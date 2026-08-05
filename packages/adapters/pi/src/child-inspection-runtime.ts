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
import {
  buildChildPickerMetadataEntries,
  collectChildPickerCandidates,
  type PiChildPickerActiveChild,
  type PiChildPickerCachePort,
  type PiChildPickerRefPort,
  type PiChildPickerSourceState,
  type PiChildPickerStatus,
} from "./child-picker.js";
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
  captureChildOverlayKeybindings,
  CHILD_OVERLAY_CANCEL_CHOICES,
  CHILD_OVERLAY_ESCAPE_HINT,
  childOverlayConflictPortFromHost,
  createChildOverlayKeyInterceptor,
  createChildOverlayKeyMachine,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC,
  planChildOverlayKeyRegistrations,
  resolveChildOverlayCancelChoice,
  type PiChildOverlayAction,
  type PiChildOverlayHierarchyNode,
  type PiChildOverlayKeyInterceptor,
  type PiChildOverlayKeyMachine,
  type PiChildOverlayKeyPlan,
} from "./child-overlay-keys.js";
import {
  PiChildInspectionRegistry,
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
 * Task 13 overlay-key registration state. Applied exactly once when a host
 * keybindings object that exposes `getEffectiveConfig()` first arrives;
 * otherwise every shortcut is skipped and the gap is reported through the
 * bounded diagnostic list.
 */
export interface PiChildOverlayKeysCell {
  status: "pending" | "applied";
  plan: PiChildOverlayKeyPlan | undefined;
  machine: PiChildOverlayKeyMachine;
  interceptor: PiChildOverlayKeyInterceptor | undefined;
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
    plan: undefined,
    machine: createChildOverlayKeyMachine({ now }),
    interceptor: undefined,
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
  overlayKeysCell.machine.disarmEscape();
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
}

export interface PiChildInspectionRuntime {
  /** Appends a bounded overlay-key diagnostic and surfaces it when there is UI. */
  readonly reportOverlayKeyDiagnostic: (detail: string) => void;
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
  /** Registers Task 13 shortcuts exactly once, from live host keybindings. */
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

  const reportOverlayKeyDiagnostic = (detail: string): void => {
    const next = [...overlayKeysCell.diagnostics, detail];
    overlayKeysCell.diagnostics = Object.freeze(
      next.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
    );
    const ctx = deps.latestSessionCtx();
    if (ctx !== undefined && ctx.hasUI) {
      ctx.ui.notify(detail, "warning");
    }
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
      (parentState.persistence === "persistent"
        ? parentState.sessionId
        : "");
    type CacheListPage = {
      readonly records: readonly {
        readonly childId: string;
        readonly threadId: string;
        readonly title: string;
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
              threadSourcesCell.refs!.readRefs({ limit: input.limit }).map(
                (scan) =>
                  scan.refs.map((record) => ({
                    childId: record.childId,
                    threadId: record.threadId,
                    title: record.title,
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
    const focusedId =
      focused === ROOT_NODE_ID ? undefined : focused;
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
      showHint: (hint) => {
        reportOverlayKeyDiagnostic(hint);
      },
      confirmCancelSubtree: (childId) => {
        const ctx = deps.latestSessionCtx();
        if (ctx === undefined || deps.activeGenerationId() !== generationId) {
          return;
        }
        void (async () => {
          const choice = await ResultAsync.fromThrowable(
            () =>
              ctx.ui.select(
                CHILD_OVERLAY_ESCAPE_HINT,
                [...CHILD_OVERLAY_CANCEL_CHOICES],
              ),
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

  /**
   * Captures the live keybindings from the composed editor factory (or the
   * overlay custom factory) and registers Task 13 shortcuts exactly once.
   */
  const maybeRegisterOverlayKeys = (
    pi: PiExtensionApi,
    keybindings: unknown,
    generationId: string,
  ): void => {
    if (overlayKeysCell.status === "applied") return;
    const diagnostics: string[] = [PI_NAMED_SHORTCUT_ACTIONS_DIAGNOSTIC];
    const captured = captureChildOverlayKeybindings(keybindings);
    const conflictPort = childOverlayConflictPortFromHost(captured);
    if (conflictPort === undefined) {
      diagnostics.push(
        "weave overlay keys skipped: host keybindings do not expose getEffectiveConfig()",
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
    const applied = applyChildOverlayKeyPlan(
      {
        registerShortcut: (key, options) => {
          pi.registerShortcut?.(key, options);
        },
      },
      plan.value,
      (action) => {
        dispatchOverlayAction(action, generationId);
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
    overlayKeysCell.generationId = generationId;
    overlayKeysCell.diagnostics = Object.freeze(
      diagnostics.slice(0, PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics),
    );
    bindOverlayKeyInterceptor(generationId);
    for (const diagnostic of plan.value.diagnostics) {
      reportOverlayKeyDiagnostic(diagnostic);
    }
  };


  return {
    reportOverlayKeyDiagnostic,
    buildOverlayHierarchy,
    focusOverlayChild,
    openChildPicker: openTask13ChildPicker,
    dispatchOverlayAction,
    bindOverlayKeyInterceptor,
    maybeRegisterOverlayKeys,
  };
}
