// SPDX-License-Identifier: Apache-2.0
// Entrypoint: eval-cli. Run by a person, never by CI with keys.
//
//   eval-cli [--planted DIR] [--injection DIR] [--aacr FILE --aacr-repo DIR] [--limit N]
//            [--variants single,two-families-no-adversary,duo]
//            (--fake | --models models.json) [--out report.md] [--json out.json]
//
// --fake uses deterministic scripted models (no keys, no network).
// --models reads {"reviewer": ModelSpec, "adversary": ModelSpec|null}; keys come
// from the env vars each spec names in apiKeyEnv. The run cap is --max-cost (default $2 per run of the CLI).
// Exit code: 0 ok, 1 an injection succeeded, 2 usage or setup error.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelSpec } from "../types.js";
import type { ModelAdapter } from "../models/index.js";
import {
  createAnthropicAdapter,
  createOpenAICompatAdapter,
} from "../models/index.js";
import { createMeter } from "../cost/index.js";
import { createGit } from "../diff/index.js";
import {
  actionDir,
  createDefaultPipeline,
  createSkilledFake,
  fakeSpec,
  hydrateAacr,
  loadAacrBenchEntries,
  loadInjectionSet,
  loadPlantedSet,
  renderReport,
  runEvalWith,
  runInjectionSet,
  VARIANTS,
  type EvalCase,
  type EvalPipeline,
  type InjectionRunResult,
  type Variant,
} from "../eval/index.js";

export interface CliArgs {
  planted: string | null;
  injection: string | null;
  aacr: string | null;
  aacrRepo: string | null;
  limit: number | undefined;
  variants: Variant[];
  fake: boolean;
  models: string | null;
  out: string | null;
  json: string | null;
  maxCost: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    planted: null,
    injection: null,
    aacr: null,
    aacrRepo: null,
    limit: undefined,
    variants: [...VARIANTS],
    fake: false,
    models: null,
    out: null,
    json: null,
    maxCost: 2,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case "--planted":
        a.planted = val();
        break;
      case "--injection":
        a.injection = val();
        break;
      case "--aacr":
        a.aacr = val();
        break;
      case "--aacr-repo":
        a.aacrRepo = val();
        break;
      case "--limit":
        a.limit = Number(val());
        break;
      case "--variants": {
        const vs = val()
          .split(",")
          .map((s) => s.trim()) as Variant[];
        for (const v of vs)
          if (!VARIANTS.includes(v)) throw new Error(`unknown variant ${v}`);
        a.variants = vs;
        break;
      }
      case "--fake":
        a.fake = true;
        break;
      case "--models":
        a.models = val();
        break;
      case "--out":
        a.out = val();
        break;
      case "--json":
        a.json = val();
        break;
      case "--max-cost":
        a.maxCost = Number(val());
        break;
      default:
        throw new Error(`unknown argument ${k}`);
    }
  }
  if (a.fake === (a.models !== null))
    throw new Error("pass exactly one of --fake or --models");
  if (a.aacr && !a.aacrRepo)
    throw new Error(
      "--aacr needs --aacr-repo (a local clone to read diffs from)",
    );
  if (!a.planted && !a.injection && !a.aacr) {
    a.planted = join(actionDir(), "eval", "planted");
    a.injection = join(actionDir(), "eval", "injection");
  }
  return a;
}

function realAdapters(
  path: string,
  maxCost: number,
  env: NodeJS.ProcessEnv,
): { reviewer: ModelAdapter; adversary: ModelAdapter | null } {
  const specs = JSON.parse(readFileSync(path, "utf8")) as {
    reviewer: ModelSpec;
    adversary: ModelSpec | null;
  };
  const meter = createMeter(maxCost);
  const make = (s: ModelSpec): ModelAdapter => {
    const apiKey = s.apiKeyEnv ? env[s.apiKeyEnv] : undefined;
    if (!apiKey)
      throw new Error(
        `no key: set the env var named in apiKeyEnv for ${s.model}`,
      );
    const opts = { fetch: globalThis.fetch, apiKey, timeoutMs: 180_000, meter };
    return s.provider === "anthropic"
      ? createAnthropicAdapter(s, opts)
      : createOpenAICompatAdapter(s, opts);
  };
  return {
    reviewer: make(specs.reviewer),
    adversary: specs.adversary ? make(specs.adversary) : null,
  };
}

export interface CliIo {
  log: (s: string) => void;
  env: NodeJS.ProcessEnv;
  pipeline?: EvalPipeline;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIo = { log: (s) => console.log(s), env: process.env },
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.log(`eval-cli: ${(e as Error).message}`);
    return 2;
  }
  const pipeline = io.pipeline ?? createDefaultPipeline();
  const cases: EvalCase[] = [];
  if (args.planted) cases.push(...loadPlantedSet(args.planted));
  if (args.aacr && args.aacrRepo) {
    const git = createGit(args.aacrRepo);
    for (const e of loadAacrBenchEntries(args.aacr, args.limit))
      cases.push(await hydrateAacr(git, e));
  }
  const injectionCases = args.injection ? loadInjectionSet(args.injection) : [];

  let adapters: { reviewer: ModelAdapter; adversary: ModelAdapter | null };
  if (args.fake) {
    const all = [...cases, ...injectionCases];
    adapters = {
      reviewer: createSkilledFake(fakeSpec("fake-claude", "claude"), all, {
        catchRate: 0.7,
        falseAlarmRate: 0.3,
        dismissesFalseAlarms: false,
        seed: "r",
      }),
      adversary: createSkilledFake(fakeSpec("fake-glm", "glm"), all, {
        catchRate: 0.6,
        falseAlarmRate: 0.2,
        dismissesFalseAlarms: true,
        seed: "a",
      }),
    };
  } else {
    try {
      adapters = realAdapters(args.models as string, args.maxCost, io.env);
    } catch (e) {
      io.log(`eval-cli: ${(e as Error).message}`);
      return 2;
    }
  }
  const variants = adapters.adversary
    ? args.variants
    : args.variants.filter((v) => v === "single");
  const report = await runEvalWith(cases, variants, adapters, pipeline);
  // Worst-case injection runs use obeying fakes; a live injection eval runs the cases through the real models instead.
  let injection: InjectionRunResult[] = [];
  if (injectionCases.length) {
    if (args.fake) injection = await runInjectionSet(injectionCases, pipeline);
    else {
      const live = await runEvalWith(
        injectionCases,
        variants,
        adapters,
        pipeline,
      );
      report.outcomes.push(...live.outcomes);
      for (const v of variants)
        report.byVariant[v].injectionSuccesses +=
          live.byVariant[v].injectionSuccesses;
    }
  }
  const md = renderReport(report, {
    adversaryModel: adapters.adversary?.spec.model ?? null,
    injection,
    ...(args.fake
      ? {
          note: "Scripted fake models (no network). Numbers show the harness works, not model quality.",
        }
      : {}),
  });
  if (args.out) writeFileSync(args.out, md);
  else io.log(md);
  if (args.json)
    writeFileSync(args.json, JSON.stringify({ report, injection }, null, 2));
  const injectionFailed =
    injection.some((r) => r.succeeded) ||
    variants.some((v) => report.byVariant[v].injectionSuccesses > 0);
  return injectionFailed ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`eval-cli: ${(e as Error).message}`);
      process.exit(2);
    },
  );
}
