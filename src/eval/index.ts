// SPDX-License-Identifier: Apache-2.0
// Module 11: evaluation harness. Unit tests use fake adapters only.
import type { CheckConclusion, FilteredFinding, ReviewResult, Severity } from "../types.js";
import type { ModelAdapter } from "../models/index.js";
import type { Git } from "../diff/index.js";
import { NotImplemented } from "../errors.js";

export interface ExpectedIssue {
  file: string;
  startLine: number;
  endLine: number;
  severity?: Severity;
  note: string;
}

export interface EvalCase {
  id: string;
  kind: "replay" | "planted" | "injection" | "aacr";
  title: string;
  body: string;
  diff: string;
  files: Record<string, string>;
  expected: ExpectedIssue[];
  injection?: { goal: "suppress-finding" | "force-pass" | "ping" | "actions-command" | "exfiltrate"; payload: string };
}

export type Variant = "single" | "two-families-no-adversary" | "duo";

export interface CaseOutcome {
  caseId: string;
  variant: Variant;
  caught: string[];
  missed: string[];
  falseAlarms: number;
  injectionSucceeded: boolean;
  dropped: number;
  uniqueByModel: Record<string, { raised: number; real: number }>;
  costUsd: number;
  conclusion: CheckConclusion;
}

export interface Metrics {
  precision: number;
  recall: number;
  falseAlarms: number;
  injectionSuccesses: number;
  costUsd: number;
  uniqueReal: Record<string, number>;
}

export interface EvalReport {
  outcomes: CaseOutcome[];
  byVariant: Record<Variant, Metrics>;
}

export interface ShadowRecord {
  headSha: string;
  singleFindings: FilteredFinding[];
  duoFindings: FilteredFinding[];
  overlap: number;
}

export function runEval(_cases: EvalCase[], _variants: Variant[], _adapters: { reviewer: ModelAdapter; adversary: ModelAdapter | null }): Promise<EvalReport> {
  throw new NotImplemented("eval.runEval");
}
/** Same file, line within [start-3, end+3]. */
export function matchFinding(_f: FilteredFinding, _e: ExpectedIssue): boolean {
  throw new NotImplemented("eval.matchFinding");
}
export function loadInjectionSet(_dir: string): EvalCase[] {
  throw new NotImplemented("eval.loadInjectionSet");
}
export function loadPlantedSet(_dir: string): EvalCase[] {
  throw new NotImplemented("eval.loadPlantedSet");
}
export function loadReplay(_git: Git, _repo: string, _prNumbers: number[]): Promise<EvalCase[]> {
  throw new NotImplemented("eval.loadReplay");
}
/** Reads a local copy of AACR-Bench (Apache-2.0); never committed. */
export function loadAacrBench(_path: string, _limit?: number): EvalCase[] {
  throw new NotImplemented("eval.loadAacrBench");
}
/** Live PRs: artifact only, never posted. */
export function shadowRun(_result: ReviewResult, _singleModel: ModelAdapter): Promise<ShadowRecord> {
  throw new NotImplemented("eval.shadowRun");
}
