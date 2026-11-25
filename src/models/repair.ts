// SPDX-License-Identifier: Apache-2.0
// Strict JSON repair. The idea follows OCR's comment_args_repair.go (Apache-2.0);
// no code copied. Exactly three repairs, nothing more:
//   1. strip one surrounding code fence;
//   2. take the outermost balanced JSON object;
//   3. (repairStringArrays) a top-level field the schema says is an array but
//      came back as a string holding JSON is parsed once.
import type { JsonSchema } from "../types.js";

export interface Extracted {
  value: unknown;
  repaired: boolean;
}

export function extractJsonDetailed(text: string): Extracted | undefined {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct.ok && isObject(direct.value))
    return { value: direct.value, repaired: false };

  let body = trimmed;
  let repaired = false;
  const fenceMatch = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(
    trimmed,
  );
  if (fenceMatch) {
    body = fenceMatch[1]!.trim();
    repaired = true;
    const inFence = tryParse(body);
    if (inFence.ok && isObject(inFence.value))
      return { value: inFence.value, repaired };
  }
  const outer = outermostObject(body);
  if (outer === undefined) return undefined;
  const parsed = tryParse(outer);
  if (!parsed.ok || !isObject(parsed.value)) return undefined;
  return { value: parsed.value, repaired: true };
}

/** Strict repair: one code fence, outermost object. undefined when no object can be recovered. */
export function extractJson(text: string): unknown | undefined {
  return extractJsonDetailed(text)?.value;
}

/** Parses, once, top-level string fields whose schema type is "array". */
export function repairStringArrays(
  value: unknown,
  schema: JsonSchema,
): Extracted {
  if (!isObject(value)) return { value, repaired: false };
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
  let repaired = false;
  const out: Record<string, unknown> = { ...value };
  for (const [key, sub] of Object.entries(props)) {
    if (sub?.type !== "array" || typeof out[key] !== "string") continue;
    const parsed = tryParse((out[key] as string).trim());
    if (parsed.ok && Array.isArray(parsed.value)) {
      out[key] = parsed.value;
      repaired = true;
    }
  }
  return { value: out, repaired };
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** From the first "{" to its balancing "}", respecting strings and escapes. */
function outermostObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
