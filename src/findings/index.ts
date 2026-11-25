// SPDX-License-Identifier: Apache-2.0
// Module 6: findings filter. Code only, no model. Out-of-diff demotion to the
// review body follows the idea of post-review.py partition_by_anchor (Comfy,
// MIT); no code copied here.
import {
  BLOCKING_SEVERITIES,
  SEVERITIES,
  type AdversaryVerdict,
  type AnchorMap,
  type FilteredFinding,
  type Finding,
  type RawFinding,
  type Severity,
} from "../types.js";
import { normalizeSeverity } from "./severity.js";
export * from "./severity.js";

export interface FilterInput {
  reviewer: Finding[];
  adversaryVerdicts: AdversaryVerdict[];
  adversaryMissed: Finding[];
  counterVerdicts: AdversaryVerdict[];
  anchors: AnchorMap;
  /** Concatenated diff + context the adversary saw, for the quote check. */
  shownText: string;
  /** Default 10; overflow goes to body, sorted by severity. */
  maxInline: number;
}

export const MIN_FAILURE_SCENARIO_CHARS = 20;
/** A refuting quote shorter than this (non-space characters) proves nothing: "}" is in every diff. */
export const MIN_QUOTE_CHARS = 10;
const DUP_LINE_WINDOW = 3;

const rank = (s: Severity): number => SEVERITIES.indexOf(s); // 0 = critical
const isBlocking = (s: Severity): boolean => BLOCKING_SEVERITIES.includes(s);

// A concrete scenario names an input, a condition or an outcome.
const CONCRETE =
  /(\bwhen\b|\bif\b|\bgiven\b|\bwith\b|\bafter\b|\bbefore\b|\bpassing\b|\bcall(?:s|ed|ing)?\b|\binput\b|\brequest\b|\breturns?\b|\bthrows?\b|\braises?\b|\bcrash|\bpanic|\boverflow|\bnull\b|\bundefined\b|\bempty\b|->|→|=>|\d|`|"|')/i;
const VAGUE =
  /^(?:this\s+)?(?:could|might|may|can)\s+(?:cause|lead\s+to|result\s+in)\s+(?:issues|problems|bugs|errors|unexpected\s+behaviou?r)\.?$/i;

export function hasProof(
  f: RawFinding,
): { ok: true } | { ok: false; reason: string } {
  if (typeof f.file !== "string" || !f.file.trim())
    return { ok: false, reason: "no file" };
  if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1)
    return { ok: false, reason: "no line" };
  const scenario =
    typeof f.failureScenario === "string" ? f.failureScenario.trim() : "";
  if (scenario.length < MIN_FAILURE_SCENARIO_CHARS)
    return { ok: false, reason: "failure scenario missing or too short" };
  if (VAGUE.test(scenario) || !CONCRETE.test(scenario))
    return {
      ok: false,
      reason: "failure scenario has no concrete input or outcome",
    };
  return { ok: true };
}

// Strips a diff marker and/or a rendered line number at the start of a line,
// so a quote of the code itself matches "+  foo();" or "  42 | foo();".
const LINE_PREFIX = /^\s*(?:\d+\s*[|:]\s?)?[+\- ]?/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const stripLines = (s: string) =>
  s
    .split(/\r?\n|\r/)
    .map((l) => l.replace(LINE_PREFIX, ""))
    .join("\n");

// A refuting quote must be executable code. Comments, and lines shaped like
// our fence markers, are text an author (or an attacker) can write to say
// "this is safe"; they never refute a finding (integrator change, see
// CONTRACT.md module 6 amendment A1 and the injection set).
const FENCE_LIKE = /^\s*={3}\s*(?:BEGIN|END)\b.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))|<!--[\s\S]*?(?:-->|$(?![\s\S]))/g;
const LINE_COMMENT_ONLY = /^\s*(?:\/\/|#|--|;;|\*|\*\/|\/\*).*$/gm;
const TRAILING_COMMENT = /(^|[\s;,){}\]])(?:\/\/|#)(?![!\[{]).*$/gm;
const DOCSTRING = /("""|\'\'\')[\s\S]*?(?:\1|$(?![\s\S]))/g;

/** The code-only view of text: diff markers, comments and fence-like lines removed. */
export function codeOnly(text: string): string {
  return stripLines(text)
    .replace(FENCE_LIKE, "")
    .replace(BLOCK_COMMENT, " ")
    .replace(DOCSTRING, " ")
    .replace(LINE_COMMENT_ONLY, "")
    .replace(TRAILING_COMMENT, "$1");
}

/**
 * Verbatim after whitespace normalisation (diff markers and line numbers
 * ignored), and the quote must still hold at least MIN_QUOTE_CHARS of code
 * once comments are removed from both sides: quoting a comment proves nothing.
 */
export function quoteFound(quote: string, shownText: string): boolean {
  if (typeof quote !== "string") return false;
  const q = norm(codeOnly(quote));
  if (q.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return false;
  return norm(codeOnly(shownText)).includes(q);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileKnown(
  file: string,
  anchors: AnchorMap,
  shownText: string,
): boolean {
  if (anchors.has(file)) return true;
  return new RegExp(
    `(?:^|[\\s"'(\\[])(?:[ab]/)?${escapeRe(file)}(?:$|[\\s:"')\\],])`,
    "m",
  ).test(shownText);
}

type VerdictPlacement =
  | { placement: "dismissed" | "disputed"; reason: string }
  | { placement: "keep"; reason: string };

function placeByVerdict(
  f: Finding,
  sev: Severity,
  v: AdversaryVerdict | undefined,
  shownText: string,
): VerdictPlacement | null {
  if (!v || v.verdict === "upheld") return null;
  if (!isBlocking(sev)) {
    if (v.verdict === "disputed")
      return { placement: "disputed", reason: "contested by the other model" };
    return {
      placement: "dismissed",
      reason: "dismissed by the other model with a reason",
    };
  }
  if (
    v.verdict === "dismissed" &&
    v.refutingQuote &&
    quoteFound(v.refutingQuote, shownText)
  ) {
    return {
      placement: "dismissed",
      reason: "dismissed with a refuting quote found in the code shown",
    };
  }
  // A critical/high finding that was not refuted by quoted code stays posted
  // and keeps gating (amendment A1): a model that obeys injected text can
  // always "dispute", so a dispute alone must never turn the check green.
  const why =
    v.verdict === "disputed"
      ? "contested by the other model without refuting code"
      : v.refutingQuote
        ? "dismissal without a refuting quote of code shown (quote missing from the code, or only a comment)"
        : "dismissal without a refuting quote";
  return { placement: "keep", reason: `disputed, still blocking: ${why}` };
}

const dupOf = (a: FilteredFinding, b: FilteredFinding) =>
  a.fingerprint === b.fingerprint ||
  (a.file === b.file &&
    a.lens === b.lens &&
    Math.abs(a.line - b.line) <= DUP_LINE_WINDOW);

const placementOrder = (p: FilteredFinding["placement"]) =>
  p === "inline" ? 0 : p === "body" ? 1 : 2;

export function filterFindings(input: FilterInput): FilteredFinding[] {
  const firstVerdict = (list: AdversaryVerdict[]) => {
    const m = new Map<string, AdversaryVerdict>();
    for (const v of list) if (!m.has(v.findingId)) m.set(v.findingId, v);
    return m;
  };
  const advVerdicts = firstVerdict(input.adversaryVerdicts);
  const counter = firstVerdict(input.counterVerdicts);
  const reviewerIds = new Set(input.reviewer.map((f) => f.id));

  const out: FilteredFinding[] = [];
  const all: [Finding, AdversaryVerdict | undefined][] = [
    ...input.reviewer.map((f): [Finding, AdversaryVerdict | undefined] => [
      f,
      advVerdicts.get(f.id),
    ]),
    ...input.adversaryMissed
      .filter((f) => !reviewerIds.has(f.id))
      .map((f): [Finding, AdversaryVerdict | undefined] => [
        f,
        counter.get(f.id),
      ]),
  ];

  for (const [f, verdict] of all) {
    const severity = normalizeSeverity(f.severity);
    const base: FilteredFinding = {
      ...f,
      severity,
      placement: "dropped",
      placementReason: "",
    };
    if (verdict) base.adversary = verdict;
    const proof = hasProof(f);
    if (!proof.ok) {
      out.push({ ...base, placementReason: proof.reason });
      continue;
    }
    if (!fileKnown(f.file, input.anchors, input.shownText)) {
      out.push({ ...base, placementReason: "unknown file" });
      continue;
    }
    const byVerdict = placeByVerdict(f, severity, verdict, input.shownText);
    const note = byVerdict?.placement === "keep" ? `${byVerdict.reason}; ` : "";
    if (byVerdict && byVerdict.placement !== "keep") {
      out.push({
        ...base,
        placement: byVerdict.placement,
        placementReason: byVerdict.reason,
      });
      continue;
    }
    if (f.preExisting) {
      out.push({
        ...base,
        placement: "pre-existing",
        placementReason: `${note}bug already on the base branch`,
      });
      continue;
    }
    const anchored = input.anchors.get(f.file)?.has(f.line) ?? false;
    out.push({
      ...base,
      placement: anchored ? "inline" : "body",
      placementReason: `${note}${anchored ? "line in the diff" : "line not in the diff"}`,
    });
  }

  // Duplicates among the surviving findings: the higher severity wins (then
  // inline over body, then reviewer order); the loser is kept as "dropped" so
  // the eval still sees both origins.
  const live = out.filter(
    (f) =>
      f.placement === "inline" ||
      f.placement === "body" ||
      f.placement === "pre-existing",
  );
  const order = [...live].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      placementOrder(a.placement) - placementOrder(b.placement) ||
      out.indexOf(a) - out.indexOf(b),
  );
  const winners: FilteredFinding[] = [];
  for (const f of order) {
    const w = winners.find((x) => dupOf(x, f));
    if (w) {
      f.placement = "dropped";
      f.placementReason = `duplicate of ${w.id}${w.origin !== f.origin ? ` (raised by both reviewer and adversary)` : ""}`;
    } else winners.push(f);
  }

  // Inline cap: the lowest-severity extras move to the body.
  const maxInline = Math.max(0, input.maxInline);
  const inline = out
    .filter((f) => f.placement === "inline")
    .sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) || out.indexOf(a) - out.indexOf(b),
    );
  for (const f of inline.slice(maxInline)) {
    f.placement = "body";
    f.placementReason = `over the inline cap of ${maxInline}`;
  }
  return out;
}
