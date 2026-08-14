/**
 * The child result contract (Pi adapter contract §10).
 *
 * A delegated child is only successful once the parent has observed a terminal
 * assistant response holding non-whitespace text. Empty, whitespace-only,
 * thinking-only and tool-only completions are `ChildResponseMissing`: a
 * retryable *result* failure, not a transport one. The transcript survives it
 * intact and capacity is released exactly as it is for a valid completion.
 */
import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { ok } from "neverthrow";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { WEAVE_CHILD_ID_ENV, WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import { SystemTimerPort } from "../child-timer.js";
import {
  PiDelegationController,
  type PiDelegationRequest,
} from "../delegation-controller.js";
import { PiRpcChild } from "../rpc-child.js";
import type { JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

/** A drain short enough to keep the suite fast, long enough to be a real wait. */
const DRAIN_MS = 5;

function noopLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function flushMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function spawnInput() {
  return {
    childId: "child-1",
    parentId: "root",
    generationId: "gen-1",
    agentName: "shuttle",
    depth: 1,
    cwd: "/project",
    env: {},
    task: "do the thing",
  };
}

function bootstrap() {
  return {
    mode: "ordinary" as const,
    agentName: "shuttle",
    composedPrompt: "You are Shuttle.",
    models: [],
    correlationId: "child-1",
    context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
  };
}

/** A terminal assistant response that satisfies the contract. */
function assistantMessage(text: string): JsonValue {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

class Responder {
  private sequence = 0;
  constructor(
    private readonly process: FakeSpawnedProcess,
    private readonly childId: string,
    private readonly generationId: string,
  ) {}

  async send(
    kind: PiControlKind,
    body: JsonValue,
    secret: Uint8Array,
  ): Promise<void> {
    this.sequence += 1;
    const envelope = await signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "child-to-parent",
        sequence: this.sequence,
        nonce: Buffer.from(randomPort.randomBytes(16)).toString("hex"),
        correlationId: this.childId,
        kind,
        body,
      },
      secret,
      hmacPort,
    );
    if (envelope.isErr()) throw new Error("test setup: signing failed");
    this.process.emitLine(envelope.value);
  }
}

interface RunningChild {
  readonly child: PiRpcChild;
  readonly spawned: FakeSpawnedProcess;
  readonly responder: Responder;
  readonly secret: Uint8Array;
  readonly observed: PiChildSessionEvent[];
  readonly runPromise: ReturnType<PiRpcChild["runTask"]>;
}

async function startRunningChild(): Promise<RunningChild> {
  const processPort = new FakeChildProcessPort();
  const observed: PiChildSessionEvent[] = [];
  const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
    processPort,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    randomPort,
    hmacPort,
    logger: noopLogger(),
    responseDrainMs: DRAIN_MS,
    sessionObserver: {
      onEvent: (event) => {
        observed.push(event);
        return ok(undefined);
      },
    },
  });
  const spawnPromise = child.spawnAndHandshake(spawnInput());
  await flush();
  const spawned = processPort.spawnedProcesses[0];
  if (spawned === undefined) throw new Error("test setup: child not spawned");
  const hex = processPort.spawnInputs.at(-1)?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("test setup: no child secret");
  const secret = hexToBytes(hex);
  const responder = new Responder(spawned, "child-1", "gen-1");
  await responder.send("handshake", {}, secret);
  expect((await spawnPromise).isOk()).toBe(true);
  const runPromise = child.runTask(spawnInput(), bootstrap());
  await flush();
  await responder.send("bootstrap-ack", {}, secret);
  await flush();
  return { child, spawned, responder, secret, observed, runPromise };
}

/** Every settlement in these tests claims success; only the events differ. */
function completedBody(): JsonValue {
  return { outcome: "completed", assistantOutput: "control-summary" };
}

describe("child result contract (Pi adapter contract §10)", () => {
  it("completes with the exact bounded terminal assistant response", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine(assistantMessage("the real answer"));
    await running.responder.send("settled", completedBody(), running.secret);

    const settlement = (await running.runPromise)._unsafeUnwrap();
    expect(settlement).toEqual({
      outcome: "completed",
      assistantOutput: "the real answer",
      interventionCount: 0,
    });
    running.child.dispose();
  });

  it("fails a whitespace-only response as retryable ChildResponseMissing", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine(assistantMessage("   \n\t  "));
    await running.responder.send("settled", completedBody(), running.secret);

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    expect(failure.retryable).toBe(true);
    expect(failure.recovery).toBe("retry");
    expect(failure.phase).toBe("completion");
    expect(failure.correlation).toEqual({
      reason: "whitespace-only",
      childId: "child-1",
      parentId: "root",
      correlationId: "child-1",
    });
    running.child.dispose();
  });

  it("fails a thinking-only turn as retryable ChildResponseMissing", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine({
      type: "thinking",
      text: "a very long chain of reasoning that is not an answer",
    });
    await flush();
    await running.responder.send("settled", completedBody(), running.secret);

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    expect(failure.retryable).toBe(true);
    expect(failure.correlation?.reason).toBe("thinking-only");
    // Length never substitutes for a response.
    expect(running.observed.some((event) => event.type === "thinking")).toBe(
      true,
    );
    running.child.dispose();
  });

  it("fails a tool-only turn as retryable ChildResponseMissing", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read",
    });
    running.spawned.emitLine({
      type: "tool_result",
      toolCallId: "call-1",
      result: { bytes: 4096 },
    });
    await flush();
    await running.responder.send("settled", completedBody(), running.secret);

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    expect(failure.retryable).toBe(true);
    expect(failure.correlation?.reason).toBe("tool-only");
    running.child.dispose();
  });

  it("fails a completion with no response at all as ChildResponseMissing", async () => {
    const running = await startRunningChild();
    await running.responder.send("settled", completedBody(), running.secret);

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    expect(failure.retryable).toBe(true);
    expect(failure.correlation?.reason).toBe("no-response");
    running.child.dispose();
  });

  it("does not let nonempty control assistantOutput alone satisfy the contract", async () => {
    const running = await startRunningChild();
    await running.responder.send(
      "settled",
      { outcome: "completed", assistantOutput: "control-only summary" },
      running.secret,
    );

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    expect(failure.retryable).toBe(true);
    expect(failure.correlation?.reason).toBe("no-response");
    running.child.dispose();
  });

  it("does not let nonempty completionCandidate alone satisfy the contract", async () => {
    const running = await startRunningChild();
    await running.responder.send(
      "settled",
      {
        outcome: "completed",
        completionCandidate: JSON.stringify({
          outcome: "success",
          message: "workflow-candidate-only",
        }),
      },
      running.secret,
    );

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    expect(failure.retryable).toBe(true);
    expect(failure.correlation?.reason).toBe("no-response");
    // CompletionSignalMissing remains owned by structured completion; this
    // path must stay ChildResponseMissing.
    expect(failure.code).not.toBe("CompletionSignalMissing");
    running.child.dispose();
  });

  it("completes only from parser-approved terminal assistant text", async () => {
    const running = await startRunningChild();
    await running.responder.send(
      "settled",
      {
        outcome: "completed",
        assistantOutput: "control-summary",
        completionCandidate: JSON.stringify({
          outcome: "success",
          message: "candidate-must-not-bypass",
        }),
      },
      running.secret,
    );
    // Still draining: control fields alone never finish the run.
    expect(running.child.snapshot().status).toBe("running");
    running.spawned.emitLine(assistantMessage("parser-approved answer"));

    const settlement = (await running.runPromise)._unsafeUnwrap();
    expect(settlement).toEqual({
      outcome: "completed",
      assistantOutput: "parser-approved answer",
      completionCandidate: JSON.stringify({
        outcome: "success",
        message: "candidate-must-not-bypass",
      }),
      interventionCount: 0,
    });
    running.child.dispose();
  });

  it("waits for a terminal response delivered after its own settlement", async () => {
    const running = await startRunningChild();
    // Out-of-order delivery inside the supported protocol window: the
    // authenticated settlement lands before the final assistant message.
    await running.responder.send("settled", completedBody(), running.secret);
    running.spawned.emitLine(assistantMessage("late but real"));

    const settlement = (await running.runPromise)._unsafeUnwrap();
    expect(settlement).toEqual({
      outcome: "completed",
      assistantOutput: "late but real",
      interventionCount: 0,
    });
    running.child.dispose();
  });

  it("classifies only after the drain window, never on the first missing event", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read",
    });
    await running.responder.send("settled", completedBody(), running.secret);
    // Still undecided while the window is open.
    expect(running.child.snapshot().status).toBe("running");
    await flushMs(DRAIN_MS * 6);

    const failure = (await running.runPromise)._unsafeUnwrapErr();
    expect(failure.code).toBe("ChildResponseMissing");
    running.child.dispose();
  });

  it("preserves every parser-approved session event for a missing response", async () => {
    const running = await startRunningChild();
    running.spawned.emitLine({ type: "turn_start" });
    running.spawned.emitLine({ type: "thinking", text: "deliberating" });
    running.spawned.emitLine({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read",
    });
    running.spawned.emitLine(assistantMessage(" "));
    await flush();
    const beforeSettlement = running.observed.map((event) => event.type);
    await running.responder.send("settled", completedBody(), running.secret);

    expect((await running.runPromise).isErr()).toBe(true);
    // The transcript is never deleted, truncated, or rewritten by the failure.
    expect(running.observed.map((event) => event.type)).toEqual(
      beforeSettlement,
    );
    expect(beforeSettlement).toEqual([
      // `turn_start` has no schema of its own, so the parser preserves it as a
      // bounded `unknown` event rather than discarding it.
      "unknown",
      "thinking",
      "tool_call",
      "message_end",
    ]);
    running.child.dispose();
  });

  it("kills the process and erases the secret on a missing response", async () => {
    const running = await startRunningChild();
    await running.responder.send("settled", completedBody(), running.secret);

    expect((await running.runPromise).isErr()).toBe(true);
    expect(running.spawned.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capacity: a settled child releases `max_children` whatever its outcome.
// ---------------------------------------------------------------------------

function config(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

class SequentialIdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `child-${this.counter}`;
  }
}

function delegationRequest(): PiDelegationRequest {
  return {
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "shuttle",
    agentName: "shuttle",
    task: "do the thing",
    cwd: "/project",
    env: {},
    bootstrap: bootstrap(),
  };
}

function spawnedAt(
  port: FakeChildProcessPort,
  index: number,
): FakeSpawnedProcess {
  const process = port.spawnedProcesses[index];
  if (process === undefined)
    throw new Error(`test setup: missing spawned process ${index}`);
  return process;
}

function childSecret(
  port: FakeChildProcessPort,
  index: number,
): { childId: string; secret: Uint8Array } {
  const input = port.spawnInputs[index];
  const hex = input?.env[WEAVE_CHILD_SECRET_ENV];
  const childId = input?.env[WEAVE_CHILD_ID_ENV];
  if (hex === undefined || childId === undefined)
    throw new Error("test setup: no child identity in spawn env");
  return { childId, secret: hexToBytes(hex) };
}

async function driveToRunning(
  port: FakeChildProcessPort,
  index: number,
): Promise<{
  process: FakeSpawnedProcess;
  responder: Responder;
  secret: Uint8Array;
}> {
  const process = spawnedAt(port, index);
  const { childId, secret } = childSecret(port, index);
  const responder = new Responder(process, childId, "gen-1");
  await responder.send("handshake", {}, secret);
  await flush();
  await responder.send("bootstrap-ack", {}, secret);
  await flush();
  await flush();
  return { process, responder, secret };
}

describe("child result contract capacity release", () => {
  it("releases max_children capacity after a ChildResponseMissing drain", async () => {
    const port = new FakeChildProcessPort();
    const controller = new PiDelegationController({
      config: config(
        "settings {\n  delegation {\n    max_children 1\n    max_concurrency 1\n    max_depth 2\n    max_processes 4\n  }\n}\nagent shuttle {\n}\n",
      ),
      generationId: "gen-1",
      idGenerator: new SequentialIdGenerator(),
      logger: noopLogger(),
      processPort: port,
      sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      randomPort,
      hmacPort,
      timerPort: new SystemTimerPort(),
      cancelGraceMs: 10,
      responseDrainMs: DRAIN_MS,
    });

    const first = controller.delegate(delegationRequest());
    await flush();
    const firstChild = await driveToRunning(port, 0);
    // No assistant text at all: a completed settlement that fails the contract.
    await firstChild.responder.send(
      "settled",
      completedBody(),
      firstChild.secret,
    );
    const firstResult = await first;
    expect(firstResult._unsafeUnwrapErr().code).toBe("ChildResponseMissing");

    // Capacity is a parallel budget, not a cumulative history: the settled
    // child released its slot, so the next delegation spawns.
    const second = controller.delegate(delegationRequest());
    await flush();
    expect(port.spawnedProcesses.length).toBe(2);
    const secondChild = await driveToRunning(port, 1);
    secondChild.process.emitLine(assistantMessage("second answer"));
    await flush();
    await secondChild.responder.send(
      "settled",
      completedBody(),
      secondChild.secret,
    );
    const secondResult = await second;
    expect(secondResult._unsafeUnwrap().outcome).toBe("completed");
    controller.disposeAll();
  });
});
