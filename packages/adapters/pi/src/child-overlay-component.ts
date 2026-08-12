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
import type { PiChildOverlayKeyInterceptor } from "./child-overlay-keys.js";
import {
  PI_CHILD_OVERLAY_SEARCH_TRIGGER,
  PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER,
} from "./child-overlay-keys.js";
import { boundText } from "./child-overlay-replay.js";
import type { OverlayLayoutSpan } from "./child-overlay-scroll.js";
import { normalizeChildOverlayScrollFrame } from "./child-overlay-terminal-input.js";
import {
  type ChildOverlayEntry,
  type ChildOverlayError,
  type ChildOverlayFallbackReason,
  type ChildOverlayFallbackRequired,
  type ChildOverlayInputOutcome,
  type ChildOverlayTelemetry,
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
import {
  fitLineToWidth,
  fitLineWithSuffix,
  fitRuleToWidth,
  frameLinesToWidth,
  overlayFrameGeometry,
} from "./render-width.js";
import type { PiUiThemePort } from "./types.js";

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
 * - No `minWidth` is set. A minimum wider than the terminal would force Pi to
 *   hand the component a width it cannot honor, and an over-wide line aborts
 *   Pi. Narrowness is handled by dropping the border, never by overflowing.
 */
export const PI_CHILD_OVERLAY_CUSTOM_OPTIONS = Object.freeze({
  overlay: true,
  overlayOptions: Object.freeze({
    anchor: "center",
    width: "90%",
    maxHeight: "90%",
    margin: 1,
  }),
} as const);

const DEFAULT_TERMINAL_ROWS = 40;

/**
 * Honest placeholder for any telemetry field the host did not report.
 *
 * Pin this exact character in render tests. Never invent `0`, `0%`, or an
 * empty segment for an unknown value.
 */
const TELEMETRY_UNAVAILABLE = "—";

/**
 * Compact a bounded token count for the overlay header.
 *
 * Keeps labels short enough for narrow terminals while staying exact for
 * sub-thousand counts. Values already passed Zod ceilings in Task 5.
 */
function formatOverlayTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return TELEMETRY_UNAVAILABLE;
  const n = Math.floor(count);
  if (n < 1_000) return String(n);
  if (n < 1_000_000) {
    const k = Math.round((n / 1_000) * 10) / 10;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  if (n < 1_000_000_000) {
    const m = Math.round((n / 1_000_000) * 10) / 10;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  const g = Math.round((n / 1_000_000_000) * 10) / 10;
  return Number.isInteger(g) ? `${g}B` : `${g.toFixed(1)}B`;
}

/**
 * One consistent header meta line for {@link ChildOverlayView.telemetry}.
 *
 * Absent fields always render {@link TELEMETRY_UNAVAILABLE}. Context percent
 * is shown only when the view already derived it from both host operands;
 * unknown context never becomes `0%`.
 */
export function formatChildOverlayTelemetryLine(
  telemetry: ChildOverlayTelemetry | undefined,
): string {
  const provider =
    telemetry?.provider !== undefined && telemetry.provider.length > 0
      ? telemetry.provider
      : TELEMETRY_UNAVAILABLE;
  const model =
    telemetry?.model !== undefined && telemetry.model.length > 0
      ? telemetry.model
      : TELEMETRY_UNAVAILABLE;
  const ctx =
    telemetry?.contextPercent !== undefined
      ? `${telemetry.contextPercent}%`
      : TELEMETRY_UNAVAILABLE;
  const input =
    telemetry?.inputTokens !== undefined
      ? formatOverlayTokenCount(telemetry.inputTokens)
      : TELEMETRY_UNAVAILABLE;
  const output =
    telemetry?.outputTokens !== undefined
      ? formatOverlayTokenCount(telemetry.outputTokens)
      : TELEMETRY_UNAVAILABLE;
  return `${provider} · ${model} · ctx ${ctx} · ${input} in / ${output} out`;
}

// ---------------------------------------------------------------------------
// Compact view projection (Task 7)
// ---------------------------------------------------------------------------

/** Header marker shown while a child renders in compact mode. */
export const CHILD_OVERLAY_COMPACT_BADGE = "COMPACT" as const;

/** Help row documenting the compact toggle; shown only when the key is free. */
export const CHILD_OVERLAY_COMPACT_HELP_LINE =
  "Ctrl+O toggles compact view" as const;

/** Characters kept from one entry's text before the width fit trims further. */
const COMPACT_SUMMARY_MAX = 160;

/** Stable one-character kind marks; never a path, id, or free-form label. */
const COMPACT_KIND_MARKS: Readonly<Record<string, string>> = Object.freeze({
  prompt: "›",
  user: "›",
  steering: "›",
  "follow-up": "›",
  assistant: "•",
  thinking: "~",
  tool: "⚙",
  error: "!",
  retry: "↻",
  image: "▣",
  status: "·",
  unknown: "?",
});

/**
 * Collapse one bounded overlay entry into a single summary line.
 *
 * Pure and render-time only: the entry itself is never rewritten, so toggling
 * back to full view restores the untouched transcript. Run dividers keep their
 * own shape so the run structure survives the condensation.
 */
export function compactChildOverlayEntryLine(
  entry: ChildOverlayEntry,
  width: number,
): string {
  const flattened = boundText(entry.text)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, COMPACT_SUMMARY_MAX);
  if (entry.kind === "run-divider") {
    const numbered =
      entry.runNumber !== undefined ? `run ${entry.runNumber}` : "run";
    const label = flattened.length > 0 ? flattened : numbered;
    return fitLineToWidth(`── ${label} ──`, width);
  }
  const mark = COMPACT_KIND_MARKS[entry.kind] ?? COMPACT_KIND_MARKS.unknown;
  const run = entry.runNumber !== undefined ? `r${entry.runNumber} ` : "";
  return fitLineToWidth(
    `${mark} ${run}${entry.kind}${flattened.length > 0 ? `: ${flattened}` : ""}`,
    width,
  );
}

/**
 * Project the loaded entry window into compact summary rows, in order.
 *
 * This is the compact counterpart of the native transcript render and reads
 * the same bounded entries the controller already holds.
 */
export function compactChildOverlayLines(
  entries: readonly ChildOverlayEntry[],
  width: number,
): readonly string[] {
  return entries.map((entry) => compactChildOverlayEntryLine(entry, width));
}

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

  const headerLines = (view: ChildOverlayView, width: number): string[] => {
    const title = boundText(view.child.title ?? view.child.childId);
    const status = view.child.status.toUpperCase();
    const badge =
      view.viewMode === "compact" ? ` · ${CHILD_OVERLAY_COMPACT_BADGE}` : "";
    const run =
      view.activeRun !== undefined ? `run ${view.activeRun}` : undefined;
    const branch =
      view.activeBranchId !== undefined
        ? `branch ${view.activeBranchId}`
        : undefined;
    const meta = [run, branch].filter((part) => part !== undefined).join(" · ");
    // Reserve ` · STATUS` so a narrow terminal truncates the title, not the
    // live/settled marker the reader needs (Task 20(f) width-51 crash).
    const header = [
      fitLineWithSuffix(`◆ ${title}`, ` · ${status}${badge}`, width),
      ...(meta.length > 0 ? [boundText(meta)] : []),
      // Always one telemetry row: every absent field is `—`, never guessed.
      fitLineToWidth(
        boundText(formatChildOverlayTelemetryLine(view.telemetry)),
        width,
      ),
    ];
    if (view.readOnly) {
      header.push(
        boundText(
          view.child.status === "orphan"
            ? "Read-only orphan — mutations disabled"
            : "Read-only — settled child",
        ),
      );
    }
    if (view.searchQuery.length > 0 && searchMode !== "typing") {
      const total = view.searchMatches.length;
      const position = total === 0 ? 0 : searchMatchIndex + 1;
      header.push(
        boundText(
          `Search: ${view.searchQuery} (${position}/${total} match${total === 1 ? "" : "es"})`,
        ),
      );
    }
    if (searchMode === "typing") {
      header.push(boundText(`Search: ${searchDraft}\u258f`));
    }
    if (searchMode !== "off") {
      header.push(
        boundText(
          searchMode === "typing"
            ? "Enter searches · Esc cancels search"
            : "n next match · N previous match · Esc exits search",
        ),
      );
    }
    header.push(fitRuleToWidth("─", width, 40));
    return header;
  };

  /**
   * Pi does not enable terminal mouse reporting, so wheel events cannot reach
   * this component. Keep the keyboard controls visible until Pi adds a mouse
   * input surface.
   */
  const helpLines = (view: ChildOverlayView, width: number): string[] => {
    const help = [
      "Scroll: PgUp/PgDn or Shift+↑/↓ · Home/End · mouse wheel unavailable",
    ];
    if (!view.readOnly) {
      help.push("Enter steers · Alt+Enter queues a follow-up");
      help.push("q cancels this child (confirm required) · Esc exits");
    }
    if (viewModeTrigger !== undefined) {
      help.push(`${CHILD_OVERLAY_COMPACT_HELP_LINE} (now ${view.viewMode})`);
    }
    return help.map((line) => fitLineToWidth(boundText(line), width));
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
    if (data === SCROLL_KEYS.pageUp && view.hasOlder) {
      // Older pages load once the viewport sits on the oldest rendered row.
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
      const frame = overlayFrameGeometry(outerWidth);
      const width = frame.innerWidth;
      const rendered = Result.fromThrowable(
        (): string[] => {
          if (finished) return lines;
          const rowLimit = usableRows();
          const innerRows = Math.max(0, rowLimit - frame.reservedRows);
          const current = controller.view();
          if (current.isErr()) return lines;
          let view = current.value;
          if (dirty || width !== lastWidth || rowLimit !== lastUsableRows) {
            syncDraftEditorTransition(view);
            const header = headerLines(view, width);
            const help = helpLines(view, width);
            const editor = renderEditorLines(width, view.readOnly).slice(
              -innerRows,
            );
            let leadingRows = Math.max(0, innerRows - editor.length);
            const visibleHeader = header.slice(0, leadingRows);
            leadingRows -= visibleHeader.length;
            const visibleHelp = help.slice(0, leadingRows);
            leadingRows -= visibleHelp.length;
            const transcriptBudget = Math.max(0, leadingRows);
            const viewport = controller.resize(
              width,
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
              return lines;
            }
            view = viewport.value;
            const transcript =
              transcriptBudget > 0
                ? renderTranscriptLines(view, width)
                : ok<OverlayRenderedTranscript, ChildOverlayFallbackRequired>({
                    lines: [],
                    spans: [],
                  });
            if (transcript.isErr()) {
              emitFallback(transcript.error);
              return lines;
            }

            const transcriptLines = transcript.value.lines;
            const contentBudget =
              view.scrollOffset > 0 && transcriptBudget > 0
                ? transcriptBudget - 1
                : transcriptBudget;
            const scrollMax = Math.max(
              0,
              transcriptLines.length - contentBudget,
            );
            // Spans travel with the extent so the controller can translate a
            // logical viewport into this layout's rendered rows.
            let scrollOffset = controller
              .setScrollExtent(scrollMax, transcript.value.spans)
              .match(
                (measured) => measured.scrollOffset,
                () => view.scrollOffset,
              );
            scrollOffset = Math.min(scrollOffset, scrollMax);
            const end = transcriptLines.length - scrollOffset;
            const visibleTranscript = transcriptLines.slice(
              Math.max(0, end - contentBudget),
              end,
            );
            lines = [
              ...visibleHeader,
              ...visibleTranscript,
              ...(scrollOffset > 0 && transcriptBudget > 0
                ? [
                    fitLineToWidth(
                      boundText(
                        `${scrollOffset} newer line(s) below — End follows output`,
                      ),
                      width,
                    ),
                  ]
                : []),
              ...visibleHelp,
              ...editor,
            ].slice(0, innerRows);
            dirty = false;
            lastWidth = width;
            lastUsableRows = rowLimit;
          }
          return lines;
        },
        (): string[] => {
          emitFallback("render-failed");
          return lines;
        },
      )().unwrapOr(lines);
      return frameLinesToWidth(rendered, outerWidth).slice(0, usableRows());
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
