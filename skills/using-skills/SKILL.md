---
name: using-skills
description: How pi-coder should pick and sequence skills for a coding task. Read this first.
---

# Using Skills

You complete a task by loading skills in order and following each one. Load a skill with the
`use_skill` tool right before you do that kind of work — don't try to remember instructions, load them.

## Workflow order

1. **prd-maker** — only for larger or ambiguous tasks. Clarify what "done" means. Skip for small, clear fixes.
2. **trd-maker** — only when prd-maker was used or the technical approach is non-obvious. Decide the approach.
3. **coding** — implement the change. Mandatory.
4. **testing** — run and/or write tests, lint, typecheck until green. Mandatory.
5. **code-reviewer** — review your own diff against the task. Mandatory. Ends by calling `record_review`.
6. **git** — commit your work with the required message format. Mandatory.

The core **coding → testing → code-reviewer → git** sequence is always required. Steps 1–2 are optional and
should be skipped for small tasks to avoid wasted work.

## Principles

- **Explore before editing.** Use `list_tree`, `search`, and `read_file` to understand the codebase first.
- **Stay in scope.** Only change what the task requires. No drive-by refactors.
- **Respect the allowlist.** `write_file` rejects paths outside the allowed directories — work within them.
- **Iterate.** If tests fail or the review finds problems, go back, fix, and re-check.
- **Finish explicitly.** When the work is committed and reviewed, call the `finish` tool with a status and summary.

Now decide whether the task needs planning (prd-maker) or is small enough to start coding. Then load the next skill.
