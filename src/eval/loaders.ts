// SPDX-License-Identifier: Apache-2.0
// Case loaders: our JSON sets, replays from git history, and AACR-Bench.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, type Severity } from "../types.js";
import type { Git } from "../diff/index.js";
import type { EvalCase, ExpectedIssue, InjectionGoal } from "./types.js";

const GOALS: InjectionGoal[] = [
  "suppress-finding",
  "force-pass",
  "ping",
  "actions-command",
  "exfiltrate",
];

// ---------------------------------------------------------------------------
// Fake secrets: case files hold placeholders, never secret-shaped strings, so
// no secret scanner trips on the repo. Values are deterministic and fake.
// ---------------------------------------------------------------------------

function fakeChars(seed: string, n: number, alphabet: string): string {
  let out = "";
  let i = 0;
  while (out.length < n) {
    const h = createHash("sha256").update(`${seed}:${i++}`).digest();
    for (const b of h) {
      if (out.length >= n) break;
      out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DASHES = "-".repeat(5);
const PEM_LABEL = ["RSA", "PRIV" + "ATE", "KEY"].join(" ");

export function fakeSecret(kind: string, seed = "sic-eval"): string {
  const s = `${kind}:${seed}`;
  switch (kind) {
    case "github-token":
      return "ghp" + "_" + fakeChars(s, 36, ALNUM);
    case "aws-access-key":
      return "AK" + "IA" + fakeChars(s, 16, UPPER);
    case "aws-secret-key":
      return fakeChars(s, 40, ALNUM + "/+");
    case "anthropic-key":
      return "sk-" + "ant-api03-" + fakeChars(s, 40, ALNUM);
    case "openai-key":
      return "sk-" + "proj-" + fakeChars(s, 40, ALNUM);
    case "slack-token":
      return (
        "xo" +
        "xb-" +
        fakeChars(s, 12, "0123456789") +
        "-" +
        fakeChars(s + "b", 24, ALNUM)
      );
    case "pem-private-key":
      return `${DASHES}BEGIN ${PEM_LABEL}${DASHES}\\n${fakeChars(s, 64, ALNUM)}\\n${DASHES}END ${PEM_LABEL}${DASHES}`;
    default:
      throw new Error(`unknown fake secret kind: ${kind}`);
  }
}

/** Expands {{FAKE:<kind>}} placeholders. */
export function expandPlaceholders(text: string): string {
  return text.replace(/\{\{FAKE:([a-z-]+)\}\}/g, (_m, kind: string) =>
    fakeSecret(kind),
  );
}

// ---------------------------------------------------------------------------
// JSON case files
// ---------------------------------------------------------------------------

function str(v: unknown, field: string, where: string): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string"))
    return v.join("\n");
  throw new Error(`${where}: "${field}" must be a string or an array of lines`);
}

function parseExpected(v: unknown, where: string): ExpectedIssue[] {
  if (!Array.isArray(v))
    throw new Error(`${where}: "expected" must be an array`);
  return v.map((e, i) => {
    const w = `${where} expected[${i}]`;
    if (typeof e !== "object" || e === null)
      throw new Error(`${w}: not an object`);
    const o = e as Record<string, unknown>;
    if (typeof o.file !== "string" || !Number.isInteger(o.startLine))
      throw new Error(`${w}: needs file and startLine`);
    const startLine = o.startLine as number;
    const endLine = Number.isInteger(o.endLine)
      ? (o.endLine as number)
      : startLine;
    if (endLine < startLine) throw new Error(`${w}: endLine < startLine`);
    const out: ExpectedIssue = {
      file: o.file,
      startLine,
      endLine,
      note: typeof o.note === "string" ? o.note : "",
    };
    if (o.severity !== undefined) {
      if (!SEVERITIES.includes(o.severity as Severity))
        throw new Error(`${w}: bad severity`);
      out.severity = o.severity as Severity;
    }
    return out;
  });
}

/**
 * One case from its JSON form. `diff`, `body` and each `files` value may be a
 * string or an array of lines. {{FAKE:<kind>}} placeholders are expanded.
 */
export function parseCase(
  raw: unknown,
  kind: EvalCase["kind"],
  where: string,
): EvalCase {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where}: case is not an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id)
    throw new Error(`${where}: missing id`);
  const w = `${where} (${o.id})`;
  const filesRaw = (o.files ?? {}) as Record<string, unknown>;
  const files: Record<string, string> = {};
  for (const [p, v] of Object.entries(filesRaw))
    files[p] = expandPlaceholders(str(v, `files.${p}`, w));
  const c: EvalCase = {
    id: o.id,
    kind,
    title: str(o.title ?? "", "title", w),
    body: expandPlaceholders(str(o.body ?? "", "body", w)),
    diff: expandPlaceholders(str(o.diff, "diff", w)),
    files,
    expected: parseExpected(o.expected ?? [], w),
  };
  if (!c.diff.startsWith("diff --git "))
    throw new Error(`${w}: diff must start with "diff --git "`);
  if (!c.diff.endsWith("\n")) c.diff += "\n";
  if (o.injection !== undefined) {
    const inj = o.injection as Record<string, unknown>;
    if (!GOALS.includes(inj.goal as InjectionGoal))
      throw new Error(`${w}: bad injection goal`);
    c.injection = {
      goal: inj.goal as InjectionGoal,
      payload: expandPlaceholders(str(inj.payload, "injection.payload", w)),
    };
  }
  if (kind === "injection" && !c.injection)
    throw new Error(`${w}: injection case without "injection"`);
  return c;
}

function loadDir(dir: string, kind: EvalCase["kind"]): EvalCase[] {
  const out: EvalCase[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const path = join(dir, name);
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    for (const [i, r] of (Array.isArray(raw) ? raw : [raw]).entries())
      out.push(parseCase(r, kind, `${name}[${i}]`));
  }
  const ids = new Set<string>();
  for (const c of out) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id} in ${dir}`);
    ids.add(c.id);
  }
  return out;
}

export function loadInjectionSet(dir: string): EvalCase[] {
  return loadDir(dir, "injection");
}
export function loadPlantedSet(dir: string): EvalCase[] {
  return loadDir(dir, "planted");
}

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------

function changedPaths(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] as string);
}

async function headFiles(
  git: Git,
  sha: string,
  diff: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const p of changedPaths(diff)) {
    const t = await git.show(sha, p);
    if (t !== null) files[p] = t;
  }
  return files;
}

/**
 * Replays from a local clone that has `pr-<n>-base` and `pr-<n>-head` refs
 * (fetched by the person running the eval, e.g.
 * `git fetch origin pull/<n>/head:pr-<n>-head`). Replay cases start with no
 * expected issues; labels are added by hand from the PR's review history.
 */
export async function loadReplay(
  git: Git,
  repo: string,
  prNumbers: number[],
): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  for (const n of prNumbers) {
    const head = `pr-${n}-head`;
    const mb = await git.mergeBase(`pr-${n}-base`, head);
    const diff = await git.diff(mb, head);
    out.push({
      id: `replay:${repo}#${n}`,
      kind: "replay",
      title: `${repo}#${n}`,
      body: "",
      diff,
      files: await headFiles(git, head, diff),
      expected: [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AACR-Bench (Alibaba-Aone/aacr-bench on Hugging Face, Apache-2.0)
//
// Format read from the dataset viewer on 2026-11-25 (open item C4): one record
// per annotated review comment, as a JSON array or JSONL, with fields
// project_main_language, pr_url, pr_source_commit, pr_target_commit,
// pr_change_line_count, pr_category, is_ai_comment, note, path, side,
// source_model, from_line, to_line, category, context, label. There is no diff
// and no severity: the diff comes from git (merge-base of target and source ..
// source), and AACR issues carry no severity, so expected issues have none.
// Rows with label !== 1 or a side other than "right" are skipped.
// ---------------------------------------------------------------------------

export interface AacrRecord {
  project_main_language?: string;
  pr_url: string;
  pr_source_commit: string;
  pr_target_commit: string;
  pr_category?: string;
  note: string;
  path: string;
  side?: string;
  from_line: number;
  to_line: number;
  category?: string;
  context?: string;
  label?: number;
}

export interface AacrEntry {
  case: EvalCase;
  prUrl: string;
  sourceCommit: string;
  targetCommit: string;
  language: string | null;
}

function readRecords(path: string): unknown[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return JSON.parse(text) as unknown[];
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        throw new Error(`${path}: line ${i + 1} is not JSON`);
      }
    });
}

function isRecord(v: unknown): v is AacrRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.pr_url === "string" &&
    typeof o.pr_source_commit === "string" &&
    typeof o.pr_target_commit === "string" &&
    typeof o.path === "string" &&
    typeof o.note === "string" &&
    Number.isInteger(o.from_line) &&
    Number.isInteger(o.to_line)
  );
}

/** Groups AACR rows into one case per PR, keeping at most `limit` PRs. */
export function parseAacrRecords(rows: unknown[], limit?: number): AacrEntry[] {
  const byPr = new Map<string, AacrEntry>();
  for (const [i, row] of rows.entries()) {
    if (!isRecord(row))
      throw new Error(`AACR row ${i}: missing a required field`);
    if (row.label !== undefined && row.label !== 1) continue;
    if (row.side !== undefined && row.side.toLowerCase() !== "right") continue;
    let e = byPr.get(row.pr_url);
    if (!e) {
      if (limit !== undefined && byPr.size >= limit) continue;
      const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(row.pr_url);
      const id = m ? `aacr:${m[1]}#${m[2]}` : `aacr:${row.pr_url}`;
      e = {
        case: {
          id,
          kind: "aacr",
          title: id,
          body: row.pr_category ?? "",
          diff: "",
          files: {},
          expected: [],
        },
        prUrl: row.pr_url,
        sourceCommit: row.pr_source_commit,
        targetCommit: row.pr_target_commit,
        language: row.project_main_language ?? null,
      };
      byPr.set(row.pr_url, e);
    }
    const from = Math.min(row.from_line, row.to_line);
    const to = Math.max(row.from_line, row.to_line);
    e.case.expected.push({
      file: row.path,
      startLine: from,
      endLine: to,
      note: `${row.category ?? "issue"}: ${row.note.slice(0, 200)}`,
    });
  }
  return [...byPr.values()];
}

/** Reads a local copy of AACR-Bench (JSON array or JSONL). Cases have no diff until hydrated. */
export function loadAacrBench(path: string, limit?: number): EvalCase[] {
  return parseAacrRecords(readRecords(path), limit).map((e) => e.case);
}

export function loadAacrBenchEntries(
  path: string,
  limit?: number,
): AacrEntry[] {
  return parseAacrRecords(readRecords(path), limit);
}

/** Fills diff and head-side files from a local clone of the PR's repository. */
export async function hydrateAacr(
  git: Git,
  entry: AacrEntry,
): Promise<EvalCase> {
  const mb = await git.mergeBase(entry.targetCommit, entry.sourceCommit);
  const diff = await git.diff(mb, entry.sourceCommit);
  return {
    ...entry.case,
    diff,
    files: await headFiles(git, entry.sourceCommit, diff),
  };
}
