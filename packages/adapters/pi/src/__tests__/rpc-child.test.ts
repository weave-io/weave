import { describe, expect, it } from "bun:test";
import { ResultAsync } from "neverthrow";
import {
  generateNonceHex,
  type HmacError,
  type HmacPort,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import type { JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
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

/**
 * A schema-valid bootstrap body (Spec 33 §11.2 Task 9): every test that
 * exercises `runTask()` beyond the bootstrap-ack wait itself needs one,
 * since `runTask()` now re-parses its own `bootstrap` argument up front
 * and fails closed on anything malformed - these tests are not testing
 * that particular gate, so they get a valid fixture by default.
 */
function validBootstrap(overrides: Record<string, unknown> = {}): JsonValue {
  return {
    agentName: "shuttle",
    composedPrompt: "You are Shuttle.",
    models: [],
    correlationId: "child-1",
    context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    activeTools: [],
    ...overrides,
  } as JsonValue;
}

/** A schema-valid bootstrap-ack body (Spec 33 §11.2 Task 9) - `runTask()` validates it against the `bootstrap` it sent before proceeding to task work. */
function validAck(overrides: Record<string, unknown> = {}): JsonValue {
  return { activeTools: [], ...overrides } as JsonValue;
}

/** Plays the part of a well-behaved (or malicious, per test) child process. */
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
    sequenceOverride?: number,
  ) {
    const sequence = sequenceOverride ?? this.sequence++;
    const envelope = await signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "child-to-parent",
        sequence,
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

/**
 * Wraps a real `HmacPort` but artificially delays only its `signHex`
 * (the parent's own *outbound* signing), leaving `verifyHex` (verifying
 * the child's incoming replies) untouched. Used to construct a
 * deterministic "the child replies faster than our own outbound signing
 * finishes" race, proving the resolver is installed *before* the send
 * rather than after it (install-before-send composition).
 */
class DelayedSignHmacPort implements HmacPort {
  constructor(
    private readonly inner: HmacPort,
    private readonly delayMs: number,
  ) {}

  signHex(key: Uint8Array, data: Uint8Array): ResultAsync<string, HmacError> {
    return new ResultAsync(
      new Promise((resolve) => {
        setTimeout(() => {
          this.inner.signHex(key, data).then(resolve);
        }, this.delayMs);
      }),
    );
  }

  verifyHex(
    key: Uint8Array,
    data: Uint8Array,
    expectedMacHex: string,
  ): ResultAsync<boolean, HmacError> {
    return this.inner.verifyHex(key, data, expectedMacHex);
  }
}

function flushMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSecretFromSpawn(port: FakeChildProcessPort): Uint8Array {
  const hex = port.spawnInputs.at(-1)?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("test setup: secret env missing");
  const bytes = hexToBytes(hex);
  if (bytes === undefined) throw new Error("test setup: malformed secret hex");
  return bytes;
}

/** Real WebCrypto signing resolves across more than one microtask tick; a macrotask boundary reliably flushes it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function extractControlEnvelopeFromPrompt(line: unknown): JsonValue {
  const record = line as { type: string; message: string };
  expect(record.type).toBe("prompt");
  const prefix = "/weave:__control__ ";
  expect(record.message.startsWith(prefix)).toBe(true);
  return JSON.parse(record.message.slice(prefix.length));
}

describe("PiRpcChild", () => {
  it("passes the secret only via environment, never argv/prompt, and completes the handshake before returning", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });

    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    expect(spawned).toBeDefined();
    const spawnInput = processPort.spawnInputs[0];
    expect(spawnInput.command).toEqual(["pi", "--mode", "rpc", "--no-session"]);
    expect(Object.keys(spawnInput.env)).toContain(WEAVE_CHILD_SECRET_ENV);

    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);

    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);
    // Handshake alone does not yet mean "running": the child must still
    // prove it applied the bootstrap descriptor via bootstrap-ack before
    // any work is sent (Spec 33 §11.3/§11.5).
    expect(child.snapshot().status).toBe("handshaking");
  });

  it("never sends an RPC steer or follow_up command; only prompt and abort", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "done" },
      secretBytes,
    );
    await runPromise;

    for (const line of spawned.writtenLines()) {
      const record = line as Record<string, unknown>;
      expect(record.type === "prompt" || record.type === "abort").toBe(true);
    }
  });

  it("delivers the bootstrap payload through an ordinary prompt command as a hidden control envelope, never a raw sideband", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    let lines = spawned.writtenLines();
    const bootstrapEnvelope = extractControlEnvelopeFromPrompt(lines[0]) as {
      kind: string;
    };
    expect(bootstrapEnvelope.kind).toBe("bootstrap");
    // No task work is sent until the child proves it applied the bootstrap.
    expect(lines.length).toBe(1);

    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    lines = spawned.writtenLines();
    const taskLine = lines[1] as { type: string; message: string };
    expect(taskLine).toEqual({ type: "prompt", message: "do the thing" });

    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "done" },
      secretBytes,
    );
    const settlement = await runPromise;
    expect(settlement.isOk()).toBe(true);
    expect(settlement._unsafeUnwrap()).toEqual({
      outcome: "completed",
      summary: "done",
    });
  });

  it("relays the child's own approval-request to the caller-supplied callback, and delivers the caller's approval-response back to it", async () => {
    const processPort = new FakeChildProcessPort();
    const relayed: {
      childId: string;
      correlationId: string;
      request: JsonValue;
    }[] = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      onApprovalRequest: (childId, correlationId, request) => {
        relayed.push({ childId, correlationId, request });
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;
    // Approval requests are only accepted once the child is actually
    // running - i.e. after it has proved bootstrap application via an
    // authenticated `bootstrap-ack` (Spec 33 §11.3/§11.5).
    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();

    const approvalRequestBody = {
      agentName: "shuttle",
      toolIdentity: "bash",
      requests: [{ summary: "allow bash?", unresolved: false }],
      allowedScopes: ["once", "session"],
    };
    await responder.send(
      "approval-request",
      "child-1-approval-0",
      approvalRequestBody,
      secretBytes,
    );
    await flush();
    expect(relayed).toEqual([
      {
        childId: "child-1",
        correlationId: "child-1-approval-0",
        request: approvalRequestBody,
      },
    ]);

    const responseResult = await child.sendApprovalResponse(
      "child-1-approval-0",
      {
        scope: "once",
      },
    );
    expect(responseResult.isOk()).toBe(true);
    const lines = spawned.writtenLines();
    const responseEnvelope = extractControlEnvelopeFromPrompt(lines.at(-1)) as {
      kind: string;
      correlationId: string;
      body: JsonValue;
    };
    expect(responseEnvelope.kind).toBe("approval-response");
    expect(responseEnvelope.correlationId).toBe("child-1-approval-0");
    expect(responseEnvelope.body).toEqual({ scope: "once" });

    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "done" },
      secretBytes,
    );
    await runPromise;
  });

  it("projects settled per-message usage once and deduplicates by message id", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const usageEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        id: "msg-1",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: 0.02 },
        },
      },
    };
    spawned.emitLine(usageEvent);
    spawned.emitLine(usageEvent); // duplicate id -> must not double count
    expect(child.snapshot().usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      cost: 0.02,
    });
  });

  it("times out the handshake when the child never authenticates, without hanging", async () => {
    const processPort = new FakeChildProcessPort();
    let scheduled: (() => void) | undefined;
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          scheduled = cb;
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    expect(scheduled).toBeDefined();
    scheduled?.();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildHandshakeMissing");
  });

  it("times out settlement when the child never reports completion", async () => {
    const processPort = new FakeChildProcessPort();
    const timers: Array<() => void> = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          timers.push(cb);
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    // Resolve handshake via its own scheduled timer slot (index 0).
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    // Resolve the bootstrap-ack wait first (its own scheduled timer slot),
    // so the child actually reaches the settlement-awaiting phase before we
    // fire the settlement timeout itself.
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    const settlementTimer = timers.at(-1);
    settlementTimer?.();
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildSettlementMissing");
  });

  it("stops the child on a replayed nonce (fail-closed authentication)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    const handshakeEnvelope = await responder.send(
      "handshake",
      "child-1",
      {},
      secretBytes,
    );
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    // Replays the exact same (already-consumed) envelope again under the guise of settlement sequence 2.
    spawned.emitLine({ ...handshakeEnvelope, kind: "settled", sequence: 2 });
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
  });

  it("rejects a settlement whose sequence is out of order (replay/late/cross-generation fail closed)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    // Jumps straight to sequence 5 instead of the expected 2.
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "x" },
      secretBytes,
      5,
    );
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
  });

  it("rejects an envelope from a different childId or generationId (cross-child/cross-generation fail closed)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const foreignResponder = new ScriptedChildResponder(
      spawned,
      "some-other-child",
      "gen-1",
    );
    await foreignResponder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildEnvelopeMalformed");
  });

  it("treats an unauthenticated (unsigned/garbage) line as ignorable noise, never as an authenticated message", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    spawned.emitLine({ type: "agent_start" }); // ordinary RPC event, not a control envelope
    spawned.emitLine({ garbage: true });
    expect(child.snapshot().status).toBe("handshaking");

    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);
  });

  it("cancels via an authenticated envelope plus the ordinary abort command, and cleans up idempotently", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const cancelPromise = child.cancel();
    await flush();
    const lines = spawned.writtenLines();
    expect(
      lines.some((line) => (line as { type: string }).type === "abort"),
    ).toBe(true);
    await responder.send("cancelled", "child-1", {}, secretBytes);
    await cancelPromise;

    child.dispose();
    child.dispose(); // idempotent
    expect(spawned.killed).toBe(true);
  });

  it("clears the secret reference on every terminal path, including spawn failure", async () => {
    const processPort = new FakeChildProcessPort();
    processPort.failNextSpawn({ type: "SpawnFailed", reason: "boom" });
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const result = await child.spawnAndHandshake(baseSpawnInput());
    expect(result.isErr()).toBe(true);
    child.dispose();
    expect(child.isDisposed()).toBe(true);
  });

  it("kills the process and erases the secret when the handshake times out, while preserving the failed status", async () => {
    const processPort = new FakeChildProcessPort();
    let scheduled: (() => void) | undefined;
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          scheduled = cb;
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    scheduled?.();
    const result = await spawnPromise;
    expect(result.isErr()).toBe(true);
    expect(child.snapshot().status).toBe("failed");
    expect(child.isDisposed()).toBe(true);
    expect(spawned.killed).toBe(true);
    // Cleanup must be idempotent and must never clobber the preserved
    // "failed" status back to "cancelled".
    child.dispose();
    expect(child.snapshot().status).toBe("failed");
  });

  it("kills the process and erases the secret when bootstrap-ack times out, while preserving the failed status", async () => {
    const processPort = new FakeChildProcessPort();
    const timers: Array<() => void> = [];
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      timerPort: {
        schedule: (cb) => {
          timers.push(cb);
          return { cancel: () => {} };
        },
      },
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    const bootstrapAckTimer = timers.at(-1);
    bootstrapAckTimer?.();
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildReplyMissing");
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.killed).toBe(true);
    expect(child.isDisposed()).toBe(true);
  });

  it("kills the process and erases the secret on a successful settlement too, not only on failure", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
    expect(spawned.killed).toBe(true);
    expect(child.isDisposed()).toBe(true);
    expect(child.snapshot().status).toBe("completed");
  });

  it("does not drop a bootstrap-ack that wins the race against the parent's own (slower) outbound signing - install-before-send", async () => {
    const processPort = new FakeChildProcessPort();
    const slowHmac = new DelayedSignHmacPort(hmacPort, 75);
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort: slowHmac,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    // The child's own replies are signed with the plain, fast, real port -
    // only the parent's *own* outbound `bootstrap` signing is slow.
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    // Deliver the ack immediately - well before the delayed outbound
    // `bootstrap` signing (75ms) could possibly have finished. Under the
    // old "install the resolver only after the send resolves" ordering,
    // this would be dispatched while no resolver exists yet and fail with
    // ChildReplyLate. Under install-before-send it must always be caught.
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flushMs(150);
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
  });

  it("does not drop a settlement delivered immediately after bootstrap-ack, with no intervening flush", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    // No extra flush before settlement: the settlement resolver must
    // already be installed by the time the task prompt is sent, since it is
    // installed in the same synchronous step that sends the prompt.
    await responder.send(
      "settled",
      "child-1",
      { outcome: "completed", summary: "done" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isOk()).toBe(true);
  });

  it("fails closed on an unknown/illegal incoming kind (a parent-to-child-only kind echoed back by a misbehaving child)", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    const runPromise = child.runTask(baseSpawnInput(), validBootstrap());
    await flush();
    await responder.send("bootstrap-ack", "child-1", validAck(), secretBytes);
    await flush();
    // "approval-response" is a parent-to-child-only kind; a child sending
    // it back is always illegal and must fail closed.
    await responder.send(
      "approval-response",
      "child-1",
      { scope: "once" },
      secretBytes,
    );
    const result = await runPromise;
    expect(result.isErr()).toBe(true);
    expect(child.isDisposed()).toBe(true);
    expect(spawned.killed).toBe(true);
  });

  it("fails closed on a `cancelled` envelope that arrives while no cancellation is in flight", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);

    await responder.send("cancelled", "child-1", {}, secretBytes);
    await flush();
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.killed).toBe(true);
  });

  it("clamps negative and non-finite usage fields to zero rather than propagating them", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.emitLine({
      type: "message_end",
      message: {
        role: "assistant",
        id: "msg-1",
        usage: {
          input: -10,
          output: Number.POSITIVE_INFINITY,
          cacheRead: Number.NaN,
          cacheWrite: -1,
          cost: { total: -5 },
        },
      },
    });
    expect(child.snapshot().usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });
  });

  it("accumulates streamed message_update deltas into the bounded latest-output buffer instead of replacing it with only the last delta", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.emitLine({ type: "message_update", delta: { text: "hello " } });
    spawned.emitLine({ type: "message_update", delta: { text: "world" } });
    expect(child.snapshot().latestOutput).toBe("hello world");

    // A new turn starts a fresh transient buffer rather than carrying the
    // previous turn's trailing text forward forever.
    spawned.emitLine({ type: "turn_start" });
    expect(child.snapshot().latestOutput).toBe("");
    spawned.emitLine({
      type: "message_update",
      delta: { text: "second turn" },
    });
    expect(child.snapshot().latestOutput).toBe("second turn");
  });

  it("observes the process's own real exit code rather than relying only on stdout ending", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    const result = await spawnPromise;
    expect(result.isOk()).toBe(true);

    // The process exits with a real, nonzero code without ever ending its
    // stdout stream first - the exit-code observer alone must catch this.
    spawned.exit(17);
    await flush();
    expect(child.snapshot().status).toBe("failed");
    expect(spawned.killed).toBe(true);
  });

  it("fails closed (and does not hang) when the process's stdout read fails", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
    });
    const spawnPromise = child.spawnAndHandshake(baseSpawnInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, "child-1", "gen-1");
    await responder.send("handshake", "child-1", {}, secretBytes);
    await spawnPromise;

    spawned.failStdoutRead("child-process-read-failed");
    expect(child.snapshot().status).toBe("failed");
    expect(child.isDisposed()).toBe(true);
  });
});
