// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/incremental-diff.py
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: ported to TypeScript; CLI subcommands replaced by functions;
// checkSubset returns {foreign, ok} with ok = no foreign section and the block
// no longer than the full diff; text before the block's first section now
// counts as foreign (Comfy dropped it silently); section splitting and header path parsing are
// shared with src/diff/parse.ts (LF-only split, quoted-path support added).
//
// Why: the "newest hunks" hint is the difference of two PR *patches*, each taken
// against a merge base (old = previous round's recorded merge base..previous
// head; new = this round's full patch), never a LAST...HEAD commit range, which
// can carry base-branch commits after a merge. Every emitted section is copied
// verbatim from the new patch, and checkSubset verifies that byte for byte.
import {
  lfLines,
  parseHeaderPaths,
  splitSections,
  unquoteGitPath,
} from "./parse.js";

/** Lines that track the BASE blob rather than the branch's own edit. */
const BASE_VOLATILE = ["index ", "similarity index ", "dissimilarity index "];

function sectionKey(lines: string[]): string {
  let oldP: string | null = null;
  let newP: string | null = null;
  for (const raw of lines.slice(1)) {
    if (raw.startsWith("@@")) break;
    const l = raw.replace(/\n$/, "");
    if (l.startsWith("rename from ")) oldP = unquoteGitPath(l.slice(12));
    else if (l.startsWith("rename to ")) newP = unquoteGitPath(l.slice(10));
  }
  if (oldP && newP) return `path:${newP}`;
  const paths = parseHeaderPaths(lines[0]!);
  // An unparseable header is keyed by its raw line; it cannot collide with a path.
  return paths ? `path:${paths[1]}` : `raw:${lines[0]!}`;
}

/** Comparable content of one section: metadata minus base-volatile lines, hunks with @@ headers collapsed. */
function hunkSignature(lines: string[]): string {
  const body = lines.slice(1);
  const binary = body.some((l) => l.startsWith("Binary files "));
  const sig: string[] = [];
  let seenHunk = false;
  for (const line of body) {
    const l = line.replace(/\n$/, "");
    if (line.startsWith("@@")) {
      seenHunk = true;
      sig.push("@@ @@");
    } else if (seenHunk) {
      sig.push(l);
    } else if (binary || !BASE_VOLATILE.some((p) => line.startsWith(p))) {
      sig.push(l);
    }
  }
  return sig.join("\n");
}

/** Sections of newPatch that oldPatch lacks or that changed since oldPatch. */
export function buildIncremental(oldPatch: string, newPatch: string): string {
  const oldBy = new Map<string, string>();
  for (const lines of splitSections(oldPatch))
    oldBy.set(sectionKey(lines), hunkSignature(lines));
  const out: string[] = [];
  for (const lines of splitSections(newPatch)) {
    const key = sectionKey(lines);
    if (oldBy.has(key) && oldBy.get(key) === hunkSignature(lines)) continue;
    out.push(...lines);
  }
  return out.join("");
}

/** Every section of block must appear byte for byte in full (as a multiset). */
export function checkSubset(
  block: string,
  full: string,
): { foreign: number; ok: boolean } {
  const remaining = new Map<string, number>();
  for (const lines of splitSections(full)) {
    const s = lines.join("");
    remaining.set(s, (remaining.get(s) ?? 0) + 1);
  }
  let foreign = 0;
  for (const lines of splitSections(block)) {
    const s = lines.join("");
    const n = remaining.get(s) ?? 0;
    if (n > 0) remaining.set(s, n - 1);
    else foreign++;
  }
  // Text outside any section (before the first `diff --git`) is not carried by
  // the full diff either; count it as foreign.
  const sectioned = splitSections(block).reduce(
    (acc, l) => acc + l.join("").length,
    0,
  );
  if (sectioned !== block.length && lfLines(block).length > 0) foreign++;
  const count = (t: string): number => t.split("\n").length - 1;
  return { foreign, ok: foreign === 0 && count(block) <= count(full) };
}
