// SPDX-License-Identifier: Apache-2.0
import type { FilteredFinding, Placement } from "../types.js";
import type { ExpectedIssue } from "./types.js";

/** Placements that reach the PR as a live finding. Only these count as "caught". */
export const POSTED_PLACEMENTS: readonly Placement[] = ["inline", "body"];

export function isPosted(f: FilteredFinding): boolean {
  return POSTED_PLACEMENTS.includes(f.placement);
}

function normPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/^[ab]\//, "");
}

/** Same file, line within [start-3, end+3]. */
export function matchFinding(
  f: Pick<FilteredFinding, "file" | "line">,
  e: ExpectedIssue,
): boolean {
  if (normPath(f.file) !== normPath(e.file)) return false;
  return f.line >= e.startLine - 3 && f.line <= e.endLine + 3;
}

/** Stable id of an expected issue inside one case, used in caught/missed. */
export function expectedId(e: ExpectedIssue): string {
  return `${normPath(e.file)}:${e.startLine}`;
}
