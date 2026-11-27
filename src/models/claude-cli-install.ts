// SPDX-License-Identifier: Apache-2.0
// Installs the pinned official Claude Code CLI for the claude-cli reviewer.
//
// The action ships claude-cli/package.json (one dependency, an exact version)
// and its package-lock.json (integrity hashes). At run time both are copied to
// a private directory under RUNNER_TEMP and installed with `npm ci`, so the
// CLI that runs is exactly the locked one: never `latest`, never a range.
// npm gets a minimal environment: no model keys, no setup-token.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_CLI_PACKAGE = "@anthropic-ai/claude-code";
export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<void>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        windowsHide: true,
      },
      (err) =>
        err
          ? reject(
              new Error(
                `npm ci failed (${(err as NodeJS.ErrnoException).code ?? "error"})`,
              ),
            )
          : resolve(),
    );
  });

export interface InstallOptions {
  /** The action's own directory (holds claude-cli/). */
  actionDir: string;
  /** Where to install (RUNNER_TEMP in Actions). */
  workRoot: string;
  /** Source of PATH and HOME only. */
  env: NodeJS.ProcessEnv;
  exec?: ExecFn;
  timeoutMs?: number;
}

/**
 * Returns the pinned version. Throws unless claude-cli/package.json pins an
 * exact x.y.z version (never `latest` or a range) and the lockfile locks the
 * same version with an integrity hash. Dependabot bumps both together.
 */
export function checkPin(actionDir: string): string {
  const pkg = JSON.parse(
    readFileSync(join(actionDir, "claude-cli", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const want = pkg.dependencies?.[CLAUDE_CLI_PACKAGE] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(want))
    throw new Error(
      `claude-cli/package.json must pin ${CLAUDE_CLI_PACKAGE} at an exact version`,
    );
  const lock = JSON.parse(
    readFileSync(join(actionDir, "claude-cli", "package-lock.json"), "utf8"),
  ) as { packages?: Record<string, { version?: string; integrity?: string }> };
  const locked = lock.packages?.[`node_modules/${CLAUDE_CLI_PACKAGE}`];
  if (locked?.version !== want || !locked.integrity)
    throw new Error(
      `claude-cli/package-lock.json must lock ${CLAUDE_CLI_PACKAGE}@${want} with an integrity hash`,
    );
  return want;
}

/** Installs the locked CLI and returns the path of its `claude` executable. */
export async function installPinnedClaudeCli(
  o: InstallOptions,
): Promise<string> {
  checkPin(o.actionDir);
  const dir = join(o.workRoot, "sic-code-reviewer-claude-cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ["package.json", "package-lock.json"])
    copyFileSync(join(o.actionDir, "claude-cli", f), join(dir, f));
  const env: Record<string, string> = {
    PATH: o.env.PATH ?? "",
    HOME: o.env.HOME ?? dir,
    npm_config_update_notifier: "false",
  };
  await (o.exec ?? defaultExec)(
    "npm",
    ["ci", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: dir, env, timeoutMs: o.timeoutMs ?? 300_000 },
  );
  const bin = join(
    dir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "claude.cmd" : "claude",
  );
  if (!existsSync(bin))
    throw new Error("claude executable missing after npm ci");
  return bin;
}
