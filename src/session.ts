/**
 * The interactive agent loop (TRD §7). One model step per iteration via the AI
 * SDK, draining the control queue between steps so the user can chat, ask
 * status, interrupt/resume, or stop. Emits live NDJSON events from the model
 * stream. An AbortController enforces the wall-clock timeout and hard stop.
 */
import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { EventEmitter } from "./events.ts";
import type { Logger } from "./logger.ts";
import type { ControlSource } from "./control.ts";
import type { RunState } from "./tools.ts";
import type { Task, Phase } from "./contracts.ts";

export type StopReason =
  | "finished" // model called finish
  | "stop_command" // user sent stop
  | "max_steps"
  | "timeout"
  | "error";

export interface SessionResult {
  reason: StopReason;
  steps: number;
}

export interface SessionOptions {
  model: LanguageModel;
  tools: ToolSet;
  systemPrompt: string;
  task: Task;
  state: RunState;
  emitter: EventEmitter;
  logger: Logger;
  control: ControlSource;
  signal: AbortSignal;
  /** performance.now() baseline for elapsed reporting. */
  startedAt: number;
}

function skillToPhase(skill: string | null): Phase {
  switch (skill) {
    case "prd-maker":
    case "trd-maker":
      return "plan";
    case "coding":
      return "code";
    case "testing":
      return "test";
    case "code-reviewer":
      return "review";
    case "git":
      return "git";
    default:
      return "plan";
  }
}

export class Session {
  constructor(private readonly opts: SessionOptions) {}

  async run(): Promise<SessionResult> {
    const { task, state, emitter, signal } = this.opts;
    const messages: ModelMessage[] = [
      { role: "user", content: "Start working on the task now. Begin by loading the using-skills skill." },
    ];
    let step = 0;

    while (step < task.constraints.max_steps) {
      if (signal.aborted) return { reason: "timeout", steps: step };
      if (state.finish) return { reason: "finished", steps: step };

      // --- safe point: drain control commands -----------------------------
      const controlOutcome = await this.drainControl(messages);
      if (controlOutcome === "stop") return { reason: "stop_command", steps: step };

      step++;
      emitter.setStep(step);
      this.syncPhase();

      try {
        const result = streamText({
          model: this.opts.model,
          system: this.opts.systemPrompt,
          messages,
          tools: this.opts.tools,
          stopWhen: stepCountIs(1),
          abortSignal: signal,
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              if (part.text) emitter.emit({ type: "llm_text", text: part.text });
              break;
            case "tool-call":
              emitter.emit({ type: "tool_call", tool: part.toolName, args: part.input });
              break;
            case "tool-result":
              emitter.emit({
                type: "tool_result",
                tool: part.toolName,
                ok: true,
                summary: summarizeOutput(part.output),
              });
              break;
            case "tool-error":
              emitter.emit({
                type: "tool_result",
                tool: part.toolName,
                ok: false,
                summary: String((part.error as Error)?.message ?? part.error),
              });
              break;
            case "error":
              emitter.error("stream_error", String((part.error as Error)?.message ?? part.error), false);
              break;
          }
        }

        messages.push(...(await result.response).messages);
        this.syncPhase();
        if (state.finish) return { reason: "finished", steps: step };
      } catch (err) {
        if (signal.aborted) return { reason: "timeout", steps: step };
        this.opts.logger.error("step failed", { step, error_type: "step_error" });
        emitter.error("step_error", (err as Error).message, false);
        // transient: let the loop try again on the next step
      }
    }

    return { reason: "max_steps", steps: step };
  }

  /** Map the active skill to a phase and emit a phase event on change. */
  private lastPhase: Phase | null = null;
  private syncPhase(): void {
    const phase = skillToPhase(this.opts.state.currentSkill);
    this.opts.state.phase = phase;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.opts.emitter.phase(phase);
    }
  }

  /**
   * Process all queued control commands. Returns "stop" if the session should
   * end, otherwise "continue". Handles interrupt by blocking until resume/stop.
   */
  private async drainControl(messages: ModelMessage[]): Promise<"continue" | "stop"> {
    for (const cmd of this.opts.control.drain()) {
      const outcome = this.applyCommand(cmd, messages);
      if (outcome === "stop") return "stop";
      if (outcome === "interrupt") {
        const r = await this.handleInterrupt(messages);
        if (r === "stop") return "stop";
      }
    }
    return "continue";
  }

  private applyCommand(
    cmd: { type: string; text?: string },
    messages: ModelMessage[],
  ): "continue" | "stop" | "interrupt" {
    switch (cmd.type) {
      case "status":
        this.emitStatus();
        return "continue";
      case "chat":
        if (cmd.text) {
          messages.push({ role: "user", content: cmd.text });
          this.opts.logger.info("chat injected", {});
        }
        return "continue";
      case "interrupt":
        this.opts.emitter.emit({ type: "interrupted" });
        return "interrupt";
      case "resume":
        return "continue"; // resume outside an interrupt is a no-op
      case "stop":
        this.opts.emitter.emit({ type: "stopping" });
        return "stop";
      default:
        return "continue";
    }
  }

  /** Block while interrupted, handling further commands until resume/stop. */
  private async handleInterrupt(messages: ModelMessage[]): Promise<"resumed" | "stop"> {
    for (;;) {
      let cmd;
      try {
        cmd = await this.opts.control.waitForNext();
      } catch {
        return "resumed"; // control channel closed → treat as resume
      }
      if (cmd.type === "resume") {
        this.opts.emitter.emit({ type: "resumed" });
        return "resumed";
      }
      if (cmd.type === "stop") {
        this.opts.emitter.emit({ type: "stopping" });
        return "stop";
      }
      this.applyCommand(cmd, messages); // status/chat allowed while paused
    }
  }

  private emitStatus(): void {
    const { state, emitter, startedAt } = this.opts;
    emitter.emit({
      type: "status_report",
      phase: state.phase,
      current_skill: state.currentSkill,
      changed_files: [...state.changedFiles],
      elapsed_sec: Math.round((performance.now() - startedAt) / 1000),
    });
  }
}

function summarizeOutput(output: unknown): string {
  try {
    const s = typeof output === "string" ? output : JSON.stringify(output);
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  } catch {
    return "[unserializable result]";
  }
}
