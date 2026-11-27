// SPDX-License-Identifier: Apache-2.0
// Claude reviewer through the official Claude Code CLI (`claude -p`), for a
// `claude setup-token` subscription token in CI. Anthropic's terms allow that
// token in CI pipelines with the unmodified official CLI, so this adapter only
// ever runs the CLI: it never sends the token to the Messages API or to any
// other endpoint, and never sets a base URL (no gateway).
//
// Shape of one call:
//   - a fresh private work dir (0700) is the child's cwd and HOME, so no
//     CLAUDE.md, settings, hooks or MCP config from the runner or the checkout
//     are loaded;
//   - the role prompt goes in a 0600 file (--system-prompt-file), the user
//     text on stdin, the JSON schema in --json-schema;
//   - no tools (--tools ""), no MCP servers (--strict-mcp-config), nothing may
//     prompt (--permission-mode dontAsk), one turn, no session saved;
//   - the token is passed ONLY in the child's environment as
//     CLAUDE_CODE_OAUTH_TOKEN; never in argv, never logged, scrubbed from every
//     error message;
//   - the child gets a minimal environment, not the runner's: no
//     ANTHROPIC_API_KEY, no ANTHROPIC_BASE_URL, no other secrets;
//   - a hard timeout kills the process group.
// Any CLI error, timeout or unparseable envelope fails the call; the role then
// fails and the run goes neutral (the existing model-failure path). The model's
// JSON is validated by our own schema check either way (fail closed).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelError, ModelRequest, ModelSpec } from "../types.js";
import type { CostMeter } from "../cost/index.js";
import { estimateTokens } from "../cost/index.js";
import {
  meterCharger,
  runComplete,
  shortMessage,
  toProviderSchema,
  type ModelAdapter,
  type SendResult,
} from "./adapters.js";

export interface ClaudeCliOptions {
  /** The setup-token value. Goes only into the child's environment. */
  token: string;
  timeoutMs: number;
  meter: CostMeter;
  /**
   * Executable to run. A function resolves it lazily (the pinned install).
   * Default: "claude" looked up on `path`.
   */
  command?: string | (() => Promise<string>);
  /** PATH for the child. Default: this process's PATH. */
  path?: string;
  /** Parent directory for the per-call private work dir. Default: os.tmpdir(). */
  tmpRoot?: string;
  /** Stdout cap; a bigger envelope is treated as a failure. Default 16 MiB. */
  maxStdoutBytes?: number;
}

const STDERR_KEEP = 4096;
const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;

/** The argv for one call. Exported for tests; never contains the token. */
export function buildClaudeArgs(
  spec: ModelSpec,
  req: ModelRequest,
  systemPromptFile: string,
): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(toProviderSchema(req.schema)),
    "--model",
    spec.model,
    "--max-turns",
    "1",
    "--system-prompt-file",
    systemPromptFile,
    // Variadic flag: "" means no built-in tools. The next argument is a flag,
    // which ends the list.
    "--tools",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
}

/** The child's whole environment. Exported for tests. */
export function buildClaudeEnv(
  token: string,
  workDir: string,
  path: string,
  maxOutputTokens: number,
): Record<string, string> {
  return {
    PATH: path,
    HOME: workDir,
    XDG_CONFIG_HOME: join(workDir, ".config"),
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Remove the token (and anything token-shaped) before a message leaves this module. */
export function scrubToken(text: string, token: string): string {
  let t = text;
  if (token) t = t.split(token).join("[redacted]");
  t = t.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return shortMessage(t);
}

type RunOutcome =
  | { kind: "spawn-error"; code: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "too-big" }
  | { kind: "exit"; code: number | null; stdout: string; stderr: string };

function runChild(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  stdin: string,
  timeoutMs: number,
  maxStdout: number,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (o: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        kind: "spawn-error",
        code: (e as NodeJS.ErrnoException)?.code ?? "error",
      });
      return;
    }
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      kill();
      done({ kind: "timeout" });
    }, timeoutMs);
    const onAbort = () => {
      kill();
      done({ kind: "aborted" });
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    child.stdout!.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > maxStdout) {
        kill();
        done({ kind: "too-big" });
        return;
      }
      out.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      err = (err + b.toString("utf8")).slice(-STDERR_KEEP);
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      done({ kind: "spawn-error", code: e.code ?? "error" }),
    );
    child.on("close", (code) =>
      done({
        kind: "exit",
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: err,
      }),
    );
    child.stdin!.on("error", () => {
      /* EPIPE when the child exits early; the exit code tells the story */
    });
    child.stdin!.end(stdin, "utf8");
  });
}

interface CliResult {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  structured_output?: unknown;
  stop_reason?: unknown;
  terminal_reason?: unknown;
  api_error_status?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  } | null;
}

/** The result envelope from `--output-format json` (an object, or an array ending in one). */
export function parseCliEnvelope(stdout: string): CliResult | null {
  const text = stdout.trim();
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const e = v[i] as CliResult | null;
      if (e && typeof e === "object" && e.type === "result") return e;
    }
    return null;
  }
  if (v && typeof v === "object" && (v as CliResult).type === "result")
    return v as CliResult;
  return null;
}

const nonNeg = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;

/**
 * Tokens the CLI reports, or null when it reports none. Unknown usage is
 * charged at the worst case (the full reservation), so the cost meter fails
 * safe rather than counting the call as free.
 */
export function cliUsage(
  r: CliResult,
): { inputTokens: number; outputTokens: number } | null {
  const u = r.usage;
  if (!u || typeof u !== "object") return null;
  const input = nonNeg(u.input_tokens);
  const output = nonNeg(u.output_tokens);
  if (input === undefined || output === undefined) return null;
  return {
    inputTokens:
      input +
      (nonNeg(u.cache_read_input_tokens) ?? 0) +
      (nonNeg(u.cache_creation_input_tokens) ?? 0),
    outputTokens: output,
  };
}

export function createClaudeCliAdapter(
  spec: ModelSpec,
  opts: ClaudeCliOptions,
): ModelAdapter {
  const token = opts.token;
  const fail = (error: ModelError): SendResult => ({ ok: false, error });
  const send = async (req: ModelRequest): Promise<SendResult> => {
    if (!token)
      return fail({
        kind: "config",
        message: "no setup-token in the configured environment variable",
      });
    if (spec.baseUrl)
      return fail({
        kind: "config",
        message: "claude-cli never uses a base URL (no gateway)",
      });
    let command: string;
    try {
      command =
        typeof opts.command === "function"
          ? await opts.command()
          : (opts.command ?? "claude");
    } catch (e) {
      return fail({
        kind: "config",
        message: scrubToken(
          `claude CLI not available: ${e instanceof Error ? e.message : "error"}`,
          token,
        ),
      });
    }
    const workDir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "sic-claude-"));
    try {
      const sysFile = join(workDir, "system-prompt.md");
      writeFileSync(sysFile, req.system, { encoding: "utf8", mode: 0o600 });
      const outcome = await runChild(
        command,
        buildClaudeArgs(spec, req, sysFile),
        buildClaudeEnv(
          token,
          workDir,
          opts.path ?? process.env.PATH ?? "",
          req.maxOutputTokens,
        ),
        workDir,
        req.user,
        opts.timeoutMs,
        opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT,
        req.signal,
      );
      if (outcome.kind === "spawn-error")
        return fail({
          kind: "config",
          message: `claude CLI could not start (${outcome.code.replace(/[^A-Z0-9_]/gi, "")})`,
        });
      if (outcome.kind === "timeout")
        return fail({
          kind: "timeout",
          message: `claude CLI gave no result within ${opts.timeoutMs} ms`,
        });
      if (outcome.kind === "aborted")
        return fail({ kind: "timeout", message: "aborted" });
      if (outcome.kind === "too-big")
        return fail({
          kind: "invalid-json",
          message: "claude CLI output over the size cap",
        });

      const env = parseCliEnvelope(outcome.stdout);
      if (!env) {
        if (outcome.code !== 0)
          return fail({
            kind: "http",
            message: scrubToken(
              `claude CLI exited with code ${outcome.code ?? "signal"}: ${outcome.stderr.trim() || "no output"}`,
              token,
            ),
          });
        return fail({
          kind: "invalid-json",
          message: "claude CLI output was not a JSON result envelope",
        });
      }
      const usage = cliUsage(env);
      const inputTokens =
        usage?.inputTokens ??
        estimateTokens(req.system + req.user + JSON.stringify(req.schema));
      const outputTokens = usage?.outputTokens ?? req.maxOutputTokens;

      if (env.stop_reason === "refusal")
        return {
          ok: true,
          text: "",
          inputTokens,
          outputTokens,
          refusal: "provider declined",
        };
      if (
        env.is_error === true ||
        env.subtype !== "success" ||
        outcome.code !== 0
      ) {
        const status = nonNeg(env.api_error_status);
        const what = [env.subtype, env.terminal_reason]
          .filter((x): x is string => typeof x === "string")
          .join("/");
        const detail = typeof env.result === "string" ? env.result : "";
        const err: ModelError = {
          kind: "http",
          message: scrubToken(
            `claude CLI error${what ? ` (${what})` : ""}${outcome.code ? ` exit ${outcome.code}` : ""}${detail ? `: ${detail}` : ""}`,
            token,
          ),
        };
        if (status !== undefined) err.status = status;
        return fail(err);
      }
      // The CLI's validated structured output when present; otherwise the
      // reply text. Our own schema check runs on it either way.
      const text =
        env.structured_output !== undefined && env.structured_output !== null
          ? JSON.stringify(env.structured_output)
          : typeof env.result === "string"
            ? env.result
            : "";
      return { ok: true, text, inputTokens, outputTokens };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };
  const charger = meterCharger(spec, opts.meter);
  return {
    spec,
    complete: (req, validate) => runComplete(charger, send, req, validate),
  };
}
