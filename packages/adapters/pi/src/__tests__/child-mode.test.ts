import { describe, expect, it } from "bun:test";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
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
import type {
  PiChildOutputError,
  PiChildOutputWrite,
} from "../child-runtime.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  ChunkTransferAssembler,
  type TransferChunk,
} from "../child-transfer.js";
import { PI_TRANSPORT_LIMITS } from "../errors.js";
import {
  buildChildBootstrapBody,
  createPiExtension,
  type PiExtensionDeps,
} from "../extension-impl.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceReader,
} from "../host-inventory.js";
import { canonicalizeToBytes, type JsonValue } from "../strict-json.js";
import {
  serializeCompletionCandidate,
  WEAVE_COMPLETE_STEP_TOOL_NAME,
} from "../structured-completion.js";
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
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

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
  onLine: ((line: Record<string, unknown>) => void) | undefined;
  private nextError: PiChildOutputError | undefined;
  private readonly deferredWrites: Array<{
    readonly settle: (result: Result<void, PiChildOutputError>) => void;
    readonly bytes: Uint8Array;
    cancelled: boolean;
    committed: boolean;
  }> = [];
  failWritesRemaining = 0;
  deferWritesRemaining = 0;
  deferModelTransitionWrites = false;
  writeAttempts = 0;

  failNextWrite(reason: string): void {
    this.nextError = { type: "ChildOutputWriteFailed", reason };
  }

  deferNextWrite(): void {
    this.deferWritesRemaining += 1;
  }

  pendingDeferredWrites(): number {
    return this.deferredWrites.length;
  }

  settleDeferredWrite(
    outcome: "resolve" | "reject",
    reason = "late-output-write-failure",
  ): void {
    const deferred = this.deferredWrites.shift();
    if (deferred === undefined) throw new Error("no deferred write pending");
    if (outcome === "resolve") {
      deferred.settle(ok(undefined));
      return;
    }
    deferred.settle(err({ type: "ChildOutputWriteFailed", reason }));
  }

  private record(bytes: Uint8Array): void {
    for (const line of new TextDecoder().decode(bytes).split("\n")) {
      if (line.length > 0) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        this.onLine?.(parsed);
        this.lines.push(parsed);
      }
    }
  }

  writeLine(bytes: Uint8Array): PiChildOutputWrite {
    this.writeAttempts += 1;
    if (this.nextError !== undefined || this.failWritesRemaining > 0) {
      const error = this.nextError ?? {
        type: "ChildOutputWriteFailed" as const,
        reason: "scripted-output-write-failure",
      };
      this.nextError = undefined;
      this.failWritesRemaining = Math.max(0, this.failWritesRemaining - 1);
      return { result: errAsync(error), cancel: () => "cancelled" };
    }
    const firstLine = new TextDecoder().decode(bytes).split("\n")[0];
    const kind =
      firstLine === undefined || firstLine.length === 0
        ? undefined
        : (JSON.parse(firstLine) as { readonly kind?: unknown }).kind;
    if (
      this.deferWritesRemaining > 0 ||
      (this.deferModelTransitionWrites && kind === "model-transition")
    ) {
      if (this.deferWritesRemaining > 0) this.deferWritesRemaining -= 1;
      let settled = false;
      let settle!: (result: Result<void, PiChildOutputError>) => void;
      const pending = new Promise<Result<void, PiChildOutputError>>(
        (resolve) => {
          settle = resolve;
        },
      );
      const entry: {
        readonly settle: (result: Result<void, PiChildOutputError>) => void;
        readonly bytes: Uint8Array;
        cancelled: boolean;
        committed: boolean;
      } = {
        settle: (result) => {
          if (settled) return;
          settled = true;
          if (!entry.cancelled && result.isOk()) {
            entry.committed = true;
            this.record(bytes);
          }
          settle(result);
        },
        bytes,
        cancelled: false,
        committed: false,
      };
      const cancel = (): "cancelled" | "committed" => {
        if (entry.committed) return "committed";
        if (settled) return "cancelled";
        entry.cancelled = true;
        settled = true;
        settle(
          err({
            type: "ChildOutputWriteCancelled",
            reason: "output-write-cancelled",
          }),
        );
        return "cancelled";
      };
      this.deferredWrites.push(entry);
      return { result: new ResultAsync(pending), cancel };
    }
    this.record(bytes);
    return { result: okAsync(undefined), cancel: () => "committed" };
  }
}

class MinimalFakeHost implements PiExtensionApi {
  readonly commands = new Map<string, PiCommandRegistration>();
  readonly events = new Map<string, PiEventHandler[]>();
  /** Raw context handler results, for asserting the public Pi envelope. */
  readonly contextResults: unknown[] = [];
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
  readonly appendedEntries: {
    readonly type: string;
    readonly data: unknown;
  }[] = [];
  appendEntry(type: string, data: unknown): void {
    this.appendedEntries.push({ type, data });
  }
  getActiveTools(): readonly string[] {
    return [];
  }
  setActiveTools(_names: readonly string[]): void {}
  readonly sentMessages: {
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
    readonly details?: unknown;
  }[] = [];
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    _options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
  ): void {
    this.sentMessages.push(message);
  }
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
  private nextSetModelDeferred:
    | {
        readonly called: () => void;
        readonly result: Promise<boolean>;
      }
    | undefined;
  thinkingLevelBehavior: "accept" | "throw" | "reject" = "accept";
  deferNextSetModel(): {
    called: Promise<void>;
    settle: (succeeded: boolean) => void;
  } {
    let resolveCalled!: () => void;
    let resolveResult!: (succeeded: boolean) => void;
    const called = new Promise<void>((resolve) => {
      resolveCalled = resolve;
    });
    const result = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });
    this.nextSetModelDeferred = {
      called: resolveCalled,
      result,
    };
    return { called, settle: resolveResult };
  }
  async setModel(model: PiModelInfo): Promise<boolean> {
    this.setModelCalls.push(model);
    this.activationCalls.push({ kind: "model", model });
    const deferred = this.nextSetModelDeferred;
    this.nextSetModelDeferred = undefined;
    if (deferred !== undefined) {
      deferred.called();
      return await deferred.result;
    }
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
    if (event === "context") {
      let initialMessages: unknown;
      if (Array.isArray(payload)) {
        initialMessages = payload;
      } else if (typeof payload === "object" && payload !== null) {
        initialMessages = (payload as { readonly messages?: unknown }).messages;
      }
      let currentMessages = Array.isArray(initialMessages)
        ? initialMessages
        : [];
      for (const handler of handlers) {
        const outcome = await handler(
          { type: "context", messages: currentMessages },
          ctx,
        );
        this.contextResults.push(outcome);
        const replacement =
          typeof outcome === "object" &&
          outcome !== null &&
          "messages" in outcome
            ? (outcome as { readonly messages?: unknown }).messages
            : undefined;
        // Pi's runner consumes only result?.messages. Raw arrays and other
        // result shapes do not become the next provider context.
        if (Array.isArray(replacement)) currentMessages = replacement;
      }
      return currentMessages;
    }

    let result: unknown;
    for (const handler of handlers) {
      const outcome = await handler(payload, ctx);
      if (outcome !== undefined) result = outcome;
    }
    return result;
  }
}

async function waitForMicrotasks(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("test setup: timed out waiting for microtask event");
}

function waitForOutputLine(
  output: FakeOutputPort,
  predicate: (line: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const existing = output.lines.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const previous = output.onLine;
    output.onLine = (line) => {
      previous?.(line);
      if (!predicate(line)) return;
      output.onLine = previous;
      resolve(line);
    };
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Waits until `predicate` becomes true. One `flush()` is not enough for the
 * large-output transfer path: each `transfer-chunk` is HMAC-signed and queued
 * on the runtime's serialized outgoing send tail, so the first chunk can land
 * after several macrotasks. Keeps the caller's assertion intact.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("test setup: timed out waiting for asynchronous event");
    }
    await flush();
  }
}

function fakeCtx(overrides: Partial<PiSessionContext> = {}): PiSessionContext {
  return {
    mode: "rpc",
    cwd: "/project",
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: true,
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
    },
    ...overrides,
  };
}

function runtimeModelFallbackSurfaceReader(
  enabled: boolean,
): PiHostSurfaceReader {
  return {
    read: () =>
      okAsync(
        PI_HOST_SURFACE_IDS.map((surfaceId) => ({
          surfaceId,
          status:
            surfaceId === "runtime-model-fallback" && !enabled
              ? ("unavailable" as const)
              : ("native" as const),
          details: "test-controlled",
        })),
      ),
  };
}

/**
 * Deterministic stand-in for the child's abort/compaction settlement timer.
 * Nothing fires until a test fires it, so the bounded deferral that keeps a
 * compaction-intent abort non-terminal costs a test no wall-clock time.
 */
class ScriptedTimerPort implements TimerPort {
  private readonly scheduled: {
    callback: () => void;
    delayMs: number;
    dueMs: number;
    order: number;
    cancelled: boolean;
    fired: boolean;
  }[] = [];
  private nowMs = 0;
  private nextOrder = 0;

  schedule(callback: () => void, delayMs: number): TimerHandle {
    const entry = {
      callback,
      delayMs,
      dueMs: this.nowMs + delayMs,
      order: this.nextOrder,
      cancelled: false,
      fired: false,
    };
    this.nextOrder += 1;
    this.scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }
  pending(): readonly (typeof this.scheduled)[number][] {
    return this.scheduled.filter((entry) => !entry.cancelled && !entry.fired);
  }

  all(): readonly (typeof this.scheduled)[number][] {
    return this.scheduled;
  }

  /** Advances the injected clock and fires every due timer in stable order. */
  advanceBy(delayMs: number): void {
    if (delayMs < 0) throw new Error("fake clock cannot move backwards");
    this.nowMs += delayMs;
    this.fireDue();
  }

  private fireDue(): void {
    for (;;) {
      const entry = this.pending()
        .filter((candidate) => candidate.dueMs <= this.nowMs)
        .sort(
          (left, right) => left.dueMs - right.dueMs || left.order - right.order,
        )[0];
      if (entry === undefined) return;
      entry.fired = true;
      entry.callback();
    }
  }

  fireDelay(delayMs: number): void {
    const entry = this.pending().find(
      (candidate) => candidate.delayMs === delayMs,
    );
    if (entry === undefined)
      throw new Error(`no timer scheduled for ${delayMs}`);
    entry.fired = true;
    entry.callback();
  }

  /** Fires every live timer once, in scheduling order. */
  fireAll(): void {
    for (const entry of [...this.scheduled]) {
      if (entry.cancelled || entry.fired) continue;
      entry.fired = true;
      entry.callback();
    }
  }
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
  const timers = new ScriptedTimerPort();
  const factory = createPiExtension({
    envPort: env,
    randomPort,
    hmacPort,
    processPort: new FakeChildProcessPort(),
    childOutputPort: output,
    childTimerPort: timers,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    ...overrides,
  });
  factory(host);
  // The hidden `weave:__control__` command handler only takes `rawArgs`.
  // Bootstrap uses the latest lifecycle context, initialized from
  // `session_start`, rather than the per-invocation context passed to this
  // command. Tests that need a specific `ctx.modelRegistry`/`ctx.model` must
  // supply it here.
  await host.fire("session_start", {}, sessionCtx);
  return { host, output, secretBytes, timers };
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

async function beginFallbackAppliedTransition() {
  const origin: PiModelInfo = {
    provider: "origin",
    id: "first",
    name: "First",
  };
  const fallback: PiModelInfo = {
    provider: "fallback",
    id: "second",
    name: "Second",
  };
  const recoveryCtx = fakeCtx({
    model: origin,
    modelRegistry: { getAvailable: () => [origin, fallback] },
    hasPendingMessages: () => false,
  });
  const built = await buildChildExtension(recoveryCtx);
  await deliverEnvelope(
    built.host,
    await signedBootstrap(built.secretBytes, {
      models: ["origin/first", "fallback/second"],
    }),
    recoveryCtx,
  );
  const failedMessage = {
    role: "assistant",
    id: "hung-applied-transition",
    stopReason: "error",
    error: { status: 503, message: "provider unavailable" },
    content: [{ type: "text", text: "retained failure" }],
  } as const;
  const deferred = built.host.deferNextSetModel();
  await built.host.fire(
    "message_end",
    { type: "message_end", message: failedMessage },
    recoveryCtx,
  );
  const fallbackSettlement = built.host.fire(
    "agent_settled",
    { type: "agent_settled" },
    recoveryCtx,
  );
  await deferred.called;
  await built.host.fire(
    "model_select",
    { type: "model_select", model: fallback },
    recoveryCtx,
  );
  return { ...built, recoveryCtx, deferred, fallbackSettlement };
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
      sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    expect(
      host.registerToolCalls.some(
        (tool) => tool.name === WEAVE_COMPLETE_STEP_TOOL_NAME,
      ),
    ).toBe(false);
    expect(host.registerToolCalls.map((tool) => tool.name)).toEqual([
      "weave_delegate",
    ]);
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

  it("keeps a child fallback epoch open through exact marker/context recovery and settles the fallback output once", async () => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: { getAvailable: () => [origin, fallback] },
      hasPendingMessages: () => false,
    });
    const { host, output, secretBytes } =
      await buildChildExtension(recoveryCtx);
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        models: ["origin/first", "fallback/second"],
      }),
      recoveryCtx,
    );

    // The failed assistant is retained as the coordinator fingerprint, not
    // copied into the later fallback result.
    const failedMessage = {
      role: "assistant",
      id: "failed-assistant",
      stopReason: "error",
      error: { status: 429, message: "rate limited" },
      content: [{ type: "text", text: "partial failed output" }],
    } as const;
    const deferred = host.deferNextSetModel();
    await host.fire(
      "message_end",
      { type: "message_end", message: failedMessage },
      recoveryCtx,
    );
    const fallbackSettlement = host.fire(
      "agent_settled",
      { type: "agent_settled" },
      recoveryCtx,
    );
    await deferred.called;
    expect(host.setModelCalls.at(-1)?.id).toBe("second");

    // Prove the native model event while the asynchronous setModel result is
    // still unresolved. The marker cannot be emitted until both proofs arrive.
    await host.fire(
      "model_select",
      { type: "model_select", model: fallback },
      recoveryCtx,
    );
    deferred.settle(true);
    await fallbackSettlement;
    await waitForMicrotasks(() => host.sentMessages.length === 1);
    const marker = host.sentMessages[0];
    expect(marker?.customType).toBe("weave.model-fallback.recovery-marker");

    await waitFor(
      () =>
        output.lines.filter((line) => line.kind === "model-transition")
          .length === 1,
    );
    const appliedLine = output.lines.find(
      (line) => line.kind === "model-transition",
    );
    const appliedBody = appliedLine?.body as Record<string, unknown>;
    expect(appliedBody).toMatchObject({
      phase: "applied",
      transitionId: expect.any(String),
      from: { provider: origin.provider, id: origin.id },
      to: { provider: fallback.provider, id: fallback.id },
    });
    expect(JSON.stringify(appliedBody)).not.toContain("partial failed output");
    expect(JSON.stringify(appliedBody)).not.toContain("rate limited");
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      0,
    );

    const durableHistory: unknown[] = [failedMessage, marker];
    await host.fire(
      "message_start",
      { type: "message_start", message: marker },
      recoveryCtx,
    );
    const userMessage = { role: "user", content: "keep this history" };
    const providerInput = [userMessage, failedMessage, marker];
    const trustedContextInputs: Array<readonly unknown[]> = [];
    host.on("context", (event) => {
      if (typeof event !== "object" || event === null) return undefined;
      const messages = (event as { readonly messages?: unknown }).messages;
      if (!Array.isArray(messages)) return undefined;
      trustedContextInputs.push(messages);
      return undefined;
    });
    const contextResult = await host.fire(
      "context",
      providerInput,
      recoveryCtx,
    );
    await waitFor(
      () =>
        output.lines.filter((line) => line.kind === "model-transition")
          .length === 2,
    );
    const transitions = output.lines.filter(
      (line) => line.kind === "model-transition",
    );
    const recoveryBody = transitions[1]?.body as Record<string, unknown>;
    expect(recoveryBody).toMatchObject({
      phase: "recovery-confirmed",
      transitionId: appliedBody.transitionId,
      from: { provider: origin.provider, id: origin.id },
      to: { provider: fallback.provider, id: fallback.id },
    });
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      0,
    );
    expect(host.appendedEntries).toHaveLength(1);
    expect(host.appendedEntries[0]).toMatchObject({
      type: "weave.model-failover",
      data: {
        schemaVersion: 1,
        transitionId: appliedBody.transitionId,
        from: { provider: origin.provider, id: origin.id },
        to: { provider: fallback.provider, id: fallback.id },
      },
    });
    expect(contextResult).toEqual([userMessage]);
    const repairedContextResult = host.contextResults.find(
      (result) =>
        typeof result === "object" && result !== null && "messages" in result,
    );
    expect(repairedContextResult).toEqual({ messages: [userMessage] });
    expect(Object.keys(repairedContextResult as object)).toEqual(["messages"]);
    expect(trustedContextInputs).toEqual([[userMessage]]);
    expect(providerInput).toEqual([userMessage, failedMessage, marker]);
    expect(
      (contextResult as readonly unknown[]).some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { readonly role?: unknown }).role === "user" &&
          (entry as { readonly content?: unknown }).content === marker?.content,
      ),
    ).toBe(false);

    await host.fire("turn_start", { type: "turn_start" }, recoveryCtx);
    const fallbackMessage = {
      role: "assistant",
      id: "fallback-assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "fallback answer" }],
    } as const;
    await host.fire(
      "message_end",
      { type: "message_end", message: fallbackMessage },
      recoveryCtx,
    );
    durableHistory.push(fallbackMessage);
    const settledLine = waitForOutputLine(
      output,
      (line) => line.kind === "settled",
    );
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    const settled = await settledLine;
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
    expect((settled.body as Record<string, unknown>).outcome).toBe("completed");
    expect((settled.body as Record<string, unknown>).assistantOutput).toBe(
      "fallback answer",
    );
    expect(
      (settled.body as Record<string, unknown>).assistantOutput,
    ).not.toContain("partial failed output");
    expect(durableHistory).toEqual([failedMessage, marker, fallbackMessage]);

    // A delayed duplicate settlement cannot publish another child result.
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
    expect(host.appendedEntries).toHaveLength(1);
  });

  it("fails the fallback once when native history is unreadable", async () => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: { getAvailable: () => [origin, fallback] },
      hasPendingMessages: () => false,
      sessionManager: {
        getSessionId: () => "child-session",
        getSessionFile: () => "/sessions/child.jsonl",
        isPersisted: () => true,
        getEntries: () => {
          throw new Error("history is unreadable");
        },
      },
    });
    const { host, output, secretBytes } =
      await buildChildExtension(recoveryCtx);
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        models: ["origin/first", "fallback/second"],
      }),
      recoveryCtx,
    );

    const failedMessage = {
      role: "assistant",
      id: "history-unreadable-failure",
      stopReason: "error",
      error: { status: 429, message: "provider details stay private" },
      content: [{ type: "text", text: "failed output stays private" }],
    } as const;
    const deferred = host.deferNextSetModel();
    await host.fire(
      "message_end",
      { type: "message_end", message: failedMessage },
      recoveryCtx,
    );
    const fallbackSettlement = host.fire(
      "agent_settled",
      { type: "agent_settled" },
      recoveryCtx,
    );
    await deferred.called;
    await host.fire(
      "model_select",
      { type: "model_select", model: fallback },
      recoveryCtx,
    );
    deferred.settle(true);
    await fallbackSettlement;
    await waitFor(() => host.sentMessages.length === 1);
    const marker = host.sentMessages[0];
    await host.fire(
      "message_start",
      { type: "message_start", message: marker },
      recoveryCtx,
    );
    const providerContext = await host.fire(
      "context",
      [failedMessage, marker, { role: "user", content: "continue" }],
      recoveryCtx,
    );
    // A failed durable append is not recovery proof. Keep the failed attempt
    // and marker in the provider context instead of admitting a new run.
    expect(providerContext).toEqual([
      failedMessage,
      marker,
      { role: "user", content: "continue" },
    ]);
    await waitFor(() => output.lines.some((line) => line.kind === "settled"));

    const transitions = output.lines.filter(
      (line) => line.kind === "model-transition",
    );
    expect(transitions).toHaveLength(1);
    expect((transitions[0]?.body as Record<string, unknown>).phase).toBe(
      "applied",
    );
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
    expect(
      (
        output.lines.find((line) => line.kind === "settled")?.body as Record<
          string,
          unknown
        >
      ).outcome,
    ).toBe("failed");
    expect(host.setModelCalls).toEqual([origin, fallback]);
    expect(host.appendedEntries).toHaveLength(0);

    // A late recovered-turn settlement cannot turn the retained failure into
    // success or publish a second terminal result.
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
  });

  it("keeps a delayed applied-transition success live and cleans its deadline", async () => {
    const { output, timers, deferred, fallbackSettlement } =
      await beginFallbackAppliedTransition();
    const timerCountBeforeReport = timers.all().length;
    output.deferNextWrite();

    deferred.settle(true);
    await waitFor(() => output.pendingDeferredWrites() === 1);
    timers.advanceBy(4_999);
    await flush();
    expect(
      output.lines.filter((line) => line.kind === "model-transition"),
    ).toHaveLength(0);

    output.settleDeferredWrite("resolve");
    await fallbackSettlement;
    await waitFor(
      () =>
        output.lines.filter((line) => line.kind === "model-transition")
          .length === 1,
    );
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      0,
    );
    await waitFor(() =>
      timers
        .all()
        .slice(timerCountBeforeReport)
        .some((entry) => entry.cancelled),
    );
  });

  it("bounds a hung applied-transition delivery, retains one failed settlement, and ignores late writes", async () => {
    const { host, output, timers, deferred, fallbackSettlement } =
      await beginFallbackAppliedTransition();
    // Defer every model-transition write, not a fixed number of output calls.
    // The clean runtime may reject a retry immediately while an older send is
    // still in flight; a runtime with its own transport retry may start a
    // second write. The test must prove the extension deadline in both cases
    // without relying on either implementation detail.
    output.deferModelTransitionWrites = true;

    deferred.settle(true);
    await waitFor(() => output.pendingDeferredWrites() >= 1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      timers.advanceBy(5_000);
      await flush();
    }

    // The transport writer may complete after the generation-owned deadlines.
    // Resolve every retained callback as a failure; none may publish a model
    // proof or seize a second terminal outcome.
    while (output.pendingDeferredWrites() > 0) {
      output.settleDeferredWrite("reject");
    }
    await flush();
    await fallbackSettlement;
    await waitFor(() => output.lines.some((line) => line.kind === "settled"));

    const settled = output.lines.filter((line) => line.kind === "settled");
    expect(settled).toHaveLength(1);
    expect((settled[0]?.body as Record<string, unknown>).outcome).toBe(
      "failed",
    );
    expect((settled[0]?.body as Record<string, unknown>).reason).toBe(
      "model-transition-applied-report-failed",
    );
    expect(
      output.lines.filter((line) => line.kind === "model-transition"),
    ).toHaveLength(0);

    await host.fire("agent_settled", { type: "agent_settled" }, fakeCtx());
    await flush();
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
    expect(timers.pending()).toHaveLength(0);
  });

  it("cancels a pending transition attempt and ignores its late callback", async () => {
    const { host, output, timers, secretBytes, recoveryCtx, deferred } =
      await beginFallbackAppliedTransition();
    output.deferNextWrite();
    deferred.settle(true);
    await waitFor(() => output.pendingDeferredWrites() === 1);
    const cancel = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 2,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "cancel",
        body: { reason: "cancelled-by-parent" },
      },
      secretBytes,
      hmacPort,
    );
    const cancelDelivery = deliverEnvelope(
      host,
      cancel._unsafeUnwrap() as unknown as JsonValue,
      recoveryCtx,
    );
    while (output.pendingDeferredWrites() > 0) {
      output.settleDeferredWrite("reject");
    }
    await cancelDelivery;
    await flush();
    expect(
      output.lines.filter((line) => line.kind === "cancelled"),
    ).toHaveLength(1);
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      0,
    );
    expect(timers.pending()).toHaveLength(0);
  });

  it("retries a failed applied-transition delivery twice and settles terminally", async () => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: { getAvailable: () => [origin, fallback] },
      hasPendingMessages: () => false,
    });
    const { host, output, secretBytes } =
      await buildChildExtension(recoveryCtx);
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        models: ["origin/first", "fallback/second"],
      }),
      recoveryCtx,
    );

    const failedMessage = {
      role: "assistant",
      id: "failed-applied-delivery",
      stopReason: "error",
      error: { status: 503, message: "provider unavailable" },
      content: [{ type: "text", text: "partial output" }],
    } as const;
    const deferred = host.deferNextSetModel();
    await host.fire(
      "message_end",
      { type: "message_end", message: failedMessage },
      recoveryCtx,
    );
    const fallbackSettlement = host.fire(
      "agent_settled",
      { type: "agent_settled" },
      recoveryCtx,
    );
    await deferred.called;
    await host.fire(
      "model_select",
      { type: "model_select", model: fallback },
      recoveryCtx,
    );

    const attemptsBeforeDelivery = output.writeAttempts;
    output.failWritesRemaining = 2;
    deferred.settle(true);
    await fallbackSettlement;
    await waitFor(() => output.lines.some((line) => line.kind === "settled"));

    const settled = output.lines.filter((line) => line.kind === "settled");
    expect(settled).toHaveLength(1);
    expect((settled[0]?.body as Record<string, unknown>).outcome).toBe(
      "failed",
    );
    expect((settled[0]?.body as Record<string, unknown>).reason).toBe(
      "model-transition-applied-report-failed",
    );
    expect(
      output.lines.filter((line) => line.kind === "model-transition"),
    ).toHaveLength(0);
    expect(
      output.writeAttempts - attemptsBeforeDelivery,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([
    {
      label: "delegated",
      context: { parentAgentName: "loom", parentDepth: 0 },
      directStep: false,
    },
    {
      label: "nested",
      context: { parentAgentName: "shuttle", parentDepth: 1 },
      directStep: false,
    },
    {
      label: "direct-step",
      context: { parentAgentName: "loom", parentDepth: 0 },
      directStep: true,
    },
  ] as const)("preserves one fallback epoch across the %s mode matrix", async ({
    label,
    context,
    directStep,
  }) => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: { getAvailable: () => [origin, fallback] },
      hasPendingMessages: () => false,
    });
    const { host, output, secretBytes } =
      await buildChildExtension(recoveryCtx);
    const modeFields = directStep
      ? {
          mode: "direct-step" as const,
          workflowInstanceId: "workflow-1",
          leaseId: "lease-1",
          stepName: "review",
          completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
        }
      : { mode: "ordinary" as const };
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        ...modeFields,
        models: ["origin/first", "fallback/second"],
        context: { ...context, cwd: "/project" },
      }),
      recoveryCtx,
    );
    await waitForMicrotasks(() =>
      output.lines.some((line) => line.kind === "bootstrap-ack"),
    );

    const failedText = `failed-${label}-credential-shaped-output`;
    const failedMessage = {
      role: "assistant",
      id: `failed-${label}`,
      stopReason: "error",
      error: { status: 503, message: `provider-${label}-secret` },
      content: [{ type: "text", text: failedText }],
    } as const;
    const deferred = host.deferNextSetModel();
    await host.fire(
      "message_end",
      { type: "message_end", message: failedMessage },
      recoveryCtx,
    );
    const pendingSettlement = host.fire(
      "agent_settled",
      { type: "agent_settled" },
      recoveryCtx,
    );
    await deferred.called;
    expect(host.setModelCalls.at(-1)).toBe(fallback);

    // The native model proof may arrive while setModel is unresolved. A
    // marker is not allowed until both facts are true.
    await host.fire(
      "model_select",
      { type: "model_select", model: fallback },
      recoveryCtx,
    );
    expect(host.sentMessages).toHaveLength(0);
    deferred.settle(true);
    await pendingSettlement;
    await waitForMicrotasks(() => host.sentMessages.length === 1);
    const marker = host.sentMessages[0];
    expect(marker?.customType).toBe("weave.model-fallback.recovery-marker");
    if (marker === undefined) throw new Error("fallback marker is missing");

    await host.fire(
      "message_start",
      { type: "message_start", message: marker },
      recoveryCtx,
    );
    const firstUserMessage = {
      role: "user",
      content: `retain-${label}`,
    };
    const queuedRealMessage = {
      role: "user",
      content: `queued-${label}`,
    };
    const providerInput = [
      firstUserMessage,
      failedMessage,
      marker,
      queuedRealMessage,
    ];
    const repaired = await host.fire("context", providerInput, recoveryCtx);
    expect(repaired).toEqual([firstUserMessage, queuedRealMessage]);
    expect(providerInput).toEqual([
      firstUserMessage,
      failedMessage,
      marker,
      queuedRealMessage,
    ]);

    await host.fire("turn_start", { type: "turn_start" }, recoveryCtx);
    const successfulMessage = {
      role: "assistant",
      id: `success-${label}`,
      stopReason: "stop",
      content: [{ type: "text", text: `success-${label}` }],
    } as const;
    await host.fire(
      "message_end",
      { type: "message_end", message: successfulMessage },
      recoveryCtx,
    );
    if (directStep) {
      const completionTool = host.registeredTool(WEAVE_COMPLETE_STEP_TOOL_NAME);
      expect(completionTool).toBeDefined();
      if (completionTool === undefined)
        throw new Error("direct-step completion tool is missing");
      const completion = await completionTool.execute(
        `tool-call-${label}`,
        { outcome: "success", method: "agent_signal" },
        undefined,
        undefined,
        recoveryCtx,
      );
      expect(completion.content[0]?.text).toContain('"ok":true');
    }
    const settledLine = waitForOutputLine(
      output,
      (line) => line.kind === "settled",
    );
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    const settled = await settledLine;
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
    const settledBody = settled.body as Record<string, unknown>;
    expect(settledBody.outcome).toBe("completed");
    if (directStep) {
      expect(settledBody.completionCandidate).toBe(
        serializeCompletionCandidate({
          outcome: "success",
          method: "agent_signal",
        }),
      );
    } else {
      expect(settledBody.assistantOutput).toBe(`success-${label}`);
    }

    // Child identity is carried by every authenticated output envelope. The
    // failed body, marker token, and provider error never enter the parent
    // projection, even though the failed message was retained durably.
    for (const line of output.lines) {
      expect(line.childId).toBe("child-1");
      expect(line.generationId).toBe("gen-1");
    }
    const outputText = JSON.stringify(output.lines);
    expect(outputText).not.toContain(failedText);
    expect(outputText).not.toContain(`provider-${label}-secret`);
    expect(outputText).not.toContain(marker.content);
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
  });

  it.each([
    {
      label: "delegated",
      context: { parentAgentName: "loom", parentDepth: 0 },
      directStep: false,
    },
    {
      label: "nested",
      context: { parentAgentName: "shuttle", parentDepth: 1 },
      directStep: false,
    },
    {
      label: "direct-step",
      context: { parentAgentName: "loom", parentDepth: 0 },
      directStep: true,
    },
  ] as const)("allows one unknown fallback advance in %s, then fails closed on the second", async ({
    label,
    context,
    directStep,
  }) => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const lastFallback: PiModelInfo = {
      provider: "fallback",
      id: "third",
      name: "Third",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: {
        getAvailable: () => [origin, fallback, lastFallback],
      },
    });
    const { host, output, secretBytes } = await buildChildExtension(
      recoveryCtx,
      { hostSurfaceReader: runtimeModelFallbackSurfaceReader(true) },
    );
    const modeFields = directStep
      ? {
          mode: "direct-step" as const,
          workflowInstanceId: "workflow-1",
          leaseId: "lease-1",
          stepName: "review",
          completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
        }
      : { mode: "ordinary" as const };
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        ...modeFields,
        models: ["origin/first", "fallback/second", "fallback/third"],
        context: { ...context, cwd: "/project" },
      }),
      recoveryCtx,
    );

    const failedMessage = (id: string) =>
      ({
        role: "assistant",
        id,
        stopReason: "error",
        error: { message: `${label}-opaque-provider-failure` },
        content: [{ type: "text", text: `${label}-private-failed-output` }],
      }) as const;
    const firstFailedMessage = failedMessage(`${label}-unknown-first`);
    await host.fire(
      "message_end",
      { type: "message_end", message: firstFailedMessage },
      recoveryCtx,
    );
    const firstSettlement = host.fire(
      "agent_settled",
      { type: "agent_settled" },
      recoveryCtx,
    );
    await waitFor(() => host.setModelCalls.length === 2);
    expect(host.setModelCalls).toEqual([origin, fallback]);
    await host.fire(
      "model_select",
      { type: "model_select", model: fallback },
      recoveryCtx,
    );
    await firstSettlement;
    await waitFor(() => host.sentMessages.length === 1);
    const marker = host.sentMessages[0];
    expect(marker?.customType).toBe("weave.model-fallback.recovery-marker");
    if (marker === undefined) throw new Error("fallback marker is missing");

    await host.fire(
      "message_start",
      { type: "message_start", message: marker },
      recoveryCtx,
    );
    const repaired = await host.fire(
      "context",
      [firstFailedMessage, marker, { role: "user", content: "queued" }],
      recoveryCtx,
    );
    expect(repaired).toEqual([{ role: "user", content: "queued" }]);
    await host.fire("turn_start", { type: "turn_start" }, recoveryCtx);

    const secondFailedMessage = failedMessage(`${label}-unknown-second`);
    await host.fire(
      "message_end",
      { type: "message_end", message: secondFailedMessage },
      recoveryCtx,
    );
    const settledLine = waitForOutputLine(
      output,
      (line) => line.kind === "settled",
    );
    const secondSettlement = host.fire(
      "agent_settled",
      { type: "agent_settled" },
      recoveryCtx,
    );
    const settled = await settledLine;
    await secondSettlement;

    // The first unknown consumed exactly one candidate. The second unknown
    // is terminal; it cannot wrap to the origin or advance to the third model.
    expect(host.setModelCalls).toEqual([origin, fallback]);
    expect(host.sentMessages).toHaveLength(1);
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
    );
    expect((settled.body as Record<string, unknown>).outcome).toBe("failed");
    const outputText = JSON.stringify(output.lines);
    expect(outputText).not.toContain(`${label}-opaque-provider-failure`);
    expect(outputText).not.toContain(`${label}-private-failed-output`);
  });

  it.each([
    {
      label: "delegated",
      context: { parentAgentName: "loom", parentDepth: 0 },
      directStep: false,
    },
    {
      label: "nested",
      context: { parentAgentName: "shuttle", parentDepth: 1 },
      directStep: false,
    },
    {
      label: "direct-step",
      context: { parentAgentName: "loom", parentDepth: 0 },
      directStep: true,
    },
  ] as const)("keeps %s child startup ready and uses legacy settlement when fallback is unproven", async ({
    label,
    context,
    directStep,
  }) => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: { getAvailable: () => [origin, fallback] },
    });
    const { host, output, secretBytes, timers } = await buildChildExtension(
      recoveryCtx,
      { hostSurfaceReader: runtimeModelFallbackSurfaceReader(false) },
    );
    const modeFields = directStep
      ? {
          mode: "direct-step" as const,
          workflowInstanceId: "workflow-1",
          leaseId: "lease-1",
          stepName: "review",
          completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
        }
      : { mode: "ordinary" as const };
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        ...modeFields,
        models: ["origin/first", "fallback/second"],
        context: { ...context, cwd: "/project" },
      }),
      recoveryCtx,
    );
    await waitForMicrotasks(() =>
      output.lines.some((line) => line.kind === "bootstrap-ack"),
    );

    const failedMessage = {
      role: "assistant",
      id: `unproven-${label}`,
      stopReason: "error",
      error: { message: "unrecognized provider failure" },
      content: [{ type: "text", text: "unproven-fallback-output" }],
    } as const;
    await host.fire(
      "message_end",
      { type: "message_end", message: failedMessage },
      recoveryCtx,
    );
    await host.fire("agent_settled", {}, recoveryCtx);
    timers.fireAll();
    const settledLine = waitForOutputLine(
      output,
      (line) => line.kind === "settled",
    );
    const settled = await settledLine;
    const settledLines = output.lines.filter((line) => line.kind === "settled");

    // Bootstrap model activation is the only setModel call. No optional
    // fallback artifact may cross the legacy path.
    expect(host.setModelCalls).toEqual([origin]);
    expect(host.sentMessages).toHaveLength(0);
    expect(
      output.lines.filter((line) => line.kind === "model-transition"),
    ).toHaveLength(0);
    expect(settledLines).toHaveLength(1);
    expect((settled.body as Record<string, unknown>).outcome).toBe("failed");
    expect(JSON.stringify(output.lines)).not.toContain(
      "unrecognized provider failure",
    );
    expect(JSON.stringify(output.lines)).not.toContain(
      "unproven-fallback-output",
    );
  });

  it.each([
    "false",
    "throw",
    "reject",
  ] as const)("settles the child without waiting for an impossible %s model proof", async (behavior) => {
    const origin: PiModelInfo = {
      provider: "origin",
      id: "first",
      name: "First",
    };
    const fallback: PiModelInfo = {
      provider: "fallback",
      id: "second",
      name: "Second",
    };
    const recoveryCtx = fakeCtx({
      model: origin,
      modelRegistry: { getAvailable: () => [origin, fallback] },
    });
    const { host, output, secretBytes } =
      await buildChildExtension(recoveryCtx);
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, {
        models: ["origin/first", "fallback/second"],
      }),
      recoveryCtx,
    );
    await waitForMicrotasks(() =>
      output.lines.some((line) => line.kind === "bootstrap-ack"),
    );

    if (behavior === "false") {
      host.modelAccepted = false;
    } else if (behavior === "throw") {
      host.setModel = ((model: PiModelInfo) => {
        host.setModelCalls.push(model);
        throw new Error("raw-child-setModel-secret");
      }) as typeof host.setModel;
    } else {
      host.setModel = ((model: PiModelInfo) => {
        host.setModelCalls.push(model);
        return Promise.reject(new Error("raw-child-setModel-secret"));
      }) as typeof host.setModel;
    }

    const failedText = `failed-${behavior}-must-not-leak`;
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: `impossible-${behavior}`,
          stopReason: "error",
          error: { status: 401, message: "raw-auth-error-secret" },
          content: [{ type: "text", text: failedText }],
        },
      },
      recoveryCtx,
    );
    const settledLine = waitForOutputLine(
      output,
      (line) => line.kind === "settled",
    );
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    const settled = await settledLine;
    expect(settled.body).toMatchObject({ outcome: "failed" });
    expect(host.sentMessages).toHaveLength(0);
    expect(JSON.stringify(output.lines)).not.toContain(failedText);
    expect(JSON.stringify(output.lines)).not.toContain("raw-auth-error-secret");
    expect(JSON.stringify(output.lines)).not.toContain(
      "raw-child-setModel-secret",
    );

    // No model_select, marker start, context repair, or second settlement is
    // required after Pi has made activation impossible.
    await host.fire("agent_settled", { type: "agent_settled" }, recoveryCtx);
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      1,
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

  it("reports terminal assistant output, not streamed previews or canary events, in the settlement output", async () => {
    const { host, output } = await buildChildExtension();
    const uiCanaryContext = fakeCtx();
    uiCanaryContext.ui.notify("ui canary", "info");
    uiCanaryContext.ui.setStatus("canary", "ui canary");
    uiCanaryContext.ui.setWidget("canary", "ui canary");
    await host.fire(
      "message_update",
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "streamed preview that must stay intermediate",
        },
      },
      fakeCtx(),
    );
    await host.fire(
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "tool-canary",
        toolName: "read",
        result: "tool output must stay private",
      },
      fakeCtx(),
    );
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "terminal-assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "thinking canary" },
            { type: "toolCall", name: "read", arguments: {} },
            { type: "text", text: "terminal assistant output" },
          ],
        },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    expect(settled?.kind).toBe("settled");
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
    expect(body.assistantOutput).toBe("terminal assistant output");
    expect(body.assistantOutput).not.toContain("streamed preview");
    expect(body.assistantOutput).not.toContain("tool output");
    expect(body.assistantOutput).not.toContain("thinking canary");
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
    // Settlement awaits the transfer ack, so observe chunks mid-flight.
    // Do not rely on a single flush(): signed chunk sends are serialized.
    await waitFor(() =>
      output.lines.some((line) => line.kind === "transfer-chunk"),
    );
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

  it("fails settlement when complete output transfer fails after one retry", async () => {
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
    expect(body.outcome).toBe("failed");
    expect(body.reason).toBe("output-transfer:EnvelopeSignFailed");
    expect(body.outputTransferId).toBeUndefined();
    expect(body.outputByteLength).toBeUndefined();
    expect(body.assistantOutput).toBeUndefined();
  });

  it("omits assistantOutput when a completed turn has no terminal assistant message", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_update",
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "streamed-only text must not become output",
        },
      },
      fakeCtx(),
    );
    await host.fire(
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "tool-canary",
        toolName: "read",
        result: "tool canary",
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
    expect(body).not.toHaveProperty("assistantOutput");
  });

  it("clears prior terminal output at turn_start and omits streamed-only output from the later turn", async () => {
    const { host, output } = await buildChildExtension();
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "earlier-terminal",
          stopReason: "stop",
          content: [{ type: "text", text: "stale terminal output" }],
        },
      },
      fakeCtx(),
    );
    await host.fire("turn_start", { type: "turn_start" }, fakeCtx());
    await host.fire(
      "message_update",
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "fresh streamed-only text",
        },
      },
      fakeCtx(),
    );
    await host.fire(
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "tool-canary",
        toolName: "read",
        result: "later tool canary",
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    await flush();

    const settled = output.lines.at(-1);
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("completed");
    expect(body).not.toHaveProperty("assistantOutput");
  });

  it("derives a failed outcome from the last observed assistant stopReason, since agent_settled itself carries no payload (Task 9)", async () => {
    const { host, output, timers } = await buildChildExtension();
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: { role: "assistant", id: "m1", stopReason: "error" },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    // The verdict is captured now and published once the bounded
    // compaction-evidence grace expires with no compaction lifecycle.
    timers.fireAll();
    await waitFor(() => output.lines.some((line) => line.kind === "settled"));

    const settled = output.lines.at(-1);
    expect(settled?.kind).toBe("settled");
    const body = settled?.body as Record<string, unknown>;
    expect(body.outcome).toBe("failed");
  });

  it("treats an aborted stopReason the same as an error stopReason", async () => {
    const { host, output, timers } = await buildChildExtension();
    await host.fire(
      "message_end",
      {
        type: "message_end",
        message: { role: "assistant", id: "m1", stopReason: "aborted" },
      },
      fakeCtx(),
    );
    await host.fire("agent_settled", {}, fakeCtx());
    timers.fireAll();
    await waitFor(() => output.lines.some((line) => line.kind === "settled"));

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

  it("copies ordinary fast intent and ordered triggers without source aliasing", () => {
    const sourceModels = ["fake/model-x#high"];
    const sourceTriggers = ["implement", "test in order"];
    const sourceTargets = [
      {
        name: "shuttle-mini",
        description: "Bounded implementation",
        triggers: sourceTriggers,
        isCategory: true,
      },
    ];
    const targetDescriptor = {
      name: "shuttle",
      composedPrompt: "You are Shuttle, a delegated specialist.",
      models: sourceModels,
      fast: true as const,
      mode: "subagent" as const,
      effectiveToolPolicy: {
        read: "allow" as const,
        write: "allow" as const,
        execute: "allow" as const,
        delegate: "allow" as const,
        network: "ask" as const,
      },
      rawToolPolicy: undefined,
      delegationTargets: sourceTargets,
      skills: [],
    };

    const bootstrap = buildChildBootstrapBody(
      new Map([[targetDescriptor.name, targetDescriptor]]),
      {
        name: targetDescriptor.name,
        description: "A delegated specialist.",
        triggers: [],
        isCategory: false,
      },
      "child-1",
      { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    ) as unknown as Record<string, unknown>;
    sourceModels[0] = "mutated/model";
    sourceTriggers[0] = "mutated trigger";
    const firstTarget = sourceTargets[0];
    if (firstTarget === undefined)
      throw new Error("test setup: missing target");
    firstTarget.name = "mutated-target";
    sourceTargets.push({
      name: "late-target",
      description: "Added after bootstrap construction",
      triggers: ["late trigger"],
      isCategory: false,
    });

    expect(bootstrap.fast).toBe(true);
    expect(bootstrap.models).toEqual(["fake/model-x#high"]);
    // Target catalogs stay parent-authoritative: the bootstrap carries none,
    // so no post-construction mutation of the source array can reach a child.
    expect(bootstrap.delegationTargets).toEqual([]);
  });

  it("preserves fast omission in an ordinary bootstrap", () => {
    const targetDescriptor = {
      name: "shuttle",
      composedPrompt: "You are Shuttle, a delegated specialist.",
      models: [],
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
    const bootstrap = buildChildBootstrapBody(
      new Map([[targetDescriptor.name, targetDescriptor]]),
      {
        name: targetDescriptor.name,
        description: "A delegated specialist.",
        triggers: [],
        isCategory: false,
      },
      "child-1",
      { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    ) as unknown as Record<string, unknown>;

    expect(Object.hasOwn(bootstrap, "fast")).toBe(false);
  });

  it("uses the prepared required-skill prompt for an ordinary child", () => {
    const targetDescriptor = {
      name: "shuttle",
      composedPrompt: "You are Shuttle, a delegated specialist.",
      models: [],
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
      skills: ["tdd"],
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
      undefined,
      (descriptor) =>
        `Required skill names to load before work: ${JSON.stringify(descriptor.skills)}\n${descriptor.composedPrompt}`,
    ) as unknown as Record<string, unknown>;

    expect(bootstrapBody.composedPrompt).toBe(
      'Required skill names to load before work: ["tdd"]\nYou are Shuttle, a delegated specialist.',
    );
  });

  it.each([
    ["ordinary", {}],
    [
      "direct-step",
      {
        mode: "direct-step",
        workflowInstanceId: "workflow-1",
        leaseId: "lease-1",
        stepName: "review",
        completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
      },
    ],
  ] as const)("applies a valid %s bootstrap before acknowledging fast intent and ordered triggers", async (_mode, modeFields) => {
    const { host, output, secretBytes } = await buildChildExtension();
    const envelope = await signedBootstrap(secretBytes, {
      ...modeFields,
      fast: true,
      delegationTargets: [
        {
          name: "shuttle-mini",
          description: "Bounded implementation",
          triggers: ["implement", "test in order"],
          isCategory: true,
        },
      ],
    });
    let appliedStateAtAck:
      | {
          delegationTool: boolean;
          completionTool: boolean;
        }
      | undefined;
    output.onLine = (line) => {
      if (line.kind !== "bootstrap-ack") return;
      appliedStateAtAck = {
        delegationTool: host.registeredTool("weave_delegate") !== undefined,
        completionTool:
          host.registeredTool(WEAVE_COMPLETE_STEP_TOOL_NAME) !== undefined,
      };
    };

    await deliverEnvelope(host, envelope);
    await flush();

    const delegationTool = host.registerToolCalls.find(
      (tool) => tool.name === "weave_delegate",
    );
    const completionTool = host.registeredTool(WEAVE_COMPLETE_STEP_TOOL_NAME);
    const ackIndex = output.lines.findIndex(
      (line) => line.kind === "bootstrap-ack",
    );
    expect(delegationTool).toBeDefined();
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(completionTool === undefined).toBe(_mode === "ordinary");
    expect(appliedStateAtAck).toEqual({
      delegationTool: true,
      completionTool: _mode === "direct-step",
    });
  });

  it.each([
    ["ordinary", {}],
    [
      "direct-step",
      {
        mode: "direct-step",
        workflowInstanceId: "workflow-1",
        leaseId: "lease-1",
        stepName: "review",
        completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
      },
    ],
  ] as const)("leaves a fast-declaring %s child's provider request and headers unchanged", async (_mode, modeFields) => {
    const model = {
      provider: "openai",
      id: "gpt-5.6-sol",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const ctx = fakeCtx({ model });
    const { host, secretBytes } = await buildChildExtension(ctx);
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, { ...modeFields, fast: true }),
      ctx,
    );
    await flush();

    const headers: Record<string, string> = {
      Authorization: "Bearer child-secret-value",
    };
    const payload = { model: "gpt-5.6-sol" };
    await host.fire(
      "before_provider_headers",
      { type: "before_provider_headers", headers },
      ctx,
    );
    const replaced = await host.fire(
      "before_provider_request",
      { type: "before_provider_request", payload },
      ctx,
    );

    // The child declares fast intent, but Pi cannot carry it: no control
    // reaches the payload and no beta header is written.
    expect(replaced).toBeUndefined();
    expect(payload).toEqual({ model: "gpt-5.6-sol" });
    expect(headers).toEqual({ Authorization: "Bearer child-secret-value" });
  });

  it.each([
    ["ordinary", {}],
    [
      "direct-step",
      {
        mode: "direct-step",
        workflowInstanceId: "workflow-1",
        leaseId: "lease-1",
        stepName: "review",
        completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
      },
    ],
  ] as const)("leaves a %s child's provider request untouched without fast intent", async (_mode, modeFields) => {
    const model = {
      provider: "openai",
      id: "gpt-5.6-sol",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const ctx = fakeCtx({ model });
    const { host, secretBytes } = await buildChildExtension(ctx);
    await deliverEnvelope(
      host,
      await signedBootstrap(secretBytes, modeFields),
      ctx,
    );
    await flush();

    const payload = { model: "gpt-5.6-sol" };
    await host.fire(
      "before_provider_headers",
      { type: "before_provider_headers", headers: {} },
      ctx,
    );
    const replaced = await host.fire(
      "before_provider_request",
      { type: "before_provider_request", payload },
      ctx,
    );

    expect(replaced).toBeUndefined();
    expect(payload).toEqual({ model: "gpt-5.6-sol" });
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
