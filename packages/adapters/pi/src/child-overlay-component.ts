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
): PiChildOverlayCustomComponent {
  const draftEditor = new CustomEditor(tui, theme, keybindings);
  const transcriptRenderer = createPiChildTranscriptRenderer();
  let componentFactory: PiTranscriptComponentFactory | undefined;
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let finished = false;
  let fallbackEmitted = false;
  let inputBusy = false;

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
    if (view.searchQuery.length > 0) {
      header.push(
        boundText(
          `Search: ${view.searchQuery} (${view.searchMatches.length} match${view.searchMatches.length === 1 ? "" : "es"})`,
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
