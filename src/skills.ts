/**
 * Skills subsystem (TRD §8). Loads the bundled markdown SKILL.md library,
 * exposes a catalog (name + description) for the system prompt, and serves full
 * skill bodies on demand for the use_skill tool.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** Default location of the bundled skills/ dir, relative to this module. */
export function defaultSkillsDir(): string {
  return join(import.meta.dir, "..", "skills");
}

/**
 * Parse YAML-ish frontmatter delimited by `---`. Supports simple `key: value`
 * pairs (name, description) — no nested structures, which the skills don't use.
 * Returns the frontmatter map and the remaining body.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: (match[2] ?? "").trim() };
}

/** Load all skills from a directory of `<name>/SKILL.md` folders. */
export function loadSkills(dir = defaultSkillsDir()): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, "SKILL.md");
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;
    const { meta, body } = parseFrontmatter(readFileSync(skillFile, "utf8"));
    skills.push({
      name: meta.name ?? entry,
      description: meta.description ?? "",
      body,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Render the skill catalog injected into the system prompt. */
export function buildCatalog(skills: Skill[]): string {
  if (skills.length === 0) return "(no skills available)";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}

/** Registry used by the use_skill tool to look up bodies by name. */
export class SkillRegistry {
  private readonly byName = new Map<string, Skill>();

  constructor(skills: Skill[]) {
    for (const skill of skills) this.byName.set(skill.name, skill);
  }

  list(): Skill[] {
    return [...this.byName.values()];
  }

  get(name: string): Skill | null {
    return this.byName.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}
