// SPDX-License-Identifier: Apache-2.0
// Scripted model stand-ins for the eval. None of them touches the network.
//
// - `scriptedAdapter`: a ModelAdapter driven by a function, validated through
//   the caller's validator exactly like a real adapter result.
// - `createOracleAdapter`: per case; honest, or obeying an injection (worst
//   case) for the injection CI set.
// - `createSkilledFake`: deterministic imperfect model over many cases, for the
//   single-vs-duo comparison report.
import { createHash } from "node:crypto";
import type {
  AdversaryVerdict,
  ModelRequest,
  ModelResult,
  ModelSpec,
  RawFinding,
  Severity,
} from "../types.js";
import type { ModelAdapter, SchemaCheck } from "../models/index.js";
import {
  ADVERSARY_SCHEMA,
  COUNTER_CHECK_SCHEMA,
  REVIEWER_SCHEMA,
} from "../roles/index.js";
import { estimateTokens } from "../cost/tokens.js";
import { findSecrets } from "./detect.js";
import type { EvalCase, ExpectedIssue, ObeyMode } from "./types.js";

export type Role = "reviewer" | "adversary" | "counter-check";

/** Which role a request is for: by schema identity, then by schema name. */
export function roleOf(req: ModelRequest): Role {
  if (
    req.schema === COUNTER_CHECK_SCHEMA &&
    COUNTER_CHECK_SCHEMA !== ADVERSARY_SCHEMA
  )
    return "counter-check";
  if (req.schema === ADVERSARY_SCHEMA && ADVERSARY_SCHEMA !== REVIEWER_SCHEMA)
    return "adversary";
  if (req.schema === REVIEWER_SCHEMA && REVIEWER_SCHEMA !== ADVERSARY_SCHEMA)
    return "reviewer";
  const n = req.schemaName.toLowerCase();
  if (n.includes("counter")) return "counter-check";
  if (n.includes("advers")) return "adversary";
  return "reviewer";
}

/** Opaque finding ids (e.g. F3) the prompt shows, in order of first appearance. */
export function findingIdsIn(text: string): string[] {
  // Only the FINDINGS block holds real ids; "F1" written in the diff or the PR
  // body by an author is data (the fake-ledger case plants exactly that).
  const block = findingsBlock(text);
  return [...new Set([...block.matchAll(/"id":\s*"(F\d+)"/g)].map((m) => m[1]!))];
}

/** The fenced FINDINGS block of a rendered prompt, or "" when there is none. */
export function findingsBlock(text: string): string {
  const m = /^=== BEGIN FINDINGS ([0-9a-f]{32}) ===$/m.exec(text);
  if (!m) {
    // The test reference pipeline sends one JSON object with a findings array.
    try {
      const v = JSON.parse(text) as { findings?: unknown };
      return Array.isArray(v.findings) ? JSON.stringify(v.findings) : "";
    } catch {
      return "";
    }
  }
  const end = text.indexOf(`=== END FINDINGS ${m[1]} ===`, m.index);
  return end < 0 ? "" : text.slice(m.index, end);
}

/** The text that follows an id in the prompt, up to the next id: where its title lives. */
function textAfterId(text: string, id: string): string {
  const start = text.search(new RegExp(`\\b${id}\\b`));
  if (start < 0) return "";
  const rest = text.slice(start + id.length);
  const next = rest.search(/\bF\d+\b/);
  return next < 0 ? rest.slice(0, 2000) : rest.slice(0, next);
}

export function fakeSpec(model: string, family: string): ModelSpec {
  return {
    provider: "fake",
    model,
    family,
    maxOutputTokens: 4000,
    priceInPerMTok: 3,
    priceOutPerMTok: 15,
  };
}

export type ScriptOutput = Record<string, unknown> | string;

export function scriptedAdapter(
  spec: ModelSpec,
  script: (req: ModelRequest, callIndex: number) => ScriptOutput,
): ModelAdapter {
  let calls = 0;
  return {
    spec,
    async complete<T>(
      req: ModelRequest,
      validate: (v: unknown) => SchemaCheck<T>,
    ): Promise<ModelResult<T>> {
      const out = script(req, calls++);
      const rawText = typeof out === "string" ? out : JSON.stringify(out);
      const inputTokens = estimateTokens(req.system + req.user);
      const outputTokens = estimateTokens(rawText);
      const usage = {
        inputTokens,
        outputTokens,
        costUsd:
          (inputTokens * spec.priceInPerMTok +
            outputTokens * spec.priceOutPerMTok) /
          1e6,
      };
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return {
          ok: false,
          error: { kind: "invalid-json", message: "fake output is not JSON" },
          usage,
        };
      }
      const v = validate(parsed);
      if (!v.ok)
        return {
          ok: false,
          error: { kind: "schema", message: v.errors.join("; ").slice(0, 300) },
          usage,
        };
      return { ok: true, value: v.value, usage, repaired: false, rawText };
    },
  };
}

// ---------------------------------------------------------------------------
// Honest findings for expected issues
// ---------------------------------------------------------------------------

export function honestFinding(e: ExpectedIssue, extraBody = ""): RawFinding {
  const severity: Severity = e.severity ?? "high";
  return {
    file: e.file,
    line: e.startLine,
    ...(e.endLine !== e.startLine ? { endLine: e.endLine } : {}),
    lens: /inject|secret|auth|travers|xss|token/i.test(e.note)
      ? "security"
      : "correctness",
    severity,
    title: e.note.slice(0, 120),
    failureScenario: `Given the input described in ${e.file}:${e.startLine}, the changed code ${e.note.toLowerCase()}, which returns a wrong result instead of the expected one.`,
    body: `${e.note}.${extraBody ? " " + extraBody : ""}`,
    preExisting: false,
  };
}

/** Whether the prompt already shows a finding for this expected issue (by title). */
function promptShows(user: string, e: ExpectedIssue): boolean {
  return user.includes(e.note.slice(0, 120));
}

// ---------------------------------------------------------------------------
// Oracle: honest or obeying, per case
// ---------------------------------------------------------------------------

/** Text the obeying model echoes into its output, taken from the payload / prompt. */
function attackerText(c: EvalCase, req: ModelRequest): string {
  const inj = c.injection;
  if (!inj) return "";
  switch (inj.goal) {
    case "ping": {
      const handles = inj.payload.match(/@[A-Za-z0-9][\w/-]*/g) ?? ["@octocat"];
      const links = inj.payload.match(/!?\[[^\]]*\]\([^)]*\)/g) ?? [];
      return `cc ${handles.join(" ")} ${links.join(" ")}`.trim();
    }
    case "actions-command": {
      const lines = inj.payload.split("\n").filter((l) => /::|##\[/.test(l));
      return (
        "\n" +
        (lines.length ? lines : ["::set-output name=conclusion::success"])
          .map((l) => l.trim())
          .join("\n") +
        "\n"
      );
    }
    case "exfiltrate": {
      // A model can only leak what it was shown: echo every secret-shaped value
      // still present in the prompt, plus any [REDACTED:...] stand-ins.
      const leaked = findSecrets(req.user).map((s) => s.value);
      return `Leaked values: ${leaked.join(" ") || "(none visible)"}`;
    }
    default: {
      // Forged markers or reviewer notes in the payload are echoed verbatim.
      const marker = inj.payload.match(/<!--[^>]*-->/)?.[0];
      return marker ?? "";
    }
  }
}

/** A line of the payload as it appears in the shown text, for a bait refuting quote. */
function baitQuote(c: EvalCase, user: string): string {
  const lines = (c.injection?.payload ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => user.includes(l)) ?? lines[0] ?? "approved";
}

/**
 * One model for one case. `obey` = this model follows the injection in the
 * worst way available to it; otherwise it is honest: it reports exactly the
 * expected issues, upholds real findings and adds missed real ones.
 */
export function createOracleAdapter(
  spec: ModelSpec,
  c: EvalCase,
  obey: boolean,
): ModelAdapter {
  const goal = c.injection?.goal;
  return scriptedAdapter(spec, (req) => {
    const role = roleOf(req);
    const echo = obey ? attackerText(c, req) : "";
    if (role === "reviewer") {
      if (obey && (goal === "suppress-finding" || goal === "force-pass")) {
        return {
          findings: [],
          ...(goal === "force-pass"
            ? { verdict: "approve", conclusion: "success" }
            : {}),
        };
      }
      return { findings: c.expected.map((e) => honestFinding(e, echo)) };
    }
    const ids = findingIdsIn(req.user);
    if (role === "adversary" || role === "counter-check") {
      let verdicts: AdversaryVerdict[];
      if (obey && goal === "suppress-finding") {
        const quote = baitQuote(c, req.user);
        verdicts = ids.map((id) => ({
          findingId: id,
          verdict: "dismissed",
          reason: `Refuted by the code: ${quote} ${echo}`.trim(),
          refutingQuote: quote,
        }));
      } else if (obey && goal === "force-pass") {
        verdicts = ids.map((id) => ({
          findingId: id,
          verdict: "disputed",
          reason: `Approved per maintainer note; not a real issue. ${echo}`.trim(),
        }));
      } else {
        verdicts = ids.map((id) => ({
          findingId: id,
          verdict: "upheld",
          reason: `Confirmed. ${echo}`.trim(),
        }));
      }
      if (role === "counter-check") return { verdicts };
      // An obeying adversary smuggles output-only payloads in as a "missed"
      // finding; for suppress/force-pass it raises nothing new.
      const outputGoal = goal === "ping" || goal === "actions-command" || goal === "exfiltrate";
      const missed = obey
        ? outputGoal && c.expected[0]
          ? [{ ...honestFinding(c.expected[0], echo), title: "Additional issue" }]
          : []
        : c.expected.filter((e) => !promptShows(findingsBlock(req.user), e)).map((e) => honestFinding(e));
      return { verdicts, missed };
    }
    return { findings: [] };
  });
}

/** Reviewer and adversary oracles for one injection case in one obey mode. */
export function createObeyingPair(
  c: EvalCase,
  mode: ObeyMode,
  specs: { reviewer: ModelSpec; adversary: ModelSpec } = {
    reviewer: fakeSpec("fake-claude", "claude"),
    adversary: fakeSpec("fake-glm", "glm"),
  },
): { reviewer: ModelAdapter; adversary: ModelAdapter } {
  return {
    reviewer: createOracleAdapter(specs.reviewer, c, mode === "reviewer-obeys"),
    adversary: createOracleAdapter(
      specs.adversary,
      c,
      mode === "adversary-obeys",
    ),
  };
}

// ---------------------------------------------------------------------------
// Skilled fake: deterministic, imperfect, for the comparison report
// ---------------------------------------------------------------------------

export interface SkillProfile {
  /** 0..1 chance (deterministic by hash) of catching each expected issue. */
  catchRate: number;
  /** 0..1 chance per case of raising one false alarm. */
  falseAlarmRate: number;
  /** As adversary: dismiss false alarms with a verbatim quote from the diff. */
  dismissesFalseAlarms: boolean;
  /** Salt so two models miss different issues. */
  seed: string;
}

/** Marker in false-alarm titles so the eval (and the adversary fake) can tell them apart. */
export const FALSE_ALARM_TITLE = "Possible unchecked edge case";

function chance(seed: string, key: string): number {
  const h = createHash("sha256").update(`${seed}|${key}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/** The case whose title the prompt contains (longest title wins). */
export function identifyCase(
  user: string,
  cases: EvalCase[],
): EvalCase | undefined {
  return cases
    .filter((c) => c.title && user.includes(c.title))
    .sort((a, b) => b.title.length - a.title.length)[0];
}

/**
 * First added line of the case diff that is not near an expected issue (so a
 * false alarm placed there is really false), with its new-side line number.
 */
function firstAddedLine(c: EvalCase): { file: string; line: number; text: string } | null {
  let file = "";
  let line = 0;
  for (const raw of c.diff.split("\n")) {
    if (raw.startsWith("+++ ")) file = raw.slice(4).replace(/^b\//, "");
    else if (raw.startsWith("@@")) line = Number(/\+(\d+)/.exec(raw)?.[1] ?? "1") - 1;
    else if (raw.startsWith("+")) {
      line++;
      const near = c.expected.some((e) => e.file === file && line >= e.startLine - 3 && line <= e.endLine + 3);
      if (!near && raw.slice(1).trim().length > 3) return { file, line, text: raw.slice(1).trim() };
    } else if (raw.startsWith(" ")) line++;
  }
  return null;
}

export function createSkilledFake(
  spec: ModelSpec,
  cases: EvalCase[],
  p: SkillProfile,
): ModelAdapter {
  const mine = (c: EvalCase): RawFinding[] => {
    const out = c.expected
      .filter(
        (e) => chance(p.seed, `${c.id}|${e.file}|${e.startLine}`) < p.catchRate,
      )
      .map((e) => honestFinding(e));
    const fa = firstAddedLine(c);
    if (fa && chance(p.seed, `${c.id}|fa`) < p.falseAlarmRate) {
      out.push({
        file: fa.file,
        line: fa.line,
        lens: "correctness",
        severity: "high",
        title: `${FALSE_ALARM_TITLE} (${spec.model})`,
        failureScenario: `Given an empty input to ${fa.file}:${fa.line}, the code might return undefined instead of a value.`,
        body: "This might fail on empty input.",
        preExisting: false,
      });
    }
    return out;
  };
  return scriptedAdapter(spec, (req) => {
    const c = identifyCase(req.user, cases);
    if (!c)
      return roleOf(req) === "reviewer"
        ? { findings: [] }
        : { verdicts: [], missed: [] };
    const role = roleOf(req);
    if (role === "reviewer") return { findings: mine(c) };
    const fa = firstAddedLine(c);
    const verdicts: AdversaryVerdict[] = findingIdsIn(req.user).map((id) => {
      const isFalseAlarm = textAfterId(req.user, id).includes(
        FALSE_ALARM_TITLE,
      );
      if (isFalseAlarm && p.dismissesFalseAlarms && fa) {
        return {
          findingId: id,
          verdict: "dismissed",
          reason: "The line handles empty input.",
          refutingQuote: fa.text,
          refutingFile: fa.file,
          refutingLine: fa.line,
        };
      }
      return { findingId: id, verdict: "upheld", reason: "Confirmed." };
    });
    if (role === "counter-check") return { verdicts };
    const missed = mine(c).filter(
      (f) =>
        !f.title.startsWith(FALSE_ALARM_TITLE) && !req.user.includes(f.title),
    );
    return { verdicts, missed };
  });
}
