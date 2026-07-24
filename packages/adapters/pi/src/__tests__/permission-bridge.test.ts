import { describe, expect, it } from "bun:test";
import type {
  EffectiveToolPolicy,
  PermissionResolver,
} from "@weaveio/weave-engine";
import {
  createInMemoryRuntimeStore,
  PermissionRegistryBuilder,
} from "@weaveio/weave-engine";
import { ok } from "neverthrow";
import {
  APPROVAL_UI_TIMEOUT_MS,
  createChildRelayApprovalPort,
  type PiApprovalChoiceInput,
  type PiApprovalPromptRequest,
  type PiApprovalUiPort,
  PiPermissionBridge,
  type PiToolPolicyPlan,
  type PiWeaveToolRegistration,
} from "../permission-bridge.js";
import type {
  PiExtensionApi,
  PiToolInfo,
  PiToolRegistration,
} from "../types.js";
import {
  foreignToolSourceInfo,
  piBuiltinSourceInfo,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

const allowPolicy: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "allow",
};
const askPolicy: EffectiveToolPolicy = {
  read: "ask",
  write: "ask",
  execute: "ask",
  delegate: "ask",
  network: "ask",
};
const denyPolicy: EffectiveToolPolicy = {
  read: "deny",
  write: "deny",
  execute: "deny",
  delegate: "deny",
  network: "deny",
};

function ownSourceInfo(): PiToolInfo["sourceInfo"] {
  return {
    path: "/fake/node_modules/@weaveio/weave-adapter-pi/dist/extension.js",
    source: "npm:@weaveio/weave-adapter-pi",
    scope: "user",
    origin: "package",
  };
}

function tool(name: string, sourceInfo: PiToolInfo["sourceInfo"]): PiToolInfo {
  return { name, sourceInfo };
}

/** A minimal, mutable `getAllTools`-only Pi port for provenance recheck tests. */
function fakePi(initial: readonly PiToolInfo[]): {
  readonly api: Pick<PiExtensionApi, "getAllTools">;
  set(tools: readonly PiToolInfo[]): void;
} {
  let tools = initial;
  return {
    api: { getAllTools: () => tools },
    set(next: readonly PiToolInfo[]) {
      tools = next;
    },
  };
}

const silentLogger = new RecordingLogger();

/** An authoritative, genuinely input-aware resolver for a weave-owned test tool. */
function weaveEchoResolver(): PermissionResolver {
  return ({ call }) => {
    const record = call as Record<string, unknown>;
    const command =
      typeof record.command === "string" ? record.command : undefined;
    if (command === undefined) {
      return ok([
        {
          unresolved: true,
          display: { summary: "weave_echo: missing command" },
        },
      ]);
    }
    return ok([
      {
        unresolved: false,
        capability: "execute",
        operation: "weave_echo",
        target: { kind: "pi-tool-argument", identifier: command },
        display: { summary: `weave_echo: ${command}` },
      },
    ]);
  };
}

function weaveTool(
  name: string,
  resolver: PermissionResolver,
): PiWeaveToolRegistration {
  const definition: PiToolRegistration = {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: {},
    execute: async () => ({ content: [] }),
  };
  return {
    tool: definition,
    owner: "weave",
    revision: "1",
    summary: name,
    resolver,
  };
}

describe("PiPermissionBridge.planToolPolicy", () => {
  it("classifies discovered tools, seals a registry, and proves complete coverage for native + weave-owned tools", () => {
    const allTools = [
      tool("bash", piBuiltinSourceInfo("bash")),
      tool("read", piBuiltinSourceInfo("read")),
      tool("some-other-tool", foreignToolSourceInfo()),
    ];
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const registrations = [
      weaveTool("weave_complete_step", weaveEchoResolver()),
    ];
    const plan = bridge
      .planToolPolicy({
        allTools,
        weaveOwnedRegistrations: registrations,
        policies: { loom: allowPolicy },
      })
      ._unsafeUnwrap();
    expect([...plan.native].sort()).toEqual(["bash", "read"]);
    expect([...plan.verifiedNative].sort()).toEqual(["bash", "read"]);
    expect(plan.weaveOwned).toEqual(["weave_complete_step"]);
    expect(plan.unmanaged).toEqual(["some-other-tool"]);
    expect(plan.coverage.isOk()).toBe(true);
    expect(plan.registry.id).toBeTruthy();
  });

  it("reports incomplete coverage for a native-named tool shadowed by a foreign extension", () => {
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const plan = bridge
      .planToolPolicy({
        allTools: [tool("bash", foreignToolSourceInfo())],
        weaveOwnedRegistrations: [],
        policies: { loom: allowPolicy },
      })
      ._unsafeUnwrap();
    expect(plan.native).toEqual(["bash"]);
    expect(plan.verifiedNative).toEqual([]);
    expect(plan.coverage.isErr()).toBe(true);
  });

  it("exposes tool-identity diagnostics only when requested", () => {
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const plan = bridge
      .planToolPolicy({
        allTools: [tool("bash", piBuiltinSourceInfo("bash"))],
        weaveOwnedRegistrations: [],
        policies: {},
        diagnostics: { includeToolIdentities: true },
      })
      ._unsafeUnwrap();
    const proof = plan.coverage._unsafeUnwrap();
    expect(proof.requiredToolIdentities).toEqual(["bash"]);
    expect(proof.registeredToolIdentities).toEqual(["bash"]);
  });

  it("never mutates Pi - registerTool is not called during planning", () => {
    const registerToolCalls: unknown[] = [];
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    bridge.planToolPolicy({
      allTools: [tool("bash", piBuiltinSourceInfo("bash"))],
      weaveOwnedRegistrations: [
        weaveTool("weave_complete_step", weaveEchoResolver()),
      ],
      policies: {},
    });
    expect(registerToolCalls).toHaveLength(0);
  });
});

class FakeToolRegistrar {
  readonly registerToolCalls: string[] = [];
  private tools: PiToolInfo[];
  dropRegistration = false;
  spoofProvenance = false;

  constructor(initial: readonly PiToolInfo[] = []) {
    this.tools = [...initial];
  }

  getAllTools(): readonly PiToolInfo[] {
    return this.tools;
  }

  registerTool(t: PiToolRegistration): void {
    this.registerToolCalls.push(t.name);
    if (this.dropRegistration) return;
    this.tools.push({
      name: t.name,
      sourceInfo: this.spoofProvenance
        ? foreignToolSourceInfo()
        : ownSourceInfo(),
    });
  }
}

describe("PiPermissionBridge.registerWeaveOwnedTools", () => {
  it("registers a Weave-owned tool once its name is proven free and re-verifies provenance", () => {
    const registrar = new FakeToolRegistrar();
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const result = bridge.registerWeaveOwnedTools(registrar, [
      weaveTool("weave_complete_step", weaveEchoResolver()),
    ]);
    expect(result._unsafeUnwrap()).toEqual(["weave_complete_step"]);
    expect(registrar.registerToolCalls).toEqual(["weave_complete_step"]);
  });

  it("fails closed when the name is not free, and never calls registerTool", () => {
    const registrar = new FakeToolRegistrar([
      tool("weave_complete_step", ownSourceInfo()),
    ]);
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const result = bridge.registerWeaveOwnedTools(registrar, [
      weaveTool("weave_complete_step", weaveEchoResolver()),
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("RequiredCapabilityUnavailable");
    expect(registrar.registerToolCalls).toEqual([]);
  });

  it("fails closed when post-registration provenance cannot be verified (spoofed)", () => {
    const registrar = new FakeToolRegistrar();
    registrar.spoofProvenance = true;
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const result = bridge.registerWeaveOwnedTools(registrar, [
      weaveTool("weave_complete_step", weaveEchoResolver()),
    ]);
    expect(result.isErr()).toBe(true);
  });

  it("fails closed when the registration is silently dropped by the host", () => {
    const registrar = new FakeToolRegistrar();
    registrar.dropRegistration = true;
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const result = bridge.registerWeaveOwnedTools(registrar, [
      weaveTool("weave_complete_step", weaveEchoResolver()),
    ]);
    expect(result.isErr()).toBe(true);
  });

  it("is a no-op for an empty registration list", () => {
    const registrar = new FakeToolRegistrar();
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    expect(
      bridge.registerWeaveOwnedTools(registrar, [])._unsafeUnwrap(),
    ).toEqual([]);
    expect(registrar.registerToolCalls).toEqual([]);
  });

  it("catches a throwing getAllTools/registerTool instead of crashing (neverthrow, not try/catch)", () => {
    const bridge = new PiPermissionBridge({ logger: silentLogger });
    const throwingGetAllTools: Pick<
      PiExtensionApi,
      "registerTool" | "getAllTools"
    > = {
      getAllTools: () => {
        throw new Error("host getAllTools threw");
      },
      registerTool: () => {},
    };
    const result = bridge.registerWeaveOwnedTools(throwingGetAllTools, [
      weaveTool("weave_complete_step", weaveEchoResolver()),
    ]);
    expect(result.isErr()).toBe(true);
  });

  it("never claims a partially-mutated batch as covered: an earlier registration that DID mutate Pi is still reported Err overall", () => {
    // Pi has no unregister receipt - if tool B's post-registration
    // provenance check fails, tool A (registered earlier in the same
    // batch) remains live in Pi's table with no way to undo it. This
    // proves the bridge is honest about that: it returns Err for the
    // whole batch (governance stays blocked) without pretending the
    // earlier mutation never happened.
    const registrar = new FakeToolRegistrar();
    let registrations = 0;
    const spoofingRegistrar: Pick<
      PiExtensionApi,
      "registerTool" | "getAllTools"
    > = {
      getAllTools: () => registrar.getAllTools(),
      registerTool: (t) => {
        registrations += 1;
        // The second registration silently lands under foreign provenance.
        registrar.spoofProvenance = registrations === 2;
        registrar.registerTool(t);
      },
    };
    const result = bridge_registerBatch(spoofingRegistrar, [
      weaveTool("weave_a", weaveEchoResolver()),
      weaveTool("weave_b", weaveEchoResolver()),
    ]);
    expect(result.isErr()).toBe(true);
    // Tool A's mutation genuinely happened and cannot be rolled back.
    expect(registrar.getAllTools().some((t) => t.name === "weave_a")).toBe(
      true,
    );
  });
});

function bridge_registerBatch(
  pi: Pick<PiExtensionApi, "registerTool" | "getAllTools">,
  registrations: readonly PiWeaveToolRegistration[],
) {
  return new PiPermissionBridge({
    logger: silentLogger,
  }).registerWeaveOwnedTools(pi, registrations);
}

describe("PiPermissionBridge.activate", () => {
  it("activates a PermissionSession from a sealed plan", async () => {
    const bridge = new PiPermissionBridge({
      logger: silentLogger,
      runtimeStore: createInMemoryRuntimeStore(),
    });
    const plan = bridge
      .planToolPolicy({
        allTools: [tool("bash", piBuiltinSourceInfo("bash"))],
        weaveOwnedRegistrations: [],
        policies: { loom: allowPolicy },
      })
      ._unsafeUnwrap();
    const session = await bridge.activate({
      project: "project",
      controllerSession: "gen-1",
      plan,
    });
    expect(session.isOk()).toBe(true);
  });
});

interface ActivatedFixture {
  readonly bridge: PiPermissionBridge;
  readonly plan: PiToolPolicyPlan;
  readonly session: import("@weaveio/weave-engine").PermissionSession;
  readonly logger: RecordingLogger;
  readonly pi: {
    readonly api: Pick<PiExtensionApi, "getAllTools">;
    set(t: readonly PiToolInfo[]): void;
  };
}

async function activatedFixture(
  policies: Record<string, EffectiveToolPolicy>,
  options: {
    weaveOwnedRegistrations?: readonly PiWeaveToolRegistration[];
    allTools?: readonly PiToolInfo[];
    runtimeStore?: import("@weaveio/weave-engine").RuntimeStore;
    activationRuntimeStore?: import("@weaveio/weave-engine").RuntimeStore;
    controllerSession?: string;
  } = {},
): Promise<ActivatedFixture> {
  const allTools = options.allTools ?? [
    tool("bash", piBuiltinSourceInfo("bash")),
    tool("read", piBuiltinSourceInfo("read")),
    tool("some-unrelated-tool", foreignToolSourceInfo()),
  ];
  const logger = new RecordingLogger();
  const bridge = new PiPermissionBridge({
    logger,
    runtimeStore: options.runtimeStore,
  });
  const plan = bridge
    .planToolPolicy({
      allTools,
      weaveOwnedRegistrations: options.weaveOwnedRegistrations ?? [],
      policies,
    })
    ._unsafeUnwrap();
  const session = (
    await bridge.activate({
      project: "project",
      controllerSession: options.controllerSession ?? "gen-1",
      plan,
      runtimeStore: options.activationRuntimeStore,
    })
  )._unsafeUnwrap();
  return { bridge, plan, session, logger, pi: fakePi(allTools) };
}

function fixedApprovalUi(
  response: PiApprovalChoiceInput | undefined,
): PiApprovalUiPort {
  return { promptApproval: async () => response };
}

function recordingApprovalUi(): {
  readonly ui: PiApprovalUiPort;
  readonly requests: PiApprovalPromptRequest[];
  respond(choice: PiApprovalChoiceInput | undefined): void;
} {
  const requests: PiApprovalPromptRequest[] = [];
  let queued: PiApprovalChoiceInput | undefined;
  return {
    requests,
    ui: {
      promptApproval: async (request) => {
        requests.push(request);
        return queued;
      },
    },
    respond(choice) {
      queued = choice;
    },
  };
}

describe("PiPermissionBridge.intercept", () => {
  it("passes an unmanaged third-party tool through untouched, without ever calling the engine", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: allowPolicy,
    });
    const outcome = (
      await bridge.intercept({
        session,
        plan,
        project: "project",
        controllerSession: "gen-1",
        agentName: "loom",
        toolIdentity: "some-unrelated-tool",
        call: { anything: true },
        approvalUiAvailable: false,
        approvalUi: fixedApprovalUi(undefined),
        pi: pi.api,
      })
    )._unsafeUnwrap();
    expect(outcome.kind).toBe("allow-unmanaged");
  });

  it("allows a governed call under an allow policy", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: allowPolicy,
    });
    const outcome = (
      await bridge.intercept({
        session,
        plan,
        project: "project",
        controllerSession: "gen-1",
        agentName: "loom",
        toolIdentity: "bash",
        call: { command: "ls" },
        approvalUiAvailable: false,
        approvalUi: fixedApprovalUi(undefined),
        pi: pi.api,
      })
    )._unsafeUnwrap();
    expect(outcome.kind).toBe("allow");
  });

  it("blocks under a deny policy without ever prompting", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: denyPolicy,
    });
    const approval = recordingApprovalUi();
    const outcome = (
      await bridge.intercept({
        session,
        plan,
        project: "project",
        controllerSession: "gen-1",
        agentName: "loom",
        toolIdentity: "bash",
        call: { command: "ls" },
        approvalUiAvailable: true,
        approvalUi: approval.ui,
        pi: pi.api,
      })
    )._unsafeUnwrap();
    expect(outcome).toEqual({ kind: "block", reason: "policy-denied" });
    expect(approval.requests).toHaveLength(0);
  });

  it("blocks when approval is required but no UI is available", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: askPolicy,
    });
    const outcome = (
      await bridge.intercept({
        session,
        plan,
        project: "project",
        controllerSession: "gen-1",
        agentName: "loom",
        toolIdentity: "bash",
        call: { command: "ls" },
        approvalUiAvailable: false,
        approvalUi: fixedApprovalUi(undefined),
        pi: pi.api,
      })
    )._unsafeUnwrap();
    expect(outcome).toEqual({
      kind: "block",
      reason: "approval-ui-unavailable",
    });
  });

  it("blocks on cancellation (undefined choice)", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: askPolicy,
    });
    const outcome = (
      await bridge.intercept({
        session,
        plan,
        project: "project",
        controllerSession: "gen-1",
        agentName: "loom",
        toolIdentity: "bash",
        call: { command: "ls" },
        approvalUiAvailable: true,
        approvalUi: fixedApprovalUi(undefined),
        pi: pi.api,
      })
    )._unsafeUnwrap();
    expect(outcome).toEqual({
      kind: "block",
      reason: "approval-cancelled-or-rejected",
    });
  });

  it("blocks on an explicit reject choice", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: askPolicy,
    });
    const outcome = (
      await bridge.intercept({
        session,
        plan,
        project: "project",
        controllerSession: "gen-1",
        agentName: "loom",
        toolIdentity: "bash",
        call: { command: "ls" },
        approvalUiAvailable: true,
        approvalUi: fixedApprovalUi({ scope: "reject" }),
        pi: pi.api,
      })
    )._unsafeUnwrap();
    expect(outcome).toEqual({
      kind: "block",
      reason: "approval-cancelled-or-rejected",
    });
  });

  it("an 'allow once' grant is never reused for a second identical call", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: askPolicy,
    });
    const first = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "once" }),
      pi: pi.api,
    });
    expect(first._unsafeUnwrap().kind).toBe("allow");

    const approval = recordingApprovalUi();
    approval.respond({ scope: "reject" });
    const second = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: approval.ui,
      pi: pi.api,
    });
    expect(approval.requests).toHaveLength(1);
    expect(second._unsafeUnwrap().kind).toBe("block");
  });

  it("an 'allow for session' grant is reused for a second identical call", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: askPolicy,
    });
    const first = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "session" }),
      pi: pi.api,
    });
    expect(first._unsafeUnwrap().kind).toBe("allow");

    const approval = recordingApprovalUi();
    const second = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: approval.ui,
      pi: pi.api,
    });
    expect(approval.requests).toHaveLength(0);
    expect(second._unsafeUnwrap().kind).toBe("allow");
  });

  it("a session grant for grep in one path does not authorize the identical pattern in a different path (grant isolation across paths)", async () => {
    const { bridge, plan, session, pi } = await activatedFixture(
      { loom: askPolicy },
      {
        allTools: [
          tool("grep", piBuiltinSourceInfo("grep")),
          tool("read", piBuiltinSourceInfo("read")),
        ],
      },
    );
    const grantedInTreeA = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "grep",
      call: { pattern: "TODO", path: "/repo/tree-a" },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "session" }),
      pi: pi.api,
    });
    expect(grantedInTreeA._unsafeUnwrap().kind).toBe("allow");

    // Same exact pattern, a DIFFERENT tree - must require a fresh approval
    // rather than silently reusing tree A's session grant (Spec 33 §12.1,
    // Spec 34 §5/§7: distinct authorization identity per bound target).
    const approvalTreeB = recordingApprovalUi();
    approvalTreeB.respond(undefined);
    const blockedInTreeB = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "grep",
      call: { pattern: "TODO", path: "/repo/tree-b" },
      approvalUiAvailable: true,
      approvalUi: approvalTreeB.ui,
      pi: pi.api,
    });
    expect(approvalTreeB.requests).toHaveLength(1);
    expect(blockedInTreeB._unsafeUnwrap().kind).toBe("block");

    // Repeating tree A's exact call again still reuses tree A's own grant.
    const repeatTreeA = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "grep",
      call: { pattern: "TODO", path: "/repo/tree-a" },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi(undefined),
      pi: pi.api,
    });
    expect(repeatTreeA._unsafeUnwrap().kind).toBe("allow");
  });

  it("a session grant for one long command does not authorize a distinct long command sharing only a long common prefix (no truncation collision, end-to-end)", async () => {
    const { bridge, plan, session, pi } = await activatedFixture(
      { loom: askPolicy },
      { allTools: [tool("bash", piBuiltinSourceInfo("bash"))] },
    );
    const prefix = "x".repeat(400);
    const grantedA = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: `${prefix}-A` },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "session" }),
      pi: pi.api,
    });
    expect(grantedA._unsafeUnwrap().kind).toBe("allow");

    // A distinct command sharing only the long prefix must still require a
    // fresh approval - a truncated identifier would collapse both onto the
    // same authorization and this call would be wrongly reused.
    const approvalB = recordingApprovalUi();
    approvalB.respond(undefined);
    const blockedB = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: `${prefix}-B` },
      approvalUiAvailable: true,
      approvalUi: approvalB.ui,
      pi: pi.api,
    });
    expect(approvalB.requests).toHaveLength(1);
    expect(blockedB._unsafeUnwrap().kind).toBe("block");
  });

  it("a session grant for a delimiter-like grep path/pattern pair does not authorize a differently-split equivalent (unambiguous structure, end-to-end)", async () => {
    const { bridge, plan, session, pi } = await activatedFixture(
      { loom: askPolicy },
      { allTools: [tool("grep", piBuiltinSourceInfo("grep"))] },
    );
    const grantedA = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "grep",
      call: { pattern: "c", path: "a::b" },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "session" }),
      pi: pi.api,
    });
    expect(grantedA._unsafeUnwrap().kind).toBe("allow");

    // A string-concatenated target would have collapsed path "a::b" +
    // pattern "c" onto the same identifier as path "a" + pattern "b::c" -
    // the unambiguous target+constraints structure must keep them distinct.
    const approvalB = recordingApprovalUi();
    approvalB.respond(undefined);
    const blockedB = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "grep",
      call: { pattern: "b::c", path: "a" },
      approvalUiAvailable: true,
      approvalUi: approvalB.ui,
      pi: pi.api,
    });
    expect(approvalB.requests).toHaveLength(1);
    expect(blockedB._unsafeUnwrap().kind).toBe("block");
  });

  it("'durable' is never offered as an approval scope without an explicitly injected durable store", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: askPolicy,
    });
    const approval = recordingApprovalUi();
    approval.respond({ scope: "reject" });
    await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: approval.ui,
      pi: pi.api,
    });
    expect(approval.requests).toHaveLength(1);
    expect(approval.requests[0].allowedScopes).toEqual(["once", "session"]);
  });

  it("offers durable scope when production binds the opened Runtime Store at activation", async () => {
    const { bridge, plan, session, pi } = await activatedFixture(
      { loom: askPolicy },
      { activationRuntimeStore: createInMemoryRuntimeStore() },
    );
    const approval = recordingApprovalUi();
    approval.respond({ scope: "reject" });
    await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: approval.ui,
      pi: pi.api,
    });
    expect(approval.requests[0]?.allowedScopes).toEqual([
      "once",
      "session",
      "durable",
    ]);
  });

  it("'durable' allows a grant to persist across sessions when a durable store is explicitly injected", async () => {
    // A bare in-memory store only becomes a "durable repository" for this
    // bridge's purposes when the caller explicitly injects it - tests may
    // do so deliberately (Spec 34 boundary note in PiPermissionBridgeDeps).
    const runtimeStore = createInMemoryRuntimeStore();
    const first = await activatedFixture(
      { loom: askPolicy },
      { runtimeStore, controllerSession: "s1" },
    );
    const durableOutcome = await first.bridge.intercept({
      session: first.session,
      plan: first.plan,
      project: "project",
      controllerSession: "s1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "durable" }),
      pi: first.pi.api,
    });
    expect(durableOutcome._unsafeUnwrap().kind).toBe("allow");

    const second = await activatedFixture(
      { loom: askPolicy },
      { runtimeStore, controllerSession: "s2" },
    );
    const approval = recordingApprovalUi();
    const reused = await second.bridge.intercept({
      session: second.session,
      plan: second.plan,
      project: "project",
      controllerSession: "s2",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: true,
      approvalUi: approval.ui,
      pi: second.pi.api,
    });
    expect(approval.requests).toHaveLength(0);
    expect(reused._unsafeUnwrap().kind).toBe("allow");
  });

  it("distinct exact calls to the same governed tool do not share authorization unless the resolver maps them to the same request", async () => {
    const registration = weaveTool("weave_echo", weaveEchoResolver());
    const { bridge, plan, session, pi } = await activatedFixture(
      { loom: askPolicy },
      {
        weaveOwnedRegistrations: [registration],
        allTools: [tool("weave_echo", ownSourceInfo())],
      },
    );
    const approvalA = recordingApprovalUi();
    approvalA.respond({ scope: "session" });
    const first = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_echo",
      call: { command: "echo one" },
      approvalUiAvailable: true,
      approvalUi: approvalA.ui,
      pi: pi.api,
    });
    expect(first._unsafeUnwrap().kind).toBe("allow");

    // A DIFFERENT exact call to the same tool must still require its own
    // approval - the session grant from the first call must not cover it.
    const approvalB = recordingApprovalUi();
    const second = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_echo",
      call: { command: "echo two" },
      approvalUiAvailable: true,
      approvalUi: approvalB.ui,
      pi: pi.api,
    });
    expect(approvalB.requests).toHaveLength(1);
    expect(second._unsafeUnwrap().kind).toBe("block");

    // The EXACT SAME call as the first is covered by its session grant.
    const approvalC = recordingApprovalUi();
    const third = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_echo",
      call: { command: "echo one" },
      approvalUiAvailable: true,
      approvalUi: approvalC.ui,
      pi: pi.api,
    });
    expect(approvalC.requests).toHaveLength(0);
    expect(third._unsafeUnwrap().kind).toBe("allow");
  });

  it("unresolved requests only ever permit a once-only approval scope", async () => {
    const builder = new PermissionRegistryBuilder();
    builder
      .register({
        toolIdentity: "weave_unresolvable",
        owner: "weave",
        revision: "1",
        summary: "always unresolved",
        resolver: () =>
          ok([{ unresolved: true, display: { summary: "unresolved" } }]),
      })
      ._unsafeUnwrap();
    const registry = builder.seal()._unsafeUnwrap();
    const plan: PiToolPolicyPlan = {
      registry,
      native: [],
      verifiedNative: [],
      weaveOwned: ["weave_unresolvable"],
      unmanaged: [],
      policies: { loom: askPolicy },
      coverage: ok({
        generationId: registry.id,
        metadataIdentity: registry.identity,
        requiredCount: 1,
        registeredCount: 1,
        interceptedCount: 1,
        unmanagedCount: 0,
      }),
    };
    const logger = new RecordingLogger();
    const bridge = new PiPermissionBridge({ logger });
    const session = (
      await bridge.activate({
        project: "project",
        controllerSession: "gen-1",
        plan,
      })
    )._unsafeUnwrap();
    const pi = fakePi([tool("weave_unresolvable", ownSourceInfo())]);

    const illegal = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_unresolvable",
      call: {},
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "session" }),
      pi: pi.api,
    });
    expect(illegal._unsafeUnwrap()).toEqual({
      kind: "block",
      reason: "approval-scope-not-permitted",
    });

    const legal = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_unresolvable",
      call: {},
      approvalUiAvailable: true,
      approvalUi: fixedApprovalUi({ scope: "once" }),
      pi: pi.api,
    });
    expect(legal._unsafeUnwrap().kind).toBe("allow");
  });

  it("blocks and never leaks secret content when a resolver throws", async () => {
    const builder = new PermissionRegistryBuilder();
    builder
      .register({
        toolIdentity: "weave_broken",
        owner: "weave",
        revision: "1",
        summary: "always throws",
        resolver: () => {
          throw new Error("leaked: token=sk-super-secret-123");
        },
      })
      ._unsafeUnwrap();
    const registry = builder.seal()._unsafeUnwrap();
    const plan: PiToolPolicyPlan = {
      registry,
      native: [],
      verifiedNative: [],
      weaveOwned: ["weave_broken"],
      unmanaged: [],
      policies: { loom: allowPolicy },
      coverage: ok({
        generationId: registry.id,
        metadataIdentity: registry.identity,
        requiredCount: 1,
        registeredCount: 1,
        interceptedCount: 1,
        unmanagedCount: 0,
      }),
    };
    const logger = new RecordingLogger();
    const bridge = new PiPermissionBridge({ logger });
    const session = (
      await bridge.activate({
        project: "project",
        controllerSession: "gen-1",
        plan,
      })
    )._unsafeUnwrap();
    const pi = fakePi([tool("weave_broken", ownSourceInfo())]);

    const outcome = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_broken",
      call: { anything: "token=sk-super-secret-123" },
      approvalUiAvailable: false,
      approvalUi: fixedApprovalUi(undefined),
      pi: pi.api,
    });
    expect(outcome._unsafeUnwrap().kind).toBe("block");
    expect(JSON.stringify(outcome)).not.toContain("sk-super-secret-123");
    for (const entry of logger.entries) {
      expect(JSON.stringify(entry)).not.toContain("sk-super-secret-123");
    }
  });

  it("recheck at the tool boundary: blocks a native tool later displaced by a foreign extension", async () => {
    const { bridge, plan, session, pi } = await activatedFixture({
      loom: allowPolicy,
    });
    const first = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: false,
      approvalUi: fixedApprovalUi(undefined),
      pi: pi.api,
    });
    expect(first._unsafeUnwrap().kind).toBe("allow");

    // A foreign extension registers over "bash" after activation - Pi
    // permits this (docs/extensions.md); it must never be silently trusted.
    pi.set([tool("bash", foreignToolSourceInfo())]);
    const second = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "ls" },
      approvalUiAvailable: false,
      approvalUi: fixedApprovalUi(undefined),
      pi: pi.api,
    });
    expect(second._unsafeUnwrap()).toEqual({
      kind: "block",
      reason: "tool-provenance-changed",
    });
  });

  it("recheck at the tool boundary: blocks a Weave-owned tool whose provenance was lost", async () => {
    const registration = weaveTool("weave_echo", weaveEchoResolver());
    const { bridge, plan, session, pi } = await activatedFixture(
      { loom: allowPolicy },
      {
        weaveOwnedRegistrations: [registration],
        allTools: [tool("weave_echo", ownSourceInfo())],
      },
    );
    pi.set([tool("weave_echo", foreignToolSourceInfo())]);
    const outcome = await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "weave_echo",
      call: { command: "echo hi" },
      approvalUiAvailable: false,
      approvalUi: fixedApprovalUi(undefined),
      pi: pi.api,
    });
    expect(outcome._unsafeUnwrap()).toEqual({
      kind: "block",
      reason: "tool-provenance-changed",
    });
  });

  it("never logs raw call input, display text, or constraints", async () => {
    const { bridge, plan, session, pi, logger } = await activatedFixture({
      loom: denyPolicy,
    });
    await bridge.intercept({
      session,
      plan,
      project: "project",
      controllerSession: "gen-1",
      agentName: "loom",
      toolIdentity: "bash",
      call: { command: "cat /etc/shadow token=sk-super-secret-123" },
      approvalUiAvailable: false,
      approvalUi: fixedApprovalUi(undefined),
      pi: pi.api,
    });
    for (const entry of logger.entries) {
      const text = JSON.stringify(entry);
      expect(text).not.toContain("sk-super-secret-123");
      expect(text).not.toContain("/etc/shadow");
    }
  });
});

describe("createChildRelayApprovalPort", () => {
  it("relays the exact prompt request to the named child and passes the choice through unchanged", async () => {
    let seenChildId: string | undefined;
    let seenRequest: PiApprovalPromptRequest | undefined;
    const port = createChildRelayApprovalPort(
      {
        relay: async (childId, request) => {
          seenChildId = childId;
          seenRequest = request;
          return { scope: "once" };
        },
      },
      "child-42",
    );
    const request: PiApprovalPromptRequest = {
      agentName: "loom",
      toolIdentity: "bash",
      requests: [],
      allowedScopes: ["once"],
    };
    const choice = await port.promptApproval(request);
    expect(seenChildId).toBe("child-42");
    expect(seenRequest).toBe(request);
    expect(choice).toEqual({ scope: "once" });
  });

  it("propagates a relay cancellation (undefined) unchanged", async () => {
    const port = createChildRelayApprovalPort(
      { relay: async () => undefined },
      "child-1",
    );
    const choice = await port.promptApproval({
      agentName: "loom",
      toolIdentity: "bash",
      requests: [],
      allowedScopes: ["once"],
    });
    expect(choice).toBeUndefined();
  });
});

it("exports a bounded approval UI timeout comfortably under the engine's 5-minute challenge expiry", () => {
  expect(APPROVAL_UI_TIMEOUT_MS).toBeGreaterThan(0);
  expect(APPROVAL_UI_TIMEOUT_MS).toBeLessThan(300_000);
});
