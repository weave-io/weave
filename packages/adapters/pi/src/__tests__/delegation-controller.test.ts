import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { MAX_CWD_LENGTH } from "../child-control-bodies.js";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { WEAVE_CHILD_ID_ENV, WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { signEnvelope } from "../child-envelope.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import { SystemTimerPort } from "../child-timer.js";
import {
  type PiChildInspectionHistoryError,
  type PiChildInspectionHistoryPort,
  type PiChildInspectionRegistration,
  PiChildInspectionRegistry,
} from "../child-tree.js";
import {
  PiDelegationController,
  type PiDelegationRequest,
} from "../delegation-controller.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";

function config(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function limitsSource(opts: {
  maxChildren: number;
  maxConcurrency: number;
  maxDepth: number;
  maxProcesses: number;
}): string {
  return `settings {\n  delegation {\n    max_children ${opts.maxChildren}\n    max_concurrency ${opts.maxConcurrency}\n    max_depth ${opts.maxDepth}\n    max_processes ${opts.maxProcesses}\n  }\n}\nagent shuttle {\n}\n`;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class SequentialIdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `child-${this.counter}`;
  }
}

function request(
  overrides: Partial<PiDelegationRequest> = {},
): PiDelegationRequest {
  return {
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "shuttle",
    agentName: "shuttle",
    task: "do the thing",
    cwd: "/project",
    env: {},
    bootstrap: {
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "You are Shuttle.",
      models: [],
      correlationId: "child-1",
      context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    },
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function spawnedAt(
  port: FakeChildProcessPort,
  index: number,
): FakeSpawnedProcess {
  const process = port.spawnedProcesses[index];
  expect(process).toBeDefined();
  if (process === undefined)
    throw new Error(`missing spawned process ${index}`);
  return process;
}

function extractSecret(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): Uint8Array {
  const idx = port.spawnedProcesses.indexOf(process);
  const input = port.spawnInputs[idx];
  const hex = input?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("no secret in spawn env");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function childIdOf(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
): string {
  const idx = port.spawnedProcesses.indexOf(process);
  return port.spawnInputs[idx]?.env[WEAVE_CHILD_ID_ENV] ?? "";
}

async function sendHandshakeOnly(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
  generationId: string,
): Promise<void> {
  const secret = extractSecret(process, port);
  const childId = childIdOf(process, port);
  const randomPort = new WebCryptoRandomPort();
  const hmacPort = new WebCryptoHmacPort();
  const handshake = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence: 1,
      nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
      correlationId: childId,
      kind: "handshake",
      body: {},
    },
    secret,
    hmacPort,
  );
  process.emitLine(handshake._unsafeUnwrap());
}

async function respondHandshakeAndSettle(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
  generationId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const secret = extractSecret(process, port);
  const childId = childIdOf(process, port);
  const randomPort = new WebCryptoRandomPort();
  const hmacPort = new WebCryptoHmacPort();
  let sequence = 1;
  const handshake = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence: sequence++,
      nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
      correlationId: childId,
      kind: "handshake",
      body: {},
    },
    secret,
    hmacPort,
  );
  process.emitLine(handshake._unsafeUnwrap());
  await flush();
  const bootstrapAck = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence: sequence++,
      nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
      correlationId: childId,
      kind: "bootstrap-ack",
      body: {},
    },
    secret,
    hmacPort,
  );
  process.emitLine(bootstrapAck._unsafeUnwrap());
  await flush();
  await flush();
  const request = process
    .writtenLines()
    .find(
      (line): line is { type: string; id: string; command: string } =>
        typeof line === "object" &&
        line !== null &&
        (line as { type?: unknown }).type === "get_entries",
    );
  if (request !== undefined) {
    process.emitLine({
      type: "response",
      id: request.id,
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "leaf-42" },
    });
    await flush();
  }
  if (outcome === "completed") {
    process.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    });
    await flush();
  }
  const settled = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence: sequence++,
      nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
      correlationId: childId,
      kind: "settled",
      body:
        outcome === "completed"
          ? { outcome, assistantOutput: "ok", outputByteLength: 2 }
          : { outcome, reason: "boom" },
    },
    secret,
    hmacPort,
  );
  process.emitLine(settled._unsafeUnwrap());
}

async function settleRunningChild(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
  generationId: string,
  sequence: number,
): Promise<void> {
  const secret = extractSecret(process, port);
  const childId = childIdOf(process, port);
  process.emitLine({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    },
  });
  await flush();
  const settled = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence,
      nonce: Buffer.from(new WebCryptoRandomPort().randomBytes(16)).toString(
        "hex",
      ),
      correlationId: childId,
      kind: "settled",
      body: {
        outcome: "completed",
        assistantOutput: "ok",
        outputByteLength: 2,
      },
    },
    secret,
    new WebCryptoHmacPort(),
  );
  process.emitLine(settled._unsafeUnwrap());
}

function makeController(
  cfg: WeaveConfig,
  port: FakeChildProcessPort,
  overrides: Partial<
    ConstructorParameters<typeof PiDelegationController>[0]
  > = {},
): PiDelegationController {
  return new PiDelegationController({
    config: cfg,
    generationId: "gen-1",
    idGenerator: new SequentialIdGenerator(),
    logger: noopLogger,
    processPort: port,
    randomPort: new WebCryptoRandomPort(),
    hmacPort: new WebCryptoHmacPort(),
    timerPort: new SystemTimerPort(),
    // Real timers, but a tiny bound: tests that never send an authenticated
    // `cancelled` ack still exercise the real bounded-wait-then-force-kill
    // path without waiting out the production 5s default.
    cancelGraceMs: 10,
    ...overrides,
  });
}

async function sendChildToRunning(
  process: FakeSpawnedProcess,
  port: FakeChildProcessPort,
  generationId: string,
): Promise<void> {
  await sendHandshakeOnly(process, port, generationId);
  await flush();
  const secret = extractSecret(process, port);
  const childId = childIdOf(process, port);
  const randomPort = new WebCryptoRandomPort();
  const hmacPort = new WebCryptoHmacPort();
  const bootstrapAck = await signEnvelope(
    {
      childId,
      generationId,
      direction: "child-to-parent",
      sequence: 2,
      nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
      correlationId: childId,
      kind: "bootstrap-ack",
      body: {},
    },
    secret,
    hmacPort,
  );
  process.emitLine(bootstrapAck._unsafeUnwrap());
  await flush();
}

function controlEnvelopesFromWritten(
  process: FakeSpawnedProcess,
): Array<{ kind: string; body: unknown }> {
  const prefix = "/weave:__control__ ";
  return (process.writtenLines() as Array<{ message?: string }>)
    .filter(
      (line): line is { message: string } =>
        typeof line.message === "string" && line.message.startsWith(prefix),
    )
    .map((line) => JSON.parse(line.message.slice(prefix.length)));
}

async function waitForDelegateResponses(
  process: FakeSpawnedProcess,
): Promise<Array<{ kind: string; body: unknown }>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const responses = controlEnvelopesFromWritten(process).filter(
      (envelope) => envelope.kind === "delegate-response",
    );
    if (responses.length > 0) return responses;
    await flush();
  }
  return controlEnvelopesFromWritten(process).filter(
    (envelope) => envelope.kind === "delegate-response",
  );
}

const GENEROUS = limitsSource({
  maxChildren: 9,
  maxConcurrency: 9,
  maxDepth: 3,
  maxProcesses: 9,
});
const NO_AGENTS = `settings {\n  delegation {\n    max_children 9\n    max_concurrency 9\n    max_depth 3\n    max_processes 9\n  }\n}\n`;

class DeterministicRandomPort {
  private value = 0;
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    bytes.fill(this.value++ & 0xff);
    return bytes;
  }
}

function recoveryRecord(
  overrides: Partial<PiChildHistoryRecord> = {},
): PiChildHistoryRecord {
  return {
    childId: "recover-me",
    parentSessionId: "parent",
    kind: "ordinary",
    status: "interrupted",
    workflow: {},
    descriptorName: "shuttle",
    sessionPath: "children/recover-me/session.jsonl",
    activeLeaf: "leaf-42",
    checkpointCursor: 7,
    branchAncestry: [],
    interventionCount: 2,
    finalOutput: "",
    trim: { trimmed: false, markerCount: 0 },
    quarantine: { quarantined: false },
    clear: { cleared: false },
    recovery: { eligible: true, count: 0 },
    bytes: { session: 1, checkpoint: 1, total: 2 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function instrumentedRegistry(
  events: string[],
  failures: Partial<
    Record<"interrupted" | "terminal", PiChildInspectionHistoryError>
  > = {},
): PiChildInspectionRegistry {
  const history: PiChildInspectionHistoryPort = {
    interrupted: () => {
      const failure = failures.interrupted;
      return failure === undefined ? okAsync(undefined) : errAsync(failure);
    },
    terminal: () => {
      const failure = failures.terminal;
      return failure === undefined ? okAsync(undefined) : errAsync(failure);
    },
  };
  const registry = new PiChildInspectionRegistry(history);
  const originalInterrupted = registry.markInterrupted.bind(registry);
  const originalTerminal = registry.retainTerminal.bind(registry);
  registry.markInterrupted = (id) => {
    events.push(`interrupted:${id}`);
    return originalInterrupted(id);
  };
  registry.retainTerminal = (id, snapshot, output) => {
    events.push(`terminal:${id}`);
    return originalTerminal(id, snapshot, output);
  };
  return registry;
}

function recoveryController(
  port: FakeChildProcessPort,
  overrides: Partial<
    ConstructorParameters<typeof PiDelegationController>[0]
  > = {},
): PiDelegationController {
  return makeController(config(GENEROUS), port, {
    randomPort: new DeterministicRandomPort(),
    rootAgentName: () => "shuttle",
    resolveRootDelegationTarget: () => ({ name: "shuttle" }) as never,
    buildBootstrap: (_target, childId, context) =>
      ({
        mode: "ordinary",
        agentName: "shuttle",
        composedPrompt: "You are Shuttle.",
        models: [],
        correlationId: childId,
        context: {
          parentAgentName: context.parentAgentName,
          parentDepth: context.parentDepth,
          cwd: context.cwd,
        },
      }) as never,
    pathContainment: {
      verifyContainment: () => okAsync("/history/children/safe"),
    },
    historyRoot: () => "/history",
    currentCwd: () => "/workspace/current",
    currentEnv: () => ({ SAFE: "yes" }),
    ...overrides,
  });
}

describe("PiDelegationController", () => {
  it("authorizes and spawns immediately when under budget, resolving on settlement", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const resultPromise = controller.delegate(request());
    await flush();
    const spawned = port.spawnedProcesses[0];
    expect(spawned).toBeDefined();
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const result = await resultPromise;
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "completed",
      assistantOutput: "ok",
      outputByteLength: 2,
      interventionCount: 0,
    });
  });

  it("denies (never queues) once max_children is reached for that parent", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 1,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    void controller.delegate(request());
    await flush();
    const second = await controller.delegate(request());
    expect(second.isErr()).toBe(true);
    expect(second._unsafeUnwrapErr().code).toBe("ChildCapacityExceeded");
    expect(second._unsafeUnwrapErr().correlation?.reason).toBe("max_children");
  });

  it("releases max_children capacity after a child settles while denying concurrent overflow", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 1,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );

    const firstPromise = controller.delegate(request());
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    const concurrent = await controller.delegate(request());
    expect(concurrent.isErr()).toBe(true);
    expect(concurrent._unsafeUnwrapErr().code).toBe("ChildCapacityExceeded");
    expect(concurrent._unsafeUnwrapErr().correlation?.reason).toBe(
      "max_children",
    );

    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    expect((await firstPromise).isOk()).toBe(true);

    const nextPromise = controller.delegate(request());
    await flush();
    expect(port.spawnedProcesses.length).toBe(2);
    await respondHandshakeAndSettle(spawnedAt(port, 1), port, "gen-1");
    expect((await nextPromise).isOk()).toBe(true);
    controller.disposeAll();
  });

  it("denies once max_depth is exceeded", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 1,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    // Root delegates a real child at depth 1 - within max_depth(1), so it
    // spawns normally.
    void controller.delegate(request());
    await flush();
    const child = spawnedAt(port, 0);
    const childId = childIdOf(child, port);

    // That same live child, at its own true depth of 1, now attempts a
    // further nested delegation of its own - childDepth would become 2,
    // exceeding max_depth(1).
    const result = await controller.delegate(
      request({
        parentId: childId,
        parentDepth: 1,
        parentAgentName: "shuttle",
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().correlation?.reason).toBe("max_depth");
    controller.disposeAll();
  });

  it("queues (does not spawn) once max_concurrency is reached, then promotes after the running child settles", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    const firstPromise = controller.delegate(request());
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    const secondPromise = controller.delegate(request());
    await flush();
    // Still only one process spawned - the second request is queued, not denied.
    expect(port.spawnedProcesses.length).toBe(1);

    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const first = await firstPromise;
    expect(first.isOk()).toBe(true);

    await flush();
    expect(port.spawnedProcesses.length).toBe(2);
    await respondHandshakeAndSettle(spawnedAt(port, 1), port, "gen-1");
    const second = await secondPromise;
    expect(second.isOk()).toBe(true);
  });

  it("queues once the global max_processes budget is reached, even for a different parent", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 1,
        }),
      ),
      port,
    );
    void controller.delegate(request({ parentId: "root" }));
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);
    const firstChildId = childIdOf(spawnedAt(port, 0), port);

    // A second, genuinely different real parent - the first live child
    // itself, delegating further - not a fabricated, never-registered
    // parentId.
    const secondPromise = controller.delegate(
      request({
        parentId: firstChildId,
        parentDepth: 1,
        parentAgentName: "shuttle",
      }),
    );
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    await flush();
    expect(port.spawnedProcesses.length).toBe(2);
    await respondHandshakeAndSettle(spawnedAt(port, 1), port, "gen-1");
    const second = await secondPromise;
    expect(second.isOk()).toBe(true);
  });

  it("fails closed (never open) when the resolved agent limits cannot be determined", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(NO_AGENTS), port);
    const result = await controller.delegate(
      request({ parentAgentName: "no-such-agent" }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildCapacityExceeded");
  });

  it("still rejects an empty task before spawning a process", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const result = await controller.delegate(request({ task: "" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(0);
  });

  it("fails closed (never spawns a process) when the request's own context.cwd exceeds the bounded control-schema limit (Pi adapter contract)", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const result = await controller.delegate(
      request({ cwd: "/".repeat(MAX_CWD_LENGTH + 1) }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(0);
  });

  it("cancelSubtree cancels a live child and drops queued descendants without ever spawning them", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 1,
        }),
      ),
      port,
    );
    const firstPromise = controller.delegate(request({ parentId: "root" }));
    await flush();
    const liveChildId = childIdOf(spawnedAt(port, 0), port);

    // Complete the handshake (but never settle) so the child is genuinely
    // "live" - otherwise it would still be blocked on a real handshake timer.
    await sendHandshakeOnly(spawnedAt(port, 0), port, "gen-1");
    await flush();

    // Second request queues under the global max_processes=1 budget and
    // targets the live child as its own parent (a grandchild delegation).
    const queuedPromise = controller.delegate(
      request({ parentId: liveChildId }),
    );
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    const cancelResult = await controller.cancelSubtree("root");
    expect(cancelResult.isOk()).toBe(true);
    expect(port.spawnedProcesses[0]?.killed).toBe(true);

    const queued = await queuedPromise;
    expect(queued.isErr()).toBe(true);
    expect(queued._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    // The queued grandchild request must never have been spawned.
    expect(port.spawnedProcesses.length).toBe(1);

    const first = await firstPromise;
    expect(first.isErr()).toBe(true);
  });

  it("cancelSubtree deterministically discovers and drops a queued-under-queued chain (depth 2+), even when the intermediate parent is never live", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 1,
        }),
      ),
      port,
    );
    // child-1: spawns immediately, consuming the only global process slot.
    const firstPromise = controller.delegate(request({ parentId: "root" }));
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);
    const child1Id = childIdOf(spawnedAt(port, 0), port);

    // child-2: queued under child-1 (global budget exhausted) - child-2 is
    // never spawned, so it never enters `this.children` at all.
    const child2Promise = controller.delegate(
      request({ parentId: child1Id, parentDepth: 1 }),
    );
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    // child-3: queued under child-2, which is itself only queued - this is
    // the exact "queued descendant whose queued parent is not yet in the
    // live child map" case. `idGenerator` assigns ids in call order, so
    // child-2's id is deterministically known before it is ever authorized.
    const child2Id = "child-2";
    const child3Promise = controller.delegate(
      request({ parentId: child2Id, parentDepth: 2 }),
    );
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    // Cancelling the live root of the chain (child-1) must transitively
    // discover and drop BOTH queued descendants, not just the direct one -
    // proving BFS traversal walks through a purely-queued intermediate
    // node rather than only checking each queued entry's immediate parent.
    const cancelResult = await controller.cancelSubtree(child1Id);
    expect(cancelResult.isOk()).toBe(true);
    expect(port.spawnedProcesses[0]?.killed).toBe(true);

    const child2Result = await child2Promise;
    expect(child2Result.isErr()).toBe(true);
    expect(child2Result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");

    const child3Result = await child3Promise;
    expect(child3Result.isErr()).toBe(true);
    expect(child3Result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");

    // Neither queued descendant was ever spawned.
    expect(port.spawnedProcesses.length).toBe(1);

    const first = await firstPromise;
    expect(first.isErr()).toBe(true);
    controller.disposeAll();
  });

  it("cancelSubtree targeting a queued (never-live) node drops only that node's own queued subtree, in deterministic BFS order, leaving unrelated live/queued nodes untouched", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 1,
        }),
      ),
      port,
    );
    // child-1: spawns immediately (consumes the only global process slot)
    // and must remain live/untouched by the cancellation below.
    const firstPromise = controller.delegate(request({ parentId: "root" }));
    await flush();
    const child1Id = childIdOf(spawnedAt(port, 0), port);

    // child-2: queued sibling directly under root - the cancellation target.
    const child2Id = "child-2";
    const child2Promise = controller.delegate(
      request({ parentId: "root", parentDepth: 0 }),
    );
    await flush();

    // child-3: queued grandchild under the still-queued child-2.
    const child3Promise = controller.delegate(
      request({ parentId: child2Id, parentDepth: 1 }),
    );
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    const cancelResult = await controller.cancelSubtree(child2Id);
    expect(cancelResult.isOk()).toBe(true);

    const child2Result = await child2Promise;
    expect(child2Result.isErr()).toBe(true);
    const child3Result = await child3Promise;
    expect(child3Result.isErr()).toBe(true);

    // child-1 was never part of the cancelled subtree and must remain live.
    expect(port.spawnedProcesses.length).toBe(1);
    expect(port.spawnedProcesses[0]?.killed).toBe(false);
    const tree = controller.snapshotTree();
    expect(tree.some((node) => node.id === child1Id)).toBe(true);

    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const first = await firstPromise;
    expect(first.isOk()).toBe(true);
    controller.disposeAll();
  });

  it("cancelSubtree on a child whose task was genuinely dispatched (bootstrap-acked, running) resolves that exact child's own pending delegate() promise as a structured cancelled settlement (Pi adapter contract) - the invariant the weave_delegate tool's abort wiring depends on", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    const delegatePromise = controller.delegate(request({ parentId: "root" }));
    await flush();
    const spawned = spawnedAt(port, 0);
    const childId = childIdOf(spawned, port);
    // Genuinely running - past handshake and bootstrap-ack, task dispatched
    // - not merely queued or mid-handshake, which instead fail closed
    // (Pi adapter contract, `PiRpcChild.completeCancellation`'s
    // `cancelled-before-running` branch, covered elsewhere in this file).
    await sendChildToRunning(spawned, port, "gen-1");

    const cancelResult = await controller.cancelSubtree(childId);
    expect(cancelResult.isOk()).toBe(true);
    expect(spawned.killed).toBe(true);

    const settlement = await delegatePromise;
    expect(settlement.isOk()).toBe(true);
    expect(settlement._unsafeUnwrap()).toEqual({ outcome: "cancelled" });
    controller.disposeAll();
  });

  it("disposeAll drains the queue and disposes every live child, idempotently", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    void controller.delegate(request());
    await flush();
    const queuedPromise = controller.delegate(request());
    await flush();

    controller.disposeAll();
    const queued = await queuedPromise;
    expect(queued.isErr()).toBe(true);
    expect(port.spawnedProcesses[0]?.killed).toBe(true);

    // Idempotent: calling again must not throw or double-resolve.
    expect(() => controller.disposeAll()).not.toThrow();
  });

  it("snapshotTree reports every spawned child (bounded inspectable tree state)", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    void controller.delegate(request());
    await flush();
    const tree = controller.snapshotTree();
    expect(tree.length).toBe(1);
    expect(tree[0]?.name).toBe("shuttle");
    controller.disposeAll();
  });

  it("delegates for an authenticated direct-step parent through the shared tracked budget", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        `${limitsSource({
          maxChildren: 2,
          maxConcurrency: 2,
          maxDepth: 3,
          maxProcesses: 2,
        })}\nagent tapestry {\n}\n`,
      ),
      port,
      {
        resolveDelegationTarget: (requestingAgentName, targetAgentName) =>
          requestingAgentName === "tapestry" &&
          targetAgentName === "tapestry-worker"
            ? { name: "tapestry-worker", triggers: [], isCategory: false }
            : undefined,
        buildBootstrap: (target, childId, context) => ({
          mode: "ordinary" as const,
          agentName: target.name,
          composedPrompt: `You are ${target.name}.`,
          models: [],
          correlationId: childId,
          context: {
            parentAgentName: context.parentAgentName,
            parentDepth: context.parentDepth,
            cwd: context.cwd,
          },
        }),
      },
    );

    const settlementPromise = controller.delegateFromAuthenticatedParent({
      parentId: "direct-workflow-step",
      parentDepth: 0,
      parentAgentName: "tapestry",
      agentName: "tapestry-worker",
      task: "Reply exactly TAPESTRY_CHILD_OK",
      cwd: "/project",
    });
    await flush();

    expect(port.spawnedProcesses.length).toBe(1);
    const child = spawnedAt(port, 0);
    const childId = childIdOf(child, port);
    expect(childId).toBe("child-1");
    const treeNode = controller
      .snapshotTree()
      .find((node) => node.id === childId);
    expect(treeNode?.parentId).toBe("direct-workflow-step");

    await respondHandshakeAndSettle(child, port, "gen-1");
    const settlement = await settlementPromise;
    expect(settlement._unsafeUnwrap()).toEqual({
      outcome: "completed",
      assistantOutput: "ok",
      outputByteLength: 2,
      interventionCount: 0,
    });
    controller.disposeAll();
  });

  it("relays a live child's delegate-request through the same tracked global budget, not an independent one", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 1,
        }),
      ),
      port,
      {
        resolveDelegationTarget: (requestingAgentName, targetAgentName) =>
          requestingAgentName === "shuttle" && targetAgentName === "shuttle"
            ? { name: "shuttle", triggers: [], isCategory: false }
            : undefined,
        buildBootstrap: (target, childId) => ({
          mode: "ordinary" as const,
          agentName: target.name,
          composedPrompt: `You are ${target.name}.`,
          models: [],
          correlationId: childId,
          context: {
            parentAgentName: "shuttle",
            parentDepth: 1,
            cwd: "/project",
          },
        }),
      },
    );
    void controller.delegate(request());
    await flush();
    const first = spawnedAt(port, 0);
    const firstChildId = childIdOf(first, port);
    await sendChildToRunning(first, port, "gen-1");

    // The child itself relays a nested delegate-request while it is live.
    const secret = extractSecret(first, port);
    const randomPort = new WebCryptoRandomPort();
    const hmacPort = new WebCryptoHmacPort();
    const delegateRequest = await signEnvelope(
      {
        childId: firstChildId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 3,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: `${firstChildId}-delegate-0`,
        kind: "delegate-request",
        body: { agentName: "shuttle", task: "nested task" },
      },
      secret,
      hmacPort,
    );
    first.emitLine(delegateRequest._unsafeUnwrap());
    await flush();

    // Still only one live process: the relayed request shares the exact
    // same global `max_processes` budget as every other delegation, never
    // an independent/untracked one (Pi adapter contract).
    expect(port.spawnedProcesses.length).toBe(1);

    // The child result contract needs a terminal assistant response before a
    // completed settlement counts (Pi adapter contract §10).
    first.emitLine({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const settled = await signEnvelope(
      {
        childId: firstChildId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 4,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: firstChildId,
        kind: "settled",
        body: { outcome: "completed", assistantOutput: "parent done" },
      },
      secret,
      hmacPort,
    );
    first.emitLine(settled._unsafeUnwrap());
    await flush();

    // Once the parent settles and frees the global budget, the queued
    // relayed request is promoted and spawned as a real grandchild.
    expect(port.spawnedProcesses.length).toBe(2);
    const grandchild = spawnedAt(port, 1);
    const grandchildId = childIdOf(grandchild, port);
    const tree = controller.snapshotTree();
    const grandchildNode = tree.find((node) => node.id === grandchildId);
    expect(grandchildNode?.parentId).toBe(firstChildId);
    controller.disposeAll();
  });

  it("fails closed with exactly one delegate-response error and never spawns when the target is not eligible for that child", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port, {
      resolveDelegationTarget: () => undefined,
      buildBootstrap: (target, childId) => ({
        mode: "ordinary" as const,
        agentName: target.name,
        composedPrompt: `You are ${target.name}.`,
        models: [],
        correlationId: childId,
        context: {
          parentAgentName: "shuttle",
          parentDepth: 1,
          cwd: "/project",
        },
      }),
    });
    void controller.delegate(request());
    await flush();
    const first = spawnedAt(port, 0);
    const firstChildId = childIdOf(first, port);
    await sendChildToRunning(first, port, "gen-1");

    const secret = extractSecret(first, port);
    const randomPort = new WebCryptoRandomPort();
    const hmacPort = new WebCryptoHmacPort();
    const delegateRequest = await signEnvelope(
      {
        childId: firstChildId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 3,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: `${firstChildId}-delegate-0`,
        kind: "delegate-request",
        body: { agentName: "no-such-target", task: "nested task" },
      },
      secret,
      hmacPort,
    );
    first.emitLine(delegateRequest._unsafeUnwrap());
    await flush();

    expect(port.spawnedProcesses.length).toBe(1);
    const responses = await waitForDelegateResponses(first);
    expect(responses).toHaveLength(1);
    const envelope = responses[0];
    expect(envelope?.kind).toBe("delegate-response");
    expect((envelope?.body as { ok: boolean; error?: string }).ok).toBe(false);
    controller.disposeAll();
  });

  it("rejects a forged parentAgentName that impersonates a different real, live parent to escape its budget", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    void controller.delegate(request());
    await flush();
    const first = spawnedAt(port, 0);
    const firstChildId = childIdOf(first, port);
    await sendChildToRunning(first, port, "gen-1");

    // A caller claims to be delegating on behalf of the real live child
    // `firstChildId`, but forges a different `parentAgentName` in the hope
    // of picking up a looser (or simply different) agent's budget instead
    // of that child's own true recorded identity.
    const result = await controller.delegate(
      request({ parentId: firstChildId, parentAgentName: "someone-else" }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    controller.disposeAll();
  });

  it("rejects a forged parentDepth that impersonates a different real, live parent to bypass max_depth", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 9,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    void controller.delegate(request());
    await flush();
    const first = spawnedAt(port, 0);
    const firstChildId = childIdOf(first, port);
    await sendChildToRunning(first, port, "gen-1");

    // `firstChildId` is really at depth 0 (it delegated straight from
    // root); a caller claims the same real `parentId` but forges a
    // shallower `parentDepth` to dodge `max_depth` for that identity.
    const result = await controller.delegate(
      request({ parentId: firstChildId, parentDepth: 0 }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    controller.disposeAll();
  });

  it("rejects a forged root parentAgentName when the real root agent name is known", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port, {
      rootAgentName: () => "loom",
    });
    const result = await controller.delegate(
      request({ parentId: "root", parentAgentName: "shuttle" }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(0);
    controller.disposeAll();
  });

  it("rejects a forged root parentDepth (root must always claim depth 0)", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const result = await controller.delegate(
      request({ parentId: "root", parentDepth: 1 }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(0);
    controller.disposeAll();
  });

  it("rejects a completely fabricated parentId that never corresponds to root or any live child", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const result = await controller.delegate(
      request({ parentId: "never-spawned-parent" }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(0);
    controller.disposeAll();
  });

  it("rejects a parentId naming a real child that has already settled and been disposed (no longer live)", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const firstPromise = controller.delegate(request());
    await flush();
    const child = spawnedAt(port, 0);
    const childId = childIdOf(child, port);
    await respondHandshakeAndSettle(child, port, "gen-1");
    const first = await firstPromise;
    expect(first.isOk()).toBe(true);
    expect(child.killed).toBe(true);

    // The very same childId that just settled and was disposed can no
    // longer be used as a `parentId` - it is no longer a live, non-terminal
    // requesting child.
    const result = await controller.delegate(
      request({
        parentId: childId,
        parentDepth: 1,
        parentAgentName: "shuttle",
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(1);
    controller.disposeAll();
  });

  it("registers history before spawning, and returns a bounded typed failure without spawning when registration fails", async () => {
    const events: string[] = [];
    let release!: () => void;
    const history: PiChildInspectionHistoryPort = {
      register: () =>
        new ResultAsync<void, PiChildInspectionHistoryError>(
          new Promise((resolve) => {
            release = () => {
              events.push("register");
              resolve(ok(undefined));
            };
          }),
        ),
    };
    const registry = new PiChildInspectionRegistry(history);
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port, {
      inspectionRegistry: registry,
    });
    void controller.delegate(request());
    await flush();
    expect(port.spawnedProcesses).toHaveLength(0);
    release();
    await flush();
    expect(events).toEqual(["register"]);
    expect(port.spawnedProcesses).toHaveLength(1);
    controller.disposeAll();

    const failing = new PiChildInspectionRegistry({
      register: () =>
        errAsync({
          kind: "history-write-failed",
          operation: "register",
          reason: "unavailable",
        }),
    });
    const failedPort = new FakeChildProcessPort();
    const failed = makeController(config(GENEROUS), failedPort, {
      inspectionRegistry: failing,
    }).delegate(request());
    const result = await failed;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildRecoveryUnavailable");
    expect(failedPort.spawnedProcesses).toHaveLength(0);
  });

  it("uses one registry for ordinary and nested children with the correct parent topology", async () => {
    const registrations: PiChildInspectionRegistration[] = [];
    const registry = new PiChildInspectionRegistry({
      register: (registration) => {
        registrations.push(registration);
        return okAsync(undefined);
      },
    });
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port, {
      inspectionRegistry: registry,
    });
    const rootPromise = controller.delegate(request());
    await flush();
    const rootId = childIdOf(spawnedAt(port, 0), port);
    const nestedPromise = controller.delegate(
      request({ parentId: rootId, parentDepth: 1 }),
    );
    await flush();
    expect(
      registrations.map(({ id, parentId, kind }) => ({ id, parentId, kind })),
    ).toEqual([
      { id: rootId, parentId: "root", kind: "ordinary" },
      { id: "child-2", parentId: rootId, kind: "nested" },
    ]);
    controller.disposeAll();
    await rootPromise;
    await nestedPromise;
  });

  it("keeps checkpoint events ordered and persists interruption before cancellation", async () => {
    const events: string[] = [];
    const registry = new PiChildInspectionRegistry({
      register: (r) => {
        events.push(`register:${r.id}`);
        return okAsync(undefined);
      },
      checkpoint: (id, event) => {
        events.push(`checkpoint:${id}:${String(event)}`);
        return okAsync(undefined);
      },
      interrupted: (id) => {
        events.push(`interrupted:${id}`);
        return okAsync(undefined);
      },
    });
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port, {
      inspectionRegistry: registry,
    });
    const promise = controller.delegate(request());
    await flush();
    const child = spawnedAt(port, 0);
    const id = childIdOf(child, port);
    await sendChildToRunning(child, port, "gen-1");
    await registry.checkpointEvent(id, "one");
    await registry.checkpointEvent(id, "two");
    await controller.cancelSubtree("root");
    const one = events.indexOf(`checkpoint:${id}:one`);
    const two = events.indexOf(`checkpoint:${id}:two`);
    const interrupted = events.indexOf(`interrupted:${id}`);
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(interrupted).toBeGreaterThan(two);
    expect(child.killed).toBe(true);
    await promise;
    controller.disposeAll();
  });

  it("persists terminal assistantOutput before disposal and capacity promotion, retaining the terminal record", async () => {
    const events: string[] = [];
    let observedAlive = false;
    const registry = new PiChildInspectionRegistry({
      register: (r) => {
        events.push(`register:${r.id}`);
        return okAsync(undefined);
      },
      terminal: (id, _snapshot, output) => {
        events.push(`terminal:${id}:${output}`);
        observedAlive = port.spawnedProcesses.length === 1;
        return okAsync(undefined);
      },
    });
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
      { inspectionRegistry: registry },
    );
    const firstPromise = controller.delegate(request());
    await flush();
    const secondPromise = controller.delegate(request());
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const first = await firstPromise;
    expect(first.isOk()).toBe(true);
    await flush();
    expect(events.some((event) => event.startsWith("terminal:"))).toBe(true);
    expect(observedAlive).toBe(true);
    expect(registry.snapshotHistory()[0]?.status).toBe("completed");
    expect(port.spawnedProcesses).toHaveLength(2);
    await respondHandshakeAndSettle(spawnedAt(port, 1), port, "gen-1");
    await secondPromise;
    controller.disposeAll();
  });

  it("still kills, disposes, and releases capacity when terminal persistence fails without exposing raw output", async () => {
    const registry = new PiChildInspectionRegistry({
      register: () => okAsync(undefined),
      terminal: () =>
        errAsync({
          kind: "history-write-failed",
          operation: "terminal",
          reason: "quota",
        }),
    });
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port, {
      inspectionRegistry: registry,
    });
    const promise = controller.delegate(request());
    await flush();
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const result = await promise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildHistoryQuotaExceeded");
    expect(spawnedAt(port, 0).killed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ok");
    controller.disposeAll();
  });

  it("blocks stale history work after close generation", async () => {
    const registrations: string[] = [];
    const registry = new PiChildInspectionRegistry({
      register: (r) => {
        registrations.push(r.id);
        return okAsync(undefined);
      },
    });
    registry.closeGeneration();
    const registration: PiChildInspectionRegistration = {
      id: "stale",
      parentId: "root",
      name: "shuttle",
      kind: "ordinary",
      snapshot: () => ({
        id: "stale",
        parentId: "root",
        name: "shuttle",
        status: "queued",
        currentTurn: 0,
        currentTool: undefined,
        startedAtMs: 0,
        elapsedMs: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
        latestOutput: "",
      }),
    };
    await registry.register(registration);
    expect(registrations).toEqual([]);
    expect(registry.snapshotHistory()).toEqual([]);
  });

  it("disposes (kills the process, erases the secret) each settled child before promoting the next queued delegation", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(
      config(
        limitsSource({
          maxChildren: 9,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 9,
        }),
      ),
      port,
    );
    const firstPromise = controller.delegate(request());
    await flush();
    const first = spawnedAt(port, 0);
    expect(first.killed).toBe(false);

    const secondPromise = controller.delegate(request());
    await flush();
    expect(port.spawnedProcesses.length).toBe(1);

    await respondHandshakeAndSettle(first, port, "gen-1");
    const firstResult = await firstPromise;
    expect(firstResult.isOk()).toBe(true);

    // The just-settled child's own process must already be killed by the
    // time the queued second delegation is promoted and spawned - not left
    // running while a fresh process consumes another global-budget slot.
    expect(first.killed).toBe(true);
    await flush();
    expect(port.spawnedProcesses.length).toBe(2);

    await respondHandshakeAndSettle(spawnedAt(port, 1), port, "gen-1");
    const secondResult = await secondPromise;
    expect(secondResult.isOk()).toBe(true);
    controller.disposeAll();
  });

  it("restores a real child with the verified session, leaf, cursor, and fixed continuation", async () => {
    const port = new FakeChildProcessPort();
    const controller = recoveryController(port);
    const promise = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "Continue safely.",
      record: recoveryRecord(),
    });
    await flush();
    expect(port.spawnInputs[0]).toMatchObject({
      cwd: "/workspace/current",
      env: { SAFE: "yes" },
      command: [
        "pi",
        "--mode",
        "rpc",
        "--session-dir",
        "/history/children/safe",
        "--session",
        "/history/children/safe/session.jsonl",
      ],
    });
    expect(port.spawnInputs[0]?.env[WEAVE_CHILD_ID_ENV]).toBe("recover-me");
    expect(port.spawnInputs[0]?.env.WEAVE_CHILD_DEPTH).toBe("1");
    expect(port.spawnInputs[0]?.env.WEAVE_CHILD_PARENT_ID).toBe("root");
    expect(port.spawnInputs[0]?.env.WEAVE_CONTROLLER_GENERATION).toBe("gen-1");
    expect(JSON.stringify(port.spawnInputs[0])).not.toContain(
      "old task canary",
    );
    expect(port.spawnInputs[0]?.command.at(-1)).toBe(
      "/history/children/safe/session.jsonl",
    );
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const result = await promise;
    expect(result._unsafeUnwrap()).toEqual({
      finalOutput: "ok",
      interventionCount: 0,
    });
    expect(spawnedAt(port, 0).killed).toBe(true);
    controller.disposeAll();
  });

  it("generates fresh recovery authority and never reuses the stored authority", async () => {
    const port = new FakeChildProcessPort();
    const controller = recoveryController(port);
    const first = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "one",
      record: recoveryRecord(),
    });
    await flush();
    const firstSecret = port.spawnInputs[0]?.env[WEAVE_CHILD_SECRET_ENV];
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    await first;
    const second = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "two",
      record: recoveryRecord(),
    });
    await flush();
    const secondSecret = port.spawnInputs[1]?.env[WEAVE_CHILD_SECRET_ENV];
    expect(firstSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSecret).not.toBe(firstSecret);
    await respondHandshakeAndSettle(spawnedAt(port, 1), port, "gen-1");
    expect((await second).isOk()).toBe(true);
    controller.disposeAll();
  });

  it("rejects every invalid restore before process spawn and bounds its error", async () => {
    const port = new FakeChildProcessPort();
    const containment = {
      verifyContainment: () => errAsync("path-component-missing" as const),
    };
    const controller = recoveryController(port, {
      pathContainment: containment,
    });
    const cases = [
      { generationId: "old", record: recoveryRecord() },
      {
        generationId: "gen-1",
        record: recoveryRecord({ parentChildId: "nested" }),
      },
      {
        generationId: "gen-1",
        record: recoveryRecord({
          sessionPath: "../old-task-canary/session.jsonl",
        }),
      },
      {
        generationId: "gen-1",
        record: recoveryRecord({ sessionPath: "children/x/wrong.jsonl" }),
      },
      {
        generationId: "gen-1",
        record: recoveryRecord({ activeLeaf: undefined }),
      },
      { generationId: "gen-1", record: recoveryRecord({ status: "settled" }) },
    ];
    for (const item of cases) {
      const result = await controller.restoreOrdinaryChild({
        generationId: item.generationId,
        descriptor: { name: "shuttle" },
        continuation: "task-canary",
        record: item.record,
      });
      expect(result.isErr()).toBe(true);
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain("canary");
    }
    expect(port.spawnedProcesses).toHaveLength(0);
    controller.disposeAll();
  });

  it("releases reservation after bootstrap failure, allowing the next restore", async () => {
    const port = new FakeChildProcessPort();
    const controller = recoveryController(port, {
      buildBootstrap: () => {
        throw new Error("raw canary");
      },
    });
    const failed = await controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "one",
      record: recoveryRecord(),
    });
    expect(failed.isErr()).toBe(true);
    expect(JSON.stringify(failed._unsafeUnwrapErr())).not.toContain("canary");
    expect(port.spawnedProcesses).toHaveLength(0);
    const next = recoveryController(port);
    const promise = next.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "two",
      record: recoveryRecord(),
    });
    await flush();
    expect(port.spawnedProcesses).toHaveLength(1);
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    expect((await promise).isOk()).toBe(true);
    next.disposeAll();
  });

  it("persists interruption before disposing on handshake/run failure and releases capacity", async () => {
    const port = new FakeChildProcessPort();
    const controller = recoveryController(port);
    const promise = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "one",
      record: recoveryRecord(),
    });
    await flush();
    const child = spawnedAt(port, 0);
    child.endStdout();
    const result = await promise;
    expect(result.isErr()).toBe(true);
    expect(child.killed).toBe(true);
    expect(port.spawnedProcesses).toHaveLength(1);
    controller.disposeAll();
  });

  it("attachment failure erases its reservation and a later restore uses capacity", async () => {
    const port = new FakeChildProcessPort();
    const registry = instrumentedRegistry([]);
    await registry.attachRecovered({
      id: "recover-me",
      parentId: "root",
      name: "shuttle",
      kind: "ordinary",
      snapshot: () =>
        ({
          id: "recover-me",
          parentId: undefined,
          name: "shuttle",
          status: "running",
          currentTurn: 0,
          currentTool: undefined,
          startedAtMs: 1,
          elapsedMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
          latestOutput: "",
        }) as never,
    });
    const controller = recoveryController(port, {
      config: config(
        limitsSource({
          maxChildren: 1,
          maxConcurrency: 1,
          maxDepth: 3,
          maxProcesses: 1,
        }),
      ),
      inspectionRegistry: registry,
    });
    const failed = await controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "one",
      record: recoveryRecord(),
    });
    expect(failed.isErr()).toBe(true);
    expect(port.spawnedProcesses).toHaveLength(0);
    const next = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "two",
      record: recoveryRecord({
        childId: "recover-next",
        sessionPath: "children/recover-next/session.jsonl",
      }),
    });
    await flush();
    expect(port.spawnedProcesses).toHaveLength(1);
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    expect(
      (
        await next.match(
          (value) => ok(value),
          (error) => err(error),
        )
      ).isOk(),
    ).toBe(true);
    controller.disposeAll();
  });

  it("cancelled and failed settlements persist interruption before disposal and release capacity", async () => {
    for (const outcome of ["cancelled", "failed"] as const) {
      const events: string[] = [];
      const port = new FakeChildProcessPort();
      const registry = instrumentedRegistry(events);
      const controller = recoveryController(port, {
        config: config(
          limitsSource({
            maxChildren: 1,
            maxConcurrency: 1,
            maxDepth: 3,
            maxProcesses: 1,
          }),
        ),
        inspectionRegistry: registry,
      });
      const promise = controller.restoreOrdinaryChild({
        generationId: "gen-1",
        descriptor: { name: "shuttle" },
        continuation: outcome,
        record: recoveryRecord(),
      });
      await flush();
      const child = spawnedAt(port, 0);
      const originalKill = child.kill.bind(child);
      const originalForceKill = child.forceKill.bind(child);
      child.kill = () => {
        events.push("disposed");
        originalKill();
      };
      child.forceKill = () => {
        events.push("disposed");
        originalForceKill();
      };
      if (outcome === "cancelled") {
        const cancellation = await controller.cancelSubtree("recover-me").match(
          (value) => ok(value),
          (error) => err(error),
        );
        expect(cancellation.isOk()).toBe(true);
      } else {
        await respondHandshakeAndSettle(child, port, "gen-1", "failed");
      }
      const result = await promise.match(
        (value) => ok(value),
        (error) => err(error),
      );
      expect(result.isErr()).toBe(true);
      expect(events).toContain("interrupted:recover-me");
      expect(events).toContain("disposed");
      expect(child.killed).toBe(true);
      expect(controller.snapshotTree()).toHaveLength(0);
      controller.disposeAll();
    }
  });

  it("successful restore persists terminal history before disposal and retains it", async () => {
    const events: string[] = [];
    const port = new FakeChildProcessPort();
    const registry = instrumentedRegistry(events);
    const controller = recoveryController(port, {
      inspectionRegistry: registry,
    });
    const promise = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "fixed",
      record: recoveryRecord(),
    });
    await flush();
    const child = spawnedAt(port, 0);
    const originalKill = child.kill.bind(child);
    const originalForceKill = child.forceKill.bind(child);
    child.kill = () => {
      events.push("disposed");
      originalKill();
    };
    child.forceKill = () => {
      events.push("disposed");
      originalForceKill();
    };
    await respondHandshakeAndSettle(child, port, "gen-1");
    expect(
      (
        await promise.match(
          (value) => ok(value),
          (error) => err(error),
        )
      ).isOk(),
    ).toBe(true);
    expect(events).toContain("terminal:recover-me");
    expect(events).toContain("disposed");
    expect(controller.snapshotTree()).toHaveLength(0);
    expect(registry.snapshotHistory()).toHaveLength(1);
    controller.disposeAll();
  });

  it("recovered running children route authenticated nested delegation through the shared budget", async () => {
    const port = new FakeChildProcessPort();
    const controller = recoveryController(port, {
      config: config(
        limitsSource({
          maxChildren: 2,
          maxConcurrency: 2,
          maxDepth: 3,
          maxProcesses: 3,
        }),
      ),
      resolveDelegationTarget: () => ({
        name: "shuttle",
        triggers: [],
        isCategory: false,
      }),
    });
    const restore = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "fixed",
      record: recoveryRecord(),
    });
    await flush();
    const parent = spawnedAt(port, 0);
    await sendChildToRunning(parent, port, "gen-1");
    const entriesRequest = parent
      .writtenLines()
      .find(
        (line): line is { type: string; id: string } =>
          typeof line === "object" &&
          line !== null &&
          (line as { type?: unknown }).type === "get_entries" &&
          typeof (line as { id?: unknown }).id === "string",
      );
    if (entriesRequest !== undefined) {
      parent.emitLine({
        type: "response",
        id: entriesRequest.id,
        command: "get_entries",
        success: true,
        data: { entries: [], leafId: "leaf-42" },
      });
      await flush();
    }
    const secret = extractSecret(parent, port);
    const childId = childIdOf(parent, port);
    const nested = await signEnvelope(
      {
        childId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 3,
        nonce: Buffer.from(new WebCryptoRandomPort().randomBytes(16)).toString(
          "hex",
        ),
        correlationId: "nested-correlation",
        kind: "delegate-request",
        body: { agentName: "shuttle", task: "nested" },
      },
      secret,
      new WebCryptoHmacPort(),
    );
    parent.emitLine(nested._unsafeUnwrap());
    await flush();
    await flush();
    await flush();
    expect(port.spawnedProcesses).toHaveLength(2);
    const grandchild = spawnedAt(port, 1);
    await respondHandshakeAndSettle(grandchild, port, "gen-1");
    await flush();
    const response = parent
      .writtenLines()
      .map((line) => {
        if (typeof line !== "object" || line === null) return undefined;
        const message = (line as { message?: unknown }).message;
        const prefix = "/weave:__control__ ";
        if (typeof message !== "string" || !message.startsWith(prefix))
          return undefined;
        return JSON.parse(message.slice(prefix.length)) as {
          kind: string;
          correlationId?: string;
          body: unknown;
        };
      })
      .reverse()
      .find((envelope) => envelope?.kind === "delegate-response");
    expect(response).toBeDefined();
    expect(response?.kind).toBe("delegate-response");
    expect(response?.correlationId).toBe("nested-correlation");
    await settleRunningChild(parent, port, "gen-1", 4);
    expect(
      (
        await restore.match(
          (value) => ok(value),
          (error) => err(error),
        )
      ).isOk(),
    ).toBe(true);
    await flush();
    await flush();
    await flush();
    expect(controller.snapshotTree()).toHaveLength(1);
    controller.disposeAll();
  });

  it("cleanup survives bounded terminal and interruption persistence failures", async () => {
    for (const operation of ["terminal", "interrupted"] as const) {
      const events: string[] = [];
      const port = new FakeChildProcessPort();
      const registry = instrumentedRegistry(events, {
        [operation]: {
          kind: "history-write-failed",
          operation,
          reason: "quota",
        },
      });
      const controller = recoveryController(port, {
        inspectionRegistry: registry,
      });
      const promise = controller.restoreOrdinaryChild({
        generationId: "gen-1",
        descriptor: { name: "shuttle" },
        continuation: operation,
        record: recoveryRecord(),
      });
      await flush();
      const child = spawnedAt(port, 0);
      const originalKill = child.kill.bind(child);
      const originalForceKill = child.forceKill.bind(child);
      child.kill = () => {
        events.push("disposed");
        originalKill();
      };
      child.forceKill = () => {
        events.push("disposed");
        originalForceKill();
      };
      if (operation === "terminal")
        await respondHandshakeAndSettle(child, port, "gen-1");
      else child.endStdout();
      const result = await promise.match(
        (value) => ok(value),
        (error) => err(error),
      );
      expect(result.isErr()).toBe(true);
      expect(events).toContain("disposed");
      expect(events.indexOf("disposed")).toBeGreaterThanOrEqual(0);
      expect(child.killed).toBe(true);
      controller.disposeAll();
    }
  });

  it("retains terminal persistence before disposal and releases the recovered child", async () => {
    const port = new FakeChildProcessPort();
    const controller = recoveryController(port);
    const promise = controller.restoreOrdinaryChild({
      generationId: "gen-1",
      descriptor: { name: "shuttle" },
      continuation: "fixed",
      record: recoveryRecord(),
    });
    await flush();
    await respondHandshakeAndSettle(spawnedAt(port, 0), port, "gen-1");
    const result = await promise;
    expect(result._unsafeUnwrap()).toMatchObject({
      finalOutput: "ok",
      interventionCount: 0,
    });
    expect(spawnedAt(port, 0).killed).toBe(true);
    expect(controller.snapshotTree()).toHaveLength(0);
    controller.disposeAll();
  });
});
