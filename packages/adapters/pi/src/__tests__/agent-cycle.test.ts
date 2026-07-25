import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import {
  listCycleablePrimaryAgents,
  nextCycleablePrimaryAgent,
  renderActiveAgentBadge,
} from "../agent-cycle.js";
import type { PiUiThemePort } from "../types.js";

function descriptor(
  name: string,
  mode: AgentDescriptor["mode"],
): AgentDescriptor {
  return {
    name,
    composedPrompt: `You are ${name}.`,
    models: [],
    mode,
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

describe("primary-agent cycle helpers", () => {
  const descriptors = new Map([
    ["loom", descriptor("loom", "primary")],
    ["shuttle", descriptor("shuttle", "subagent")],
    ["tapestry", descriptor("tapestry", "all")],
  ]);

  it("keeps primary and all descriptors in materialization order", () => {
    expect(
      listCycleablePrimaryAgents(descriptors).map((agent) => agent.name),
    ).toEqual(["loom", "tapestry"]);
  });

  it("cycles with wraparound and skips subagents", () => {
    expect(nextCycleablePrimaryAgent(descriptors, "loom")?.name).toBe(
      "tapestry",
    );
    expect(nextCycleablePrimaryAgent(descriptors, "tapestry")?.name).toBe(
      "loom",
    );
  });

  it("does not cycle when fewer than two primary agents exist", () => {
    expect(
      nextCycleablePrimaryAgent(
        new Map([["loom", descriptor("loom", "primary")]]),
        "loom",
      ),
    ).toBeUndefined();
  });

  it("renders a readable fallback badge without a theme", () => {
    expect(renderActiveAgentBadge("tapestry")).toBe("◆ WEAVE · TAPESTRY");
  });

  it("uses Pi theme tokens when the host exposes them", () => {
    const theme: PiUiThemePort = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `<bold>${text}</bold>`,
    };

    expect(renderActiveAgentBadge("loom", theme)).toBe(
      "<accent>◆</accent> <bold>WEAVE</bold> <muted>·</muted> <accent><bold>LOOM</bold></accent>",
    );
  });
});
