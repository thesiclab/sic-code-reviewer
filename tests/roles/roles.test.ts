// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../../src/types.js";
import { createFakeAdapter } from "../../src/models/index.js";
import {
  anonymise,
  assignIds,
  fingerprint,
  normalizeRepoPath,
  runAdversary,
  runAdversaryDetailed,
  runCounterCheck,
  runReviewer,
  runReviewerDetailed,
  validateAdversaryOutput,
  validateCounterCheckOutput,
  validateReviewerOutput,
} from "../../src/roles/index.js";
import {
  finding,
  inputs,
  PROMPTS,
  raw,
  SPEC,
} from "../fixtures/prompt-inputs.js";
import { FAKE } from "../fixtures/fake-secrets.js";

describe("validateReviewerOutput", () => {
  it("accepts a complete finding and normalises the path", () => {
    const r = validateReviewerOutput({
      findings: [raw({ file: "./src//math.ts" })],
    });
    expect(r.ok && r.value.findings[0]!.file).toBe("src/math.ts");
  });

  it("requires every proof field", () => {
    for (const key of [
      "file",
      "line",
      "lens",
      "severity",
      "title",
      "failureScenario",
      "body",
      "preExisting",
    ] as const) {
      const f: Record<string, unknown> = { ...raw() };
      delete f[key];
      const r = validateReviewerOutput({ findings: [f] });
      expect(r.ok, key).toBe(false);
    }
  });

  it("rejects severities outside the rubric (case is forgiven)", () => {
    expect(
      validateReviewerOutput({
        findings: [raw({ severity: "urgent" as never })],
      }).ok,
    ).toBe(false);
    const r = validateReviewerOutput({
      findings: [raw({ severity: "HIGH" as never })],
    });
    expect(r.ok && r.value.findings[0]!.severity).toBe("high");
  });

  it("rejects paths that leave the repo, and bad lines", () => {
    for (const file of ["/etc/passwd", "../x", "a/../../x", "a\\b", "a\0b"])
      expect(
        validateReviewerOutput({ findings: [raw({ file })] }).ok,
        file,
      ).toBe(false);
    expect(validateReviewerOutput({ findings: [raw({ line: 0 })] }).ok).toBe(
      false,
    );
    expect(
      validateReviewerOutput({ findings: [raw({ line: 3, endLine: 2 })] }).ok,
    ).toBe(false);
  });

  it("copies only known fields", () => {
    const r = validateReviewerOutput({
      findings: [{ ...raw(), origin: "adversary", extra: "x" }],
    });
    expect(r.ok && Object.keys(r.value.findings[0]!)).not.toContain("extra");
  });

  it("normalizeRepoPath", () => {
    expect(normalizeRepoPath("a/./b/../c")).toBe("a/c");
    expect(normalizeRepoPath("..")).toBeNull();
  });
});

describe("adversary and counter-check validators", () => {
  const ids = new Set(["F1", "F2"]);
  it("accepts verdicts for known ids and missed findings", () => {
    const r = validateAdversaryOutput(
      {
        verdicts: [
          {
            findingId: "F1",
            verdict: "dismissed",
            reason: "guarded",
            refutingQuote: "if (b === 0) return 0;",
            refutingFile: "src/math.ts",
            refutingLine: 2,
          },
        ],
        missed: [raw()],
      },
      ids,
    );
    expect(r.ok && r.value.verdicts[0]!.refutingLine).toBe(2);
    expect(r.ok && r.value.missed).toHaveLength(1);
  });
  it("an unknown id is a schema error", () => {
    expect(
      validateAdversaryOutput(
        {
          verdicts: [{ findingId: "F9", verdict: "upheld", reason: "x" }],
          missed: [],
        },
        ids,
      ).ok,
    ).toBe(false);
  });
  it("a second verdict for one id is a schema error", () => {
    const v = { findingId: "F1", verdict: "upheld", reason: "x" };
    expect(validateCounterCheckOutput({ verdicts: [v, v] }, ids).ok).toBe(
      false,
    );
  });
  it("a missing verdict is allowed (treated as upheld later)", () => {
    expect(validateCounterCheckOutput({ verdicts: [] }, ids).ok).toBe(true);
  });
});

describe("assignIds / fingerprint / anonymise", () => {
  it("assigns opaque sequential ids and stable fingerprints", () => {
    const fs = assignIds(
      [raw(), raw({ title: "Other" })],
      "adversary",
      "glm-4.6",
      5,
    );
    expect(fs.map((f) => f.id)).toEqual(["F5", "F6"]);
    expect(fs[0]!.origin).toBe("adversary");
    expect(fs[0]!.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(
      fingerprint(raw({ title: "Division by ZERO returns 0, silently!" })),
    ).toBe(fingerprint(raw({ title: "division by zero returns 0 silently" })));
    expect(fingerprint(raw({ lens: "security" }))).not.toBe(fingerprint(raw()));
  });

  it("shuffles deterministically per seed and blanks origin, model, fingerprint", () => {
    const fs = assignIds(
      Array.from({ length: 8 }, (_, i) => raw({ title: `t${i}` })),
      "reviewer",
      "claude-x",
      1,
    );
    const a = anonymise(fs, "seed-1");
    expect(anonymise(fs, "seed-1").map((f) => f.id)).toEqual(
      a.map((f) => f.id),
    );
    expect(anonymise(fs, "seed-2").map((f) => f.id)).not.toEqual(
      a.map((f) => f.id),
    );
    expect(a.map((f) => f.id).sort()).toEqual(fs.map((f) => f.id).sort());
    expect(
      a.every(
        (f) =>
          f.raisedByModel === "" &&
          f.fingerprint === "" &&
          f.origin === "reviewer",
      ),
    ).toBe(true);
    expect(fs[0]!.raisedByModel).toBe("claude-x"); // originals untouched
  });
});

describe("runReviewer / runAdversary / runCounterCheck (fake adapter)", () => {
  it("reviewer: sends the reviewer schema and returns validated findings", async () => {
    let req: ModelRequest | undefined;
    const adapter = createFakeAdapter(SPEC, (r) => {
      req = r;
      return JSON.stringify({ findings: [raw()] });
    });
    const r = await runReviewer({ adapter, prompts: PROMPTS }, inputs());
    expect(r.ok && r.value.findings).toHaveLength(1);
    expect(req!.schemaName).toBe("submit_review");
    expect(req!.maxOutputTokens).toBe(SPEC.maxOutputTokens);
    expect(req!.user).toContain("=== BEGIN DIFF ");
    expect(req!.user).not.toContain("=== BEGIN FINDINGS ");
  });

  it("reviewer detailed run reports redactions and the shown code text", async () => {
    const adapter = createFakeAdapter(SPEC, () =>
      JSON.stringify({ findings: [] }),
    );
    const run = await runReviewerDetailed(
      { adapter, prompts: PROMPTS },
      inputs({ prBody: `oops ${FAKE.ghp}` }),
    );
    expect(run.redactions).toEqual([{ kind: "github-token", count: 1 }]);
    expect(run.shownText).toContain("return a / b;");
  });

  it("adversary: sees anonymised findings and may only judge ids it was given", async () => {
    let user = "";
    const adapter = createFakeAdapter(SPEC, (r) => {
      user = r.user;
      return JSON.stringify({
        verdicts: [{ findingId: "F1", verdict: "upheld", reason: "real" }],
        missed: [raw({ title: "Missed one", line: 3 })],
      });
    });
    const run = await runAdversaryDetailed(
      { adapter, prompts: PROMPTS },
      { ...inputs(), findings: [finding({ raisedByModel: "claude-hidden" })] },
    );
    expect(run.result.ok && run.result.value.missed).toHaveLength(1);
    expect(user).not.toContain("claude-hidden");
    expect(user).toContain("=== BEGIN FINDINGS ");

    const bad = createFakeAdapter(SPEC, () =>
      JSON.stringify({
        verdicts: [{ findingId: "F7", verdict: "dismissed", reason: "x" }],
        missed: [],
      }),
    );
    const r = await runAdversary(
      { adapter: bad, prompts: PROMPTS },
      { ...inputs(), findings: [finding()] },
    );
    expect(!r.ok && r.error.kind).toBe("schema");
  });

  it("counter-check: verdicts on the adversary's findings", async () => {
    const adapter = createFakeAdapter(SPEC, () =>
      JSON.stringify({
        verdicts: [{ findingId: "F2", verdict: "disputed", reason: "unclear" }],
      }),
    );
    const r = await runCounterCheck(
      { adapter, prompts: PROMPTS },
      { ...inputs(), findings: [finding({ id: "F2", origin: "adversary" })] },
    );
    expect(r.ok && r.value.verdicts[0]!.verdict).toBe("disputed");
  });

  it("a model failure comes back as ok:false, never as an empty success", async () => {
    const adapter = createFakeAdapter(SPEC, () => ({
      error: { kind: "http", status: 503, message: "down" },
    }));
    const r = await runReviewer({ adapter, prompts: PROMPTS }, inputs());
    expect(r.ok).toBe(false);
  });
});
