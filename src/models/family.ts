// SPDX-License-Identifier: Apache-2.0
import type { GateReason, ModelSpec, ProviderKind } from "../types.js";

const PREFIXES: [RegExp, string][] = [
  [/^claude-/, "claude"],
  [/^glm-/, "glm"],
  [/^gpt-/, "gpt"],
  [/^o\d/, "gpt"],
  [/^gemini-/, "gemini"],
  [/^qwen/, "qwen"],
  [/^kimi-/, "kimi"],
  [/^deepseek-/, "deepseek"],
  [/^llama/, "llama"],
];

/**
 * Maps a model id to its family. An explicit override wins. Router-style ids
 * ("z-ai/glm-4.6", "anthropic.claude-...", "qwen3-coder:30b") are reduced to
 * the model part first. Unknown ids throw: config must then set `family`.
 */
export function resolveFamily(
  provider: ProviderKind,
  model: string,
  override?: string,
): string {
  if (override && override.trim()) return override.trim().toLowerCase();
  if (provider === "fake") return "fake";
  // The claude CLI only runs Claude models; ids may be aliases ("sonnet").
  if (provider === "claude-cli") return "claude";
  let id = model.trim().toLowerCase();
  id = id.slice(id.lastIndexOf("/") + 1);
  const dotted = /(?:^|\.)(claude-[^.]*.*)$/.exec(id);
  if (dotted) id = dotted[1]!;
  for (const [re, family] of PREFIXES) if (re.test(id)) return family;
  if (provider === "anthropic") return "claude";
  throw new Error(
    `unknown model family for "${model}"; set "family" for this model in the config`,
  );
}

function familyOf(spec: ModelSpec): string {
  return (
    spec.family || resolveFamily(spec.provider, spec.model)
  ).toLowerCase();
}

/** No adversary, or both models from one family: run, but say "single family". */
export function familyCheck(
  reviewer: ModelSpec,
  adversary: ModelSpec | null,
): { ok: true } | { ok: false; reason: GateReason } {
  const rf = familyOf(reviewer);
  if (!adversary)
    return { ok: false, reason: { kind: "single-family", family: rf } };
  if (familyOf(adversary) === rf)
    return { ok: false, reason: { kind: "single-family", family: rf } };
  return { ok: true };
}
