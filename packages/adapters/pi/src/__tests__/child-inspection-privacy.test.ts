import { expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
  MAX_LATEST_OUTPUT_BYTES,
  truncateLatestOutput,
} from "../child-tree.js";
import { TransportDirectDispatchPort } from "../direct-dispatch.js";
import { createPiExtension } from "../extension.js";
import {
  FakeClock,
  FakeIdGenerator,
  RecordingFakePiHost,
} from "./fakes/fake-pi-host.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

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

test("private canaries stay out of every parent-facing projection", async () => {
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
    expect(boundedParentResult).not.toContain(canary);
  }
  expect(boundedParentResult).toContain("bounded terminal output");
  expect(
    truncateLatestOutput(privateCanaryText.repeat(100)).length,
  ).toBeLessThanOrEqual(MAX_LATEST_OUTPUT_BYTES);
});

test("parent result is the bounded terminal projection plus numeric metadata", async () => {
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
    sessionStorageAuthority: TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
  });
  factory(host.api);

  await host.triggerSessionStart();
  await host.invokeCommand("weave:health", PRIVATE.healthCanary);

  const message = host.notifyCalls.at(-1)?.message ?? "";
  expect(message).toContain("Weave adapter mode:");
  expect(message).not.toContain(PRIVATE.healthCanary);
});
