// SPDX-License-Identifier: Apache-2.0
// Generates eval case JSON from before/after file contents using git diff --no-index.
// Source of eval/planted/*.json and eval/injection/*.json. Edit a spec, then:
//   node eval/specs/gen-cases.mjs eval/specs/planted.mjs eval/planted
//   node eval/specs/gen-cases.mjs eval/specs/injection.mjs eval/injection
// Secrets are {{FAKE:<kind>}} placeholders, expanded only at load time.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [, , specPath, outDir] = process.argv;
const { cases } = await import(resolve(specPath));
mkdirSync(outDir, { recursive: true });

function diffFor(path, before, after) {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gen-"));
  try {
    const a = join(d, "a", path);
    const b = join(d, "b", path);
    mkdirSync(dirname(a), { recursive: true });
    mkdirSync(dirname(b), { recursive: true });
    const args = ["diff", "--no-index", "--no-color", "--no-ext-diff"];
    if (before !== null) writeFileSync(a, before);
    if (after !== null) writeFileSync(b, after);
    let out = "";
    try {
      execFileSync("git", [...args, before === null ? "/dev/null" : `a/${path}`, after === null ? "/dev/null" : `b/${path}`], { cwd: d, encoding: "utf8" });
    } catch (e) {
      out = e.stdout;
    }
    // Normalise headers to repo-relative a/ b/ paths.
    out = out.replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`);
    out = out.replace(/^--- a\/.*$/m, `--- a/${path}`).replace(/^\+\+\+ b\/.*$/m, `+++ b/${path}`);
    out = out.replace(/^index .*\n/m, "");
    if (before === null) out = out.replace(/^--- .*$/m, "--- /dev/null");
    return out;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

for (const c of cases) {
  let diff = "";
  const files = {};
  for (const [path, { before, after }] of Object.entries(c.files)) {
    diff += diffFor(path, before, after);
    if (after !== null) files[path] = after.split("\n");
  }
  const expected = (c.bugs ?? []).map((b) => {
    const lines = c.files[b.file].after.split("\n");
    const idx = lines.findIndex((l) => l.includes(b.find));
    if (idx < 0) throw new Error(`${c.id}: "${b.find}" not found in ${b.file}`);
    const span = b.span ?? 1;
    return { file: b.file, startLine: idx + 1, endLine: idx + span, severity: b.severity ?? "high", note: b.note };
  });
  const out = {
    id: c.id,
    title: c.title,
    body: c.body ?? "",
    diff: diff.split("\n"),
    files,
    expected,
    ...(c.injection ? { injection: c.injection } : {}),
  };
  if (out.diff.at(-1) === "") out.diff.pop();
  writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(out, null, 2) + "\n");
}
console.log(`wrote ${cases.length} cases to ${outDir}`);
