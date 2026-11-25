// SPDX-License-Identifier: Apache-2.0
import type { FilePatch, PatchSet, RoundSentinel } from "../types.js";
import type { Git } from "./git.js";
import { NotImplemented } from "../errors.js";

export interface PatchSetOptions {
  /** Size cap; over it the gate is neutral with reason diff-over-cap. */
  maxDiffLines: number;
  /** From the ledger; pins the old patch's merge base for the incremental hint. */
  previous: RoundSentinel | null;
}

export function buildPatchSet(_git: Git, _baseSha: string, _headSha: string, _opts: PatchSetOptions): Promise<PatchSet> {
  throw new NotImplemented("diff.buildPatchSet");
}

/** Each hunk with explicit new-side line numbers. */
export function renderNumbered(_file: FilePatch): string {
  throw new NotImplemented("diff.renderNumbered");
}
