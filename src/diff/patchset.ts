// SPDX-License-Identifier: Apache-2.0
// Builds the PatchSet a round reviews: always the full PR patch from the merge
// base (`git diff <mergeBase> <head>`), plus the "newest hunks" hint as the
// difference of two merge-base patches, verified byte for byte.
import type { FilePatch, NotRead, PatchSet, RoundSentinel } from "../types.js";
import type { Git } from "./git.js";
import { parseUnifiedDiff } from "./parse.js";
import { buildIncremental, checkSubset } from "./incremental.js";
import { lockfileNote } from "./lockfile.js";

export interface PatchSetOptions {
  /** Size cap; over it the gate is neutral with reason diff-over-cap. */
  maxDiffLines: number;
  /** From the ledger; pins the old patch's merge base for the incremental hint. */
  previous: RoundSentinel | null;
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** File classes whose bodies never go to a model. */
const EXCLUDED_CLASSES = new Set([
  "lockfile",
  "generated",
  "vendored",
  "binary",
] as const);

export function isExcludedFile(file: FilePatch): boolean {
  return (EXCLUDED_CLASSES as Set<string>).has(file.fileClass);
}

/** Changed lines (added + deleted) in the patch; what the size cap is measured in. */
export function countDiffLines(patch: Pick<PatchSet, "files">): number {
  let n = 0;
  for (const f of patch.files)
    for (const h of f.hunks) for (const l of h.lines) if (l.kind !== "ctx") n++;
  return n;
}

async function incrementalHint(
  git: Git,
  previous: RoundSentinel | null,
  fullText: string,
): Promise<string | null> {
  if (
    !previous ||
    !SHA_RE.test(previous.mergeBase) ||
    !SHA_RE.test(previous.headSha)
  )
    return null;
  let oldPatch: string;
  try {
    oldPatch = await git.diff(previous.mergeBase, previous.headSha);
  } catch {
    // The previous round's commits may be gone (force push + gc): no hint.
    return null;
  }
  const block = buildIncremental(oldPatch, fullText);
  return checkSubset(block, fullText).ok ? block : null;
}

export async function buildPatchSet(
  git: Git,
  baseSha: string,
  headSha: string,
  opts: PatchSetOptions,
): Promise<PatchSet> {
  const mergeBase = await git.mergeBase(baseSha, headSha);
  const fullText = await git.diff(mergeBase, headSha);
  const files = parseUnifiedDiff(fullText);
  const excluded: NotRead[] = [];
  const lockfileNotes: string[] = [];
  for (const f of files) {
    if (!isExcludedFile(f)) continue;
    const path = f.newPath ?? f.oldPath ?? "";
    excluded.push({
      kind: "file",
      path,
      reason: f.fileClass as NotRead["reason"],
    });
    if (f.fileClass === "lockfile") lockfileNotes.push(lockfileNote(f));
  }
  const incrementalText = await incrementalHint(git, opts.previous, fullText);
  return {
    baseSha,
    headSha,
    mergeBase,
    files,
    fullText,
    incrementalText,
    excluded,
    lockfileNotes,
  };
}

/** Each hunk with explicit new-side line numbers. Deleted lines have no new-side number. */
export function renderNumbered(file: FilePatch): string {
  const path = file.newPath ?? file.oldPath ?? "(unknown)";
  const head =
    file.status === "renamed" && file.oldPath
      ? `File: ${path} (renamed from ${file.oldPath})`
      : `File: ${path} (${file.status})`;
  const out: string[] = [head];
  if (file.hunks.length === 0) {
    out.push(
      file.fileClass === "binary"
        ? "(binary file, no text hunks)"
        : "(no text hunks)",
    );
    return out.join("\n");
  }
  let width = 1;
  for (const h of file.hunks)
    width = Math.max(width, String(h.newStart + h.newCount).length);
  const blank = " ".repeat(width);
  for (const h of file.hunks) {
    out.push(
      `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.header ? ` ${h.header}` : ""}`,
    );
    for (const l of h.lines) {
      if (l.kind === "add")
        out.push(`${String(l.newLine).padStart(width)} + ${l.text}`);
      else if (l.kind === "ctx")
        out.push(`${String(l.newLine).padStart(width)}   ${l.text}`);
      else out.push(`${blank} - ${l.text}`);
    }
  }
  return out.join("\n");
}
