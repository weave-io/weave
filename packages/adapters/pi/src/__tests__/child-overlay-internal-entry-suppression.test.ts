/**
 * Adapter-owned bookkeeping must never reach the reader's transcript.
 *
 * A child's native session carries three kinds of entry the operator never
 * asked for and never observed: the `weave.child.thread` pointer that names
 * the child's storage leaf, and the `weave.child.result-chunk` /
 * `weave.child.result-commit` group that carries the durable authoritative
 * result. A clean-HEAD child-inspector smoke showed the last two falling
 * through the generic custom-entry branch and printing as bare
 * `· status weave.child.result-chunk` rows.
 *
 * This suite drives one bounded native page containing all three internal
 * records alongside ordinary messages and a genuine, user-visible custom
 * status, and proves the mapping drops exactly the three internal records and
 * keeps everything else — including the raw internal type strings, which must
 * appear nowhere in the rendered settled transcript.
 */

import { describe, expect, it } from "bun:test";
import {
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
} from "../child-native-results.js";
import { PI_NATIVE_THREAD_ENTRY_TYPE } from "../child-native-sessions.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import {
  mapNativeSessionEntryToOverlay,
  transcriptFromOverlayEntries,
} from "../child-overlay-replay.js";
import type { ChildOverlayEntry } from "../child-overlay-types.js";
import { plainPaint } from "../ui-paint.js";

/** A user-visible custom fact the adapter must keep rendering as a status. */
const VISIBLE_STATUS_TYPE = "weave.child.compaction";

const NATIVE_PAGE: readonly unknown[] = [
  {
    type: "custom",
    id: "entry-thread",
    customType: PI_NATIVE_THREAD_ENTRY_TYPE,
    data: { childId: "child-1", leaf: "leaf-1" },
  },
  {
    type: "message",
    id: "entry-user",
    message: {
      role: "user",
      content: "summarize the run",
      timestamp: 1_700_000_000_000,
    },
  },
  {
    type: "custom",
    id: "entry-chunk-1",
    customType: PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
    data: { index: 0, bytes: 12, text: "chunk payload" },
  },
  {
    type: "custom",
    id: "entry-status",
    customType: VISIBLE_STATUS_TYPE,
    data: {},
  },
  {
    type: "custom",
    id: "entry-chunk-2",
    customType: PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
    data: { index: 1, bytes: 9, text: "more payload" },
  },
  {
    type: "message",
    id: "entry-assistant",
    message: {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      content: [{ type: "text", text: "the run finished" }],
      usage: {
        input: 2,
        output: 4,
        cacheRead: 10,
        cacheWrite: 1,
        totalTokens: 17,
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    },
  },
  {
    type: "custom",
    id: "entry-commit",
    customType: PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
    data: { count: 2, totalBytes: 21, digest: "a".repeat(64) },
  },
];

function mappedEntries(): readonly ChildOverlayEntry[] {
  const entries: ChildOverlayEntry[] = [];
  NATIVE_PAGE.forEach((entry, index) => {
    const mapped = mapNativeSessionEntryToOverlay(entry, index);
    expect(mapped.isOk()).toBe(true);
    if (mapped.isOk() && mapped.value !== undefined) entries.push(mapped.value);
  });
  return entries;
}

describe("internal durable-result records never become overlay entries", () => {
  it("drops the thread pointer, every result chunk and the commit marker", () => {
    const ids = mappedEntries().map((entry) => entry.id);
    expect(ids).not.toContain("entry-thread");
    expect(ids).not.toContain("entry-chunk-1");
    expect(ids).not.toContain("entry-chunk-2");
    expect(ids).not.toContain("entry-commit");
  });

  it("keeps ordinary messages and the user-visible custom status", () => {
    const entries = mappedEntries();
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain("entry-user");
    expect(ids).toContain("entry-assistant");
    expect(ids).toContain("entry-status");
    // Exactly three survivors: nothing else was hidden along the way.
    expect(entries).toHaveLength(3);

    const status = entries.find((entry) => entry.id === "entry-status");
    expect(status?.kind).toBe("status");
    expect(status?.text).toBe(VISIBLE_STATUS_TYPE);
  });

  it("renders a settled transcript with no raw internal type string", () => {
    const rendered = renderOverlayPiNative(
      plainPaint(),
      {
        entries: transcriptFromOverlayEntries(mappedEntries()).entries,
        childName: "shuttle",
        settled: true,
      },
      96,
    ).plain.join("\n");

    expect(rendered).not.toContain(PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE);
    expect(rendered).not.toContain(PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE);
    expect(rendered).not.toContain(PI_NATIVE_THREAD_ENTRY_TYPE);
    expect(rendered).not.toContain("result-chunk");
    expect(rendered).not.toContain("result-commit");
    expect(rendered).toContain("the run finished");
    expect(rendered).toContain(VISIBLE_STATUS_TYPE);
  });
});
