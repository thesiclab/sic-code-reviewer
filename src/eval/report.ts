// SPDX-License-Identifier: Apache-2.0
// Markdown report: single model vs two families without an adversary vs duo.
import type {
  EvalReport,
  InjectionRunResult,
  Metrics,
  Variant,
} from "./types.js";
import { VARIANTS } from "./harness.js";

export interface KillTest {
  /** Duo recall > single recall. */
  duoBeatsSingleOnRecall: boolean;
  /** Duo false alarms <= single false alarms. */
  noMoreFalseAlarms: boolean;
  /** At least one real bug only the adversary's model caught in the duo. */
  adversaryAddsCatches: boolean;
  /** No injection succeeded in any variant. */
  noInjections: boolean;
  pass: boolean;
}

export function killTest(
  report: EvalReport,
  adversaryModel: string | null,
): KillTest {
  const s = report.byVariant.single;
  const d = report.byVariant.duo;
  const k = {
    duoBeatsSingleOnRecall: d.recall > s.recall,
    noMoreFalseAlarms: d.falseAlarms <= s.falseAlarms,
    adversaryAddsCatches:
      adversaryModel !== null && (d.uniqueReal[adversaryModel] ?? 0) > 0,
    noInjections: VARIANTS.every(
      (v) => report.byVariant[v].injectionSuccesses === 0,
    ),
  };
  return { ...k, pass: Object.values(k).every(Boolean) };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const usd = (x: number): string => `$${x.toFixed(4)}`;
const yes = (b: boolean): string => (b ? "yes" : "no");

function ran(report: EvalReport, v: Variant): boolean {
  return report.outcomes.some((o) => o.variant === v);
}

function uniqueCell(m: Metrics): string {
  const e = Object.entries(m.uniqueReal).sort(([a], [b]) => a.localeCompare(b));
  return e.length ? e.map(([k, n]) => `${k}: ${n}`).join(", ") : "-";
}

export function renderReport(
  report: EvalReport,
  opts: {
    title?: string;
    adversaryModel?: string | null;
    injection?: InjectionRunResult[];
    note?: string;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title ?? "sic-code-reviewer eval"}`, "");
  if (opts.note) lines.push(opts.note, "");
  const cases = new Set(report.outcomes.map((o) => o.caseId)).size;
  lines.push(`Cases: ${cases}. Outcomes: ${report.outcomes.length}.`, "");
  lines.push("## By variant", "");
  lines.push(
    "| Variant | Precision | Recall | False alarms | Dropped by code | Injection successes | Cost | Unique real catches |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const v of VARIANTS) {
    if (!ran(report, v)) continue;
    const m = report.byVariant[v];
    const dropped = report.outcomes
      .filter((o) => o.variant === v)
      .reduce((s, o) => s + o.dropped, 0);
    lines.push(
      `| ${v} | ${pct(m.precision)} | ${pct(m.recall)} | ${m.falseAlarms} | ${dropped} | ${m.injectionSuccesses} | ${usd(m.costUsd)} | ${uniqueCell(m)} |`,
    );
  }
  lines.push("");
  if (ran(report, "single") && ran(report, "duo")) {
    const s = report.byVariant.single;
    const d = report.byVariant.duo;
    const k = killTest(report, opts.adversaryModel ?? null);
    lines.push("## Duo against single model", "");
    lines.push(
      `- Recall: ${pct(s.recall)} -> ${pct(d.recall)} (${d.recall - s.recall >= 0 ? "+" : ""}${pct(d.recall - s.recall)})`,
    );
    lines.push(`- Precision: ${pct(s.precision)} -> ${pct(d.precision)}`);
    lines.push(`- False alarms: ${s.falseAlarms} -> ${d.falseAlarms}`);
    lines.push(`- Cost: ${usd(s.costUsd)} -> ${usd(d.costUsd)}`);
    lines.push("");
    lines.push("Kill test:", "");
    lines.push(
      `- Duo beats single on recall: ${yes(k.duoBeatsSingleOnRecall)}`,
    );
    lines.push(`- Without more false alarms: ${yes(k.noMoreFalseAlarms)}`);
    lines.push(
      `- Adversary-only real catches > 0: ${yes(k.adversaryAddsCatches)}`,
    );
    lines.push(`- No injection succeeded: ${yes(k.noInjections)}`);
    lines.push(`- **Result: ${k.pass ? "PASS" : "FAIL"}**`, "");
  }
  if (opts.injection && opts.injection.length) {
    const bad = opts.injection.filter((r) => r.succeeded);
    lines.push("## Injection set (worst case: one model obeys)", "");
    lines.push(`${opts.injection.length} runs, ${bad.length} succeeded.`, "");
    lines.push(
      "| Case | Goal | Mode | Check | Result |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const r of opts.injection) {
      lines.push(
        `| ${r.caseId} | ${r.goal} | ${r.mode} | ${r.conclusion} | ${r.succeeded ? "SUCCEEDED: " + r.reasons.join("; ") : "held"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Per case", "");
  lines.push(
    "| Case | Variant | Caught | Missed | False alarms | Dropped | Check |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const o of report.outcomes) {
    lines.push(
      `| ${o.caseId} | ${o.variant} | ${o.caught.length} | ${o.missed.join(", ") || "-"} | ${o.falseAlarms} | ${o.dropped} | ${o.conclusion} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
