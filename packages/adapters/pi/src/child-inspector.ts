import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import type { PiChildPickerNode } from "./child-picker.js";

export type PiInspectorStatus =
  | "queued"
  | "spawning"
  | "handshaking"
  | "bootstrapping"
  | "running"
  | "cancelling"
  | "settled"
  | "interrupted"
  | "failed"
  | "cancelled";
export interface PiInspectorChild extends PiChildPickerNode {
  readonly status: PiInspectorStatus;
  readonly descendants?: readonly PiInspectorChild[];
}
export interface PiInspectorViewState {
  readonly draft: string;
  readonly scrollOffset: number;
  readonly expandedTools: readonly string[];
  readonly thinkingVisible: boolean;
  readonly imagesVisible: boolean;
  readonly queue: readonly string[];
}
export type PiInspectorViewStateUpdate = Partial<PiInspectorViewState>;

export const EMPTY_INSPECTOR_VIEW_STATE: PiInspectorViewState = {
  draft: "",
  scrollOffset: 0,
  expandedTools: [],
  thinkingVisible: true,
  imagesVisible: true,
  queue: [],
};
export interface PiInspectorView {
  readonly childId: string;
  readonly generationId: string | undefined;
  readonly state: PiInspectorViewState;
  readonly readOnly: boolean;
}
export interface PiInspectorRpc {
  steer(
    childId: string,
    generationId: string,
    message: string,
  ): ResultAsyncType<void, unknown>;
  followUp(
    childId: string,
    generationId: string,
    message: string,
  ): ResultAsyncType<void, unknown>;
  cancel(childId: string, generationId: string): ResultAsyncType<void, unknown>;
}
export interface PiInspectorConfirmation {
  confirm(
    message: string,
    options?: { readonly timeout?: number },
  ): ResultAsyncType<boolean, unknown> | Result<boolean, unknown>;
}
export type PiInspectorError =
  | { readonly type: "child-not-running" }
  | { readonly type: "stale-view" }
  | { readonly type: "invalid-message" }
  | { readonly type: "cancel-rejected" }
  | { readonly type: "not-found" };

/** Stable numeric slots. Queued and terminal children never consume a slot. */
export class PiChildSlots {
  private readonly slots = new Map<number, string>();
  assign(children: readonly PiInspectorChild[]): ReadonlyMap<number, string> {
    const live = children.filter((child) =>
      [
        "spawning",
        "handshaking",
        "bootstrapping",
        "running",
        "cancelling",
      ].includes(child.status),
    );
    const liveIds = new Set(live.map((child) => child.childId));
    // Slots describe the current live, non-queued set. A queued child never
    // owns a slot, and a transition out of that set releases it immediately.
    for (const [slot, id] of this.slots) {
      if (!liveIds.has(id)) this.slots.delete(slot);
    }
    for (const child of live) {
      if ([...this.slots.values()].includes(child.childId)) continue;
      for (let slot = 1; slot <= 9; slot += 1)
        if (!this.slots.has(slot)) {
          this.slots.set(slot, child.childId);
          break;
        }
    }
    return new Map(this.slots);
  }
  childAt(slot: number): string | undefined {
    return this.slots.get(slot);
  }
  assignTree(
    children: readonly { readonly id: string; readonly status: string }[],
  ): ReadonlyMap<number, string> {
    return this.assign(
      children.map((child) => ({
        childId: child.id,
        status: child.status as PiInspectorStatus,
        name: "",
        kind: "ordinary" as const,
        live: true,
      })),
    );
  }
  release(childId: string): void {
    for (const [slot, id] of this.slots)
      if (id === childId) this.slots.delete(slot);
  }
}

function flatten(
  root: PiInspectorChild,
  out: PiInspectorChild[] = [],
): PiInspectorChild[] {
  out.push(root);
  for (const child of root.descendants ?? []) flatten(child, out);
  return out;
}
function asAsync<T>(
  value: ResultAsyncType<T, unknown> | Result<T, unknown>,
): ResultAsyncType<T, unknown> {
  if ("then" in value) return value;
  return value.isOk() ? okAsync(value.value) : errAsync(value.error);
}

export class PiChildInspector {
  readonly slots = new PiChildSlots();
  private readonly views = new Map<string, PiInspectorViewState>();
  private readonly children = new Map<string, PiInspectorChild>();
  private currentId: string;
  constructor(
    readonly rootId: string,
    private readonly rpc: PiInspectorRpc,
    current?: string,
  ) {
    this.currentId = current ?? rootId;
  }
  current(): string {
    return this.currentId;
  }
  setChildren(root: PiInspectorChild): ReadonlyMap<number, string> {
    const all = flatten(root);
    this.children.clear();
    for (const child of all) this.children.set(child.childId, child);
    return this.slots.assign(all.filter((c) => c.childId !== this.rootId));
  }
  setKnownChildren(children: readonly PiInspectorChild[]): void {
    this.children.clear();
    for (const child of children) this.children.set(child.childId, child);
    this.slots.assign(
      children.filter((child) => child.childId !== this.rootId),
    );
  }
  knownChildren(): readonly PiInspectorChild[] {
    return [...this.children.values()];
  }
  child(childId = this.currentId): PiInspectorChild | undefined {
    return this.children.get(childId);
  }
  open(
    childId: string,
    known: readonly PiInspectorChild[],
  ): Result<PiInspectorView, PiInspectorError> {
    this.setKnownChildren(known);
    const child = known.find((c) => c.childId === childId);
    if (!child) return err({ type: "not-found" });
    this.currentId = childId;
    const state = this.views.get(childId) ?? EMPTY_INSPECTOR_VIEW_STATE;
    this.views.set(childId, state);
    return ok({
      childId,
      generationId: child.generationId,
      state,
      readOnly: child.status !== "running",
    });
  }
  saveState(view: PiInspectorView): void {
    this.views.set(view.childId, { ...view.state });
  }
  updateState(
    childId: string,
    update: PiInspectorViewStateUpdate,
  ): PiInspectorViewState {
    const next = {
      ...(this.views.get(childId) ?? EMPTY_INSPECTOR_VIEW_STATE),
      ...update,
    };
    this.views.set(childId, next);
    return next;
  }
  state(childId: string): PiInspectorViewState | undefined {
    return this.views.get(childId);
  }
  parent(
    child: PiInspectorChild,
    known: readonly PiInspectorChild[],
  ): Result<PiInspectorView, PiInspectorError> {
    return this.open(child.parentId ?? this.rootId, known);
  }
  private running(
    child: PiInspectorChild,
    generationId: string,
  ): Result<void, PiInspectorError> {
    if (child.status !== "running" || !generationId)
      return err({ type: "child-not-running" });
    if (child.generationId !== undefined && child.generationId !== generationId)
      return err({ type: "stale-view" });
    return ok(undefined);
  }
  steer(
    child: PiInspectorChild,
    generationId: string,
    message: string,
  ): ResultAsyncType<void, PiInspectorError> {
    const valid = this.running(child, generationId);
    if (valid.isErr()) return errAsync(valid.error);
    if (!message.trim()) return errAsync({ type: "invalid-message" });
    return this.rpc
      .steer(child.childId, generationId, message)
      .mapErr(() => ({ type: "stale-view" as const }));
  }
  followUp(
    child: PiInspectorChild,
    generationId: string,
    message: string,
  ): ResultAsyncType<void, PiInspectorError> {
    const valid = this.running(child, generationId);
    if (valid.isErr()) return errAsync(valid.error);
    if (!message.trim()) return errAsync({ type: "invalid-message" });
    return this.rpc
      .followUp(child.childId, generationId, message)
      .mapErr(() => ({ type: "stale-view" as const }));
  }
  escape(
    child: PiInspectorChild,
    generationId: string,
    confirmation: PiInspectorConfirmation,
  ): ResultAsyncType<void, PiInspectorError> {
    const valid = this.running(child, generationId);
    if (valid.isErr()) return errAsync(valid.error);
    const descendants = flatten(child).slice(1);
    const tool = child.currentTool
      ? ` current tool ${child.currentTool}`
      : " current tool none";
    const descendantText =
      descendants.length === 0
        ? " no descendants"
        : ` descendants ${descendants.map((item) => item.name).join(", ")}`;
    const message = `Cancel child ${child.name}${tool};${descendantText}?`;
    const answer = ResultAsync.fromThrowable(
      async () =>
        await asAsync(confirmation.confirm(message, { timeout: undefined })),
      () => undefined,
    )().andThen((result) => result);
    return answer
      .andThen((confirmed) => {
        if (!confirmed) return errAsync({ type: "cancel-rejected" as const });
        return this.rpc
          .cancel(child.childId, generationId)
          .mapErr(() => ({ type: "stale-view" as const }));
      })
      .mapErr(() => ({ type: "cancel-rejected" as const }));
  }
}

export type PiChildSlashCommand = "inspect" | "clear-children";
export function interceptChildSlashCommand(
  input: string,
  isParentView = true,
): Result<
  PiChildSlashCommand | undefined,
  { readonly type: "rejected-slash-command" }
> {
  const isSlash = /^\s*\/\S+/.test(input);
  if (!isSlash) return ok(undefined);
  if (!isParentView) return err({ type: "rejected-slash-command" });
  const match = /^\s*\/weave:(inspect|clear-children)\s*$/.exec(input);
  if (match) return ok(match[1] as PiChildSlashCommand);
  return err({ type: "rejected-slash-command" });
}
