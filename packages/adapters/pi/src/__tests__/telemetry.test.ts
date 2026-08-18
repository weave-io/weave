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
import {
  PROVIDER_FAST_REASONS,
  PROVIDER_FAST_STATES,
  PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
  type ProviderFastPublicSnapshot,
} from "../provider-fast-activation.js";
import {
  createPiTelemetry,
  createPiTelemetryLogger,
  extractAssistantUsageFromMessage,
  PI_JOURNAL_FAMILIES,
  PI_MODEL_FALLBACK_JOURNAL_DATA_KEYS,
  PI_PROVIDER_FAST_DEDUPE_LIMIT,
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
      "model-fallback",
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
  overrides: Partial<ProviderFastPublicSnapshot> = {},
): ProviderFastPublicSnapshot {
  return { ...PROVIDER_FAST_UNSUPPORTED_SNAPSHOT, ...overrides };
}

/** One codex-mapping call that wrote both routing parts, evidence pending. */
const CODEX_REQUESTED: Partial<ProviderFastPublicSnapshot> = {
  state: "requested",
  evidenceKind: "openai-service-tier",
  evidenceOutcome: "absent",
  reason: "none",
  ruleId: "codex-sub-05",
};

/** The same call settling on the pinned host's observed standard tier. */
const CODEX_STANDARD: Partial<ProviderFastPublicSnapshot> = {
  state: "not-confirmed",
  evidenceKind: "openai-service-tier",
  evidenceOutcome: "standard",
  reason: "none",
  ruleId: "codex-sub-05",
};

/** The same call settling with no readable proof for that attempt. */
const CODEX_UNREAD: Partial<ProviderFastPublicSnapshot> = {
  state: "not-confirmed",
  evidenceKind: "openai-service-tier",
  evidenceOutcome: "absent",
  reason: "response-proof-unavailable",
  ruleId: "codex-sub-05",
};

/** The only shape that may be reported as applied. */
const CODEX_APPLIED: Partial<ProviderFastPublicSnapshot> = {
  state: "applied",
  evidenceKind: "openai-service-tier",
  evidenceOutcome: "confirmed",
  reason: "none",
  ruleId: "codex-sub-05",
};

/** An eligible owner whose request already carried a conflicting control. */
const CODEX_COLLISION: Partial<ProviderFastPublicSnapshot> = {
  state: "unsupported",
  evidenceKind: "none",
  evidenceOutcome: "absent",
  reason: "request-collision",
};

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
  // Exactly the expected keys: no extra field can ride along, and every key
  // must be one the closed journal contract names.
  expect(Object.keys(data as object).sort()).toEqual(
    Object.keys(expected).sort(),
  );
  for (const key of Object.keys(data as object)) {
    expect(PI_PROVIDER_FAST_JOURNAL_DATA_KEYS).toContain(
      key as (typeof PI_PROVIDER_FAST_JOURNAL_DATA_KEYS)[number],
    );
    expect(typeof (data as Record<string, unknown>)[key]).toBe("string");
  }
}

function providerFastEntries(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
) {
  return [...store.journal.snapshot().values()].filter((entry) =>
    entry.eventType.startsWith("provider-fast."),
  );
}

function modelFallbackEntries(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
) {
  return [...store.journal.snapshot().values()].filter((entry) =>
    entry.eventType.startsWith("model-fallback."),
  );
}

describe("PiTelemetry — provider-fast journal family", () => {
  it("projects only closed sanitized keys and types", () => {
    const projected = projectProviderFastJournalData(providerFastSnapshot());
    expect(projected.isOk()).toBe(true);
    if (projected.isErr()) {
      return;
    }
    expectExactJournalData(projected.value, {
      state: "unsupported",
      evidenceKind: "none",
      evidenceOutcome: "absent",
      reason: "harness-seam-unavailable",
    });
  });

  it("projects a codex mapping outcome with its allowlist rule ID", () => {
    const projected = projectProviderFastJournalData(
      providerFastSnapshot(CODEX_APPLIED),
    );
    expect(projected.isOk()).toBe(true);
    if (projected.isErr()) {
      return;
    }
    expectExactJournalData(projected.value, {
      state: "applied",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "confirmed",
      reason: "none",
      ruleId: "codex-sub-05",
    });
  });

  it("rejects extra, raw, and secret-shaped fields at the projection boundary", () => {
    const extra = {
      ...providerFastSnapshot(),
      model: "gpt-5.6-sol",
      prompt: PROVIDER_FAST_SECRET,
      authorization: `Bearer ${PROVIDER_FAST_SECRET}`,
    };
    const missing = { state: "unsupported" };
    const rawReason = {
      ...providerFastSnapshot(),
      reason: PROVIDER_FAST_SECRET,
    };
    expect(
      projectProviderFastJournalData(
        extra as unknown as ProviderFastPublicSnapshot,
      ).isErr(),
    ).toBe(true);
    expect(
      projectProviderFastJournalData(
        missing as unknown as ProviderFastPublicSnapshot,
      ).isErr(),
    ).toBe(true);
    expect(
      projectProviderFastJournalData(
        rawReason as unknown as ProviderFastPublicSnapshot,
      ).isErr(),
    ).toBe(true);
  });

  it("accepts every widened state and reason the contract defines", () => {
    for (const state of PROVIDER_FAST_STATES) {
      const projected = projectProviderFastJournalData(
        providerFastSnapshot({ state }),
      );
      expect(projected.isOk()).toBe(true);
    }
    for (const reason of PROVIDER_FAST_REASONS) {
      const projected = projectProviderFastJournalData(
        providerFastSnapshot({ reason }),
      );
      expect(projected.isOk()).toBe(true);
    }
  });

  it("rejects every token outside the widened vocabulary", () => {
    for (const state of ["active", "pending", "fast", PROVIDER_FAST_SECRET]) {
      expect(
        projectProviderFastJournalData(
          providerFastSnapshot({
            state,
          } as unknown as Partial<ProviderFastPublicSnapshot>),
        ).isErr(),
      ).toBe(true);
    }
    expect(
      projectProviderFastJournalData(
        providerFastSnapshot({
          evidenceKind: "response-status",
        } as unknown as Partial<ProviderFastPublicSnapshot>),
      ).isErr(),
    ).toBe(true);
    expect(
      projectProviderFastJournalData(
        providerFastSnapshot({
          evidenceOutcome: "unavailable",
        } as unknown as Partial<ProviderFastPublicSnapshot>),
      ).isErr(),
    ).toBe(true);
    expect(
      projectProviderFastJournalData(
        providerFastSnapshot({
          reason: "response-body-evidence-unavailable",
        } as unknown as Partial<ProviderFastPublicSnapshot>),
      ).isErr(),
    ).toBe(true);
    // A rule ID is the only model-adjacent token, so it must be an exact
    // allowlist ID and never model text or a secret-shaped value.
    for (const ruleId of [
      "codex-sub-99",
      "gpt-5.6-sol",
      "none",
      PROVIDER_FAST_SECRET,
    ]) {
      expect(
        projectProviderFastJournalData(
          providerFastSnapshot({
            ruleId,
          } as unknown as Partial<ProviderFastPublicSnapshot>),
        ).isErr(),
      ).toBe(true);
    }
  });

  it("persists one outcome per distinct state, reason, and evidence tuple", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const distinct: readonly ProviderFastPublicSnapshot[] = [
      providerFastSnapshot(),
      providerFastSnapshot(CODEX_REQUESTED),
      providerFastSnapshot(CODEX_STANDARD),
      providerFastSnapshot(CODEX_UNREAD),
      providerFastSnapshot(CODEX_APPLIED),
    ];
    for (const snapshot of distinct) {
      expect(
        expectOkValue(await telemetry.recordProviderFastTransition(snapshot)),
      ).toBe("recorded");
      expect(
        expectOkValue(await telemetry.recordProviderFastTransition(snapshot)),
      ).toBe("duplicate");
    }

    const entries = providerFastEntries(store);
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "provider-fast.unsupported",
      "provider-fast.requested",
      "provider-fast.not-confirmed",
      "provider-fast.not-confirmed",
      "provider-fast.applied",
    ]);
    // Same state, different evidence: both facts survive, because "standard
    // tier" and "no proof could be read" are not the same outcome.
    expectExactJournalData(entries[2]?.data, {
      state: "not-confirmed",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "standard",
      reason: "none",
      ruleId: "codex-sub-05",
    });
    expectExactJournalData(entries[3]?.data, {
      state: "not-confirmed",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "absent",
      reason: "response-proof-unavailable",
      ruleId: "codex-sub-05",
    });
  });

  it("journals requested as a request, never as an application", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    expect(
      expectOkValue(
        await telemetry.recordProviderFastTransition(
          providerFastSnapshot(CODEX_REQUESTED),
        ),
      ),
    ).toBe("recorded");
    // The same call later settles below applied; that is a second fact.
    expect(
      expectOkValue(
        await telemetry.recordProviderFastTransition(
          providerFastSnapshot(CODEX_STANDARD),
        ),
      ),
    ).toBe("recorded");

    const entries = providerFastEntries(store);
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "provider-fast.requested",
      "provider-fast.not-confirmed",
    ]);
    expect(JSON.stringify(entries)).not.toContain("applied");
    expectExactJournalData(entries[0]?.data, {
      state: "requested",
      evidenceKind: "openai-service-tier",
      evidenceOutcome: "absent",
      reason: "none",
      ruleId: "codex-sub-05",
    });
  });

  it("bounds the in-memory dedupe window instead of growing per record", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    expect(PI_PROVIDER_FAST_DEDUPE_LIMIT).toBeGreaterThan(0);
    for (let repeat = 0; repeat < PI_PROVIDER_FAST_DEDUPE_LIMIT * 4; repeat++) {
      await telemetry.recordProviderFastTransition(providerFastSnapshot());
    }
    // One state/reason/evidence key exists, so the window can never exceed
    // its bound and the durable journal keeps exactly one record.
    expect(providerFastEntries(store)).toHaveLength(1);
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

  it("renders each neutral state distinctly from bounded tokens", () => {
    expect(
      expectOkValue(renderProviderFastStatusLine(undefined)),
    ).toBeUndefined();
    const render = (snapshot: ProviderFastPublicSnapshot) =>
      expectOkValue(renderProviderFastStatusLine(snapshot));

    expect(render(providerFastSnapshot())).toBe(
      "fast: unsupported (harness-seam-unavailable)",
    );
    expect(
      render(providerFastSnapshot({ state: "declared", reason: "none" })),
    ).toBe("fast: declared");
    expect(render(providerFastSnapshot(CODEX_REQUESTED))).toBe(
      "fast: requested (codex-sub-05, openai-service-tier=absent)",
    );
    expect(render(providerFastSnapshot(CODEX_APPLIED))).toBe(
      "fast: applied (codex-sub-05, openai-service-tier=confirmed)",
    );
    expect(render(providerFastSnapshot(CODEX_STANDARD))).toBe(
      "fast: not-confirmed (codex-sub-05, openai-service-tier=standard)",
    );
    expect(render(providerFastSnapshot(CODEX_UNREAD))).toBe(
      "fast: not-confirmed (codex-sub-05, response-proof-unavailable, openai-service-tier=absent)",
    );
    expect(render(providerFastSnapshot(CODEX_COLLISION))).toBe(
      "fast: unsupported (request-collision)",
    );
  });

  it("never renders an unproven state as applied or confirmed", () => {
    for (const snapshot of [
      providerFastSnapshot(),
      providerFastSnapshot(CODEX_REQUESTED),
      providerFastSnapshot(CODEX_STANDARD),
      providerFastSnapshot(CODEX_UNREAD),
      providerFastSnapshot(CODEX_COLLISION),
    ]) {
      const rendered = expectOkValue(renderProviderFastStatusLine(snapshot));
      expect(rendered).not.toContain("applied");
      expect(rendered).not.toContain("active");
      expect(rendered).not.toMatch(/(?<!not-)confirmed/);
    }
  });

  it("keeps model text, headers, and URLs out of every rendered line", () => {
    for (const snapshot of [
      providerFastSnapshot(),
      providerFastSnapshot(CODEX_APPLIED),
      providerFastSnapshot(CODEX_UNREAD),
    ]) {
      const rendered = expectOkValue(renderProviderFastStatusLine(snapshot));
      for (const forbidden of [
        "gpt-",
        "service_tier",
        "originator",
        "codex_cli_rs",
        "x-codex-routing-hint",
        "chatgpt.com",
        "Bearer",
        PROVIDER_FAST_SECRET,
      ]) {
        expect(rendered).not.toContain(forbidden);
      }
    }
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
    const entries = providerFastEntries(store);
    expect(entries).toHaveLength(2);
    expect(
      entries.every((entry) => entry.eventType === "provider-fast.unsupported"),
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
      providerFastSnapshot(),
    );
    expect(recorded.isOk()).toBe(true);
    const status = renderProviderFastStatusLine(providerFastSnapshot());
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

  it("keeps secret-shaped values out of a codex mapping record", async () => {
    const store = createInMemoryRuntimeStore();
    const { logger, logs } = fakeLogger();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
      logger,
    });
    const hostile = {
      ...providerFastSnapshot(CODEX_APPLIED),
      apiKey: PROVIDER_FAST_SECRET,
      authorization: `Bearer ${PROVIDER_FAST_SECRET}`,
      model: "gpt-5.6-sol",
    } as unknown as ProviderFastPublicSnapshot;
    // The hostile copy cannot be persisted at all.
    expect(
      (await telemetry.recordProviderFastTransition(hostile)).isErr(),
    ).toBe(true);
    // The sanitized original can, and carries nothing but bounded tokens.
    expect(
      (
        await telemetry.recordProviderFastTransition(
          providerFastSnapshot(CODEX_APPLIED),
        )
      ).isOk(),
    ).toBe(true);
    const sinks = [
      JSON.stringify(store.journal.snapshot()),
      JSON.stringify(logs),
    ];
    for (const sink of sinks) {
      expect(sink).not.toContain(PROVIDER_FAST_SECRET);
      expect(sink).not.toContain("sk-proj");
      expect(sink).not.toContain("Authorization");
      expect(sink).not.toContain("gpt-5.6-sol");
      expect(sink).not.toContain("service_tier");
    }
  });
});

describe("PiTelemetry — model-fallback journal family", () => {
  it("accepts one bounded applied fallback record with failure truth", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const accepted = {
      outcome: "applied",
      failureClass: "provider_unavailable",
      fromProvider: "openai-codex",
      fromId: "gpt-5.6-luna",
      toProvider: "anthropic",
      toId: "claude-sonnet-4-5",
      cursorPosition: 0,
    } as const;

    const result = await telemetry.recordModelFallbackTransition(accepted);
    expect(result.isOk()).toBe(true);

    const entries = modelFallbackEntries(store);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.eventType).toBe("model-fallback.applied");
    expect(entry.severity).toBe("info");
    expect(entry.data).toEqual(accepted);
    expect(Object.keys(entry.data).sort()).toEqual(
      [...PI_MODEL_FALLBACK_JOURNAL_DATA_KEYS].sort(),
    );
  });

  it("rejects raw errors, marker tokens, failed content, extra keys, invalid identities, and invalid cursors", async () => {
    const store = createInMemoryRuntimeStore();
    const telemetry = buildTelemetry({
      journal: new RuntimeJournalWriter(store.journal, { strictMode: false }),
    });
    const accepted = {
      outcome: "applied",
      failureClass: "provider_unavailable",
      fromProvider: "openai-codex",
      fromId: "gpt-5.6-luna",
      toProvider: "anthropic",
      toId: "claude-sonnet-4-5",
      cursorPosition: 0,
    } as const;
    const rawError = "PRIVATE-RAW-PROVIDER-ERROR-CANARY";
    const markerToken = "PRIVATE-MARKER-TOKEN-CANARY";
    const failedContent = "PRIVATE-FAILED-CONTENT-CANARY";
    const rejected: ReadonlyArray<{
      readonly input: unknown;
      readonly canary?: string;
    }> = [
      {
        input: { ...accepted, errorMessage: rawError },
        canary: rawError,
      },
      {
        input: { ...accepted, markerToken },
        canary: markerToken,
      },
      {
        input: { ...accepted, failedContent },
        canary: failedContent,
      },
      {
        input: {
          ...accepted,
          unexpected: "PRIVATE-EXTRA-KEY-CANARY",
        },
        canary: "PRIVATE-EXTRA-KEY-CANARY",
      },
      { input: { ...accepted, fromProvider: "" } },
      { input: { ...accepted, fromId: 42 } },
      { input: { ...accepted, toProvider: "x".repeat(65) } },
      { input: { ...accepted, cursorPosition: -1 } },
      { input: { ...accepted, cursorPosition: 1.5 } },
      {
        input: {
          ...accepted,
          cursorPosition: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        input: { ...accepted, cursorPosition: Number.POSITIVE_INFINITY },
      },
    ];

    for (const candidate of rejected) {
      const result = await telemetry.recordModelFallbackTransition(
        candidate.input,
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("JournalWriteFailed");
        if (candidate.canary !== undefined) {
          expect(JSON.stringify(result.error)).not.toContain(candidate.canary);
        }
      }
    }

    expect(modelFallbackEntries(store)).toHaveLength(0);
    const journal = JSON.stringify(store.journal.snapshot());
    for (const canary of [rawError, markerToken, failedContent]) {
      expect(journal).not.toContain(canary);
    }
    expect(journal).not.toContain("PRIVATE-EXTRA-KEY-CANARY");
  });
});
