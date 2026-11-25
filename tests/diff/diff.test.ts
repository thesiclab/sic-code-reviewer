// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import {
  anchorableLines,
  buildIncremental,
  buildPatchSet,
  checkSubset,
  classifyFile,
  countDiffLines,
  createGit,
  lockfileNote,
  parseUnifiedDiff,
  renderNumbered,
  GitError,
} from "../../src/diff/index.js";
import type { FilePatch, RoundSentinel } from "../../src/types.js";
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

const lines = (n: number, prefix = "line"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

function sentinel(
  mergeBase: string,
  headSha: string,
  baseSha = mergeBase,
): RoundSentinel {
  return {
    v: 1,
    round: 1,
    baseSha,
    headSha,
    mergeBase,
    cacheKey: "k",
    conclusion: "success",
  };
}

// ---------------------------------------------------------------------------
describe("createGit", () => {
  it("runs merge-base, diff, show, grep and ls-tree against a real repo", async () => {
    const r = repo();
    r.write("src/a.ts", "export function alpha() {\n  return 1;\n}\n");
    r.write("src/b.ts", "import { alpha } from './a';\nalpha();\n");
    const base = r.commit("base");
    r.write("src/a.ts", "export function alpha() {\n  return 2;\n}\n");
    const head = r.commit("head");
    const git = createGit(r.dir);
    expect(await git.mergeBase(base, head)).toBe(base);
    const d = await git.diff(base, head);
    expect(d).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(d).toMatch(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/); // --full-index
    expect(await git.show(head, "src/a.ts")).toContain("return 2");
    expect(await git.show(base, "src/a.ts")).toContain("return 1");
    expect(await git.show(head, "missing.ts")).toBeNull();
    expect(await git.show(head, "src")).toBeNull(); // a tree is not file text
    const hits = await git.grep(head, "alpha", {
      word: true,
      fixed: true,
      maxCount: 10,
    });
    expect(hits).toEqual(
      expect.arrayContaining([
        { path: "src/a.ts", line: 1, text: "export function alpha() {" },
        { path: "src/b.ts", line: 2, text: "alpha();" },
      ]),
    );
    expect(
      await git.grep(head, "nomatchanywhere", {
        word: true,
        fixed: true,
        maxCount: 5,
      }),
    ).toEqual([]);
    expect(
      (await git.grep(head, "alpha", { word: true, fixed: true, maxCount: 1 }))
        .length,
    ).toBe(1);
    expect((await git.lsTree(head)).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("treats grep patterns as data and refuses revisions that look like options", async () => {
    const r = repo();
    r.write("x.txt", "--output=/tmp/pwn\n");
    const head = r.commit("c");
    const git = createGit(r.dir);
    const hits = await git.grep(head, "--output=/tmp/pwn", {
      word: false,
      fixed: true,
      maxCount: 5,
    });
    expect(hits).toEqual([
      { path: "x.txt", line: 1, text: "--output=/tmp/pwn" },
    ]);
    await expect(git.diff("--output=/tmp/x", head)).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(git.mergeBase(head, "a..b")).rejects.toBeInstanceOf(GitError);
  });
});

// ---------------------------------------------------------------------------
describe("parseUnifiedDiff", () => {
  it("parses every status from a real diff, with raw sections that rebuild the text byte for byte", async () => {
    const r = repo();
    r.write("mod.py", lines(10));
    r.write("gone.txt", "bye\n");
    r.write("old/name.ts", lines(30, "keep"));
    r.write("run.sh", "echo hi\n");
    r.write("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const base = r.commit("base");
    r.write("mod.py", lines(10).replace("line 5\n", "line five\nline 5b\n"));
    r.remove("gone.txt");
    r.write("new.ts", "export const x = 1;\n");
    r.remove("old/name.ts");
    r.write("new/name.ts", lines(30, "keep"));
    r.chmod("run.sh", 0o755);
    r.write("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    r.write("café dir/ü.py", "x = 1\n");
    const head = r.commit("head");
    const text = await createGit(r.dir).diff(base, head);
    const files = parseUnifiedDiff(text);
    const by = (p: string): FilePatch =>
      files.find((f) => (f.newPath ?? f.oldPath) === p)!;

    expect(files.map((f) => f.raw).join("")).toBe(text);

    const mod = by("mod.py");
    expect(mod.status).toBe("modified");
    expect(mod.fileClass).toBe("source");
    expect(mod.hunks).toHaveLength(1);
    const added = mod.hunks[0]!.lines.filter((l) => l.kind === "add");
    expect(added).toEqual([
      { kind: "add", newLine: 5, text: "line five" },
      { kind: "add", newLine: 6, text: "line 5b" },
    ]);
    expect(mod.hunks[0]!.lines.find((l) => l.kind === "del")).toEqual({
      kind: "del",
      oldLine: 5,
      text: "line 5",
    });

    expect(by("gone.txt")).toMatchObject({
      status: "deleted",
      oldPath: "gone.txt",
      newPath: null,
    });
    expect(by("new.ts")).toMatchObject({
      status: "added",
      oldPath: null,
      newPath: "new.ts",
    });
    expect(by("new/name.ts")).toMatchObject({
      status: "renamed",
      oldPath: "old/name.ts",
      newPath: "new/name.ts",
      hunks: [],
    });
    expect(by("run.sh")).toMatchObject({ status: "mode", hunks: [] });
    expect(by("img.png")).toMatchObject({
      status: "modified",
      fileClass: "binary",
    });
    expect(by("café dir/ü.py")).toMatchObject({
      status: "added",
      newPath: "café dir/ü.py",
    });
  });

  it("splits on LF only, so a form feed cannot forge a file section", () => {
    const text =
      "diff --git a/a.py b/a.py\nindex 1..2 100644\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,2 @@\n x\n+y\fdiff --git a/lib/auth.py b/lib/auth.py\n";
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]!.hunks[0]!.lines[1]!.text).toBe(
      "y\fdiff --git a/lib/auth.py b/lib/auth.py",
    );
  });

  it("reads hunk content by its declared counts, so a `+++ b/x` content line is content", () => {
    const text = [
      "diff --git a/p.diff b/p.diff",
      "--- a/p.diff",
      "+++ b/p.diff",
      "@@ -1,1 +1,3 @@",
      " keep",
      "+--- a/evil.py",
      "++++ b/evil.py",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(text);
    expect(f!.newPath).toBe("p.diff");
    expect(f!.hunks[0]!.lines.map((l) => [l.kind, l.newLine, l.text])).toEqual([
      ["ctx", 1, "keep"],
      ["add", 2, "--- a/evil.py"],
      ["add", 3, "+++ b/evil.py"],
    ]);
  });

  it("stops at a hunk whose body disagrees with its counts instead of guessing", () => {
    const text =
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n x\nnot a content line\n";
    const [f] = parseUnifiedDiff(text);
    expect(f!.hunks).toHaveLength(1);
    expect(f!.hunks[0]!.lines).toHaveLength(1);
  });
});

describe("classifyFile", () => {
  it.each([
    ["package-lock.json", "lockfile"],
    ["web/yarn.lock", "lockfile"],
    ["Cargo.lock", "lockfile"],
    ["go.sum", "lockfile"],
    ["vendor/github.com/x/y.go", "vendored"],
    ["app/node_modules/x/index.js", "vendored"],
    ["logo.png", "binary"],
    ["dist/index.js", "generated"],
    ["a/b.min.js", "generated"],
    ["api/foo.pb.go", "generated"],
    ["src/foo.test.ts", "test"],
    ["tests/test_foo.py", "test"],
    ["pkg/foo_test.go", "test"],
    ["README.md", "docs"],
    ["docs/guide.txt", "docs"],
    [".github/workflows/ci.yml", "config"],
    ["tsconfig.json", "config"],
    ["Dockerfile", "config"],
    ["src/index.ts", "source"],
    ["main.go", "source"],
  ])("%s -> %s", (path, cls) => {
    expect(classifyFile(path)).toBe(cls);
  });
});

// ---------------------------------------------------------------------------
describe("anchorableLines (Comfy port)", () => {
  it("maps added and context lines, not deletions", () => {
    const text = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "diff --git a/gone.py b/gone.py",
      "--- a/gone.py",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-x",
      "",
    ].join("\n");
    const m = anchorableLines(text)!;
    expect([...m.get("a.py")!]).toEqual([1, 2, 3]);
    expect(m.has("gone.py")).toBe(false);
  });

  it("returns null for text that is not a diff (fail open)", () => {
    expect(anchorableLines("hello\nworld\n")).toBeNull();
    expect(anchorableLines("")).toBeNull();
  });

  it("decodes quoted and tab-terminated paths", () => {
    const text =
      'diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"\n--- "a/caf\\303\\251.py"\n+++ "b/caf\\303\\251.py"\n@@ -1 +1 @@\n-a\n+b\n';
    expect([...anchorableLines(text)!.get("café.py")!]).toEqual([1]);
    const spaced =
      "diff --git a/my dir/x.py b/my dir/x.py\n--- a/my dir/x.py\t\n+++ b/my dir/x.py\t\n@@ -1 +1 @@\n-a\n+b\n";
    expect([...anchorableLines(spaced)!.get("my dir/x.py")!]).toEqual([1]);
  });

  it("does not let an over-declared hunk eat the next header pair and fabricate anchors", () => {
    const text = [
      "diff --git a/x.py b/x.py",
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1,2 +1,2 @@",
      " a",
      "diff --git a/y.py b/y.py",
      "--- a/y.py",
      "+++ b/y.py",
      "@@ -1 +1 @@",
      "-q",
      "+r",
      "",
    ].join("\n");
    const m = anchorableLines(text)!;
    expect([...m.get("y.py")!]).toEqual([1]);
    expect([...m.get("x.py")!]).toEqual([1]);
  });

  it("ignores a header pair that content forges after the budget is spent", () => {
    const text = [
      "diff --git a/x.py b/x.py",
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- x",
      "+++ b/app.py",
      "@@ -1 +500,2 @@",
      "+evil",
      "",
    ].join("\n");
    const m = anchorableLines(text)!;
    expect(m.has("app.py")).toBe(false);
    expect([...m.get("x.py")!]).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
describe("buildIncremental / checkSubset (Comfy port)", () => {
  const sec = (
    path: string,
    idx: string,
    hunkHeader: string,
    body: string,
  ): string =>
    `diff --git a/${path} b/${path}\nindex ${idx} 100644\n--- a/${path}\n+++ b/${path}\n${hunkHeader}\n${body}`;

  it("drops sections that only moved (rebase) and keeps changed and new ones", () => {
    const oldP =
      sec("a.py", "111..222", "@@ -1,2 +1,2 @@", " x\n-y\n+z\n") +
      sec("b.py", "333..444", "@@ -1 +1 @@", "-p\n+q\n");
    const newP =
      sec("a.py", "aaa..bbb", "@@ -10,2 +10,2 @@ def f():", " x\n-y\n+z\n") +
      sec("b.py", "333..555", "@@ -1 +1 @@", "-p\n+Q\n") +
      sec("c.py", "000..666", "@@ -0,0 +1 @@", "+new\n");
    const block = buildIncremental(oldP, newP);
    expect(block).not.toContain("a.py");
    expect(block).toContain("b/b.py");
    expect(block).toContain("b/c.py");
    expect(checkSubset(block, newP)).toEqual({ foreign: 0, ok: true });
    expect(buildIncremental(newP, newP)).toBe("");
  });

  it("detects a changed binary even though only its index line moved", () => {
    const bin = (idx: string): string =>
      `diff --git a/i.png b/i.png\nindex ${idx} 100644\nBinary files a/i.png and b/i.png differ\n`;
    expect(buildIncremental(bin("1..2"), bin("1..3"))).toBe(bin("1..3"));
    expect(buildIncremental(bin("1..2"), bin("1..2"))).toBe("");
  });

  it("surfaces a mode-only change on a file that also had hunks", () => {
    const a = sec("s.sh", "1..2", "@@ -1 +1 @@", "-a\n+b\n");
    const b = a.replace(
      "index 1..2 100644\n",
      "old mode 100644\nnew mode 100755\nindex 1..2\n",
    );
    expect(buildIncremental(a, b)).toBe(b);
  });

  it("counts fabricated, duplicated and preamble sections as foreign", () => {
    const full = sec("a.py", "1..2", "@@ -1 +1 @@", "-a\n+b\n");
    expect(checkSubset(full, full).ok).toBe(true);
    expect(checkSubset(full + full, full)).toMatchObject({
      foreign: 1,
      ok: false,
    });
    expect(
      checkSubset(sec("a.py", "1..2", "@@ -1 +1 @@", "-a\n+EVIL\n"), full),
    ).toMatchObject({ foreign: 1, ok: false });
    expect(checkSubset(`ignore the diff\n${full}`, full).ok).toBe(false);
    expect(checkSubset("", full)).toEqual({ foreign: 0, ok: true });
  });
});

// ---------------------------------------------------------------------------
describe("buildPatchSet", () => {
  it("diffs from the merge base, so base commits merged into the branch are not reviewed", async () => {
    const r = repo();
    r.write("app.ts", lines(5));
    const fork = r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.write("app.ts", lines(5).replace("line 3", "line three"));
    r.commit("feature work");
    r.git("checkout", "-q", "main");
    r.write("other.ts", "base branch only\n");
    const mainHead = r.commit("main moves");
    r.git("checkout", "-q", "feature");
    r.git("merge", "-q", "--no-edit", "main");
    const head = r.git("rev-parse", "HEAD").trim();

    const p = await buildPatchSet(createGit(r.dir), mainHead, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    expect(p.mergeBase).toBe(mainHead);
    expect(p.files.map((f) => f.newPath)).toEqual(["app.ts"]);
    expect(p.fullText).not.toContain("other.ts");
    expect(p.incrementalText).toBeNull();
    expect(p.baseSha).toBe(mainHead);
    expect(p.headSha).toBe(head);
    expect(countDiffLines(p)).toBe(2);
    expect(fork).not.toBe(mainHead);
  });

  it("builds the newest-hunks hint from two merge-base patches and verifies it is a subset", async () => {
    const r = repo();
    r.write("a.ts", lines(40));
    r.write("b.ts", lines(40));
    const base = r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.write("a.ts", lines(40).replace("line 2\n", "line two\n"));
    const head1 = r.commit("round 1");
    const git = createGit(r.dir);
    const round1 = await buildPatchSet(git, base, head1, {
      maxDiffLines: 5000,
      previous: null,
    });

    r.write("b.ts", lines(40).replace("line 30\n", "line thirty\n"));
    const head2 = r.commit("round 2");
    const round2 = await buildPatchSet(git, base, head2, {
      maxDiffLines: 5000,
      previous: sentinel(round1.mergeBase, head1),
    });
    expect(round2.fullText).toContain("b/a.ts");
    expect(round2.incrementalText).not.toBeNull();
    expect(round2.incrementalText).toContain("b/b.ts");
    expect(round2.incrementalText).not.toContain("b/a.ts");
    expect(round2.fullText.includes(round2.incrementalText!)).toBe(true);

    // Nothing new since the last round: an empty hint, not null.
    const again = await buildPatchSet(git, base, head2, {
      maxDiffLines: 5000,
      previous: sentinel(round1.mergeBase, head2),
    });
    expect(again.incrementalText).toBe("");

    // Previous round's commits are unknown (force push + gc): no hint.
    const lost = await buildPatchSet(git, base, head2, {
      maxDiffLines: 5000,
      previous: sentinel("f".repeat(40), "e".repeat(40)),
    });
    expect(lost.incrementalText).toBeNull();
  });

  it("pins the old patch to the recorded merge base, so a moved base does not hide unseen hunks", async () => {
    const r = repo();
    r.write("a.ts", lines(40));
    const base1 = r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.write("a.ts", lines(40).replace("line 2\n", "line two\n"));
    const head1 = r.commit("round 1");
    r.git("checkout", "-q", "main");
    r.write("c.ts", "main\n");
    const base2 = r.commit("main moves");
    r.git("checkout", "-q", "feature");
    r.git("merge", "-q", "--no-edit", "main");
    const head2 = r.git("rev-parse", "HEAD").trim();
    const p = await buildPatchSet(createGit(r.dir), base2, head2, {
      maxDiffLines: 5000,
      previous: sentinel(base1, head1),
    });
    // The branch's own edit did not change, so nothing is new; c.ts is not in the PR at all.
    expect(p.incrementalText).toBe("");
    expect(p.fullText).not.toContain("c.ts");
  });

  it("excludes lockfile, generated, vendored and binary bodies and writes lockfile notes", async () => {
    const r = repo();
    const lock = (v: string, extra = ""): string =>
      JSON.stringify(
        {
          name: "x",
          lockfileVersion: 3,
          packages: {
            "": { name: "x" },
            "node_modules/left-pad": { version: v },
            ...(extra
              ? {
                  [`node_modules/${extra}`]: {
                    version: "0.1.0",
                    hasInstallScript: true,
                  },
                }
              : {}),
          },
        },
        null,
        2,
      ) + "\n";
    r.write("package-lock.json", lock("1.0.0"));
    r.write("src/a.ts", "export const a = 1;\n");
    const base = r.commit("base");
    r.write("package-lock.json", lock("1.3.0", "evil-postinstall"));
    r.write("dist/out.js", "generated();\n");
    r.write("vendor/lib.go", "package lib\n");
    r.write("pic.png", Buffer.from([1, 2, 3, 0, 4]));
    r.write("src/a.ts", "export const a = 2;\n");
    const head = r.commit("head");
    const p = await buildPatchSet(createGit(r.dir), base, head, {
      maxDiffLines: 5000,
      previous: null,
    });
    expect(p.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
      ["dist/out.js", "generated"],
      ["package-lock.json", "lockfile"],
      ["pic.png", "binary"],
      ["vendor/lib.go", "vendored"],
    ]);
    expect(p.lockfileNotes).toHaveLength(1);
    expect(p.lockfileNotes[0]).toContain(
      "changed (1): left-pad 1.0.0 -> 1.3.0",
    );
    expect(p.lockfileNotes[0]).toContain("added (1): evil-postinstall 0.1.0");
    expect(p.lockfileNotes[0]).toContain(
      "new install scripts (1): evil-postinstall",
    );
  });
});

describe("lockfileNote", () => {
  const filePatch = (path: string, body: string): FilePatch => {
    const n = body.split("\n").length - 1;
    const text = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${n} +1,${n} @@\n${body}`;
    return parseUnifiedDiff(text)[0]!;
  };
  it("reads yarn.lock, Cargo.lock, go.sum and pnpm-lock.yaml", () => {
    expect(
      lockfileNote(
        filePatch(
          "yarn.lock",
          ' "lodash@^4.17.0":\n-  version "4.17.20"\n+  version "4.17.21"\n',
        ),
      ),
    ).toContain("changed (1): lodash 4.17.20 -> 4.17.21");
    expect(
      lockfileNote(
        filePatch(
          "Cargo.lock",
          ' name = "serde"\n-version = "1.0.1"\n+version = "1.0.2"\n',
        ),
      ),
    ).toContain("serde 1.0.1 -> 1.0.2");
    expect(
      lockfileNote(
        filePatch(
          "go.sum",
          "-golang.org/x/net v0.1.0 h1:aaa=\n+golang.org/x/net v0.2.0 h1:bbb=\n+golang.org/x/net v0.2.0/go.mod h1:ccc=\n",
        ),
      ),
    ).toContain("golang.org/x/net v0.1.0 -> v0.2.0");
    const pnpm = lockfileNote(
      filePatch(
        "pnpm-lock.yaml",
        "-  /esbuild@0.18.0:\n+  /esbuild@0.19.0:\n+    requiresBuild: true\n",
      ),
    );
    expect(pnpm).toContain("esbuild 0.18.0 -> 0.19.0");
    expect(pnpm).toContain("new install scripts (1): esbuild");
  });
  it("falls back to line counts for formats it does not parse", () => {
    expect(lockfileNote(filePatch("flake.lock", "-a\n+b\n"))).toBe(
      "flake.lock: modified, 1 lines added, 1 removed; format not parsed",
    );
  });
});

describe("renderNumbered", () => {
  it("prints new-side numbers for added and context lines, none for deletions", () => {
    const text =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,3 +8,3 @@ function f() {\n x\n-y\n+z\n w\n";
    expect(renderNumbered(parseUnifiedDiff(text)[0]!)).toBe(
      [
        "File: a.ts (modified)",
        "@@ -8,3 +8,3 @@ function f() {",
        " 8   x",
        "   - y",
        " 9 + z",
        "10   w",
      ].join("\n"),
    );
  });
  it("says so when there are no text hunks", () => {
    const text =
      "diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n";
    expect(renderNumbered(parseUnifiedDiff(text)[0]!)).toBe(
      "File: i.png (modified)\n(binary file, no text hunks)",
    );
  });
});
