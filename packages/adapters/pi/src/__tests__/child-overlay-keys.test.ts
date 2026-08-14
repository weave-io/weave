import { describe, expect, it } from "bun:test";
import {
  answerOverlayCancelConfirm,
  CLOSED_OVERLAY_SEARCH,
  OVERLAY_SEARCH_QUERY_MAX,
  type OverlaySearchState,
  overlaySearchQuery,
  stepOverlaySearch,
} from "../child-overlay-input-modes.js";
import {
  applyChildOverlayKeyPlan,
  CHILD_OVERLAY_CANCEL_CHOICES,
  CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE,
  CHILD_OVERLAY_CANCEL_KEYS,
  CHILD_OVERLAY_CANCEL_PROMPT,
  childOverlayActionFromId,
  childOverlayActiveSlots,
  childOverlayCancelPrompt,
  childOverlaySibling,
  childOverlayTreeOrder,
  classifyChildOverlayKey,
  createChildOverlayConflictPort,
  createChildOverlayKeyMachine,
  isChildOverlayCancelKey,
  isChildOverlaySearchOpenInput,
  isPiChildOverlayActionId,
  PI_CHILD_OVERLAY_ACTION_IDS,
  PI_CHILD_OVERLAY_ACTIONS,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  PI_CHILD_OVERLAY_SEARCH_KEY,
  PI_CHILD_OVERLAY_SEARCH_KEY_USUAL_OWNER,
  PI_CHILD_OVERLAY_SEARCH_OPEN_KEY,
  PI_CHILD_OVERLAY_SEARCH_TRIGGER,
  PI_CHILD_OVERLAY_UNCLAIMED_KEYS_NOTE,
  type PiChildOverlayHierarchyNode,
  type PiChildOverlayKeyContext,
  type PiChildOverlayKeyPlan,
  parseChildOverlayKeyOverrides,
  planChildOverlayKeyRegistrations,
  resolveChildOverlayCancelChoice,
  resolveChildOverlaySearchRoute,
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
    // Pi does not own alt+h / alt+l, so they lead; alt+left / alt+right stay
    // as secondary candidates a real host normally skips.
    expect(byAction.get("weave.child.sibling.previous")).toEqual([
      "alt+h",
      "alt+left",
    ]);
    expect(byAction.get("weave.child.sibling.next")).toEqual([
      "alt+l",
      "alt+right",
    ]);
  });

  it("keeps the sibling primaries when Pi owns the arrow aliases", () => {
    // The bindings a stock Pi keymap actually declares for these keys.
    const plan = mustPlan({
      conflicts: createChildOverlayConflictPort({
        "app.tree.foldOrUp": "alt+left",
        "app.tree.unfoldOrDown": "alt+right",
      }),
    });
    const keysFor = (actionId: string): readonly string[] =>
      plan.registrations
        .filter((registration) => registration.actionId === actionId)
        .map((registration) => registration.key);
    expect(keysFor("weave.child.sibling.previous")).toEqual(["alt+h"]);
    expect(keysFor("weave.child.sibling.next")).toEqual(["alt+l"]);
    // The skipped aliases are reported, and each diagnostic names its owner.
    expect(plan.diagnostics).toEqual([
      "weave overlay action weave.child.sibling.previous skipped key alt+left: already bound to app.tree.foldOrUp",
      "weave overlay action weave.child.sibling.next skipped key alt+right: already bound to app.tree.unfoldOrDown",
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

  it("closes the overlay on a single Escape and never cancels", () => {
    let now = 1_000;
    const machine = createChildOverlayKeyMachine({ now: () => now });
    const plan = mustPlan();
    const hierarchy = nodes([{ childId: "child", order: 1 }]);
    const ctx = context(plan, hierarchy, "child");

    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toEqual({
      kind: "close-overlay",
    });

    // No arming state survives: a second, much later Escape closes too.
    now = 90_000;
    expect(machine.handleEscape(ctx)._unsafeUnwrap()).toEqual({
      kind: "close-overlay",
    });

    // Immediate repeat presses stay plain closes, never a cancel confirmation.
    now = 90_010;
    expect(machine.handleInput("\x1b", ctx)._unsafeUnwrap()).toEqual({
      kind: "close-overlay",
    });

    // Unfocused overlay still closes rather than reporting no-target.
    expect(
      machine.handleEscape(context(plan, hierarchy, undefined))._unsafeUnwrap(),
    ).toEqual({ kind: "close-overlay" });
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

  it("opens the cancel confirmation only for q on an empty draft over a live child", () => {
    const plan = mustPlan();
    const machine = createChildOverlayKeyMachine({ now: () => 0 });
    const hierarchy = nodes([
      { childId: "child", order: 1 },
      { childId: "settled", order: 2, active: false },
    ]);

    // Empty draft: both q and Q open the confirmation for the focused child.
    for (const key of ["q", "Q"]) {
      expect(
        machine
          .handleInput(key, context(plan, hierarchy, "child", ""))
          ._unsafeUnwrap(),
      ).toEqual({
        kind: "confirm-cancel-subtree",
        childId: "child",
        choices: CHILD_OVERLAY_CANCEL_CHOICES,
        defaultChoice: CHILD_OVERLAY_CANCEL_DEFAULT_CHOICE,
      });
    }

    // Nonempty draft: the byte belongs to the overlay editor, so it is typed.
    for (const key of ["q", "Q"]) {
      expect(
        machine
          .handleInput(key, context(plan, hierarchy, "child", "qu"))
          ._unsafeUnwrap(),
      ).toEqual({ kind: "overlay-input" });
    }

    // A settled (read-only) child cannot be cancelled: no modal is offered.
    expect(
      machine
        .handleInput("q", context(plan, hierarchy, "settled", ""))
        ._unsafeUnwrap(),
    ).toEqual({ kind: "no-target" });

    // Nothing focused: no destructive prompt without a target.
    expect(
      machine
        .handleInput("q", context(plan, hierarchy, undefined, ""))
        ._unsafeUnwrap(),
    ).toEqual({ kind: "no-target" });

    // A child that is not in the hierarchy at all is likewise no target.
    expect(
      machine
        .handleInput("q", context(plan, hierarchy, "ghost", ""))
        ._unsafeUnwrap(),
    ).toEqual({ kind: "no-target" });
  });

  it("keeps q out of the registered shortcut plan and matches it semantically", () => {
    const plan = mustPlan();
    for (const registration of plan.registrations) {
      expect(CHILD_OVERLAY_CANCEL_KEYS).not.toContain(registration.key);
      expect(registration.key).not.toBe("q");
      expect(registration.key).not.toBe("shift+q");
    }
    expect(classifyChildOverlayKey(plan, "q")).toBeUndefined();
    expect(classifyChildOverlayKey(plan, "Q")).toBeUndefined();
    expect(isChildOverlayCancelKey("q")).toBe(true);
    expect(isChildOverlayCancelKey("Q")).toBe(true);
    expect(isChildOverlayCancelKey("a")).toBe(false);
    expect(isChildOverlayCancelKey("\x1b")).toBe(false);
  });

  it("names the focused child in bounded cancel-prompt copy", () => {
    expect(childOverlayCancelPrompt(undefined)).toBe(
      CHILD_OVERLAY_CANCEL_PROMPT,
    );
    expect(childOverlayCancelPrompt("   ")).toBe(CHILD_OVERLAY_CANCEL_PROMPT);
    expect(childOverlayCancelPrompt("Refactor parser")).toBe(
      'Cancel "Refactor parser" and its subtree?',
    );
    const long = childOverlayCancelPrompt("x".repeat(4000));
    expect(long.length).toBeLessThanOrEqual(
      PI_CHILD_OVERLAY_KEY_BOUNDS.maxCancelLabelLength + 32,
    );
    expect(childOverlayCancelPrompt("bad\u0007title")).toBe(
      'Cancel "badtitle" and its subtree?',
    );
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

// ---------------------------------------------------------------------------
// The in-overlay search openers
// ---------------------------------------------------------------------------

describe("child overlay search openers", () => {
  it("opens on / only while the draft is empty", () => {
    const alias = PI_CHILD_OVERLAY_SEARCH_TRIGGER;
    expect(PI_CHILD_OVERLAY_SEARCH_OPEN_KEY).toBe("/");
    expect(isChildOverlaySearchOpenInput("/", "", alias)).toBe(true);
    // A reader typing a steer that contains a slash keeps typing it.
    expect(isChildOverlaySearchOpenInput("/", "fix packages/", alias)).toBe(
      false,
    );
    expect(isChildOverlaySearchOpenInput("/", " ", alias)).toBe(false);
  });

  it("accepts the ctrl+f alias regardless of the draft, and only when free", () => {
    const alias = PI_CHILD_OVERLAY_SEARCH_TRIGGER;
    expect(PI_CHILD_OVERLAY_SEARCH_TRIGGER).toBe("\x06");
    expect(isChildOverlaySearchOpenInput("\x06", "", alias)).toBe(true);
    expect(isChildOverlaySearchOpenInput("\x06", "a draft", alias)).toBe(true);
    // A disabled alias never removes search: `/` still opens it.
    expect(isChildOverlaySearchOpenInput("\x06", "", undefined)).toBe(false);
    expect(isChildOverlaySearchOpenInput("/", "", undefined)).toBe(true);
    expect(isChildOverlaySearchOpenInput("x", "", alias)).toBe(false);
  });

  it("keeps the alias when no host binding owns ctrl+f", () => {
    const route = resolveChildOverlaySearchRoute(
      createChildOverlayConflictPort({ "app.something": "ctrl+g" }),
    );
    expect(route.trigger).toBe(PI_CHILD_OVERLAY_SEARCH_TRIGGER);
    expect(route.diagnostics).toEqual([]);
    expect(resolveChildOverlaySearchRoute().trigger).toBe(
      PI_CHILD_OVERLAY_SEARCH_TRIGGER,
    );
  });

  it("skips a taken ctrl+f and names its usual owner in the diagnostic", () => {
    const route = resolveChildOverlaySearchRoute(
      createChildOverlayConflictPort({
        [PI_CHILD_OVERLAY_SEARCH_KEY_USUAL_OWNER]: PI_CHILD_OVERLAY_SEARCH_KEY,
      }),
    );
    expect(route.trigger).toBeUndefined();
    expect(route.diagnostics).toHaveLength(1);
    const diagnostic = route.diagnostics[0] as string;
    expect(diagnostic).toContain(PI_CHILD_OVERLAY_SEARCH_KEY);
    expect(diagnostic).toContain(PI_CHILD_OVERLAY_SEARCH_KEY_USUAL_OWNER);
    // The report still states that search remains reachable.
    expect(diagnostic).toContain(PI_CHILD_OVERLAY_SEARCH_OPEN_KEY);
  });

  it("never registers /, q, n or N as host shortcuts", () => {
    const plan = mustPlan();
    const registered = plan.registrations.map(
      (registration) => registration.key,
    );
    for (const key of ["/", "q", "shift+q", "n", "shift+n", "ctrl+f"]) {
      expect(registered).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Deliberate non-claims
// ---------------------------------------------------------------------------

describe("child overlay non-claims", () => {
  it("states which keys the mounted overlay leaves alone and why", () => {
    expect(PI_CHILD_OVERLAY_UNCLAIMED_KEYS_NOTE).toContain("Ctrl+O");
    expect(PI_CHILD_OVERLAY_UNCLAIMED_KEYS_NOTE).toContain("Alt+A");
    expect(PI_CHILD_OVERLAY_UNCLAIMED_KEYS_NOTE).toContain("Alt+T");
    expect(PI_CHILD_OVERLAY_UNCLAIMED_KEYS_NOTE).toContain("ui.custom");
    expect(PI_CHILD_OVERLAY_UNCLAIMED_KEYS_NOTE).toContain(
      "setEditorComponent",
    );
  });

  it("declares no compact-view action, so ctrl+o is never planned", () => {
    expect(PI_CHILD_OVERLAY_ACTION_IDS.some((id) => id.includes("view"))).toBe(
      false,
    );
    const plan = mustPlan();
    expect(
      plan.registrations.some((registration) => registration.key === "ctrl+o"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two modal keyboards: search and the cancel confirmation
// ---------------------------------------------------------------------------

describe("overlay search keyboard", () => {
  const ALIAS = PI_CHILD_OVERLAY_SEARCH_TRIGGER;

  const open = (query = ""): OverlaySearchState => ({
    mode: "typing",
    query,
    matchIndex: 0,
    accepted: false,
  });

  it("opens on / only from an empty draft, and on the alias always", () => {
    const shut = stepOverlaySearch(CLOSED_OVERLAY_SEARCH, "/", "", ALIAS);
    expect(shut.claimed).toBe(true);
    expect(shut.state.mode).toBe("typing");
    expect(shut.effect).toEqual({ kind: "repaint" });

    // A slash typed into a steer belongs to the draft, not to search.
    const typing = stepOverlaySearch(
      CLOSED_OVERLAY_SEARCH,
      "/",
      "fix packages/",
      ALIAS,
    );
    expect(typing.claimed).toBe(false);
    expect(typing.state).toBe(CLOSED_OVERLAY_SEARCH);

    expect(
      stepOverlaySearch(CLOSED_OVERLAY_SEARCH, ALIAS, "a draft", ALIAS).claimed,
    ).toBe(true);
    // A host-owned alias is simply absent; `/` still opens search.
    expect(
      stepOverlaySearch(CLOSED_OVERLAY_SEARCH, ALIAS, "", undefined).claimed,
    ).toBe(false);
    expect(
      stepOverlaySearch(CLOSED_OVERLAY_SEARCH, "n", "", ALIAS).claimed,
    ).toBe(false);
  });

  it("edits the query with printable bytes and backspace, and bounds it", () => {
    const typed = stepOverlaySearch(open(), "ab", "", ALIAS);
    expect(typed.state.query).toBe("ab");
    expect(stepOverlaySearch(open("ab"), "\x7f", "", ALIAS).state.query).toBe(
      "a",
    );
    // Control sequences never edit the query, but they stay consumed.
    const arrow = stepOverlaySearch(open("ab"), "\x1b[C", "", ALIAS);
    expect(arrow.claimed).toBe(true);
    expect(arrow.state.query).toBe("ab");

    const long = "x".repeat(OVERLAY_SEARCH_QUERY_MAX);
    expect(stepOverlaySearch(open(long), "y", "", ALIAS).state.query).toBe(
      long,
    );
  });

  it("commits on Enter, latches the anchor, and runs the query once", () => {
    const committed = stepOverlaySearch(open("needle"), "\r", "", ALIAS);
    expect(committed.state.mode).toBe("navigate");
    expect(committed.state.accepted).toBe(true);
    expect(committed.state.matchIndex).toBe(0);
    expect(committed.effect).toEqual({ kind: "run", query: "needle" });
    expect(stepOverlaySearch(open("needle"), "\n", "", ALIAS).effect).toEqual({
      kind: "run",
      query: "needle",
    });
  });

  it("walks matches with n/j/Down and N/k/Up while navigating", () => {
    const navigating: OverlaySearchState = {
      mode: "navigate",
      query: "needle",
      matchIndex: 0,
      accepted: true,
    };
    for (const key of ["n", "j", "\x1b[B"]) {
      const next = stepOverlaySearch(navigating, key, "", ALIAS);
      expect(next.state.matchIndex).toBe(1);
      expect(next.effect).toEqual({ kind: "focus" });
    }
    for (const key of ["N", "k", "\x1b[A"]) {
      const previous = stepOverlaySearch(navigating, key, "", ALIAS);
      expect(previous.state.matchIndex).toBe(-1);
      expect(previous.effect).toEqual({ kind: "focus" });
    }
    // Everything else stays consumed: search owns the keyboard until Escape.
    for (const key of ["q", "/", "x", "\r"]) {
      const other = stepOverlaySearch(navigating, key, "", ALIAS);
      expect(other.claimed).toBe(true);
      expect(other.state).toEqual(navigating);
      expect(other.effect).toEqual({ kind: "none" });
    }
  });

  it("closes search on Escape from either open mode, and nothing else", () => {
    for (const state of [
      open("needle"),
      { mode: "navigate", query: "n", matchIndex: 3, accepted: true } as const,
    ]) {
      const closed = stepOverlaySearch(state, "\x1b", "", ALIAS);
      expect(closed.claimed).toBe(true);
      expect(closed.state).toEqual(CLOSED_OVERLAY_SEARCH);
      expect(closed.effect).toEqual({ kind: "close" });
    }
  });

  it("reports the typed query while typing and the committed one after", () => {
    expect(overlaySearchQuery(open("half"), "committed")).toBe("half");
    expect(
      overlaySearchQuery(
        { mode: "navigate", query: "half", matchIndex: 0, accepted: true },
        "committed",
      ),
    ).toBe("committed");
  });
});

describe("overlay cancel confirmation keyboard", () => {
  it("answers only y and n/Esc, and swallows everything else", () => {
    expect(answerOverlayCancelConfirm("y")).toBe("confirm");
    expect(answerOverlayCancelConfirm("Y")).toBe("confirm");
    expect(answerOverlayCancelConfirm("n")).toBe("dismiss");
    expect(answerOverlayCancelConfirm("N")).toBe("dismiss");
    expect(answerOverlayCancelConfirm("\x1b")).toBe("dismiss");
    // Precedence made visible: while the question is up, none of these can
    // reach search, the overlay keys, or the draft editor.
    for (const key of ["/", "q", "j", "k", "\r", "\x7f", "\x06", "a"]) {
      expect(answerOverlayCancelConfirm(key)).toBe("swallow");
    }
  });
});
