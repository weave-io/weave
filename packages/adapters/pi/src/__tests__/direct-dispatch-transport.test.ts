import { describe, expect, it } from "bun:test";
import {
  generateNonceHex,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import type { PiDirectDispatchInput } from "../direct-dispatch.js";
import {
  createDirectDispatchTransport,
  PiDirectStepChildRegistry,
} from "../direct-dispatch-transport.js";
import type { JsonValue } from "../strict-json.js";
import { serializeCompletionCandidate } from "../structured-completion.js";
import type { PiAdapterLogger } from "../types.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import { FakeIdGenerator } from "./fakes/fake-pi-host.js";

/**
 * Regression coverage for the live exact-host direct-dispatch bootstrap
 * timeout (issue #21 Task 12): `createDirectDispatchTransport` generates
 * its own authenticated `childId` for `PiRpcChild`, but the bootstrap body
 * it sent placed the caller's own, unrelated engine-level
 * `PiDirectDispatchInput.correlationId` (`dispatchEffect.runAgent.correlationId`,
 * `PiWorkflowController`'s own effect/audit correlation, Spec 33 §14) into
 * the bootstrap's `correlationId` field instead. `applyChildBootstrap`
 * requires `parsed.correlationId === state.childId` (the child's own
 * env-derived authenticated identity, Spec 33 §11.2 Task 9) and fails
 * closed - disposing the runtime without ever sending a `bootstrap-ack` -
 * on any mismatch, so every direct-step dispatch (workflow steps) failed
 * closed while ordinary delegation (whose `buildChildBootstrapBody` always
 * used the generated `childId`) never exhibited this defect.
 */

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

function noopLogger(): PiAdapterLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function extractSecretFromSpawn(port: FakeChildProcessPort): Uint8Array {
  const hex = port.spawnInputs.at(-1)?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("test setup: secret env missing");
  const bytes = hexToBytes(hex);
  if (bytes === undefined) throw new Error("test setup: malformed secret hex");
  return bytes;
}

function extractControlEnvelopeFromPrompt(line: unknown): {
  readonly kind: string;
  readonly correlationId: string;
  readonly body: {
    readonly correlationId?: string;
    readonly activeTools?: readonly string[];
    readonly resolvedModel?: unknown;
  };
} {
  const record = line as { type: string; message: string };
  expect(record.type).toBe("prompt");
  const prefix = "/weave:__control__ ";
  expect(record.message.startsWith(prefix)).toBe(true);
  return JSON.parse(record.message.slice(prefix.length));
}

/** Plays the part of a well-behaved direct-step child process. */
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

function baseInput(
  overrides: Partial<PiDirectDispatchInput> = {},
): PiDirectDispatchInput {
  return {
    workflowInstanceId: "wf-1",
    leaseId: "lease-1",
    stepName: "verify",
    agentName: "smoke-child",
    composedPrompt: "Call weave_complete_step exactly once.",
    cwd: "/project",
    // Deliberately different from the transport's own generated `childId`
    // (Spec 33 §14's engine-level effect correlation), so the assertion
    // below cannot pass by accident if the two were ever conflated again.
    correlationId: "engine-effect-correlation-unrelated",
    models: ["anthropic/claude-sonnet-5"],
    effectiveToolPolicy: {
      read: "allow",
      write: "ask",
      execute: "deny",
      delegate: "deny",
      network: "deny",
    },
    delegationTargets: [],
    ...overrides,
  };
}

const AVAILABLE_MODELS = [{ provider: "anthropic", id: "claude-sonnet-5" }];

describe("createDirectDispatchTransport (Spec 33 §11.2, §14, §15)", () => {
  it("bootstraps the direct-step child using its own generated childId as the control-envelope correlationId, never the caller's unrelated engine-level correlationId", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );

    const resultPromise = transport(baseInput());
    await flush();

    const spawned = processPort.spawnedProcesses[0];
    expect(spawned).toBeDefined();
    // The transport builds `childId` as
    // `direct-${workflowInstanceId}-${stepName}-${idGenerator.next()}`; the
    // fake id generator deterministically returns `generation-1` on its
    // first call.
    const expectedChildId = "direct-wf-1-verify-generation-1";
    expect(processPort.spawnInputs.at(-1)?.command).toBeDefined();

    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    // The transport's own bootstrap-body construction (HMAC signing) takes
    // one additional microtask/macrotask turn beyond the handshake reply
    // itself, so this awaits two ticks rather than one.
    await flush();
    await flush();

    const lines = spawned.writtenLines();
    const bootstrapEnvelope = extractControlEnvelopeFromPrompt(lines[0]);
    expect(bootstrapEnvelope.kind).toBe("bootstrap");
    // The envelope's own top-level `correlationId` (child-authentication
    // correlation) and the bootstrap body's `correlationId` (what
    // `applyChildBootstrap` actually validates against `state.childId`)
    // must both equal the generated `childId` - never
    // `baseInput().correlationId`.
    expect(bootstrapEnvelope.correlationId).toBe(expectedChildId);
    expect(bootstrapEnvelope.body.correlationId).toBe(expectedChildId);
    expect(bootstrapEnvelope.body.correlationId).not.toBe(
      "engine-effect-correlation-unrelated",
    );

    // Complete the flow so the transport's returned promise resolves
    // cleanly rather than leaving dangling async work in the test.
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      {
        activeTools: [...(bootstrapEnvelope.body.activeTools ?? [])],
        resolvedModel: bootstrapEnvelope.body.resolvedModel,
      } as JsonValue,
      secretBytes,
    );
    await flush();
    await responder.send(
      "settled",
      expectedChildId,
      {
        outcome: "completed",
        summary: serializeCompletionCandidate({
          outcome: "success",
          method: "agent_signal",
          message: "SMOKE_FLOW_COMPLETE",
        }),
      },
      secretBytes,
    );

    const settlement = await resultPromise;
    expect(settlement.isOk()).toBe(true);
    // `DirectDispatchTransport` passes the raw `PiChildSettlement` through
    // unparsed (Spec 33 §15) - structured-candidate interpretation happens
    // one layer up, in `direct-dispatch.ts`'s own port, not here.
    expect(settlement._unsafeUnwrap()).toEqual({
      outcome: "completed",
      summary: serializeCompletionCandidate({
        outcome: "success",
        method: "agent_signal",
        message: "SMOKE_FLOW_COMPLETE",
      }),
    } as never);
  });

  it("registers/clears the direct-step child in the shared registry across a full bootstrap-ack/settle cycle", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const registry = new PiDirectStepChildRegistry();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        registry,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );

    const resultPromise = transport(baseInput());
    await flush();
    expect(registry.isActive()).toBe(true);

    const spawned = processPort.spawnedProcesses[0];
    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    await flush();
    await flush();
    const bootstrapEnvelope = extractControlEnvelopeFromPrompt(
      spawned.writtenLines()[0],
    );
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      {
        activeTools: [...(bootstrapEnvelope.body.activeTools ?? [])],
        resolvedModel: bootstrapEnvelope.body.resolvedModel,
      } as JsonValue,
      secretBytes,
    );
    await flush();
    await responder.send(
      "settled",
      expectedChildId,
      {
        outcome: "completed",
        summary: serializeCompletionCandidate({ outcome: "success" }),
      },
      secretBytes,
    );
    const settlement = await resultPromise;
    expect(settlement.isOk()).toBe(true);
    expect(registry.isActive()).toBe(false);
  });
});
