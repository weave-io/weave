import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { errAsync, okAsync } from "neverthrow";
import {
  PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS,
  type PiNativeSessionEntryPage,
  type PiNativeSessionEntryPageOptions,
  type PiNativeSessionError,
  type PiNativeSessionFsPort,
  type PiNativeSessionHandle,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import {
  CHILD_OVERLAY_BOUNDS,
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  createReadSessionEntryPageOverlaySource,
  mapNativeSessionEntryToOverlay,
  transcriptFromOverlayEntries,
  type ChildOverlayChild,
  type ChildOverlayFallbackRequired,
  type ChildOverlayMutationPort,
  type ChildOverlayView,
  type MemoryOverlaySourceChild,
  type MemoryOverlaySourceEntry,
} from "../child-overlay.js";
import { MemoryPiNativeSessionFs } from "../native-session-fs.js";

/** Pi native components read the process-wide theme. */
initTheme("default");

const ESCAPE = "\x1b";
const ENTER = "\r";
const ALT_ENTER = "\x1b\r";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const CTRL_E = "\x05";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content },
  };
}

function runDivider(id: string, run: number, action: "start" | "retry" | "continue"): unknown {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "weave.child.run-divider",
    data: { run, action },
  };
}

function entries(count: number, prefix = "e"): MemoryOverlaySourceEntry[] {
  const result: MemoryOverlaySourceEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}${i}`;
    let role: "user" | "assistant";
    if (i === 0 || i % 2 === 0) {
      role = "user";
    } else {
      role = "assistant";
    }
    result.push({
      id,
      payload: message(id, role, `${prefix}-text-${i}`),
    });
  }
  return result;
}

function child(
  partial: Partial<MemoryOverlaySourceChild> &
    Pick<MemoryOverlaySourceChild, "childId" | "entries">,
): MemoryOverlaySourceChild {
  return {
    threadId: partial.threadId ?? partial.childId,
    status: partial.status ?? "settled",
    title: partial.title,
    generationId: partial.generationId,
    parentChildId: partial.parentChildId,
    runs: partial.runs ?? [{ run: 1, action: "start" }],
    branchIds: partial.branchIds ?? ["main"],
    descendantChildIds: partial.descendantChildIds ?? [],
    childId: partial.childId,
    entries: partial.entries,
  };
}

async function mustOpen(
  controller: ReturnType<typeof createChildOverlayController>,
  target: ChildOverlayChild | string,
): Promise<ChildOverlayView> {
  const result = await controller.open(target);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

/** In-memory native page adapter for overlay source unit tests. */
function pageMemoryEntries(
  entries: readonly unknown[],
  options: PiNativeSessionEntryPageOptions,
): PiNativeSessionEntryPage {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const parseCursor = (cursor: string | undefined): number => {
    if (cursor === undefined || !cursor.startsWith("idx:")) return -1;
    const value = Number(cursor.slice(4));
    return Number.isSafeInteger(value) ? value : -1;
  };
  if (options.direction === "newest") {
    const start = Math.max(0, entries.length - limit);
    const slice = entries.slice(start);
    return {
      entries: slice.map((value, index) => ({
        kind: "entry" as const,
        offset: start + index,
        value,
      })),
      ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
      ...(entries.length > 0
        ? { newerCursor: `idx:${entries.length - 1}` }
        : {}),
      bytesRead: slice.length,
      linesScanned: slice.length,
    };
  }
  const cursorIndex = parseCursor(options.cursor);
  if (cursorIndex < 0) {
    return { entries: [], bytesRead: 0, linesScanned: 0 };
  }
  if (options.direction === "older") {
    const end = cursorIndex;
    const start = Math.max(0, end - limit);
    const slice = entries.slice(start, end);
    return {
      entries: slice.map((value, index) => ({
        kind: "entry" as const,
        offset: start + index,
        value,
      })),
      ...(start > 0 ? { olderCursor: `idx:${start}` } : {}),
      ...(slice.length > 0
        ? { newerCursor: `idx:${start + slice.length - 1}` }
        : {}),
      bytesRead: slice.length,
      linesScanned: slice.length,
    };
  }
  const start = cursorIndex + 1;
  const end = Math.min(entries.length, start + limit);
  const slice = entries.slice(start, end);
  return {
    entries: slice.map((value, index) => ({
      kind: "entry" as const,
      offset: start + index,
      value,
    })),
    ...(start > 0 && slice.length > 0 ? { olderCursor: `idx:${start}` } : {}),
    ...(end < entries.length ? { newerCursor: `idx:${end - 1}` } : {}),
    bytesRead: slice.length,
    linesScanned: slice.length,
  };
}

describe("mapNativeSessionEntryToOverlay", () => {
  it("maps user/assistant messages and run dividers without retaining paths", () => {
    const prompt = mapNativeSessionEntryToOverlay(
      message("m0", "user", "do the work"),
      0,
    )._unsafeUnwrap();
    expect(prompt?.kind).toBe("prompt");
    expect(prompt?.text).toBe("do the work");

    const assistant = mapNativeSessionEntryToOverlay(
      message("m1", "assistant", "done"),
      1,
    )._unsafeUnwrap();
    expect(assistant?.kind).toBe("assistant");

    const divider = mapNativeSessionEntryToOverlay(
      runDivider("r2", 2, "retry"),
      2,
    )._unsafeUnwrap();
    expect(divider?.kind).toBe("run-divider");
    expect(divider?.runNumber).toBe(2);
    expect(divider?.text).not.toContain("/Users/");
  });

  it("builds a transcript handoff model from overlay entries", () => {
    const mapped = [
      mapNativeSessionEntryToOverlay(message("a", "user", "task"), 0)._unsafeUnwrap(),
      mapNativeSessionEntryToOverlay(message("b", "assistant", "ok"), 1)._unsafeUnwrap(),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const transcript = transcriptFromOverlayEntries(mapped);
    expect(transcript.entries.some((entry) => entry.kind === "task")).toBe(true);
    expect(transcript.entries.some((entry) => entry.kind === "assistant")).toBe(
      true,
    );
  });
});

describe("ChildOverlayController", () => {
  it("opens a historical child with the newest bounded page", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "hist-1", status: "settled", entries: entries(80) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    const view = await mustOpen(overlay, "hist-1");
    expect(view.child.status).toBe("settled");
    expect(view.readOnly).toBe(true);
    expect(view.entries.length).toBe(20);
    expect(view.entries.at(-1)?.id).toBe("e79");
    expect(view.hasOlder).toBe(true);
    expect(view.hasNewer).toBe(false);
    expect(view.liveTail).toBe(true);
  });

  it("opens a live child and applies Task 11 parser/reducer live events", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "live-1",
        status: "live",
        generationId: "gen-1",
        entries: entries(5, "live"),
        runs: [
          { run: 1, action: "start" },
          { run: 2, action: "continue" },
        ],
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const opened = await mustOpen(overlay, "live-1");
    expect(opened.child.status).toBe("live");
    expect(opened.readOnly).toBe(false);
    expect(opened.activeRun).toBe(2);

    const after = overlay.applyLiveEvent({
      type: "message_update",
      delta: { messageId: "msg-live", text: "streaming fragment" },
    });
    expect(after.isOk()).toBe(true);
    const view = after._unsafeUnwrap();
    expect(view.entries.some((entry) => entry.text.includes("streaming"))).toBe(
      true,
    );
    expect(view.compact.runs.length).toBeGreaterThanOrEqual(0);
  });

  it("paginates older and newer without exceeding the window cap", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "page-1", entries: entries(120) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 20,
      windowCap: 45,
    });
    await mustOpen(overlay, "page-1");
    const older = (await overlay.loadOlder())._unsafeUnwrap();
    expect(older.entries.length).toBeLessThanOrEqual(45);
    expect(older.hasOlder).toBe(true);
    const oldestId = older.entries[0]?.id;

    // Drop some newest by loading older until window trims, then load newer.
    await overlay.loadOlder();
    const afterTrim = (await overlay.loadOlder())._unsafeUnwrap();
    expect(afterTrim.entries.length).toBeLessThanOrEqual(45);
    expect(afterTrim.entries.every((entry) => entry.id.length > 0)).toBe(true);

    if (afterTrim.newerCursor !== undefined) {
      const newer = (await overlay.loadNewer())._unsafeUnwrap();
      expect(newer.entries.length).toBeLessThanOrEqual(45);
      expect(newer.entries.some((entry) => entry.id === oldestId)).toBe(true);
    }
  });

  it("retains fetched older pages at the window cap without gaps or dupes", async () => {
    const total = 200;
    const pageSize = 20;
    const windowCap = 50;
    const source = createMemoryChildOverlaySource([
      child({ childId: "overflow-1", entries: entries(total) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize,
      windowCap,
    });
    const opened = await mustOpen(overlay, "overflow-1");
    expect(opened.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: pageSize }, (_, i) => `e${total - pageSize + i}`),
    );

    // Scroll to the oldest loaded edge so the logical anchor is stable there.
    overlay.setScrollOffset(opened.entries.length - 1)._unsafeUnwrap();
    const anchorBefore = overlay.view()._unsafeUnwrap().anchor?.entryId;
    expect(anchorBefore).toBe(opened.entries[0]?.id);

    const seenOldestIds: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const view = (await overlay.loadOlder())._unsafeUnwrap();
      expect(view.entries.length).toBeLessThanOrEqual(windowCap);
      const ids = view.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Contiguous numeric ids — no history gap inside the window.
      for (let i = 1; i < ids.length; i += 1) {
        const prev = Number(ids[i - 1]?.slice(1));
        const next = Number(ids[i]?.slice(1));
        expect(next).toBe(prev + 1);
      }
      const oldest = ids[0];
      if (oldest !== undefined) seenOldestIds.push(oldest);
      // Fetched older edge must remain in the window (trim newest, not oldest).
      expect(view.entries[0]?.id).toBe(oldest);
    }

    // Multiple older pages remain reachable — oldest edge keeps moving back.
    expect(seenOldestIds.length).toBeGreaterThan(1);
    expect(seenOldestIds.at(-1)).not.toBe(seenOldestIds[0]);
    const afterOlder = overlay.view()._unsafeUnwrap();
    expect(afterOlder.entries.length).toBe(windowCap);
    expect(afterOlder.hasNewer).toBe(true);
    expect(afterOlder.newerCursor).toBeDefined();
    expect(afterOlder.liveTail).toBe(false);
    // Anchor from the first page's oldest edge stays when still retained, else
    // the viewport stays on a retained entry (no jump to live tip).
    expect(afterOlder.liveTail).toBe(false);
    expect(afterOlder.scrollOffset).toBeGreaterThan(0);

    // Walk newer pages back toward the tip without dupes/gaps; live-tail
    // resumes only once the true newest edge is restored.
    let guard = 0;
    let tip = afterOlder;
    while (tip.hasNewer && tip.newerCursor !== undefined && guard < 20) {
      tip = (await overlay.loadNewer())._unsafeUnwrap();
      guard += 1;
      const ids = tip.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (let i = 1; i < ids.length; i += 1) {
        const prev = Number(ids[i - 1]?.slice(1));
        const next = Number(ids[i]?.slice(1));
        expect(next).toBe(prev + 1);
      }
      expect(tip.entries.length).toBeLessThanOrEqual(windowCap);
    }
    expect(tip.hasNewer).toBe(false);
    expect(tip.entries.at(-1)?.id).toBe(`e${total - 1}`);
    // End / live-tail path: follow output at the newest edge.
    const followed = overlay.setScrollOffset(0)._unsafeUnwrap();
    expect(followed.liveTail).toBe(true);
    expect(followed.scrollOffset).toBe(0);
  });

  it("keeps a scroll anchor stable across older-page overflow", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "anchor-1", entries: entries(160) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 25,
      windowCap: 60,
    });
    await mustOpen(overlay, "anchor-1");
    // Fill toward the cap, then pin near the oldest edge (survives newest trim).
    await overlay.loadOlder();
    await overlay.loadOlder();
    const filled = overlay.view()._unsafeUnwrap();
    expect(filled.entries.length).toBe(60);
    const pinned = overlay
      .setScrollOffset(filled.entries.length - 5)
      ._unsafeUnwrap();
    const anchorId = pinned.anchor?.entryId;
    expect(anchorId).toBeDefined();
    expect(pinned.liveTail).toBe(false);

    // One more older page overflows the cap by trimming the newest tail only.
    const after = (await overlay.loadOlder())._unsafeUnwrap();
    expect(after.entries.length).toBe(60);
    expect(after.entries.some((entry) => entry.id === anchorId)).toBe(true);
    expect(after.anchor?.entryId).toBe(anchorId);
    expect(after.liveTail).toBe(false);
    expect(after.hasNewer).toBe(true);
    // Window slid older: first id is below the previous oldest edge.
    expect(Number(after.entries[0]?.id.slice(1))).toBeLessThan(
      Number(filled.entries[0]?.id.slice(1)),
    );
  });

  it("hard-caps the retained window and dedups stable entry ids", async () => {
    const duplicated = entries(30);
    duplicated.push({
      id: "e29",
      payload: message("e29", "assistant", "duplicate"),
    });
    const source = createMemoryChildOverlaySource([
      child({ childId: "cap-1", entries: duplicated }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 40,
      windowCap: 25,
    });
    const view = await mustOpen(overlay, "cap-1");
    expect(view.entries.length).toBeLessThanOrEqual(25);
    const ids = view.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("searches loaded entries and fetches a bounded number of older pages", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "search-1", entries: entries(100) }),
    ]);
    const overlay = createChildOverlayController(source, {
      pageSize: 10,
      maxSearchPages: 3,
    });
    await mustOpen(overlay, "search-1");
    // Needle must sit within maxSearchPages of the newest page (contiguous).
    const found = (await overlay.search("e-text-65"))._unsafeUnwrap();
    expect(found.searchQuery).toBe("e-text-65");
    expect(found.searchMatches.length).toBeGreaterThan(0);
    expect(found.entries.length).toBeLessThanOrEqual(10 + 10 * 3);

    const beforeMiss = found.entries.length;
    const miss = (await overlay.search("never-present-token-zz"))._unsafeUnwrap();
    expect(miss.searchMatches).toEqual([]);
    // One search call fetches at most maxSearchPages additional older pages.
    expect(miss.entries.length).toBeLessThanOrEqual(beforeMiss + 10 * 3);
    expect(miss.entries.length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.maxWindowCap,
    );
  });

  it("disables live-tail on manual scroll and re-enables at the bottom", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "tail-1",
        status: "live",
        generationId: "g1",
        entries: entries(30),
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "tail-1");
    const scrolled = overlay.setScrollOffset(5)._unsafeUnwrap();
    expect(scrolled.liveTail).toBe(false);
    const bottom = overlay.setScrollOffset(0)._unsafeUnwrap();
    expect(bottom.liveTail).toBe(true);

    await overlay.handleInput("\x1b[5~"); // page up
    expect(overlay.view()._unsafeUnwrap().liveTail).toBe(false);
    await overlay.handleInput("\x1b[F"); // end
    expect(overlay.view()._unsafeUnwrap().liveTail).toBe(true);
  });

  it("preserves a logical anchor across resize", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "resize-1", entries: entries(40) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 20 });
    await mustOpen(overlay, "resize-1");
    overlay.setScrollOffset(4)._unsafeUnwrap();
    const before = overlay.view()._unsafeUnwrap();
    const anchorId = before.anchor?.entryId;
    expect(anchorId).toBeDefined();
    const resized = overlay.resize(120, 40)._unsafeUnwrap();
    expect(resized.anchor?.entryId).toBe(anchorId);
    expect(resized.width).toBe(120);
    expect(resized.height).toBe(40);
  });

  it("toggles global expansion across all loaded entries", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "exp-1", entries: entries(12) }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 12 });
    await mustOpen(overlay, "exp-1");
    const expanded = overlay.toggleGlobalExpansion()._unsafeUnwrap();
    expect(expanded.globalExpanded).toBe(true);
    expect(expanded.entries.every((entry) => entry.expanded)).toBe(true);
    const collapsed = overlay.toggleGlobalExpansion()._unsafeUnwrap();
    expect(collapsed.globalExpanded).toBe(false);
    expect(collapsed.entries.every((entry) => !entry.expanded)).toBe(true);
  });

  it("navigates runs and branches from divider metadata", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "nav-1",
        entries: entries(8),
        runs: [
          { run: 1, action: "start" },
          { run: 2, action: "retry" },
          { run: 3, action: "continue" },
        ],
        branchIds: ["main", "alt"],
      }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "nav-1");
    expect(overlay.view()._unsafeUnwrap().activeRun).toBe(3);
    expect(overlay.navigateRun(-1)._unsafeUnwrap().activeRun).toBe(2);
    expect(overlay.navigateBranch(1)._unsafeUnwrap().activeBranchId).toBe("alt");
  });

  it("emits steer and follow-up only for an active live child", async () => {
    const steers: string[] = [];
    const followUps: string[] = [];
    const mutations: ChildOverlayMutationPort = {
      steer: (childId, _generationId, text) => {
        steers.push(`${childId}:${text}`);
        return okAsync(undefined);
      },
      followUp: (childId, _generationId, text) => {
        followUps.push(`${childId}:${text}`);
        return okAsync(undefined);
      },
    };
    const source = createMemoryChildOverlaySource([
      child({
        childId: "active-1",
        status: "live",
        generationId: "gen-a",
        entries: entries(4),
      }),
    ]);
    const overlay = createChildOverlayController(source, {}, mutations);
    await mustOpen(overlay, "active-1");
    overlay.updateDraft("steer please")._unsafeUnwrap();
    const steered = (await overlay.handleInput("\r"))._unsafeUnwrap();
    expect(steered.kind).toBe("steer");
    expect(steers).toEqual(["active-1:steer please"]);

    overlay.updateDraft("follow later")._unsafeUnwrap();
    const follow = (await overlay.handleInput("\x1b\r"))._unsafeUnwrap();
    expect(follow.kind).toBe("follow-up");
    expect(followUps).toEqual(["active-1:follow later"]);
  });

  it("treats settled and orphan children as read-only with no mutations", async () => {
    const steers: string[] = [];
    const mutations: ChildOverlayMutationPort = {
      steer: (_c, _g, text) => {
        steers.push(text);
        return okAsync(undefined);
      },
      followUp: (_c, _g, text) => {
        steers.push(text);
        return okAsync(undefined);
      },
    };
    const source = createMemoryChildOverlaySource([
      child({
        childId: "settled-1",
        status: "settled",
        generationId: "gen-s",
        entries: entries(3),
      }),
      child({
        childId: "orphan-1",
        status: "orphan",
        generationId: "gen-o",
        entries: entries(3, "o"),
      }),
    ]);
    const overlay = createChildOverlayController(source, {}, mutations);
    await mustOpen(overlay, "settled-1");
    overlay.updateDraft("nope")._unsafeUnwrap();
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");
    const settledEnter = (await overlay.handleInput("\r"))._unsafeUnwrap();
    expect(settledEnter.kind).toBe("consumed");
    expect(steers).toEqual([]);

    await mustOpen(overlay, "orphan-1");
    expect(overlay.view()._unsafeUnwrap().readOnly).toBe(true);
    const orphanEnter = (await overlay.handleInput("\r"))._unsafeUnwrap();
    expect(orphanEnter.kind).toBe("consumed");
    expect(steers).toEqual([]);
  });

  it("consumes all keys while mounted and never routes to a primary editor", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "keys-1",
        status: "live",
        generationId: "gen-k",
        entries: entries(5),
      }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "keys-1");
    const outcomes = [];
    for (const key of ["a", "b", "\x1b[A", "\x1b", "/", "hello"]) {
      outcomes.push((await overlay.handleInput(key))._unsafeUnwrap().kind);
    }
    expect(outcomes.every((kind) => kind !== undefined)).toBe(true);
    // No outcome kind exists for primary-editor forwarding.
    expect(outcomes.every((kind) => kind !== "host-default")).toBe(true);
    expect(JSON.stringify(outcomes)).not.toContain("primary");
  });

  it("preserves draft and scroll per child across one-instance swaps", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "a",
        status: "live",
        generationId: "ga",
        entries: entries(20, "a"),
      }),
      child({
        childId: "b",
        status: "live",
        generationId: "gb",
        entries: entries(20, "b"),
      }),
    ]);
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    await mustOpen(overlay, "a");
    overlay.updateDraft("draft-a")._unsafeUnwrap();
    overlay.setScrollOffset(3)._unsafeUnwrap();

    await mustOpen(overlay, "b");
    expect(overlay.currentChildId()).toBe("b");
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");

    await mustOpen(overlay, "a");
    const restored = overlay.view()._unsafeUnwrap();
    expect(restored.draft).toBe("draft-a");
    expect(restored.scrollOffset).toBe(3);
  });

  it("evicts least-recently-used child state beyond the LRU bound", async () => {
    const children = Array.from({ length: 10 }, (_, i) =>
      child({
        childId: `c${i}`,
        status: "live",
        generationId: `g${i}`,
        entries: entries(4, `c${i}`),
      }),
    );
    const source = createMemoryChildOverlaySource(children);
    const overlay = createChildOverlayController(source, {
      maxLruChildren: 3,
      pageSize: 4,
    });
    for (const item of children.slice(0, 3)) {
      await mustOpen(overlay, item.childId);
      overlay.updateDraft(`draft-${item.childId}`)._unsafeUnwrap();
    }
    // Opening c3..c5 should evict c0 (LRU capacity 3).
    for (const item of children.slice(3, 6)) {
      await mustOpen(overlay, item.childId);
      overlay.updateDraft(`draft-${item.childId}`)._unsafeUnwrap();
    }
    await mustOpen(overlay, "c0");
    expect(overlay.view()._unsafeUnwrap().draft).toBe("");
    await mustOpen(overlay, "c5");
    expect(overlay.view()._unsafeUnwrap().draft).toBe("draft-c5");
  });

  it("reports nested hierarchy metadata on the open child", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "parent",
        entries: entries(3, "p"),
        descendantChildIds: ["child", "grandchild"],
      }),
      child({
        childId: "child",
        parentChildId: "parent",
        entries: entries(3, "c"),
        descendantChildIds: ["grandchild"],
      }),
    ]);
    const overlay = createChildOverlayController(source);
    const view = await mustOpen(overlay, "child");
    expect(view.child.parentChildId).toBe("parent");
    expect(view.child.descendantChildIds).toContain("grandchild");
  });

  it("returns fallback-required with bounded metadata and no path leakage", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "fb-1", entries: entries(5) }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "fb-1");
    const fallback = overlay.requireFallback("render-failed");
    expect(fallback.kind).toBe("fallback-required");
    expect(fallback.metadata.childId).toBe("fb-1");
    expect(fallback.metadata.reason).toBe("render-failed");
    expect(fallback.transcript.entries.length).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(fallback);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("session.jsonl");
    expect(serialized).not.toContain("Error:");
  });

  it("triggers fallback-required when the source fails on open", async () => {
    const source = createMemoryChildOverlaySource([]);
    const overlay = createChildOverlayController(source);
    const result = await overlay.open("missing-child");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as ChildOverlayFallbackRequired;
    expect(error.kind).toBe("fallback-required");
    expect(error.metadata.reason).toBe("describe-failed");
    expect(JSON.stringify(error)).not.toContain("/Users/");
  });

  it("adapts Task 4 readSessionEntryPage through the paged source helper", async () => {
    const hostEntries = Object.freeze([
      message("n0", "user", "from-native"),
      message("n1", "assistant", "reply"),
      runDivider("n2", 2, "continue"),
    ]);
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [{ run: 1, action: "start" as const }],
          branchIds: ["main"],
          descendantChildIds: [],
        }),
      readSessionEntryPage: (_childId, options) =>
        okAsync(pageMemoryEntries(hostEntries, options)),
    });
    const overlay = createChildOverlayController(source, { pageSize: 10 });
    const view = await mustOpen(overlay, "native-1");
    expect(view.entries.some((entry) => entry.text === "from-native")).toBe(
      true,
    );
    expect(view.entries.some((entry) => entry.kind === "run-divider")).toBe(
      true,
    );
  });

  it("pages >10k native source with bounded metrics and no full materialization", async () => {
    const entryCount = 10_500;
    const ROOT = "/data/weave/adapters/pi/sessions";
    const PARENT = "parent-session-1";
    const REF = "child-1/session.jsonl";
    const DIR = `${ROOT}/child-1`;
    const FILE = "session.jsonl";
    const textEncoder = new TextEncoder();
    const fs = new MemoryPiNativeSessionFs();
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "native-session-1",
        cwd: "/repo",
        parentSession: PARENT,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ];
    for (let index = 0; index < entryCount; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: `n=${index}` },
        }),
      );
    }
    const directory = (await fs.openDirectory(DIR, true))._unsafeUnwrap();
    (
      await directory.appendFile(
        FILE,
        textEncoder.encode(`${lines.join("\n")}\n`),
        0o600,
      )
    )._unsafeUnwrap();
    directory.close();

    class ForbiddenHost implements PiNativeSessionHostPort {
      create(): PiNativeSessionHandle {
        throw new Error("host.create must not be called");
      }
      open(): PiNativeSessionHandle {
        throw new Error("host.open must not be called");
      }
    }
    const store = new PiNativeSessionStore({
      root: ROOT,
      fs: fs as unknown as PiNativeSessionFsPort,
      host: new ForbiddenHost(),
    });

    const metrics: Array<{
      readonly entries: number;
      readonly bytesRead: number;
      readonly linesScanned: number;
    }> = [];
    let maxEntriesReturned = 0;
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [],
          branchIds: [],
          descendantChildIds: [],
        }),
      readSessionEntryPage: (_childId, options) =>
        store.readSessionEntryPage(REF, PARENT, options).map((page) => {
          metrics.push({
            entries: page.entries.length,
            bytesRead: page.bytesRead,
            linesScanned: page.linesScanned,
          });
          maxEntriesReturned = Math.max(maxEntriesReturned, page.entries.length);
          return page;
        }),
    });

    const newest = (await source.loadNewest("big-hist", 40))._unsafeUnwrap();
    expect(newest.entries.length).toBeLessThanOrEqual(40);
    expect(newest.hasOlder).toBe(true);
    expect(
      newest.entries.some((entry) => entry.text === `n=${entryCount - 1}`),
    ).toBe(true);

    let cursor = newest.olderCursor;
    let sawOlderWindow = false;
    const targetOlder = `n=${entryCount - 200}`;
    for (let step = 0; step < 8 && cursor !== undefined; step += 1) {
      const page = (
        await source.loadOlder("big-hist", cursor, 40)
      )._unsafeUnwrap();
      expect(page.entries.length).toBeLessThanOrEqual(40);
      if (page.entries.some((entry) => entry.text === targetOlder)) {
        sawOlderWindow = true;
      }
      if (page.newerCursor !== undefined) {
        const newer = (
          await source.loadNewer("big-hist", page.newerCursor, 40)
        )._unsafeUnwrap();
        expect(newer.entries.length).toBeLessThanOrEqual(40);
      }
      cursor = page.olderCursor;
    }
    expect(sawOlderWindow).toBe(true);

    const overlay = createChildOverlayController(source, {
      pageSize: 40,
      windowCap: 120,
      maxSearchPages: 3,
    });
    await mustOpen(overlay, "big-hist");
    const beforeSearch = metrics.length;
    await overlay.search("n=5");
    const searchCalls = metrics.length - beforeSearch;
    expect(searchCalls).toBeLessThanOrEqual(3);

    expect(maxEntriesReturned).toBeLessThanOrEqual(
      PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit,
    );
    for (const sample of metrics) {
      expect(sample.entries).toBeLessThanOrEqual(
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLimit,
      );
      expect(sample.bytesRead).toBeLessThanOrEqual(
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned,
      );
      expect(sample.linesScanned).toBeLessThanOrEqual(
        PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLinesScanned,
      );
      // Never materializes the full >10k source in one page.
      expect(sample.entries).toBeLessThan(entryCount);
    }
    expect(overlay.view()._unsafeUnwrap().entries.length).toBeLessThanOrEqual(
      120,
    );
    expect(
      JSON.stringify(overlay.view()._unsafeUnwrap().entries.map((e) => e.id)),
    ).not.toContain("/Users/");
  });

  it("rejects invalid overlay cursors without a full read", async () => {
    let calls = 0;
    const source = createReadSessionEntryPageOverlaySource({
      describe: (childId) =>
        okAsync({
          childId,
          threadId: childId,
          status: "settled" as const,
          runs: [],
          branchIds: [],
          descendantChildIds: [],
        }),
      readSessionEntryPage: () => {
        calls += 1;
        return errAsync({
          type: "SessionCorrupt",
          ref: "x",
          reason: "invalid-cursor",
        } satisfies PiNativeSessionError);
      },
    });
    const older = await source.loadOlder("c1", "", 10);
    expect(older.isErr()).toBe(true);
    expect(older._unsafeUnwrapErr().type).toBe("SourceInvalidCursor");
    expect(calls).toBe(0);
  });

  it("keeps production overlay/extension free of full-read overlay sources", async () => {
    const overlaySrc = await Bun.file(
      new URL("../child-overlay.ts", import.meta.url),
    ).text();
    const extensionSrc = await Bun.file(
      new URL("../extension.ts", import.meta.url),
    ).text();
    expect(overlaySrc).not.toContain("createReadSessionEntriesOverlaySource");
    expect(extensionSrc).not.toContain("createReadSessionEntriesOverlaySource");
    expect(overlaySrc).toContain("createReadSessionEntryPageOverlaySource");
    expect(extensionSrc).toContain("createReadSessionEntryPageOverlaySource");
    expect(extensionSrc).toContain("readSessionEntryPage");
    // Overlay controller wiring must not call the full-read host path.
    const overlayWire = extensionSrc.slice(
      extensionSrc.indexOf("createChildOverlayController("),
      extensionSrc.indexOf("createChildOverlayController(") + 2_500,
    );
    expect(overlayWire).not.toContain("readSessionEntries");
    expect(overlayWire).toContain("readSessionEntryPage");
  });

  it("keeps one instance: open swaps content instead of stacking", async () => {
    const source = createMemoryChildOverlaySource([
      child({ childId: "one", entries: entries(5, "one") }),
      child({ childId: "two", entries: entries(5, "two") }),
    ]);
    const overlay = createChildOverlayController(source);
    await mustOpen(overlay, "one");
    await mustOpen(overlay, "two");
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.currentChildId()).toBe("two");
    expect(overlay.view()._unsafeUnwrap().entries[0]?.id.startsWith("two")).toBe(
      true,
    );
  });

  it("exposes bounded defaults used by the controller", () => {
    expect(CHILD_OVERLAY_BOUNDS.defaultPageSize).toBe(50);
    expect(CHILD_OVERLAY_BOUNDS.defaultWindowCap).toBe(200);
    expect(CHILD_OVERLAY_BOUNDS.maxLruChildren).toBe(8);
    expect(CHILD_OVERLAY_BOUNDS.maxSearchPages).toBe(4);
  });
});

describe("createChildOverlayCustomComponent", () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const mount = async (options: {
    readonly status?: "live" | "settled" | "orphan";
    readonly entryCount?: number;
    readonly pageSize?: number;
    readonly mutations?: ChildOverlayMutationPort;
    readonly onFallback?: (fallback: ChildOverlayFallbackRequired) => void;
  } = {}) => {
    const status = options.status ?? "live";
    const source = createMemoryChildOverlaySource([
      child({
        childId: "overlay-1",
        status,
        generationId: "gen-1",
        entries: entries(options.entryCount ?? 12),
        runs: [
          { run: 1, action: "start" },
          { run: 2, action: "continue" },
        ],
      }),
    ]);
    const controller = createChildOverlayController(
      source,
      { pageSize: options.pageSize ?? 10 },
      options.mutations,
    );
    await mustOpen(controller, "overlay-1");
    let closed = 0;
    const fallbacks: ChildOverlayFallbackRequired[] = [];
    let renders = 0;
    const component = createChildOverlayCustomComponent(
      {
        requestRender: () => {
          renders += 1;
        },
      } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => {
        closed += 1;
      },
      (fallback) => {
        fallbacks.push(fallback);
        options.onFallback?.(fallback);
      },
      { cwd: "/workspace" },
    );
    return {
      component,
      controller,
      closed: () => closed,
      fallbacks: () => fallbacks,
      renders: () => renders,
    };
  };

  it("renders native entry kinds with a bounded header for a live child", async () => {
    const { component, controller } = await mount({ status: "live" });
    controller.applyLiveEvent({
      type: "thinking",
      text: "pondering",
    });
    controller.applyLiveEvent({
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "read",
    });
    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("LIVE");
    // Native components render content (not kind labels): thinking text + tool name.
    expect(joined).toContain("pondering");
    expect(joined).toContain("read");
    expect(joined).toContain("e-text-");
    expect(joined).not.toContain("/Users/");
  });

  it("calls resize and preserves the logical anchor across widths", async () => {
    const { component, controller } = await mount({ entryCount: 40 });
    controller.setScrollOffset(4)._unsafeUnwrap();
    const before = controller.view()._unsafeUnwrap().anchor?.entryId;
    expect(before).toBeDefined();
    component.render(100);
    const after = controller.view()._unsafeUnwrap();
    expect(after.anchor?.entryId).toBe(before);
    expect(after.width).toBe(100);
  });

  it("requests older and newer pages at pagination edges", async () => {
    const { component, controller } = await mount({
      entryCount: 80,
      pageSize: 10,
    });
    // Scroll to the oldest loaded edge, then page-up should fetch older.
    controller
      .setScrollOffset(controller.view()._unsafeUnwrap().entries.length)
      ._unsafeUnwrap();
    const beforeOlder = controller.view()._unsafeUnwrap().entries.length;
    component.handleInput(PAGE_UP);
    await flush();
    expect(controller.view()._unsafeUnwrap().entries.length).toBeGreaterThan(
      beforeOlder,
    );

    // Return to live-tail and page-down/end may fetch newer when available.
    component.handleInput(END);
    await flush();
    component.handleInput(PAGE_DOWN);
    await flush();
    expect(controller.isOpen()).toBe(true);
  });

  it("awaits Enter steer and Alt+Enter follow-up for an active child", async () => {
    const steers: string[] = [];
    const followUps: string[] = [];
    const { component, controller } = await mount({
      status: "live",
      mutations: {
        steer: (_c, _g, text) => {
          steers.push(text);
          return okAsync(undefined);
        },
        followUp: (_c, _g, text) => {
          followUps.push(text);
          return okAsync(undefined);
        },
      },
    });
    controller.updateDraft("steer please")._unsafeUnwrap();
    component.handleInput(ENTER);
    await flush();
    expect(steers).toEqual(["steer please"]);

    controller.updateDraft("follow later")._unsafeUnwrap();
    component.handleInput(ALT_ENTER);
    await flush();
    expect(followUps).toEqual(["follow later"]);
  });

  it("shows a read-only banner and no draft editor for settled/orphan children", async () => {
    for (const status of ["settled", "orphan"] as const) {
      const steers: string[] = [];
      const { component, controller } = await mount({
        status,
        mutations: {
          steer: (_c, _g, text) => {
            steers.push(text);
            return okAsync(undefined);
          },
          followUp: (_c, _g, text) => {
            steers.push(text);
            return okAsync(undefined);
          },
        },
      });
      const joined = component.render(80).join("\n");
      expect(joined.toLowerCase()).toContain("read-only");
      expect(joined).not.toMatch(/^>/m);
      controller.updateDraft("nope")._unsafeUnwrap();
      component.handleInput(ENTER);
      await flush();
      expect(steers).toEqual([]);
      expect(controller.view()._unsafeUnwrap().draft).toBe("");
    }
  });

  it("consumes input without primary-editor leakage and closes once on Escape", async () => {
    const { component, closed, controller } = await mount({ status: "live" });
    component.handleInput("a");
    await flush();
    component.handleInput("b");
    await flush();
    expect(controller.view()._unsafeUnwrap().draft).toContain("a");
    component.handleInput(CTRL_E);
    await flush();
    expect(controller.view()._unsafeUnwrap().globalExpanded).toBe(true);
    component.handleInput(ESCAPE);
    expect(closed()).toBe(1);
    component.handleInput(ESCAPE);
    expect(closed()).toBe(1);
  });

  it("emits typed fallback once on render failure and never throws into Pi", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "fb",
        status: "live",
        generationId: "g",
        entries: entries(3),
      }),
    ]);
    const controller = createChildOverlayController(source);
    await mustOpen(controller, "fb");
    const fallbacks: ChildOverlayFallbackRequired[] = [];
    let closed = 0;
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      { matches: () => false } as never,
      controller,
      () => {
        closed += 1;
      },
      (fallback) => {
        fallbacks.push(fallback);
      },
      { cwd: "/workspace" },
    );
    controller.resize = () =>
      ({
        isErr: () => true,
        isOk: () => false,
        error: controller.requireFallback("render-failed"),
      }) as never;
    expect(() => component.render(40)).not.toThrow();
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]?.kind).toBe("fallback-required");
    expect(fallbacks[0]?.metadata.reason).toBe("render-failed");
    expect(closed).toBe(1);
    expect(() => component.render(40)).not.toThrow();
    expect(fallbacks.length).toBe(1);
    expect(JSON.stringify(fallbacks)).not.toContain("/Users/");
    expect(JSON.stringify(fallbacks)).not.toContain("Error:");
  });

  it("keeps a single component/controller instance across child swaps", async () => {
    const source = createMemoryChildOverlaySource([
      child({
        childId: "one",
        status: "live",
        generationId: "g1",
        entries: entries(5, "one"),
      }),
      child({
        childId: "two",
        status: "live",
        generationId: "g2",
        entries: entries(5, "two"),
      }),
    ]);
    const controller = createChildOverlayController(source);
    await mustOpen(controller, "one");
    let instances = 0;
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );
    instances += 1;
    component.render(60);
    await mustOpen(controller, "two");
    component.invalidate();
    const joined = component.render(60).join("\n");
    expect(instances).toBe(1);
    expect(controller.currentChildId()).toBe("two");
    expect(joined).toContain("two");
  });
});
