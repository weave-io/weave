import { expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import { createPiExtension } from "../extension.js";
import { MemoryPiChildHistoryFs } from "../child-history-fs.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
} from "./fakes/fake-pi-host.js";
import type { PiChildHistoryRecord } from "../child-history-schema.js";
import { PiChildHistoryStore } from "../child-history-store.js";
import {
  MAX_LATEST_OUTPUT_BYTES,
  truncateLatestOutput,
} from "../child-tree.js";
import { TransportDirectDispatchPort } from "../direct-dispatch.js";

const PRIVATE = {
  healthCanary: "PRIVATE-HEALTH-COMMAND-CANARY",
  prompt: "PRIVATE-PROMPT-CANARY",
  task: "PRIVATE-TASK-CANARY",
  intervention: "PRIVATE-INTERVENTION-CANARY",
  toolArgs: "PRIVATE-TOOL-ARGS-CANARY",
  image: "PRIVATE-IMAGE-CANARY",
  rpcBody: "PRIVATE-RPC-BODY-CANARY",
  path: "PRIVATE-PATH-CANARY",
  secret: "PRIVATE-SECRET-CANARY",
};
const privateCanaries = {
  projection: [
    PRIVATE.prompt,
    PRIVATE.task,
    PRIVATE.intervention,
    PRIVATE.toolArgs,
    PRIVATE.image,
    PRIVATE.rpcBody,
    PRIVATE.path,
    PRIVATE.secret,
  ],
} as const;

const privateCanaryText = privateCanaries.projection.join(" ");
const base: PiChildHistoryRecord = {
  childId: "child",
  parentSessionId: "parent",
  kind: "ordinary",
  status: "settled",
  workflow: {},
  sessionPath: "children/child/session.jsonl",
  checkpointCursor: 0,
  branchAncestry: [],
  interventionCount: 1,
  finalOutput: "safe final output",
  trim: { trimmed: false, markerCount: 0 },
  quarantine: { quarantined: false },
  clear: { cleared: false },
  recovery: { eligible: true, count: 0 },
  bytes: { session: 0, checkpoint: 0, total: 0 },
  createdAt: 1,
  updatedAt: 1,
};

test("private canaries stay out of every parent-facing history projection", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const opened = await PiChildHistoryStore.open(
    "parent",
    {
      persist_history: true,
      max_bytes_per_child: 4 * 1024 * 1024,
      max_bytes_total: 64 * 1024 * 1024,
      orphan_retention_days: 30,
    },
    { fs, now: () => 10 },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) return;
  const store = opened.value;
  expect((await store.upsertRecord(base)).isOk()).toBe(true);
  expect(
    (
      await store.appendSessionEvent("child", {
        type: "follow-up",
        text: `${PRIVATE.prompt} ${PRIVATE.task} ${PRIVATE.intervention}`,
        at: 2,
      })
    ).isOk(),
  ).toBe(true);
  expect(
    (
      await store.appendCheckpoint(
        "child",
        [
          {
            id: "root",
            kind: "message",
            payload: {
              prompt: PRIVATE.prompt,
              task: PRIVATE.task,
              intervention: PRIVATE.intervention,
              toolArgs: { value: PRIVATE.toolArgs },
              image: PRIVATE.image,
              rpcBody: PRIVATE.rpcBody,
              path: PRIVATE.path,
              secret: PRIVATE.secret,
            },
          },
        ],
        "root",
      )
    ).isOk(),
  ).toBe(true);

  const persistedSession = await store.readSessionEvents("child");
  expect(persistedSession.isOk()).toBe(true);
  const persistedCheckpoint = await store.readCheckpointFor("child");
  expect(persistedCheckpoint.isOk()).toBe(true);
  const privateHistory = `${
    persistedSession.isOk() ? JSON.stringify(persistedSession.value) : ""
  }${persistedCheckpoint.isOk() ? JSON.stringify(persistedCheckpoint.value) : ""}`;
  for (const canary of privateCanaries.projection) {
    expect(privateHistory).toContain(canary);
  }

  const ordinaryHistoryProjection = JSON.stringify(store.getIndex());
  expect(
    privateCanaries.projection.every(
      (canary) => !ordinaryHistoryProjection.includes(canary),
    ),
  ).toBe(true);
  const direct = new TransportDirectDispatchPort(() =>
    okAsync({
      outcome: "completed" as const,
      completionCandidate: JSON.stringify({
        outcome: "success",
        message: "bounded terminal output",
      }),
      interventionCount: 2,
    }),
  );
  const parentResult = await direct.dispatch({
    workflowInstanceId: "workflow",
    leaseId: "lease",
    stepName: "step",
    agentName: "shuttle",
    composedPrompt: privateCanaryText,
    taskPrompt: privateCanaryText,
    cwd: "/private/worktree",
    correlationId: "correlation",
    models: [],
    delegationTargets: [],
  });
  expect(parentResult.isOk()).toBe(true);
  const boundedParentResult = JSON.stringify(parentResult);
  for (const canary of privateCanaries.projection) {
    expect(ordinaryHistoryProjection).not.toContain(canary);
    expect(boundedParentResult).not.toContain(canary);
  }
  expect(boundedParentResult).toContain("bounded terminal output");
  expect(
    truncateLatestOutput(privateCanaryText.repeat(100)).length,
  ).toBeLessThanOrEqual(MAX_LATEST_OUTPUT_BYTES);
  store.close();
});

test("parent result is the store's terminal projection plus numeric metadata", async () => {
  const fs = new MemoryPiChildHistoryFs();
  const opened = await PiChildHistoryStore.open(
    "projection-parent",
    {
      persist_history: true,
      max_bytes_per_child: 4 * 1024 * 1024,
      max_bytes_total: 64 * 1024 * 1024,
      orphan_retention_days: 30,
    },
    { fs, now: () => 10 },
  );
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) return;
  expect((await opened.value.upsertRecord(base)).isOk()).toBe(true);
  const direct = new TransportDirectDispatchPort(() =>
    okAsync({
      outcome: "completed" as const,
      completionCandidate: JSON.stringify({
        outcome: "success",
        message: "safe final output",
      }),
      interventionCount: 1,
    }),
  );
  const result = await direct.dispatch({
    workflowInstanceId: "projection-workflow",
    leaseId: "projection-lease",
    stepName: "projection-step",
    agentName: "shuttle",
    composedPrompt: "PRIVATE-INTERMEDIATE-PROMPT",
    taskPrompt: "PRIVATE-TASK-CONTENT",
    cwd: "/tmp/private",
    correlationId: "projection-correlation",
    models: [],
    delegationTargets: [],
  });
  expect(result.isOk()).toBe(true);
  expect(
    result.match(
      (value) => value,
      () => undefined,
    ),
  ).toEqual({
    outcome: "success",
    message: "safe final output",
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE-INTERMEDIATE-PROMPT");
  expect(JSON.stringify(result)).not.toContain("PRIVATE-TASK-CONTENT");
  opened.value.close();
});

test("real /weave:health output does not include private command args", async () => {
  const host = new RecordingFakePiHost({
    mode: "tui",
    trusted: false,
    cwd: "/tmp/weave-task13-fake-host",
    installPath: "/tmp/weave-task13-fake-host",
  });
  const factory = createPiExtension({
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
  });
  factory(host.api);

  await host.triggerSessionStart();
  await host.invokeCommand("weave:health", PRIVATE.healthCanary);

  const message = host.notifyCalls.at(-1)?.message ?? "";
  expect(message).toContain("Weave adapter mode:");
  expect(message).not.toContain(PRIVATE.healthCanary);
});
