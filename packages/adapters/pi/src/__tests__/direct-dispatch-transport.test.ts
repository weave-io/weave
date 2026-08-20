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
import type {
  CreateNativeChildSessionInput,
  MintNativeSessionLaunchGrantInput,
  PiNativeResultAppendIdentity,
  PiNativeSessionRecord,
  PiNativeThreadMetadataInput,
} from "../child-native-sessions.js";
import type {
  AppendChildRefLifecycleInput,
  AppendChildRefRunInput,
  AppendNewChildRefInput,
  PiChildRefRecord,
} from "../child-session-refs.js";
import { encodeTransferChunks } from "../child-transfer.js";
import {
  type PiChildInspectionRegistration,
  PiChildInspectionRegistry,
  ROOT_NODE_ID,
} from "../child-tree.js";
import type {
  PiThreadRefPort,
  PiThreadSessionPort,
} from "../delegation-controller.js";
import type { PiDirectDispatchInput } from "../direct-dispatch.js";
import {
  createDirectDispatchTransport,
  PiDirectStepChildRegistry,
} from "../direct-dispatch-transport.js";
import {
  EMPTY_PI_DISPATCH_SNAPSHOT,
  type PiDispatchSnapshot,
} from "../dispatch-snapshot.js";
import type { JsonValue } from "../strict-json.js";
import { serializeCompletionCandidate } from "../structured-completion.js";
import type { PiAdapterLogger } from "../types.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import { FakeIdGenerator } from "./fakes/fake-pi-host.js";
import {
  mintTestOnlyLaunchGrant,
  TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
} from "./fakes/test-only-session-storage-authority.js";

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

/**
 * Awaits the exact observable state an assertion needs instead of guessing a
 * fixed number of `flush()` ticks. Envelope signing and verification use real
 * WebCrypto and outgoing writes are serialized on a send tail, so the number of
 * macrotasks before an effect lands varies with host load; under a loaded CI
 * runner a fixed tick count is a timing race, not a wait. The bound keeps a
 * genuinely stuck path a fast, diagnosable failure rather than a hang.
 */
async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`test setup: timed out waiting for ${description}`);
    }
    await flush();
  }
}

/** Parser-approved terminal assistant text that satisfies the result contract. */
function terminalAssistantMessage(
  text = "ordinary terminal assistant prose",
): JsonValue {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/**
 * Awaits the direct-step spawn itself. `transport()` spawns asynchronously, so
 * reading `spawnedProcesses[0]` after a fixed number of `flush()` ticks is a
 * race under load. The port resolves `spawnCalled` from inside `spawn()`, after
 * it has already recorded the spawn input, so awaiting it makes both the
 * process and its input awaited facts rather than timing assumptions.
 */
async function awaitSpawnedChild(
  port: FakeChildProcessPort,
): Promise<FakeSpawnedProcess> {
  const spawned = await port.spawnCalled;
  expect(port.spawnedProcesses[0]).toBe(spawned);
  return spawned;
}

function extractSecretFromSpawn(port: FakeChildProcessPort): Uint8Array {
  // Every transport call in this file spawns exactly one child, and callers
  // reach here only after `awaitSpawnedChild` has guaranteed the spawn input
  // was recorded, so index 0 is an awaited fact, not a fixed-tick guess.
  expect(port.spawnInputs).toHaveLength(1);
  const hex = port.spawnInputs[0]?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("test setup: secret env missing");
  const bytes = hexToBytes(hex);
  if (bytes === undefined) throw new Error("test setup: malformed secret hex");
  return bytes;
}

const CONTROL_PROMPT_PREFIX = "/weave:__control__ ";

interface ParsedControlEnvelope {
  readonly kind: string;
  readonly correlationId: string;
  readonly body: {
    readonly correlationId?: string;
    readonly resolvedModel?: unknown;
    readonly thinkingLevel?: string;
    readonly fast?: unknown;
    readonly models?: unknown;
    readonly delegationTargets?: unknown;
  };
}

/**
 * Decodes a written line only when it is a signed control prompt. Ordinary
 * task prompts and non-prompt writes yield `undefined` so callers can scan for
 * the exact control envelope they need instead of assuming a line index.
 */
function decodeControlEnvelopeFromPrompt(
  line: unknown,
): ParsedControlEnvelope | undefined {
  if (typeof line !== "object" || line === null) return undefined;
  const record = line as {
    readonly type?: unknown;
    readonly message?: unknown;
  };
  if (record.type !== "prompt") return undefined;
  if (typeof record.message !== "string") return undefined;
  if (!record.message.startsWith(CONTROL_PROMPT_PREFIX)) return undefined;
  return JSON.parse(
    record.message.slice(CONTROL_PROMPT_PREFIX.length),
  ) as ParsedControlEnvelope;
}

/**
 * Waits boundedly for the specific signed control prompt an assertion needs.
 * Outgoing writes are serialized on a send tail and interleaved with ordinary
 * task prompts, so neither a fixed line index nor a fixed tick count is a
 * sound wait; matching on the decoded envelope is.
 */
async function waitForControlEnvelope(
  spawned: FakeSpawnedProcess,
  description: string,
  matches: (envelope: ParsedControlEnvelope) => boolean,
): Promise<ParsedControlEnvelope> {
  let found: ParsedControlEnvelope | undefined;
  await waitFor(description, () => {
    for (const line of spawned.writtenLines()) {
      const envelope = decodeControlEnvelopeFromPrompt(line);
      if (envelope !== undefined && matches(envelope)) {
        found = envelope;
        return true;
      }
    }
    return false;
  });
  if (found === undefined) {
    throw new Error(`test setup: missing control envelope for ${description}`);
  }
  return found;
}

/** Waits for the one signed bootstrap envelope addressed to this child. */
function waitForBootstrapEnvelope(
  spawned: FakeSpawnedProcess,
  childId: string,
): Promise<ParsedControlEnvelope> {
  return waitForControlEnvelope(
    spawned,
    "the signed bootstrap control prompt",
    (envelope) =>
      envelope.kind === "bootstrap" && envelope.correlationId === childId,
  );
}

/**
 * Waits for the ordinary, unsigned task prompt. The transport writes it only
 * after it has verified and applied the child's `bootstrap-ack`, so this line
 * is the observable proof that the ack was consumed; a fixed `flush()` after
 * sending the ack proves nothing, because envelope verification uses real
 * WebCrypto and the write is serialized behind a send tail.
 */
async function waitForTaskPrompt(spawned: FakeSpawnedProcess): Promise<void> {
  await waitFor("the task prompt to be written to the child", () =>
    spawned
      .writtenLines()
      .some(
        (line) =>
          typeof line === "object" &&
          line !== null &&
          (line as { readonly type?: unknown }).type === "prompt" &&
          decodeControlEnvelopeFromPrompt(line) === undefined,
      ),
  );
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
  it("copies fast intent and ordered trigger arrays into the direct bootstrap without source aliasing", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );
    const models = ["anthropic/claude-sonnet-5#high"];
    const triggers = ["implement", "test in order"];
    const delegationTargets = [
      {
        name: "shuttle-mini",
        description: "Bounded implementation",
        triggers,
        isCategory: true,
      },
    ];

    const resultPromise = transport(
      baseInput({ models, delegationTargets, fast: true }),
    );
    const spawned = await awaitSpawnedChild(processPort);
    models[0] = "mutated/model";
    triggers[0] = "mutated trigger";
    const firstTarget = delegationTargets[0];
    if (firstTarget === undefined)
      throw new Error("test setup: missing target");
    firstTarget.name = "mutated-target";
    delegationTargets.push({
      name: "late-target",
      description: "Added after dispatch",
      triggers: ["late trigger"],
      isCategory: false,
    });

    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
    expect(bootstrapEnvelope.body.fast).toBe(true);
    expect(bootstrapEnvelope.body.models).toEqual([
      "anthropic/claude-sonnet-5#high",
    ]);
    // Target catalogs stay parent-authoritative: the bootstrap carries none,
    // so no post-dispatch mutation of the source array can reach a child.
    expect(bootstrapEnvelope.body.delegationTargets).toEqual([]);

    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await waitForTaskPrompt(spawned);
    spawned.emitLine(terminalAssistantMessage());
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

  it("preserves fast omission in the direct bootstrap", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );

    const resultPromise = transport(baseInput());
    const spawned = await awaitSpawnedChild(processPort);
    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
    expect(Object.hasOwn(bootstrapEnvelope.body, "fast")).toBe(false);

    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await waitForTaskPrompt(spawned);
    spawned.emitLine(terminalAssistantMessage());
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

  it("bootstraps the direct-step child using its own generated childId as the control-envelope correlationId, never the caller's unrelated engine-level correlationId", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator,
        availableModels: AVAILABLE_MODELS,
      },
      "gen-1",
    );

    const resultPromise = transport(
      baseInput({ models: ["anthropic/claude-sonnet-5#high"] }),
    );
    const spawned = await awaitSpawnedChild(processPort);
    expect(spawned).toBeDefined();
    // The transport builds `childId` as
    // `direct-${workflowInstanceId}-${stepName}-${idGenerator.next()}`; the
    // fake id generator deterministically returns `generation-1` on its
    // first call.
    const expectedChildId = "direct-wf-1-verify-generation-1";
    expect(processPort.spawnInputs[0]?.command).toBeDefined();

    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    // Outgoing control writes are serialized on a send tail and can land
    // after ordinary task prompts, so wait for the signed bootstrap envelope
    // by content rather than assuming writtenLines()[0] after a fixed flush.
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
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
    // The task prompt is written only once the ack is verified and applied.
    await waitForTaskPrompt(spawned);
    spawned.emitLine(terminalAssistantMessage());
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
        interventionCount: 7,
        assistantOutput: "ordinary terminal assistant prose",
      },
      secretBytes,
    );

    const settlement = await resultPromise;
    expect(settlement.isOk()).toBe(true);
    // PiRpcChild authenticates both fields. The transport preserves the
    // numeric metadata beside the candidate; it does not put the count into
    // the completion authority. Direct-step settlement projects only the
    // candidate (assistant text stays on the rpc-child path).
    expect(settlement._unsafeUnwrap()).toEqual({
      outcome: "completed",
      completionCandidate: serializeCompletionCandidate({
        outcome: "success",
        method: "agent_signal",
        message: "SMOKE_FLOW_COMPLETE",
      }),
      interventionCount: 0,
    });
    expect(typeof settlement._unsafeUnwrap().interventionCount).toBe("number");
    expect(settlement._unsafeUnwrap().completionCandidate).not.toContain(
      "interventionCount",
    );
  });

  it("omits an unresolved model identity so strict bootstrap serialization and dispatch still succeed", async () => {
    const processPort = new FakeChildProcessPort();
    const idGenerator = new FakeIdGenerator();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    const spawned = await awaitSpawnedChild(processPort);
    expect(spawned).toBeDefined();
    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    // Wait for the specific signed bootstrap envelope: signing plus the
    // serialized send tail means no fixed tick count guarantees it has landed
    // at writtenLines()[0].
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
    expect(bootstrapEnvelope.correlationId).toBe(expectedChildId);
    expect(bootstrapEnvelope.body.correlationId).toBe(expectedChildId);
    expect("resolvedModel" in bootstrapEnvelope.body).toBe(false);

    await responder.send("bootstrap-ack", expectedChildId, {}, secretBytes);
    await waitForTaskPrompt(spawned);
    spawned.emitLine(terminalAssistantMessage());
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
        assistantOutput: "TAPESTRY_CHILD_OK",
      });
    };
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    const spawned = await awaitSpawnedChild(processPort);
    expect(spawned).toBeDefined();
    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );

    await responder.send(
      "delegate-request",
      `${expectedChildId}-delegate-0`,
      {
        agentName: "tapestry-worker",
        task: "Reply exactly TAPESTRY_CHILD_OK",
      },
      secretBytes,
    );
    await waitFor(
      "the nested delegation to reach the shared parent controller",
      () => relayRequests.length > 0,
    );

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
    const delegationResponse = (await waitForControlEnvelope(
      spawned,
      "the signed delegate-response control prompt",
      (envelope) =>
        envelope.kind === "delegate-response" &&
        envelope.correlationId === `${expectedChildId}-delegate-0`,
    )) as unknown as {
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
        assistantOutput: "TAPESTRY_CHILD_OK",
      },
    });

    spawned.emitLine(terminalAssistantMessage());
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
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    // Registration happens before spawn (asserted inside `register` above);
    // awaiting the spawn makes both facts observable without a fixed tick.
    const spawned = await awaitSpawnedChild(processPort);
    expect(registration).toMatchObject({
      parentId: ROOT_NODE_ID,
      kind: "workflow-step",
      workflowInstanceId: "wf-1",
      stepName: "verify",
    });
    expect(processPort.spawnInputs).toHaveLength(1);

    const childId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, childId, "gen-1");
    await responder.send("handshake", childId, {}, secretBytes);
    const bootstrap = await waitForBootstrapEnvelope(spawned, childId);
    await responder.send(
      "bootstrap-ack",
      childId,
      { resolvedModel: bootstrap.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await waitForTaskPrompt(spawned);
    spawned.emitLine({
      type: "message_update",
      workflowInstanceId: "forged-workflow",
      stepName: "forged-step",
      delta: { text: "forged" },
    });
    spawned.emitLine(terminalAssistantMessage());
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
    // The forged line was delivered on the same ordered stdout stream ahead of
    // the terminal message, so a settled transport has necessarily consumed it;
    // the trusted metadata must still be the parent's own values.
    expect(registration?.workflowInstanceId).toBe("wf-1");
    expect(registration?.stepName).toBe("verify");
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
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    const spawned = await awaitSpawnedChild(processPort);
    const childId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(spawned, childId, "gen-1");
    await responder.send("handshake", childId, {}, secretBytes);
    const bootstrap = await waitForBootstrapEnvelope(spawned, childId);
    await responder.send(
      "bootstrap-ack",
      childId,
      { resolvedModel: bootstrap.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    await waitForTaskPrompt(spawned);
    spawned.emitLine(terminalAssistantMessage("terminal"));
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
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    const failedProcess = await awaitSpawnedChild(failingProcess);
    const failedSecret = extractSecretFromSpawn(failingProcess);
    const failedResponder = new ScriptedChildResponder(
      failedProcess,
      childId,
      "gen-1",
    );
    await failedResponder.send("handshake", childId, {}, failedSecret);
    const failedBootstrap = await waitForBootstrapEnvelope(
      failedProcess,
      childId,
    );
    await failedResponder.send(
      "bootstrap-ack",
      childId,
      { resolvedModel: failedBootstrap.body.resolvedModel } as JsonValue,
      failedSecret,
    );
    await waitForTaskPrompt(failedProcess);
    failedProcess.emitLine(terminalAssistantMessage());
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
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
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
    const spawned = await awaitSpawnedChild(processPort);
    expect(registry.isActive()).toBe(true);

    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
    expect("thinkingLevel" in bootstrapEnvelope.body).toBe(false);
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );
    // The task prompt proves the acknowledged bootstrap was applied.
    await waitForTaskPrompt(spawned);
    spawned.emitLine(terminalAssistantMessage());
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

/**
 * Task 11 review blocker: a direct workflow step wrote a durable `running`
 * child ref before spawning but never appended a terminal lifecycle record, so
 * every settled direct child stayed `running` in the parent session forever.
 *
 * These tests pin the replacement contract: once (and only once) a durable
 * running ref exists, exactly one terminal lifecycle record is appended for
 * each of the four settled outcomes, the recorded status follows the child's
 * real outcome rather than the workflow-facing projection, and a failed
 * lifecycle append never displaces the primary transport or persistence
 * failure.
 */

const LIFECYCLE_SESSION_DIR = "/data/weave/adapters/pi/sessions/child";
const LIFECYCLE_SESSION_PATH = `${LIFECYCLE_SESSION_DIR}/session.jsonl`;

/** A ref port that records every lifecycle append it is asked to perform. */
class LifecycleRefPort implements PiThreadRefPort {
  readonly newChildren: AppendNewChildRefInput[] = [];
  readonly lifecycles: AppendChildRefLifecycleInput[] = [];
  failNewChild = false;
  failLifecycle = false;
  /** Observes when a durable lifecycle append actually happens. */
  onLifecycle: (() => void) | undefined;

  liveParentSessionId(): string {
    return "parent-session-1";
  }

  readRefs() {
    return okAsync({ refs: [], issues: [] } as never);
  }

  appendNewChild(input: AppendNewChildRefInput) {
    if (this.failNewChild) {
      return errAsync({ type: "RefWriteFailed", reason: "io" } as never);
    }
    this.newChildren.push(input);
    return okAsync({
      childId: input.childId,
      threadId: input.threadId ?? input.childId,
      nativeSessionId: input.nativeSessionId,
      sessionRef: input.sessionRef,
      title: input.title,
      status: input.status ?? "running",
    } as unknown as PiChildRefRecord);
  }

  appendRunDivider(record: PiChildRefRecord, _input: AppendChildRefRunInput) {
    return okAsync(record);
  }

  appendLifecycle(
    record: PiChildRefRecord,
    input: AppendChildRefLifecycleInput,
  ) {
    if (this.failLifecycle) {
      return errAsync({ type: "RefWriteFailed", reason: "io" } as never);
    }
    this.onLifecycle?.();
    this.lifecycles.push(input);
    return okAsync({ ...record, status: input.status } as PiChildRefRecord);
  }
}

/** A session port that provisions an in-memory, validly shaped native session. */
class LifecycleSessionPort implements PiThreadSessionPort {
  readonly resultOutputs: Array<{
    readonly ref: string;
    readonly output: string;
    readonly expected: PiNativeResultAppendIdentity;
  }> = [];
  failResultOutput = false;
  /** Observes when a durable result persist actually happens. */
  onResultOutput: (() => void) | undefined;

  createChildSession(input: CreateNativeChildSessionInput) {
    return okAsync({
      childId: input.childId,
      sessionId: "native-lifecycle-1",
      ref: "child/session.jsonl",
      path: LIFECYCLE_SESSION_PATH,
      parentSession: input.parentSession,
      cwd: input.cwd,
    } as never);
  }

  mintLaunchGrant(input: MintNativeSessionLaunchGrantInput) {
    return okAsync(
      mintTestOnlyLaunchGrant(TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY, {
        childId: input.childId,
        sessionId: "native-lifecycle-1",
        ref: "child/session.jsonl",
        sessionDir: LIFECYCLE_SESSION_DIR,
        sessionPath: LIFECYCLE_SESSION_PATH,
        activeLeafId: input.activeLeafId,
      }),
    ) as never;
  }

  appendResultOutput(
    ref: string,
    output: string,
    expected: PiNativeResultAppendIdentity,
  ) {
    if (this.failResultOutput) {
      return errAsync({
        type: "SessionCreateFailed" as const,
        reason: "io" as const,
      });
    }
    this.onResultOutput?.();
    this.resultOutputs.push({ ref, output, expected });
    return okAsync(undefined);
  }

  establishThreadLeaf(
    _ref: string,
    _metadata: PiNativeThreadMetadataInput,
    _expectedParentSession?: string,
  ) {
    return okAsync({
      record: {
        childId: "child",
        sessionId: "native-lifecycle-1",
        ref: "child/session.jsonl",
        path: LIFECYCLE_SESSION_PATH,
        parentSession: "parent-session-1",
        cwd: "/project",
      },
      leafId: "leaf-1",
    } as never);
  }

  appendTombstone(record: PiNativeSessionRecord) {
    return okAsync({
      version: 1 as const,
      ref: record.ref,
      childId: record.childId,
      parentSession: record.parentSession,
      deletedAt: "2026-01-01T00:00:00.000Z",
      reason: "explicit-user-deletion" as const,
    } as never);
  }

  openSession(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }

  readSessionEntries(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }

  readSessionEntryPage(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }

  readThreadMetadata(ref: string) {
    return errAsync({ type: "SessionMissing" as const, ref } as never);
  }
}

function lifecycleTransport(options: {
  readonly processPort: FakeChildProcessPort;
  readonly refs: PiThreadRefPort;
  readonly sessions?: PiThreadSessionPort;
  readonly registry?: PiDirectStepChildRegistry;
}) {
  return createDirectDispatchTransport(
    {
      processPort: options.processPort,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      idGenerator: new FakeIdGenerator(),
      availableModels: AVAILABLE_MODELS,
      sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      threadSessions: () => options.sessions ?? new LifecycleSessionPort(),
      threadRefs: () => options.refs,
      requireNativeSession: () => true,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      now: () => 1_700_000_000_000,
    },
    "gen-1",
  );
}

const LIFECYCLE_CHILD_ID = "direct-wf-1-verify-generation-1";

/** Drives a direct step to the point where its task prompt has been applied. */
async function driveToRunning(processPort: FakeChildProcessPort) {
  const spawned = await awaitSpawnedChild(processPort);
  const secretBytes = extractSecretFromSpawn(processPort);
  const responder = new ScriptedChildResponder(
    spawned,
    LIFECYCLE_CHILD_ID,
    "gen-1",
  );
  await responder.send("handshake", LIFECYCLE_CHILD_ID, {}, secretBytes);
  const bootstrap = await waitForBootstrapEnvelope(spawned, LIFECYCLE_CHILD_ID);
  await responder.send(
    "bootstrap-ack",
    LIFECYCLE_CHILD_ID,
    { resolvedModel: bootstrap.body.resolvedModel } as JsonValue,
    secretBytes,
  );
  // A restored native session is verified with a bounded `get_entries` page
  // before the task prompt is written, so the scripted child must answer it.
  await waitFor("the restore verification probe", () =>
    spawned
      .writtenLines()
      .some(
        (line) => (line as { readonly type?: unknown }).type === "get_entries",
      ),
  );
  const probe = spawned
    .writtenLines()
    .find(
      (line) => (line as { readonly type?: unknown }).type === "get_entries",
    ) as { readonly id?: unknown };
  spawned.emitLine({
    id: probe.id,
    type: "response",
    command: "get_entries",
    success: true,
    data: { entries: [], leafId: "leaf-1" },
  } as JsonValue);
  await waitForTaskPrompt(spawned);
  return { spawned, responder, secretBytes };
}

describe("direct workflow steps persist a terminal child lifecycle", () => {
  it("appends exactly one completed lifecycle record after a completed outcome", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const settlementPromise = lifecycleTransport({ processPort, refs })(
      baseInput(),
    );
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    const settlement = await settlementPromise;

    expect({
      settled: settlement.isOk(),
      outcome: settlement.isOk() ? settlement.value.outcome : "",
      runningRefs: refs.newChildren.length,
      lifecycleAppends: refs.lifecycles.length,
      status: refs.lifecycles[0]?.status ?? "",
      settledAt: refs.lifecycles[0]?.settledAt ?? 0,
    }).toEqual({
      settled: true,
      outcome: "completed",
      runningRefs: 1,
      lifecycleAppends: 1,
      status: "completed",
      settledAt: 1_700_000_000_000,
    });
  });

  it("appends exactly one failed lifecycle record after a failed outcome", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const settlementPromise = lifecycleTransport({ processPort, refs })(
      baseInput(),
    );
    const { responder, secretBytes } = await driveToRunning(processPort);
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      { outcome: "failed", reason: "child reported failure" },
      secretBytes,
    );
    const settlement = await settlementPromise;

    expect({
      settled: settlement.isOk(),
      outcome: settlement.isOk() ? settlement.value.outcome : "",
      lifecycleAppends: refs.lifecycles.length,
      status: refs.lifecycles[0]?.status ?? "",
    }).toEqual({
      settled: true,
      outcome: "failed",
      lifecycleAppends: 1,
      status: "failed",
    });
  });

  it("records a cancelled child as cancelled even though the workflow settlement is the closed failed shape", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const registry = new PiDirectStepChildRegistry();
    const settlementPromise = lifecycleTransport({
      processPort,
      refs,
      registry,
    })(baseInput());
    const { responder, secretBytes } = await driveToRunning(processPort);
    const cancelling = registry.cancel();
    expect(cancelling).toBeDefined();
    await responder.send("cancelled", LIFECYCLE_CHILD_ID, {}, secretBytes);
    await cancelling;
    const settlement = await settlementPromise;

    expect({
      settled: settlement.isOk(),
      // The workflow layer still receives the closed failed projection.
      projected: settlement.isOk()
        ? `${settlement.value.outcome}:${settlement.value.outcome === "failed" ? settlement.value.reason : ""}`
        : "",
      lifecycleAppends: refs.lifecycles.length,
      // The durable record preserves the real outcome.
      status: refs.lifecycles[0]?.status ?? "",
    }).toEqual({
      settled: true,
      projected: "failed:cancelled",
      lifecycleAppends: 1,
      status: "cancelled",
    });
  });

  it("appends one failed lifecycle record and still reports the transport error", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const settlementPromise = lifecycleTransport({ processPort, refs })(
      baseInput(),
    );
    const spawned = await awaitSpawnedChild(processPort);
    // The child dies before it ever handshakes: a transport error, not a
    // settled outcome.
    spawned.exit(1);
    const settlement = await settlementPromise;

    expect({
      failed: settlement.isErr(),
      // The primary transport failure is preserved verbatim.
      primaryCode: settlement.isErr() ? settlement.error.code : "",
      lifecycleAppends: refs.lifecycles.length,
      status: refs.lifecycles[0]?.status ?? "",
      leakedPath: JSON.stringify(
        settlement.isErr() ? settlement.error : {},
      ).includes(LIFECYCLE_SESSION_PATH),
    }).toEqual({
      failed: true,
      primaryCode: "ChildExitedUnexpectedly",
      lifecycleAppends: 1,
      status: "failed",
      leakedPath: false,
    });
  });

  it("reports a typed path-free failure when the terminal lifecycle append fails", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    refs.failLifecycle = true;
    const settlementPromise = lifecycleTransport({ processPort, refs })(
      baseInput(),
    );
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    const settlement = await settlementPromise;
    const rendered = JSON.stringify(settlement.isErr() ? settlement.error : {});

    expect({
      failed: settlement.isErr(),
      code: settlement.isErr() ? settlement.error.code : "",
      namesClosedReason: rendered.includes("direct-lifecycle-writeback-failed"),
      // The ref store's own error text and every path stay out of the failure.
      leakedStoreError: rendered.includes("RefWriteFailed"),
      leakedPath: rendered.includes(LIFECYCLE_SESSION_PATH),
    }).toEqual({
      failed: true,
      code: "ChildAbortFailed",
      namesClosedReason: true,
      leakedStoreError: false,
      leakedPath: false,
    });
  });

  it("appends no terminal lifecycle record when no durable running ref exists", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    refs.failNewChild = true;
    const settlement = await lifecycleTransport({ processPort, refs })(
      baseInput(),
    );

    expect({
      failed: settlement.isErr(),
      code: settlement.isErr() ? settlement.error.code : "",
      runningRefs: refs.newChildren.length,
      lifecycleAppends: refs.lifecycles.length,
      spawns: processPort.spawnInputs.length,
    }).toEqual({
      failed: true,
      code: "ChildSpawnFailed",
      runningRefs: 0,
      lifecycleAppends: 0,
      spawns: 0,
    });
  });
});

/**
 * Complete private output must land on the already-provisioned native session
 * before a completed direct-step settlement can succeed. The write uses the
 * provisioned opaque ref and expected parent; a store failure is typed and
 * fail-closed. Native ref/lifecycle and the optional observer stay intact.
 */
describe("direct workflow steps persist complete private output", () => {
  it("writes captured output to the provisioned native session before completed settlement", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const sessions = new LifecycleSessionPort();
    const observed: Array<{
      output: string;
      byteLength: number;
      source: string;
    }> = [];
    // A direct step's authoritative result is its structured completion
    // candidate. Above the inline cap the child transfers that candidate, so
    // the transferred bytes and the settled candidate are the same value.
    const completeOutput = serializeCompletionCandidate({
      outcome: "success",
      message: `COMPLETE_PRIVATE_OUTPUT ${"界".repeat(80)}`,
    });
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator: new FakeIdGenerator(),
        availableModels: AVAILABLE_MODELS,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        threadSessions: () => sessions,
        threadRefs: () => refs,
        requireNativeSession: () => true,
        now: () => 1_700_000_000_000,
        onPrivateOutput: (_childId, capture) => {
          observed.push(capture);
          return okAsync(undefined);
        },
      },
      "gen-1",
    );
    const settlementPromise = transport(baseInput());
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    const transferId = "direct-complete-output";
    const chunks = encodeTransferChunks(completeOutput, transferId);
    expect(chunks.isOk()).toBe(true);
    if (chunks.isErr()) return;
    for (const chunk of chunks.value) {
      await responder.send(
        "transfer-chunk",
        transferId,
        { channel: "output", ...chunk },
        secretBytes,
      );
    }
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      {
        outcome: "completed",
        completionCandidateTransferred: true,
        outputTransferId: transferId,
        outputByteLength: new TextEncoder().encode(completeOutput).byteLength,
      },
      secretBytes,
    );
    const settlement = await settlementPromise;

    expect({
      settled: settlement.isOk(),
      outcome: settlement.isOk() ? settlement.value.outcome : "",
      persisted: sessions.resultOutputs,
      observer: observed,
      lifecycleAppends: refs.lifecycles.length,
      status: refs.lifecycles[0]?.status ?? "",
    }).toEqual({
      settled: true,
      outcome: "completed",
      persisted: [
        {
          ref: "child/session.jsonl",
          output: completeOutput,
          expected: {
            childId: LIFECYCLE_CHILD_ID,
            nativeSessionId: "native-lifecycle-1",
            parentSession: "parent-session-1",
          },
        },
      ],
      observer: [
        {
          output: completeOutput,
          byteLength: new TextEncoder().encode(completeOutput).byteLength,
          source: "transferred-candidate",
        },
      ],
      lifecycleAppends: 1,
      status: "completed",
    });
  });

  it("persists the inline completion candidate, never the terminal assistant prose", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const sessions = new LifecycleSessionPort();
    const captures: Array<{ output: string; source: string }> = [];
    const candidate = serializeCompletionCandidate({
      outcome: "success",
      message: "STRUCTURED_CANDIDATE_MESSAGE",
    });
    const transport = createDirectDispatchTransport(
      {
        processPort,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator: new FakeIdGenerator(),
        availableModels: AVAILABLE_MODELS,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        threadSessions: () => sessions,
        threadRefs: () => refs,
        requireNativeSession: () => true,
        now: () => 1_700_000_000_000,
        onPrivateOutput: (_childId, capture) => {
          captures.push({ output: capture.output, source: capture.source });
          return okAsync(undefined);
        },
      },
      "gen-1",
    );
    const settlementPromise = transport(baseInput());
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    // A structured direct step still leaves ordinary terminal prose behind.
    // That prose is not its result and must never be persisted as one.
    spawned.emitLine(terminalAssistantMessage("UNRELATED_TERMINAL_PROSE"));
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      { outcome: "completed", completionCandidate: candidate },
      secretBytes,
    );
    const settlement = await settlementPromise;

    expect({
      settled: settlement.isOk(),
      persistedOutputs: sessions.resultOutputs.map((entry) => entry.output),
      captureSources: captures.map((entry) => entry.source),
      persistedProse: sessions.resultOutputs.some((entry) =>
        entry.output.includes("UNRELATED_TERMINAL_PROSE"),
      ),
    }).toEqual({
      settled: true,
      persistedOutputs: [candidate],
      captureSources: ["inline-candidate"],
      persistedProse: false,
    });
  });

  it("refuses to persist a completed direct step that produced no candidate", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const sessions = new LifecycleSessionPort();
    const settlementPromise = lifecycleTransport({
      processPort,
      refs,
      sessions,
    })(baseInput());
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    spawned.emitLine(terminalAssistantMessage("UNRELATED_TERMINAL_PROSE"));
    // A completed settlement carrying only prose is not a direct-step result.
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      { outcome: "completed", assistantOutput: "UNRELATED_TERMINAL_PROSE" },
      secretBytes,
    );
    const settlement = await settlementPromise;

    expect({
      failed: settlement.isErr(),
      persisted: sessions.resultOutputs,
      rendered: JSON.stringify(
        settlement.isErr() ? settlement.error : {},
      ).includes("UNRELATED_TERMINAL_PROSE"),
    }).toEqual({ failed: true, persisted: [], rendered: false });
  });

  it("fails closed with a typed path-free error when native result persist fails", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const sessions = new LifecycleSessionPort();
    sessions.failResultOutput = true;
    const settlementPromise = lifecycleTransport({
      processPort,
      refs,
      sessions,
    })(baseInput());
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    const settlement = await settlementPromise;
    const rendered = JSON.stringify(settlement.isErr() ? settlement.error : {});

    expect({
      failed: settlement.isErr(),
      code: settlement.isErr() ? settlement.error.code : "",
      persisted: sessions.resultOutputs.length,
      lifecycleAppends: refs.lifecycles.length,
      status: refs.lifecycles[0]?.status ?? "",
      leakedStoreError: rendered.includes("SessionCreateFailed"),
      leakedPath: rendered.includes(LIFECYCLE_SESSION_PATH),
    }).toEqual({
      failed: true,
      code: "ChildRecoveryUnavailable",
      persisted: 0,
      lifecycleAppends: 1,
      // A durable `completed` lifecycle asserts a retrievable result. The
      // authoritative result never landed, so the one terminal record this
      // step is allowed to write must say `failed` instead.
      status: "failed",
      leakedStoreError: false,
      leakedPath: false,
    });
  });

  it("persists the authoritative result before it writes a completed lifecycle", async () => {
    const processPort = new FakeChildProcessPort();
    const refs = new LifecycleRefPort();
    const sessions = new LifecycleSessionPort();
    const order: string[] = [];
    // Both durable writes record their arrival order, so the ordering claim
    // is observed rather than inferred from the settlement value.
    sessions.onResultOutput = () => order.push("result");
    refs.onLifecycle = () => order.push("lifecycle");
    const settlementPromise = lifecycleTransport({
      processPort,
      refs,
      sessions,
    })(baseInput());
    const { spawned, responder, secretBytes } =
      await driveToRunning(processPort);
    spawned.emitLine(terminalAssistantMessage());
    await responder.send(
      "settled",
      LIFECYCLE_CHILD_ID,
      {
        outcome: "completed",
        completionCandidate: serializeCompletionCandidate({
          outcome: "success",
        }),
      },
      secretBytes,
    );
    const settlement = await settlementPromise;

    expect({
      completed: settlement.isOk(),
      order,
      status: refs.lifecycles[0]?.status ?? "",
      persisted: sessions.resultOutputs.length,
    }).toEqual({
      completed: true,
      order: ["result", "lifecycle"],
      status: "completed",
      persisted: 1,
    });
  });
});

describe("direct workflow steps pin the catalog they were dispatched with", () => {
  it("samples the step's lifecycle budgets from the current catalog at dispatch", async () => {
    const processPort = new FakeChildProcessPort();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator: new FakeIdGenerator(),
        availableModels: AVAILABLE_MODELS,
        // A one-millisecond handshake budget is only reachable through the
        // accessor: the transport's own default is thirty seconds.
        currentDispatch: (): PiDispatchSnapshot => ({
          ...EMPTY_PI_DISPATCH_SNAPSHOT,
          budgets: { handshakeTimeoutMs: 1 },
        }),
      },
      "gen-1",
    );

    const settlement = await transport(baseInput());

    expect(settlement._unsafeUnwrapErr().code).toBe("ChildHandshakeMissing");
  });

  it("relays every nested request against the catalog sampled at dispatch, not a newer one", async () => {
    const processPort = new FakeChildProcessPort();
    const relayRequests: Array<{ readonly snapshot?: PiDispatchSnapshot }> = [];
    const dispatched: PiDispatchSnapshot = {
      ...EMPTY_PI_DISPATCH_SNAPSHOT,
      resolveAgentRole: () => "dispatched",
    };
    const published: PiDispatchSnapshot = {
      ...EMPTY_PI_DISPATCH_SNAPSHOT,
      resolveAgentRole: () => "published",
    };
    let current = dispatched;
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator: new FakeIdGenerator(),
        availableModels: AVAILABLE_MODELS,
        currentDispatch: () => current,
        relayDelegation: (request) => {
          relayRequests.push(request);
          return okAsync({
            outcome: "completed" as const,
            assistantOutput: "NESTED_OK",
          });
        },
      },
      "gen-1",
    );

    void transport(baseInput({ agentName: "tapestry" }));
    const spawned = await awaitSpawnedChild(processPort);
    const expectedChildId = "direct-wf-1-verify-generation-1";
    const secretBytes = extractSecretFromSpawn(processPort);
    const responder = new ScriptedChildResponder(
      spawned,
      expectedChildId,
      "gen-1",
    );
    await responder.send("handshake", expectedChildId, {}, secretBytes);
    const bootstrapEnvelope = await waitForBootstrapEnvelope(
      spawned,
      expectedChildId,
    );
    await responder.send(
      "bootstrap-ack",
      expectedChildId,
      { resolvedModel: bootstrapEnvelope.body.resolvedModel } as JsonValue,
      secretBytes,
    );

    // A whole new catalog is published while this step runs.
    current = published;

    await responder.send(
      "delegate-request",
      `${expectedChildId}-delegate-0`,
      { agentName: "tapestry-worker", task: "nested task" },
      secretBytes,
    );
    await waitFor(
      "the nested delegation to reach the shared parent controller",
      () => relayRequests.length > 0,
    );

    expect(relayRequests[0]?.snapshot).toBe(dispatched);
  });
});
