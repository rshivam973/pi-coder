---
name: trd-maker
description: Decide the concrete technical approach — files, functions, and tests — before writing code.
---

# TRD Maker

Translate the task (and PRD, if you made one) into a concrete technical plan. Keep it short and specific.

1. **Affected files** — list the files you expect to read and change. Confirm they're inside the write allowlist.
2. **Approach** — the smallest change that satisfies the task. Note the functions/modules involved.
3. **Tests** — which existing tests cover this, and what new test(s) you'll add to prove the fix/feature.
4. **Risks** — edge cases, backwards-compatibility concerns, anything that could break.

Verify your assumptions against the real code with `read_file` and `search` before committing to the plan —
don't plan against files you haven't looked at.

When the approach is clear, load the **coding** skill.
