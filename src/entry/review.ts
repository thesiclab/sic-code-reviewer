// SPDX-License-Identifier: Apache-2.0
// Entrypoint: the READ job (CONTRACT.md section 2). Runs with contents:read,
// pull-requests:read and the model keys. Never posts, never sets a check: it
// writes review-result.json, which the post job validates and acts on.
//
// Fail closed: any model failure, invalid output after repair, budget
// exhaustion or internal error ends in a neutral verdict, never green.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readInputs, readPrEvent, type PrEvent } from "./env.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdversaryVerdict,
  ContextBundle,
  FilteredFinding,
  Finding,
  GateReason,
  ModelError,
  ModelResult,
  ModelSpec,
  NotRead,
  Placement,
  ReviewResult,
} from "../types.js";
import { loadConfig as realLoadConfig, type Config } from "../config/index.js";
import {
  anchorableLines,
  buildPatchSet,
  countDiffLines,
  createGit,
  type Git,
} from "../diff/index.js";
import { buildContext } from "../context/index.js";
import {
  loadPrompts,
  mergeRedactionCounts,
  redact,
  type PromptInputs,
  type PromptSet,
} from "../prompts/index.js";
import {
  createAnthropicAdapter,
  createOpenAICompatAdapter,
  familyCheck,
  type ModelAdapter,
} from "../models/index.js";
import {
  assignIds,
  runAdversaryDetailed,
  runCounterCheckDetailed,
  runReviewerDetailed,
} from "../roles/index.js";
import { filterFindings } from "../findings/index.js";
import {
  enforceRepeatCap,
  LEDGER_DEFAULTS,
  loadLedger,
  renderLedger,
} from "../memory/index.js";
import {
  cacheKey,
  createSentinelCache,
  decide,
  type CacheStore,
} from "../gate/index.js";
import { createMeter, estimate, type CostMeter } from "../cost/index.js";
import { createGitHubReader, type GitHubReader } from "../github/index.js";
import { PLACEMENT_LIST } from "../output/shapes.js";

/** Base-branch config file, read from the BASE commit only. */
export const CONFIG_PATH = ".sic-code-reviewer.yml";

export interface ReviewDeps {
  repo: string;
  prNumber: number;
  /** The pinned action's own directory: prompts load from here, never from the PR. */
  actionDir: string;
  actionVersion: string;
  /** Action inputs (lower-case names, as in action.yml). */
  inputs: Record<string, string>;
  gh: GitHubReader;
  git: Git;
  /** Builds an adapter charged against the run's meter. */
  createAdapter: (spec: ModelSpec, meter: CostMeter) => ModelAdapter;
  cache?: CacheStore;
  loadConfig?: typeof realLoadConfig;
  prompts?: PromptSet;
  warn?: (msg: string) => void;
}

export function countPlacements(
  findings: FilteredFinding[],
): Record<Placement, number> {
  const out = Object.fromEntries(PLACEMENT_LIST.map((p) => [p, 0])) as Record<
    Placement,
    number
  >;
  for (const f of findings) out[f.placement]++;
  return out;
}

export function promptHash(p: PromptSet): string {
  return createHash("sha256")
    .update(
      JSON.stringify([p.reviewer, p.adversary, p.counterCheck, p.rubric]),
      "utf8",
    )
    .digest("hex");
}

function emptyResult(
  repo: string,
  pr: number,
  headSha: string,
  baseSha: string,
  config: Pick<Config, "reviewer" | "adversary" | "maxCostUsd"> | null,
): ReviewResult {
  return {
    schemaVersion: 1,
    repo,
    prNumber: pr,
    headSha,
    baseSha,
    mergeBase: "",
    cacheKey: "",
    round: 1,
    reviewer: config
      ? { model: config.reviewer.model, family: config.reviewer.family }
      : { model: "", family: "" },
    adversary: config?.adversary
      ? { model: config.adversary.model, family: config.adversary.family }
      : null,
    providersSawCode: [],
    findings: [],
    notRead: [],
    coverage: { filesInDiff: 0, filesRead: 0, tokensUsed: 0, tokenBudget: 0 },
    gate: decide({ findings: [], failures: [] }),
    cost: {
      estimateUsd: 0,
      spentUsd: 0,
      capUsd: config?.maxCostUsd ?? 0,
      usage: [],
    },
    redactions: [],
    counts: countPlacements([]),
  };
}

/**
 * The artifact for a run that crashed. There is no "internal error" gate
 * reason in the contract, so it is reported as a reviewer failure of kind
 * "config"; the result is neutral either way.
 */
export function errorResult(
  repo: string,
  pr: number,
  headSha: string,
  baseSha: string,
  err: unknown,
): ReviewResult {
  const name = err instanceof Error ? err.name : "Error";
  const error: ModelError = {
    kind: "config",
    message: `review job failed before a verdict (${name})`,
  };
  const r = emptyResult(repo, pr, headSha, baseSha, null);
  r.gate = decide({
    findings: [],
    failures: [{ kind: "model-failure", role: "reviewer", error }],
  });
  return r;
}

const providerLabel = (s: ModelSpec) => `${s.provider}:${s.model}`;
const sameProvider = (a: ModelSpec, b: ModelSpec) =>
  a.provider === b.provider && (a.baseUrl ?? "") === (b.baseUrl ?? "");

export async function runReview(d: ReviewDeps): Promise<ReviewResult> {
  const warn = d.warn ?? (() => {});
  const pr = await d.gh.getPr(d.repo, d.prNumber);

  // Trusted config only: action inputs + the BASE commit's file.
  const baseFile = await d.git.show(pr.baseSha, CONFIG_PATH);
  const { config, configHash, warnings } = (d.loadConfig ?? realLoadConfig)(
    d.inputs,
    baseFile,
  );
  warnings.forEach(warn);

  const stop = (
    failures: GateReason[],
    over: Partial<ReviewResult> = {},
  ): ReviewResult => {
    const r = {
      ...emptyResult(d.repo, d.prNumber, pr.headSha, pr.baseSha, config),
      ...over,
    };
    r.gate = decide({ findings: r.findings, failures });
    return r;
  };

  if (pr.isFork) return stop([{ kind: "fork-not-reviewed" }]);

  // Private repos send code to a second provider only when the owner opted in.
  let adversarySpec = config.adversary;
  if (
    adversarySpec &&
    pr.isPrivateRepo &&
    !config.allowSecondProviderOnPrivate &&
    !sameProvider(config.reviewer, adversarySpec)
  ) {
    warn(
      "private repository: the adversary's provider is not opted in (allowSecondProviderOnPrivate); running single family",
    );
    adversarySpec = null;
  }

  let ledger;
  try {
    ledger = await loadLedger(d.gh, d.repo, d.prNumber, {
      ...LEDGER_DEFAULTS,
      botLogins: config.botLogins,
    });
  } catch {
    warn("could not read earlier review rounds; continuing without the ledger");
    ledger = { rounds: 0, last: null, entries: [], truncated: false };
  }
  const round = (ledger.last?.round ?? 0) + 1;

  const patch = await buildPatchSet(d.git, pr.baseSha, pr.headSha, {
    maxDiffLines: config.maxDiffLines,
    previous: ledger.last,
  });
  if (ledger.last && patch.incrementalText === null)
    warn("newest-hunks hint unavailable this round");
  const base = {
    mergeBase: patch.mergeBase,
    round,
    notRead: [...patch.excluded],
  };

  const lines = countDiffLines(patch);
  if (lines > config.maxDiffLines) {
    return stop([{ kind: "diff-over-cap", lines, cap: config.maxDiffLines }], {
      ...base,
      coverage: {
        filesInDiff: patch.files.length,
        filesRead: 0,
        tokensUsed: 0,
        tokenBudget: 0,
      },
    });
  }

  const prompts = d.prompts ?? loadPrompts(d.actionDir);
  const key = cacheKey({
    headSha: pr.headSha,
    mergeBase: patch.mergeBase,
    configHash,
    promptHash: promptHash(prompts),
    reviewer: providerLabel(config.reviewer),
    adversary: adversarySpec ? providerLabel(adversarySpec) : null,
    actionVersion: d.actionVersion,
  });
  const cache = d.cache ?? createSentinelCache(d.gh, d.repo, d.prNumber);
  try {
    const hit = await cache.get(key);
    if (hit)
      return {
        ...hit,
        repo: d.repo,
        prNumber: d.prNumber,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        cacheKey: key,
      };
  } catch {
    warn("cache lookup failed; reviewing");
  }

  const context: ContextBundle = await buildContext(
    d.git,
    patch,
    config.context,
  );
  const notRead: NotRead[] = [...patch.excluded, ...context.notRead];
  const unreadFiles = new Set(
    notRead.filter((n) => n.kind === "file").map((n) => n.path),
  );
  const coverage = {
    filesInDiff: patch.files.length,
    filesRead: patch.files.filter(
      (f) => !unreadFiles.has(f.newPath ?? f.oldPath ?? ""),
    ).length,
    tokensUsed: context.tokensUsed,
    tokenBudget: context.tokenBudget,
  };

  const est = estimate(patch, context, config.reviewer, adversarySpec);
  const common = {
    ...base,
    cacheKey: key,
    notRead,
    coverage,
    adversary: adversarySpec
      ? { model: adversarySpec.model, family: adversarySpec.family }
      : null,
  };
  if (est.totalUsd > config.maxCostUsd) {
    return stop(
      [
        {
          kind: "estimate-over-cap",
          estimateUsd: est.totalUsd,
          capUsd: config.maxCostUsd,
        },
      ],
      {
        ...common,
        cost: {
          estimateUsd: est.totalUsd,
          spentUsd: 0,
          capUsd: config.maxCostUsd,
          usage: [],
        },
      },
    );
  }

  const meter = createMeter(config.maxCostUsd);
  const failures: GateReason[] = [];
  const fam = familyCheck(config.reviewer, adversarySpec);
  if (!fam.ok) failures.push(fam.reason);

  const reviewerAdapter = d.createAdapter(config.reviewer, meter);
  const adversaryAdapter = adversarySpec
    ? d.createAdapter(adversarySpec, meter)
    : null;
  const providers = new Set<string>();
  let redactions = redact([pr.title, pr.body].join("\n")).counts;

  const track = <T>(
    run: {
      result: ModelResult<T>;
      redactions: { kind: string; count: number }[];
    },
    role: "reviewer" | "adversary" | "counter-check",
    spec: ModelSpec,
  ): T | null => {
    providers.add(providerLabel(spec));
    redactions = mergeRedactionCounts(redactions, run.redactions);
    if (run.result.ok) return run.result.value;
    const error = run.result.error;
    failures.push(
      error.kind === "budget"
        ? {
            kind: "budget-exhausted",
            spentUsd: meter.spentUsd,
            capUsd: meter.capUsd,
          }
        : { kind: "model-failure", role, error },
    );
    return null;
  };

  const inputs: PromptInputs = {
    prompts,
    patch,
    context,
    prTitle: pr.title,
    prBody: pr.body,
    ledgerText: null,
    guidance: config.guidance,
  };

  let reviewer: Finding[] = [];
  let adversaryVerdicts: AdversaryVerdict[] = [];
  let adversaryMissed: Finding[] = [];
  let counterVerdicts: AdversaryVerdict[] = [];
  let shownText = "";

  const rv = await runReviewerDetailed(
    { adapter: reviewerAdapter, prompts },
    { ...inputs, ledgerText: renderLedger(ledger, "reviewer") },
  );
  shownText = rv.shownText;
  const rvOut = track(rv, "reviewer", config.reviewer);
  if (rvOut)
    reviewer = assignIds(rvOut.findings, "reviewer", config.reviewer.model, 1);

  // Once a model call fails, stop calling models: keep what was produced, neutral.
  if (rvOut && adversaryAdapter && adversarySpec) {
    const av = await runAdversaryDetailed(
      { adapter: adversaryAdapter, prompts },
      {
        ...inputs,
        ledgerText: renderLedger(ledger, "adversary"),
        findings: reviewer,
      },
    );
    shownText = av.shownText || shownText;
    const avOut = track(av, "adversary", adversarySpec);
    if (avOut) {
      adversaryVerdicts = avOut.verdicts;
      adversaryMissed = assignIds(
        avOut.missed,
        "adversary",
        adversarySpec.model,
        reviewer.length + 1,
      );
      if (adversaryMissed.length > 0) {
        const cv = await runCounterCheckDetailed(
          { adapter: reviewerAdapter, prompts },
          {
            ...inputs,
            ledgerText: renderLedger(ledger, "adversary"),
            findings: adversaryMissed,
          },
        );
        const cvOut = track(cv, "counter-check", config.reviewer);
        if (cvOut) counterVerdicts = cvOut.verdicts;
      }
    }
  }

  let findings = filterFindings({
    reviewer,
    adversaryVerdicts,
    adversaryMissed,
    counterVerdicts,
    anchors: anchorableLines(patch.fullText) ?? new Map(),
    shownText:
      shownText ||
      [patch.fullText, ...context.items.map((i) => i.text)].join("\n"),
    maxInline: config.maxInline,
  });
  findings = enforceRepeatCap(findings, ledger, config.repeatCap);
  const gate = decide({ findings, failures });

  const result: ReviewResult = {
    schemaVersion: 1,
    repo: d.repo,
    prNumber: d.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    ...common,
    reviewer: { model: config.reviewer.model, family: config.reviewer.family },
    providersSawCode: [...providers],
    findings,
    gate,
    cost: {
      estimateUsd: est.totalUsd,
      spentUsd: meter.spentUsd,
      capUsd: meter.capUsd,
      usage: meter.usage(),
    },
    redactions,
    counts: countPlacements(findings),
  };
  if (gate.conclusion !== "neutral") {
    try {
      await cache.put(key, result);
    } catch {
      /* cache is an optimisation */
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Process wiring (GitHub Actions)
// ---------------------------------------------------------------------------

export { readInputs, readPrEvent, type PrEvent } from "./env.js";

/** Directory of the pinned action: GITHUB_ACTION_PATH, else two levels above this file. */
export function resolveActionDir(env: NodeJS.ProcessEnv): string {
  return (
    env.GITHUB_ACTION_PATH ||
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  );
}

export function readActionVersion(actionDir: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(actionDir, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** An adapter that always fails with a config error (for example a missing key), so the run goes neutral. */
function failingAdapter(spec: ModelSpec, message: string): ModelAdapter {
  return {
    spec,
    async complete() {
      return {
        ok: false,
        error: { kind: "config", message },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}

export function realAdapterFactory(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
) {
  return (spec: ModelSpec, meter: CostMeter): ModelAdapter => {
    const apiKey = spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined;
    if (!apiKey)
      return failingAdapter(
        spec,
        `no API key in the configured environment variable for ${spec.model}`,
      );
    const opts = { fetch: fetchImpl, apiKey, timeoutMs: 180_000, meter };
    if (spec.provider === "anthropic")
      return createAnthropicAdapter(spec, opts);
    if (spec.provider === "openai-compatible")
      return createOpenAICompatAdapter(spec, opts);
    return failingAdapter(spec, "the fake provider is for tests only");
  };
}

/** Code-written warning to the Actions log. Never pass model or PR text here. */
function logWarning(msg: string): void {
  process.stderr.write(`::warning::${msg.replace(/[\r\n%]/g, " ")}\n`);
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const inputs = readInputs(env);
  const out =
    inputs["result-path"] ||
    resolve(env.RUNNER_TEMP ?? ".", "review-result.json");
  let ev: PrEvent;
  try {
    ev = readPrEvent(env);
  } catch (e) {
    logWarning(
      `not a pull request run (${e instanceof Error ? e.name : "Error"})`,
    );
    return 1;
  }
  let result: ReviewResult;
  let code = 0;
  try {
    const actionDir = resolveActionDir(env);
    result = await runReview({
      repo: ev.repo,
      prNumber: ev.prNumber,
      actionDir,
      actionVersion: readActionVersion(actionDir),
      inputs,
      gh: createGitHubReader(
        inputs["github-token"] ?? "",
        fetch,
        env.GITHUB_API_URL || undefined,
      ),
      git: createGit(env.GITHUB_WORKSPACE ?? process.cwd()),
      createAdapter: realAdapterFactory(env, fetch),
      warn: logWarning,
    });
  } catch (e) {
    process.stderr.write(
      `::error::sic-code-reviewer review failed (${e instanceof Error ? e.name : "Error"})\n`,
    );
    result = errorResult(ev.repo, ev.prNumber, ev.headSha, ev.baseSha, e);
    code = 1;
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return code;
}
