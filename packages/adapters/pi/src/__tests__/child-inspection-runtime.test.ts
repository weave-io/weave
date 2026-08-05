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
import { PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC } from "../child-overlay-keys.js";
import { PiChildInspectionRegistry, ROOT_NODE_ID } from "../child-tree.js";
import type { PiExtensionApi } from "../types.js";

/** Records raw shortcut registrations exactly as the host would receive them. */
function recordingPi(): {
  readonly pi: PiExtensionApi;
  readonly registered: Map<string, (ctx: never) => unknown>;
} {
  const registered = new Map<string, (ctx: never) => unknown>();
  const pi = {
    registerShortcut: (
      shortcut: string,
      registration: { handler: (ctx: never) => unknown },
    ) => {
      registered.set(shortcut, registration.handler);
    },
  } as unknown as PiExtensionApi;
  return { pi, registered };
}

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

describe("overlay key registration independent of editor ownership", () => {
  /** Builds a runtime whose only conflict source is the host keybindings port. */
  function runtimeWithHostKeybindings(
    hostKeybindings: (() => unknown) | undefined,
    activeGenerationId: () => string | undefined = () => "gen-1",
    registry?: PiChildInspectionRegistry,
  ): {
    readonly runtime: ReturnType<typeof createChildInspectionRuntime>;
    readonly overlayCell: ReturnType<typeof createChildOverlayCell>;
    readonly overlayKeysCell: ReturnType<typeof createChildOverlayKeysCell>;
    readonly focused: string[];
    readonly notices: string[];
  } {
    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const editorCell = createChildInspectionEditorCell();
    const focused: string[] = [];
    editorCell.activate = (childId) => {
      focused.push(childId);
    };
    const notices: string[] = [];
    const registryCell = createChildInspectionRegistryCell();
    registryCell.registry = registry;
    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: editorCell,
      inspectionRegistryCell: registryCell,
      treeSelectionCell: createChildTreeSelectionCell(),
      threadSourcesCell: createThreadSourcesCell(),
      delegationControllerCell: createDelegationControllerCell(),
      latestSessionCtx: () =>
        ({
          cwd: "/repo",
          hasUI: true,
          ui: {
            notify: (message: string) => notices.push(message),
            select: async () => undefined,
          },
        }) as never,
      activeGenerationId,
      parentSessionState: () => ({ persistence: "unknown", sessionId: "" }),
      childInspectionSettings: () => undefined,
      closeOverlay: () => closeChildOverlay(overlayCell, overlayKeysCell),
      ...(hostKeybindings === undefined ? {} : { hostKeybindings }),
    });
    return { runtime, overlayCell, overlayKeysCell, focused, notices };
  }

  test("registers overlay shortcuts from the host keybindings port with no editor factory", () => {
    // Models `pi-vim` owning the primary editor: Weave's composed editor
    // factory never runs, so no keybindings object is ever injected.
    const { pi, registered } = recordingPi();
    const { runtime, overlayKeysCell } = runtimeWithHostKeybindings(() => ({
      getResolvedBindings: () => ({ "app.interrupt": "ctrl+c" }),
    }));

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(overlayKeysCell.status).toBe("applied");
    expect(registered.has("alt+i")).toBe(true);
    expect(registered.has("alt+1")).toBe(true);
    expect(registered.has("alt+9")).toBe(true);
  });

  test("accepts a host manager exposing only getEffectiveConfig", () => {
    const { pi, registered } = recordingPi();
    const { runtime, overlayKeysCell } = runtimeWithHostKeybindings(() => ({
      getEffectiveConfig: () => ({ "app.interrupt": "ctrl+c" }),
    }));

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(overlayKeysCell.status).toBe("applied");
    expect(registered.has("alt+i")).toBe(true);
  });

  test("reports and never overwrites a key the user already owns", () => {
    const { pi, registered } = recordingPi();
    const { runtime, overlayKeysCell } = runtimeWithHostKeybindings(() => ({
      getResolvedBindings: () => ({ "app.message.followUp": ["alt+i"] }),
    }));

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(registered.has("alt+i")).toBe(false);
    expect(registered.has("alt+1")).toBe(true);
    expect(
      overlayKeysCell.diagnostics.some(
        (line) =>
          line.includes("weave.child.picker.open") &&
          line.includes("alt+i") &&
          line.includes("app.message.followUp"),
      ),
    ).toBe(true);
  });

  test("fails closed when no host keybindings can be inspected", () => {
    const { pi, registered } = recordingPi();
    const { runtime, overlayKeysCell } = runtimeWithHostKeybindings(undefined);

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(registered.size).toBe(0);
    expect(overlayKeysCell.status).toBe("pending");
    expect(
      overlayKeysCell.diagnostics.some((line) =>
        line.includes("weave overlay keys skipped"),
      ),
    ).toBe(true);
  });

  test("survives a throwing host keybindings accessor", () => {
    const { pi, registered } = recordingPi();
    const { runtime, overlayKeysCell } = runtimeWithHostKeybindings(() => {
      throw new Error("host exploded");
    });

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(registered.size).toBe(0);
    expect(overlayKeysCell.status).toBe("pending");
  });

  test("a shortcut registered for one generation serves its replacement", async () => {
    const { pi, registered } = recordingPi();
    let generationId: string | undefined;
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "child-1",
      parentId: ROOT_NODE_ID,
      name: "shuttle",
      kind: "ordinary",
      snapshot: () => ({
        id: "child-1",
        parentId: undefined,
        name: "shuttle",
        status: "running",
        currentTurn: 1,
        currentTool: undefined,
        startedAtMs: 1,
        elapsedMs: 0,
        usage: {} as never,
        latestOutput: "",
      }),
    });
    const { runtime, overlayCell, overlayKeysCell, focused } =
      runtimeWithHostKeybindings(
        () => ({ getResolvedBindings: () => ({}) }),
        () => generationId,
        registry,
      );

    // Registration happens during session activation, exactly as the
    // extension does, while the first generation is live.
    generationId = "gen-old";
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-old");
    const slotOne = registered.get("alt+1");
    expect(slotOne).toBeDefined();
    const afterFirstGeneration = registered.size;

    // Generation teardown drops the plan but keeps the host registrations.
    clearChildOverlayGeneration(overlayCell, overlayKeysCell);
    generationId = undefined;
    await slotOne?.(undefined as never);
    expect(focused).toEqual([]);

    // The replacement generation re-plans behind the very same raw key.
    generationId = "gen-new";
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-new");
    expect(registered.size).toBe(afterFirstGeneration);
    expect(overlayKeysCell.generationId).toBe("gen-new");

    await slotOne?.(undefined as never);
    expect(focused).toEqual(["child-1"]);
  });

  test("registration is exactly once across activation and later factory offers", () => {
    const { pi, registered } = recordingPi();
    const { runtime } = runtimeWithHostKeybindings(() => ({
      getResolvedBindings: () => ({}),
    }));

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    const afterBoot = registered.size;
    runtime.maybeRegisterOverlayKeys(
      pi,
      { getResolvedBindings: () => ({}) },
      "gen-1",
    );

    expect(registered.size).toBe(afterBoot);
  });
});
