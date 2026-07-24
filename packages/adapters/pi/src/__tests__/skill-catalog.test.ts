import { describe, expect, it } from "bun:test";
import { PiSkillCatalog } from "../skill-catalog.js";

describe("PiSkillCatalog", () => {
  it("returns an empty resolution when the descriptor requests no skills", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", undefined);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("resolves exact, case-sensitive requested skills present in the Pi-owned snapshot", () => {
    const catalog = new PiSkillCatalog([
      { name: "tdd" },
      { name: "code-review" },
    ]);
    const result = catalog.resolveForAgent("loom", ["tdd", "code-review"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((s) => s.name)).toEqual([
      "tdd",
      "code-review",
    ]);
  });

  it("does not match a differently-cased skill name", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", ["TDD"]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual([
      { type: "MissingSkill", agentName: "loom", skillName: "TDD" },
    ]);
  });

  it("isolates a missing skill to this agent's result only (no global failure shape)", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", ["tdd", "nonexistent"]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual([
      { type: "MissingSkill", agentName: "loom", skillName: "nonexistent" },
    ]);
  });

  it("omits a disabled skill request without treating it as missing", () => {
    const catalog = new PiSkillCatalog([{ name: "tdd" }]);
    const result = catalog.resolveForAgent("loom", ["tdd"], ["tdd"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("refresh() replaces the discovery snapshot used by subsequent resolutions", () => {
    const catalog = new PiSkillCatalog([]);
    const before = catalog.resolveForAgent("loom", ["tdd"]);
    expect(before.isErr()).toBe(true);

    catalog.refresh([{ name: "tdd" }]);
    const after = catalog.resolveForAgent("loom", ["tdd"]);
    expect(after.isOk()).toBe(true);
    expect(catalog.getAvailableSkills().map((s) => s.name)).toEqual(["tdd"]);
  });
});
