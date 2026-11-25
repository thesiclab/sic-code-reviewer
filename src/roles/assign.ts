// SPDX-License-Identifier: Apache-2.0
import type { Finding, FindingOrigin, RawFinding } from "../types.js";
import { NotImplemented } from "../errors.js";

export function assignIds(_raw: RawFinding[], _origin: FindingOrigin, _model: string, _startAt: number): Finding[] {
  throw new NotImplemented("roles.assignIds");
}
/** Shuffled order (seeded); origin and model are blanked in the prompt view. */
export function anonymise(_findings: Finding[], _seed: string): Finding[] {
  throw new NotImplemented("roles.anonymise");
}
/** sha256(file, normalized title, lens) -> 12 hex characters. */
export function fingerprint(_f: RawFinding): string {
  throw new NotImplemented("roles.fingerprint");
}
