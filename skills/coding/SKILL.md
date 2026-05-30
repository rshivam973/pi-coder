---
name: coding
description: Implement the change cleanly and minimally, matching the surrounding code style.
---

# Coding

Implement the task. The goal is the smallest correct change that satisfies the acceptance criteria.

## Process

1. **Locate** the exact code to change with `search` and `read_file`. Understand it before editing.
2. **Match the codebase.** Follow the existing naming, structure, error handling, and comment density. Your
   change should read like the surrounding code wrote it.
3. **Edit** with `write_file` (full file contents). Only touch files the task requires.
4. **Build/run as you go** with the `run` tool to catch errors early.

## Rules

- Stay strictly in scope. No unrelated refactors, renames, or formatting churn.
- No leftover debug prints, commented-out code, or `TODO`s unless the task explicitly calls for them.
- Never hard-code secrets. Never weaken security or auth to make something pass.
- If you must change a file outside the write allowlist, you can't — rethink the approach within scope.

When the implementation is in place, load the **testing** skill to validate it.
