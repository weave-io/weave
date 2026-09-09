import { describe, expect, it } from "bun:test";
import {
  type ToolPolicyEffective,
  toPermissionRules,
} from "../tool-policy-mapping.js";

const BASE_POLICY: ToolPolicyEffective = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "allow",
};

describe("toPermissionRules", () => {
  describe("read dimension", () => {
    it("maps allow", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, read: "allow" });
      expect(rules[0]).toEqual({
        action: "read.*",
        resource: "*",
        effect: "allow",
      });
    });

    it("maps deny", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, read: "deny" });
      expect(rules[0]).toEqual({
        action: "read.*",
        resource: "*",
        effect: "deny",
      });
    });

    it("maps ask", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, read: "ask" });
      expect(rules[0]).toEqual({
        action: "read.*",
        resource: "*",
        effect: "ask",
      });
    });
  });

  describe("write dimension", () => {
    it("maps allow", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, write: "allow" });
      expect(rules[1]).toEqual({
        action: "write.*",
        resource: "*",
        effect: "allow",
      });
    });

    it("maps deny", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, write: "deny" });
      expect(rules[1]).toEqual({
        action: "write.*",
        resource: "*",
        effect: "deny",
      });
    });

    it("maps ask", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, write: "ask" });
      expect(rules[1]).toEqual({
        action: "write.*",
        resource: "*",
        effect: "ask",
      });
    });
  });

  describe("execute dimension", () => {
    it("maps allow", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, execute: "allow" });
      expect(rules[2]).toEqual({
        action: "execute.*",
        resource: "*",
        effect: "allow",
      });
    });

    it("maps deny", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, execute: "deny" });
      expect(rules[2]).toEqual({
        action: "execute.*",
        resource: "*",
        effect: "deny",
      });
    });

    it("maps ask", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, execute: "ask" });
      expect(rules[2]).toEqual({
        action: "execute.*",
        resource: "*",
        effect: "ask",
      });
    });
  });

  describe("delegate dimension", () => {
    it("maps allow", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, delegate: "allow" });
      expect(rules[3]).toEqual({
        action: "delegate.*",
        resource: "*",
        effect: "allow",
      });
    });

    it("maps deny", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, delegate: "deny" });
      expect(rules[3]).toEqual({
        action: "delegate.*",
        resource: "*",
        effect: "deny",
      });
    });

    it("maps ask", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, delegate: "ask" });
      expect(rules[3]).toEqual({
        action: "delegate.*",
        resource: "*",
        effect: "ask",
      });
    });
  });

  describe("network dimension", () => {
    it("maps allow", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, network: "allow" });
      expect(rules[4]).toEqual({
        action: "network.*",
        resource: "*",
        effect: "allow",
      });
    });

    it("maps deny", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, network: "deny" });
      expect(rules[4]).toEqual({
        action: "network.*",
        resource: "*",
        effect: "deny",
      });
    });

    it("maps ask", () => {
      const rules = toPermissionRules({ ...BASE_POLICY, network: "ask" });
      expect(rules[4]).toEqual({
        action: "network.*",
        resource: "*",
        effect: "ask",
      });
    });
  });

  it("emits exactly 5 rules in the documented order: read, write, execute, delegate, network", () => {
    const policy: ToolPolicyEffective = {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "deny",
    };
    const rules = toPermissionRules(policy);

    expect(rules).toHaveLength(5);
    expect(rules.map((r) => r.action)).toEqual([
      "read.*",
      "write.*",
      "execute.*",
      "delegate.*",
      "network.*",
    ]);
    expect(rules).toEqual([
      { action: "read.*", resource: "*", effect: "allow" },
      { action: "write.*", resource: "*", effect: "deny" },
      { action: "execute.*", resource: "*", effect: "ask" },
      { action: "delegate.*", resource: "*", effect: "allow" },
      { action: "network.*", resource: "*", effect: "deny" },
    ]);
  });

  it("produces deterministic, byte-identical output for identical input", () => {
    const policy: ToolPolicyEffective = {
      read: "ask",
      write: "allow",
      execute: "deny",
      delegate: "ask",
      network: "allow",
    };
    const first = toPermissionRules(policy);
    const second = toPermissionRules(policy);

    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    expect(first).toEqual(second);
  });

  it("all-deny policy maps every dimension to deny", () => {
    const rules = toPermissionRules({
      read: "deny",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    });

    expect(rules.every((r) => r.effect === "deny")).toBe(true);
  });

  it("all-ask policy maps every dimension to ask", () => {
    const rules = toPermissionRules({
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });

    expect(rules.every((r) => r.effect === "ask")).toBe(true);
  });
});
