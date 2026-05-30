/**
 * Subprocess execution primitive (TRD §9 `run`, §13 command timeouts).
 *
 * Every shell/git/test command in pi-coder goes through here so that timeouts,
 * cwd, env scrubbing, output capture, and log files are handled in one place.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ExecOptions {
  cwd: string;
  /** Per-command timeout in ms. Default 120_000 (TRD §13). */
  timeoutMs?: number;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
  /** When false, strip common proxy/network env vars (best-effort, TRD §13). */
  allowNetwork?: boolean;
  /** Global abort signal (wall-clock timeout / stop). */
  signal?: AbortSignal;
  /** If set, combined output is appended to this file. */
  logPath?: string;
}

export interface ExecResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  logPath: string | null;
}

const NETWORK_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/**
 * Run a shell command string via `bash -lc`. Resolves with the captured result;
 * never throws on a non-zero exit (callers inspect exitCode).
 */
export async function exec(command: string, opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = performance.now();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(opts.env ?? {}),
  };
  if (opts.allowNetwork === false) {
    for (const key of NETWORK_ENV_KEYS) delete env[key];
  }

  const proc = Bun.spawn({
    cmd: ["bash", "-c", command],
    cwd: opts.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = (await proc.exited) ?? -1;

  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  const durationMs = Math.round(performance.now() - start);

  let logPath: string | null = null;
  if (opts.logPath) {
    logPath = opts.logPath;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `$ ${command}\n${stdout}${stderr}\n[exit ${exitCode}${timedOut ? " TIMEOUT" : ""} in ${durationMs}ms]\n\n`,
      );
    } catch {
      // logging is best-effort
    }
  }

  return { command, exitCode, durationMs, stdout, stderr, timedOut, logPath };
}
