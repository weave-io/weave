/**
 * Native child inspection runtime (Pi adapter contract).
 *
 * Owns the generation-scoped inspection cells - native overlay, Task 13
 * overlay keys, the custom-editor inspection handle, live tree selection -
 * and the behaviour that reads them: the child picker, overlay key
 * registration, and overlay action dispatch.
 *
 * The extension keeps orchestration only. Everything here reaches the
 * session through the explicit ports on {@link PiChildInspectionRuntimeDeps},
 * never through extension-local closures, so generation isolation stays a
 * property of the ports rather than of accidental capture.
 */
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import type { PiChildInspectionEditor } from "./child-inspection-editor.js";
import {
  childInspectionOverlayKeyOverrides,
  type PiChildInspectionSettings,
} from "./child-inspection-settings.js";
import type {
  ChildOverlayController,
  PiChildOverlayCustomComponent,
} from "./child-overlay.js";
import {
  applyChildOverlayKeyPlan,
  CHILD_OVERLAY_CANCEL_CHOICES,
  CHILD_OVERLAY_CANCEL_PROMPT,
  captureChildOverlayKeybindings,
  childOverlayConflictPortFromHost,
  createChildOverlayKeyInterceptor,
  createChildOverlayKeyMachine,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC,
  type PiChildOverlayAction,
  type PiChildOverlayHierarchyNode,
  type PiChildOverlayKeyInterceptor,
  type PiChildOverlayKeyMachine,
  type PiChildOverlayKeyPlan,
  planChildOverlayKeyRegistrations,
  resolveChildOverlayCancelChoice,
} from "./child-overlay-keys.js";
import {
  createChildOverlayTerminalInputBinder,
  releaseChildOverlayTerminalInput,
} from "./child-overlay-terminal-input.js";
import {
  buildChildPickerMetadataEntries,
  collectChildPickerCandidates,
  type PiChildPickerActiveChild,
  type PiChildPickerCachePort,
  type PiChildPickerRefPort,
  type PiChildPickerSourceState,
  type PiChildPickerStatus,
} from "./child-picker.js";
import {
  type PiChildInspectionRegistry,
  type PiChildTreeNode,
  ROOT_NODE_ID,
} from "./child-tree.js";
import type {
  PiDelegationController,
  PiThreadCachePort,
  PiThreadRefPort,
  PiThreadSessionPort,
} from "./delegation-controller.js";
import type { PiExtensionApi, PiSessionContext } from "./types.js";

export { releaseChildOverlayTerminalInput };

/**
 * Holds the live delegation controller together with the generation it was
 * built for, so replacement and authority checks can never drift apart.
 */
export interface PiDelegationControllerCell {
  controller: PiDelegationController | undefined;
  generationId: string | undefined;
}

/**
 * Generation-scoped thread sources: the parent ref store, the native child
 * session store, and the metadata cache. They stay `undefined` until a host
 * that can supply a no-follow session filesystem is wired, so an unwired
 * source degrades to a structured refusal and never to an unverified resume.
 */
export interface PiThreadSourcesCell {
  refs: PiThreadRefPort | undefined;
  sessions: PiThreadSessionPort | undefined;
  cache: PiThreadCachePort | undefined;
  cacheMode: "active" | "degraded" | undefined;
}

/**
 * Generation-scoped native child overlay: one controller and at most one
 * mounted `ui.custom` component, so content swaps never stack.
 */
export interface PiChildOverlayCell {
  controller: ChildOverlayController | undefined;
  settle: (() => void) | undefined;
  component: PiChildOverlayCustomComponent | undefined;
  tui: { requestRender(): void } | undefined;
  open: boolean;
  generationId: string | undefined;
}

/**
 * Task 13 overlay-key registration state.
 *
 * Raw keys are handed to `pi.registerShortcut` exactly once for the extension
 * lifetime (`registeredKeys`), while the plan behind them is rebuilt per
 * generation, because a generation carries its own
 * `child_inspection.keys` overrides and `clearChildOverlayGeneration` drops
 * the plan. Registration requires an inspectable host keybindings source;
 * without one every shortcut is skipped and the gap is reported through the
 * bounded diagnostic list.
 */
export interface PiChildOverlayKeysCell {
  status: "pending" | "applied";
  /** Raw keys already handed to the host, never registered twice. */
  registeredKeys: readonly string[];
  plan: PiChildOverlayKeyPlan | undefined;
  machine: PiChildOverlayKeyMachine;
  interceptor: PiChildOverlayKeyInterceptor | undefined;
  /**
   * Unsubscribe handle for the generation's raw terminal-input listener, or
   * `undefined` when none is installed.
   *
   * `pi.registerShortcut` is dispatched by Pi's *default* editor, so under a
   * foreign primary editor (`pi-vim`) the registered handler never fires. The
   * listener is the ownership-independent route to the same dispatch. It is
   * installed at most once per generation and released on generation teardown,
   * so a reload can never stack two listeners on the same host.
   */
  terminalInput: (() => void) | undefined;
  /**
   * The host UI object the live listener was installed on, or `undefined`
   * when no listener is installed.
   *
   * Pi drops every extension terminal-input listener without telling the
   * extension: `InteractiveMode` registers
   * `setBeforeSessionInvalidate(() => this.resetExtensionUI())`, and
   * `resetExtensionUI` calls `clearExtensionTerminalInputListeners`, which
   * runs each unsubscribe and empties the set. `/reload` takes the same route.
   * The handle Weave holds therefore survives as an inert closure, which on
   * its own would make the single-listener guard skip rebinding forever.
   *
   * Pi hands the extension runner one `ExtensionUIContext` per session bind
   * and exposes it by reference (`get ui() { return runner.uiContext; }`), so
   * the identity of this object is the reliable signal for "same live host":
   * unchanged while the bind lasts, replaced after an invalidation or reload.
   */
  terminalInputHost: unknown;
  diagnostics: readonly string[];
  generationId: string | undefined;
}

/** Handle to the custom-editor inspection fallback for the generation. */
export interface PiChildInspectionEditorCell {
  editor: PiChildInspectionEditor | undefined;
  activate?: (childId: string) => void;
}

/** Live child-inspection registry for the generation. */
export interface PiChildInspectionRegistryCell {
  registry: PiChildInspectionRegistry | undefined;
}

/** Bounded live child-tree selection, reset to the root per generation. */
export interface PiChildTreeSelectionCell {
  selectedId: string;
}

export function createDelegationControllerCell(): PiDelegationControllerCell {
  return { controller: undefined, generationId: undefined };
}

export function createThreadSourcesCell(): PiThreadSourcesCell {
  return {
    refs: undefined,
    sessions: undefined,
    cache: undefined,
    cacheMode: undefined,
  };
}

export function clearThreadSources(cell: PiThreadSourcesCell): void {
  cell.refs = undefined;
  cell.sessions = undefined;
  cell.cache = undefined;
  cell.cacheMode = undefined;
}

export function createChildOverlayCell(): PiChildOverlayCell {
  return {
    controller: undefined,
    settle: undefined,
    component: undefined,
    tui: undefined,
    open: false,
    generationId: undefined,
  };
}

export function createChildOverlayKeysCell(
  now: () => number = () => Date.now(),
): PiChildOverlayKeysCell {
  return {
    status: "pending",
    registeredKeys: Object.freeze([]),
    plan: undefined,
    machine: createChildOverlayKeyMachine({ now }),
    interceptor: undefined,
    terminalInput: undefined,
    terminalInputHost: undefined,
    diagnostics: Object.freeze([PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC]),
    generationId: undefined,
  };
}

export function createChildInspectionEditorCell(): PiChildInspectionEditorCell {
  return { editor: undefined };
}

export function createChildInspectionRegistryCell(): PiChildInspectionRegistryCell {
  return { registry: undefined };
}

export function createChildTreeSelectionCell(): PiChildTreeSelectionCell {
  return { selectedId: ROOT_NODE_ID };
}

/**
 * Settles and closes the mounted overlay exactly once. Idempotent: the settle
 * handle is cleared before it runs, so replacement, shutdown, and a stale
 * callback can race without settling the same promise twice.
 */
export function closeChildOverlay(
  overlayCell: PiChildOverlayCell,
  overlayKeysCell: PiChildOverlayKeysCell,
): void {
  const settle = overlayCell.settle;
  overlayCell.settle = undefined;
  overlayCell.open = false;
  overlayCell.component = undefined;
  overlayCell.tui = undefined;
  const overlay = overlayCell.controller;
  if (overlay?.isOpen()) {
    Result.fromThrowable(
      () => overlay.close(),
      () => "overlay_close_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  }
  settle?.();
}

/**
 * Drops every generation-scoped overlay resource. Raw shortcut registration
 * is exactly-once for the extension lifetime, so a replaced generation keeps
 * the already-registered shortcuts and only loses the plan behind them.
 */
export function clearChildOverlayGeneration(
  overlayCell: PiChildOverlayCell,
  overlayKeysCell: PiChildOverlayKeysCell,
): void {
  closeChildOverlay(overlayCell, overlayKeysCell);
  overlayCell.controller = undefined;
  overlayCell.generationId = undefined;
  overlayKeysCell.interceptor = undefined;
  overlayKeysCell.plan = undefined;
  overlayKeysCell.generationId = undefined;
  releaseChildOverlayTerminalInput(overlayKeysCell);
}

/** Parent session state as the picker needs it: an id, or none. */
export interface PiChildInspectionParentSession {
  readonly persistence: string;
  readonly sessionId: string;
}

export interface PiChildInspectionRuntimeDeps {
  readonly overlayCell: PiChildOverlayCell;
  readonly overlayKeysCell: PiChildOverlayKeysCell;
  readonly inspectionEditorCell: PiChildInspectionEditorCell;
  readonly inspectionRegistryCell: PiChildInspectionRegistryCell;
  readonly treeSelectionCell: PiChildTreeSelectionCell;
  readonly threadSourcesCell: PiThreadSourcesCell;
  readonly delegationControllerCell: PiDelegationControllerCell;
  /** The most recent session context, or none when no session is live. */
  readonly latestSessionCtx: () => PiSessionContext | undefined;
  /** The generation the live session belongs to, or none. */
  readonly activeGenerationId: () => string | undefined;
  /** Parent session state of the live session. */
  readonly parentSessionState: () => PiChildInspectionParentSession;
  /** Parsed child-inspection settings for a generation, when it is current. */
  readonly childInspectionSettings: (
    generationId: string,
  ) => PiChildInspectionSettings | undefined;
  /** Closes the mounted overlay, if any. */
  readonly closeOverlay: () => void;
  /**
   * The host's process-wide keybindings manager, when the harness exposes one.
   *
   * Overlay shortcuts must not depend on Weave owning the primary editor: when
   * another extension (for example `pi-vim`) installs the editor first, Weave
   * yields and its composed factory never runs, so no keybindings object ever
   * reaches {@link PiChildInspectionRuntime.maybeRegisterOverlayKeys}. This
   * port is the ownership-independent source of the same conflict data.
   */
  readonly hostKeybindings?: () => unknown;
}

export interface PiChildInspectionRuntime {
  /** Appends a bounded overlay-key diagnostic and surfaces it when there is UI. */
  readonly reportOverlayKeyDiagnostic: (detail: string) => void;
  /**
   * Appends a bounded overlay diagnostic without notifying.
   *
   * Fallback decisions are recorded on every inspection, including the routine
   * ones (a host without the native overlay preflight always falls back), so
   * surfacing them as warnings would be noise. They are still readable from
   * `/weave:health`, which is where a proof run collects them.
   */
  readonly recordOverlayDiagnostic: (detail: string) => void;
  /** Projects the live registry as the overlay's hierarchy view. */
  readonly buildOverlayHierarchy: (
    registry: PiChildInspectionRegistry,
  ) => readonly PiChildOverlayHierarchyNode[];
  /** Activates the inspection view for one child, when one is installed. */
  readonly focusOverlayChild: (childId: string) => void;
  /** Opens the bounded child picker for a generation. */
  readonly openChildPicker: (
    ctx: PiSessionContext,
    generationId: string,
  ) => Promise<void>;
  /** Runs one overlay key action against the generation that owns it. */
  readonly dispatchOverlayAction: (
    action: PiChildOverlayAction,
    generationId: string,
  ) => void;
  /** Rebuilds the overlay key interceptor for a generation. */
  readonly bindOverlayKeyInterceptor: (generationId: string) => void;
  /**
   * Registers Task 13 shortcuts exactly once, from live host keybindings.
   *
   * `keybindings` may be an injected keybindings object or `undefined`, in
   * which case the host keybindings port supplies the conflict data. The
   * registered handlers resolve the live generation at key-press time, so a
   * later generation reuses the same registrations.
   */
  readonly maybeRegisterOverlayKeys: (
    pi: PiExtensionApi,
    keybindings: unknown,
    generationId: string,
  ) => void;
}

export function createChildInspectionRuntime(
  deps: PiChildInspectionRuntimeDeps,
): PiChildInspectionRuntime {
  const {
    overlayCell: childOverlayCell,
    overlayKeysCell,
    inspectionEditorCell: childInspectionEditorCell,
    inspectionRegistryCell,
    treeSelectionCell,
    threadSourcesCell,
    delegationControllerCell,
  } = deps;

  const formatChildPickerTimestamp = (epochMs: number): string =>
    Result.fromThrowable(
      () => new Date(epochMs).toLocaleString(),
      () => `${epochMs}`,
    )().match(
      (label) => label,
      (fallback) => fallback,
    );

  const mapLiveStatusToPicker = (
    status: PiChildTreeNode["status"],
  ): PiChildPickerStatus => {
    if (status === "queued") return "queued";
    if (status === "completed") return "completed";
    if (status === "cancelled") return "cancelled";
    if (status === "failed") return "failed";
    return "running";
  };

  const buildOverlayHierarchy = (
    registry: PiChildInspectionRegistry,
  ): readonly PiChildOverlayHierarchyNode[] =>
    registry.snapshotLive().map((node) => ({
      childId: node.id,
      ...(node.parentId === undefined || node.parentId === ROOT_NODE_ID
        ? {}
        : { parentId: node.parentId }),
      active: !["completed", "cancelled", "failed"].includes(node.status),
      order: node.startedAtMs,
    }));

  /**
   * Reads the host keybindings manager without ever letting a host throw
   * escape. Absent or throwing hosts degrade to `undefined`, which the caller
   * reports as a skipped registration rather than an unchecked one.
   */
  const readHostKeybindings = (): unknown => {
    const read = deps.hostKeybindings;
    if (read === undefined) return undefined;
    return Result.fromThrowable(
      () => read(),
      () => undefined,
    )().match(
      (value) => value,
      () => undefined,
    );
  };

  const recordOverlayDiagnostic = (detail: string): void => {
    const next = [...overlayKeysCell.diagnostics, detail];
    overlayKeysCell.diagnostics = Object.freeze(
      next.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
    );
  };

  const reportOverlayKeyDiagnostic = (detail: string): void => {
    recordOverlayDiagnostic(detail);
    // Pi's `ExtensionContext.ui` getter calls `assertActive()` and throws once
    // the extension runner is marked stale, so a context retained across a
    // session invalidation can throw on plain property access. A diagnostic is
    // best-effort surface: it must never throw out of a lifecycle callback and
    // abort key registration, so a dead host degrades to "recorded only".
    Result.fromThrowable(
      () => {
        const ctx = deps.latestSessionCtx();
        if (ctx === undefined || !ctx.hasUI) return;
        ctx.ui.notify(detail, "warning");
      },
      () => "overlay_diagnostic_notify_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const focusOverlayChild = (childId: string): void => {
    const activate = childInspectionEditorCell.activate;
    if (activate === undefined) return;
    activate(childId);
  };

  const openTask13ChildPicker = async (
    ctx: PiSessionContext,
    generationId: string,
  ): Promise<void> => {
    const registry = inspectionRegistryCell.registry;
    if (registry === undefined || deps.activeGenerationId() !== generationId) {
      return;
    }
    const ordered = buildOverlayHierarchy(registry);
    const orderById = new Map(
      ordered.map((node) => [node.childId, node.order] as const),
    );
    const active: PiChildPickerActiveChild[] = registry
      .snapshotLiveRegistrations()
      .map(({ registration, snapshot }) => ({
        childId: snapshot.id,
        threadId:
          delegationControllerCell.controller?.resolveThreadIdForLiveChild(
            snapshot.id,
          ) ?? snapshot.id,
        ...(snapshot.parentId === undefined ||
        snapshot.parentId === ROOT_NODE_ID
          ? {}
          : { parentId: snapshot.parentId }),
        status: mapLiveStatusToPicker(snapshot.status),
        agent: registration.name,
        createdAt: snapshot.startedAtMs,
        updatedAt: snapshot.startedAtMs + snapshot.elapsedMs,
        treeOrder: orderById.get(snapshot.id) ?? snapshot.startedAtMs,
        ...(registration.stepName === undefined
          ? {}
          : { workflowStep: registration.stepName }),
      }));

    const parentState = deps.parentSessionState();
    const parentSessionId =
      threadSourcesCell.refs?.liveParentSessionId() ??
      (parentState.persistence === "persistent" ? parentState.sessionId : "");
    type CacheListPage = {
      readonly records: readonly {
        readonly childId: string;
        readonly threadId: string;
        readonly title: string;
        /** Provenance marker for `title`; absent means the title is unproven. */
        readonly titleProvenance?: string;
        readonly status: string;
        readonly createdAt: number;
        readonly updatedAt: number;
        readonly originParentSessionId: string;
        readonly stale: boolean;
        readonly tombstoned: boolean;
      }[];
    };
    const cacheCandidate = threadSourcesCell.cache as
      | {
          list?: (input: {
            readonly workspaceKey: string;
            readonly parentSessionId?: string;
            readonly limit: number;
          }) => Result<CacheListPage, unknown>;
          get?: (
            scope: {
              readonly workspaceKey: string;
              readonly parentSessionId: string;
            },
            childId: string,
          ) => ResultAsync<
            unknown,
            { readonly type?: string; readonly state?: string }
          >;
        }
      | undefined;
    const canUseCache =
      parentSessionId.length > 0 &&
      threadSourcesCell.cacheMode === "active" &&
      typeof cacheCandidate?.list === "function" &&
      typeof cacheCandidate.get === "function";
    const cachePort: PiChildPickerCachePort | undefined = canUseCache
      ? {
          list: (input) => {
            const listed = cacheCandidate.list?.(input);
            if (listed === undefined || listed.isErr()) {
              return errAsync({
                type: "invalid-picker-input" as const,
                detail: "cache list unavailable",
              });
            }
            return okAsync(listed.value);
          },
          validate: (childId) => {
            const got = cacheCandidate.get?.(
              { workspaceKey: ctx.cwd, parentSessionId },
              childId,
            );
            if (got === undefined) return okAsync("unavailable" as const);
            return got
              .map((): PiChildPickerSourceState => "available")
              .orElse((failure) => {
                if (failure.state === "orphan") {
                  return okAsync("orphan" as const);
                }
                if (failure.state === "stale") {
                  return okAsync("stale" as const);
                }
                return okAsync("unavailable" as const);
              });
          },
        }
      : undefined;

    const refsPort: PiChildPickerRefPort | undefined =
      threadSourcesCell.refs === undefined
        ? undefined
        : {
            readRefs: (input) =>
              threadSourcesCell
                .refs!.readRefs({ limit: input.limit })
                .map((scan) =>
                  scan.refs.map((record) => ({
                    childId: record.childId,
                    threadId: record.threadId,
                    title: record.title,
                    // The provenance marker travels with the title: dropping
                    // it here would make every ref-backed row look unproven
                    // and collapse trusted titles to the fallback.
                    ...(record.titleProvenance === undefined
                      ? {}
                      : { titleProvenance: record.titleProvenance }),
                    status: record.status,
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt,
                    originParentSessionId: record.originParentSessionId,
                  })),
                ),
          };

    const candidates = await collectChildPickerCandidates({
      active,
      workspaceKey: ctx.cwd,
      parentSessionId: parentSessionId.length > 0 ? parentSessionId : ctx.cwd,
      ...(cachePort === undefined ? {} : { cache: cachePort }),
      cacheDegraded: !canUseCache,
      ...(refsPort === undefined ? {} : { refs: refsPort }),
    });
    if (candidates.isErr()) {
      ctx.ui.notify("Child picker is unavailable in this session.", "warning");
      return;
    }
    const entries = buildChildPickerMetadataEntries({
      candidates: candidates.value,
      formatTimestamp: formatChildPickerTimestamp,
    });
    if (entries.isErr()) {
      ctx.ui.notify("Child picker is unavailable in this session.", "warning");
      return;
    }
    if (entries.value.length === 0) {
      ctx.ui.notify("No Weave children are available to inspect.", "info");
      return;
    }
    const labels = entries.value.map(
      (entry) =>
        `${entry.active ? "●" : "○"} ${entry.title} [${entry.status}] ${entry.timestampLabel}`,
    );
    const selected = await ResultAsync.fromThrowable(
      () => ctx.ui.select("Weave children", labels),
      () => "picker unavailable",
    )();
    if (selected.isErr() || selected.value === undefined) return;
    if (deps.activeGenerationId() !== generationId) return;
    const index = labels.indexOf(selected.value);
    const entry = entries.value[index];
    if (entry === undefined || entry.readOnly) return;
    focusOverlayChild(entry.childId);
  };

  /**
   * Hands one raw overlay scroll frame to the mounted overlay component.
   *
   * Pi 0.83 routes PageUp/PageDown to its own paging route before a mounted
   * `ui.custom` component, so the ownership-independent terminal-input
   * listener claims those frames and delivers them here instead. Delivery is
   * exactly once - the listener consumes only what this reports as
   * delivered - and it fails closed on every mismatch: a stale session
   * context, a generation that is no longer current, an overlay mounted for a
   * different generation, a closed overlay, a missing component, or a
   * throwing dispatch target all report `false` and leave the frame on its
   * existing host route rather than sending it to the wrong session.
   */
  const dispatchOverlayScroll = (
    data: string,
    generationId: string,
  ): boolean => {
    if (deps.latestSessionCtx() === undefined) return false;
    if (deps.activeGenerationId() !== generationId) return false;
    if (!childOverlayCell.open) return false;
    if (
      childOverlayCell.generationId !== undefined &&
      childOverlayCell.generationId !== generationId
    ) {
      return false;
    }
    const component = childOverlayCell.component;
    if (component === undefined) return false;
    return Result.fromThrowable(
      () => {
        component.handleInput(data);
        return true;
      },
      () => "overlay_scroll_dispatch_failed" as const,
    )().unwrapOr(false);
  };

  const dispatchOverlayAction = (
    action: PiChildOverlayAction,
    generationId: string,
  ): void => {
    const ctx = deps.latestSessionCtx();
    if (ctx === undefined || deps.activeGenerationId() !== generationId) {
      return;
    }
    const registry = inspectionRegistryCell.registry;
    if (registry === undefined) return;
    const plan = overlayKeysCell.plan;
    if (plan === undefined) return;
    const focused =
      childOverlayCell.controller?.view().match(
        (view) => view.child.childId,
        () => treeSelectionCell.selectedId,
      ) ?? treeSelectionCell.selectedId;
    const focusedId = focused === ROOT_NODE_ID ? undefined : focused;
    const draft =
      childOverlayCell.controller?.view().match(
        (view) => view.draft,
        () => "",
      ) ?? "";
    const outcome = overlayKeysCell.machine.handleAction(action, {
      plan,
      nodes: buildOverlayHierarchy(registry),
      focusedChildId: focusedId,
      draft,
    });
    if (outcome.isErr()) {
      reportOverlayKeyDiagnostic(
        `weave overlay key failed: ${outcome.error.detail}`,
      );
      return;
    }
    switch (outcome.value.kind) {
      case "open-picker":
        void openTask13ChildPicker(ctx, generationId);
        return;
      case "focus-child":
        focusOverlayChild(outcome.value.childId);
        return;
      case "no-target":
        reportOverlayKeyDiagnostic(
          "weave overlay key ignored: no matching child",
        );
        return;
      default:
        return;
    }
  };

  const bindOverlayKeyInterceptor = (generationId: string): void => {
    const plan = overlayKeysCell.plan;
    if (plan === undefined) {
      overlayKeysCell.interceptor = undefined;
      return;
    }
    overlayKeysCell.interceptor = createChildOverlayKeyInterceptor({
      machine: overlayKeysCell.machine,
      context: () => {
        if (deps.activeGenerationId() !== generationId) return undefined;
        const registry = inspectionRegistryCell.registry;
        if (registry === undefined) return undefined;
        const focused =
          childOverlayCell.controller?.view().match(
            (view) => view.child.childId,
            () => undefined,
          ) ?? undefined;
        const draft =
          childOverlayCell.controller?.view().match(
            (view) => view.draft,
            () => "",
          ) ?? "";
        return {
          plan,
          nodes: buildOverlayHierarchy(registry),
          focusedChildId: focused,
          draft,
        };
      },
      openPicker: () => {
        const ctx = deps.latestSessionCtx();
        if (ctx === undefined) return;
        void openTask13ChildPicker(ctx, generationId);
      },
      focusChild: (childId) => focusOverlayChild(childId),
      closeOverlay: () => deps.closeOverlay(),
      updateDraft: (draft) => {
        const overlay = childOverlayCell.controller;
        if (overlay === undefined) return;
        Result.fromThrowable(
          () => overlay.updateDraft(draft),
          () => "overlay_draft_failed" as const,
        )().match(
          () => {
            childOverlayCell.component?.invalidate();
            childOverlayCell.tui?.requestRender();
          },
          () => undefined,
        );
      },
      confirmCancelSubtree: (childId) => {
        const ctx = deps.latestSessionCtx();
        if (ctx === undefined || deps.activeGenerationId() !== generationId) {
          return;
        }
        void (async () => {
          const choice = await ResultAsync.fromThrowable(
            () =>
              ctx.ui.select(CHILD_OVERLAY_CANCEL_PROMPT, [
                ...CHILD_OVERLAY_CANCEL_CHOICES,
              ]),
            () => "cancel confirm unavailable",
          )();
          if (deps.activeGenerationId() !== generationId) return;
          const decision = resolveChildOverlayCancelChoice(
            childId,
            choice.isOk() ? choice.value : undefined,
          );
          if (decision.kind !== "cancel-subtree") return;
          const controller = delegationControllerCell.controller;
          if (controller === undefined) return;
          await controller.cancelSubtree(decision.childId);
        })();
      },
      report: (detail) => reportOverlayKeyDiagnostic(detail),
    });
  };

  const terminalInput = createChildOverlayTerminalInputBinder({
    state: overlayKeysCell,
    latestSessionCtx: deps.latestSessionCtx,
    isOverlayOpen: () => childOverlayCell.open,
    activeGenerationId: deps.activeGenerationId,
    dispatchOverlayAction: (action, generationId) =>
      dispatchOverlayAction(action, generationId),
    dispatchOverlayScroll: (data, generationId) =>
      dispatchOverlayScroll(data, generationId),
  });

  /**
   * Plans and registers Task 13 shortcuts.
   *
   * Raw key registration is exactly once for the extension lifetime, but the
   * plan behind those keys is rebuilt whenever a generation needs one: a new
   * generation carries its own overrides, and generation teardown drops the
   * plan while the host keeps the registered keys.
   *
   * The keybindings object may come from the composed editor factory, from the
   * overlay custom factory, or - when another extension such as `pi-vim` owns
   * the primary editor and neither factory ever runs - from the host
   * keybindings port. Conflict inspection stays a precondition on every route:
   * a key already owned by the host or the user is skipped and reported,
   * never overwritten.
   *
   * `generationId` is the generation whose overrides apply to the plan. It
   * never binds the registered handlers: those resolve the live generation at
   * key-press time, so a replacement generation reuses the same keys.
   */
  const registerOverlayKeys = (
    pi: PiExtensionApi,
    keybindings: unknown,
    generationId: string,
  ): void => {
    if (
      overlayKeysCell.status === "applied" &&
      overlayKeysCell.plan !== undefined
    ) {
      return;
    }
    const diagnostics: string[] = [PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC];
    const captured =
      captureChildOverlayKeybindings(keybindings) ??
      captureChildOverlayKeybindings(readHostKeybindings());
    const conflictPort = childOverlayConflictPortFromHost(captured);
    if (conflictPort === undefined) {
      diagnostics.push(
        "weave overlay keys skipped: host keybindings expose neither getResolvedBindings() nor getEffectiveConfig()",
      );
      overlayKeysCell.diagnostics = Object.freeze(
        diagnostics.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
      );
      return;
    }
    const settings = deps.childInspectionSettings(generationId);
    const overrides =
      settings === undefined
        ? undefined
        : Object.fromEntries(childInspectionOverlayKeyOverrides(settings));
    const plan = planChildOverlayKeyRegistrations({
      ...(overrides === undefined ? {} : { overrides }),
      conflicts: conflictPort,
    });
    if (plan.isErr()) {
      diagnostics.push(`weave overlay keys failed: ${plan.error.detail}`);
      overlayKeysCell.diagnostics = Object.freeze(
        diagnostics.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
      );
      return;
    }
    diagnostics.push(...plan.value.diagnostics);
    // Keys already handed to the host stay registered: Pi keeps one handler
    // per key, and re-registering would replace a live handler with an
    // identical one for no gain.
    const alreadyRegistered = new Set(overlayKeysCell.registeredKeys);
    const pending = plan.value.registrations.filter(
      (registration) => !alreadyRegistered.has(registration.key),
    );
    const applied = applyChildOverlayKeyPlan(
      {
        registerShortcut: (key, options) => {
          pi.registerShortcut?.(key, options);
        },
      },
      { ...plan.value, registrations: pending },
      (action) => {
        // Raw keys are registered exactly once for the extension lifetime, so
        // a handler must never close over the generation that happened to be
        // live when it was registered: that generation may since have been
        // replaced, which would make the shortcut permanently inert. Resolve
        // the live generation at key-press time instead, and stay inert only
        // while no generation is live at all.
        const target = deps.activeGenerationId();
        if (target === undefined) return;
        dispatchOverlayAction(action, target);
      },
    );
    if (applied.isErr()) {
      diagnostics.push(`weave overlay keys failed: ${applied.error.detail}`);
      overlayKeysCell.diagnostics = Object.freeze(
        diagnostics.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
      );
      return;
    }
    overlayKeysCell.status = "applied";
    overlayKeysCell.plan = plan.value;
    overlayKeysCell.registeredKeys = Object.freeze([
      ...overlayKeysCell.registeredKeys,
      ...pending.map((registration) => registration.key),
    ]);
    overlayKeysCell.generationId = generationId;
    bindOverlayKeyInterceptor(generationId);
    terminalInput.bind(generationId, diagnostics);
    overlayKeysCell.diagnostics = Object.freeze(
      diagnostics.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
    );
    for (const diagnostic of plan.value.diagnostics) {
      reportOverlayKeyDiagnostic(diagnostic);
    }
  };

  const maybeRegisterOverlayKeys = (
    pi: PiExtensionApi,
    keybindings: unknown,
    generationId: string,
  ): void => {
    registerOverlayKeys(pi, keybindings, generationId);
    terminalInput.retry(generationId);
  };

  return {
    reportOverlayKeyDiagnostic,
    recordOverlayDiagnostic,
    buildOverlayHierarchy,
    focusOverlayChild,
    openChildPicker: openTask13ChildPicker,
    dispatchOverlayAction,
    bindOverlayKeyInterceptor,
    maybeRegisterOverlayKeys,
  };
}
