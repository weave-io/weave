import { describe, expect, it } from "bun:test";
import { Model, Provider } from "@opencode-ai/plugin";
import { translateOpenCode2Agent } from "../v2/translate-agent.js";
import { descriptor } from "./v2-fixtures.js";

describe("translateOpenCode2Agent", () => {
  it("preserves identity, role prompt, mode, request intent, model, skills, and delegation", () => {
    const model = {
      providerID: Provider.ID.make("provider"),
      id: Model.ID.make("model"),
    };
    const result = translateOpenCode2Agent(
      descriptor({
        name: "shuttle-ui",
        displayName: "UI Shuttle",
        description: "UI specialist",
        mode: "all",
        temperature: 0.4,
        skills: ["accessibility"],
        delegationTargets: [{ name: "weft", isCategory: false, triggers: [] }],
      }),
      model,
    );
    expect(result).toMatchObject({
      id: "shuttle-ui",
      displayName: "UI Shuttle",
      description: "UI specialist",
      mode: "all",
      temperature: 0.4,
      model,
      skillNames: ["accessibility"],
    });
    expect(result.system).toContain("native subagent tool");
    expect(result.permissions).toContainEqual({
      action: "subagent",
      resource: "weft",
      effect: "allow",
    });
  });
});
