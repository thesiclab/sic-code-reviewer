// SPDX-License-Identifier: Apache-2.0
// Module 4: model adapters. No tools; text in, JSON out, validated by code.
export type {
  SchemaCheck,
  ModelAdapter,
  AdapterOptions,
  FakeScript,
} from "./adapters.js";
export {
  createAnthropicAdapter,
  createOpenAICompatAdapter,
  createFakeAdapter,
  toProviderSchema,
} from "./adapters.js";
export {
  extractJson,
  extractJsonDetailed,
  repairStringArrays,
} from "./repair.js";
export { resolveFamily, familyCheck } from "./family.js";
