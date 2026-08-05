import { describe, expect, it } from "bun:test";
import {
  buildChildPickerEntries,
  buildChildPickerMetadataEntries,
  childPickerTaskFirstLine,
  createChildPickerEntries,
  createChildPickerMetadataEntries,
  moveChildPicker,
  PI_CHILD_PICKER_BOUNDS,
  PI_CHILD_PICKER_STATUSES,
  resolveChildPickerTitle,
  sanitizeChildPickerPreview,
  type PiChildPickerCandidate,
  type PiChildPickerStatus,
} from "../child-picker.js";

const node = (childId: string, overrides: Record<string, unknown> = {}) => ({
  childId,
  name: childId,
  kind: "ordinary" as const,
  status: "running",
  live: true,
  ...overrides,
});

const candidate = (
  childId: string,
  overrides: Partial<PiChildPickerCandidate> = {},
): PiChildPickerCandidate => ({
  childId,
  threadId: overrides.threadId ?? `thread-${childId}`,
  status: overrides.status ?? "running",
  agent: overrides.agent ?? "shuttle-mini",
  createdAt: overrides.createdAt ?? 1_000,
  updatedAt: overrides.updatedAt ?? 1_000,
  active: overrides.active ?? false,
  treeOrder: overrides.treeOrder ?? 0,
  sourceState: overrides.sourceState ?? "available",
  ...overrides,
});

const formatTimestamp = (epochMs: number): string => `local:${epochMs}`;

describe("child picker", () => {
  it("builds root, nested, workflow, and history hierarchy", () => {
    const result = buildChildPickerEntries({
      live: [
        node("a"),
        node("b", { parentId: "a", kind: "nested" }),
        node("step", { parentId: "a", kind: "workflow-step" }),
      ],
      history: [
        node("old", {
          status: "settled",
          live: false,
          recoverable: true,
          resumable: true,
        }),
      ],
    });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries[0]?.id).toBe("root");
    expect(entries.find((entry) => entry.id === "b")?.depth).toBe(1);
    expect(entries.find((entry) => entry.id === "old")?.label).toContain(
      "history:",
    );
    expect(entries.some((entry) => entry.action === "recover")).toBe(true);
    expect(entries.some((entry) => entry.action === "resume")).toBe(true);
  });

  it("sanitizes and bounds previews", () => {
    const preview = sanitizeChildPickerPreview(
      `\x1b[31mhello\x1b[0m\n${"x".repeat(500)}`,
    );
    expect(preview).not.toContain("\x1b");
    expect(preview.length).toBeLessThanOrEqual(240);
  });

  it("rejects duplicate ids and missing parents", () => {
    expect(
      buildChildPickerEntries({ live: [node("x"), node("x")] }).isErr(),
    ).toBe(true);
    expect(
      buildChildPickerEntries({
        live: [node("x", { parentId: "missing" })],
      }).isErr(),
    ).toBe(true);
  });

  it("shows trusted workflow breadcrumbs and only clears terminal history", () => {
    const result = buildChildPickerEntries({
      live: [
        node("live-step", {
          kind: "workflow-step",
          workflowInstanceId: "wf-1",
          stepName: "review",
        }),
      ],
      history: [
        node("interrupted-root", {
          live: false,
          status: "interrupted",
          recoverable: true,
          workflowInstanceId: "wf-1",
          stepName: "recover",
        }),
        node("running-history", { live: false, status: "running" }),
      ],
    });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries.find((entry) => entry.id === "live-step")?.label).toContain(
      "wf-1 / review",
    );
    expect(entries.some((entry) => entry.id === "interrupted-root:clear")).toBe(
      true,
    );
    expect(entries.some((entry) => entry.id === "running-history:clear")).toBe(
      false,
    );
  });

  it("moves selection within bounds", () => {
    const state = {
      entries: [{ id: "root", label: "root", preview: "", depth: 0 }],
      selected: 0,
    };
    expect(moveChildPicker(state, 1).selected).toBe(0);
    expect(moveChildPicker(state, -1).selected).toBe(0);
  });

  it("keeps the legacy createChildPickerEntries alias", () => {
    expect(createChildPickerEntries).toBe(buildChildPickerEntries);
    expect(createChildPickerMetadataEntries).toBe(
      buildChildPickerMetadataEntries,
    );
  });
});

describe("child picker metadata", () => {
  it("includes every planned status", () => {
    const result = buildChildPickerMetadataEntries({
      formatTimestamp,
      candidates: PI_CHILD_PICKER_STATUSES.map((status, index) =>
        candidate(`c-${status}`, {
          status,
          active: status === "running",
          treeOrder: index,
          updatedAt: 1_000 + index,
        }),
      ),
    });
    expect(result.isOk()).toBe(true);
    const statuses = new Set(result._unsafeUnwrap().map((entry) => entry.status));
    for (const status of PI_CHILD_PICKER_STATUSES) {
      expect(statuses.has(status)).toBe(true);
    }
  });

  it("orders active by tree order, then nonactive newest with child-id ties", () => {
    const result = buildChildPickerMetadataEntries({
      formatTimestamp,
      candidates: [
        candidate("z-old", {
          active: false,
          updatedAt: 10,
          createdAt: 10,
          status: "settled",
        }),
        candidate("a-new", {
          active: false,
          updatedAt: 50,
          createdAt: 40,
          status: "completed",
        }),
        candidate("b-tie", {
          active: false,
          updatedAt: 50,
          createdAt: 40,
          status: "failed",
        }),
        candidate("active-2", { active: true, treeOrder: 2, status: "running" }),
        candidate("active-1", { active: true, treeOrder: 1, status: "queued" }),
      ],
    });
    expect(result._unsafeUnwrap().map((entry) => entry.childId)).toEqual([
      "active-1",
      "active-2",
      "a-new",
      "b-tie",
      "z-old",
    ]);
  });

  it("resolves title precedence and never keeps raw task remainder", () => {
    expect(
      resolveChildPickerTitle({
        explicitTitle: "Explicit",
        taskFirstLine: "Task line\nSECRET_REMAINDER",
        workflowStep: "step",
        agent: "agent",
      }),
    ).toBe("Explicit");
    expect(
      resolveChildPickerTitle({
        taskFirstLine: "Task line\nSECRET_REMAINDER",
        workflowStep: "step",
        agent: "agent",
      }),
    ).toBe("Task line");
    expect(
      resolveChildPickerTitle({
        workflowStep: "step",
        agent: "agent",
      }),
    ).toBe("step");
    expect(resolveChildPickerTitle({ agent: "agent" })).toBe("agent");

    const first = childPickerTaskFirstLine(
      `\x1b[31mfirst line\x1b[0m\nsecond line must not appear`,
    );
    expect(first).toBe("first line");
    expect(first).not.toContain("second");
    expect(first).not.toContain("must not appear");

    const built = buildChildPickerMetadataEntries({
      formatTimestamp,
      candidates: [
        candidate("t1", {
          taskFirstLine: "Only first\nRAW_TASK_BODY_SHOULD_NOT_LEAK",
          status: "settled",
        }),
      ],
    });
    const entry = built._unsafeUnwrap()[0];
    expect(entry?.title).toBe("Only first");
    expect(JSON.stringify(entry)).not.toContain("RAW_TASK_BODY");
  });

  it("injects the local timestamp formatter", () => {
    const result = buildChildPickerMetadataEntries({
      formatTimestamp: (ms) => `fmt(${ms})`,
      candidates: [
        candidate("c1", { updatedAt: 42, status: "settled" }),
      ],
    });
    expect(result._unsafeUnwrap()[0]?.timestampLabel).toBe("fmt(42)");
  });

  it("excludes stale and unavailable source rows", () => {
    const result = buildChildPickerMetadataEntries({
      formatTimestamp,
      candidates: [
        candidate("ok", { sourceState: "available", status: "running", active: true }),
        candidate("stale", { sourceState: "stale", status: "running" }),
        candidate("gone", { sourceState: "unavailable", status: "settled" }),
      ],
    });
    expect(result._unsafeUnwrap().map((entry) => entry.childId)).toEqual(["ok"]);
  });

  it("includes orphan candidates as read-only", () => {
    const result = buildChildPickerMetadataEntries({
      formatTimestamp,
      candidates: [
        candidate("orphan-1", {
          sourceState: "orphan",
          status: "settled",
          updatedAt: 9,
        }),
      ],
    });
    const entry = result._unsafeUnwrap()[0];
    expect(entry?.sourceState).toBe("orphan");
    expect(entry?.readOnly).toBe(true);
  });

  it("bounds candidate input and rejects unknown statuses", () => {
    const tooMany = Array.from(
      { length: PI_CHILD_PICKER_BOUNDS.maxCandidates + 1 },
      (_unused, index) => candidate(`c${index}`, { status: "settled" }),
    );
    expect(
      buildChildPickerMetadataEntries({
        formatTimestamp,
        candidates: tooMany,
      })._unsafeUnwrapErr().detail,
    ).toContain("at most");

    expect(
      buildChildPickerMetadataEntries({
        formatTimestamp,
        candidates: [
          candidate("bad", {
            status: "not-a-status" as PiChildPickerStatus,
          }),
        ],
      }).isErr(),
    ).toBe(true);
  });
});
