/**
 * Named, configurable shortcut actions for the single Task 12 child overlay,
 * plus the hierarchy / Backspace / Escape state machines.
 *
 * ## Host capability gap (Pi 0.83)
 *
 * Pi 0.83 has no named, user-configurable *extension* action surface. The two
 * public mechanisms are:
 *
 * - `pi.registerShortcut(shortcut, { description, handler })`, whose public
 *   type is `ExtensionShortcut { shortcut: KeyId; ... }` — a **raw key**, not a
 *   named action id; and
 * - `~/.pi/agent/keybindings.json`, which only accepts Pi's own namespaced
 *   keybinding ids (`tui.*`, `app.*`). Extension ids are not part of that
 *   registry, so a user cannot rebind an extension shortcut there.
 *
 * The gap is reported through the Task 13 bounded key-registration health
 * diagnostic (`PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC`), not as a native
 * `CapabilityId`. This module is the emulation: stable adapter-owned action
 * ids with defaults, user overrides through an adapter-owned bounded config
 * map, resolved down to raw keys that are handed to the real
 * `pi.registerShortcut` surface.
 *
 * Nothing here overwrites a host binding. Every default and override is first
 * checked against an injected conflict port (fed from Pi's own
 * `KeybindingsManager.getResolvedBindings()`); a taken key is skipped and
 * reported once, never registered.
 */
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { err, ok, Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const PI_CHILD_OVERLAY_KEY_BOUNDS = Object.freeze({
  /** Alt+1..Alt+9 — nine active-child slots, matching the tree convention. */
  maxSlots: 9,
  maxOverrideEntries: 32,
  maxKeysPerAction: 4,
  maxKeyLength: 32,
  maxDiagnostics: 64,
  /** Double-Escape window. A second Escape at exactly this age still counts. */
  escapeWindowMs: 750,
  maxHierarchyNodes: 512,
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type SlotIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type PiChildOverlaySlotActionId = `weave.child.slot.${SlotIndex}`;

export type PiChildOverlayActionId =
  | "weave.child.picker.open"
  | PiChildOverlaySlotActionId
  | "weave.child.sibling.previous"
  | "weave.child.sibling.next";

/** Validated key identifier handed to `pi.registerShortcut` / `matchesKey`. */
export type PiChildOverlayKey = KeyId;

const SLOT_INDEXES = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9,
] as const satisfies readonly SlotIndex[]);

const SLOT_ACTION_IDS = Object.freeze(
  SLOT_INDEXES.map(
    (slot) => `weave.child.slot.${slot}` as PiChildOverlaySlotActionId,
  ),
);

export const PI_CHILD_OVERLAY_ACTION_IDS: readonly PiChildOverlayActionId[] =
  Object.freeze([
    "weave.child.picker.open",
    ...SLOT_ACTION_IDS,
    "weave.child.sibling.previous",
    "weave.child.sibling.next",
  ]);

const KNOWN_ACTION_IDS: ReadonlySet<string> = new Set(
  PI_CHILD_OVERLAY_ACTION_IDS,
);

export function isPiChildOverlayActionId(
  value: string,
): value is PiChildOverlayActionId {
  return KNOWN_ACTION_IDS.has(value);
}

export interface PiChildOverlayActionDefinition {
  readonly id: PiChildOverlayActionId;
  readonly defaultKeys: readonly PiChildOverlayKey[];
  readonly description: string;
}

/** Data-driven registration table; slots are generated, never hand-written. */
export const PI_CHILD_OVERLAY_ACTIONS: readonly PiChildOverlayActionDefinition[] =
  Object.freeze([
    {
      id: "weave.child.picker.open",
      defaultKeys: Object.freeze(["alt+i"] as const satisfies readonly KeyId[]),
      description: "Open the Weave child picker",
    },
    ...SLOT_ACTION_IDS.map((id, index) => ({
      id,
      defaultKeys: Object.freeze([
        `alt+${index + 1}` as KeyId,
      ] as const satisfies readonly KeyId[]),
      description: `Focus active child ${index + 1}`,
    })),
    {
      id: "weave.child.sibling.previous",
      defaultKeys: Object.freeze([
        "alt+left",
        "alt+h",
      ] as const satisfies readonly KeyId[]),
      description: "Focus the previous sibling child",
    },
    {
      id: "weave.child.sibling.next",
      defaultKeys: Object.freeze([
        "alt+right",
        "alt+l",
      ] as const satisfies readonly KeyId[]),
      description: "Focus the next sibling child",
    },
  ]);

export type PiChildOverlayAction =
  | { readonly kind: "open-picker" }
  | { readonly kind: "select-slot"; readonly slot: SlotIndex }
  | { readonly kind: "sibling"; readonly direction: -1 | 1 };

/** Maps a stable action id onto its overlay action, or `undefined` if unknown. */
export function childOverlayActionFromId(
  id: string,
): PiChildOverlayAction | undefined {
  if (id === "weave.child.picker.open") return { kind: "open-picker" };
  if (id === "weave.child.sibling.previous")
    return { kind: "sibling", direction: -1 };
  if (id === "weave.child.sibling.next")
    return { kind: "sibling", direction: 1 };
  const slot = /^weave\.child\.slot\.([1-9])$/.exec(id);
  if (slot?.[1] !== undefined) {
    const value = Number(slot[1]) as SlotIndex;
    return { kind: "select-slot", slot: value };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PiChildOverlayKeyError =
  | {
      readonly type: "invalid-overlay-key-override";
      readonly detail: string;
    }
  | {
      readonly type: "invalid-overlay-hierarchy";
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

const KEY_PATTERN =
  /^(?:(?:ctrl|shift|alt)\+){0,3}(?:f(?:[1-9]|1[0-2])|escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageUp|pageDown|up|down|left|right|[a-z0-9]|[`\-=[\]\\;',./!@#$%^&*()_+|~{}:<>?])$/;

/**
 * True when `value` is a key identifier this module can plan and match. The
 * settings layer reuses it so an invalid override is rejected at config-parse
 * time rather than silently dropped at registration time.
 */
export function isPiChildOverlayKeySyntax(
  value: string,
): value is PiChildOverlayKey {
  return (
    value.length > 0 &&
    value.length <= PI_CHILD_OVERLAY_KEY_BOUNDS.maxKeyLength &&
    KEY_PATTERN.test(value)
  );
}

export type PiChildOverlayKeyOverrides = Readonly<
  Partial<
    Record<
      PiChildOverlayActionId,
      PiChildOverlayKey | readonly PiChildOverlayKey[]
    >
  >
>;

function normalizeOverrideKeys(
  actionId: PiChildOverlayActionId,
  raw: unknown,
): Result<readonly PiChildOverlayKey[], PiChildOverlayKeyError> {
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) {
    return err({
      type: "invalid-overlay-key-override",
      detail: `${actionId}: keys must be a string or an array of strings`,
    });
  }
  if (list.length > PI_CHILD_OVERLAY_KEY_BOUNDS.maxKeysPerAction) {
    return err({
      type: "invalid-overlay-key-override",
      detail: `${actionId}: at most ${PI_CHILD_OVERLAY_KEY_BOUNDS.maxKeysPerAction} keys`,
    });
  }
  const keys: PiChildOverlayKey[] = [];
  for (const candidate of list) {
    if (typeof candidate !== "string") {
      return err({
        type: "invalid-overlay-key-override",
        detail: `${actionId}: keys must be strings`,
      });
    }
    if (candidate.length === 0) {
      return err({
        type: "invalid-overlay-key-override",
        detail: `${actionId}: key must be non-empty`,
      });
    }
    if (candidate.length > PI_CHILD_OVERLAY_KEY_BOUNDS.maxKeyLength) {
      return err({
        type: "invalid-overlay-key-override",
        detail: `${actionId}: key is too long`,
      });
    }
    if (!isPiChildOverlayKeySyntax(candidate)) {
      return err({
        type: "invalid-overlay-key-override",
        detail: `${actionId}: unsupported key "${candidate}"`,
      });
    }
    const key = candidate as PiChildOverlayKey;
    if (!keys.includes(key)) keys.push(key);
  }
  return ok(Object.freeze(keys));
}

/**
 * Validates the adapter-owned override map. Unknown action ids, oversized
 * maps, and unsupported key syntax are failures, never silent drops.
 */
export function parseChildOverlayKeyOverrides(
  raw: unknown,
  actions: readonly PiChildOverlayActionDefinition[] = PI_CHILD_OVERLAY_ACTIONS,
): Result<
  ReadonlyMap<PiChildOverlayActionId, readonly PiChildOverlayKey[]>,
  PiChildOverlayKeyError
> {
  if (raw === undefined || raw === null) return ok(new Map());
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return err({
      type: "invalid-overlay-key-override",
      detail: "overrides must be an object",
    });
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > PI_CHILD_OVERLAY_KEY_BOUNDS.maxOverrideEntries) {
    return err({
      type: "invalid-overlay-key-override",
      detail: `at most ${PI_CHILD_OVERLAY_KEY_BOUNDS.maxOverrideEntries} overrides`,
    });
  }
  const known = new Set<string>(actions.map((action) => action.id));
  const resolved = new Map<
    PiChildOverlayActionId,
    readonly PiChildOverlayKey[]
  >();
  for (const [actionId, value] of entries) {
    if (!known.has(actionId) || !isPiChildOverlayActionId(actionId)) {
      return err({
        type: "invalid-overlay-key-override",
        detail: `unknown action ${actionId}`,
      });
    }
    const keys = normalizeOverrideKeys(actionId, value);
    if (keys.isErr()) return err(keys.error);
    resolved.set(actionId, keys.value);
  }
  return ok(resolved);
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface PiChildOverlayKeybindingConflictPort {
  /** Returns the id of the binding already owning `key`, or `undefined`. */
  ownerOf(key: string): string | undefined;
}

/**
 * The public `KeybindingsManager` members this adapter is allowed to touch.
 *
 * Pi's live manager (`@earendil-works/pi-tui`) exposes
 * `getResolvedBindings()`; the coding agent's interactive mode additionally
 * reads `getEffectiveConfig()`. Both return the same resolved id-to-key map,
 * so either one is enough for conflict inspection and both are optional here.
 * Duck-typing exactly these two documented methods keeps the capture safe
 * against host internals changing shape underneath us.
 */
export interface PiKeybindingsConfigPort {
  getEffectiveConfig?(): Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  getResolvedBindings?(): Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
}

/**
 * Recognizes Pi's live `KeybindingsManager`, whether it arrives from the
 * composed editor/custom-component factory or from the host's process-wide
 * accessor. Anything without a callable `getResolvedBindings()` or
 * `getEffectiveConfig()` is rejected: conflict inspection is a precondition
 * for registering, never something to guess at.
 */
export function captureChildOverlayKeybindings(
  candidate: unknown,
): PiKeybindingsConfigPort | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const port = candidate as {
    getEffectiveConfig?: unknown;
    getResolvedBindings?: unknown;
  };
  if (
    typeof port.getResolvedBindings !== "function" &&
    typeof port.getEffectiveConfig !== "function"
  ) {
    return undefined;
  }
  return candidate as PiKeybindingsConfigPort;
}

/**
 * Reads the host's effective bindings into a conflict port. A throwing or
 * non-object config yields `undefined` so the caller fails closed rather than
 * registering over bindings it could not inspect.
 */
export function childOverlayConflictPortFromHost(
  keybindings: PiKeybindingsConfigPort | undefined,
): PiChildOverlayKeybindingConflictPort | undefined {
  if (keybindings === undefined) return undefined;
  const read = (():
    | (() => Readonly<Record<string, string | readonly string[] | undefined>>)
    | undefined => {
    if (typeof keybindings.getResolvedBindings === "function") {
      return () => keybindings.getResolvedBindings!();
    }
    if (typeof keybindings.getEffectiveConfig === "function") {
      return () => keybindings.getEffectiveConfig!();
    }
    return undefined;
  })();
  if (read === undefined) return undefined;
  const config = Result.fromThrowable(
    read,
    () => "keybindings_config_unavailable" as const,
  )();
  if (config.isErr()) return undefined;
  const value = config.value;
  if (typeof value !== "object" || value === null) return undefined;
  return createChildOverlayConflictPort(
    value as Readonly<Record<string, string | readonly string[] | undefined>>,
  );
}

/**
 * Adapts a resolved host keybinding config (Pi's
 * `KeybindingsManager.getResolvedBindings()` shape) into the conflict port.
 * The first declaring id wins so the report names a stable owner.
 */
export function createChildOverlayConflictPort(
  resolved: Readonly<Record<string, string | readonly string[] | undefined>>,
): PiChildOverlayKeybindingConflictPort {
  const owners = new Map<string, string>();
  for (const [bindingId, value] of Object.entries(resolved)) {
    if (value === undefined) continue;
    const keys = typeof value === "string" ? [value] : value;
    if (!Array.isArray(keys)) continue;
    for (const key of keys) {
      if (typeof key !== "string" || key.length === 0) continue;
      if (!owners.has(key)) owners.set(key, bindingId);
    }
  }
  return { ownerOf: (key) => owners.get(key) };
}

export interface PiChildOverlayKeyRegistration {
  readonly actionId: PiChildOverlayActionId;
  readonly key: PiChildOverlayKey;
  readonly description: string;
}

export interface PiChildOverlayKeyConflict {
  readonly actionId: PiChildOverlayActionId;
  readonly key: PiChildOverlayKey;
  readonly owner: string;
}

export interface PiChildOverlayKeyPlan {
  readonly registrations: readonly PiChildOverlayKeyRegistration[];
  readonly conflicts: readonly PiChildOverlayKeyConflict[];
  /** One bounded line per conflict: action, key, and current owner. */
  readonly diagnostics: readonly string[];
}

export interface PiChildOverlayKeyPlanInput {
  readonly overrides?: unknown;
  readonly conflicts?: PiChildOverlayKeybindingConflictPort;
  readonly actions?: readonly PiChildOverlayActionDefinition[];
}

/**
 * Resolves defaults + overrides into concrete registrations. Every key is
 * offered to the conflict port first: a taken key is skipped and reported,
 * never registered and never overwritten. A key already claimed by one of our
 * own actions is likewise skipped, so nothing is registered twice.
 */
export function planChildOverlayKeyRegistrations(
  input: PiChildOverlayKeyPlanInput = {},
): Result<PiChildOverlayKeyPlan, PiChildOverlayKeyError> {
  const actions = input.actions ?? PI_CHILD_OVERLAY_ACTIONS;
  const overrides = parseChildOverlayKeyOverrides(input.overrides, actions);
  if (overrides.isErr()) return err(overrides.error);

  const registrations: PiChildOverlayKeyRegistration[] = [];
  const conflicts: PiChildOverlayKeyConflict[] = [];
  const diagnostics: string[] = [];
  const claimed = new Map<PiChildOverlayKey, PiChildOverlayActionId>();

  for (const action of actions) {
    const keys = overrides.value.get(action.id) ?? action.defaultKeys;
    for (const key of keys) {
      const mine = claimed.get(key);
      const owner = mine ?? input.conflicts?.ownerOf(key);
      if (owner !== undefined) {
        conflicts.push({ actionId: action.id, key, owner });
        if (diagnostics.length < PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics) {
          diagnostics.push(
            `weave overlay action ${action.id} skipped key ${key}: already bound to ${owner}`,
          );
        }
        continue;
      }
      claimed.set(key, action.id);
      registrations.push({
        actionId: action.id,
        key,
        description: action.description,
      });
    }
  }

  return ok({
    registrations: Object.freeze(registrations),
    conflicts: Object.freeze(conflicts),
    diagnostics: Object.freeze(diagnostics),
  });
}

/** The minimal slice of `pi.registerShortcut` this module depends on. */
export interface PiChildOverlayShortcutRegistrar {
  registerShortcut(
    key: PiChildOverlayKey,
    options: {
      readonly description: string;
      readonly handler: (ctx: unknown) => Promise<void> | void;
    },
  ): void;
}

/**
 * Registers exactly the planned keys through the real Pi shortcut surface.
 * Returns the registered keys in registration order.
 */
export function applyChildOverlayKeyPlan(
  registrar: PiChildOverlayShortcutRegistrar | undefined,
  plan: PiChildOverlayKeyPlan,
  dispatch: (action: PiChildOverlayAction) => Promise<void> | void,
): Result<readonly PiChildOverlayKey[], PiChildOverlayKeyError> {
  if (registrar === undefined) return ok(Object.freeze([]));
  const registered: PiChildOverlayKey[] = [];
  for (const registration of plan.registrations) {
    const action = childOverlayActionFromId(registration.actionId);
    if (action === undefined) {
      return err({
        type: "invalid-overlay-key-override",
        detail: `unknown action ${registration.actionId}`,
      });
    }
    registrar.registerShortcut(registration.key, {
      description: registration.description,
      handler: () => dispatch(action),
    });
    registered.push(registration.key);
  }
  return ok(Object.freeze(registered));
}

/** Classifies raw terminal input against a plan, for overlay-owned input. */
export function classifyChildOverlayKey(
  plan: PiChildOverlayKeyPlan,
  data: string,
): PiChildOverlayAction | undefined {
  for (const registration of plan.registrations) {
    if (matchesKey(data, registration.key)) {
      return childOverlayActionFromId(registration.actionId);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export interface PiChildOverlayHierarchyNode {
  readonly childId: string;
  /** `undefined` (or the root id) marks a direct child of the parent session. */
  readonly parentId?: string;
  readonly active: boolean;
  /** Stable spawn order used for slot and sibling ordering. */
  readonly order: number;
}

const ROOT_PARENT_ID = "root";

function isRootParent(parentId: string | undefined): boolean {
  return parentId === undefined || parentId === ROOT_PARENT_ID;
}

function validateHierarchy(
  nodes: readonly PiChildOverlayHierarchyNode[],
): Result<readonly PiChildOverlayHierarchyNode[], PiChildOverlayKeyError> {
  if (nodes.length > PI_CHILD_OVERLAY_KEY_BOUNDS.maxHierarchyNodes) {
    return err({
      type: "invalid-overlay-hierarchy",
      detail: "too many nodes",
    });
  }
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node.childId || seen.has(node.childId)) {
      return err({
        type: "invalid-overlay-hierarchy",
        detail: "child ids must be unique and non-empty",
      });
    }
    seen.add(node.childId);
  }
  for (const node of nodes) {
    if (isRootParent(node.parentId)) continue;
    if (!seen.has(node.parentId as string)) {
      return err({
        type: "invalid-overlay-hierarchy",
        detail: `unknown parent ${node.parentId}`,
      });
    }
  }
  return ok(nodes);
}

function compareNodes(
  a: PiChildOverlayHierarchyNode,
  b: PiChildOverlayHierarchyNode,
): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.childId < b.childId) return -1;
  if (a.childId > b.childId) return 1;
  return 0;
}

/** Depth-first stable tree order: parents before their children. */
export function childOverlayTreeOrder(
  nodes: readonly PiChildOverlayHierarchyNode[],
): Result<readonly string[], PiChildOverlayKeyError> {
  const validated = validateHierarchy(nodes);
  if (validated.isErr()) return err(validated.error);
  const byParent = new Map<string, PiChildOverlayHierarchyNode[]>();
  for (const node of nodes) {
    const key = isRootParent(node.parentId)
      ? ROOT_PARENT_ID
      : (node.parentId as string);
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort(compareNodes);
  const ordered: string[] = [];
  const visit = (parentKey: string, depth: number): void => {
    if (depth > PI_CHILD_OVERLAY_KEY_BOUNDS.maxHierarchyNodes) return;
    for (const node of byParent.get(parentKey) ?? []) {
      ordered.push(node.childId);
      visit(node.childId, depth + 1);
    }
  };
  visit(ROOT_PARENT_ID, 0);
  return ok(Object.freeze(ordered));
}

/** Active children only, in stable tree order — the Alt+1..9 slot order. */
export function childOverlayActiveSlots(
  nodes: readonly PiChildOverlayHierarchyNode[],
): Result<readonly string[], PiChildOverlayKeyError> {
  const ordered = childOverlayTreeOrder(nodes);
  if (ordered.isErr()) return err(ordered.error);
  const active = new Set(
    nodes.filter((node) => node.active).map((node) => node.childId),
  );
  return ok(Object.freeze(ordered.value.filter((id) => active.has(id))));
}

/**
 * Sibling within the same parent, in stable order, wrapping at both ends so
 * every sibling stays reachable with one key.
 */
export function childOverlaySibling(
  nodes: readonly PiChildOverlayHierarchyNode[],
  childId: string,
  direction: -1 | 1,
): Result<string | undefined, PiChildOverlayKeyError> {
  const validated = validateHierarchy(nodes);
  if (validated.isErr()) return err(validated.error);
  const current = nodes.find((node) => node.childId === childId);
  if (current === undefined) return ok(undefined);
  const parentKey = isRootParent(current.parentId)
    ? ROOT_PARENT_ID
    : (current.parentId as string);
  const siblings = nodes
    .filter((node) =>
      isRootParent(node.parentId)
        ? parentKey === ROOT_PARENT_ID
        : node.parentId === parentKey,
    )
    .sort(compareNodes);
  if (siblings.length <= 1) return ok(undefined);
  const index = siblings.findIndex((node) => node.childId === childId);
  if (index < 0) return ok(undefined);
  const next = (index + direction + siblings.length * 2) % siblings.length;
  return ok(siblings[next]?.childId);
}

/** Parent of `childId`, or `undefined` when it is a direct child. */
export function childOverlayParent(
  nodes: readonly PiChildOverlayHierarchyNode[],
  childId: string,
): string | undefined {
  const current = nodes.find((node) => node.childId === childId);
  if (current === undefined) return undefined;
  return isRootParent(current.parentId) ? undefined : current.parentId;
}

// ---------------------------------------------------------------------------
// Outcomes and the input state machine
// ---------------------------------------------------------------------------

export const CHILD_OVERLAY_ESCAPE_HINT =
  "Press Escape again to cancel this child subtree";

export const CHILD_OVERLAY_CANCEL_CHOICES = Object.freeze([
  "Keep running",
  "Cancel subtree",
] as const);

/** `Keep running` is always first and always the default. */
export const CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE = 0;

export type PiChildOverlayKeyOutcome =
  | { readonly kind: "open-picker" }
  | { readonly kind: "focus-child"; readonly childId: string }
  | { readonly kind: "close-overlay" }
  | { readonly kind: "no-target" }
  | { readonly kind: "draft-updated"; readonly draft: string }
  | { readonly kind: "escape-armed"; readonly hint: string }
  | { readonly kind: "escape-rearmed"; readonly hint: string }
  | {
      readonly kind: "confirm-cancel-subtree";
      readonly childId: string;
      readonly choices: readonly string[];
      readonly defaultChoice: number;
    }
  /** Not one of ours: the Task 12 overlay controller handles it. Never Pi. */
  | { readonly kind: "overlay-input" };

export type PiChildOverlayCancelDecision =
  | { readonly kind: "keep-running" }
  | { readonly kind: "cancel-subtree"; readonly childId: string };

/** Anything but an explicit `Cancel subtree` keeps the child running. */
export function resolveChildOverlayCancelChoice(
  childId: string,
  choice: number | string | undefined,
): PiChildOverlayCancelDecision {
  const cancel = choice === 1 || choice === CHILD_OVERLAY_CANCEL_CHOICES[1];
  return cancel
    ? { kind: "cancel-subtree", childId }
    : { kind: "keep-running" };
}

export interface PiChildOverlayKeyContext {
  readonly plan: PiChildOverlayKeyPlan;
  readonly nodes: readonly PiChildOverlayHierarchyNode[];
  readonly focusedChildId: string | undefined;
  readonly draft: string;
}

export interface PiChildOverlayKeyMachineDeps {
  /** Injected monotonic clock in milliseconds — never `Date.now()` directly. */
  readonly now: () => number;
  readonly escapeWindowMs?: number;
}

/**
 * Owns the overlay-mounted keyboard. While mounted, no outcome ever asks the
 * caller to forward input to Pi or the primary editor: every key resolves to a
 * navigation outcome, a draft edit, an Escape state change, or
 * `overlay-input`, which the Task 12 controller consumes.
 */
export class PiChildOverlayKeyMachine {
  private readonly now: () => number;
  private readonly escapeWindowMs: number;
  private escapeArmedAt: number | undefined;

  constructor(deps: PiChildOverlayKeyMachineDeps) {
    this.now = deps.now;
    this.escapeWindowMs = Math.max(
      0,
      deps.escapeWindowMs ?? PI_CHILD_OVERLAY_KEY_BOUNDS.escapeWindowMs,
    );
  }

  /** True while the first Escape's hint is visible. */
  isEscapeArmed(): boolean {
    return this.escapeArmedAt !== undefined;
  }

  /** Clears the armed hint, e.g. after the overlay swaps or unmounts. */
  disarmEscape(): void {
    this.escapeArmedAt = undefined;
  }

  handleAction(
    action: PiChildOverlayAction,
    context: PiChildOverlayKeyContext,
  ): Result<PiChildOverlayKeyOutcome, PiChildOverlayKeyError> {
    if (action.kind === "open-picker") return ok({ kind: "open-picker" });
    if (action.kind === "select-slot") {
      const slots = childOverlayActiveSlots(context.nodes);
      if (slots.isErr()) return err(slots.error);
      const childId = slots.value[action.slot - 1];
      if (childId === undefined) return ok({ kind: "no-target" });
      return ok({ kind: "focus-child", childId });
    }
    const focused = context.focusedChildId;
    if (focused === undefined) return ok({ kind: "no-target" });
    const sibling = childOverlaySibling(
      context.nodes,
      focused,
      action.direction,
    );
    if (sibling.isErr()) return err(sibling.error);
    if (sibling.value === undefined || sibling.value === focused)
      return ok({ kind: "no-target" });
    return ok({ kind: "focus-child", childId: sibling.value });
  }

  /**
   * Backspace. A nonempty draft belongs to the overlay's editor, which deletes
   * at the cursor; this machine only claims Backspace when there is no draft,
   * where it opens the parent or closes the overlay for a direct child.
   */
  handleBackspace(
    context: PiChildOverlayKeyContext,
  ): Result<PiChildOverlayKeyOutcome, PiChildOverlayKeyError> {
    if (context.draft.length > 0) {
      // Deleting the last character regardless of cursor position would make
      // the field unusable the moment the cursor is not at the end.
      return ok({ kind: "overlay-input" });
    }
    const focused = context.focusedChildId;
    if (focused === undefined) return ok({ kind: "close-overlay" });
    const validated = validateHierarchy(context.nodes);
    if (validated.isErr()) return err(validated.error);
    const parent = childOverlayParent(context.nodes, focused);
    if (parent === undefined) return ok({ kind: "close-overlay" });
    return ok({ kind: "focus-child", childId: parent });
  }

  /**
   * Escape. Always consumed while mounted. The first press arms a hint; a
   * second press within the window opens the cancel-subtree confirmation;
   * a later press rearms.
   */
  handleEscape(
    context: PiChildOverlayKeyContext,
  ): Result<PiChildOverlayKeyOutcome, PiChildOverlayKeyError> {
    const now = this.now();
    const armedAt = this.escapeArmedAt;
    if (armedAt !== undefined && now - armedAt <= this.escapeWindowMs) {
      this.escapeArmedAt = undefined;
      const focused = context.focusedChildId;
      if (focused === undefined) return ok({ kind: "no-target" });
      return ok({
        kind: "confirm-cancel-subtree",
        childId: focused,
        choices: CHILD_OVERLAY_CANCEL_CHOICES,
        defaultChoice: CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE,
      });
    }
    this.escapeArmedAt = now;
    return ok(
      armedAt === undefined
        ? { kind: "escape-armed", hint: CHILD_OVERLAY_ESCAPE_HINT }
        : { kind: "escape-rearmed", hint: CHILD_OVERLAY_ESCAPE_HINT },
    );
  }

  /** Single entry point for overlay-mounted raw input. */
  handleInput(
    data: string,
    context: PiChildOverlayKeyContext,
  ): Result<PiChildOverlayKeyOutcome, PiChildOverlayKeyError> {
    if (matchesKey(data, "escape")) return this.handleEscape(context);
    const action = classifyChildOverlayKey(context.plan, data);
    if (action !== undefined) return this.handleAction(action, context);
    if (matchesKey(data, "backspace")) return this.handleBackspace(context);
    return ok({ kind: "overlay-input" });
  }
}

export function createChildOverlayKeyMachine(
  deps: PiChildOverlayKeyMachineDeps,
): PiChildOverlayKeyMachine {
  return new PiChildOverlayKeyMachine(deps);
}

// ---------------------------------------------------------------------------
// Overlay key interceptor
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the keystroke was consumed by Task 13. A consumed key is
 * never handed on to the Task 12 overlay controller, and no key ever travels
 * further than that, so the primary editor sees nothing while mounted.
 */
export type PiChildOverlayKeyInterceptor = (data: string) => boolean;

export interface PiChildOverlayKeyInterceptorDeps {
  readonly machine: PiChildOverlayKeyMachine;
  /**
   * Current context, or `undefined` when the generation that produced it is no
   * longer the active one. A stale context consumes the key and reports rather
   * than acting on a replaced generation.
   */
  readonly context: () => PiChildOverlayKeyContext | undefined;
  readonly openPicker: () => void;
  readonly focusChild: (childId: string) => void;
  readonly closeOverlay: () => void;
  readonly updateDraft: (draft: string) => void;
  readonly showHint: (hint: string) => void;
  readonly confirmCancelSubtree: (childId: string) => void;
  /** One bounded line per stale / no-target / invalid-hierarchy outcome. */
  readonly report: (detail: string) => void;
}

/**
 * Wraps {@link PiChildOverlayKeyMachine} into the single callback the Task 12
 * overlay component invokes before its own input handling.
 */
export function createChildOverlayKeyInterceptor(
  deps: PiChildOverlayKeyInterceptorDeps,
): PiChildOverlayKeyInterceptor {
  return (data: string): boolean => {
    const context = deps.context();
    if (context === undefined) {
      // Stale generation: Escape and every planned key are still swallowed so
      // nothing reaches the primary editor, but no action is taken.
      if (
        matchesKey(data, "escape") ||
        matchesKey(data, "backspace") ||
        classifyChildOverlayKey(EMPTY_PLAN, data) !== undefined
      ) {
        deps.report(
          "weave overlay key ignored: generation is no longer active",
        );
        return true;
      }
      return false;
    }
    const outcome = deps.machine.handleInput(data, context);
    if (outcome.isErr()) {
      deps.report(`weave overlay key failed: ${outcome.error.detail}`);
      return true;
    }
    switch (outcome.value.kind) {
      case "overlay-input":
        return false;
      case "open-picker":
        deps.openPicker();
        return true;
      case "focus-child":
        deps.focusChild(outcome.value.childId);
        return true;
      case "close-overlay":
        deps.closeOverlay();
        return true;
      case "draft-updated":
        deps.updateDraft(outcome.value.draft);
        return true;
      case "escape-armed":
      case "escape-rearmed":
        deps.showHint(outcome.value.hint);
        return true;
      case "confirm-cancel-subtree":
        deps.confirmCancelSubtree(outcome.value.childId);
        return true;
      case "no-target":
        deps.report("weave overlay key ignored: no matching child");
        return true;
    }
  };
}

/** A plan with the declared defaults only, used for stale-key classification. */
const EMPTY_PLAN: PiChildOverlayKeyPlan = Object.freeze({
  registrations: Object.freeze(
    PI_CHILD_OVERLAY_ACTIONS.flatMap((action) =>
      action.defaultKeys.map((key) => ({
        actionId: action.id,
        key,
        description: action.description,
      })),
    ),
  ),
  conflicts: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

// ---------------------------------------------------------------------------
// Host capability gap
// ---------------------------------------------------------------------------

/** Stable id of the declared Pi 0.83 named-action gap. */
export const PI_NAMED_SHORTCUT_ACTIONS_CAPABILITY_ID =
  "named-configurable-shortcut-actions" as const;

/**
 * The single bounded diagnostic describing the gap. Pi 0.83 exposes only raw
 * keys through `registerShortcut`, and `keybindings.json` accepts only Pi's own
 * namespaced ids, so the adapter owns the action ids and their overrides.
 */
export const PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC =
  "Pi exposes raw-key shortcuts only (registerShortcut takes a key, not a named action id, and keybindings.json accepts only Pi's own tui.*/app.* ids). Weave emulates named actions with adapter-owned ids and settings.adapters.pi.child_inspection.keys overrides." as const;

// ---------------------------------------------------------------------------
// In-overlay search route (Task 20 item c)
// ---------------------------------------------------------------------------

/**
 * Documented key that opens the transcript search prompt while the native
 * overlay owns the keyboard. `ctrl+f` is the standard "find" key and is not one
 * of Pi's own bindings, but the host may still claim it, so it is offered to
 * the same conflict port every other overlay key uses.
 */
export const PI_CHILD_OVERLAY_SEARCH_KEY = "ctrl+f" as const;

/** Raw terminal byte Pi delivers for {@link PI_CHILD_OVERLAY_SEARCH_KEY}. */
export const PI_CHILD_OVERLAY_SEARCH_TRIGGER = "\x06" as const;

export interface PiChildOverlaySearchRoute {
  /** Raw key data that opens the search prompt, or undefined when skipped. */
  readonly trigger: string | undefined;
  /** Bounded diagnostic lines; one line when the host already owns the key. */
  readonly diagnostics: readonly string[];
}

/**
 * Resolves the in-overlay search key against the host's effective bindings.
 *
 * The overlay never registers this key as a Pi shortcut: it is consumed only
 * while the overlay is mounted and focused. When the host already binds the
 * key, the route is skipped and reported instead of being silently stolen, so
 * a conflict is always visible rather than changing the key's meaning.
 */
export function resolveChildOverlaySearchRoute(
  conflicts?: PiChildOverlayKeybindingConflictPort,
): PiChildOverlaySearchRoute {
  const owner = conflicts?.ownerOf(PI_CHILD_OVERLAY_SEARCH_KEY);
  if (owner !== undefined) {
    return Object.freeze({
      trigger: undefined,
      diagnostics: Object.freeze([
        `weave overlay search skipped key ${PI_CHILD_OVERLAY_SEARCH_KEY}: already bound to ${owner}`,
      ]),
    });
  }
  return Object.freeze({
    trigger: PI_CHILD_OVERLAY_SEARCH_TRIGGER,
    diagnostics: Object.freeze([]),
  });
}
