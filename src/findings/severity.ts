// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (normalize_severity) and prompt-judge.md (severity rubric) (MIT, Copyright (c)
// 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: ported to TypeScript; rubric text lightly reworded.
import { SEVERITIES, type Severity } from "../types.js";

export const DEFAULT_SEVERITY: Severity = "medium";

export const SEVERITY_RUBRIC: Record<Severity, string> = {
  critical: "Exploitable security hole, data loss or corruption, or a crash on a normal path. Ship-blocker.",
  high: "A real bug that will misbehave on a plausible input, or a serious risk that should be fixed before merge.",
  medium: "A bug or risk on an edge or uncommon path; should be fixed but is not a blocker.",
  low: "A minor correctness or robustness issue with limited impact.",
  nit: "Style, naming or polish; optional.",
};

/** Unknown, missing or non-string values become medium rather than dropping the finding. */
export function normalizeSeverity(value: unknown): Severity {
  if (typeof value !== "string") return DEFAULT_SEVERITY;
  const candidate = value.trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(candidate) ? (candidate as Severity) : DEFAULT_SEVERITY;
}
