import { describe, expect, it } from "bun:test";
import { mapOpenCode2ToolPolicy } from "../v2/tool-policy-mapping.js";

describe("mapOpenCode2ToolPolicy", () => {
  it("preserves allow, deny, and ask on current native actions", () => {
    const rules = mapOpenCode2ToolPolicy(
      {
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "ask",
        network: "deny",
      },
      ["helper", "helper"],
    );
    expect(rules).toContainEqual({
      action: "read",
      resource: "*",
      effect: "allow",
    });
    expect(rules).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "deny",
    });
    expect(rules).toContainEqual({
      action: "shell",
      resource: "*",
      effect: "ask",
    });
    expect(rules).toContainEqual({
      action: "subagent",
      resource: "*",
      effect: "deny",
    });
    expect(
      rules.filter(
        (rule) => rule.action === "subagent" && rule.resource === "helper",
      ),
    ).toEqual([{ action: "subagent", resource: "helper", effect: "ask" }]);
    expect(
      rules.some((rule) => ["task", "bash", "doom_loop"].includes(rule.action)),
    ).toBe(false);
  });

  it("does not advertise targets when delegation is denied", () => {
    const rules = mapOpenCode2ToolPolicy(
      {
        read: "deny",
        write: "deny",
        execute: "deny",
        delegate: "deny",
        network: "deny",
      },
      ["helper"],
    );
    expect(rules.filter((rule) => rule.action === "subagent")).toEqual([
      { action: "subagent", resource: "*", effect: "deny" },
    ]);
  });
});
