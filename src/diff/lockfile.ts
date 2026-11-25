// SPDX-License-Identifier: Apache-2.0
// Deterministic notes on lockfile changes. Lockfile bodies never go to a model;
// these notes do (fenced as LOCKFILE NOTES). Package names come from PR bytes,
// so the notes are data, never instructions; each name is length-capped.
import type { FilePatch, Hunk } from "../types.js";

const MAX_ITEMS = 40;
const MAX_NAME = 120;

interface Change {
  name: string;
  from?: string;
  to?: string;
}

const clip = (s: string): string =>
  s.length > MAX_NAME ? `${s.slice(0, MAX_NAME)}...` : s;

/** Shared walk: track the current package from key lines, record version lines added/removed. */
function walk(
  hunks: Hunk[],
  keyOf: (text: string) => string | null,
  versionOf: (text: string) => string | null,
  installOf: (text: string) => boolean,
): { changes: Map<string, Change>; installScripts: Set<string> } {
  const changes = new Map<string, Change>();
  const installScripts = new Set<string>();
  for (const h of hunks) {
    let current: string | null = h.header ? keyOf(h.header) : null;
    for (const l of h.lines) {
      const k = keyOf(l.text);
      if (k !== null) {
        current = k;
        continue;
      }
      if (l.kind === "ctx") continue;
      const v = versionOf(l.text);
      const name = current ?? "(unknown package)";
      if (v !== null) {
        const c = changes.get(name) ?? { name };
        if (l.kind === "add") c.to = v;
        else c.from = v;
        changes.set(name, c);
      } else if (l.kind === "add" && installOf(l.text)) {
        installScripts.add(name);
      }
    }
  }
  return { changes, installScripts };
}

const npmKey = (t: string): string | null => {
  const m = /^\s*"((?:[^"\\]|\\.)*node_modules\/(?:[^"\\]|\\.)+)":\s*\{/.exec(
    t,
  );
  if (!m) return null;
  const p = m[1]!;
  return p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length);
};
const npmVersion = (t: string): string | null =>
  /^\s*"version":\s*"([^"]*)"/.exec(t)?.[1] ?? null;

const yarnKey = (t: string): string | null => {
  if (/^\s/.test(t) || t.startsWith("#") || !t.trimEnd().endsWith(":"))
    return null;
  const first = t.split(",")[0]!.trim().replace(/^"/, "");
  const at = first.lastIndexOf("@");
  return at > 0 ? first.slice(0, at) : first.replace(/:$/, "");
};
const yarnVersion = (t: string): string | null =>
  /^\s+version:?\s+"?([^"\s]+)"?/.exec(t)?.[1] ?? null;

/** Cargo.lock, poetry.lock, uv.lock, pdm.lock: `name = "x"` then `version = "y"`. */
const tomlKey = (t: string): string | null =>
  /^name\s*=\s*"([^"]*)"/.exec(t)?.[1] ?? null;
const tomlVersion = (t: string): string | null =>
  /^version\s*=\s*"([^"]*)"/.exec(t)?.[1] ?? null;

/** pnpm-lock.yaml: package keys carry the version, e.g. `  /foo@1.2.3:` or `  foo@1.2.3:`. */
function pnpmChanges(hunks: Hunk[]): {
  changes: Map<string, Change>;
  installScripts: Set<string>;
} {
  const changes = new Map<string, Change>();
  const installScripts = new Set<string>();
  const re = /^ {2}'?\/?((?:@[^/@\s]+\/)?[^@\s/']+)@([^:(\s']+)[^:]*'?:\s*$/;
  for (const h of hunks) {
    let current: string | null = null;
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) {
        current = m[1]!;
        if (l.kind !== "ctx") {
          const c = changes.get(m[1]!) ?? { name: m[1]! };
          if (l.kind === "add") c.to = m[2]!;
          else c.from = m[2]!;
          changes.set(m[1]!, c);
        }
        continue;
      }
      if (l.kind === "add" && /^\s+requiresBuild:\s*true/.test(l.text))
        installScripts.add(current ?? "(unknown package)");
    }
  }
  return { changes, installScripts };
}

/** go.sum: `module version[/go.mod] hash` per line. */
function goSumChanges(hunks: Hunk[]): Map<string, Change> {
  const changes = new Map<string, Change>();
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "ctx") continue;
      const m = /^(\S+)\s+(v[^\s/]+)(\/go\.mod)?\s+\S+/.exec(l.text);
      if (!m || m[3]) continue;
      const c = changes.get(m[1]!) ?? { name: m[1]! };
      if (l.kind === "add") c.to = m[2]!;
      else c.from = m[2]!;
      changes.set(m[1]!, c);
    }
  }
  return changes;
}

/** Gemfile.lock: `    name (version)`. */
function gemChanges(hunks: Hunk[]): Map<string, Change> {
  const changes = new Map<string, Change>();
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "ctx") continue;
      const m = /^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)\s*$/.exec(l.text);
      if (!m) continue;
      const c = changes.get(m[1]!) ?? { name: m[1]! };
      if (l.kind === "add") c.to = m[2]!;
      else c.from = m[2]!;
      changes.set(m[1]!, c);
    }
  }
  return changes;
}

function summarise(
  path: string,
  changes: Map<string, Change>,
  installScripts: Set<string>,
): string {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const c of [...changes.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (c.from !== undefined && c.to !== undefined) {
      if (c.from !== c.to)
        changed.push(`${clip(c.name)} ${clip(c.from)} -> ${clip(c.to)}`);
    } else if (c.to !== undefined) added.push(`${clip(c.name)} ${clip(c.to)}`);
    else if (c.from !== undefined)
      removed.push(`${clip(c.name)} ${clip(c.from)}`);
  }
  const parts: string[] = [];
  const list = (label: string, xs: string[]): void => {
    if (!xs.length) return;
    const shown = xs.slice(0, MAX_ITEMS);
    const more =
      xs.length > shown.length ? `, and ${xs.length - shown.length} more` : "";
    parts.push(`${label} (${xs.length}): ${shown.join(", ")}${more}`);
  };
  list("added", added);
  list("removed", removed);
  list("changed", changed);
  list("new install scripts", [...installScripts].sort().map(clip));
  if (!parts.length)
    return `${clip(path)}: changed, no package version changes recognised`;
  return `${clip(path)}: ${parts.join("; ")}`;
}

function lineCounts(file: FilePatch): string {
  let a = 0;
  let d = 0;
  for (const h of file.hunks)
    for (const l of h.lines)
      l.kind === "add" ? a++ : l.kind === "del" ? d++ : 0;
  return `${a} lines added, ${d} removed`;
}

/** One note per lockfile in the patch. */
export function lockfileNote(file: FilePatch): string {
  const path = file.newPath ?? file.oldPath ?? "(unknown)";
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (file.fileClass === "binary" || file.hunks.length === 0) {
    return `${clip(path)}: ${file.status}, binary or no text hunks; contents not parsed`;
  }
  switch (base) {
    case "package-lock.json":
    case "npm-shrinkwrap.json": {
      const r = walk(file.hunks, npmKey, npmVersion, (t) =>
        /^\s*"hasInstallScript":\s*true/.test(t),
      );
      return summarise(path, r.changes, r.installScripts);
    }
    case "yarn.lock": {
      const r = walk(file.hunks, yarnKey, yarnVersion, () => false);
      return summarise(path, r.changes, r.installScripts);
    }
    case "pnpm-lock.yaml": {
      const r = pnpmChanges(file.hunks);
      return summarise(path, r.changes, r.installScripts);
    }
    case "cargo.lock":
    case "poetry.lock":
    case "uv.lock":
    case "pdm.lock": {
      const r = walk(file.hunks, tomlKey, tomlVersion, () => false);
      return summarise(path, r.changes, r.installScripts);
    }
    case "go.sum":
    case "go.work.sum":
      return summarise(path, goSumChanges(file.hunks), new Set());
    case "gemfile.lock":
      return summarise(path, gemChanges(file.hunks), new Set());
    default:
      return `${clip(path)}: ${file.status}, ${lineCounts(file)}; format not parsed`;
  }
}
