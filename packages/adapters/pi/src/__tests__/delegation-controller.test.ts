import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { MAX_CWD_LENGTH } from "../child-control-bodies.js";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { WEAVE_CHILD_ID_ENV, WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { signEnvelope } from "../child-envelope.js";
import { SystemTimerPort } from "../child-timer.js";
import {
  PiDelegationController,
  type PiDelegationRequest,
} from "../delegation-controller.js";
import { MAX_TASK_INPUT_CHARS } from "../delegation-limits.js";
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
      activeTools: [],
    },
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
      body: { activeTools: [] },
    },
    secret,
    hmacPort,
  );
  process.emitLine(bootstrapAck._unsafeUnwrap());
  await flush();
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
          ? { outcome, summary: "ok" }
          : { outcome, reason: "boom" },
    },
    secret,
    hmacPort,
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
      body: { activeTools: [] },
    },
    secret,
    hmacPort,
  );
  process.emitLine(bootstrapAck._unsafeUnwrap());
  await flush();
}

function extractControlEnvelopeFromWritten(
  process: FakeSpawnedProcess,
): { kind: string; body: unknown } | undefined {
  const lines = process.writtenLines() as Array<{ message?: string }>;
  const last = lines.at(-1);
  if (last?.message === undefined) return undefined;
  const prefix = "/weave:__control__ ";
  if (!last.message.startsWith(prefix)) return undefined;
  return JSON.parse(last.message.slice(prefix.length));
}

const GENEROUS = limitsSource({
  maxChildren: 9,
  maxConcurrency: 9,
  maxDepth: 3,
  maxProcesses: 9,
});
const NO_AGENTS = `settings {\n  delegation {\n    max_children 9\n    max_concurrency 9\n    max_depth 3\n    max_processes 9\n  }\n}\n`;

describe("PiDelegationController", () => {
  it("authorizes and spawns immediately when under budget, resolving on settlement", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const resultPromise = controller.delegate(request());
    await flush();
    const spawned = port.spawnedProcesses[0];
    expect(spawned).toBeDefined();
    await respondHandshakeAndSettle(spawned!, port, "gen-1");
    const result = await resultPromise;
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      outcome: "completed",
      summary: "ok",
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
    const child = port.spawnedProcesses[0]!;
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

    await respondHandshakeAndSettle(port.spawnedProcesses[0]!, port, "gen-1");
    const first = await firstPromise;
    expect(first.isOk()).toBe(true);

    await flush();
    expect(port.spawnedProcesses.length).toBe(2);
    await respondHandshakeAndSettle(port.spawnedProcesses[1]!, port, "gen-1");
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
    const firstChildId = childIdOf(port.spawnedProcesses[0]!, port);

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

    await respondHandshakeAndSettle(port.spawnedProcesses[0]!, port, "gen-1");
    await flush();
    expect(port.spawnedProcesses.length).toBe(2);
    await respondHandshakeAndSettle(port.spawnedProcesses[1]!, port, "gen-1");
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

  it("fails closed (never spawns a process) when the request's own task exceeds the same bound enforced at tool parsing and RPC send (Spec 33 \u00a711.2 Task 9)", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const result = await controller.delegate(
      request({ task: "x".repeat(MAX_TASK_INPUT_CHARS + 1) }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildAbortFailed");
    expect(port.spawnedProcesses.length).toBe(0);
  });

  it("fails closed (never spawns a process) when the request's own context.cwd exceeds the bounded control-schema limit (Spec 33 \u00a711.2 Task 9)", async () => {
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
    const liveChildId = childIdOf(port.spawnedProcesses[0]!, port);

    // Complete the handshake (but never settle) so the child is genuinely
    // "live" - otherwise it would still be blocked on a real handshake timer.
    await sendHandshakeOnly(port.spawnedProcesses[0]!, port, "gen-1");
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
    const child1Id = childIdOf(port.spawnedProcesses[0]!, port);

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
    const child1Id = childIdOf(port.spawnedProcesses[0]!, port);

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

    await respondHandshakeAndSettle(port.spawnedProcesses[0]!, port, "gen-1");
    const first = await firstPromise;
    expect(first.isOk()).toBe(true);
    controller.disposeAll();
  });

  it("cancelSubtree on a child whose task was genuinely dispatched (bootstrap-acked, running) resolves that exact child's own pending delegate() promise as a structured cancelled settlement (Spec 33 \u00a711.5) - the invariant the weave_delegate tool's abort wiring depends on", async () => {
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
    const spawned = port.spawnedProcesses[0]!;
    const childId = childIdOf(spawned, port);
    // Genuinely running - past handshake and bootstrap-ack, task dispatched
    // - not merely queued or mid-handshake, which instead fail closed
    // (Spec 33 \u00a711.5, `PiRpcChild.completeCancellation`'s
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

  it("relays a live child's approval-request to the injected callback and delivers respondToApproval back to that exact child", async () => {
    const port = new FakeChildProcessPort();
    const relayed: { childId: string; correlationId: string }[] = [];
    const controller = new PiDelegationController({
      config: config(GENEROUS),
      generationId: "gen-1",
      idGenerator: new SequentialIdGenerator(),
      logger: noopLogger,
      processPort: port,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
      timerPort: new SystemTimerPort(),
      onChildApprovalRequest: (childId, correlationId) => {
        relayed.push({ childId, correlationId });
      },
    });
    void controller.delegate(request());
    await flush();
    const process = port.spawnedProcesses[0]!;
    await sendHandshakeOnly(process, port, "gen-1");
    await flush();
    const secretBytes = extractSecret(process, port);
    const childId = childIdOf(process, port);
    const randomPort = new WebCryptoRandomPort();
    const hmacPort = new WebCryptoHmacPort();
    const bootstrapAck = await signEnvelope(
      {
        childId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 2,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: childId,
        kind: "bootstrap-ack",
        body: { activeTools: [] },
      },
      secretBytes,
      hmacPort,
    );
    process.emitLine(bootstrapAck._unsafeUnwrap());
    await flush();
    const approvalRequest = await signEnvelope(
      {
        childId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 3,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: `${childId}-approval-0`,
        kind: "approval-request",
        body: {
          agentName: "shuttle",
          toolIdentity: "bash",
          requests: [{ summary: "allow?", unresolved: false }],
          allowedScopes: ["once", "session"],
        },
      },
      secretBytes,
      hmacPort,
    );
    process.emitLine(approvalRequest._unsafeUnwrap());
    await flush();
    expect(relayed).toEqual([
      { childId, correlationId: `${childId}-approval-0` },
    ]);

    const response = await controller.respondToApproval(
      childId,
      `${childId}-approval-0`,
      { scope: "once" },
    );
    expect(response.isOk()).toBe(true);
    controller.disposeAll();
  });

  it("respondToApproval fails closed for an unknown child id", async () => {
    const port = new FakeChildProcessPort();
    const controller = makeController(config(GENEROUS), port);
    const response = await controller.respondToApproval(
      "no-such-child",
      "corr-1",
      {},
    );
    expect(response.isErr()).toBe(true);
    expect(response._unsafeUnwrapErr().code).toBe("UiBridgeFailed");
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
          activeTools: [],
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
    const child = port.spawnedProcesses[0]!;
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
      summary: "ok",
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
          activeTools: [],
        }),
      },
    );
    void controller.delegate(request());
    await flush();
    const first = port.spawnedProcesses[0]!;
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
    // an independent/untracked one (Spec 33 §10-11).
    expect(port.spawnedProcesses.length).toBe(1);

    const settled = await signEnvelope(
      {
        childId: firstChildId,
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: 4,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: firstChildId,
        kind: "settled",
        body: { outcome: "completed", summary: "parent done" },
      },
      secret,
      hmacPort,
    );
    first.emitLine(settled._unsafeUnwrap());
    await flush();

    // Once the parent settles and frees the global budget, the queued
    // relayed request is promoted and spawned as a real grandchild.
    expect(port.spawnedProcesses.length).toBe(2);
    const grandchild = port.spawnedProcesses[1]!;
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
        activeTools: [],
      }),
    });
    void controller.delegate(request());
    await flush();
    const first = port.spawnedProcesses[0]!;
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
    const envelope = extractControlEnvelopeFromWritten(first);
    expect(envelope?.kind).toBe("delegate-response");
    expect(
      (envelope?.body as { ok: boolean; error?: string } | undefined)?.ok,
    ).toBe(false);
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
    const first = port.spawnedProcesses[0]!;
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
    const first = port.spawnedProcesses[0]!;
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
    const child = port.spawnedProcesses[0]!;
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
    const first = port.spawnedProcesses[0]!;
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

    await respondHandshakeAndSettle(port.spawnedProcesses[1]!, port, "gen-1");
    const secondResult = await secondPromise;
    expect(secondResult.isOk()).toBe(true);
    controller.disposeAll();
  });
});
