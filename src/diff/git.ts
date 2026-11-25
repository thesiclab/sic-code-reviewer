// SPDX-License-Identifier: Apache-2.0
import { NotImplemented } from "../errors.js";

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/** The only place that runs git. Uses execFile, never a shell. */
export interface Git {
  mergeBase(baseSha: string, headSha: string): Promise<string>;
  /** git diff --no-color --no-ext-diff -M --full-index <from> <to> */
  diff(fromSha: string, toSha: string): Promise<string>;
  /** git show <sha>:<path>; null if the path does not exist at sha. */
  show(sha: string, path: string): Promise<string | null>;
  grep(sha: string, pattern: string, opts: { word: boolean; fixed: boolean; maxCount: number }): Promise<GrepHit[]>;
  lsTree(sha: string): Promise<string[]>;
}

export function createGit(_repoDir: string): Git {
  throw new NotImplemented("diff.createGit");
}
