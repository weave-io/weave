import { describe, expect, it } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import { MAX_CWD_LENGTH } from "../child-control-bodies.js";
import {
  bytesToHex,
  generateNonceHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import {
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";
import { signEnvelope } from "../child-envelope.js";
import {
  classifyApprovalRelayFailureCause,
  cloneApprovalPromptRequestAsJson,
  createPiExtension,
} from "../extension.js";
import type { JsonValue } from "../strict-json.js";
import type {
  PiCommandRegistration,
  PiEnvPort,
  PiEventHandler,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiToolInfo,
} from "../types.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";

/**
 * Layer C, private-child variant: exercises `createPiExtension()`'s real
 * `piAdapterExtension` function end-to-end against a minimal hand-built
 * `PiExtensionApi` fake, with a scripted bootstrap secret delivered only
 * through the environment (never argv/prompt), proving the whole spawned
 * `pi --mode rpc --no-session` child path - handshake detection, hidden
 * control-command wiring, bootstrap application (composed prompt + tool
 * policy), governed tool-call blocking, and settlement reporting - without
 * ever starting a real Pi process.
 */

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

class FakeEnvPort implements PiEnvPort {
  constructor(private readonly values: Map<string, string>) {}
  read(name: string): string | undefined {
    return this.values.get(name);
  }
  deleteValue(name: string): void {
    this.values.delete(name);
  }
}

class FakeOutputPort {
  readonly lines: Record<string, unknown>[] = [];
  writeLine(
    bytes: Uint8Array,
  ): ResultAsync<void, { type: "ChildOutputWriteFailed"; reason: string }> {
    for (const line of new TextDecoder().decode(bytes).split("\n")) {
      if (line.length > 0) this.lines.push(JSON.parse(line));
    }
    return okAsync(undefined);
  }
}

class MinimalFakeHost implements PiExtensionApi {
  readonly commands = new Map<string, PiCommandRegistration>();
  readonly events = new Map<string, PiEventHandler[]>();
  registerCommand(name: string, registration: PiCommandRegistration): void {
    this.commands.set(name, registration);
  }
  getCommands() {
    return [];
  }
  /** Overridable per test; defaults to just `bash` for the existing tests. */
  toolsInventory: readonly PiToolInfo[] = [
    {
      name: "bash",
      sourceInfo: {
        path: "<builtin:bash>",
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
    },
  ];
  getAllTools(): readonly PiToolInfo[] {
    return this.toolsInventory;
  }
  on(event: string, handler: PiEventHandler): void {
    const existing = this.events.get(event) ?? [];
    existing.push(handler);
    this.events.set(event, existing);
  }
  registerTool(): void {}
  /** Set to `false` to simulate the host declining a `setModel()` call. */
  modelAccepted = true;
  readonly setModelCalls: PiModelInfo[] = [];
  setModel(model: PiModelInfo): boolean {
    this.setModelCalls.push(model);
    return this.modelAccepted;
  }
  readonly setActiveToolsCalls: (readonly string[])[] = [];
  activeTools: readonly string[] = [];
  setActiveTools(names: readonly string[]): void {
    this.setActiveToolsCalls.push(names);
    this.activeTools = [...names];
  }
  getActiveTools(): readonly string[] {
    return this.activeTools;
  }
  async fire(
    event: string,
    payload: unknown,
    ctx: PiSessionContext,
  ): Promise<unknown> {
    const handlers = this.events.get(event) ?? [];
    let result: unknown;
    for (const handler of handlers) {
      const outcome = await handler(payload, ctx);
      if (outcome !== undefined) result = outcome;
    }
    return result;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeCtx(overrides: Partial<PiSessionContext> = {}): PiSessionContext {
  return {
    mode: "rpc",
    cwd: "/project",
    isProjectTrusted: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
    ...overrides,
  };
}

async function buildChildExtension(sessionCtx: PiSessionContext = fakeCtx()) {
  const secretBytes = randomPort.randomBytes(32);
  const env = new FakeEnvPort(
    new Map([
      [WEAVE_CHILD_SECRET_ENV, bytesToHex(secretBytes)],
      [WEAVE_CHILD_ID_ENV, "child-1"],
      [WEAVE_CONTROLLER_GENERATION_ENV, "gen-1"],
    ]),
  );
  const output = new FakeOutputPort();
  const host = new MinimalFakeHost();
  const factory = createPiExtension({
    envPort: env,
    randomPort,
    hmacPort,
    processPort: new FakeChildProcessPort(),
    childOutputPort: output,
  });
  factory(host);
  // The hidden hidden `weave:__control__` command handler only takes
  // `rawArgs` - `applyChildBootstrap()` always closes over the *session's*
  // own `ctx` (captured once, at `session_start`), not any per-invocation
  // ctx a caller might pass to the command handler. Tests that need a
  // specific `ctx.modelRegistry`/`ctx.model` must supply it here.
  await host.fire("session_start", {}, sessionCtx);
  return { host, output, secretBytes };
}

async function deliverEnvelope(
  host: MinimalFakeHost,
  envelope: JsonValue,
  ctx: PiSessionContext = fakeCtx(),
): Promise<void> {
  const control = host.commands.get("weave:__control__");
  expect(control).toBeDefined();
  await control?.handler(JSON.stringify(envelope), ctx);
}

/** Builds a schema-valid signed bootstrap envelope, with per-test overrides. */
async function signedBootstrap(
  secretBytes: Uint8Array,
  bodyOverrides: Record<string, unknown> = {},
): Promise<JsonValue> {
  const envelope = await signEnvelope(
    {
      childId: "child-1",
      generationId: "gen-1",
      direction: "parent-to-child",
      sequence: 1,
      nonce: generateNonceHex(randomPort),
      correlationId: "child-1",
      kind: "bootstrap",
      body: {
        mode: "ordinary",
        agentName: "shuttle",
        composedPrompt: "You are Shuttle, a delegated specialist.",
        models: [],
        correlationId: "child-1",
        context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
        activeTools: [],
        ...bodyOverrides,
      },
    },
    secretBytes,
    hmacPort,
  );
  return envelope._unsafeUnwrap() as unknown as JsonValue;
}

describe("private child mode (Spec 33 §11.2-§11.5, end-to-end against a fake host)", () => {
  it("detects the bootstrap secret via environment only, completes the handshake, and registers the hidden control command", async () => {
    const { host, output } = await buildChildExtension();
    expect(host.commands.has("weave:__control__")).toBe(true);
    const handshake = output.lines[0];
    expect(handshake?.kind).toBe("handshake");
    expect(handshake?.childId).toBe("child-1");
  });

  it("never activates child behavior for an ordinary session with no bootstrap secret present", async () => {
    const env = new FakeEnvPort(new Map());
    const output = new FakeOutputPort();
    const host = new MinimalFakeHost();
    const factory = createPiExtension({
      envPort: env,
      randomPort,
      hmacPort,
      processPort: new FakeChildProcessPort(),
      childOutputPort: output,
    });
    factory(host);
    expect(host.commands.has("weave:__control__")).toBe(false);
    expect(output.lines.length).toBe(0);
  });

  it("applies the bootstrap descriptor's composed prompt exactly once, then blocks a governed native tool call denied by its own effective policy", async () => {
    const { host, secretBytes } = await buildChildExtension();
    const bootstrap = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "bootstrap",
        body: {
          mode: "ordinary",
          agentName: "shuttle",
          composedPrompt: "You are Shuttle, a delegated specialist.",
          models: [],
          effectiveToolPolicy: {
            read: "allow",
            write: "ask",
            execute: "deny",
            delegate: "deny",
            network: "deny",
          },
          correlationId: "child-1",
          context: {
            parentAgentName: "loom",
            parentDepth: 0,
            cwd: "/project",
          },
          // `execute` is denied and `bash` (the only tool this fake host
          // discovers) maps to `execute`, so the exact valid active-tool
          // set for this policy is empty (Spec 33 §11.2 Task 9).
          activeTools: [],
        },
      },
      secretBytes,
      hmacPort,
    );
    await deliverEnvelope(
      host,
      bootstrap._unsafeUnwrap() as unknown as JsonValue,
    );
    await flush();

    const appended = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(appended).toEqual({
      systemPrompt: expect.stringContaining("Shuttle"),
    } as never);
    expect((appended as { systemPrompt: string }).systemPrompt).toContain(
      "You are Shuttle, a delegated specialist.",
    );

    const secondAppend = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(secondAppend).toBeUndefined();

    const blocked = await host.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "rm -rf /" },
      },
      fakeCtx(),
    );
    expect(blocked).toEqual({
      block: true,
      reason: expect.any(String),
    } as never);
  });

  it("reports settlement exactly once via an authenticated envelope on agent_settled", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();
    const settled = output.lines.at(-1);
    expect(settled?.kind).toBe("settled");
    expect((settled?.body as Record<string, unknown>).outcome).toBe(
      "completed",
    );
  });

  it("never sends a duplicate settled envelope if agent_settled fires more than once", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();
    const settledLinesAfterFirst = output.lines.filter(
      (line) => line.kind === "settled",
    ).length;
    expect(settledLinesAfterFirst).toBe(1);

    await host.fire("agent_settled", {}, fakeCtx());
    await flush();
    const settledLinesAfterSecond = output.lines.filter(
      (line) => line.kind === "settled",
    ).length;
    expect(settledLinesAfterSecond).toBe(1);
  });

  it("reports the child's real streamed assistant text as the settlement summary, never the old constant placeholder (Task 9 finding 1)", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_update",
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Here is the ",
        },
      },
      fakeCtx(),
    );
    await host.fire(
      "message_update",
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "real result." },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    expect(settled?.kind).toBe("settled");
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
    expect(body.summary).toBe("Here is the real result.");
    expect(body.summary).not.toBe("delegated task settled");
  });

  it("reports a safe fixed fallback summary (not the old constant) when a completed turn produced no observable assistant text", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
    expect(typeof body.summary).toBe("string");
    expect(body.summary).not.toBe("delegated task settled");
  });

  it("resets the settlement summary buffer on turn_start so a later turn never reports a stale earlier turn's text", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_update",
      {
        type: "message_update",
        delta: { text: "stale text from an earlier turn" },
      },
      fakeCtx(),
    );
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await host.fire(
      "message_update",
      { type: "message_update", delta: { text: "fresh turn text" } },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    const body = settled?.body as Record<string, unknown>;
    expect(body.summary).toBe("fresh turn text");
    expect(body.summary).not.toContain("stale text");
  });

  it("derives a failed outcome from the last observed assistant stopReason, since agent_settled itself carries no payload (Task 9 finding 2)", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: { role: "assistant", id: "m1", stopReason: "error" },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    expect(settled?.kind).toBe("settled");
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("failed");
  });

  it("treats an aborted stopReason the same as an error stopReason", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: { role: "assistant", id: "m1", stopReason: "aborted" },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const body = output.lines.at(-1)?.body as Record<string, unknown>;
    expect(body.outcome).toBe("failed");
  });

  it("still reports completed for an ordinary stop reason", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: { role: "assistant", id: "m1", stopReason: "stop" },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const body = output.lines.at(-1)?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
  });

  it("never reports completed after cancellation has already been admitted - no race to a stray completed settlement (Task 9 finding 2)", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    const cancelEnvelope = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "cancel",
        body: { reason: "cancelled-by-parent" },
      },
      secretBytes,
      hmacPort,
    );
    await deliverEnvelope(
      host,
      cancelEnvelope._unsafeUnwrap() as unknown as JsonValue,
    );
    await flush();
    expect(output.lines.some((line) => line.kind === "cancelled")).toBe(true);

    // A stray agent_settled arriving after cancellation was already admitted
    // (e.g. the underlying run finishes tearing down just after the parent's
    // cancel envelope was processed) must never send a second, competing
    // terminal report.
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    expect(output.lines.some((line) => line.kind === "settled")).toBe(false);
    const cancelledLines = output.lines.filter(
      (line) => line.kind === "cancelled",
    );
    expect(cancelledLines).toHaveLength(1);
  });

  it("calls the real setActiveTools() with exactly the parent-derived active-tool list before acking, and the ack echoes the same set", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    host.toolsInventory = [
      {
        name: "bash",
        sourceInfo: {
          path: "<builtin:bash>",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      },
      {
        name: "read",
        sourceInfo: {
          path: "<builtin:read>",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      },
    ];
    const envelope = await signedBootstrap(secretBytes, {
      effectiveToolPolicy: {
        read: "allow",
        write: "deny",
        execute: "deny",
        delegate: "deny",
        network: "deny",
      },
      activeTools: ["read"],
    });
    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.setActiveToolsCalls).toEqual([["read"]]);
    expect(host.getActiveTools()).toEqual(["read"]);
    const ack = output.lines.find((line) => line.kind === "bootstrap-ack");
    expect(ack).toBeDefined();
    expect((ack?.body as Record<string, unknown>).activeTools).toEqual([
      "read",
    ]);
  });

  it("fails closed (no setActiveTools call, no ack, prompt never applied) when the bootstrap names a tool the child cannot verify as governed", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    const envelope = await signedBootstrap(secretBytes, {
      // A real, activatable policy is required so the failure below is
      // provably the unknown-tool-name gate and not an unrelated
      // activation failure caused by an absent policy.
      effectiveToolPolicy: {
        read: "allow",
        write: "deny",
        execute: "deny",
        delegate: "deny",
        network: "deny",
      },
      activeTools: ["nonexistent-tool"],
    });
    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.setActiveToolsCalls).toEqual([]);
    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      false,
    );
    const appended = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(appended).toBeUndefined();
  });

  it("rehydrates a compact parent model identity to the full child catalog object before setModel, then keeps the ack compact", async () => {
    const catalogModel = {
      provider: "anthropic",
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 1_000_000,
    };
    const sessionCtx = fakeCtx({
      modelRegistry: { getAvailable: () => [catalogModel] },
    });
    const { host, output, secretBytes } = await buildChildExtension(sessionCtx);
    const envelope = await signedBootstrap(secretBytes, {
      effectiveToolPolicy: {
        read: "allow",
        write: "deny",
        execute: "deny",
        delegate: "deny",
        network: "deny",
      },
      resolvedModel: {
        provider: catalogModel.provider,
        id: catalogModel.id,
        name: catalogModel.name,
      },
    });

    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.setModelCalls).toEqual([catalogModel]);
    expect(host.setModelCalls[0]).toBe(catalogModel);
    const ack = output.lines.find((line) => line.kind === "bootstrap-ack");
    expect((ack?.body as Record<string, unknown>).resolvedModel).toEqual({
      provider: catalogModel.provider,
      id: catalogModel.id,
      name: catalogModel.name,
    });
    expect(
      (ack?.body as { resolvedModel: Record<string, unknown> }).resolvedModel,
    ).not.toHaveProperty("baseUrl");
  });

  it("fails closed (no ack, no work applied) when the host rejects the resolved model, even though tools already applied cleanly", async () => {
    const sessionCtx = fakeCtx({
      modelRegistry: {
        getAvailable: () => [
          { provider: "fake", id: "model-x", name: "Fake Model X" },
        ],
      },
    });
    const { host, output, secretBytes } = await buildChildExtension(sessionCtx);
    host.modelAccepted = false;
    const envelope = await signedBootstrap(secretBytes, {
      effectiveToolPolicy: {
        read: "allow",
        write: "deny",
        execute: "deny",
        delegate: "deny",
        network: "deny",
      },
      models: ["fake/model-x"],
    });
    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.setModelCalls.length).toBe(1);
    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      false,
    );
    const appended = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(appended).toBeUndefined();
  });

  it("rejects (no ack, dispose) a bootstrap whose context.cwd exceeds the bounded control-schema limit", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    const envelope = await signedBootstrap(secretBytes, {
      context: {
        parentAgentName: "loom",
        parentDepth: 0,
        cwd: "/".repeat(MAX_CWD_LENGTH + 1),
      },
    });
    await deliverEnvelope(host, envelope);
    await flush();

    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      false,
    );
    const appended = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(appended).toBeUndefined();
  });

  it("rejects (no ack, dispose) a bootstrap whose correlationId does not match this child's own authenticated identity", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    const envelope = await signedBootstrap(secretBytes, {
      correlationId: "some-other-child",
    });
    await deliverEnvelope(host, envelope);
    await flush();

    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      false,
    );
    expect(host.setActiveToolsCalls).toEqual([]);
    const appended = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(appended).toBeUndefined();
  });
});

describe("classifyApprovalRelayFailureCause (Task 9 finding 3)", () => {
  it("classifies a thrown Error as 'thrown-error', never the raw message", () => {
    expect(
      classifyApprovalRelayFailureCause(new Error("/secret/path leaked")),
    ).toBe("thrown-error");
  });

  it("classifies any non-Error rejection as 'rejected-non-error'", () => {
    expect(classifyApprovalRelayFailureCause("a raw string cause")).toBe(
      "rejected-non-error",
    );
    expect(classifyApprovalRelayFailureCause(undefined)).toBe(
      "rejected-non-error",
    );
    expect(classifyApprovalRelayFailureCause({ some: "object" })).toBe(
      "rejected-non-error",
    );
  });
});

describe("cloneApprovalPromptRequestAsJson (Task 9 finding 3)", () => {
  it("builds an explicit typed clone with every field preserved", () => {
    const clone = cloneApprovalPromptRequestAsJson({
      agentName: "shuttle (child child-1)",
      toolIdentity: "bash",
      requests: [
        { summary: "allow bash?", details: "rm -rf /tmp/x", unresolved: false },
      ],
      allowedScopes: ["once", "session"],
    });
    expect(clone).toEqual({
      agentName: "shuttle (child child-1)",
      toolIdentity: "bash",
      requests: [
        { summary: "allow bash?", details: "rm -rf /tmp/x", unresolved: false },
      ],
      allowedScopes: ["once", "session"],
    });
  });

  it("omits an absent optional 'details' field rather than writing it as undefined", () => {
    const clone = cloneApprovalPromptRequestAsJson({
      agentName: "shuttle",
      toolIdentity: "bash",
      requests: [{ summary: "allow bash?", unresolved: true }],
      allowedScopes: ["once"],
    });
    const requests = (clone as { requests: unknown[] }).requests;
    expect(requests[0]).toEqual({ summary: "allow bash?", unresolved: true });
    expect(Object.hasOwn(requests[0] as object, "details")).toBe(false);
  });

  it("never throws for a well-formed request, unlike JSON.parse(JSON.stringify(...))", () => {
    expect(() =>
      cloneApprovalPromptRequestAsJson({
        agentName: "shuttle",
        toolIdentity: "bash",
        requests: [{ summary: "allow?", unresolved: false }],
        allowedScopes: ["once"],
      }),
    ).not.toThrow();
  });
});
