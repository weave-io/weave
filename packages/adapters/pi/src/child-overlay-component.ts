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

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
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
import { PI_CHILD_OVERLAY_SEARCH_TRIGGER } from "./child-overlay-keys.js";
import { boundText } from "./child-overlay-replay.js";
import {
  type ChildOverlayError,
  type ChildOverlayFallbackReason,
  type ChildOverlayFallbackRequired,
  type ChildOverlayInputOutcome,
  type ChildOverlayView,
  SCROLL_KEYS,
} from "./child-overlay-types.js";
import {
  createPiChildTranscriptRenderer,
  type PiTranscriptComponentFactory,
} from "./child-transcript.js";

// ---------------------------------------------------------------------------
// Native custom component (Task 12 phase B1)
// ---------------------------------------------------------------------------

/** Rows Pi keeps for its own footer, status, and padding around the overlay. */
const OVERLAY_RESERVED_HOST_ROWS = 6;

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
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
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
  theme: EditorTheme,
  keybindings: ConstructorParameters<typeof CustomEditor>[2],
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
): PiChildOverlayCustomComponent {
  const searchTrigger = searchRoute.trigger;
  const draftEditor = new CustomEditor(tui, theme, keybindings);
  const transcriptRenderer = createPiChildTranscriptRenderer();
  let componentFactory: PiTranscriptComponentFactory | undefined;
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let finished = false;
  let fallbackEmitted = false;
  let inputBusy = false;
  let searchMode: OverlaySearchMode = "off";
  let searchDraft = "";
  let searchMatchIndex = 0;

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

  const visibleHeight = (): number => {
    const rows = Result.fromThrowable(
      () => tui.terminal?.rows,
      () => "terminal_rows_unavailable" as const,
    )().unwrapOr(undefined);
    const usable = typeof rows === "number" && rows > 0 ? rows : 40;
    return Math.max(8, usable - OVERLAY_RESERVED_HOST_ROWS);
  };

  const syncDraftEditor = (view: ChildOverlayView): void => {
    if (view.readOnly) {
      if (draftEditor.getText() !== "") draftEditor.setText("");
      return;
    }
    if (draftEditor.getText() !== view.draft) draftEditor.setText(view.draft);
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
    const title = view.child.title ?? view.child.childId;
    const status = view.child.status.toUpperCase();
    const run =
      view.activeRun !== undefined ? `run ${view.activeRun}` : undefined;
    const branch =
      view.activeBranchId !== undefined
        ? `branch ${view.activeBranchId}`
        : undefined;
    const meta = [run, branch].filter((part) => part !== undefined).join(" · ");
    const header = [
      boundText(`◆ ${title} · ${status}`),
      ...(meta.length > 0 ? [boundText(meta)] : []),
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
    header.push("─".repeat(Math.min(width, 40)));
    return header;
  };

  const renderTranscriptLines = (
    view: ChildOverlayView,
    width: number,
  ): Result<readonly string[], ChildOverlayFallbackRequired> => {
    return Result.fromThrowable(
      () => {
        const rendered = transcriptRenderer.render(view.transcript, width, {
          componentFactory: factory(),
        });
        if (rendered.lines.length > 0) return rendered.lines;
        // Native factory may suppress bookkeeping rows; fall back to overlay
        // entry text so kinds remain visible in the bounded window.
        return view.entries.map((entry) =>
          boundText(
            entry.expanded || entry.text.length <= 120
              ? `[${entry.kind}] ${entry.text}`
              : `[${entry.kind}] ${entry.text.slice(0, 117)}…`,
          ),
        );
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
    const view = controller.view();
    if (view.isOk()) syncDraftEditor(view.value);
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
      const nearOldest =
        view.scrollOffset >= Math.max(0, view.entries.length - 1);
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

  return {
    render(width) {
      return Result.fromThrowable(
        (): string[] => {
          if (finished) return lines;
          const resized = controller.resize(width, visibleHeight());
          if (resized.isErr()) {
            if (isOverlayFallbackRequired(resized.error)) {
              emitFallback(resized.error);
            } else if (
              !("type" in resized.error) ||
              resized.error.type !== "OverlayNotOpen"
            ) {
              emitFallback("render-failed");
            }
            return lines;
          }
          const view = resized.value;
          if (dirty || width !== lastWidth) {
            syncDraftEditor(view);
            const header = headerLines(view, width);
            const editorLines = renderEditorLines(width, view.readOnly);
            const transcript = renderTranscriptLines(view, width);
            if (transcript.isErr()) {
              emitFallback(transcript.error);
              return lines;
            }
            const budget = Math.max(
              1,
              visibleHeight() - editorLines.length - header.length - 1,
            );
            const scrollMax = Math.max(0, transcript.value.length - budget);
            const scrollOffset = Math.min(view.scrollOffset, scrollMax);
            const end = transcript.value.length - scrollOffset;
            lines = [
              ...header,
              ...transcript.value.slice(Math.max(0, end - budget), end),
              ...(scrollOffset > 0
                ? [
                    boundText(
                      `${scrollOffset} newer line(s) below — End follows output`,
                    ),
                  ]
                : []),
              ...editorLines,
            ];
            dirty = false;
            lastWidth = width;
          }
          return lines;
        },
        (): string[] => {
          emitFallback("render-failed");
          return lines;
        },
      )().unwrapOr(lines);
    },
    handleInput(data) {
      if (finished || inputBusy) return;
      Result.fromThrowable(
        () => {
          // Search owns the keyboard whenever it is open, so no key can reach
          // the interceptor, the draft editor, or Pi while the prompt is up.
          if (handleSearchInput(data)) return;
          if (keyInterceptor !== undefined) {
            const consumed = Result.fromThrowable(
              () => keyInterceptor(data),
              () => "overlay_key_interceptor_failed" as const,
              // A failing interceptor must not leak the key onward, so an
              // exception is treated as "consumed" rather than "ignored".
            )().unwrapOr(true);
            if (consumed) return;
          } else if (
            keybindings.matches(data, "tui.select.cancel") ||
            data === "\x1b"
          ) {
            // Without Task 13 mounted, Escape keeps its Task 12 meaning.
            finish();
            return;
          }
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
