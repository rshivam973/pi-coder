import { describe, expect, test } from "bun:test";
import {
  parseTask,
  parseResult,
  parseControlLine,
  ContractError,
} from "../src/contracts.ts";

const minimalTask = {
  task_id: "t1",
  repo: "https://github.com/acme/widgets.git",
  base_ref: "main",
  issue_id: "ISSUE-1",
  instructions: "do the thing",
  provider: { name: "openrouter", model: "anthropic/claude-3.5-sonnet", api_key_env: "OPENROUTER_API_KEY" },
};

describe("parseTask", () => {
  test("applies constraint + github defaults", () => {
    const task = parseTask(minimalTask);
    expect(task.constraints.max_steps).toBe(40);
    expect(task.constraints.max_runtime_sec).toBe(1800);
    expect(task.constraints.allow_network).toBe(true);
    expect(task.constraints.allow_write).toEqual(["."]);
    expect(task.tool_profile).toBe("auto");
    expect(task.github.token_env).toBe("GITHUB_TOKEN");
  });

  test("rejects a non-url repo", () => {
    expect(() => parseTask({ ...minimalTask, repo: "not-a-url" })).toThrow(ContractError);
  });

  test("rejects unknown provider", () => {
    expect(() =>
      parseTask({ ...minimalTask, provider: { ...minimalTask.provider, name: "bogus" } }),
    ).toThrow(ContractError);
  });

  test("preserves explicit allow_write", () => {
    const task = parseTask({
      ...minimalTask,
      constraints: { allow_write: ["./src", "./test"] },
    });
    expect(task.constraints.allow_write).toEqual(["./src", "./test"]);
    expect(task.constraints.max_steps).toBe(40); // still defaulted
  });
});

describe("parseResult", () => {
  test("rejects an incomplete result", () => {
    expect(() => parseResult({ task_id: "t1", status: "success" })).toThrow(ContractError);
  });
});

describe("parseControlLine", () => {
  test("parses each command type", () => {
    expect(parseControlLine('{"type":"status"}')).toEqual({ type: "status" });
    expect(parseControlLine('{"type":"chat","text":"hi"}')).toEqual({ type: "chat", text: "hi" });
    expect(parseControlLine('{"type":"interrupt"}')).toEqual({ type: "interrupt" });
    expect(parseControlLine('{"type":"resume"}')).toEqual({ type: "resume" });
    expect(parseControlLine('{"type":"stop"}')).toEqual({ type: "stop" });
  });

  test("returns null for blank, malformed, and unknown shapes", () => {
    expect(parseControlLine("")).toBeNull();
    expect(parseControlLine("   ")).toBeNull();
    expect(parseControlLine("{not json")).toBeNull();
    expect(parseControlLine('{"type":"frobnicate"}')).toBeNull();
    expect(parseControlLine('{"type":"chat"}')).toBeNull(); // missing text
  });
});
