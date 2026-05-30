import { describe, expect, test } from "bun:test";
import { isWriteAllowed, resolveInWorkdir } from "../src/paths.ts";

describe("isWriteAllowed", () => {
  test("'.' allows everything", () => {
    expect(isWriteAllowed(["."], "src/a.ts")).toBe(true);
    expect(isWriteAllowed(["."], "anything/deep/file.txt")).toBe(true);
  });

  test("matches exact prefix and descendants, with ./ normalization", () => {
    const allow = ["./src", "./test"];
    expect(isWriteAllowed(allow, "src/index.ts")).toBe(true);
    expect(isWriteAllowed(allow, "src")).toBe(true);
    expect(isWriteAllowed(allow, "test/a/b.test.ts")).toBe(true);
  });

  test("rejects paths outside the allowlist", () => {
    const allow = ["./src"];
    expect(isWriteAllowed(allow, "lib/x.ts")).toBe(false);
    expect(isWriteAllowed(allow, "package.json")).toBe(false);
    // a sibling that merely shares a prefix string is NOT allowed
    expect(isWriteAllowed(allow, "srcfoo/x.ts")).toBe(false);
  });
});

describe("resolveInWorkdir", () => {
  test("resolves a relative path inside the workdir", () => {
    const abs = resolveInWorkdir("/repo", "src/a.ts");
    expect(abs).toBe("/repo/src/a.ts");
  });

  test("throws on traversal outside the workdir", () => {
    expect(() => resolveInWorkdir("/repo", "../etc/passwd")).toThrow();
    expect(() => resolveInWorkdir("/repo", "/etc/passwd")).toThrow();
  });
});
