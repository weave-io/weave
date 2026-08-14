/**
 * Pi TUI custom component for the child overlay (Spec 33 §7, plan Task 12
 * phase B1).
 *
 * Owns terminal rendering, the draft editor, native transcript component
 * wiring, and the typed fallback path when the native surface cannot be used.
 *
 * Depends on the controller, replay helpers, and shared types; nothing in the
 * overlay runtime imports this module except the `child-overlay.js` facade.
 */

import {
  CustomEditor,
  getSelectListTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  isKeyRelease,
  matchesKey,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import {
  createPiNativeTranscriptComponentFactory,
  type PiNativeTranscriptComponentDeps,
} from "./child-native-components.js";
import type { ChildOverlayController } from "./child-overlay-controller.js";
import {
  childOverlayHeaderFacts,
  childOverlayPromptFacts,
  childOverlayRailFacts,
  childOverlaySettlementFacts,
  compactChildOverlayLines,
} from "./child-overlay-facts.js";
import type { PiChildOverlayKeyInterceptor } from "./child-overlay-keys.js";
import {
  PI_CHILD_OVERLAY_SEARCH_TRIGGER,
  PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER,
} from "./child-overlay-keys.js";
import {
  compactStatusMatrix,
  composeSessionHeader,
  frameOverlay,
  identitySafetyRow,
  keyLine,
  markSearchGutter,
  OVERLAY_FRAME_ROWS,
  OVERLAY_FRAME_TITLE,
  type OverlayFrameChrome,
  type OverlayNavFacts,
  type OverlayNavMatch,
  overlayPaneGeometry,
  overlayRuleRow,
  promptKeys,
  renderPromptGroup,
  renderRailStatusMatrix,
  searchRailSections,
  squeezeBody,
  transcriptWindow,
} from "./child-overlay-layout.js";
import { boundText } from "./child-overlay-replay.js";
import type { OverlayLayoutSpan } from "./child-overlay-scroll.js";
import { normalizeChildOverlayScrollFrame } from "./child-overlay-terminal-input.js";
import {
  type ChildOverlayEntry,
  type ChildOverlayError,
  type ChildOverlayFallbackReason,
  type ChildOverlayFallbackRequired,
  type ChildOverlayInputOutcome,
  type ChildOverlayView,
  SCROLL_KEYS,
} from "./child-overlay-types.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import {
  createPiChildTranscriptRenderer,
  isAssistantTerminalProviderErrorRow,
  type PiChildTranscriptRenderedRow,
  type PiTranscriptComponentFactory,
} from "./child-transcript.js";
import { fitLineToWidth } from "./render-width.js";
import type { PiUiThemePort } from "./types.js";
import { makePaint, type Paint, plainPaint } from "./ui-paint.js";
import { cell, fitTo, joinColumns } from "./ui-rows.js";

// ---------------------------------------------------------------------------
// Native custom component (Task 12 phase B1)
// ---------------------------------------------------------------------------

/** Longest search query the prompt accepts before it stops taking input. */
const OVERLAY_SEARCH_QUERY_MAX = 120;

/** Keys the search prompt understands, as raw terminal data. */
const SEARCH_KEYS = {
  commit: ["\r", "\n"],
  cancel: "\x1b",
  backspace: ["\x7f", "\b"],
  nextMatch: "n",
  previousMatch: "N",
} as const;

/**
 * How the overlay is routing keyboard input.
 *
 * `off` is the ordinary overlay; `typing` collects a search query and consumes
 * every key; `navigate` walks committed matches. Neither search state ever
 * forwards a key to the draft editor, the key interceptor, or Pi.
 */
type OverlaySearchMode = "off" | "typing" | "navigate";

export interface PiChildOverlayCustomComponent {
  focused?: boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

/**
 * Mount options for the child overlay's `ctx.ui.custom` call.
 *
 * `overlay: true` is the whole point: without it Pi *replaces* the editor with
 * the component and clears the screen, so opening a child inspector would tear
 * down the conversation view and the primary editor with it. As a floating
 * surface the overlay draws on top of the existing screen, keeps the
 * conversation visible behind it, and returns input to the editor on close.
 *
 * The sizing keeps the surface inside the terminal on every side, so the
 * border this component draws is always visible rather than clipped:
 *
 * - `width` / `maxHeight` as percentages let the frame breathe on wide
 *   terminals without ever exceeding the screen.
 * - `margin` keeps one column and row of host content visible around the
 *   frame, which is what makes it read as floating rather than full-screen.
 * - `minWidth` is the inspector's two-column floor. Pi clamps a minimum it
 *   cannot honor to the terminal, and the component drops its border rather
 *   than overflow, so the minimum widens the surface without ever producing
 *   an over-wide line.
 * - `visible` hides the overlay entirely below
 *   {@link PI_CHILD_OVERLAY_MIN_TERMINAL}. A terminal that small cannot carry
 *   a readable inspector, and a hidden overlay is honest where a corrupted one
 *   is not.
 */
export const PI_CHILD_OVERLAY_MIN_TERMINAL = Object.freeze({
  width: 44,
  height: 12,
} as const);

export const PI_CHILD_OVERLAY_CUSTOM_OPTIONS = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({
    anchor: "center",
    width: "92%",
    minWidth: 40,
    maxHeight: "86%",
    margin: 1,
    visible: (terminalWidth: number, terminalHeight: number): boolean =>
      terminalWidth >= PI_CHILD_OVERLAY_MIN_TERMINAL.width &&
      terminalHeight >= PI_CHILD_OVERLAY_MIN_TERMINAL.height,
  }),
} as const);

const DEFAULT_TERMINAL_ROWS = 40;

/**
 * Transcript rows the folded rail may never take.
 *
 * The compact matrix is a degradation of the rail, and a degradation that
 * leaves no transcript has degraded the wrong region.
 */
const OVERLAY_MIN_TRANSCRIPT_ROWS = 3;

/** Painted transcript rows plus the per-entry row spans that produced them. */
export interface OverlayRenderedTranscript {
  readonly lines: readonly string[];
  readonly spans: readonly OverlayLayoutSpan[];
}

/**
 * Collapse the native renderer's per-fact rows into per-entry row spans.
 *
 * One entry can emit several rows, and each row can wrap to several lines, so
 * the span of an entry is the total lines of its consecutive rows. Rows arrive
 * in transcript order, so accumulating while the entry id repeats preserves
 * that order without sorting.
 *
 * Rows replayed from the overlay window carry the overlay entry's own id, and
 * one overlay entry can fan out into several transcript entries (an assistant
 * message plus its tool calls). Grouping on that id keeps full-layout spans in
 * the same identity space compact spans use, so a viewport anchor survives a
 * layout toggle. Live rows without it fall back to the transcript entry id.
 */
export function spansFromRows(
  rows: readonly PiChildTranscriptRenderedRow[],
): readonly OverlayLayoutSpan[] {
  const spans: OverlayLayoutSpan[] = [];
  let currentId: string | undefined;
  let currentRows = 0;
  for (const row of rows) {
    const rowId = row.overlayEntryId ?? row.entryId;
    if (rowId !== currentId) {
      if (currentId !== undefined) {
        spans.push({ entryId: currentId, rows: currentRows });
      }
      currentId = rowId;
      currentRows = 0;
    }
    currentRows += row.lines.length;
  }
  if (currentId !== undefined) {
    spans.push({ entryId: currentId, rows: currentRows });
  }
  return spans;
}

/**
 * Return the same row limit Pi's overlay compositor applies after rendering.
 * Staying within this limit keeps Pi's top-only truncation from removing the
 * editor or bottom border.
 */
export function overlayUsableRows(tui: {
  readonly terminal?: { readonly rows?: number };
}): number {
  const reportedRows = Result.fromThrowable(
    () => tui.terminal?.rows,
    () => undefined,
  )().unwrapOr(undefined);
  const terminalRows =
    typeof reportedRows === "number" &&
    Number.isFinite(reportedRows) &&
    reportedRows > 0
      ? Math.floor(reportedRows)
      : DEFAULT_TERMINAL_ROWS;
  const options = PI_CHILD_OVERLAY_CUSTOM_OPTIONS.overlayOptions;
  const verticalMargin = Math.max(0, options.margin) * 2;
  const available = Math.max(1, terminalRows - verticalMargin);
  const maxHeight = options.maxHeight;
  const requested =
    typeof maxHeight === "number"
      ? maxHeight
      : Math.floor((terminalRows * Number.parseFloat(maxHeight)) / 100);
  return Math.max(1, Math.min(Math.floor(requested), available));
}

/**
 * Keeps a rendered overlay inside the row budget Pi will actually keep.
 *
 * Pi truncates a component's output to its first `maxHeight` rows, so an
 * over-tall render loses its bottom border and its prompt. Trimming from the
 * MIDDLE instead keeps both edges of the frame, which is what a reader needs
 * to see that the surface is complete.
 */
export function fitOverlayRows(
  lines: readonly string[],
  limit: number,
): string[] {
  const rows = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (lines.length <= rows) return [...lines];
  if (rows <= 1) return lines.slice(0, rows);
  return [lines[0] as string, ...lines.slice(lines.length - (rows - 1))];
}

/**
 * The overlay's ink, or the ANSI-free twin when the host port cannot paint.
 *
 * A stand-in theme port is a legitimate host state (and every render test
 * passes one), and a paint that throws would abort a render rather than lose a
 * colour. Geometry is identical either way, so degrading here changes no
 * column count.
 */
export function childOverlayPaint(theme: PiUiThemePort): Paint {
  return Result.fromThrowable(
    (): Paint => {
      const paint = makePaint(theme);
      // Prove the port answers before any row depends on it.
      paint.text("");
      paint.bold("");
      return paint;
    },
    () => "overlay_paint_unavailable" as const,
  )().unwrapOr(plainPaint());
}

/**
 * Builds the overlay's steering / follow-up field.
 *
 * This is deliberately a {@link CustomEditor} and never a `pi-tui` `Input`.
 * `Input` is a single-line field with no app keybindings: it cannot carry a
 * multi-line follow-up, and it swallows the app shortcuts a user still expects
 * while a child runs. `CustomEditor` is the same class Pi uses for its own
 * prompt, so the overlay's field behaves like the primary editor.
 *
 * Factored out so the choice is directly assertable in a regression test.
 */
const FALLBACK_SELECT_LIST_THEME: SelectListTheme = Object.freeze({
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
});

/** Convert Pi's palette theme into the styling record its native editor needs. */
export function toChildOverlayEditorTheme(theme: PiUiThemePort): EditorTheme {
  const selectList = Result.fromThrowable(
    () => getSelectListTheme(),
    () => FALLBACK_SELECT_LIST_THEME,
  )().unwrapOr(FALLBACK_SELECT_LIST_THEME);
  return {
    borderColor: (text: string) => theme.fg("border", text),
    selectList,
  };
}

export function createChildOverlayDraftEditor(
  tui: TUI,
  theme: PiUiThemePort,
  keybindings: KeybindingsManager,
): CustomEditor {
  return new CustomEditor(tui, toChildOverlayEditorTheme(theme), keybindings);
}

function isOverlayFallbackRequired(
  error: ChildOverlayError,
): error is ChildOverlayFallbackRequired {
  return "kind" in error && error.kind === "fallback-required";
}

/**
 * Builds the Spec 33 §7 full-screen overlay as a Pi `ui.custom` component.
 *
 * One component wraps one {@link ChildOverlayController}. Escape closes only
 * this overlay. Renderer/theme/source failures emit typed fallback once and
 * never throw into Pi. Input never reaches a primary-editor callback.
 */
export function createChildOverlayCustomComponent(
  tui: TUI & { readonly width?: number; requestRender(): void },
  theme: PiUiThemePort,
  keybindings: KeybindingsManager,
  controller: ChildOverlayController,
  done: () => void,
  onFallback: (fallback: ChildOverlayFallbackRequired) => void,
  nativeDeps?: Omit<PiNativeTranscriptComponentDeps, "tui">,
  /**
   * Task 13 owns the keyboard first. Anything it consumes never reaches the
   * Task 12 input path below, and nothing here ever forwards a key to Pi or
   * the primary editor while the overlay is mounted.
   */
  keyInterceptor?: PiChildOverlayKeyInterceptor,
  /**
   * Resolved in-overlay search route. Omitted keeps the documented default
   * key; passing a route with an undefined trigger disables the route, which
   * is how a host binding conflict is honored: the key keeps its existing
   * meaning instead of being silently stolen.
   */
  searchRoute: { readonly trigger: string | undefined } = {
    trigger: PI_CHILD_OVERLAY_SEARCH_TRIGGER,
  },
  /**
   * Resolved compact-view toggle route. Same contract as `searchRoute`: an
   * undefined trigger means the host already owns the key, so the overlay
   * leaves it alone and never advertises the toggle in the help rows.
   */
  viewModeRoute: { readonly trigger: string | undefined } = {
    trigger: PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER,
  },
): PiChildOverlayCustomComponent {
  const searchTrigger = searchRoute.trigger;
  const viewModeTrigger = viewModeRoute.trigger;
  const draftEditor = createChildOverlayDraftEditor(tui, theme, keybindings);
  const transcriptRenderer = createPiChildTranscriptRenderer();
  const paint = childOverlayPaint(theme);
  /** The frame's title and lifecycle marker, refreshed by every composition. */
  let chrome: OverlayFrameChrome = {
    title: OVERLAY_FRAME_TITLE,
    marker: "",
    markerTone: "mute",
  };
  let componentFactory: PiTranscriptComponentFactory | undefined;
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let lastUsableRows = -1;
  let finished = false;
  let fallbackEmitted = false;
  let inputBusy = false;
  let searchMode: OverlaySearchMode = "off";
  let searchDraft = "";
  let searchMatchIndex = 0;
  let lastDraftChildId: string | undefined;
  let lastDraftReadOnly: boolean | undefined;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    Result.fromThrowable(
      () => {
        done();
      },
      () => "overlay_done_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const emitFallback = (
    reason: ChildOverlayFallbackReason | ChildOverlayFallbackRequired,
  ): void => {
    if (fallbackEmitted) return;
    fallbackEmitted = true;
    const payload =
      typeof reason === "string" ? controller.requireFallback(reason) : reason;
    Result.fromThrowable(
      () => {
        onFallback(payload);
      },
      () => "overlay_fallback_callback_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
    finish();
  };

  const factory = (): PiTranscriptComponentFactory => {
    componentFactory ??= createPiNativeTranscriptComponentFactory({
      ...nativeDeps,
      cwd: nativeDeps?.cwd ?? ".",
      tui,
    });
    return componentFactory;
  };

  const usableRows = (): number => overlayUsableRows(tui);

  const syncDraftEditorTransition = (view: ChildOverlayView): void => {
    const childChanged = lastDraftChildId !== view.child.childId;
    const readOnlyChanged = lastDraftReadOnly !== view.readOnly;
    if (!childChanged && !readOnlyChanged) return;
    lastDraftChildId = view.child.childId;
    lastDraftReadOnly = view.readOnly;
    const nextText = view.readOnly ? "" : view.draft;
    if (draftEditor.getText() !== nextText) draftEditor.setText(nextText);
  };

  const renderEditorLines = (width: number, readOnly: boolean): string[] => {
    if (readOnly) return [];
    const rendered = Result.fromThrowable(
      () => draftEditor.render(width),
      () => "editor_render_failed" as const,
    )().unwrapOr([]);
    return Array.isArray(rendered) && rendered.length > 0
      ? rendered
      : [`> ${draftEditor.getText()}`];
  };

  /**
   * The Session Header and its rule, from identity facts alone.
   *
   * Nothing state-derived reaches it: status, elapsed, queue, tokens and the
   * search all belong to the rail, and the lifecycle marker belongs to the
   * frame, so this block is byte-identical in every child state.
   */
  const headRegion = (view: ChildOverlayView, width: number): string[] => [
    ...composeSessionHeader(paint, childOverlayHeaderFacts(view), width).lines,
    overlayRuleRow(paint, width),
  ];

  /**
   * The prompt region: Pi's own editor, then the layout's key row.
   *
   * The layout renders the settled and cancel-confirmation forms itself, since
   * both are pure text. A live child instead gets the real {@link CustomEditor}
   * as the panel body, because a live draft is a component with a caret and
   * multi-line editing, not a string the layout could paint. The key row below
   * it still comes from the layout, so the two forms advertise the same keys.
   */
  const promptRegion = (view: ChildOverlayView, width: number): string[] => {
    const facts = childOverlayPromptFacts(view, {
      draft: draftEditor.getText(),
      confirmingCancel: false,
    });
    if (facts.settled) return renderPromptGroup(paint, facts, width);
    return [
      ...renderEditorLines(width, false).map((line) =>
        cell(fitLineToWidth(line, width), width),
      ),
      cell(keyLine(paint, promptKeys(facts), width), width),
    ];
  };

  /**
   * The rail's search vocabulary, built from the controller's own match set.
   *
   * The counter counts matched ENTRIES, which is what the controller searched
   * and what `n` / `N` walk, so the rail can never claim a match the keyboard
   * cannot reach. Row indices come from the spans the transcript just
   * reported, so the marker gutter marks rows that were actually painted.
   */
  const navFacts = (
    view: ChildOverlayView,
    spans: readonly OverlayLayoutSpan[],
  ): OverlayNavFacts => {
    const startRow = new Map<string, number>();
    let row = 0;
    for (const span of spans) {
      startRow.set(span.entryId, row);
      row += span.rows;
    }
    const total = view.searchMatches.length;
    const current =
      total === 0 ? 0 : (((searchMatchIndex % total) + total) % total) + 1;
    const matches: OverlayNavMatch[] = view.searchMatches.map(
      (entryId, index) => {
        const entry = view.entries.find(
          (candidate) => candidate.id === entryId,
        );
        return {
          ordinal: index + 1,
          row: startRow.get(entryId) ?? 0,
          label: entry?.kind ?? "entry",
          at: entry?.runNumber === undefined ? "" : `run ${entry.runNumber}`,
          snippet: boundText(entry?.text ?? ""),
        };
      },
    );
    const counts = new Map<string, number>();
    for (const match of matches) {
      counts.set(match.label, (counts.get(match.label) ?? 0) + 1);
    }
    return {
      open: searchMode !== "off",
      accepted: false,
      query: searchMode === "typing" ? searchDraft : view.searchQuery,
      matches,
      total,
      current,
      currentMatch: current === 0 ? undefined : matches[current - 1],
      counter: `${current}/${total} match${total === 1 ? "" : "es"}`,
      summary:
        total === 0
          ? "no match in this transcript"
          : [...counts.entries()]
              .map(([label, count]) => `${label} ${count}`)
              .join(" · "),
      empty: total === 0,
      rows: new Set(
        view.searchMatches
          .map((entryId) => startRow.get(entryId))
          .filter((value): value is number => value !== undefined),
      ),
      // The controller's scroll offset already positions the viewport on the
      // current match, so the window is never anchored twice.
      anchorRow: undefined,
    };
  };

  /**
   * Paint the transcript for the active layout and report how many rendered
   * rows each entry occupies.
   *
   * The spans are what let the controller keep a logical viewport across a
   * layout change: compact renders exactly one row per entry while full can
   * render many, so the two layouts share no row coordinate system.
   */
  const renderTranscriptLines = (
    view: ChildOverlayView,
    width: number,
  ): Result<OverlayRenderedTranscript, ChildOverlayFallbackRequired> => {
    const terminalErrorLine =
      view.terminalError === undefined
        ? undefined
        : fitLineToWidth(formatPiChildProviderError(view.terminalError), width);
    if (view.viewMode === "compact") {
      // Render-time projection of the same bounded entries; the native
      // transcript model is left untouched so toggling back is lossless.
      const entryLines = compactChildOverlayLines(view.entries, width);
      return ok({
        lines:
          terminalErrorLine === undefined
            ? entryLines
            : [...entryLines, terminalErrorLine],
        spans: view.entries
          .slice(0, entryLines.length)
          .map((entry) => ({ entryId: entry.id, rows: 1 })),
      });
    }
    return Result.fromThrowable(
      (): OverlayRenderedTranscript => {
        const rendered = transcriptRenderer.render(view.transcript, width, {
          componentFactory: factory(),
        });
        if (rendered.lines.length > 0) {
          const hasAssistantTerminalProviderError = rendered.rows.some(
            isAssistantTerminalProviderErrorRow,
          );
          return {
            lines:
              terminalErrorLine === undefined ||
              hasAssistantTerminalProviderError
                ? rendered.lines
                : [...rendered.lines, terminalErrorLine],
            spans: spansFromRows(rendered.rows),
          };
        }
        // Native factory may suppress bookkeeping rows; fall back to overlay
        // entry text so kinds remain visible in the bounded window.
        const lines = view.entries.map((entry) =>
          boundText(
            entry.expanded || entry.text.length <= 120
              ? `[${entry.kind}] ${entry.text}`
              : `[${entry.kind}] ${entry.text.slice(0, 117)}…`,
          ),
        );
        return {
          lines:
            terminalErrorLine === undefined
              ? lines
              : [...lines, terminalErrorLine],
          spans: view.entries.map((entry) => ({
            entryId: entry.id,
            rows: 1,
          })),
        };
      },
      (): ChildOverlayFallbackRequired =>
        controller.requireFallback("render-failed"),
    )();
  };

  const requestPaint = (): void => {
    dirty = true;
    Result.fromThrowable(
      () => {
        tui.requestRender();
      },
      () => "overlay_request_render_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const afterControllerOutcome = (
    outcome: Result<ChildOverlayInputOutcome, ChildOverlayError>,
  ): void => {
    if (outcome.isErr()) {
      if (isOverlayFallbackRequired(outcome.error)) {
        emitFallback(outcome.error);
        return;
      }
      emitFallback("source-failed");
      return;
    }
    if (outcome.value.kind === "fallback-required") {
      emitFallback(outcome.value);
      return;
    }
    requestPaint();
  };

  const focusSearchMatch = (): void => {
    const viewResult = controller.view();
    if (viewResult.isErr()) return;
    const view = viewResult.value;
    if (view.searchMatches.length === 0) return;
    const bounded =
      ((searchMatchIndex % view.searchMatches.length) +
        view.searchMatches.length) %
      view.searchMatches.length;
    searchMatchIndex = bounded;
    const matchId = view.searchMatches[bounded];
    const index = view.entries.findIndex((entry) => entry.id === matchId);
    if (index < 0) return;
    // Scroll offsets count backwards from the newest entry, so the newest
    // entry sits at offset 0 and the oldest at entries.length - 1.
    controller.setScrollOffset(view.entries.length - 1 - index).match(
      () => undefined,
      () => undefined,
    );
  };

  const exitSearch = (clearQuery: boolean): void => {
    searchMode = "off";
    searchDraft = "";
    searchMatchIndex = 0;
    if (!clearQuery) {
      requestPaint();
      return;
    }
    void controller.search("").match(
      () => requestPaint(),
      () => requestPaint(),
    );
  };

  /**
   * Runs the whole search route. Returns true when the key belonged to search,
   * which means it must never reach the interceptor, the controller, the draft
   * editor, or Pi.
   */
  const handleSearchInput = (data: string): boolean => {
    if (searchMode === "off") {
      if (searchTrigger === undefined || data !== searchTrigger) return false;
      searchMode = "typing";
      searchDraft = "";
      searchMatchIndex = 0;
      requestPaint();
      return true;
    }
    if (data === SEARCH_KEYS.cancel) {
      exitSearch(true);
      return true;
    }
    if (searchTrigger !== undefined && data === searchTrigger) {
      // Re-opening from navigate mode edits the committed query again.
      searchMode = "typing";
      requestPaint();
      return true;
    }
    if (searchMode === "navigate") {
      if (data === SEARCH_KEYS.nextMatch) {
        searchMatchIndex += 1;
        focusSearchMatch();
        requestPaint();
        return true;
      }
      if (data === SEARCH_KEYS.previousMatch) {
        searchMatchIndex -= 1;
        focusSearchMatch();
        requestPaint();
        return true;
      }
      // Every other key stays consumed: search owns the keyboard until Escape.
      return true;
    }
    if (SEARCH_KEYS.commit.includes(data as never)) {
      const query = searchDraft;
      searchMode = "navigate";
      searchMatchIndex = 0;
      inputBusy = true;
      void controller.search(query).match(
        () => {
          inputBusy = false;
          focusSearchMatch();
          requestPaint();
        },
        (error) => {
          inputBusy = false;
          afterControllerOutcome(err(error));
        },
      );
      return true;
    }
    if (SEARCH_KEYS.backspace.includes(data as never)) {
      searchDraft = searchDraft.slice(0, -1);
      requestPaint();
      return true;
    }
    // Printable ASCII only; control sequences never edit the query.
    if (
      data.length > 0 &&
      searchDraft.length < OVERLAY_SEARCH_QUERY_MAX &&
      /^[\x20-\x7e]+$/.test(data)
    ) {
      searchDraft = `${searchDraft}${data}`.slice(0, OVERLAY_SEARCH_QUERY_MAX);
      requestPaint();
    }
    return true;
  };

  const handlePaginationEdge = (
    data: string,
  ): ResultAsync<void, ChildOverlayError> => {
    const viewResult = controller.view();
    if (viewResult.isErr()) return errAsync(viewResult.error);
    const view = viewResult.value;
    if (
      (data === SCROLL_KEYS.pageUp || data === SCROLL_KEYS.home) &&
      view.hasOlder
    ) {
      // Older pages load once the viewport sits on the oldest rendered row.
      // A fitting newest page reports scrollExtent 0, so PageUp/Home are
      // already at that edge even though older history still exists.
      const nearOldest = view.scrollOffset >= Math.max(0, view.scrollExtent);
      if (nearOldest || view.entries.length === 0) {
        return controller.loadOlder().map(() => undefined);
      }
    }
    if (
      (data === SCROLL_KEYS.pageDown || data === SCROLL_KEYS.end) &&
      view.hasNewer &&
      (view.liveTail || view.scrollOffset === 0)
    ) {
      return controller.loadNewer().map(() => undefined);
    }
    return okAsync(undefined);
  };

  const isControllerInput = (
    data: string,
    normalizedScroll: string | undefined,
  ): boolean =>
    normalizedScroll !== undefined ||
    matchesKey(data, "ctrl+e") ||
    (viewModeTrigger !== undefined &&
      (data === viewModeTrigger || matchesKey(data, "ctrl+o"))) ||
    matchesKey(data, "alt+left") ||
    matchesKey(data, "alt+right") ||
    matchesKey(data, "alt+up") ||
    matchesKey(data, "alt+down");

  const handleControllerInput = (data: string): void => {
    if (inputBusy) return;
    inputBusy = true;
    void handlePaginationEdge(data)
      .andThen(() => controller.handleInput(data))
      .match(
        (value) => {
          inputBusy = false;
          afterControllerOutcome(ok(value));
        },
        (error) => {
          inputBusy = false;
          afterControllerOutcome(err(error));
        },
      );
  };

  const submitDraft = (kind: "steer" | "follow-up"): void => {
    if (inputBusy) return;
    const view = controller.view();
    if (view.isErr() || view.value.readOnly) return;
    const text = draftEditor.getExpandedText().trim();
    if (text.length === 0) return;
    const editorTextAtSubmit = draftEditor.getText();
    // The draft editor is shared across children. Remember which child owned
    // the submitted text so a focus switch during the pending mutation can
    // never clear or overwrite the newly focused child's draft.
    const submittedChildId = view.value.child.childId;
    inputBusy = true;
    const submission =
      kind === "steer"
        ? controller.submitSteer(text)
        : controller.submitFollowUp(text);
    void submission.match(
      (outcome) => {
        inputBusy = false;
        const settledView = controller.view();
        if (
          settledView.isErr() ||
          settledView.value.child.childId !== submittedChildId
        ) {
          // Focus moved while the mutation was in flight: the editor now
          // belongs to another child, so re-align it with that child's draft
          // instead of clearing it or mirroring stale text back.
          if (settledView.isOk()) syncDraftEditorTransition(settledView.value);
          afterControllerOutcome(ok(outcome));
          return;
        }
        if (
          outcome.kind === kind &&
          draftEditor.getText() === editorTextAtSubmit
        ) {
          draftEditor.setText("");
        }
        controller.updateDraft(draftEditor.getText()).match(
          () => afterControllerOutcome(ok(outcome)),
          (error) => afterControllerOutcome(err(error)),
        );
      },
      (error) => {
        inputBusy = false;
        afterControllerOutcome(err(error));
      },
    );
  };

  const handleDraftEditorInput = (data: string): void => {
    const view = controller.view();
    if (view.isErr() || view.value.readOnly) return;
    draftEditor.handleInput(data);
    controller.updateDraft(draftEditor.getText()).match(
      () => requestPaint(),
      (error) => afterControllerOutcome(err(error)),
    );
  };

  /**
   * The whole inspector for one width and one row budget, or `undefined` when
   * the last painted body must stand.
   *
   * The order is the contract: the header and the prompt reserve their rows
   * first, the rail either takes a column beside the transcript or folds into
   * dense rows above it, and only what is left becomes the transcript budget
   * handed to `controller.resize`. The transcript is painted at the pane width
   * with the search inset already removed, so the marker gutter, the match row
   * indices and the measured spans all describe the same rows.
   */
  const composeOverlayContent = (
    opened: ChildOverlayView,
    outer: number,
    rowLimit: number,
  ): string[] | undefined => {
    syncDraftEditorTransition(opened);
    const settlement = childOverlaySettlementFacts(opened);
    chrome = {
      title: OVERLAY_FRAME_TITLE,
      marker: ` ${settlement.glyph} ${settlement.word} `,
      markerTone: settlement.tone,
    };
    const geometry = overlayPaneGeometry(outer, searchMode !== "off");
    const inner = geometry.inner;
    const innerHeight = Math.max(1, rowLimit - OVERLAY_FRAME_ROWS);

    const prompt = promptRegion(opened, inner);
    // A vertically starved overlay gives up provenance, then the whole header,
    // before it gives up the prompt: a reader who cannot act on a child is
    // worse off than one who cannot read its plan breadcrumb.
    let head = headRegion(opened, inner);
    if (head.length + prompt.length + 1 > innerHeight) {
      head = identitySafetyRow(paint, childOverlayHeaderFacts(opened), inner);
    }
    if (head.length + prompt.length > innerHeight) head = [];

    const railFacts = childOverlayRailFacts(opened);
    const room = Math.max(0, innerHeight - head.length - prompt.length);
    // The folded rail keeps its most valuable rows first and never buys them
    // from the transcript's floor: an inspector with no transcript is not an
    // inspector, and the rail's dropped rows are still one resize away.
    const folded =
      geometry.rail === undefined
        ? compactStatusMatrix(paint, railFacts, inner).slice(
            0,
            Math.max(0, room - OVERLAY_MIN_TRANSCRIPT_ROWS - 1),
          )
        : [];
    const transcriptBudget = Math.max(
      0,
      room - (folded.length > 0 ? folded.length + 1 : 0),
    );

    const viewport = controller.resize(
      geometry.transcript,
      Math.max(1, transcriptBudget),
    );
    if (viewport.isErr()) {
      if (isOverlayFallbackRequired(viewport.error)) {
        emitFallback(viewport.error);
      } else if (
        !("type" in viewport.error) ||
        viewport.error.type !== "OverlayNotOpen"
      ) {
        emitFallback("render-failed");
      }
      return undefined;
    }
    const view = viewport.value;
    const transcript =
      transcriptBudget > 0
        ? renderTranscriptLines(view, geometry.transcript)
        : ok<OverlayRenderedTranscript, ChildOverlayFallbackRequired>({
            lines: [],
            spans: [],
          });
    if (transcript.isErr()) {
      emitFallback(transcript.error);
      return undefined;
    }

    const nav = navFacts(view, transcript.value.spans);
    const painted = nav.open
      ? markSearchGutter(paint, nav, transcript.value.lines, geometry.pane)
      : transcript.value.lines;
    // The cue costs a transcript row, so it is budgeted rather than overlaid.
    const contentBudget =
      view.scrollOffset > 0 && transcriptBudget > 0
        ? transcriptBudget - 1
        : transcriptBudget;
    const scrollMax = Math.max(0, painted.length - contentBudget);
    // Spans travel with the extent so the controller can translate a logical
    // viewport into this layout's rendered rows.
    const measured = controller
      .setScrollExtent(scrollMax, transcript.value.spans)
      .match(
        (updated) => updated.scrollOffset,
        () => view.scrollOffset,
      );
    const scrollOffset = Math.min(measured, scrollMax);
    const end = Math.max(0, painted.length - scrollOffset);
    const pane = [
      ...transcriptWindow(
        paint,
        painted.slice(0, end),
        geometry.pane,
        contentBudget,
        nav.anchorRow,
      ),
      ...(scrollOffset > 0 && transcriptBudget > 0
        ? [
            cell(
              fitLineToWidth(
                paint.muted(
                  `\u2193 ${scrollOffset} newer line(s) below — End follows output`,
                ),
                geometry.pane,
              ),
              geometry.pane,
            ),
          ]
        : []),
    ];

    const railWidth = geometry.rail;
    const main =
      railWidth === undefined
        ? [
            ...folded,
            ...(folded.length > 0 ? [overlayRuleRow(paint, inner)] : []),
            ...pane,
          ]
        : joinColumns(
            [
              { lines: pane, width: geometry.pane },
              {
                lines: fitTo(
                  renderRailStatusMatrix(
                    paint,
                    railFacts,
                    railWidth,
                    room,
                    nav.open ? searchRailSections(paint, nav, railWidth) : [],
                  ),
                  room,
                  "head",
                ),
                width: railWidth,
              },
            ],
            room,
            paint.rule("\u2502"),
          );

    // Overflow is taken out of the transcript block, never out of the prompt,
    // so a starved terminal can still act on the child.
    const above = squeezeBody(
      paint,
      [...head, ...main],
      Math.max(1, innerHeight - prompt.length),
      inner,
    );
    return fitTo([...above, ...prompt], innerHeight, "tail");
  };

  return {
    get focused() {
      return draftEditor.focused;
    },
    set focused(value: boolean) {
      if (draftEditor.focused === value) return;
      draftEditor.focused = value;
      requestPaint();
    },
    render(outerWidth) {
      const outer = Number.isFinite(outerWidth)
        ? Math.max(0, Math.floor(outerWidth))
        : 0;
      const rowLimit = usableRows();
      const rendered = Result.fromThrowable(
        (): string[] => {
          if (finished) return lines;
          const current = controller.view();
          if (current.isErr()) return lines;
          if (dirty || outer !== lastWidth || rowLimit !== lastUsableRows) {
            const composed = composeOverlayContent(
              current.value,
              outer,
              rowLimit,
            );
            if (composed === undefined) return lines;
            lines = composed;
            dirty = false;
            lastWidth = outer;
            lastUsableRows = rowLimit;
          }
          return lines;
        },
        (): string[] => {
          emitFallback("render-failed");
          return lines;
        },
      )().unwrapOr(lines);
      // The frame is applied on every call, so a cached body is still fitted to
      // whatever width Pi passed this time and can never overflow it.
      return fitOverlayRows(
        frameOverlay(paint, rendered, outer, chrome),
        rowLimit,
      );
    },
    handleInput(data) {
      if (finished || isKeyRelease(data)) return;
      Result.fromThrowable(
        () => {
          if (handleSearchInput(data)) return;
          const normalizedScroll = normalizeChildOverlayScrollFrame(data);
          const routedData = normalizedScroll ?? data;
          if (keyInterceptor !== undefined) {
            const consumed = Result.fromThrowable(
              () => keyInterceptor(routedData),
              () => "overlay_key_interceptor_failed" as const,
            )().unwrapOr(true);
            if (consumed) return;
          } else if (
            keybindings.matches(routedData, "tui.select.cancel") ||
            routedData === "\x1b"
          ) {
            finish();
            return;
          }
          if (matchesKey(routedData, "alt+enter")) {
            submitDraft("follow-up");
            return;
          }
          if (matchesKey(routedData, "enter")) {
            submitDraft("steer");
            return;
          }
          if (isControllerInput(routedData, normalizedScroll)) {
            handleControllerInput(routedData);
            return;
          }
          handleDraftEditorInput(data);
        },
        () => "overlay_input_failed" as const,
      )().match(
        () => undefined,
        () => {
          inputBusy = false;
          emitFallback("render-failed");
        },
      );
    },
    invalidate() {
      dirty = true;
    },
  };
}
