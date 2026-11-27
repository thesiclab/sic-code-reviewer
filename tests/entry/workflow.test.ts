// SPDX-License-Identifier: Apache-2.0
// Pins the security shape of the shipped workflow files (text checks, no YAML dependency).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wf = readFileSync("examples/workflows/sic-code-reviewer.yml", "utf8");
const action = readFileSync("action.yml", "utf8");
const code = (t: string) =>
  t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
const job = (name: string) => {
  const m = code(wf).match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`));
  if (!m) throw new Error(`job ${name} not found`);
  return m[1]!;
};

describe("example workflow security shape", () => {
  it("uses pull_request, never pull_request_target", () => {
    expect(code(wf)).toMatch(/^on:\n  pull_request:/m);
    expect(code(wf)).not.toContain("pull_request_target");
  });

  it("defaults to no permissions and cancels superseded runs", () => {
    expect(code(wf)).toMatch(/^permissions: \{\}$/m);
    expect(code(wf)).toContain("cancel-in-progress: true");
  });

  it("review job: read-only token, base checkout without persisted credentials", () => {
    const r = job("review");
    expect(r).toMatch(/contents: read/);
    expect(r).toMatch(/pull-requests: read/);
    expect(r).not.toMatch(/: write/);
    expect(r).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(r).toContain("persist-credentials: false");
    expect(r).toContain("mode: review");
  });

  it("post job: write token, no checkout, no model keys", () => {
    const p = job("post");
    expect(p).toMatch(/pull-requests: write/);
    expect(p).toMatch(/checks: write/);
    expect(p).not.toMatch(/contents: write/);
    expect(p).not.toContain("actions/checkout");
    expect(p).not.toMatch(/secrets\./);
    expect(p).toContain("needs: review");
    expect(p).toContain("mode: post");
  });

  it("skips fork PRs in both jobs", () => {
    for (const j of ["review", "post"]) {
      expect(job(j)).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    }
  });

  it("pins every action by a full commit SHA", () => {
    const uses = [...code(wf).matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("action.yml", () => {
  it("is a node action with a mode input and no secret defaults", () => {
    expect(code(action)).toMatch(/using: node\d+/);
    expect(code(action)).toMatch(/\n  mode:\n/);
    expect(code(action)).not.toMatch(/secrets\./);
  });
});

describe("Claude reviewer through the official CLI", () => {
  it("action.yml defaults the reviewer to claude-cli and names the token variable, never a value", () => {
    expect(code(action)).toMatch(/\n  reviewer-provider:\n[^\n]*\n[^\n]*\n    default: claude-cli\n/);
    expect(code(action)).not.toMatch(/sk-ant-/);
  });

  it("the example passes the setup-token secret only to the review job", () => {
    expect(job("review")).toContain("reviewer-provider: claude-cli");
    expect(job("review")).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(job("post")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("the CLI is pinned to an exact version, never latest or a range", () => {
    const pkg = JSON.parse(readFileSync("claude-cli/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@anthropic-ai/claude-code"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
