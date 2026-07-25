/**
 * SQLite-backed regression tests for `resumeExecution`'s explicit
 * `recoveryTakeover` correlation (Issue #21 Task 12 S020).
 *
 * Mirrors the exact live-smoke S020 regression: a reload leaves the
 * Runtime Store with a paused WorkflowInstance and an unexpired
 * pre-reload lease (S019). A fresh owner (new controller generation)
 * must be able to take over that exact lease only when the caller
 * supplies the correlated lease ID and owner - never a broad foreign
 * lease steal.
 *
 * @see packages/engine/src/execution-lifecycle/resume.ts
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md — §18
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionLeaseId,
  createOwnerId,
  createSqliteRuntimeStore,
  type RuntimeStore,
  resumeExecution,
} from "@weaveio/weave-engine";

let testDir: string;

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `weave-resume-takeover-test-${crypto.randomUUID()}`,
  );
  Bun.spawnSync(["mkdir", "-p", dir]);
  return dir;
}

function makeStore(dir: string): RuntimeStore {
  return createSqliteRuntimeStore({
    dbPath: join(dir, "runtime", "weave.db"),
    projectRoot: dir,
  });
}

beforeEach(() => {
  testDir = makeTempDir();
});

afterEach(() => {
  Bun.spawnSync(["rm", "-rf", testDir]);
});

async function pausedInstanceWithOldLease(store: RuntimeStore) {
  const createResult = await store.instances.create({
    workflowName: "reload-workflow",
    goal: "reload goal",
    slug: "reload-goal",
  });
  if (!createResult.isOk()) throw new Error("failed to create instance");
  const instanceId = createResult.value.id;
  await store.instances.update(instanceId, { status: "paused" });

  const oldLeaseResult = await store.leases.acquire({
    workflowInstanceId: instanceId,
    ownerId: createOwnerId("controller-gen-old"),
    ttlMs: 3_600_000,
  });
  if (!oldLeaseResult.isOk()) throw new Error("failed to acquire old lease");

  return { instanceId, oldLease: oldLeaseResult.value };
}

describe("resumeExecution > recoveryTakeover (SQLite)", () => {
  it("reload leaves the store at wait with no child, and S019 stays inert (no auto resume)", async () => {
    const store = makeStore(testDir);
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    // A reload never itself calls resumeExecution — the instance and its
    // unexpired lease simply persist across the "restart" boundary.
    const instance = await store.instances.getById(instanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("paused");

    const active = await store.leases.findActive();
    expect(active.isOk()).toBe(true);
    if (!active.isOk()) return;
    expect(active.value?.id).toBe(oldLease.id);

    await store.close();
  });

  it("takes over the exact correlated pre-reload lease with a fresh owner", async () => {
    const store = makeStore(testDir);
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.leaseId).not.toBe(oldLease.id);

    const oldLeaseLookup = await store.leases.findById(oldLease.id);
    expect(oldLeaseLookup.isOk()).toBe(true);
    if (!oldLeaseLookup.isOk()) return;
    expect(oldLeaseLookup.value).toBeNull();

    const freshLease = await store.leases.getById(result.value.leaseId);
    expect(freshLease.isOk()).toBe(true);
    if (!freshLease.isOk()) return;
    expect(freshLease.value.ownerId).toBe(createOwnerId("controller-gen-new"));

    const instance = await store.instances.getById(instanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("running");

    await store.close();
  });

  it("fails closed with no mutation when the correlation mismatches the active lease", async () => {
    const store = makeStore(testDir);
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: createExecutionLeaseId("wrong-lease-id"),
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");

    const stillActive = await store.leases.findById(oldLease.id);
    expect(stillActive.isOk()).toBe(true);
    if (!stillActive.isOk()) return;
    expect(stillActive.value).not.toBeNull();

    const instance = await store.instances.getById(instanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("paused");

    await store.close();
  });

  it("fails closed without recoveryTakeover, matching the exact S020 regression (LeaseLost path)", async () => {
    const store = makeStore(testDir);
    const { instanceId } = await pausedInstanceWithOldLease(store);

    // No correlation supplied - this is the exact pre-fix S020 behavior:
    // resumeExecution's plain acquire conflicts on the unexpired old lease.
    const result = await resumeExecution(
      { workflowInstanceId: instanceId, ownerId: "controller-gen-new" },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");

    await store.close();
  });

  it("fails closed with no mutation when authorizationSource is missing for a takeover", async () => {
    const store = makeStore(testDir);
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("authorizationSource");
    }

    const stillActive = await store.leases.findById(oldLease.id);
    expect(stillActive.isOk()).toBe(true);
    if (!stillActive.isOk()) return;
    expect(stillActive.value).not.toBeNull();

    await store.close();
  });
});
