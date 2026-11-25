// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (anchorable_lines, header_new_path, unquote_header_path) (MIT, Copyright (c)
// 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) ported to TypeScript; returns Map<string, Set<number>>.
import type { AnchorMap } from "../types.js";
import { NotImplemented } from "../errors.js";

/** null = the text is not a diff this parser understands; callers fail open. */
export function anchorableLines(_diffText: string): AnchorMap | null {
  throw new NotImplemented("diff.anchorableLines");
}
