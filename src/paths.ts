/**
 * Path resolution + the write allowlist guard (TRD §9 write_file, §13).
 * Pure functions so the guard is unit-testable in isolation.
 */
import { resolve, relative, isAbsolute } from "node:path";

/**
 * Resolve a (possibly relative) path against the workdir and ensure it stays
 * inside it. Throws on traversal outside the workdir.
 */
export function resolveInWorkdir(workdir: string, p: string): string {
  const base = resolve(workdir);
  const target = isAbsolute(p) ? resolve(p) : resolve(base, p);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(".." + "/") || isAbsolute(rel)) {
    throw new Error(`Path escapes workdir: ${p}`);
  }
  return target;
}

/** Normalize an allowlist entry or relative path to a comparable form. */
function normalizePrefix(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  if (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  return s;
}

/**
 * Is `relPath` (relative to workdir) writable under the given allowlist?
 * A prefix of "." or "" allows everything. Otherwise the path must equal a
 * prefix or sit beneath it.
 */
export function isWriteAllowed(allowWrite: string[], relPath: string): boolean {
  const target = normalizePrefix(relPath);
  for (const entry of allowWrite) {
    const prefix = normalizePrefix(entry);
    if (prefix === "" || prefix === ".") return true;
    if (target === prefix) return true;
    if (target.startsWith(prefix + "/")) return true;
  }
  return false;
}
