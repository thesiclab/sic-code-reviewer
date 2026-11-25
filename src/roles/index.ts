// SPDX-License-Identifier: Apache-2.0
// Module 5: reviewer, adversary, counter-check.
import type { Finding, JsonSchema, ModelResult } from "../types.js";
import type { ModelAdapter, SchemaCheck } from "../models/index.js";
import {
  renderAdversaryPrompt,
  renderCounterCheckPrompt,
  renderReviewerPrompt,
  shownCodeText,
  type PromptInputs,
  type PromptSet,
  type RenderedPrompt,
} from "../prompts/index.js";
import {
  ADVERSARY_SCHEMA,
  COUNTER_CHECK_SCHEMA,
  REVIEWER_SCHEMA,
  validateAdversaryOutput,
  validateCounterCheckOutput,
  validateReviewerOutput,
  type AdversaryOutput,
  type CounterCheckOutput,
  type ReviewerOutput,
} from "./schema.js";
import { anonymise } from "./assign.js";
export * from "./schema.js";
export * from "./assign.js";

export interface RoleDeps {
  adapter: ModelAdapter;
  prompts: PromptSet;
}

/**
 * A role call plus what entry/ needs for the artifact: the redaction counts of
 * the prompt actually sent, and the code text the model was shown (module 6
 * checks refuting quotes against it). Same call as runReviewer etc.
 */
export interface RoleRun<T> {
  result: ModelResult<T>;
  redactions: RenderedPrompt["redactions"];
  shownText: string;
}

async function call<T>(
  deps: RoleDeps,
  inputs: PromptInputs,
  render: (i: PromptInputs) => RenderedPrompt,
  schema: JsonSchema,
  schemaName: string,
  validate: (v: unknown) => SchemaCheck<T>,
): Promise<RoleRun<T>> {
  const rendered = render({ ...inputs, prompts: deps.prompts });
  const result = await deps.adapter.complete<T>(
    {
      system: rendered.system,
      user: rendered.user,
      schema,
      schemaName,
      maxOutputTokens: deps.adapter.spec.maxOutputTokens,
    },
    validate,
  );
  return {
    result,
    redactions: rendered.redactions,
    shownText: shownCodeText(inputs),
  };
}

function shuffleSeed(inputs: PromptInputs, role: string): string {
  return `${inputs.patch.headSha}:${inputs.patch.mergeBase}:${role}`;
}

export function runReviewerDetailed(
  deps: RoleDeps,
  inputs: PromptInputs,
): Promise<RoleRun<ReviewerOutput>> {
  const { findings: _ignored, ...rest } = inputs;
  return call(
    deps,
    rest,
    renderReviewerPrompt,
    REVIEWER_SCHEMA,
    "submit_review",
    validateReviewerOutput,
  );
}

export function runAdversaryDetailed(
  deps: RoleDeps,
  inputs: PromptInputs & { findings: Finding[] },
): Promise<RoleRun<AdversaryOutput>> {
  const ids = new Set(inputs.findings.map((f) => f.id));
  const shown = anonymise(inputs.findings, shuffleSeed(inputs, "adversary"));
  return call(
    deps,
    { ...inputs, findings: shown },
    renderAdversaryPrompt,
    ADVERSARY_SCHEMA,
    "submit_adversary_review",
    (v) => validateAdversaryOutput(v, ids),
  );
}

export function runCounterCheckDetailed(
  deps: RoleDeps,
  inputs: PromptInputs & { findings: Finding[] },
): Promise<RoleRun<CounterCheckOutput>> {
  const ids = new Set(inputs.findings.map((f) => f.id));
  const shown = anonymise(
    inputs.findings,
    shuffleSeed(inputs, "counter-check"),
  );
  return call(
    deps,
    { ...inputs, findings: shown },
    renderCounterCheckPrompt,
    COUNTER_CHECK_SCHEMA,
    "submit_counter_check",
    (v) => validateCounterCheckOutput(v, ids),
  );
}

export async function runReviewer(
  deps: RoleDeps,
  inputs: PromptInputs,
): Promise<ModelResult<ReviewerOutput>> {
  return (await runReviewerDetailed(deps, inputs)).result;
}
export async function runAdversary(
  deps: RoleDeps,
  inputs: PromptInputs & { findings: Finding[] },
): Promise<ModelResult<AdversaryOutput>> {
  return (await runAdversaryDetailed(deps, inputs)).result;
}
/** Skipped by the caller when the adversary's `missed` is empty. */
export async function runCounterCheck(
  deps: RoleDeps,
  inputs: PromptInputs & { findings: Finding[] },
): Promise<ModelResult<CounterCheckOutput>> {
  return (await runCounterCheckDetailed(deps, inputs)).result;
}
