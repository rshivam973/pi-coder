---
name: testing
description: Validate the change with tests, lint, and typecheck; add regression coverage; iterate to green.
---

# Testing

Prove the change works and didn't break anything.

## Process

1. **Add coverage.** Write or update a test that fails without your change and passes with it — this is the
   regression test that proves the fix/feature. Put it where the project's other tests live.
2. **Run tests** with the `run_tests` tool. If it reports "skipped", the project has no detected test command;
   note that and rely on `run` for any project-specific verification.
3. **Lint and typecheck** with `run_lint` and `run_typecheck`. Fix what they flag (within scope).
4. **Iterate.** If anything fails, return to the code, fix it, and re-run. Don't proceed with red checks.

## Handling failures

- Read the actual error output — don't guess. Use `read_file`/`search` to find the cause.
- If a test is flaky, re-run it once in a clean state before treating it as a real failure.
- If a pre-existing, unrelated test is already failing, note it as a risk rather than trying to fix it.

When the relevant checks are green, load the **code-reviewer** skill.
