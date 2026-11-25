// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/fence-diff.py
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) ported to TypeScript; fixed label vocabulary; in-memory only.
import { NotImplemented } from "../errors.js";

export type FenceLabel =
  | "DIFF"
  | "NEWEST HUNKS"
  | "CONTEXT"
  | "PR DESCRIPTION"
  | "FINDINGS"
  | "PRIOR REVIEW LEDGER"
  | "LOCKFILE NOTES";

/** 16 random bytes as lowercase hex. Never put it in env, outputs or logs. */
export function mintNonce(): string {
  throw new NotImplemented("prompts.mintNonce");
}

/** "=== BEGIN <label> <nonce> ===\n<body>\n=== END <label> <nonce> ===\n", body unchanged. */
export function fence(_label: FenceLabel, _body: string, _nonce: string): string {
  throw new NotImplemented("prompts.fence");
}
