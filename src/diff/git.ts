// SPDX-License-Identifier: Apache-2.0
// The only place that runs git. Every call goes through execFile with an
// argument array (never a shell), so PR-controlled strings (paths, symbols)
// can never be read as shell syntax. Revisions are checked before use so a
// value starting with "-" can never be read as a git option.
import { execFile } from "node:child_process";

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
  grep(
    sha: string,
    pattern: string,
    opts: { word: boolean; fixed: boolean; maxCount: number },
  ): Promise<GrepHit[]>;
  lsTree(sha: string): Promise<string[]>;
}

/** Output larger than this is an error rather than a silent truncation. */
const MAX_BUFFER = 512 * 1024 * 1024;

/** A revision we pass to git: hex object id or a plain ref name, never an option. */
const REV_RE = /^[0-9A-Za-z][0-9A-Za-z._/@^~-]*$/;

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

function checkRev(rev: string): string {
  if (!REV_RE.test(rev) || rev.includes("..")) {
    throw new GitError(`refusing revision ${JSON.stringify(rev)}`, null, "");
  }
  return rev;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(repoDir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // Pinned settings so the user's or runner's git config cannot change the
      // shape of the output we parse.
      ["-c", "color.ui=false", "-c", "core.pager=cat", ...args],
      {
        cwd: repoDir,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code =
            typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : null;
          if (code === null) {
            reject(
              new GitError(
                `git ${args[0] ?? ""} failed: ${err.message}`,
                null,
                String(stderr),
              ),
            );
            return;
          }
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function runOk(repoDir: string, args: string[]): Promise<string> {
  const r = await run(repoDir, args);
  if (r.code !== 0) {
    throw new GitError(
      `git ${args[0] ?? ""} exited ${r.code}: ${r.stderr.trim().slice(0, 500)}`,
      r.code,
      r.stderr,
    );
  }
  return r.stdout;
}

/** Parse `git grep -n -z <tree>` output: `<tree>:<path>\0<line>\0<text>\n`. */
export function parseGrepOutput(stdout: string, treePrefix: string): GrepHit[] {
  const hits: GrepHit[] = [];
  const prefix = `${treePrefix}:`;
  for (const record of stdout.split("\n")) {
    if (record === "") continue;
    const first = record.indexOf("\0");
    if (first < 0) continue;
    const second = record.indexOf("\0", first + 1);
    if (second < 0) continue;
    let path = record.slice(0, first);
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    const line = Number(record.slice(first + 1, second));
    if (!Number.isInteger(line) || line <= 0) continue;
    hits.push({ path, line, text: record.slice(second + 1) });
  }
  return hits;
}

export function createGit(repoDir: string): Git {
  return {
    async mergeBase(baseSha, headSha) {
      const out = await runOk(repoDir, [
        "merge-base",
        checkRev(baseSha),
        checkRev(headSha),
      ]);
      return out.trim();
    },

    async diff(fromSha, toSha) {
      return runOk(repoDir, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        "--full-index",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        checkRev(fromSha),
        checkRev(toSha),
        "--",
      ]);
    },

    async show(sha, path) {
      if (path === "" || path.includes("\0")) return null;
      // Ask for the object type first so a missing path is null, not an error,
      // and a directory (tree) is never printed as file text.
      const spec = `${checkRev(sha)}:${path}`;
      const type = await run(repoDir, ["cat-file", "-t", spec]);
      if (type.code !== 0 || type.stdout.trim() !== "blob") return null;
      const r = await run(repoDir, ["cat-file", "blob", spec]);
      if (r.code !== 0) return null;
      return r.stdout;
    },

    async grep(sha, pattern, opts) {
      if (pattern === "" || opts.maxCount <= 0) return [];
      const tree = checkRev(sha);
      const args = ["grep", "-n", "-z", "-I", "--no-color", "--full-name"];
      if (opts.word) args.push("-w");
      args.push(opts.fixed ? "-F" : "-E");
      // -m caps hits per file; the total is capped below.
      args.push("-m", String(opts.maxCount), "-e", pattern, tree, "--");
      const r = await run(repoDir, args);
      if (r.code === 1) return []; // no match
      if (r.code !== 0) {
        throw new GitError(
          `git grep exited ${r.code}: ${r.stderr.trim().slice(0, 500)}`,
          r.code,
          r.stderr,
        );
      }
      return parseGrepOutput(r.stdout, tree).slice(0, opts.maxCount);
    },

    async lsTree(sha) {
      const out = await runOk(repoDir, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "--full-tree",
        checkRev(sha),
      ]);
      return out.split("\0").filter((p) => p !== "");
    },
  };
}
