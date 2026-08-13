import { expect, test } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { createInMemoryRuntimeStore } from "@weaveio/weave-engine";
import { ok, okAsync } from "neverthrow";
import {
  generateNonceHex,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import {
  MAX_CONTROL_BODY_BYTES,
  type PiControlKind,
  signEnvelope,
} from "../child-envelope.js";
import { MAX_NATIVE_RECORD_BYTES } from "../child-framing.js";
import type { PiChildRecoveryRecord } from "../child-recovery.js";
import { SystemTimerPort } from "../child-timer.js";
import {
  type PiChildInspectionHistoryPort,
  PiChildInspectionRegistry,
  ROOT_NODE_ID,
} from "../child-tree.js";
import {
  PiDelegationController,
  type PiDelegationRequest,
} from "../delegation-controller.js";
import {
  createDirectDispatchTransport,
  PiDirectStepChildRegistry,
} from "../direct-dispatch-transport.js";
import { InMemoryRecoveryPointerStore } from "../recovery-pointer.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { canonicalizeToBytes, type JsonValue } from "../strict-json.js";
import {
  authorizeByExplicitUser,
  PiWorkflowController,
} from "../workflow-controller.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";
import {
  createTestOnlyGrantedSessionStorageAuthority,
  mintTestOnlyLaunchGrant,
} from "./fakes/test-only-session-storage-authority.js";

/** One shared authority: it mints every launch grant these fixtures use. */
const TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY =
  await createTestOnlyGrantedSessionStorageAuthority("/history/children");

const encoder = new TextEncoder();
const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

const input: PiRpcChildSpawnInput = {
  childId: "child-1",
  parentId: ROOT_NODE_ID,
  generationId: "gen-1",
  agentName: "shuttle",
  depth: 1,
  cwd: "/project",
  env: {},
  task: "inspect the child",
};
function bootstrapFor(correlationId: string): JsonValue {
  return {
    mode: "ordinary",
    agentName: "shuttle",
    composedPrompt: "bounded",
    models: [],
    correlationId,
    context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
  };
}

function config(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const generous = config(`settings {
  delegation {
    max_children 9
    max_concurrency 9
    max_depth 3
    max_processes 9
  }
}
agent shuttle {
}
agent loom {
}
`);

class Ids {
  private n = 0;
  next(): string {
    this.n += 1;
    return `child-${this.n}`;
  }
}

function request(
  overrides: Partial<PiDelegationRequest> = {},
): PiDelegationRequest {
  return {
    parentId: ROOT_NODE_ID,
    parentDepth: 0,
    parentAgentName: "loom",
    agentName: "shuttle",
    task: "do the thing",
    cwd: "/project",
    env: {},
    bootstrap: bootstrapFor(overrides.childId ?? "child-1"),
    ...overrides,
  };
}

function processAt(
  port: FakeChildProcessPort,
  index: number,
): FakeSpawnedProcess {
  const process = port.spawnedProcesses[index];
  if (process === undefined) throw new Error(`missing fake process ${index}`);
  return process;
}

function secretFor(
  port: FakeChildProcessPort,
  process: FakeSpawnedProcess,
): Uint8Array {
  const index = port.spawnedProcesses.indexOf(process);
  const hex = port.spawnInputs[index]?.env[WEAVE_CHILD_SECRET_ENV];
  if (hex === undefined) throw new Error("missing child secret");
  const secret = hexToBytes(hex);
  if (secret === undefined) throw new Error("invalid child secret");
  return secret;
}

async function settleProcess(
  port: FakeChildProcessPort,
  process: FakeSpawnedProcess,
  generationId = "gen-1",
  output = "bounded terminal result",
): Promise<void> {
  const secret = secretFor(port, process);
  const childId =
    port.spawnInputs[port.spawnedProcesses.indexOf(process)]?.env
      .WEAVE_CHILD_ID;
  if (childId === undefined) throw new Error("missing child id");
  const random = new WebCryptoRandomPort();
  const hmac = new WebCryptoHmacPort();
  let sequence = 1;
  const send = async (kind: PiControlKind, body: JsonValue): Promise<void> => {
    const signed = await signEnvelope(
      {
        childId,
        generationId,
        direction: "child-to-parent",
        sequence: sequence++,
        nonce: generateNonceHex(random),
        correlationId: childId,
        kind,
        body,
      },
      secret,
      hmac,
    );
    if (signed.isErr()) throw new Error("could not sign fake reply");
    process.emitLine(signed.value);
  };
  await send("handshake", {});
  await flush();
  await send("bootstrap-ack", {});
  await flush();
  await flush();
  const entriesRequest = process
    .writtenLines()
    .find(
      (line): line is { type: string; id: string; command: string } =>
        typeof line === "object" &&
        line !== null &&
        (line as { type?: unknown }).type === "get_entries",
    );
  if (entriesRequest !== undefined) {
    process.emitLine({
      type: "response",
      id: entriesRequest.id,
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: "leaf-42" },
    });
    await flush();
  }
  process.emitLine({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: output }] },
  });
  await send("settled", {
    outcome: "completed",
    assistantOutput: output,
    outputByteLength: encoder.encode(output).byteLength,
  });
}

async function runningRpc() {
  const processPort = new FakeChildProcessPort();
  const child = new PiRpcChild("child-1", ROOT_NODE_ID, "gen-1", "shuttle", 1, {
    processPort,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    randomPort,
    hmacPort,
    logger: noopLogger,
  });
  const spawnedResult = child.spawnAndHandshake(input);
  await flush();
  const spawned = processAt(processPort, 0);
  const secret = secretFor(processPort, spawned);
  let sequence = 1;
  const send = async (kind: PiControlKind, body: JsonValue): Promise<void> => {
    const signed = await signEnvelope(
      {
        childId: "child-1",
        generationId: "gen-1",
        direction: "child-to-parent",
        sequence: sequence++,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind,
        body,
      },
      secret,
      hmacPort,
    );
    if (signed.isErr()) throw new Error("could not sign fake reply");
    spawned.emitLine(signed.value);
  };
  await send("handshake", {});
  expect((await spawnedResult).isOk()).toBe(true);
  const run = child.runTask(input, bootstrapFor("child-1"));
  await flush();
  await send("bootstrap-ack", {});
  await flush();
  return { child, spawned, run, send, secret };
}

const resumeConfig = config(`
workflow recovery-flow {
  description "Recovery workflow"
  version 1
  step verify {
    name "Verify recovery"
    type autonomous
    agent shuttle
    prompt "verify {{instance.goal}}"
    completion agent_signal
  }
}
`);

/**
 * Since ADR 0014 restores take the parent session's child-ref record and read
 * the session location plus active leaf from the native session tree.
 */
function recoveryRecord(childId: string): PiChildRecoveryRecord {
  return {
    childId,
    threadId: childId,
    nativeSessionId: `native-${childId}`,
    sessionRef: `children/${childId}/session.jsonl`,
    originParentSessionId: "parent",
    originEntryId: `entry-${childId}`,
    title: "shuttle",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    runs: [{ run: 1, action: "start", startedAt: 1 }],
  };
}

/** Structural Task 4 native session source backing the restore path. */
function restoreSessions(childId: string) {
  const record = (ref: string) => ({
    childId,
    sessionId: `native-${childId}`,
    ref,
    path: `/history/children/${childId}/session.jsonl`,
    parentSession: "parent",
    cwd: "/project",
  });
  return () =>
    ({
      mintLaunchGrant: (input: {
        readonly childId: string;
        readonly record: { readonly path: string; readonly sessionId: string };
        readonly activeLeafId: string;
      }) =>
        ok(
          mintTestOnlyLaunchGrant(TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY, {
            childId: input.childId,
            sessionId: input.record.sessionId,
            sessionDir: input.record.path.slice(
              0,
              input.record.path.lastIndexOf("/"),
            ),
            sessionPath: input.record.path,
            activeLeafId: input.activeLeafId,
          }),
        ),
      createChildSession: () =>
        okAsync(record(`children/${childId}/session.jsonl`)),
      establishThreadLeaf: (ref: string) =>
        okAsync({ record: record(ref), leafId: "leaf-42" }),
      appendTombstone: () => okAsync({ ref: "tombstoned" } as never),
      openSession: (ref: string) => okAsync(record(ref)),
      readThreadMetadata: () => okAsync({ threadId: childId } as never),
      readSessionEntries: (ref: string) =>
        okAsync({ record: record(ref), entries: [{ id: "leaf-42" }] }),
    }) as never;
}

test("real ordinary, nested, and workflow execution retain only bounded topology metadata", async () => {
  const port = new FakeChildProcessPort();
  const terminal: Array<{ id: string; snapshot: unknown; output?: string }> =
    [];
  const history: PiChildInspectionHistoryPort = {
    register: () => okAsync(undefined),
    checkpoint: () => okAsync(undefined),
    terminal: (id, snapshot, output) => {
      terminal.push({ id, snapshot, output });
      return okAsync(undefined);
    },
  };
  const registry = new PiChildInspectionRegistry(history);
  const controller = new PiDelegationController({
    config: generous,
    generationId: "gen-1",
    idGenerator: new Ids(),
    logger: noopLogger,
    processPort: port,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    randomPort,
    hmacPort,
    timerPort: new SystemTimerPort(),
    cancelGraceMs: 10,
    rootAgentName: () => "loom",
    resolveDelegationTarget: () => ({ name: "shuttle" }) as never,
    buildBootstrap: (_target, childId) => bootstrapFor(childId),
    inspectionRegistry: registry,
  });
  const ordinary = controller.delegate(request());
  await flush();
  const nested = controller.delegate(
    request({
      parentId: "child-1",
      parentDepth: 1,
      parentAgentName: "shuttle",
    }),
  );
  await flush();
  expect(
    controller.snapshotTree().map((node) => [node.parentId, node.status]),
  ).toEqual([
    [ROOT_NODE_ID, "handshaking"],
    ["child-1", "handshaking"],
  ]);
  await settleProcess(port, processAt(port, 0));
  await settleProcess(port, processAt(port, 1));
  expect((await ordinary).isOk()).toBe(true);
  expect((await nested).isOk()).toBe(true);

  const workflowPort = new FakeChildProcessPort();
  const workflowRegistry = new PiChildInspectionRegistry(history);
  const workflow = createDirectDispatchTransport(
    {
      processPort: workflowPort,
      sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
      randomPort,
      hmacPort,
      logger: noopLogger,
      idGenerator: new Ids(),
      inspectionRegistry: workflowRegistry,
      registry: new PiDirectStepChildRegistry(),
    },
    "gen-1",
  )({
    agentName: "shuttle",
    composedPrompt: "workflow prompt",
    models: [],
    delegationTargets: [],
    workflowInstanceId: "workflow-1",
    leaseId: "lease-1",
    stepName: "verify",
    taskPrompt: "run verify",
    cwd: "/project",
    correlationId: "effect-1",
  });
  await flush();
  await settleProcess(workflowPort, processAt(workflowPort, 0));
  expect((await workflow).isOk()).toBe(true);

  const ids = terminal.map(({ id }) => id);
  expect(ids).toEqual([
    "child-1",
    "child-2",
    "direct-workflow-1-verify-child-1",
  ]);
  expect((terminal[0]?.snapshot as { parentId?: string }).parentId).toBe(
    ROOT_NODE_ID,
  );
  expect((terminal[1]?.snapshot as { parentId?: string }).parentId).toBe(
    "child-1",
  );
  expect((terminal[2]?.snapshot as { status?: string }).status).toBe(
    "completed",
  );
  expect(
    terminal.every(({ output }) => output === "bounded terminal result"),
  ).toBe(true);
  expect(JSON.stringify(terminal)).not.toContain("workflow prompt");
  expect(JSON.stringify(terminal)).not.toContain("intermediate");
  controller.disposeAll();
});

test("real RPC lifecycle supports steer, queued follow-up, UI response, interruption, and restart", async () => {
  const running = await runningRpc();
  const steer = running.child.steer("child-1", "gen-1", "steer");
  await flush();
  const steerLine = running.spawned.writtenLines().at(-1) as { id: string };
  running.spawned.emitLine({
    id: steerLine.id,
    type: "response",
    command: "steer",
    success: true,
  });
  expect((await steer).isOk()).toBe(true);
  const follow = running.child.followUp("child-1", "gen-1", "follow-up");
  await flush();
  const followLine = running.spawned.writtenLines().at(-1) as { id: string };
  running.spawned.emitLine({
    id: followLine.id,
    type: "response",
    command: "follow_up",
    success: true,
  });
  expect((await follow).isOk()).toBe(true);
  running.spawned.emitLine({
    type: "extension_ui_request",
    requestType: "dialog",
    requestId: "ui-1",
  });
  await flush();
  expect(
    (
      await running.child.sendExtensionUiResponse("child-1", "gen-1", {
        type: "extension_ui_response",
        requestId: "ui-1",
        response: "yes",
      })
    ).isOk(),
  ).toBe(true);
  expect(running.spawned.writtenText).toContain('"id":"ui-1"');
  const run = running.run;
  running.spawned.endStdout();
  expect((await run).isErr()).toBe(true);
  expect(running.child.snapshot().status).toBe("failed");

  // Restart through the controller's authenticated restore seam, not by
  // constructing another child directly. The restore must use a new process.
  const restorePort = new FakeChildProcessPort();
  const restoredTerminal: Array<{ id: string; output?: string }> = [];
  const restoreRegistry = new PiChildInspectionRegistry({
    register: () => okAsync(undefined),
    checkpoint: () => okAsync(undefined),
    terminal: (id, _snapshot, output) => {
      restoredTerminal.push({ id, output });
      return okAsync(undefined);
    },
  });
  const restoreController = new PiDelegationController({
    config: generous,
    generationId: "gen-1",
    idGenerator: new Ids(),
    logger: noopLogger,
    processPort: restorePort,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    randomPort,
    hmacPort,
    timerPort: new SystemTimerPort(),
    cancelGraceMs: 10,
    rootAgentName: () => "loom",
    resolveRootDelegationTarget: () => ({ name: "shuttle" }) as never,
    buildBootstrap: (_target, childId) => bootstrapFor(childId),
    pathContainment: {
      verifyContainment: () => okAsync("/history/children/child-1"),
    },
    threadSessions: restoreSessions("child-1"),
    currentCwd: () => "/project",
    inspectionRegistry: restoreRegistry,
  });
  const restarted = restoreController.restoreOrdinaryChild({
    generationId: "gen-1",
    descriptor: { name: "shuttle" },
    continuation: "private continuation must not escape",
    record: recoveryRecord("child-1"),
  });
  await flush();
  expect(restorePort.spawnedProcesses).toHaveLength(1);
  await settleProcess(restorePort, processAt(restorePort, 0));
  const restartedResult = await restarted;
  expect(restartedResult.isOk()).toBe(true);
  if (restartedResult.isOk()) {
    expect(restartedResult.value).toEqual({
      finalOutput: "bounded terminal result",
      interventionCount: 0,
    });
    expect(JSON.stringify(restartedResult.value)).not.toContain(
      "private continuation",
    );
  }
  expect(restoredTerminal).toEqual([
    { id: "child-1", output: "bounded terminal result" },
  ]);
  expect(JSON.stringify(restoredTerminal)).not.toContain(
    "private continuation",
  );
  restoreController.disposeAll();
});

test("real ordinary recovery resumes through the controller and preserves bounded result", async () => {
  const port = new FakeChildProcessPort();
  const registry = new PiChildInspectionRegistry();
  const controller = new PiDelegationController({
    config: generous,
    generationId: "gen-1",
    idGenerator: new Ids(),
    logger: noopLogger,
    processPort: port,
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    randomPort,
    hmacPort,
    timerPort: new SystemTimerPort(),
    cancelGraceMs: 10,
    rootAgentName: () => "loom",
    resolveRootDelegationTarget: () => ({ name: "shuttle" }) as never,
    buildBootstrap: (_target, childId) => bootstrapFor(childId),
    pathContainment: {
      verifyContainment: () => okAsync("/history/children/recover-me"),
    },
    threadSessions: restoreSessions("recover-me"),
    currentCwd: () => "/project",
    inspectionRegistry: registry,
  });
  const resumed = controller.restoreOrdinaryChild({
    generationId: "gen-1",
    descriptor: { name: "shuttle" },
    continuation: "continue",
    record: recoveryRecord("recover-me"),
  });
  await flush();
  await settleProcess(port, processAt(port, 0));
  const resumedResult = await resumed;
  expect(resumedResult.isOk()).toBe(true);
  expect(resumedResult._unsafeUnwrap()).toEqual({
    finalOutput: "bounded terminal result",
    interventionCount: 0,
  });
  expect(JSON.stringify(resumedResult._unsafeUnwrap())).not.toContain(
    "continue",
  );
  controller.disposeAll();
});

test("the actual workflow resume controller completes the persisted step", async () => {
  const store = createInMemoryRuntimeStore();
  const created = await store.instances.create({
    workflowName: "recovery-flow",
    goal: "resume the interrupted step",
    slug: "resume-the-interrupted-step",
  });
  expect(created.isOk()).toBe(true);
  if (created.isErr()) return;

  const workflow = resumeConfig.workflows["recovery-flow"];
  if (workflow === undefined) throw new Error("missing recovery workflow");
  const context = {
    workflowName: "recovery-flow",
    goal: "resume the interrupted step",
    slug: "resume-the-interrupted-step",
    workflows: { "recovery-flow": workflow },
  };
  let dispatchCount = 0;
  let dispatchOutcome: "paused" | "success" = "paused";
  const directDispatch = {
    dispatch: (input: { workflowInstanceId: string; stepName: string }) => {
      dispatchCount += 1;
      expect(input.workflowInstanceId).toBe(created.value.id);
      expect(input.stepName).toBe("verify");
      return okAsync({ outcome: dispatchOutcome, method: "agent_signal" });
    },
  };
  const recoveryPointerStore = new InMemoryRecoveryPointerStore();
  const deps = {
    store,
    directDispatch,
    recoveryPointerStore,
    clock: { now: () => 1_700_000_000_000 },
    idGenerator: { next: () => "resume-attempt" },
    logger: noopLogger,
    controllerGenerationId: "gen-1",
    assertGenerationCurrent: () => ok(undefined),
    ownerId: "gen-1",
    projectRoot: "/project",
    maxAutoAdvanceSteps: 2,
    resolveAgentDescriptor: (name: string) => ({
      name,
      composedPrompt: "bounded workflow prompt",
      models: [],
      mode: "subagent",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "deny",
        network: "deny",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    }),
  };
  const controller = new PiWorkflowController(deps as never);
  const authorization = authorizeByExplicitUser(true);
  expect(authorization.isOk()).toBe(true);
  if (authorization.isErr()) return;
  const started = await controller.startExecution(
    { workflowInstanceId: created.value.id, context },
    authorization.value,
  );
  if (started.isErr())
    throw new Error(`start failed: ${JSON.stringify(started.error)}`);
  expect(started.isOk()).toBe(true);
  expect(dispatchCount).toBe(1);
  if (started.isOk()) {
    recoveryPointerStore.appendPointer({
      schemaVersion: 1,
      workflowId: created.value.id,
      leaseId: started.value.leaseId,
      controllerGeneration: "gen-1",
      attempt: {
        attemptId: "00000000-0000-4000-8000-000000000001",
      },
      status: "recoverable",
      observedAt: "2024-01-01T00:00:00.000Z",
    });
  }

  dispatchOutcome = "success";
  const freshController = new PiWorkflowController({
    ...deps,
    ownerId: "owner-new",
    controllerGenerationId: "gen-2",
  } as never);
  const resumed = await freshController.resumeExecution(
    {
      workflowInstanceId: created.value.id,
      context,
      metadata: {
        weaveResumeAttemptId: "00000000-0000-4000-8000-000000000002",
        weaveResumePreviousAttemptId: "00000000-0000-4000-8000-000000000001",
      },
      recoveryTakeover: {
        expectedLeaseId: started.isOk() ? (started.value.leaseId ?? "") : "",
        expectedControllerGeneration: "gen-1",
      },
    },
    authorization.value,
  );
  if (resumed.isErr()) throw new Error(JSON.stringify(resumed.error));
  expect(resumed.isOk()).toBe(true);
  expect(dispatchCount).toBe(2);
  const inspected = await controller.inspect(created.value.id);
  expect(inspected.isOk()).toBe(true);
  if (inspected.isOk()) {
    expect(inspected.value.workflowInstanceId).toBe(created.value.id);
    expect(inspected.value.workflowName).toBe("recovery-flow");
    expect(inspected.value.status).toBe("completed");
  }
});

test("the real RPC child accepts a >1 MiB assistant record and settles without poison", async () => {
  const running = await runningRpc();
  const payload = "assistant-private-canary";
  const native = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      id: "large",
      // A terminal assistant response satisfies the child result contract; the
      // oversized private payload rides alongside it (Pi adapter contract §10).
      content: [{ type: "text", text: "done" }],
      details: { text: "x".repeat(1_050_000) + payload },
    },
  });
  const nativeBytes = encoder.encode(`${native}\n`);
  expect(nativeBytes.byteLength).toBeGreaterThan(1024 * 1024);
  expect(nativeBytes.byteLength).toBeLessThanOrEqual(MAX_NATIVE_RECORD_BYTES);
  running.spawned.emit(nativeBytes);
  await running.send("settled", {
    outcome: "completed",
    assistantOutput: "done",
  });
  const result = await running.run;
  expect(result.isOk()).toBe(true);
  expect(JSON.stringify(result)).not.toContain(payload);
  expect(JSON.stringify(result)).not.toContain("ChildSettlementMissing");
});

test("the real RPC decoder rejects a signed control body over 64 KiB exactly", async () => {
  const running = await runningRpc();
  const body = { payload: "control-private-canary".repeat(5_000) } as JsonValue;
  const unsigned = {
    type: "weave_control",
    schemaVersion: 1,
    childId: "child-1",
    generationId: "gen-1",
    direction: "child-to-parent",
    sequence: 1,
    nonce: generateNonceHex(randomPort),
    correlationId: "child-1",
    kind: "settled",
    body,
  } as const;
  const bytes = canonicalizeToBytes(unsigned as JsonValue);
  expect(bytes.isOk()).toBe(true);
  if (bytes.isErr()) return;
  expect(bytes.value.byteLength).toBeGreaterThan(MAX_CONTROL_BODY_BYTES);
  const mac = await hmacPort.signHex(running.secret, bytes.value);
  expect(mac.isOk()).toBe(true);
  if (mac.isErr()) return;
  running.spawned.emitLine({ ...unsigned, mac: mac.value });
  const result = await running.run;
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.code).toBe("ChildAuthenticationFailed");
    expect(result.error.correlation).toEqual({ reason: "BodyTooLarge" });
  }
  expect(running.child.snapshot().status).toBe("failed");
});
