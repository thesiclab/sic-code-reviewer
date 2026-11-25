// SPDX-License-Identifier: Apache-2.0
// Shared fixtures for the prompts, roles and findings tests (modules 3-6).
import type {
  ContextBundle,
  Finding,
  ModelSpec,
  PatchSet,
  RawFinding,
} from "../../src/types.js";
import type { PromptInputs, PromptSet } from "../../src/prompts/index.js";
import { renderRubric } from "../../src/prompts/index.js";

export const DIFF_RAW = [
  "diff --git a/src/math.ts b/src/math.ts",
  "index 1111111..2222222 100644",
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,4 @@",
  " export function div(a: number, b: number): number {",
  "-  return a / b;",
  "+  if (b === 0) return 0;",
  "+  return a / b;",
  " }",
  "",
].join("\n");

export const LOCK_RAW = [
  "diff --git a/package-lock.json b/package-lock.json",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  '-"lodash": "4.17.20"',
  '+"lodash": "4.17.21"',
  "",
].join("\n");

export function patch(over: Partial<PatchSet> = {}): PatchSet {
  return {
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    mergeBase: "m".repeat(40),
    files: [
      {
        oldPath: "src/math.ts",
        newPath: "src/math.ts",
        status: "modified",
        fileClass: "source",
        hunks: [],
        raw: DIFF_RAW,
      },
      {
        oldPath: "package-lock.json",
        newPath: "package-lock.json",
        status: "modified",
        fileClass: "lockfile",
        hunks: [],
        raw: LOCK_RAW,
      },
    ],
    fullText: DIFF_RAW + LOCK_RAW,
    incrementalText: null,
    excluded: [{ kind: "file", path: "package-lock.json", reason: "lockfile" }],
    lockfileNotes: ["lodash 4.17.20 -> 4.17.21"],
    ...over,
  };
}

export function context(over: Partial<ContextBundle> = {}): ContextBundle {
  return {
    items: [
      {
        kind: "changed-function",
        path: "src/math.ts",
        startLine: 1,
        endLine: 4,
        symbol: "div",
        text: "1 | export function div(a: number, b: number): number {\n2 |   if (b === 0) return 0;\n3 |   return a / b;\n4 | }",
        tokens: 30,
      },
    ],
    notRead: [],
    tokensUsed: 30,
    tokenBudget: 1000,
    ...over,
  };
}

export const PROMPTS: PromptSet = {
  reviewer:
    "You are the reviewer. Read the change through four lenses: correctness, security, tests, scope.",
  adversary:
    "You are the adversary. Judge each finding against the code, and add findings the list does not contain.",
  counterCheck:
    "You check findings another model added. Judge each against the code.",
  rubric: renderRubric(),
};

export function inputs(over: Partial<PromptInputs> = {}): PromptInputs {
  return {
    prompts: PROMPTS,
    patch: patch(),
    context: context(),
    prTitle: "Guard division by zero",
    prBody: "Returns 0 when b is 0.",
    ledgerText: null,
    guidance: null,
    ...over,
  };
}

export function raw(over: Partial<RawFinding> = {}): RawFinding {
  return {
    file: "src/math.ts",
    line: 2,
    lens: "correctness",
    severity: "high",
    title: "Division by zero returns 0 silently",
    failureScenario:
      "div(1, 0) returns 0 instead of signalling an error, so callers compute wrong totals.",
    body: "Returning 0 hides the error.",
    preExisting: false,
    ...over,
  };
}

export function finding(over: Partial<Finding> = {}): Finding {
  return {
    ...raw(over),
    id: "F1",
    origin: "reviewer",
    raisedByModel: "claude-x",
    fingerprint: "abc123abc123",
    ...over,
  };
}

export const SPEC: ModelSpec = {
  provider: "fake",
  model: "fake-model",
  family: "fake",
  maxOutputTokens: 1000,
  priceInPerMTok: 1,
  priceOutPerMTok: 5,
};
