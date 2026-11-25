// SPDX-License-Identifier: Apache-2.0
import { NotImplemented } from "../errors.js";

export interface RedactionResult {
  text: string;
  counts: { kind: string; count: number }[];
}

/** Replaces secret-shaped values with [REDACTED:<kind>]. Counts only, never values. */
export function redact(_text: string): RedactionResult {
  throw new NotImplemented("prompts.redact");
}
