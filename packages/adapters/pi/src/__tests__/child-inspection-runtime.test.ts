import { describe, expect, test } from "bun:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import { errAsync, okAsync } from "neverthrow";
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
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceEntry,
} from "../child-overlay.js";
import {
  PI_CHILD_OVERLAY_SEARCH_TRIGGER,
  PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC,
} from "../child-overlay-keys.js";
import { SCROLL_KEYS } from "../child-overlay-types.js";
import { PiChildInspectionRegistry, ROOT_NODE_ID } from "../child-tree.js";
import type { PiExtensionApi, PiTerminalInputHandler } from "../types.js";

/** Records raw shortcut registrations exactly as the host would receive them. */
function recordingPi(): {
  readonly pi: PiExtensionApi;
  readonly registered: Map<string, (ctx: never) => unknown>;
  /** Total `registerShortcut` calls, so re-registration cannot hide in a Map. */
  readonly registrationCalls: () => number;
} {
  const registered = new Map<string, (ctx: never) => unknown>();
  let registrationCalls = 0;
  const pi = {
    registerShortcut: (
      shortcut: string,
      registration: { handler: (ctx: never) => unknown },
    ) => {
      registrationCalls += 1;
      registered.set(shortcut, registration.handler);
    },
  } as unknown as PiExtensionApi;
  return { pi, registered, registrationCalls: () => registrationCalls };
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
    readonly clearAll: () => void;
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
      // Mirrors Pi's `clearExtensionTerminalInputListeners`: every extension
      // listener is unsubscribed and the set emptied without telling the
      // extension, so the handle Weave still holds becomes an inert closure.
      // Deliberately silent, and deliberately not counted as an
      // adapter-driven unsubscribe.
      clearAll: () => {
        listeners.length = 0;
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
    readonly delegationCell: ReturnType<typeof createDelegationControllerCell>;
    readonly treeSelectionCell: ReturnType<typeof createChildTreeSelectionCell>;
    readonly focused: string[];
    readonly selects: string[];
    readonly notices: string[];
    readonly invalidateHost: () => void;
    readonly poisonHost: () => void;
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
    const delegationCell = createDelegationControllerCell();
    // Pi hands the extension runner one `ExtensionUIContext` per session bind
    // and exposes it by reference (`get ui() { return runner.uiContext; }`),
    // so the context object is stable for as long as a bind lasts and is
    // replaced only by the next bind. Modelling that identity faithfully is
    // what makes the host-identity guard meaningful; a helper that rebuilt the
    // context on every read would look like a permanent invalidation.
    const buildCtx = (): never =>
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
      }) as never;
    let liveCtx = buildCtx();
    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: editorCell,
      inspectionRegistryCell: registryCell,
      treeSelectionCell,
      threadSourcesCell: createThreadSourcesCell(),
      delegationControllerCell: delegationCell,
      latestSessionCtx: () => liveCtx,
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
      delegationCell,
      treeSelectionCell,
      focused,
      selects,
      notices,
      // Models one full Pi session invalidation: `resetExtensionUI` clears
      // every extension terminal-input listener, and the following bind hands
      // the runner a fresh `ExtensionUIContext`.
      invalidateHost: () => {
        input?.clearAll();
        liveCtx = buildCtx();
      },
      // Models a context retained across a session invalidation with no
      // replacement bind yet: Pi's `ExtensionContext.ui` getter calls
      // `assertActive()` and throws once the runner is stale, so plain
      // property access on the retained context throws.
      poisonHost: () => {
        input?.clearAll();
        liveCtx = {
          cwd: "/repo",
          hasUI: true,
          get ui(): never {
            throw new Error("extension context is no longer active");
          },
        } as never;
      },
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

  /** Lets the component's asynchronous input path settle. */
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Mounts a real controller and a real native component into the overlay
   * cell, exactly as the extension does when the native overlay opens.
   */
  async function mountRealOverlay(
    overlayCell: ReturnType<typeof createChildOverlayCell>,
    generationId: string,
  ): Promise<ReturnType<typeof createChildOverlayController>> {
    const overlayEntries: MemoryOverlaySourceEntry[] = Array.from(
      { length: 40 },
      (_unused, index) => ({
        id: `e${index}`,
        payload: {
          type: "message",
          id: `e${index}`,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `overlay line ${index}`,
          },
        },
      }),
    );
    const source = createMemoryChildOverlaySource([
      {
        childId: "overlay-1",
        threadId: "overlay-1",
        status: "live",
        generationId,
        runs: [{ run: 1, action: "start" }],
        branchIds: ["main"],
        descendantChildIds: [],
        entries: overlayEntries,
      },
    ]);
    const controller = createChildOverlayController(source, { pageSize: 40 });
    const opened = await controller.open("overlay-1");
    expect(opened.isOk()).toBe(true);
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );
    overlayCell.controller = controller;
    overlayCell.component = component;
    overlayCell.generationId = generationId;
    overlayCell.open = true;
    return controller;
  }

  test("one Escape closes the overlay, restores the parent, and never cancels", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const {
      runtime,
      overlayCell,
      overlayKeysCell,
      delegationCell,
      notices,
      selects,
    } = runtimeUnderForeignEditor(await registryWithChildren("child-1"), input);
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");

    const cancelled: string[] = [];
    delegationCell.controller = {
      cancelSubtree: (nodeId: string) => {
        cancelled.push(nodeId);
        return okAsync(undefined);
      },
    } as never;

    const controller = await mountRealOverlay(overlayCell, "gen-1");
    // The settle handle is what hands focus back to the parent session, so
    // running it exactly once is the observable "parent regains focus".
    let parentResumed = 0;
    overlayCell.settle = () => {
      parentResumed += 1;
    };
    runtime.bindOverlayKeyInterceptor("gen-1");
    const intercept = overlayKeysCell.interceptor;
    expect(intercept).toBeDefined();

    // A single Escape, not two, and no confirmation in between.
    expect(intercept?.("\u001b")).toBe(true);

    expect(overlayCell.open).toBe(false);
    expect(controller.isOpen()).toBe(false);
    expect(parentResumed).toBe(1);
    // The child keeps running: no cancel prompt and no cancel call.
    expect(selects).toEqual([]);
    expect(cancelled).toEqual([]);
    // No Escape hint is ever armed or surfaced.
    expect(
      notices.filter((notice) => notice.toLowerCase().includes("escape")),
    ).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toEqual([]);
  });

  test("search Escape exits search only and leaves the overlay open", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell, overlayKeysCell, delegationCell } =
      runtimeUnderForeignEditor(await registryWithChildren("child-1"), input);
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    const cancelled: string[] = [];
    delegationCell.controller = {
      cancelSubtree: (nodeId: string) => {
        cancelled.push(nodeId);
        return okAsync(undefined);
      },
    } as never;
    const controller = await mountRealOverlay(overlayCell, "gen-1");
    let parentResumed = 0;
    overlayCell.settle = () => {
      parentResumed += 1;
    };
    runtime.bindOverlayKeyInterceptor("gen-1");
    // The real mount wires the Task 13 interceptor as a constructor argument,
    // so the component under test is built the same way.
    const mounted = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
      (data: string) => overlayKeysCell.interceptor?.(data) ?? false,
    );
    overlayCell.component = mounted;

    // Ctrl+F opens the in-overlay search prompt.
    mounted.handleInput(PI_CHILD_OVERLAY_SEARCH_TRIGGER);
    // Escape while searching exits search and nothing else.
    mounted.handleInput("\u001b");

    expect(overlayCell.open).toBe(true);
    expect(controller.isOpen()).toBe(true);
    expect(parentResumed).toBe(0);
    expect(cancelled).toEqual([]);

    // The next Escape, with search off, closes the overlay.
    mounted.handleInput("\u001b");
    expect(overlayCell.open).toBe(false);
    expect(parentResumed).toBe(1);
    expect(cancelled).toEqual([]);
  });

  test("the raw scroll frames drive the mounted overlay exactly once each", async () => {
    // Pi 0.83 claims PageUp/PageDown for its own paging route before a mounted
    // custom component, so before the terminal-input route claimed the six
    // overlay scroll frames, raw PageUp never scrolled the live overlay.
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell, focused } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    const controller = await mountRealOverlay(overlayCell, "gen-1");
    const mounted = overlayCell.component;
    if (mounted === undefined) throw new Error("overlay was not mounted");
    // Pi stops routing a consumed frame, so each frame must reach the mounted
    // component exactly once: from this route, never also from host routing.
    const delivered: string[] = [];
    overlayCell.component = {
      render: (width: number) => mounted.render(width),
      handleInput: (data: string) => {
        delivered.push(data);
        mounted.handleInput(data);
      },
      invalidate: () => mounted.invalidate(),
    };

    expect(controller.view()._unsafeUnwrap().liveTail).toBe(true);

    // PageUp disengages live tail and raises the newer-lines cue.
    expect(input.emit(SCROLL_KEYS.pageUp)).toBe(true);
    await flush();
    const firstPage = controller.view()._unsafeUnwrap();
    expect(firstPage.scrollOffset).toBeGreaterThan(0);
    expect(firstPage.liveTail).toBe(false);
    expect(mounted.render(80).join("\n")).toContain("newer line(s) below");

    // A second page moves further back, so paging is not a one-shot that
    // immediately re-pins to the tail.
    expect(input.emit(SCROLL_KEYS.pageUp)).toBe(true);
    await flush();
    const secondPage = controller.view()._unsafeUnwrap().scrollOffset;
    expect(secondPage).toBeGreaterThan(firstPage.scrollOffset);

    expect(input.emit(SCROLL_KEYS.pageDown)).toBe(true);
    await flush();
    const afterPageDown = controller.view()._unsafeUnwrap().scrollOffset;
    expect(afterPageDown).toBeLessThan(secondPage);

    // Shift+Up / Shift+Down are the conflict-safe aliases for paging, sent by
    // a live Pi 0.83 PTY in the event-aware Kitty-compatible encoding
    // (`ESC [ 1;2:1 A`), not the legacy `ESC [ 1;2 A` the raw binder used to
    // require. They must reach the component as canonical PageUp/PageDown.
    expect(input.emit("\x1b[1;2:1A")).toBe(true);
    await flush();
    const afterShiftUp = controller.view()._unsafeUnwrap().scrollOffset;
    expect(afterShiftUp).toBeGreaterThan(afterPageDown);

    // Event reporting also delivers a release for the same physical press; it
    // must not scroll again and must not be consumed.
    expect(input.emit("\x1b[1;2:3A")).toBe(false);
    await flush();
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBe(afterShiftUp);

    expect(input.emit("\x1b[1;2:1B")).toBe(true);
    await flush();
    expect(controller.view()._unsafeUnwrap().scrollOffset).toBeLessThan(
      afterShiftUp,
    );

    // Home reaches the oldest retained row, End follows output again.
    expect(input.emit(SCROLL_KEYS.home)).toBe(true);
    await flush();
    expect(controller.view()._unsafeUnwrap().liveTail).toBe(false);

    expect(input.emit(SCROLL_KEYS.end)).toBe(true);
    await flush();
    const followed = controller.view()._unsafeUnwrap();
    expect(followed.scrollOffset).toBe(0);
    expect(followed.liveTail).toBe(true);
    expect(mounted.render(80).join("\n")).not.toContain("newer line(s) below");

    expect(delivered).toEqual([
      SCROLL_KEYS.pageUp,
      SCROLL_KEYS.pageUp,
      SCROLL_KEYS.pageDown,
      // Normalized from the live event-aware Shift+Up / Shift+Down frames.
      SCROLL_KEYS.pageUp,
      SCROLL_KEYS.pageDown,
      SCROLL_KEYS.home,
      SCROLL_KEYS.end,
    ]);
    // Nothing on the scroll route reached the pre-mount child-focus route.
    expect(focused).toEqual([]);
  });

  test("a scroll frame for a replaced generation is never dispatched", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    const controller = await mountRealOverlay(overlayCell, "gen-1");
    // The mounted overlay belongs to a generation that is no longer live.
    overlayCell.generationId = "gen-0";

    expect(input.emit(SCROLL_KEYS.pageUp)).toBe(false);
    await flush();

    const view = controller.view()._unsafeUnwrap();
    expect(view.scrollOffset).toBe(0);
    expect(view.liveTail).toBe(true);
  });

  test("an open overlay with no mounted component fails closed", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    overlayCell.open = true;
    overlayCell.generationId = "gen-1";

    expect(input.emit(SCROLL_KEYS.pageUp)).toBe(false);
  });

  test("a throwing component never leaks the frame or the exception", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayCell } = runtimeUnderForeignEditor(
      await registryWithChildren("child-1"),
      input,
    );
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    await mountRealOverlay(overlayCell, "gen-1");
    overlayCell.component = {
      render: () => [],
      handleInput: () => {
        throw new Error("component is gone");
      },
      invalidate: () => undefined,
    };

    expect(input.emit(SCROLL_KEYS.pageUp)).toBe(false);
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
    expect(overlayKeysCell.terminalInput).toBeUndefined();
    // Teardown drops the host identity with the handle, so the next
    // generation cannot mistake a dead host for the live one.
    expect(overlayKeysCell.terminalInputHost).toBeUndefined();

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);

    releaseChildOverlayTerminalInput(overlayKeysCell);
    expect(input.listeners.length).toBe(0);
    const afterRelease = input.unsubscribeCalls;
    // Releasing twice is safe and does not unsubscribe anything else.
    releaseChildOverlayTerminalInput(overlayKeysCell);
    expect(input.unsubscribeCalls).toBe(afterRelease);
    expect(input.listeners.length).toBe(0);
  });

  test("a silently cleared listener is rebound once on the next live host", async () => {
    const { pi, registered, registrationCalls } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayKeysCell, focused, invalidateHost } =
      runtimeUnderForeignEditor(await registryWithChildren("child-1"), input);

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);
    const boundHost = overlayKeysCell.terminalInputHost;
    expect(boundHost).toBeDefined();
    const afterFirstRegistration = registrationCalls();

    // Pi's `setBeforeSessionInvalidate` -> `resetExtensionUI` ->
    // `clearExtensionTerminalInputListeners` empties the listener set without
    // telling the extension, and the next bind presents a fresh UI context.
    const beforeInvalidate = input.unsubscribeCalls;
    invalidateHost();
    expect(input.listeners.length).toBe(0);
    // The clear is silent: it is not an adapter-driven unsubscribe, and the
    // retained handle survives as an inert closure.
    expect(input.unsubscribeCalls).toBe(beforeInvalidate);
    expect(overlayKeysCell.terminalInput).toBeDefined();

    // The next lifecycle retry sees a different live host and rebinds.
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);
    expect(overlayKeysCell.terminalInputHost).not.toBe(boundHost);

    // Alt+1 dispatches exactly once through the single live listener.
    expect(input.emit("\u001b1")).toBe(true);
    expect(focused).toEqual(["child-1"]);

    // A repeated retry against the same live host adds no duplicate, so the
    // action still fires once per key frame.
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);
    focused.length = 0;
    expect(input.emit("\u001b1")).toBe(true);
    expect(focused).toEqual(["child-1"]);

    // Rebinding raw input never re-runs host shortcut registration.
    expect(registrationCalls()).toBe(afterFirstRegistration);
    expect(registered.has("alt+1")).toBe(true);
  });

  test("a stale ui context that throws is contained, not propagated", async () => {
    const { pi, registered, registrationCalls } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayKeysCell, focused, poisonHost, invalidateHost } =
      runtimeUnderForeignEditor(await registryWithChildren("child-1"), input);

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);
    const afterFirstRegistration = registrationCalls();
    const afterFirstDiagnostics = [...overlayKeysCell.diagnostics];

    // The retained context is now dead: reading `ctx.ui` throws.
    poisonHost();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() =>
        runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1"),
      ).not.toThrow();
    }
    // A dead host degrades to "no route" and stays bounded: no listener is
    // installed, no diagnostic accumulates, and registration does not repeat.
    expect(input.listeners.length).toBe(0);
    expect([...overlayKeysCell.diagnostics]).toEqual(afterFirstDiagnostics);
    expect(registrationCalls()).toBe(afterFirstRegistration);
    expect(registered.has("alt+1")).toBe(true);

    // Once Pi binds a live context again, the route is restored exactly once.
    invalidateHost();
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);
    expect(input.emit("\u001b1")).toBe(true);
    expect(focused).toEqual(["child-1"]);
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

  /**
   * Models the lifecycle order in which key planning happens before a session
   * context can carry raw input: the first registration sees a UI without
   * `onTerminalInput`, a later lifecycle call sees the live one.
   */
  function runtimeWithDeferredTerminalInput(
    registry: PiChildInspectionRegistry,
    input: ReturnType<typeof terminalInputHost>,
  ): {
    readonly runtime: ReturnType<typeof createChildInspectionRuntime>;
    readonly overlayCell: ReturnType<typeof createChildOverlayCell>;
    readonly overlayKeysCell: ReturnType<typeof createChildOverlayKeysCell>;
    readonly focused: string[];
    readonly exposeTerminalInput: () => void;
    readonly invalidateHost: () => void;
  } {
    let terminalInputLive = false;
    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const editorCell = createChildInspectionEditorCell();
    const focused: string[] = [];
    editorCell.activate = (childId) => {
      focused.push(childId);
    };
    const registryCell = createChildInspectionRegistryCell();
    registryCell.registry = registry;
    // Stable per bind, replaced only when Pi would hand the runner a new
    // `ExtensionUIContext`. See the note in `runtimeUnderForeignEditor`.
    const buildCtx = (): never =>
      ({
        cwd: "/repo",
        hasUI: true,
        ui: {
          notify: () => undefined,
          select: async () => undefined,
          ...(terminalInputLive
            ? { onTerminalInput: input.onTerminalInput }
            : {}),
        },
      }) as never;
    let liveCtx = buildCtx();
    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: editorCell,
      inspectionRegistryCell: registryCell,
      treeSelectionCell: createChildTreeSelectionCell(),
      threadSourcesCell: createThreadSourcesCell(),
      delegationControllerCell: createDelegationControllerCell(),
      latestSessionCtx: () => liveCtx,
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
      focused,
      exposeTerminalInput: () => {
        terminalInputLive = true;
        // Gaining the raw-input route is itself a rebind in Pi: the next
        // `bindCurrentSessionExtensions` builds a fresh context.
        liveCtx = buildCtx();
      },
      invalidateHost: () => {
        input.clearAll();
        liveCtx = buildCtx();
      },
    };
  }

  test("a later lifecycle call binds the listener an applied plan never got", async () => {
    const { pi, registered } = recordingPi();
    const input = terminalInputHost();
    const {
      runtime,
      overlayCell,
      overlayKeysCell,
      focused,
      exposeTerminalInput,
    } = runtimeWithDeferredTerminalInput(
      await registryWithChildren("child-1"),
      input,
    );

    // Planning succeeds from the host keybindings port, but the session
    // context cannot carry raw input yet, so no listener is installed.
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(registered.has("alt+1")).toBe(true);
    expect(overlayKeysCell.status).toBe("applied");
    expect(overlayKeysCell.plan).toBeDefined();
    const appliedPlan = overlayKeysCell.plan;
    expect(input.listeners.length).toBe(0);

    // The session context now exposes the listener route. Before this fix the
    // applied-plan early return made every later call inert, so Alt+1 stayed
    // dead for the whole generation under a foreign primary editor.
    exposeTerminalInput();
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);

    expect(input.emit("\u001b1")).toBe(true);
    expect(focused).toEqual(["child-1"]);

    // Repeated later calls reuse the one listener.
    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    runtime.maybeRegisterOverlayKeys(
      pi,
      { getResolvedBindings: () => ({}) },
      "gen-1",
    );
    expect(input.listeners.length).toBe(1);
    // The plan object is untouched, so key planning and host shortcut
    // registration did not run a second time.
    expect(overlayKeysCell.plan).toBe(appliedPlan);

    // Teardown releases the listener, and a new generation installs one fresh.
    clearChildOverlayGeneration(overlayCell, overlayKeysCell);
    expect(input.listeners.length).toBe(0);
    expect(overlayKeysCell.terminalInput).toBeUndefined();

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    expect(input.listeners.length).toBe(1);
  });

  test("retries without a listener route keep the diagnostic list bounded", async () => {
    const { pi } = recordingPi();
    const input = terminalInputHost();
    const { runtime, overlayKeysCell } = runtimeWithDeferredTerminalInput(
      await registryWithChildren("child-1"),
      input,
    );

    runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    const afterFirst = [...overlayKeysCell.diagnostics];
    expect(
      afterFirst.filter((line) => line.includes("ui.onTerminalInput")).length,
    ).toBe(1);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      runtime.maybeRegisterOverlayKeys(pi, undefined, "gen-1");
    }

    expect([...overlayKeysCell.diagnostics]).toEqual(afterFirst);
    expect(input.listeners.length).toBe(0);
  });
});

/**
 * Task 20 item (d): a live session has authoritative live children while the
 * Task 5 ref scan and Task 6 cache are unusable. The picker must still list
 * every live child; only truly invalid bounded data may fail closed.
 */
describe("live child picker with degraded thread sources", () => {
  async function liveRegistry(
    ...children: readonly (readonly [string, number])[]
  ): Promise<PiChildInspectionRegistry> {
    const registry = new PiChildInspectionRegistry();
    for (const [childId, startedAtMs] of children) {
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
          startedAtMs,
          elapsedMs: 5,
          usage: {} as never,
          latestOutput: "",
        }),
      });
    }
    return registry;
  }

  function pickerHarness(
    registry: PiChildInspectionRegistry | undefined,
    refs: unknown,
  ): {
    readonly runtime: ReturnType<typeof createChildInspectionRuntime>;
    readonly selectCalls: (readonly string[])[];
    readonly notices: { message: string; level: string }[];
    readonly focused: string[];
    readonly ctx: never;
  } {
    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const editorCell = createChildInspectionEditorCell();
    const focused: string[] = [];
    editorCell.activate = (childId) => {
      focused.push(childId);
    };
    const registryCell = createChildInspectionRegistryCell();
    registryCell.registry = registry;
    const threadSourcesCell = createThreadSourcesCell();
    threadSourcesCell.refs = refs as never;
    const selectCalls: (readonly string[])[] = [];
    const notices: { message: string; level: string }[] = [];
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        notify: (message: string, level: string) =>
          notices.push({ message, level }),
        select: async (_title: string, labels: readonly string[]) => {
          selectCalls.push([...labels]);
          return undefined;
        },
      },
    } as never;
    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: editorCell,
      inspectionRegistryCell: registryCell,
      treeSelectionCell: createChildTreeSelectionCell(),
      threadSourcesCell,
      delegationControllerCell: createDelegationControllerCell(),
      latestSessionCtx: () => ctx,
      activeGenerationId: () => "gen-1",
      parentSessionState: () => ({
        persistence: "persistent",
        sessionId: "parent-session",
      }),
      childInspectionSettings: () => undefined,
      closeOverlay: () => closeChildOverlay(overlayCell, overlayKeysCell),
    });
    return { runtime, selectCalls, notices, focused, ctx };
  }

  /**
   * Models the live transition observed in isolated Pi 0.83: the bounded ref
   * scan succeeds while no child exists and becomes unusable once children do,
   * because each ref's authoritative source is checked during the scan.
   */
  function refsUnusableWithChildren(hasChildren: () => boolean): unknown {
    return {
      liveParentSessionId: () => "parent-session",
      readRefs: () =>
        hasChildren()
          ? errAsync({ type: "ChildRefParentUnavailable" as const })
          : okAsync({ refs: [] }),
    };
  }

  test("reports no children before any child exists", async () => {
    const { runtime, selectCalls, notices, ctx } = pickerHarness(
      await liveRegistry(),
      refsUnusableWithChildren(() => false),
    );

    await runtime.openChildPicker(ctx, "gen-1");

    expect(selectCalls).toEqual([]);
    expect(notices).toEqual([
      { message: "No Weave children are available to inspect.", level: "info" },
    ]);
  });

  test("lists every live child when the ref scan is unusable", async () => {
    const { runtime, selectCalls, notices, ctx } = pickerHarness(
      await liveRegistry(["child-c", 30], ["child-a", 10], ["child-b", 20]),
      refsUnusableWithChildren(() => true),
    );

    await runtime.openChildPicker(ctx, "gen-1");

    expect(notices).toEqual([]);
    expect(selectCalls.length).toBe(1);
    const labels = selectCalls[0] ?? [];
    expect(labels.length).toBe(3);
    // Deterministic tree order (start time), active marker, title, status.
    expect(labels[0]).toContain("child-a");
    expect(labels[1]).toContain("child-b");
    expect(labels[2]).toContain("child-c");
    for (const label of labels) {
      expect(label.startsWith("●")).toBe(true);
      expect(label).toContain("[running]");
      // The injected formatter renders a non-empty local timestamp.
      expect(label.trim().endsWith("[running]")).toBe(false);
    }
  });

  test("lists live children when a settled ref carries an over-long title", async () => {
    const longTitle = "t".repeat(400);
    const refs = {
      liveParentSessionId: () => "parent-session",
      readRefs: () =>
        okAsync({
          refs: [
            {
              childId: "settled-1",
              threadId: "thread-settled-1",
              title: longTitle,
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
              originParentSessionId: "parent-session",
            },
          ],
        }),
    };
    const { runtime, selectCalls, notices, ctx } = pickerHarness(
      await liveRegistry(["child-a", 10]),
      refs,
    );

    await runtime.openChildPicker(ctx, "gen-1");

    expect(notices).toEqual([]);
    const labels = selectCalls[0] ?? [];
    expect(labels.length).toBe(2);
    expect(labels[0]).toContain("child-a");
    expect(labels[1]).toContain("[completed]");
  });

  test("fails closed on truly invalid bounded live data", async () => {
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: "child-bad",
      parentId: ROOT_NODE_ID,
      name: "child-bad",
      kind: "ordinary",
      snapshot: () => ({
        id: "child-bad",
        parentId: undefined,
        name: "child-bad",
        status: "running",
        currentTurn: 1,
        currentTool: undefined,
        // A non-finite timestamp is out of bounds for the picker contract.
        startedAtMs: Number.POSITIVE_INFINITY,
        elapsedMs: 0,
        usage: {} as never,
        latestOutput: "",
      }),
    });
    const { runtime, selectCalls, notices, ctx } = pickerHarness(
      registry,
      refsUnusableWithChildren(() => true),
    );

    await runtime.openChildPicker(ctx, "gen-1");

    expect(selectCalls).toEqual([]);
    expect(notices).toEqual([
      {
        message: "Child picker is unavailable in this session.",
        level: "warning",
      },
    ]);
  });
});

/**
 * Task 4: cancelling a child is reachable only through `q` on an empty draft
 * plus an explicit confirmation. Every other resolution leaves it running.
 */
describe("child cancellation behind q with explicit confirmation", () => {
  const CHILD_ID = "overlay-1";
  const CHILD_TITLE = "Refactor the parser";

  async function cancelHarness(
    options: {
      readonly childStatus?: "running" | "completed";
      readonly overlayStatus?: "live" | "settled";
      readonly select?: (
        title: string,
        labels: readonly string[],
      ) => Promise<unknown>;
    } = {},
  ): Promise<{
    readonly intercept: (data: string) => boolean;
    readonly controller: ReturnType<typeof createChildOverlayController>;
    readonly selects: {
      readonly title: string;
      readonly labels: readonly string[];
    }[];
    readonly cancelled: string[];
    readonly notices: string[];
    readonly setGeneration: (generationId: string) => void;
  }> {
    const status = options.childStatus ?? "running";
    const registry = new PiChildInspectionRegistry();
    await registry.register({
      id: CHILD_ID,
      parentId: ROOT_NODE_ID,
      name: CHILD_ID,
      kind: "ordinary",
      snapshot: () => ({
        id: CHILD_ID,
        parentId: undefined,
        name: CHILD_ID,
        status,
        currentTurn: 1,
        currentTool: undefined,
        startedAtMs: 1,
        elapsedMs: 0,
        usage: {} as never,
        latestOutput: "",
      }),
    });

    const overlayCell = createChildOverlayCell();
    const overlayKeysCell = createChildOverlayKeysCell(() => 1);
    const registryCell = createChildInspectionRegistryCell();
    registryCell.registry = registry;
    const delegationCell = createDelegationControllerCell();

    const selects: {
      readonly title: string;
      readonly labels: readonly string[];
    }[] = [];
    const notices: string[] = [];
    let generation = "gen-1";
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        notify: (message: string) => notices.push(message),
        select: async (title: string, labels: readonly string[]) => {
          selects.push({ title, labels });
          if (options.select === undefined) return undefined;
          return await options.select(title, labels);
        },
      },
    } as never;

    const runtime = createChildInspectionRuntime({
      overlayCell,
      overlayKeysCell,
      inspectionEditorCell: createChildInspectionEditorCell(),
      inspectionRegistryCell: registryCell,
      treeSelectionCell: createChildTreeSelectionCell(),
      threadSourcesCell: createThreadSourcesCell(),
      delegationControllerCell: delegationCell,
      latestSessionCtx: () => ctx,
      activeGenerationId: () => generation,
      parentSessionState: () => ({ persistence: "unknown", sessionId: "" }),
      childInspectionSettings: () => undefined,
      closeOverlay: () => closeChildOverlay(overlayCell, overlayKeysCell),
      hostKeybindings: () => ({ getResolvedBindings: () => ({}) }),
    });

    const cancelled: string[] = [];
    delegationCell.controller = {
      cancelSubtree: (nodeId: string) => {
        cancelled.push(nodeId);
        return okAsync(undefined);
      },
    } as never;

    const entries: MemoryOverlaySourceEntry[] = [
      {
        id: "e0",
        payload: {
          type: "message",
          id: "e0",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "assistant", content: "overlay line" },
        },
      },
    ];
    const source = createMemoryChildOverlaySource([
      {
        childId: CHILD_ID,
        threadId: CHILD_ID,
        status: options.overlayStatus ?? "live",
        title: CHILD_TITLE,
        generationId: "gen-1",
        runs: [{ run: 1, action: "start" }],
        branchIds: ["main"],
        descendantChildIds: [],
        entries,
      },
    ]);
    const controller = createChildOverlayController(source, { pageSize: 40 });
    const opened = await controller.open(CHILD_ID);
    expect(opened.isOk()).toBe(true);
    overlayCell.controller = controller;
    overlayCell.generationId = "gen-1";
    overlayCell.open = true;

    runtime.maybeRegisterOverlayKeys(recordingPi().pi, undefined, "gen-1");
    runtime.bindOverlayKeyInterceptor("gen-1");
    const interceptor = overlayKeysCell.interceptor;
    expect(interceptor).toBeDefined();

    return {
      intercept: (data: string) => interceptor?.(data) ?? false,
      controller,
      selects,
      cancelled,
      notices,
      setGeneration: (generationId: string) => {
        generation = generationId;
      },
    };
  }

  async function settle(): Promise<void> {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  }

  test("q on an empty draft prompts with the child's bounded title and cancels once on explicit confirm", async () => {
    const harness = await cancelHarness({
      select: async () => "Cancel subtree",
    });

    expect(harness.intercept("q")).toBe(true);
    await settle();

    expect(harness.selects).toHaveLength(1);
    expect(harness.selects[0]?.title).toBe(
      `Cancel "${CHILD_TITLE}" and its subtree?`,
    );
    expect(harness.selects[0]?.labels).toEqual([
      "Keep running",
      "Cancel subtree",
    ]);
    expect(harness.cancelled).toEqual([CHILD_ID]);
  });

  test("Q behaves exactly like q", async () => {
    const harness = await cancelHarness({ select: async () => 1 });
    expect(harness.intercept("Q")).toBe(true);
    await settle();
    expect(harness.selects).toHaveLength(1);
    expect(harness.cancelled).toEqual([CHILD_ID]);
  });

  test("q with a non-empty draft types into the editor instead of prompting", async () => {
    const harness = await cancelHarness({
      select: async () => "Cancel subtree",
    });
    expect(harness.controller.updateDraft("qu").isOk()).toBe(true);

    // `false` means the byte was not consumed: the overlay editor receives it.
    expect(harness.intercept("q")).toBe(false);
    expect(harness.intercept("Q")).toBe(false);
    await settle();

    expect(harness.selects).toEqual([]);
    expect(harness.cancelled).toEqual([]);
  });

  test("every non-confirm resolution leaves the child running", async () => {
    const resolutions: readonly (() => Promise<unknown>)[] = [
      // Dismissed modal / no choice at all.
      async () => undefined,
      // Explicit keep-running choice, by label and by index.
      async () => "Keep running",
      async () => 0,
      // Unknown choice the host may invent.
      async () => 99,
      // Timeout / select failure surfaces as a throw from the host.
      async () => {
        throw new Error("select timed out");
      },
    ];

    for (const select of resolutions) {
      const harness = await cancelHarness({ select });
      expect(harness.intercept("q")).toBe(true);
      await settle();
      expect(harness.selects).toHaveLength(1);
      expect(harness.cancelled).toEqual([]);
    }
  });

  test("a generation change while the modal is open cancels nothing", async () => {
    let setGeneration: ((generationId: string) => void) | undefined;
    const harness = await cancelHarness({
      select: async () => {
        setGeneration?.("gen-2");
        return "Cancel subtree";
      },
    });
    setGeneration = harness.setGeneration;

    expect(harness.intercept("q")).toBe(true);
    await settle();

    expect(harness.selects).toHaveLength(1);
    expect(harness.cancelled).toEqual([]);
  });

  test("a settled, read-only child never opens the confirmation", async () => {
    const harness = await cancelHarness({
      overlayStatus: "settled",
      select: async () => "Cancel subtree",
    });

    // The key is still consumed, so it never reaches the primary editor.
    expect(harness.intercept("q")).toBe(true);
    await settle();

    expect(harness.selects).toEqual([]);
    expect(harness.cancelled).toEqual([]);
  });

  test("a completed child in the hierarchy never opens the confirmation", async () => {
    const harness = await cancelHarness({
      childStatus: "completed",
      select: async () => "Cancel subtree",
    });

    expect(harness.intercept("q")).toBe(true);
    await settle();

    expect(harness.selects).toEqual([]);
    expect(harness.cancelled).toEqual([]);
  });
});
