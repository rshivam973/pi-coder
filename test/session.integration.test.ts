import { afterAll, describe, expect, test } from "bun:test";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.ts";
import { EventEmitter } from "../src/events.ts";
import { Logger } from "../src/logger.ts";
import { NullControlChannel } from "../src/control.ts";
import { loadSkills, SkillRegistry } from "../src/skills.ts";
import { resolveProfile } from "../src/profiles.ts";
import { createRunState, createTools, type ToolContext } from "../src/tools.ts";
import { parseTask, type PiEvent } from "../src/contracts.ts";

const created: string[] = [];
afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh git repo with one seed commit on `main`. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-"));
  created.push(dir);
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "ignore" });
  run("git init -q");
  run("git config user.email t@t.local");
  run("git config user.name t");
  run("git checkout -q -b main");
  execSync("echo seed > seed.txt", { cwd: dir });
  run("git add -A");
  run("git commit -q -m seed");
  return dir;
}

let callId = 0;
function streamFor(parts: LanguageModelV2StreamPart[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] } as LanguageModelV2StreamPart,
        ...parts,
        {
          type: "finish",
          finishReason: parts.some((p) => p.type === "tool-call") ? "tool-calls" : "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as LanguageModelV2StreamPart,
      ],
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
    }),
  };
}

/** Model that returns one scripted step per call (function form avoids the array off-by-one). */
function scriptedModel(steps: LanguageModelV2StreamPart[][]): MockLanguageModelV2 {
  let i = 0;
  return new MockLanguageModelV2({
    doStream: async () => streamFor(steps[i++] ?? steps[steps.length - 1]!),
  });
}

function toolCall(name: string, args: Record<string, unknown>): LanguageModelV2StreamPart {
  return { type: "tool-call", toolCallId: `c${callId++}`, toolName: name, input: JSON.stringify(args) };
}

const task = parseTask({
  task_id: "it-1",
  repo: "https://github.com/acme/widgets.git",
  base_ref: "main",
  issue_id: "ISSUE-7",
  instructions: "Add a hello.txt file with a greeting.",
  acceptance_criteria: "hello.txt exists with content.",
  provider: { name: "openrouter", model: "x", api_key_env: "X" },
});

function makeCtx(workdir: string, events: PiEvent[]) {
  const emitter = new EventEmitter({
    write: (line) => events.push(JSON.parse(line)),
    clock: () => "2026-05-30T00:00:00.000Z",
  });
  const state = createRunState();
  const logger = new Logger({ logPath: join(workdir, ".pi.log"), taskId: task.task_id });
  const controller = new AbortController();
  const ctx: ToolContext = {
    workdir,
    task,
    profile: resolveProfile(workdir, "auto"),
    skills: new SkillRegistry(loadSkills()),
    emitter,
    logger,
    logDir: join(workdir, ".logs"),
    signal: controller.signal,
    state,
  };
  return { ctx, emitter, state, logger, controller };
}

describe("Session — scripted runs", () => {
  test("loads a skill, edits, commits, reviews, and finishes success", async () => {
    const workdir = tempRepo();
    const events: PiEvent[] = [];
    const { ctx, emitter, state, logger, controller } = makeCtx(workdir, events);
    const tools = createTools(ctx);

    const model = scriptedModel([
      [{ type: "text-start", id: "t0" }, { type: "text-delta", id: "t0", delta: "Loading skill." }, { type: "text-end", id: "t0" }, toolCall("use_skill", { name: "coding" })],
      [toolCall("write_file", { path: "hello.txt", content: "hello world\n" })],
      [toolCall("git_commit", { message: "[agentic] issue-ISSUE-7: add hello.txt" })],
      [toolCall("record_review", { passed: true, findings: [] })],
      [toolCall("finish", { status: "success", summary: "Added hello.txt with a greeting." })],
    ]);

    const session = new Session({
      model, tools, systemPrompt: "test", task, state, emitter, logger,
      control: new NullControlChannel(), signal: controller.signal, startedAt: performance.now(),
    });

    const result = await session.run();

    expect(result.reason).toBe("finished");
    expect(state.finish?.status).toBe("success");
    expect(state.loadedSkills.has("coding")).toBe(true);
    expect(state.changedFiles.has("hello.txt")).toBe(true);
    expect(state.review.passed).toBe(true);

    // The file was really written and committed.
    expect(existsSync(join(workdir, "hello.txt"))).toBe(true);
    expect(readFileSync(join(workdir, "hello.txt"), "utf8")).toBe("hello world\n");

    const types = new Set(events.map((e) => e.type));
    expect(types.has("skill_loaded")).toBe(true);
    expect(types.has("tool_call")).toBe(true);
    expect(types.has("review")).toBe(true);
    expect(types.has("git")).toBe(true);
    expect(types.has("llm_text")).toBe(true);
  });

  test("finish gate: success is rejected until a review passes", async () => {
    const workdir = tempRepo();
    const events: PiEvent[] = [];
    const { ctx, emitter, state, logger, controller } = makeCtx(workdir, events);
    const tools = createTools(ctx);

    const model = scriptedModel([
      [toolCall("write_file", { path: "a.txt", content: "x" })],
      [toolCall("finish", { status: "success", summary: "done" })], // rejected: no passing review
      [toolCall("record_review", { passed: true, findings: [] })],
      [toolCall("finish", { status: "success", summary: "done" })], // accepted
    ]);

    const session = new Session({
      model, tools, systemPrompt: "test", task, state, emitter, logger,
      control: new NullControlChannel(), signal: controller.signal, startedAt: performance.now(),
    });

    const result = await session.run();
    expect(result.reason).toBe("finished");
    expect(result.steps).toBe(4); // the premature finish did not end the run
    expect(state.review.passed).toBe(true);
    expect(state.finish?.status).toBe("success");
  });
});
