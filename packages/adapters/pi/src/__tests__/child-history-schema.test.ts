import { describe, expect, it } from "bun:test";
import {
  PI_CHILD_HISTORY_LAYOUT,
  PiChildHistoryIndexV1Schema,
  parsePiChildHistoryIndex,
} from "../child-history-schema.js";

const RECORD = {
  childId: "child-1",
  parentSessionId: "parent-1",
  kind: "ordinary" as const,
  status: "settled" as const,
  workflow: {},
  sessionPath: "children/child-1/session.jsonl",
  checkpointCursor: 3,
  branchAncestry: [],
  interventionCount: 1,
  finalOutput: "done",
  trim: { trimmed: false, markerCount: 0 },
  quarantine: { quarantined: false },
  clear: { cleared: false },
  recovery: { eligible: false, count: 0 },
  bytes: { session: 10, checkpoint: 4, total: 14 },
  createdAt: 1,
  updatedAt: 2,
};

const INDEX = {
  schemaVersion: 1 as const,
  parentSessionId: "parent-1",
  records: [RECORD],
  updatedAt: 2,
};

describe("PiChildHistoryIndexV1", () => {
  it("round-trips and rejects unknown versions", () => {
    const parsed = parsePiChildHistoryIndex(INDEX);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk())
      expect(PiChildHistoryIndexV1Schema.parse(parsed.value)).toEqual(INDEX);
    const unknown = parsePiChildHistoryIndex({ ...INDEX, schemaVersion: 2 });
    expect(unknown.isErr()).toBe(true);
    if (unknown.isErr())
      expect(unknown.error.type).toBe("ChildHistoryVersionUnsupported");
  });

  it("caps all stored strings and final output by UTF-8 bytes", () => {
    expect(
      PiChildHistoryIndexV1Schema.safeParse({
        ...INDEX,
        records: [{ ...RECORD, sessionPath: "x".repeat(1_025) }],
      }).success,
    ).toBe(false);
    expect(
      PiChildHistoryIndexV1Schema.safeParse({
        ...INDEX,
        records: [{ ...RECORD, finalOutput: "🙂".repeat(1_025) }],
      }).success,
    ).toBe(false);
  });

  it("keeps the prescribed private layout and no transcript field", () => {
    expect(PI_CHILD_HISTORY_LAYOUT).toEqual({
      indexFile: "index.v1.json",
      childDirectory: "children",
      sessionFile: "session.jsonl",
      checkpointFile: "checkpoint.json",
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    expect("transcript" in RECORD).toBe(false);
    expect("prompt" in RECORD).toBe(false);
  });
});
