import { describe, expect, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  findOrdinaryRecoveryCandidates,
  PiChildRecoveryCoordinator,
  type PiChildRecoveryRecord,
  RECOVERY_CHOICES,
  RECOVERY_CONTINUATION,
} from "../child-recovery.js";
import type {
  PiChildRefRecord,
  PiChildRefStatus,
} from "../child-session-refs.js";

/**
 * Since ADR 0014 the recovery record is the parent session's child-ref record.
 * It is metadata only: no transcript, no checkpoint cursor, no byte budgets.
 */
const record = (
  overrides: Partial<PiChildRecoveryRecord> = {},
): PiChildRecoveryRecord => ({
  childId: "child-1",
  threadId: "child-1",
  nativeSessionId: "native-1",
  sessionRef: "children/child-1/session.json",
  originParentSessionId: "parent-1",
  originEntryId: "entry-1",
  title: "loom",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  runs: [{ run: 1, action: "start", startedAt: 1 }],
  ...overrides,
});

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }
}

function coordinator(
  choice: string | undefined,
  spawned: Array<unknown>,
  inspected: Array<unknown> = [],
) {
  const child = record();
  return new PiChildRecoveryCoordinator({
    history: {
      list: () => okAsync([child]),
      updateStatus: () => okAsync(undefined),
    },
    ui: {
      select: async (_title, options) => {
        expect(options).toEqual(RECOVERY_CHOICES);
        return choice;
      },
      notify: () => undefined,
      inspect: (value) => {
        inspected.push(value);
      },
    },
    generationId: "generation-1",
    trustedProject: true,
    recoveryEnabled: true,
    countdownSeconds: 10,
    resolveDescriptor: (name) => ({ name, current: true }),
    currentModel: "current-model",
    currentPolicy: () => ({ tools: ["read"] }),
    currentLimits: { turns: 4 },
    spawn: (input) => {
      spawned.push(input);
      return okAsync({
        finalOutput: "fresh recovered output",
        interventionCount: 7,
      });
    },
  });
}

describe("PiChildRecoveryCoordinator", () => {
  test("expiry recovers and passes current trust inputs plus fixed continuation", async () => {
    const spawned: unknown[] = [];
    const result = await coordinator(undefined, spawned).startup();
    expect(result.isOk()).toBe(true);
    expect(spawned).toHaveLength(1);
    expect((spawned[0] as { continuation: string }).continuation).toBe(
      RECOVERY_CONTINUATION,
    );
    expect((spawned[0] as { model: string }).model).toBe("current-model");
  });

  test("settles with bounded authenticated output and never starts a turn", async () => {
    const calls: Array<{ content: string; triggerTurn: false }> = [];
    const updates: PiChildRefStatus[] = [];
    const child = record();
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([child]),
        updateStatus: (_record, status) => {
          updates.push(status);
          return okAsync(undefined);
        },
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      isGenerationCurrent: () => true,
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () =>
        okAsync({ finalOutput: "🙂".repeat(2_000), interventionCount: 9 }),
      injectParentContext: (content, options) => {
        calls.push({ content, ...options });
        return okAsync(undefined);
      },
    }).recover(child);
    expect(result.isOk()).toBe(true);
    expect(updates).toEqual(["running", "completed"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.triggerTurn).toBe(false);
    expect(new TextEncoder().encode(calls[0]?.content).byteLength).toBeLessThan(
      65_800,
    );
    expect(calls[0]?.content).toContain("Interventions: 9");
  });

  test("Skip and Inspect do not spawn or consume eligibility", async () => {
    for (const choice of ["Skip", "Inspect"] as const) {
      const spawned: unknown[] = [];
      const inspected: unknown[] = [];
      const result = await coordinator(choice, spawned, inspected).startup();
      expect(result.isOk()).toBe(true);
      expect(spawned).toHaveLength(0);
      if (choice === "Inspect") expect(inspected).toHaveLength(1);
    }
  });

  test("filters settled, tombstoned, and metadata-incomplete refs", () => {
    expect(
      findOrdinaryRecoveryCandidates([
        record(),
        record({ title: "" }),
        record({ sessionRef: "" }),
        record({ nativeSessionId: "" }),
        record({ threadId: "" }),
        record({ status: "completed" }),
        record({ status: "tombstoned" }),
        record({ settledAt: 9 }),
      ]),
    ).toHaveLength(1);
  });

  test("keeps a queued ref as a recovery candidate", () => {
    expect(
      findOrdinaryRecoveryCandidates([record({ status: "queued" })]),
    ).toHaveLength(1);
  });

  test("spawn rejection fails closed and rolls the ref back", async () => {
    const updates: PiChildRefStatus[] = [];
    const deps = {
      history: {
        list: () => okAsync([record()]),
        updateStatus: (_record: PiChildRefRecord, status: PiChildRefStatus) => {
          updates.push(status);
          return okAsync(undefined);
        },
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name: string) => ({ name, current: true }),
      spawn: () => errAsync(new Error("no process")),
    };
    const result = await new PiChildRecoveryCoordinator(deps).recoverByChildId(
      "child-1",
    );
    expect(result.isErr()).toBe(true);
    expect(updates).toEqual(["running", "failed"]);
  });

  test("recovers later picker targets by ID and all", async () => {
    const first = record({ childId: "child-1", threadId: "child-1" });
    const second = record({ childId: "child-2", threadId: "child-2" });
    let spawned = 0;
    const coordinator = new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([first, second]),
        updateStatus: () => okAsync(undefined),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => {
        spawned += 1;
        return okAsync({ finalOutput: "fresh", interventionCount: 1 });
      },
    });
    expect((await coordinator.recoverByChildId("child-2")).isOk()).toBe(true);
    expect((await coordinator.recoverAll()).isOk()).toBe(true);
    expect(spawned).toBe(3);
  });

  test("does not spawn or inject after generation becomes stale", async () => {
    let current = true;
    let spawned = 0;
    let injected = 0;
    const child = record();
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([child]),
        updateStatus: () => okAsync(undefined),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      isGenerationCurrent: () => current,
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => {
        spawned += 1;
        current = false;
        return okAsync({ finalOutput: "x", interventionCount: 1 });
      },
      injectParentContext: () => {
        injected += 1;
        return okAsync(undefined);
      },
    }).recover(child);
    expect(result.isErr()).toBe(true);
    expect(spawned).toBe(1);
    expect(injected).toBe(0);
  });

  test("explicit Recover now is distinct from timeout and recovers", async () => {
    const spawned: unknown[] = [];
    const result = await coordinator("Recover now", spawned).startup();
    expect(result.isOk()).toBe(true);
    expect(
      result.match(
        (value) => value,
        () => "error",
      ),
    ).toBe("recovered");
    expect(spawned).toHaveLength(1);
  });

  test.each([
    ["disabled recovery", { recoveryEnabled: false }],
    ["untrusted project", { trustedProject: false }],
    [
      "missing descriptor",
      { resolveDescriptor: (_name: string): undefined => undefined },
    ],
    [
      "changed descriptor",
      {
        resolveDescriptor: (
          _name: string,
        ): { name: string; current: boolean } => ({
          name: "other",
          current: true,
        }),
      },
    ],
    ["tombstoned ref", { child: record({ status: "tombstoned" }) }],
    ["settled ref", { child: record({ status: "completed", settledAt: 5 }) }],
    ["missing ref", { child: undefined }],
    ["stale generation", { isGenerationCurrent: () => false }],
  ] as const)("fails closed for %s", async (_name, options) => {
    let spawned = 0;
    const config = options as {
      child?: PiChildRecoveryRecord;
      recoveryEnabled?: boolean;
      trustedProject?: boolean;
      isGenerationCurrent?: () => boolean;
      resolveDescriptor?: (
        name: string,
      ) => { name: string; current: boolean } | undefined;
    };
    const child = "child" in config ? config.child : record();
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync(child === undefined ? [] : [child]),
        updateStatus: () => okAsync(undefined),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: config.trustedProject ?? true,
      recoveryEnabled: config.recoveryEnabled ?? true,
      countdownSeconds: 0,
      isGenerationCurrent: config.isGenerationCurrent,
      resolveDescriptor:
        config.resolveDescriptor ??
        ((name: string): { name: string; current: boolean } => ({
          name,
          current: true,
        })),
      spawn: () => {
        spawned += 1;
        return okAsync({ finalOutput: "must not run", interventionCount: 1 });
      },
    }).recoverByChildId("child-1");
    expect(result.isErr()).toBe(true);
    expect((result as { error: { type: string } }).error.type).toMatch(
      /ChildRecovery/,
    );
    expect(spawned).toBe(0);
  });

  test("ref list failure is typed and happens before spawn", async () => {
    let spawned = 0;
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => errAsync(new Error("private history")),
        updateStatus: () => okAsync(undefined),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => {
        spawned += 1;
        return okAsync({ finalOutput: "x", interventionCount: 0 });
      },
    }).recoverByChildId("child-1");
    expect(result.isErr()).toBe(true);
    expect(
      (result as { error: { type: string; reason?: string } }).error.type,
    ).toBe("ChildRecoveryUnavailable");
    expect((result as { error: { reason?: string } }).error.reason).toBe(
      "History is unavailable.",
    );
    expect(spawned).toBe(0);
  });

  test("initial ref update failure prevents spawn", async () => {
    let spawned = 0;
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => errAsync(new Error("secret history")),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => {
        spawned += 1;
        return okAsync({ finalOutput: "x", interventionCount: 0 });
      },
    }).recoverByChildId("child-1");
    expect(result.isErr()).toBe(true);
    expect(spawned).toBe(0);
  });

  test("rollback update failure remains a bounded spawn failure", async () => {
    let updates = 0;
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => {
          updates += 1;
          return updates === 1
            ? okAsync(undefined)
            : errAsync(new Error("rollback secret"));
        },
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () =>
        ResultAsync.fromPromise(
          Promise.reject(new Error("spawn secret")),
          () => new Error("spawn secret"),
        ),
    }).recoverByChildId("child-1");
    expect(result.isErr()).toBe(true);
    expect((result as { error: { type: string } }).error.type).toBe(
      "ChildRecoverySpawnFailed",
    );
    expect(updates).toBe(2);
  });

  test("terminal ref update failure is reported after valid settlement", async () => {
    let updates = 0;
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => {
          updates += 1;
          return updates === 2
            ? errAsync(new Error("terminal secret"))
            : okAsync(undefined);
        },
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => okAsync({ finalOutput: "settled", interventionCount: 2 }),
    }).recoverByChildId("child-1");
    expect(result.isErr()).toBe(true);
    expect((result as { error: { type: string } }).error.type).toBe(
      "ChildRecoverySpawnFailed",
    );
    expect(updates).toBe(2);
  });

  test.each([
    [
      "select sync throw",
      {
        select: () => {
          throw new Error("select secret");
        },
      },
    ],
    [
      "select rejection",
      { select: () => Promise.reject(new Error("select secret")) },
    ],
  ] as const)("UI %s is typed", async (_name, ui) => {
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => okAsync(undefined),
      },
      ui: { ...ui, notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => okAsync({ finalOutput: "x", interventionCount: 0 }),
    }).startup();
    expect(result.isErr()).toBe(true);
    expect(
      JSON.stringify(
        result.match(
          () => undefined,
          (error) => error,
        ),
      ),
    ).not.toContain("secret");
  });

  test.each([
    [
      "inspect sync throw",
      () => {
        throw new Error("inspect secret");
      },
    ],
    ["inspect rejection", () => Promise.reject(new Error("inspect secret"))],
  ] as const)("%s is typed", async (_name, inspect) => {
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => okAsync(undefined),
      },
      ui: {
        select: async () => "Inspect",
        notify: () => undefined,
        inspect: inspect as never,
      },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () => okAsync({ finalOutput: "x", interventionCount: 0 }),
    }).startup();
    expect(result.isErr()).toBe(true);
    expect(
      JSON.stringify(
        result.match(
          () => undefined,
          (error) => error,
        ),
      ),
    ).not.toContain("secret");
  });

  test.each([
    [
      "sync throw",
      () => {
        throw new Error("spawn secret");
      },
    ],
    ["rejection", () => Promise.reject(new Error("spawn secret"))],
  ] as const)("spawn %s is typed", async (_name, spawn) => {
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => okAsync(undefined),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: spawn as never,
    }).recoverByChildId("child-1");
    expect(result.isErr()).toBe(true);
    expect((result as { error: { type: string } }).error.type).toBe(
      "ChildRecoverySpawnFailed",
    );
  });

  test("successful terminal ref stays completed when injection fails or generation goes stale", async () => {
    for (const mode of ["injection", "stale"] as const) {
      let current = true;
      const updates: PiChildRefStatus[] = [];
      const result = await new PiChildRecoveryCoordinator({
        history: {
          list: () => okAsync([record()]),
          updateStatus: (_record, status) => {
            updates.push(status);
            return okAsync(undefined);
          },
        },
        ui: { select: async () => "Recover now", notify: () => undefined },
        generationId: "generation-1",
        isGenerationCurrent: () => current,
        trustedProject: true,
        recoveryEnabled: true,
        countdownSeconds: 0,
        resolveDescriptor: (
          name: string,
        ): { name: string; current: boolean } => ({ name, current: true }),
        spawn: () => okAsync({ finalOutput: "terminal", interventionCount: 4 }),
        injectParentContext: () => {
          if (mode === "stale") {
            current = false;
            return okAsync(undefined);
          }
          throw new Error("context secret");
        },
      }).recoverByChildId("child-1");
      expect(result.isErr()).toBe(true);
      expect(updates).toEqual(["running", "completed"]);
    }
  });

  test("privacy boundary bounds injected final output and omits ref metadata", async () => {
    const canary = "STALE_TRANSCRIPT_TOOL_THINKING_UI_INTERVENTION_SECRET";
    const injected: string[] = [];
    const updates: PiChildRefStatus[] = [];
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record({ nativeSessionId: canary })]),
        updateStatus: (_record, status) => {
          updates.push(status);
          return okAsync(undefined);
        },
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () =>
        okAsync({ finalOutput: "🙂".repeat(3_000), interventionCount: 12 }),
      injectParentContext: (content, options) => {
        injected.push(`${content}|${options.triggerTurn}`);
        return okAsync(undefined);
      },
    }).recoverByChildId("child-1");
    expect(result.isOk()).toBe(true);
    expect(injected[0]).not.toContain(canary);
    expect(injected[0]).toContain("Interventions: 12|false");
    expect(
      new TextEncoder().encode(injected[0] ?? "").byteLength,
    ).toBeLessThanOrEqual(65_800);
    expect(updates).toEqual(["running", "completed"]);
    expect(injected[0]).not.toContain("transcript");
  });

  test("startup prompts once and recover-all follows candidate order", async () => {
    const first = record({ childId: "z-child", threadId: "z-child" });
    const second = record({ childId: "a-child", threadId: "a-child" });
    let prompts = 0;
    const order: string[] = [];
    const result = await new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([first, second]),
        updateStatus: () => okAsync(undefined),
      },
      ui: {
        select: async () => {
          prompts += 1;
          return undefined;
        },
        notify: () => undefined,
      },
      generationId: "generation-1",
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: (input) => {
        order.push(input.record.childId);
        return okAsync({ finalOutput: "x", interventionCount: 0 });
      },
    }).startup();
    expect(result.isOk()).toBe(true);
    expect(prompts).toBe(1);
    expect(order).toEqual(["z-child", "a-child"]);
  });

  test("does not inject queued recovery into a replacement session", async () => {
    let current = true;
    const injectionCalled = new Deferred<void>();
    const sentMessages: string[] = [];
    const recovery = new PiChildRecoveryCoordinator({
      history: {
        list: () => okAsync([record()]),
        updateStatus: () => okAsync(undefined),
      },
      ui: { select: async () => "Recover now", notify: () => undefined },
      generationId: "generation-1",
      isGenerationCurrent: () => current,
      trustedProject: true,
      recoveryEnabled: true,
      countdownSeconds: 0,
      resolveDescriptor: (name) => ({ name, current: true }),
      spawn: () =>
        okAsync({ finalOutput: "replacement-safe", interventionCount: 1 }),
      injectParentContext: (content) => {
        injectionCalled.resolve(undefined);
        return ResultAsync.fromPromise(
          Promise.resolve().then(() => {
            if (!current) throw new Error("stale generation");
            sentMessages.push(content);
          }),
          () => new Error("stale generation"),
        );
      },
    }).recoverByChildId("child-1");

    await injectionCalled.promise;
    current = false;
    const result = await recovery;

    expect(result.isErr()).toBe(true);
    expect(sentMessages).toEqual([]);
  });
});
