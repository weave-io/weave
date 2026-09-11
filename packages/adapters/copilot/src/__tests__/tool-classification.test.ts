import { describe, expect, it } from "bun:test";
import {
  type EffectiveToolPolicy,
  resolveToolDecisions,
} from "@weaveio/weave-engine";
import {
  COPILOT_TOOL_CLASSIFICATIONS,
  COPILOT_TOOL_IDS,
  getCopilotToolClassifications,
} from "../tool-classification.js";

describe("COPILOT_TOOL_CLASSIFICATIONS", () => {
  it("maps execute to execute capability", () => {
    const entry = COPILOT_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "execute",
    );
    expect(entry?.capability).toBe("execute");
  });

  it("maps read to read capability", () => {
    const entry = COPILOT_TOOL_CLASSIFICATIONS.find((c) => c.toolId === "read");
    expect(entry?.capability).toBe("read");
  });

  it("maps edit to write capability", () => {
    const entry = COPILOT_TOOL_CLASSIFICATIONS.find((c) => c.toolId === "edit");
    expect(entry?.capability).toBe("write");
  });

  it("maps search to read capability", () => {
    const entry = COPILOT_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "search",
    );
    expect(entry?.capability).toBe("read");
  });

  it("maps agent to delegate capability", () => {
    const entry = COPILOT_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "agent",
    );
    expect(entry?.capability).toBe("delegate");
  });

  it("maps web to network capability", () => {
    const entry = COPILOT_TOOL_CLASSIFICATIONS.find((c) => c.toolId === "web");
    expect(entry?.capability).toBe("network");
  });

  it("covers all five abstract capabilities", () => {
    const capabilities = new Set(
      COPILOT_TOOL_CLASSIFICATIONS.map((c) => c.capability),
    );
    expect(capabilities).toEqual(
      new Set(["read", "write", "execute", "delegate", "network"]),
    );
  });
});

describe("getCopilotToolClassifications", () => {
  it("returns the same array as the constant", () => {
    expect(getCopilotToolClassifications()).toBe(COPILOT_TOOL_CLASSIFICATIONS);
  });
});

describe("COPILOT_TOOL_IDS", () => {
  it("matches the classification list length", () => {
    expect(COPILOT_TOOL_IDS).toHaveLength(COPILOT_TOOL_CLASSIFICATIONS.length);
  });
});

describe("resolveToolDecisions integration", () => {
  it("compiles and resolves decisions against the engine types", () => {
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "allow",
      execute: "deny",
      delegate: "ask",
      network: "allow",
    };
    const decisions = resolveToolDecisions(
      COPILOT_TOOL_IDS,
      getCopilotToolClassifications(),
      policy,
    );
    expect(decisions.length).toBe(COPILOT_TOOL_IDS.length);
  });
});
