import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
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
  type PiChildOutputError,
  type PiChildOutputPort,
  PiChildRuntime,
} from "../child-runtime.js";
import { encodeDelegateRequestChunks } from "../delegate-request-chunking.js";
import type { JsonValue } from "../strict-json.js";
import type { PiEnvPort } from "../types.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

class FakeEnvPort implements PiEnvPort {
  readonly deleted: string[] = [];
  constructor(private readonly values: Map<string, string>) {}
  read(name: string): string | undefined {
    return this.values.get(name);
  }
  deleteValue(name: string): void {
    this.deleted.push(name);
    this.values.delete(name);
  }
}

class FakeOutputPort implements PiChildOutputPort {
  readonly lines: JsonValue[] = [];
  private nextError: PiChildOutputError | undefined;

  failNextWrite(error: PiChildOutputError): void {
    this.nextError = error;
  }

  writeLine(bytes: Uint8Array): ResultAsync<void, PiChildOutputError> {
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      return errAsync(error);
    }
    const text = new TextDecoder().decode(bytes);
    for (const line of text.split("\n")) {
      if (line.length > 0) this.lines.push(JSON.parse(line));
    }
    return okAsync(undefined);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function noopLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function childEnv(
  secretHex: string,
  childId = "child-1",
  generationId = "gen-1",
): Map<string, string> {
  return new Map([
    [WEAVE_CHILD_SECRET_ENV, secretHex],
    [WEAVE_CHILD_ID_ENV, childId],
    [WEAVE_CONTROLLER_GENERATION_ENV, generationId],
  ]);
}

async function buildActivatedRuntime() {
  const secretBytes = randomPort.randomBytes(32);
  const secretHex = bytesToHex(secretBytes);
  const env = new FakeEnvPort(childEnv(secretHex));
  const output = new FakeOutputPort();
  const runtime = new PiChildRuntime({
    envPort: env,
    randomPort,
    hmacPort,
    outputPort: output,
    logger: noopLogger(),
  });
  const _outcome = await runtime.start();
  return { runtime, env, output, secretBytes };
}

describe("PiChildRuntime.start", () => {
  it("returns not-a-child and never deletes anything when no bootstrap secret is present in the environment", async () => {
    const env = new FakeEnvPort(new Map());
    const output = new FakeOutputPort();
    const runtime = new PiChildRuntime({
      envPort: env,
      randomPort,
      hmacPort,
      outputPort: output,
      logger: noopLogger(),
    });
    const result = await runtime.start();
    expect(result._unsafeUnwrap()).toEqual({ kind: "not-a-child" });
    expect(env.deleted).toEqual([]);
    expect(runtime.isActivated()).toBe(false);
  });

  it("reads the secret from environment only, erases it immediately, and sends a signed handshake", async () => {
    const { runtime, env, output } = await buildActivatedRuntime();
    expect(env.deleted).toEqual([WEAVE_CHILD_SECRET_ENV]);
    expect(runtime.isActivated()).toBe(true);
    expect(runtime.getChildId()).toBe("child-1");
    expect(output.lines.length).toBe(1);
    const handshake = output.lines[0] as Record<string, unknown>;
    expect(handshake.kind).toBe("handshake");
    expect(handshake.direction).toBe("child-to-parent");
    expect(handshake.childId).toBe("child-1");
    expect(handshake.generationId).toBe("gen-1");
    expect(handshake.sequence).toBe(1);
  });

  it("fails closed with handshake-failed when the bootstrap environment is malformed", async () => {
    const env = new FakeEnvPort(
      new Map([
        [WEAVE_CHILD_SECRET_ENV, "not-valid-hex"],
        [WEAVE_CHILD_ID_ENV, "child-1"],
        [WEAVE_CONTROLLER_GENERATION_ENV, "gen-1"],
      ]),
    );
    const output = new FakeOutputPort();
    const runtime = new PiChildRuntime({
      envPort: env,
      randomPort,
      hmacPort,
      outputPort: output,
      logger: noopLogger(),
    });
    const result = await runtime.start();
    expect(result._unsafeUnwrap().kind).toBe("handshake-failed");
    expect(output.lines.length).toBe(0);
  });
});

describe("PiChildRuntime.admitControlLine", () => {
  it("silently ignores JSON that does not look like our own control envelope", async () => {
    const { runtime } = await buildActivatedRuntime();
    let bootstrapCalled = false;
    await runtime.admitControlLine(
      { type: "agent_start" },
      {
        onBootstrap: () => {
          bootstrapCalled = true;
        },
        onCancel: () => {},
      },
    );
    expect(bootstrapCalled).toBe(false);
  });

  it("admits a validly-signed bootstrap envelope from the parent and invokes onBootstrap with its body", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    const signed = await signEnvelope(
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
          composedPrompt: "You are Shuttle.",
          models: [],
          correlationId: "child-1",
          context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
        },
      },
      secretBytes,
      hmacPort,
    );
    let received: JsonValue | undefined;
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: (body) => {
          received = body;
        },
        onCancel: () => {},
      },
    );
    expect(received).toEqual({
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "You are Shuttle.",
      models: [],
      correlationId: "child-1",
      context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    });
  });

  it("dispatches a cancel envelope to onCancel", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    const signed = await signEnvelope(
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
    let cancelled = false;
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {},
        onCancel: () => {
          cancelled = true;
        },
      },
    );
    expect(cancelled).toBe(true);
  });

  it("isCancelled() reports false until a cancel envelope is admitted, then true (Task 9 finding 2)", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    expect(runtime.isCancelled()).toBe(false);
    const signed = await signEnvelope(
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
    // `admitControlLine` resolves only after envelope verification and
    // admission have actually run, so awaiting it is the deterministic wait
    // for this assertion. A fixed `flush()` merely hoped multi-tick WebCrypto
    // verification had finished by then.
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {},
        onCancel: () => {},
      },
    );
    expect(runtime.isCancelled()).toBe(true);
  });

  it("rejects (and never dispatches) an envelope signed with the wrong secret, and stops the runtime (fail closed, not merely log-and-continue)", async () => {
    const { runtime } = await buildActivatedRuntime();
    const wrongSecret = randomPort.randomBytes(32);
    const signed = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "bootstrap",
        body: { x: 1 },
      },
      wrongSecret,
      hmacPort,
    );
    let bootstrapCalled = false;
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {
          bootstrapCalled = true;
        },
        onCancel: () => {},
      },
    );
    expect(bootstrapCalled).toBe(false);
    expect(runtime.isActivated()).toBe(false);
  });

  it("rejects a replayed nonce (fail closed) rather than logging and continuing", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    const envelope = {
      childId: "child-1",
      generationId: "gen-1",
      direction: "parent-to-child" as const,
      sequence: 1,
      nonce: generateNonceHex(randomPort),
      correlationId: "child-1",
      kind: "cancel" as const,
      body: { reason: "first" },
    };
    const signed = await signEnvelope(envelope, secretBytes, hmacPort);
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {},
        onCancel: () => {},
      },
    );
    expect(runtime.isActivated()).toBe(true);

    // Same nonce, next sequence: this must be caught as a replay/sequence
    // violation and stop the runtime, not merely be logged.
    const replay = await signEnvelope(
      { ...envelope, sequence: 2 },
      secretBytes,
      hmacPort,
    );
    await runtime.admitControlLine(
      replay._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {},
        onCancel: () => {},
      },
    );
    expect(runtime.isActivated()).toBe(false);
  });

  it("admits a bootstrap exactly once - a second bootstrap is rejected and stops the runtime", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    let bootstrapCalls = 0;
    const handlers = {
      onBootstrap: () => {
        bootstrapCalls += 1;
      },
      onCancel: () => {},
    };
    const body = {
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "You are Shuttle.",
      models: [],
      correlationId: "child-1",
      context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
    };
    const first = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "bootstrap",
        body,
      },
      secretBytes,
      hmacPort,
    );
    await runtime.admitControlLine(
      first._unsafeUnwrap() as unknown as JsonValue,
      handlers,
    );
    expect(bootstrapCalls).toBe(1);

    const second = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 2,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "bootstrap",
        body,
      },
      secretBytes,
      hmacPort,
    );
    await runtime.admitControlLine(
      second._unsafeUnwrap() as unknown as JsonValue,
      handlers,
    );
    expect(bootstrapCalls).toBe(1);
    expect(runtime.isActivated()).toBe(false);
  });

  it("admits a cancel exactly once - a second cancel is rejected and stops the runtime", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    let cancelCalls = 0;
    const handlers = {
      onBootstrap: () => {},
      onCancel: () => {
        cancelCalls += 1;
      },
    };
    const makeCancel = (sequence: number) =>
      signEnvelope(
        {
          childId: "child-1",
          generationId: "gen-1",
          direction: "parent-to-child" as const,
          sequence,
          nonce: generateNonceHex(randomPort),
          correlationId: "child-1",
          kind: "cancel" as const,
          body: { reason: "stop" },
        },
        secretBytes,
        hmacPort,
      );
    const first = await makeCancel(1);
    // `admitControlLine` resolves only after envelope verification, admission
    // and the handler/dispose side effects have actually run, so awaiting it
    // is the deterministic wait for this assertion. A fixed `flush()` merely
    // hoped multi-tick WebCrypto verification had finished by then.
    await runtime.admitControlLine(
      first._unsafeUnwrap() as unknown as JsonValue,
      handlers,
    );
    expect(cancelCalls).toBe(1);

    const second = await makeCancel(2);
    await runtime.admitControlLine(
      second._unsafeUnwrap() as unknown as JsonValue,
      handlers,
    );
    expect(cancelCalls).toBe(1);
    expect(runtime.isActivated()).toBe(false);
  });

  it("fails closed on a malformed control body instead of dispatching it to the handler", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    let bootstrapCalled = false;
    const signed = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "bootstrap",
        // Missing required `composedPrompt`/`models` fields.
        body: { agentName: "shuttle" },
      },
      secretBytes,
      hmacPort,
    );
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {
          bootstrapCalled = true;
        },
        onCancel: () => {},
      },
    );
    expect(bootstrapCalled).toBe(false);
    expect(runtime.isActivated()).toBe(false);
  });

  it("fails closed on an illegal incoming kind that only a child may ever send (e.g. `settled` echoed back by a misbehaving parent)", async () => {
    const { runtime, secretBytes } = await buildActivatedRuntime();
    const signed = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "settled",
        body: { outcome: "completed", assistantOutput: "x" },
      },
      secretBytes,
      hmacPort,
    );
    await runtime.admitControlLine(
      signed._unsafeUnwrap() as unknown as JsonValue,
      {
        onBootstrap: () => {},
        onCancel: () => {},
      },
    );
    expect(runtime.isActivated()).toBe(false);
  });

  it("surfaces an outputPort write failure as a typed EnvelopeSignFailed result rather than throwing", async () => {
    const secretBytes = randomPort.randomBytes(32);
    const env = new FakeEnvPort(childEnv(bytesToHex(secretBytes)));
    const output = new FakeOutputPort();
    const runtime = new PiChildRuntime({
      envPort: env,
      randomPort,
      hmacPort,
      outputPort: output,
      logger: noopLogger(),
    });
    await runtime.start();
    output.failNextWrite({
      type: "ChildOutputWriteFailed",
      reason: "stdout-write-failed",
    });
    const result = await runtime.reportCancelled();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EnvelopeSignFailed");
  });
});

describe("PiChildRuntime.reportSettled / reportCancelled", () => {
  it("writes a settled envelope with the outcome and output", async () => {
    const { runtime, output } = await buildActivatedRuntime();
    const result = await runtime.reportSettled("completed", {
      assistantOutput: "done",
    });
    expect(result.isOk()).toBe(true);
    const settled = output.lines.at(-1) as Record<string, unknown>;
    expect(settled.kind).toBe("settled");
    expect(settled.body).toEqual({
      outcome: "completed",
      assistantOutput: "done",
    });
    // Sequence 1 was the handshake; this is sequence 2.
    expect(settled.sequence).toBe(2);
  });

  it("writes a cancelled envelope", async () => {
    const { runtime, output } = await buildActivatedRuntime();
    const result = await runtime.reportCancelled();
    expect(result.isOk()).toBe(true);
    expect((output.lines.at(-1) as Record<string, unknown>).kind).toBe(
      "cancelled",
    );
  });

  it("allows a settlement retry after a failed output write without skipping its authenticated sequence", async () => {
    const { runtime, output } = await buildActivatedRuntime();
    output.failNextWrite({
      type: "ChildOutputWriteFailed",
      reason: "stdout-write-failed",
    });

    const first = await runtime.reportSettled("completed", {
      assistantOutput: "ok",
    });
    expect(first.isErr()).toBe(true);
    expect(output.lines).toHaveLength(1);

    const second = await runtime.reportSettled("completed", {
      assistantOutput: "ok",
    });
    expect(second.isOk()).toBe(true);
    expect(output.lines).toHaveLength(2);
    expect((output.lines.at(-1) as Record<string, unknown>).sequence).toBe(2);
  });

  it("reports settlement exactly once - a second call is rejected rather than sending a duplicate envelope", async () => {
    const { runtime, output } = await buildActivatedRuntime();
    const first = await runtime.reportSettled("completed", {
      assistantOutput: "ok",
    });
    expect(first.isOk()).toBe(true);
    const linesAfterFirst = output.lines.length;

    const second = await runtime.reportSettled("failed", { reason: "late" });
    expect(second.isErr()).toBe(true);
    expect(second._unsafeUnwrapErr().type).toBe("EnvelopeSignFailed");
    expect(output.lines.length).toBe(linesAfterFirst);
  });
});

describe("PiChildRuntime.requestDelegation", () => {
  it("sends and resolves a nested task larger than one control envelope", async () => {
    const { runtime, output, secretBytes } = await buildActivatedRuntime();
    const task = `nested-🙂\n${"x".repeat(1_100_000)}`;

    const expectedChunkCount = encodeDelegateRequestChunks(
      task,
      "count-only",
      "shuttle",
    )._unsafeUnwrap().length;
    const request = runtime.requestDelegation({
      agentName: "shuttle",
      task,
    });
    for (
      let attempt = 0;
      attempt < 100 && output.lines.length < expectedChunkCount + 1;
      attempt += 1
    ) {
      await flush();
    }

    const chunks = output.lines.slice(1) as Array<Record<string, unknown>>;
    expect(chunks.length).toBe(expectedChunkCount);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe("delegate-request-chunk");
      expect(JSON.stringify(chunk).length).toBeLessThan(64 * 1024);
    }
    const correlationId = chunks[0]?.correlationId;
    expect(typeof correlationId).toBe("string");

    const response = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "parent-to-child",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: correlationId as string,
        kind: "delegate-response",
        body: {
          ok: true,
          settlement: { outcome: "completed", assistantOutput: "done" },
        },
      },
      secretBytes,
      hmacPort,
    );
    await runtime.admitControlLine(
      response._unsafeUnwrap() as unknown as JsonValue,
      { onBootstrap: () => {}, onCancel: () => {} },
    );

    expect((await request)._unsafeUnwrap()).toEqual({
      ok: true,
      settlement: { outcome: "completed", assistantOutput: "done" },
    });
  });
});

describe("PiChildRuntime.dispose", () => {
  it("clears the runtime's secret reference, is idempotent, and blocks any further signed control message", async () => {
    const { runtime } = await buildActivatedRuntime();
    runtime.dispose();
    expect(runtime.isActivated()).toBe(false);
    expect(() => runtime.dispose()).not.toThrow();
    const result = await runtime.reportSettled("failed", {
      reason: "disposed",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EnvelopeSignFailed");
  });
});
