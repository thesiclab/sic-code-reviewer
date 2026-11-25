// SPDX-License-Identifier: Apache-2.0
// Secret redaction for every string sent to a model provider (and, in module 9,
// a second pass over model output). Patterns written by us.

export interface RedactionResult {
  text: string;
  counts: { kind: string; count: number }[];
}

interface Rule {
  kind: string;
  re: RegExp;
  /** Builds the replacement from the match groups; default replaces the whole match. */
  replace?: (m: string, ...groups: string[]) => string;
}

const tag = (kind: string) => `[REDACTED:${kind}]`;
// A value already redacted must not be redacted again (keeps the pass idempotent).
const NOT_REDACTED = "(?!\\[REDACTED:)";

/** Ordered: specific token shapes first, the generic assignment rule last. */
const RULES: Rule[] = [
  {
    kind: "pem-private-key",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  {
    // A BEGIN line with no END (truncated hunk): the header plus base64-looking lines after it.
    kind: "pem-private-key",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:\r?\n[+\- ]?[A-Za-z0-9+/=]{16,})*/g,
  },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    kind: "aws-secret-key",
    re: new RegExp(
      `((?:aws_?secret_?access_?key|aws_?secret(?:_?key)?)["']?\\s*[:=]\\s*["']?)${NOT_REDACTED}[A-Za-z0-9/+=]{40}`,
      "gi",
    ),
    replace: (_m, pre) => `${pre}${tag("aws-secret-key")}`,
  },
  {
    kind: "github-token",
    re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,255}\b/g,
  },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    kind: "openai-key",
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  { kind: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    kind: "bearer-token",
    re: new RegExp(
      `\\b(Bearer\\s+)${NOT_REDACTED}[A-Za-z0-9._~+/=-]{16,}`,
      "g",
    ),
    replace: (_m, pre) => `${pre}${tag("bearer-token")}`,
  },
  {
    // scheme://user:password@host -> keep user and host
    kind: "connection-string-password",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    replace: (m, pre, pw, at) =>
      pw.startsWith("[REDACTED:")
        ? m
        : `${pre}${tag("connection-string-password")}${at}`,
  },
  {
    // key|secret|token|password = "<value>" (also :, =>), quoted values of 8+ chars.
    kind: "generic-secret-assignment",
    re: new RegExp(
      `\\b([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*["']?\\s*(?:=>|:=|=|:)\\s*)(["'\`])${NOT_REDACTED}([^"'\`\\s]{8,})\\2`,
      "gi",
    ),
    replace: (_m, pre, q) =>
      `${pre}${q}${tag("generic-secret-assignment")}${q}`,
  },
];

/** Replaces secret-shaped values with [REDACTED:<kind>]. Counts only, never values. */
export function redact(text: string): RedactionResult {
  const counts = new Map<string, number>();
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const m = args[0] as string;
      const groups = args
        .slice(1, -2)
        .map((g) => (typeof g === "string" ? g : ""));
      const replacement = rule.replace
        ? rule.replace(m, ...groups)
        : tag(rule.kind);
      if (replacement !== m)
        counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return replacement;
    });
  }
  return {
    text: out,
    counts: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

/** Adds redaction counts by kind. */
export function mergeRedactionCounts(
  ...lists: RedactionResult["counts"][]
): RedactionResult["counts"] {
  const total = new Map<string, number>();
  for (const list of lists)
    for (const { kind, count } of list)
      total.set(kind, (total.get(kind) ?? 0) + count);
  return [...total].map(([kind, count]) => ({ kind, count }));
}
