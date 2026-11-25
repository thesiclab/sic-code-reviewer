// SPDX-License-Identifier: Apache-2.0
// A deliberately small YAML subset for .sic-code-reviewer.yml, so the action
// needs no YAML package (no runtime dependencies in v1). Supported:
//   - nested mappings by indentation (spaces only)
//   - scalars: plain, 'single' and "double" quoted, numbers, true/false, null
//   - block scalars `|` and `>` (with optional `-` / `+` chomping)
//   - `#` comments and blank lines
//   - a JSON document (JSON is valid YAML) as a whole
// Not supported (they throw): sequences, anchors and aliases, tags, flow
// mappings, multi-document files. A file that does not parse fails closed.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

export class YamlError extends Error {
  override name = "YamlError";
}

const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

function scalar(raw: string, lineNo: number): YamlValue {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s))
      throw new YamlError(`line ${lineNo}: unterminated double-quoted string`);
    return JSON.parse(s) as string;
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s))
      throw new YamlError(`line ${lineNo}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>[\]{}@`%]/.test(s) || s.startsWith("- "))
    throw new YamlError(`line ${lineNo}: unsupported YAML syntax`);
  return s;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === q && !(q === '"' && line[i - 1] === "\\")) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!)))
      return line.slice(0, i);
  }
  return line;
}

export function parseConfigYaml(text: string): YamlValue {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES)
    throw new YamlError("config file is larger than 64 KiB");
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      throw new YamlError("config looks like JSON but does not parse");
    }
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.some((l) => /^\t/.test(l) || /^ *\t/.test(l)))
    throw new YamlError("tabs are not allowed for indentation");
  if (
    lines.some((l) => /^(---|\.\.\.)\s*$/.test(l)) &&
    lines.filter((l) => /^---\s*$/.test(l)).length > 1
  )
    throw new YamlError("multi-document files are not supported");

  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const isBlank = (l: string) =>
    stripComment(l).trim() === "" || /^---\s*$/.test(l);

  function parseMap(indent: number, depth: number): { [k: string]: YamlValue } {
    if (depth > MAX_DEPTH) throw new YamlError("config nests too deeply");
    const out: { [k: string]: YamlValue } = Object.create(null) as {
      [k: string]: YamlValue;
    };
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent)
        throw new YamlError(`line ${i + 1}: unexpected indentation`);
      const body = stripComment(line).trim();
      if (body.startsWith("- ") || body === "-")
        throw new YamlError(`line ${i + 1}: lists are not supported`);
      const m =
        /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"]+"|'[^']+'):(?:\s+(.*))?$/.exec(
          body,
        );
      if (!m) throw new YamlError(`line ${i + 1}: expected "key: value"`);
      let key = m[1]!;
      if (/^["']/.test(key)) key = key.slice(1, -1);
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        throw new YamlError(`line ${i + 1}: key "${key}" is not allowed`);
      if (Object.prototype.hasOwnProperty.call(out, key))
        throw new YamlError(`line ${i + 1}: duplicate key "${key}"`);
      const rest = (m[2] ?? "").trim();
      const lineNo = i + 1;
      i++;
      const block = /^([|>])([+-]?)$/.exec(rest);
      if (block) {
        out[key] = parseBlock(indent, block[1] as "|" | ">", block[2] ?? "");
      } else if (rest === "") {
        // Nested mapping, or null when nothing more indented follows.
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) > indent) {
          i = j;
          out[key] = parseMap(indentOf(lines[j]!), depth + 1);
        } else out[key] = null;
      } else {
        out[key] = scalar(rest, lineNo);
      }
    }
    return out;
  }

  function parseBlock(
    parentIndent: number,
    style: "|" | ">",
    chomp: string,
  ): string {
    const body: string[] = [];
    let blockIndent = -1;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "") {
        body.push("");
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind <= parentIndent) break;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent) break;
      body.push(line.slice(blockIndent));
      i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    let text =
      style === "|"
        ? body.join("\n")
        : body
            .join("\n")
            .replace(/([^\n])\n(?!\n)/g, "$1 ")
            .replace(/\n\n/g, "\n");
    if (chomp === "+") text += "\n".repeat(trailing + 1);
    else if (chomp !== "-" && text) text += "\n";
    return text;
  }

  const v = parseMap(0, 0);
  // Return a plain object (the null-prototype map is only for parsing).
  return JSON.parse(JSON.stringify(v)) as YamlValue;
}
