import { describe, expect, it } from "bun:test";
import {
  applyChildOverlayKeyPlan,
  CHILD_OVERLAY_CANCEL_CHOICES,
  CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE,
  CHILD_OVERLAY_ESCAPE_HINT,
  childOverlayActionFromId,
  childOverlayActiveSlots,
  childOverlaySibling,
  childOverlayTreeOrder,
  classifyChildOverlayKey,
  createChildOverlayConflictPort,
  createChildOverlayKeyMachine,
  isPiChildOverlayActionId,
  PI_CHILD_OVERLAY_ACTION_IDS,
  PI_CHILD_OVERLAY_ACTIONS,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  type PiChildOverlayHierarchyNode,
  type PiChildOverlayKeyContext,
  type PiChildOverlayKeyPlan,
  parseChildOverlayKeyOverrides,
  planChildOverlayKeyRegistrations,
  resolveChildOverlayCancelChoice,
} from "../child-overlay-keys.js";

function mustPlan(
  input: Parameters<typeof planChildOverlayKeyRegistrations>[0] = {},
): PiChildOverlayKeyPlan {
  const result = planChildOverlayKeyRegistrations(input);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function nodes(
  entries: readonly {
    readonly childId: string;
    readonly parentId?: string;
    readonly active?: boolean;
    readonly order: number;
  }[],
): readonly PiChildOverlayHierarchyNode[] {
  return entries.map((entry) => ({
    childId: entry.childId,
    parentId: entry.parentId,
    active: entry.active ?? true,
    order: entry.order,
  }));
}

function context(
  plan: PiChildOverlayKeyPlan,
  hierarchy: readonly PiChildOverlayHierarchyNode[],
  focusedChildId: string | undefined,
  draft = "",
): PiChildOverlayKeyContext {
  return { plan, nodes: hierarchy, focusedChildId, draft };
}

describe("child-overlay-keys actions and registration plans", () => {
  it("exposes the closed action-id set and typed defaults", () => {
    expect(PI_CHILD_OVERLAY_ACTION_IDS).toEqual([
      "weave.child.picker.open",
      "weave.child.slot.1",
      "weave.child.slot.2",
      "weave.child.slot.3",
      "weave.child.slot.4",
      "weave.child.slot.5",
      "weave.child.slot.6",
      "weave.child.slot.7",
      "weave.child.slot.8",
      "weave.child.slot.9",
      "weave.child.sibling.previous",
      "weave.child.sibling.next",
    ]);
    expect(PI_CHILD_OVERLAY_ACTIONS).toHaveLength(
      PI_CHILD_OVERLAY_ACTION_IDS.length,
    );
    expect(isPiChildOverlayActionId("weave.child.picker.open")).toBe(true);
    expect(isPiChildOverlayActionId("weave.child.slot.9")).toBe(true);
    expect(isPiChildOverlayActionId("weave.child.slot.0")).toBe(false);
    expect(isPiChildOverlayActionId("tui.escape")).toBe(false);
    expect(childOverlayActionFromId("weave.child.slot.3")).toEqual({
      kind: "select-slot",
      slot: 3,
    });
    expect(childOverlayActionFromId("unknown")).toBeUndefined();
  });

  it("plans default registrations for every action key", () => {
    const plan = mustPlan();
    expect(plan.conflicts).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
    const byAction = new Map(
      PI_CHILD_OVERLAY_ACTIONS.map((action) => [
        action.id,
        plan.registrations
          .filter((registration) => registration.actionId === action.id)
          .map((registration) => registration.key),
      ]),
    );
    expect(byAction.get("weave.child.picker.open")).toEqual(["alt+i"]);
    expect(byAction.get("weave.child.slot.1")).toEqual(["alt+1"]);
    expect(byAction.get("weave.child.slot.9")).toEqual(["alt+9"]);
    expect(byAction.get("weave.child.sibling.previous")).toEqual([
      "alt+left",
      "alt+h",
    ]);
    expect(byAction.get("weave.child.sibling.next")).toEqual([
      "alt+right",
      "alt+l",
    ]);
  });

  it("applies overrides in place of defaults for a known action", () => {
    const plan = mustPlan({
      overrides: {
        "weave.child.picker.open": "ctrl+p",
        "weave.child.sibling.next": ["alt+j", "alt+n"],
      },
    });
    expect(
      plan.registrations
        .filter((r) => r.actionId === "weave.child.picker.open")
        .map((r) => r.key),
    ).toEqual(["ctrl+p"]);
    expect(
      plan.registrations
        .filter((r) => r.actionId === "weave.child.sibling.next")
        .map((r) => r.key),
    ).toEqual(["alt+j", "alt+n"]);
    expect(
      plan.registrations.some(
        (r) => r.actionId === "weave.child.picker.open" && r.key === "alt+i",
      ),
    ).toBe(false);
  });

  it("rejects unknown actions, empty keys, and unsupported key syntax", () => {
    expect(
      parseChildOverlayKeyOverrides({ "tui.unknown": "alt+x" }).isErr(),
    ).toBe(true);
    expect(
      parseChildOverlayKeyOverrides({
        "weave.child.picker.open": "",
      })._unsafeUnwrapErr().detail,
    ).toContain("non-empty");
    expect(
      parseChildOverlayKeyOverrides({
        "weave.child.picker.open": "not a key",
      }).isErr(),
    ).toBe(true);
    expect(
      parseChildOverlayKeyOverrides({
        "weave.child.picker.open": [
          "alt+a",
          "alt+b",
          "alt+c",
          "alt+d",
          "alt+e",
        ],
      }).isErr(),
    ).toBe(true);
  });

  it("skips duplicate and host conflicts and bounds diagnostics", () => {
    const host = createChildOverlayConflictPort({
      "app.open": "alt+i",
      "tui.prev": ["alt+left"],
    });
    const plan = mustPlan({
      conflicts: host,
      overrides: {
        "weave.child.sibling.next": "alt+h",
      },
    });
    expect(
      plan.registrations.some(
        (r) => r.actionId === "weave.child.picker.open" && r.key === "alt+i",
      ),
    ).toBe(false);
    expect(
      plan.conflicts.some((c) => c.key === "alt+i" && c.owner === "app.open"),
    ).toBe(true);
    expect(
      plan.conflicts.some(
        (c) =>
          c.actionId === "weave.child.sibling.next" &&
          c.key === "alt+h" &&
          c.owner === "weave.child.sibling.previous",
      ),
    ).toBe(true);
    expect(plan.diagnostics.length).toBe(plan.conflicts.length);
    expect(plan.diagnostics[0]).toContain("already bound to");

    const extraCount = PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics + 8;
    const floodedActions = Array.from(
      { length: extraCount },
      (_unused, index) => ({
        id: "weave.child.picker.open" as const,
        defaultKeys: Object.freeze([`k${index}`]),
        description: `flood ${index}`,
      }),
    );
    const flooded = mustPlan({
      // Synthetic table larger than the diagnostic ceiling.
      actions: floodedActions as unknown as typeof PI_CHILD_OVERLAY_ACTIONS,
      conflicts: createChildOverlayConflictPort(
        Object.fromEntries(
          floodedActions.map((action, index) => [
            `host.${index}`,
            action.defaultKeys[0],
          ]),
        ),
      ),
    });
    expect(flooded.conflicts.length).toBe(extraCount);
    expect(flooded.diagnostics.length).toBe(
      PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics,
    );
  });

  it("applies a plan through the registrar without inventing keys", () => {
    const registered: string[] = [];
    const plan = mustPlan();
    const applied = applyChildOverlayKeyPlan(
      {
        registerShortcut(key, options) {
          registered.push(key);
          expect(options.description.length).toBeGreaterThan(0);
        },
      },
      plan,
      () => undefined,
    );
    expect(applied.isOk()).toBe(true);
    expect(applied._unsafeUnwrap()).toEqual(
      plan.registrations.map((r) => r.key),
    );
    expect(registered).toEqual(plan.registrations.map((r) => r.key));
  });
});

describe("child-overlay-keys raw classification and hierarchy", () => {
  it("classifies raw terminal input against planned keys", () => {
    const plan = mustPlan();
    expect(classifyChildOverlayKey(plan, "\x1bi")).toEqual({
      kind: "open-picker",
    });
    expect(classifyChildOverlayKey(plan, "\x1b1")).toEqual({
      kind: "select-slot",
      slot: 1,
    });
    expect(classifyChildOverlayKey(plan, "\x1bh")).toEqual({
      kind: "sibling",
      direction: -1,
    });
    expect(classifyChildOverlayKey(plan, "\x1bl")).toEqual({
      kind: "sibling",
      direction: 1,
    });
    expect(classifyChildOverlayKey(plan, "a")).toBeUndefined();
  });

  it("orders the slot tree parents-before-children and active-only", () => {
    const hierarchy = nodes([
      { childId: "b", order: 2, active: true },
      { childId: "a", order: 1, active: true },
      { childId: "a1", parentId: "a", order: 1, active: true },
      { childId: "idle", order: 0, active: false },
      { childId: "b1", parentId: "b", order: 1, active: false },
    ]);
    expect(childOverlayTreeOrder(hierarchy)._unsafeUnwrap()).toEqual([
      "idle",
      "a",
      "a1",
      "b",
      "b1",
    ]);
    expect(childOverlayActiveSlots(hierarchy)._unsafeUnwrap()).toEqual([
      "a",
      "a1",
      "b",
    ]);
  });

  it("wraps sibling navigation and honors both aliases", () => {
    const hierarchy = nodes([
      { childId: "a", order: 1 },
      { childId: "b", order: 2 },
      { childId: "c", order: 3 },
      { childId: "nested", parentId: "a", order: 1 },
    ]);
    expect(childOverlaySibling(hierarchy, "a", 1)._unsafeUnwrap()).toBe("b");
    expect(childOverlaySibling(hierarchy, "c", 1)._unsafeUnwrap()).toBe("a");
    expect(childOverlaySibling(hierarchy, "a", -1)._unsafeUnwrap()).toBe("c");
    expect(
      childOverlaySibling(hierarchy, "nested", 1)._unsafeUnwrap(),
    ).toBeUndefined();

    const plan = mustPlan();
    const machine = createChildOverlayKeyMachine({ now: () => 0 });
    const nextViaAlias = machine.handleInput(
      "\x1bl",
      context(plan, hierarchy, "a"),
    );
    expect(nextViaAlias._unsafeUnwrap()).toEqual({
      kind: "focus-child",
      childId: "b",
    });
    const prevViaAlias = machine.handleInput(
      "\x1bh",
      context(plan, hierarchy, "a"),
    );
    expect(prevViaAlias._unsafeUnwrap()).toEqual({
      kind: "focus-child",
      childId: "c",
    });
  });
});

describe("child-overlay-keys Backspace, Escape, and cancel", () => {
  it("routes nonempty Backspace to the editor and navigates on empty", () => {
    const plan = mustPlan();
    const machine = createChildOverlayKeyMachine({ now: () => 0 });
    const hierarchy = nodes([
      { childId: "root-child", order: 1 },
      { childId: "nested", parentId: "root-child", order: 1 },
    ]);

    const edited = machine.handleBackspace(
      context(plan, hierarchy, "nested", "ab👍"),
    );
    expect(edited._unsafeUnwrap()).toEqual({ kind: "overlay-input" });

    const toParent = machine.handleBackspace(
      context(plan, hierarchy, "nested", ""),
    );
    expect(toParent._unsafeUnwrap()).toEqual({
      kind: "focus-child",
      childId: "root-child",
    });

    const closeDirect = machine.handleBackspace(
      context(plan, hierarchy, "root-child", ""),
    );
    expect(closeDirect._unsafeUnwrap()).toEqual({ kind: "close-overlay" });

    const closeUnfocused = machine.handleBackspace(
      context(plan, hierarchy, undefined, ""),
    );
    expect(closeUnfocused._unsafeUnwrap()).toEqual({ kind: "close-overlay" });
  });

  it("arms Escape below the window, confirms at exact 750ms, and rearms above", () => {
    let now = 1_000;
    const machine = createChildOverlayKeyMachine({
      now: () => now,
      escapeWindowMs: PI_CHILD_OVERLAY_KEY_BOUNDS.escapeWindowMs,
    });
    const plan = mustPlan();
    const hierarchy = nodes([{ childId: "child", order: 1 }]);
    const ctx = context(plan, hierarchy, "child");

    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toEqual({
      kind: "escape-armed",
      hint: CHILD_OVERLAY_ESCAPE_HINT,
    });
    expect(machine.isEscapeArmed()).toBe(true);

    now = 1_000 + 749;
    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toMatchObject({
      kind: "confirm-cancel-subtree",
      childId: "child",
      defaultChoice: CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE,
      choices: [...CHILD_OVERLAY_CANCEL_CHOICES],
    });
    expect(machine.isEscapeArmed()).toBe(false);

    now = 2_000;
    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toEqual({
      kind: "escape-armed",
      hint: CHILD_OVERLAY_ESCAPE_HINT,
    });

    now = 2_000 + PI_CHILD_OVERLAY_KEY_BOUNDS.escapeWindowMs;
    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toMatchObject({
      kind: "confirm-cancel-subtree",
      childId: "child",
    });

    now = 4_000;
    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toEqual({
      kind: "escape-armed",
      hint: CHILD_OVERLAY_ESCAPE_HINT,
    });
    now = 4_000 + PI_CHILD_OVERLAY_KEY_BOUNDS.escapeWindowMs + 1;
    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toEqual({
      kind: "escape-rearmed",
      hint: CHILD_OVERLAY_ESCAPE_HINT,
    });
  });

  it("defaults cancel confirmation to Keep running and cancels only when explicit", () => {
    expect(CHILD_OVERLAY_CANCEL_CHOICES[0]).toBe("Keep running");
    expect(CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE).toBe(0);
    expect(resolveChildOverlayCancelChoice("c1", undefined)).toEqual({
      kind: "keep-running",
    });
    expect(resolveChildOverlayCancelChoice("c1", 0)).toEqual({
      kind: "keep-running",
    });
    expect(resolveChildOverlayCancelChoice("c1", "Keep running")).toEqual({
      kind: "keep-running",
    });
    expect(resolveChildOverlayCancelChoice("c1", 99)).toEqual({
      kind: "keep-running",
    });
    expect(resolveChildOverlayCancelChoice("c1", 1)).toEqual({
      kind: "cancel-subtree",
      childId: "c1",
    });
    expect(resolveChildOverlayCancelChoice("c1", "Cancel subtree")).toEqual({
      kind: "cancel-subtree",
      childId: "c1",
    });
  });

  it("never forwards overlay-mounted input to the primary editor", () => {
    const plan = mustPlan();
    const machine = createChildOverlayKeyMachine({ now: () => 0 });
    const hierarchy = nodes([{ childId: "child", order: 1 }]);
    const ctx = context(plan, hierarchy, "child", "draft");

    const outcomes = [
      machine.handleInput("\x1bi", ctx)._unsafeUnwrap(),
      machine.handleInput("\x1b1", ctx)._unsafeUnwrap(),
      machine.handleInput("\x7f", ctx)._unsafeUnwrap(),
      machine.handleInput("\x1b", ctx)._unsafeUnwrap(),
      machine.handleInput("x", ctx)._unsafeUnwrap(),
      machine.handleInput("\r", ctx)._unsafeUnwrap(),
    ];
    for (const outcome of outcomes) {
      expect(outcome.kind).not.toBe("forward-primary");
      expect(JSON.stringify(outcome)).not.toContain("primary-editor");
      expect(JSON.stringify(outcome)).not.toContain("host-default");
    }
    expect(outcomes[4]).toEqual({ kind: "overlay-input" });
    expect(outcomes[5]).toEqual({ kind: "overlay-input" });
  });
});
