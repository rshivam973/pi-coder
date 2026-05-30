/**
 * Agent tools (TRD §9). Registered with the AI SDK; the model invokes them to
 * read/edit code, run commands, drive git, load skills, record its review, and
 * finish. Generic tool_call/tool_result events are emitted by the loop from the
 * model stream; tools here emit only their domain-specific events
 * (test_run, git, skill_loaded, review).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { exec } from "./exec.ts";
import { resolveInWorkdir, isWriteAllowed } from "./paths.ts";
import * as git from "./git.ts";
import type { EventEmitter } from "./events.ts";
import type { Logger } from "./logger.ts";
import type { ResolvedProfile } from "./profiles.ts";
import type { SkillRegistry } from "./skills.ts";
import type { Task, CommandExecution, ReviewOutcome, Phase } from "./contracts.ts";

const MAX_OUTPUT_CHARS = 30_000;
const MAX_FILE_CHARS = 100_000;
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".pi-coder",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "coverage",
]);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

/** Mutable run state shared between tools and the session. */
export interface RunState {
  phase: Phase;
  currentSkill: string | null;
  loadedSkills: Set<string>;
  changedFiles: Set<string>;
  testsExecuted: CommandExecution[];
  lintExecuted: CommandExecution | null;
  typecheckExecuted: CommandExecution | null;
  review: ReviewOutcome;
  finish: {
    status: "success" | "partial" | "failed";
    summary: string;
    risks: string[];
    next_steps: string[];
  } | null;
}

export function createRunState(): RunState {
  return {
    phase: "plan",
    currentSkill: null,
    loadedSkills: new Set(),
    changedFiles: new Set(),
    testsExecuted: [],
    lintExecuted: null,
    typecheckExecuted: null,
    review: { passed: false, iterations: 0, findings: [] },
    finish: null,
  };
}

export interface ToolContext {
  workdir: string;
  task: Task;
  profile: ResolvedProfile;
  skills: SkillRegistry;
  emitter: EventEmitter;
  logger: Logger;
  logDir: string;
  signal: AbortSignal;
  state: RunState;
}

const ok = (data: Record<string, unknown> = {}) => ({ ok: true, ...data });
const fail = (message: string) => ({ ok: false, error: message });

export function createTools(ctx: ToolContext): ToolSet {
  const gitCtx = { cwd: ctx.workdir, signal: ctx.signal, logPath: join(ctx.logDir, "git.log") };

  async function runProfileCommand(
    kind: "test" | "lint" | "typecheck",
    command: string | null,
  ): Promise<CommandExecution | { skipped: true }> {
    if (!command) return { skipped: true };
    const logPath = join(ctx.logDir, `${kind}-${Date.now()}.log`);
    const res = await exec(command, {
      cwd: ctx.workdir,
      signal: ctx.signal,
      allowNetwork: ctx.task.constraints.allow_network,
      logPath,
      timeoutMs: 600_000,
    });
    const record: CommandExecution = {
      name: kind,
      command,
      exit_code: res.exitCode,
      duration_ms: res.durationMs,
      log_path: logPath,
    };
    ctx.emitter.emit({
      type: "test_run",
      command,
      exit_code: res.exitCode,
      duration_ms: res.durationMs,
    });
    return record;
  }

  return {
    read_file: tool({
      description: "Read a UTF-8 text file from the repo, relative to the repo root.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const abs = resolveInWorkdir(ctx.workdir, path);
          return ok({ path, content: truncate(readFileSync(abs, "utf8"), MAX_FILE_CHARS) });
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    }),

    write_file: tool({
      description:
        "Write (create or overwrite) a UTF-8 text file. Rejected if the path is outside the allowed write directories.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        let abs: string;
        try {
          abs = resolveInWorkdir(ctx.workdir, path);
        } catch (err) {
          return fail((err as Error).message);
        }
        const rel = relative(ctx.workdir, abs);
        if (!isWriteAllowed(ctx.task.constraints.allow_write, rel)) {
          return fail(
            `Write denied: "${rel}" is outside allow_write [${ctx.task.constraints.allow_write.join(", ")}].`,
          );
        }
        try {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
          ctx.state.changedFiles.add(rel);
          return ok({ path: rel, bytes: Buffer.byteLength(content) });
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    }),

    list_tree: tool({
      description: "List the repo file tree (relative paths) up to a max depth, skipping vendored dirs.",
      inputSchema: z.object({
        root: z.string().default("."),
        max_depth: z.number().int().positive().max(12).default(4),
      }),
      execute: async ({ root, max_depth }) => {
        try {
          const base = resolveInWorkdir(ctx.workdir, root);
          const out: string[] = [];
          const walk = (dir: string, depth: number) => {
            if (depth > max_depth) return;
            for (const name of readdirSync(dir).sort()) {
              if (IGNORED_DIRS.has(name)) continue;
              const abs = join(dir, name);
              const isDir = statSync(abs).isDirectory();
              out.push(relative(ctx.workdir, abs) + (isDir ? "/" : ""));
              if (isDir) walk(abs, depth + 1);
              if (out.length > 5000) return;
            }
          };
          walk(base, 1);
          return ok({ entries: out });
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    }),

    search: tool({
      description: "Search file contents with ripgrep. Returns matching lines with file:line prefixes.",
      inputSchema: z.object({ pattern: z.string(), path: z.string().default(".") }),
      execute: async ({ pattern, path }) => {
        const res = await exec(
          `rg --line-number --no-heading --color never ${git.shellQuote(pattern)} ${git.shellQuote(path)}`,
          { cwd: ctx.workdir, signal: ctx.signal, timeoutMs: 60_000 },
        );
        // rg exits 1 when there are no matches — that's not an error.
        if (res.exitCode > 1) return fail(res.stderr.trim() || `ripgrep exit ${res.exitCode}`);
        return ok({ matches: truncate(res.stdout, MAX_OUTPUT_CHARS), found: res.exitCode === 0 });
      },
    }),

    run: tool({
      description:
        "Run a shell command in the repo. Use for builds, scripts, and inspection. Has a timeout; output is truncated.",
      inputSchema: z.object({
        cmd: z.string(),
        cwd: z.string().default("."),
        timeout_ms: z.number().int().positive().max(600_000).default(120_000),
      }),
      execute: async ({ cmd, cwd, timeout_ms }) => {
        let absCwd: string;
        try {
          absCwd = resolveInWorkdir(ctx.workdir, cwd);
        } catch (err) {
          return fail((err as Error).message);
        }
        const res = await exec(cmd, {
          cwd: absCwd,
          signal: ctx.signal,
          allowNetwork: ctx.task.constraints.allow_network,
          timeoutMs: timeout_ms,
          logPath: join(ctx.logDir, "run.log"),
        });
        return ok({
          exit_code: res.exitCode,
          timed_out: res.timedOut,
          stdout: truncate(res.stdout, MAX_OUTPUT_CHARS),
          stderr: truncate(res.stderr, MAX_OUTPUT_CHARS),
        });
      },
    }),

    git_status: tool({
      description: "Show porcelain git status of the working tree.",
      inputSchema: z.object({}),
      execute: async () => ok({ status: await git.status(gitCtx) }),
    }),

    git_diff: tool({
      description: "Show the git diff of the working tree (or staged changes).",
      inputSchema: z.object({ staged: z.boolean().default(false) }),
      execute: async ({ staged }) => ok({ diff: truncate(await git.diff(staged, gitCtx), MAX_OUTPUT_CHARS) }),
    }),

    git_commit: tool({
      description:
        'Stage and commit changes. Use the title format "[agentic] issue-<id>: <short title>".',
      inputSchema: z.object({
        message: z.string(),
        files: z.array(z.string()).optional(),
        no_verify: z.boolean().default(false),
      }),
      execute: async ({ message, files, no_verify }) => {
        try {
          const committed = await git.commit({ message, files, noVerify: no_verify }, gitCtx);
          if (!committed) return ok({ committed: false, note: "nothing to commit" });
          ctx.emitter.emit({ type: "git", action: "commit", detail: message.split("\n")[0] ?? message });
          for (const f of await git.changedFiles(ctx.task.base_ref, gitCtx)) ctx.state.changedFiles.add(f);
          return ok({ committed: true });
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    }),

    run_tests: tool({
      description: "Run the project's test suite (auto-detected from the tool profile).",
      inputSchema: z.object({}),
      execute: async () => {
        const r = await runProfileCommand("test", ctx.profile.test);
        if ("skipped" in r) return ok({ skipped: true, note: "no test command for this profile" });
        ctx.state.testsExecuted.push(r);
        return ok({ exit_code: r.exit_code, duration_ms: r.duration_ms, passed: r.exit_code === 0 });
      },
    }),

    run_lint: tool({
      description: "Run the project's linter (auto-detected from the tool profile).",
      inputSchema: z.object({}),
      execute: async () => {
        const r = await runProfileCommand("lint", ctx.profile.lint);
        if ("skipped" in r) return ok({ skipped: true, note: "no lint command for this profile" });
        ctx.state.lintExecuted = r;
        return ok({ exit_code: r.exit_code, passed: r.exit_code === 0 });
      },
    }),

    run_typecheck: tool({
      description: "Run the project's type checker (auto-detected from the tool profile).",
      inputSchema: z.object({}),
      execute: async () => {
        const r = await runProfileCommand("typecheck", ctx.profile.typecheck);
        if ("skipped" in r) return ok({ skipped: true, note: "no typecheck command for this profile" });
        ctx.state.typecheckExecuted = r;
        return ok({ exit_code: r.exit_code, passed: r.exit_code === 0 });
      },
    }),

    use_skill: tool({
      description:
        "Load the full instructions for a skill by name. Consult the skill catalog in the system prompt to choose.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const skill = ctx.skills.get(name);
        if (!skill) return fail(`Unknown skill "${name}". Available: ${ctx.skills.names().join(", ")}`);
        ctx.state.loadedSkills.add(name);
        ctx.state.currentSkill = name;
        ctx.emitter.emit({ type: "skill_loaded", name: skill.name, description: skill.description });
        return ok({ name: skill.name, instructions: skill.body });
      },
    }),

    record_review: tool({
      description:
        "Record the outcome of the code-reviewer skill. Call with passed=false and findings when changes need fixing; passed=true only when the diff is relevant, complete, and clean.",
      inputSchema: z.object({
        passed: z.boolean(),
        findings: z.array(z.string()).default([]),
      }),
      execute: async ({ passed, findings }) => {
        ctx.state.review.iterations += 1;
        ctx.state.review.passed = passed;
        ctx.state.review.findings = findings;
        ctx.emitter.emit({
          type: "review",
          passed,
          findings,
          iteration: ctx.state.review.iterations,
        });
        return ok({ recorded: true, iteration: ctx.state.review.iterations });
      },
    }),

    finish: tool({
      description:
        "Conclude the task. Provide a final status and summary. A 'success' finish requires a passing code review when there are changes.",
      inputSchema: z.object({
        status: z.enum(["success", "partial", "failed"]),
        summary: z.string(),
        risks: z.array(z.string()).default([]),
        next_steps: z.array(z.string()).default([]),
      }),
      execute: async ({ status, summary, risks, next_steps }) => {
        if (status === "success" && ctx.state.changedFiles.size > 0 && !ctx.state.review.passed) {
          return fail(
            "Cannot finish with status 'success': there are changes but no passing code review. Load the code-reviewer skill, review the diff, and call record_review with passed=true first.",
          );
        }
        ctx.state.finish = { status, summary, risks, next_steps };
        return ok({ accepted: true });
      },
    }),
  };
}
