// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  parseConfigYaml,
  checkBaseUrl,
} from "../../src/config/index.js";

const INPUTS: Record<string, string> = {
  "reviewer-provider": "anthropic",
  "reviewer-model": "claude-sonnet-5-5",
  "reviewer-price-in-per-mtok": "3",
  "reviewer-price-out-per-mtok": "15",
  "adversary-provider": "openai-compatible",
  "adversary-model": "glm-5.3",
  "adversary-base-url": "https://api.z.ai/api/paas/v4",
  "adversary-api-key-env": "ZAI_API_KEY",
  "adversary-price-in-per-mtok": "1",
  "adversary-price-out-per-mtok": "4",
  "max-cost-usd": "2.00",
  "bot-logins": "github-actions[bot]",
  "check-name": "sic-code-reviewer",
};

describe("loadConfig", () => {
  it("builds the default duo from action inputs", () => {
    const { config, configHash, warnings } = loadConfig(INPUTS, null);
    expect(config.reviewer.family).toBe("claude");
    expect(config.reviewer.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.adversary?.family).toBe("glm");
    expect(config.maxCostUsd).toBe(2);
    expect(config.repeatCap).toBe(2);
    expect(config.allowSecondProviderOnPrivate).toBe(false);
    expect(configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings).toEqual([]);
  });

  it("the base-branch file overrides models, budget, caps and guidance", () => {
    const file = [
      "# repo config",
      "reviewer:",
      "  model: claude-opus-5-5",
      "  max-output-tokens: 32000",
      "adversary:",
      "  model: glm-5.3-air",
      "max-cost-usd: 0.5",
      "max-inline: 5",
      "context:",
      "  token-budget: 20000",
      "guidance: |",
      "  Money is in integer cents.",
      "  Never log user emails.",
    ].join("\n");
    const { config } = loadConfig(INPUTS, file);
    expect(config.reviewer.model).toBe("claude-opus-5-5");
    expect(config.reviewer.maxOutputTokens).toBe(32000);
    expect(config.adversary?.model).toBe("glm-5.3-air");
    expect(config.adversary?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(config.maxCostUsd).toBe(0.5);
    expect(config.maxInline).toBe(5);
    expect(config.context.tokenBudget).toBe(20000);
    expect(config.guidance).toBe(
      "Money is in integer cents.\nNever log user emails.",
    );
  });

  it("the hash changes with the config and not with key order", () => {
    const a = loadConfig(INPUTS, "max-inline: 5\nmax-cost-usd: 1").configHash;
    const b = loadConfig(INPUTS, "max-cost-usd: 1\nmax-inline: 5").configHash;
    const c = loadConfig(INPUTS, "max-cost-usd: 1\nmax-inline: 6").configHash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("the base file cannot set trust or data-flow keys, or switch off defences", () => {
    const { config, warnings } = loadConfig(
      INPUTS,
      "bot-logins: evil\nallow-second-provider-on-private: true\nfencing: false\nredaction: off\n",
    );
    expect(config.botLogins).toEqual(["github-actions[bot]"]);
    expect(config.allowSecondProviderOnPrivate).toBe(false);
    expect(warnings.join("\n")).toMatch(/bot-logins/);
    expect(warnings.join("\n")).toMatch(/fencing/);
  });

  it("repeat-cap may be lowered, not raised", () => {
    expect(loadConfig(INPUTS, "repeat-cap: 1").config.repeatCap).toBe(1);
    const r = loadConfig(INPUTS, "repeat-cap: 9");
    expect(r.config.repeatCap).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/lowered, not raised/);
  });

  it("adversary: none runs single family with a warning", () => {
    const r = loadConfig(INPUTS, "adversary: none");
    expect(r.config.adversary).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/single family/);
  });

  it("same family is a warning, not an error", () => {
    const r = loadConfig(
      {
        ...INPUTS,
        "adversary-provider": "anthropic",
        "adversary-model": "claude-haiku-5",
        "adversary-api-key-env": "ANTHROPIC_API_KEY",
        "adversary-base-url": "",
      },
      null,
    );
    expect(r.config.adversary?.family).toBe("claude");
    expect(r.warnings.join(" ")).toMatch(/single family/);
  });

  it("fails closed on missing prices, bad key env names, bad URLs and bad numbers", () => {
    const { ["reviewer-price-in-per-mtok"]: _drop, ...noPrice } = INPUTS;
    expect(() => loadConfig(noPrice, null)).toThrow(/price/);
    expect(() =>
      loadConfig({ ...INPUTS, "adversary-api-key-env": "sk-not-a-name" }, null),
    ).toThrow(/NAME of an environment variable/);
    expect(() =>
      loadConfig(
        { ...INPUTS, "adversary-base-url": "http://api.example.com" },
        null,
      ),
    ).toThrow(/https/);
    expect(() => loadConfig(INPUTS, "max-cost-usd: 5000")).toThrow(
      /max-cost-usd/,
    );
    expect(() => loadConfig({ ...INPUTS, "reviewer-model": "" }, null)).toThrow(
      /reviewer-model/,
    );
    expect(() => loadConfig({ ...INPUTS, "bot-logins": "a b" }, null)).toThrow(
      /bot-logins/,
    );
    expect(() =>
      loadConfig({ ...INPUTS, "adversary-model": "mystery-7b" }, null),
    ).toThrow(/family/);
  });

  it("an unknown model with an explicit family works (local model slot)", () => {
    const r = loadConfig(
      {
        ...INPUTS,
        "adversary-model": "mystery-7b",
        "adversary-family": "mystery",
        "adversary-base-url": "http://192.168.6.56:11434/v1",
      },
      null,
    );
    expect(r.config.adversary?.family).toBe("mystery");
  });
});

describe("parseConfigYaml (small subset)", () => {
  it("parses nested maps, quotes, comments and block scalars", () => {
    const v = parseConfigYaml(
      [
        "a: 1",
        "b: 'it''s'",
        'c: "x # not a comment"',
        "d:   # comment",
        "  e: true",
        "  f: null",
        "g: >",
        "  one",
        "  two",
        "",
      ].join("\n"),
    );
    expect(v).toEqual({
      a: 1,
      b: "it's",
      c: "x # not a comment",
      d: { e: true, f: null },
      g: "one two\n",
    });
  });
  it("accepts JSON", () => {
    expect(parseConfigYaml('{"max-inline": 3}')).toEqual({ "max-inline": 3 });
  });
  it("rejects what it does not support", () => {
    expect(() => parseConfigYaml("a:\n  - 1")).toThrow();
    expect(() => parseConfigYaml("a: &x 1")).toThrow();
    expect(() => parseConfigYaml("a: 1\na: 2")).toThrow(/duplicate/);
    expect(() => parseConfigYaml("__proto__: 1")).toThrow();
    expect(() => parseConfigYaml("\ta: 1")).toThrow(/tabs/);
  });
});

describe("checkBaseUrl", () => {
  it("https anywhere, http only to private hosts, never credentials", () => {
    expect(checkBaseUrl("https://api.z.ai/v4/", "x")).toBe(
      "https://api.z.ai/v4",
    );
    expect(checkBaseUrl("http://10.0.0.5:11434/v1", "x")).toBe(
      "http://10.0.0.5:11434/v1",
    );
    expect(() => checkBaseUrl("http://8.8.8.8/v1", "x")).toThrow();
    expect(() => checkBaseUrl("https://u:p@api.z.ai", "x")).toThrow(
      /credentials/,
    );
  });
});
