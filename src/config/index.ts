// SPDX-License-Identifier: Apache-2.0
// Config from trusted sources only: action inputs and the BASE-commit
// .sic-code-reviewer.yml. Fencing, redaction, sanitising, the proof rule and
// the fail-closed gate have no config keys.
import type { ModelSpec } from "../types.js";
import type { ContextOptions } from "../context/index.js";
import { NotImplemented } from "../errors.js";

export interface Config {
  reviewer: ModelSpec;
  adversary: ModelSpec | null;
  maxCostUsd: number;
  maxDiffLines: number;
  context: ContextOptions;
  maxInline: number;
  /** Fixed at 2 in v1; config may lower it, not raise it. */
  repeatCap: number;
  botLogins: string[];
  allowSecondProviderOnPrivate: boolean;
  guidance: string | null;
  checkName: string;
}

export const DEFAULTS = {
  maxCostUsd: 2.0,
  maxDiffLines: 5000,
  tokenBudget: 60000,
  maxInline: 10,
  repeatCap: 2,
  checkName: "sic-code-reviewer",
  botLogins: ["github-actions[bot]"],
} as const;

export function loadConfig(
  _actionInputs: Record<string, string>,
  _baseFile: string | null,
): { config: Config; configHash: string; warnings: string[] } {
  throw new NotImplemented("config.loadConfig");
}
