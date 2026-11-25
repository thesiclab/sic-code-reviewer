// SPDX-License-Identifier: Apache-2.0
// Entrypoint: the WRITE job (CONTRACT.md section 2, module 9). Holds only the
// write token (pull-requests:write, checks:write). Never checks out PR code,
// never calls a model, never reads a model key. It re-validates the artifact,
// re-runs the gate from the findings (inside postReview), sanitizes, posts and
// sets the check. Anything it cannot verify ends in a neutral check.
import { appendFileSync, readFileSync } from "node:fs";
import type { CheckConclusion, ReviewResult } from "../types.js";
import {
  createGitHubWriter,
  postReview,
  validateReviewResult,
  type GitHubWriter,
} from "../output/index.js";
import { parseRoundSentinel } from "../memory/index.js";
import { readInputs, readPrEvent } from "./env.js";

export interface PostDeps {
  /** From the workflow event, not from the artifact. */
  repo: string;
  prNumber: number;
  headSha: string;
  /** Raw artifact text, or null when the read job left none. */
  artifact: string | null;
  gh: GitHubWriter;
  checkName: string;
  botLogins: string[];
  writeSummary: (md: string) => void;
}

export type PostOutcome =
  | { kind: "posted"; delivered: "inline" | "body-only" | "summary-only" }
  | { kind: "cached"; conclusion: CheckConclusion }
  | { kind: "rejected"; reason: string };

async function neutral(
  d: PostDeps,
  title: string,
  detail: string,
): Promise<void> {
  d.writeSummary(
    `## sic-code-reviewer · Neutral (not a pass)\n\n${title}\n\n${detail}\n`,
  );
  const r = await d.gh.createCheckRun(
    d.repo,
    d.headSha,
    d.checkName,
    "neutral",
    title,
    detail,
  );
  if (!r.ok)
    throw new Error(
      `could not set the check run (status ${r.status ?? "none"})`,
    );
}

/**
 * A cached verdict is accepted only when GitHub itself shows our bot's review
 * at this head carrying the same cache key; the artifact's word is not enough.
 */
async function verifyCached(
  d: PostDeps,
  result: ReviewResult,
): Promise<{ conclusion: CheckConclusion; round: number } | null> {
  const bots = new Set(d.botLogins);
  const reviews = await d.gh.listReviews(d.repo, d.prNumber);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i]!;
    if (!bots.has(r.author) || r.commitId !== d.headSha) continue;
    const s = parseRoundSentinel(r.body);
    if (!s || s.headSha !== d.headSha || s.cacheKey !== result.cacheKey)
      continue;
    if (s.conclusion === "neutral") return null;
    return { conclusion: s.conclusion, round: s.round };
  }
  return null;
}

export async function runPost(d: PostDeps): Promise<PostOutcome> {
  if (d.artifact === null) {
    await neutral(
      d,
      "Not reviewed: the review job left no result",
      "The read job failed or was skipped. Re-run the workflow.",
    );
    return { kind: "rejected", reason: "no artifact" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(d.artifact);
  } catch {
    await neutral(
      d,
      "Not reviewed: the review result is unreadable",
      "review-result.json is not valid JSON.",
    );
    return { kind: "rejected", reason: "invalid json" };
  }
  const v = validateReviewResult(parsed);
  if (!v.ok) {
    await neutral(
      d,
      "Not reviewed: the review result failed validation",
      `${v.errors.length} schema error(s).`,
    );
    return { kind: "rejected", reason: "schema" };
  }
  const result = v.value;
  if (
    result.repo !== d.repo ||
    result.prNumber !== d.prNumber ||
    result.headSha !== d.headSha
  ) {
    await neutral(
      d,
      "Not reviewed: the review result is for a different pull request or commit",
      "Re-run the workflow.",
    );
    return { kind: "rejected", reason: "mismatch" };
  }

  if (result.gate.reasons.some((r) => r.kind === "cached")) {
    let hit: { conclusion: CheckConclusion; round: number } | null = null;
    try {
      hit = await verifyCached(d, result);
    } catch {
      hit = null;
    }
    if (!hit) {
      await neutral(
        d,
        "Cached verdict could not be verified",
        "Re-run the workflow to review this commit again.",
      );
      return { kind: "rejected", reason: "cache unverified" };
    }
    const title = `Same input as round ${hit.round}: verdict re-used`;
    d.writeSummary(`## sic-code-reviewer\n\n${title} (${hit.conclusion}).\n`);
    const r = await d.gh.createCheckRun(
      d.repo,
      d.headSha,
      d.checkName,
      hit.conclusion,
      title,
      `${title} (${hit.conclusion}).`,
    );
    if (!r.ok)
      throw new Error(
        `could not set the check run (status ${r.status ?? "none"})`,
      );
    return { kind: "cached", conclusion: hit.conclusion };
  }

  const { delivered } = await postReview(d.gh, result, {
    checkName: d.checkName,
    writeSummary: d.writeSummary,
  });
  return { kind: "posted", delivered };
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const inputs = readInputs(env);
  const ev = readPrEvent(env);
  const path =
    inputs["result-path"] || `${env.RUNNER_TEMP ?? "."}/review-result.json`;
  let artifact: string | null = null;
  try {
    artifact = readFileSync(path, "utf8");
  } catch {
    artifact = null;
  }
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  try {
    const out = await runPost({
      repo: ev.repo,
      prNumber: ev.prNumber,
      headSha: ev.headSha,
      artifact,
      gh: createGitHubWriter(
        inputs["github-token"] ?? "",
        fetch,
        env.GITHUB_API_URL || undefined,
      ),
      checkName: inputs["check-name"] || "sic-code-reviewer",
      botLogins: (inputs["bot-logins"] || "github-actions[bot]")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      writeSummary: (md) => {
        if (summaryPath) appendFileSync(summaryPath, md + "\n", "utf8");
      },
    });
    void out;
    return 0;
  } catch (e) {
    process.stderr.write(
      `::error::sic-code-reviewer post failed (${e instanceof Error ? e.name : "Error"})\n`,
    );
    return 1;
  }
}
