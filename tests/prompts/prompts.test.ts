// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "vitest";

describe("prompts (CONTRACT.md)", () => {
  it.todo("implement tests for module prompts per CONTRACT.md");
});

describe("injection defences (required before milestone 1)", () => {
  it.todo("a forged END fence inside the diff does not close the region");
  it.todo("nonce never appears in env, outputs or logs");
  it.todo("redaction removes every listed secret kind before the adapter is called");
});
