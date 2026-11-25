// SPDX-License-Identifier: Apache-2.0
// Module 6: findings filter. Code only, no model.
import type { AdversaryVerdict, AnchorMap, FilteredFinding, Finding, RawFinding } from "../types.js";
import { NotImplemented } from "../errors.js";
export * from "./severity.js";

export interface FilterInput {
  reviewer: Finding[];
  adversaryVerdicts: AdversaryVerdict[];
  adversaryMissed: Finding[];
  counterVerdicts: AdversaryVerdict[];
  anchors: AnchorMap;
  /** Concatenated diff + context the adversary saw, for the quote check. */
  shownText: string;
  /** Default 10; overflow goes to body, sorted by severity. */
  maxInline: number;
}

export function filterFindings(_input: FilterInput): FilteredFinding[] {
  throw new NotImplemented("findings.filterFindings");
}
export function hasProof(_f: RawFinding): { ok: true } | { ok: false; reason: string } {
  throw new NotImplemented("findings.hasProof");
}
/** Verbatim after whitespace normalisation. */
export function quoteFound(_quote: string, _shownText: string): boolean {
  throw new NotImplemented("findings.quoteFound");
}
