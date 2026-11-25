// SPDX-License-Identifier: Apache-2.0
// Module 5: reviewer, adversary, counter-check.
import type { Finding, ModelResult } from "../types.js";
import type { ModelAdapter } from "../models/index.js";
import type { PromptInputs, PromptSet } from "../prompts/index.js";
import type { AdversaryOutput, CounterCheckOutput, ReviewerOutput } from "./schema.js";
import { NotImplemented } from "../errors.js";
export * from "./schema.js";
export * from "./assign.js";

export interface RoleDeps {
  adapter: ModelAdapter;
  prompts: PromptSet;
}

export function runReviewer(_deps: RoleDeps, _inputs: PromptInputs): Promise<ModelResult<ReviewerOutput>> {
  throw new NotImplemented("roles.runReviewer");
}
export function runAdversary(_deps: RoleDeps, _inputs: PromptInputs & { findings: Finding[] }): Promise<ModelResult<AdversaryOutput>> {
  throw new NotImplemented("roles.runAdversary");
}
export function runCounterCheck(_deps: RoleDeps, _inputs: PromptInputs & { findings: Finding[] }): Promise<ModelResult<CounterCheckOutput>> {
  throw new NotImplemented("roles.runCounterCheck");
}
