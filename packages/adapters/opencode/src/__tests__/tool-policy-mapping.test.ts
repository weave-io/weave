/** Tests for the OpenCode permission projection. */

import { describe, expect, it } from "bun:test";
import type { EffectiveToolPolicy } from "@weaveio/weave-engine";
import {
  createExecutionLeaseId,
  createWorkflowInstanceId,
  evaluateEffectiveToolPolicy,
  previewToolPolicy,
} from "@weaveio/weave-engine";
import {
  buildReadPermissionEntries,
  mapToolPolicy,
  READ_PERMISSION_NAMES,
  toOpenCodePermission,
} from "../tool-policy-mapping.js";

const allAllowPolicy: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "allow",
};

const allDenyPolicy: EffectiveToolPolicy = {
  read: "deny",
  write: "deny",
  execute: "deny",
  delegate: "deny",
  network: "deny",
};

const allAskPolicy: EffectiveToolPolicy = {
  read: "ask",
  write: "ask",
  execute: "ask",
  delegate: "ask",
  network: "ask",
};

describe("toOpenCodePermission", () => {
  it("preserves allow, deny, and ask exactly", () => {
    expect(toOpenCodePermission("allow")).toBe("allow");
    expect(toOpenCodePermission("deny")).toBe("deny");
    expect(toOpenCodePermission("ask")).toBe("ask");
  });
});

describe("buildReadPermissionEntries", () => {
  it("uses all four pinned OpenCode read permission fields", () => {
    expect(Object.keys(buildReadPermissionEntries("allow"))).toEqual([
      ...READ_PERMISSION_NAMES,
    ]);
  });

  it("maps allow, deny, and ask to every read field", () => {
    for (const action of ["allow", "deny", "ask"] as const) {
      const entries = buildReadPermissionEntries(action);
      for (const name of READ_PERMISSION_NAMES) {
        expect(entries[name]).toBe(action);
      }
    }
  });
});

describe("mapToolPolicy — exact OpenCode schema mapping", () => {
  it("maps allow for read, glob, grep, list, and task", () => {
    const { permission } = mapToolPolicy(allAllowPolicy);

    expect(permission.read).toBe("allow");
    expect(permission.glob).toBe("allow");
    expect(permission.grep).toBe("allow");
    expect(permission.list).toBe("allow");
    expect(permission.task).toBe("allow");
  });

  it("maps deny for read, glob, grep, list, and task", () => {
    const { permission } = mapToolPolicy(allDenyPolicy);

    expect(permission.read).toBe("deny");
    expect(permission.glob).toBe("deny");
    expect(permission.grep).toBe("deny");
    expect(permission.list).toBe("deny");
    expect(permission.task).toBe("deny");
  });

  it("maps ask explicitly instead of enabling reads by omission", () => {
    const { permission } = mapToolPolicy(allAskPolicy);

    expect(permission.read).toBe("ask");
    expect(permission.glob).toBe("ask");
    expect(permission.grep).toBe("ask");
    expect(permission.list).toBe("ask");
    expect(permission.task).toBe("ask");
  });

  it("maps the remaining capabilities to their exact permission names", () => {
    const { permission } = mapToolPolicy({
      read: "ask",
      write: "deny",
      execute: "allow",
      delegate: "ask",
      network: "deny",
    });

    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("allow");
    expect(permission.task).toBe("ask");
    expect(permission.webfetch).toBe("deny");
    expect(Object.hasOwn(permission, "doom_loop")).toBe(false);
  });

  it("contains no legacy boolean read-tool projection", () => {
    const mapping = mapToolPolicy(allDenyPolicy);
    expect(Object.hasOwn(mapping.permission, "tools")).toBe(false);
  });
});

describe("adapter/engine boundary", () => {
  const workflowInstanceId = createWorkflowInstanceId("boundary-test-001");
  const leaseId = createExecutionLeaseId("boundary-lease-001");

  it("passes abstract read capability to the engine", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "glob",
      effectiveToolPolicy: evaluateEffectiveToolPolicy({ read: "allow" }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.decision).toBe("allow");
  });

  it("does not pass OpenCode names as engine capabilities", async () => {
    const rawInput = JSON.parse(
      JSON.stringify({
        workflowInstanceId,
        leaseId,
        agentName: "shuttle",
        toolCapability: "glob",
        toolName: "glob",
        effectiveToolPolicy: evaluateEffectiveToolPolicy({ read: "allow" }),
      }),
    );
    const result = await previewToolPolicy(rawInput);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.type === "validation") {
      expect(result.error.field).toBe("toolCapability");
    }
  });
});
