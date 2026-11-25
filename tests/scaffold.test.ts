// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalizeSeverity, SEVERITY_RUBRIC } from "../src/findings/index.js";
import { estimateTokens } from "../src/cost/index.js";
import { SEVERITIES } from "../src/types.js";
import { NotImplemented } from "../src/errors.js";
import { decide } from "../src/gate/index.js";

describe("scaffold", () => {
  it("blocks the network in tests", () => {
    expect(() => fetch("https://api.anthropic.com/v1/messages")).toThrow(/network access is not allowed/);
  });

  it("normalizes severity, defaulting to medium", () => {
    expect(normalizeSeverity("HIGH ")).toBe("high");
    expect(normalizeSeverity("blocker")).toBe("medium");
    expect(normalizeSeverity(undefined)).toBe("medium");
  });

  it("has a rubric line for every severity", () => {
    for (const s of SEVERITIES) expect(SEVERITY_RUBRIC[s].length).toBeGreaterThan(10);
  });

  it("estimates tokens as chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("stubs throw NotImplemented until built", () => {
    expect(() => decide({ findings: [], failures: [] })).toThrow(NotImplemented);
  });
});
