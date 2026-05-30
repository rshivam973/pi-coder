/**
 * Preflight / environment validation (TRD §5 init, §14). Checks the toolchain
 * and, when a task is supplied, the provider key and GitHub PAT access. Reused
 * by the `run` bootstrap so a bad environment fails fast and clearly.
 */
import { exec } from "./exec.ts";
import { resolveApiKey, ProviderError } from "./providers.ts";
import { GitHubClient } from "./github.ts";
import { parseRepoCoords } from "./git.ts";
import type { Task } from "./contracts.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: Check[];
}

async function toolCheck(name: string, command: string): Promise<Check> {
  const res = await exec(command, { cwd: process.cwd(), timeoutMs: 10_000 });
  return {
    name,
    ok: res.exitCode === 0,
    detail: res.exitCode === 0 ? res.stdout.trim().split("\n")[0]! : `not found (exit ${res.exitCode})`,
  };
}

export async function runPreflight(task?: Task): Promise<PreflightReport> {
  const checks: Check[] = [];

  checks.push({ name: "bun", ok: true, detail: Bun.version });
  checks.push(await toolCheck("git", "git --version"));
  checks.push(await toolCheck("ripgrep", "rg --version"));

  if (task) {
    // Provider key presence.
    try {
      resolveApiKey(task.provider);
      checks.push({ name: "provider_key", ok: true, detail: `${task.provider.name} key present (${task.provider.api_key_env})` });
    } catch (err) {
      checks.push({
        name: "provider_key",
        ok: false,
        detail: err instanceof ProviderError ? err.message : String(err),
      });
    }

    // GitHub PAT + repo access.
    const token = process.env[task.github.token_env];
    if (!token) {
      checks.push({ name: "github_pat", ok: false, detail: `env ${task.github.token_env} is unset` });
    } else {
      try {
        const { owner, name } = parseRepoCoords(task.repo);
        await new GitHubClient({ token, owner, repo: name }).validateAccess();
        checks.push({ name: "github_pat", ok: true, detail: `access to ${owner}/${name} confirmed` });
      } catch (err) {
        checks.push({ name: "github_pat", ok: false, detail: (err as Error).message });
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
