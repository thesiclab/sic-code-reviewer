// SPDX-License-Identifier: Apache-2.0
// The pinned CLI install, with npm replaced by a fake. No network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_PACKAGE,
  checkPin,
  installPinnedClaudeCli,
} from "../../src/models/index.js";

const TOKEN = ["sk", "ant", "oat01", "FAKEfakeFAKEfake0123456789"].join("-");
let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sic-install-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("pinned claude CLI", () => {
  it("the shipped pin is an exact version with a locked integrity hash", () => {
    expect(checkPin(process.cwd())).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("a range or 'latest' in the shipped package.json is refused", () => {
    const d = tmp();
    mkdirSync(join(d, "claude-cli"));
    writeFileSync(
      join(d, "claude-cli", "package.json"),
      JSON.stringify({ dependencies: { [CLAUDE_CLI_PACKAGE]: "latest" } }),
    );
    expect(() => checkPin(d)).toThrow(/exact version/);
  });

  it("runs npm ci from the lockfile with no secrets in its environment", async () => {
    const work = tmp();
    let seen: {
      file: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    } | null = null;
    const bin = await installPinnedClaudeCli({
      actionDir: process.cwd(),
      workRoot: work,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/x",
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
        ZAI_API_KEY: "k",
      },
      exec: async (file, args, o) => {
        seen = { file, args, env: o.env, cwd: o.cwd };
        mkdirSync(join(o.cwd, "node_modules", ".bin"), { recursive: true });
        writeFileSync(join(o.cwd, "node_modules", ".bin", "claude"), "");
      },
    });
    expect(seen).not.toBeNull();
    expect(seen!.file).toBe("npm");
    expect(seen!.args[0]).toBe("ci");
    expect(Object.keys(seen!.env).sort()).toEqual([
      "HOME",
      "PATH",
      "npm_config_update_notifier",
    ]);
    expect(JSON.stringify(seen!.env)).not.toContain(TOKEN);
    expect(bin).toBe(join(seen!.cwd, "node_modules", ".bin", "claude"));
  });

  it("fails when npm ci leaves no executable", async () => {
    await expect(
      installPinnedClaudeCli({
        actionDir: process.cwd(),
        workRoot: tmp(),
        env: { PATH: "/usr/bin" },
        exec: async () => {},
      }),
    ).rejects.toThrow(/missing/);
  });
});
