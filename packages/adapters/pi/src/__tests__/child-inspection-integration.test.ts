import { expect, test } from "bun:test";
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
import { MemoryPiChildHistoryFs } from "../child-history-fs.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import { PiChildHistoryStore } from "../child-history-store.js";
import type { PiChildInspectionSettings } from "../child-inspection-settings.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { canonicalizeToBytes, type JsonValue } from "../strict-json.js";
import {
  FakeChildProcessPort,
  type FakeSpawnedProcess,
} from "./fakes/fake-child-process-port.js";

const canary = "PRIVATE-CANARY-7f2b";
const encoder = new TextEncoder();
const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();
const input: PiRpcChildSpawnInput = {
  childId: "child-1",
  parentId: "root",
  generationId: "gen-1",
  agentName: "shuttle",
  depth: 1,
  cwd: "/project",
  env: {},
  task: "inspect the child",
};
const bootstrap = {
  mode: "ordinary",
  agentName: "shuttle",
  composedPrompt: "bounded",
  models: [],
  correlationId: "child-1",
  context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
} as JsonValue;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function runningRpc() {
  const processPort = new FakeChildProcessPort();
  const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
    processPort,
    randomPort,
    hmacPort,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const spawnedResult = child.spawnAndHandshake(input);
  await flush();
  const spawned = processPort.spawnedProcesses[0] as FakeSpawnedProcess;
  const secretHex = processPort.spawnInputs[0]?.env[WEAVE_CHILD_SECRET_ENV];
  if (secretHex === undefined) throw new Error("missing child secret");
  const secret = hexToBytes(secretHex);
  if (secret === undefined) throw new Error("invalid child secret");
  let sequence = 1;
  const send = async (kind: PiControlKind, body: JsonValue) => {
    const envelope = await signEnvelope(
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
    if (envelope.isErr()) throw new Error("could not sign fake reply");
    spawned.emitLine(envelope.value);
  };
  await send("handshake", {});
  expect((await spawnedResult).isOk()).toBe(true);
  const run = child.runTask(input, bootstrap);
  await flush();
  await send("bootstrap-ack", {});
  await flush();
  return { child, spawned, run, send, secret };
}

const record = (
  childId: string,
  overrides: Partial<PiChildHistoryRecord> = {},
): PiChildHistoryRecord => ({
  childId,
  parentSessionId: "parent-session",
  kind: "ordinary",
  status: "settled",
  workflow: {},
  sessionPath: `children/${childId}/session.jsonl`,
  checkpointCursor: 0,
  branchAncestry: [],
  interventionCount: 2,
  finalOutput: "bounded terminal result",
  trim: { trimmed: false, markerCount: 0 },
  quarantine: { quarantined: false },
  clear: { cleared: false },
  recovery: { eligible: true, count: 0 },
  bytes: { session: 0, checkpoint: 0, total: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

async function open(
  fs = new MemoryPiChildHistoryFs(),
  now = 10,
  settings: Partial<PiChildInspectionSettings> = {},
) {
  return PiChildHistoryStore.open(
    "parent-session",
    {
      persist_history: true,
      max_bytes_per_child: 4 * 1024 * 1024,
      max_bytes_total: 64 * 1024 * 1024,
      orphan_retention_days: 30,
      ...settings,
    },
    { fs, now: () => now },
  );
}

test("fake nested and workflow children expose bounded metadata only", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const opened = await open(fs);
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) return;
  const store = opened.value;
  expect(
    (
      await store.upsertRecord(
        record("nested", { kind: "nested", parentChildId: "root" }),
      )
    ).isOk(),
  ).toBe(true);
  expect(
    (
      await store.upsertRecord(
        record("workflow", {
          kind: "workflow-step",
          workflow: { workflow: "release", step: "verify" },
        }),
      )
    ).isOk(),
  ).toBe(true);
  await store.appendSessionEvent("nested", {
    type: "steer",
    text: canary,
    at: 2,
  });
  await store.appendCheckpoint(
    "workflow",
    [{ id: "root", kind: "message", payload: canary }],
    "root",
  );

  const exported = JSON.stringify(store.getIndex());
  expect(exported).toContain("bounded terminal result");
  expect(exported).not.toContain(canary);
  expect(
    store
      .getIndex()
      .records.map(({ childId, status, finalOutput, interventionCount }) => ({
        childId,
        status,
        finalOutput,
        interventionCount,
      })),
  ).toEqual([
    {
      childId: "nested",
      status: "settled",
      finalOutput: "bounded terminal result",
      interventionCount: 2,
    },
    {
      childId: "workflow",
      status: "settled",
      finalOutput: "bounded terminal result",
      interventionCount: 2,
    },
  ]);
  store.close();
});

test("the real RPC child accepts a >1 MiB assistant record and settles without poison", async () => {
  const running = await runningRpc();
  const payload = "assistant-private-canary";
  const native = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      id: "large",
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
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  expect(running.child.snapshot().status).toBe("completed");
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
