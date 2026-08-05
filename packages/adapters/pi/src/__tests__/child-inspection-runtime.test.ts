import { describe, expect, test } from "bun:test";
import {
  clearChildOverlayGeneration,
  clearThreadSources,
  closeChildOverlay,
  createChildInspectionEditorCell,
  createChildInspectionRegistryCell,
  createChildInspectionRuntime,
  createChildOverlayCell,
  createChildOverlayKeysCell,
  createChildTreeSelectionCell,
  createDelegationControllerCell,
  createThreadSourcesCell,
} from "../child-inspection-runtime.js";
import { ROOT_NODE_ID } from "../child-tree.js";
import { PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC } from "../child-overlay-keys.js";

describe("child-inspection-runtime cells", () => {
  test("constructors start empty and clear helpers drop generation state", () => {
    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const threadSourcesCell = createThreadSourcesCell();
    const treeSelectionCell = createChildTreeSelectionCell();
    const editorCell = createChildInspectionEditorCell();
    const registryCell = createChildInspectionRegistryCell();
    const delegationCell = createDelegationControllerCell();

    expect(overlayCell.open).toBe(false);
    expect(overlayKeysCell.status).toBe("pending");
    expect(overlayKeysCell.diagnostics).toEqual([
      PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC,
    ]);
    expect(treeSelectionCell.selectedId).toBe(ROOT_NODE_ID);
    expect(editorCell.editor).toBeUndefined();
    expect(registryCell.registry).toBeUndefined();
    expect(delegationCell.controller).toBeUndefined();

    overlayCell.open = true;
    overlayCell.generationId = "gen-1";
    overlayCell.settle = () => undefined;
    overlayKeysCell.plan = {
      registrations: [],
      diagnostics: [],
    } as never;
    overlayKeysCell.generationId = "gen-1";
    threadSourcesCell.cacheMode = "active";

    closeChildOverlay(overlayCell, overlayKeysCell);
    expect(overlayCell.open).toBe(false);
    expect(overlayCell.settle).toBeUndefined();

    clearChildOverlayGeneration(overlayCell, overlayKeysCell);
    expect(overlayCell.controller).toBeUndefined();
    expect(overlayCell.generationId).toBeUndefined();
    expect(overlayKeysCell.plan).toBeUndefined();
    expect(overlayKeysCell.generationId).toBeUndefined();
    // Exactly-once registration status survives generation clear.
    expect(overlayKeysCell.status).toBe("pending");

    clearThreadSources(threadSourcesCell);
    expect(threadSourcesCell.refs).toBeUndefined();
    expect(threadSourcesCell.sessions).toBeUndefined();
    expect(threadSourcesCell.cache).toBeUndefined();
    expect(threadSourcesCell.cacheMode).toBeUndefined();
  });

  test("createChildInspectionRuntime refuses picker work without a live generation", async () => {
    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: createChildInspectionEditorCell(),
      inspectionRegistryCell: createChildInspectionRegistryCell(),
      treeSelectionCell: createChildTreeSelectionCell(),
      threadSourcesCell: createThreadSourcesCell(),
      delegationControllerCell: createDelegationControllerCell(),
      latestSessionCtx: () => undefined,
      activeGenerationId: () => undefined,
      parentSessionState: () => ({ persistence: "unknown", sessionId: "" }),
      childInspectionSettings: () => undefined,
      closeOverlay: () => closeChildOverlay(overlayCell, overlayKeysCell),
    });

    await runtime.openChildPicker(
      {
        cwd: "/repo",
        hasUI: true,
        ui: {
          notify: () => undefined,
          select: async () => undefined,
        },
      } as never,
      "gen-missing",
    );

    expect(overlayKeysCell.diagnostics).toEqual([
      PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC,
    ]);
  });
});
