/**
 * Git operations (TRD §9, §11). Thin, typed wrappers over `git` via exec().
 * The GitHub PAT is embedded in the remote URL for clone/push (acceptable in an
 * ephemeral sandbox); it is never logged.
 */
import { exec, type ExecResult } from "./exec.ts";

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RepoCoords {
  /** owner/name parsed from the repo URL. */
  owner: string;
  name: string;
}

/** Parse owner/name from a github URL (https or git@). */
export function parseRepoCoords(repoUrl: string): RepoCoords {
  const cleaned = repoUrl.replace(/\.git$/, "");
  const m =
    cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/) ?? cleaned.match(/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error(`Cannot parse owner/repo from URL: ${repoUrl}`);
  return { owner: m[1]!, name: m[2]! };
}

/** Build an https clone URL with the token embedded for authentication. */
export function authenticatedUrl(repoUrl: string, token: string): string {
  const httpsUrl = repoUrl.startsWith("git@")
    ? repoUrl.replace(/^git@github\.com:/, "https://github.com/")
    : repoUrl;
  return httpsUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

interface GitCtx {
  cwd: string;
  signal?: AbortSignal;
  logPath?: string;
}

async function git(args: string, ctx: GitCtx): Promise<ExecResult> {
  return exec(`git ${args}`, { cwd: ctx.cwd, signal: ctx.signal, logPath: ctx.logPath, timeoutMs: 300_000 });
}

async function gitOrThrow(args: string, ctx: GitCtx, label: string): Promise<ExecResult> {
  const res = await git(args, ctx);
  if (res.exitCode !== 0) {
    throw new GitError(`${label} failed (exit ${res.exitCode}): ${res.stderr.trim()}`, res);
  }
  return res;
}

export interface CloneOptions {
  repo: string;
  baseRef: string;
  workdir: string;
  token: string;
  signal?: AbortSignal;
  logPath?: string;
}

/** Clone the repo at baseRef into workdir. workdir must not yet exist. */
export async function cloneRepo(opts: CloneOptions): Promise<void> {
  const url = authenticatedUrl(opts.repo, opts.token);
  const parentCtx: GitCtx = { cwd: process.cwd(), signal: opts.signal, logPath: opts.logPath };
  await gitOrThrow(
    `clone --depth 1 --branch ${shellQuote(opts.baseRef)} ${shellQuote(url)} ${shellQuote(opts.workdir)}`,
    parentCtx,
    "git clone",
  );
  // Identify the committer inside the sandbox.
  const ctx: GitCtx = { cwd: opts.workdir, signal: opts.signal, logPath: opts.logPath };
  await git(`config user.email "pi-coder@agents.local"`, ctx);
  await git(`config user.name "pi-coder"`, ctx);
}

export async function createBranch(branch: string, ctx: GitCtx): Promise<void> {
  await gitOrThrow(`checkout -b ${shellQuote(branch)}`, ctx, "git checkout -b");
}

export async function status(ctx: GitCtx): Promise<string> {
  return (await git("status --porcelain", ctx)).stdout;
}

export async function diff(staged: boolean, ctx: GitCtx): Promise<string> {
  return (await git(`diff${staged ? " --cached" : ""}`, ctx)).stdout;
}

export interface CommitOptions {
  message: string;
  files?: string[];
  noVerify?: boolean;
}

/** Stage (all, or the given files) and commit. Returns false if nothing to commit. */
export async function commit(opts: CommitOptions, ctx: GitCtx): Promise<boolean> {
  const add = opts.files && opts.files.length > 0 ? opts.files.map(shellQuote).join(" ") : "-A";
  await gitOrThrow(`add ${add}`, ctx, "git add");
  const staged = (await git("diff --cached --name-only", ctx)).stdout.trim();
  if (staged.length === 0) return false;
  const flags = opts.noVerify ? " --no-verify" : "";
  await gitOrThrow(`commit${flags} -m ${shellQuote(opts.message)}`, ctx, "git commit");
  return true;
}

export async function push(branch: string, ctx: GitCtx): Promise<void> {
  await gitOrThrow(`push -u origin ${shellQuote(branch)}`, ctx, "git push");
}

/** Files changed between baseRef and HEAD. */
export async function changedFiles(baseRef: string, ctx: GitCtx): Promise<string[]> {
  const res = await git(`diff --name-only origin/${shellQuote(baseRef)}...HEAD`, ctx);
  if (res.exitCode !== 0) {
    // Fall back to working-tree changes when the base ref isn't fetched (shallow clone).
    const wt = await git("diff --name-only HEAD", ctx);
    return splitLines(wt.stdout);
  }
  return splitLines(res.stdout);
}

export interface NumStat {
  additions: number;
  deletions: number;
  files: number;
}

/** Aggregate +/- line and file counts for the commits on this branch. */
export async function diffStats(baseRef: string, ctx: GitCtx): Promise<NumStat> {
  let res = await git(`diff --numstat origin/${shellQuote(baseRef)}...HEAD`, ctx);
  if (res.exitCode !== 0) res = await git("diff --numstat HEAD", ctx);
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of splitLines(res.stdout)) {
    const [add, del] = line.split("\t");
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
    files += 1;
  }
  return { additions, deletions, files };
}

/** Write the unified patch for this branch to outPath. */
export async function writePatch(baseRef: string, outPath: string, ctx: GitCtx): Promise<void> {
  let res = await git(`diff origin/${shellQuote(baseRef)}...HEAD`, ctx);
  if (res.exitCode !== 0) res = await git("diff HEAD", ctx);
  await Bun.write(outPath, res.stdout);
}

// --- helpers --------------------------------------------------------------

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Minimal POSIX single-quote escaping for embedding values in a bash -lc string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
