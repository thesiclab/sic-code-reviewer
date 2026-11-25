// SPDX-License-Identifier: Apache-2.0
// Module 7: gate and per-commit cache. New code. The fail-closed principle
// comes from Comfy's Panel integrity design (no code copied).
//
// Verdict table, first match wins (CONTRACT.md module 7):
//   fork PR -> neutral; diff over cap -> neutral; estimate over cap -> neutral;
//   any model failure / budget exhausted -> neutral (never green);
//   a surviving inline or body finding with severity critical/high -> failure;
//   otherwise success (labelled "single family" when the family check failed).
import { createHash } from "node:crypto";
import { BLOCKING_SEVERITIES } from "../types.js";
import type {
  FilteredFinding,
  GateReason,
  GateResult,
  Placement,
  ReviewResult,
} from "../types.js";
import type { GitHubReader } from "../github/index.js";
import { parseRoundSentinel } from "../memory/index.js";

export interface GateInput {
  findings: FilteredFinding[];
  failures: GateReason[];
}

export interface CacheStore {
  get(key: string): Promise<ReviewResult | null>;
  put(key: string, result: ReviewResult): Promise<void>;
}

export interface CacheKeyParts {
  headSha: string;
  mergeBase: string;
  configHash: string;
  promptHash: string;
  reviewer: string;
  adversary: string | null;
  actionVersion: string;
}

/** Placements that can fail the gate. pre-existing, dismissed, disputed and dropped never do. */
export const GATING_PLACEMENTS: readonly Placement[] = ["inline", "body"];

export function isBlocking(f: FilteredFinding): boolean {
  return (
    GATING_PLACEMENTS.includes(f.placement) &&
    BLOCKING_SEVERITIES.includes(f.severity)
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function decide(input: GateInput): GateResult {
  const blocking = input.findings.filter(isBlocking);
  const blockingFindingIds = blocking.map((f) => f.id);
  const reasons: GateReason[] = [...input.failures];
  if (blocking.length > 0)
    reasons.push({ kind: "blocking-findings", count: blocking.length });

  const has = <K extends GateReason["kind"]>(kind: K) =>
    input.failures.find(
      (r): r is Extract<GateReason, { kind: K }> => r.kind === kind,
    );
  const singleFamily = has("single-family");
  const label = singleFamily
    ? ` (single family: ${singleFamily.family}; not a duo verdict)`
    : "";
  const neutral = (summary: string): GateResult => ({
    conclusion: "neutral",
    summary,
    reasons,
    blockingFindingIds,
  });

  if (has("fork-not-reviewed")) return neutral("Not reviewed (fork).");
  const overCap = has("diff-over-cap");
  if (overCap)
    return neutral(
      `Not reviewed: the diff has ${overCap.lines} lines, over the ${overCap.cap}-line cap.`,
    );
  const overEstimate = has("estimate-over-cap");
  if (overEstimate) {
    return neutral(
      `Not reviewed: estimated cost $${overEstimate.estimateUsd.toFixed(2)} is over the $${overEstimate.capUsd.toFixed(2)} cap.`,
    );
  }
  const failures = input.failures.filter(
    (
      r,
    ): r is Extract<
      GateReason,
      { kind: "model-failure" | "budget-exhausted" }
    > => r.kind === "model-failure" || r.kind === "budget-exhausted",
  );
  if (failures.length > 0) {
    const what = failures
      .map((r) =>
        r.kind === "model-failure"
          ? `${r.role} model failed (${r.error.kind})`
          : `budget exhausted ($${r.spentUsd.toFixed(2)} of $${r.capUsd.toFixed(2)})`,
      )
      .join("; ");
    const pending =
      blocking.length > 0
        ? ` ${plural(blocking.length, "blocking finding", "blocking findings")} so far.`
        : "";
    return neutral(`Partial review, not a pass: ${what}.${pending}`);
  }
  if (blocking.length > 0) {
    const crit = blocking.filter((f) => f.severity === "critical").length;
    const high = blocking.length - crit;
    const parts = [
      crit ? plural(crit, "critical", "critical") : "",
      high ? plural(high, "high", "high") : "",
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      conclusion: "failure",
      summary: `${parts} severity ${blocking.length === 1 ? "finding" : "findings"} survived${label}.`,
      reasons,
      blockingFindingIds,
    };
  }
  return {
    conclusion: "success",
    summary: `No blocking findings${label}.`,
    reasons,
    blockingFindingIds,
  };
}

/** sha256 over a fixed, versioned encoding of every input that can change the verdict. */
export function cacheKey(parts: CacheKeyParts): string {
  const encoded = JSON.stringify([
    "sic-code-reviewer:cache:v1",
    parts.headSha,
    parts.mergeBase,
    parts.configHash,
    parts.promptHash,
    parts.reviewer,
    parts.adversary,
    parts.actionVersion,
  ]);
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

/** Only decided verdicts are cached. A neutral run (model failure, budget, caps) is retried next time. */
function cacheable(conclusion: string): boolean {
  return conclusion === "success" || conclusion === "failure";
}

/**
 * The per-commit cache is the round sentinel our bot posted: a review whose
 * sentinel carries the same cache key (and whose head equals the review's own
 * commit) already decided this exact input. The hit is a stub result that
 * carries the cached verdict and a "cached" reason; the post job re-verifies
 * the sentinel against GitHub before it re-sets the check, and never re-posts.
 * put() is a no-op: posting the review is what writes the cache.
 */
export function createSentinelCache(
  gh: GitHubReader,
  repo: string,
  pr: number,
): CacheStore {
  return {
    async get(key) {
      const reviews = await gh.listReviews(repo, pr);
      for (let i = reviews.length - 1; i >= 0; i--) {
        const r = reviews[i]!;
        if (r.authorType !== "Bot") continue;
        const s = parseRoundSentinel(r.body);
        if (!s || s.cacheKey !== key || s.headSha !== r.commitId) continue;
        if (!cacheable(s.conclusion)) return null;
        return cachedStub(
          repo,
          pr,
          s.headSha,
          s.baseSha,
          s.mergeBase,
          key,
          s.round,
          s.conclusion,
        );
      }
      return null;
    },
    async put() {
      /* the posted review is the cache entry */
    },
  };
}

export function cachedStub(
  repo: string,
  pr: number,
  headSha: string,
  baseSha: string,
  mergeBase: string,
  key: string,
  round: number,
  conclusion: "success" | "failure" | "neutral",
): ReviewResult {
  return {
    schemaVersion: 1,
    repo,
    prNumber: pr,
    headSha,
    baseSha,
    mergeBase,
    cacheKey: key,
    round,
    reviewer: { model: "cached", family: "cached" },
    adversary: null,
    providersSawCode: [],
    findings: [],
    notRead: [],
    coverage: { filesInDiff: 0, filesRead: 0, tokensUsed: 0, tokenBudget: 0 },
    gate: {
      conclusion,
      summary: `Same input as round ${round}: verdict re-used (${conclusion}).`,
      reasons: [{ kind: "cached", cacheKey: key }],
      blockingFindingIds: [],
    },
    cost: { estimateUsd: 0, spentUsd: 0, capUsd: 0, usage: [] },
    redactions: [],
    counts: {
      inline: 0,
      body: 0,
      "pre-existing": 0,
      dismissed: 0,
      disputed: 0,
      dropped: 0,
    },
  };
}

export function createMemoryCache(): CacheStore {
  const store = new Map<string, ReviewResult>();
  return {
    async get(key) {
      const hit = store.get(key);
      return hit ? structuredClone(hit) : null;
    },
    async put(key, result) {
      if (!cacheable(result.gate.conclusion)) return;
      store.set(key, structuredClone(result));
    },
  };
}
