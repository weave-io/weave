/**
 * Usage observations + durable rollups (Spec 12 extension / Spec 33 §19.4).
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryRuntimeStore,
  createSqliteRuntimeStore,
  createUsageObservationId,
  createWorkflowInstanceId,
  type RuntimeStore,
  type UsageObservation,
} from "../index.js";

function baseObservation(
  overrides: Partial<UsageObservation> = {},
): UsageObservation {
  return {
    id: createUsageObservationId("obs-1"),
    timestamp: "2026-01-01T00:00:00.000Z",
    source: { kind: "adapter", name: "test" },
    inputTokens: 10,
    outputTokens: 5,
    ...overrides,
  };
}

async function expectUsageContract(store: RuntimeStore): Promise<void> {
  const first = await store.usage.recordObservation(baseObservation());
  expect(first.isOk()).toBe(true);
  expect(first._unsafeUnwrap().kind).toBe("inserted");

  // Same ID + identical values → no-op
  const noop = await store.usage.recordObservation(baseObservation());
  expect(noop.isOk()).toBe(true);
  expect(noop._unsafeUnwrap().kind).toBe("noop");

  // Same ID + different values → invariant breach
  const conflict = await store.usage.recordObservation(
    baseObservation({ inputTokens: 99 }),
  );
  expect(conflict.isErr()).toBe(true);
  expect(conflict._unsafeUnwrapErr().type).toBe("invariant_violation");

  // Independent field sums — second observation missing outputTokens
  const second = await store.usage.recordObservation(
    baseObservation({
      id: createUsageObservationId("obs-2"),
      timestamp: "2026-01-01T00:01:00.000Z",
      inputTokens: 3,
      outputTokens: undefined,
      cost: 1.5,
    }),
  );
  expect(second.isOk()).toBe(true);

  const rollups = await store.usage.listRollups();
  expect(rollups.isOk()).toBe(true);
  const rollup = rollups._unsafeUnwrap()[0];
  expect(rollup).toBeDefined();
  expect(rollup?.observationCount).toBe(2);
  expect(rollup?.inputTokens).toBe(13);
  expect(rollup?.outputTokens).toBe(5); // only first observation contributed
  expect(rollup?.cost).toBe(1.5);

  // Prune details without subtracting rollups
  const pruned = await store.usage.pruneDetails({
    olderThan: "2026-01-01T00:00:30.000Z",
  });
  expect(pruned.isOk()).toBe(true);
  expect(pruned._unsafeUnwrap().removedByAge).toBe(1);

  const remaining = await store.usage.listObservations();
  expect(remaining._unsafeUnwrap()).toHaveLength(1);
  expect(remaining._unsafeUnwrap()[0]?.id).toBe(
    createUsageObservationId("obs-2"),
  );

  const rollupsAfter = await store.usage.listRollups();
  const after = rollupsAfter._unsafeUnwrap()[0];
  expect(after?.observationCount).toBe(2);
  expect(after?.inputTokens).toBe(13);
  expect(after?.outputTokens).toBe(5);
  expect(after?.cost).toBe(1.5);
}

describe("usage observations — memory store", () => {
  it("supports idempotent insert, invariant conflict, independent sums, and prune-without-rollup-subtraction", async () => {
    const store = createInMemoryRuntimeStore();
    await expectUsageContract(store);
  });

  it("groups rollups by available dimensions", async () => {
    const store = createInMemoryRuntimeStore();
    await store.usage.recordObservation(
      baseObservation({
        id: createUsageObservationId("a"),
        agentName: "loom",
        model: "m1",
        workflowInstanceId: createWorkflowInstanceId("wf-1"),
      }),
    );
    await store.usage.recordObservation(
      baseObservation({
        id: createUsageObservationId("b"),
        agentName: "shuttle",
        model: "m1",
        workflowInstanceId: createWorkflowInstanceId("wf-1"),
        inputTokens: 7,
      }),
    );

    const rollups = (await store.usage.listRollups())._unsafeUnwrap();
    expect(rollups).toHaveLength(2);
    const loom = rollups.find((r) => r.agentName === "loom");
    const shuttle = rollups.find((r) => r.agentName === "shuttle");
    expect(loom?.inputTokens).toBe(10);
    expect(shuttle?.inputTokens).toBe(7);
  });

  it("rolls back usage when a transaction fails after a usage write", async () => {
    const { errAsync } = await import("neverthrow");
    const store = createInMemoryRuntimeStore();
    const txResult = await store.transaction((tx) =>
      tx.usage
        .recordObservation(
          baseObservation({ id: createUsageObservationId("tx-obs") }),
        )
        .andThen(() =>
          errAsync({ type: "validation" as const, message: "force rollback" }),
        ),
    );
    expect(txResult.isErr()).toBe(true);
    const found = await store.usage.findObservationById(
      createUsageObservationId("tx-obs"),
    );
    expect(found._unsafeUnwrap()).toBeNull();
  });

  it("rejects negative token counters", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await store.usage.recordObservation(
      baseObservation({ inputTokens: -1 }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("prunes by count keeping newest", async () => {
    const store = createInMemoryRuntimeStore();
    for (let i = 0; i < 5; i += 1) {
      await store.usage.recordObservation(
        baseObservation({
          id: createUsageObservationId(`c-${i}`),
          timestamp: `2026-01-01T00:0${i}:00.000Z`,
          inputTokens: i,
        }),
      );
    }
    const pruned = await store.usage.pruneDetails({ maxCount: 2 });
    expect(pruned._unsafeUnwrap().removedByCount).toBe(3);
    const remaining = (await store.usage.listObservations())._unsafeUnwrap();
    expect(remaining.map((o) => o.id)).toEqual([
      createUsageObservationId("c-3"),
      createUsageObservationId("c-4"),
    ]);
    const rollups = (await store.usage.listRollups())._unsafeUnwrap();
    expect(rollups[0]?.observationCount).toBe(5);
  });
});

describe("usage observations — sqlite store", () => {
  it("matches the memory contract", async () => {
    const dir = join(tmpdir(), `weave-usage-${crypto.randomUUID()}`);
    Bun.spawnSync(["mkdir", "-p", dir]);
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "weave.db"),
    });
    await expectUsageContract(store);
    await store.close();
  });
});
