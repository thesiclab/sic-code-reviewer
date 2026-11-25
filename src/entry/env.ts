// SPDX-License-Identifier: Apache-2.0
// Shared GitHub Actions environment readers for both entrypoints.
import { readFileSync } from "node:fs";

/** Action inputs from the INPUT_* environment, keyed by lower-case input name. */
export function readInputs(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("INPUT_") && v !== undefined)
      out[k.slice(6).toLowerCase()] = v.trim();
  }
  return out;
}

export interface PrEvent {
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

export function readPrEvent(env: NodeJS.ProcessEnv): PrEvent {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const path = env.GITHUB_EVENT_PATH;
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set");
  const event = JSON.parse(readFileSync(path, "utf8")) as {
    pull_request?: {
      number?: number;
      head?: { sha?: string };
      base?: { sha?: string };
    };
  };
  const pr = event.pull_request;
  if (!pr || typeof pr.number !== "number")
    throw new Error("not a pull_request event");
  return {
    repo,
    prNumber: pr.number,
    headSha: pr.head?.sha ?? "",
    baseSha: pr.base?.sha ?? "",
  };
}
