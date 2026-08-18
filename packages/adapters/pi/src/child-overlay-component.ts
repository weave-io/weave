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
import type { PiNativeTranscriptComponentDeps } from "./child-native-components.js";
import type { ChildOverlayController } from "./child-overlay-controller.js";
import {
  childOverlayHeaderFacts,
  childOverlayPromptFacts,
  childOverlayRailFacts,
  childOverlaySettlementFacts,
  childOverlayTranscriptInput,
} from "./child-overlay-facts.js";
import {
  answerOverlayCancelConfirm,
  CLOSED_OVERLAY_SEARCH,
  type OverlaySearchState,
  overlaySearchQuery,
  stepOverlaySearch,
} from "./child-overlay-input-modes.js";
import type { PiChildOverlayKeyInterceptor } from "./child-overlay-keys.js";
import { PI_CHILD_OVERLAY_SEARCH_TRIGGER } from "./child-overlay-keys.js";
import {
  compactStatusMatrix,
  composeSessionHeader,
  frameOverlay,
  identitySafetyRow,
  markSearchGutter,
  OVERLAY_FRAME_ROWS,
  OVERLAY_FRAME_TITLE,
  OVERLAY_PROMPT_PANEL_INSET,
  type OverlayFrameChrome,
  type OverlayNavFacts,
  type OverlayNavMatch,
  overlayEditorBodyRows,
  overlayPaneGeometry,
  overlayRuleRow,
  promptEditorPanel,
  renderPromptGroup,
  renderRailStatusMatrix,
  searchRailSections,
  squeezeBody,
  transcriptWindow,
} from "./child-overlay-layout.js";
import { renderOverlayTranscript } from "./child-overlay-pi-native.js";
import { boundText } from "./child-overlay-replay.js";
import type { OverlayLayoutSpan } from "./child-overlay-scroll.js";
import { normalizeChildOverlayScrollFrame } from "./child-overlay-terminal-input.js";
import {
  type ChildOverlayError,
  type ChildOverlayFallbackReason,
  type ChildOverlayFallbackRequired,
  type ChildOverlayInputOutcome,
  type ChildOverlayView,
  SCROLL_KEYS,
} from "./child-overlay-types.js";
import type { PiChildTranscriptRenderedRow } from "./child-transcript.js";
import { fitLineToWidth } from "./render-width.js";
import type { PiUiThemePort } from "./types.js";
import { makePaint, type Paint, plainPaint } from "./ui-paint.js";
import { cell, fitTo, joinColumns } from "./ui-rows.js";

// ---------------------------------------------------------------------------
// Native custom component (Task 12 phase B1)
// ---------------------------------------------------------------------------

export interface PiChildOverlayCustomComponent {
  focused?: boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  /**
   * Opens the in-overlay `y` / `n` cancel confirmation for `childId`.
   *
   * Returns `true` when the mounted overlay took the confirmation, which is
   * how the caller knows it must not open a nested host dialog on top of a
   * surface that already owns the keyboard. Only the custom-editor fallback,
   * which has no such surface, still asks the host.
   */
  requestCancelConfirmation?(childId: string): boolean;
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
  /** ANSI-free text of those rows, per entry: the controller's search index. */
  readonly searchIndex: ReadonlyMap<string, string>;
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
 * message plus its tool calls). Grouping on that id keeps a span in the same
 * identity space the viewport anchor uses, so the anchor survives a re-measure.
 * Live rows without it fall back to the transcript entry id.
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
  /**
   * Retained for call-site compatibility and deliberately unused.
   *
   * The inspector once painted its pane with Pi's native message components.
   * They render the HOST's transcript — with its shell-integration markers and
   * its own width contract — and they carry no queue, status, retry or tool
   * outcome row, so a reader watching a child saw neither the prototype's
   * design nor half of what the child was doing. The pane is now the ported
   * `renderPiNative`, fed from the reducer's own entries.
   */
  _nativeDeps?: Omit<PiNativeTranscriptComponentDeps, "tui">,
  /**
   * Task 13 owns the keyboard first. Anything it consumes never reaches the
   * Task 12 input path below, and nothing here ever forwards a key to Pi or
   * the primary editor while the overlay is mounted.
   */
  keyInterceptor?: PiChildOverlayKeyInterceptor,
  /**
   * Resolved in-overlay search ALIAS route (`Ctrl+F`). Omitted keeps the
   * documented default; passing a route with an undefined trigger disables the
   * alias, which is how a host binding conflict is honored: the key keeps its
   * existing meaning instead of being silently stolen. `/` on an empty draft
   * opens search either way, so a disabled alias never removes search.
   */
  searchRoute: { readonly trigger: string | undefined } = {
    trigger: PI_CHILD_OVERLAY_SEARCH_TRIGGER,
  },
  /**
   * Runs the subtree cancellation the in-overlay confirmation just approved.
   *
   * The confirmation itself lives here, in the prompt region, so the mounted
   * overlay never stacks a host dialog on top of a surface that owns the
   * keyboard. Absent means `y` has nothing to call, so the confirmation can
   * only ever dismiss.
   */
  cancelSubtree?: (childId: string) => void,
): PiChildOverlayCustomComponent {
  const searchTrigger = searchRoute.trigger;
  const draftEditor = createChildOverlayDraftEditor(tui, theme, keybindings);
  // Focused on mount, from here rather than from the mount site. The overlay
  // owns the keyboard as soon as it is on screen, so a reader's first keystroke
  // must land in the visible field instead of in a surface behind the frame.
  // Focus never moves anywhere else while mounted: `handleInput` routes every
  // byte itself, and closing simply unmounts, which returns input to whichever
  // primary editor the host already had. This module never calls the host's
  // editor-component installer, so a foreign editor such as `pi-vim` keeps the
  // primary editor across the whole overlay lifetime.
  draftEditor.focused = true;
  const paint = childOverlayPaint(theme);
  /** The frame's title and lifecycle marker, refreshed by every composition. */
  let chrome: OverlayFrameChrome = {
    title: OVERLAY_FRAME_TITLE,
    marker: "",
    markerTone: "mute",
  };
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let lastUsableRows = -1;
  let finished = false;
  let fallbackEmitted = false;
  let inputBusy = false;
  let search: OverlaySearchState = CLOSED_OVERLAY_SEARCH;
  /** The child whose cancellation is awaiting a `y` / `n` answer, if any. */
  let confirmingCancelChildId: string | undefined;
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

  const usableRows = (): number => overlayUsableRows(tui);

  const syncDraftEditorTransition = (view: ChildOverlayView): void => {
    const childChanged = lastDraftChildId !== view.child.childId;
    const readOnlyChanged = lastDraftReadOnly !== view.readOnly;
    if (!childChanged && !readOnlyChanged) return;
    // A confirmation belongs to the child it named. Focus moved, so the
    // question no longer has a subject and is dropped rather than re-aimed.
    if (childChanged) confirmingCancelChildId = undefined;
    lastDraftChildId = view.child.childId;
    lastDraftReadOnly = view.readOnly;
    const nextText = view.readOnly ? "" : view.draft;
    if (draftEditor.getText() !== nextText) draftEditor.setText(nextText);
  };

  /** The live editor's text rows, already fitted to the panel's body width. */
  const renderEditorLines = (width: number, readOnly: boolean): string[] => {
    if (readOnly) return [];
    const rendered = Result.fromThrowable(
      () => draftEditor.render(width),
      () => "editor_render_failed" as const,
    )().unwrapOr([]);
    return overlayEditorBodyRows(
      Array.isArray(rendered) && rendered.length > 0
        ? rendered
        : [`> ${draftEditor.getText()}`],
      width,
    );
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
   * multi-line editing, not a string the layout could paint. The panel, its
   * label and the key row still come from the layout, so a live prompt and a
   * settled one are the same bordered surface rather than two different ones.
   */
  const promptRegion = (view: ChildOverlayView, width: number): string[] => {
    const facts = childOverlayPromptFacts(view, {
      draft: draftEditor.getText(),
      confirmingCancel: confirmingCancelChildId !== undefined,
    });
    // The confirmation REPLACES the editor, which is the structural reason `q`
    // can never cancel without a `y` / `n` answer.
    if (facts.settled || facts.confirmingCancel) {
      return renderPromptGroup(paint, facts, width);
    }
    const body = Math.max(1, width - OVERLAY_PROMPT_PANEL_INSET);
    return promptEditorPanel(
      paint,
      facts,
      renderEditorLines(body, false),
      width,
    );
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
      total === 0 ? 0 : (((search.matchIndex % total) + total) % total) + 1;
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
      open: search.mode !== "off",
      accepted: search.accepted,
      query: overlaySearchQuery(search, view.searchQuery),
      matches,
      total,
      current,
      currentMatch: current === 0 ? undefined : matches[current - 1],
      counter: `${current}/${total}`,
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
   * Paint the transcript and report how many rendered rows each entry occupies.
   *
   * The spans are what let the controller keep a logical viewport across a
   * width or content change: one entry can render many rows, so a rendered-row
   * offset alone cannot name the entry a reader is looking at.
   */
  const renderTranscriptLines = (
    view: ChildOverlayView,
    width: number,
  ): Result<OverlayRenderedTranscript, ChildOverlayFallbackRequired> =>
    Result.fromThrowable(
      (): OverlayRenderedTranscript =>
        renderOverlayTranscript(
          paint,
          childOverlayTranscriptInput(view),
          width,
        ),
      (): ChildOverlayFallbackRequired =>
        controller.requireFallback("render-failed"),
    )();

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
      ((search.matchIndex % view.searchMatches.length) +
        view.searchMatches.length) %
      view.searchMatches.length;
    search = { ...search, matchIndex: bounded };
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
    search = CLOSED_OVERLAY_SEARCH;
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
   * Adopts the query being typed so the rail counts what it prints.
   *
   * Window-only and synchronous: no source read, no timer, no viewport move.
   * A reader is still typing, so the transcript must not jump under them; the
   * commit key owns both the historical search and the jump.
   */
  const previewSearchQuery = (query: string): void => {
    controller.previewSearch(query).match(
      () => requestPaint(),
      (error) => {
        if (isOverlayFallbackRequired(error)) {
          emitFallback(error);
          return;
        }
        // An overlay that is no longer open has nothing to preview; the query
        // field stays exactly as the reader typed it.
        requestPaint();
      },
    );
  };

  const runSearchQuery = (query: string): void => {
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
  };

  /**
   * Runs the whole search route. Returns true when the key belonged to search,
   * which means it must never reach the interceptor, the controller, the draft
   * editor, or Pi.
   *
   * `/` opens search only on an empty draft; `Ctrl+F` is the conflict-safe
   * alias and is absent when the host owns it. Once open, EVERY byte is
   * consumed until Escape, which closes search and nothing else.
   */
  const handleSearchInput = (data: string): boolean => {
    const step = stepOverlaySearch(
      search,
      data,
      draftEditor.getText(),
      searchTrigger,
    );
    if (!step.claimed) return false;
    search = step.state;
    switch (step.effect.kind) {
      case "none":
        return true;
      case "repaint":
        requestPaint();
        return true;
      case "preview":
        previewSearchQuery(step.effect.query);
        return true;
      case "focus":
        focusSearchMatch();
        requestPaint();
        return true;
      case "run":
        runSearchQuery(step.effect.query);
        return true;
      case "close":
        exitSearch(true);
        return true;
    }
  };

  /**
   * Opens the in-overlay confirmation. Search is closed first so the two
   * modes can never be open at once, and the confirmation outranks search for
   * as long as it is up.
   */
  const openCancelConfirmation = (childId: string): boolean => {
    if (search.mode !== "off") exitSearch(false);
    confirmingCancelChildId = childId;
    requestPaint();
    return true;
  };

  /**
   * The cancel confirmation owns EVERY key while it is open.
   *
   * That is what makes `n` unambiguously NO and `y` unambiguously YES: with the
   * confirmation up, neither byte can reach search, the overlay actions, or the
   * draft editor. Escape dismisses the question and never closes the overlay.
   */
  const handleCancelConfirmInput = (data: string): boolean => {
    const childId = confirmingCancelChildId;
    if (childId === undefined) return false;
    const answer = answerOverlayCancelConfirm(data);
    if (answer === "swallow") return true;
    confirmingCancelChildId = undefined;
    if (answer === "confirm") {
      Result.fromThrowable(
        () => cancelSubtree?.(childId),
        () => "overlay_cancel_subtree_failed" as const,
      )().match(
        () => undefined,
        () => undefined,
      );
    }
    requestPaint();
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

  // `Ctrl+O` is absent on purpose: the overlay has one view, so the key stays
  // Pi's own tool-expand action and is never routed to the controller.
  const isControllerInput = (
    data: string,
    normalizedScroll: string | undefined,
  ): boolean =>
    normalizedScroll !== undefined ||
    matchesKey(data, "ctrl+e") ||
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
    const geometry = overlayPaneGeometry(outer, search.mode !== "off");
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
            searchIndex: new Map(),
          });
    if (transcript.isErr()) {
      emitFallback(transcript.error);
      return undefined;
    }

    // Search matches what the reader can read, so the painted rows' ANSI-free
    // twin is reported to the controller exactly like the measured extent
    // below.
    //
    // It is reported on EVERY render, not only while search is open. Pi may
    // coalesce repaints, so the render that opens the search field and the
    // render that would have published the index can be the same frame the
    // query is submitted in: a reader who typed `/query` and pressed Enter
    // without pausing was matched against an index that had never been
    // published, and read `no match in this transcript` for text plainly on
    // screen. The index is the latest rendered transcript, keyed by current
    // window entry ids and bounded by the window, so publishing it is a
    // constant-cost assignment and an empty query still matches nothing.
    controller.setRenderedSearchText(transcript.value.searchIndex).match(
      () => undefined,
      () => undefined,
    );
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
    const railLines =
      railWidth === undefined
        ? []
        : renderRailStatusMatrix(
            paint,
            railFacts,
            railWidth,
            room,
            nav.open ? searchRailSections(paint, nav, railWidth) : [],
          );
    const foldedRail =
      folded.length > 0 ? [...folded, overlayRuleRow(paint, inner)] : [];
    // The prototype's body owns every row the header and the prompt did not
    // reserve: the transcript window and the rail both pad themselves to it, so
    // the rail reads as one full column beside the transcript rather than as a
    // block that stops early. Budgeting the CANVAS, not the content, is the
    // locked composition (`bodyRightRail`).
    const main =
      railWidth === undefined
        ? [...foldedRail, ...pane]
        : joinColumns(
            [
              { lines: pane, width: geometry.pane },
              { lines: fitTo(railLines, room, "head"), width: railWidth },
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
    requestCancelConfirmation(childId) {
      if (finished) return false;
      return openCancelConfirmation(childId);
    },
    /**
     * THE PRECEDENCE CHAIN, in one place and in this order:
     *
     *     cancel confirmation › search › overlay keys › draft editor
     *
     * Nothing else reads keys while the overlay is mounted, so the order cannot
     * be reordered from elsewhere. A key release is dropped before any of it,
     * because a release is the same physical press reported twice.
     */
    handleInput(data) {
      if (finished || isKeyRelease(data)) return;
      Result.fromThrowable(
        () => {
          // 1. The confirmation consumes everything it is open for.
          if (handleCancelConfirmInput(data)) return;
          // 2. Search claims its openers and, once open, every byte until Esc.
          if (handleSearchInput(data)) return;
          const normalizedScroll = normalizeChildOverlayScrollFrame(data);
          const routedData = normalizedScroll ?? data;
          // 3. Overlay actions: Escape, planned child keys, Backspace, q.
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
          // 4. Whatever is left is text for the draft editor.
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
