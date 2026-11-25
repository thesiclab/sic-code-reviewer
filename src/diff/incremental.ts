// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/incremental-diff.py
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) ported to TypeScript; CLI subcommands replaced by functions.
import { NotImplemented } from "../errors.js";

/** Sections of newPatch that oldPatch lacks or that changed since oldPatch. */
export function buildIncremental(_oldPatch: string, _newPatch: string): string {
  throw new NotImplemented("diff.buildIncremental");
}

/** Every section of block must appear byte for byte in full (as a multiset). */
export function checkSubset(_block: string, _full: string): { foreign: number; ok: boolean } {
  throw new NotImplemented("diff.checkSubset");
}
