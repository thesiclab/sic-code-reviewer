// SPDX-License-Identifier: Apache-2.0
// Shadow run on a live PR: the duo result is the posted one; a single-model
// run is recorded next to it as an artifact only. Never posted.
import type { FilteredFinding, ReviewResult } from "../types.js";
import type { ModelAdapter } from "../models/index.js";
import type { ShadowRecord } from "./types.js";
import { isPosted } from "./match.js";

/** Re-runs one single-model review for the same commit; supplied by entry wiring. */
export type SingleRunner = (
  result: ReviewResult,
  singleModel: ModelAdapter,
) => Promise<FilteredFinding[]>;

function sameIssue(a: FilteredFinding, b: FilteredFinding): boolean {
  return (
    a.fingerprint === b.fingerprint ||
    (a.file === b.file && Math.abs(a.line - b.line) <= 3 && a.lens === b.lens)
  );
}

export function shadowRecord(
  result: ReviewResult,
  singleFindings: FilteredFinding[],
): ShadowRecord {
  const duo = result.findings.filter(isPosted);
  const single = singleFindings.filter(isPosted);
  return {
    headSha: result.headSha,
    singleFindings: single,
    duoFindings: duo,
    overlap: duo.filter((d) => single.some((s) => sameIssue(d, s))).length,
  };
}

let runner: SingleRunner | null = null;

/** Entry wiring registers how to re-run the reviewer alone (it owns git, context and prompts). */
export function setShadowRunner(r: SingleRunner | null): void {
  runner = r;
}

export async function shadowRun(
  result: ReviewResult,
  singleModel: ModelAdapter,
): Promise<ShadowRecord> {
  if (!runner)
    throw new Error(
      "shadowRun: no single-model runner registered (entry wiring calls setShadowRunner)",
    );
  return shadowRecord(result, await runner(result, singleModel));
}
