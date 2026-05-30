import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProfile } from "../src/profiles.ts";

const created: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-profile-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("resolveProfile — node", () => {
  test("detects pnpm and scripts", () => {
    const dir = repo({
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }),
      "tsconfig.json": "{}",
    });
    const p = resolveProfile(dir, "auto");
    expect(p.name).toBe("node");
    expect(p.packageManager).toBe("pnpm");
    expect(p.install).toBe("pnpm install");
    expect(p.test).toBe("pnpm run test");
    expect(p.lint).toBe("pnpm run lint");
    expect(p.typecheck).toBe("pnpm exec tsc --noEmit");
  });

  test("npm + no scripts → null test/lint, tsconfig still gives typecheck", () => {
    const dir = repo({
      "package-lock.json": "",
      "package.json": JSON.stringify({ name: "x" }),
      "tsconfig.json": "{}",
    });
    const p = resolveProfile(dir, "auto");
    expect(p.packageManager).toBe("npm");
    expect(p.test).toBeNull();
    expect(p.lint).toBeNull();
    expect(p.typecheck).toBe("npx tsc --noEmit");
  });
});

describe("resolveProfile — python", () => {
  test("uv project with ruff configured", () => {
    const dir = repo({
      "uv.lock": "",
      "pyproject.toml": "[tool.ruff]\nline-length = 100\n",
    });
    const p = resolveProfile(dir, "auto");
    expect(p.name).toBe("python");
    expect(p.packageManager).toBe("uv");
    expect(p.install).toBe("uv sync");
    expect(p.test).toBe("uv run pytest -q");
    expect(p.lint).toBe("uv run ruff check .");
    expect(p.typecheck).toBeNull();
  });

  test("requirements.txt pip project", () => {
    const dir = repo({ "requirements.txt": "pytest\n" });
    const p = resolveProfile(dir, "auto");
    expect(p.packageManager).toBe("pip");
    expect(p.install).toBe("pip install -r requirements.txt");
    expect(p.test).toBe("pytest -q");
  });
});

describe("resolveProfile — overrides + unknown", () => {
  test("command_overrides win over detection", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const p = resolveProfile(dir, "auto", { test: "make test", typecheck: "tsc -b" });
    expect(p.test).toBe("make test");
    expect(p.typecheck).toBe("tsc -b");
  });

  test("empty repo → unknown profile, all null", () => {
    const dir = repo({ "README.md": "# hi" });
    const p = resolveProfile(dir, "auto");
    expect(p.name).toBe("unknown");
    expect(p.install).toBeNull();
    expect(p.test).toBeNull();
  });
});
