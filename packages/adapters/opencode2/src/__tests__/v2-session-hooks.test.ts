import { describe, expect, it } from "bun:test";
import { Skill } from "@opencode-ai/plugin";
import { okAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import type { SessionContext, SessionPrompt } from "../v2/host-types.js";
import type { OpenCode2SessionHookDependencies } from "../v2/session-hooks.js";
import { OpenCode2SessionHooks } from "../v2/session-hooks.js";
import { catalog, projection } from "./v2-fixtures.js";

function hookCatalog(): OpenCode2CatalogCandidate {
  const agent = { ...projection("helper"), temperature: 0.3 };
  return {
    ...catalog(new Map([["helper", agent]])),
    runtime: new Map([
      ["helper", { projection: agent, skillIDs: [Skill.ID.make("skill-one")] }],
    ]),
  };
}

function dependencies(
  value: OpenCode2CatalogCandidate,
  ownsAgent = true,
): OpenCode2SessionHookDependencies {
  return {
    location: "/project",
    workspaceID: "workspace",
    catalog: () => value,
    ownsAgent: () => ownsAgent,
    refresh: () => okAsync(value),
    session: {
      get: async () => ({
        location: { directory: "/project", workspaceID: "workspace" },
        agent: "helper",
      }),
    },
  } as unknown as OpenCode2SessionHookDependencies;
}

describe("OpenCode2SessionHooks", () => {
  it("attaches configured available skills once and preserves caller skill mentions", async () => {
    const value = hookCatalog();
    const prompt = { skills: [{ id: Skill.ID.make("caller") }] };
    const input = { sessionID: "session", prompt } as SessionPrompt;
    const hooks = new OpenCode2SessionHooks(dependencies(value));
    expect((await hooks.applyPrompt(input)).isOk()).toBe(true);
    expect((await hooks.applyPrompt(input)).isOk()).toBe(true);
    expect(prompt.skills.map((skill) => String(skill.id))).toEqual([
      "caller",
      "skill-one",
    ]);
  });

  it("does not attach skills or temperature to foreign colliding agents", async () => {
    const value = hookCatalog();
    const prompt = { skills: [] };
    const hooks = new OpenCode2SessionHooks(dependencies(value, false));
    await hooks.applyPrompt({
      sessionID: "session",
      prompt,
    } as unknown as SessionPrompt);
    const generation: { temperature?: number } = {};
    await hooks.applyContext({
      sessionID: "session",
      agent: "helper",
      generation,
    } as SessionContext);
    expect(prompt.skills).toEqual([]);
    expect(generation.temperature).toBeUndefined();
  });

  it("applies temperature only after validating the session Location", async () => {
    const value = hookCatalog();
    const hooks = new OpenCode2SessionHooks(dependencies(value));
    const generation: { temperature?: number } = {};
    expect(
      (
        await hooks.applyContext({
          sessionID: "session",
          agent: "helper",
          generation,
        } as SessionContext)
      ).isOk(),
    ).toBe(true);
    expect(generation.temperature).toBe(0.3);
  });
});
