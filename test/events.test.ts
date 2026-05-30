import { describe, expect, test } from "bun:test";
import { EventEmitter } from "../src/events.ts";
import type { PiEvent } from "../src/contracts.ts";

function capture() {
  const lines: string[] = [];
  const emitter = new EventEmitter({
    write: (line) => lines.push(line),
    clock: () => "2026-05-30T00:00:00.000Z",
  });
  return { emitter, lines, parsed: () => lines.map((l) => JSON.parse(l) as PiEvent) };
}

describe("EventEmitter", () => {
  test("emits NDJSON with envelope and current step", () => {
    const { emitter, lines, parsed } = capture();
    emitter.setStep(3);
    emitter.emit({ type: "phase", phase: "code" });
    expect(lines[0]!.endsWith("\n")).toBe(true);
    const ev = parsed()[0]!;
    expect(ev).toEqual({ ts: "2026-05-30T00:00:00.000Z", step: 3, type: "phase", phase: "code" });
  });

  test("each line is independently valid JSON", () => {
    const { emitter, lines } = capture();
    emitter.emit({ type: "llm_text", text: "hello\nworld" });
    emitter.emit({ type: "tool_call", tool: "read_file", args: { path: "a.ts" } });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line.split("\n").filter(Boolean)).toHaveLength(1);
    }
  });

  test("error helper sets fatal flag", () => {
    const { emitter, parsed } = capture();
    emitter.error("clone_failed", "boom", true);
    expect(parsed()[0]).toMatchObject({ type: "error", error_type: "clone_failed", fatal: true });
  });
});
