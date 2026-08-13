import { describe, expect, test } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type {
  PiNativeSessionError,
  PiNativeSessionRecord,
  PiNativeSessionTombstone,
} from "../child-native-sessions.js";
import { CHILD_OVERLAY_BOUNDS } from "../child-overlay-types.js";
import {
  type AppendNewChildRefInput,
  childRefTotalRuns,
  createNativeChildRefSourceAuthority,
  hasNoTranscriptFields,
  PI_CHILD_REF_BOUNDS,
  PI_CHILD_REF_ENTRY_TYPE,
  PI_CHILD_REF_ORDER,
  PI_CHILD_REF_SCHEMA_VERSION,
  type PiChildRefAppendPort,
  type PiChildRefEntryReadPort,
  type PiChildRefRecord,
  type PiChildRefSourceAuthority,
  type PiChildRefSourceState,
  PiChildSessionRefStore,
  parseChildRefEnvelope,
  parseChildRefRecord,
  serializeChildRefEnvelope,
} from "../child-session-refs.js";
import { PI_CHILD_TITLE_PROVENANCE } from "../child-title.js";

const PARENT = "parent-session-1";
const OTHER_PARENT = "parent-session-2";
const SESSION_REF = "child-1/session.jsonl";

/**
 * The pre-remediation ceiling that the run ordinal and the envelope ordering
 * clock used to share. Kept only as a test landmark: crossing it must now be
 * unremarkable.
 */
const OLD_RUN_CEILING = 1_000_000;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RecordedEntry {
  readonly customType: string;
  readonly data: unknown;
}

class FakeParentSession
  implements PiChildRefAppendPort, PiChildRefEntryReadPort
{
  readonly appended: RecordedEntry[] = [];
  private readonly extra: unknown[] = [];
  throwOnAppend = false;
  throwOnRead = false;

  appendEntry(customType: string, data: unknown): void {
    if (this.throwOnAppend) throw new Error("host refused append");
    this.appended.push({ customType, data });
  }

  getEntries(): readonly unknown[] {
    if (this.throwOnRead) throw new Error("session unavailable");
    return [
      ...this.extra,
      ...this.appended.map((entry) => ({
        type: "custom",
        customType: entry.customType,
        data: entry.data,
      })),
    ];
  }

  seedRaw(entry: unknown): void {
    this.extra.push(entry);
  }
}

function fixedAuthority(
  state: PiChildRefSourceState,
): PiChildRefSourceAuthority {
  return { checkSource: () => okAsync(state) };
}

function authorityByRef(
  states: Readonly<Record<string, PiChildRefSourceState>>,
): PiChildRefSourceAuthority {
  return {
    checkSource: (sessionRef) => okAsync(states[sessionRef] ?? "missing"),
  };
}

interface HarnessOptions {
  readonly parentSessionId?: string;
  readonly authority?: PiChildRefSourceAuthority;
  readonly now?: () => number;
}

function harness(options: HarnessOptions = {}) {
  const session = new FakeParentSession();
  let clock = 1_000;
  const ids: string[] = [];
  let idCounter = 0;
  const store = new PiChildSessionRefStore({
    parentSessionId: options.parentSessionId ?? PARENT,
    append: session,
    read: session,
    authority: options.authority ?? fixedAuthority("available"),
    now: options.now ?? (() => (clock += 10)),
    newEntryId: () => {
      idCounter += 1;
      const id = `entry-${idCounter}`;
      ids.push(id);
      return id;
    },
  });
  return { session, store, ids };
}

const NEW_CHILD: AppendNewChildRefInput = {
  childId: "child-1",
  nativeSessionId: "native-1",
  sessionRef: SESSION_REF,
  title: "shuttle-child1",
  titleProvenance: PI_CHILD_TITLE_PROVENANCE,
};

function validRecord(
  overrides: Partial<PiChildRefRecord> = {},
): PiChildRefRecord {
  return {
    childId: "child-1",
    threadId: "child-1",
    nativeSessionId: "native-1",
    sessionRef: SESSION_REF,
    originParentSessionId: PARENT,
    originEntryId: "entry-1",
    title: "shuttle-child1",
    titleProvenance: PI_CHILD_TITLE_PROVENANCE,
    status: "running",
    createdAt: 1_000,
    updatedAt: 1_000,
    runs: [],
    ...overrides,
  };
}

function envelopeOf(record: PiChildRefRecord, sequence = 1) {
  return {
    schemaVersion: PI_CHILD_REF_SCHEMA_VERSION,
    entryType: PI_CHILD_REF_ENTRY_TYPE,
    kind: "new-child" as const,
    sequence,
    appendedAt: 1_000,
    record,
  };
}

function customEntry(data: unknown) {
  return { type: "custom", customType: PI_CHILD_REF_ENTRY_TYPE, data };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("child ref schema", () => {
  test("accepts a bounded, metadata-only record", () => {
    const parsed = parseChildRefRecord(validRecord());
    expect(parsed.isOk()).toBe(true);
  });

  test("rejects unknown keys instead of silently stripping them", () => {
    const parsed = parseChildRefRecord({
      ...validRecord(),
      prompt: "do the thing",
    });
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.type).toBe("ChildRefInvalid");
    }
  });

  test("rejects an over-long title", () => {
    const parsed = parseChildRefRecord(
      validRecord({
        title: "x".repeat(PI_CHILD_REF_BOUNDS.maxTitleLength + 1),
      }),
    );
    expect(parsed.isErr()).toBe(true);
  });

  test("rejects an over-long id", () => {
    const parsed = parseChildRefRecord(
      validRecord({ childId: "c".repeat(PI_CHILD_REF_BOUNDS.maxIdLength + 1) }),
    );
    expect(parsed.isErr()).toBe(true);
  });

  test("rejects escaping or absolute session refs", () => {
    for (const ref of [
      "../escape/session.jsonl",
      "/abs/session.jsonl",
      "a/../../b",
    ]) {
      expect(
        parseChildRefRecord(validRecord({ sessionRef: ref })).isErr(),
      ).toBe(true);
    }
  });

  test("rejects an unbounded run window", () => {
    const runs = Array.from(
      { length: PI_CHILD_REF_BOUNDS.maxRuns + 1 },
      () => ({
        run: 1,
        action: "start" as const,
        startedAt: 1,
      }),
    );
    expect(parseChildRefRecord(validRecord({ runs })).isErr()).toBe(true);
  });

  test("rejects a foreign or missing schema version in the envelope", () => {
    expect(
      parseChildRefEnvelope({
        ...envelopeOf(validRecord()),
        schemaVersion: 2,
      }).isErr(),
    ).toBe(true);
    expect(parseChildRefEnvelope({ record: validRecord() }).isErr()).toBe(true);
  });

  test("returns typed values for garbage input and never throws", () => {
    for (const value of [undefined, null, 42, "text", [], { a: 1 }]) {
      const parsed = parseChildRefEnvelope(value);
      expect(parsed.isErr()).toBe(true);
      if (parsed.isErr()) expect(parsed.error.type).toBe("ChildRefInvalid");
    }
  });
});

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

describe("append APIs", () => {
  test("appendNewChild writes one versioned envelope with live-parent origin", async () => {
    const sourceCalls: Array<readonly [string, string]> = [];
    const { session, store } = harness({
      authority: {
        checkSource: (sessionRef, expectedParentSessionId) => {
          sourceCalls.push([sessionRef, expectedParentSessionId]);
          return okAsync("available");
        },
      },
    });
    const created = await store.appendNewChild(NEW_CHILD);
    expect(created.isOk()).toBe(true);
    expect(sourceCalls).toEqual([[SESSION_REF, PARENT]]);
    expect(session.appended).toHaveLength(1);
    const entry = session.appended[0];
    expect(entry?.customType).toBe(PI_CHILD_REF_ENTRY_TYPE);
    const parsed = parseChildRefEnvelope(entry?.data);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(parsed.value.schemaVersion).toBe(PI_CHILD_REF_SCHEMA_VERSION);
    expect(parsed.value.kind).toBe("new-child");
    expect(parsed.value.record.originParentSessionId).toBe(PARENT);
    expect(parsed.value.record.originEntryId).toBe("entry-1");
    expect(parsed.value.record.nativeSessionId).toBe("native-1");
    expect(parsed.value.record.status).toBe("queued");
  });

  test("run divider and lifecycle appends preserve immutable origin ids", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    const withRun = await store.appendRunDivider(created.value, {
      action: "retry",
      priorOutcome: "failed",
      initiator: "user",
    });
    expect(withRun.isOk()).toBe(true);
    if (!withRun.isOk()) return;
    expect(withRun.value.runs).toHaveLength(1);
    expect(withRun.value.runs[0]?.action).toBe("retry");
    expect(withRun.value.runs[0]?.run).toBe(1);
    expect(withRun.value.status).toBe("running");

    const settled = await store.appendLifecycle(withRun.value, {
      status: "completed",
    });
    expect(settled.isOk()).toBe(true);
    if (!settled.isOk()) return;
    expect(settled.value.settledAt).toBeGreaterThan(0);

    for (const entry of session.appended) {
      const parsed = parseChildRefEnvelope(entry.data);
      expect(parsed.isOk()).toBe(true);
      if (!parsed.isOk()) continue;
      expect(parsed.value.record.originParentSessionId).toBe(PARENT);
      expect(parsed.value.record.originEntryId).toBe("entry-1");
    }
    // Sequences are an ordering clock, not the run count, so only the order
    // is contractual.
    const sequences = session.appended.flatMap((entry) => {
      const parsed = parseChildRefEnvelope(entry.data);
      return parsed.isOk() ? [parsed.value.sequence] : [];
    });
    expect(sequences).toHaveLength(3);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(3);
  });

  test("repeated lifecycle updates keep strictly increasing sequences", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    let current = created.value;
    for (const status of ["running", "failed", "cancelled"] as const) {
      const next = await store.appendLifecycle(current, { status });
      if (!next.isOk()) throw new Error("append failed");
      current = next.value;
    }
    const sequences = session.appended.flatMap((entry) => {
      const parsed = parseChildRefEnvelope(entry.data);
      return parsed.isOk() ? [parsed.value.sequence] : [];
    });
    expect(sequences).toHaveLength(4);
    expect(
      sequences.every(
        (value, index) => index === 0 || value > (sequences[index - 1] ?? 0),
      ),
    ).toBe(true);
    expect(new Set(sequences).size).toBe(4);
  });

  test("never appends for a child whose recorded origin differs", async () => {
    let sourceChecks = 0;
    const { session, store } = harness({
      authority: {
        checkSource: () => {
          sourceChecks += 1;
          return okAsync("available");
        },
      },
    });
    const foreign = validRecord({ originParentSessionId: OTHER_PARENT });
    const run = await store.appendRunDivider(foreign, { action: "continue" });
    const lifecycle = await store.appendLifecycle(foreign, {
      status: "completed",
    });
    expect(run.isErr()).toBe(true);
    expect(lifecycle.isErr()).toBe(true);
    if (run.isErr()) expect(run.error.type).toBe("ChildRefOriginMismatch");
    if (lifecycle.isErr()) {
      expect(lifecycle.error.type).toBe("ChildRefOriginMismatch");
    }
    expect(sourceChecks).toBe(0);
    expect(session.appended).toHaveLength(0);
  });

  test("rejects invalid append input without writing an entry", async () => {
    let sourceChecks = 0;
    const { session, store } = harness({
      authority: {
        checkSource: () => {
          sourceChecks += 1;
          return okAsync("available");
        },
      },
    });
    const result = await store.appendNewChild({
      ...NEW_CHILD,
      sessionRef: "../escape.jsonl",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ChildRefInvalid");
    expect(sourceChecks).toBe(0);
    expect(session.appended).toHaveLength(0);
  });

  test("maps a throwing host append to a typed failure", async () => {
    const { session, store } = harness();
    session.throwOnAppend = true;
    const result = await store.appendNewChild(NEW_CHILD);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("ChildRefAppendFailed");
  });

  test("refuses to append when there is no live parent session id", async () => {
    const { session, store } = harness({ parentSessionId: "" });
    const result = await store.appendNewChild(NEW_CHILD);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ChildRefParentUnavailable");
    }
    expect(session.appended).toHaveLength(0);
  });

  test("new-child append is rejected with zero writes for each non-available source state", async () => {
    for (const state of [
      "missing",
      "corrupt",
      "unavailable",
      "tombstoned",
    ] as const) {
      const { session, store } = harness({
        authority: fixedAuthority(state),
      });
      const result = await store.appendNewChild(NEW_CHILD);
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) continue;
      expect(result.error).toEqual({
        type: "ChildRefSourceUnusable",
        childId: "child-1",
        state,
      });
      expect(session.appended).toHaveLength(0);
    }
  });

  test("run-divider and lifecycle re-check source authority and reject after tombstone", async () => {
    let state: PiChildRefSourceState = "available";
    const { session, store } = harness({
      authority: {
        checkSource: () => okAsync(state),
      },
    });
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    expect(session.appended).toHaveLength(1);

    state = "tombstoned";
    const run = await store.appendRunDivider(created.value, {
      action: "retry",
    });
    expect(run.isErr()).toBe(true);
    if (run.isErr()) {
      expect(run.error).toEqual({
        type: "ChildRefSourceUnusable",
        childId: "child-1",
        state: "tombstoned",
      });
    }
    expect(session.appended).toHaveLength(1);

    state = "missing";
    const lifecycle = await store.appendLifecycle(created.value, {
      status: "cancelled",
    });
    expect(lifecycle.isErr()).toBe(true);
    if (lifecycle.isErr()) {
      expect(lifecycle.error).toEqual({
        type: "ChildRefSourceUnusable",
        childId: "child-1",
        state: "missing",
      });
    }
    expect(session.appended).toHaveLength(1);
  });

  test("origin mismatch rejects before any source or write side effect", async () => {
    let sourceChecks = 0;
    const { session, store } = harness({
      authority: {
        checkSource: () => {
          sourceChecks += 1;
          return okAsync("available");
        },
      },
    });
    const foreign = validRecord({ originParentSessionId: OTHER_PARENT });
    const result = await store.appendLifecycle(foreign, { status: "failed" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("ChildRefOriginMismatch");
    }
    expect(sourceChecks).toBe(0);
    expect(session.appended).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cumulative runs beyond the retained window
// ---------------------------------------------------------------------------

describe("cumulative run history", () => {
  async function runTimes(
    store: PiChildSessionRefStore,
    seed: PiChildRefRecord,
    times: number,
  ): Promise<PiChildRefRecord> {
    let current = seed;
    for (let index = 0; index < times; index += 1) {
      const next = await store.appendRunDivider(current, { action: "retry" });
      if (!next.isOk()) {
        throw new Error(
          `run ${index + 1} rejected: ${JSON.stringify(next.error)}`,
        );
      }
      current = next.value;
    }
    return current;
  }

  test("appends run 65, past the retained window, without failing", async () => {
    const { store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");

    const atWindow = await runTimes(
      store,
      created.value,
      PI_CHILD_REF_BOUNDS.maxRuns,
    );
    expect(atWindow.runs).toHaveLength(PI_CHILD_REF_BOUNDS.maxRuns);
    expect(childRefTotalRuns(atWindow)).toBe(PI_CHILD_REF_BOUNDS.maxRuns);

    const past = await store.appendRunDivider(atWindow, { action: "retry" });
    expect(past.isOk()).toBe(true);
    if (!past.isOk()) return;
    expect(past.value.runs.at(-1)?.run).toBe(65);
    expect(childRefTotalRuns(past.value)).toBe(65);
    // The window stays bounded; the oldest entry is the one that left.
    expect(past.value.runs).toHaveLength(PI_CHILD_REF_BOUNDS.maxRuns);
    expect(past.value.runs[0]?.run).toBe(2);
  });

  test("appends past run 1,000 and keeps the record bounded", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");

    const late = await runTimes(store, created.value, 1_001);
    expect(childRefTotalRuns(late)).toBe(1_001);
    expect(late.runs.at(-1)?.run).toBe(1_001);
    expect(late.runs).toHaveLength(PI_CHILD_REF_BOUNDS.maxRuns);

    // Every appended envelope stayed valid, so nothing was written that a
    // restart could not decode.
    const newest = session.appended.at(-1);
    const parsed = parseChildRefEnvelope(newest?.data);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(childRefTotalRuns(parsed.value.record)).toBe(1_001);
    expect(parsed.value.record.runs.length).toBeLessThanOrEqual(
      PI_CHILD_REF_BOUNDS.maxRuns,
    );
  });

  test("a restarted store reads back the run-1,001 ref and continues its ordinals", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    await runTimes(store, created.value, 1_001);

    // Fresh store over the same parent entries: nothing in memory carries over.
    const restarted = new PiChildSessionRefStore({
      parentSessionId: PARENT,
      append: session,
      read: session,
      authority: fixedAuthority("available"),
    });
    const scan = await restarted.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    const [ref] = scan.value.refs;
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    expect(childRefTotalRuns(ref)).toBe(1_001);

    const resumed = await restarted.appendRunDivider(ref, { action: "retry" });
    expect(resumed.isOk()).toBe(true);
    if (!resumed.isOk()) return;
    expect(resumed.value.runs.at(-1)?.run).toBe(1_002);
    expect(childRefTotalRuns(resumed.value)).toBe(1_002);
  });

  test("a legacy ref without totalRuns counts its window as the history", () => {
    const legacy = parseChildRefRecord(
      validRecord({
        runs: [
          { run: 1, action: "start", startedAt: 1_000 },
          { run: 2, action: "retry", startedAt: 1_010 },
        ],
      }),
    );
    expect(legacy.isOk()).toBe(true);
    if (!legacy.isOk()) return;
    expect(legacy.value.totalRuns).toBeUndefined();
    expect(childRefTotalRuns(legacy.value)).toBe(2);
  });

  test("keeps the record bounds strict: ordinal ceiling and window size", () => {
    expect(
      parseChildRefRecord(
        validRecord({
          runs: [
            {
              run: PI_CHILD_REF_BOUNDS.maxRunOrdinal + 1,
              action: "start",
              startedAt: 1_000,
            },
          ],
        }),
      ).isErr(),
    ).toBe(true);
    expect(
      parseChildRefRecord(
        validRecord({
          runs: [{ run: 5, action: "start", startedAt: 1_000 }],
          totalRuns: 4,
        }),
      ).isErr(),
    ).toBe(true);
    expect(
      parseChildRefRecord(
        validRecord({
          totalRuns: PI_CHILD_REF_BOUNDS.maxRunOrdinal + 1,
        }),
      ).isErr(),
    ).toBe(true);
  });

  test("appends run 1,000,001, past the old cumulative ceiling", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");

    // A thread that has already run a million times, with only the bounded
    // newest-last window retained. This was the exact point where the old
    // shared run/sequence ceiling refused a healthy append.
    const atOldCeiling: PiChildRefRecord = {
      ...created.value,
      runs: [{ run: OLD_RUN_CEILING, action: "retry", startedAt: 1_000 }],
      totalRuns: OLD_RUN_CEILING,
    };
    expect(parseChildRefRecord(atOldCeiling).isOk()).toBe(true);

    const past = await store.appendRunDivider(atOldCeiling, {
      action: "retry",
    });
    expect(past.isOk()).toBe(true);
    if (!past.isOk()) return;
    expect(past.value.runs.at(-1)?.run).toBe(OLD_RUN_CEILING + 1);
    expect(childRefTotalRuns(past.value)).toBe(OLD_RUN_CEILING + 1);
    expect(past.value.runs.length).toBeLessThanOrEqual(
      PI_CHILD_REF_BOUNDS.maxRuns,
    );

    // What was written is decodable, so a restart sees the same run 1,000,001.
    const parsed = parseChildRefEnvelope(session.appended.at(-1)?.data);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(childRefTotalRuns(parsed.value.record)).toBe(OLD_RUN_CEILING + 1);
  });

  test("keeps appending run dividers well past the old cumulative ceiling", async () => {
    const { store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    let current: PiChildRefRecord = {
      ...created.value,
      runs: [{ run: OLD_RUN_CEILING, action: "retry", startedAt: 1_000 }],
      totalRuns: OLD_RUN_CEILING,
    };
    for (let index = 1; index <= 8; index += 1) {
      const next = await store.appendRunDivider(current, { action: "retry" });
      expect(next.isOk()).toBe(true);
      if (!next.isOk()) return;
      expect(childRefTotalRuns(next.value)).toBe(OLD_RUN_CEILING + index);
      current = next.value;
    }
  });

  test("refuses one append past the finite ordinal ceiling", async () => {
    const { store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    const atCeiling: PiChildRefRecord = {
      ...created.value,
      totalRuns: PI_CHILD_REF_BOUNDS.maxRunOrdinal,
    };
    const result = await store.appendRunDivider(atCeiling, {
      action: "retry",
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error).toEqual({
      type: "ChildRefInvalid",
      issues: ["totalRuns"],
    });
  });
});

// ---------------------------------------------------------------------------
// Ordering identity, separate from the run ordinal
// ---------------------------------------------------------------------------

/** Sequences of every envelope appended, in write order. */
function writtenSequences(session: FakeParentSession): readonly number[] {
  return session.appended.map((entry) => {
    const parsed = parseChildRefEnvelope(entry.data);
    if (!parsed.isOk()) throw new Error("an invalid envelope was appended");
    return parsed.value.sequence;
  });
}

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value > (values[index - 1] ?? 0),
  );
}

describe("envelope ordering identity", () => {
  test("the ordinal ceiling is the ordering-clock ceiling, not a second limit", () => {
    expect(PI_CHILD_REF_BOUNDS.maxRunOrdinal).toBe(
      PI_CHILD_REF_ORDER.maxSequence,
    );
    // The overlay restates the ordinal ceiling to stay acyclic; drift there
    // would reject exactly the long-lived threads this remediation unblocked.
    expect(CHILD_OVERLAY_BOUNDS.maxRunOrdinal).toBe(
      PI_CHILD_REF_BOUNDS.maxRunOrdinal,
    );
    // Both sit far above the old shared ceiling.
    expect(PI_CHILD_REF_ORDER.maxSequence).toBeGreaterThan(OLD_RUN_CEILING);
  });

  test("mixed run and lifecycle appends never reuse a sequence", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    let current = created.value;
    for (let index = 0; index < 12; index += 1) {
      const run = await store.appendRunDivider(current, { action: "retry" });
      if (!run.isOk()) throw new Error("run divider rejected");
      const settled = await store.appendLifecycle(run.value, {
        status: "completed",
      });
      if (!settled.isOk()) throw new Error("lifecycle rejected");
      current = settled.value;
    }

    const sequences = writtenSequences(session);
    expect(sequences).toHaveLength(25);
    expect(strictlyIncreasing(sequences)).toBe(true);
    expect(new Set(sequences).size).toBe(sequences.length);
    // Ordering is independent of the run count: there are more envelopes than
    // runs, and the newest sequence is not the run ordinal.
    expect(sequences.length).toBeGreaterThan(childRefTotalRuns(current));
  });

  test("repeated lifecycle appends at the old ceiling stay ordered and newest wins", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    let current: PiChildRefRecord = {
      ...created.value,
      runs: [{ run: OLD_RUN_CEILING, action: "retry", startedAt: 1_000 }],
      totalRuns: OLD_RUN_CEILING,
    };

    const statuses = [
      "running",
      "queued",
      "running",
      "failed",
      "running",
      "completed",
    ] as const;
    for (const status of statuses) {
      const next = await store.appendLifecycle(current, { status });
      expect(next.isOk()).toBe(true);
      if (!next.isOk()) return;
      current = next.value;
    }

    const sequences = writtenSequences(session);
    expect(strictlyIncreasing(sequences)).toBe(true);
    expect(new Set(sequences).size).toBe(sequences.length);

    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    // No duplicate sequence was emitted, so nothing was reported as a
    // duplicate entry and the last write is the one that wins.
    expect(scan.value.counts.duplicateEntries).toBe(0);
    expect(scan.value.refs[0]?.status).toBe("completed");
    expect(childRefTotalRuns(scan.value.refs[0] as PiChildRefRecord)).toBe(
      OLD_RUN_CEILING,
    );
  });

  test("the clock does not saturate at the wall-clock ceiling", async () => {
    // A store pinned to the last schema-valid instant: the clock can only
    // advance by its own counter from here, which is exactly the case where a
    // clamped sequence would start repeating.
    const { session, store } = harness({
      now: () => PI_CHILD_REF_ORDER.maxTimestamp,
    });
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    let current = created.value;
    for (let index = 0; index < 40; index += 1) {
      const next = await store.appendLifecycle(current, { status: "running" });
      expect(next.isOk()).toBe(true);
      if (!next.isOk()) return;
      current = next.value;
    }

    const sequences = writtenSequences(session);
    expect(sequences).toHaveLength(41);
    expect(strictlyIncreasing(sequences)).toBe(true);
    expect(sequences[0]).toBe(PI_CHILD_REF_ORDER.maxTimestamp);
    expect(sequences.at(-1)).toBe(PI_CHILD_REF_ORDER.maxTimestamp + 40);
    for (const sequence of sequences) {
      expect(sequence).toBeLessThanOrEqual(PI_CHILD_REF_ORDER.maxSequence);
    }
  });

  test("a restarted store resumes the order past the old ceiling", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    const seeded: PiChildRefRecord = {
      ...created.value,
      runs: [{ run: OLD_RUN_CEILING, action: "retry", startedAt: 1_000 }],
      totalRuns: OLD_RUN_CEILING,
    };
    const before = await store.appendRunDivider(seeded, { action: "retry" });
    if (!before.isOk()) throw new Error("setup failed");
    const beforeRestart = writtenSequences(session).at(-1) ?? 0;

    // Fresh store over the same parent entries: nothing in memory carries over.
    const restarted = new PiChildSessionRefStore({
      parentSessionId: PARENT,
      append: session,
      read: session,
      authority: fixedAuthority("available"),
    });
    const scan = await restarted.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    const ref = scan.value.refs[0];
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    expect(childRefTotalRuns(ref)).toBe(OLD_RUN_CEILING + 1);

    const resumedRun = await restarted.appendRunDivider(ref, {
      action: "retry",
    });
    expect(resumedRun.isOk()).toBe(true);
    if (!resumedRun.isOk()) return;
    expect(childRefTotalRuns(resumedRun.value)).toBe(OLD_RUN_CEILING + 2);
    const resumedLifecycle = await restarted.appendLifecycle(resumedRun.value, {
      status: "completed",
    });
    expect(resumedLifecycle.isOk()).toBe(true);

    const sequences = writtenSequences(session);
    expect(strictlyIncreasing(sequences)).toBe(true);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences.at(-1)).toBeGreaterThan(beforeRestart);

    const after = await restarted.readRefs();
    expect(after.isOk()).toBe(true);
    if (!after.isOk()) return;
    expect(after.value.counts.duplicateEntries).toBe(0);
    expect(after.value.refs[0]?.status).toBe("completed");
  });

  test("a legacy small sequence is outranked by every new append", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");

    // A ref written before the ordering clock existed: its sequence came from
    // the run counter and is therefore small.
    const legacy = {
      ...envelopeOf({ ...created.value, status: "queued" as const }, 3),
      kind: "lifecycle" as const,
    };
    session.seedRaw(customEntry(legacy));

    const live = new PiChildSessionRefStore({
      parentSessionId: PARENT,
      append: session,
      read: session,
      authority: fixedAuthority("available"),
    });
    const settled = await live.appendLifecycle(created.value, {
      status: "completed",
    });
    expect(settled.isOk()).toBe(true);

    const sequences = writtenSequences(session);
    expect(sequences.at(-1)).toBeGreaterThan(3);

    const scan = await live.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.counts.duplicateEntries).toBe(0);
    expect(scan.value.refs[0]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("read API", () => {
  test("returns valid refs newest-first and tolerates unrelated entries", async () => {
    const { session, store } = harness();
    session.seedRaw({ type: "message", role: "user" });
    session.seedRaw("not an object");
    session.seedRaw(null);
    const first = await store.appendNewChild(NEW_CHILD);
    const second = await store.appendNewChild({
      ...NEW_CHILD,
      childId: "child-2",
      nativeSessionId: "native-2",
      sessionRef: "child-2/session.jsonl",
      title: "shuttle-child2",
    });
    expect(first.isOk() && second.isOk()).toBe(true);

    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs.map((ref) => ref.childId)).toEqual([
      "child-2",
      "child-1",
    ]);
    expect(scan.value.issues).toHaveLength(0);
    expect(scan.value.counts.usableRefs).toBe(2);
    expect(scan.value.counts.candidateEntries).toBe(2);
    expect(scan.value.counts.scannedEntries).toBe(5);
  });

  test("collapses updates to the newest entry per child", async () => {
    const { store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    const updated = await store.appendLifecycle(created.value, {
      status: "completed",
      title: "loom-child1",
      titleProvenance: PI_CHILD_TITLE_PROVENANCE,
    });
    expect(updated.isOk()).toBe(true);

    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs).toHaveLength(1);
    expect(scan.value.refs[0]?.status).toBe("completed");
    expect(scan.value.refs[0]?.title).toBe("loom-child1");
  });

  test("newest bounded scan keeps recent lifecycle state when older entries exceed the cap", async () => {
    const { session, store } = harness();
    // Chronological layout: early lifecycle, then enough fillers that an
    // oldest-first cap would drop the completed update at the end.
    session.seedRaw(
      customEntry(envelopeOf(validRecord({ status: "running" }), 1)),
    );
    for (
      let index = 0;
      index < PI_CHILD_REF_BOUNDS.maxScannedEntries - 1;
      index += 1
    ) {
      session.seedRaw({ type: "message", role: "user", id: `filler-${index}` });
    }
    session.seedRaw(
      customEntry(
        envelopeOf(
          validRecord({
            status: "completed",
            updatedAt: 2_000,
            settledAt: 2_000,
          }),
          2,
        ),
      ),
    );

    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.counts.scannedEntries).toBe(
      PI_CHILD_REF_BOUNDS.maxScannedEntries,
    );
    expect(scan.value.refs).toHaveLength(1);
    expect(scan.value.refs[0]?.status).toBe("completed");
    expect(scan.value.refs[0]?.settledAt).toBe(2_000);
    expect(scan.value.refs.map((ref) => ref.childId)).toEqual(["child-1"]);
  });

  test("reports malformed ref entries as typed issues and skips them", async () => {
    const { session, store } = harness();
    session.seedRaw(customEntry({ schemaVersion: 1, nonsense: true }));
    session.seedRaw(customEntry("definitely not an envelope"));
    const created = await store.appendNewChild(NEW_CHILD);
    expect(created.isOk()).toBe(true);

    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs.map((ref) => ref.childId)).toEqual(["child-1"]);
    expect(scan.value.counts.malformedEntries).toBe(2);
    expect(
      scan.value.issues.filter((issue) => issue.kind === "invalid-envelope"),
    ).toHaveLength(2);
  });

  test("excludes fork/clone origin mismatches and reports them informationally", async () => {
    const { session, store } = harness();
    session.seedRaw(
      customEntry(
        envelopeOf(validRecord({ originParentSessionId: OTHER_PARENT })),
      ),
    );
    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs).toHaveLength(0);
    expect(scan.value.counts.originMismatchedChildren).toBe(1);
    expect(scan.value.issues).toEqual([
      { kind: "origin-mismatch", childId: "child-1" },
    ]);
  });

  test("fails closed when immutable origin fields conflict for one child", async () => {
    const { session, store } = harness();
    session.seedRaw(customEntry(envelopeOf(validRecord(), 1)));
    session.seedRaw(
      customEntry(envelopeOf(validRecord({ originEntryId: "entry-9" }), 2)),
    );
    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs).toHaveLength(0);
    expect(scan.value.counts.conflictingChildren).toBe(1);
    expect(
      scan.value.issues.some(
        (issue) =>
          issue.kind === "conflicting-entry" && issue.field === "originEntryId",
      ),
    ).toBe(true);
  });

  test("reports duplicate entries at the same sequence", async () => {
    const { session, store } = harness();
    session.seedRaw(customEntry(envelopeOf(validRecord(), 3)));
    session.seedRaw(
      customEntry(envelopeOf(validRecord({ title: "other-child1" }), 3)),
    );
    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.counts.duplicateEntries).toBe(1);
    expect(
      scan.value.issues.some((issue) => issue.kind === "duplicate-entry"),
    ).toBe(true);
  });

  test("bounds the number of returned refs", async () => {
    const { session, store } = harness();
    for (let index = 0; index < 5; index += 1) {
      session.seedRaw(
        customEntry(
          envelopeOf(
            validRecord({
              childId: `child-${index}`,
              threadId: `child-${index}`,
              nativeSessionId: `native-${index}`,
              sessionRef: `child-${index}/session.jsonl`,
              updatedAt: 1_000 + index,
            }),
          ),
        ),
      );
    }
    const scan = await store.readRefs({ limit: 2 });
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs).toHaveLength(2);
    expect(scan.value.refs[0]?.childId).toBe("child-4");
  });

  test("maps a throwing entry read to a typed failure", async () => {
    const { session, store } = harness();
    session.throwOnRead = true;
    const scan = await store.readRefs();
    expect(scan.isErr()).toBe(true);
    if (scan.isErr()) {
      expect(scan.error.type).toBe("ChildRefParentUnavailable");
    }
  });
});

// ---------------------------------------------------------------------------
// Source authority
// ---------------------------------------------------------------------------

describe("source authority", () => {
  test("excludes refs whose authoritative session is missing", async () => {
    const { session, store } = harness({
      authority: fixedAuthority("missing"),
    });
    session.seedRaw(customEntry(envelopeOf(validRecord())));
    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs).toHaveLength(0);
    expect(scan.value.counts.unusableSourceChildren).toBe(1);
    expect(scan.value.issues).toEqual([
      { kind: "source-unusable", childId: "child-1", state: "missing" },
    ]);
  });

  test("excludes corrupt, unavailable, and tombstoned sources", async () => {
    for (const state of ["corrupt", "unavailable", "tombstoned"] as const) {
      const { session, store } = harness({ authority: fixedAuthority(state) });
      session.seedRaw(customEntry(envelopeOf(validRecord())));
      const scan = await store.readRefs();
      expect(scan.isOk()).toBe(true);
      if (!scan.isOk()) continue;
      expect(scan.value.refs).toHaveLength(0);
      expect(scan.value.issues[0]).toEqual({
        kind: "source-unusable",
        childId: "child-1",
        state,
      });
    }
  });

  test("keeps only the refs whose sessions are available", async () => {
    const { session, store } = harness({
      authority: authorityByRef({
        "child-1/session.jsonl": "available",
        "child-2/session.jsonl": "corrupt",
      }),
    });
    session.seedRaw(customEntry(envelopeOf(validRecord())));
    session.seedRaw(
      customEntry(
        envelopeOf(
          validRecord({
            childId: "child-2",
            threadId: "child-2",
            nativeSessionId: "native-2",
            sessionRef: "child-2/session.jsonl",
            updatedAt: 2_000,
          }),
        ),
      ),
    );
    const scan = await store.readRefs();
    expect(scan.isOk()).toBe(true);
    if (!scan.isOk()) return;
    expect(scan.value.refs.map((ref) => ref.childId)).toEqual(["child-1"]);
    expect(scan.value.counts.unusableSourceChildren).toBe(1);
  });

  test("the ref store exposes no session-mutating API", () => {
    const { store } = harness();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
    ];
    for (const forbidden of [
      "createSession",
      "deleteSession",
      "restoreSession",
      "repairSession",
      "writeSession",
      "appendSessionEntry",
    ]) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface.sort()).toEqual(
      [
        "appendLifecycle",
        "appendNewChild",
        "appendRunDivider",
        "applyAuthority",
        "collect",
        "constructor",
        "guardOrigin",
        "liveParentSessionId",
        "nextSequence",
        "readRefs",
        "scanEntries",
        "write",
      ].sort(),
    );
  });
});

describe("native source authority adapter", () => {
  const nativeRecord: PiNativeSessionRecord = {
    childId: "child-1",
    sessionId: "native-1",
    ref: SESSION_REF,
    path: `/root/${SESSION_REF}`,
    parentSession: PARENT,
    cwd: "/work",
  };

  function nativeStore(options: {
    readonly open: (
      ref: string,
    ) => ResultAsync<PiNativeSessionRecord, PiNativeSessionError>;
    readonly tombstones?: readonly PiNativeSessionTombstone[];
  }) {
    return {
      openSession: (ref: string) => options.open(ref),
      readTombstones: () =>
        okAsync<readonly PiNativeSessionTombstone[], PiNativeSessionError>(
          options.tombstones ?? [],
        ),
    };
  }

  test("maps store outcomes to source states", async () => {
    const cases: readonly {
      readonly error?: PiNativeSessionError;
      readonly expected: PiChildRefSourceState;
    }[] = [
      { expected: "available" },
      {
        error: { type: "SessionMissing", ref: SESSION_REF },
        expected: "missing",
      },
      {
        error: {
          type: "SessionCorrupt",
          ref: SESSION_REF,
          reason: "unreadable",
        },
        expected: "corrupt",
      },
      {
        error: {
          type: "SessionStorageUnavailable",
          reason: "filesystem-unavailable",
        },
        expected: "unavailable",
      },
    ];
    for (const testCase of cases) {
      const authority = createNativeChildRefSourceAuthority(
        nativeStore({
          open: () =>
            testCase.error === undefined
              ? okAsync(nativeRecord)
              : errAsync(testCase.error),
        }),
      );
      const state = await authority.checkSource(SESSION_REF, PARENT);
      expect(state.isOk()).toBe(true);
      if (state.isOk()) expect(state.value).toBe(testCase.expected);
    }
  });

  test("reports a tombstoned session without opening it", async () => {
    let opened = 0;
    const authority = createNativeChildRefSourceAuthority(
      nativeStore({
        open: () => {
          opened += 1;
          return okAsync(nativeRecord);
        },
        tombstones: [
          {
            version: 1,
            ref: SESSION_REF,
            childId: "child-1",
            parentSession: PARENT,
            deletedAt: "2026-01-01T00:00:00.000Z",
            reason: "explicit-user-deletion",
          },
        ],
      }),
    );
    const state = await authority.checkSource(SESSION_REF, PARENT);
    expect(state.isOk()).toBe(true);
    if (state.isOk()) expect(state.value).toBe("tombstoned");
    expect(opened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("serialization carries metadata only", () => {
  test("serialized envelopes contain no transcript-like fields", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild({
      ...NEW_CHILD,
      run: { action: "start", startedAt: 1_000, initiator: "loom" },
    });
    if (!created.isOk()) throw new Error("setup failed");
    const withRun = await store.appendRunDivider(created.value, {
      action: "retry",
    });
    if (!withRun.isOk()) throw new Error("setup failed");
    const done = await store.appendLifecycle(withRun.value, {
      status: "completed",
    });
    expect(done.isOk()).toBe(true);

    expect(session.appended.length).toBeGreaterThan(0);
    for (const entry of session.appended) {
      const serialized = JSON.stringify(entry.data);
      expect(hasNoTranscriptFields(serialized)).toBe(true);
      for (const needle of [
        "prompt",
        "message",
        "assistant",
        "thinking",
        "toolResult",
        "transcript",
        "content",
      ]) {
        expect(serialized).not.toContain(needle);
      }
    }
  });

  test("envelope keys are exactly the declared metadata keys", async () => {
    const { session, store } = harness();
    const created = await store.appendNewChild(NEW_CHILD);
    if (!created.isOk()) throw new Error("setup failed");
    const parsed = parseChildRefEnvelope(session.appended[0]?.data);
    expect(parsed.isOk()).toBe(true);
    if (!parsed.isOk()) return;
    expect(Object.keys(parsed.value).sort()).toEqual([
      "appendedAt",
      "entryType",
      "kind",
      "record",
      "schemaVersion",
      "sequence",
    ]);
    expect(Object.keys(parsed.value.record).sort()).toEqual([
      "childId",
      "createdAt",
      "nativeSessionId",
      "originEntryId",
      "originParentSessionId",
      "runs",
      "sessionRef",
      "status",
      "threadId",
      "title",
      "titleProvenance",
      "totalRuns",
      "updatedAt",
    ]);
    expect(serializeChildRefEnvelope(parsed.value)).toBe(
      JSON.stringify(parsed.value),
    );
  });

  test("the transcript guard detects nested forbidden fields", () => {
    expect(
      hasNoTranscriptFields(
        JSON.stringify({ record: { runs: [{ toolResult: "x" }] } }),
      ),
    ).toBe(false);
    expect(hasNoTranscriptFields("not json")).toBe(false);
  });
});
