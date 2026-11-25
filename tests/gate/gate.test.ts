// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  cacheKey,
  createMemoryCache,
  createSentinelCache,
  decide,
} from "../../src/gate/index.js";
import { renderRoundSentinel } from "../../src/memory/index.js";
import type { GitHubReader, ReviewRecord } from "../../src/github/index.js";
import type { GateReason, ModelError } from "../../src/types.js";
import { BASE, finding, HEAD, KEY, MB, result } from "../helpers/fixtures.js";

const err: ModelError = { kind: "http", message: "boom", status: 500 };

describe("gate.decide verdict table", () => {
  it("success with no findings", () => {
    expect(decide({ findings: [], failures: [] }).conclusion).toBe("success");
  });

  it("fails on a surviving inline or body critical/high", () => {
    for (const placement of ["inline", "body"] as const) {
      for (const severity of ["critical", "high"] as const) {
        const g = decide({
          findings: [finding({ placement, severity })],
          failures: [],
        });
        expect(g.conclusion).toBe("failure");
        expect(g.blockingFindingIds).toHaveLength(1);
        expect(g.reasons).toContainEqual({
          kind: "blocking-findings",
          count: 1,
        });
      }
    }
  });

  it("never gates on medium/low/nit or on pre-existing, dismissed, disputed, dropped", () => {
    const fs = [
      finding({ severity: "medium" }),
      finding({ severity: "low", placement: "body" }),
      finding({ severity: "nit" }),
      finding({ placement: "pre-existing", severity: "critical" }),
      finding({ placement: "dismissed", severity: "critical" }),
      finding({ placement: "disputed", severity: "high" }),
      finding({ placement: "dropped", severity: "critical" }),
    ];
    const g = decide({ findings: fs, failures: [] });
    expect(g.conclusion).toBe("success");
    expect(g.blockingFindingIds).toEqual([]);
  });

  it("any model failure or budget exhaustion is neutral, never green, even with blocking findings", () => {
    const cases: GateReason[] = [
      { kind: "model-failure", role: "reviewer", error: err },
      {
        kind: "model-failure",
        role: "adversary",
        error: { kind: "schema", message: "bad" },
      },
      { kind: "model-failure", role: "counter-check", error: err },
      { kind: "budget-exhausted", spentUsd: 1.9, capUsd: 2 },
    ];
    for (const r of cases) {
      expect(decide({ findings: [], failures: [r] }).conclusion).toBe(
        "neutral",
      );
      const g = decide({ findings: [finding()], failures: [r] });
      expect(g.conclusion).toBe("neutral");
      expect(g.summary).toMatch(/not a pass/);
    }
  });

  it("first match wins: fork, diff cap, estimate cap", () => {
    const all: GateReason[] = [
      { kind: "estimate-over-cap", estimateUsd: 3, capUsd: 2 },
      { kind: "diff-over-cap", lines: 9000, cap: 5000 },
      { kind: "fork-not-reviewed" },
    ];
    expect(decide({ findings: [finding()], failures: all }).summary).toMatch(
      /fork/,
    );
    expect(decide({ findings: [], failures: all.slice(0, 2) }).summary).toMatch(
      /9000 lines/,
    );
    expect(decide({ findings: [], failures: all.slice(0, 1) }).summary).toMatch(
      /\$3\.00/,
    );
  });

  it("single family is a label, not a verdict change", () => {
    const sf: GateReason = { kind: "single-family", family: "claude" };
    const ok = decide({ findings: [], failures: [sf] });
    expect(ok.conclusion).toBe("success");
    expect(ok.summary).toMatch(/single family/);
    expect(decide({ findings: [finding()], failures: [sf] }).conclusion).toBe(
      "failure",
    );
  });
});

describe("gate.cacheKey", () => {
  const parts = {
    headSha: HEAD,
    mergeBase: MB,
    configHash: "c1",
    promptHash: "p1",
    reviewer: "claude-x",
    adversary: "glm-x",
    actionVersion: "0.1.0",
  };
  it("is stable and changes with every part", () => {
    const k = cacheKey(parts);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...parts })).toBe(k);
    for (const [name, value] of Object.entries({
      headSha: "e".repeat(40),
      mergeBase: "f".repeat(40),
      configHash: "c2",
      promptHash: "p2",
      reviewer: "claude-y",
      adversary: null,
      actionVersion: "0.1.1",
    })) {
      expect(cacheKey({ ...parts, [name]: value }), name).not.toBe(k);
    }
  });
});

describe("gate caches", () => {
  it("memory cache round-trips decided results and skips neutral ones", async () => {
    const c = createMemoryCache();
    await c.put(
      "k1",
      result({
        gate: {
          conclusion: "failure",
          summary: "x",
          reasons: [],
          blockingFindingIds: [],
        },
      }),
    );
    await c.put(
      "k2",
      result({
        gate: {
          conclusion: "neutral",
          summary: "x",
          reasons: [],
          blockingFindingIds: [],
        },
      }),
    );
    expect((await c.get("k1"))?.gate.conclusion).toBe("failure");
    expect(await c.get("k2")).toBeNull();
    expect(await c.get("nope")).toBeNull();
  });

  const reader = (reviews: ReviewRecord[]): GitHubReader => ({
    getPr: async () => {
      throw new Error("unused");
    },
    listReviews: async () => reviews,
    listReviewThreads: async () => [],
  });
  const sentinel = (
    conclusion: "success" | "failure" | "neutral",
    key = KEY,
    head = HEAD,
  ) =>
    `## x\n${renderRoundSentinel({ v: 1, round: 3, baseSha: BASE, headSha: head, mergeBase: MB, cacheKey: key, conclusion })}\n`;

  it("sentinel cache hits on our bot's review with the same key and head", async () => {
    const c = createSentinelCache(
      reader([
        {
          id: 1,
          body: sentinel("failure"),
          commitId: HEAD,
          author: "github-actions[bot]",
          authorType: "Bot",
        },
      ]),
      "o/r",
      7,
    );
    const hit = await c.get(KEY);
    expect(hit?.gate.conclusion).toBe("failure");
    expect(hit?.gate.reasons).toEqual([{ kind: "cached", cacheKey: KEY }]);
    expect(hit?.round).toBe(3);
  });

  it("sentinel cache ignores users, head mismatches, other keys and neutral rounds", async () => {
    const miss = async (r: ReviewRecord) =>
      createSentinelCache(reader([r]), "o/r", 7).get(KEY);
    const base = {
      id: 1,
      commitId: HEAD,
      author: "x",
      authorType: "Bot" as const,
    };
    expect(
      await miss({ ...base, body: sentinel("success"), authorType: "User" }),
    ).toBeNull();
    expect(
      await miss({
        ...base,
        body: sentinel("success"),
        commitId: "9".repeat(40),
      }),
    ).toBeNull();
    expect(
      await miss({ ...base, body: sentinel("success", "e".repeat(64)) }),
    ).toBeNull();
    expect(await miss({ ...base, body: sentinel("neutral") })).toBeNull();
    expect(
      await miss({ ...base, body: sentinel("success")
          .split("\n")
          .map((l) => "> " + l)
          .join("\n") }),
    ).toBeNull();
  });
});
