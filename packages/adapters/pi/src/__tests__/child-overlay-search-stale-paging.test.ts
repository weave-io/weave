/**
 * A committed search that the reader has already replaced may not rewrite the
 * inspector when its page finally arrives.
 *
 * Committing a query starts BOUNDED HISTORICAL PAGING: one older page per
 * step, each one a real native session read. A reader does not wait for it.
 * They edit the query, re-open search, or walk to another child while the
 * first page is still in flight, and the answer to the query they abandoned
 * lands afterwards — into whatever is on screen by then.
 *
 * Every step of that late answer is a mutation: it prepends a page to the
 * window, it restores the viewport around the entries it prepended, it merges
 * its match ids into the counter the rail prints, it returns a child, and a
 * failed read collapses the whole inspector into the custom-editor fallback.
 * None of that belongs to the query the reader is now looking at.
 *
 * These cases drive the real mounted component over the production
 * `readSessionEntryPage` overlay source, with the first older page BLOCKED, and
 * assert on the rendered rail plus the controller view the rail is drawn from.
 */
import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { okAsync, ResultAsync } from "neverthrow";
import type {
  PiNativeSessionEntryPage,
  PiNativeSessionEntryPageOptions,
} from "../child-native-sessions.js";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createReadSessionEntryPageOverlaySource,
} from "../child-overlay.js";
import type {
  ChildOverlayChild,
  ChildOverlayFallbackRequired,
} from "../child-overlay-types.js";

initTheme("default");

const CHILD_ONE = "5b1d9d5e-1f2f-4a63-9a2e-2f1a4c6d8e01";
const CHILD_TWO = "5b1d9d5e-1f2f-4a63-9a2e-2f1a4c6d8e02";

/** The pane is rendered wide enough for the rail to take its own column. */
const WIDTH = 200;

/** Raw byte Pi delivers for the `Ctrl+F` search alias. */
const SEARCH_ALIAS = "\x06";

/** The query committed first, and then abandoned. */
const LOST_QUERY = "ALPHASTALE";

/** The query the reader actually ends up looking at. */
const LIVE_QUERY = "BRAVOFRESH";

/** Entry id of the abandoned query's older page: the identity to look for. */
const STALE_ENTRY_ID = "olderstale1";

/** Text only the abandoned query's older page carries. */
const STALE_ROW = "STALEONLYROW";

/** Text only the live query's own older page carries. */
const LIVE_OLDER_ROW = "FRESHOLDERROW";

/**
 * One real Pi 0.84.2 session message, in the shape the host writes it.
 */
const message = (
  id: string,
  parentId: string,
  role: "user" | "assistant",
  text: string,
): unknown => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-08-18T07:06:54.769Z",
  message: {
    role,
    content: [{ type: "text", text }],
    timestamp: 1_787_036_814_768,
  },
});

const NEWEST_ONE: readonly unknown[] = [
  message(
    "newest1",
    "root",
    "user",
    `Look for ${LOST_QUERY} and then for ${LIVE_QUERY}.`,
  ),
  message("newest2", "newest1", "assistant", `Reply naming ${LIVE_QUERY}.`),
];

const NEWEST_TWO: readonly unknown[] = [
  message("twonewest1", "root", "user", "A different child, different work."),
];

/** Id of the ONLY entry the abandoned query matches in the tall transcript. */
const TALL_MATCH_ID = "tallmatch";

/**
 * A newest page too tall for one viewport, whose only match is its OLDEST
 * entry.
 *
 * A short transcript cannot prove anything about the viewport: it fits, so the
 * scroll extent is zero and every jump clamps back to the tail whether the
 * surface asked for one or not. Here the reader sits at the live tail while
 * the one match sits at the far end of the window, so a jump the reader did
 * not ask for is a visible move rather than a no-op.
 */
const TALL_NEWEST_ONE: readonly unknown[] = [
  message(TALL_MATCH_ID, "root", "user", `Look for ${LOST_QUERY} up here.`),
  ...Array.from({ length: 30 }, (_unused, index) =>
    message(
      `tallfill${index}`,
      index === 0 ? TALL_MATCH_ID : `tallfill${index - 1}`,
      index % 2 === 0 ? "assistant" : "user",
      `Filler row ${index}: ordinary transcript text.`,
    ),
  ),
];

/** The page the ABANDONED query is still waiting for when it is replaced. */
const OLDER_STALE: readonly unknown[] = [
  message(
    STALE_ENTRY_ID,
    "root",
    "user",
    `${STALE_ROW} ${LOST_QUERY} older history.`,
  ),
];

/** The page the LIVE query fetches for itself. */
const OLDER_LIVE: readonly unknown[] = [
  message(
    "olderlive1",
    "root",
    "assistant",
    `${LIVE_OLDER_ROW} ${LIVE_QUERY} older history.`,
  ),
];

const pageOf = (
  entries: readonly unknown[],
  olderCursor: string | undefined,
): PiNativeSessionEntryPage => ({
  entries: entries.map((value, offset) => ({
    kind: "entry" as const,
    offset,
    value,
  })),
  ...(olderCursor === undefined ? {} : { olderCursor }),
  bytesRead: 0,
  linesScanned: entries.length,
});

const describedChild = (childId: string): ChildOverlayChild =>
  ({
    childId,
    threadId: childId,
    status: "settled",
    outcome: "completed" as const,
    generationId: "gen-1",
    runs: [{ run: 1, action: "start" as const }],
    branchIds: ["main"],
    descendantChildIds: [],
    agentName: "shuttle-tests",
  }) as ChildOverlayChild;

interface StaleSearchHarness {
  readonly controller: ReturnType<typeof createChildOverlayController>;
  readonly component: ReturnType<typeof createChildOverlayCustomComponent>;
  readonly fallbacks: readonly ChildOverlayFallbackRequired[];
  readonly olderReads: () => number;
  /** Answers the first, blocked older read: the abandoned query's page. */
  readonly releaseBlockedOlderPage: () => void;
}

/**
 * The production source with ONE blocked older read.
 *
 * The first `direction: "older"` request — the one the first committed query
 * makes — is held open until the test releases it. Every later older request
 * is answered at once, so the query the reader ends up on completes its own
 * bounded paging normally while the abandoned one is still in flight.
 */
async function openedHarness(
  options: { readonly tall?: boolean } = {},
): Promise<StaleSearchHarness> {
  const pending: ((page: PiNativeSessionEntryPage) => void)[] = [];
  let olderReads = 0;
  const newestByChild = new Map<string, readonly unknown[]>([
    [CHILD_ONE, options.tall === true ? TALL_NEWEST_ONE : NEWEST_ONE],
    [CHILD_TWO, NEWEST_TWO],
  ]);
  const source = createReadSessionEntryPageOverlaySource({
    describe: (childId: string) => okAsync(describedChild(childId)),
    readSessionEntryPage: (
      childId: string,
      options: PiNativeSessionEntryPageOptions,
    ) => {
      if (options.direction !== "older") {
        return okAsync<PiNativeSessionEntryPage, never>(
          pageOf(
            newestByChild.get(childId) ?? NEWEST_ONE,
            childId === CHILD_ONE ? "cursor-older-1" : undefined,
          ),
        );
      }
      olderReads += 1;
      if (olderReads === 1) {
        return ResultAsync.fromSafePromise(
          new Promise<PiNativeSessionEntryPage>((resolve) => {
            pending.push(resolve);
          }),
        );
      }
      return okAsync<PiNativeSessionEntryPage, never>(
        pageOf(OLDER_LIVE, undefined),
      );
    },
  });

  const controller = createChildOverlayController(source);
  (await controller.open(CHILD_ONE))._unsafeUnwrap();
  const fallbacks: ChildOverlayFallbackRequired[] = [];
  const component = createChildOverlayCustomComponent(
    { requestRender: () => undefined } as never,
    {} as never,
    getKeybindings() as never,
    controller,
    () => undefined,
    (fallback) => {
      fallbacks.push(fallback);
    },
    { cwd: "/workspace" },
  );
  return {
    controller,
    component,
    fallbacks,
    olderReads: () => olderReads,
    releaseBlockedOlderPage: () => {
      for (const resolve of pending.splice(0)) {
        resolve(pageOf(OLDER_STALE, undefined));
      }
    },
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips real ANSI.
const ANSI = /\x1b\[[0-9;]*m/gu;
const plainRows = (rows: readonly string[]): string =>
  rows.map((row) => row.replace(ANSI, "")).join("\n");

const counterOf = (rail: string): string =>
  /match {4}(\d+\/\d+)/u.exec(rail)?.[1] ?? "absent";

const typeInto = (
  component: StaleSearchHarness["component"],
  text: string,
): void => {
  for (const character of text) component.handleInput(character);
};

/** Drains every microtask the controller's page chain schedules. */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe("a superseded committed search is a no-op", () => {
  it("cannot rewrite the rail after the query was replaced with Ctrl+F", async () => {
    const harness = await openedHarness();
    const { component, controller } = harness;
    component.render(WIDTH);

    // The reader commits one query; its first older page never arrives.
    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // `Ctrl+F` edits the committed query, and a different one is committed.
    component.handleInput(SEARCH_ALIAS);
    typeInto(component, "\x7f".repeat(LOST_QUERY.length));
    typeInto(component, `${LIVE_QUERY}\r`);
    await settle();

    const before = plainRows(component.render(WIDTH));
    const beforeView = controller.view()._unsafeUnwrap();
    expect(before).toContain(`query    ${LIVE_QUERY}`);
    // The live query DID complete its own bounded paging.
    expect(before).toContain(LIVE_OLDER_ROW);
    expect(harness.olderReads()).toBe(2);

    // The abandoned query's page finally arrives.
    harness.releaseBlockedOlderPage();
    await settle();

    const after = plainRows(component.render(WIDTH));
    const afterView = controller.view()._unsafeUnwrap();

    // The rail still describes the query the reader is looking at.
    expect(after).toContain(`query    ${LIVE_QUERY}`);
    expect(afterView.searchQuery).toBe(LIVE_QUERY);
    expect(counterOf(after)).toBe(counterOf(before));

    // No identity from the abandoned page reached the window, the match list,
    // or the screen.
    expect(afterView.searchMatches).toEqual(beforeView.searchMatches);
    expect(afterView.searchMatches).not.toContain(STALE_ENTRY_ID);
    expect(afterView.entries.map((entry) => entry.id)).not.toContain(
      STALE_ENTRY_ID,
    );
    expect(after).not.toContain(STALE_ROW);

    // The child on screen and the reader's viewport are untouched.
    expect(controller.currentChildId()).toBe(CHILD_ONE);
    expect(afterView.scrollOffset).toBe(beforeView.scrollOffset);
    expect(harness.fallbacks).toHaveLength(0);
  });

  it("cannot page into the child the reader walked to", async () => {
    const harness = await openedHarness();
    const { component, controller } = harness;
    component.render(WIDTH);

    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // The reader walks to another child while that page is in flight.
    (await controller.open(CHILD_TWO))._unsafeUnwrap();
    component.render(WIDTH);
    const beforeTwo = controller.view()._unsafeUnwrap();

    harness.releaseBlockedOlderPage();
    await settle();

    component.render(WIDTH);
    const afterTwo = controller.view()._unsafeUnwrap();
    expect(controller.currentChildId()).toBe(CHILD_TWO);
    expect(afterTwo.entries.map((entry) => entry.id)).toEqual(
      beforeTwo.entries.map((entry) => entry.id),
    );
    expect(afterTwo.scrollOffset).toBe(beforeTwo.scrollOffset);
    expect(harness.fallbacks).toHaveLength(0);

    // The child the reader LEFT is untouched too: a late page may not edit a
    // saved window nobody is looking at.
    const reopened = (await controller.open(CHILD_ONE))._unsafeUnwrap();
    expect(reopened.entries.map((entry) => entry.id)).not.toContain(
      STALE_ENTRY_ID,
    );
    expect(reopened.searchMatches).not.toContain(STALE_ENTRY_ID);
  });

  it("cannot write into a window the reader closed", async () => {
    const harness = await openedHarness();
    const { component, controller } = harness;
    component.render(WIDTH);

    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // The reader closes the inspector while that page is in flight.
    controller.close()._unsafeUnwrap();
    harness.releaseBlockedOlderPage();
    await settle();

    expect(controller.isOpen()).toBe(false);
    expect(harness.fallbacks).toHaveLength(0);

    // Re-opening shows the window as the reader left it.
    const reopened = (await controller.open(CHILD_ONE))._unsafeUnwrap();
    expect(reopened.entries.map((entry) => entry.id)).not.toContain(
      STALE_ENTRY_ID,
    );
    expect(reopened.searchMatches).not.toContain(STALE_ENTRY_ID);
  });

  it("cannot rewrite a search that was closed and reopened", async () => {
    const harness = await openedHarness();
    const { component, controller } = harness;
    component.render(WIDTH);

    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // Escape closes search only; `/` opens a fresh one and commits a new query.
    component.handleInput("\x1b");
    component.render(WIDTH);
    typeInto(component, `/${LIVE_QUERY}\r`);
    await settle();

    const before = plainRows(component.render(WIDTH));
    const beforeView = controller.view()._unsafeUnwrap();
    expect(before).toContain(`query    ${LIVE_QUERY}`);
    expect(harness.olderReads()).toBe(2);

    harness.releaseBlockedOlderPage();
    await settle();

    const after = plainRows(component.render(WIDTH));
    const afterView = controller.view()._unsafeUnwrap();
    expect(after).toContain(`query    ${LIVE_QUERY}`);
    expect(counterOf(after)).toBe(counterOf(before));
    expect(afterView.searchMatches).toEqual(beforeView.searchMatches);
    expect(afterView.searchMatches).not.toContain(STALE_ENTRY_ID);
    expect(after).not.toContain(STALE_ROW);
    expect(afterView.scrollOffset).toBe(beforeView.scrollOffset);
    expect(controller.currentChildId()).toBe(CHILD_ONE);
    expect(harness.fallbacks).toHaveLength(0);
  });

  it("cannot rewrite the rail after Ctrl+F re-opened its own query", async () => {
    const harness = await openedHarness();
    const { component, controller } = harness;
    component.render(WIDTH);

    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // `Ctrl+F` re-opens the SAME committed query for editing, and then the
    // reader pauses. Nothing is typed, nothing is committed, no child is
    // walked to and the overlay stays open: the re-open itself is the whole
    // event, and the page lands in the pause after it.
    component.handleInput(SEARCH_ALIAS);

    const before = plainRows(component.render(WIDTH));
    const beforeView = controller.view()._unsafeUnwrap();
    expect(before).toContain(`query    ${LOST_QUERY}`);
    expect(beforeView.searchMatches.length).toBeGreaterThan(0);

    harness.releaseBlockedOlderPage();
    await settle();

    const after = plainRows(component.render(WIDTH));
    const afterView = controller.view()._unsafeUnwrap();

    // Nothing from the released page reached the window, the counter, the
    // screen or the viewport.
    expect(afterView.entries.map((entry) => entry.id)).toEqual(
      beforeView.entries.map((entry) => entry.id),
    );
    expect(afterView.searchMatches).toEqual(beforeView.searchMatches);
    expect(afterView.searchMatches).not.toContain(STALE_ENTRY_ID);
    expect(counterOf(after)).toBe(counterOf(before));
    expect(after).not.toContain(STALE_ROW);
    expect(afterView.scrollOffset).toBe(beforeView.scrollOffset);
    expect(controller.currentChildId()).toBe(CHILD_ONE);
    expect(harness.fallbacks).toHaveLength(0);
    // The re-open reads nothing: editing a committed query is window-only.
    expect(harness.olderReads()).toBe(1);
  });

  it("cannot jump the viewport after the same child was re-opened", async () => {
    const harness = await openedHarness({ tall: true });
    const { component, controller } = harness;
    component.render(WIDTH);

    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // The reader closes the inspector and re-opens THE SAME child. Every fact
    // the surface owns is unchanged by that — same child id, same committed
    // query, no key pressed — and yet it is a different reading, so the page
    // still in flight is answering a question nobody is asking.
    controller.close()._unsafeUnwrap();
    (await controller.open(CHILD_ONE))._unsafeUnwrap();
    component.render(WIDTH);

    const beforeView = controller.view()._unsafeUnwrap();
    // The jump this test forbids is a jump that COULD happen: the reader is at
    // the live tail, the transcript is taller than the viewport, and the only
    // match sits at its oldest end.
    expect(beforeView.scrollOffset).toBe(0);
    expect(beforeView.scrollExtent).toBeGreaterThan(0);
    expect(beforeView.searchMatches).toEqual([TALL_MATCH_ID]);

    harness.releaseBlockedOlderPage();
    await settle();

    component.render(WIDTH);
    const afterView = controller.view()._unsafeUnwrap();
    expect(afterView.scrollOffset).toBe(beforeView.scrollOffset);
    expect(afterView.liveTail).toBe(beforeView.liveTail);
    expect(afterView.entries.map((entry) => entry.id)).toEqual(
      beforeView.entries.map((entry) => entry.id),
    );
    expect(afterView.searchMatches).toEqual(beforeView.searchMatches);
    expect(afterView.searchMatches).not.toContain(STALE_ENTRY_ID);
    expect(harness.fallbacks).toHaveLength(0);
  });

  it("frees the surface when the current run settles, pending read or not", async () => {
    const harness = await openedHarness();
    const { component, controller } = harness;
    component.render(WIDTH);

    // The abandoned query's page NEVER arrives: a committed page read has no
    // timeout, so its promise simply stays pending.
    typeInto(component, `/${LOST_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(1);

    // The query the reader is actually waiting on completes its own paging.
    component.handleInput(SEARCH_ALIAS);
    typeInto(component, "\x7f".repeat(LOST_QUERY.length));
    typeInto(component, `${LIVE_QUERY}\r`);
    await settle();
    expect(harness.olderReads()).toBe(2);
    expect(controller.view()._unsafeUnwrap().searchQuery).toBe(LIVE_QUERY);

    // Escape leaves search; the overlay and the child stay exactly as they are.
    component.handleInput("\x1b");
    await settle();
    expect(controller.isOpen()).toBe(true);

    // The surface must be usable again. It is not waiting for anything the
    // reader can see, so a key that mutates the child must be taken rather
    // than dropped against a wait owned by a search nobody committed.
    expect(controller.view()._unsafeUnwrap().globalExpanded).toBe(false);
    component.handleInput("\x05");
    await settle();
    expect(controller.view()._unsafeUnwrap().globalExpanded).toBe(true);
    expect(harness.fallbacks).toHaveLength(0);

    // Releasing the abandoned read afterwards still changes nothing.
    harness.releaseBlockedOlderPage();
    await settle();
    const afterView = controller.view()._unsafeUnwrap();
    expect(afterView.entries.map((entry) => entry.id)).not.toContain(
      STALE_ENTRY_ID,
    );
    expect(afterView.globalExpanded).toBe(true);
    expect(harness.fallbacks).toHaveLength(0);
  });
});
