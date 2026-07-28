import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  generateNonceHex,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { type PiControlKind, signEnvelope } from "../child-envelope.js";
import {
  type PiChildInspectionRegistration,
  PiChildInspectionRegistry,
  ROOT_NODE_ID,
} from "../child-tree.js";
import {
  type PiDirectDispatchInput,
  TransportDirectDispatchPort,
} from "../direct-dispatch.js";
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
 * timeout (issue #21): `createDirectDispatchTransport` generates
 * its own authenticated `childId` for `PiRpcChild`, but the bootstrap body
 * it sent placed the caller's own, unrelated engine-level
 * `PiDirectDispatchInput.correlationId` (`dispatchEffect.runAgent.correlationId`,
 * `PiWorkflowController`'s own effect/audit correlation under the Pi adapter contract) into
 * the bootstrap's `correlationId` field instead. `applyChildBootstrap`
 * requires `parsed.correlationId === state.childId` (the child's own
 * env-derived authenticated identity, as required by the Pi adapter contract) and fails
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
    readonly resolvedModel?: unknown;
    readonly thinkingLevel?: string;
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
    composedPrompt: "You are the workflow step agent.",
    taskPrompt: "Call weave_complete_step exactly once.",
    cwd: "/project",
    // Deliberately different from the transport's own generated `childId`
    // (Pi adapter contract's engine-level effect correlation), so the assertion
    // below cannot pass by accident if the two were ever conflated again.
    correlationId: "engine-effect-correlation-unrelated",
    models: ["anthropic/claude-sonnet-5"],
    delegationTargets: [],
    ...overrides,
  };
}

const AVAILABLE_MODELS = [{ provider: "anthropic", id: "claude-sonnet-5" }];

describe("createDirectDispatchTransport (Pi adapter contract)", () => {
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

    const directPort = new TransportDirectDispatchPort(transport);
    const resultPromise = directPort.dispatch(
      baseInput({ models: ["anthropic/claude-sonnet-5#high"] }),
    );
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
    expect(bootstrapEnvelope.body.thinkingLevel).toBe("high");

    // Complete the flow so the transport's returned promise resolves
    // cleanly rather than leaving dangling async work in the test.
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await flush();
    await responder.send(
      "settled",
      expectedChildId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
          method: "agent_signal",
          message: "SMOKE_FLOW_COMPLETE",
        }),
        assistantOutput: "ordinary terminal assistant prose",
      },
      secretBytes,
    );

    const settlement = await resultPromise;
    expect(settlement.isOk()).toBe(true);
    // This is the real seam: PiRpcChild parses the authenticated settlement,
    // then TransportDirectDispatchPort interprets only the dedicated
    // completion-candidate field. Ordinary assistant prose must not replace it.
    expect(settlement._unsafeUnwrap()).toEqual({
      outcome: "success",
      method: "agent_signal",
      message: "SMOKE_FLOW_COMPLETE",
    });
  });

  it("omits an unresolved model identity so strict bootstrap serialization and dispatch still succeed", async () => {
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

    const resultPromise = transport(
      baseInput({ models: ["unavailable/model"] }),
    );
    await flush();

    const spawned = processPort.spawnedProcesses[0];
    expect(spawned).toBeDefined();
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
    expect(bootstrapEnvelope.correlationId).toBe(expectedChildId);
    expect(bootstrapEnvelope.body.correlationId).toBe(expectedChildId);
    expect("resolvedModel" in bootstrapEnvelope.body).toBe(false);

    await responder.send("bootstrap-ack", expectedChildId, {}, secretBytes);
    await flush();
    await responder.send(
      "settled",
      expectedChildId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );

    const settlement = await resultPromise;
    expect(settlement.isOk()).toBe(true);
  });

  it("relays a direct-step child's nested delegation through the shared parent controller", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const relayRequests: unknown[] = [];
    const relayDelegation = (request: unknown) => {
      relayRequests.push(request);
      return okAsync({
        outcome: "completed" as const,
        summary: "TAPESTRY_CHILD_OK",
      });
    };
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        availableModels: AVAILABLE_MODELS,
        relayDelegation,
      } as Parameters<typeof createDirectDispatchTransport>[0] & {
        readonly relayDelegation: typeof relayDelegation;
      },
      "gen-1",
    );

    const resultPromise = transport(
      baseInput({
        agentName: "tapestry",
        delegationTargets: [
          { name: "tapestry-worker", triggers: [], isCategory: false },
        ],
      }),
    );
    await flush();

    const spawned = processPort.spawnedProcesses[0];
    expect(spawned).toBeDefined();
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
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await flush();

    await responder.send(
      "delegate-request",
      `${expectedChildId}-delegate-0`,
      {
        agentName: "tapestry-worker",
        task: "Reply exactly TAPESTRY_CHILD_OK",
      },
      secretBytes,
    );
    await flush();
    await flush();

    expect(relayRequests).toEqual([
      {
        parentId: expectedChildId,
        parentDepth: 0,
        parentAgentName: "tapestry",
        agentName: "tapestry-worker",
        task: "Reply exactly TAPESTRY_CHILD_OK",
        cwd: "/project",
      },
    ]);
    const delegationResponse = extractControlEnvelopeFromPrompt(
      spawned.writtenLines().at(-1),
    ) as unknown as {
      readonly kind: string;
      readonly correlationId: string;
      readonly body: {
        readonly ok: boolean;
        readonly settlement?: unknown;
      };
    };
    expect(delegationResponse.kind).toBe("delegate-response");
    expect(delegationResponse.correlationId).toBe(
      `${expectedChildId}-delegate-0`,
    );
    expect(delegationResponse.body).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        summary: "TAPESTRY_CHILD_OK",
      },
    });

    await responder.send(
      "settled",
      expectedChildId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    expect((await resultPromise).isOk()).toBe(true);
  });

  it("registers workflow steps at ROOT before spawn and keeps trusted metadata despite forged child fields", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    let registration: PiChildInspectionRegistration | undefined;
    const registry = new PiChildInspectionRegistry({
      register: (value) => {
        registration = value;
        expect(processPort.spawnInputs).toHaveLength(0);
        return okAsync(undefined);
      },
      checkpoint: () => okAsync(undefined),
      terminal: () => okAsync(undefined),
    });
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        inspectionRegistry: registry,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );
    const resultPromise = transport(baseInput());
    await flush();
    expect(registration).toMatchObject({
      parentId: ROOT_NODE_ID,
      kind: "workflow-step",
      workflowInstanceId: "wf-1",
      stepName: "verify",
    });
    expect(processPort.spawnInputs).toHaveLength(1);

    const spawned = processPort.spawnedProcesses[0];
    const childId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, childId, "gen-1");
    await responder.send("handshake", childId, {}, secretBytes);
    await flush();
    await flush();
    const bootstrap = extractControlEnvelopeFromPrompt(
      spawned.writtenLines()[0],
    );
    await responder.send(
      "bootstrap-ack",
      childId,
      { resolvedModel: bootstrap.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await flush();
    spawned.emitLine({
      type: "message_update",
      workflowInstanceId: "forged-workflow",
      stepName: "forged-step",
      delta: { text: "forged" },
    });
    await flush();
    expect(registration?.workflowInstanceId).toBe("wf-1");
    expect(registration?.stepName).toBe("verify");
    await responder.send(
      "settled",
      childId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    expect((await resultPromise).isOk()).toBe(true);
  });

  it("persists terminal history before disposal, retains it, disposes on failure, and remains outside ordinary budgets", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const order: string[] = [];
    const registry = new PiChildInspectionRegistry({
      register: () => okAsync(undefined),
      terminal: () => {
        order.push("terminal");
        return okAsync(undefined);
      },
    });
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        inspectionRegistry: registry,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );
    const resultPromise = transport(baseInput());
    await flush();
    const spawned = processPort.spawnedProcesses[0];
    const childId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, childId, "gen-1");
    await responder.send("handshake", childId, {}, secretBytes);
    await flush();
    await flush();
    const bootstrap = extractControlEnvelopeFromPrompt(
      spawned.writtenLines()[0],
    );
    await responder.send(
      "bootstrap-ack",
      childId,
      { resolvedModel: bootstrap.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await flush();
    await responder.send(
      "settled",
      childId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
          message: "terminal",
        }),
      },
      secretBytes,
    );
    expect((await resultPromise).isOk()).toBe(true);
    expect(order).toEqual(["terminal"]);
    expect(registry.snapshotHistory()).toHaveLength(1);
    expect(spawned.killed).toBe(true);

    const failingProcess = new FakeChildProcessPort();
    const failingRegistry = new PiChildInspectionRegistry({
      register: () => okAsync(undefined),
      terminal: () =>
        errAsync({
          kind: "history-write-failed",
          operation: "terminal",
          reason: "unavailable",
        }),
    });
    const failingTransport = createDirectDispatchTransport(
      {
        processPort: failingProcess,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator: new FakeIdGenerator(),
        inspectionRegistry: failingRegistry,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );
    const failed = failingTransport(baseInput());
    await flush();
    const failedProcess = failingProcess.spawnedProcesses[0];
    const failedSecret = extractSecretFromSpawn(failingProcess);
    const failedResponder = new ScriptedChildResponder(
      failedProcess,
      childId,
      "gen-1",
    );
    await failedResponder.send("handshake", childId, {}, failedSecret);
    await flush();
    await flush();
    const failedBootstrap = extractControlEnvelopeFromPrompt(
      failedProcess.writtenLines()[0],
    );
    await failedResponder.send(
      "bootstrap-ack",
      childId,
      { resolvedModel: failedBootstrap.body.resolvedModel } as JsonValue,
      failedSecret,
    );
    await flush();
    await failedResponder.send(
      "settled",
      childId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      failedSecret,
    );
    expect((await failed).isErr()).toBe(true);
    expect(failedProcess.killed).toBe(true);
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
    expect("thinkingLevel" in bootstrapEnvelope.body).toBe(false);
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await flush();
    await responder.send(
      "settled",
      expectedChildId,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    const settlement = await resultPromise;
    expect(settlement.isOk()).toBe(true);
    expect(registry.isActive()).toBe(false);
  });
});
