// SPDX-License-Identifier: Apache-2.0
// Shared builders for gate/memory/output/entry tests. No network.
import type {
  FilteredFinding,
  ModelSpec,
  ReviewResult,
} from "../../src/types.js";

export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const MB = "c".repeat(40);
export const KEY = "d".repeat(64);

let n = 0;
export function finding(over: Partial<FilteredFinding> = {}): FilteredFinding {
  n++;
  return {
    id: `F${n}`,
    file: "src/a.ts",
    line: 10,
    lens: "correctness",
    severity: "high",
    title: "Off-by-one in loop bound",
    failureScenario:
      "With items=[1,2,3] the loop reads items[3] and returns undefined.",
    body: "The loop uses <= instead of <.",
    preExisting: false,
    origin: "reviewer",
    raisedByModel: "claude-x",
    fingerprint: `abcdef${String(n).padStart(6, "0")}`,
    placement: "inline",
    placementReason: "line in diff",
    ...over,
  };
}

export function result(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    schemaVersion: 1,
    repo: "thesiclab/demo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    mergeBase: MB,
    cacheKey: KEY,
    round: 2,
    reviewer: { model: "claude-x", family: "claude" },
    adversary: { model: "glm-x", family: "glm" },
    providersSawCode: ["anthropic:claude-x", "openai-compatible:glm-x"],
    findings: [],
    notRead: [],
    coverage: {
      filesInDiff: 2,
      filesRead: 2,
      tokensUsed: 100,
      tokenBudget: 60000,
    },
    gate: {
      conclusion: "success",
      summary: "No blocking findings.",
      reasons: [],
      blockingFindingIds: [],
    },
    cost: { estimateUsd: 0.5, spentUsd: 0.1, capUsd: 2, usage: [] },
    redactions: [],
    counts: {
      inline: 0,
      body: 0,
      "pre-existing": 0,
      dismissed: 0,
      disputed: 0,
      dropped: 0,
    },
    ...over,
  };
}

export function spec(over: Partial<ModelSpec> = {}): ModelSpec {
  return {
    provider: "fake",
    model: "m",
    family: "claude",
    maxOutputTokens: 1000,
    priceInPerMTok: 3,
    priceOutPerMTok: 15,
    ...over,
  };
}
