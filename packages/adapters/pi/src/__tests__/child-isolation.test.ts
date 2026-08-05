import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
  type AppendNewChildRefInput,
  type PiChildRefSourceState,
  type PiChildRefSourceAuthority,
  PiChildSessionRefStore,
} from "../child-session-refs.js";
import { PersistentFakeNativeSessionStore } from "./fakes/fake-pi-host.js";

const PARENT = "parent-session";

class ParentSessionFake {
  readonly entries: unknown[] = [];

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ type: "custom", customType, data });
  }

  getEntries(): readonly unknown[] {
    return this.entries;
  }
}

function authority(states: Record<string, PiChildRefSourceState>): PiChildRefSourceAuthority {
  return {
    checkSource: (ref, parent) =>
      okAsync(parent === PARENT ? (states[ref] ?? "missing") : "missing"),
  };
}

function store(
  parent: ParentSessionFake,
  states: Record<string, PiChildRefSourceState>,
  now: () => number = (() => {
    let value = 1_000;
    return () => (value += 1);
  })(),
): PiChildSessionRefStore {
  let entryId = 0;
  return new PiChildSessionRefStore({
    parentSessionId: PARENT,
    append: parent,
    read: parent,
    authority: authority(states),
    now,
    newEntryId: () => `entry-${++entryId}`,
  });
}

function input(childId: string, ref = `${childId}/session.jsonl`): AppendNewChildRefInput {
  return {
    childId,
    threadId: `${childId}-thread`,
    nativeSessionId: `${childId}-native`,
    sessionRef: ref,
    title: `Task ${childId}`,
  };
}

describe("native child isolation", () => {
  test("keeps concurrent nested children isolated by parent and source", async () => {
    const parent = new ParentSessionFake();
    const refs = store(parent, {
      "child-a/session.jsonl": "available",
      "child-b/session.jsonl": "available",
      "child-a/nested/session.jsonl": "available",
    });

    const created = await Promise.all([
      refs.appendNewChild(input("child-a")),
      refs.appendNewChild(input("child-b")),
      refs.appendNewChild(input("child-a/nested", "child-a/nested/session.jsonl")),
    ]);

    expect(created.every((result) => result.isOk())).toBe(true);
    const scan = await refs.readRefs({ limit: 10 });
    expect(scan.isOk()).toBe(true);
    expect(
      scan.match(
        (value) => value.refs.map((record) => record.childId),
        () => [],
      ),
    ).toEqual(["child-a/nested", "child-b", "child-a"]);

    const foreignParent = new PiChildSessionRefStore({
      parentSessionId: "other-parent",
      append: parent,
      read: parent,
      authority: authority({ "child-a/session.jsonl": "available" }),
      now: () => 2_000,
      newEntryId: () => "foreign-entry",
    });
    const foreignScan = await foreignParent.readRefs();
    expect(foreignScan.isOk()).toBe(true);
    expect(foreignScan._unsafeUnwrap().refs).toEqual([]);
  });

  test("preserves append order when completions arrive out of order", async () => {
    const parent = new ParentSessionFake();
    const refs = store(parent, {
      "first/session.jsonl": "available",
      "second/session.jsonl": "available",
    });

    const first = await refs.appendNewChild(input("first"));
    const second = await refs.appendNewChild(input("second"));
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    const firstRecord = first._unsafeUnwrap();
    const secondRecord = second._unsafeUnwrap();
    const completed = await refs.appendLifecycle(firstRecord, { status: "completed" });
    const retried = await refs.appendRunDivider(secondRecord, {
      action: "retry",
      priorOutcome: "failed",
      initiator: "user",
    });
    expect(completed.isOk()).toBe(true);
    expect(retried.isOk()).toBe(true);

    const scan = await refs.readRefs();
    expect(scan.isOk()).toBe(true);
    const records = scan._unsafeUnwrap().refs;
    expect(records.map((record) => record.childId)).toEqual(["second", "first"]);
    expect(records[0]?.runs.map((run) => run.action)).toEqual(["retry"]);
    expect(records[1]?.status).toBe("completed");
  });

  test("reports missing, corrupt, tombstoned, and unavailable native sources without mixing them", async () => {
    const parent = new ParentSessionFake();
    const states = {
      "available/session.jsonl": "available",
      "missing/session.jsonl": "available",
      "corrupt/session.jsonl": "available",
      "tombstoned/session.jsonl": "available",
      "unavailable/session.jsonl": "available",
    } as Record<string, PiChildRefSourceState>;
    const refs = store(parent, states);

    for (const childId of Object.keys(states).map((ref) => ref.split("/")[0])) {
      expect((await refs.appendNewChild(input(childId))).isOk()).toBe(true);
    }
    states["missing/session.jsonl"] = "missing";
    states["corrupt/session.jsonl"] = "corrupt";
    states["tombstoned/session.jsonl"] = "tombstoned";
    states["unavailable/session.jsonl"] = "unavailable";

    const scan = await refs.readRefs({ limit: 20 });
    expect(scan.isOk()).toBe(true);
    const value = scan._unsafeUnwrap();
    expect(value.refs.map((record) => record.childId)).toEqual(["available"]);
    expect(value.issues).toEqual(
      expect.arrayContaining([
        { kind: "source-unusable", childId: "missing", state: "missing" },
        { kind: "source-unusable", childId: "corrupt", state: "corrupt" },
        { kind: "source-unusable", childId: "tombstoned", state: "tombstoned" },
        { kind: "source-unusable", childId: "unavailable", state: "unavailable" },
      ]),
    );
  });

  test("reconstructs the same native session after reload and rejects tombstone writes", () => {
    const first = new PersistentFakeNativeSessionStore();
    first.create("child-native");
    expect(
      first.append("child-native", {
        type: "message_end",
        data: { text: "completed before reload" },
      }),
    ).toBe(true);
    first.tombstone("child-native");

    const reloaded = first.reload();
    expect(reloaded.read("child-native")).toEqual([
      { type: "message_end", data: { text: "completed before reload" } },
    ]);
    expect(reloaded.isTombstoned("child-native")).toBe(true);
    expect(
      reloaded.append("child-native", { type: "retry", data: {} }),
    ).toBe(false);
  });

  test("does not resurrect a tombstoned child during retry or continue", async () => {
    const parent = new ParentSessionFake();
    const states: Record<string, PiChildRefSourceState> = {
      "child/session.jsonl": "available",
    };
    const refs = store(parent, states);
    const created = await refs.appendNewChild(input("child"));
    const record = created._unsafeUnwrap();

    states["child/session.jsonl"] = "tombstoned";
    const retry = await refs.appendRunDivider(record, {
      action: "retry",
      priorOutcome: "failed",
    });
    const continueRun = await refs.appendRunDivider(record, {
      action: "continue",
      priorOutcome: "failed",
    });
    expect(retry.isErr()).toBe(true);
    expect(continueRun.isErr()).toBe(true);
    expect(parent.entries).toHaveLength(1);
  });

  test("bounds a scan and releases capacity after settled children", async () => {
    const parent = new ParentSessionFake();
    const states: Record<string, PiChildRefSourceState> = {};
    const refs = store(parent, states);
    for (let index = 0; index < 100; index += 1) {
      const ref = `child-${index}/session.jsonl`;
      states[ref] = "available";
      expect((await refs.appendNewChild(input(`child-${index}`, ref))).isOk()).toBe(true);
    }

    const limited = await refs.readRefs({ limit: 7 });
    expect(limited.isOk()).toBe(true);
    expect(limited._unsafeUnwrap().refs).toHaveLength(7);
    const firstRef = limited._unsafeUnwrap().refs.at(0);
    expect(firstRef).toBeDefined();
    if (firstRef === undefined) return;
    const settled = await refs.appendLifecycle(firstRef, { status: "completed" });
    expect(settled.isOk()).toBe(true);
    const after = await refs.readRefs({ limit: 7 });
    expect(after._unsafeUnwrap().refs[0]?.status).toBe("completed");
  });
});
