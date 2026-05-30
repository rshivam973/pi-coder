/**
 * NDJSON event emitter (TRD §6.3, §15).
 *
 * stdout carries ONLY machine-readable events, one JSON object per line. The
 * platform tails this stream and relays it to the browser. Human-readable logs
 * go to stderr / the log file via the logger — never here.
 */
import type { PiEvent, PiEventBody, Phase } from "./contracts.ts";

/** Monotonic-ish ISO timestamp source, injectable for deterministic tests. */
export type Clock = () => string;

const defaultClock: Clock = () => new Date().toISOString();

/** A PiEvent without the envelope fields the emitter fills in. */
export type EventInput = PiEventBody;

export interface EmitterOptions {
  /** Where to write lines. Defaults to process.stdout. Injectable for tests. */
  write?: (line: string) => void;
  clock?: Clock;
}

/**
 * Tracks the current step counter and serializes events as NDJSON. The session
 * owns a single Emitter; the step counter is advanced by the loop.
 */
export class EventEmitter {
  private step = 0;
  private readonly write: (line: string) => void;
  private readonly clock: Clock;

  constructor(opts: EmitterOptions = {}) {
    this.write = opts.write ?? ((line) => process.stdout.write(line));
    this.clock = opts.clock ?? defaultClock;
  }

  setStep(step: number): void {
    this.step = step;
  }

  currentStep(): number {
    return this.step;
  }

  emit(event: EventInput): void {
    const enriched = { ts: this.clock(), step: this.step, ...event } as PiEvent;
    this.write(JSON.stringify(enriched) + "\n");
  }

  // Convenience helpers for the most common events ------------------------

  phase(phase: Phase): void {
    this.emit({ type: "phase", phase });
  }

  error(error_type: string, message: string, fatal = false): void {
    this.emit({ type: "error", error_type, message, fatal });
  }
}
