import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
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
  ChunkTransferAssembler,
  type TransferChunk,
} from "../child-transfer.js";
import { PI_TRANSPORT_LIMITS } from "../errors.js";
import {
  buildChildBootstrapBody,
  createPiExtension,
  type PiExtensionDeps,
} from "../extension.js";
import { canonicalizeToBytes, type JsonValue } from "../strict-json.js";
import { WEAVE_COMPLETE_STEP_TOOL_NAME } from "../structured-completion.js";
import type {
  PiCommandRegistration,
  PiEnvPort,
  PiEventHandler,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiToolRegistration,
} from "../types.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";

/**
 * Layer C, private-child variant: exercises `createPiExtension()`'s real
 * `piAdapterExtension` function end-to-end against a minimal hand-built
 * `PiExtensionApi` fake, with a scripted bootstrap secret delivered only
 * through the environment (never argv/prompt), proving the whole spawned
 * `pi --mode rpc --no-session` child path - handshake detection, hidden
 * control-command wiring, bootstrap application, Weave tool registration,
 * and settlement reporting without ever starting a real Pi process.
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
  private nextError:
    | { type: "ChildOutputWriteFailed"; reason: string }
    | undefined;
  failWritesRemaining = 0;
  writeAttempts = 0;

  failNextWrite(reason: string): void {
    this.nextError = { type: "ChildOutputWriteFailed", reason };
  }

  writeLine(
    bytes: Uint8Array,
  ): ResultAsync<void, { type: "ChildOutputWriteFailed"; reason: string }> {
    this.writeAttempts += 1;
    if (this.nextError !== undefined || this.failWritesRemaining > 0) {
      const error = this.nextError ?? {
        type: "ChildOutputWriteFailed" as const,
        reason: "scripted-output-write-failure",
      };
      this.nextError = undefined;
      this.failWritesRemaining = Math.max(0, this.failWritesRemaining - 1);
      return errAsync(error);
    }
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
  on(event: string, handler: PiEventHandler): void {
    const existing = this.events.get(event) ?? [];
    existing.push(handler);
    this.events.set(event, existing);
  }
  sendUserMessage(_content: string): void {}
  appendEntry(_type: string, _data: unknown): void {}
  getActiveTools(): readonly string[] {
    return [];
  }
  setActiveTools(_names: readonly string[]): void {}
  sendMessage(
    _message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    _options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
  ): void {}
  /** Every `registerTool()` call, in order. */
  readonly registerToolCalls: PiToolRegistration[] = [];
  registerTool(tool: PiToolRegistration): void {
    this.registerToolCalls.push(tool);
  }
  /** Looks up a registered tool's own `execute()` by name, for a test to invoke directly. */
  registeredTool(name: string): PiToolRegistration | undefined {
    return this.registerToolCalls.find((t) => t.name === name);
  }
  /** Set to `false` to simulate the host declining a `setModel()` call. */
  modelAccepted = true;
  readonly setModelCalls: PiModelInfo[] = [];
  readonly activationCalls: (
    | { readonly kind: "model"; readonly model: PiModelInfo }
    | { readonly kind: "thinking"; readonly level: string }
  )[] = [];
  thinkingLevelBehavior: "accept" | "throw" | "reject" = "accept";
  setModel(model: PiModelInfo): boolean {
    this.setModelCalls.push(model);
    this.activationCalls.push({ kind: "model", model });
    return this.modelAccepted;
  }
  setThinkingLevel(level: string): void | Promise<void> {
    this.activationCalls.push({ kind: "thinking", level });
    if (this.thinkingLevelBehavior === "throw") {
      throw new Error("simulated child thinking-level host failure");
    }
    if (this.thinkingLevelBehavior === "reject") {
      return Promise.reject(
        new Error("simulated child thinking-level rejection"),
      );
    }
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
    isIdle: () => true,
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

async function buildChildExtension(
  sessionCtx: PiSessionContext = fakeCtx(),
  overrides: Partial<PiExtensionDeps> = {},
) {
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
    ...overrides,
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
        ...bodyOverrides,
      },
    },
    secretBytes,
    hmacPort,
  );
  return envelope._unsafeUnwrap() as unknown as JsonValue;
}

describe("private child mode (Pi adapter contract, end-to-end against a fake host)", () => {
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

  it("an ordinary (non-direct-step) child never registers weave_complete_step and gains no completion authority even when it names the exact tool", async () => {
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
          composedPrompt: "You are Shuttle, a nested delegated specialist.",
          models: [],
          correlationId: "child-1",
          context: {
            parentAgentName: "shuttle",
            parentDepth: 1,
            cwd: "/project",
          },
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

    // Only a direct-step bootstrap ever registers weave_complete_step -
    // an ordinary/nested child never receives it (Pi adapter contract).
    expect(host.registeredTool(WEAVE_COMPLETE_STEP_TOOL_NAME)).toBeUndefined();

    // A call naming that exact tool anyway is not a Weave-owned control
    // channel for this child - it is unmanaged, never specially allowed.
    const outcome = await host.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tc-fake-complete",
        toolName: WEAVE_COMPLETE_STEP_TOOL_NAME,
        input: { outcome: "success" },
      },
      fakeCtx(),
    );
    expect(outcome).toBeUndefined();
    expect(host.registerToolCalls).toHaveLength(0);
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

  it("retries settlement once after a failed output write without leaving a sequence gap", async () => {
    const { host, output } = await buildChildExtension();
    output.failNextWrite("stdout-write-failed");

    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.filter((line) => line.kind === "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.sequence).toBe(2);
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

  it("reports the child's real streamed assistant text as the settlement summary, never the old constant placeholder (Task 9)", async () => {
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
    expect(body.assistantOutput).toBe("Here is the real result.");
    expect(body.assistantOutput).not.toBe("delegated task settled");
  });

  it("transfers large final output before settlement and projects only bounded text plus numeric metadata", async () => {
    const { host, output, secretBytes } = await buildChildExtension();
    const sentinel = "UNIQUE_TERMINAL_SENTINEL";
    const fullOutput = `${"x".repeat(12_000)}${sentinel}`;
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "large-output",
          stopReason: "stop",
          content: [{ type: "text", text: fullOutput }],
        },
      },
      fakeCtx(),
    );

    const settlementPending = host.fire("agent_settled", {}, fakeCtx());
    await flush();
    const chunks = output.lines.filter(
      (line) => line.kind === "transfer-chunk",
    );
    expect(chunks.length).toBeGreaterThan(0);

    const assembler = new ChunkTransferAssembler();
    let reassembled: string | undefined;
    let transferId = "";
    for (const line of chunks) {
      const body = line.body as unknown as TransferChunk;
      transferId = body.transferId;
      const accepted = assembler.accept(body);
      expect(accepted.isOk()).toBe(true);
      if (accepted.isOk() && accepted.value !== undefined) {
        reassembled = accepted.value;
      }
    }
    expect(reassembled).toBe(fullOutput);
    expect(reassembled?.endsWith(sentinel)).toBe(true);

    const ack = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: transferId,
        kind: "transfer-result",
        body: { channel: "output", transferId, status: "ack" },
      },
      secretBytes,
      hmacPort,
    );
    expect(ack.isOk()).toBe(true);
    if (ack.isErr()) return;
    await deliverEnvelope(host, ack.value as unknown as JsonValue);
    await settlementPending;
    await flush();

    const settled = output.lines.find((line) => line.kind === "settled");
    const body = settled?.body as Record<string, unknown>;
    expect(body.outputTransferId).toBe(transferId);
    expect(body.outputByteLength).toBe(
      new TextEncoder().encode(fullOutput).byteLength,
    );
    expect(
      new TextEncoder().encode(String(body.assistantOutput)).byteLength,
    ).toBeLessThanOrEqual(PI_TRANSPORT_LIMITS.parentProjectionBytes);
  });

  it("degrades a failed output transfer to bounded inline settlement after one retry", async () => {
    const { host, output } = await buildChildExtension();
    const fullOutput = "z".repeat(12_000);
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: fullOutput }],
        },
      },
      fakeCtx(),
    );

    const attemptsBeforeTransfer = output.writeAttempts;
    // Fail the first chunk write on both attempts. Each failed authenticated
    // send releases sequence 2, so the fallback settlement must reuse it.
    output.failWritesRemaining = 2;
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    expect(output.writeAttempts - attemptsBeforeTransfer).toBe(3);
    const settled = output.lines.find((line) => line.kind === "settled");
    const body = settled?.body as Record<string, unknown>;
    expect(body.outputTransferId).toBeUndefined();
    expect(body.outputByteLength).toBe(12_000);
    expect(
      new TextEncoder().encode(String(body.assistantOutput)).byteLength,
    ).toBeLessThanOrEqual(PI_TRANSPORT_LIMITS.parentProjectionBytes);
  });

  it("reports a safe fixed fallback summary (not the old constant) when a completed turn produced no observable assistant text", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
    expect(typeof body.assistantOutput).toBe("string");
    expect(body.assistantOutput).not.toBe("delegated task settled");
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
    expect(body.assistantOutput).toBe("fresh turn text");
    expect(body.assistantOutput).not.toContain("stale text");
  });

  it("derives a failed outcome from the last observed assistant stopReason, since agent_settled itself carries no payload (Task 9)", async () => {
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

  it("never reports completed after cancellation has already been admitted - no race to a stray completed settlement (Task 9)", async () => {
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

  it("omits an unresolved ordinary parent model before signing so the child resolves locally", async () => {
    const catalogModel = {
      provider: "fake",
      id: "model-x",
      name: "Fake Model X",
      api: "fake-api",
    };
    const targetDescriptor = {
      name: "shuttle",
      composedPrompt: "You are Shuttle, a delegated specialist.",
      models: ["fake/model-x"],
      mode: "subagent" as const,
      effectiveToolPolicy: {
        read: "allow" as const,
        write: "allow" as const,
        execute: "allow" as const,
        delegate: "allow" as const,
        network: "ask" as const,
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    };
    const bootstrapBody = buildChildBootstrapBody(
      new Map([[targetDescriptor.name, targetDescriptor]]),
      {
        name: targetDescriptor.name,
        description: "A delegated specialist.",
        triggers: [],
        isCategory: false,
      },
      "child-1",
      { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
      fakeCtx({ modelRegistry: { getAvailable: () => [] } }),
    );
    const bootstrapRecord = bootstrapBody as unknown as Record<string, unknown>;

    expect(bootstrapRecord).not.toHaveProperty("resolvedModel");
    expect(canonicalizeToBytes(bootstrapBody).isOk()).toBe(true);

    const { host, output, secretBytes } = await buildChildExtension(
      fakeCtx({ modelRegistry: { getAvailable: () => [catalogModel] } }),
    );
    const envelope = await signedBootstrap(secretBytes, bootstrapRecord);

    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.setModelCalls).toEqual([catalogModel]);
    const ack = output.lines.find((line) => line.kind === "bootstrap-ack");
    expect((ack?.body as Record<string, unknown>).resolvedModel).toEqual({
      provider: catalogModel.provider,
      id: catalogModel.id,
      name: catalogModel.name,
    });
  });

  it("applies transported thinking intent after ordinary child model activation", async () => {
    const catalogModel = {
      provider: "fake",
      id: "model-x",
      name: "Fake Model X",
      api: "fake-api",
    };
    const { host, output, secretBytes } = await buildChildExtension(
      fakeCtx({ modelRegistry: { getAvailable: () => [catalogModel] } }),
    );
    const envelope = await signedBootstrap(secretBytes, {
      models: ["fake/model-x#high"],
      resolvedModel: {
        provider: catalogModel.provider,
        id: catalogModel.id,
        name: catalogModel.name,
      },
      thinkingLevel: "high",
    });

    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "high" },
    ]);
    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      true,
    );
  });

  it("applies transported thinking intent after direct-step child model activation", async () => {
    const catalogModel = {
      provider: "fake",
      id: "model-x",
      name: "Fake Model X",
      api: "fake-api",
    };
    const { host, output, secretBytes } = await buildChildExtension(
      fakeCtx({ modelRegistry: { getAvailable: () => [catalogModel] } }),
    );
    const envelope = await signedBootstrap(secretBytes, {
      mode: "direct-step",
      workflowInstanceId: "workflow-1",
      leaseId: "lease-1",
      stepName: "review",
      models: ["fake/model-x#medium"],
      resolvedModel: {
        provider: catalogModel.provider,
        id: catalogModel.id,
        name: catalogModel.name,
      },
      thinkingLevel: "medium",
      completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
    });

    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "medium" },
    ]);
    expect(host.registeredTool(WEAVE_COMPLETE_STEP_TOOL_NAME)).toBeDefined();
    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      true,
    );
  });

  it("does not call the thinking host for a child bootstrap without a thinking level", async () => {
    const catalogModel = {
      provider: "fake",
      id: "model-x",
      name: "Fake Model X",
      api: "fake-api",
    };
    const { host, secretBytes } = await buildChildExtension(
      fakeCtx({ modelRegistry: { getAvailable: () => [catalogModel] } }),
    );
    const envelope = await signedBootstrap(secretBytes, {
      models: ["fake/model-x"],
      resolvedModel: {
        provider: catalogModel.provider,
        id: catalogModel.id,
        name: catalogModel.name,
      },
    });

    await deliverEnvelope(host, envelope);
    await flush();

    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
    ]);
  });

  it.each([
    "throw",
    "reject",
  ] as const)("keeps child model activation successful when the thinking host %s", async (behavior) => {
    const catalogModel = {
      provider: "fake",
      id: "model-x",
      name: "Fake Model X",
      api: "fake-api",
    };
    const { host, output, secretBytes } = await buildChildExtension(
      fakeCtx({ modelRegistry: { getAvailable: () => [catalogModel] } }),
    );
    host.thinkingLevelBehavior = behavior;
    const envelope = await signedBootstrap(secretBytes, {
      models: ["fake/model-x#low"],
      resolvedModel: {
        provider: catalogModel.provider,
        id: catalogModel.id,
        name: catalogModel.name,
      },
      thinkingLevel: "low",
    });

    await expect(deliverEnvelope(host, envelope)).resolves.toBeUndefined();
    await flush();

    expect(host.activationCalls).toEqual([
      { kind: "model", model: catalogModel },
      { kind: "thinking", level: "low" },
    ]);
    expect(output.lines.some((line) => line.kind === "bootstrap-ack")).toBe(
      true,
    );
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
    const appended = await host.fire(
      "before_agent_start",
      { systemPrompt: "base prompt" },
      fakeCtx(),
    );
    expect(appended).toBeUndefined();
  });
});
