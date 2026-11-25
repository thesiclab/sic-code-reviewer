// SPDX-License-Identifier: Apache-2.0
// Runtime lists of the closed string unions in src/types.ts, for validation.
import type { Lens, Placement } from "../types.js";

export const LENSES_LIST: readonly Lens[] = ["correctness", "security", "tests", "scope"];
export const PLACEMENT_LIST: readonly Placement[] = [
  "inline",
  "body",
  "pre-existing",
  "dismissed",
  "disputed",
  "dropped",
];
