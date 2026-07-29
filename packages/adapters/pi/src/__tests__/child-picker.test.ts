import { describe, expect, it } from "bun:test";
import {
  buildChildPickerEntries,
  moveChildPicker,
  sanitizeChildPickerPreview,
} from "../child-picker.js";

const node = (childId: string, overrides: Record<string, unknown> = {}) => ({
  childId,
  name: childId,
  kind: "ordinary" as const,
  status: "running",
  live: true,
  ...overrides,
});

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
});
