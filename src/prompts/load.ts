// SPDX-License-Identifier: Apache-2.0
import { NotImplemented } from "../errors.js";

export interface PromptSet {
  reviewer: string;
  adversary: string;
  counterCheck: string;
  rubric: string;
}

/** Loads from the action's own prompts/ directory (pinned with the action). Never from the PR head. */
export function loadPrompts(_actionDir: string): PromptSet {
  throw new NotImplemented("prompts.loadPrompts");
}
