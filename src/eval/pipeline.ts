// SPDX-License-Identifier: Apache-2.0
// The default eval pipeline: the real modules, wired as the read job wires
// them (CONTRACT.md section 2), over an in-memory repository built from the
// case. No git process, no network: model calls go to the adapters passed in.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  AdversaryVerdict,
  ContextBundle,
  FilteredFinding,
  Finding,
  GateReason,
  ModelResult,
  ModelUsage,
  PatchSet,
  Placement,
  ReviewResult,
} from "../types.js";
import type { Git, GrepHit } from "../diff/index.js";
import { anchorableLines, parseUnifiedDiff } from "../diff/index.js";
import { buildContext } from "../context/index.js";
import {
  loadPrompts,
  type PromptInputs,
  type PromptSet,
} from "../prompts/index.js";
import {
  anonymise,
  assignIds,
  runAdversary,
  runCounterCheck,
  runReviewer,
} from "../roles/index.js";
import { familyCheck } from "../models/index.js";
import { filterFindings } from "../findings/index.js";
import { enforceRepeatCap } from "../memory/index.js";
import { decide } from "../gate/index.js";
import { renderReview } from "../output/index.js";
import { DEFAULTS } from "../config/index.js";
import type {
  CaseRun,
  EvalAdapters,
  EvalCase,
  EvalPipeline,
  Variant,
} from "./types.js";

export const EVAL_BASE_SHA = "0".repeat(40);
export const EVAL_HEAD_SHA = "1".repeat(40);

/** Repo root = two levels above this file (src/eval or dist/eval). */
export function actionDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A Git over the case's head-side files. Base-side reads return null. */
export function memoryGit(c: EvalCase): Git {
  return {
    async mergeBase() {
      return EVAL_BASE_SHA;
    },
    async diff() {
      return c.diff;
    },
    async show(sha, path) {
      if (sha === EVAL_BASE_SHA) return null;
      return c.files[path] ?? null;
    },
    async grep(_sha, pattern, opts) {
      const src = opts.fixed ? escapeRe(pattern) : pattern;
      const re = new RegExp(opts.word ? `\\b${src}\\b` : src);
      const hits: GrepHit[] = [];
      for (const [path, text] of Object.entries(c.files)) {
        let n = 0;
        for (const [i, line] of text.split("\n").entries()) {
          if (re.test(line)) {
            hits.push({ path, line: i + 1, text: line });
            if (++n >= opts.maxCount) break;
          }
        }
      }
      return hits;
    },
    async lsTree() {
      return Object.keys(c.files).sort();
    },
  };
}

export function patchFromCase(c: EvalCase): PatchSet {
  return {
    baseSha: EVAL_BASE_SHA,
    headSha: EVAL_HEAD_SHA,
    mergeBase: EVAL_BASE_SHA,
    files: parseUnifiedDiff(c.diff),
    fullText: c.diff,
    incrementalText: null,
    excluded: [],
    lockfileNotes: [],
  };
}

const PLACEMENTS: Placement[] = [
  "inline",
  "body",
  "pre-existing",
  "dismissed",
  "disputed",
  "dropped",
];

export interface DefaultPipelineOptions {
  prompts?: PromptSet;
  maxInline?: number;
  tokenBudget?: number;
}

export function createDefaultPipeline(
  opts: DefaultPipelineOptions = {},
): EvalPipeline {
  let prompts = opts.prompts;
  return async (
    c: EvalCase,
    variant: Variant,
    adapters: EvalAdapters,
  ): Promise<CaseRun> => {
    prompts ??= loadPrompts(actionDir());
    const patch = patchFromCase(c);
    const git = memoryGit(c);
    const context: ContextBundle = await buildContext(git, patch, {
      tokenBudget: opts.tokenBudget ?? DEFAULTS.tokenBudget,
      maxCallersPerSymbol: 5,
      maxCalleesPerSymbol: 5,
      repoMapMaxTokens: 2000,
    });
    const inputs: PromptInputs = {
      prompts,
      patch,
      context,
      prTitle: c.title,
      prBody: c.body,
      ledgerText: null,
      guidance: null,
    };
    const usage: ModelUsage[] = [];
    const failures: GateReason[] = [];
    const track = <T>(
      r: ModelResult<T>,
      role: "reviewer" | "adversary" | "counter-check",
    ): T | null => {
      usage.push(r.usage);
      if (r.ok) return r.value;
      failures.push({ kind: "model-failure", role, error: r.error });
      return null;
    };

    const second = variant === "single" ? null : adapters.adversary;
    const fam = familyCheck(adapters.reviewer.spec, second?.spec ?? null);
    if (!fam.ok) failures.push(fam.reason);

    let reviewer: Finding[] = [];
    let adversaryVerdicts: AdversaryVerdict[] = [];
    let adversaryMissed: Finding[] = [];
    let counterVerdicts: AdversaryVerdict[] = [];

    const rv = track(
      await runReviewer({ adapter: adapters.reviewer, prompts }, inputs),
      "reviewer",
    );
    if (rv)
      reviewer = assignIds(
        rv.findings,
        "reviewer",
        adapters.reviewer.spec.model,
        1,
      );

    if (rv && second && variant === "two-families-no-adversary") {
      const r2 = track(
        await runReviewer({ adapter: second, prompts }, inputs),
        "adversary",
      );
      if (r2)
        adversaryMissed = assignIds(
          r2.findings,
          "adversary",
          second.spec.model,
          reviewer.length + 1,
        );
    } else if (rv && second && variant === "duo") {
      const av = track(
        await runAdversary(
          { adapter: second, prompts },
          { ...inputs, findings: anonymise(reviewer, c.id) },
        ),
        "adversary",
      );
      if (av) {
        adversaryVerdicts = av.verdicts;
        adversaryMissed = assignIds(
          av.missed,
          "adversary",
          second.spec.model,
          reviewer.length + 1,
        );
        if (adversaryMissed.length > 0) {
          const cv = track(
            await runCounterCheck(
              { adapter: adapters.reviewer, prompts },
              { ...inputs, findings: anonymise(adversaryMissed, `${c.id}:cc`) },
            ),
            "counter-check",
          );
          if (cv) counterVerdicts = cv.verdicts;
        }
      }
    }

    const shownText = [
      patch.fullText,
      ...context.items.map((i) => i.text),
    ].join("\n");
    let findings: FilteredFinding[] = filterFindings({
      reviewer,
      adversaryVerdicts,
      adversaryMissed,
      counterVerdicts,
      anchors: anchorableLines(c.diff) ?? new Map(),
      shownText,
      maxInline: opts.maxInline ?? DEFAULTS.maxInline,
    });
    findings = enforceRepeatCap(findings, {
      rounds: 0,
      last: null,
      entries: [],
      truncated: false,
    });
    const gate = decide({ findings, failures });

    const counts = Object.fromEntries(
      PLACEMENTS.map((p) => [
        p,
        findings.filter((f) => f.placement === p).length,
      ]),
    ) as Record<Placement, number>;
    const spent = usage.reduce((s, u) => s + u.costUsd, 0);
    const result: ReviewResult = {
      schemaVersion: 1,
      repo: "eval/eval",
      prNumber: 0,
      headSha: EVAL_HEAD_SHA,
      baseSha: EVAL_BASE_SHA,
      mergeBase: EVAL_BASE_SHA,
      cacheKey: `eval:${c.id}:${variant}`,
      round: 1,
      reviewer: {
        model: adapters.reviewer.spec.model,
        family: adapters.reviewer.spec.family,
      },
      adversary: second
        ? { model: second.spec.model, family: second.spec.family }
        : null,
      providersSawCode: [
        adapters.reviewer.spec.provider,
        ...(second ? [second.spec.provider] : []),
      ],
      findings,
      notRead: context.notRead,
      coverage: {
        filesInDiff: patch.files.length,
        filesRead: new Set(context.items.map((i) => i.path)).size,
        tokensUsed: context.tokensUsed,
        tokenBudget: context.tokenBudget,
      },
      gate,
      cost: {
        estimateUsd: 0,
        spentUsd: spent,
        capUsd: DEFAULTS.maxCostUsd,
        usage,
      },
      redactions: [],
      counts,
    };
    const rendered = renderReview(result);
    return {
      findings,
      gate,
      posted: [
        rendered.body,
        ...rendered.comments.map((x) => x.body),
        gate.summary,
      ],
      costUsd: spent,
    };
  };
}
