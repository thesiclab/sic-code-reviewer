// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (neutralize_mentions, render_finding_entry) and agent-error.py (sanitize)
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) ported to TypeScript; adds link/image flattening, HTML tag
// escaping, control-character removal and a second redaction pass.
import { NotImplemented } from "../errors.js";

export function sanitizeModelText(_text: string, _maxChars: number): string {
  throw new NotImplemented("output.sanitizeModelText");
}
/** A finding body inside a blockquote its markdown cannot escape. */
export function blockquote(_text: string): string {
  throw new NotImplemented("output.blockquote");
}
