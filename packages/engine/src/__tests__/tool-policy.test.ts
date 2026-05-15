import { describe, expect, it } from "bun:test";
import type { ToolPermission, ToolPolicy } from "@weave/core";
import type { EffectiveToolPolicy } from "../tool-policy.js";
import { ABSTRACT_CAPABILITIES, DEFAULT_PERMISSION } from "../tool-policy.js";

// ---------------------------------------------------------------------------
// ABSTRACT_CAPABILITIES
// ---------------------------------------------------------------------------

describe("ABSTRACT_CAPABILITIES", () => {
  it("contains exactly the five approved abstract capabilities", () => {
    expect(ABSTRACT_CAPABILITIES).toEqual([
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ]);
  });

  it("has exactly five entries", () => {
    expect(ABSTRACT_CAPABILITIES).toHaveLength(5);
  });

  it("contains 'read'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("read");
  });

  it("contains 'write'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("write");
  });

  it("contains 'execute'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("execute");
  });

  it("contains 'delegate'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("delegate");
  });

  it("contains 'network'", () => {
    expect(ABSTRACT_CAPABILITIES).toContain("network");
  });

  it("is typed as (keyof ToolPolicy)[] — all entries are valid ToolPolicy keys", () => {
    // Compile-time check: ABSTRACT_CAPABILITIES is typed as (keyof ToolPolicy)[].
    // Runtime check: every entry is a valid key of a ToolPolicy object.
    const validKeys: (keyof ToolPolicy)[] = [
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ];
    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(validKeys).toContain(cap);
    }
  });

  it("does not contain harness-specific tool names", () => {
    // Guard: no OpenCode, Claude Code, Pi, or other harness names
    const harnessNames = [
      "opencode",
      "claude-code",
      "pi",
      "bash",
      "edit",
      "search",
      "glob",
    ];
    for (const name of harnessNames) {
      expect(ABSTRACT_CAPABILITIES).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// EffectiveToolPolicy
// ---------------------------------------------------------------------------

describe("EffectiveToolPolicy", () => {
  it("accepts an object with all five capabilities as required fields", () => {
    // Type-level: if EffectiveToolPolicy required fields are missing, this
    // would be a compile error. Runtime: verify the shape is correct.
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "deny",
      network: "ask",
    };

    expect(policy.read).toBe("allow");
    expect(policy.write).toBe("deny");
    expect(policy.execute).toBe("ask");
    expect(policy.delegate).toBe("deny");
    expect(policy.network).toBe("ask");
  });

  it("covers all five ABSTRACT_CAPABILITIES as required keys", () => {
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "allow",
      network: "allow",
    };

    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(policy[cap]).toBeDefined();
    }
  });

  it("each capability value is a valid ToolPermission", () => {
    const validPermissions: ToolPermission[] = ["allow", "deny", "ask"];
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "deny",
    };

    for (const cap of ABSTRACT_CAPABILITIES) {
      expect(validPermissions).toContain(policy[cap]);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PERMISSION
// ---------------------------------------------------------------------------

describe("DEFAULT_PERMISSION", () => {
  it("equals 'ask'", () => {
    expect(DEFAULT_PERMISSION).toBe("ask");
  });

  it("is typed as ToolPermission", () => {
    // Compile-time: DEFAULT_PERMISSION is typed as ToolPermission.
    // Runtime: verify it is one of the three valid values.
    const validPermissions: ToolPermission[] = ["allow", "deny", "ask"];
    expect(validPermissions).toContain(DEFAULT_PERMISSION);
  });

  it("is the safest default (ask requires explicit approval)", () => {
    // Semantic assertion: 'ask' is the most restrictive safe default.
    // 'allow' would be too permissive; 'deny' would break workflows silently.
    expect(DEFAULT_PERMISSION).not.toBe("allow");
    expect(DEFAULT_PERMISSION).not.toBe("deny");
  });
});
