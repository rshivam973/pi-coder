#!/usr/bin/env bun
/**
 * pi-coder CLI entrypoint (TRD §5). Dispatches init / run / validate /
 * summarize. stdout is reserved for NDJSON events during `run`; human output
 * for the other commands is plain text.
 */
import { parseArgs } from "node:util";
import { runTask } from "./run.ts";
import { runPreflight } from "./init.ts";
import { parseTask, parseResult, ContractError } from "./contracts.ts";
import { buildSummaryMarkdown } from "./report.ts";

const USAGE = `pi-coder — interactive coding agent

Usage:
  pi-coder init [--task <task.json>]
  pi-coder run --task <task.json> [--output result.json] [--workdir <dir>] [--no-input] [--max-steps N] [--max-runtime SEC]
  pi-coder validate --result <result.json>
  pi-coder summarize --result <result.json>
`;

function fail(message: string, code: number): never {
  process.stderr.write(message + "\n");
  process.exit(code);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 2);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      task: { type: "string" },
      output: { type: "string", default: "result.json" },
      result: { type: "string" },
      workdir: { type: "string", default: "./.pi-coder/workspace" },
      "no-input": { type: "boolean", default: false },
      "max-steps": { type: "string" },
      "max-runtime": { type: "string" },
    },
    allowPositionals: false,
  });

  switch (command) {
    case "init": {
      const task = values.task ? parseTask(await Bun.file(values.task).json()) : undefined;
      const report = await runPreflight(task);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(report.ok ? 0 : 3);
      break;
    }

    case "run": {
      if (!values.task) fail("run requires --task <task.json>", 2);
      const result = await runTask({
        taskPath: values.task!,
        outputPath: values.output!,
        workdir: values.workdir!,
        noInput: values["no-input"]!,
        maxStepsOverride: values["max-steps"] ? Number(values["max-steps"]) : undefined,
        maxRuntimeOverride: values["max-runtime"] ? Number(values["max-runtime"]) : undefined,
      });
      // Exit code per TRD §5.2: 0 success, 1 failed, 4 partial.
      process.exit(result.status === "success" ? 0 : result.status === "failed" ? 1 : 4);
      break;
    }

    case "validate": {
      if (!values.result) fail("validate requires --result <result.json>", 2);
      parseResult(await Bun.file(values.result!).json());
      process.stdout.write("result.json is valid\n");
      process.exit(0);
      break;
    }

    case "summarize": {
      if (!values.result) fail("summarize requires --result <result.json>", 2);
      const result = parseResult(await Bun.file(values.result!).json());
      process.stdout.write(buildSummaryMarkdown(result) + "\n");
      process.exit(0);
      break;
    }

    default:
      fail(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

main().catch((err) => {
  if (err instanceof ContractError) fail(err.message, 2);
  fail(`pi-coder error: ${(err as Error).message}`, 1);
});
