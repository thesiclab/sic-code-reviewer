// SPDX-License-Identifier: Apache-2.0
// Config from trusted sources only: action inputs and the BASE-commit
// .sic-code-reviewer.yml. Fencing, redaction, sanitising, the proof rule and
// the fail-closed gate have no config keys.
//
// Precedence: built-in defaults < action inputs < base-branch file, for the
// keys the base file may set (models, budget, caps, guidance). check-name,
// bot-logins and allow-second-provider-on-private come from the action inputs
// only: they decide whose reviews are trusted and where code may go, so they
// belong to the workflow owner, not to a config file.
//
// Errors throw. The read job turns a throw into a neutral check (never green).
import { createHash } from "node:crypto";
import type { ModelSpec, ProviderKind } from "../types.js";
import { CONTEXT_DEFAULTS, type ContextOptions } from "../context/index.js";
import { resolveFamily } from "../models/index.js";
import { parseConfigYaml, type YamlValue } from "./yaml.js";

export { parseConfigYaml } from "./yaml.js";

export interface Config {
  reviewer: ModelSpec;
  adversary: ModelSpec | null;
  maxCostUsd: number;
  maxDiffLines: number;
  context: ContextOptions;
  maxInline: number;
  /** Fixed at 2 in v1; config may lower it, not raise it. */
  repeatCap: number;
  botLogins: string[];
  allowSecondProviderOnPrivate: boolean;
  guidance: string | null;
  checkName: string;
}

export const DEFAULTS = {
  maxCostUsd: 2.0,
  maxDiffLines: 5000,
  tokenBudget: 60000,
  maxInline: 10,
  repeatCap: 2,
  checkName: "sic-code-reviewer",
  botLogins: ["github-actions[bot]"],
  maxOutputTokens: 16000,
} as const;

/** Upper bounds that keep a typo from turning into a large bill or a huge prompt. */
export const LIMITS = {
  maxCostUsd: 100,
  maxDiffLines: 50000,
  tokenBudget: 400000,
  maxInline: 50,
  maxOutputTokens: 128000,
  guidanceChars: 4000,
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

const MODEL_KEYS = new Set([
  "provider",
  "model",
  "family",
  "base-url",
  "api-key-env",
  "max-output-tokens",
  "price-in-per-mtok",
  "price-out-per-mtok",
]);
const CONTEXT_KEYS = new Set([
  "token-budget",
  "max-callers-per-symbol",
  "max-callees-per-symbol",
  "repo-map-max-tokens",
]);
const TOP_KEYS = new Set([
  "reviewer",
  "adversary",
  "max-cost-usd",
  "max-diff-lines",
  "context",
  "max-inline",
  "repeat-cap",
  "guidance",
]);

type Obj = Record<string, YamlValue>;
const isObj = (v: YamlValue | undefined): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: YamlValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function num(
  v: string | YamlValue | undefined,
  name: string,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  )
    throw new ConfigError(
      `${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`,
    );
  return n;
}

function bool(v: string | undefined, name: string): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  if (/^(true|yes|1)$/i.test(v)) return true;
  if (/^(false|no|0)$/i.test(v)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

/** https anywhere; plain http only to loopback or private addresses (a self-hosted runner's local model). */
export function checkBaseUrl(raw: string, name: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (u.username || u.password)
    throw new ConfigError(`${name} must not carry credentials`);
  if (u.protocol === "https:") return raw.replace(/\/+$/, "");
  const h = u.hostname;
  const privateHost =
    h === "localhost" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith(".svc.cluster.local");
  if (u.protocol === "http:" && privateHost) return raw.replace(/\/+$/, "");
  throw new ConfigError(
    `${name} must use https (plain http is allowed only to a private address)`,
  );
}

interface ModelFields {
  provider?: string;
  model?: string;
  family?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxOutputTokens?: string | number;
  priceIn?: string | number;
  priceOut?: string | number;
}

function fromInputs(i: Record<string, string>, role: string): ModelFields {
  const g = (k: string) => {
    const v = i[`${role}-${k}`];
    return v === undefined || v === "" ? undefined : v;
  };
  const out: ModelFields = {};
  const set = <K extends keyof ModelFields>(
    k: K,
    v: ModelFields[K] | undefined,
  ) => {
    if (v !== undefined) out[k] = v;
  };
  set("provider", g("provider"));
  set("model", g("model"));
  set("family", g("family"));
  set("baseUrl", g("base-url"));
  set("apiKeyEnv", g("api-key-env"));
  set("maxOutputTokens", g("max-output-tokens"));
  set("priceIn", g("price-in-per-mtok"));
  set("priceOut", g("price-out-per-mtok"));
  return out;
}

function fromFile(o: Obj, role: string, warnings: string[]): ModelFields {
  for (const k of Object.keys(o))
    if (!MODEL_KEYS.has(k))
      warnings.push(`config: unknown key ${role}.${k} ignored`);
  const out: ModelFields = {};
  const set = <K extends keyof ModelFields>(
    k: K,
    v: ModelFields[K] | undefined,
  ) => {
    if (v !== undefined) out[k] = v;
  };
  set("provider", str(o["provider"]));
  set("model", str(o["model"]));
  set("family", str(o["family"]));
  set("baseUrl", str(o["base-url"]));
  set("apiKeyEnv", str(o["api-key-env"]));
  set("maxOutputTokens", str(o["max-output-tokens"]));
  set("priceIn", str(o["price-in-per-mtok"]));
  set("priceOut", str(o["price-out-per-mtok"]));
  return out;
}

function buildSpec(role: string, f: ModelFields): ModelSpec {
  const provider = (f.provider ?? "").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai-compatible")
    throw new ConfigError(
      `${role}-provider must be 'anthropic' or 'openai-compatible'`,
    );
  if (!f.model) throw new ConfigError(`${role}-model is required`);
  if (!/^[\w.:/@-]{1,128}$/.test(f.model))
    throw new ConfigError(
      `${role}-model has characters a model id does not use`,
    );
  const apiKeyEnv =
    f.apiKeyEnv ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : undefined);
  if (!apiKeyEnv) throw new ConfigError(`${role}-api-key-env is required`);
  if (!ENV_NAME.test(apiKeyEnv))
    throw new ConfigError(
      `${role}-api-key-env must be the NAME of an environment variable (A-Z, 0-9, _), never a key`,
    );
  let baseUrl: string | undefined;
  if (provider === "openai-compatible") {
    if (!f.baseUrl)
      throw new ConfigError(
        `${role}-base-url is required for openai-compatible`,
      );
    baseUrl = checkBaseUrl(f.baseUrl, `${role}-base-url`);
  } else if (f.baseUrl) {
    baseUrl = checkBaseUrl(f.baseUrl, `${role}-base-url`);
  }
  const priceIn = num(f.priceIn, `${role}-price-in-per-mtok`, 0, 1000);
  const priceOut = num(f.priceOut, `${role}-price-out-per-mtok`, 0, 1000);
  if (priceIn === undefined || priceOut === undefined)
    throw new ConfigError(
      `${role}-price-in-per-mtok and ${role}-price-out-per-mtok are required: the cost cap cannot hold without prices`,
    );
  const family = resolveFamily(provider as ProviderKind, f.model, f.family);
  const spec: ModelSpec = {
    provider: provider as ProviderKind,
    model: f.model,
    family,
    apiKeyEnv,
    maxOutputTokens:
      num(
        f.maxOutputTokens,
        `${role}-max-output-tokens`,
        256,
        LIMITS.maxOutputTokens,
        true,
      ) ?? DEFAULTS.maxOutputTokens,
    priceInPerMTok: priceIn,
    priceOutPerMTok: priceOut,
  };
  if (baseUrl) spec.baseUrl = baseUrl;
  return spec;
}

/** Canonical JSON (sorted keys) so the hash does not depend on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function loadConfig(
  actionInputs: Record<string, string>,
  baseFile: string | null,
): { config: Config; configHash: string; warnings: string[] } {
  const warnings: string[] = [];
  const inputs = actionInputs;

  let file: Obj = {};
  if (baseFile !== null && baseFile.trim()) {
    const parsed = parseConfigYaml(baseFile);
    if (!isObj(parsed))
      throw new ConfigError(
        ".sic-code-reviewer.yml must be a mapping at the top level",
      );
    file = parsed;
    for (const k of Object.keys(file))
      if (!TOP_KEYS.has(k))
        warnings.push(
          `config: unknown or not-allowed key "${k}" in .sic-code-reviewer.yml ignored`,
        );
  }

  // Reviewer
  const rvFile = file["reviewer"];
  if (rvFile !== undefined && !isObj(rvFile))
    throw new ConfigError(
      "reviewer in .sic-code-reviewer.yml must be a mapping",
    );
  const reviewer = buildSpec("reviewer", {
    provider: "anthropic",
    ...fromInputs(inputs, "reviewer"),
    ...(isObj(rvFile) ? fromFile(rvFile, "reviewer", warnings) : {}),
  });

  // Adversary ("none" turns it off; the run is then labelled single family)
  const advFile = file["adversary"];
  let adversary: ModelSpec | null;
  const advInputs: ModelFields = {
    provider: "openai-compatible",
    apiKeyEnv: "ZAI_API_KEY",
    ...fromInputs(inputs, "adversary"),
  };
  const advFields: ModelFields =
    advFile === "none" || advFile === null
      ? { provider: "none" }
      : isObj(advFile)
        ? { ...advInputs, ...fromFile(advFile, "adversary", warnings) }
        : advFile === undefined
          ? advInputs
          : (() => {
              throw new ConfigError(
                "adversary in .sic-code-reviewer.yml must be a mapping or 'none'",
              );
            })();
  if ((advFields.provider ?? "").toLowerCase() === "none") {
    adversary = null;
    warnings.push(
      "config: no adversary configured; the review runs single family and is never labelled a duo verdict",
    );
  } else {
    adversary = buildSpec("adversary", advFields);
    if (adversary.family === reviewer.family)
      warnings.push(
        `config: reviewer and adversary are both ${reviewer.family}; the review is labelled single family`,
      );
  }

  const ctxFile = file["context"];
  if (ctxFile !== undefined && !isObj(ctxFile))
    throw new ConfigError(
      "context in .sic-code-reviewer.yml must be a mapping",
    );
  if (isObj(ctxFile))
    for (const k of Object.keys(ctxFile))
      if (!CONTEXT_KEYS.has(k))
        warnings.push(`config: unknown key context.${k} ignored`);
  const c = isObj(ctxFile) ? ctxFile : {};
  const context: ContextOptions = {
    tokenBudget:
      num(
        c["token-budget"],
        "context.token-budget",
        1000,
        LIMITS.tokenBudget,
        true,
      ) ?? DEFAULTS.tokenBudget,
    maxCallersPerSymbol:
      num(
        c["max-callers-per-symbol"],
        "context.max-callers-per-symbol",
        0,
        50,
        true,
      ) ?? CONTEXT_DEFAULTS.maxCallersPerSymbol,
    maxCalleesPerSymbol:
      num(
        c["max-callees-per-symbol"],
        "context.max-callees-per-symbol",
        0,
        50,
        true,
      ) ?? CONTEXT_DEFAULTS.maxCalleesPerSymbol,
    repoMapMaxTokens:
      num(
        c["repo-map-max-tokens"],
        "context.repo-map-max-tokens",
        0,
        20000,
        true,
      ) ?? CONTEXT_DEFAULTS.repoMapMaxTokens,
  };

  const maxCostUsd =
    num(str(file["max-cost-usd"]), "max-cost-usd", 0.01, LIMITS.maxCostUsd) ??
    num(inputs["max-cost-usd"], "max-cost-usd", 0.01, LIMITS.maxCostUsd) ??
    DEFAULTS.maxCostUsd;
  const maxDiffLines =
    num(
      str(file["max-diff-lines"]),
      "max-diff-lines",
      1,
      LIMITS.maxDiffLines,
      true,
    ) ?? DEFAULTS.maxDiffLines;
  const maxInline =
    num(str(file["max-inline"]), "max-inline", 0, LIMITS.maxInline, true) ??
    DEFAULTS.maxInline;
  const wantedCap = num(str(file["repeat-cap"]), "repeat-cap", 0, 100, true);
  if (wantedCap !== undefined && wantedCap > DEFAULTS.repeatCap)
    warnings.push(
      `config: repeat-cap may be lowered, not raised; using ${DEFAULTS.repeatCap}`,
    );
  const repeatCap = Math.min(
    wantedCap ?? DEFAULTS.repeatCap,
    DEFAULTS.repeatCap,
  );

  let guidance: string | null = null;
  const g = file["guidance"];
  if (g !== undefined && g !== null) {
    if (typeof g !== "string") throw new ConfigError("guidance must be text");
    guidance = g.trim() || null;
    if (guidance && guidance.length > LIMITS.guidanceChars) {
      guidance = guidance.slice(0, LIMITS.guidanceChars);
      warnings.push(
        `config: guidance cut to ${LIMITS.guidanceChars} characters`,
      );
    }
  }

  const botLogins = (inputs["bot-logins"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const l of botLogins)
    if (!LOGIN.test(l))
      throw new ConfigError(`bot-logins: "${l}" is not a GitHub login`);
  const checkName = (inputs["check-name"] ?? "").trim() || DEFAULTS.checkName;
  if (checkName.length > 100 || /[\r\n]/.test(checkName))
    throw new ConfigError("check-name must be one short line");

  const config: Config = {
    reviewer,
    adversary,
    maxCostUsd,
    maxDiffLines,
    context,
    maxInline,
    repeatCap,
    botLogins: botLogins.length ? botLogins : [...DEFAULTS.botLogins],
    allowSecondProviderOnPrivate:
      bool(
        inputs["allow-second-provider-on-private"],
        "allow-second-provider-on-private",
      ) ?? false,
    guidance,
    checkName,
  };
  const configHash = createHash("sha256")
    .update(`sic-code-reviewer:config:v1\n${canonical(config)}`)
    .digest("hex");
  return { config, configHash, warnings };
}
