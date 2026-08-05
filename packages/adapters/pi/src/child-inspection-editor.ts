import { ok, type Result } from "neverthrow";
import type {
  PiChildInspector,
  PiInspectorChild,
  PiInspectorView,
} from "./child-inspector.js";
import {
  classifyChildInspectorKey,
  type PiChildInspectorKey,
} from "./child-tree-keys.js";

export interface PiChildInspectionEditorHost {
  readonly getDraft?: () => string;
  readonly setDraft?: (draft: string) => void;
  readonly defaultInput?: (data: string) => void;
  readonly beforeInput?: () => void;
  readonly openPicker?: () => void;
  readonly onViewChange?: (view: PiInspectorView) => void;
  readonly onSlashCommand?: (command: "inspect" | "clear-children") => void;
  readonly confirm?: import("./child-inspector.js").PiInspectorConfirmation;
}
export type PiChildInspectionEditorResult =
  | {
      readonly kind: "handled";
      readonly key: PiChildInspectorKey;
      readonly operation?: unknown;
    }
  | { readonly kind: "host-default" }
  | { readonly kind: "rejected"; readonly reason: string };

/** Compositional editor wrapper. It owns inspection state and leaves Pi's editor as the host boundary. */
export class PiChildInspectionEditor {
  private view: PiInspectorView | undefined;
  constructor(
    readonly inspector: PiChildInspector,
    private readonly host: PiChildInspectionEditorHost = {},
  ) {}
  attach(view: PiInspectorView): void {
    this.view = view;
  }
  detach(): PiInspectorView | undefined {
    if (this.view) this.inspector.saveState(this.view);
    const view = this.view;
    this.view = undefined;
    return view;
  }
  currentView(): PiInspectorView | undefined {
    return this.view;
  }
  handleInput(data: string): Result<PiChildInspectionEditorResult, never> {
    this.host.beforeInput?.();
    if (/^\s*\/\S+/.test(data)) {
      const isParentView =
        this.view?.childId === this.inspector.rootId ||
        (this.view === undefined &&
          this.inspector.current() === this.inspector.rootId);
      const command = /^\s*\/weave:(inspect|clear-children)\s*$/.exec(
        data,
      )?.[1] as "inspect" | "clear-children" | undefined;
      if (!isParentView)
        return ok({
          kind: "rejected",
          reason: "slash command is not allowed in a child view",
        });
      if (command === undefined) {
        this.host.defaultInput?.(data);
        return ok({ kind: "host-default" });
      }
      this.host.onSlashCommand?.(command);
      if (command === "inspect") this.host.openPicker?.();
      return ok({ kind: "handled", key: { kind: "open-picker" } });
    }
    const key = classifyChildInspectorKey(data);
    if (!key || !this.view) {
      if (this.view?.readOnly)
        return ok({ kind: "rejected", reason: "completed child is read-only" });
      this.host.defaultInput?.(data);
      return ok({ kind: "host-default" });
    }
    const currentChild = this.inspector.child(this.view.childId);
    if (
      this.inspector.current() !== this.view.childId ||
      currentChild?.generationId !== this.view.generationId
    )
      return ok({ kind: "rejected", reason: "stale inspector view" });
    if (key.kind === "open-picker") {
      this.host.openPicker?.();
      return ok({ kind: "handled", key });
    }
    if (key.kind === "select-direct-child") {
      const childId = this.inspector.slots.childAt(key.index);
      if (childId !== undefined) this.switchTo(childId);
      return ok({ kind: "handled", key });
    }
    if (key.kind === "select-parent") {
      if (this.view.state.draft.length > 0) {
        this.host.defaultInput?.(data);
        return ok({ kind: "host-default" });
      }
      const child = this.inspector.child(this.view.childId);
      if (child !== undefined && this.view.childId !== this.inspector.rootId) {
        // A top-level child has no explicit parent; the root view is its parent,
        // so navigation never dead-ends inside an inspected child.
        this.switchTo(child.parentId ?? this.inspector.rootId);
        return ok({ kind: "handled", key });
      }
      this.host.defaultInput?.(data);
      return ok({ kind: "host-default" });
    }
    if (key.kind === "cancel-selected") {
      const child = this.inspector.child(this.view.childId);
      if (
        !child ||
        child.childId === this.inspector.rootId ||
        !this.host.confirm
      ) {
        this.host.defaultInput?.(data);
        return ok({ kind: "host-default" });
      }
      const operation = this.inspector.escape(
        child,
        this.view.generationId ?? "",
        this.host.confirm,
      );
      return ok({ kind: "handled", key, operation });
    }
    const child = this.inspector.child(this.view.childId);
    const message = this.view.state.draft;
    if (this.view.childId === this.inspector.rootId) {
      this.host.defaultInput?.(data);
      return ok({ kind: "host-default" });
    }
    if (
      !child ||
      child.status !== "running" ||
      !message.trim() ||
      !child.generationId
    ) {
      return ok({ kind: "handled", key });
    }
    const operation =
      key.kind === "steer"
        ? this.inspector.steer(child, child.generationId, message)
        : this.inspector.followUp(child, child.generationId, message);
    this.updateDraft("");
    return ok({ kind: "handled", key, operation });
  }
  updateDraft(draft: string): void {
    this.updateViewState({ draft });
  }
  updateViewState(
    update: import("./child-inspector.js").PiInspectorViewStateUpdate,
  ): void {
    if (this.view) {
      const state = this.inspector.updateState(this.view.childId, update);
      this.view = { ...this.view, state };
      if (update.draft !== undefined) this.host.setDraft?.(update.draft);
      this.host.onViewChange?.(this.view);
    }
  }
  updateScrollOffset(scrollOffset: number): void {
    this.updateViewState({ scrollOffset });
  }
  updateExpandedTools(expandedTools: readonly string[]): void {
    this.updateViewState({ expandedTools });
  }
  updateThinkingVisible(thinkingVisible: boolean): void {
    this.updateViewState({ thinkingVisible });
  }
  updateImagesVisible(imagesVisible: boolean): void {
    this.updateViewState({ imagesVisible });
  }
  updateQueue(queue: readonly string[]): void {
    this.updateViewState({ queue });
  }
  open(
    child: PiInspectorChild,
    known: readonly PiInspectorChild[],
  ): ReturnType<PiChildInspector["open"]> {
    this.inspector.setKnownChildren(known);
    return this.switchTo(child.childId, known);
  }
  syncChildren(children: readonly PiInspectorChild[]): void {
    const currentId = this.view?.childId;
    const current = this.inspector
      .knownChildren()
      .find((child) => child.childId === currentId);
    this.inspector.setKnownChildren(
      current === undefined ? children : [current, ...children],
    );
  }
  private switchTo(
    childId: string,
    known = this.inspector.knownChildren(),
  ): ReturnType<PiChildInspector["open"]> {
    if (this.view) this.inspector.saveState(this.view);
    const opened = this.inspector.open(childId, known);
    if (opened.isOk()) {
      this.attach(opened.value);
      this.host.setDraft?.(opened.value.state.draft);
      this.host.onViewChange?.(opened.value);
    }
    return opened;
  }
}
export function createChildInspectionEditor(
  inspector: PiChildInspector,
  host?: PiChildInspectionEditorHost,
): PiChildInspectionEditor {
  return new PiChildInspectionEditor(inspector, host);
}
