import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ChildExtensionSelectionRecord } from "../child-extension-selection.js";
import {
  buildPiConfigHint,
  buildPiConfigRows,
  buildPiConfigSaveIntent,
  createPiConfigComponent,
  initialPiConfigSelection,
  mergePiConfigEntries,
  PI_CONFIG_DROPPED_TAG,
  PI_CONFIG_INHERIT_ROW_LABEL,
  PI_CONFIG_MANDATORY_ROW_LABEL,
  PI_CONFIG_MANDATORY_UNLISTED_TAG,
  PI_CONFIG_STORED_ONLY_SCOPE,
  PI_CONFIG_UNAVAILABLE_TAG,
  type PiConfigExtensionEntry,
  type PiConfigSaveError,
  type PiConfigSaveIntent,
} from "../pi-config-ui.js";

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_ESCAPE = "\u001b";
const KEY_ENTER = "\r";
const KEY_SPACE = " ";

function entry(
  overrides: Partial<PiConfigExtensionEntry> &
    Pick<PiConfigExtensionEntry, "id">,
): PiConfigExtensionEntry {
  return {
    label: overrides.id,
    source: overrides.id,
    path: `/ext/${overrides.id.replace(/[^a-z0-9-]/gi, "-")}.ts`,
    scope: "user",
    mandatory: false,
    available: true,
    ...overrides,
  };
}

const WEAVE_ENTRY = entry({
  id: "npm:@weaveio/weave-adapter-pi",
  label: "weave-adapter-pi",
  path: "/host/weave/dist/extension.js",
  scope: "user",
  mandatory: true,
});

/** One user extension, one project extension, one unavailable entry. */
const INVENTORY: readonly PiConfigExtensionEntry[] = [
  entry({ id: "npm:pi-vim", label: "pi-vim", scope: "user" }),
  entry({
    id: "/project/.pi/extensions/lint.ts",
    label: "lint",
    scope: "project",
  }),
  entry({
    id: "/project/.pi/extensions/gone.ts",
    label: "gone",
    scope: "project",
    available: false,
  }),
  WEAVE_ENTRY,
];

/**
 * A stored record whose selection has drifted: one entry the inventory still
 * offers, one it now reports unavailable, and one it no longer knows at all.
 */
const STORED_WITH_MISSING: ChildExtensionSelectionRecord = {
  schemaVersion: 1,
  mode: "explicit",
  entries: [
    {
      id: "npm:pi-vim",
      source: "npm:pi-vim",
      path: "/ext/npm-pi-vim.ts",
      label: "pi-vim",
    },
    {
      id: "/project/.pi/extensions/gone.ts",
      source: "/project/.pi/extensions/gone.ts",
      path: "/project/.pi/extensions/gone.ts",
      label: "gone",
    },
    {
      id: "npm:removed",
      source: "npm:removed",
      path: "/ext/removed.ts",
      label: "removed",
    },
  ],
};

interface Harness {
  readonly component: ReturnType<typeof createPiConfigComponent>;
  readonly saves: PiConfigSaveIntent[];
  readonly rejections: PiConfigSaveError[];
  readonly cancels: { count: number };
  readonly changes: { count: number };
}

function harness(
  options: {
    readonly entries?: readonly PiConfigExtensionEntry[];
    readonly record?: ChildExtensionSelectionRecord;
    readonly readOnly?: boolean;
    readonly isCurrent?: () => boolean;
  } = {},
): Harness {
  const saves: PiConfigSaveIntent[] = [];
  const rejections: PiConfigSaveError[] = [];
  const cancels = { count: 0 };
  const changes = { count: 0 };
  const component = createPiConfigComponent({
    entries: options.entries ?? INVENTORY,
    ...(options.record === undefined ? {} : { record: options.record }),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.isCurrent === undefined
      ? {}
      : { isCurrent: options.isCurrent }),
    getTerminalRows: () => 30,
    onSave: (intent) => saves.push(intent),
    onCancel: () => {
      cancels.count += 1;
    },
    onRejected: (rejection) => rejections.push(rejection),
    onChange: () => {
      changes.count += 1;
    },
  });
  return { component, saves, rejections, cancels, changes };
}

function lineFor(lines: readonly string[], needle: string): string | undefined {
  return lines.find((line) => line.includes(needle));
}

describe("pi-config overlay rows and state", () => {
  it("pins the mandatory Weave row first with no toggle affordance", async () => {
    await Promise.resolve();
    const rows = buildPiConfigRows(INVENTORY);
    expect(rows[0]).toEqual({ kind: "mandatory", entry: WEAVE_ENTRY });
    expect(rows[1]).toEqual({ kind: "inherit" });

    const lines = harness().component.render(120);
    const mandatory = lineFor(lines, PI_CONFIG_MANDATORY_ROW_LABEL);
    expect(mandatory).toBeDefined();
    expect(mandatory).toContain("mandatory");
    // A locked row must not look like a checkbox the user failed to tick.
    expect(mandatory).not.toContain("[x]");
    expect(mandatory).not.toContain("[ ]");
  });

  it("orders optional entries by scope then label and tags unavailable ones", async () => {
    await Promise.resolve();
    const optional = buildPiConfigRows([
      ...INVENTORY,
      entry({ id: "npm:aardvark", label: "aardvark", scope: "user" }),
      entry({ id: "npm:tmp", label: "tmp", scope: "temporary" }),
    ]).flatMap((row) => (row.kind === "optional" ? [row.entry] : []));
    expect(optional.map((item) => item.label)).toEqual([
      "aardvark",
      "pi-vim",
      "gone",
      "lint",
      "tmp",
    ]);

    const lines = harness().component.render(120);
    expect(lineFor(lines, "gone")).toContain("unavailable");
    expect(lineFor(lines, "lint")).toContain("project");
  });

  it("states what a child loads, what it loses, and when the change applies", async () => {
    await Promise.resolve();
    const rendered = harness().component.render(120).join("\n");
    expect(rendered).toContain(
      "Children load only the selected extensions plus Weave.",
    );
    expect(rendered).toContain(
      "Unselected provider extensions supply no models or credentials to children.",
    );
    expect(rendered).toContain(
      "Changes apply to children spawned after this session's next start, never to running children.",
    );
  });

  it("shows the inherit-all row and every key hint in the footer", async () => {
    await Promise.resolve();
    const lines = harness().component.render(120);
    expect(lineFor(lines, PI_CONFIG_INHERIT_ROW_LABEL)).toBeDefined();
    const hint = lines[lines.length - 1] ?? "";
    for (const fragment of [
      "up/down move",
      "space toggle",
      "a all",
      "n none",
      "enter save",
      "escape cancel",
    ]) {
      expect(hint).toContain(fragment);
    }
  });

  it("names the user's own keys in the hint", async () => {
    await Promise.resolve();
    expect(
      buildPiConfigHint({
        up: ["ctrl+p"],
        down: ["ctrl+n"],
        confirm: ["ctrl+s"],
        cancel: ["ctrl+g"],
      }),
    ).toBe(
      "ctrl+p/ctrl+n move · space toggle · a all · n none · ctrl+s save · ctrl+g cancel",
    );
  });

  it("seeds from a stored record and never selects what a child cannot load", async () => {
    await Promise.resolve();
    const state = initialPiConfigSelection(STORED_WITH_MISSING, INVENTORY);
    expect(state.mode).toBe("explicit");
    expect([...state.selected]).toEqual(["npm:pi-vim"]);
    // Remembered rather than forgotten: "removed" is gone from the inventory
    // and "gone" is present but unavailable; both were part of the stored
    // selection, and both have to be visible before the user decides.
    expect([...(state.unavailableStored ?? [])].sort()).toEqual([
      "/project/.pi/extensions/gone.ts",
      "npm:removed",
    ]);
  });
});

describe("pi-config mandatory row without inventory evidence", () => {
  it("still pins one locked Weave row when no entry is mandatory", async () => {
    await Promise.resolve();
    // Task 10 degradation can legitimately return an inventory that never
    // observed the adapter. The row states a contract, so it stays.
    const degraded = INVENTORY.filter((item) => !item.mandatory);
    const rows = buildPiConfigRows(degraded);
    expect(rows[0]).toEqual({ kind: "mandatory" });
    expect(rows[1]).toEqual({ kind: "inherit" });
    expect(rows.filter((row) => row.kind === "mandatory")).toHaveLength(1);

    const lines = harness({
      entries: degraded,
      readOnly: true,
    }).component.render(140);
    const mandatory = lineFor(lines, PI_CONFIG_MANDATORY_ROW_LABEL);
    expect(mandatory).toBeDefined();
    expect(mandatory).toContain("mandatory");
    // Honest about the gap instead of implying evidence it does not have.
    expect(mandatory).toContain(PI_CONFIG_MANDATORY_UNLISTED_TAG);
    // No checkbox, no toggle, no payload.
    expect(mandatory).not.toContain("[x]");
    expect(mandatory).not.toContain("[ ]");
  });

  it("keeps the locked row un-toggleable and out of every payload", async () => {
    await Promise.resolve();
    const degraded = INVENTORY.filter((item) => !item.mandatory);
    const { component, saves } = harness({ entries: degraded });
    component.handleInput(KEY_UP); // onto the pinned row
    component.handleInput(KEY_SPACE); // deliberate no-op
    component.handleInput("a");
    component.handleInput(KEY_ENTER);
    const intent = saves[0];
    expect(intent?.kind).toBe("explicit");
    const ids =
      intent?.kind === "explicit"
        ? intent.record.entries.map((item) => item.id)
        : [];
    expect(ids).toEqual(["npm:pi-vim", "/project/.pi/extensions/lint.ts"]);
  });
});

describe("pi-config stored entries the live inventory lost", () => {
  it("merges a stored-only entry as an unavailable row it can recognize", async () => {
    await Promise.resolve();
    const merged = mergePiConfigEntries(INVENTORY, STORED_WITH_MISSING);
    const stored = merged.find((item) => item.id === "npm:removed");
    expect(stored).toEqual({
      id: "npm:removed",
      label: "removed",
      source: "npm:removed",
      path: "/ext/removed.ts",
      scope: PI_CONFIG_STORED_ONLY_SCOPE,
      mandatory: false,
      available: false,
    });
    // A live entry is never duplicated or overwritten by the stored copy.
    expect(merged.filter((item) => item.id === "npm:pi-vim")).toHaveLength(1);
    expect(mergePiConfigEntries(INVENTORY, undefined)).toEqual(INVENTORY);
  });

  it("shows the drift, its consequence, and the way to keep it", async () => {
    await Promise.resolve();
    const lines = harness({ record: STORED_WITH_MISSING }).component.render(
      160,
    );
    const rendered = lines.join("\n");
    const row = lineFor(lines, "removed");
    expect(row).toBeDefined();
    // Scope claims only what is known, and the row says what saving costs.
    expect(row).toContain(PI_CONFIG_STORED_ONLY_SCOPE);
    expect(row).toContain(PI_CONFIG_UNAVAILABLE_TAG);
    expect(row).toContain(PI_CONFIG_DROPPED_TAG);
    // A stored row is not an unchecked box the user forgot to tick.
    expect(row).not.toContain("[ ]");
    // The live-but-unavailable stored entry gets the same treatment.
    expect(lineFor(lines, "gone")).toContain(PI_CONFIG_DROPPED_TAG);
    expect(rendered).toContain(
      "2 stored extensions are unavailable and saving drops them; cancel keeps the stored selection.",
    );
    // Stored-only rows sort last, after every scope the inventory proved.
    const optional = buildPiConfigRows(
      mergePiConfigEntries(INVENTORY, STORED_WITH_MISSING),
    ).flatMap((item) => (item.kind === "optional" ? [item.entry.label] : []));
    expect(optional).toEqual(["pi-vim", "gone", "lint", "removed"]);
  });

  it("never lets a stored-only row be toggled or saved", async () => {
    await Promise.resolve();
    const { component, saves } = harness({ record: STORED_WITH_MISSING });
    // inherit -> pi-vim -> gone -> lint -> removed
    for (let step = 0; step < 4; step += 1) component.handleInput(KEY_DOWN);
    expect(
      component.render(160).find((line) => line.startsWith("\u203a")),
    ).toContain("removed");
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ENTER);
    // Saving a corrected selection persists only what a child could load,
    // matching the spawn path's dropped-entry semantics.
    expect(saves[0]).toEqual({
      kind: "explicit",
      record: {
        schemaVersion: 1,
        mode: "explicit",
        entries: [
          {
            id: "npm:pi-vim",
            source: "npm:pi-vim",
            path: "/ext/npm-pi-vim.ts",
            label: "pi-vim",
          },
        ],
      },
    });
  });

  it("select-all still refuses every unavailable stored entry", async () => {
    await Promise.resolve();
    const { component, saves } = harness({ record: STORED_WITH_MISSING });
    component.handleInput("a");
    component.handleInput(KEY_ENTER);
    const intent = saves[0];
    const ids =
      intent?.kind === "explicit"
        ? intent.record.entries.map((item) => item.id)
        : [];
    expect(ids).toEqual(["npm:pi-vim", "/project/.pi/extensions/lint.ts"]);
  });

  it("cancelling proposes no change at all, so the stored record survives", async () => {
    await Promise.resolve();
    const { component, saves, cancels } = harness({
      record: STORED_WITH_MISSING,
    });
    component.handleInput(KEY_DOWN);
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ESCAPE);
    expect(saves).toEqual([]);
    expect(cancels.count).toBe(1);
  });

  it("keeps every line inside the terminal with stored-only rows merged", async () => {
    await Promise.resolve();
    const { component } = harness({ record: STORED_WITH_MISSING });
    for (const width of [1, 4, 12, 40, 200]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("pi-config overlay input", () => {
  it("moves the cursor and never lets it rest on the locked row", async () => {
    await Promise.resolve();
    const { component, changes } = harness();
    // Opens on the inherit row, immediately below the locked Weave row.
    expect(
      component.render(120).find((line) => line.startsWith("›")),
    ).toContain(PI_CONFIG_INHERIT_ROW_LABEL);
    component.handleInput(KEY_UP);
    expect(
      component.render(120).find((line) => line.startsWith("›")),
    ).toContain(PI_CONFIG_MANDATORY_ROW_LABEL);
    // The locked row still cannot be toggled, and the save stays inherit-all.
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ENTER);
    expect(changes.count).toBeGreaterThan(0);
  });

  it("toggling an extension leaves inherit-all and saves an explicit record", async () => {
    await Promise.resolve();
    const { component, saves } = harness();
    component.handleInput(KEY_DOWN); // pi-vim
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ENTER);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({
      kind: "explicit",
      record: {
        schemaVersion: 1,
        mode: "explicit",
        entries: [
          {
            id: "npm:pi-vim",
            source: "npm:pi-vim",
            path: "/ext/npm-pi-vim.ts",
            label: "pi-vim",
          },
        ],
      },
    });
  });

  it("select-all takes every available entry and never the mandatory one", async () => {
    await Promise.resolve();
    const { component, saves } = harness();
    component.handleInput("a");
    component.handleInput(KEY_ENTER);
    const intent = saves[0];
    expect(intent?.kind).toBe("explicit");
    const ids =
      intent?.kind === "explicit"
        ? intent.record.entries.map((item) => item.id)
        : [];
    expect(ids).toEqual(["npm:pi-vim", "/project/.pi/extensions/lint.ts"]);
    expect(ids).not.toContain(WEAVE_ENTRY.id);
  });

  it("select-none saves an explicit record with no optional entries", async () => {
    await Promise.resolve();
    const { component, saves } = harness();
    component.handleInput("a");
    component.handleInput("n");
    component.handleInput(KEY_ENTER);
    expect(saves[0]).toEqual({
      kind: "explicit",
      record: { schemaVersion: 1, mode: "explicit", entries: [] },
    });
  });

  it("refuses to toggle an unavailable entry", async () => {
    await Promise.resolve();
    const { component, saves } = harness();
    component.handleInput(KEY_DOWN); // pi-vim
    component.handleInput(KEY_DOWN); // the unavailable "gone" row
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ENTER);
    expect(saves[0]).toEqual({ kind: "inherit-all" });
  });

  it("round-trips an explicit record back to inherit-all", async () => {
    await Promise.resolve();
    const record: ChildExtensionSelectionRecord = {
      schemaVersion: 1,
      mode: "explicit",
      entries: [
        {
          id: "npm:pi-vim",
          source: "npm:pi-vim",
          path: "/ext/npm-pi-vim.ts",
          label: "pi-vim",
        },
      ],
    };
    const { component, saves } = harness({ record });
    expect(component.render(120).join("\n")).toContain("1 of 3");
    // The inherit row is reachable from the opening cursor position.
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ENTER);
    expect(saves[0]).toEqual({ kind: "inherit-all" });
  });

  it("cancels without producing any save intent", async () => {
    await Promise.resolve();
    const { component, saves, cancels } = harness();
    component.handleInput("a");
    component.handleInput(KEY_ESCAPE);
    expect(saves).toEqual([]);
    expect(cancels.count).toBe(1);
  });

  it("settles exactly once, whatever arrives afterwards", async () => {
    await Promise.resolve();
    const saved = harness();
    saved.component.handleInput(KEY_ENTER);
    saved.component.handleInput(KEY_ENTER);
    saved.component.handleInput(KEY_ESCAPE);
    expect(saved.saves).toHaveLength(1);
    expect(saved.cancels.count).toBe(0);

    const cancelled = harness();
    cancelled.component.handleInput(KEY_ESCAPE);
    cancelled.component.handleInput(KEY_ESCAPE);
    cancelled.component.handleInput(KEY_ENTER);
    expect(cancelled.cancels.count).toBe(1);
    expect(cancelled.saves).toEqual([]);
  });

  it("reports a stale generation once and then stops rendering", async () => {
    await Promise.resolve();
    let current = true;
    const stale: number[] = [];
    const component = createPiConfigComponent({
      entries: INVENTORY,
      getTerminalRows: () => 30,
      isCurrent: () => current,
      onStale: () => stale.push(1),
      onSave: () => undefined,
      onCancel: () => undefined,
    });
    expect(component.render(120).length).toBeGreaterThan(0);
    current = false;
    expect(component.render(120)).toEqual([]);
    component.handleInput(KEY_ENTER);
    expect(stale).toHaveLength(1);
  });
});

describe("pi-config overlay read-only and payload validation", () => {
  it("opens read-only with honest copy and cannot save", async () => {
    await Promise.resolve();
    const { component, saves, cancels } = harness({ readOnly: true });
    const lines = component.render(120);
    expect(lines.join("\n")).toContain(
      "Read-only: the extension inventory is incomplete, so no selection can be saved.",
    );
    expect(lines[lines.length - 1]).not.toContain("toggle");
    component.handleInput("a");
    component.handleInput(KEY_SPACE);
    component.handleInput(KEY_ENTER);
    expect(saves).toEqual([]);
    expect(cancels.count).toBe(1);
  });

  it("refuses a payload that names the Weave adapter", async () => {
    await Promise.resolve();
    expect(
      buildPiConfigSaveIntent({
        state: { mode: "explicit", selected: new Set([WEAVE_ENTRY.id]) },
        entries: INVENTORY,
      })._unsafeUnwrapErr(),
    ).toEqual({ reason: "mandatory-entry-in-payload" });
    // Even an "inherit all" request may not carry it: the adapter is derived
    // at spawn time, so naming it could only ever be wrong.
    expect(
      buildPiConfigSaveIntent({
        state: { mode: "inherit-all", selected: new Set([WEAVE_ENTRY.id]) },
        entries: INVENTORY,
      })._unsafeUnwrapErr(),
    ).toEqual({ reason: "mandatory-entry-in-payload" });
    expect(
      buildPiConfigSaveIntent({
        state: { mode: "explicit", selected: new Set() },
        entries: INVENTORY,
        readOnly: true,
      })._unsafeUnwrapErr(),
    ).toEqual({ reason: "read-only" });
  });

  it("drops an entry whose path a child could not safely load", async () => {
    await Promise.resolve();
    const unsafe = entry({ id: "npm:bad", label: "bad", path: "relative.ts" });
    const intent = buildPiConfigSaveIntent({
      state: { mode: "explicit", selected: new Set(["npm:bad"]) },
      entries: [WEAVE_ENTRY, unsafe],
    })._unsafeUnwrap();
    expect(intent).toEqual({
      kind: "explicit",
      record: { schemaVersion: 1, mode: "explicit", entries: [] },
    });
  });
});

describe("pi-config overlay layout", () => {
  it("never renders a line wider than the terminal", async () => {
    await Promise.resolve();
    const wide = entry({
      id: "npm:very-long",
      label: "an extension with a deliberately very long descriptive label",
      scope: "project",
    });
    const { component } = harness({ entries: [WEAVE_ENTRY, wide] });
    for (const width of [1, 4, 12, 40, 200]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("never claims more rows than the terminal has", async () => {
    await Promise.resolve();
    const many = Array.from({ length: 40 }, (_, index) =>
      entry({ id: `npm:ext-${index}`, label: `ext-${index}` }),
    );
    for (const rows of [1, 6, 10, 24, 80]) {
      const component = createPiConfigComponent({
        entries: [WEAVE_ENTRY, ...many],
        getTerminalRows: () => rows,
        onSave: () => undefined,
        onCancel: () => undefined,
      });
      expect(component.render(80).length).toBeLessThanOrEqual(rows);
    }
  });

  it("scrolls to keep the cursor visible in a short terminal", async () => {
    await Promise.resolve();
    const many = Array.from({ length: 30 }, (_, index) =>
      entry({
        id: `npm:ext-${index}`,
        label: `ext-${String(index).padStart(2, "0")}`,
      }),
    );
    const component = createPiConfigComponent({
      entries: [WEAVE_ENTRY, ...many],
      getTerminalRows: () => 16,
      onSave: () => undefined,
      onCancel: () => undefined,
    });
    for (let step = 0; step < 20; step += 1) component.handleInput(KEY_DOWN);
    const cursorLine = component
      .render(80)
      .find((line) => line.startsWith("›"));
    expect(cursorLine).toContain("ext-19");
  });
});
