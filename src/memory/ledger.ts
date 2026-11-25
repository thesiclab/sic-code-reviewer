// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived in part from Comfy-Org/github-workflows .github/cursor-review/build-ledger.py
// (provenance rule, _defang_fences, _prose, round sentinel, REPEAT_CAP, answered rule)
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) ported to TypeScript; GitHub fetching rewritten; sentinel
// renamed to sic-code-reviewer:round v1 and extended with cacheKey and conclusion.
import type { FilteredFinding, Ledger, RoundSentinel } from "../types.js";
import type { GitHubReader } from "../github/index.js";
import { NotImplemented } from "../errors.js";

export const REPEAT_CAP = 2;

export interface LedgerOptions {
  maxRounds: number;
  maxBodyChars: number;
  maxBytes: number;
  botLogins: string[];
}

export function loadLedger(_gh: GitHubReader, _repo: string, _pr: number, _opts: LedgerOptions): Promise<Ledger> {
  throw new NotImplemented("memory.loadLedger");
}
export function renderLedger(_ledger: Ledger, _audience: "reviewer" | "adversary"): string | null {
  throw new NotImplemented("memory.renderLedger");
}
export function defangFences(_text: string): string {
  throw new NotImplemented("memory.defangFences");
}
export function quoteProse(_text: string): string {
  throw new NotImplemented("memory.quoteProse");
}
/** <!-- sic-code-reviewer:round v1 {...} --> */
export function renderRoundSentinel(_s: RoundSentinel): string {
  throw new NotImplemented("memory.renderRoundSentinel");
}
export function parseRoundSentinel(_body: string): RoundSentinel | null {
  throw new NotImplemented("memory.parseRoundSentinel");
}
export function enforceRepeatCap(_findings: FilteredFinding[], _ledger: Ledger, _cap?: number): FilteredFinding[] {
  throw new NotImplemented("memory.enforceRepeatCap");
}
