/**
 * Tool profiles (TRD §10). Inspects the cloned repo and resolves the
 * install/test/lint/typecheck commands for Node or Python. Task
 * `command_overrides` always win over detection; an unresolved command is
 * recorded as null (skipped) rather than failing the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandOverrides, ToolProfileName } from "./contracts.ts";

export type ResolvedProfileName = "node" | "python" | "unknown";

export interface ResolvedProfile {
  name: ResolvedProfileName;
  packageManager: string | null;
  install: string | null;
  test: string | null;
  lint: string | null;
  typecheck: string | null;
}

function exists(root: string, file: string): boolean {
  return existsSync(join(root, file));
}

function readJson(root: string, file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(root: string, file: string): string | null {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}

// --- Node -----------------------------------------------------------------

function detectPackageManager(root: string): string {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "package-lock.json")) return "npm";
  if (exists(root, "yarn.lock")) return "yarn";
  return "npm";
}

function runScript(pm: string, script: string): string {
  return pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
}

function execBin(pm: string, bin: string): string {
  if (pm === "npm") return `npx ${bin}`;
  if (pm === "yarn") return `yarn ${bin}`;
  return `${pm} exec ${bin}`; // pnpm
}

function resolveNode(root: string): ResolvedProfile {
  const pm = detectPackageManager(root);
  const pkg = readJson(root, "package.json");
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

  const test = "test" in scripts ? runScript(pm, "test") : null;
  const lint = "lint" in scripts ? runScript(pm, "lint") : null;
  let typecheck: string | null = null;
  if ("typecheck" in scripts) typecheck = runScript(pm, "typecheck");
  else if (exists(root, "tsconfig.json")) typecheck = execBin(pm, "tsc --noEmit");

  return {
    name: "node",
    packageManager: pm,
    install: `${pm} install`,
    test,
    lint,
    typecheck,
  };
}

// --- Python ---------------------------------------------------------------

function resolvePython(root: string): ResolvedProfile {
  const usesUv = exists(root, "uv.lock") || exists(root, "pyproject.toml");
  const pyproject = readText(root, "pyproject.toml") ?? "";

  const hasRuff = exists(root, "ruff.toml") || /\[tool\.ruff\]/.test(pyproject);
  const hasMypy = exists(root, "mypy.ini") || /\[tool\.mypy\]/.test(pyproject);

  if (usesUv) {
    return {
      name: "python",
      packageManager: "uv",
      install: "uv sync",
      test: "uv run pytest -q",
      lint: hasRuff ? "uv run ruff check ." : null,
      typecheck: hasMypy ? "uv run mypy ." : null,
    };
  }

  return {
    name: "python",
    packageManager: "pip",
    install: exists(root, "requirements.txt") ? "pip install -r requirements.txt" : null,
    test: "pytest -q",
    lint: hasRuff ? "ruff check ." : null,
    typecheck: hasMypy ? "mypy ." : null,
  };
}

// --- Public API -----------------------------------------------------------

function detectName(root: string, requested: ToolProfileName): ResolvedProfileName {
  if (requested === "node") return "node";
  if (requested === "python") return "python";
  // auto
  if (exists(root, "package.json")) return "node";
  if (exists(root, "pyproject.toml") || exists(root, "requirements.txt")) return "python";
  return "unknown";
}

/**
 * Resolve the effective profile for a repo. `command_overrides` from the task
 * replace any field they specify.
 */
export function resolveProfile(
  root: string,
  requested: ToolProfileName,
  overrides: CommandOverrides = {},
): ResolvedProfile {
  const name = detectName(root, requested);
  const base: ResolvedProfile =
    name === "node"
      ? resolveNode(root)
      : name === "python"
        ? resolvePython(root)
        : { name: "unknown", packageManager: null, install: null, test: null, lint: null, typecheck: null };

  return {
    ...base,
    install: overrides.install ?? base.install,
    test: overrides.test ?? base.test,
    lint: overrides.lint ?? base.lint,
    typecheck: overrides.typecheck ?? base.typecheck,
  };
}
