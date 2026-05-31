# pi-coder

An interactive, skill-driven **coding agent CLI** that runs inside a sandbox. Given a task, it clones a repo,
implements the change with a pluggable LLM, validates it (tests / lint / typecheck), self-reviews the diff,
commits, opens a GitHub Pull Request — and then **stays alive to chat about the changes** until you stop it.

It streams its progress as machine-readable events and accepts live control (chat / status / interrupt / stop),
so a UI can show what it's doing and steer it in real time.

> pi-coder is **sub-project 1** of the Agentic PR Factory. It's transport-agnostic — driven entirely by a
> `task.json` file + environment variables — so the platform (sub-project 2) can install and drive it inside a
> Daytona sandbox without any changes here.

---

## Table of contents
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [CLI](#cli)
- [task.json (input)](#taskjson-input)
- [result.json (output)](#resultjson-output)
- [Event protocol (stdout)](#event-protocol-stdout)
- [Control protocol (stdin)](#control-protocol-stdin)
- [Skills](#skills)
- [Tool profiles](#tool-profiles)
- [Agent tools](#agent-tools)
- [Discussion mode](#discussion-mode)
- [Security & guardrails](#security--guardrails)
- [Project structure](#project-structure)
- [Testing](#testing)

---

## How it works

```
 task.json + env (LLM key, GitHub PAT)
        │
        ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ pi-coder run                                                    │
  │  1. init / preflight   (bun, git, rg, keys, PAT valid)          │
  │  2. clone repo @ base_ref                                       │
  │  3. detect tool profile (node / python)                         │
  │  4. AGENT LOOP — one model step per iteration:                  │
  │       use_skill → coding → testing → code-reviewer (gate) → git │
  │       (control commands drained between steps)                  │
  │  5. on finish: commit → push → open PR                          │
  │  6. DISCUSSION MODE — stay alive, answer questions read-only    │
  │  7. write result.json                                           │
  └───────────────────────────────────────────────────────────────┘
        │  stdout: NDJSON events   stdin: NDJSON control   stderr: logs
        ▼
```

The agent loop is a **manual one-model-step-per-iteration loop** (Vercel AI SDK `streamText` +
`stopWhen: stepCountIs(1)`). Running one step at a time is what lets pi-coder drain control commands *between*
steps — so you can chat, interrupt, or stop mid-run. A wall-clock `AbortController` bounds the work phase.

The agent works by loading **skills** (markdown instruction modules) and calling **tools** (read/write/run/git…).
The `code-reviewer` skill is a **gate**: the agent cannot finish with `success` while there are changes and no
passing review.

---

## Requirements

In the sandbox/host: `bun` ≥ 1.1, `git`, `ripgrep` (`rg`), plus the runtime for the target repo (Node and/or
Python). `pi-coder init` validates all of this.

---

## Install

```bash
bun install
```

Secrets are provided via **environment variables** named in the task (never inline in `task.json`):

```bash
export OPENROUTER_API_KEY=sk-or-...   # whatever provider.api_key_env points to
export GITHUB_TOKEN=ghp_...           # whatever github.token_env points to
```

---

## CLI

| Command | Description |
|---------|-------------|
| `pi-coder init [--task task.json]` | Validate environment (bun/git/rg, and — with `--task` — the provider key + GitHub PAT/repo access). Prints a JSON readiness report. |
| `pi-coder run --task <path> [--output result.json] [--workdir <dir>] [--no-input] [--max-steps N] [--max-runtime SEC]` | Run a session. NDJSON events → stdout, logs → stderr, control ← stdin. Writes `result.json`. |
| `pi-coder validate --result <path>` | Schema-check a `result.json`. |
| `pi-coder summarize --result <path>` | Print the PR-body summary from a result. |

**Flags:** `--no-input` disables the control channel (autonomous/CI mode, skips discussion). `--max-steps` /
`--max-runtime` override the task constraints.

**Exit codes:** `0` success · `1` failed · `2` invalid input · `3` preflight failure · `4` partial.

---

## task.json (input)

```jsonc
{
  "task_id": "uuid",
  "repo": "https://github.com/org/repo.git",
  "base_ref": "main",
  "issue_id": "ISSUE-123",                 // optional — used in branch/commit/PR naming
  "instructions": "Fix the off-by-one in pagination; add a regression test.",
  "acceptance_criteria": "Tests pass; new test covers the boundary.",  // optional
  "constraints": {
    "max_steps": 40,
    "max_runtime_sec": 1800,
    "allow_network": true,
    "allow_write": ["./src", "./test"]      // write_file is rejected outside these
  },
  "tool_profile": "auto",                   // auto | node | python
  "command_overrides": {                    // optional, win over detection
    "install": "...", "test": "...", "lint": "...", "typecheck": "..."
  },
  "provider": {
    "name": "openrouter",                   // openrouter | anthropic | openai
    "model": "anthropic/claude-sonnet-4",
    "api_key_env": "OPENROUTER_API_KEY"     // env var NAME (not the key)
  },
  "github": {
    "token_env": "GITHUB_TOKEN",
    "pr_target_ref": "main"                 // optional, defaults to base_ref
  }
}
```

Validated with zod at the boundary (`src/contracts.ts`). See `examples/task.example.json`.

---

## result.json (output)

```jsonc
{
  "task_id": "...",
  "status": "success" | "partial" | "failed",
  "summary": "...",
  "changed_files": ["..."],
  "tests_executed": [{ "name", "command", "exit_code", "duration_ms", "log_path" }],
  "lint_executed": { ... } | null,
  "typecheck_executed": { ... } | null,
  "review": { "passed": bool, "iterations": n, "findings": ["..."] },
  "diff_stats": { "additions": n, "deletions": n, "files": n },
  "blocked_by": ["..."],
  "risks": ["..."],
  "next_steps": ["..."],
  "artifacts": { "log_path", "diff_patch", "summary_md", "prd_md", "trd_md", "pr_url" }
}
```

---

## Event protocol (stdout)

One JSON object per line. Envelope: `{ "type", "ts", "step", ...payload }`. **stdout carries only events** —
human logs go to stderr / `.pi-coder/logs/session.log`.

| `type` | Meaning |
|--------|---------|
| `session_start` | run began (task_id, repo, provider, model) |
| `phase` | phase change: `clone` `plan` `code` `test` `review` `git` `discuss` `done` |
| `skill_loaded` | agent loaded a skill |
| `llm_text` | streamed model text (deltas) |
| `tool_call` / `tool_result` | a tool was invoked / returned |
| `test_run` | a test/lint/typecheck command finished |
| `review` | code-reviewer gate outcome (passed, findings, iteration) |
| `git` | branch / commit / push |
| `pr_created` | PR opened (url, number) |
| `status_report` | response to a `status` command |
| `interrupted` / `resumed` / `stopping` | control-state transitions |
| `done` | session finished (status, result_path) |
| `error` | recoverable or fatal error |

## Control protocol (stdin)

One JSON object per line:

| Command | Effect |
|---------|--------|
| `{"type":"chat","text":"…"}` | inject a message — steer the agent or ask a question |
| `{"type":"status"}` | emit a `status_report` |
| `{"type":"interrupt"}` / `{"type":"resume"}` | pause at the next safe point / continue |
| `{"type":"stop"}` | end gracefully (commit/push/PR what exists, write a partial result) |

---

## Skills

Markdown `SKILL.md` modules under `skills/`, each with `name` + `description` frontmatter. At startup their
descriptions are injected into the system prompt as a catalog; the agent loads a full skill on demand with the
`use_skill` tool.

Bundled: `using-skills` (meta) · `prd-maker` · `trd-maker` · `coding` · `testing` · **`code-reviewer`** (gate) ·
`git`. Workflow order: `using-skills → prd-maker → trd-maker → coding → testing → code-reviewer → git` (small
tasks skip the planning skills; the `coding → testing → code-reviewer → git` core is mandatory).

Add a skill = drop in a new `skills/<name>/SKILL.md` folder. No code change.

---

## Tool profiles

`src/profiles.ts` auto-detects commands (task `command_overrides` always win):

- **Node** — package manager from lockfile (pnpm > npm > yarn); `test`/`lint` from `package.json` scripts;
  `tsc --noEmit` if `tsconfig.json`.
- **Python** — `uv` if `pyproject.toml`/`uv.lock`, else `pip` + `requirements.txt`; `pytest -q`; ruff/mypy if
  configured.

---

## Agent tools

`read_file`, `write_file` (allowlist-guarded), `list_tree`, `search` (ripgrep), `run` (shell w/ timeout),
`git_status`, `git_diff`, `git_commit`, `run_tests`, `run_lint`, `run_typecheck`, `use_skill`, `record_review`,
`finish`. During discussion mode only the read-only subset is used.

---

## Discussion mode

When the agent finishes, the PR is opened immediately and the session **does not exit** — it switches to a
read-only conversational phase keeping its full context (the diff it just made). You can ask about the changes
or the codebase; it answers using read-only tools. It ends on `{"type":"stop"}` or after an idle timeout
(`standbyIdleSec`, default 900s). Disabled under `--no-input`.

---

## Security & guardrails

- `write_file` rejects paths outside `constraints.allow_write`; the reviewer flags out-of-scope edits.
- Every subprocess has a timeout; the work phase has a wall-clock cap.
- Secrets come from env, are never logged, and are redacted from tool-call events.
- Finalize (commit/push/PR) runs without the work-phase abort signal so a timeout can't corrupt it.

---

## Project structure

```
src/
  cli.ts        run.ts       session.ts    contracts.ts
  providers.ts  profiles.ts  skills.ts     prompt.ts
  tools.ts      paths.ts     exec.ts       git.ts
  github.ts     report.ts    events.ts     control.ts   logger.ts   init.ts
skills/         # markdown SKILL.md library
examples/       # example task.json
test/           # bun tests
```

---

## Testing

```bash
bun test          # unit + integration (mock provider, local git, no network)
bun run typecheck
bun run build     # bun build --compile → dist/pi-coder
```

Integration tests drive the full loop with a scripted mock model against a temp git repo — including the
review gate and the discussion phase — with no real LLM or network.
