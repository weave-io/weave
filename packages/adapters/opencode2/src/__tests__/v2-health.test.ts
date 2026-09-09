import { describe, expect, it } from "bun:test";
import { buildOpenCode2Health } from "../v2/health.js";
import { catalog, projection } from "./v2-fixtures.js";

describe("buildOpenCode2Health", () => {
  it("reports owned resources, collisions, registration state, and durable workflow limits", () => {
    const value = catalog(
      new Map([
        ["helper", projection("helper")],
        ["tapestry", projection("tapestry")],
      ]),
    );
    const report = buildOpenCode2Health(
      value,
      { state: "fresh" },
      new Set(["helper"]),
      { requestIntent: false, foregroundPlans: false, planDisplay: true },
    );
    expect(report.agentCount).toBe(1);
    expect(report.issues).toContainEqual({ code: "agent_collision", count: 1 });
    expect(report.readiness).toEqual({
      nativeAgents: true,
      requestIntent: false,
      foregroundPlans: false,
      planDisplay: true,
      nativeDelegation: true,
      durableWorkflows: false,
    });
  });
});
