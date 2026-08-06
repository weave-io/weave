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
  releaseChildOverlayTerminalInput,
} from "../child-inspection-runtime.js";
import { PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC } from "../child-overlay-keys.js";
import { PiChildInspectionRegistry, ROOT_NODE_ID } from "../child-tree.js";
import type { PiExtensionApi, PiTerminalInputHandler } from "../types.js";

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

describe("pre-mount overlay keys under a foreign primary editor", () => {
  /**
   * Models `pi-vim`: `pi.registerShortcut` is accepted by the host, but the
   * registered handler is never dispatched, because a custom editor owns
   * input. Only `ctx.ui.onTerminalInput` still sees the raw frames.
   */
  function terminalInputHost(): {
    readonly onTerminalInput: (handler: PiTerminalInputHandler) => () => void;
    readonly listeners: PiTerminalInputHandler[];
    readonly emit: (data: string) => boolean;
    unsubscribeCalls: number;
  } {
    const listeners: PiTerminalInputHandler[] = [];
    const host = {
      listeners,
      unsubscribeCalls: 0,
      onTerminalInput: (handler: PiTerminalInputHandler) => {
        listeners.push(handler);
        return () => {
          const index = listeners.indexOf(handler);
          if (index === -1) return;
          listeners.splice(index, 1);
          host.unsubscribeCalls += 1;
        };
      },
      // Mirrors Pi's TUI: listeners run before any component or shortcut
      // routing, and a consuming listener stops the frame.
      emit: (data: string) => {
        for (const listener of [...listeners]) {
          const result = listener(data);
          if (result?.consume === true) return true;
        }
        return false;
      },
    };
    return host;
  }

  async function registryWithChildren(
    ...childIds: readonly string[]
  ): Promise<PiChildInspectionRegistry> {
    const registry = new PiChildInspectionRegistry();
    for (const childId of childIds) {
      await registry.register({
        id: childId,
        parentId: ROOT_NODE_ID,
        name: childId,
        kind: "ordinary",
        snapshot: () => ({
          id: childId,
          parentId: undefined,
          name: childId,
          status: "running",
          currentTurn: 1,
          currentTool: undefined,
          startedAtMs: 1,
          elapsedMs: 0,
          usage: {} as never,
          latestOutput: "",
        }),
      });
    }
    return registry;
  }

  function runtimeUnderForeignEditor(
    registry: PiChildInspectionRegistry | undefined,
    input: ReturnType<typeof terminalInputHost> | undefined,
  ): {
    readonly runtime: ReturnType<typeof createChildInspectionRuntime>;
    readonly overlayCell: ReturnType<typeof createChildOverlayCell>;
    readonly overlayKeysCell: ReturnType<typeof createChildOverlayKeysCell>;
    readonly treeSelectionCell: ReturnType<typeof createChildTreeSelectionCell>;
    readonly focused: string[];
    readonly selects: string[];
    readonly notices: string[];
  } {
    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const editorCell = createChildInspectionEditorCell();
    const treeSelectionCell = createChildTreeSelectionCell();
    const focused: string[] = [];
    editorCell.activate = (childId) => {
      focused.push(childId);
    };
    const selects: string[] = [];
    const notices: string[] = [];
    const registryCell = createChildInspectionRegistryCell();
    registryCell.registry = registry;
    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: editorCell,
      inspectionRegistryCell: registryCell,
      treeSelectionCell,
      threadSourcesCell: createThreadSourcesCell(),
      delegationControllerCell: createDelegationControllerCell(),
      latestSessionCtx: () =>
        ({
          cwd: "/repo",
          hasUI: true,
          ui: {
            notify: (message: string) => notices.push(message),
            select: async (title: string) => {
              selects.push(title);
              return undefined;
            },
            ...(input === undefined
              ? {}
              : { onTerminalInput: input.onTerminalInput }),
          },
        }) as never,
      activeGenerationId: () => "gen-1",
      parentSessionState: () => ({ persistence: "unknown", sessionId: "" }),
      childInspectionSettings: () => undefined,
      closeOverlay: () => closeChildOverlay(overlayCell, overlayKeysCell),
      hostKeybindings: () => ({ getResolvedBindings: () => ({}) }),
    });
    return {
      runtime,
      overlayCell,
      overlayKeysCell,
      treeSelectionCell,
      focused,
      selects,
      notices,
    };
  }

  test("Alt+1 reaches child selection before the overlay is mounted", async () => {
    const { pi, registered } = recordingPi();
    const input = terminalInputHost();
    const { runtime, focused } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    // The host accepted the raw registration, but a foreign editor owns
    // dispatch, so the shortcut handler is never invoked.
    expect(registered.has("alt+1")).toBe(true);
    expect(focused).toEqual([]);

    expect(input.emit("\u001b1")).toBe(true);
    expect(focused).toEqual(["child-1"]);
  });

  test("Alt+I reaches the picker route before the overlay is mounted", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, selects, notices } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(input.emit("\u001bi")).toBe(true);
    // The picker route is asynchronous: the listener dispatches it, and the
    // bounded picker then either prompts or explains why it cannot.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect([...selects, ...notices].length).toBeGreaterThan(0);
  });

  test("sibling shortcuts share the same dispatch path", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, treeSelectionCell, focused } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1", "child-2"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(input.emit("\u001b2")).toBe(true);
    expect(focused).toEqual(["child-2"]);

    // Pre-mount focus lives in the live tree selection, which is what the
    // sibling route reads when no overlay controller is mounted.
    treeSelectionCell.selectedId = "child-2";
    expect(input.emit("\u001b[1;3D")).toBe(true);
    expect(focused).toEqual(["child-2", "child-1"]);
  });

  test("ordinary input, Escape, and unrelated Alt keys pass through", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, focused, selects } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    for (const data of ["a", "hello", "\u001b", "\u001bx", "\u0003", "\r"]) {
      expect(input.emit(data)).toBe(false);
    }
    expect(focused).toEqual([]);
    expect(selects).toEqual([]);
  });

  test("a mounted overlay keeps ownership, so no action is handled twice", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell, focused } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    overlayCell.open = true;

    expect(input.emit("\u001b1")).toBe(false);
    expect(focused).toEqual([]);
  });

  test("exactly one listener, released on teardown and reinstalled once", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell, overlayKeysCell } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);

    clearChildOverlayGeneration(overlayCell, overlayKeysCell);
    expect(input.listeners.length).toBe(0);
    expect(input.unsubscribeCalls).toBe(1);
    expect(overlayKeysCell.terminalInput).toBeUndefined();

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);

    releaseChildOverlayTerminalInput(overlayKeysCell);
    expect(input.listeners.length).toBe(0);
    expect(input.unsubscribeCalls).toBe(2);
    // Releasing twice is safe and does not unsubscribe anything else.
    releaseChildOverlayTerminalInput(overlayKeysCell);
    expect(input.unsubscribeCalls).toBe(2);
  });

  test("degrades with a diagnostic when the host exposes no input listener", async () => {
    const { pi, registered } = recordingPi();
    const { runtime, overlayKeysCell } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      undefined,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    expect(registered.has("alt+1")).toBe(true);
    expect(overlayKeysCell.status).toBe("applied");
    expect(overlayKeysCell.terminalInput).toBeUndefined();
    expect(
      overlayKeysCell.diagnostics.some((line) =>
        line.includes("ui.onTerminalInput"),
      ),
    ).toBe(true);
  });
});
