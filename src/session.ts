/**
 * The interactive agent loop (TRD §7) + post-task discussion mode.
 *
 * Work phase: one model step per iteration via the AI SDK, draining the control
 * queue between steps so the user can chat / interrupt / stop. An AbortController
 * enforces the wall-clock timeout.
 *
 * Discussion phase: once the agent finishes the task, the platform opens the PR
 * (via onFinish) and the session does NOT exit — it stays alive with the full
 * context (the diff it just made) + read-only tools, answering the user's
 * questions until they /stop it or it idles out. This is what lets a user chat
 * with the agent about the changes after the work is done.
 */
import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { EventEmitter } from "./events.ts";
import type { Logger } from "./logger.ts";
import type { ControlSource } from "./control.ts";
import type { RunState } from "./tools.ts";
import type { Task, Phase, ControlCommand } from "./contracts.ts";

export type StopReason =
  | "finished" // model called finish (and no discussion phase ran)
  | "stop_command" // user sent stop
  | "max_steps"
  | "timeout"
  | "standby_idle" // discussion phase ended after an idle period
  | "error";

export interface SessionResult {
  reason: StopReason;
  steps: number;
}

export interface SessionOptions {
  model: LanguageModel;
  tools: ToolSet;
  systemPrompt: string;
  /** System prompt used during the discussion phase (read-only / conversational). */
  standbySystemPrompt?: string;
  task: Task;
  state: RunState;
  emitter: EventEmitter;
  logger: Logger;
  control: ControlSource;
  signal: AbortSignal;
  startedAt: number;
  /** Whether a control channel can deliver chat (false for --no-input). */
  interactive?: boolean;
  /** Called once when the agent finishes the task; opens the PR. Returns the PR url. */
  onFinish?: () => Promise<{ prUrl: string | null } | void>;
  /** Idle seconds before the discussion phase ends. Default 900 (15 min). */
  standbyIdleSec?: number;
}

const MAX_ANSWER_STEPS = 12;

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
  private step = 0;
  private lastPhase: Phase | null = null;
  private activeSystem: string;
  private readonly messages: ModelMessage[] = [];

  constructor(private readonly opts: SessionOptions) {
    this.activeSystem = opts.systemPrompt;
  }

  async run(): Promise<SessionResult> {
    this.messages.push({
      role: "user",
      content: "Start working on the task now. Begin by loading the using-skills skill.",
    });

    const workReason = await this.workLoop();

    const canDiscuss =
      workReason === "finished" && !!this.opts.onFinish && this.opts.interactive !== false;
    if (!canDiscuss) return { reason: workReason, steps: this.step };

    await this.enterDiscussion();
    const reason = await this.discussionLoop();
    return { reason, steps: this.step };
  }

  // --- work phase ---------------------------------------------------------

  private async workLoop(): Promise<StopReason> {
    const { task, state, emitter, signal } = this.opts;

    while (this.step < task.constraints.max_steps) {
      if (signal.aborted) return "timeout";
      if (state.finish) return "finished";

      const ctl = await this.drainControl();
      if (ctl === "stop") return "stop_command";

      this.step++;
      emitter.setStep(this.step);
      this.syncPhase();

      try {
        await this.modelStep(this.activeSystem);
      } catch (err) {
        if (signal.aborted) return "timeout";
        this.opts.logger.error("step failed", { step: this.step, error_type: "step_error" });
        emitter.error("step_error", (err as Error).message, false);
      }

      this.syncPhase();
      if (state.finish) return "finished";
    }

    return "max_steps";
  }

  // --- discussion phase ---------------------------------------------------

  private async enterDiscussion(): Promise<void> {
    this.activeSystem = this.opts.standbySystemPrompt ?? this.opts.systemPrompt;
    this.setPhase("discuss");

    let prUrl: string | null = null;
    try {
      const r = await this.opts.onFinish?.();
      if (r && typeof r === "object" && "prUrl" in r) prUrl = r.prUrl ?? null;
    } catch (err) {
      this.opts.emitter.error("finalize_failed", (err as Error).message, false);
    }

    this.messages.push({
      role: "user",
      content:
        `The work is committed and a pull request has been opened${prUrl ? `: ${prUrl}` : ""}. ` +
        `You are now in DISCUSSION MODE. Briefly tell me the work is done and invite questions. ` +
        `From here on, answer my questions about the changes you made and about the codebase. ` +
        `Use only read-only tools (read_file, search, git_diff, git_status, list_tree) to look things up. ` +
        `Do NOT edit files, commit, or call finish again. If I ask for further changes, explain that those ` +
        `should be a new dispatch rather than part of this discussion.`,
    });

    await this.answer();
  }

  private async discussionLoop(): Promise<StopReason> {
    const idleMs = (this.opts.standbyIdleSec ?? 900) * 1000;
    for (;;) {
      if (this.opts.signal.aborted) return "standby_idle";
      const cmd = await this.waitWithIdle(idleMs);
      if (cmd === "IDLE") {
        this.opts.emitter.emit({ type: "stopping" });
        return "standby_idle";
      }
      switch (cmd.type) {
        case "stop":
          this.opts.emitter.emit({ type: "stopping" });
          return "stop_command";
        case "status":
          this.emitStatus();
          break;
        case "chat":
          if (cmd.text) this.messages.push({ role: "user", content: cmd.text });
          await this.answer();
          break;
        case "interrupt":
        case "resume":
          break; // no-op in discussion mode
      }
    }
  }

  /** Run model steps until the model produces a final text answer (no tool call) or the cap. */
  private async answer(): Promise<void> {
    for (let i = 0; i < MAX_ANSWER_STEPS; i++) {
      if (this.opts.signal.aborted) return;
      this.step++;
      this.opts.emitter.setStep(this.step);
      try {
        const { toolCalled } = await this.modelStep(this.activeSystem);
        if (!toolCalled) return;
      } catch (err) {
        this.opts.emitter.error("step_error", (err as Error).message, false);
        return;
      }
    }
  }

  /** Race the next control command against an idle timeout. */
  private waitWithIdle(idleMs: number): Promise<ControlCommand | "IDLE"> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve("IDLE");
        }
      }, idleMs);
      this.opts.control
        .waitForNext()
        .then((cmd) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(cmd);
          }
        })
        .catch(() => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve("IDLE");
          }
        });
    });
  }

  // --- shared step + control plumbing -------------------------------------

  /** Stream one model step, emit events, accumulate context. Returns whether a tool was called. */
  private async modelStep(system: string): Promise<{ toolCalled: boolean }> {
    const { emitter, signal } = this.opts;
    let toolCalled = false;

    const result = streamText({
      model: this.opts.model,
      system,
      messages: this.messages,
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
          toolCalled = true;
          emitter.emit({ type: "tool_call", tool: part.toolName, args: part.input });
          break;
        case "tool-result":
          emitter.emit({ type: "tool_result", tool: part.toolName, ok: true, summary: summarizeOutput(part.output) });
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

    this.messages.push(...(await result.response).messages);
    return { toolCalled };
  }

  private setPhase(phase: Phase): void {
    this.opts.state.phase = phase;
    this.lastPhase = phase;
    this.opts.emitter.phase(phase);
  }

  private syncPhase(): void {
    const phase = skillToPhase(this.opts.state.currentSkill);
    this.opts.state.phase = phase;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.opts.emitter.phase(phase);
    }
  }

  private async drainControl(): Promise<"continue" | "stop"> {
    for (const cmd of this.opts.control.drain()) {
      const outcome = this.applyCommand(cmd);
      if (outcome === "stop") return "stop";
      if (outcome === "interrupt") {
        const r = await this.handleInterrupt();
        if (r === "stop") return "stop";
      }
    }
    return "continue";
  }

  private applyCommand(cmd: { type: string; text?: string }): "continue" | "stop" | "interrupt" {
    switch (cmd.type) {
      case "status":
        this.emitStatus();
        return "continue";
      case "chat":
        if (cmd.text) {
          this.messages.push({ role: "user", content: cmd.text });
          this.opts.logger.info("chat injected", {});
        }
        return "continue";
      case "interrupt":
        this.opts.emitter.emit({ type: "interrupted" });
        return "interrupt";
      case "resume":
        return "continue";
      case "stop":
        this.opts.emitter.emit({ type: "stopping" });
        return "stop";
      default:
        return "continue";
    }
  }

  private async handleInterrupt(): Promise<"resumed" | "stop"> {
    for (;;) {
      let cmd;
      try {
        cmd = await this.opts.control.waitForNext();
      } catch {
        return "resumed";
      }
      if (cmd.type === "resume") {
        this.opts.emitter.emit({ type: "resumed" });
        return "resumed";
      }
      if (cmd.type === "stop") {
        this.opts.emitter.emit({ type: "stopping" });
        return "stop";
      }
      this.applyCommand(cmd);
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
