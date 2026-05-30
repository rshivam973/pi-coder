/**
 * Control channel: reads NDJSON commands from stdin into a queue that the
 * session drains between steps (TRD §6.4, §7.2). Transport-agnostic — the
 * platform pipes a WebSocket into this process's stdin.
 */
import { createInterface, type Interface } from "node:readline";
import { parseControlLine, type ControlCommand } from "./contracts.ts";

export interface ControlChannelOptions {
  /** Input stream. Defaults to process.stdin. Injectable for tests. */
  input?: NodeJS.ReadableStream;
  /** Called once per malformed line so the session can emit a non-fatal error. */
  onMalformed?: (line: string) => void;
}

/**
 * Buffers parsed control commands. The session calls `drain()` at each safe
 * point, or `waitForNext()` while paused on an interrupt.
 */
export class ControlChannel {
  private readonly queue: ControlCommand[] = [];
  private readonly rl: Interface | null;
  private pendingResolver: ((cmd: ControlCommand) => void) | null = null;
  private closed = false;

  constructor(opts: ControlChannelOptions = {}) {
    const input = opts.input ?? process.stdin;
    this.rl = createInterface({ input, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      const cmd = parseControlLine(line);
      if (cmd === null) {
        if (line.trim().length > 0) opts.onMalformed?.(line);
        return;
      }
      if (this.pendingResolver) {
        const resolve = this.pendingResolver;
        this.pendingResolver = null;
        resolve(cmd);
      } else {
        this.queue.push(cmd);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
    });
  }

  /** Remove and return all currently queued commands (in arrival order). */
  drain(): ControlCommand[] {
    return this.queue.splice(0, this.queue.length);
  }

  /**
   * Resolve with the next command. If one is already queued it returns
   * immediately; otherwise it waits for the next line. Used while paused on an
   * interrupt. Rejects if the channel closes with nothing pending.
   */
  waitForNext(): Promise<ControlCommand> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) {
      return Promise.reject(new Error("control channel closed"));
    }
    return new Promise((resolve) => {
      this.pendingResolver = resolve;
    });
  }

  close(): void {
    this.rl?.close();
  }
}

/** A no-op channel for `--no-input` / autonomous mode: never yields commands. */
export class NullControlChannel {
  drain(): ControlCommand[] {
    return [];
  }
  waitForNext(): Promise<ControlCommand> {
    return new Promise(() => {}); // never resolves; only entered on interrupt, which can't happen here
  }
  close(): void {}
}

export type ControlSource = Pick<ControlChannel, "drain" | "waitForNext" | "close">;
