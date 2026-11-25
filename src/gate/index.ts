// SPDX-License-Identifier: Apache-2.0
// Module 7: gate and per-commit cache.
import type { FilteredFinding, GateReason, GateResult, ReviewResult } from "../types.js";
import type { GitHubReader } from "../github/index.js";
import { NotImplemented } from "../errors.js";

export interface GateInput {
  findings: FilteredFinding[];
  failures: GateReason[];
}

export interface CacheStore {
  get(key: string): Promise<ReviewResult | null>;
  put(key: string, result: ReviewResult): Promise<void>;
}

export interface CacheKeyParts {
  headSha: string;
  mergeBase: string;
  configHash: string;
  promptHash: string;
  reviewer: string;
  adversary: string | null;
  actionVersion: string;
}

export function decide(_input: GateInput): GateResult {
  throw new NotImplemented("gate.decide");
}
export function cacheKey(_parts: CacheKeyParts): string {
  throw new NotImplemented("gate.cacheKey");
}
export function createSentinelCache(_gh: GitHubReader, _repo: string, _pr: number): CacheStore {
  throw new NotImplemented("gate.createSentinelCache");
}
export function createMemoryCache(): CacheStore {
  throw new NotImplemented("gate.createMemoryCache");
}
