// SPDX-License-Identifier: Apache-2.0
// A small stand-in for the real pipeline, used to test the eval harness while
// the real modules are built in parallel. It follows the CONTRACT.md rules
// literally (proof rule, quote rule on code only, disputed critical/high still
// gates per amendment A1, sanitizer list) so
// the injection set shows what those rules let through. It is NOT the product.
import type {
  AdversaryVerdict,
  FilteredFinding,
  Finding,
  GateResult,
  ModelRequest,
  RawFinding,
  Severity,
} from "../../src/types.js";
import { BLOCKING_SEVERITIES } from "../../src/types.js";
import { quoteFound } from "../../src/findings/index.js";
import type { SchemaCheck } from "../../src/models/index.js";
import {
  ADVERSARY_SCHEMA,
  COUNTER_CHECK_SCHEMA,
  REVIEWER_SCHEMA,
} from "../../src/roles/index.js";
import type {
  CaseRun,
  EvalAdapters,
  EvalCase,
  EvalPipeline,
  Variant,
} from "../../src/eval/index.js";

type Out = {
  findings?: RawFinding[];
  verdicts?: AdversaryVerdict[];
  missed?: RawFinding[];
};
const any = (v: unknown): SchemaCheck<Out> =>
  typeof v === "object" && v !== null
    ? { ok: true, value: v as Out }
    : { ok: false, errors: ["not an object"] };

export interface RefOptions {
  /** Sanitize posted text (mentions, Actions commands, secrets). */
  sanitize: boolean;
  /** Apply the quote rule for high/critical dismissals. */
  quoteRule: boolean;
  /** Redact secrets from model input (default true). */
  redactInput?: boolean;
}

const ZWSP = "\u200b";
function redactRef(s: string): string {
  return s
    .replace(
      /-----BEGIN [A-Z ]*-----[\s\S]*?-----END [A-Z ]*-----/g,
      "[REDACTED:pem]",
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:aws]")
    .replace(/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/g, "[REDACTED:github]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:sk]")
    .replace(/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack]")
    .replace(
      /(SECRET[A-Z_]*\s*=\s*")([^"]{16,})"/g,
      '$1[REDACTED:assignment]"',
    );
}
export function sanitizeRef(s: string): string {
  return redactRef(s)
    .replace(/@/g, "@" + ZWSP)
    .replace(/^(\s*)::/gm, "$1:" + ZWSP + ":")
    .replace(/##\[/g, "##" + ZWSP + "[")
    .replace(/<!--/g, "&lt;!--")
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)");
}

function hasProof(f: RawFinding): boolean {
  return (
    Boolean(f.file) &&
    Number.isInteger(f.line) &&
    typeof f.failureScenario === "string" &&
    f.failureScenario.length >= 20
  );
}

function anchors(diff: string): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>();
  let file = "";
  let n = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.slice(4).replace(/^b\//, "");
      m.set(file, new Set());
    } else if (l.startsWith("@@")) n = Number(/\+(\d+)/.exec(l)?.[1] ?? "1");
    else if (l.startsWith("+") || l.startsWith(" ")) m.get(file)?.add(n++);
  }
  return m;
}

function render(c: EvalCase, findings: Finding[], redactIn: (s: string) => string): string {
  return JSON.stringify({
    title: c.title,
    // Input redaction (module 3's job in the real pipeline).
    body: redactIn(c.body),
    diff: redactIn(c.diff),
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      file: f.file,
      line: f.line,
      severity: f.severity,
      body: f.body,
    })),
  });
}

function req(
  c: EvalCase,
  schema: Record<string, unknown>,
  name: string,
  findings: Finding[],
  redactIn: (s: string) => string = redactRef,
): ModelRequest {
  return {
    system: "eval reference",
    user: render(c, findings, redactIn),
    schema,
    schemaName: name,
    maxOutputTokens: 4000,
  };
}

const rank: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

export function createReferencePipeline(
  o: RefOptions = { sanitize: true, quoteRule: true },
): EvalPipeline {
  const rin = o.redactInput === false ? (s: string) => s : redactRef;
  return async (
    c: EvalCase,
    variant: Variant,
    a: EvalAdapters,
  ): Promise<CaseRun> => {
    let cost = 0;
    let failed = false;
    let next = 1;
    const assign = (
      raw: RawFinding[],
      origin: Finding["origin"],
      model: string,
    ): Finding[] =>
      raw.map((r) => ({
        ...r,
        id: `F${next++}`,
        origin,
        raisedByModel: model,
        fingerprint: `${r.file}:${r.title}`,
      }));

    const r = await a.reviewer.complete(
      req(c, REVIEWER_SCHEMA, "reviewer", [], rin),
      any,
    );
    cost += r.usage.costUsd;
    if (!r.ok) failed = true;
    const reviewer = r.ok
      ? assign(r.value.findings ?? [], "reviewer", a.reviewer.spec.model)
      : [];
    let verdicts: AdversaryVerdict[] = [];
    let missed: Finding[] = [];
    if (a.adversary && variant === "two-families-no-adversary") {
      const r2 = await a.adversary.complete(
        req(c, REVIEWER_SCHEMA, "reviewer", [], rin),
        any,
      );
      cost += r2.usage.costUsd;
      if (!r2.ok) failed = true;
      else
        missed = assign(
          r2.value.findings ?? [],
          "adversary",
          a.adversary.spec.model,
        );
    } else if (a.adversary && variant === "duo") {
      const av = await a.adversary.complete(
        req(c, ADVERSARY_SCHEMA, "adversary", reviewer, rin),
        any,
      );
      cost += av.usage.costUsd;
      if (!av.ok) failed = true;
      else {
        verdicts = av.value.verdicts ?? [];
        missed = assign(
          av.value.missed ?? [],
          "adversary",
          a.adversary.spec.model,
        );
        if (missed.length) {
          const cv = await a.reviewer.complete(
            req(c, COUNTER_CHECK_SCHEMA, "counter-check", missed, rin),
            any,
          );
          cost += cv.usage.costUsd;
          if (!cv.ok) failed = true;
          else verdicts = [...verdicts, ...(cv.value.verdicts ?? [])];
        }
      }
    }
    const anc = anchors(c.diff);
    const shown = c.diff;
    const findings: FilteredFinding[] = [...reviewer, ...missed].map((f) => {
      const v = verdicts.find((x) => x.findingId === f.id);
      const base = { ...f, ...(v ? { adversary: v } : {}) };
      if (!hasProof(f))
        return { ...base, placement: "dropped", placementReason: "no proof" };
      if (!(f.file in c.files))
        return {
          ...base,
          placement: "dropped",
          placementReason: "unknown file",
        };
      const high = BLOCKING_SEVERITIES.includes(f.severity);
      if (v?.verdict === "dismissed") {
        const ok =
          !high ||
          !o.quoteRule ||
          (v.refutingQuote !== undefined && quoteFound(v.refutingQuote, shown));
        if (ok)
          return { ...base, placement: "dismissed", placementReason: v.reason };
      } else if (v?.verdict === "disputed" && !high) {
        return { ...base, placement: "disputed", placementReason: v.reason };
      }
      // Amendment A1: a critical/high finding not refuted by quoted code stays
      // posted and blocking, whether disputed or dismissed without a quote.
      if (f.preExisting)
        return {
          ...base,
          placement: "pre-existing",
          placementReason: "pre-existing",
        };
      return anc.get(f.file)?.has(f.line)
        ? { ...base, placement: "inline", placementReason: "in diff" }
        : { ...base, placement: "body", placementReason: "line not in diff" };
    });
    findings.sort((x, y) => rank[x.severity] - rank[y.severity]);
    const blocking = findings.filter(
      (f) =>
        (f.placement === "inline" || f.placement === "body") &&
        BLOCKING_SEVERITIES.includes(f.severity),
    );
    const gate: GateResult = failed
      ? {
          conclusion: "neutral",
          summary: "model failure",
          reasons: [],
          blockingFindingIds: [],
        }
      : blocking.length
        ? {
            conclusion: "failure",
            summary: `${blocking.length} blocking`,
            reasons: [{ kind: "blocking-findings", count: blocking.length }],
            blockingFindingIds: blocking.map((f) => f.id),
          }
        : {
            conclusion: "success",
            summary: "no blocking findings",
            reasons: [],
            blockingFindingIds: [],
          };
    const clean = (s: string) => (o.sanitize ? sanitizeRef(s) : s);
    const posted = findings
      .filter((f) => f.placement !== "dropped")
      .map(
        (f) =>
          `**${clean(f.title)}** (${f.severity})\n> ${clean(f.body)}${f.adversary ? `\n\nAdversary: ${clean(f.adversary.reason)}` : ""}`,
      );
    return {
      findings,
      gate,
      posted: [posted.join("\n\n"), gate.summary],
      costUsd: cost,
    };
  };
}
