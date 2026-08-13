import { describe, expect, it } from "bun:test";
import { ResultAsync } from "neverthrow";
import {
  generateNonceHex,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import type {
  ChildProcessError,
  PiChildProcessPort,
  PiChildSpawnInput,
  PiSpawnedChildProcess,
} from "../child-process-port.js";
import { DEFAULT_CHILD_RUNTIME_BUDGET_MS } from "../child-timer.js";
import {
  type PiRpcChildDeps,
  type PiRpcChildSpawnInput,
  PiRpcChild,
} from "../rpc-child.js";
import type { JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

/**
 * Distinct budget values, chosen so no two scheduled delays collide with each
 * other or with a default (handshake 10s, reply 15s, drain 250ms, cancel grace
 * 5s). Delay is therefore a reliable identity for "which timer is this".
 */
const INACTIVITY_MS = 111;
const RUNTIME_BUDGET_MS = 7_777;

/**
 * A process port whose `spawn` stays pending until the test releases it, so
 * the window between arming the absolute budget and owning a live process is
 * directly observable.
 */
class DeferredSpawnProcessPort implements PiChildProcessPort {
  readonly spawnedProcesses: FakeSpawnedProcess[] = [];
  readonly spawnInputs: PiChildSpawnInput[] = [];
  private readonly pending: Array<() => void> = [];

  spawn(
    input: PiChildSpawnInput,
  ): ResultAsync<PiSpawnedChildProcess, ChildProcessError> {
    this.spawnInputs.push(input);
    const process = new FakeSpawnedProcess();
    this.spawnedProcesses.push(process);
    return ResultAsync.fromSafePromise(
      new Promise<PiSpawnedChildProcess>((resolve) => {
        this.pending.push(() => resolve(process));
      }),
    );
  }

  /** Resolves the oldest in-flight `spawn`. */
  releaseSpawn(): void {
    this.pending.shift()?.();
  }
}

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface RecordedTimer {
  readonly delayMs: number;
  cancelled: boolean;
  readonly fire: () => void;
}

/** Records every scheduled timer and fires it only on demand. */
class ImmediateExpiryTimerPort {
  scheduleCalls = 0;
  cancelCalls = 0;

  schedule(callback: () => void, _delayMs: number) {
    this.scheduleCalls += 1;
    callback();
    return {
      cancel: () => {
        this.cancelCalls += 1;
      },
    };
  }
}

class RecordingTimerPort {
  readonly timers: RecordedTimer[] = [];

  schedule(callback: () => void, delayMs: number) {
    const timer: RecordedTimer = {
      delayMs,
      cancelled: false,
      fire: () => {
        if (!timer.cancelled) callback();
      },
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  withDelay(delayMs: number): RecordedTimer[] {
    return this.timers.filter((timer) => timer.delayMs === delayMs);
  }

  budgetTimer(): RecordedTimer | undefined {
    return this.withDelay(RUNTIME_BUDGET_MS).at(0);
  }
}

function baseSpawnInput(
  overrides: Partial<PiRpcChildSpawnInput> = {},
): PiRpcChildSpawnInput {
  return {
    childId: "child-1",
    parentId: "root",
    generationId: "gen-1",
    agentName: "shuttle",
    depth: 1,
    cwd: "/project",
    env: {},
    task: "do the thing",
    ...overrides,
  };
}

function validBootstrap(): JsonValue {
  return {
    mode: "ordinary",
    agentName: "shuttle",
    composedPrompt: "You are Shuttle.",
    models: [],
    correlationId: "child-1",
    context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
  } as JsonValue;
}

function validAck(): JsonValue {
  return {} as JsonValue;
}

function terminalAssistantMessage(text = "final answer"): JsonValue {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function extractSecretFromSpawn(port: FakeChildProcessPort): Uint8Array {
  const hex = port.spawnInputs.at(-1)?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("test setup: secret env missing");
  const bytes = hexToBytes(hex);
  if (bytes === undefined) throw new Error("test setup: malformed secret hex");
  return bytes;
}

/** Plays the part of a well-behaved child process. */
class ScriptedChildResponder {
  private sequence = 1;

  constructor(
    private readonly process: FakeSpawnedProcess,
    private readonly childId: string,
    private readonly generationId: string,
  ) {}

  async send(
    kind: PiControlKind,
    correlationId: string,
    body: JsonValue,
    secretBytes: Uint8Array,
  ) {
    const envelope = await signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "child-to-parent",
        sequence: this.sequence++,
        nonce: generateNonceHex(randomPort),
        correlationId,
        kind,
        body,
      },
      secretBytes,
      hmacPort,
    );
    if (envelope.isErr())
      throw new Error(`test setup failed to sign: ${envelope.error.type}`);
    this.process.emitLine(envelope.value);
    return envelope.value;
  }
}

interface RunningChild {
  readonly child: PiRpcChild;
  readonly processPort: FakeChildProcessPort;
  readonly spawned: FakeSpawnedProcess;
  readonly responder: ScriptedChildResponder;
  readonly secretBytes: Uint8Array;
  readonly timerPort: RecordingTimerPort;
}

/** Spawns, authenticates, and drives the child to the settlement-awaiting phase. */
async function startRunningChild(
  overrides: Partial<PiRpcChildDeps> = {},
): Promise<
  RunningChild & { readonly runPromise: ReturnType<PiRpcChild["runTask"]> }
> {
  const timerPort = new RecordingTimerPort();
  const processPort = new FakeChildProcessPort();
  const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
    processPort,
    randomPort,
    hmacPort,
    logger: noopLogger(),
    timerPort,
    settlementTimeoutMs: INACTIVITY_MS,
    runtimeBudgetMs: RUNTIME_BUDGET_MS,
    ...overrides,
  });
  const input = baseSpawnInput();
  const spawnPromise = child.spawnAndHandshake(input);
  await flush();
  const spawned = processPort.spawnedProcesses[0];
  if (spawned === undefined) throw new Error("test setup: no spawned process");
  const secretBytes = extractSecretFromSpawn(processPort);
  const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
  await responder.send("handshake", "child-1", {}, secretBytes);
  await spawnPromise;

  const runPromise = child.runTask(input, validBootstrap());
  await flush();
  await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
  await flush();
  return {
    child,
    processPort,
    spawned,
    responder,
    secretBytes,
    timerPort,
    runPromise,
  };
}

/** Emits parser-approved activity, then fires every already-superseded inactivity timer. */
async function reportActivity(
  running: RunningChild,
  turns: number,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    running.spawned.emitLine({ type: "turn_start" });
    await flush();
    // Every inactivity timer but the newest one is already cancelled; firing
    // them proves renewal really did supersede them.
    const inactivityTimers = running.timerPort.withDelay(INACTIVITY_MS);
    for (const timer of inactivityTimers.slice(0, -1)) timer.fire();
    await flush();
  }
}

async function isPending<T>(promise: {
  then: (onOk: (value: T) => unknown) => unknown;
}): Promise<boolean> {
  const sentinel = Symbol("pending");
  const settled = new Promise<"settled">((resolve) => {
    promise.then(() => resolve("settled"));
  });
  const raced = await Promise.race([settled, flush().then(() => sentinel)]);
  return raced === sentinel;
}

describe("absolute child runtime budget", () => {
  it("lets continuous activity outlive the renewable inactivity budget", async () => {
    const running = await startRunningChild();
    await reportActivity(running, 4);

    expect(running.timerPort.withDelay(INACTIVITY_MS).length).toBeGreaterThan(
      1,
    );
    expect(await isPending(running.runPromise)).toBe(true);
    expect(running.child.snapshot().status).toBe("running");
    expect(running.spawned.forceKilled).toBe(false);

    // Clean up so the pending run never dangles.
    running.child.dispose();
    await running.runPromise;
  });

  it("terminates a continuously active child once the absolute budget expires", async () => {
    const running = await startRunningChild();
    await reportActivity(running, 4);

    const budgetTimer = running.timerPort.budgetTimer();
    expect(budgetTimer).toBeDefined();
    expect(budgetTimer?.cancelled).toBe(false);
    budgetTimer?.fire();

    const result = await running.runPromise;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe("ChildRuntimeExceeded");
    expect(result.error.scope).toEqual({ kind: "child", id: "child-1" });
    expect(result.error.correlation?.budgetMs).toBe(RUNTIME_BUDGET_MS);
    // Fails closed: the process is force-killed, never merely abandoned.
    expect(running.spawned.forceKilled).toBe(true);
    expect(running.child.snapshot().status).toBe("failed");
  });

  it("preserves the thread for explicit recovery instead of discarding it", async () => {
    const running = await startRunningChild();
    running.timerPort.budgetTimer()?.fire();

    const result = await running.runPromise;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.retryable).toBe(true);
    expect(result.error.recovery).toBe("retry");
    expect(result.error.impact).toBe("operation-stopped");
  });

  it("arms the absolute budget exactly once and never renews it on activity", async () => {
    const running = await startRunningChild();
    expect(running.timerPort.withDelay(RUNTIME_BUDGET_MS).length).toBe(1);

    await reportActivity(running, 5);
    await running.responder.send(
      "delegate-request",
      "delegation-1",
      { agentName: "shuttle", task: "keep going" },
      running.secretBytes,
    );
    await flush();

    const budgetTimers = running.timerPort.withDelay(RUNTIME_BUDGET_MS);
    expect(budgetTimers.length).toBe(1);
    expect(budgetTimers[0]?.cancelled).toBe(false);

    running.child.dispose();
    await running.runPromise;
  });

  it("arms the budget at the spawn boundary and clears it when the handshake times out", async () => {
    const timerPort = new RecordingTimerPort();
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort,
      settlementTimeoutMs: INACTIVITY_MS,
      runtimeBudgetMs: RUNTIME_BUDGET_MS,
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    // The wall-clock budget covers the whole child lifetime, including the
    // pre-handshake window.
    expect(timerPort.withDelay(RUNTIME_BUDGET_MS).length).toBe(1);

    timerPort.withDelay(30_000).at(0)?.fire();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildHandshakeMissing");
    expect(timerPort.budgetTimer()?.cancelled).toBe(true);
  });

  it("defaults the absolute budget to 6 hours", async () => {
    const timerPort = new RecordingTimerPort();
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort,
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    expect(DEFAULT_CHILD_RUNTIME_BUDGET_MS).toBe(6 * 60 * 60 * 1_000);
    expect(timerPort.withDelay(DEFAULT_CHILD_RUNTIME_BUDGET_MS).length).toBe(1);

    child.dispose();
    await spawnPromise;
  });

  it("stops spawn setup when the runtime budget expires synchronously", async () => {
    const timerPort = new ImmediateExpiryTimerPort();
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort,
      runtimeBudgetMs: RUNTIME_BUDGET_MS,
    });

    const result = await child.spawnAndHandshake(baseSpawnInput());

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe("ChildRuntimeExceeded");
    expect(processPort.spawnInputs).toHaveLength(0);
    expect(child.snapshot().status).toBe("failed");
    expect(timerPort.scheduleCalls).toBe(1);
    expect(timerPort.cancelCalls).toBe(1);
  });

  it("clears the budget timer when the child settles before the cap", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine(terminalAssistantMessage());
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      running.secretBytes,
    );

    const result = await running.runPromise;
    expect(result.isOk()).toBe(true);
    expect(running.timerPort.budgetTimer()?.cancelled).toBe(true);

    // A cancelled timer that fires anyway must stay inert.
    running.timerPort.budgetTimer()?.fire();
    expect(running.child.snapshot().status).toBe("completed");
  });

  it("fails a draining child when the absolute cap expires before its terminal response", async () => {
    const running = await startRunningChild();
    // Settlement arrives before the terminal assistant message, so the child
    // enters the bounded drain window with its settlement waiter outstanding.
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      running.secretBytes,
    );
    await flush();

    running.timerPort.budgetTimer()?.fire();

    const result = await running.runPromise;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    // The cap stays authoritative over the drain: it must not be swallowed
    // while the parent is still blocked on that waiter.
    expect(result.error.code).toBe("ChildRuntimeExceeded");
    expect(running.spawned.forceKilled).toBe(true);
    expect(running.child.snapshot().status).toBe("failed");

    // No double settlement: the drain timer is cancelled and a late terminal
    // response can no longer complete the settlement it already lost.
    for (const timer of running.timerPort.withDelay(250)) timer.fire();
    running.spawned.emitLine(terminalAssistantMessage());
    await flush();
    expect(running.child.snapshot().status).toBe("failed");
  });

  it("ignores a cap that expires after a drained settlement already completed", async () => {
    const running = await startRunningChild();
    await running.responder.send(
      "settled",
      "child-1",
      { outcome: "completed", assistantOutput: "done" },
      running.secretBytes,
    );
    await flush();
    // The terminal response lands inside the drain window and wins the race.
    running.spawned.emitLine(terminalAssistantMessage());

    const result = await running.runPromise;
    expect(result.isOk()).toBe(true);
    expect(running.timerPort.budgetTimer()?.cancelled).toBe(true);

    running.timerPort.budgetTimer()?.fire();
    await flush();
    expect(running.child.snapshot().status).toBe("completed");
  });

  it("kills a process that finishes spawning after the cap already expired", async () => {
    const timerPort = new RecordingTimerPort();
    const processPort = new DeferredSpawnProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort,
      settlementTimeoutMs: INACTIVITY_MS,
      runtimeBudgetMs: RUNTIME_BUDGET_MS,
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    // The budget covers the spawn itself, so it can expire while `spawn` is
    // still pending and no process object exists to kill yet.
    expect(processPort.spawnInputs.length).toBe(1);
    expect(timerPort.budgetTimer()).toBeDefined();

    timerPort.budgetTimer()?.fire();
    await flush();

    processPort.releaseSpawn();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildRuntimeExceeded");

    const late = processPort.spawnedProcesses[0];
    // The late process is force-killed rather than left running.
    expect(late?.forceKilled).toBe(true);
    // It is never installed as a live child: no transport is wired and no
    // handshake waiter (10s timer) is left behind for nobody to reject.
    expect(timerPort.withDelay(10_000).length).toBe(0);
    expect(child.snapshot().status).toBe("failed");

    late?.emitLine(terminalAssistantMessage());
    await flush();
    expect(child.snapshot().status).toBe("failed");
  });

  it("kills a process that finishes spawning after disposal", async () => {
    const timerPort = new RecordingTimerPort();
    const processPort = new DeferredSpawnProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort,
      settlementTimeoutMs: INACTIVITY_MS,
      runtimeBudgetMs: RUNTIME_BUDGET_MS,
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    child.dispose();

    processPort.releaseSpawn();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(processPort.spawnedProcesses[0]?.forceKilled).toBe(true);
    expect(timerPort.withDelay(10_000).length).toBe(0);
    expect(timerPort.budgetTimer()?.cancelled).toBe(true);
  });

  it("clears the budget timer on cancellation", async () => {
    const running = await startRunningChild();
    const cancelPromise = running.child.cancel();
    await flush();
    running.timerPort.withDelay(5_000).at(0)?.fire();
    expect((await cancelPromise).isOk()).toBe(true);

    expect(running.timerPort.budgetTimer()?.cancelled).toBe(true);
    expect(running.spawned.forceKilled).toBe(true);
    await running.runPromise;
  });

  it("clears the budget timer on disposal", async () => {
    const running = await startRunningChild();
    running.child.dispose();

    expect(running.timerPort.budgetTimer()?.cancelled).toBe(true);
    const result = await running.runPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
  });

  it("ignores a cap that expires after the child already failed", async () => {
    const running = await startRunningChild();
    const inactivityTimers = running.timerPort.withDelay(INACTIVITY_MS);
    inactivityTimers.at(-1)?.fire();

    const result = await running.runPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildSettlementMissing");

    expect(running.timerPort.budgetTimer()?.cancelled).toBe(true);
    running.timerPort.budgetTimer()?.fire();
    expect(running.child.snapshot().status).toBe("failed");
  });
});
