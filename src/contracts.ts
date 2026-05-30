/**
 * Data contracts for pi-coder (TRD §6).
 *
 * Everything that crosses a process boundary — the input task, the output
 * result, the stdout event stream, and the stdin control stream — is defined
 * and validated here with zod. Secrets never appear in these contracts; the
 * task references env var *names* only (TRD §12).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// task.json (input) — TRD §6.1
// ---------------------------------------------------------------------------

export const providerNameSchema = z.enum(["openrouter", "anthropic", "openai"]);
export type ProviderName = z.infer<typeof providerNameSchema>;

export const providerConfigSchema = z.object({
  name: providerNameSchema,
  model: z.string().min(1),
  /** Name of the env var holding the API key (not the key itself). */
  api_key_env: z.string().min(1),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const constraintsSchema = z.object({
  max_steps: z.number().int().positive().default(40),
  max_runtime_sec: z.number().int().positive().default(1800),
  allow_network: z.boolean().default(true),
  /** Path prefixes (relative to repo root) the write_file tool may target. */
  allow_write: z.array(z.string()).default(["."]),
});
export type Constraints = z.infer<typeof constraintsSchema>;

export const commandOverridesSchema = z
  .object({
    install: z.string().optional(),
    test: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
  })
  .default({});
export type CommandOverrides = z.infer<typeof commandOverridesSchema>;

export const githubConfigSchema = z.object({
  /** Name of the env var holding the GitHub PAT. */
  token_env: z.string().min(1).default("GITHUB_TOKEN"),
  /** Target branch for the PR. Defaults to base_ref when omitted. */
  pr_target_ref: z.string().optional(),
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;

export const toolProfileSchema = z.enum(["auto", "node", "python"]);
export type ToolProfileName = z.infer<typeof toolProfileSchema>;

export const taskSchema = z.object({
  task_id: z.string().min(1),
  repo: z.string().url(),
  base_ref: z.string().min(1),
  issue_id: z.string().min(1),
  instructions: z.string().min(1),
  acceptance_criteria: z.string().optional(),
  constraints: constraintsSchema.default({}),
  tool_profile: toolProfileSchema.default("auto"),
  command_overrides: commandOverridesSchema,
  provider: providerConfigSchema,
  github: githubConfigSchema.default({}),
});
export type Task = z.infer<typeof taskSchema>;

// ---------------------------------------------------------------------------
// result.json (output) — TRD §6.2
// ---------------------------------------------------------------------------

export const resultStatusSchema = z.enum(["success", "partial", "failed"]);
export type ResultStatus = z.infer<typeof resultStatusSchema>;

export const commandExecutionSchema = z.object({
  name: z.string(),
  command: z.string(),
  exit_code: z.number().int(),
  duration_ms: z.number().int().nonnegative(),
  log_path: z.string(),
});
export type CommandExecution = z.infer<typeof commandExecutionSchema>;

export const reviewOutcomeSchema = z.object({
  passed: z.boolean(),
  iterations: z.number().int().nonnegative(),
  findings: z.array(z.string()),
});
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

export const diffStatsSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export type DiffStats = z.infer<typeof diffStatsSchema>;

export const artifactsSchema = z.object({
  log_path: z.string(),
  diff_patch: z.string().nullable(),
  summary_md: z.string().nullable(),
  prd_md: z.string().nullable(),
  trd_md: z.string().nullable(),
  pr_url: z.string().nullable(),
});
export type Artifacts = z.infer<typeof artifactsSchema>;

export const resultSchema = z.object({
  task_id: z.string(),
  status: resultStatusSchema,
  summary: z.string(),
  changed_files: z.array(z.string()),
  tests_executed: z.array(commandExecutionSchema),
  lint_executed: commandExecutionSchema.nullable(),
  typecheck_executed: commandExecutionSchema.nullable(),
  review: reviewOutcomeSchema,
  diff_stats: diffStatsSchema,
  blocked_by: z.array(z.string()),
  risks: z.array(z.string()),
  next_steps: z.array(z.string()),
  artifacts: artifactsSchema,
});
export type Result = z.infer<typeof resultSchema>;

// ---------------------------------------------------------------------------
// Event protocol (stdout NDJSON) — TRD §6.3
// ---------------------------------------------------------------------------

export type Phase =
  | "clone"
  | "plan"
  | "code"
  | "test"
  | "review"
  | "git"
  | "done";

/**
 * The payload variants of every event emitted on stdout, WITHOUT the common
 * envelope. Kept separate so the emitter can take a body and add the envelope,
 * and so `Omit` over the union distributes correctly. Defined as a TS type (not
 * zod) for ergonomics at emit sites; shapes are asserted by tests.
 */
export type PiEventBody =
  | { type: "session_start"; task_id: string; repo: string; provider: string; model: string }
  | { type: "phase"; phase: Phase }
  | { type: "skill_loaded"; name: string; description: string }
  | { type: "llm_text"; text: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string }
  | { type: "test_run"; command: string; exit_code: number; duration_ms: number }
  | { type: "review"; passed: boolean; findings: string[]; iteration: number }
  | { type: "git"; action: "branch" | "commit" | "push"; detail: string }
  | { type: "pr_created"; url: string; number: number }
  | {
      type: "status_report";
      phase: Phase;
      current_skill: string | null;
      changed_files: string[];
      elapsed_sec: number;
    }
  | { type: "chat_reply"; text: string }
  | { type: "interrupted" }
  | { type: "resumed" }
  | { type: "stopping" }
  | { type: "done"; status: ResultStatus; result_path: string }
  | { type: "error"; error_type: string; message: string; fatal: boolean };

/** A fully-enveloped event as written to stdout. */
export type PiEvent = { ts: string; step: number } & PiEventBody;

export type PiEventType = PiEventBody["type"];

// ---------------------------------------------------------------------------
// Control protocol (stdin NDJSON) — TRD §6.4
// ---------------------------------------------------------------------------

export const controlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat"), text: z.string() }),
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("stop") }),
]);
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type ControlCommandType = ControlCommand["type"];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export class ContractError extends Error {
  constructor(
    message: string,
    readonly issues?: z.ZodError,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

/** Parse + validate a task.json payload. Throws ContractError on failure. */
export function parseTask(raw: unknown): Task {
  const parsed = taskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractError(
      `Invalid task.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/** Parse + validate a result.json payload. Throws ContractError on failure. */
export function parseResult(raw: unknown): Result {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractError(
      `Invalid result.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * Parse a single line of control input. Returns null for blank lines or
 * malformed JSON / unknown command shapes (the caller emits a non-fatal error).
 */
export function parseControlLine(line: string): ControlCommand | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = controlCommandSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
