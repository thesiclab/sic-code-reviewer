// SPDX-License-Identifier: Apache-2.0
import type { ContextBundle, Finding, PatchSet } from "../types.js";
import type { PromptSet } from "./load.js";
import type { RedactionResult } from "./redact.js";
import { NotImplemented } from "../errors.js";

export interface PromptInputs {
  prompts: PromptSet;
  patch: PatchSet;
  context: ContextBundle;
  prTitle: string;
  prBody: string;
  ledgerText: string | null;
  guidance: string | null;
  /** Adversary and counter-check only; origin fields are stripped when rendered. */
  findings?: Finding[];
}

export interface RenderedPrompt {
  system: string;
  user: string;
  nonce: string;
  redactions: RedactionResult["counts"];
}

export function renderReviewerPrompt(_i: PromptInputs): RenderedPrompt {
  throw new NotImplemented("prompts.renderReviewerPrompt");
}
export function renderAdversaryPrompt(_i: PromptInputs): RenderedPrompt {
  throw new NotImplemented("prompts.renderAdversaryPrompt");
}
export function renderCounterCheckPrompt(_i: PromptInputs): RenderedPrompt {
  throw new NotImplemented("prompts.renderCounterCheckPrompt");
}
