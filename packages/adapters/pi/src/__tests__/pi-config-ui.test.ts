import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ChildExtensionSelectionRecord } from "../child-extension-selection.js";
import {
  buildPiConfigHint,
  buildPiConfigRows,
  buildPiConfigSaveIntent,
  createPiConfigComponent,
  initialPiConfigSelection,
  PI_CONFIG_INHERIT_ROW_LABEL,
  PI_CONFIG_MANDATORY_ROW_LABEL,
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

  it("seeds from a stored record and drops entries the inventory lost", async () => {
    await Promise.resolve();
    const state = initialPiConfigSelection(
      {
        schemaVersion: 1,
        mode: "explicit",
        entries: [
          {
            id: "npm:pi-vim",
            source: "npm:pi-vim",
            path: "/ext/pi-vim.ts",
            label: "pi-vim",
          },
          {
            id: "npm:removed",
            source: "npm:removed",
            path: "/ext/removed.ts",
            label: "removed",
          },
        ],
      },
      INVENTORY,
    );
    expect(state.mode).toBe("explicit");
    expect([...state.selected]).toEqual(["npm:pi-vim"]);
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
