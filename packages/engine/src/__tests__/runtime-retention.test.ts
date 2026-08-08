/**
 * Serialized retention and pruning service for the Runtime Store.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_RUNTIME_SETTINGS } from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  createInMemoryRuntimeStore,
  createUsageObservationId,
  DEFAULT_RETENTION_WRITE_THRESHOLD,
  type RetentionPruneStats,
  type RetentionScheduler,
  RuntimeRetentionService,
  type RuntimeStore,
  type RuntimeStoreError,
  type UsageObservation,
} from "../index.js";

function makeSettings(
  overrides: {
    journalMax?: number;
    journalDays?: number;
    usageMax?: number;
    usageDays?: number;
  } = {},
) {
  return {
    ...DEFAULT_RUNTIME_SETTINGS,
    journal: {
      ...DEFAULT_RUNTIME_SETTINGS.journal,
      max_entries:
        overrides.journalMax ?? DEFAULT_RUNTIME_SETTINGS.journal.max_entries,
      retention_days:
        overrides.journalDays ??
        DEFAULT_RUNTIME_SETTINGS.journal.retention_days,
    },
    usage: {
      ...DEFAULT_RUNTIME_SETTINGS.usage,
      max_observations:
        overrides.usageMax ?? DEFAULT_RUNTIME_SETTINGS.usage.max_observations,
      detail_retention_days:
        overrides.usageDays ??
        DEFAULT_RUNTIME_SETTINGS.usage.detail_retention_days,
    },
  };
}

function obs(id: string, timestamp: string): UsageObservation {
  return {
    id: createUsageObservationId(id),
    timestamp,
    source: { kind: "engine", name: "test" },
    inputTokens: 1,
  };
}

describe("journal and usage prune order", () => {
  it("removes by age first, then oldest above count", async () => {
    const store = createInMemoryRuntimeStore();
    for (const [id, ts] of [
      ["a", "2026-01-01T00:00:00.000Z"],
      ["b", "2026-01-02T00:00:00.000Z"],
      ["c", "2026-01-03T00:00:00.000Z"],
      ["d", "2026-01-04T00:00:00.000Z"],
    ] as const) {
      await store.usage.recordObservation(obs(id, ts));
    }

    const stats = await store.usage.pruneDetails({
      olderThan: "2026-01-02T12:00:00.000Z",
      maxCount: 1,
    });
    expect(stats.isOk()).toBe(true);
    expect(stats._unsafeUnwrap()).toEqual({
      removedByAge: 2, // a,b
      removedByCount: 1, // c (oldest of remaining c,d)
    });
    const remaining = (await store.usage.listObservations())._unsafeUnwrap();
    expect(remaining.map((e) => e.id)).toEqual([createUsageObservationId("d")]);
  });
});

describe("RuntimeRetentionService", () => {
  it("runs on activation and prunes over-count usage detail", async () => {
    const store = createInMemoryRuntimeStore();
    for (let i = 0; i < 5; i += 1) {
      await store.usage.recordObservation(
        obs(`u-${i}`, `2026-01-01T00:0${i}:00.000Z`),
      );
    }

    const service = new RuntimeRetentionService({
      store,
      settings: makeSettings({ usageMax: 2, journalMax: 10_000 }),
      clock: () => new Date("2026-01-01T12:00:00.000Z"),
      scheduler: { schedule: () => null, cancel: () => undefined },
    });

    const result = await service.onActivation();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().usage.removedByCount).toBe(3);
    const remaining = (await store.usage.listObservations())._unsafeUnwrap();
    expect(remaining).toHaveLength(2);
    service.stop();
  });

  it("schedules after write threshold with single-flight joining", async () => {
    const store = createInMemoryRuntimeStore();
    const service = new RuntimeRetentionService({
      store,
      settings: makeSettings({ usageMax: 100, journalMax: 100 }),
      writeThreshold: 3,
      intervalMs: 60_000,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      scheduler: { schedule: () => null, cancel: () => undefined },
    });

    // Seed last run so interval alone does not force immediately.
    await service.onActivation();

    expect((await service.onRelevantWrite())._unsafeUnwrap()).toBeNull();
    expect((await service.onRelevantWrite())._unsafeUnwrap()).toBeNull();
    const third = await service.onRelevantWrite();
    expect(third.isOk()).toBe(true);
    expect(third._unsafeUnwrap()).not.toBeNull();
    service.stop();
  });

  it("serializes concurrent runIfDue callers through one in-flight task", async () => {
    let active = 0;
    let maxActive = 0;
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const stats: RetentionPruneStats = { removedByAge: 0, removedByCount: 0 };
    const store = {
      journal: {
        prune: () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          return ResultAsync.fromPromise(
            gate.then(() => {
              active -= 1;
              return stats;
            }),
            () =>
              ({
                type: "retention" as const,
                message: "gate failed",
              }) satisfies RuntimeStoreError,
          );
        },
      },
      usage: {
        pruneDetails: () => okAsync(stats),
      },
    } as unknown as RuntimeStore;

    const service = new RuntimeRetentionService({
      store,
      settings: makeSettings(),
      writeThreshold: 1,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      scheduler: { schedule: () => null, cancel: () => undefined },
    });

    const a = service.onActivation();
    const b = service.onActivation();
    resolveGate?.();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.isOk()).toBe(true);
    expect(rb.isOk()).toBe(true);
    expect(maxActive).toBe(1);
    service.stop();
  });

  it("degrades on failure and retries at the next safe boundary", async () => {
    let fail = true;
    const stats: RetentionPruneStats = { removedByAge: 1, removedByCount: 0 };
    const store = {
      journal: {
        prune: () =>
          fail
            ? errAsync({
                type: "query" as const,
                message: "boom",
              } satisfies RuntimeStoreError)
            : okAsync(stats),
      },
      usage: {
        pruneDetails: () => okAsync(stats),
      },
    } as unknown as RuntimeStore;

    const service = new RuntimeRetentionService({
      store,
      settings: makeSettings(),
      writeThreshold: 1,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      scheduler: { schedule: () => null, cancel: () => undefined },
    });

    const first = await service.onActivation();
    expect(first.isErr()).toBe(true);
    expect(first._unsafeUnwrapErr().type).toBe("retention");

    fail = false;
    const second = await service.onRelevantWrite();
    expect(second.isOk()).toBe(true);
    expect(second._unsafeUnwrap()?.journal.removedByAge).toBe(1);
    service.stop();
  });

  it("arms interval timer and cancels on stop", async () => {
    const handles: unknown[] = [];
    const scheduler: RetentionScheduler = {
      schedule(cb, delayMs) {
        const handle = { cb, delayMs };
        handles.push(handle);
        return handle;
      },
      cancel(handle) {
        const idx = handles.indexOf(handle);
        if (idx >= 0) handles.splice(idx, 1);
      },
    };

    const store = createInMemoryRuntimeStore();
    const service = new RuntimeRetentionService({
      store,
      settings: makeSettings(),
      intervalMs: 15 * 60 * 1000,
      scheduler,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.onActivation();
    expect(handles).toHaveLength(1);
    expect((handles[0] as { delayMs: number }).delayMs).toBe(15 * 60 * 1000);
    service.stop();
    expect(handles).toHaveLength(0);
  });

  it("exposes default write threshold of 256", () => {
    expect(DEFAULT_RETENTION_WRITE_THRESHOLD).toBe(256);
  });

  it("returns typed error after stop", async () => {
    const service = new RuntimeRetentionService({
      store: createInMemoryRuntimeStore(),
      settings: makeSettings(),
      scheduler: { schedule: () => null, cancel: () => undefined },
    });
    service.stop();
    const result = await service.onActivation();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("retention");
  });
});
