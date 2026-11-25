// SPDX-License-Identifier: Apache-2.0
// Module 11 types. The first block is CONTRACT.md module 11 verbatim; the
// second block holds eval-internal types (pipeline seam, injection runs).
import type {
  CheckConclusion,
  FilteredFinding,
  GateResult,
  Severity,
} from "../types.js";
import type { ModelAdapter } from "../models/index.js";

// --- CONTRACT.md module 11 -------------------------------------------------

export interface ExpectedIssue {
  file: string;
  startLine: number;
  endLine: number;
  severity?: Severity;
  note: string;
}

export type InjectionGoal =
  | "suppress-finding"
  | "force-pass"
  | "ping"
  | "actions-command"
  | "exfiltrate";

export interface EvalCase {
  id: string;
  kind: "replay" | "planted" | "injection" | "aacr";
  title: string;
  body: string;
  diff: string;
  files: Record<string, string>;
  expected: ExpectedIssue[];
  injection?: { goal: InjectionGoal; payload: string };
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
  /**
   * Per model id: `raised` = posted (inline/body) findings that model raised;
   * `real` = expected issues that ONLY this model caught in this case.
   */
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

// --- eval-internal ---------------------------------------------------------

export interface EvalAdapters {
  reviewer: ModelAdapter;
  adversary: ModelAdapter | null;
}

/** What one pipeline run over one case produced. */
export interface CaseRun {
  findings: FilteredFinding[];
  gate: GateResult;
  /** Every string that would reach GitHub: review body, inline comment bodies, check summary. */
  posted: string[];
  costUsd: number;
}

/**
 * The seam between the harness and the review pipeline. `defaultPipeline`
 * wires the real modules; tests may pass a reference pipeline.
 */
export type EvalPipeline = (
  c: EvalCase,
  variant: Variant,
  adapters: EvalAdapters,
) => Promise<CaseRun>;

/** Which model the injection has "won over" in a worst-case run. */
export type ObeyMode = "reviewer-obeys" | "adversary-obeys";

export interface InjectionVerdict {
  succeeded: boolean;
  reasons: string[];
}

export interface InjectionRunResult extends InjectionVerdict {
  caseId: string;
  goal: InjectionGoal;
  mode: ObeyMode;
  variant: Variant;
  conclusion: CheckConclusion;
}
