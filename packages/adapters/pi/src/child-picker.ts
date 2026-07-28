import { err, ok, type Result } from "neverthrow";

export type PiChildPickerKind = "root" | "ordinary" | "nested" | "workflow-step" | "history";
export interface PiChildPickerNode {
  readonly childId: string;
  readonly name: string;
  readonly kind: PiChildPickerKind;
  readonly parentId?: string;
  readonly status: string;
  readonly preview?: string;
  readonly live: boolean;
  readonly recoverable?: boolean;
  readonly resumable?: boolean;
  readonly currentTool?: string;
  readonly generationId?: string;
}
export interface PiChildPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly preview: string;
  readonly depth: number;
  readonly node?: PiChildPickerNode;
  readonly action?: "recover" | "resume" | "clear";
}
export interface PiChildPickerInput {
  readonly rootLabel?: string;
  readonly live: readonly PiChildPickerNode[];
  readonly history?: readonly PiChildPickerNode[];
}
export type PiChildPickerError = { readonly type: "invalid-picker-input"; readonly detail: string };

const MAX_PICKER_PREVIEW_LENGTH = 240;
function sanitize(value: string | undefined): string {
  if (!value) return "";
  const clean = value.replace(new RegExp("\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\)?)", "g"), "").replace(new RegExp("[\\u0000-\\u001f\\u007f]", "g"), " ").replace(/\s+/g, " ").trim();
  return clean.length > MAX_PICKER_PREVIEW_LENGTH ? `${clean.slice(0, MAX_PICKER_PREVIEW_LENGTH - 1)}…` : clean;
}
function pathDepth(node: PiChildPickerNode, nodes: readonly PiChildPickerNode[]): number {
  let depth = 0; let parent = node.parentId; const seen = new Set<string>();
  while (parent && !seen.has(parent)) { seen.add(parent); depth += 1; parent = nodes.find((n) => n.childId === parent)?.parentId; }
  return depth;
}
export function buildChildPickerEntries(input: PiChildPickerInput): Result<readonly PiChildPickerEntry[], PiChildPickerError> {
  const all = [...input.live, ...(input.history ?? [])];
  const ids = new Set<string>();
  for (const node of all) {
    if (!node.childId || ids.has(node.childId)) return err({ type: "invalid-picker-input", detail: "child ids must be unique and non-empty" });
    if (node.parentId !== undefined && node.parentId !== "root" && !all.some((candidate) => candidate.childId === node.parentId)) {
      return err({ type: "invalid-picker-input", detail: `unknown parent ${node.parentId}` });
    }
    ids.add(node.childId);
  }
  const entries: PiChildPickerEntry[] = [{ id: "root", label: input.rootLabel ?? "root", preview: "", depth: 0 }];
  for (const node of all) {
    const history = !node.live;
    const status = sanitize(node.status);
    const label = `${history ? "history: " : ""}${sanitize(node.name) || node.childId} [${status}]`;
    entries.push({ id: node.childId, label, preview: sanitize(node.preview), depth: pathDepth(node, all), node });
    if (node.recoverable) entries.push({ id: `${node.childId}:recover`, label: "  ↻ recover", preview: "", depth: pathDepth(node, all) + 1, node, action: "recover" });
    if (node.resumable) entries.push({ id: `${node.childId}:resume`, label: "  ▶ resume", preview: "", depth: pathDepth(node, all) + 1, node, action: "resume" });
    if (history) entries.push({ id: `${node.childId}:clear`, label: "  × clear history", preview: "", depth: pathDepth(node, all) + 1, node, action: "clear" });
  }
  return ok(entries);
}
export const createChildPickerEntries = buildChildPickerEntries;
export function sanitizeChildPickerPreview(value: string | undefined): string { return sanitize(value); }

export interface PiChildPickerState { readonly entries: readonly PiChildPickerEntry[]; readonly selected: number; }
export function moveChildPicker(state: PiChildPickerState, delta: number): PiChildPickerState {
  if (!state.entries.length) return state;
  const selected = Math.max(0, Math.min(state.entries.length - 1, state.selected + delta));
  return { ...state, selected };
}
export function selectedChildPickerEntry(state: PiChildPickerState): PiChildPickerEntry | undefined { return state.entries[state.selected]; }
