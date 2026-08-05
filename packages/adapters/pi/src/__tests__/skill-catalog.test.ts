import { describe, expect, it } from "bun:test";
import { PiSkillCatalog } from "../skill-catalog.js";

describe("PiSkillCatalog", () => {
  it("returns an empty resolution when the descriptor requests no skills", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", undefined);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      resolvedSkills: [],
      warnings: [],
    });
  });

  it("resolves exact, case-sensitive requested skills present in the Pi-owned snapshot", () => {
    const catalog = new PiSkillCatalog([
      { name: "tdd" },
      { name: "code-review" },
    ]);
    const result = catalog.resolveForAgent("loom", ["tdd", "code-review"]);
    expect(result.isOk()).toBe(true);
    expect(
      result._unsafeUnwrap().resolvedSkills.map((skill) => skill.name),
    ).toEqual(["tdd", "code-review"]);
    expect(result._unsafeUnwrap().warnings).toEqual([]);
  });

  it("warns when a differently-cased skill name is unavailable", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", ["TDD"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      resolvedSkills: [],
      warnings: [{ type: "MissingSkill", agentName: "loom", skillName: "TDD" }],
    });
  });

  it("returns available skills and warns for missing skills without failing the agent", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", ["tdd", "nonexistent"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      resolvedSkills: [
        {
          name: "tdd",
          skillInfo: { name: "tdd", metadata: {} },
        },
      ],
      warnings: [
        {
          type: "MissingSkill",
          agentName: "loom",
          skillName: "nonexistent",
        },
      ],
    });
  });

  it("omits a disabled skill request without warning", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", ["tdd"], ["tdd"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      resolvedSkills: [],
      warnings: [],
    });
  });

  it("refresh() replaces the discovery snapshot used by subsequent resolutions", () => {
    const catalog = new PiSkillCatalog([]);
    const before = catalog.resolveForAgent("loom", ["tdd"]);
    expect(before.isOk()).toBe(true);
    expect(before._unsafeUnwrap().warnings).toEqual([
      { type: "MissingSkill", agentName: "loom", skillName: "tdd" },
    ]);

    catalog.refresh([{ name: "tdd" }]);
    const after = catalog.resolveForAgent("loom", ["tdd"]);
    expect(after.isOk()).toBe(true);
    expect(
      after._unsafeUnwrap().resolvedSkills.map((skill) => skill.name),
    ).toEqual(["tdd"]);
    expect(after._unsafeUnwrap().warnings).toEqual([]);
    expect(catalog.getAvailableSkills().map((skill) => skill.name)).toEqual([
      "tdd",
    ]);
  });
});
