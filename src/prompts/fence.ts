// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/fence-diff.py
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: ported to TypeScript; in-memory only (no CLI, no streaming, no
// strip-marker step: our prompts never carry a static marker); the label is a
// fixed vocabulary type instead of a free regex; fence() refuses a body that
// already contains the nonce (cannot happen with a fresh nonce, so it means a
// caller bug).
import { randomBytes } from "node:crypto";

export type FenceLabel =
  | "DIFF"
  | "NEWEST HUNKS"
  | "CONTEXT"
  | "PR DESCRIPTION"
  | "FINDINGS"
  | "PRIOR REVIEW LEDGER"
  | "LOCKFILE NOTES";

export const FENCE_LABELS: readonly FenceLabel[] = [
  "DIFF",
  "NEWEST HUNKS",
  "CONTEXT",
  "PR DESCRIPTION",
  "FINDINGS",
  "PRIOR REVIEW LEDGER",
  "LOCKFILE NOTES",
];

// Comfy: lowercase hex only, 16-64 characters. Anything else could smuggle
// whitespace or "=" into a fence line. Anchored on both ends with no
// multiline flag, so a trailing newline is rejected.
const NONCE_RE = /^[0-9a-f]{16,64}$/;
const NONCE_BYTES = 16;

function checkNonce(nonce: string): string {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    throw new Error(
      `fence: nonce must be 16-64 lowercase hex characters (got length ${String(nonce ?? "").length})`,
    );
  }
  return nonce;
}

function checkLabel(label: FenceLabel): FenceLabel {
  if (!FENCE_LABELS.includes(label)) throw new Error("fence: unknown label");
  return label;
}

/** 16 random bytes as lowercase hex. Never put it in env, outputs or logs. */
export function mintNonce(): string {
  return checkNonce(randomBytes(NONCE_BYTES).toString("hex"));
}

export function openFence(label: FenceLabel, nonce: string): string {
  return `=== BEGIN ${checkLabel(label)} ${checkNonce(nonce)} ===`;
}

export function closeFence(label: FenceLabel, nonce: string): string {
  return `=== END ${checkLabel(label)} ${checkNonce(nonce)} ===`;
}

/** "=== BEGIN <label> <nonce> ===\n<body>\n=== END <label> <nonce> ===\n", body unchanged. */
export function fence(label: FenceLabel, body: string, nonce: string): string {
  const open = openFence(label, nonce);
  const close = closeFence(label, nonce);
  if (body.includes(nonce)) {
    // A fresh nonce is minted after the body exists, so this means the caller
    // reused a nonce. Refuse rather than emit a forgeable region.
    throw new Error("fence: body already contains the nonce; mint a fresh one");
  }
  return `${open}\n${body}\n${close}\n`;
}
