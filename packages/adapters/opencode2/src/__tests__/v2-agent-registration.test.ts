import { describe, expect, it } from "bun:test";
import type { AgentEditor } from "@opencode-ai/plugin/promise/agent";
import { WEAVE_OWNERSHIP_MARKER } from "../translate-agent.js";
import { registerOpenCode2Agents } from "../v2/agent-registration.js";
import type { OpenCode2AgentProjection } from "../v2/translate-agent.js";

function projection(id: string): OpenCode2AgentProjection {
  return {
    id,
    displayName: "Weave helper",
    system: "system",
    mode: "subagent",
    permissions: [],
    skillNames: [],
  };
}

describe("registerOpenCode2Agents", () => {
  it("inserts absent agents and preserves foreign collisions", () => {
    const records = new Map<string, Record<string, unknown>>([
      ["foreign", { id: "foreign" }],
    ]);
    const defaults: Array<string | undefined> = [];
    const editor = {
      list: () => [],
      get: (id: string) => records.get(id),
      default: (id: string | undefined) => defaults.push(id),
      update: (
        id: string,
        update: (agent: Record<string, unknown>) => void,
      ) => {
        const agent = { id, permissions: [] };
        update(agent);
        records.set(id, agent);
      },
      remove: () => undefined,
    } as unknown as AgentEditor;
    const inserted = new Set<string>();
    registerOpenCode2Agents(
      editor,
      {
        agents: new Map([
          ["foreign", projection("foreign")],
          ["weave", projection("weave")],
        ]),
      },
      inserted,
      "weave",
    );
    expect(inserted).toEqual(new Set(["weave"]));
    expect(defaults).toEqual(["weave"]);
    expect(records.get("foreign")).toEqual({ id: "foreign" });
    expect(records.get("weave")?.name).toBe("Weave helper");
    expect(records.get("weave")?.description).toBe(
      `${WEAVE_OWNERSHIP_MARKER} weave`,
    );
  });
});
