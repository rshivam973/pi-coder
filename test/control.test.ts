import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ControlChannel } from "../src/control.ts";

function feed(...lines: string[]): PassThrough {
  const stream = new PassThrough();
  for (const line of lines) stream.write(line + "\n");
  return stream;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("ControlChannel", () => {
  test("drains queued commands in arrival order", async () => {
    const input = feed('{"type":"status"}', '{"type":"chat","text":"hi"}');
    const ch = new ControlChannel({ input });
    await tick();
    expect(ch.drain()).toEqual([{ type: "status" }, { type: "chat", text: "hi" }]);
    expect(ch.drain()).toEqual([]); // drained
    ch.close();
  });

  test("reports malformed lines via callback, ignores blanks", async () => {
    const malformed: string[] = [];
    const input = feed("", "{garbage", '{"type":"status"}');
    const ch = new ControlChannel({ input, onMalformed: (l) => malformed.push(l) });
    await tick();
    expect(malformed).toEqual(["{garbage"]);
    expect(ch.drain()).toEqual([{ type: "status" }]);
    ch.close();
  });

  test("waitForNext resolves with a later-arriving command", async () => {
    const input = new PassThrough();
    const ch = new ControlChannel({ input });
    const next = ch.waitForNext();
    await tick();
    input.write('{"type":"resume"}\n');
    expect(await next).toEqual({ type: "resume" });
    ch.close();
  });
});
