// SPDX-License-Identifier: Apache-2.0
// Module 4: model adapters. No tools; text in, JSON out, validated by code.
import type { GateReason, ModelError, ModelRequest, ModelResult, ModelSpec, ProviderKind } from "../types.js";
import type { CostMeter } from "../cost/index.js";
import { NotImplemented } from "../errors.js";

export type SchemaCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ModelAdapter {
  readonly spec: ModelSpec;
  /** One call. Never retries on its own except the single schema-repair re-ask. */
  complete<T>(req: ModelRequest, validate: (v: unknown) => SchemaCheck<T>): Promise<ModelResult<T>>;
}

export interface AdapterOptions {
  fetch: typeof fetch;
  apiKey: string;
  timeoutMs: number;
  meter: CostMeter;
}

export type FakeScript = (req: ModelRequest, callIndex: number) => string | { error: ModelError };

export function createAnthropicAdapter(_spec: ModelSpec, _opts: AdapterOptions): ModelAdapter {
  throw new NotImplemented("models.createAnthropicAdapter");
}
export function createOpenAICompatAdapter(_spec: ModelSpec, _opts: AdapterOptions): ModelAdapter {
  throw new NotImplemented("models.createOpenAICompatAdapter");
}
export function createFakeAdapter(_spec: ModelSpec, _script: FakeScript): ModelAdapter {
  throw new NotImplemented("models.createFakeAdapter");
}
/** Strict repair: one code fence, outermost object, one string-encoded array. */
export function extractJson(_text: string): unknown | undefined {
  throw new NotImplemented("models.extractJson");
}
export function resolveFamily(_provider: ProviderKind, _model: string, _override?: string): string {
  throw new NotImplemented("models.resolveFamily");
}
export function familyCheck(_reviewer: ModelSpec, _adversary: ModelSpec | null): { ok: true } | { ok: false; reason: GateReason } {
  throw new NotImplemented("models.familyCheck");
}
