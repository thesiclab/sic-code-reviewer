// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  createMeter,
  estimate,
  PROMPT_OVERHEAD_TOKENS,
  priceUsd,
} from "../../src/cost/index.js";
import type { ContextBundle, PatchSet } from "../../src/types.js";
import { spec } from "../helpers/fixtures.js";

const patch = (fullText: string): PatchSet => ({
  baseSha: "b",
  headSha: "h",
  mergeBase: "m",
  files: [],
  fullText,
  incrementalText: null,
  excluded: [],
  lockfileNotes: [],
});
const ctx = (tokensUsed: number): ContextBundle => ({
  items: [],
  notRead: [],
  tokensUsed,
  tokenBudget: 60000,
});

describe("cost.estimate", () => {
  it("counts reviewer, adversary and counter-check at full max output", () => {
    const r = spec({
      model: "claude-x",
      maxOutputTokens: 1000,
      priceInPerMTok: 3,
      priceOutPerMTok: 15,
    });
    const a = spec({
      model: "glm-x",
      family: "glm",
      maxOutputTokens: 2000,
      priceInPerMTok: 1,
      priceOutPerMTok: 2,
    });
    const e = estimate(patch("x".repeat(4000)), ctx(500), r, a);
    const shared = PROMPT_OVERHEAD_TOKENS + 1000 + 500;
    expect(e.calls.map((c) => c.role)).toEqual([
      "reviewer",
      "adversary",
      "counter-check",
    ]);
    expect(e.calls[0]!.inputTokens).toBe(shared);
    expect(e.calls[1]!.inputTokens).toBe(shared + 1000);
    expect(e.calls[2]!.inputTokens).toBe(shared + 2000);
    expect(e.calls[2]!.model).toBe("claude-x");
    const sum =
      priceUsd(r, shared, 1000) +
      priceUsd(a, shared + 1000, 2000) +
      priceUsd(r, shared + 2000, 1000);
    expect(e.totalUsd).toBeCloseTo(sum, 6);
  });

  it("has a single call without an adversary", () => {
    const e = estimate(patch("abc"), ctx(0), spec(), null);
    expect(e.calls).toHaveLength(1);
  });
});

describe("cost.createMeter", () => {
  it("reserves the worst case and refuses a call that would cross the cap", () => {
    const s = spec({ priceInPerMTok: 1_000_000, priceOutPerMTok: 0 }); // $1 per input token
    const m = createMeter(2);
    expect(m.reserve(s, 1, 0)).toBe(true);
    expect(m.reserve(s, 1, 0)).toBe(true); // exactly at cap is allowed
    expect(m.reserve(s, 1, 0)).toBe(false);
    expect(m.spentUsd).toBe(0);
  });

  it("settle releases the reservation and charges actual usage", () => {
    const s = spec({ priceInPerMTok: 1_000_000, priceOutPerMTok: 1_000_000 });
    const m = createMeter(10);
    expect(m.reserve(s, 2, 8)).toBe(true); // $10 held
    expect(m.reserve(s, 1, 0)).toBe(false);
    const u = m.settle(s, { inputTokens: 2, outputTokens: 1 });
    expect(u.costUsd).toBe(3);
    expect(m.spentUsd).toBe(3);
    expect(m.reserve(s, 7, 0)).toBe(true);
    expect(m.usage()).toEqual([
      { inputTokens: 2, outputTokens: 1, costUsd: 3 },
    ]);
  });

  it("a failed call settles at zero and frees its reservation", () => {
    const s = spec({ priceInPerMTok: 1_000_000, priceOutPerMTok: 0 });
    const m = createMeter(1);
    expect(m.reserve(s, 1, 0)).toBe(true);
    m.settle(s, { inputTokens: 0, outputTokens: 0 });
    expect(m.reserve(s, 1, 0)).toBe(true);
  });

  it("rejects a bad cap", () => {
    expect(() => createMeter(-1)).toThrow();
    expect(() => createMeter(Number.NaN)).toThrow();
  });
});
