// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived from Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (neutralize_mentions, render_finding_entry) and agent-error.py (sanitize)
// (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: ported to TypeScript; one function for every model-written string
// instead of per-call-site helpers; adds link/image flattening, HTML tag
// escaping (which also covers Comfy's "<!--" defang), removal of control and
// bidi-override characters, line-start-only "::" breaking (Comfy breaks every
// "::" in one-line log values), a length cap and a second redaction pass.
import { redact } from "../prompts/index.js";

const ZWSP = "\u200b";

/** Every character a renderer or a log may treat as a line break; all become "\n". */
const LINE_BREAKS = /\r\n|[\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
/** C0/C1 controls except \n and \t, plus bidi overrides/isolates (Trojan Source). */
// eslint-disable-next-line no-control-regex
const STRIP =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** ![alt](url) and [text](url) become plain "text (url)"; nothing renders as an image or a link label. */
function flattenLinks(text: string): string {
  let prev: string;
  let out = text;
  // Repeat so nested forms ([![x](a)](b)) flatten fully; bounded.
  for (let i = 0; i < 5; i++) {
    prev = out;
    out = out.replace(
      /!?\[([^\[\]\n]*)\]\(\s*<?([^()\s<>]*)>?(?:\s+"[^"\n]*")?\s*\)/g,
      (_m, label: string, url: string) => (url ? `${label} (${url})` : label),
    );
    if (out === prev) break;
  }
  // Whatever the pattern above could not flatten (odd URLs, reference links)
  // is broken: "![" cannot open an image and "](" / "][" cannot close a link
  // label once a space sits between them.
  return out
    .replace(/!\[/g, "! [")
    .replace(/\]\(/g, "] (")
    .replace(/\]\[/g, "] [");
}

/** A line opening with "::" (an Actions workflow command, if ever echoed to a log) is broken. */
function breakCommands(line: string): string {
  let out = line.replace(
    /^(\s*)(:{2,})/,
    (_m, ws: string, colons: string) => ws + colons.split("").join(" "),
  );
  out = out.replace(/#(?=#\[)/g, "# ");
  return out;
}

/**
 * Applied to every model-written string before it reaches GitHub (and the job
 * summary): redaction, line-break normalisation, control removal, link and
 * image flattening, HTML escaping, mention neutralising, Actions-command
 * breaking, length cap.
 */
export function sanitizeModelText(text: string, maxChars: number): string {
  let t = String(text ?? "");
  t = t.replace(LINE_BREAKS, "\n").replace(STRIP, "");
  // Second redaction net (the first runs on everything sent to a provider).
  // Before escaping, so patterns see the raw text.
  t = redact(t).text;
  t = flattenLinks(t);
  // All HTML is escaped, which also defangs "<!--" (so no hidden markers or
  // sentinels can be forged) and autolinks like <https://...>.
  t = t.replace(/&(?=[#A-Za-z0-9]+;)/g, "&amp;").replace(/</g, "&lt;");
  t = t.replace(/@/g, "@" + ZWSP);
  t = t.split("\n").map(breakCommands).join("\n");
  if (maxChars > 0 && t.length > maxChars)
    t = t.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
  return t;
}

/**
 * A finding body inside a blockquote its markdown cannot escape: every line,
 * split on every CommonMark line ending, gets a "> " prefix, so a heading, a
 * rule, a forged row or a fence line stays inside the quote. Callers end the
 * quote with a blank line, which also closes any unterminated code fence.
 */
export function blockquote(text: string): string {
  return String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((ln) => (ln ? `> ${ln}` : ">"))
    .join("\n");
}

/**
 * A code span holding arbitrary one-line text (a path from a model), with a
 * backtick run longer than any inside it, so it cannot close early.
 */
export function codeSpan(text: string, maxChars = 300): string {
  let t = String(text ?? "")
    .replace(LINE_BREAKS, " ")
    .replace(/\n/g, " ")
    .replace(STRIP, "");
  if (t.length > maxChars) t = t.slice(0, maxChars - 1) + "…";
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") || t === "" ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}
