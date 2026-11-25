// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelSpec, ModelUsage } from "../../src/types.js";
import type { CostMeter } from "../../src/cost/index.js";
import {
  createAnthropicAdapter,
  createFakeAdapter,
  createOpenAICompatAdapter,
  extractJson,
  familyCheck,
  resolveFamily,
  toProviderSchema,
  type SchemaCheck,
} from "../../src/models/index.js";
import {
  REVIEWER_SCHEMA,
  validateReviewerOutput,
} from "../../src/roles/index.js";
import { raw, SPEC } from "../fixtures/prompt-inputs.js";
import { FAKE } from "../fixtures/fake-secrets.js";

const REQ: ModelRequest = {
  system: "sys",
  user: "user",
  schema: REVIEWER_SCHEMA,
  schemaName: "submit_review",
  maxOutputTokens: 500,
};
const GOOD = JSON.stringify({ findings: [raw()] });

/** Test-local meter (module 10 is another worker's): records calls, can refuse. */
function testMeter(
  opts: { refuse?: boolean } = {},
): CostMeter & { reserves: number; settles: ModelUsage[] } {
  const settles: ModelUsage[] = [];
  const m = {
    capUsd: 2,
    spentUsd: 0,
    reserves: 0,
    settles,
    reserve: () => {
      m.reserves++;
      return !opts.refuse;
    },
    settle: (
      _s: ModelSpec,
      u: { inputTokens: number; outputTokens: number },
    ) => {
      const r = { ...u, costUsd: u.inputTokens / 1e6 + u.outputTokens / 1e6 };
      settles.push(r);
      return r;
    },
    usage: () => settles,
  };
  return m;
}

type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
function fakeFetch(replies: Reply[]) {
  const calls: {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init!,
      body: JSON.parse(String(init!.body)),
    });
    const r = replies.shift();
    if (!r) throw new Error("no more fake replies");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const anthropicSpec: ModelSpec = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  family: "claude",
  maxOutputTokens: 500,
  priceInPerMTok: 4,
  priceOutPerMTok: 20,
};
const glmSpec: ModelSpec = {
  provider: "openai-compatible",
  model: "glm-4.6",
  family: "glm",
  baseUrl: "https://api.z.ai/api/paas/v4/",
  maxOutputTokens: 500,
  priceInPerMTok: 1,
  priceOutPerMTok: 2,
};
const anthropicOk = (text: string, stop = "end_turn") => ({
  status: 200,
  body: {
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text },
    ],
    stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 50 },
  },
});
const openaiOk = (content: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    choices: [{ message: { content, ...extra }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  },
});

describe("extractJson (strict repair)", () => {
  it("parses a plain object", () =>
    expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it("strips one code fence", () =>
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it("takes the outermost balanced object, braces in strings included", () => {
    expect(extractJson('Here you go: {"a":"}{","b":{"c":2}} thanks')).toEqual({
      a: "}{",
      b: { c: 2 },
    });
  });
  it("returns undefined for a bare array, prose or broken JSON", () => {
    expect(extractJson("[1,2]")).toBeUndefined();
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson('{"a":')).toBeUndefined();
  });
});

describe("resolveFamily / familyCheck", () => {
  it("maps the known prefixes", () => {
    expect(resolveFamily("anthropic", "claude-opus-5-5")).toBe("claude");
    expect(resolveFamily("openai-compatible", "glm-4.6")).toBe("glm");
    expect(resolveFamily("openai-compatible", "gpt-5")).toBe("gpt");
    expect(resolveFamily("openai-compatible", "o3-mini")).toBe("gpt");
    expect(resolveFamily("openai-compatible", "gemini-2.5-pro")).toBe("gemini");
    expect(resolveFamily("openai-compatible", "qwen3-coder:30b")).toBe("qwen");
    expect(resolveFamily("openai-compatible", "kimi-k2")).toBe("kimi");
    expect(resolveFamily("openai-compatible", "deepseek-v3")).toBe("deepseek");
    expect(resolveFamily("openai-compatible", "llama3.3:70b")).toBe("llama");
  });
  it("strips router prefixes", () => {
    expect(resolveFamily("openai-compatible", "z-ai/glm-4.6")).toBe("glm");
    expect(
      resolveFamily("openai-compatible", "us.anthropic.claude-opus-5-5"),
    ).toBe("claude");
  });
  it("an override wins; unknown without override throws", () => {
    expect(resolveFamily("openai-compatible", "mystery-1", "Mistral")).toBe(
      "mistral",
    );
    expect(() => resolveFamily("openai-compatible", "mystery-1")).toThrow(
      /family/,
    );
  });
  it("flags single family for a missing or same-family adversary", () => {
    expect(familyCheck(anthropicSpec, glmSpec)).toEqual({ ok: true });
    expect(familyCheck(anthropicSpec, null)).toEqual({
      ok: false,
      reason: { kind: "single-family", family: "claude" },
    });
    expect(
      familyCheck(anthropicSpec, {
        ...anthropicSpec,
        model: "claude-sonnet-5-5",
      }),
    ).toEqual({
      ok: false,
      reason: { kind: "single-family", family: "claude" },
    });
  });
});

describe("fake adapter (shared completion loop)", () => {
  it("returns validated output without repair", async () => {
    const a = createFakeAdapter(SPEC, () => GOOD);
    const r = await a.complete(REQ, validateReviewerOutput);
    expect(r.ok && r.value.findings).toHaveLength(1);
    expect(r.ok && r.repaired).toBe(false);
    expect(r.usage.costUsd).toBeGreaterThan(0);
  });

  it("repairs a fenced reply and a string-encoded array", async () => {
    const fenced = await createFakeAdapter(
      SPEC,
      () => "```json\n" + GOOD + "\n```",
    ).complete(REQ, validateReviewerOutput);
    expect(fenced.ok && fenced.repaired).toBe(true);
    const stringArray = await createFakeAdapter(SPEC, () =>
      JSON.stringify({ findings: JSON.stringify([raw()]) }),
    ).complete(REQ, validateReviewerOutput);
    expect(stringArray.ok && stringArray.value.findings[0]?.file).toBe(
      "src/math.ts",
    );
    expect(stringArray.ok && stringArray.repaired).toBe(true);
  });

  it("re-asks once with the validation errors, then succeeds", async () => {
    const seen: string[] = [];
    const a = createFakeAdapter(SPEC, (req, i) => {
      seen.push(req.user);
      return i === 0
        ? JSON.stringify({ findings: [{ ...raw(), severity: "urgent" }] })
        : GOOD;
    });
    const r = await a.complete(REQ, validateReviewerOutput);
    expect(r.ok).toBe(true);
    expect(r.ok && r.repaired).toBe(true);
    expect(seen[1]).toContain("did not pass validation");
    expect(seen[1]).toContain("severity must be one of");
  });

  it("a second invalid reply is a schema error (gate goes neutral), with no third call", async () => {
    let calls = 0;
    const r = await createFakeAdapter(SPEC, () => {
      calls++;
      return "not json at all";
    }).complete(REQ, validateReviewerOutput);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe("schema");
    expect(calls).toBe(2);
  });

  it("passes scripted provider errors through", async () => {
    const r = await createFakeAdapter(SPEC, () => ({
      error: { kind: "http", status: 500, message: "boom" },
    })).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error).toEqual({
      kind: "http",
      status: 500,
      message: "boom",
    });
  });

  it("never calls global fetch", async () => {
    await createFakeAdapter(SPEC, () => GOOD).complete(
      REQ,
      validateReviewerOutput,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("anthropic adapter", () => {
  it("sends output_config json_schema, no tools, no temperature, and reads the text block", async () => {
    const f = fakeFetch([anthropicOk(GOOD)]);
    const meter = testMeter();
    const a = createAnthropicAdapter(anthropicSpec, {
      fetch: f.fn,
      apiKey: "test-key",
      timeoutMs: 5000,
      meter,
    });
    const r = await a.complete(
      { ...REQ, temperature: 0 },
      validateReviewerOutput,
    );
    expect(r.ok).toBe(true);
    const { url, init, body } = f.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe(
      "2023-06-01",
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(
      (body.output_config as { format: { type: string } }).format.type,
    ).toBe("json_schema");
    expect(meter.reserves).toBe(1);
    expect(meter.settles[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(r.usage.inputTokens).toBe(100);
  });

  it("a refusal stop reason is a refusal error", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          content: [],
          stop_reason: "refusal",
          stop_details: { category: "cyber" },
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
    ]);
    const r = await createAnthropicAdapter(anthropicSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error.kind).toBe("refusal");
  });

  it("retries once on 429 after retry-after, not twice", async () => {
    const f = fakeFetch([
      {
        status: 429,
        body: { error: { message: "slow down" } },
        headers: { "retry-after": "0" },
      },
      {
        status: 529,
        body: { error: { message: "overloaded" } },
        headers: { "retry-after": "0" },
      },
    ]);
    const r = await createAnthropicAdapter(anthropicSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(f.calls).toHaveLength(2);
    expect(!r.ok && r.error).toEqual({
      kind: "http",
      status: 529,
      message: "overloaded",
    });
  });

  it("does not retry a 400, and redacts a provider message that echoes a secret", async () => {
    const f = fakeFetch([
      {
        status: 400,
        body: { error: { message: `bad key ${FAKE.anthropic}` } },
      },
    ]);
    const r = await createAnthropicAdapter(anthropicSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(f.calls).toHaveLength(1);
    expect(!r.ok && r.error.message).not.toContain(FAKE.anthropic);
  });

  it("a failed reservation is a budget error and nothing is sent", async () => {
    const f = fakeFetch([]);
    const r = await createAnthropicAdapter(anthropicSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter({ refuse: true }),
    }).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error.kind).toBe("budget");
    expect(f.calls).toHaveLength(0);
  });

  it("times out", async () => {
    const hang = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init!.signal!.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          ),
        ),
    ) as unknown as typeof fetch;
    const r = await createAnthropicAdapter(anthropicSpec, {
      fetch: hang,
      apiKey: "k",
      timeoutMs: 20,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error.kind).toBe("timeout");
  });

  it("a missing key is a config error", async () => {
    const r = await createAnthropicAdapter(anthropicSpec, {
      fetch: fakeFetch([]).fn,
      apiKey: "",
      timeoutMs: 50,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error.kind).toBe("config");
  });
});

describe("openai-compatible adapter", () => {
  it("posts to baseUrl/chat/completions with response_format json_schema", async () => {
    const f = fakeFetch([openaiOk(GOOD)]);
    const r = await createOpenAICompatAdapter(glmSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.url).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
    expect((f.calls[0]!.body.response_format as { type: string }).type).toBe(
      "json_schema",
    );
    expect(
      (f.calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer k");
    expect(r.usage.inputTokens).toBe(80);
  });

  it("falls back to json_object when json_schema is rejected, and stays there", async () => {
    const f = fakeFetch([
      {
        status: 400,
        body: {
          error: { message: "response_format json_schema is not supported" },
        },
      },
      openaiOk(GOOD),
      openaiOk(GOOD),
    ]);
    const a = createOpenAICompatAdapter(glmSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter(),
    });
    expect((await a.complete(REQ, validateReviewerOutput)).ok).toBe(true);
    expect((await a.complete(REQ, validateReviewerOutput)).ok).toBe(true);
    expect(
      f.calls.map((c) => (c.body.response_format as { type: string }).type),
    ).toEqual(["json_schema", "json_object", "json_object"]);
  });

  it("a refusal field is a refusal error", async () => {
    const f = fakeFetch([openaiOk("", { refusal: "cannot help" })]);
    const r = await createOpenAICompatAdapter(glmSpec, {
      fetch: f.fn,
      apiKey: "k",
      timeoutMs: 5000,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error.kind).toBe("refusal");
  });

  it("needs a baseUrl", async () => {
    const { baseUrl: _b, ...noBase } = glmSpec;
    const r = await createOpenAICompatAdapter(noBase, {
      fetch: fakeFetch([]).fn,
      apiKey: "k",
      timeoutMs: 50,
      meter: testMeter(),
    }).complete(REQ, validateReviewerOutput);
    expect(!r.ok && r.error.kind).toBe("config");
  });
});

describe("toProviderSchema", () => {
  it("drops length and numeric bounds and closes every object", () => {
    const s = toProviderSchema({
      type: "object",
      properties: {
        a: { type: "string", maxLength: 3 },
        b: { type: "object", properties: {} },
      },
    });
    expect(JSON.stringify(s)).not.toContain("maxLength");
    expect(
      (s.properties as Record<string, Record<string, unknown>>).b!
        .additionalProperties,
    ).toBe(false);
    expect(s.additionalProperties).toBe(false);
  });
});

// Type-level: SchemaCheck stays the contract shape.
const _check: SchemaCheck<number> = { ok: false, errors: [] };
void _check;
