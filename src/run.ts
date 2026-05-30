/**
 * Session bootstrap + finalize (TRD §7.2, §11, §14). Reads the task, validates
 * the environment, clones the repo, runs the interactive agent loop, then
 * commits/pushes/opens a PR and writes result.json. Always produces a
 * schema-valid result, even on failure, so the platform has a structured
 * outcome.
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseTask,
  type Task,
  type Result,
  type ResultStatus,
  type CommandExecution,
} from "./contracts.ts";
import { EventEmitter } from "./events.ts";
import { Logger } from "./logger.ts";
import { runPreflight } from "./init.ts";
import { getModel } from "./providers.ts";
import { loadSkills, SkillRegistry } from "./skills.ts";
import { resolveProfile } from "./profiles.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { createRunState, createTools, type RunState, type ToolContext } from "./tools.ts";
import { Session, type StopReason } from "./session.ts";
import { ControlChannel, NullControlChannel, type ControlSource } from "./control.ts";
import { buildPrTitle, buildPrBody, buildSummaryMarkdown } from "./report.ts";
import { GitHubClient } from "./github.ts";
import * as git from "./git.ts";

export interface RunOptions {
  taskPath: string;
  outputPath: string;
  workdir: string;
  noInput: boolean;
  maxStepsOverride?: number;
  maxRuntimeOverride?: number;
}

interface Dirs {
  piDir: string;
  logDir: string;
  artifactsDir: string;
  logPath: string;
}

function makeDirs(): Dirs {
  const piDir = resolve(".pi-coder");
  const logDir = join(piDir, "logs");
  const artifactsDir = join(piDir, "artifacts");
  return { piDir, logDir, artifactsDir, logPath: join(logDir, "session.log") };
}

/** Map the loop's stop reason + agent finish into the final result status. */
function finalStatus(reason: StopReason, state: RunState): ResultStatus {
  if (reason === "finished" && state.finish) return state.finish.status;
  if (reason === "error") return "failed";
  return "partial"; // stop_command, max_steps, timeout
}

function blockedReasons(reason: StopReason, prFailed: boolean): string[] {
  const out: string[] = [];
  if (reason === "max_steps") out.push("max_steps_reached");
  if (reason === "timeout") out.push("max_runtime_reached");
  if (prFailed) out.push("pr_failed");
  return out;
}

export async function runTask(opts: RunOptions): Promise<Result> {
  const dirs = makeDirs();
  const raw = await Bun.file(opts.taskPath).json();
  const task: Task = parseTask(raw);
  if (opts.maxStepsOverride) task.constraints.max_steps = opts.maxStepsOverride;
  if (opts.maxRuntimeOverride) task.constraints.max_runtime_sec = opts.maxRuntimeOverride;

  const emitter = new EventEmitter();
  const logger = new Logger({ logPath: dirs.logPath, taskId: task.task_id });
  emitter.emit({
    type: "session_start",
    task_id: task.task_id,
    repo: task.repo,
    provider: task.provider.name,
    model: task.provider.model,
  });

  const state = createRunState();
  const branch = `pi-coder/issue-${task.issue_id}`;

  // --- preflight ----------------------------------------------------------
  const preflight = await runPreflight(task);
  if (!preflight.ok) {
    for (const c of preflight.checks.filter((c) => !c.ok)) {
      emitter.error("preflight_failed", `${c.name}: ${c.detail}`, true);
    }
    return finalize({ task, state, dirs, emitter, logger, branch, reason: "error", prUrl: null, prFailed: false, outputPath: opts.outputPath });
  }

  // --- clone --------------------------------------------------------------
  emitter.phase("clone");
  const token = process.env[task.github.token_env]!;
  const workdir = resolve(opts.workdir);
  if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.constraints.max_runtime_sec * 1000);

  try {
    await git.cloneRepo({ repo: task.repo, baseRef: task.base_ref, workdir, token, signal: controller.signal, logPath: join(dirs.logDir, "git.log") });
  } catch (err) {
    clearTimeout(timer);
    emitter.error("clone_failed", (err as Error).message, true);
    const r = await finalize({ task, state, dirs, emitter, logger, branch, reason: "error", prUrl: null, prFailed: false, outputPath: opts.outputPath, extraBlocked: ["clone_failed"] });
    return r;
  }

  const gitCtx = { cwd: workdir, signal: controller.signal, logPath: join(dirs.logDir, "git.log") };
  await git.createBranch(branch, gitCtx);
  emitter.emit({ type: "git", action: "branch", detail: branch });

  // --- setup agent --------------------------------------------------------
  const profile = resolveProfile(workdir, task.tool_profile, task.command_overrides);
  const skills = loadSkills();
  const registry = new SkillRegistry(skills);
  const systemPrompt = buildSystemPrompt(task, profile, skills);
  const model = getModel(task.provider);

  const ctx: ToolContext = {
    workdir,
    task,
    profile,
    skills: registry,
    emitter,
    logger,
    logDir: dirs.logDir,
    signal: controller.signal,
    state,
  };
  const tools = createTools(ctx);

  const control: ControlSource = opts.noInput
    ? new NullControlChannel()
    : new ControlChannel({ onMalformed: (line) => emitter.error("bad_control", `ignored: ${line.slice(0, 80)}`, false) });

  // --- run loop -----------------------------------------------------------
  const session = new Session({
    model,
    tools,
    systemPrompt,
    task,
    state,
    emitter,
    logger,
    control,
    signal: controller.signal,
    startedAt: performance.now(),
  });

  let reason: StopReason = "error";
  try {
    ({ reason } = await session.run());
  } catch (err) {
    logger.error("session crashed", { error_type: "session_crash" });
    emitter.error("session_crash", (err as Error).message, true);
  } finally {
    clearTimeout(timer);
    control.close();
  }

  // --- finalize -----------------------------------------------------------
  emitter.phase("git");
  let prUrl: string | null = null;
  let prFailed = false;

  try {
    // Commit any work the agent left uncommitted (e.g. on stop/timeout).
    const dirty = (await git.status(gitCtx)).trim().length > 0;
    if (dirty) {
      await git.commit({ message: `[agentic] issue-${task.issue_id}: work in progress (auto-commit)` }, gitCtx);
    }
    for (const f of await git.changedFiles(task.base_ref, gitCtx)) state.changedFiles.add(f);

    if (state.changedFiles.size > 0) {
      await git.push(branch, gitCtx);
      emitter.emit({ type: "git", action: "push", detail: branch });

      const stats = await git.diffStats(task.base_ref, gitCtx);
      const preResult = buildResult({ task, state, dirs, reason, prUrl: null, blocked: [], diffStats: stats });
      const gh = ghClient(task, token);
      try {
        const pr = await gh.createPullRequest({
          head: branch,
          base: task.github.pr_target_ref ?? task.base_ref,
          title: buildPrTitle(task, preResult),
          body: buildPrBody(task, preResult),
        });
        prUrl = pr.url;
        emitter.emit({ type: "pr_created", url: pr.url, number: pr.number });
      } catch (err) {
        prFailed = true;
        emitter.error("pr_failed", (err as Error).message, false);
      }
    }
  } catch (err) {
    emitter.error("finalize_failed", (err as Error).message, false);
  }

  return finalize({ task, state, dirs, emitter, logger, branch, reason, prUrl, prFailed, outputPath: opts.outputPath, gitCtx, baseRef: task.base_ref });
}

function ghClient(task: Task, token: string): GitHubClient {
  const { owner, name } = git.parseRepoCoords(task.repo);
  return new GitHubClient({ token, owner, repo: name });
}

interface FinalizeArgs {
  task: Task;
  state: RunState;
  dirs: Dirs;
  emitter: EventEmitter;
  logger: Logger;
  branch: string;
  reason: StopReason;
  prUrl: string | null;
  prFailed: boolean;
  outputPath: string;
  extraBlocked?: string[];
  gitCtx?: { cwd: string; signal?: AbortSignal; logPath?: string };
  baseRef?: string;
}

/** Build the result, write artifacts + result.json, emit done. */
async function finalize(args: FinalizeArgs): Promise<Result> {
  const { task, state, dirs, emitter, reason, prUrl, prFailed, outputPath } = args;

  let diffPatchPath: string | null = null;
  if (args.gitCtx && args.baseRef && state.changedFiles.size > 0) {
    diffPatchPath = join(dirs.artifactsDir, "changes.patch");
    try {
      await git.writePatch(args.baseRef, diffPatchPath, args.gitCtx);
    } catch {
      diffPatchPath = null;
    }
  }

  let diffStats: git.NumStat | undefined;
  if (args.gitCtx && args.baseRef) {
    try {
      diffStats = await git.diffStats(args.baseRef, args.gitCtx);
    } catch {
      /* leave undefined → falls back to file count */
    }
  }

  const blocked = [...(args.extraBlocked ?? []), ...blockedReasons(reason, prFailed)];
  const result = buildResult({ task, state, dirs, reason, prUrl, blocked, diffPatchPath, diffStats });

  // Summary markdown artifact.
  try {
    const summaryPath = join(dirs.artifactsDir, "summary.md");
    await Bun.write(summaryPath, buildSummaryMarkdown(result));
    result.artifacts.summary_md = summaryPath;
  } catch {
    /* best-effort */
  }

  await Bun.write(outputPath, JSON.stringify(result, null, 2));
  emitter.phase("done");
  emitter.emit({ type: "done", status: result.status, result_path: resolve(outputPath) });
  return result;
}

interface BuildResultArgs {
  task: Task;
  state: RunState;
  dirs: Dirs;
  reason: StopReason;
  prUrl: string | null;
  blocked: string[];
  diffPatchPath?: string | null;
  diffStats?: git.NumStat;
}

function buildResult(args: BuildResultArgs): Result {
  const { task, state, dirs, reason, prUrl, blocked } = args;
  const status = finalStatus(reason, state);
  const finish = state.finish;

  const tests: CommandExecution[] = state.testsExecuted;
  const diff_stats = args.diffStats ?? { additions: 0, deletions: 0, files: state.changedFiles.size };

  return {
    task_id: task.task_id,
    status,
    summary: finish?.summary ?? defaultSummary(reason, state),
    changed_files: [...state.changedFiles],
    tests_executed: tests,
    lint_executed: state.lintExecuted,
    typecheck_executed: state.typecheckExecuted,
    review: state.review,
    diff_stats,
    blocked_by: blocked,
    risks: finish?.risks ?? [],
    next_steps: finish?.next_steps ?? [],
    artifacts: {
      log_path: dirs.logPath,
      diff_patch: args.diffPatchPath ?? null,
      summary_md: null,
      prd_md: null,
      trd_md: null,
      pr_url: prUrl,
    },
  };
}

function defaultSummary(reason: StopReason, state: RunState): string {
  switch (reason) {
    case "stop_command":
      return `Run stopped by user after touching ${state.changedFiles.size} file(s).`;
    case "max_steps":
      return "Run hit the step budget before the agent finished.";
    case "timeout":
      return "Run hit the wall-clock timeout before the agent finished.";
    case "error":
      return "Run failed before completion.";
    default:
      return "Run completed.";
  }
}
