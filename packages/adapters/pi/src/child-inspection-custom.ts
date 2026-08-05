import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Result } from "neverthrow";
import type { PiChildInspectionEditor } from "./child-inspection-editor.js";
import {
  createChildInspectionRenderer,
  type PiChildInspectionRenderInput,
} from "./child-inspection-render.js";
import {
  createPiNativeTranscriptComponentFactory,
  type PiNativeTranscriptComponentDeps,
} from "./child-native-components.js";

export interface PiCustomTui {
  readonly width?: number;
  requestRender(): void;
}

/** Rows Pi keeps for its own footer, status, and padding around the editor. */
const RESERVED_HOST_ROWS = 6;

/** Scroll gestures the view owns; everything else reaches the child editor. */
const SCROLL_KEYS = {
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  shiftUp: "\x1b[1;2A",
  shiftDown: "\x1b[1;2B",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

const SCROLL_PAGE = 10;

export interface PiChildInspectionCustomComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

/** Real Pi custom UI component for child inspection. */
export function createChildInspectionCustomComponent(
  tui: PiCustomTui & TUI,
  theme: EditorTheme,
  keybindings: ConstructorParameters<typeof CustomEditor>[2],
  editor: PiChildInspectionEditor,
  getInput: () => PiChildInspectionRenderInput,
  getDraft: () => string,
  setDraft: (draft: string) => void,
  done: () => void,
  nativeDeps?: Omit<PiNativeTranscriptComponentDeps, "tui">,
): PiChildInspectionCustomComponent {
  const renderer = createChildInspectionRenderer({
    componentFactory: createPiNativeTranscriptComponentFactory({
      ...nativeDeps,
      cwd: nativeDeps?.cwd ?? ".",
      tui,
    }),
  });
  const input = new CustomEditor(tui, theme, keybindings);
  const renderEditor = (width: number): string[] => {
    const rendered = Result.fromThrowable(
      () => input.render(width),
      () => "editor_render_failed",
    )().unwrapOr([]);
    return Array.isArray(rendered) && rendered.length > 0
      ? rendered
      : [`> ${input.getText()}`];
  };
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let finished = false;
  /**
   * The view lives in Pi's fixed editor region, so an unbounded transcript
   * pushes newly streamed lines out of sight. Keep the newest output, which is
   * what a streaming child is watched for.
   */
  const visibleHeight = (): number => {
    const rows = Result.fromThrowable(
      () => tui.terminal?.rows,
      () => "terminal_rows_unavailable",
    )().unwrapOr(undefined);
    const usable = typeof rows === "number" && rows > 0 ? rows : 40;
    return Math.max(8, usable - RESERVED_HOST_ROWS);
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done();
  };
  const syncInput = (): void => {
    const draft = getDraft();
    if (input.getText() !== draft) input.setText(draft);
  };
  /** Lines held back from the bottom; 0 follows the live tail. */
  let scrollOffset = editor.currentView()?.state.scrollOffset ?? 0;
  let scrollMax = 0;
  const scrollBy = (delta: number): void => {
    const next = Math.min(Math.max(0, scrollOffset + delta), scrollMax);
    if (next === scrollOffset) return;
    scrollOffset = next;
    editor.updateScrollOffset(next);
    dirty = true;
  };
  const scrollKey = (
    data: string,
  ): number | "oldest" | "follow" | undefined => {
    if (data === SCROLL_KEYS.pageUp) return SCROLL_PAGE;
    if (data === SCROLL_KEYS.pageDown) return -SCROLL_PAGE;
    if (data === SCROLL_KEYS.shiftUp) return 1;
    if (data === SCROLL_KEYS.shiftDown) return -1;
    if (data === SCROLL_KEYS.home) return "oldest";
    if (data === SCROLL_KEYS.end) return "follow";
    return undefined;
  };
  return {
    render(width) {
      // A resize changes every padded native line, so width is part of the
      // cache key, not just the dirty flag.
      if (dirty || width !== lastWidth) {
        renderer.invalidate();
        syncInput();
        const output = renderer.render(getInput(), width);
        const editorLines = renderEditor(width);
        const view = output.match(
          (value) => ({
            header: [
              value.breadcrumb,
              value.statusLine,
              ...value.markers,
              ...value.taskPreviewLines,
              "\u2500".repeat(Math.min(width, 40)),
            ],
            transcript: value.transcript.lines,
          }),
          () => ({ header: [] as string[], transcript: [] as string[] }),
        );
        const budget = Math.max(
          1,
          visibleHeight() - editorLines.length - view.header.length - 1,
        );
        scrollMax = Math.max(0, view.transcript.length - budget);
        scrollOffset = Math.min(scrollOffset, scrollMax);
        const end = view.transcript.length - scrollOffset;
        lines = [
          ...view.header,
          ...view.transcript.slice(Math.max(0, end - budget), end),
          ...(scrollOffset > 0
            ? [`${scrollOffset} newer line(s) below \u2014 End follows output`]
            : []),
          ...editorLines,
        ];
        dirty = false;
        lastWidth = width;
      }
      return lines;
    },
    handleInput(data) {
      const scroll = scrollKey(data);
      if (scroll !== undefined) {
        if (scroll === "oldest") scrollBy(scrollMax);
        else if (scroll === "follow") scrollBy(-scrollMax);
        else scrollBy(scroll);
        tui.requestRender();
        return;
      }
      syncInput();
      const result = editor.handleInput(data);
      if (result.isOk() && result.value.kind === "host-default") {
        input.handleInput(data);
        setDraft(input.getText());
      } else if (result.isOk() && result.value.kind !== "host-default") {
        input.setText(getDraft());
      }
      const isEscape = keybindings.matches(data, "tui.select.cancel");
      const view = editor.currentView();
      // Escape must always have an exit: at the root view, and in a completed
      // child view where cancelling has nothing left to stop.
      if (
        isEscape &&
        (view?.childId === editor.inspector.rootId || view?.readOnly === true)
      ) {
        finish();
        return;
      }
      dirty = true;
      renderer.invalidate();
      tui.requestRender();
    },
    invalidate() {
      dirty = true;
      renderer.invalidate();
    },
  };
}
