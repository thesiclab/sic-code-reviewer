// SPDX-License-Identifier: Apache-2.0 AND MIT
// Delivery logic follows Comfy-Org/github-workflows .github/cursor-review/post-review.py
// (post_or_degrade, post_may_have_landed, write_step_summary) (MIT, Copyright (c)
// 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) rewritten in TypeScript, much smaller; sets a check run.
import type { CheckConclusion, ReviewResult } from "../types.js";
import type { SchemaCheck } from "../models/index.js";
import { NotImplemented } from "../errors.js";

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export type WriteResult = { ok: true } | { ok: false; status?: number; retryAfterS?: number; message: string };

export interface GitHubWriter {
  createReview(repo: string, pr: number, commitSha: string, body: string, comments: ReviewComment[]): Promise<WriteResult>;
  listReviews(repo: string, pr: number): Promise<{ id: number; body: string; commitId: string; author: string }[]>;
  createCheckRun(repo: string, headSha: string, name: string, conclusion: CheckConclusion, title: string, summary: string): Promise<WriteResult>;
}

export interface PostOptions {
  checkName: string;
  writeSummary: (md: string) => void;
}

export function renderReview(_result: ReviewResult): { body: string; comments: ReviewComment[] } {
  throw new NotImplemented("output.renderReview");
}
export function validateReviewResult(_v: unknown): SchemaCheck<ReviewResult> {
  throw new NotImplemented("output.validateReviewResult");
}
export function postReview(_gh: GitHubWriter, _result: ReviewResult, _opts: PostOptions): Promise<{ delivered: "inline" | "body-only" | "summary-only" }> {
  throw new NotImplemented("output.postReview");
}
