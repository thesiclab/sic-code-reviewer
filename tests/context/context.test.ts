// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

// The context engine must pass every item through prompts.redact. Module 3 is
// built separately; this stand-in redacts one token shape so the test can see
// that redaction ran on stored text.
vi.mock("../../src/prompts/index.js", () => ({
  redact: (text: string) => ({
    text: text.replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED:github-token]"),
    counts: [],
  }),
}));

import {
  buildContext,
  calleesOf,
  changedFunctions,
  estimateTokens,
  findCallers,
  relatedTests,
  repoMap,
  symbolsDefinedIn,
  CONTEXT_DEFAULTS,
  type ContextOptions,
} from "../../src/context/index.js";
import {
  buildPatchSet,
  createGit,
  parseUnifiedDiff,
} from "../../src/diff/index.js";
import type { Hunk } from "../../src/types.js";
import { makeRepo, type FixtureRepo } from "../fixtures/repo.js";

const repos: FixtureRepo[] = [];
function repo(): FixtureRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

/** A hunk adding one line at `line`. */
const at = (line: number): Hunk => ({
  oldStart: line,
  oldCount: 0,
  newStart: line,
  newCount: 1,
  header: "",
  lines: [{ kind: "add", newLine: line, text: "" }],
});

// ---------------------------------------------------------------------------
describe("changedFunctions", () => {
  const ts = [
    "import { x } from './x';", // 1
    "", // 2
    "export function outer(a: number): number {", // 3
    "  const s = '}{ not a brace';", // 4
    "  // } neither is this", // 5
    "  return helper(a) + 1;", // 6
    "}", // 7
    "", // 8
    "export class Box {", // 9
    "  private v = 0;", // 10
    "  get(): number {", // 11
    "    return this.v;", // 12
    "  }", // 13
    "  async put(n: number): Promise<void> {", // 14
    "    this.v = n;", // 15
    "  }", // 16
    "}", // 17
    "const arrow = (q: string) => {", // 18
    "  return q.length;", // 19
    "};", // 20
    "",
  ].join("\n");

  it("finds TS functions, methods and arrow functions by brace matching, ignoring braces in strings and comments", () => {
    expect(changedFunctions(ts, "a.ts", [at(6)])).toEqual([
      { name: "outer", startLine: 3, endLine: 7 },
    ]);
    expect(changedFunctions(ts, "a.ts", [at(15)])).toEqual([
      { name: "put", startLine: 14, endLine: 16 },
    ]);
    expect(changedFunctions(ts, "a.ts", [at(12)])).toEqual([
      { name: "get", startLine: 11, endLine: 13 },
    ]);
    expect(changedFunctions(ts, "a.ts", [at(10)])).toEqual([
      { name: "Box", startLine: 9, endLine: 17 },
    ]);
    expect(changedFunctions(ts, "a.ts", [at(19)])).toEqual([
      { name: "arrow", startLine: 18, endLine: 20 },
    ]);
  });

  it("uses the hunk plus 20 lines either side outside any function and for unknown languages", () => {
    expect(changedFunctions(ts, "a.ts", [at(1)])).toEqual([
      { name: "", startLine: 1, endLine: 20 },
    ]);
    const txt =
      Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    expect(changedFunctions(txt, "data.weird", [at(50)])).toEqual([
      { name: "", startLine: 30, endLine: 70 },
    ]);
    expect(changedFunctions(txt, "data.weird", [at(50), at(55)])).toEqual([
      { name: "", startLine: 30, endLine: 75 },
    ]);
  });

  it("uses indentation for Python, with decorators and multi-line signatures", () => {
    const py = [
      "import os", // 1
      "", // 2
      "@cache", // 3
      "def load(path,", // 4
      "         mode='r'):", // 5
      '    """Doc with a', // 6
      'def fake(): inside docstring"""', // 7
      "    with open(path) as f:", // 8
      "        return parse(f.read())", // 9
      "", // 10
      "class Store:", // 11
      "    def get(self, k):", // 12
      "        return self.d[k]", // 13
      "", // 14
      "x = 1", // 15
      "",
    ].join("\n");
    expect(changedFunctions(py, "m.py", [at(9)])).toEqual([
      { name: "load", startLine: 3, endLine: 9 },
    ]);
    expect(changedFunctions(py, "m.py", [at(13)])).toEqual([
      { name: "get", startLine: 12, endLine: 13 },
    ]);
  });

  it("handles Go functions and methods", () => {
    const go = [
      "package m",
      "",
      "func (s *Server) Handle(w Writer) error {",
      "\tif x {",
      "\t\treturn nil",
      "\t}",
      "\treturn s.next(w)",
      "}",
      "",
    ].join("\n");
    expect(changedFunctions(go, "m.go", [at(5)])).toEqual([
      { name: "Handle", startLine: 3, endLine: 8 },
    ]);
  });

  it("locates pure deletions by the surrounding new-side lines", () => {
    const text =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -14,3 +14,2 @@\n   async put(n: number): Promise<void> {\n-    log(n);\n     this.v = n;\n";
    const hunks = parseUnifiedDiff(text)[0]!.hunks;
    expect(changedFunctions(ts, "a.ts", hunks)).toEqual([
      { name: "put", startLine: 14, endLine: 16 },
    ]);
  });
});

describe("symbolsDefinedIn / calleesOf", () => {
  const src = [
    "export function process(items: Item[]): number {",
    "  const total = sumAll(items.map((i) => weigh(i)));",
    "  console.log('calls fake(1) in a string');",
    "  if (total > limit()) { throw new OverLimit(total); }",
    "  return process(items.slice(1));",
    "}",
    "",
  ].join("\n");
  const span = { name: "process", startLine: 1, endLine: 6 };

  it("names the function as the changed symbol", () => {
    expect(symbolsDefinedIn(span, src, "p.ts")).toEqual(["process"]);
  });

  it("lists called identifiers, skipping keywords, builtins, strings and recursion", () => {
    expect(calleesOf(span, src, "p.ts")).toEqual([
      "sumAll",
      "weigh",
      "limit",
      "OverLimit",
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("findCallers / relatedTests / repoMap on a fixture repo", () => {
  function fixture(): { r: FixtureRepo; head: string } {
    const r = repo();
    r.write(
      "src/pricing.ts",
      "export function applyDiscount(p: number): number {\n  return p * 0.9;\n}\n",
    );
    r.write(
      "src/cart.ts",
      "import { applyDiscount } from './pricing';\nexport function total(xs: number[]) {\n  return xs.map((x) => applyDiscount(x));\n}\n",
    );
    r.write(
      "src/pricing.test.ts",
      "import { it } from 'vitest';\nit('works', () => {});\n",
    );
    r.write(
      "tests/checkout.spec.ts",
      "// exercises applyDiscount end to end\napplyDiscount(1);\n",
    );
    r.write("tests/unrelated.test.ts", "nothing here\n");
    r.write("vendor/x/pricing.js", "applyDiscount(2);\n");
    const head = r.commit("c");
    return { r, head };
  }

  it("findCallers returns call sites, not the definition, imports or vendored code", async () => {
    const { r, head } = fixture();
    const hits = await findCallers(createGit(r.dir), head, "applyDiscount", 5);
    expect(hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual([
      "src/cart.ts:3",
      "tests/checkout.spec.ts:2",
    ]);
    expect(
      (await findCallers(createGit(r.dir), head, "applyDiscount", 1)).length,
    ).toBe(1);
  });

  it("relatedTests finds tests by name convention first, then by symbol", async () => {
    const { r, head } = fixture();
    const tests = await relatedTests(
      createGit(r.dir),
      head,
      ["src/pricing.ts"],
      ["applyDiscount"],
    );
    expect(tests).toEqual(["src/pricing.test.ts", "tests/checkout.spec.ts"]);
  });

  it("repoMap stays within its token cap and says what it left out", async () => {
    const r = repo();
    for (let i = 0; i < 60; i++)
      r.write(`pkg${String(i).padStart(2, "0")}/file.ts`, "x\n");
    const head = r.commit("c");
    const full = await repoMap(createGit(r.dir), head, 10000);
    expect(full.split("\n")).toHaveLength(60);
    const small = await repoMap(createGit(r.dir), head, 50);
    expect(estimateTokens(small)).toBeLessThanOrEqual(50);
    expect(small).toMatch(/more folders not shown\)$/);
    expect(await repoMap(createGit(r.dir), head, 0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
describe("buildContext", () => {
  const TOKEN = `ghp_${"A".repeat(36)}`;

  async function scenario(): Promise<{
    r: FixtureRepo;
    base: string;
    head: string;
  }> {
    const r = repo();
    r.write(
      "src/pricing.ts",
      [
        "import { roundCents } from './money';",
        "",
        "export function applyDiscount(p: number, pct: number): number {",
        "  return roundCents(p * (1 - pct));",
        "}",
        "",
      ].join("\n"),
    );
    r.write(
      "src/money.ts",
      "export function roundCents(x: number): number {\n  return Math.round(x * 100) / 100;\n}\n",
    );
    r.write(
      "src/cart.ts",
      "import { applyDiscount } from './pricing';\n\nexport function total(xs: number[]): number {\n  return xs.reduce((a, x) => a + applyDiscount(x, 0.1), 0);\n}\n",
    );
    r.write(
      "src/pricing.test.ts",
      `// token ${TOKEN}\nimport { applyDiscount } from './pricing';\napplyDiscount(1, 0);\n`,
    );
    r.write("package-lock.json", '{\n  "lockfileVersion": 3\n}\n');
    const base = r.commit("base");
    r.write(
      "src/pricing.ts",
      [
        "import { roundCents } from './money';",
        "",
        "export function applyDiscount(p: number, pct: number): number {",
        "  if (pct > 1) pct = 1;",
        "  return roundCents(p * (1 - pct));",
        "}",
        "",
      ].join("\n"),
    );
    r.write("package-lock.json", '{\n  "lockfileVersion": 3,\n  "x": 1\n}\n');
    const head = r.commit("head");
    return { r, base, head };
  }

  const opts = (o: Partial<ContextOptions> = {}): ContextOptions => ({
    ...CONTEXT_DEFAULTS,
    ...o,
  });

  it("fills in the fixed order and records excluded files as not read", async () => {
    const { r, base, head } = await scenario();
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    const b = await buildContext(git, patch, opts());

    expect(b.items.map((i) => `${i.kind}:${i.path}`)).toEqual([
      "hunks:src/pricing.ts",
      "changed-function:src/pricing.ts",
      "caller:src/cart.ts",
      "caller:src/pricing.test.ts",
      "callee:src/money.ts",
      "test:src/pricing.test.ts",
      "repo-map:.",
    ]);
    const fn = b.items[1]!;
    expect(fn).toMatchObject({
      symbol: "applyDiscount",
      startLine: 3,
      endLine: 6,
    });
    expect(fn.text).toContain("4  " + "  if (pct > 1) pct = 1;");
    expect(b.items[4]).toMatchObject({
      symbol: "roundCents",
      startLine: 1,
      endLine: 3,
    });
    expect(b.notRead).toEqual([
      { kind: "file", path: "package-lock.json", reason: "lockfile" },
    ]);
    expect(b.tokensUsed).toBe(b.items.reduce((s, i) => s + i.tokens, 0));
    for (const i of b.items) expect(i.tokens).toBe(estimateTokens(i.text));
  });

  it("redacts every stored item", async () => {
    const { r, base, head } = await scenario();
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    const b = await buildContext(git, patch, opts());
    const all = b.items.map((i) => i.text).join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("[REDACTED:github-token]");
  });

  it("adds items whole or not at all and lists what did not fit", async () => {
    const { r, base, head } = await scenario();
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    const full = await buildContext(git, patch, opts());
    const hunkTokens = full.items[0]!.tokens;
    const fnTokens = full.items[1]!.tokens;
    const mapTokens = full.items.find((i) => i.kind === "repo-map")!.tokens;

    // Room for the hunks and the repo map only: middle tiers skip, filling continues.
    const b = await buildContext(
      git,
      patch,
      opts({ tokenBudget: hunkTokens + mapTokens }),
    );
    expect(b.items.map((i) => i.kind)).toEqual(["hunks", "repo-map"]);
    expect(b.tokensUsed).toBeLessThanOrEqual(b.tokenBudget);
    const skipped = b.notRead.filter((n) => n.reason === "budget");
    expect(skipped.map((n) => n.kind)).toEqual([
      "changed-function",
      "caller",
      "caller",
      "callee",
      "test",
    ]);
    expect(skipped[0]!.detail).toContain(`${fnTokens} tokens`);

    // A budget smaller than the diff itself: nothing fits, everything is listed.
    const none = await buildContext(git, patch, opts({ tokenBudget: 1 }));
    expect(none.items).toEqual([]);
    expect(
      none.notRead.some((n) => n.kind === "hunks" && n.reason === "budget"),
    ).toBe(true);
  });

  it("respects the caller and callee caps and appends static analysis last", async () => {
    const { r, base, head } = await scenario();
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    const b = await buildContext(
      git,
      patch,
      opts({
        maxCallersPerSymbol: 1,
        maxCalleesPerSymbol: 0,
        staticAnalysis: "lint: ok",
      }),
    );
    expect(b.items.filter((i) => i.kind === "caller")).toHaveLength(1);
    expect(b.items.filter((i) => i.kind === "callee")).toHaveLength(0);
    expect(b.items[b.items.length - 1]).toMatchObject({
      kind: "static-analysis",
      text: "lint: ok",
    });
  });

  it("adds no function items for a new file (its hunk is the whole file) but still finds its callers", async () => {
    const r = repo();
    r.write("src/a.ts", "export const a = 1;\n");
    const base = r.commit("base");
    r.write("src/fresh.ts", "export function freshHelper(n: number): number {\n  return n + 1;\n}\n");
    r.write("src/use.ts", "import { freshHelper } from './fresh';\nexport const v = freshHelper(2);\n");
    const head = r.commit("head");
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, { maxDiffLines: 5000, previous: null });
    const b = await buildContext(git, patch, opts());
    expect(b.items.filter((i) => i.kind === "changed-function")).toEqual([]);
    expect(b.items.filter((i) => i.kind === "hunks").map((i) => i.path).sort()).toEqual(["src/fresh.ts", "src/use.ts"]);
    // The caller sits in an added file whose hunk is already shown, so it is not repeated.
    expect(b.items.filter((i) => i.kind === "caller")).toEqual([]);
  });

  it("skips caller/callee/test lookups once the budget is spent", async () => {
    const { r, base, head } = await scenario();
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, { maxDiffLines: 5000, previous: null });
    const full = await buildContext(git, patch, opts());
    const b = await buildContext(git, patch, opts({ tokenBudget: full.items[0]!.tokens }));
    expect(b.items.map((i) => i.kind)).toEqual(["hunks"]);
    expect(b.notRead).toContainEqual(expect.objectContaining({ kind: "caller", reason: "budget", detail: expect.stringContaining("budget spent") }));
  });

  it("reads PR files from git objects, not the working tree", async () => {
    const { r, base, head } = await scenario();
    r.write("src/pricing.ts", "working tree garbage\n");
    const git = createGit(r.dir);
    const patch = await buildPatchSet(git, base, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    const b = await buildContext(git, patch, opts());
    expect(b.items[1]!.text).toContain("applyDiscount");
    expect(b.items.map((i) => i.text).join("\n")).not.toContain(
      "working tree garbage",
    );
  });
});
