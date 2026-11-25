// SPDX-License-Identifier: Apache-2.0
import type { ContextBundle, CostEstimate, ModelSpec, ModelUsage, PatchSet } from "../types.js";
import { NotImplemented } from "../errors.js";
export { estimateTokens } from "./tokens.js";

export interface CostMeter {
  readonly capUsd: number;
  readonly spentUsd: number;
  /** Reserve the worst case for a call; false = would exceed the cap, do not call. */
  reserve(spec: ModelSpec, inputTokens: number, maxOutputTokens: number): boolean;
  settle(spec: ModelSpec, usage: { inputTokens: number; outputTokens: number }): ModelUsage;
  usage(): ModelUsage[];
}

export function estimate(_patch: PatchSet, _context: ContextBundle, _reviewer: ModelSpec, _adversary: ModelSpec | null): CostEstimate {
  throw new NotImplemented("cost.estimate");
}
export function createMeter(_capUsd: number): CostMeter {
  throw new NotImplemented("cost.createMeter");
}
