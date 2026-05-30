# pi-coder

An interactive, skill-driven coding agent CLI. Given a task spec, it runs **inside a sandbox**: clones a
repo, implements the change with a pluggable LLM, validates it (tests/lint/typecheck), self-reviews the diff,
commits, and opens a Pull Request — streaming live progress and accepting live control (chat/status/stop).

Built per [TRD.md](../TRD.md). This is sub-project 1 of the Agentic PR Factory; the orchestrator + frontend
(sub-project 2) install and drive `pi-coder` inside Daytona sandboxes.

## Requirements (in the sandbox)
`bun` ≥ 1.1, `git`, `ripgrep` (`rg`), plus the runtime for the target repo (Node and/or Python).

## Install
```bash
bun install
```

## Commands
```bash
pi-coder init   [--task task.json]                 # validate env, provider key, GitHub PAT
pi-coder run    --task task.json [--output result.json] [--workdir DIR] [--no-input] [--max-steps N] [--max-runtime SEC]
pi-coder validate   --result result.json           # schema-check a result
pi-coder summarize  --result result.json           # print the PR-body summary
```

Secrets are passed via **environment variables** named in the task (never inline):
```bash
export OPENROUTER_API_KEY=sk-or-...
export GITHUB_TOKEN=ghp_...
pi-coder run --task examples/task.example.json
```

## Protocols
- **stdout** — NDJSON event stream (one event per line): `session_start`, `phase`, `skill_loaded`,
  `llm_text`, `tool_call`, `tool_result`, `test_run`, `review`, `git`, `pr_created`, `status_report`,
  `interrupted`, `resumed`, `stopping`, `done`, `error`. The platform relays these to the browser.
- **stdin** — NDJSON control commands: `{"type":"chat","text":"…"}`, `{"type":"status"}`,
  `{"type":"interrupt"}`, `{"type":"resume"}`, `{"type":"stop"}`.
- **stderr** — human-readable structured logs (also written to `.pi-coder/logs/session.log`).

## How it works
1. Validate environment (`init.ts`), clone the repo, detect the tool profile (`profiles.ts`).
2. Run the **manual agent loop** (`session.ts`): one model step per iteration via the Vercel AI SDK, draining
   control commands between steps so the user can chat / interrupt / stop. A wall-clock `AbortController`
   enforces the timeout.
3. The agent works through bundled **skills** (`skills/`): `using-skills` → `prd-maker` → `trd-maker` →
   `coding` → `testing` → `code-reviewer` → `git`. The `code-reviewer` step is a **gate** — `finish` with
   status `success` is refused until a review passes.
4. Finalize (`run.ts`): commit, push, open the PR via Octokit, write a schema-valid `result.json`.

## Providers
Pluggable via the task's `provider` block (`providers.ts`): `openrouter` (default), `anthropic`, `openai`.

## Tests
```bash
bun test          # unit + integration (mock provider, local git, no network)
bun run typecheck
```

## Project layout
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
