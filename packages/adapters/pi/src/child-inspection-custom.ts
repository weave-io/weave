import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { PiChildInspectionEditor } from "./child-inspection-editor.js";
import {
  createChildInspectionRenderer,
  type PiChildInspectionRenderInput,
} from "./child-inspection-render.js";

export interface PiCustomTui {
  readonly width?: number;
  requestRender(): void;
}

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
): PiChildInspectionCustomComponent {
  const renderer = createChildInspectionRenderer();
  const input = new CustomEditor(tui, theme, keybindings);
  let dirty = true;
  let lines: string[] = [];
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done();
  };
  const syncInput = (): void => {
    const draft = getDraft();
    if (input.getText() !== draft) input.setText(draft);
  };
  return {
    render(width) {
      if (dirty) {
        syncInput();
        const output = renderer.render(getInput(), width);
        lines = [
          ...output.match(
            (value) => value.lines,
            () => [],
          ),
          `> ${input.getText()}`,
        ];
        dirty = false;
      }
      return lines;
    },
    handleInput(data) {
      syncInput();
      const result = editor.handleInput(data);
      if (result.isOk() && result.value.kind === "host-default") {
        input.handleInput(data);
        setDraft(input.getText());
      } else if (result.isOk() && result.value.kind !== "host-default") {
        input.setText(getDraft());
      }
      const isEscape = keybindings.matches(data, "tui.select.cancel");
      if (
        editor.currentView()?.childId === editor.inspector.rootId &&
        isEscape
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
