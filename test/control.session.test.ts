import { afterAll, describe, expect, test } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.ts";
import { EventEmitter } from "../src/events.ts";
import { Logger } from "../src/logger.ts";
import { loadSkills, SkillRegistry } from "../src/skills.ts";
import { resolveProfile } from "../src/profiles.ts";
import { createRunState, createTools, type ToolContext } from "../src/tools.ts";
import { parseTask, type PiEvent, type ControlCommand } from "../src/contracts.ts";

const created: string[] = [];
afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-ctrl-"));
  created.push(d);
  return d;
}

/** Scripted control source: drains[i] is returned on the i-th drain(); waits[j] on the j-th waitForNext(). */
class FakeControl {
  private di = 0;
  private wi = 0;
  constructor(
    private readonly drains: ControlCommand[][],
    private readonly waits: ControlCommand[] = [],
  ) {}
  drain(): ControlCommand[] {
    return this.drains[this.di++] ?? [];
  }
  waitForNext(): Promise<ControlCommand> {
    return Promise.resolve(this.waits[this.wi++] ?? { type: "resume" });
  }
  close(): void {}
}

let id = 0;
function streamFor(parts: LanguageModelV2StreamPart[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] } as LanguageModelV2StreamPart,
        ...parts,
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as LanguageModelV2StreamPart,
      ],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}
function scriptedModel(steps: LanguageModelV2StreamPart[][]): MockLanguageModelV2 {
  let i = 0;
  return new MockLanguageModelV2({ doStream: async () => streamFor(steps[i++] ?? steps[steps.length - 1]!) });
}
function toolCall(name: string, args: Record<string, unknown>): LanguageModelV2StreamPart {
  return { type: "tool-call", toolCallId: `c${id++}`, toolName: name, input: JSON.stringify(args) };
}

const task = parseTask({
  task_id: "ctl",
  repo: "https://github.com/a/b.git",
  base_ref: "main",
  issue_id: "I-9",
  instructions: "noop",
  provider: { name: "openrouter", model: "x", api_key_env: "X" },
});

function harness(workdir: string, control: FakeControl, steps: LanguageModelV2StreamPart[][]) {
  const events: PiEvent[] = [];
  const emitter = new EventEmitter({ write: (l) => events.push(JSON.parse(l)), clock: () => "t" });
  const state = createRunState();
  const logger = new Logger({ logPath: join(workdir, ".log"), taskId: task.task_id });
  const controller = new AbortController();
  const ctx: ToolContext = {
    workdir, task, profile: resolveProfile(workdir, "auto"),
    skills: new SkillRegistry(loadSkills()), emitter, logger,
    logDir: join(workdir, ".logs"), signal: controller.signal, state,
  };
  const session = new Session({
    model: scriptedModel(steps), tools: createTools(ctx), systemPrompt: "t",
    task, state, emitter, logger, control, signal: controller.signal, startedAt: performance.now(),
  });
  return { session, events };
}

describe("control protocol", () => {
  test("stop ends the run before any model step", async () => {
    // A finish step exists, but stop should pre-empt it.
    const control = new FakeControl([[{ type: "stop" }]]);
    const { session, events } = harness(tempDir(), control, [
      [toolCall("finish", { status: "success", summary: "x" })],
    ]);
    const result = await session.run();
    expect(result.reason).toBe("stop_command");
    expect(result.steps).toBe(0);
    expect(events.map((e) => e.type)).toContain("stopping");
  });

  test("status emits a status_report, run continues", async () => {
    const control = new FakeControl([[{ type: "status" }]]);
    const { session, events } = harness(tempDir(), control, [
      [toolCall("finish", { status: "success", summary: "no changes" })],
    ]);
    const result = await session.run();
    expect(result.reason).toBe("finished");
    const status = events.find((e) => e.type === "status_report");
    expect(status).toBeDefined();
    expect(status).toMatchObject({ phase: "plan", current_skill: null });
  });

  test("interrupt pauses, chat is accepted while paused, resume continues", async () => {
    const control = new FakeControl(
      [[{ type: "interrupt" }]], // first drain interrupts
      [{ type: "chat", text: "also handle the edge case" }, { type: "resume" }], // while paused
    );
    const { session, events } = harness(tempDir(), control, [
      [toolCall("finish", { status: "success", summary: "ok" })],
    ]);
    const result = await session.run();
    expect(result.reason).toBe("finished");
    const types = events.map((e) => e.type);
    expect(types).toContain("interrupted");
    expect(types).toContain("resumed");
    // interrupted must come before resumed
    expect(types.indexOf("interrupted")).toBeLessThan(types.indexOf("resumed"));
  });
});
