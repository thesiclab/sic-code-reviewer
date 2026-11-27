// SPDX-License-Identifier: Apache-2.0
// Model adapters. No tools: text in, JSON out, validated by code. Adapters never
// log prompts, responses or keys; errors carry a status and a short, redacted
// provider message only.
import type {
  JsonSchema,
  ModelError,
  ModelRequest,
  ModelResult,
  ModelSpec,
  ModelUsage,
} from "../types.js";
import type { CostMeter } from "../cost/index.js";
import { estimateTokens } from "../cost/index.js";
import { redact } from "../prompts/index.js";
import { extractJsonDetailed, repairStringArrays } from "./repair.js";

export type SchemaCheck<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export interface ModelAdapter {
  readonly spec: ModelSpec;
  /** One call. Never retries on its own except the single schema-repair re-ask. */
  complete<T>(
    req: ModelRequest,
    validate: (v: unknown) => SchemaCheck<T>,
  ): Promise<ModelResult<T>>;
}

export interface AdapterOptions {
  fetch: typeof fetch;
  apiKey: string;
  timeoutMs: number;
  meter: CostMeter;
}

export type FakeScript = (
  req: ModelRequest,
  callIndex: number,
) => string | { error: ModelError };

// ---------------------------------------------------------------------------
// Shared completion loop
// ---------------------------------------------------------------------------

/** @internal Shared with the claude CLI adapter. */
export type SendResult =
  | {
      ok: true;
      text: string;
      inputTokens: number;
      outputTokens: number;
      refusal?: string;
      truncated?: boolean;
    }
  | { ok: false; error: ModelError };

/** @internal */
export interface Charger {
  reserve(inputTokens: number, maxOutputTokens: number): boolean;
  settle(inputTokens: number, outputTokens: number): ModelUsage;
}

const MAX_REASK_ERRORS_CHARS = 2000;

/** @internal */
export function meterCharger(spec: ModelSpec, meter: CostMeter): Charger {
  return {
    reserve: (i, o) => meter.reserve(spec, i, o),
    settle: (i, o) => meter.settle(spec, { inputTokens: i, outputTokens: o }),
  };
}

function priceCharger(spec: ModelSpec): Charger {
  return {
    reserve: () => true,
    settle: (i, o) => ({
      inputTokens: i,
      outputTokens: o,
      costUsd: (i * spec.priceInPerMTok + o * spec.priceOutPerMTok) / 1e6,
    }),
  };
}

function sumUsage(list: ModelUsage[]): ModelUsage {
  return list.reduce(
    (a, u) => ({
      inputTokens: a.inputTokens + u.inputTokens,
      outputTokens: a.outputTokens + u.outputTokens,
      costUsd: a.costUsd + u.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

function reaskText(errors: string[]): string {
  let list = errors.map((e) => `- ${e}`).join("\n");
  if (list.length > MAX_REASK_ERRORS_CHARS)
    list = `${list.slice(0, MAX_REASK_ERRORS_CHARS)}\n- (more errors not shown)`;
  return `\n\nYour previous reply did not pass validation:\n${list}\nReply again with only the corrected JSON object.`;
}

/** @internal Shared completion loop: reserve, send, extract, validate, one re-ask. */
export async function runComplete<T>(
  charger: Charger,
  send: (req: ModelRequest) => Promise<SendResult>,
  req: ModelRequest,
  validate: (v: unknown) => SchemaCheck<T>,
): Promise<ModelResult<T>> {
  const usages: ModelUsage[] = [];
  let attemptReq = req;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const inTok = estimateTokens(
      attemptReq.system + attemptReq.user + JSON.stringify(attemptReq.schema),
    );
    if (!charger.reserve(inTok, attemptReq.maxOutputTokens)) {
      return {
        ok: false,
        error: { kind: "budget", message: "cost cap reached before the call" },
        usage: sumUsage(usages),
      };
    }
    const r = await send(attemptReq);
    if (!r.ok) {
      usages.push(charger.settle(0, 0));
      return { ok: false, error: r.error, usage: sumUsage(usages) };
    }
    usages.push(charger.settle(r.inputTokens, r.outputTokens));
    if (r.refusal !== undefined) {
      return {
        ok: false,
        error: { kind: "refusal", message: shortMessage(r.refusal) },
        usage: sumUsage(usages),
      };
    }
    const ex = extractJsonDetailed(r.text);
    if (!ex) {
      lastErrors = [
        r.truncated
          ? "the reply was cut off at the output token limit and is not complete JSON"
          : "the reply was not a JSON object",
      ];
    } else {
      let check = validate(ex.value);
      let repaired = ex.repaired;
      if (!check.ok) {
        const sa = repairStringArrays(ex.value, req.schema);
        if (sa.repaired) {
          const again = validate(sa.value);
          if (again.ok) {
            check = again;
            repaired = true;
          }
        }
      }
      if (check.ok)
        return {
          ok: true,
          value: check.value,
          usage: sumUsage(usages),
          repaired: repaired || attempt > 0,
          rawText: r.text,
        };
      lastErrors = check.errors;
    }
    attemptReq = { ...req, user: req.user + reaskText(lastErrors) };
  }
  return {
    ok: false,
    error: {
      kind: "schema",
      message: shortMessage(
        `output invalid after one re-ask: ${lastErrors.slice(0, 5).join("; ")}`,
      ),
    },
    usage: sumUsage(usages),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const RETRY_CAP_S = 30;
const DEFAULT_RETRY_S = 2;

/** @internal Short, control-free, redacted message for errors. */
export function shortMessage(s: string): string {
  return redact(s.replace(/[\u0000-\u001f]+/g, " ").slice(0, 200)).text;
}

function retryAfterSeconds(h: string | null): number {
  if (!h) return DEFAULT_RETRY_S;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(Math.max(n, 0), RETRY_CAP_S);
  const at = Date.parse(h);
  if (Number.isFinite(at))
    return Math.min(Math.max((at - Date.now()) / 1000, 0), RETRY_CAP_S);
  return DEFAULT_RETRY_S;
}

function providerMessage(json: unknown): string {
  const e = (json as { error?: { message?: unknown } | string } | null)?.error;
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  return "";
}

type PostResult =
  | { ok: true; json: unknown }
  | { ok: false; error: ModelError };

async function postOnce(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctrl.abort(new Error("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { res, json } as const;
  } catch (err) {
    if (ctrl.signal.aborted) {
      const timedOut = !signal?.aborted;
      return {
        error: {
          kind: "timeout",
          message: timedOut ? `no response within ${timeoutMs} ms` : "aborted",
        } as ModelError,
      };
    }
    return {
      error: {
        kind: "http",
        message: shortMessage(
          `network error: ${(err as Error)?.name ?? "error"}`,
        ),
      } as ModelError,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** One POST; one retry on 429/5xx after retry-after (capped at 30 s). */
async function postJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PostResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await postOnce(fetchFn, url, headers, body, timeoutMs, signal);
    if ("error" in r) return { ok: false, error: r.error };
    const { res, json } = r;
    if (res.ok) return { ok: true, json };
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt === 0) {
      const wait = retryAfterSeconds(res.headers.get("retry-after"));
      if (wait > 0)
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    return {
      ok: false,
      error: {
        kind: "http",
        status: res.status,
        message: shortMessage(providerMessage(json) || `HTTP ${res.status}`),
      },
    };
  }
  return { ok: false, error: { kind: "http", message: "unreachable" } };
}

/**
 * Structured-output schemas reject numeric and string-length constraints, and
 * every object needs additionalProperties:false. Code validates the bounds.
 */
export function toProviderSchema(schema: JsonSchema): JsonSchema {
  const DROP = new Set([
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "pattern",
  ]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v))
        if (!DROP.has(k)) out[k] = walk(val);
      if (out.type === "object") out.additionalProperties = false;
      return out;
    }
    return v;
  };
  return walk(schema) as JsonSchema;
}

/**
 * A Claude subscription OAuth token (from `claude setup-token`). Such a token
 * may only be used by the official claude CLI, never sent to the Messages API
 * or to any other endpoint by this action.
 */
export function isSubscriptionToken(key: string): boolean {
  return /^sk-ant-oat/i.test(key.trim());
}

// ---------------------------------------------------------------------------
// Anthropic: POST /v1/messages with output_config.format json_schema.
// Not forced tool use: current Claude models (Opus 5.5, Sonnet 5.5) return 400
// for tool_choice "tool"/"any", and reject temperature, so neither is sent.
// ---------------------------------------------------------------------------

export function createAnthropicAdapter(
  spec: ModelSpec,
  opts: AdapterOptions,
): ModelAdapter {
  const url = `${(spec.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  const send = async (req: ModelRequest): Promise<SendResult> => {
    if (!opts.apiKey)
      return {
        ok: false,
        error: {
          kind: "config",
          message: "no API key for the Anthropic adapter",
        },
      };
    if (isSubscriptionToken(opts.apiKey))
      return {
        ok: false,
        error: {
          kind: "config",
          message:
            "a Claude subscription token is not an API key; use provider claude-cli",
        },
      };
    const body = {
      model: spec.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: {
        format: { type: "json_schema", schema: toProviderSchema(req.schema) },
      },
    };
    const headers = {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const r = await postJson(
      opts.fetch,
      url,
      headers,
      body,
      opts.timeoutMs,
      req.signal,
    );
    if (!r.ok) return r;
    const j = r.json as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
      stop_details?: { category?: string | null } | null;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const text = (j.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const u = j.usage ?? {};
    const inputTokens =
      (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) ||
      estimateTokens(req.system + req.user);
    const outputTokens = u.output_tokens ?? estimateTokens(text);
    const result: SendResult = {
      ok: true,
      text,
      inputTokens,
      outputTokens,
      truncated: j.stop_reason === "max_tokens",
    };
    if (j.stop_reason === "refusal")
      result.refusal = `provider declined${j.stop_details?.category ? ` (${j.stop_details.category})` : ""}`;
    return result;
  };
  const charger = meterCharger(spec, opts.meter);
  return {
    spec,
    complete: (req, validate) => runComplete(charger, send, req, validate),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible: POST /chat/completions with response_format json_schema;
// falls back to json_object (sticky for this adapter) when the server rejects it.
// ---------------------------------------------------------------------------

export function createOpenAICompatAdapter(
  spec: ModelSpec,
  opts: AdapterOptions,
): ModelAdapter {
  let mode: "json_schema" | "json_object" = "json_schema";
  const send = async (req: ModelRequest): Promise<SendResult> => {
    if (!spec.baseUrl)
      return {
        ok: false,
        error: {
          kind: "config",
          message: "openai-compatible adapter needs baseUrl",
        },
      };
    if (!opts.apiKey)
      return {
        ok: false,
        error: {
          kind: "config",
          message: "no API key for the openai-compatible adapter",
        },
      };
    if (isSubscriptionToken(opts.apiKey))
      return {
        ok: false,
        error: {
          kind: "config",
          message:
            "a Claude subscription token is never sent through an API or gateway; use provider claude-cli",
        },
      };
    const url = `${spec.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    };
    for (;;) {
      const body: Record<string, unknown> = {
        model: spec.model,
        max_tokens: req.maxOutputTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format:
          mode === "json_schema"
            ? {
                type: "json_schema",
                json_schema: {
                  name: req.schemaName,
                  schema: toProviderSchema(req.schema),
                  strict: false,
                },
              }
            : { type: "json_object" },
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      const r = await postJson(
        opts.fetch,
        url,
        headers,
        body,
        opts.timeoutMs,
        req.signal,
      );
      if (!r.ok) {
        if (
          mode === "json_schema" &&
          r.error.status !== undefined &&
          r.error.status >= 400 &&
          r.error.status < 500 &&
          r.error.status !== 429 &&
          /response_format|json_schema|schema/i.test(r.error.message)
        ) {
          mode = "json_object";
          continue;
        }
        return r;
      }
      const j = r.json as {
        choices?: {
          message?: { content?: string | null; refusal?: string | null };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = j.choices?.[0];
      const text =
        typeof choice?.message?.content === "string"
          ? choice.message.content
          : "";
      const result: SendResult = {
        ok: true,
        text,
        inputTokens:
          j.usage?.prompt_tokens ?? estimateTokens(req.system + req.user),
        outputTokens: j.usage?.completion_tokens ?? estimateTokens(text),
        truncated: choice?.finish_reason === "length",
      };
      if (choice?.message?.refusal) result.refusal = choice.message.refusal;
      else if (choice?.finish_reason === "content_filter")
        result.refusal = "provider content filter";
      return result;
    }
  };
  const charger = meterCharger(spec, opts.meter);
  return {
    spec,
    complete: (req, validate) => runComplete(charger, send, req, validate),
  };
}

/** Which response_format an openai-compatible adapter ended up using (open item C3). */
export type OpenAIResponseMode = "json_schema" | "json_object";

// ---------------------------------------------------------------------------
// Fake: tests and eval. Never touches the network. Goes through the same
// repair, re-ask and validation path as the real adapters.
// ---------------------------------------------------------------------------

export function createFakeAdapter(
  spec: ModelSpec,
  script: FakeScript,
): ModelAdapter {
  let callIndex = 0;
  const send = async (req: ModelRequest): Promise<SendResult> => {
    const out = script(req, callIndex++);
    if (typeof out !== "string") return { ok: false, error: out.error };
    return {
      ok: true,
      text: out,
      inputTokens: estimateTokens(req.system + req.user),
      outputTokens: estimateTokens(out),
    };
  };
  const charger = priceCharger(spec);
  return {
    spec,
    complete: (req, validate) => runComplete(charger, send, req, validate),
  };
}
