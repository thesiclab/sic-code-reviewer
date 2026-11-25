// SPDX-License-Identifier: Apache-2.0
// Thin GitHub REST/GraphQL client. Readers are used by the read job (pull-requests: read);
// the writer (output/poster.ts GitHubWriter) is used only by the post job.
import { NotImplemented } from "../errors.js";

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  /** True when head repo != base repo. Fork PRs are not reviewed in v1. */
  isFork: boolean;
  isPrivateRepo: boolean;
}

export interface ReviewRecord {
  id: number;
  body: string;
  commitId: string;
  author: string;
  authorType: "Bot" | "User" | "Organization";
}

export interface ReviewThreadComment {
  id: string;
  author: string;
  authorAssociation: string;
  body: string;
  url: string;
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface GitHubReader {
  getPr(repo: string, pr: number): Promise<PrInfo>;
  listReviews(repo: string, pr: number): Promise<ReviewRecord[]>;
  listReviewThreads(repo: string, pr: number): Promise<ReviewThread[]>;
}

export function createGitHubReader(_token: string, _fetchImpl: typeof fetch): GitHubReader {
  throw new NotImplemented("github.createGitHubReader");
}
