// SPDX-License-Identifier: Apache-2.0 AND MIT
// Delivery logic follows Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (post_or_degrade, post_may_have_landed, write_step_summary) (MIT, Copyright (c)
// 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: rewritten in TypeScript, much smaller: one POST, one body-only retry
// on a rejected anchor (422), a landed-check before the single retry under
// 403/429/5xx/transport errors, job-summary fallback; sets a check run; the
// gate is recomputed here from the findings rather than trusted from the
// artifact; the review renderer and the artifact validator are ours.
import { LENSES_LIST, PLACEMENT_LIST } from "./shapes.js";
import { SEVERITIES } from "../types.js";
import type {
  CheckConclusion,
  FilteredFinding,
  GateReason,
  Placement,
  ReviewResult,
  Severity,
} from "../types.js";
import type { SchemaCheck } from "../models/index.js";
import { decide } from "../gate/index.js";
import {
  renderBodyFindingsSentinel,
  renderFindingMarker,
  renderRoundSentinel,
  type BodyFindingRecord,
} from "../memory/index.js";
import {
  assertRepo,
  isValidRepo,
  createHttpClient,
  DEFAULT_API_URL,
  listAllReviews,
  parseRetryAfter,
} from "../github/index.js";
import { blockquote, codeSpan, sanitizeModelText } from "./sanitize.js";

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export type WriteResult =
  | { ok: true }
  | { ok: false; status?: number; retryAfterS?: number; message: string };

export interface GitHubWriter {
  createReview(
    repo: string,
    pr: number,
    commitSha: string,
    body: string,
    comments: ReviewComment[],
  ): Promise<WriteResult>;
  listReviews(
    repo: string,
    pr: number,
  ): Promise<{ id: number; body: string; commitId: string; author: string }[]>;
  createCheckRun(
    repo: string,
    headSha: string,
    name: string,
    conclusion: CheckConclusion,
    title: string,
    summary: string,
  ): Promise<WriteResult>;
}

export interface PostOptions {
  checkName: string;
  writeSummary: (md: string) => void;
  /** Injected for tests; defaults to a real timer. Waits are capped at 30 s. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_REVIEW_BODY_CHARS = 60_000;
export const MAX_COMMENT_CHARS = 8_000;
const MAX_TITLE = 200;
const MAX_BODY = 3_000;
const MAX_SCENARIO = 1_500;
const MAX_REASON = 1_000;
const MAX_QUOTE = 600;
const MAX_RETRY_WAIT_S = 30;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  nit: "Nit",
};
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};
const REPEAT_URL_RE =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+#discussion_r\d+$/;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function oneLineText(text: string, max: number): string {
  return sanitizeModelText(text, max).replace(/\n+/g, " ").trim();
}

function badge(f: FilteredFinding): string {
  return `**[${SEVERITY_LABEL[f.severity]}]** · ${f.lens}`;
}

/** The quoted part of a finding: body, failure scenario, and verdict detail. Every line inside a blockquote. */
function findingQuote(f: FilteredFinding, withVerdict: boolean): string {
  const parts = [
    sanitizeModelText(f.body, MAX_BODY),
    "",
    `Failure scenario: ${sanitizeModelText(f.failureScenario, MAX_SCENARIO)}`,
  ];
  if (f.repeatOf && REPEAT_URL_RE.test(f.repeatOf))
    parts.push("", `Repeats an answered finding: ${f.repeatOf}`);
  if (withVerdict && f.adversary) {
    parts.push(
      "",
      `Adversary (${f.adversary.verdict}): ${sanitizeModelText(f.adversary.reason, MAX_REASON)}`,
    );
    if (f.adversary.refutingQuote) {
      parts.push(
        `Refuting line: ${sanitizeModelText(f.adversary.refutingQuote, MAX_QUOTE)}`,
      );
    }
  }
  if (withVerdict && f.placement !== "inline" && f.placement !== "body") {
    parts.push(
      "",
      `Placed by code: ${sanitizeModelText(f.placementReason, MAX_REASON)}`,
    );
  }
  return blockquote(parts.join("\n"));
}

function inlineCommentBody(f: FilteredFinding, round: number): string {
  const lines: string[] = [];
  try {
    lines.push(
      renderFindingMarker({ fp: f.fingerprint, round, sev: f.severity }),
    );
  } catch {
    /* an unusual fingerprint only loses the ledger link, never the finding */
  }
  lines.push(
    `${badge(f)} · ${oneLineText(f.title, MAX_TITLE)}`,
    "",
    findingQuote(f, false),
    "",
  );
  const body = lines.join("\n");
  return body.length <= MAX_COMMENT_CHARS
    ? body
    : body.slice(0, MAX_COMMENT_CHARS - 1) + "…";
}

function bodyEntry(f: FilteredFinding): string {
  return [
    `${badge(f)} · ${codeSpan(`${f.file}:${f.line}`)} · ${oneLineText(f.title, MAX_TITLE)}`,
    "",
    findingQuote(f, true),
    "",
  ].join("\n");
}

function bySeverity(a: FilteredFinding, b: FilteredFinding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

function money(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

const CONCLUSION_LABEL: Record<CheckConclusion, string> = {
  success: "Pass",
  failure: "Blocking findings",
  neutral: "Neutral (not a pass)",
};

function isRealSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

interface RenderOptions {
  /** Body-only fallback: inline findings are written into the body too. */
  inlineInBody: boolean;
}

function renderBody(result: ReviewResult, opts: RenderOptions): string {
  const f = result.findings;
  const at = (p: Placement) =>
    f.filter((x) => x.placement === p).sort(bySeverity);
  const inline = at("inline");
  const body = at("body");
  const inBody = opts.inlineInBody
    ? [...inline, ...body].sort(bySeverity)
    : body;

  const head: string[] = [
    `## sic-code-reviewer · ${CONCLUSION_LABEL[result.gate.conclusion]}`,
  ];
  // Sentinels sit at the top so a tail clamp can never cut them.
  if (
    isRealSha(result.headSha) &&
    isRealSha(result.baseSha) &&
    isRealSha(result.mergeBase)
  ) {
    try {
      head.push(
        renderRoundSentinel({
          v: 1,
          round: result.round,
          baseSha: result.baseSha,
          headSha: result.headSha,
          mergeBase: result.mergeBase,
          cacheKey: result.cacheKey,
          conclusion: result.gate.conclusion,
        }),
      );
    } catch {
      /* no sentinel: next round simply has no cache hit and no incremental hint */
    }
  }
  const records: BodyFindingRecord[] = inBody.map((x) => ({
    fp: x.fingerprint,
    file: x.file,
    line: x.line,
    sev: x.severity,
    title: x.title,
  }));
  const bodySentinel = renderBodyFindingsSentinel(records);
  if (bodySentinel) head.push(bodySentinel);

  const out: string[] = [head.join("\n"), ""];
  out.push(`**Verdict:** ${sanitizeModelText(result.gate.summary, 500)}`, "");

  const single = result.gate.reasons.find((r) => r.kind === "single-family");
  if (single && single.kind === "single-family") {
    out.push(
      `> Warning: single family (${codeSpan(single.family, 60)}). This is one model family checking itself, not a duo verdict.`,
      "",
    );
  }
  const cached = result.gate.reasons.find((r) => r.kind === "cached");
  if (cached)
    out.push(
      "Same input as an earlier round; the earlier verdict was re-used.",
      "",
    );

  const cov = result.coverage;
  out.push(
    `- **Coverage:** ${cov.filesRead} of ${cov.filesInDiff} changed files read; ${cov.tokensUsed} of ${cov.tokenBudget} context tokens.`,
  );
  out.push(
    `- **Reviewer:** ${codeSpan(result.reviewer.model, 100)} (${codeSpan(result.reviewer.family, 40)}). **Adversary:** ${
      result.adversary
        ? `${codeSpan(result.adversary.model, 100)} (${codeSpan(result.adversary.family, 40)})`
        : "none"
    }.`,
  );
  out.push(
    `- **Providers that saw the code:** ${
      result.providersSawCode.length
        ? result.providersSawCode.map((p) => codeSpan(p, 100)).join(", ")
        : "none"
    }.`,
  );
  out.push(
    `- **Cost:** ${money(result.cost.spentUsd)} spent (estimate ${money(result.cost.estimateUsd)}, cap ${money(result.cost.capUsd)}).`,
  );
  if (!opts.inlineInBody && inline.length)
    out.push(`- **Inline comments:** ${inline.length}.`);
  if (opts.inlineInBody && inline.length) {
    out.push(
      `- Inline comments could not be placed; all ${inline.length} are listed below.`,
    );
  }
  out.push("");

  const section = (title: string, items: FilteredFinding[]) => {
    if (items.length === 0) return;
    out.push(`### ${title}`, "");
    for (const x of items) out.push(bodyEntry(x));
  };
  section(
    opts.inlineInBody
      ? "Findings"
      : "Findings outside the diff (posted here; critical/high still block)",
    inBody,
  );
  section(
    "Pre-existing issues (not introduced here; never block)",
    at("pre-existing"),
  );
  section(
    "Disputed (contested without a verified quote; never block)",
    at("disputed"),
  );
  section("Dismissed by the adversary (never block)", at("dismissed"));

  if (result.notRead.length) {
    out.push("### Not read", "");
    for (const n of result.notRead.slice(0, 200)) {
      const detail = n.detail ? ` (${oneLineText(n.detail, 200)})` : "";
      out.push(`- ${codeSpan(n.path)} (${n.kind}): ${n.reason}${detail}`);
    }
    if (result.notRead.length > 200)
      out.push(`- …and ${result.notRead.length - 200} more.`);
    out.push("");
  }
  const red = result.redactions.filter((r) => r.count > 0);
  if (red.length) {
    out.push(
      `Redacted before sending to models: ${red.map((r) => `${codeSpan(r.kind, 60)} × ${r.count}`).join(", ")}.`,
      "",
    );
  }
  const dropped = result.counts.dropped ?? 0;
  if (dropped > 0)
    out.push(
      `${dropped} finding(s) failed the proof or repeat rules and were not posted.`,
      "",
    );

  return clampBody(out.join("\n"));
}

const CLAMP_NOTE =
  "\n\n_Cut to fit GitHub's size limit; the full text is in the job summary._\n";

export function clampBody(body: string, limit = MAX_REVIEW_BODY_CHARS): string {
  if (body.length <= limit) return body;
  return body.slice(0, limit - CLAMP_NOTE.length).trimEnd() + CLAMP_NOTE;
}

export function renderReview(result: ReviewResult): {
  body: string;
  comments: ReviewComment[];
} {
  const comments = result.findings
    .filter((f) => f.placement === "inline")
    .sort(bySeverity)
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT" as const,
      body: inlineCommentBody(f, result.round),
    }));
  return { body: renderBody(result, { inlineInBody: false }), comments };
}

/** The body-only fallback after GitHub rejected an anchor. */
export function renderReviewBodyOnly(result: ReviewResult): string {
  return renderBody(result, { inlineInBody: true });
}

// ---------------------------------------------------------------------------
// Artifact validation (the post job trusts nothing it can check)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min = 0): v is number =>
  isNum(v) && Number.isInteger(v) && v >= min;
const SHA_RE = /^[0-9a-f]{40}$/;
const GATE_KINDS = new Set([
  "blocking-findings",
  "model-failure",
  "budget-exhausted",
  "estimate-over-cap",
  "single-family",
  "fork-not-reviewed",
  "diff-over-cap",
  "cached",
]);
const MAX_FINDINGS = 500;

function checkFinding(v: unknown, path: string, errors: string[]): void {
  if (!isObj(v)) return void errors.push(`${path}: not an object`);
  for (const k of [
    "id",
    "file",
    "title",
    "failureScenario",
    "body",
    "raisedByModel",
    "fingerprint",
    "placementReason",
  ]) {
    if (!isStr(v[k])) errors.push(`${path}.${k}: not a string`);
  }
  if (!isInt(v.line, 0))
    errors.push(`${path}.line: not a non-negative integer`);
  if (v.endLine !== undefined && !isInt(v.endLine, 0))
    errors.push(`${path}.endLine: invalid`);
  if (!(LENSES_LIST as readonly unknown[]).includes(v.lens))
    errors.push(`${path}.lens: invalid`);
  if (!(SEVERITIES as readonly unknown[]).includes(v.severity))
    errors.push(`${path}.severity: invalid`);
  if (typeof v.preExisting !== "boolean")
    errors.push(`${path}.preExisting: not a boolean`);
  if (v.origin !== "reviewer" && v.origin !== "adversary")
    errors.push(`${path}.origin: invalid`);
  if (!(PLACEMENT_LIST as readonly unknown[]).includes(v.placement))
    errors.push(`${path}.placement: invalid`);
  if (v.repeatOf !== undefined && !isStr(v.repeatOf))
    errors.push(`${path}.repeatOf: not a string`);
  if (v.adversary !== undefined) {
    const a = v.adversary;
    if (
      !isObj(a) ||
      !isStr(a.findingId) ||
      !isStr(a.reason) ||
      !["upheld", "dismissed", "disputed"].includes(a.verdict as string)
    ) {
      errors.push(`${path}.adversary: invalid`);
    } else if (a.refutingQuote !== undefined && !isStr(a.refutingQuote)) {
      errors.push(`${path}.adversary.refutingQuote: invalid`);
    }
  }
}

function checkReason(v: unknown, path: string, errors: string[]): void {
  if (!isObj(v) || !isStr(v.kind) || !GATE_KINDS.has(v.kind))
    return void errors.push(`${path}: invalid gate reason`);
  switch (v.kind) {
    case "blocking-findings":
      if (!isInt(v.count)) errors.push(`${path}.count: invalid`);
      break;
    case "model-failure":
      if (
        !["reviewer", "adversary", "counter-check"].includes(v.role as string)
      )
        errors.push(`${path}.role: invalid`);
      if (!isObj(v.error) || !isStr(v.error.kind) || !isStr(v.error.message))
        errors.push(`${path}.error: invalid`);
      break;
    case "budget-exhausted":
      if (!isNum(v.spentUsd) || !isNum(v.capUsd))
        errors.push(`${path}: invalid amounts`);
      break;
    case "estimate-over-cap":
      if (!isNum(v.estimateUsd) || !isNum(v.capUsd))
        errors.push(`${path}: invalid amounts`);
      break;
    case "single-family":
      if (!isStr(v.family)) errors.push(`${path}.family: invalid`);
      break;
    case "diff-over-cap":
      if (!isInt(v.lines) || !isInt(v.cap))
        errors.push(`${path}: invalid counts`);
      break;
    case "cached":
      if (!isStr(v.cacheKey)) errors.push(`${path}.cacheKey: invalid`);
      break;
  }
}

export function validateReviewResult(v: unknown): SchemaCheck<ReviewResult> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["result: not an object"] };
  if (v.schemaVersion !== 1) errors.push("schemaVersion: must be 1");
  if (!isStr(v.repo) || !isValidRepo(v.repo))
    errors.push("repo: invalid");
  if (!isInt(v.prNumber, 0)) errors.push("prNumber: invalid");
  for (const k of ["headSha", "baseSha"])
    if (!isStr(v[k]) || !SHA_RE.test(v[k] as string))
      errors.push(`${k}: not a full SHA`);
  // mergeBase may be empty for runs that stopped before the patch (fork, errors).
  if (!isStr(v.mergeBase) || (v.mergeBase !== "" && !SHA_RE.test(v.mergeBase)))
    errors.push("mergeBase: invalid");
  if (!isStr(v.cacheKey)) errors.push("cacheKey: not a string");
  if (!isInt(v.round, 1)) errors.push("round: invalid");
  if (
    !isObj(v.reviewer) ||
    !isStr(v.reviewer.model) ||
    !isStr(v.reviewer.family)
  )
    errors.push("reviewer: invalid");
  if (
    v.adversary !== null &&
    (!isObj(v.adversary) ||
      !isStr(v.adversary.model) ||
      !isStr(v.adversary.family))
  ) {
    errors.push("adversary: invalid");
  }
  if (!Array.isArray(v.providersSawCode) || !v.providersSawCode.every(isStr))
    errors.push("providersSawCode: invalid");
  if (!Array.isArray(v.findings)) errors.push("findings: not an array");
  else if (v.findings.length > MAX_FINDINGS) errors.push("findings: too many");
  else v.findings.forEach((f, i) => checkFinding(f, `findings[${i}]`, errors));
  if (
    !Array.isArray(v.notRead) ||
    !v.notRead.every(
      (n) => isObj(n) && isStr(n.path) && isStr(n.kind) && isStr(n.reason),
    )
  ) {
    errors.push("notRead: invalid");
  }
  const c = v.coverage;
  if (
    !isObj(c) ||
    !isInt(c.filesInDiff) ||
    !isInt(c.filesRead) ||
    !isInt(c.tokensUsed) ||
    !isInt(c.tokenBudget)
  ) {
    errors.push("coverage: invalid");
  }
  const g = v.gate;
  if (
    !isObj(g) ||
    !["success", "failure", "neutral"].includes(g.conclusion as string) ||
    !isStr(g.summary)
  ) {
    errors.push("gate: invalid");
  } else {
    if (!Array.isArray(g.reasons)) errors.push("gate.reasons: not an array");
    else
      g.reasons.forEach((r, i) => checkReason(r, `gate.reasons[${i}]`, errors));
    if (
      !Array.isArray(g.blockingFindingIds) ||
      !g.blockingFindingIds.every(isStr)
    )
      errors.push("gate.blockingFindingIds: invalid");
  }
  const cost = v.cost;
  if (
    !isObj(cost) ||
    !isNum(cost.estimateUsd) ||
    !isNum(cost.spentUsd) ||
    !isNum(cost.capUsd) ||
    !Array.isArray(cost.usage) ||
    !cost.usage.every(
      (u) =>
        isObj(u) &&
        isNum(u.inputTokens) &&
        isNum(u.outputTokens) &&
        isNum(u.costUsd),
    )
  ) {
    errors.push("cost: invalid");
  }
  if (
    !Array.isArray(v.redactions) ||
    !v.redactions.every((r) => isObj(r) && isStr(r.kind) && isInt(r.count))
  ) {
    errors.push("redactions: invalid");
  }
  if (
    !isObj(v.counts) ||
    !PLACEMENT_LIST.every((p) => isInt((v.counts as Obj)[p]))
  )
    errors.push("counts: invalid");
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ReviewResult };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Recompute the verdict from the findings; keep only the failure reasons code cannot recompute. */
export function recomputeGate(result: ReviewResult): ReviewResult {
  const failures: GateReason[] = result.gate.reasons.filter(
    (r) => r.kind !== "blocking-findings",
  );
  return { ...result, gate: decide({ findings: result.findings, failures }) };
}

/** GitHub validated and refused: nothing was written. Anything else may have landed. */
function mayHaveLanded(r: WriteResult): boolean {
  if (r.ok) return true;
  const s = r.status;
  return s === undefined || s === 403 || s === 429 || s >= 500;
}

const realSleep = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, ms));

export async function postReview(
  gh: GitHubWriter,
  input: ReviewResult,
  opts: PostOptions,
): Promise<{ delivered: "inline" | "body-only" | "summary-only" }> {
  const sleep = opts.sleep ?? realSleep;
  const result = recomputeGate(input);
  const { repo, prNumber: pr, headSha } = result;
  const { body, comments } = renderReview(result);

  const landed = async (): Promise<boolean> => {
    try {
      const reviews = await gh.listReviews(repo, pr);
      return reviews.some((r) => r.commitId === headSha && r.body === body);
    } catch {
      return false; // unknown: a duplicate review is better than a lost one
    }
  };

  let delivered: "inline" | "body-only" | "summary-only" = "summary-only";
  const first = await gh.createReview(repo, pr, headSha, body, comments);
  if (first.ok) {
    delivered = "inline";
  } else if (first.status === 422 && comments.length > 0) {
    const second = await gh.createReview(
      repo,
      pr,
      headSha,
      renderReviewBodyOnly(result),
      [],
    );
    if (second.ok) delivered = "body-only";
  } else if (mayHaveLanded(first)) {
    if (await landed()) {
      delivered = "inline";
    } else {
      const wait = Math.min(first.retryAfterS ?? 0, MAX_RETRY_WAIT_S);
      if (wait > 0) await sleep(wait * 1000);
      const again = await gh.createReview(repo, pr, headSha, body, comments);
      if (again.ok) delivered = "inline";
      else if (again.status === 422 && comments.length > 0) {
        const bodyOnly = await gh.createReview(
          repo,
          pr,
          headSha,
          renderReviewBodyOnly(result),
          [],
        );
        if (bodyOnly.ok) delivered = "body-only";
      }
    }
  }

  const conclusion: CheckConclusion =
    delivered === "summary-only" ? "neutral" : result.gate.conclusion;
  const title =
    delivered === "summary-only"
      ? "Delivery failed: findings are in the job summary"
      : `${CONCLUSION_LABEL[conclusion]}: ${result.gate.summary}`.slice(0, 200);

  const summaryNote =
    delivered === "summary-only"
      ? "\n\n_The review could not be posted on the pull request; this summary is the only copy._\n"
      : "";
  opts.writeSummary(renderReviewBodyOnly(result) + summaryNote);

  const check = await gh.createCheckRun(
    repo,
    headSha,
    opts.checkName,
    conclusion,
    title,
    clampBody(body),
  );
  if (!check.ok) {
    throw new Error(
      `could not set the check run (status ${check.status ?? "none"})`,
    );
  }
  return { delivered };
}

// ---------------------------------------------------------------------------
// The real writer (constructed only in src/entry/post.ts)
// ---------------------------------------------------------------------------

export function createGitHubWriter(
  token: string,
  fetchImpl: typeof fetch,
  apiUrl: string = DEFAULT_API_URL,
): GitHubWriter {
  const http = createHttpClient(token, fetchImpl, apiUrl);
  const write = async (
    path: string,
    payload: unknown,
  ): Promise<WriteResult> => {
    try {
      const r = await http.request("POST", path, payload);
      if (r.status >= 200 && r.status < 300) return { ok: true };
      const retryAfterS = parseRetryAfter(r.headers);
      return {
        ok: false,
        status: r.status,
        ...(retryAfterS !== undefined ? { retryAfterS } : {}),
        message: `HTTP ${r.status}`,
      };
    } catch (e) {
      const status = (e as { status?: number }).status;
      return {
        ok: false,
        ...(status !== undefined ? { status } : {}),
        message: "request failed",
      };
    }
  };
  return {
    createReview(repo, pr, commitSha, body, comments) {
      assertRepo(repo);
      return write(`/repos/${repo}/pulls/${pr}/reviews`, {
        commit_id: commitSha,
        body,
        event: "COMMENT",
        comments,
      });
    },
    async listReviews(repo, pr) {
      const all = await listAllReviews(http, repo, pr);
      return all.map((r) => ({
        id: r.id,
        body: r.body,
        commitId: r.commitId,
        author: r.author,
      }));
    },
    createCheckRun(repo, headSha, name, conclusion, title, summary) {
      assertRepo(repo);
      return write(`/repos/${repo}/check-runs`, {
        name,
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: { title, summary },
      });
    },
  };
}
