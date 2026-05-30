---
name: prd-maker
description: Draft a brief product requirements summary for larger or ambiguous tasks before coding.
---

# PRD Maker

Use this ONLY for larger or ambiguous tasks. For a small, well-specified fix, skip it and start coding.

Produce a short, focused product spec — a few sentences per section, not a long document:

1. **Problem** — what is broken or missing, from the user's perspective.
2. **Goal** — what "done" looks like. Restate the acceptance criteria in concrete terms.
3. **Scope** — what you WILL change and, just as important, what you will NOT touch.
4. **Acceptance checks** — the observable behaviors or tests that prove the task is complete.

Keep it in your reasoning. If the repository clearly documents features (e.g. a `docs/` directory) and writing a
short spec file is genuinely part of the task, you may write one with `write_file` inside an allowed path —
otherwise do not create files.

When the goal and scope are clear, load the **trd-maker** skill (for non-trivial approaches) or **coding**.
