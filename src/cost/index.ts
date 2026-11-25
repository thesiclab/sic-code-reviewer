// SPDX-License-Identifier: Apache-2.0
// Module 10: cost estimate, meter and hard cap. New code.
//
// The meter is the only thing standing between a runaway prompt and a large
// bill, so it reserves the WORST case (full input plus maxOutputTokens) before
// every call and only releases the reservation when the call settles. A call
// whose reservation would cross the cap is never sent.
import type {
  ContextBundle,
  CostEstimate,
  ModelSpec,
  ModelUsage,
  PatchSet,
} from "../types.js";
import { estimateTokens } from "./tokens.js";
export { estimateTokens } from "./tokens.js";

export interface CostMeter {
  readonly capUsd: number;
  readonly spentUsd: number;
  /** Reserve the worst case for a call; false = would exceed the cap, do not call. */
  reserve(
    spec: ModelSpec,
    inputTokens: number,
    maxOutputTokens: number,
  ): boolean;
  settle(
    spec: ModelSpec,
    usage: { inputTokens: number; outputTokens: number },
  ): ModelUsage;
  usage(): ModelUsage[];
}

/**
 * Tokens of fixed prompt text (role prompt, rubric, fence lines, schema
 * description) added to every call on top of the variable inputs. Generous on
 * purpose: the estimate is a ceiling, not a forecast.
 */
export const PROMPT_OVERHEAD_TOKENS = 3000;

/** Floating-point slack so a reservation that exactly meets the cap is allowed. */
const EPSILON_USD = 1e-9;

export function priceUsd(
  spec: ModelSpec,
  inputTokens: number,
  outputTokens: number,
): number {
  const usd =
    (Math.max(0, inputTokens) * spec.priceInPerMTok +
      Math.max(0, outputTokens) * spec.priceOutPerMTok) /
    1_000_000;
  return round6(usd);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function specKey(spec: ModelSpec): string {
  return `${spec.provider}\u0000${spec.model}\u0000${spec.baseUrl ?? ""}`;
}

/**
 * Worst-case cost of one run: reviewer, adversary and counter-check, each at
 * full maxOutputTokens. The adversary and counter-check also read the previous
 * role's full output. The diff and the context are both counted in full even
 * though the context's first tier repeats the hunks: over-estimating is safe,
 * under-estimating is not.
 */
export function estimate(
  patch: PatchSet,
  context: ContextBundle,
  reviewer: ModelSpec,
  adversary: ModelSpec | null,
): CostEstimate {
  const shared =
    PROMPT_OVERHEAD_TOKENS +
    estimateTokens(patch.fullText) +
    (patch.incrementalText ? estimateTokens(patch.incrementalText) : 0) +
    estimateTokens(patch.lockfileNotes.join("\n")) +
    Math.max(0, context.tokensUsed);

  const calls: CostEstimate["calls"] = [];
  const add = (role: string, spec: ModelSpec, inputTokens: number) => {
    const outputTokens = spec.maxOutputTokens;
    calls.push({
      role,
      model: spec.model,
      inputTokens,
      outputTokens,
      usd: priceUsd(spec, inputTokens, outputTokens),
    });
  };

  add("reviewer", reviewer, shared);
  if (adversary) {
    add("adversary", adversary, shared + reviewer.maxOutputTokens);
    add("counter-check", reviewer, shared + adversary.maxOutputTokens);
  }
  const totalUsd = round6(calls.reduce((s, c) => s + c.usd, 0));
  return { calls, totalUsd };
}

export function createMeter(capUsd: number): CostMeter {
  if (!Number.isFinite(capUsd) || capUsd < 0)
    throw new Error("cost cap must be a finite, non-negative number");
  let spent = 0;
  let reserved = 0;
  const pending = new Map<string, number[]>();
  const log: ModelUsage[] = [];

  return {
    capUsd,
    get spentUsd() {
      return round6(spent);
    },
    reserve(spec, inputTokens, maxOutputTokens) {
      const worst = priceUsd(spec, inputTokens, maxOutputTokens);
      if (spent + reserved + worst > capUsd + EPSILON_USD) return false;
      reserved += worst;
      const key = specKey(spec);
      const q = pending.get(key) ?? [];
      q.push(worst);
      pending.set(key, q);
      return true;
    },
    settle(spec, usage) {
      const q = pending.get(specKey(spec));
      const held = q && q.length > 0 ? q.shift()! : 0;
      reserved = Math.max(0, reserved - held);
      const costUsd = priceUsd(spec, usage.inputTokens, usage.outputTokens);
      spent += costUsd;
      const entry: ModelUsage = {
        inputTokens: Math.max(0, usage.inputTokens),
        outputTokens: Math.max(0, usage.outputTokens),
        costUsd,
      };
      log.push(entry);
      return { ...entry };
    },
    usage() {
      return log.map((u) => ({ ...u }));
    },
  };
}
