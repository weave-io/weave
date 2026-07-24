/**
 * Maps raw terminal input bytes to child-tree control keys (Spec 33 §11.5):
 * Alt+1..Alt+9 (direct-child selection), Backspace (parent selection), and
 * Esc (cancel selected subtree). Pure and independently testable via
 * `matchesKey` alone - the host-default-preserving wiring lives in the
 * `WeaveChildTreeEditor` `CustomEditor` subclass in `extension.ts`, which
 * falls back to `super.handleInput(data)` (Pi's own default editor
 * behavior) whenever this function returns `undefined` (not one of these
 * three key groups) or `child-tree.ts`'s own `applyTreeControlKey` reducer
 * reports `{ kind: "host-default" }` (e.g. Backspace/Esc at the root node).
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { PiTreeControlKey } from "./child-tree.js";

const DIRECT_CHILD_KEY_IDS = [
  "alt+1",
  "alt+2",
  "alt+3",
  "alt+4",
  "alt+5",
  "alt+6",
  "alt+7",
  "alt+8",
  "alt+9",
] as const;

/** Returns the child-tree control key raw input `data` represents, or `undefined` if it is none of ours. */
export function classifyChildTreeKey(
  data: string,
): PiTreeControlKey | undefined {
  for (let index = 0; index < DIRECT_CHILD_KEY_IDS.length; index += 1) {
    if (matchesKey(data, DIRECT_CHILD_KEY_IDS[index])) {
      return { kind: "select-direct-child", index: index + 1 };
    }
  }
  if (matchesKey(data, "backspace")) return { kind: "select-parent" };
  if (matchesKey(data, "escape")) return { kind: "cancel-selected" };
  return undefined;
}
