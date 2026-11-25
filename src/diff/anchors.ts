// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (anchorable_lines, header_new_path, unquote_header_path) (MIT, Copyright (c)
// 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: ported to TypeScript; returns Map<string, Set<number>>; the
// "diff ends mid-hunk" stderr note is dropped (callers see the short map);
// path unquoting shared with src/diff/parse.ts.
//
// Map new-side path -> lines a RIGHT-side review comment may anchor to. null
// when the text carries no diff marker at all (callers fail OPEN). The scan
// tracks each hunk's remaining budget from its @@ counts, so a header test
// only ever runs outside hunk content: an added line reading `++ b/x` (shown
// as `+++ b/x`) can never be taken for a file header. Any disagreement between
// the counts and the body drops the file and desyncs until the next
// `diff --git` line, which content can never impersonate.
import type { AnchorMap } from "../types.js";
import { unquoteGitPath } from "./parse.js";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerNewPath(raw: string): string | null {
  let target = raw.slice(4).replace(/\r+$/, "");
  target = target.split("\t", 1)[0] ?? "";
  if (target.length >= 2 && target.startsWith('"') && target.endsWith('"')) {
    const u = unquoteGitPath(target);
    if (u === null) return null;
    target = u;
  }
  if (target === "/dev/null") return null;
  return target.startsWith("a/") || target.startsWith("b/")
    ? target.slice(2)
    : target;
}

/** null = the text is not a diff this parser understands; callers fail open. */
export function anchorableLines(diffText: string): AnchorMap | null {
  const anchors: AnchorMap = new Map();
  let path: string | null = null;
  let right = 0;
  let pendingOld = 0;
  let pendingNew = 0;
  let sawMarker = false;
  let sawOldHeader = false;
  let desynced = false;
  let sawGitHeader = false;
  let awaitingHeader = true;
  let ateOldHeader = false;

  const add = (): void => {
    if (path !== null && right) anchors.get(path)?.add(right);
  };
  const drop = (): void => {
    path = null;
    right = 0;
    desynced = true;
  };

  const lines = diffText.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const raw of lines) {
    const sawOldHeaderBefore = sawOldHeader;
    sawOldHeader = false;
    const ateOldHeaderBefore = ateOldHeader;
    ateOldHeader = false;

    if (pendingOld > 0 || pendingNew > 0) {
      if (raw.startsWith("+") && pendingNew > 0) {
        if (ateOldHeaderBefore && raw.startsWith("+++ ")) {
          // Both sides over-declared: the next file's header pair was eaten.
          drop();
          pendingOld = pendingNew = 0;
          continue;
        }
        pendingNew--;
        add();
        right++;
        continue;
      }
      if (raw.startsWith(" ") && pendingOld > 0 && pendingNew > 0) {
        pendingOld--;
        pendingNew--;
        add();
        right++;
        continue;
      }
      if (raw.startsWith("-") && pendingOld > 0) {
        pendingOld--;
        ateOldHeader = raw.startsWith("--- ");
        continue;
      }
      if (raw.startsWith("\\")) continue;
      // Budget says the hunk is not over but this is not content: drop the file
      // and re-read the line as metadata.
      drop();
      pendingOld = pendingNew = 0;
    } else if (
      (raw[0] === "+" || raw[0] === "-" || raw[0] === " ") &&
      !(
        (awaitingHeader || !sawGitHeader) &&
        (raw.startsWith("--- ") || raw.startsWith("+++ "))
      )
    ) {
      // Budget spent but content keeps coming: the counts were too small.
      drop();
    }

    if (raw.startsWith("diff --git ")) {
      desynced = false;
      sawMarker = true;
      sawGitHeader = true;
      awaitingHeader = true;
      path = null;
      right = 0;
      continue;
    }
    if (raw.startsWith("--- ")) {
      sawOldHeader = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (
        !sawOldHeaderBefore ||
        desynced ||
        (sawGitHeader && !awaitingHeader)
      ) {
        drop();
        continue;
      }
      sawMarker = true;
      path = headerNewPath(raw);
      right = 0;
      awaitingHeader = false;
      if (path !== null && !anchors.has(path)) anchors.set(path, new Set());
      continue;
    }
    if (raw.startsWith("@@") && !desynced) {
      const m = HUNK_HEADER_RE.exec(raw);
      if (!m) {
        drop();
        continue;
      }
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      if (newStart === 0 && newCount > 0) {
        drop();
        pendingOld = pendingNew = 0;
        continue;
      }
      right = newStart;
      pendingOld = m[2] === undefined ? 1 : Number(m[2]);
      pendingNew = newCount;
    }
  }
  if (!sawMarker) return null;
  return anchors;
}
