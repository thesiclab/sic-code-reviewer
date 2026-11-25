// SPDX-License-Identifier: Apache-2.0
// Function boundaries and symbol extraction by language heuristics, with no
// parser dependency: brace matching for C-family / JS / TS / Go / Rust / Java,
// indentation for Python. Strings and comments are masked out first so braces
// and names inside them do not count. Unknown languages fall back to the
// changed lines plus 20 lines either side.
import type { Hunk } from "../types.js";

export interface FunctionSpan {
  name: string;
  startLine: number;
  endLine: number;
}

export type LangKind = "brace" | "indent" | "unknown";

const BRACE_EXT = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "hxx",
  "cs",
  "php",
  "dart",
  "groovy",
  "sol",
  "zig",
]);
const INDENT_EXT = new Set(["py", "pyi"]);
/** Languages where '...' is a string, not a char literal / lifetime. */
const SQUOTE_STRING_EXT = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "php",
  "dart",
  "py",
  "pyi",
  "groovy",
  "sol",
]);

export const UNKNOWN_WINDOW = 20;

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
}

export function languageOf(path: string): LangKind {
  const e = ext(path);
  if (BRACE_EXT.has(e)) return "brace";
  if (INDENT_EXT.has(e)) return "indent";
  return "unknown";
}

/**
 * Same length as source, newlines kept, with comment text and string contents
 * replaced by spaces. Quote characters are kept so a blanked string still
 * reads as an argument.
 */
export function maskSource(source: string, path: string): string {
  const lang = languageOf(path);
  const e = ext(path);
  const out = source.split("");
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    const c2 = source[i + 1];
    if (lang === "indent") {
      if (c === "#") {
        const end = source.indexOf("\n", i);
        const stop = end < 0 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if ((c === '"' || c === "'") && source.startsWith(c.repeat(3), i)) {
        const close = source.indexOf(c.repeat(3), i + 3);
        const stop = close < 0 ? n : close + 3;
        blank(i + 3, stop - 3);
        i = stop;
        continue;
      }
    } else {
      if (c === "/" && c2 === "/") {
        const end = source.indexOf("\n", i);
        const stop = end < 0 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === "/" && c2 === "*") {
        const close = source.indexOf("*/", i + 2);
        const stop = close < 0 ? n : close + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === "#" && e === "php") {
        const end = source.indexOf("\n", i);
        const stop = end < 0 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === '"' || c === "`" || (c === "'" && SQUOTE_STRING_EXT.has(e))) {
      // String to the matching quote; plain quotes stop at end of line.
      let j = i + 1;
      while (j < n) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) break;
        if (d === "\n" && c !== "`") break;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = j < n && source[j] === c ? j + 1 : j;
      continue;
    }
    if (c === "'") {
      // Char literal only when it closes right away ('a', '\n', '\u{1F600}'); otherwise a lifetime or apostrophe.
      const m = /^'(?:\\[^']{1,10}|[^'\\\n])'/.exec(source.slice(i, i + 14));
      if (m) {
        blank(i + 1, i + m[0].length - 1);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

const ID = "[A-Za-z_$][\\w$]*";
const MODS =
  "(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|readonly|synchronized|native|extern|inline|constexpr|unsafe|open|suspend|const|pub(?:\\([^)]*\\))?|declare)\\s+)*";

const DECL_RES: RegExp[] = [
  new RegExp(`^\\s*${MODS}function\\s*\\*?\\s*(${ID})`),
  new RegExp(
    `^\\s*${MODS}(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]*)?=>|${ID}\\s*=>|\\(\\s*$)`,
  ),
  new RegExp(
    `^\\s*${MODS}(?:class|interface|enum|struct|trait|object|union)\\s+(${ID})`,
  ),
  new RegExp(`^\\s*${MODS}impl(?:\\s*<[^>]*>)?\\s+(${ID})`),
  new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?(${ID})`),
  new RegExp(
    `^\\s*${MODS}(?:extern\\s+"[^"]*"\\s+)?(?:fn|fun|func)\\s+(?:<[^>]*>\\s*)?(?:${ID}\\.)?(${ID})`,
  ),
  new RegExp(`^\\s*type\\s+(${ID})\\s+(?:struct|interface)\\b`),
];

/** A method / C-style function header: `name(...)` with only types and modifiers before it. */
const METHOD_RE = new RegExp(
  `^\\s*${MODS}(?:(?:get|set)\\s+)?(?:[\\w$.<>\\[\\],:*&?]+\\s+)*?(~?${ID})\\s*(?:<[^>]*>)?\\s*\\(([^;]*)$`,
);

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "new",
  "else",
  "do",
  "try",
  "typeof",
  "instanceof",
  "sizeof",
  "alignof",
  "decltype",
  "await",
  "yield",
  "throw",
  "with",
  "delete",
  "void",
  "case",
  "in",
  "of",
  "elif",
  "except",
  "lambda",
  "assert",
  "not",
  "and",
  "or",
  "is",
  "match",
  "loop",
  "defer",
  "go",
  "select",
  "foreach",
  "using",
  "lock",
  "fixed",
  "unless",
  "until",
  "super",
  "this",
  "self",
  "print",
  "import",
  "require",
  "from",
  "export",
  "default",
  "async",
  "class",
  "def",
  "fn",
  "func",
  "fun",
]);

function methodName(line: string): string | null {
  const m = METHOD_RE.exec(line);
  if (!m) return null;
  const name = m[1]!.replace(/^~/, "");
  if (KEYWORDS.has(name)) return null;
  const rest = m[2]!;
  if (rest.includes("=>")) return null;
  // After the parameter list only a return type / throws clause and an optional '{' may follow.
  const close = rest.lastIndexOf(")");
  if (close >= 0) {
    const tail = rest.slice(close + 1).trim();
    if (
      tail !== "" &&
      !/^(?::\s*[^{=]+|->\s*[^{=]+|throws\s+[\w.,\s<>]+|const|noexcept|override|final|where\b[^{]*)?\s*\{?\s*$/.test(
        tail,
      )
    )
      return null;
  } else if (!/[,(]\s*$/.test(rest) && rest.trim() !== "") {
    return null;
  }
  return name;
}

export function declarationName(
  maskedLine: string,
  lang: LangKind,
): string | null {
  if (lang === "indent") {
    const m =
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)|^\s*class\s+([A-Za-z_]\w*)/.exec(
        maskedLine,
      );
    return m ? (m[1] ?? m[2] ?? null) : null;
  }
  if (lang !== "brace") return null;
  for (const re of DECL_RES) {
    const m = re.exec(maskedLine);
    if (m?.[1] && !KEYWORDS.has(m[1])) return m[1];
  }
  return methodName(maskedLine);
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

/** Line index (0-based) of the brace closing the first '{' at or after line `from`; null when none. */
function braceSpan(lines: string[], from: number): number | null {
  let paren = 0;
  let depth = 0;
  let opened = false;
  const limit = Math.min(lines.length, from + 12);
  for (let li = from; li < lines.length; li++) {
    if (!opened && li >= limit) return null;
    for (const ch of lines[li]!) {
      if (!opened) {
        if (ch === "(") paren++;
        else if (ch === ")") paren = Math.max(0, paren - 1);
        else if (ch === ";" && paren === 0) return null;
        else if (ch === "{") {
          opened = true;
          depth = 1;
        }
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return li;
      }
    }
  }
  return opened ? lines.length - 1 : null;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 8 - (n % 8);
    else break;
  }
  return n;
}

function indentSpanEnd(lines: string[], from: number): number {
  const declIndent = indentOf(lines[from]!);
  // Signature end: paren depth back to 0 on a line ending with ':'.
  let paren = 0;
  let sigEnd = from;
  for (let li = from; li < lines.length; li++) {
    for (const ch of lines[li]!) {
      if ("([{".includes(ch)) paren++;
      else if (")]}".includes(ch)) paren = Math.max(0, paren - 1);
    }
    sigEnd = li;
    if (paren === 0 && /:\s*$/.test(lines[li]!)) break;
    if (li - from > 30) break;
  }
  let end = sigEnd;
  for (let li = sigEnd + 1; li < lines.length; li++) {
    const l = lines[li]!;
    if (l.trim() === "") continue;
    if (indentOf(l) <= declIndent) break;
    end = li;
  }
  return end;
}

/** Every function/class span in the file, 1-based inclusive lines. */
export function allSpans(source: string, path: string): FunctionSpan[] {
  const lang = languageOf(path);
  if (lang === "unknown") return [];
  const lines = maskSource(source, path).split("\n");
  const spans: FunctionSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = declarationName(lines[i]!, lang);
    if (!name) continue;
    if (lang === "brace") {
      const end = braceSpan(lines, i);
      if (end === null) continue;
      spans.push({ name, startLine: i + 1, endLine: end + 1 });
    } else {
      let start = i;
      const ind = indentOf(lines[i]!);
      while (
        start > 0 &&
        /^\s*@/.test(lines[start - 1]!) &&
        indentOf(lines[start - 1]!) === ind
      )
        start--;
      spans.push({
        name,
        startLine: start + 1,
        endLine: indentSpanEnd(lines, i) + 1,
      });
    }
  }
  return spans;
}

/** New-side lines a hunk touches: added lines, plus the position of each pure deletion. */
export function touchedLines(hunks: Hunk[]): number[] {
  const out = new Set<number>();
  for (const h of hunks) {
    let cursor = h.newStart;
    let pendingDel = false;
    for (const l of h.lines) {
      if (l.kind === "add") {
        out.add(l.newLine!);
        cursor = l.newLine! + 1;
        pendingDel = false;
      } else if (l.kind === "ctx") {
        if (pendingDel) out.add(l.newLine!);
        cursor = l.newLine! + 1;
        pendingDel = false;
      } else {
        pendingDel = true;
        // The deletion sits between cursor-1 and cursor; mark the line before it too.
        if (cursor > 1) out.add(cursor - 1);
      }
    }
    if (pendingDel) out.add(Math.max(1, cursor - 1));
  }
  return [...out].filter((n) => n > 0).sort((a, b) => a - b);
}

export function changedFunctions(
  source: string,
  path: string,
  hunks: Hunk[],
): FunctionSpan[] {
  if (source === "") return [];
  const total = source.endsWith("\n")
    ? source.split("\n").length - 1
    : source.split("\n").length;
  const spans = allSpans(source, path);
  const picked = new Map<string, FunctionSpan>();
  const uncovered: number[] = [];
  for (const line of touchedLines(hunks)) {
    if (line > total) continue;
    let best: FunctionSpan | null = null;
    for (const s of spans) {
      if (
        s.startLine <= line &&
        line <= s.endLine &&
        (!best || s.endLine - s.startLine < best.endLine - best.startLine)
      )
        best = s;
    }
    if (best) picked.set(`${best.startLine}:${best.endLine}`, best);
    else uncovered.push(line);
  }
  // Fallback windows: changed lines +/- 20, merged when they overlap.
  const windows: FunctionSpan[] = [];
  for (const line of uncovered) {
    const start = Math.max(1, line - UNKNOWN_WINDOW);
    const end = Math.min(total, line + UNKNOWN_WINDOW);
    const last = windows[windows.length - 1];
    if (last && start <= last.endLine + 1)
      last.endLine = Math.max(last.endLine, end);
    else windows.push({ name: "", startLine: start, endLine: end });
  }
  // Drop windows wholly inside a picked span.
  const result = [...picked.values()];
  for (const w of windows) {
    if (
      !result.some((s) => s.startLine <= w.startLine && w.endLine <= s.endLine)
    )
      result.push(w);
  }
  return result.sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
  );
}

const SYMBOL_STOP = new Set([
  "constructor",
  "__init__",
  "__new__",
  "__call__",
  "init",
  "main",
  "new",
  "toString",
  "setUp",
  "tearDown",
  "render",
]);
const MIN_SYMBOL = 3;

export function symbolsDefinedIn(
  span: FunctionSpan,
  source: string,
  path: string,
): string[] {
  const lang = languageOf(path);
  const lines = maskSource(source, path).split("\n");
  const out: string[] = [];
  const push = (s: string): void => {
    if (s.length >= MIN_SYMBOL && !SYMBOL_STOP.has(s) && !out.includes(s))
      out.push(s);
  };
  if (span.name) push(span.name);
  for (let i = span.startLine - 1; i < span.endLine && i < lines.length; i++) {
    const n = declarationName(lines[i]!, lang);
    if (n) push(n);
  }
  return out;
}

const NOT_CALLEES = new Set([
  ...KEYWORDS,
  // Python builtins
  "len",
  "range",
  "str",
  "int",
  "float",
  "bool",
  "list",
  "dict",
  "set",
  "tuple",
  "isinstance",
  "issubclass",
  "open",
  "getattr",
  "setattr",
  "hasattr",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "reversed",
  "min",
  "max",
  "sum",
  "any",
  "all",
  "repr",
  "type",
  "id",
  "iter",
  "next",
  "abs",
  "round",
  "format",
  "vars",
  "dir",
  "bytes",
  "object",
  "staticmethod",
  "classmethod",
  "property",
  // JS / TS globals and very common methods
  "parseInt",
  "parseFloat",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Symbol",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "push",
  "pop",
  "shift",
  "unshift",
  "forEach",
  "reduce",
  "join",
  "split",
  "slice",
  "splice",
  "includes",
  "indexOf",
  "keys",
  "values",
  "entries",
  "then",
  "finally",
  "toString",
  "trim",
  "replace",
  "test",
  "exec",
  "has",
  "get",
  "add",
  "apply",
  "call",
  "bind",
  "assign",
  "resolve",
  "reject",
  "stringify",
  "parse",
  "from",
  "isArray",
  "concat",
  "some",
  "every",
  "find",
  "sort",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
  "append",
  "extend",
  "items",
  // Go / Rust / C
  "make",
  "cap",
  "panic",
  "recover",
  "copy",
  "close",
  "println",
  "printf",
  "sprintf",
  "fprintf",
  "malloc",
  "free",
  "unwrap",
  "expect",
  "clone",
  "into",
  "iter",
  "collect",
  "Some",
  "None",
  "Ok",
  "Err",
  "vec",
]);

export function calleesOf(
  span: FunctionSpan,
  source: string,
  path: string,
): string[] {
  const lines = maskSource(source, path).split("\n");
  const defined = new Set(symbolsDefinedIn(span, source, path));
  if (span.name) defined.add(span.name);
  const out: string[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*(?:<[\w$.,\s<>[\]]*>)?\s*\(/g;
  for (let i = span.startLine - 1; i < span.endLine && i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(re)) {
      const name = m[1]!;
      if (
        name.length < MIN_SYMBOL ||
        NOT_CALLEES.has(name) ||
        defined.has(name) ||
        out.includes(name)
      )
        continue;
      // Skip declarations: `function name(`, `def name(`, `fn name(`.
      const before = line.slice(0, m.index).trimEnd();
      if (/(?:^|\s)(?:function\*?|def|fn|fun|func|class)$/.test(before))
        continue;
      out.push(name);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this grep hit line define `name` (rather than use it)? */
export function isDefinitionLine(
  name: string,
  text: string,
  path: string,
): boolean {
  const n = escapeRe(name);
  const b = "(?<![\\w$])";
  const a = "(?![\\w$])";
  const res = [
    new RegExp(
      `${b}(?:function\\s*\\*?\\s*|def\\s+|fn\\s+|fun\\s+|class\\s+|interface\\s+|struct\\s+|enum\\s+|trait\\s+|type\\s+)${n}${a}`,
    ),
    new RegExp(`${b}func\\s+(?:\\([^)]*\\)\\s*)?${n}${a}`),
    new RegExp(`${b}(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=(?!=)`),
    new RegExp(
      `${b}${n}\\s*[:=]\\s*(?:async\\s*)?(?:function${a}|\\([^)]*\\)\\s*(?::[^=]*)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
    ),
  ];
  if (res.some((r) => r.test(text))) return true;
  if (languageOf(path) === "brace") {
    // Method / C function definition: header ending in '{'.
    const m = new RegExp(
      `^\\s*${MODS}(?:(?:get|set)\\s+)?(?:[\\w$.<>\\[\\],:*&?]+\\s+)*?${n}\\s*\\([^;]*\\)[^;={]*\\{\\s*$`,
    ).exec(text);
    if (m) return true;
  }
  return false;
}

const IMPORT_RE =
  /^\s*(?:import\b|from\s+\S+\s+import\b|export\s*\{|export\s+\*|use\s+[\w:]+|#include\b|using\s+[\w.]+;|require\s*\()|^\s*(?:const|let|var)\s+[{\w$,\s}]+=\s*require\s*\(/;

export function isImportLine(text: string): boolean {
  return IMPORT_RE.test(text);
}
