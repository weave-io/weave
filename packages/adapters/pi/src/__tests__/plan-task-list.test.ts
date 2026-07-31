import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PlanTaskNode, PlanTaskSnapshot } from "@weaveio/weave-engine";
import {
  createPlanTaskListComponent,
  PI_PLAN_TASK_LIST_SHORTCUT,
  type PlanTaskListThemePort,
  planTaskListMaxScroll,
  planTaskListOffsetForIndex,
  planTaskListRowBudget,
  planTaskListVisibleRows,
  renderPlanTaskListLines,
} from "../plan-task-list.js";

function parent(
  id: string,
  title: string,
  state: PlanTaskNode["state"],
): PlanTaskNode {
  return { id, title, state, children: [] };
}

function snapshotOf(
  parents: readonly PlanTaskNode[],
  planName = "demo-plan",
): PlanTaskSnapshot {
  return {
    planName,
    contentRevision: "rev-1",
    format: "canonical",
    parents,
    totalParentCount: parents.length,
    complete: parents.every((node) => node.state === "completed"),
  };
}

function manyTasks(count: number): PlanTaskNode[] {
  return Array.from({ length: count }, (_, index) =>
    parent(String(index + 1), `Task ${index + 1}`, "pending"),
  );
}

/**
 * Stand-in for Pi's `Theme`. Real themes add only ANSI escapes, which have no
 * visible width, so this fake must not add printable characters either.
 */
const fakeTheme: PlanTaskListThemePort = {
  fg: (_color, text) => `\u001b[38;5;42m${text}\u001b[39m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

/** Raw byte sequences the real terminal sends for the default bindings. */
const KEY = {
  up: "\u001b[A",
  down: "\u001b[B",
  escape: "\u001b",
  ctrlC: "\u0003",
  pageDown: "\u001b[6~",
  j: "j",
  k: "k",
  q: "q",
} as const;

describe("plan-task-list rendering", () => {
  it("pins the shortcut this module owns to alt+t", () => {
    expect(PI_PLAN_TASK_LIST_SHORTCUT).toBe("alt+t");
  });

  it("renders every task with its state marker and marks the active one", () => {
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf([
        parent("1", "Read the plan", "completed"),
        parent("2", "Write the code", "in_progress"),
        parent("3", "Ship it", "pending"),
      ]),
      viewport: { rows: 20, scrollOffset: 0 },
    });

    expect(lines[0]).toBe('Plan "demo-plan" - 3 tasks');
    expect(lines).toContain("  [x] 1. Read the plan");
    // `selectActivePlanTask` prefers the in-progress task, so it carries the cursor.
    expect(lines).toContain("\u203a [~] 2. Write the code");
    expect(lines).toContain("  [ ] 3. Ship it");
    expect(lines.at(-1)).toBe("Up/Down scrolls, Esc closes");
  });

  it("singularizes the title for a one-task plan", () => {
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf([parent("1", "Only task", "pending")]),
      viewport: { rows: 20, scrollOffset: 0 },
    });
    expect(lines[0]).toBe('Plan "demo-plan" - 1 task');
  });

  it("explains an empty plan instead of opening an empty popup", () => {
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf([]),
      viewport: { rows: 20, scrollOffset: 0 },
      hint: "Esc closes",
    });
    expect(lines).toEqual([
      'Plan "demo-plan" - 0 tasks',
      "",
      "This plan has no tasks.",
      "Esc closes",
    ]);
  });

  it("keeps the rendered output bounded by the viewport and reports the remainder", () => {
    const rows = 12;
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(40)),
      viewport: { rows, scrollOffset: 0 },
    });

    const visible = planTaskListVisibleRows(rows);
    expect(visible).toBe(8);
    // Title, blank line, task rows, hint.
    expect(lines).toHaveLength(visible + 3);
    expect(lines.at(-1)).toBe("32 more \u2014 Up/Down scrolls, Esc closes");
  });

  it("scrolls the window rather than truncating the plan", () => {
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(40)),
      viewport: { rows: 12, scrollOffset: 5 },
    });

    expect(lines[2]).toBe("  [ ] 6. Task 6");
    expect(lines).not.toContain("  [ ] 5. Task 5");
  });

  it("clamps a scroll offset beyond the end back to the last full window", () => {
    const maxScroll = planTaskListMaxScroll(40, 12);
    expect(maxScroll).toBe(32);

    const clamped = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(40)),
      viewport: { rows: 12, scrollOffset: 9999 },
    });
    const atMax = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(40)),
      viewport: { rows: 12, scrollOffset: maxScroll },
    });
    expect(clamped).toEqual(atMax);
    expect(clamped.at(-2)).toBe("  [ ] 40. Task 40");
  });

  it("clamps a negative scroll offset to the top", () => {
    expect(
      renderPlanTaskListLines({
        snapshot: snapshotOf(manyTasks(10)),
        viewport: { rows: 12, scrollOffset: -4 },
      }),
    ).toEqual(
      renderPlanTaskListLines({
        snapshot: snapshotOf(manyTasks(10)),
        viewport: { rows: 12, scrollOffset: 0 },
      }),
    );
  });

  it("never claims more rows than a pathologically small terminal has", () => {
    expect(planTaskListVisibleRows(1)).toBe(0);
    expect(planTaskListVisibleRows(0)).toBe(0);
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(4)),
      viewport: { rows: 1, scrollOffset: 0 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('Plan "demo-plan" - 4 tasks');
  });

  it("renders a compact two-line state on a two-row terminal", () => {
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(4)),
      viewport: { rows: 2, scrollOffset: 0 },
    });
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)).toBe("4 more \u2014 Up/Down scrolls, Esc closes");
  });

  it("drops the blank separator before it drops task rows", () => {
    const lines = renderPlanTaskListLines({
      snapshot: snapshotOf(manyTasks(4)),
      viewport: { rows: 4, scrollOffset: 0 },
    });
    expect(lines).toHaveLength(4);
    expect(lines).not.toContain("");
    expect(lines.at(-1)).toBe("2 more \u2014 Up/Down scrolls, Esc closes");
  });

  it("never emits more lines than the viewport for rows 1 through 12", () => {
    for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      for (const count of [0, 1, 30]) {
        const lines = renderPlanTaskListLines({
          snapshot: snapshotOf(manyTasks(count)),
          viewport: { rows, scrollOffset: 0 },
        });
        expect(lines.length).toBeLessThanOrEqual(rows);
      }
    }
  });

  it("caps the viewport on an enormous terminal", () => {
    expect(planTaskListVisibleRows(500)).toBe(24);
    expect(planTaskListMaxScroll(200, 500)).toBe(176);
  });

  it("never reports a negative max scroll for a plan smaller than the viewport", () => {
    expect(planTaskListMaxScroll(2, 20)).toBe(0);
    expect(planTaskListMaxScroll(0, 20)).toBe(0);
  });

  it("cannot scroll at all when no task rows are visible", () => {
    expect(planTaskListVisibleRows(2)).toBe(0);
    expect(planTaskListMaxScroll(50, 2)).toBe(0);
    expect(planTaskListMaxScroll(50, 1)).toBe(0);
    expect(planTaskListOffsetForIndex(40, 50, 2)).toBe(0);
    expect(planTaskListOffsetForIndex(40, 50, 1)).toBe(0);
  });
});

describe("plan-task-list terminal-height budgeting", () => {
  it("reserves rows for Pi's own editor and footer", () => {
    expect(planTaskListRowBudget(30)).toBe(24);
    expect(planTaskListVisibleRows(planTaskListRowBudget(30))).toBe(20);
  });

  it("falls back to a conservative height when the host reports nothing usable", () => {
    for (const rows of [
      undefined,
      0,
      -10,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(planTaskListRowBudget(rows)).toBe(18);
    }
  });

  it("never budgets more rows than a tiny terminal actually has", () => {
    expect(planTaskListRowBudget(4)).toBe(4);
    expect(planTaskListVisibleRows(planTaskListRowBudget(4))).toBe(2);
  });

  it("stays within the terminal and above zero for every small height", () => {
    for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const budget = planTaskListRowBudget(rows);
      expect(budget).toBeLessThanOrEqual(rows);
      expect(budget).toBeGreaterThanOrEqual(1);
    }
  });

  it("stays within the terminal for arbitrary finite positive heights", () => {
    for (const rows of [1, 2, 7, 13, 14, 27, 33, 34, 100, 999, 4.9]) {
      const budget = planTaskListRowBudget(rows);
      expect(budget).toBeGreaterThanOrEqual(1);
      expect(budget).toBeLessThanOrEqual(Math.trunc(rows));
    }
  });

  it("never exceeds the maximum viewport on a very tall terminal", () => {
    expect(planTaskListRowBudget(400)).toBe(28);
    expect(planTaskListVisibleRows(planTaskListRowBudget(400))).toBe(24);
  });
});

describe("plan-task-list active-task visibility", () => {
  it("keeps an off-screen active task inside the opening window", () => {
    expect(planTaskListOffsetForIndex(30, 40, 12)).toBe(23);
    expect(planTaskListOffsetForIndex(2, 40, 12)).toBe(0);
    expect(planTaskListOffsetForIndex(undefined, 40, 12)).toBe(0);
    expect(planTaskListOffsetForIndex(39, 40, 12)).toBe(32);
  });
});

describe("plan-task-list width safety", () => {
  const widths = [1, 2, 5, 12, 20, 40, 80, 200];

  function assertBounded(lines: readonly string[], width: number): void {
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
    }
  }

  it("bounds every plain line to the requested width", () => {
    const snapshot = snapshotOf([
      parent(
        "1",
        "A very long task title that will not fit anywhere",
        "completed",
      ),
      parent(
        "2",
        "Another extremely long title used to force truncation",
        "in_progress",
      ),
      ...manyTasks(30),
    ]);
    for (const width of widths) {
      const component = createPlanTaskListComponent({
        snapshot,
        onCancel: () => {},
      });
      assertBounded(component.render(width), width);
    }
  });

  it("bounds every themed line, ANSI styling included", () => {
    const snapshot = snapshotOf(
      [
        parent("1", "Long completed title ".repeat(6), "completed"),
        parent("2", "Long active title ".repeat(6), "in_progress"),
        parent("3", "Long pending title ".repeat(6), "pending"),
      ],
      "a-plan-name-that-is-itself-quite-long-indeed",
    );
    for (const width of widths) {
      const component = createPlanTaskListComponent({
        snapshot,
        theme: fakeTheme,
        onCancel: () => {},
      });
      const lines = component.render(width);
      assertBounded(lines, width);
      expect(lines.some((line) => line.includes("\u001b["))).toBe(true);
    }
  });

  it("bounds wide Unicode titles without splitting past the width", () => {
    const snapshot = snapshotOf(
      [
        parent("1", "日本語のとても長いタスクのタイトルです", "in_progress"),
        parent("2", "🚀🚀🚀 emoji heavy task title 🚀🚀🚀", "pending"),
        parent("3", "한국어 제목 테스트 매우 긴 제목", "completed"),
      ],
      "プラン名",
    );
    for (const width of widths) {
      const component = createPlanTaskListComponent({
        snapshot,
        theme: fakeTheme,
        onCancel: () => {},
      });
      assertBounded(component.render(width), width);
    }
  });

  it("bounds the empty-plan body too", () => {
    for (const width of widths) {
      const component = createPlanTaskListComponent({
        snapshot: snapshotOf([], "a-very-long-plan-name-for-an-empty-plan"),
        theme: fakeTheme,
        onCancel: () => {},
      });
      assertBounded(component.render(width), width);
    }
  });

  it("treats a zero or negative width as one column", () => {
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(5)),
      onCancel: () => {},
    });
    assertBounded(component.render(0), 0);
    assertBounded(component.render(-8), -8);
  });
});

describe("plan-task-list component behaviour", () => {
  it("derives its viewport from the live terminal height", () => {
    let rows: number | undefined = 40;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(60)),
      getTerminalRows: () => rows,
      onCancel: () => {},
    });
    // 40 rows - 6 host rows - 4 chrome rows, capped at 24.
    expect(component.render(80)).toHaveLength(24 + 3);

    rows = 14;
    expect(component.render(80)).toHaveLength(4 + 3);

    rows = undefined;
    expect(component.render(80)).toHaveLength(14 + 3);
  });

  it("scrolls with the configured up and down bindings and clamps both ends", () => {
    let renders = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(40)),
      getTerminalRows: () => 22,
      onCancel: () => {},
      onChange: () => {
        renders += 1;
      },
    });
    const first = (): string | undefined => component.render(80)[2];

    // Every task is pending, so the resolver treats the first as active.
    expect(first()).toBe("\u203a [ ] 1. Task 1");
    component.handleInput(KEY.up);
    expect(first()).toBe("\u203a [ ] 1. Task 1");

    component.handleInput(KEY.down);
    expect(first()).toBe("  [ ] 2. Task 2");
    component.handleInput(KEY.down);
    expect(first()).toBe("  [ ] 3. Task 3");
    component.handleInput(KEY.up);
    expect(first()).toBe("  [ ] 2. Task 2");

    // 22 rows -> 16 popup rows -> 12 visible task rows -> max scroll 28.
    for (let index = 0; index < 200; index += 1)
      component.handleInput(KEY.down);
    expect(first()).toBe("  [ ] 29. Task 29");
    expect(component.render(80).at(-2)).toBe("  [ ] 40. Task 40");
    expect(renders).toBeGreaterThan(0);
  });

  it("cannot underflow or overflow an empty or single-task plan", () => {
    for (const parents of [[], [parent("1", "Only", "pending")]]) {
      const component = createPlanTaskListComponent({
        snapshot: snapshotOf(parents),
        onCancel: () => {},
      });
      const before = component.render(80);
      component.handleInput(KEY.up);
      component.handleInput(KEY.down);
      component.handleInput(KEY.down);
      expect(component.render(80)).toEqual(before);
    }
  });

  it("opens on the active task when it is below the first window", () => {
    const parents = manyTasks(40);
    parents[29] = parent("30", "Task 30", "in_progress");
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(parents),
      getTerminalRows: () => 22,
      onCancel: () => {},
    });
    expect(component.render(80)).toContain("\u203a [~] 30. Task 30");
  });

  it("cancels exactly once and ignores later input", () => {
    let cancels = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(40)),
      onCancel: () => {
        cancels += 1;
      },
    });
    component.handleInput(KEY.escape);
    component.handleInput(KEY.escape);
    component.handleInput(KEY.ctrlC);
    component.handleInput(KEY.down);
    expect(cancels).toBe(1);
  });

  it("ignores keys it does not own, including the removed j/k/q fallbacks", () => {
    let cancels = 0;
    let changes = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(40)),
      onCancel: () => {
        cancels += 1;
      },
      onChange: () => {
        changes += 1;
      },
    });
    const before = component.render(80);
    for (const data of [KEY.j, KEY.k, KEY.q, KEY.pageDown, "enter", "x"]) {
      component.handleInput(data);
    }
    expect(cancels).toBe(0);
    expect(changes).toBe(0);
    expect(component.render(80)).toEqual(before);
  });

  it("honours alternate keybindings supplied by the host", () => {
    let cancels = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(40)),
      getTerminalRows: () => 22,
      keybindings: {
        getKeys: (binding) => {
          if (binding === "tui.select.up") return ["alt+k"];
          if (binding === "tui.select.down") return ["alt+j"];
          return ["ctrl+q"];
        },
      },
      onCancel: () => {
        cancels += 1;
      },
    });

    // Default keys are no longer bound, so they do nothing.
    component.handleInput(KEY.down);
    component.handleInput(KEY.escape);
    expect(cancels).toBe(0);
    expect(component.render(80)[2]).toBe("\u203a [ ] 1. Task 1");

    component.handleInput("\u001bj");
    expect(component.render(80)[2]).toBe("  [ ] 2. Task 2");
    component.handleInput("\u001bk");
    expect(component.render(80)[2]).toBe("\u203a [ ] 1. Task 1");

    component.handleInput("\u0011");
    expect(cancels).toBe(1);
    // The hint names the keys the user actually has bound.
    expect(component.render(80).at(-1)).toContain("alt+k/alt+j");
    expect(component.render(80).at(-1)).toContain("ctrl+q closes");
  });

  it("falls back to Pi's defaults when no keybinding manager or getKeys function is available", () => {
    for (const keybindings of [undefined, {}] as const) {
      let cancels = 0;
      const component = createPlanTaskListComponent({
        snapshot: snapshotOf(manyTasks(40)),
        keybindings,
        onCancel: () => {
          cancels += 1;
        },
      });
      component.handleInput(KEY.down);
      expect(component.render(80)[2]).toBe("  [ ] 2. Task 2");
      component.handleInput(KEY.escape);
      expect(cancels).toBe(1);
      expect(component.render(80).at(-1)).toContain(
        "up/down scrolls, escape closes",
      );
    }
  });

  it("treats empty injected bindings as unbound", () => {
    let cancels = 0;
    let changes = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(40)),
      keybindings: {
        getKeys: (binding) => {
          if (binding === "tui.select.up") return [];
          if (binding === "tui.select.down") return [];
          return [];
        },
      },
      onCancel: () => {
        cancels += 1;
      },
      onChange: () => {
        changes += 1;
      },
    });
    const before = component.render(80);

    for (const data of [KEY.up, KEY.down, KEY.escape, KEY.ctrlC]) {
      component.handleInput(data);
    }

    expect(cancels).toBe(0);
    expect(changes).toBe(0);
    expect(component.render(80)).toEqual(before);
    expect(component.render(80).at(-1)).toContain(
      "unbound/unbound scrolls, unbound closes",
    );
  });

  it("rebuilds themed output after invalidate so a theme change takes effect", () => {
    let palette = "old";
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(3)),
      theme: {
        fg: (_color, text) => `<${palette}>${text}`,
        bold: (text) => text,
      },
      onCancel: () => {},
    });
    expect(component.render(80).join("\n")).toContain("<old>");

    palette = "new";
    // Without invalidate the cached themed strings are returned unchanged.
    expect(component.render(80).join("\n")).toContain("<old>");

    component.invalidate();
    const rebuilt = component.render(80).join("\n");
    expect(rebuilt).toContain("<new>");
    expect(rebuilt).not.toContain("<old>");
  });

  it("re-renders after a width change without an explicit invalidate", () => {
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf([
        parent(
          "1",
          "A title long enough to be truncated at 20 columns",
          "pending",
        ),
      ]),
      onCancel: () => {},
    });
    const narrow = component.render(20);
    const wide = component.render(80);
    expect(narrow).not.toEqual(wide);
    expect(visibleWidth(narrow[2] ?? "")).toBeLessThanOrEqual(20);
    expect(wide[2]).toContain("truncated at 20 columns");
  });

  it("renders nothing once its generation is no longer current", () => {
    let current = true;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(5)),
      isCurrent: () => current,
      onCancel: () => {},
    });
    expect(component.render(80).length).toBeGreaterThan(0);
    current = false;
    expect(component.render(80)).toEqual([]);
  });

  it("reports staleness once so the host can close the overlay it owns", () => {
    let current = true;
    let staleReports = 0;
    let cancels = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(5)),
      isCurrent: () => current,
      onStale: () => {
        staleReports += 1;
      },
      onCancel: () => {
        cancels += 1;
      },
      onChange: () => {
        // A host that re-renders on change must not be able to loop here.
        component.render(80);
      },
    });

    expect(component.render(80).length).toBeGreaterThan(0);
    expect(staleReports).toBe(0);

    current = false;
    // Render and input both arrange closure, and both do it only once, so a
    // re-rendering host cannot drive an unbounded loop of settlements.
    expect(component.render(80)).toEqual([]);
    expect(component.render(80)).toEqual([]);
    component.handleInput("\u001b");
    component.handleInput("j");
    expect(staleReports).toBe(1);
    // Staleness is not a cancel: the host settles the overlay itself.
    expect(cancels).toBe(0);
  });

  it("cancels exactly once and ignores input afterwards", () => {
    let cancels = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(5)),
      onCancel: () => {
        cancels += 1;
      },
    });
    component.handleInput("\u001b");
    component.handleInput("\u001b");
    component.handleInput("j");
    expect(cancels).toBe(1);
  });
});

describe("plan-task-list tiny-terminal geometry", () => {
  const snapshots: readonly [string, PlanTaskSnapshot][] = [
    ["empty plan", snapshotOf([])],
    ["single-task plan", snapshotOf([parent("1", "Only task", "in_progress")])],
    ["long plan", snapshotOf(manyTasks(120))],
    [
      "unicode plan",
      snapshotOf([
        parent("1", "🚀 ship the 日本語 renderer ✨", "completed"),
        parent("2", "e\u0301tude combinée ".repeat(8), "in_progress"),
        ...manyTasks(20),
      ]),
    ],
  ];

  it("never renders more lines than its own row budget, at any height", () => {
    for (const [label, snapshot] of snapshots) {
      for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        const component = createPlanTaskListComponent({
          snapshot,
          getTerminalRows: () => rows,
          onCancel: () => {},
        });
        const rendered = component.render(80);
        const budget = planTaskListRowBudget(rows);
        expect(budget).toBeLessThanOrEqual(rows);
        expect({
          label,
          rows,
          rendered: rendered.length,
          budget,
          fits: rendered.length <= budget,
        }).toMatchObject({ fits: true });
      }
    }
  });

  it("keeps every line inside the width even on a tiny terminal", () => {
    for (const [, snapshot] of snapshots) {
      for (const rows of [1, 2, 4, 8]) {
        for (const width of [1, 3, 12, 40]) {
          const component = createPlanTaskListComponent({
            snapshot,
            theme: fakeTheme,
            getTerminalRows: () => rows,
            onCancel: () => {},
          });
          for (const line of component.render(width)) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it("re-budgets on a live shrink and on a live grow", () => {
    let rows: number | undefined = 40;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(60)),
      getTerminalRows: () => rows,
      onCancel: () => {},
    });
    expect(component.render(80).length).toBeLessThanOrEqual(
      planTaskListRowBudget(40),
    );

    rows = 4;
    const shrunk = component.render(80);
    expect(shrunk.length).toBeLessThanOrEqual(4);
    expect(shrunk.length).toBeLessThanOrEqual(planTaskListRowBudget(4));

    rows = 1;
    expect(component.render(80)).toHaveLength(1);

    rows = 40;
    const grown = component.render(80);
    expect(grown.length).toBeGreaterThan(shrunk.length);
    expect(grown.length).toBeLessThanOrEqual(planTaskListRowBudget(40));
  });

  it("falls back to the conservative height for undefined and invalid heights", () => {
    const invalid = [
      undefined,
      0,
      -10,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ] as const;
    for (const rows of invalid) {
      expect(planTaskListRowBudget(rows)).toBe(18);
      const component = createPlanTaskListComponent({
        snapshot: snapshotOf(manyTasks(60)),
        getTerminalRows: () => rows,
        onCancel: () => {},
      });
      expect(component.render(80).length).toBeLessThanOrEqual(18);
      expect(component.render(80)).toHaveLength(17);
    }
  });

  it("stays cancellable through the configured binding on a one-row terminal", () => {
    let cancels = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(60)),
      keybindings: { getKeys: () => ["q"] },
      getTerminalRows: () => 1,
      onCancel: () => {
        cancels += 1;
      },
    });
    expect(component.render(80)).toHaveLength(1);
    component.handleInput("q");
    expect(cancels).toBe(1);
    component.handleInput("q");
    expect(cancels).toBe(1);
  });

  it("ignores scroll keys when no task rows are visible", () => {
    let changes = 0;
    const component = createPlanTaskListComponent({
      snapshot: snapshotOf(manyTasks(60)),
      getTerminalRows: () => 2,
      onCancel: () => {},
      onChange: () => {
        changes += 1;
      },
    });
    const before = component.render(80);
    component.handleInput(KEY.down);
    component.handleInput(KEY.down);
    component.handleInput(KEY.up);
    expect(component.render(80)).toEqual(before);
    // Scroll keys are still consumed, but nothing can move: the offset cannot
    // underflow or run off the end of a plan the viewport cannot show.
    expect(changes).toBe(3);
  });
});
