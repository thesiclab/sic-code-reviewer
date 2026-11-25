// SPDX-License-Identifier: Apache-2.0 AND MIT
// Derived in part from Comfy-Org/github-workflows .github/cursor-review/review-output-mcp.py
// (validate_finding) (MIT, Copyright (c) 2026 Comfy Org), commit 63c501a0. See NOTICE.
// Changes: (scaffold) ported to TypeScript; proof fields (lens, title,
// failureScenario, preExisting) added; adversary and counter-check schemas are ours.
import type { AdversaryVerdict, JsonSchema, RawFinding } from "../types.js";
import type { SchemaCheck } from "../models/index.js";
import { NotImplemented } from "../errors.js";

export interface ReviewerOutput {
  findings: RawFinding[];
}
export interface AdversaryOutput {
  verdicts: AdversaryVerdict[];
  missed: RawFinding[];
}
export interface CounterCheckOutput {
  verdicts: AdversaryVerdict[];
}

export const REVIEWER_SCHEMA: JsonSchema = {};
export const ADVERSARY_SCHEMA: JsonSchema = {};
export const COUNTER_CHECK_SCHEMA: JsonSchema = {};

export function validateReviewerOutput(_v: unknown): SchemaCheck<ReviewerOutput> {
  throw new NotImplemented("roles.validateReviewerOutput");
}
export function validateAdversaryOutput(_v: unknown, _ids: Set<string>): SchemaCheck<AdversaryOutput> {
  throw new NotImplemented("roles.validateAdversaryOutput");
}
export function validateCounterCheckOutput(_v: unknown, _ids: Set<string>): SchemaCheck<CounterCheckOutput> {
  throw new NotImplemented("roles.validateCounterCheckOutput");
}
