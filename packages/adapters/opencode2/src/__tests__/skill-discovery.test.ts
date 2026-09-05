import { describe, expect, it } from "bun:test";
import { resolveSkillsForAgent } from "@weaveio/weave-engine";
import {
  loadAvailableSkillsV2,
  registerWeaveManagedSkills,
} from "../skill-discovery.js";
import { MockPluginContext } from "./mock-plugin-context.js";

describe("loadAvailableSkillsV2", () => {
  it("returns [] when no skills are registered", async () => {
    const ctx = new MockPluginContext();

    const result = await loadAvailableSkillsV2(ctx);

    expect(result).toEqual([]);
  });

  it("adapts populated V2 skill records into engine SkillInfo[]", async () => {
    const ctx = new MockPluginContext();
    ctx.seedSkill("tdd");
    ctx.seedSkill("code-review");

    const result = await loadAvailableSkillsV2(ctx);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name).sort()).toEqual(["code-review", "tdd"]);
    for (const skillInfo of result) {
      expect(skillInfo.metadata).toBeDefined();
    }
  });

  it("surfaces a typed MissingSkill diagnostic when an agent declares an unavailable skill", async () => {
    const ctx = new MockPluginContext();
    ctx.seedSkill("tdd");

    const available = await loadAvailableSkillsV2(ctx);

    const result = resolveSkillsForAgent({
      agentName: "shuttle",
      agentSkills: ["tdd", "nonexistent-skill"],
      availableSkills: available,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual([
        {
          type: "MissingSkill",
          agentName: "shuttle",
          skillName: "nonexistent-skill",
        },
      ]);
    }
  });
});

describe("registerWeaveManagedSkills", () => {
  it("registers skills and returns a disposable V2Registration", async () => {
    const ctx = new MockPluginContext();

    const result = await registerWeaveManagedSkills(ctx, [
      { name: "tdd" },
      { name: "code-review" },
    ]);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const registration = result.value;
    expect(typeof registration.dispose).toBe("function");

    const listed = await loadAvailableSkillsV2(ctx);
    expect(listed.map((s) => s.name).sort()).toEqual(["code-review", "tdd"]);

    await registration.dispose();
    const afterDispose = await loadAvailableSkillsV2(ctx);
    expect(afterDispose).toEqual([]);
  });

  it("preserves adapter-owned metadata when re-registering a discovered skill", async () => {
    const ctx = new MockPluginContext();
    ctx.seedSkill("tdd");
    const available = await loadAvailableSkillsV2(ctx);

    const ctx2 = new MockPluginContext();
    const result = await registerWeaveManagedSkills(ctx2, available);

    expect(result.isOk()).toBe(true);
    const listed = await loadAvailableSkillsV2(ctx2);
    expect(listed.map((s) => s.name)).toEqual(["tdd"]);
  });
});
