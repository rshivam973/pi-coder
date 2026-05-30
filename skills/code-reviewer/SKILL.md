---
name: code-reviewer
description: Review your own diff against the task — relevance, completeness, correctness — and gate the result.
---

# Code Reviewer

This is a GATE, not advice. Review your own work critically before it becomes a PR, then record the outcome
with the `record_review` tool.

## Review the diff

Run `git_diff` and read the full change. Judge it against the task instructions and acceptance criteria:

1. **Relevance** — does every change map to the task? Flag any out-of-scope edits, unrelated refactors, or
   files that shouldn't have changed. Changes outside the task's intent are a failure.
2. **Completeness** — are the acceptance criteria actually met? Is there a test that proves it?
3. **Correctness & quality** — obvious bugs, unhandled edge cases, leftover debug code or `TODO`s, broken
   formatting, or anything that wouldn't pass human review.
4. **Safety** — no secrets, credentials, or tokens in the diff; no weakened security.

## Record the outcome

- If you find problems: call `record_review` with `passed: false` and a `findings` list. Then go back, load
  the **coding** skill, fix the issues, re-run **testing**, and review again.
- Only when the diff is relevant, complete, correct, and clean: call `record_review` with `passed: true`.

You cannot finish the task with status "success" until a review has passed. When it has, load the **git** skill.
