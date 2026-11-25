// SPDX-License-Identifier: Apache-2.0
// The CI injection gate (CONTRACT.md module 11): the injection set through the
// REAL pipeline (fences, filter, quote rule, sanitizer, gate) with fake models
// that obey the injection. Any success fails the build.
//
// While the other modules are still stubs this file skips with a warning. Set
// SIC_REQUIRE_FULL_PIPELINE=1 (CI after integration) to make a stub a failure.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotImplemented } from "../../src/errors.js";
import {
  actionDir,
  createDefaultPipeline,
  loadInjectionSet,
  loadPlantedSet,
  runInjectionSet,
  type EvalCase,
} from "../../src/eval/index.js";
import { createOracleAdapter, fakeSpec } from "../../src/eval/index.js";

const ROOT = actionDir();
const injection = loadInjectionSet(join(ROOT, "eval", "injection"));
const planted = loadPlantedSet(join(ROOT, "eval", "planted"));
const require = process.env.SIC_REQUIRE_FULL_PIPELINE === "1";

/** Runs one honest case through the real pipeline; reports a missing module instead of throwing. */
async function probe(c: EvalCase): Promise<string | null> {
  try {
    const p = createDefaultPipeline();
    await p(c, "duo", {
      reviewer: createOracleAdapter(
        fakeSpec("fake-claude", "claude"),
        c,
        false,
      ),
      adversary: createOracleAdapter(fakeSpec("fake-glm", "glm"), c, false),
    });
    return null;
  } catch (e) {
    // NotImplemented stubs, empty prompt files and the like: not ready yet.
    return e instanceof NotImplemented ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
  }
}

const missing = await probe(planted[0]!);
if (missing && !require) {
  console.warn(
    `[injection-ci] SKIPPED: real pipeline incomplete (${missing}). Set SIC_REQUIRE_FULL_PIPELINE=1 to fail instead.`,
  );
}

describe.skipIf(missing !== null && !require)(
  "injection CI gate (real pipeline, obeying fakes)",
  () => {
    it("the real pipeline is complete", () => {
      expect(missing).toBeNull();
    });

    it("honest duo catches every planted bug and blocks", async () => {
      const p = createDefaultPipeline();
      for (const c of planted) {
        const run = await p(c, "duo", {
          reviewer: createOracleAdapter(
            fakeSpec("fake-claude", "claude"),
            c,
            false,
          ),
          adversary: createOracleAdapter(fakeSpec("fake-glm", "glm"), c, false),
        });
        const blocking = c.expected.some(
          (e) =>
            e.severity === undefined ||
            e.severity === "critical" ||
            e.severity === "high",
        );
        expect(run.gate.conclusion, c.id).toBe(
          blocking ? "failure" : "success",
        );
      }
    });

    it("no injection succeeds in either obey mode", async () => {
      const res = await runInjectionSet(injection, createDefaultPipeline());
      const bad = res
        .filter((r) => r.succeeded)
        .map((r) => `${r.caseId} [${r.mode}]: ${r.reasons.join("; ")}`);
      expect(bad).toEqual([]);
    });
  },
);
