// SPDX-License-Identifier: Apache-2.0
// Module 2: context engine. Fill order: hunks -> changed functions ->
// callers/callees -> related tests -> repo map, capped by a token budget.
import type { ContextBundle, Hunk, PatchSet } from "../types.js";
import type { Git, GrepHit } from "../diff/index.js";
import { NotImplemented } from "../errors.js";

export interface ContextOptions {
  tokenBudget: number;
  maxCallersPerSymbol: number;
  maxCalleesPerSymbol: number;
  repoMapMaxTokens: number;
  /** LATER: static-analysis output as the last fill item. */
  staticAnalysis?: string;
}

export interface FunctionSpan {
  name: string;
  startLine: number;
  endLine: number;
}

export function buildContext(_git: Git, _patch: PatchSet, _opts: ContextOptions): Promise<ContextBundle> {
  throw new NotImplemented("context.buildContext");
}
export function changedFunctions(_source: string, _path: string, _hunks: Hunk[]): FunctionSpan[] {
  throw new NotImplemented("context.changedFunctions");
}
export function symbolsDefinedIn(_span: FunctionSpan, _source: string, _path: string): string[] {
  throw new NotImplemented("context.symbolsDefinedIn");
}
export function calleesOf(_span: FunctionSpan, _source: string, _path: string): string[] {
  throw new NotImplemented("context.calleesOf");
}
export function findCallers(_git: Git, _sha: string, _symbol: string, _max: number): Promise<GrepHit[]> {
  throw new NotImplemented("context.findCallers");
}
export function relatedTests(_git: Git, _sha: string, _changedPaths: string[], _symbols: string[]): Promise<string[]> {
  throw new NotImplemented("context.relatedTests");
}
export function repoMap(_git: Git, _sha: string, _maxTokens: number): Promise<string> {
  throw new NotImplemented("context.repoMap");
}
export { estimateTokens } from "../cost/tokens.js";
