/**
 * Human-readable structured logging (TRD §15).
 *
 * Writes to stderr AND appends to .pi-coder/logs/session.log. NEVER writes to
 * stdout (reserved for the NDJSON event stream). Secrets are never logged.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  phase?: string;
  step?: number;
  tool?: string;
  duration_ms?: number;
  exit_code?: number;
  error_type?: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly logPath: string;
  private readonly taskId: string;

  constructor(opts: { logPath: string; taskId: string }) {
    this.logPath = opts.logPath;
    this.taskId = opts.taskId;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
    } catch {
      // best-effort; logging must never throw on the hot path
    }
  }

  private writeLine(level: LogLevel, message: string, fields: LogFields): void {
    const record = {
      ts: new Date().toISOString(),
      level,
      task_id: this.taskId,
      message,
      ...fields,
    };
    const line = JSON.stringify(record) + "\n";
    process.stderr.write(line);
    try {
      appendFileSync(this.logPath, line);
    } catch {
      // ignore file write failures
    }
  }

  debug(message: string, fields: LogFields = {}): void {
    this.writeLine("debug", message, fields);
  }
  info(message: string, fields: LogFields = {}): void {
    this.writeLine("info", message, fields);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.writeLine("warn", message, fields);
  }
  error(message: string, fields: LogFields = {}): void {
    this.writeLine("error", message, fields);
  }
}
