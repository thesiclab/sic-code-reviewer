// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SEVERITIES } from "../types.js";
import { SEVERITY_RUBRIC } from "../findings/index.js";

export interface PromptSet {
  reviewer: string;
  adversary: string;
  counterCheck: string;
  rubric: string;
}

const FILES: Record<Exclude<keyof PromptSet, "rubric">, string> = {
  reviewer: "reviewer.md",
  adversary: "adversary.md",
  counterCheck: "counter-check.md",
};

/**
 * Loads from the action's own prompts/ directory (pinned with the action). Never from the PR head.
 *
 * When GITHUB_ACTION_PATH is set (running as an action), actionDir must be that
 * directory, so a caller cannot point the loader at the PR checkout. Each prompt
 * must be non-empty after its licence comment and must pass lintPrompt. The
 * rubric is rendered from SEVERITY_RUBRIC, which ships in the action's code.
 */
export function loadPrompts(actionDir: string): PromptSet {
  const dir = resolve(actionDir);
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (actionPath && resolve(actionPath) !== dir) {
    throw new Error(
      "loadPrompts: actionDir must be the action's own directory (GITHUB_ACTION_PATH)",
    );
  }
  const out: Partial<PromptSet> = {};
  for (const [key, file] of Object.entries(FILES) as [
    keyof typeof FILES,
    string,
  ][]) {
    const text = stripLeadingComments(
      readFileSync(join(dir, "prompts", file), "utf8"),
    );
    if (!text.trim()) throw new Error(`loadPrompts: prompts/${file} is empty`);
    const problems = lintPrompt(text);
    if (problems.length) {
      throw new Error(
        `loadPrompts: prompts/${file} tells a model to drop findings silently: ${problems.join("; ")}`,
      );
    }
    out[key] = text;
  }
  return { ...(out as Omit<PromptSet, "rubric">), rubric: renderRubric() };
}

/** Leading HTML comments (licence headers) are not prompt text. */
export function stripLeadingComments(text: string): string {
  let t = text.replace(/^﻿/, "");
  for (;;) {
    const m = /^\s*<!--[\s\S]*?-->/.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t.replace(/^\s+/, "");
}

export function renderRubric(): string {
  return SEVERITIES.map((s) => `- ${s}: ${SEVERITY_RUBRIC[s]}`).join("\n");
}

// ---------------------------------------------------------------------------
// "No prompt tells a model to drop findings silently" (plan v3 item 8).
// Models fill proof fields; code filters. These patterns catch the usual ways a
// prompt asks a model to self-filter. Quoted text ("...", `...`) is ignored, so
// a prompt may quote what injected text might say.
// ---------------------------------------------------------------------------

const F = "(?:findings?|issues?|bugs?|problems?|concerns?|comments?)";
const DROP =
  "(?:drop|discard|omit|suppress|remove|skip|filter(?:\\s+out)?|leave\\s+out|exclude|hide|ignore)";
const SILENT_DROP_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "silently/quietly drop",
    re: new RegExp(`\\b(?:silently|quietly)\\s+${DROP}`, "i"),
  },
  {
    name: "drop without telling",
    re: new RegExp(
      `\\b${DROP}\\b[^.\\n]{0,60}\\bwithout\\s+(?:reporting|mentioning|saying|noting|telling|explaining|a\\s+trace)`,
      "i",
    ),
  },
  {
    name: "only report confident findings",
    re: new RegExp(
      `\\bonly\\s+(?:report|include|output|list|flag|raise|return|post)\\b[^.\\n]{0,40}\\b${F}\\b[^.\\n]{0,40}\\b(?:confident|certain|sure|high[- ]confidence)`,
      "i",
    ),
  },
  {
    name: "do not report unsure findings",
    re: new RegExp(
      `\\b(?:do\\s+not|don't|never)\\s+(?:report|include|output|list|flag|raise|mention|return)\\b[^.\\n]{0,40}\\b${F}\\b[^.\\n]{0,50}\\b(?:unsure|not\\s+sure|uncertain|not\\s+confident|low[- ]confidence|doubt)`,
      "i",
    ),
  },
  {
    name: "drop findings conditionally",
    re: new RegExp(
      `\\b${DROP}\\b\\s+(?:any|the|those|such|all)?\\s*${F}\\b[^.\\n]{0,50}\\b(?:if|when|unless|that)\\b`,
      "i",
    ),
  },
  {
    name: "when in doubt leave it out",
    re: /\bwhen\s+in\s+doubt\b[^.\n]{0,30}\b(?:leave\s+it\s+out|omit|drop|don't\s+report|do\s+not\s+report|skip)/i,
  },
  {
    name: "empty list unless",
    re: new RegExp(
      `\\b(?:return|output|report)\\s+(?:an?\\s+)?(?:empty\\s+(?:list|array)|no\\s+${F})\\s+unless\\b`,
      "i",
    ),
  },
];

/** Returns the names of silent-drop instructions found; empty means clean. */
export function lintPrompt(text: string): string[] {
  const unquoted = text
    .replace(/"[^"\n]*"/g, '""')
    .replace(/`[^`\n]*`/g, "``")
    .replace(/“[^”\n]*”/g, '""');
  return SILENT_DROP_PATTERNS.filter((p) => p.re.test(unquoted)).map(
    (p) => p.name,
  );
}
