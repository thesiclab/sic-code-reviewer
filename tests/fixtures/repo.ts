// SPDX-License-Identifier: Apache-2.0
// Throwaway git repositories for tests. Isolated from the user's and system git
// config (no signing hooks, fixed identity and dates), deleted after the run.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export interface FixtureRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  remove(path: string): void;
  chmod(path: string, mode: number): void;
  commit(message: string): string;
  cleanup(): void;
}

export function makeRepo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "sic-fixture-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  return {
    dir,
    git,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(path) {
      unlinkSync(join(dir, path));
    },
    chmod(path, mode) {
      chmodSync(join(dir, path), mode);
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD").trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
