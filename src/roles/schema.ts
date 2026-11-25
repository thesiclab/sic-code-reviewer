// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived in part from Comfy-Org/github-workflows .github/cursor-review/review-output-mcp.py
// (validate_finding) (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: ported to TypeScript; collects every error instead of raising on the
// first; proof fields (lens, title, failureScenario, preExisting) added; side
// dropped (always RIGHT); unknown keys are ignored (only known fields are
// copied) rather than rejected; severity accepted case-insensitively; the
// adversary and counter-check schemas and validators are ours.
import {
  SEVERITIES,
  type AdversaryVerdict,
  type AdversaryVerdictKind,
  type JsonSchema,
  type Lens,
  type RawFinding,
  type Severity,
} from "../types.js";
import type { SchemaCheck } from "../models/index.js";

export interface ReviewerOutput {
  findings: RawFinding[];
}
export interface AdversaryOutput {
  verdicts: AdversaryVerdict[];
  missed: RawFinding[];
}
export interface CounterCheckOutput {
  verdicts: AdversaryVerdict[];
}

export const LENSES: readonly Lens[] = [
  "correctness",
  "security",
  "tests",
  "scope",
];
const VERDICTS: readonly AdversaryVerdictKind[] = [
  "upheld",
  "dismissed",
  "disputed",
];

export const LIMITS = {
  path: 1024,
  title: 200,
  failureScenario: 4000,
  body: 20000,
  reason: 4000,
  quote: 4000,
  repeatOf: 2048,
  findings: 100,
} as const;

const FINDING_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "file",
    "line",
    "lens",
    "severity",
    "title",
    "failureScenario",
    "body",
    "preExisting",
  ],
  properties: {
    file: {
      type: "string",
      description: "Repo-relative POSIX path of the file the bug is in.",
    },
    line: { type: "integer", description: "New-side line number of the bug." },
    endLine: { type: "integer", description: "Optional last line of a range." },
    lens: { type: "string", enum: [...LENSES] },
    severity: { type: "string", enum: [...SEVERITIES] },
    title: { type: "string" },
    failureScenario: {
      type: "string",
      description:
        "Concrete inputs and the wrong result they produce, or the attack.",
    },
    body: { type: "string" },
    preExisting: {
      type: "boolean",
      description: "True when the bug is already on the base branch.",
    },
    repeatOf: {
      type: "string",
      description:
        "Discussion URL of the answered ledger entry this re-raises; only then.",
    },
  },
};

const VERDICT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findingId", "verdict", "reason"],
  properties: {
    findingId: { type: "string" },
    verdict: { type: "string", enum: [...VERDICTS] },
    reason: { type: "string" },
    refutingQuote: {
      type: "string",
      description:
        "Code line(s) that refute the finding, copied exactly from the DIFF or CONTEXT blocks.",
    },
    refutingFile: { type: "string" },
    refutingLine: { type: "integer" },
  },
};

export const REVIEWER_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: { findings: { type: "array", items: FINDING_SCHEMA } },
};

export const ADVERSARY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts", "missed"],
  properties: {
    verdicts: { type: "array", items: VERDICT_SCHEMA },
    missed: { type: "array", items: FINDING_SCHEMA },
  },
};

export const COUNTER_CHECK_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: { verdicts: { type: "array", items: VERDICT_SCHEMA } },
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;

function str(
  o: Rec,
  key: string,
  max: number,
  where: string,
  errors: string[],
  required = true,
): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) errors.push(`${where}.${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || !v.trim()) {
    errors.push(`${where}.${key} must be a non-empty string`);
    return undefined;
  }
  if (v.length > max) {
    errors.push(`${where}.${key} is longer than ${max} characters`);
    return undefined;
  }
  return v;
}

/** Comfy validate_finding path rule: repo-relative POSIX, normalised, never escaping the repo. */
export function normalizeRepoPath(path: string): string | null {
  if (
    !path ||
    path.length > LIMITS.path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return null;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

function validateFinding(
  v: unknown,
  where: string,
  errors: string[],
): RawFinding | null {
  if (!isRec(v)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const before = errors.length;
  const rawFile = str(v, "file", LIMITS.path, where, errors);
  const file = rawFile === undefined ? null : normalizeRepoPath(rawFile);
  if (rawFile !== undefined && file === null)
    errors.push(
      `${where}.file must be a repo-relative path inside the repository`,
    );
  if (!isPosInt(v.line))
    errors.push(`${where}.line must be a positive integer`);
  if (
    v.endLine !== undefined &&
    v.endLine !== null &&
    (!isPosInt(v.endLine) || (isPosInt(v.line) && v.endLine < v.line))
  ) {
    errors.push(`${where}.endLine must be an integer not below line`);
  }
  const lens = typeof v.lens === "string" ? v.lens.trim().toLowerCase() : "";
  if (!(LENSES as readonly string[]).includes(lens))
    errors.push(`${where}.lens must be one of ${LENSES.join(", ")}`);
  const severity =
    typeof v.severity === "string" ? v.severity.trim().toLowerCase() : "";
  if (!(SEVERITIES as readonly string[]).includes(severity))
    errors.push(`${where}.severity must be one of ${SEVERITIES.join(", ")}`);
  const title = str(v, "title", LIMITS.title, where, errors);
  const failureScenario = str(
    v,
    "failureScenario",
    LIMITS.failureScenario,
    where,
    errors,
  );
  const body = str(v, "body", LIMITS.body, where, errors);
  if (typeof v.preExisting !== "boolean")
    errors.push(`${where}.preExisting must be true or false`);
  const repeatOf = str(v, "repeatOf", LIMITS.repeatOf, where, errors, false);
  if (errors.length > before) return null;

  const f: RawFinding = {
    file: file!,
    line: v.line as number,
    lens: lens as Lens,
    severity: severity as Severity,
    title: title!,
    failureScenario: failureScenario!,
    body: body!,
    preExisting: v.preExisting as boolean,
  };
  if (isPosInt(v.endLine)) f.endLine = v.endLine;
  if (repeatOf !== undefined) f.repeatOf = repeatOf;
  return f;
}

function validateFindingList(
  v: unknown,
  key: string,
  errors: string[],
): RawFinding[] {
  if (!Array.isArray(v)) {
    errors.push(`${key} must be an array`);
    return [];
  }
  if (v.length > LIMITS.findings)
    errors.push(`${key} has more than ${LIMITS.findings} entries`);
  const out: RawFinding[] = [];
  v.slice(0, LIMITS.findings).forEach((item, i) => {
    const f = validateFinding(item, `${key}[${i}]`, errors);
    if (f) out.push(f);
  });
  return out;
}

function validateVerdicts(
  v: unknown,
  ids: Set<string>,
  errors: string[],
): AdversaryVerdict[] {
  if (!Array.isArray(v)) {
    errors.push("verdicts must be an array");
    return [];
  }
  const seen = new Set<string>();
  const out: AdversaryVerdict[] = [];
  v.forEach((item, i) => {
    const where = `verdicts[${i}]`;
    if (!isRec(item)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const before = errors.length;
    const id = typeof item.findingId === "string" ? item.findingId.trim() : "";
    if (!ids.has(id))
      errors.push(`${where}.findingId is not one of the finding ids given`);
    else if (seen.has(id))
      errors.push(
        `${where}.findingId repeats an id that already has a verdict`,
      );
    const verdict =
      typeof item.verdict === "string" ? item.verdict.trim().toLowerCase() : "";
    if (!(VERDICTS as readonly string[]).includes(verdict))
      errors.push(`${where}.verdict must be one of ${VERDICTS.join(", ")}`);
    const reason = str(item, "reason", LIMITS.reason, where, errors);
    const refutingQuote = str(
      item,
      "refutingQuote",
      LIMITS.quote,
      where,
      errors,
      false,
    );
    const rawRefFile = str(
      item,
      "refutingFile",
      LIMITS.path,
      where,
      errors,
      false,
    );
    const refutingFile =
      rawRefFile === undefined ? undefined : normalizeRepoPath(rawRefFile);
    if (rawRefFile !== undefined && refutingFile === null)
      errors.push(`${where}.refutingFile must be a repo-relative path`);
    if (
      item.refutingLine !== undefined &&
      item.refutingLine !== null &&
      !isPosInt(item.refutingLine)
    )
      errors.push(`${where}.refutingLine must be a positive integer`);
    if (errors.length > before) return;
    seen.add(id);
    const out1: AdversaryVerdict = {
      findingId: id,
      verdict: verdict as AdversaryVerdictKind,
      reason: reason!,
    };
    if (refutingQuote !== undefined) out1.refutingQuote = refutingQuote;
    if (refutingFile) out1.refutingFile = refutingFile;
    if (isPosInt(item.refutingLine)) out1.refutingLine = item.refutingLine;
    out.push(out1);
  });
  return out;
}

const result = <T>(errors: string[], value: T): SchemaCheck<T> =>
  errors.length ? { ok: false, errors } : { ok: true, value };

export function validateReviewerOutput(
  v: unknown,
): SchemaCheck<ReviewerOutput> {
  if (!isRec(v))
    return { ok: false, errors: ["the reply must be a JSON object"] };
  const errors: string[] = [];
  const findings = validateFindingList(v.findings, "findings", errors);
  return result(errors, { findings });
}

export function validateAdversaryOutput(
  v: unknown,
  ids: Set<string>,
): SchemaCheck<AdversaryOutput> {
  if (!isRec(v))
    return { ok: false, errors: ["the reply must be a JSON object"] };
  const errors: string[] = [];
  const verdicts = validateVerdicts(v.verdicts, ids, errors);
  const missed = validateFindingList(v.missed, "missed", errors);
  return result(errors, { verdicts, missed });
}

export function validateCounterCheckOutput(
  v: unknown,
  ids: Set<string>,
): SchemaCheck<CounterCheckOutput> {
  if (!isRec(v))
    return { ok: false, errors: ["the reply must be a JSON object"] };
  const errors: string[] = [];
  const verdicts = validateVerdicts(v.verdicts, ids, errors);
  return result(errors, { verdicts });
}
