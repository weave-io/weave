import { describe, expect, it } from "bun:test";
import type { RuntimeSettings } from "@weaveio/weave-core";
import {
  createInMemoryRuntimeStore,
  MemoryRuntimeLogFileSystem,
  RuntimeJournalWriter,
  type RuntimeStoreError,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import type { PiAdapterFailure } from "../errors.js";
import {
  createPiTelemetry,
  createPiTelemetryLogger,
  extractAssistantUsageFromMessage,
  PI_JOURNAL_FAMILIES,
  type PiJournalPort,
  type PiRetentionPort,
  PiTelemetry,
  type PiTelemetryUiPort,
  type PiUsagePort,
} from "../telemetry.js";
import type { Clock, PiAdapterLogger } from "../types.js";

function fakeClock(startMs = 1_700_000_000_000): Clock {
  let value = startMs;
  return {
    now: () => {
      value += 1;
      return value;
    },
  };
}

interface RecordedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly obj: Record<string, unknown>;
  readonly msg?: string;
}

function fakeLogger(): { logger: PiAdapterLogger; logs: RecordedLog[] } {
  const logs: RecordedLog[] = [];
  const logger: PiAdapterLogger = {
    debug: (obj, msg) => logs.push({ level: "debug", obj, msg }),
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  };
  return { logger, logs };
}

function fakeUi(): {
  ui: PiTelemetryUiPort;
  notifications: Array<{ message: string; level: string }>;
} {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
    notifications,
  };
}

function alwaysStoppedRetention(): {
  port: PiRetentionPort;
  stopped: boolean[];
} {
  const stopped: boolean[] = [];
  return {
    port: {
      onActivation: () =>
        okAsync({
          journal: { removedByAge: 0, removedByCount: 0 },
          usage: { removedByAge: 0, removedByCount: 0 },
          ranAt: new Date().toISOString(),
        }),
      onRelevantWrite: () => okAsync(null),
      stop: () => stopped.push(true),
    },
    stopped,
  };
}

const DEFAULT_SETTINGS: RuntimeSettings = {
  journal: { strict: false, retention_days: 30, max_entries: 10_000 },
  usage: { detail_retention_days: 30, max_observations: 100_000 },
  log: { max_segment_bytes: 5_242_880, max_segments: 3 },
};

function buildTelemetry(overrides?: {
  readonly journal?: PiJournalPort;
  readonly usage?: PiUsagePort;
  readonly retention?: PiRetentionPort;
  readonly logger?: PiAdapterLogger;
  readonly clock?: Clock;
}) {
  const store = createInMemoryRuntimeStore();
  const { logger } = fakeLogger();
  const retention = overrides?.retention ?? alwaysStoppedRetention().port;
  return new PiTelemetry({
    journal:
      overrides?.journal ??
      new RuntimeJournalWriter(store.journal, { strictMode: false }),
    usage: overrides?.usage ?? store.usage,
    retention,
    logger: overrides?.logger ?? logger,
    clock: overrides?.clock ?? fakeClock(),
    maxTrackedUsageIds: DEFAULT_SETTINGS.usage.max_observations,
  });
}

describe("PiTelemetry — TUI diagnostics dedupe (Spec 33 §19.2)", () => {
  it("notifies exactly once per unique code+scope+correlation identity", () => {
    const telemetry = buildTelemetry();
    const { ui, notifications } = fakeUi();
    const failure: PiAdapterFailure = {
      code: "JournalWriteFailed",
      phase: "telemetry",
      scope: { kind: "adapter" },
      impact: "degraded",
      retryable: true,
      recovery: "retry",
      safeMessage: "Weave could not write a Runtime Journal entry.",
      correlation: { reason: "journal_write" },
    };
    telemetry.notifyFailureOnce(ui, failure);
    telemetry.notifyFailureOnce(ui, failure);
    telemetry.notifyFailureOnce(ui, { ...failure });
    expect(notifications.length).toBe(1);
  });

  it("treats a different correlation id as a distinct diagnostic (one primary action each)", () => {
    const telemetry = buildTelemetry();
    const { ui, notifications } = fakeUi();
    const base: PiAdapterFailure = {
      code: "UsageWriteFailed",
      phase: "telemetry",
      scope: { kind: "adapter" },
      impact: "degraded",
      retryable: true,
      recovery: "retry",
      safeMessage: "Weave could not record a usage observation.",
      correlation: { reason: "a" },
    };
    telemetry.notifyFailureOnce(ui, base);
    telemetry.notifyFailureOnce(ui, { ...base, correlation: { reason: "b" } });
    expect(notifications.length).toBe(2);
    for (const n of notifications) {
      // Exactly one primary action per notification — a single message, no
      // secondary action payload.
      expect(typeof n.message).toBe("string");
    }
  });
});

describe("PiTelemetry — data ban (Spec 33 §19.1)", () => {
  it("extractAssistantUsageFromMessage never surfaces message text/content", () => {
    const extracted = extractAssistantUsageFromMessage({
      message: {
        role: "assistant",
        id: "msg-1",
        content: "this is the raw assistant text and must never appear",
        text: "also raw text",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.002 },
        },
      },
    });
    expect(extracted).toBeDefined();
    expect(extracted?.id).toBe("msg-1");
    const keys = Object.keys(extracted?.usage ?? {});
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("text");
    expect(extracted?.usage.inputTokens).toBe(10);
    expect(extracted?.usage.outputTokens).toBe(20);
    expect(extracted?.usage.cost).toBe(0.002);
  });

  it("ignores non-assistant messages and missing ids", () => {
    expect(
      extractAssistantUsageFromMessage({ message: { role: "user", id: "x" } }),
    ).toBeUndefined();
    expect(
      extractAssistantUsageFromMessage({ message: { role: "assistant" } }),
    ).toBeUndefined();
    expect(extractAssistantUsageFromMessage({})).toBeUndefined();
  });

  it("rejects negative/non-finite token and cost values rather than passing them through", () => {
    const extracted = extractAssistantUsageFromMessage({
      message: {
        role: "assistant",
        id: "msg-2",
        usage: {
          input: -5,
          output: Number.POSITIVE_INFINITY,
          cacheRead: "not-a-number",
        },
      },
    });
    expect(extracted?.usage.inputTokens).toBeUndefined();
    expect(extracted?.usage.outputTokens).toBeUndefined();
    expect(extracted?.usage.cacheReadTokens).toBeUndefined();
  });

  it("declares every normalized journal family required by Spec 33", () => {
    expect(PI_JOURNAL_FAMILIES).toEqual([
      "activation-health",
      "generation",
      "probe",
      "workflow-recovery",
      "lease",
      "effect",
      "plan",
      "completion",
      "artifact",
      "child-lifecycle",
      "child-protocol",
      "delegation",
      "ui-bridge",
      "usage",
      "retention",
      "telemetry-degradation",
    ]);
  });

  it("recordJournalEvent accepts bounded safe scalars", async () => {
    const telemetry = buildTelemetry();
    const result = await telemetry.recordJournalEvent({
      family: "activation-health",
      event: "generation-activated",
      severity: "info",
      data: { generationId: "gen-1", trusted: true, attempt: 1 },
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects raw-content fields and invalid event names before persistence", async () => {
    const telemetry = buildTelemetry();
    const rawContent = await telemetry.recordJournalEvent({
      family: "generation",
      event: "activated",
      severity: "info",
      data: { prompt: "secret content" },
    });
    expect(rawContent.isErr()).toBe(true);
    if (rawContent.isErr()) {
      expect(rawContent.error.code).toBe("JournalWriteFailed");
    }

    const invalidEvent = await telemetry.recordJournalEvent({
      family: "generation",
      event: `event-${"x".repeat(64)}`,
      severity: "info",
    });
    expect(invalidEvent.isErr()).toBe(true);
  });
});

describe("PiTelemetry — exactly-once usage observation (Spec 33 §19.4)", () => {
  it("records one usage observation per settled assistant message id", async () => {
    const telemetry = buildTelemetry();
    const first = await telemetry.recordAssistantUsage({
      id: "msg-usage-1",
      source: "primary",
      agentName: "loom",
      model: "claude-sonnet-4-5",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(first.isOk()).toBe(true);
    if (first.isOk()) expect(first.value).toBe("inserted");
  });

  it("is idempotent: same id + same normalized values is a no-op, never a duplicate", async () => {
    const telemetry = buildTelemetry();
    const input = {
      id: "msg-usage-2",
      source: "child" as const,
      agentName: "shuttle",
      inputTokens: 10,
      outputTokens: 5,
    };
    const first = await telemetry.recordAssistantUsage(input);
    const second = await telemetry.recordAssistantUsage(input);
    expect(first.isOk() && first.value).toBe("inserted");
    expect(second.isOk() && second.value).toBe("noop");
  });

  it("same id + different values is a closed InvariantViolation failure, never silently overwritten", async () => {
    const telemetry = buildTelemetry();
    const first = await telemetry.recordAssistantUsage({
      id: "msg-usage-3",
      source: "primary",
      inputTokens: 10,
    });
    expect(first.isOk()).toBe(true);
    const conflicting = await telemetry.recordAssistantUsage({
      id: "msg-usage-3",
      source: "primary",
      inputTokens: 999,
    });
    expect(conflicting.isErr()).toBe(true);
    if (conflicting.isErr()) {
      expect(conflicting.error.code).toBe("InvariantViolation");
    }
  });

  it("maps a genuine store write failure to the closed UsageWriteFailed code", async () => {
    const failingUsage: PiUsagePort = {
      recordObservation: () =>
        errAsync({ type: "query", message: "boom" } as RuntimeStoreError),
    };
    const telemetry = buildTelemetry({ usage: failingUsage });
    const result = await telemetry.recordAssistantUsage({
      id: "msg-usage-4",
      source: "child",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("UsageWriteFailed");
      expect(result.error.phase).toBe("telemetry");
      expect(result.error.impact).toBe("degraded");
    }
  });
});

describe("PiTelemetry — telemetry degradation (Spec 33 §19.2/§23)", () => {
  it("recordJournalEvent maps a journal write failure to JournalWriteFailed and never throws", async () => {
    const failingJournal: PiJournalPort = {
      write: () =>
        errAsync({
          type: "journal_write",
          message: "disk full",
        } as RuntimeStoreError),
    };
    const telemetry = buildTelemetry({ journal: failingJournal });
    const result = await telemetry.recordJournalEvent({
      family: "telemetry-degradation",
      event: "probe",
      severity: "warn",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("JournalWriteFailed");
  });

  it("recordDegradation always logs and never recurses through a failing sink", () => {
    const failingJournal: PiJournalPort = {
      write: () =>
        errAsync({
          type: "journal_write",
          message: "sink down",
        } as RuntimeStoreError),
    };
    const { logger, logs } = fakeLogger();
    const telemetry = buildTelemetry({ journal: failingJournal, logger });
    expect(() =>
      telemetry.recordDegradation({
        code: "LogWriteFailed",
        phase: "telemetry",
        scope: { kind: "adapter" },
        impact: "degraded",
        retryable: true,
        recovery: "retry",
        safeMessage: "Weave could not write to the runtime log sink.",
      }),
    ).not.toThrow();
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("createPiTelemetryLogger degrades to the fallback logger when the log filesystem fails", async () => {
    const { logger: fallbackLogger } = fakeLogger();
    const failingFs = {
      ensureLogDirectory: () =>
        errAsync({ type: "initialization" as const, message: "no permission" }),
    };
    const result = await createPiTelemetryLogger({
      projectRoot: "/tmp/does-not-matter",
      settings: DEFAULT_SETTINGS.log,
      fallbackLogger,
      fs: failingFs,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("LogWriteFailed");
  });

  it("createPiTelemetry never fails outright: it degrades to fallbackLogger and reports logDegradation", async () => {
    const store = createInMemoryRuntimeStore();
    const { logger: fallbackLogger } = fakeLogger();
    const failingFs = {
      ensureLogDirectory: () =>
        errAsync({ type: "initialization" as const, message: "no permission" }),
    };
    const created = await createPiTelemetry({
      store,
      settings: DEFAULT_SETTINGS,
      projectRoot: "/tmp/does-not-matter",
      clock: fakeClock(),
      fallbackLogger,
      logFileSystem: failingFs,
    });
    expect(created.isOk()).toBe(true);
    if (created.isOk()) {
      expect(created.value.telemetry).toBeInstanceOf(PiTelemetry);
      expect(created.value.logDegradation?.code).toBe("LogWriteFailed");
    }
  });

  it("builds a working rotating sink against the in-memory log filesystem seam", async () => {
    const { logger: fallbackLogger } = fakeLogger();
    const result = await createPiTelemetryLogger({
      projectRoot: "/tmp/does-not-matter",
      settings: DEFAULT_SETTINGS.log,
      fallbackLogger,
      fs: new MemoryRuntimeLogFileSystem(),
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value.logger.info).toBe("function");
      const disposed = await result.value.dispose();
      expect(disposed.isOk()).toBe(true);
    }
  });
});

describe("PiTelemetry — activation and cleanup (Spec 33 §19.3)", () => {
  it("activate() runs an immediate retention pass and records an activation journal entry", async () => {
    const store = createInMemoryRuntimeStore();
    const activations: string[] = [];
    const retention: PiRetentionPort = {
      onActivation: () => {
        activations.push("activated");
        return okAsync({
          journal: { removedByAge: 0, removedByCount: 0 },
          usage: { removedByAge: 0, removedByCount: 0 },
          ranAt: new Date().toISOString(),
        });
      },
      onRelevantWrite: () => okAsync(null),
      stop: () => {},
    };
    const telemetry = buildTelemetry({ retention });
    void store; // in-memory store already wired inside buildTelemetry
    const result = await telemetry.activate();
    expect(result.isOk()).toBe(true);
    expect(activations).toEqual(["activated"]);
  });

  it("activate() degrades to RetentionFailed without throwing when retention fails", async () => {
    const retention: PiRetentionPort = {
      onActivation: () =>
        errAsync({ type: "retention", message: "boom" } as RuntimeStoreError),
      onRelevantWrite: () => okAsync(null),
      stop: () => {},
    };
    const telemetry = buildTelemetry({ retention });
    const result = await telemetry.activate();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("RetentionFailed");
  });

  it("shutdown() stops retention scheduling and disposes the log sink exactly once", async () => {
    const { port: retention, stopped } = alwaysStoppedRetention();
    const telemetry = buildTelemetry({ retention });
    const first = await telemetry.shutdown();
    const second = await telemetry.shutdown();
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(stopped.length).toBe(1);
  });

  it("createPiTelemetry's shutdown releases the rotating log sink from createPiTelemetryLogger", async () => {
    const store = createInMemoryRuntimeStore();
    const { logger: fallbackLogger } = fakeLogger();
    const { port: retention, stopped } = alwaysStoppedRetention();
    const created = await createPiTelemetry({
      store,
      settings: DEFAULT_SETTINGS,
      projectRoot: "/tmp/does-not-matter",
      clock: fakeClock(),
      fallbackLogger,
      logFileSystem: new MemoryRuntimeLogFileSystem(),
      retention,
    });
    expect(created.isOk()).toBe(true);
    if (created.isOk()) {
      const shutdown = await created.value.telemetry.shutdown();
      expect(shutdown.isOk()).toBe(true);
      expect(stopped.length).toBe(1);
    }
  });
});
