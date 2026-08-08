import { describe, expect, test } from "bun:test";
import {
  appendUnseenCheckpointEntries,
  createEmptyPiChildSessionCheckpoint,
  decodePiChildSessionCheckpoint,
  encodePiChildSessionCheckpoint,
} from "../child-session-checkpoint.js";
import type { JsonValue } from "../strict-json.js";

const entry = (id: string, payload: JsonValue, parentId?: string) => ({
  id,
  ...(parentId === undefined ? {} : { parentId }),
  kind: "message",
  payload,
});

describe("Pi child session checkpoints", () => {
  test("appends only unseen entries and is idempotent for repeated batches", () => {
    const base = createEmptyPiChildSessionCheckpoint(1);
    const first = appendUnseenCheckpointEntries(
      base,
      [entry("root", "private"), entry("a", "a", "root")],
      "a",
      2,
      2,
    ).unwrapOr(base);
    const repeated = appendUnseenCheckpointEntries(
      first,
      [entry("root", "private"), entry("a", "a", "root")],
      "a",
      3,
      2,
    );

    expect(repeated.isOk()).toBe(true);
    if (repeated.isOk()) {
      expect(repeated.value.entries).toEqual(first.entries);
      expect(repeated.value.checkpointCursor).toBe(2);
      expect(repeated.value.updatedAt).toBe(3);
    }
  });

  test("rejects a conflicting identity instead of silently replacing it", () => {
    const base = createEmptyPiChildSessionCheckpoint(1);
    const first = appendUnseenCheckpointEntries(
      base,
      [entry("same", "original")],
      undefined,
      2,
    ).unwrapOr(base);
    const result = appendUnseenCheckpointEntries(
      first,
      [entry("same", "changed")],
      undefined,
      3,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("checkpoint-conflict");
  });

  test("persists and restores the active leaf and checkpoint cursor", () => {
    const base = createEmptyPiChildSessionCheckpoint(1);
    const appended = appendUnseenCheckpointEntries(
      base,
      [entry("root", "root"), entry("leaf", "leaf", "root")],
      "leaf",
      2,
      42,
    );
    expect(appended.isOk()).toBe(true);
    if (appended.isOk()) {
      const bytes = encodePiChildSessionCheckpoint(appended.value).unwrapOr(
        new Uint8Array(),
      );
      const restored = decodePiChildSessionCheckpoint(bytes);
      expect(restored.isOk()).toBe(true);
      if (restored.isOk()) {
        expect(restored.value.activeLeaf).toBe("leaf");
        expect(restored.value.checkpointCursor).toBe(42);
      }
    }
  });

  test("preserves alternate branch ancestry when a later batch selects one leaf", () => {
    const base = createEmptyPiChildSessionCheckpoint(1);
    const first = appendUnseenCheckpointEntries(
      base,
      [entry("root", "root"), entry("left", "left", "root")],
      "left",
      2,
    ).unwrapOr(base);
    const result = appendUnseenCheckpointEntries(
      first,
      [
        entry("right", "right", "root"),
        entry("right-leaf", "right-leaf", "right"),
      ],
      "right-leaf",
      3,
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(
        result.value.entries.map(({ id, parentId }) => ({ id, parentId })),
      ).toEqual([
        { id: "root", parentId: undefined },
        { id: "left", parentId: "root" },
        { id: "right", parentId: "root" },
        { id: "right-leaf", parentId: "right" },
      ]);
      expect(result.value.activeLeaf).toBe("right-leaf");
    }
  });

  test("rejects malformed, duplicate, oversized, unsupported, and out-of-order input safely", () => {
    const malformed = decodePiChildSessionCheckpoint(
      new TextEncoder().encode('{"entries":'),
    );
    expect(malformed.isErr()).toBe(true);
    if (malformed.isErr())
      expect(JSON.stringify(malformed.error)).not.toContain("entries");

    const duplicateKeys = decodePiChildSessionCheckpoint(
      new TextEncoder().encode(
        '{"schemaVersion":1,"schemaVersion":1,"entries":[],"updatedAt":1}',
      ),
    );
    expect(duplicateKeys.isErr()).toBe(true);

    const unsupported = decodePiChildSessionCheckpoint(
      new TextEncoder().encode(
        '{"schemaVersion":2,"entries":[],"updatedAt":1}',
      ),
    );
    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr())
      expect(unsupported.error.type).toBe("checkpoint-version-unsupported");

    const base = createEmptyPiChildSessionCheckpoint(1);
    const duplicate = appendUnseenCheckpointEntries(
      base,
      [entry("same", "a"), entry("same", "a")],
      undefined,
      2,
    );
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr())
      expect(duplicate.error.type).toBe("checkpoint-duplicate");

    const outOfOrder = appendUnseenCheckpointEntries(
      base,
      [entry("child", "child", "missing-parent")],
      undefined,
      2,
    );
    expect(outOfOrder.isErr()).toBe(true);
    if (outOfOrder.isErr())
      expect(outOfOrder.error.type).toBe("checkpoint-out-of-order");

    const oversized = appendUnseenCheckpointEntries(
      base,
      [
        entry(
          "large",
          Array.from({ length: 32 }, () => "x".repeat(16_000)),
        ),
      ],
      undefined,
      2,
    );
    expect(oversized.isErr()).toBe(true);
    if (oversized.isErr())
      expect(oversized.error.type).toBe("checkpoint-oversized");

    const cursorBase = appendUnseenCheckpointEntries(
      base,
      [entry("cursor", "first")],
      undefined,
      2,
      2,
    ).unwrapOr(base);
    const backwards = appendUnseenCheckpointEntries(
      cursorBase,
      [entry("later", "later")],
      undefined,
      3,
      1,
    );
    expect(backwards.isErr()).toBe(true);
    if (backwards.isErr())
      expect(backwards.error.type).toBe("checkpoint-out-of-order");
  });

  test("rejects a torn or oversized checkpoint without exposing raw content", () => {
    const torn = decodePiChildSessionCheckpoint(
      new TextEncoder().encode('{"broken-secret":'),
    );
    expect(torn.isErr()).toBe(true);
    if (torn.isErr())
      expect(JSON.stringify(torn.error)).not.toContain("broken-secret");

    const oversized = decodePiChildSessionCheckpoint(new Uint8Array(1_048_577));
    expect(oversized.isErr()).toBe(true);
    if (oversized.isErr())
      expect(oversized.error.type).toBe("checkpoint-oversized");
  });
});
