---
name: git
description: Commit the reviewed work with the required message format, then finish the task.
---

# Git

Commit your work. The system handles pushing the branch and opening the Pull Request after you finish — you do
NOT push or open the PR yourself.

## Commit

1. Run `git_status` and `git_diff` to confirm exactly what you're about to commit. It should match your
   reviewed change and nothing else.
2. Commit with the `git_commit` tool using this title format (required):

   ```
   [agentic] issue-<id>: <short imperative title>
   ```

   Use the issue id from the task. Keep the title under ~72 chars. Add a short body explaining what and why if
   the change is non-trivial.

## Finish

After committing, call the `finish` tool with:

- `status`: `success` if the task is complete and the review passed; `partial` if you made progress but
  couldn't fully finish; `failed` if you could not implement it.
- `summary`: what you changed, in a sentence or two (used for the PR title and body).
- `risks`: anything a reviewer should watch for.
- `next_steps`: follow-ups, if any.

Do not call `finish` with `success` unless the code review passed and your work is committed.
