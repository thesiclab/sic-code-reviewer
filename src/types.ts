// SPDX-License-Identifier: Apache-2.0
// Shared types for sic-code-reviewer. This file is the canonical source for
// every cross-module type named in CONTRACT.md. Changing a type here is an
// interface change: stop and report (CONTRACT.md, "Changing the contract").

// ---------------------------------------------------------------------------
// Severity (5-level rubric, adopted from Comfy prompt-judge.md; see
// src/findings/severity.ts for the rubric text and the derived-code header)
// ---------------------------------------------------------------------------

export const SEVERITIES = ["critical", "high", "medium", "low", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severities that fail the gate when they survive. */
export const BLOCKING_SEVERITIES: readonly Severity[] = ["critical", "high"];

export type Lens = "correctness" | "security" | "tests" | "scope";

// ---------------------------------------------------------------------------
// Diff (module 1)
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** New-side line number; undefined for deletions. */
  newLine?: number;
  /** Old-side line number; undefined for additions. */
  oldLine?: number;
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Function context git printed after the second @@, if any. */
  header: string;
  lines: DiffLine[];
}

export type FileClass =
  | "source"
  | "test"
  | "lockfile"
  | "generated"
  | "binary"
  | "vendored"
  | "docs"
  | "config";

export interface FilePatch {
  oldPath: string | null; // null = added
  newPath: string | null; // null = deleted
  status: "added" | "deleted" | "modified" | "renamed" | "mode";
  fileClass: FileClass;
  hunks: Hunk[];
  /** The raw section text from `diff --git` to the next one, byte for byte. */
  raw: string;
}

export interface PatchSet {
  baseSha: string;
  headSha: string;
  /** The merge base this round diffed against; recorded in the round sentinel. */
  mergeBase: string;
  files: FilePatch[];
  /** The full unified diff text (mergeBase..head), the thing under review. */
  fullText: string;
  /**
   * "Newest hunks" hint: sections of fullText changed since the last reviewed
   * round. Always a byte-for-byte subset of fullText, or null when there is no
   * prior round or the subset check failed.
   */
  incrementalText: string | null;
  /** Files excluded from model input by size cap or class, with the reason. */
  excluded: NotRead[];
  /** Deterministic notes on lockfile changes (packages changed, install scripts). */
  lockfileNotes: string[];
}

/** path -> set of new-side line numbers a RIGHT-side review comment may anchor to. */
export type AnchorMap = Map<string, Set<number>>;

// ---------------------------------------------------------------------------
// Context (module 2)
// ---------------------------------------------------------------------------

export type ContextKind =
  | "hunks"
  | "changed-function"
  | "caller"
  | "callee"
  | "test"
  | "repo-map"
  | "static-analysis";

export interface ContextItem {
  kind: ContextKind;
  path: string;
  /** Inclusive new-side line range, when the item is a slice of a file. */
  startLine?: number;
  endLine?: number;
  /** The symbol that pulled this item in (for caller/callee/test). */
  symbol?: string;
  /** Rendered text with line numbers, already redacted. */
  text: string;
  tokens: number;
}

export interface NotRead {
  kind: ContextKind | "file";
  path: string;
  reason:
    | "budget"
    | "size-cap"
    | "lockfile"
    | "generated"
    | "binary"
    | "vendored"
    | "unreadable";
  detail?: string;
}

export interface ContextBundle {
  items: ContextItem[];
  notRead: NotRead[];
  tokensUsed: number;
  tokenBudget: number;
}

// ---------------------------------------------------------------------------
// Findings (modules 5, 6)
// ---------------------------------------------------------------------------

/** What a model returns per finding. Proof fields are mandatory in the schema. */
export interface RawFinding {
  file: string;
  line: number;
  /** Optional end of a line range. */
  endLine?: number;
  lens: Lens;
  severity: Severity;
  title: string;
  /** Concrete inputs -> wrong result, or an attack vector. */
  failureScenario: string;
  /** Short explanation; rendered as the comment body. */
  body: string;
  /** True when the bug exists on the base branch too (not introduced here). */
  preExisting: boolean;
  /** Set only when re-raising an answered ledger entry (module 8). */
  repeatOf?: string;
}

export type FindingOrigin = "reviewer" | "adversary";

/** A finding after code assigned an opaque id and recorded who raised it. */
export interface Finding extends RawFinding {
  /** Opaque, e.g. "F3". Shown to models; never reveals origin. */
  id: string;
  /** Hidden from the adversary prompt (module 5); kept for eval attribution. */
  origin: FindingOrigin;
  /** Model id that raised it; hidden from every prompt. */
  raisedByModel: string;
  /** Stable fingerprint: sha256(file, normalized title, lens) -> 12 hex. */
  fingerprint: string;
}

export type AdversaryVerdictKind = "upheld" | "dismissed" | "disputed";

export interface AdversaryVerdict {
  findingId: string;
  verdict: AdversaryVerdictKind;
  reason: string;
  /**
   * The code line(s) that refute the finding, quoted verbatim. Required by
   * code for dismissing critical/high; a dismissal whose quote is missing or
   * not found verbatim in the prompt's diff/context is turned into "disputed".
   */
  refutingQuote?: string;
  refutingFile?: string;
  refutingLine?: number;
}

export type Placement =
  | "inline" // anchored to a diff line, may gate
  | "body" // valid proof but anchor outside the diff; in the review body, may gate
  | "pre-existing" // own section, never gates
  | "dismissed" // knocked down with reason (and quote when required); never gates
  | "disputed" // contested without a verified quote; never gates
  | "dropped"; // failed the proof rule; only in the run artifact

export interface FilteredFinding extends Finding {
  placement: Placement;
  /** Why code placed it there (e.g. "no failure scenario", "line not in diff"). */
  placementReason: string;
  adversary?: AdversaryVerdict;
}

// ---------------------------------------------------------------------------
// Models (module 4)
// ---------------------------------------------------------------------------

export type ProviderKind =
  | "claude-cli"
  | "anthropic"
  | "openai-compatible"
  | "fake";

export interface ModelSpec {
  provider: ProviderKind;
  model: string;
  /** Model family, e.g. "claude", "glm", "gpt", "gemini", "qwen". Resolved by models/family.ts. */
  family: string;
  /** Base URL for openai-compatible providers. Never set for claude-cli. */
  baseUrl?: string;
  /** Name of the env var holding the key (or, for claude-cli, the setup-token); never the value itself. */
  apiKeyEnv?: string;
  maxOutputTokens: number;
  /** USD per million tokens, for the cost meter. */
  priceInPerMTok: number;
  priceOutPerMTok: number;
}

export interface ModelRequest {
  system: string;
  user: string;
  /** JSON Schema the response must satisfy. */
  schema: JsonSchema;
  schemaName: string;
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ModelResult<T> =
  | {
      ok: true;
      value: T;
      usage: ModelUsage;
      repaired: boolean;
      rawText: string;
    }
  | { ok: false; error: ModelError; usage: ModelUsage };

export interface ModelError {
  kind:
    | "http"
    | "timeout"
    | "invalid-json"
    | "schema"
    | "refusal"
    | "budget"
    | "config";
  message: string;
  status?: number;
}

export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Gate (module 7)
// ---------------------------------------------------------------------------

export type CheckConclusion = "success" | "failure" | "neutral";

export interface GateResult {
  conclusion: CheckConclusion;
  /** One-line human reason, e.g. "2 high-severity findings survived". */
  summary: string;
  reasons: GateReason[];
  blockingFindingIds: string[];
}

export type GateReason =
  | { kind: "blocking-findings"; count: number }
  | {
      kind: "model-failure";
      role: "reviewer" | "adversary" | "counter-check";
      error: ModelError;
    }
  | { kind: "budget-exhausted"; spentUsd: number; capUsd: number }
  | { kind: "estimate-over-cap"; estimateUsd: number; capUsd: number }
  | { kind: "single-family"; family: string }
  | { kind: "fork-not-reviewed" }
  | { kind: "diff-over-cap"; lines: number; cap: number }
  | { kind: "cached"; cacheKey: string };

// ---------------------------------------------------------------------------
// Memory (module 8)
// ---------------------------------------------------------------------------

export interface LedgerReply {
  author: string;
  /** PR author or OWNER/MEMBER/COLLABORATOR. Only these count as answers. */
  isAuthorOrMaintainer: boolean;
  body: string;
}

export interface LedgerEntry {
  round: number;
  fingerprint: string;
  file: string;
  line: number | null;
  severity: Severity;
  title: string;
  body: string;
  /** Permalink of the inline thread; null for body-placed findings. */
  discussionUrl: string | null;
  resolved: boolean;
  outdated: boolean;
  replies: LedgerReply[];
  answered: boolean;
}

export interface RoundSentinel {
  v: 1;
  round: number;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  cacheKey: string;
  conclusion: CheckConclusion;
}

export interface Ledger {
  rounds: number;
  last: RoundSentinel | null;
  entries: LedgerEntry[];
  /** Disclosed in the prompt when caps drop anything. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Cost (module 10)
// ---------------------------------------------------------------------------

export interface CostEstimate {
  calls: {
    role: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    usd: number;
  }[];
  totalUsd: number;
}

// ---------------------------------------------------------------------------
// Run result: the artifact the read job hands to the write job
// ---------------------------------------------------------------------------

export interface ReviewResult {
  schemaVersion: 1;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  cacheKey: string;
  round: number;
  reviewer: { model: string; family: string };
  adversary: { model: string; family: string } | null;
  /** Providers that received code, for the data-flow statement. */
  providersSawCode: string[];
  findings: FilteredFinding[];
  notRead: NotRead[];
  coverage: {
    filesInDiff: number;
    filesRead: number;
    tokensUsed: number;
    tokenBudget: number;
  };
  gate: GateResult;
  cost: {
    estimateUsd: number;
    spentUsd: number;
    capUsd: number;
    usage: ModelUsage[];
  };
  redactions: { kind: string; count: number }[];
  /** Counts by placement, including "dropped", for the eval. */
  counts: Record<Placement, number>;
}
