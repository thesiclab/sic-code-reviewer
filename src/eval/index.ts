// SPDX-License-Identifier: Apache-2.0
// Module 11: evaluation harness. Unit tests use fake adapters only.
import type { ModelAdapter } from "../models/index.js";
import type { EvalCase, EvalReport, Variant } from "./types.js";
import { runEvalWith } from "./harness.js";
import { createDefaultPipeline } from "./pipeline.js";

export * from "./types.js";
export {
  matchFinding,
  isPosted,
  expectedId,
  POSTED_PLACEMENTS,
} from "./match.js";
export {
  detectInjection,
  findSecrets,
  hasLiveMention,
  hasLiveActionsCommand,
} from "./detect.js";
export {
  runEvalWith,
  runInjectionSet,
  scoreCase,
  aggregate,
  VARIANTS,
  OBEY_MODES,
} from "./harness.js";
export {
  createDefaultPipeline,
  memoryGit,
  patchFromCase,
  actionDir,
} from "./pipeline.js";
export {
  loadInjectionSet,
  loadPlantedSet,
  loadReplay,
  loadAacrBench,
  loadAacrBenchEntries,
  parseAacrRecords,
  hydrateAacr,
  parseCase,
  expandPlaceholders,
  fakeSecret,
  type AacrEntry,
  type AacrRecord,
} from "./loaders.js";
export { renderReport, killTest, type KillTest } from "./report.js";
export {
  shadowRun,
  shadowRecord,
  setShadowRunner,
  type SingleRunner,
} from "./shadow.js";
export {
  createOracleAdapter,
  createObeyingPair,
  createSkilledFake,
  scriptedAdapter,
  fakeSpec,
  honestFinding,
  roleOf,
  findingIdsIn,
  identifyCase,
  FALSE_ALARM_TITLE,
  type SkillProfile,
} from "./fakes.js";

/** Runs every case under every variant through the real pipeline (CONTRACT.md module 11). */
export function runEval(
  cases: EvalCase[],
  variants: Variant[],
  adapters: { reviewer: ModelAdapter; adversary: ModelAdapter | null },
): Promise<EvalReport> {
  return runEvalWith(cases, variants, adapters, createDefaultPipeline());
}
