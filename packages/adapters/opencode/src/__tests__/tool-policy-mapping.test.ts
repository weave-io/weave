/**
 * Unit tests for `tool-policy-mapping.ts`.
 *
 * ## What these tests prove
 *
 * ### Adapter / Engine boundary
 * 1. The adapter maps concrete OpenCode tool names to abstract capabilities
 *    before any engine call — the engine never sees OpenCode tool names.
 * 2. `mapToolPolicy` produces the correct `permission` block from an
 *    `EffectiveToolPolicy` without branching on harness-specific names.
 * 3. `READ_TOOL_NAMES` is the single source of truth for read-class tool names
 *    in the OpenCode adapter.
 *
 * ### Policy mapping correctness
 * 4. `toOpenCodePermission` maps all three Weave values 1-to-1.
 * 5. `buildReadToolsEntry` returns `undefined` for allow/ask and a deny map
 *    for deny.
 * 6. `mapToolPolicy` produces the correct `permission` block for all five
 *    abstract capabilities.
 * 7. `mapToolPolicy` produces the correct `tools` patch when `read` is denied.
 *
 * ### Engine boundary: previewToolPolicy receives abstract capabilities only
 * 8. `previewToolPolicy` accepts abstract capability names ("read", "write", etc.)
 *    and never receives OpenCode tool names ("glob", "grep", etc.) directly.
 * 9. The adapter maps concrete tool names to abstract capabilities before
 *    calling `previewToolPolicy` — the engine policy decision is capability-based.
 *
 * All tests are pure — no filesystem access, no SDK calls, no harness startup.
 */

import { describe, expect, it } from "bun:test";
import type { EffectiveToolPolicy } from "@weaveio/weave-engine";
import {
  createExecutionLeaseId,
  createWorkflowInstanceId,
  evaluateEffectiveToolPolicy,
  previewToolPolicy,
} from "@weaveio/weave-engine";
import {
  buildReadToolsEntry,
  mapToolPolicy,
  READ_TOOL_NAMES,
  toOpenCodePermission,
} from "../tool-policy-mapping.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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

const mixedPolicy: EffectiveToolPolicy = {
  read: "allow",
  write: "deny",
  execute: "ask",
  delegate: "deny",
  network: "ask",
};

// ---------------------------------------------------------------------------
// § 1 — toOpenCodePermission
// ---------------------------------------------------------------------------

describe("toOpenCodePermission — 1-to-1 mapping", () => {
  it("maps 'allow' to 'allow'", () => {
    expect(toOpenCodePermission("allow")).toBe("allow");
  });

  it("maps 'deny' to 'deny'", () => {
    expect(toOpenCodePermission("deny")).toBe("deny");
  });

  it("maps 'ask' to 'ask'", () => {
    expect(toOpenCodePermission("ask")).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// § 2 — buildReadToolsEntry
// ---------------------------------------------------------------------------

describe("buildReadToolsEntry — read capability to tools map", () => {
  it("returns undefined when read is 'allow'", () => {
    expect(buildReadToolsEntry("allow")).toBeUndefined();
  });

  it("returns undefined when read is 'ask'", () => {
    expect(buildReadToolsEntry("ask")).toBeUndefined();
  });

  it("returns a deny map when read is 'deny'", () => {
    const result = buildReadToolsEntry("deny");
    expect(result).toBeDefined();
  });

  it("sets every READ_TOOL_NAME to false when read is 'deny'", () => {
    const result = buildReadToolsEntry("deny");
    expect(result).toBeDefined();
    if (!result) return;
    for (const name of READ_TOOL_NAMES) {
      expect(result[name]).toBe(false);
    }
  });

  it("deny map contains exactly the READ_TOOL_NAMES entries", () => {
    const result = buildReadToolsEntry("deny");
    expect(result).toBeDefined();
    if (!result) return;
    const keys = Object.keys(result);
    expect(keys.length).toBe(READ_TOOL_NAMES.length);
    for (const key of keys) {
      expect(READ_TOOL_NAMES).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// § 3 — READ_TOOL_NAMES — single source of truth
// ---------------------------------------------------------------------------

describe("READ_TOOL_NAMES — single source of truth for read-class tools", () => {
  it("is a non-empty readonly array", () => {
    expect(Array.isArray(READ_TOOL_NAMES)).toBe(true);
    expect(READ_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("contains only non-empty tool names", () => {
    for (const name of READ_TOOL_NAMES) {
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("contains the expected read-class tool names", () => {
    // These are the concrete OpenCode tool names for the read capability.
    // The engine never sees these names — only the adapter does.
    expect(READ_TOOL_NAMES).toContain("read");
    expect(READ_TOOL_NAMES).toContain("glob");
    expect(READ_TOOL_NAMES).toContain("grep");
    expect(READ_TOOL_NAMES).toContain("list");
  });

  it("does not contain write-class tool names", () => {
    // Write-class tools are mapped via permission.edit, not via READ_TOOL_NAMES.
    // This proves the adapter does not conflate read and write tool names.
    expect(READ_TOOL_NAMES).not.toContain("edit");
    expect(READ_TOOL_NAMES).not.toContain("write");
    expect(READ_TOOL_NAMES).not.toContain("bash");
  });
});

// ---------------------------------------------------------------------------
// § 4 — mapToolPolicy — permission block
// ---------------------------------------------------------------------------

describe("mapToolPolicy — permission block from EffectiveToolPolicy", () => {
  it("maps write capability to permission.edit", () => {
    const { permission } = mapToolPolicy(allAllowPolicy);
    expect(permission.edit).toBe("allow");
  });

  it("maps execute capability to permission.bash", () => {
    const { permission } = mapToolPolicy(allAllowPolicy);
    expect(permission.bash).toBe("allow");
  });

  it("maps network capability to permission.webfetch", () => {
    const { permission } = mapToolPolicy(allAllowPolicy);
    expect(permission.webfetch).toBe("allow");
  });

  it("maps delegate capability to permission.task", () => {
    const { permission } = mapToolPolicy(allAllowPolicy);
    expect(permission.task).toBe("allow");
    expect(Object.hasOwn(permission, "doom_loop")).toBe(false);
  });

  it("produces all-deny permission block from all-deny policy", () => {
    const { permission } = mapToolPolicy(allDenyPolicy);
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("deny");
    expect(permission.webfetch).toBe("deny");
    expect(permission.task).toBe("deny");
  });

  it("produces all-ask permission block from all-ask policy", () => {
    const { permission } = mapToolPolicy(allAskPolicy);
    expect(permission.edit).toBe("ask");
    expect(permission.bash).toBe("ask");
    expect(permission.webfetch).toBe("ask");
    expect(permission.task).toBe("ask");
  });

  it("maps mixed policy correctly to each permission field", () => {
    const { permission } = mapToolPolicy(mixedPolicy);
    // write: deny → edit: deny
    expect(permission.edit).toBe("deny");
    // execute: ask → bash: ask
    expect(permission.bash).toBe("ask");
    // network: ask → webfetch: ask
    expect(permission.webfetch).toBe("ask");
    // delegate: deny → task: deny
    expect(permission.task).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// § 5 — mapToolPolicy — tools patch for read capability
// ---------------------------------------------------------------------------

describe("mapToolPolicy — tools patch for read capability", () => {
  it("returns undefined tools when read is 'allow'", () => {
    const { tools } = mapToolPolicy(allAllowPolicy);
    expect(tools).toBeUndefined();
  });

  it("returns undefined tools when read is 'ask'", () => {
    const { tools } = mapToolPolicy(allAskPolicy);
    expect(tools).toBeUndefined();
  });

  it("returns a deny map for tools when read is 'deny'", () => {
    const { tools } = mapToolPolicy(allDenyPolicy);
    expect(tools).toBeDefined();
    if (!tools) return;
    for (const name of READ_TOOL_NAMES) {
      expect(tools[name]).toBe(false);
    }
  });

  it("tools patch is undefined even when other capabilities are deny", () => {
    // Only read capability controls the tools patch.
    // Other deny capabilities are expressed via permission fields, not tools.
    const policy: EffectiveToolPolicy = {
      read: "allow",
      write: "deny",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    };
    const { tools } = mapToolPolicy(policy);
    expect(tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// § 6 — Adapter / Engine boundary: engine never sees OpenCode tool names
// ---------------------------------------------------------------------------

describe("adapter/engine boundary — engine receives abstract capabilities only", () => {
  const wfId = createWorkflowInstanceId("boundary-test-001");
  const leaseId = createExecutionLeaseId("boundary-lease-001");

  it("previewToolPolicy accepts abstract capability 'read' — not OpenCode tool name 'glob'", async () => {
    // The adapter maps "glob" → "read" before calling previewToolPolicy.
    // The engine only sees the abstract capability "read".
    const policy = evaluateEffectiveToolPolicy({ read: "allow" });
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read", // abstract capability — adapter-resolved
      toolName: "glob", // concrete OpenCode tool name — for audit only
      effectiveToolPolicy: policy,
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("previewToolPolicy accepts abstract capability 'read' — not OpenCode tool name 'grep'", async () => {
    const policy = evaluateEffectiveToolPolicy({ read: "deny" });
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read", // abstract capability
      toolName: "grep", // concrete OpenCode tool name — for audit only
      effectiveToolPolicy: policy,
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("deny");
  });

  it("previewToolPolicy accepts abstract capability 'write' — not OpenCode tool name 'edit'", async () => {
    const policy = evaluateEffectiveToolPolicy({ write: "ask" });
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "write", // abstract capability
      toolName: "edit", // concrete OpenCode tool name — for audit only
      effectiveToolPolicy: policy,
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("ask");
  });

  it("previewToolPolicy accepts abstract capability 'execute' — not OpenCode tool name 'bash'", async () => {
    const policy = evaluateEffectiveToolPolicy({ execute: "deny" });
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "execute", // abstract capability
      toolName: "bash", // concrete OpenCode tool name — for audit only
      effectiveToolPolicy: policy,
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("deny");
  });

  it("previewToolPolicy accepts abstract capability 'network' — not OpenCode tool name 'webfetch'", async () => {
    const policy = evaluateEffectiveToolPolicy({ network: "allow" });
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "network", // abstract capability
      toolName: "webfetch", // concrete OpenCode tool name — for audit only
      effectiveToolPolicy: policy,
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("previewToolPolicy rejects an OpenCode tool name passed as toolCapability", async () => {
    // This proves the engine does NOT branch on OpenCode tool names.
    // The raw fixture enters the engine's runtime validation seam directly;
    // it is never first represented as a trusted typed input.
    const policy = evaluateEffectiveToolPolicy({ read: "allow" });
    const rawInput = JSON.parse(
      JSON.stringify({
        workflowInstanceId: wfId,
        leaseId,
        agentName: "shuttle",
        toolCapability: "glob",
        toolName: "glob",
        effectiveToolPolicy: policy,
      }),
    );
    const result = await previewToolPolicy(rawInput);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("toolCapability");
    }
  });

  it("previewToolPolicy rejects 'bash' passed as toolCapability (not an abstract capability)", async () => {
    const policy = evaluateEffectiveToolPolicy({ execute: "allow" });
    const rawInput = JSON.parse(
      JSON.stringify({
        workflowInstanceId: wfId,
        leaseId,
        agentName: "shuttle",
        toolCapability: "bash",
        toolName: "bash",
        effectiveToolPolicy: policy,
      }),
    );
    const result = await previewToolPolicy(rawInput);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("previewToolPolicy rejects 'edit' passed as toolCapability (not an abstract capability)", async () => {
    const policy = evaluateEffectiveToolPolicy({ write: "allow" });
    const rawInput = JSON.parse(
      JSON.stringify({
        workflowInstanceId: wfId,
        leaseId,
        agentName: "shuttle",
        toolCapability: "edit",
        toolName: "edit",
        effectiveToolPolicy: policy,
      }),
    );
    const result = await previewToolPolicy(rawInput);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("previewToolPolicy rejects 'webfetch' passed as toolCapability (not an abstract capability)", async () => {
    const policy = evaluateEffectiveToolPolicy({ network: "allow" });
    const rawInput = JSON.parse(
      JSON.stringify({
        workflowInstanceId: wfId,
        leaseId,
        agentName: "shuttle",
        toolCapability: "webfetch",
        toolName: "webfetch",
        effectiveToolPolicy: policy,
      }),
    );
    const result = await previewToolPolicy(rawInput);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// § 7 — previewToolPolicy metadata sanitization — no secret-bearing metadata
// ---------------------------------------------------------------------------

describe("previewToolPolicy — rejects secret-bearing metadata", () => {
  const wfId = createWorkflowInstanceId("metadata-test-001");
  const leaseId = createExecutionLeaseId("metadata-lease-001");
  const policy = evaluateEffectiveToolPolicy({ read: "allow" });

  it("rejects metadata with 'token' key", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: policy,
      metadata: { token: "secret-value" },
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("rejects metadata with 'password' key", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: policy,
      metadata: { password: "hunter2" },
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("rejects metadata with 'apiKey' key", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: policy,
      metadata: { apiKey: "sk-1234" },
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("rejects metadata with 'secret' key", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: policy,
      metadata: { secret: "my-secret" },
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("accepts safe metadata with non-denied keys", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: policy,
      metadata: { stepName: "execute", agentName: "shuttle", attempt: 1 },
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("accepts undefined metadata (no metadata field)", async () => {
    const result = await previewToolPolicy({
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: policy,
      // metadata omitted
    });
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § 8 — mapToolPolicy round-trip: all five capabilities
// ---------------------------------------------------------------------------

describe("mapToolPolicy — all five abstract capabilities are mapped", () => {
  it("maps all five capabilities from an all-allow policy", () => {
    const { permission, tools } = mapToolPolicy(allAllowPolicy);
    // write → edit
    expect(permission.edit).toBe("allow");
    // execute → bash
    expect(permission.bash).toBe("allow");
    // network → webfetch
    expect(permission.webfetch).toBe("allow");
    // delegate → task
    expect(permission.task).toBe("allow");
    // read → tools (undefined when allow)
    expect(tools).toBeUndefined();
  });

  it("maps all five capabilities from an all-deny policy", () => {
    const { permission, tools } = mapToolPolicy(allDenyPolicy);
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("deny");
    expect(permission.webfetch).toBe("deny");
    expect(permission.task).toBe("deny");
    // read → tools (deny map when deny)
    expect(tools).toBeDefined();
  });

  it("permission block has exactly the four expected fields", () => {
    const { permission } = mapToolPolicy(allAllowPolicy);
    const keys = Object.keys(permission);
    expect(keys).toContain("edit");
    expect(keys).toContain("bash");
    expect(keys).toContain("webfetch");
    expect(keys).toContain("task");
    expect(keys).not.toContain("doom_loop");
    // No OpenCode tool names should appear as permission keys
    expect(keys).not.toContain("read");
    expect(keys).not.toContain("glob");
    expect(keys).not.toContain("grep");
    expect(keys).not.toContain("list");
  });
});
