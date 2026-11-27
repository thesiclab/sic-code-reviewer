// SPDX-License-Identifier: Apache-2.0
// The claude CLI adapter against a fake `claude` executable on PATH. No real
// CLI, no network. The fake records its argv, environment, cwd and stdin so
// the tests can check what the adapter hands the child.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildClaudeArgs,
  createAnthropicAdapter,
  createClaudeCliAdapter,
  createOpenAICompatAdapter,
  parseCliEnvelope,
  scrubToken,
  type SchemaCheck,
} from "../../src/models/index.js";
import { createMeter } from "../../src/cost/index.js";
import { realAdapterFactory } from "../../src/entry/review.js";
import type { ModelRequest, ModelSpec } from "../../src/types.js";

// Assembled at run time so no token-shaped literal sits in the repository.
const TOKEN = ["sk", "ant", "oat01", "FAKEfakeFAKEfake0123456789abcdef"].join(
  "-",
);

const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const rec = path.join(__dirname, "calls.jsonl");
  fs.appendFileSync(rec, JSON.stringify({ args, env: process.env, cwd: process.cwd(), stdin }) + "\n");
  const calls = fs.readFileSync(rec, "utf8").trim().split("\n").length;
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10 };
  const ok = (extra) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, ...extra }));
  switch (model) {
    case "m-success": ok({ result: "", structured_output: { verdict: "ok" }, usage }); break;
    case "m-text": ok({ result: "Here: {\"verdict\":\"ok\"}", usage }); break;
    case "m-no-usage": ok({ result: "", structured_output: { verdict: "ok" } }); break;
    case "m-invalid": ok({ result: "", structured_output: { wrong: calls }, usage }); break;
    case "m-refusal": ok({ result: "no", stop_reason: "refusal", is_error: true, usage }); break;
    case "m-exit":
      process.stderr.write("auth failed for token " + process.env.CLAUDE_CODE_OAUTH_TOKEN + "\n");
      process.exit(1);
    case "m-is-error":
      process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", usage, errors: ["max turns"] }));
      process.exit(1);
    case "m-api-error":
      ok({ is_error: true, result: "API Error 401 " + process.env.CLAUDE_CODE_OAUTH_TOKEN, api_error_status: 401, terminal_reason: "api_error", usage });
      break;
    case "m-garbage": process.stdout.write("not json at all"); break;
    case "m-timeout": setTimeout(() => {}, 60000); break;
    default: process.exit(3);
  }
});
`;

let root: string;
let fakeDir: string;
let workRoot: string;
let PATH: string;

const schema = {
  type: "object",
  properties: { verdict: { type: "string", minLength: 1 } },
  required: ["verdict"],
};
const validate = (v: unknown): SchemaCheck<{ verdict: string }> => {
  const o = v as { verdict?: unknown };
  return o &&
    typeof o === "object" &&
    typeof o.verdict === "string" &&
    o.verdict
    ? { ok: true, value: { verdict: o.verdict } }
    : { ok: false, errors: ["verdict: required string"] };
};
const req = (): ModelRequest => ({
  system: "You are the reviewer. SYSTEM-MARKER",
  user: "the diff USER-MARKER",
  schema,
  schemaName: "review",
  maxOutputTokens: 4000,
});
const spec = (model: string): ModelSpec => ({
  provider: "claude-cli",
  model,
  family: "claude",
  apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  maxOutputTokens: 4000,
  priceInPerMTok: 3,
  priceOutPerMTok: 15,
});
const calls = (): {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}[] => {
  const f = join(fakeDir, "calls.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
};
const adapter = (model: string, timeoutMs = 20_000) =>
  createClaudeCliAdapter(spec(model), {
    token: TOKEN,
    timeoutMs,
    meter: createMeter(100),
    path: PATH,
    tmpRoot: workRoot,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sic-cli-test-"));
  fakeDir = join(root, "bin");
  workRoot = join(root, "work");
  mkdirSync(fakeDir);
  mkdirSync(workRoot);
  writeFileSync(join(fakeDir, "claude"), FAKE);
  chmodSync(join(fakeDir, "claude"), 0o755);
  PATH = `${fakeDir}:${dirname(process.execPath)}`;
});
afterEach(() => {
  rmSync(join(fakeDir, "calls.jsonl"), { force: true });
  vi.restoreAllMocks();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("claude CLI adapter", () => {
  it("success: structured output passes our schema check; usage is charged", async () => {
    const r = await adapter("m-success").complete(req(), validate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ verdict: "ok" });
    expect(r.usage.inputTokens).toBe(1010);
    expect(r.usage.outputTokens).toBe(200);
    expect(r.usage.costUsd).toBeCloseTo((1010 * 3 + 200 * 15) / 1e6, 9);
  });

  it("runs claude -p with the flags, the prompt on stdin, and the token only in env", async () => {
    await adapter("m-success").complete(req(), validate);
    const [c] = calls();
    expect(c).toBeDefined();
    const a = c!.args;
    expect(a[0]).toBe("-p");
    const flag = (f: string) => a[a.indexOf(f) + 1];
    expect(flag("--output-format")).toBe("json");
    expect(flag("--model")).toBe("m-success");
    expect(flag("--max-turns")).toBe("1");
    expect(flag("--tools")).toBe("");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--no-session-persistence");
    expect(a).not.toContain("--bare");
    // Provider schema: constraints the API rejects are dropped; code checks them.
    expect(JSON.parse(flag("--json-schema")!)).toEqual({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    });
    // System prompt went through a file, user text through stdin, not argv.
    expect(a.join(" ")).not.toContain("SYSTEM-MARKER");
    expect(a.join(" ")).not.toContain("USER-MARKER");
    expect(c!.stdin).toBe("the diff USER-MARKER");
    // The token is only in the child's environment.
    expect(a.join(" ")).not.toContain(TOKEN);
    expect(c!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    // Minimal environment: nothing that could reroute or reuse other secrets.
    expect(c!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c!.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(c!.env.GITHUB_TOKEN).toBeUndefined();
    expect(c!.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4000");
    // Isolated work dir as cwd and HOME, removed afterwards.
    expect(c!.env.HOME).toBe(c!.cwd);
    expect(c!.cwd.startsWith(workRoot)).toBe(true);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("falls back to JSON in the result text when there is no structured output", async () => {
    const r = await adapter("m-text").complete(req(), validate);
    expect(r.ok && r.value).toEqual({ verdict: "ok" });
  });

  it("schema-invalid output: one re-ask, then the role fails (schema error)", async () => {
    const r = await adapter("m-invalid").complete(req(), validate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("schema");
    expect(calls()).toHaveLength(2);
    expect(calls()[1]!.stdin).toContain("did not pass validation");
  });

  it("non-zero exit fails the call and never leaks the token", async () => {
    const r = await adapter("m-exit").complete(req(), validate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("http");
    expect(r.error.message).toContain("exited with code 1");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("oat01");
  });

  it("an error envelope (max turns, API error) fails the call; token scrubbed", async () => {
    const a = await adapter("m-is-error").complete(req(), validate);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.message).toContain("error_max_turns");
    const b = await adapter("m-api-error").complete(req(), validate);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.status).toBe(401);
    expect(JSON.stringify(b)).not.toContain(TOKEN);
  });

  it("refusal maps to a refusal error", async () => {
    const r = await adapter("m-refusal").complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("refusal");
  });

  it("unparseable output fails the call", async () => {
    const r = await adapter("m-garbage").complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("invalid-json");
  });

  it("timeout kills the child and fails the call", async () => {
    const t0 = Date.now();
    const r = await adapter("m-timeout", 1500).complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("unknown usage is charged at the worst case, never as free", async () => {
    const r = await adapter("m-no-usage").complete(req(), validate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.outputTokens).toBe(4000);
    expect(r.usage.costUsd).toBeGreaterThan((4000 * 15) / 1e6);
  });

  it("a missing executable fails as a config error", async () => {
    const r = await createClaudeCliAdapter(spec("m-success"), {
      token: TOKEN,
      timeoutMs: 5000,
      meter: createMeter(100),
      command: join(root, "nope", "claude"),
      path: PATH,
      tmpRoot: workRoot,
    }).complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("config");
  });

  it("refuses a base URL (never through a gateway)", async () => {
    const r = await createClaudeCliAdapter(
      { ...spec("m-success"), baseUrl: "https://gateway.example" },
      {
        token: TOKEN,
        timeoutMs: 5000,
        meter: createMeter(100),
        path: PATH,
        tmpRoot: workRoot,
      },
    ).complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("config");
    expect(calls()).toHaveLength(0);
  });

  it("writes nothing with the token to stdout, stderr or the console", async () => {
    const seen: string[] = [];
    const grab = (...a: unknown[]) => {
      seen.push(a.map(String).join(" "));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(grab as never);
    vi.spyOn(process.stderr, "write").mockImplementation(grab as never);
    for (const m of ["log", "error", "warn", "info", "debug"] as const)
      vi.spyOn(console, m).mockImplementation(grab);
    for (const m of ["m-exit", "m-api-error", "m-success"])
      await adapter(m).complete(req(), validate);
    vi.restoreAllMocks();
    expect(seen.join("\n")).not.toContain(TOKEN);
  });
});

describe("claude CLI helpers", () => {
  it("argv never carries the token", () => {
    expect(buildClaudeArgs(spec("x"), req(), "/tmp/s").join(" ")).not.toContain(
      TOKEN,
    );
  });
  it("scrubToken removes the exact token and token-shaped strings", () => {
    expect(scrubToken(`a ${TOKEN} b`, TOKEN)).toBe("a [redacted] b");
    const other = ["sk", "ant", "oat01", "zzzzzzzzzzzzzzzz"].join("-");
    expect(scrubToken(`x ${other}`, TOKEN)).not.toContain("zzzz");
  });
  it("parses an envelope object or an array ending in a result", () => {
    expect(
      parseCliEnvelope('{"type":"result","subtype":"success"}')?.subtype,
    ).toBe("success");
    expect(
      parseCliEnvelope(
        '[{"type":"system"},{"type":"result","subtype":"success"}]',
      )?.subtype,
    ).toBe("success");
    expect(parseCliEnvelope('{"type":"assistant"}')).toBeNull();
    expect(parseCliEnvelope("")).toBeNull();
  });
});

describe("a subscription token never reaches an HTTP API", () => {
  const fetchSpy = () => vi.fn(async () => new Response("{}"));
  it("the Anthropic adapter refuses it before any request", async () => {
    const f = fetchSpy();
    const r = await createAnthropicAdapter(
      { ...spec("claude-sonnet-5-5"), provider: "anthropic" },
      {
        fetch: f as never,
        apiKey: TOKEN,
        timeoutMs: 1000,
        meter: createMeter(100),
      },
    ).complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("config");
    expect(f).not.toHaveBeenCalled();
  });
  it("the openai-compatible adapter refuses it before any request", async () => {
    const f = fetchSpy();
    const r = await createOpenAICompatAdapter(
      {
        ...spec("glm-5.3"),
        provider: "openai-compatible",
        baseUrl: "https://gw.example/v1",
      },
      {
        fetch: f as never,
        apiKey: TOKEN,
        timeoutMs: 1000,
        meter: createMeter(100),
      },
    ).complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("config");
    expect(f).not.toHaveBeenCalled();
  });
  it("the real adapter factory refuses it for any non-CLI provider", async () => {
    const f = fetchSpy();
    const make = realAdapterFactory({ ANTHROPIC_API_KEY: TOKEN }, f as never);
    const a = make(
      {
        ...spec("claude-sonnet-5-5"),
        provider: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      createMeter(100),
    );
    const r = await a.complete(req(), validate);
    expect(!r.ok && r.error.kind).toBe("config");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(f).not.toHaveBeenCalled();
  });
});
