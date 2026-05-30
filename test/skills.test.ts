import { describe, expect, test } from "bun:test";
import { parseFrontmatter, loadSkills, buildCatalog, SkillRegistry } from "../src/skills.ts";

describe("parseFrontmatter", () => {
  test("extracts name + description and body", () => {
    const raw = `---\nname: coding\ndescription: Implement the change.\n---\n\n# Coding\n\nBody here.`;
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe("coding");
    expect(meta.description).toBe("Implement the change.");
    expect(body).toContain("# Coding");
  });

  test("strips surrounding quotes from values", () => {
    const { meta } = parseFrontmatter(`---\nname: "x"\ndescription: 'y z'\n---\nbody`);
    expect(meta.name).toBe("x");
    expect(meta.description).toBe("y z");
  });

  test("no frontmatter → empty meta, whole text as body", () => {
    const { meta, body } = parseFrontmatter("# just markdown");
    expect(meta).toEqual({});
    expect(body).toBe("# just markdown");
  });
});

describe("loadSkills (bundled library)", () => {
  const skills = loadSkills();

  test("loads all seven bundled skills with descriptions", () => {
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(
      ["code-reviewer", "coding", "git", "prd-maker", "testing", "trd-maker", "using-skills"].sort(),
    );
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  test("catalog lists every skill", () => {
    const catalog = buildCatalog(skills);
    for (const s of skills) expect(catalog).toContain(s.name);
  });
});

describe("SkillRegistry", () => {
  const reg = new SkillRegistry(loadSkills());

  test("looks up by name and reports availability", () => {
    expect(reg.has("coding")).toBe(true);
    expect(reg.get("coding")?.body).toContain("Coding");
    expect(reg.get("nope")).toBeNull();
    expect(reg.names()).toContain("git");
  });
});
