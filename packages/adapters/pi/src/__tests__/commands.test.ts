import { describe, expect, it } from "bun:test";
import {
  buildChildPickerEntries,
  sanitizeChildPickerPreview,
} from "../child-picker.js";
import {
  classifyWeaveCommand,
  WEAVE_CLEAR_CHILDREN_COMMAND_NAME,
  WEAVE_COMMAND_NAMES,
  WEAVE_INSPECT_COMMAND_NAME,
  WEAVE_PI_CONFIG_COMMAND_NAME,
  WEAVE_RECOVERY_COMMAND_NAME,
} from "../commands.js";

describe("Pi command, history, and picker integration proof", () => {
  it("has one exact command tuple with classifications", async () => {
    await Promise.resolve();
    expect(WEAVE_INSPECT_COMMAND_NAME).toBe("weave:inspect");
    expect(WEAVE_CLEAR_CHILDREN_COMMAND_NAME).toBe("weave:clear-children");
    expect(WEAVE_RECOVERY_COMMAND_NAME).toBe("weave:recover-children");
    expect(WEAVE_COMMAND_NAMES).toEqual([
      "weave:start",
      "weave:run",
      "weave:status",
      "weave:abort",
      "weave:advance",
      "weave:health",
      "weave:resume",
      "weave:plan",
      "weave:artifact",
      "weave:inspect",
      "weave:history",
      "weave:doctor",
      "weave:clear-children",
      "weave:recover-children",
      "weave:pi-config",
    ]);
    expect(new Set(WEAVE_COMMAND_NAMES).size).toBe(15);
    expect(classifyWeaveCommand("weave:inspect")).toBe("read-only");
    expect(classifyWeaveCommand("weave:history")).toBe("read-only");
    expect(classifyWeaveCommand("weave:doctor")).toBe("read-only");
    expect(classifyWeaveCommand("weave:clear-children")).toBe(
      "idempotent-cleanup",
    );
    expect(classifyWeaveCommand("weave:recover-children")).toBe("mutating");
  });

  it("classifies child-extension configuration as mutating", async () => {
    await Promise.resolve();
    // The command writes a durable preference that changes how every future
    // child is spawned, so health-only mode must block it.
    expect(WEAVE_PI_CONFIG_COMMAND_NAME).toBe("weave:pi-config");
    expect(WEAVE_COMMAND_NAMES).toContain(WEAVE_PI_CONFIG_COMMAND_NAME);
    expect(classifyWeaveCommand(WEAVE_PI_CONFIG_COMMAND_NAME)).toBe("mutating");
  });

  it("builds inspect options from trusted live and history breadcrumbs only", async () => {
    await Promise.resolve();
    const result = buildChildPickerEntries({
      live: [
        {
          childId: "live",
          name: "nested",
          kind: "nested",
          parentId: "root",
          status: "running",
          live: true,
          workflowInstanceId: "wf",
          stepName: "step",
        },
      ],
      history: [
        {
          childId: "old",
          name: "old",
          kind: "workflow-step",
          status: "settled",
          live: false,
          workflowInstanceId: "wf",
          stepName: "done",
        },
      ],
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((entry) => entry.label).join(" ")).toContain(
        "wf / step",
      );
      expect(result.value.map((entry) => entry.id)).not.toContain("session");
      expect(result.value.map((entry) => entry.id)).not.toContain("checkpoint");
      expect(result.value.map((entry) => entry.id)).not.toContain("task");
    }
  });

  it("exposes recover, resume, and clear actions for selected children", async () => {
    await Promise.resolve();
    const result = buildChildPickerEntries({
      live: [
        {
          childId: "child",
          name: "child",
          kind: "ordinary",
          status: "running",
          live: true,
          resumable: true,
        },
      ],
      history: [
        {
          childId: "old",
          name: "old",
          kind: "ordinary",
          status: "interrupted",
          live: false,
          recoverable: true,
        },
      ],
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((entry) => entry.action)).toEqual([
        undefined,
        undefined,
        "resume",
        undefined,
        "recover",
        "clear",
      ]);
      expect(
        result.value.find((entry) => entry.action === "recover")?.node?.childId,
      ).toBe("old");
    }
  });

  it("sanitizes picker previews without leaking control bytes", async () => {
    await Promise.resolve();
    expect(sanitizeChildPickerPreview("\u001b[31msecret\u001b[0m\nnext")).toBe(
      "secret next",
    );
  });

  it("rejects duplicate live/history IDs before picker mutation", async () => {
    await Promise.resolve();
    const result = buildChildPickerEntries({
      live: [
        {
          childId: "same",
          name: "a",
          kind: "ordinary",
          status: "running",
          live: true,
        },
      ],
      history: [
        {
          childId: "same",
          name: "b",
          kind: "ordinary",
          status: "settled",
          live: false,
        },
      ],
    });
    expect(result.isErr()).toBe(true);
  });
});
