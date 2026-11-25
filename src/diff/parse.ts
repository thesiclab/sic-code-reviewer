// SPDX-License-Identifier: Apache-2.0
// Unified diff parser for `git diff` output. Lines are split on LF only (see
// lfLines). Hunk content is read against each hunk's declared @@ counts, so a
// content line that looks like a header is never taken for one.
import type { DiffLine, FileClass, FilePatch, Hunk } from "../types.js";

const DIFF_HEADER = "diff --git ";
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Split on LF only, keeping each terminator. A lone CR, FF, U+2028 etc. is content. */
export function lfLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) lines.push(`${parts[i]}\n`);
  const last = parts[parts.length - 1];
  if (last) lines.push(last);
  return lines;
}

const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
};

/** Undo git's C-style quoting of a path ("caf\303\251.py"), or null if it will not decode. */
export function unquoteGitPath(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"'))
    return quoted;
  const body = quoted.slice(1, -1);
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; ) {
    const ch = body[i]!;
    if (ch !== "\\") {
      const cp = body.codePointAt(i)!;
      const s = String.fromCodePoint(cp);
      out.push(...enc.encode(s));
      i += s.length;
      continue;
    }
    i++;
    if (i >= body.length) return null;
    const esc = body[i]!;
    const mapped = C_ESCAPES[esc];
    if (mapped !== undefined) {
      out.push(mapped);
      i++;
      continue;
    }
    const digits = body.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(digits)) {
      const v = parseInt(digits, 8);
      if (v > 0xff) return null;
      out.push(v);
      i += 3;
      continue;
    }
    return null;
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(out));
}

/** `--- a/x` / `+++ b/x` -> repo path, or null for /dev/null or an undecodable path. */
function headerPath(line: string): string | null {
  let target = line.slice(4).replace(/\r$/, "");
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

/** (old, new) paths from a `diff --git a/X b/Y` header; null when it cannot be read. */
export function parseHeaderPaths(header: string): [string, string] | null {
  const rest = header.slice(DIFF_HEADER.length).replace(/\n$/, "");
  // Quoted form: "a/x" "b/y" (either side may be quoted).
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted && (rest.startsWith('"') || rest.endsWith('"'))) {
    const a = unquoteGitPath(quoted[1]!);
    const b = unquoteGitPath(quoted[2]!);
    if (a?.startsWith("a/") && b?.startsWith("b/"))
      return [a.slice(2), b.slice(2)];
    return null;
  }
  if (!rest.startsWith("a/")) return null;
  const candidates: [string, string][] = [];
  let idx = rest.indexOf(" b/");
  while (idx !== -1) {
    const o = rest.slice(2, idx);
    const n = rest.slice(idx + 3);
    if (o && n) candidates.push([o, n]);
    idx = rest.indexOf(" b/", idx + 1);
  }
  for (const c of candidates) if (c[0] === c[1]) return c;
  return candidates[0] ?? null;
}

/** Split a diff into file sections, each starting at `diff --git `. Text before the first is dropped. */
export function splitSections(text: string): string[][] {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of lfLines(text)) {
    if (line.startsWith(DIFF_HEADER)) {
      current = [line];
      sections.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return sections;
}

const strip = (l: string): string => (l.endsWith("\n") ? l.slice(0, -1) : l);

function parseSection(lines: string[]): FilePatch {
  const header = lines[0]!;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let minus: string | null | undefined;
  let plus: string | null | undefined;
  let added = false;
  let deleted = false;
  let modeChange = false;
  let binary = false;
  let i = 1;
  // Metadata until the first @@.
  for (; i < lines.length; i++) {
    const l = strip(lines[i]!);
    if (l.startsWith("@@")) break;
    if (l.startsWith("new file mode ")) added = true;
    else if (l.startsWith("deleted file mode ")) deleted = true;
    else if (l.startsWith("old mode ") || l.startsWith("new mode "))
      modeChange = true;
    else if (l.startsWith("rename from "))
      renameFrom = unquoteGitPath(l.slice(12));
    else if (l.startsWith("rename to ")) renameTo = unquoteGitPath(l.slice(10));
    else if (l.startsWith("Binary files ") || l === "GIT binary patch")
      binary = true;
    else if (l.startsWith("--- ") && minus === undefined) minus = headerPath(l);
    else if (l.startsWith("+++ ") && plus === undefined && minus !== undefined)
      plus = headerPath(l);
  }

  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const m = HUNK_RE.exec(strip(lines[i]!));
    if (!m) break; // unreadable: stop rather than guess at numbers
    const hunk: Hunk = {
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
      header: m[5] ?? "",
      lines: [],
    };
    i++;
    let oldLeft = hunk.oldCount;
    let newLeft = hunk.newCount;
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let broken = false;
    while ((oldLeft > 0 || newLeft > 0) && i < lines.length) {
      const l = strip(lines[i]!);
      const c = l[0];
      if (c === "+" && newLeft > 0) {
        hunk.lines.push({ kind: "add", newLine: newNo++, text: l.slice(1) });
        newLeft--;
      } else if (c === "-" && oldLeft > 0) {
        hunk.lines.push({ kind: "del", oldLine: oldNo++, text: l.slice(1) });
        oldLeft--;
      } else if (c === " " && oldLeft > 0 && newLeft > 0) {
        const dl: DiffLine = {
          kind: "ctx",
          oldLine: oldNo++,
          newLine: newNo++,
          text: l.slice(1),
        };
        hunk.lines.push(dl);
        oldLeft--;
        newLeft--;
      } else if (c === "\\") {
        // "\ No newline at end of file": a marker, not content.
      } else {
        broken = true;
        break;
      }
      i++;
    }
    // A trailing "\ No newline" after the budget is spent.
    while (i < lines.length && lines[i]!.startsWith("\\")) i++;
    hunks.push(hunk);
    if (broken || oldLeft > 0 || newLeft > 0) break;
  }

  const fromHeader = parseHeaderPaths(header);
  let oldPath: string | null;
  let newPath: string | null;
  if (renameFrom !== null && renameTo !== null) {
    oldPath = renameFrom;
    newPath = renameTo;
  } else if (minus !== undefined || plus !== undefined) {
    oldPath = minus ?? null;
    newPath = plus ?? null;
    if (minus === undefined && fromHeader) oldPath = fromHeader[0];
    if (plus === undefined && fromHeader) newPath = fromHeader[1];
  } else {
    oldPath = fromHeader ? fromHeader[0] : null;
    newPath = fromHeader ? fromHeader[1] : null;
  }
  if (added) oldPath = null;
  if (deleted) newPath = null;

  let status: FilePatch["status"];
  if (added) status = "added";
  else if (deleted) status = "deleted";
  else if (renameFrom !== null && renameTo !== null) status = "renamed";
  else if (modeChange && hunks.length === 0 && !binary) status = "mode";
  else status = "modified";

  const path = newPath ?? oldPath ?? "";
  const fileClass: FileClass = binary ? "binary" : classifyFile(path);
  return { oldPath, newPath, status, fileClass, hunks, raw: lines.join("") };
}

/** Parse `git diff` output into file patches. `raw` of each is its section byte for byte. */
export function parseUnifiedDiff(text: string): FilePatch[] {
  return splitSections(text).map(parseSection);
}

// ---------------------------------------------------------------------------
// File classes
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "go.sum",
  "go.work.sum",
  "poetry.lock",
  "pipfile.lock",
  "pdm.lock",
  "uv.lock",
  "gemfile.lock",
  "composer.lock",
  "flake.lock",
  "podfile.lock",
  "package.resolved",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "conan.lock",
  "cartfile.resolved",
]);

const VENDORED_DIRS = [
  "vendor/",
  "node_modules/",
  "third_party/",
  "third-party/",
  "bower_components/",
  "jspm_packages/",
  ".yarn/releases/",
  ".yarn/cache/",
];

const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "avif",
  "tif",
  "tiff",
  "psd",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "jar",
  "war",
  "whl",
  "egg",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "so",
  "dylib",
  "dll",
  "exe",
  "a",
  "o",
  "obj",
  "lib",
  "bin",
  "class",
  "pyc",
  "pyo",
  "wasm",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "flac",
  "mov",
  "avi",
  "webm",
  "mkv",
  "sqlite",
  "db",
  "lockb",
  "pb",
  "onnx",
  "pt",
  "safetensors",
  "parquet",
]);

const GENERATED_RE = [
  /\.min\.(js|css|mjs)$/,
  /\.(js|css|mjs)\.map$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.pyi?$/,
  /\.pb\.(cc|h)$/,
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.generated\.[a-z0-9]+$/,
  /\.gen\.(go|ts|js)$/,
  /_generated\.(go|ts|rs|py)$/,
  /(^|\/)__generated__\//,
  /(^|\/)generated\//,
  /(^|\/)dist\//,
  /(^|\/)\.next\//,
  /\.snap$/,
];

const TEST_RE = [
  /\.(test|spec)\.[a-z0-9]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rb|exs?)$/,
  /_spec\.rb$/,
  /(Test|Tests|IT)\.(java|kt|cs|scala)$/,
  /(^|\/)(tests?|__tests__|spec|specs)\//,
];

const DOC_EXT = new Set(["md", "mdx", "rst", "txt", "adoc", "asciidoc", "org"]);
const CONFIG_EXT = new Set([
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "editorconfig",
  "xml",
  "plist",
]);
const CONFIG_NAMES = new Set([
  "dockerfile",
  "makefile",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  "codeowners",
  ".dockerignore",
  "procfile",
]);

/** lockfile / vendored / binary / generated / test / docs / config / source, first match wins in that order. */
export function classifyFile(path: string): FileClass {
  const p = path.replace(/^\.\//, "");
  const lower = p.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (LOCKFILES.has(base)) return "lockfile";
  if (VENDORED_DIRS.some((d) => lower.startsWith(d) || lower.includes(`/${d}`)))
    return "vendored";
  if (BINARY_EXT.has(ext)) return "binary";
  if (GENERATED_RE.some((r) => r.test(lower))) return "generated";
  if (TEST_RE.some((r) => r.test(p) || r.test(lower))) return "test";
  if (
    DOC_EXT.has(ext) ||
    lower.startsWith("docs/") ||
    base === "license" ||
    base === "notice"
  )
    return "docs";
  if (
    CONFIG_EXT.has(ext) ||
    CONFIG_NAMES.has(base) ||
    lower.startsWith(".github/") ||
    base.startsWith("dockerfile")
  )
    return "config";
  return "source";
}
