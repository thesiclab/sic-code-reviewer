// SPDX-License-Identifier: Apache-2.0
// Module 2: context engine. Fill order: hunks -> changed functions ->
// callers/callees -> related tests -> repo map (-> static analysis, later),
// capped by a token budget. Each item goes in whole or not at all; an item
// that does not fit is listed in notRead and filling continues with later
// (smaller) items, never going back up a tier. Every item is rendered with
// line numbers and redacted before it is stored.
//
// The bundle's notRead also repeats patch.excluded (lockfile, generated,
// vendored, binary files), so it is the one list of what the model did not see.
import type {
  ContextBundle,
  ContextItem,
  ContextKind,
  NotRead,
  PatchSet,
} from "../types.js";
import type { Git, GrepHit } from "../diff/index.js";
import { classifyFile, isExcludedFile, renderNumbered } from "../diff/index.js";
import { redact } from "../prompts/index.js";
import { estimateTokens } from "../cost/tokens.js";
import {
  allSpans,
  calleesOf,
  changedFunctions,
  isDefinitionLine,
  isImportLine,
  symbolsDefinedIn,
  type FunctionSpan,
} from "./functions.js";

export {
  calleesOf,
  changedFunctions,
  symbolsDefinedIn,
  languageOf,
  maskSource,
  allSpans,
  isDefinitionLine,
} from "./functions.js";
export type { FunctionSpan } from "./functions.js";
export { estimateTokens } from "../cost/tokens.js";

export interface ContextOptions {
  tokenBudget: number;
  maxCallersPerSymbol: number;
  maxCalleesPerSymbol: number;
  repoMapMaxTokens: number;
  /** LATER: static-analysis output as the last fill item. */
  staticAnalysis?: string;
}

export const CONTEXT_DEFAULTS: ContextOptions = {
  tokenBudget: 60000,
  maxCallersPerSymbol: 5,
  maxCalleesPerSymbol: 5,
  repoMapMaxTokens: 1500,
};

/** A caller or callee slice longer than this is cut to a window around the hit. */
const MAX_SLICE_LINES = 150;
const SLICE_WINDOW = 15;
const MAX_RELATED_TESTS = 20;
const MAX_SYMBOLS_FOR_TESTS = 20;
/** Bound on symbols searched for callers per PR, to bound git calls on large diffs. */
const MAX_CALLER_SYMBOLS = 40;
/** A line that is only a comment mentions a symbol; it does not call it. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#\s|--\s)/;

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** `git grep -w -F <symbol>` at sha, minus definition and import lines, up to max hits. */
export async function findCallers(
  git: Git,
  sha: string,
  symbol: string,
  max: number,
): Promise<GrepHit[]> {
  if (max <= 0 || symbol === "") return [];
  const hits = await git.grep(sha, symbol, {
    word: true,
    fixed: true,
    maxCount: max * 4 + 10,
  });
  const out: GrepHit[] = [];
  for (const h of hits) {
    if (
      isDefinitionLine(symbol, h.text, h.path) ||
      isImportLine(h.text) ||
      COMMENT_LINE_RE.test(h.text)
    )
      continue;
    const cls = classifyFile(h.path);
    if (
      cls === "vendored" ||
      cls === "generated" ||
      cls === "lockfile" ||
      cls === "binary"
    )
      continue;
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

function stemOf(path: string): string {
  let base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  return base.replace(/^test_/, "").replace(/_test$/, "");
}

const GENERIC_STEMS = new Set([
  "index",
  "main",
  "mod",
  "__init__",
  "init",
  "lib",
  "app",
  "utils",
  "util",
  "types",
  "common",
]);

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function conventionMatch(changed: string, test: string): boolean {
  const s = stemOf(changed);
  if (!s) return false;
  const tb = test.slice(test.lastIndexOf("/") + 1);
  const es = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named =
    new RegExp(`^${es}\\.(test|spec)\\.[^.]+$`).test(tb) ||
    new RegExp(`^test_${es}\\.py$`).test(tb) ||
    new RegExp(`^${es}_test\\.[^.]+$`).test(tb) ||
    new RegExp(`^${es}(Test|Tests|Spec)\\.[^.]+$`).test(tb) ||
    (/(^|\/)(tests?|__tests__|spec|specs)\//.test(test) &&
      new RegExp(`^${es}([^A-Za-z0-9]|$)`).test(tb));
  if (!named) return false;
  if (!GENERIC_STEMS.has(s)) return true;
  // A generic name (index.ts) needs the test to sit beside it or mirror its folder.
  const parent = dirOf(changed);
  const parentName = parent.slice(parent.lastIndexOf("/") + 1);
  return (
    dirOf(test) === parent ||
    (parentName !== "" && test.split("/").includes(parentName))
  );
}

/** Test files by name convention first, then test files whose text names a changed symbol. */
export async function relatedTests(
  git: Git,
  sha: string,
  changedPaths: string[],
  symbols: string[],
): Promise<string[]> {
  const all = await git.lsTree(sha);
  const changed = new Set(changedPaths);
  const tests = all.filter(
    (p) => classifyFile(p) === "test" && !changed.has(p),
  );
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p) && out.length < MAX_RELATED_TESTS) out.push(p);
  };
  for (const c of changedPaths) {
    if (classifyFile(c) === "test") continue;
    for (const t of tests) if (conventionMatch(c, t)) push(t);
  }
  const testSet = new Set(tests);
  for (const sym of symbols.slice(0, MAX_SYMBOLS_FOR_TESTS)) {
    if (out.length >= MAX_RELATED_TESTS) break;
    const hits = await git.grep(sha, sym, {
      word: true,
      fixed: true,
      maxCount: 200,
    });
    for (const h of hits) if (testSet.has(h.path)) push(h.path);
  }
  return out;
}

/** Compact directory listing at sha, at most maxTokens (estimateTokens). */
export async function repoMap(
  git: Git,
  sha: string,
  maxTokens: number,
): Promise<string> {
  if (maxTokens <= 0) return "";
  const paths = (await git.lsTree(sha)).filter((p) => {
    const c = classifyFile(p);
    return c !== "vendored" && c !== "binary" && c !== "generated";
  });
  const byDir = new Map<string, string[]>();
  for (const p of paths.sort()) {
    const d = dirOf(p);
    const list = byDir.get(d) ?? [];
    list.push(p.slice(p.lastIndexOf("/") + 1));
    byDir.set(d, list);
  }
  const lines: string[] = [];
  for (const [d, files] of [...byDir.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const label = d === "" ? "./" : `${d}/`;
    const shown =
      files.length > 30
        ? `${files.length} files: ${files.slice(0, 10).join(", ")}, ...`
        : files.join(", ");
    lines.push(`${label} ${shown}`);
  }
  const out: string[] = [];
  let shownPaths = 0;
  for (let i = 0; i < lines.length; i++) {
    const remaining = lines.length - i - 1;
    const trailer =
      remaining > 0 ? `\n(... ${remaining} more folders not shown)` : "";
    const candidate = [...out, lines[i]!].join("\n") + trailer;
    if (estimateTokens(candidate) > maxTokens) break;
    out.push(lines[i]!);
    shownPaths++;
  }
  const hidden = lines.length - shownPaths;
  if (hidden > 0) {
    const trailer = `(... ${hidden} more folders not shown)`;
    while (
      out.length &&
      estimateTokens([...out, trailer].join("\n")) > maxTokens
    )
      out.pop();
    if (estimateTokens([...out, trailer].join("\n")) <= maxTokens)
      out.push(trailer);
  }
  return out.join("\n");
}

/** Spans not nested inside another span (top-level functions and classes). */
function topLevelSpans(source: string, path: string): FunctionSpan[] {
  const spans = allSpans(source, path);
  return spans.filter((s) => !spans.some((o) => o !== s && o.startLine <= s.startLine && s.endLine <= o.endLine && (o.startLine !== s.startLine || o.endLine !== s.endLine)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function numbered(source: string, start: number, end: number): string {
  const lines = source.split("\n");
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end && n <= lines.length; n++)
    out.push(`${String(n).padStart(width)}  ${lines[n - 1]}`);
  return out.join("\n");
}

function lineCount(source: string): number {
  if (source === "") return 0;
  return source.endsWith("\n")
    ? source.split("\n").length - 1
    : source.split("\n").length;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface Candidate {
  kind: ContextKind;
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  /** Unredacted text; redacted when added. */
  text: string;
}

export async function buildContext(
  git: Git,
  patch: PatchSet,
  opts: ContextOptions,
): Promise<ContextBundle> {
  const sha = patch.headSha;
  const items: ContextItem[] = [];
  const notRead: NotRead[] = patch.excluded.map((e) => ({ ...e }));
  let tokensUsed = 0;

  const offer = (c: Candidate): void => {
    const text = redact(c.text).text;
    const tokens = estimateTokens(text);
    if (tokensUsed + tokens > opts.tokenBudget) {
      const range =
        c.startLine !== undefined ? `lines ${c.startLine}-${c.endLine}` : "";
      const detail = [
        range,
        c.symbol ? `symbol ${c.symbol}` : "",
        `${tokens} tokens`,
      ]
        .filter(Boolean)
        .join(", ");
      notRead.push({ kind: c.kind, path: c.path, reason: "budget", detail });
      return;
    }
    tokensUsed += tokens;
    const item: ContextItem = { kind: c.kind, path: c.path, text, tokens };
    if (c.startLine !== undefined) item.startLine = c.startLine;
    if (c.endLine !== undefined) item.endLine = c.endLine;
    if (c.symbol !== undefined) item.symbol = c.symbol;
    items.push(item);
  };

  // Ranges already queued, per path, so a caller inside a changed function is not repeated.
  const covered = new Map<string, [number, number][]>();
  const isCovered = (path: string, s: number, e: number): boolean =>
    (covered.get(path) ?? []).some(([a, b]) => a <= s && e <= b);
  const cover = (path: string, s: number, e: number): void => {
    const list = covered.get(path) ?? [];
    list.push([s, e]);
    covered.set(path, list);
  };

  const sources = new Map<string, string | null>();
  const read = async (path: string): Promise<string | null> => {
    if (!sources.has(path)) sources.set(path, await git.show(sha, path));
    return sources.get(path) ?? null;
  };

  const included = patch.files.filter((f) => !isExcludedFile(f));

  // (1) Changed hunks.
  for (const f of included) {
    offer({
      kind: "hunks",
      path: f.newPath ?? f.oldPath ?? "",
      text: renderNumbered(f),
    });
  }

  // (2) Full changed functions.
  const changed: { path: string; span: FunctionSpan; source: string }[] = [];
  for (const f of included) {
    if (!f.newPath || f.hunks.length === 0) continue;
    if (f.fileClass !== "source" && f.fileClass !== "test") continue;
    const source = await read(f.newPath);
    if (source === null) {
      notRead.push({
        kind: "changed-function",
        path: f.newPath,
        reason: "unreadable",
      });
      continue;
    }
    if (f.status === "added") {
      // The hunk already shows the whole new file: no function items, but its
      // top-level symbols still pull in callers.
      const total = lineCount(source);
      cover(f.newPath, 1, total);
      for (const span of topLevelSpans(source, f.newPath)) changed.push({ path: f.newPath, span, source });
      continue;
    }
    for (const span of changedFunctions(source, f.newPath, f.hunks)) {
      changed.push({ path: f.newPath, span, source });
      cover(f.newPath, span.startLine, span.endLine);
      const label = span.name
        ? `Changed function ${span.name}`
        : "Changed lines";
      const c: Candidate = {
        kind: "changed-function",
        path: f.newPath,
        startLine: span.startLine,
        endLine: span.endLine,
        text: `${label} in ${f.newPath}, lines ${span.startLine}-${span.endLine} (head):\n${numbered(source, span.startLine, span.endLine)}`,
      };
      if (span.name) c.symbol = span.name;
      offer(c);
    }
  }

  // (3) Callers and callees of changed symbols.
  const allSymbols: string[] = [];
  const sliceAround = async (
    path: string,
    line: number,
  ): Promise<{ source: string; start: number; end: number } | null> => {
    const source = await read(path);
    if (source === null) return null;
    const hunk = {
      oldStart: line,
      oldCount: 0,
      newStart: line,
      newCount: 1,
      header: "",
      lines: [{ kind: "add" as const, newLine: line, text: "" }],
    };
    const spans = changedFunctions(source, path, [hunk]);
    let start = spans[0]?.startLine ?? Math.max(1, line - SLICE_WINDOW);
    let end =
      spans[0]?.endLine ?? Math.min(lineCount(source), line + SLICE_WINDOW);
    if (end - start + 1 > MAX_SLICE_LINES) {
      start = Math.max(1, line - SLICE_WINDOW);
      end = Math.min(lineCount(source), line + SLICE_WINDOW);
    }
    return { source, start, end };
  };

  if (tokensUsed >= opts.tokenBudget && changed.length > 0) {
    // Nothing more can fit; do not spend git calls building items that will be dropped.
    notRead.push({ kind: "caller", path: ".", reason: "budget", detail: "callers, callees and related tests skipped: budget spent" });
    changed.length = 0;
  }
  for (const { path, span, source } of changed) {
    const symbols = symbolsDefinedIn(span, source, path).filter((s) => !allSymbols.includes(s));
    for (const sym of symbols) {
      if (allSymbols.length >= MAX_CALLER_SYMBOLS) break;
      allSymbols.push(sym);
      const hits = await findCallers(git, sha, sym, opts.maxCallersPerSymbol);
      for (const h of hits) {
        const slice = await sliceAround(h.path, h.line);
        if (!slice) {
          notRead.push({
            kind: "caller",
            path: h.path,
            reason: "unreadable",
            detail: `symbol ${sym}`,
          });
          continue;
        }
        if (isCovered(h.path, slice.start, slice.end)) continue;
        cover(h.path, slice.start, slice.end);
        offer({
          kind: "caller",
          path: h.path,
          startLine: slice.start,
          endLine: slice.end,
          symbol: sym,
          text: `Caller of ${sym} in ${h.path}, lines ${slice.start}-${slice.end} (call at line ${h.line}):\n${numbered(slice.source, slice.start, slice.end)}`,
        });
      }
    }
    let callees = 0;
    for (const callee of calleesOf(span, source, path)) {
      if (callees >= opts.maxCalleesPerSymbol) break;
      const hits = await git.grep(sha, callee, {
        word: true,
        fixed: true,
        maxCount: 30,
      });
      const defs = hits.filter(
        (h) =>
          isDefinitionLine(callee, h.text, h.path) &&
          classifyFile(h.path) !== "vendored",
      );
      const def = defs.find((h) => h.path === path) ?? defs[0];
      if (!def) continue;
      callees++;
      const slice = await sliceAround(def.path, def.line);
      if (!slice) {
        notRead.push({
          kind: "callee",
          path: def.path,
          reason: "unreadable",
          detail: `symbol ${callee}`,
        });
        continue;
      }
      if (isCovered(def.path, slice.start, slice.end)) continue;
      cover(def.path, slice.start, slice.end);
      offer({
        kind: "callee",
        path: def.path,
        startLine: slice.start,
        endLine: slice.end,
        symbol: callee,
        text: `Callee ${callee} defined in ${def.path}, lines ${slice.start}-${slice.end}:\n${numbered(slice.source, slice.start, slice.end)}`,
      });
    }
  }

  // (4) Related tests, whole files.
  const changedPaths = included
    .map((f) => f.newPath)
    .filter((p): p is string => p !== null);
  const tests = tokensUsed >= opts.tokenBudget ? [] : await relatedTests(git, sha, changedPaths, allSymbols);
  for (const t of tests) {
    const source = await read(t);
    if (source === null) {
      notRead.push({ kind: "test", path: t, reason: "unreadable" });
      continue;
    }
    const end = lineCount(source);
    offer({
      kind: "test",
      path: t,
      startLine: 1,
      endLine: end,
      text: `Related test ${t}, lines 1-${end}:\n${numbered(source, 1, end)}`,
    });
  }

  // (5) Repo map.
  const map = await repoMap(git, sha, opts.repoMapMaxTokens);
  if (map)
    offer({
      kind: "repo-map",
      path: ".",
      text: `Repository map at ${sha.slice(0, 12)}:\n${map}`,
    });

  // (6) LATER: static analysis output.
  if (opts.staticAnalysis)
    offer({ kind: "static-analysis", path: ".", text: opts.staticAnalysis });

  return { items, notRead, tokensUsed, tokenBudget: opts.tokenBudget };
}
