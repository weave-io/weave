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
import { makeChildCapacityExceededFailure } from "../errors.js";
import type { ProviderFastAttemptPublicSnapshot } from "../provider-fast-activation.js";
import {
  createPiTelemetry,
  createPiTelemetryLogger,
  extractAssistantUsageFromMessage,
  PI_JOURNAL_FAMILIES,
  PI_PROVIDER_FAST_JOURNAL_DATA_KEYS,
  type PiJournalPort,
  type PiProviderFastJournalData,
  type PiRetentionPort,
  PiTelemetry,
  type PiTelemetryUiPort,
  type PiUsagePort,
  projectProviderFastJournalData,
  renderProviderFastStatusLine,
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

describe("PiTelemetry — TUI diagnostics dedupe (Pi adapter contract)", () => {
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

  it("never leaks private correlation reason into user diagnostics", () => {
    const telemetry = buildTelemetry();
    const { ui, notifications } = fakeUi();
    const privateCanary = "PRIVATE-DIAGNOSTIC-CANARY";
    telemetry.notifyFailureOnce(
      ui,
      makeChildCapacityExceededFailure(privateCanary, "max_children"),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toBe(
      "Delegation limits do not permit spawning this child right now. (retry)",
    );
    expect(JSON.stringify(notifications)).not.toContain(privateCanary);
  });
});

describe("PiTelemetry — data ban (Pi adapter contract)", () => {
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

  it("accepts exact-host responseId as the stable assistant identity", () => {
    const extracted = extractAssistantUsageFromMessage({
      message: {
        role: "assistant",
        responseId: "msg-response-1",
        usage: { input: 2, output: 22 },
      },
    });

    expect(extracted).toEqual({
      id: "msg-response-1",
      usage: {
        inputTokens: 2,
        outputTokens: 22,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        cost: undefined,
      },
    });
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

  it("declares every normalized journal family required by Pi adapter contract", () => {
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
      "provider-fast",
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

  it("passes private canaries through the real journal boundary, then omits them from every sink", async () => {
    const store = createInMemoryRuntimeStore();
    const { logger, logs } = fakeLogger();
    const telemetry = new PiTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
      usage: store.usage,
      retention: alwaysStoppedRetention().port,
      logger,
      clock: fakeClock(),
      maxTrackedUsageIds: DEFAULT_SETTINGS.usage.max_observations,
    });
    const privateCanaries = {
      prompt: "PRIVATE-PROMPT-CANARY",
      task: "PRIVATE-TASK-CANARY",
      intervention: "PRIVATE-INTERVENTION-CANARY",
      toolArgs: "PRIVATE-TOOL-ARGS-CANARY",
      image: "PRIVATE-IMAGE-CANARY",
      rpcBody: "PRIVATE-RPC-BODY-CANARY",
      path: "PRIVATE-PATH-CANARY",
      secret: "PRIVATE-SECRET-CANARY",
    };
    const journal = await telemetry.recordJournalEvent({
      family: "activation-health",
      event: "generation-activated",
      severity: "info",
      data: {
        prompt: privateCanaries.prompt,
        task: privateCanaries.task,
        intervention: privateCanaries.intervention,
        toolArgs: privateCanaries.toolArgs,
        image: privateCanaries.image,
        rpcBody: privateCanaries.rpcBody,
        path: privateCanaries.path,
        secret: privateCanaries.secret,
      },
    });
    expect(journal.isErr()).toBe(true);
    const usage = await telemetry.recordAssistantUsage({
      id: "safe-message",
      inputTokens: 2,
      outputTokens: 3,
      cost: 0.01,
      source: "child",
    });
    expect(usage.isOk()).toBe(true);
    const sinks = [
      JSON.stringify(store.journal.snapshot()),
      JSON.stringify(store.usage.snapshot()),
      JSON.stringify(logs),
      JSON.stringify(journal),
      JSON.stringify(usage),
    ];
    for (const canary of Object.values(privateCanaries)) {
      expect(sinks.every((sink) => !sink.includes(canary))).toBe(true);
    }
  });

  it("rejects raw-content fields and private input before persistence", async () => {
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
      expect(rawContent.error.safeMessage).toBe(
        "Weave could not write a Runtime Journal entry.",
      );
      expect(JSON.stringify(rawContent.error)).not.toContain("secret content");
    }

    const invalidEvent = await telemetry.recordJournalEvent({
      family: "generation",
      event: "PRIVATE-GENERATION-INVALID-EVENT-CANARY",
      severity: "info",
    });
    expect(invalidEvent.isErr()).toBe(true);
    if (invalidEvent.isErr()) {
      expect(invalidEvent.error.code).toBe("JournalWriteFailed");
      expect(invalidEvent.error.safeMessage).toBe(
        "Weave could not write a Runtime Journal entry.",
      );
      expect(JSON.stringify(invalidEvent.error)).not.toContain(
        "PRIVATE-GENERATION-INVALID-EVENT-CANARY",
      );
    }
  });
});

describe("PiTelemetry — exactly-once usage observation (Pi adapter contract)", () => {
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

describe("PiTelemetry — telemetry degradation (Pi adapter contract)", () => {
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

describe("PiTelemetry — activation and cleanup (Pi adapter contract)", () => {
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

const PROVIDER_FAST_SECRET = "sk-proj-fast-secret-value-DO-NOT-ECHO-9f3c2a1b";

function providerFastSnapshot(
  overrides: Partial<ProviderFastAttemptPublicSnapshot> = {},
): ProviderFastAttemptPublicSnapshot {
  return {
    sequence: 1,
    pendingCount: 1,
    providerFamily: "openai",
    apiFamily: "openai-responses",
    allowlistRuleId: "openai-gpt-5-6-sol",
    collision: false,
    state: "declared",
    evidenceKind: "none",
    evidenceOutcome: "none",
    reason: "none",
    ...overrides,
  };
}

function expectOkValue<T>(result: {
  match: (ok: (value: T) => T, err: () => never) => T;
}): T {
  return result.match(
    (value) => value,
    () => {
      throw new Error("expected Ok");
    },
  );
}

function expectExactJournalData(
  data: unknown,
  expected: PiProviderFastJournalData,
): void {
  expect(data).toEqual(expected);
  expect(Object.keys(data as object).sort()).toEqual(
    [...PI_PROVIDER_FAST_JOURNAL_DATA_KEYS].sort(),
  );
  expect(typeof (data as PiProviderFastJournalData).providerFamily).toBe(
    "string",
  );
  expect(typeof (data as PiProviderFastJournalData).apiFamily).toBe("string");
  expect(typeof (data as PiProviderFastJournalData).allowlistRuleId).toBe(
    "string",
  );
  expect(typeof (data as PiProviderFastJournalData).sequence).toBe("number");
  expect(typeof (data as PiProviderFastJournalData).pendingCount).toBe(
    "number",
  );
  expect(typeof (data as PiProviderFastJournalData).collision).toBe("boolean");
  expect(typeof (data as PiProviderFastJournalData).state).toBe("string");
  expect(typeof (data as PiProviderFastJournalData).evidenceKind).toBe(
    "string",
  );
  expect(typeof (data as PiProviderFastJournalData).evidenceOutcome).toBe(
    "string",
  );
  expect(typeof (data as PiProviderFastJournalData).reason).toBe("string");
}

describe("PiTelemetry — provider-fast journal family", () => {
  it("projects only closed sanitized keys and types", () => {
    const projected = projectProviderFastJournalData(providerFastSnapshot());
    expect(projected.isOk()).toBe(true);
    if (projected.isErr()) {
      return;
    }
    expectExactJournalData(projected.value, {
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      sequence: 1,
      pendingCount: 1,
      collision: false,
      state: "declared",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });
  });

  it("rejects extra, raw, and secret-shaped fields at the projection boundary", () => {
    const extra = {
      ...providerFastSnapshot(),
      model: "gpt-5.6-sol",
      prompt: PROVIDER_FAST_SECRET,
      authorization: `Bearer ${PROVIDER_FAST_SECRET}`,
    };
    const missing = {
      sequence: 1,
      state: "declared",
    };
    const rawReason = {
      ...providerFastSnapshot(),
      reason: PROVIDER_FAST_SECRET,
    };
    expect(projectProviderFastJournalData(extra).isErr()).toBe(true);
    expect(
      projectProviderFastJournalData(
        missing as unknown as ProviderFastAttemptPublicSnapshot,
      ).isErr(),
    ).toBe(true);
    expect(
      projectProviderFastJournalData(
        rawReason as unknown as ProviderFastAttemptPublicSnapshot,
      ).isErr(),
    ).toBe(true);
  });

  it("does not persist no-intent idle snapshots", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const recorded = await telemetry.recordProviderFastTransition(
      providerFastSnapshot({
        sequence: 0,
        pendingCount: 0,
        providerFamily: "none",
        apiFamily: "none",
        allowlistRuleId: "none",
        state: "unsupported",
      }),
    );
    expect(recorded.isOk() && recorded.value).toBe("duplicate");
    const entries = [...store.journal.snapshot().values()].filter((entry) =>
      entry.eventType.startsWith("provider-fast."),
    );
    expect(entries).toHaveLength(0);
  });

  it("records each lifecycle state once and deduplicates repeats", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const declared = providerFastSnapshot();
    const requested = providerFastSnapshot({
      state: "requested",
      pendingCount: 1,
    });
    const confirmed = providerFastSnapshot({
      state: "not-confirmed",
      pendingCount: 0,
      evidenceKind: "response-status",
      evidenceOutcome: "unavailable",
      reason: "response-body-evidence-unavailable",
    });
    const unsupported = providerFastSnapshot({
      sequence: 2,
      pendingCount: 0,
      providerFamily: "none",
      allowlistRuleId: "none",
      state: "unsupported",
      reason: "model-not-allowed",
    });
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(declared)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(declared)),
    ).toBe("duplicate");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(requested)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(confirmed)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(unsupported)),
    ).toBe("recorded");

    const entries = [...store.journal.snapshot().values()]
      .filter((entry) => entry.eventType.startsWith("provider-fast."))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "provider-fast.declared",
      "provider-fast.requested",
      "provider-fast.not-confirmed",
      "provider-fast.unsupported",
    ]);
    expectExactJournalData(entries[0]?.data, {
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      sequence: 1,
      pendingCount: 1,
      collision: false,
      state: "declared",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });
    expectExactJournalData(entries[1]?.data, {
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      sequence: 1,
      pendingCount: 1,
      collision: false,
      state: "requested",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "none",
    });
    expectExactJournalData(entries[2]?.data, {
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      sequence: 1,
      pendingCount: 0,
      collision: false,
      state: "not-confirmed",
      evidenceKind: "response-status",
      evidenceOutcome: "unavailable",
      reason: "response-body-evidence-unavailable",
    });
    expectExactJournalData(entries[3]?.data, {
      providerFamily: "none",
      apiFamily: "openai-responses",
      allowlistRuleId: "none",
      sequence: 2,
      pendingCount: 0,
      collision: false,
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "model-not-allowed",
    });
  });

  it("records a cancelled attempt as its own terminal event", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const requested = providerFastSnapshot({
      state: "requested",
      pendingCount: 1,
    });
    const cancelled = providerFastSnapshot({
      state: "not-confirmed",
      pendingCount: 0,
      reason: "cancelled",
    });
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(requested)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(cancelled)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(cancelled)),
    ).toBe("duplicate");

    const entries = [...store.journal.snapshot().values()]
      .filter((entry) => entry.eventType.startsWith("provider-fast."))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "provider-fast.requested",
      "provider-fast.not-confirmed",
    ]);
    expectExactJournalData(entries[1]?.data, {
      providerFamily: "openai",
      apiFamily: "openai-responses",
      allowlistRuleId: "openai-gpt-5-6-sol",
      sequence: 1,
      pendingCount: 0,
      collision: false,
      state: "not-confirmed",
      evidenceKind: "none",
      evidenceOutcome: "none",
      reason: "cancelled",
    });
  });

  it("records retries as a later sequence without collapsing prior events", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const first = providerFastSnapshot({ sequence: 1, state: "requested" });
    const retry = providerFastSnapshot({ sequence: 2, state: "requested" });
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(first)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(retry)),
    ).toBe("recorded");
    const entries = [...store.journal.snapshot().values()].filter((entry) =>
      entry.eventType.startsWith("provider-fast."),
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.data.sequence)).toEqual([1, 2]);
  });

  it("degrades through the typed journal path when persistence fails", async () => {
    const failingJournal: PiJournalPort = {
      write: () =>
        errAsync({
          type: "journal_write",
          message: "disk full",
        } as RuntimeStoreError),
    };
    const telemetry = buildTelemetry({ journal: failingJournal });
    const result = await telemetry.recordProviderFastTransition(
      providerFastSnapshot(),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("JournalWriteFailed");
      expect(result.error.safeMessage).toBe(
        "Weave could not write a Runtime Journal entry.",
      );
      expect(JSON.stringify(result.error)).not.toContain(PROVIDER_FAST_SECRET);
    }
  });

  it("renders concise status lines for every public state and omits no-intent", () => {
    expect(
      expectOkValue(renderProviderFastStatusLine(undefined)),
    ).toBeUndefined();
    expect(
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({
            sequence: 0,
            pendingCount: 0,
            providerFamily: "none",
            apiFamily: "none",
            allowlistRuleId: "none",
            state: "unsupported",
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      expectOkValue(renderProviderFastStatusLine(providerFastSnapshot())),
    ).toBe("fast: declared");
    expect(
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({ state: "requested" }),
        ),
      ),
    ).toBe("fast: requested");
    expect(
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({
            state: "not-confirmed",
            evidenceKind: "response-status",
            evidenceOutcome: "unavailable",
            reason: "response-body-evidence-unavailable",
          }),
        ),
      ),
    ).toBe("fast: not-confirmed");
    expect(
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({
            state: "unsupported",
            reason: "model-not-allowed",
          }),
        ),
      ),
    ).toBe("fast: unsupported (model-not-allowed)");
    expect(
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({
            state: "unsupported",
            reason: "expired",
          }),
        ),
      ),
    ).toBe("fast: unsupported (expired)");
    const rendered = [
      expectOkValue(renderProviderFastStatusLine(providerFastSnapshot())),
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({ state: "requested" }),
        ),
      ),
      expectOkValue(
        renderProviderFastStatusLine(
          providerFastSnapshot({
            state: "not-confirmed",
            reason: "response-body-evidence-unavailable",
          }),
        ),
      ),
    ].join("\n");
    expect(rendered).not.toContain("applied");
    expect(rendered).not.toContain("active");
    expect(rendered).not.toMatch(/(?<!not-)confirmed/);
  });

  it("clears in-memory reporting dedupe on session reset without rewriting durable events", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const snapshot = providerFastSnapshot();
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(snapshot)),
    ).toBe("recorded");
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(snapshot)),
    ).toBe("duplicate");
    telemetry.resetProviderFastReporting();
    expect(
      expectOkValue(await telemetry.recordProviderFastTransition(snapshot)),
    ).toBe("recorded");
    const entries = [...store.journal.snapshot().values()].filter((entry) =>
      entry.eventType.startsWith("provider-fast."),
    );
    expect(entries).toHaveLength(2);
    expect(
      entries.every((entry) => entry.eventType === "provider-fast.declared"),
    ).toBe(true);
  });

  it("keeps secret-shaped values out of projected data, status, and logs", async () => {
    const store = createInMemoryRuntimeStore();
    const { logger, logs } = fakeLogger();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
      logger,
    });
    const recorded = await telemetry.recordProviderFastTransition(
      providerFastSnapshot({
        state: "not-confirmed",
        evidenceKind: "response-status",
        evidenceOutcome: "unavailable",
        reason: "response-body-evidence-unavailable",
      }),
    );
    expect(recorded.isOk()).toBe(true);
    const status = renderProviderFastStatusLine(
      providerFastSnapshot({
        state: "not-confirmed",
        evidenceKind: "response-status",
        evidenceOutcome: "unavailable",
        reason: "response-body-evidence-unavailable",
      }),
    );
    const sinks = [
      JSON.stringify(store.journal.snapshot()),
      JSON.stringify(logs),
      JSON.stringify(recorded),
      JSON.stringify(status),
    ];
    for (const sink of sinks) {
      expect(sink).not.toContain(PROVIDER_FAST_SECRET);
      expect(sink).not.toContain("sk-proj");
      expect(sink).not.toContain("Authorization");
      expect(sink).not.toContain("applied");
      expect(sink).not.toContain("gpt-5.6-sol");
    }
  });
});
