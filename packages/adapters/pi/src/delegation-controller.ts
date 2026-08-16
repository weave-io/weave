/**
 * Adapter-owned delegation transport (Pi adapter contract): enforces the
 * engine's pure `authorizeDelegation()` decision against live,
 * adapter-supplied counts; owns the per-parent FIFO queue, global process
 * budget, spawn/handshake/settlement of `PiRpcChild` instances, whole-tree
 * cancellation with descendant cleanup, and the bounded inspectable tree
 * snapshot. Never reimplements the engine's limit-decision logic.
 */

import { basename, dirname, isAbsolute, join } from "node:path";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  authorizeDelegation,
  type DelegationAuthorizationDecision,
  type DelegationAuthorizationError,
  type DelegationLimitsError,
  type DelegationTarget,
  resolveEffectiveDelegationLimits,
} from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  MAX_CWD_LENGTH,
  MAX_NAME_LENGTH,
  type PiDelegateRequestBody,
} from "./child-control-bodies.js";
import type { HmacPort, RandomPort } from "./child-crypto.js";
import type {
  CreateNativeChildSessionInput,
  MintNativeSessionLaunchGrantInput,
  PiNativeResultAppendIdentity,
  PiNativeResultGroupRead,
  PiNativeResultGroupReadOptions,
  PiNativeResultReadIdentity,
  PiNativeSessionEntries,
  PiNativeSessionEntryPage,
  PiNativeSessionEntryPageOptions,
  PiNativeSessionError,
  PiNativeSessionRecord,
  PiNativeSessionTombstone,
  PiNativeThreadMetadata,
  PiNativeThreadMetadataInput,
} from "./child-native-sessions.js";
import type { PiChildProcessPort } from "./child-process-port.js";
import type {
  PiChildRecoverySettlement,
  PiChildRecoverySpawnInput,
} from "./child-recovery.js";
import type { PiChildSessionEvent } from "./child-session-events.js";
import type { PiChildSessionLaunchGrant } from "./child-session-launch.js";
import {
  type AppendChildRefLifecycleInput,
  type AppendChildRefRunInput,
  type AppendNewChildRefInput,
  childRefTotalRuns,
  type PiChildRefError,
  type PiChildRefRecord,
  type PiChildRefScan,
  type PiChildRefStatus,
} from "./child-session-refs.js";
import {
  describeChildSessionStorageUnavailable,
  type PiChildSessionStorageAuthority,
} from "./child-session-storage-authority.js";
import {
  SystemTimerPort,
  type TimerHandle,
  type TimerPort,
} from "./child-timer.js";
import {
  PI_CHILD_TITLE_PROVENANCE,
  resolveDurableChildTitle,
} from "./child-title.js";
import {
  addUsage,
  EMPTY_USAGE_AGGREGATE,
  type PiChildInspectionHistoryError,
  type PiChildInspectionRegistry,
  type PiChildTreeNode,
  ROOT_NODE_ID,
  subtreeIds,
} from "./child-tree.js";
import {
  makeChildAbortFailedFailure,
  makeChildCapacityExceededFailure,
  makeChildInteractionUnavailableFailure,
  makeChildRecordCorruptFailure,
  makeChildRecordQuarantinedFailure,
  makeChildRecordQuotaExceededFailure,
  makeChildRecoveryUnavailableFailure,
  makeChildSpawnFailedFailure,
  makeThreadAlreadyRunningFailure,
  makeThreadAuthorityDeniedFailure,
  makeThreadIntegrityFailure,
  makeThreadNotFoundFailure,
  makeThreadNotResumableFailure,
  makeThreadNotRetryableFailure,
  makeThreadResumeUnavailableFailure,
  makeThreadStaleFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PathContainmentPort } from "./path-containment.js";
import { isLexicallyContained } from "./path-containment.js";
import {
  type PiChildPrivateOutputCapture,
  type PiChildSessionObserverResult,
  type PiChildSettlement,
  PiRpcChild,
  type PiRpcChildSpawnSession,
} from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import type { PiTelemetryUsageSink } from "./telemetry.js";
import type { IdGenerator, PiAdapterLogger } from "./types.js";

/** A task/context object echoed at multiple layers (Pi adapter contract). */
export interface PiDelegationContext {
  readonly parentAgentName: string;
  readonly parentDepth: number;
  readonly cwd: string;
}

export interface PiDelegationControllerDeps {
  readonly config: WeaveConfig;
  readonly generationId: string;
  readonly idGenerator: IdGenerator;
  readonly logger: PiAdapterLogger;
  readonly processPort: PiChildProcessPort;
  /**
   * The one generation-scoped authority handed to every child this
   * controller launches, including retry and continue spawns. It is
   * required, with no default: a silent fallback authority would let
   * readiness report ready while every spawn refuses, so each construction
   * site must state, by name, which authority governs its launches.
   */
  readonly sessionStorageAuthority: PiChildSessionStorageAuthority;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly timerPort?: TimerPort;
  readonly handshakeTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly settlementTimeoutMs?: number;
  readonly runtimeBudgetMs?: number;
  readonly cancelGraceMs?: number;
  /** Bounded post-settlement drain window for the child result contract. */
  readonly responseDrainMs?: number;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly command?: readonly string[];
  /**
   * The real primary/root agent's own logical name for this generation, as
   * activated by the extension - never caller-supplied. Used to verify
   * that a `delegate()` call claiming to originate from the synthetic
   * root (`parentId === ROOT_NODE_ID`) isn't forging a different
   * `parentAgentName` to pick a looser delegation budget than the real
   * root actually has (Pi adapter contract). A lazy accessor, not a plain string,
   * because the real primary agent may not finish activating until after
   * this controller is constructed for the generation - callers must
   * always read the *current* value, never one captured too early.
   * Returns `undefined` only in tests that don't exercise root-level
   * delegation, or before the primary has activated.
   */
  readonly rootAgentName?: () => string | undefined;
  /**
   * Resolves a nested/descendant delegation target (Pi adapter contract): given
   * the *requesting* child's own agent name and the target agent name it
   * asked for, returns that target only if it is one of the requester's
   * OWN normalized `delegationTargets` - never any arbitrary agent in the
   * project. Returns `undefined` to fail closed (invalid/ineligible
   * target, or nested delegation not wired for this generation).
   */
  readonly resolveDelegationTarget?: (
    requestingAgentName: string,
    targetAgentName: string,
  ) => DelegationTarget | undefined;
  /**
   * Builds the bootstrap payload for a resolved nested delegation target,
   * given the pre-generated child id (used as the bootstrap's
   * `correlationId`, as required by the Pi adapter contract) and the requesting child's own
   * delegation context.
   */
  readonly buildBootstrap?: (
    target: DelegationTarget,
    childId: string,
    context: PiDelegationContext,
  ) => JsonValue;
  /**
   * Invoked whenever the inspectable tree may have changed (Pi adapter contract
   *) - immediately on spawn/settle/cancel/dispose, and on a bounded
   * poll interval while any child is live, so turn/tool/usage/output
   * updates streaming from a running child are eventually reflected too.
   */
  readonly onTreeChanged?: () => void;
  readonly treeRefreshIntervalMs?: number;
  /**
   * Durable usage-ledger seam (Pi adapter contract). When present, every settled
   * child assistant message (deduplicated per {@link PiRpcChild}'s own
   * `seenUsageMessageIds`) is also recorded as one exact-once usage
   * observation. Absent in tests that don't exercise telemetry.
   */
  readonly telemetry?: PiTelemetryUsageSink;
  /** Private inspector/history sink. Full output never enters settlements. */
  readonly onPrivateOutput?: (
    childId: string,
    capture: PiChildPrivateOutputCapture,
  ) => PiChildSessionObserverResult;
  /**
   * Invoked after parser-approved inspection checkpointing for every live
   * child session event. Exceptions are caught/logged and never affect
   * execution. Overlay and other UI seams subscribe here.
   */
  readonly onChildSessionEvent?: (
    childId: string,
    event: PiChildSessionEvent,
  ) => void;
  readonly inspectionRegistry?: PiChildInspectionRegistry;
  readonly pathContainment?: PathContainmentPort;
  readonly currentCwd?: () => string;
  readonly currentEnv?: () => Readonly<Record<string, string>>;
  readonly resolveRootDelegationTarget?: (
    name: string,
  ) => DelegationTarget | undefined;
  /**
   * Resolves the configured engine descriptor's category name for one agent,
   * used as the inspector's `role` fact. Returns `undefined` for an agent this
   * session did not configure, or for a configured agent with no category:
   * a role is only ever reported, never invented.
   */
  readonly resolveAgentRole?: (agentName: string) => string | undefined;
  /**
   * Reads the live parent session id (Task 7's persistent-parent probe). Thread
   * ownership is measured against it, so a session transition can never let a
   * new parent inherit another parent's threads.
   */
  readonly parentSessionId?: () => string | undefined;
  /** Task 5 parent custom-entry ref store for thread resolution and dividers. */
  readonly threadRefs?: () => PiThreadRefPort | undefined;
  /** Task 4 native child session store; the authoritative thread source. */
  readonly threadSessions?: () => PiThreadSessionPort | undefined;
  /** Task 6 metadata cache. Best effort only: failures never block a run. */
  readonly threadCache?: () => PiThreadCachePort | undefined;
  /** Cache scoping key. Only read when a cache port is present. */
  readonly threadWorkspaceKey?: () => string;
  /**
   * Production sets this when Task 4/5 sources were required for the
   * generation. An absent session store then fails closed instead of taking
   * the legacy ephemeral start path. Unit embeddings omit the flag (or set
   * it false) so tests without a factory keep pre-thread start semantics.
   */
  readonly threadSourcesRequired?: boolean;
}

// ---------------------------------------------------------------------------
// Thread lifecycle (Pi adapter contract §9: start / retry / continue)
// ---------------------------------------------------------------------------

/** The default bounded continuation instruction used by a retry without one. */
export const DEFAULT_THREAD_RETRY_INSTRUCTION =
  "Retry the previous task in this thread. Review what already happened, correct what failed, and finish the task.";

export type PiThreadAction = "retry" | "continue";

/**
 * Path-free overlay descriptor for one live or historical child identity.
 * Never carries filesystem paths or session file locations.
 */
export interface PiOverlayChildDescriptor {
  readonly childId: string;
  readonly threadId: string;
  /** Newest live run child id when known; otherwise the resolved child id. */
  readonly activeChildId: string;
  readonly status: "live" | "settled" | "orphan";
  readonly title: string;
  readonly generationId: string;
  readonly parentChildId: string | undefined;
  readonly runs: readonly {
    readonly run: number;
    readonly action: "start" | "retry" | "continue";
    readonly startedAt?: number;
    readonly priorOutcome?: string;
    readonly initiator?: string;
    readonly model?: string;
    readonly reasoning?: string;
  }[];
  readonly branchIds: readonly string[];
  readonly descendantChildIds: readonly string[];
  /**
   * Opaque Task 4 session ref when known. Contained root-relative identity
   * only — never an absolute filesystem path.
   */
  readonly sessionRef: string | undefined;
  /**
   * Authoritative identity and operational facts for the inspector header and
   * rail (Spec 33 §7).
   *
   * Live children fill these from this generation's own thread state and the
   * child tree node; historical children fill them from the child's own
   * `weave.child.thread` metadata entry. Nothing here is ever inferred from a
   * title, from the parent's model, from a configured default, or from another
   * child's usage: an unknown fact is absent.
   */
  readonly agentName?: string;
  readonly parentAgentName?: string;
  /** Configured category name for this agent; absent when unconfigured. */
  readonly role?: string;
  readonly model?: string;
  readonly reasoning?: string;
  /**
   * The child's own assignment fact, when an authoritative privacy-safe source
   * names one.
   *
   * It is deliberately never the dispatched task text. A task is untrusted
   * caller content that can carry secrets, credentials and filesystem paths,
   * and no such content may cross this boundary — the thread-lifecycle privacy
   * test pins that for every descriptor a live or historical child yields. No
   * source proves an assignment today, so the fact stays absent, exactly like
   * every other unknown here.
   */
  readonly assignment?: string;
  readonly turn?: number;
  readonly queueDepth?: number;
  readonly elapsedMs?: number;
  readonly usage?: PiOverlayChildUsage;
}

/** Bounded aggregate usage the delegation tree reported for one child. */
export interface PiOverlayChildUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
}

/**
 * Who is asking for the run. Owner is the live parent session that created the
 * thread; an ancestor is an authenticated live child in this generation that
 * additionally holds an explicit transfer for this exact thread.
 */
export type PiThreadInitiator =
  | { readonly kind: "owner"; readonly parentSessionId: string }
  | { readonly kind: "ancestor"; readonly ancestorChildId: string };

/**
 * Assigned identity for one retry/continue run, reported before spawn so the
 * tool layer can open a fresh compact block with the correct run number.
 */
export interface PiThreadRunAssignment {
  readonly threadId: string;
  readonly runNumber: number;
  readonly action: PiThreadAction;
  readonly agentName: string;
  readonly childId: string;
}

export interface PiThreadRunRequest {
  readonly threadId: string;
  readonly action: PiThreadAction;
  /** Continue: required. Retry: optional; a default instruction is used. */
  readonly instruction?: string;
  readonly initiator: PiThreadInitiator;
  /**
   * Optional parser-approved session-event sink for this resume run. Threaded
   * into the internal `PiDelegationRequest` before `spawnNow`.
   */
  readonly onSessionEvent?: (event: PiChildSessionEvent) => void;
  /**
   * Invoked once the run number, child id, agent, and action are assigned and
   * before `spawnNow`. Exceptions are isolated and never affect the run.
   */
  readonly onRunAssigned?: (assignment: PiThreadRunAssignment) => void;
}

/** One completed thread run. The tool layer bounds and redacts it further. */
export interface PiThreadRunOutcome {
  readonly threadId: string;
  readonly run: number;
  readonly settlement: PiChildSettlement;
}

/** Structural view of the Task 5 ref store this controller depends on. */
export interface PiThreadRefPort {
  liveParentSessionId(): string;
  readRefs(options?: {
    readonly limit?: number;
  }): ResultAsync<PiChildRefScan, PiChildRefError>;
  appendNewChild(
    input: AppendNewChildRefInput,
  ): ResultAsync<PiChildRefRecord, PiChildRefError>;
  appendRunDivider(
    record: PiChildRefRecord,
    input: AppendChildRefRunInput,
  ): ResultAsync<PiChildRefRecord, PiChildRefError>;
  appendLifecycle(
    record: PiChildRefRecord,
    input: AppendChildRefLifecycleInput,
  ): ResultAsync<PiChildRefRecord, PiChildRefError>;
}

/** Structural view of the Task 4 native session store. */
/**
 * Internal, path-free handle on a proven native session: the store's own
 * validated record plus the leaf it is anchored at. It never leaves the
 * controller; only the store converts it into a launch grant.
 */
interface PiThreadLaunchSource {
  readonly record: PiNativeSessionRecord;
  readonly activeLeafId: string;
}

export interface PiThreadSessionPort {
  /**
   * Mints the unforgeable launch grant one child needs to start against one
   * validated native session (Spec 33 §5.3 / R5). The controller never hands
   * a filesystem path to a launch path, and never a record the store did not
   * itself validate: the mint reopens and revalidates the proven session
   * before it authorizes anything, which is why it is asynchronous.
   */
  mintLaunchGrant(
    input: MintNativeSessionLaunchGrantInput,
  ): ResultAsync<PiChildSessionLaunchGrant, PiNativeSessionError>;
  createChildSession(
    input: CreateNativeChildSessionInput,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError>;
  establishThreadLeaf(
    ref: string,
    metadata: PiNativeThreadMetadataInput,
    expectedParentSession?: string,
  ): ResultAsync<
    { readonly record: PiNativeSessionRecord; readonly leafId: string },
    PiNativeSessionError
  >;
  appendResultOutput?(
    ref: string,
    output: string,
    expected: PiNativeResultAppendIdentity,
  ): ResultAsync<void, PiNativeSessionError>;
  /**
   * Bounded, paged verification and exact retrieval of a durable result. The
   * caller proves the exact child identity it is asking for, so a sibling of
   * the same parent can never be served another child's result.
   */
  readResultGroup?(
    ref: string,
    expected: PiNativeResultReadIdentity,
    options?: PiNativeResultGroupReadOptions,
  ): ResultAsync<PiNativeResultGroupRead, PiNativeSessionError>;
  appendTombstone(
    record: PiNativeSessionRecord,
  ): ResultAsync<PiNativeSessionTombstone, PiNativeSessionError>;
  openSession(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionRecord, PiNativeSessionError>;
  readSessionEntries(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeSessionEntries, PiNativeSessionError>;
  /**
   * Bounded native JSONL page read for historical overlay paging. Must not
   * materialize the full transcript for overlay consumers.
   */
  readSessionEntryPage(
    ref: string,
    expectedParentSession: string | undefined,
    options: PiNativeSessionEntryPageOptions,
  ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError>;
  readThreadMetadata(
    ref: string,
    expectedParentSession?: string,
  ): ResultAsync<PiNativeThreadMetadata, PiNativeSessionError>;
}

/** Structural view of the Task 6 metadata cache. Best effort by contract. */
export interface PiThreadCachePort {
  upsertRef(
    ref: PiChildRefRecord,
    workspaceKey: string,
    options?: { readonly stale?: boolean },
  ): Result<unknown, unknown>;
}

/**
 * Result of one confirmed session-transition settlement: how many owned
 * subtree roots were cancelled and how many origin settlement appends landed.
 */
export interface PiTransitionSettlementReport {
  readonly cancelled: number;
  readonly settlementsWritten: number;
}

/** Outcome of a bounded quit/reload shutdown. */
export interface PiShutdownReport {
  readonly gracefullyCancelled: number;
  readonly forceStopped: number;
  readonly timedOut: boolean;
}

/** Default graceful-cancel budget before quit/reload force-stops what remains. */
export const DEFAULT_TRANSITION_SHUTDOWN_BUDGET_MS = 10_000;

/** Adapter-tracked state of one logical thread across all of its runs. */
interface PiThreadState {
  readonly threadId: string;
  readonly agentName: string;
  readonly parentId: string;
  readonly parentDepth: number;
  readonly parentAgentName: string;
  readonly ownerParentSessionId: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Concrete model identity the thread's runs are dispatched with, if known. */
  readonly model: string | undefined;
  /** Thinking/reasoning intent recorded for the thread's runs, if known. */
  readonly reasoning: string | undefined;
  /** Newest run's child id. A new one is minted for every run. */
  latestChildId: string;
  status: PiChildRefStatus;
  runs: number;
  /** Retryability of the newest settled run. Unknown until one settles. */
  lastRetryable: boolean | undefined;
  running: boolean;
}

export interface PiAuthenticatedDelegationRequest extends PiDelegationContext {
  readonly parentId: string;
  readonly agentName: string;
  readonly task: string;
}

export interface PiDelegationRequest {
  readonly parentId: string;
  readonly parentDepth: number;
  /**
   * The invoking (parent) agent's own logical name - portable delegation
   * limits (Pi adapter contract, ADR 0008) are the *parent's* budget for how many
   * children it may spawn, never the target's own settings.
   */
  readonly parentAgentName: string;
  readonly agentName: string;
  readonly task: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly bootstrap: JsonValue;
  /**
   * Trusted adapter-owned session selection. Only the thread lifecycle sets
   * this, to reopen an existing native child session at its active leaf; an
   * ordinary start never carries one and stays ephemeral.
   */
  readonly session?: PiRpcChildSpawnSession;
  /** Receives bounded snapshots for this exact child while it runs. */
  readonly onUpdate?: (snapshot: PiChildTreeNode) => void;
  /**
   * Receives each parser-approved child session event while this child runs.
   * Invoked from the authenticated session observer after inspection
   * checkpointing. Exceptions are caught/logged and never affect execution.
   */
  readonly onSessionEvent?: (event: PiChildSessionEvent) => void;
  /**
   * Pre-generated by the caller when it must know the child id *before*
   * calling `delegate()` - e.g. to embed it as the bootstrap's
   * `correlationId` (Pi adapter contract). Falls back to a
   * controller-generated id when absent.
   */
  readonly childId?: string;
}

interface QueuedDelegation {
  readonly childId: string;
  readonly request: PiDelegationRequest;
  readonly resolve: (
    result: Result<PiChildSettlement, PiAdapterFailure>,
  ) => void;
}

const DEFAULT_TREE_REFRESH_INTERVAL_MS = 500;

/**
 * Reads the concrete model identity and thinking intent out of a bootstrap body
 * so the inspection view can name what the child is actually running on.
 */
/**
 * Reads the id of the newest entry in a native child session: the leaf a
 * resumed run must reopen at. Entries arrive from the host by reference and
 * are never copied; only the last id-bearing record is inspected.
 */
function readActiveLeafId(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

function bootstrapRuntimeMeta(bootstrap: unknown): {
  readonly model?: string;
  readonly thinkingLevel?: string;
} {
  if (typeof bootstrap !== "object" || bootstrap === null) return {};
  const record = bootstrap as Record<string, unknown>;
  const resolved = record.resolvedModel;
  const identity =
    typeof resolved === "object" && resolved !== null
      ? (resolved as Record<string, unknown>)
      : undefined;
  const id = identity?.id;
  const thinkingLevel = record.thinkingLevel;
  return {
    ...(typeof id === "string" && id !== "" ? { model: id } : {}),
    ...(typeof thinkingLevel === "string" && thinkingLevel !== ""
      ? { thinkingLevel }
      : {}),
  };
}

/**
 * Derives resume retryability from a settled ref status. Unknown/in-flight
 * statuses leave retryability unset so readiness fails closed instead of
 * inventing a prior outcome.
 */
function retryableFromRefStatus(status: PiChildRefStatus): boolean | undefined {
  if (status === "completed") return false;
  if (status === "failed" || status === "cancelled") return true;
  return undefined;
}

type PiChildRestoreUnavailableReason =
  | "stale generation"
  | "record is not an interrupted ordinary child"
  | "duplicate live child"
  | "active leaf is missing"
  | "restore dependencies unavailable"
  | "root authority unavailable"
  | "session reference is missing"
  | "invalid session path"
  | "invalid session directory"
  | "containment failed"
  | "capacity unavailable";

type PiChildRestoreFailure =
  | {
      readonly type: "ChildRecoveryUnavailable";
      readonly reason: PiChildRestoreUnavailableReason;
    }
  | {
      readonly type: "ChildRecoverySpawnFailed";
      readonly phase:
        | "attachment"
        | "bootstrap"
        | "handshake"
        | "run"
        | "settlement"
        | "persistence";
    };

export class PiDelegationController {
  private readonly children = new Map<string, PiRpcChild>();
  private readonly queue: QueuedDelegation[] = [];
  /** Slots reserved by queued requests while durable session provisioning runs. */
  private queueReservations = 0;
  /**
   * Authorized starts that have not yet registered a live child. JavaScript can
   * interleave async provisioning and inspection registration, so these slots
   * close the gap between authorization and `children.set`.
   */
  private readonly dispatchReservations = new Map<string, number>();
  private dispatchProcessReservations = 0;
  private disposedAll = false;
  private treeRefreshTimer: TimerHandle | undefined;
  /** Built once, and only when no port was injected. */
  private fallbackTimerPort: TimerPort | undefined;
  private readonly restoreReservations = new Set<string>();
  /** One entry per logical thread this generation started or resumed. */
  private readonly threads = new Map<string, PiThreadState>();
  /**
   * Newest queued-prompt depth a live child itself reported, keyed by child id.
   *
   * The only authoritative source is the child's own parser-approved
   * `queue_change` event, so a child that never reported one has no entry and
   * the inspector shows no queue fact rather than a guessed zero. Entries are
   * dropped with the child, so this stays bounded by the live child count.
   */
  private readonly liveQueueDepths = new Map<string, number>();
  /** Explicit thread transfers: thread id to the ancestor child id granted it. */
  private readonly threadTransfers = new Map<string, string>();
  /**
   * Newest parent ref record seen for each logical thread. A session
   * transition writes settlement metadata back through these records, so the
   * append always lands in the origin parent that owns the thread and never
   * in a destination/new session.
   */
  private readonly threadRecords = new Map<string, PiChildRefRecord>();
  /**
   * `thread\0status` keys whose settlement metadata has already landed in the
   * origin refs. Keeps the transition write-back and the ordinary in-flight
   * settlement write from double-appending the same outcome.
   */
  private readonly threadSettlementWritten = new Set<string>();
  /**
   * In-flight settlement appends keyed by `thread\0status`. Both the ordinary
   * asynchronous settlement path and the session-transition path route
   * through this map, so a race shares one write promise instead of
   * producing two entries, and a transition can await a write the ordinary
   * path already started. A failed write is removed so it stays retryable,
   * and its failure is returned to every joined caller.
   */
  private readonly threadSettlementWrites = new Map<
    string,
    Promise<Result<void, PiAdapterFailure>>
  >();

  /**
   * The authority every child launch consults first. Resolved once, here, so
   * no per-spawn branch can pick a different one, and defaulting to the
   * production (always-refusing) authority when the caller names none.
   */
  private readonly sessionStorageAuthority: PiChildSessionStorageAuthority;

  constructor(private readonly deps: PiDelegationControllerDeps) {
    this.sessionStorageAuthority = deps.sessionStorageAuthority;
  }

  private requireSessionStorageAuthority(
    childId: string,
  ): Result<void, PiAdapterFailure> {
    return this.sessionStorageAuthority
      .requireNativeSessionAuthority()
      .mapErr((failure) =>
        makeChildSpawnFailedFailure(
          childId,
          describeChildSessionStorageUnavailable(failure),
        ),
      );
  }

  /**
   * Steers a live child through its {@link PiRpcChild} RPC channel. Missing or
   * settled/disposed children return a bounded typed failure without throwing.
   */
  steerChild(
    childId: string,
    text: string,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.withLiveChild(childId, (child) =>
      child.steer(childId, this.deps.generationId, text),
    );
  }

  /**
   * Queues a follow-up on a live child through its {@link PiRpcChild} RPC
   * channel. Missing or settled/disposed children return a bounded typed
   * failure without throwing.
   */
  followUpChild(
    childId: string,
    text: string,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.withLiveChild(childId, (child) =>
      child.followUp(childId, this.deps.generationId, text),
    );
  }

  /**
   * Resolves any live run child id (or logical thread id) to a path-free
   * overlay descriptor. Live memory wins; historical ids fall through Task 5
   * refs. Never returns filesystem paths.
   */
  resolveOverlayChild(
    childId: string,
  ): ResultAsync<PiOverlayChildDescriptor, PiAdapterFailure> {
    if (childId.length === 0) {
      return errAsync(makeThreadNotFoundFailure(childId, "unknown-thread"));
    }
    const live = this.resolveLiveOverlayChild(childId);
    if (live !== undefined) return okAsync(live);
    return this.resolveHistoricalOverlayChild(childId);
  }

  /**
   * Maps a RUNNING run child id to its logical thread id.
   *
   * Liveness, not mere acquaintance, is the contract. A thread outlives the
   * run that opened it — it stays in this generation's map so it can be
   * resumed — so answering from the map alone reported every settled child as
   * live forever. The child inspector treats this as its settlement signal:
   * with a thread id still coming back, a settled child kept an open overlay
   * on `LIVE`, with a frozen elapsed time and an editable prompt, while the
   * parent's own card already said `COMPLETED`.
   *
   * Undefined for a settled, cancelled, tombstoned, historical-only, or
   * unknown id.
   */
  resolveThreadIdForLiveChild(childId: string): string | undefined {
    const state = this.findLiveThreadState(childId);
    return state?.running === true ? state.threadId : undefined;
  }

  /** Requests one delegated child. Resolves immediately if denied, queues if over budget, spawns once authorized. */
  delegate(
    request: PiDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const storageAuthority = this.requireSessionStorageAuthority("delegation");
    if (storageAuthority.isErr()) return errAsync(storageAuthority.error);
    const childId = request.childId ?? this.deps.idGenerator.next();
    const validation = this.validateRequest(childId, request);
    if (validation.isErr()) return errAsync(validation.error);
    const identity = this.verifyParentIdentity(request);
    if (identity.isErr()) {
      return errAsync(makeChildAbortFailedFailure(childId, identity.error));
    }
    return this.authorizeAndDispatch(childId, request);
  }

  /**
   * Relays one request from an authenticated, currently running direct-step
   * child into this controller's ordinary child tree and shared budgets.
   * Only the direct-step RPC transport may call this seam: that transport
   * has already verified the child's HMAC envelope, generation, identity,
   * sequence, and running state before exposing the request here.
   */
  delegateFromAuthenticatedParent(
    request: PiAuthenticatedDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const storageAuthority = this.requireSessionStorageAuthority("delegation");
    if (storageAuthority.isErr()) return errAsync(storageAuthority.error);
    const childId = this.deps.idGenerator.next();
    const target = this.deps.resolveDelegationTarget?.(
      request.parentAgentName,
      request.agentName,
    );
    const buildBootstrap = this.deps.buildBootstrap;
    if (target === undefined || buildBootstrap === undefined) {
      return errAsync(
        makeChildAbortFailedFailure(childId, "invalid delegation target"),
      );
    }
    const delegationRequest: PiDelegationRequest = {
      ...request,
      env: {},
      childId,
      bootstrap: buildBootstrap(target, childId, {
        parentAgentName: request.parentAgentName,
        parentDepth: request.parentDepth,
        cwd: request.cwd,
      }),
    };
    const validation = this.validateRequest(childId, delegationRequest);
    if (validation.isErr()) return errAsync(validation.error);
    return this.authorizeAndDispatch(childId, delegationRequest);
  }

  private validateRequest(
    childId: string,
    request: PiDelegationRequest,
  ): Result<void, PiAdapterFailure> {
    if (this.disposedAll) {
      return err(makeChildAbortFailedFailure(childId, "controller disposed"));
    }
    if (
      request.parentId.length === 0 ||
      !Number.isInteger(request.parentDepth) ||
      request.parentDepth < 0
    ) {
      return err(
        makeChildAbortFailedFailure(childId, "invalid parent reference"),
      );
    }
    // Defense-in-depth bound re-check (Pi adapter contract): the same task
    // and context limits are enforced at tool parsing, the bootstrap control
    // schema, here (the controller), and again at RPC prompt send in
    // `rpc-child.ts` - never trusting a single upstream layer alone.
    if (
      request.task.length < 1 ||
      request.parentAgentName.length < 1 ||
      request.parentAgentName.length > MAX_NAME_LENGTH ||
      request.agentName.length < 1 ||
      request.agentName.length > MAX_NAME_LENGTH ||
      request.cwd.length < 1 ||
      request.cwd.length > MAX_CWD_LENGTH
    ) {
      return err(
        makeChildAbortFailedFailure(
          childId,
          "task is empty or context exceeds bound",
        ),
      );
    }
    return ok(undefined);
  }

  private authorizeAndDispatch(
    childId: string,
    request: PiDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const decision = this.authorize(request);
    if (decision.isErr()) {
      // Config-level limit-resolution failures should already be rejected at
      // config-validation time; treat any that slip through as a hard cap so
      // delegation never fails open (Pi adapter contract, ADR 0008).
      return errAsync(
        makeChildCapacityExceededFailure(childId, "max_children"),
      );
    }
    if (decision.value.outcome === "denied") {
      return errAsync(
        makeChildCapacityExceededFailure(childId, decision.value.reason),
      );
    }
    const queued = decision.value.outcome !== "authorized";
    let queueReserved = false;
    let dispatchReserved = false;
    if (queued) {
      const limits = resolveEffectiveDelegationLimits(
        this.deps.config,
        request.parentAgentName,
      );
      if (
        limits.isErr() ||
        this.queue.length + this.queueReservations >= limits.value.maxProcesses
      ) {
        return errAsync(
          makeChildCapacityExceededFailure(childId, "queue_capacity"),
        );
      }
      this.queueReservations += 1;
      queueReserved = true;
    } else {
      this.reserveDispatch(request.parentId);
      dispatchReserved = true;
    }
    const releaseDispatch = (): void => {
      if (!dispatchReserved) return;
      this.releaseDispatch(request.parentId);
      dispatchReserved = false;
    };
    // The authoritative native session and its parent ref are created here,
    // strictly before any process or lease exists. A provisioning failure
    // therefore leaves no child process, no lease, no thread, and no
    // half-written authority behind - the run simply never started.
    return this.provisionThreadSource(childId, request)
      .andThen((provisioned) => {
        // Every start opens a logical thread whose id is this first run's
        // child id. Later runs of the same thread mint their own child ids and
        // never reuse, reopen, or rewrite this one.
        this.registerThreadRun(childId, childId, request);
        const runRequest: PiDelegationRequest =
          provisioned === undefined
            ? request
            : { ...request, session: provisioned.session };
        if (queueReserved) {
          this.queueReservations -= 1;
          queueReserved = false;
        }
        const dispatched = queued
          ? this.enqueue(childId, runRequest)
          : this.spawnNow(childId, runRequest, releaseDispatch);
        return new ResultAsync<PiChildSettlement, PiAdapterFailure>(
          (async () => {
            const settled = await dispatched;
            this.settleThread(childId, settled);
            if (provisioned !== undefined) {
              this.recordThreadSettlement(
                provisioned.ref,
                this.threads.get(childId),
              );
            }
            return settled;
          })(),
        );
      })
      .orElse((failure) => {
        if (queueReserved) {
          this.queueReservations -= 1;
          queueReserved = false;
        }
        releaseDispatch();
        return errAsync(failure);
      });
  }

  /**
   * Creates the thread's authoritative sources for a *new* thread: the native
   * child session under the Weave-owned isolated root, a real active leaf, and
   * the parent's new-child ref. The metadata cache is projected best effort
   * and can never block or fail a run.
   *
   * Resolves to `undefined` when no provisioning source is wired, which
   * preserves the pre-thread start semantics byte for byte for embeddings and
   * tests that supply no session store.
   */
  private provisionThreadSource(
    childId: string,
    request: PiDelegationRequest,
  ): ResultAsync<
    | {
        readonly session: PiRpcChildSpawnSession;
        readonly ref: PiChildRefRecord;
      }
    | undefined,
    PiAdapterFailure
  > {
    const sessions = this.deps.threadSessions?.();
    if (sessions === undefined) {
      if (this.deps.threadSourcesRequired === true) {
        // Production wired a required factory but the authoritative store is
        // missing: refuse before process/lease rather than legacy ephemeral start.
        return errAsync(
          makeChildSpawnFailedFailure(childId, "thread-sessions-unavailable"),
        );
      }
      // No native session store wired: preserve pre-thread start semantics.
      return okAsync(undefined);
    }
    const refs = this.deps.threadRefs?.();
    if (refs === undefined) {
      // A native session without a parent ref would be unreachable authority:
      // refuse before creating one rather than orphan it.
      return errAsync(
        makeChildSpawnFailedFailure(childId, "thread-refs-unavailable"),
      );
    }
    const parentSession = refs.liveParentSessionId();
    if (parentSession.length === 0) {
      return errAsync(
        makeChildSpawnFailedFailure(childId, "thread-parent-unavailable"),
      );
    }
    const runtime = bootstrapRuntimeMeta(request.bootstrap);
    const createdAt = this.deps.now?.() ?? Date.now();
    return sessions
      .createChildSession({ childId, parentSession, cwd: request.cwd })
      .mapErr(() =>
        makeChildSpawnFailedFailure(childId, "thread-session-create-failed"),
      )
      .andThen((record) =>
        sessions
          .establishThreadLeaf(
            record.ref,
            {
              threadId: childId,
              agentName: request.agentName,
              parentId: request.parentId,
              parentAgentName: request.parentAgentName,
              parentDepth: request.parentDepth,
              ownerParentSessionId: parentSession,
              cwd: request.cwd,
              ...(runtime.model === undefined ? {} : { model: runtime.model }),
              ...(runtime.thinkingLevel === undefined
                ? {}
                : { reasoning: runtime.thinkingLevel }),
              createdAt,
            },
            parentSession,
          )
          .mapErr(() => {
            this.tombstoneProvisionedSession(sessions, record);
            return makeChildSpawnFailedFailure(
              childId,
              "thread-leaf-unavailable",
            );
          })
          .andThen((leaf) =>
            refs
              .appendNewChild({
                childId,
                threadId: childId,
                nativeSessionId: record.sessionId,
                sessionRef: record.ref,
                // Spec 33 §4.2/§13, Threat Model T6: the durable title is
                // derived only from trusted identity metadata. No task text,
                // prompt text or transcript content may reach it. The explicit
                // provenance marker (Task 21 remediation D) is what lets every
                // later reader trust this title; a row without it is replaced
                // by the safe fallback.
                title: resolveDurableChildTitle({
                  agentName: request.agentName,
                  threadId: childId,
                }),
                titleProvenance: PI_CHILD_TITLE_PROVENANCE,
                status: "running",
                run: {
                  action: "start",
                  startedAt: createdAt,
                  ...(runtime.model === undefined
                    ? {}
                    : { model: runtime.model }),
                  ...(runtime.thinkingLevel === undefined
                    ? {}
                    : { reasoning: runtime.thinkingLevel }),
                },
              })
              .mapErr(() => {
                this.tombstoneProvisionedSession(sessions, record);
                return makeChildSpawnFailedFailure(
                  childId,
                  "thread-ref-write-failed",
                );
              })
              .andThen((ref) =>
                // The launch grant is minted by the store, from the store's
                // own validated record, and bound to the child that will
                // actually start. Nothing downstream sees a path.
                sessions
                  .mintLaunchGrant({
                    childId,
                    record,
                    activeLeafId: leaf.leafId,
                  })
                  .mapErr(() => {
                    this.tombstoneProvisionedSession(sessions, record);
                    return makeChildSpawnFailedFailure(
                      childId,
                      "thread-launch-grant-unavailable",
                    );
                  })
                  .map((grant) => {
                    this.rememberThreadRecord(ref);
                    return {
                      session: { mode: "native" as const, grant },
                      ref,
                    };
                  }),
              ),
          ),
      );
  }

  /**
   * Marks a session created for a run that never started. Best effort by
   * design: the ref that would have made it reachable was never written, so a
   * failed tombstone leaves an unreferenced file, never a resumable thread.
   */
  private tombstoneProvisionedSession(
    sessions: PiThreadSessionPort,
    record: PiNativeSessionRecord,
  ): void {
    void sessions.appendTombstone(record).match(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Verifies `parentId` names *exactly* the real synthetic root or a real
   * live, non-terminal requesting child, and that the request's claimed
   * `parentAgentName`/`parentDepth` match that identity's true recorded
   * values (Pi adapter contract). `authorize()` alone can't catch a forged
   * identity since it only trusts the request's own claimed fields as
   * given - without this, a caller could name a completely fabricated
   * `parentId` to get a brand-new, uncapped budget bucket, or name a real
   * *existing* parent's own `parentId` while forging a different
   * `parentAgentName`/`parentDepth`/depth-zero root claim to bypass that
   * parent's true per-parent FIFO/limits. Every `delegate()` call - root
   * or nested - must therefore resolve to one of exactly two legitimate
   * identities: the synthetic root, or a child this controller itself
   * currently tracks as live and not yet terminal.
   */
  private verifyParentIdentity(
    request: PiDelegationRequest,
  ): Result<void, string> {
    if (request.parentId === ROOT_NODE_ID) {
      if (request.parentDepth !== 0) return err("forged root depth");
      const rootAgentName = this.deps.rootAgentName?.();
      if (
        rootAgentName !== undefined &&
        request.parentAgentName !== rootAgentName
      ) {
        return err("forged root agent name");
      }
      return ok(undefined);
    }
    const parent = this.children.get(request.parentId);
    if (parent === undefined) return err("unknown parent reference");
    if (this.isTerminal(parent)) return err("parent is no longer live");
    if (parent.getAgentName() !== request.parentAgentName) {
      return err("forged parent agent name");
    }
    if (parent.getDepth() !== request.parentDepth) {
      return err("forged parent depth");
    }
    return ok(undefined);
  }

  private authorize(
    request: PiDelegationRequest,
  ): Result<
    DelegationAuthorizationDecision,
    DelegationAuthorizationError | DelegationLimitsError
  > {
    const limits = resolveEffectiveDelegationLimits(
      this.deps.config,
      request.parentAgentName,
    );
    if (limits.isErr()) return err(limits.error);
    return authorizeDelegation({
      limits: limits.value,
      directChildren: this.countDirectChildren(request.parentId),
      activeChildren: this.countActiveChildren(request.parentId),
      childDepth: request.parentDepth + 1,
      liveProcesses: this.countLiveProcesses(),
    });
  }

  /**
   * Counts the controller's structural direct-child records. This count may
   * include queued and terminal records for the engine's consistency check;
   * the active-child capacity decisions use `countActiveChildren()` below so
   * settled/disposed children never consume `max_children`.
   */
  private countDirectChildren(parentId: string): number {
    let count = this.dispatchReservations.get(parentId) ?? 0;
    for (const child of this.children.values())
      if (child.getParentId() === parentId) count += 1;
    for (const queued of this.queue)
      if (queued.request.parentId === parentId) count += 1;
    return count;
  }

  /** Counts direct children that are still occupying execution capacity. */
  private countActiveChildren(parentId: string): number {
    let count = this.dispatchReservations.get(parentId) ?? 0;
    for (const child of this.children.values()) {
      if (child.getParentId() === parentId && !this.isTerminal(child))
        count += 1;
    }
    if (parentId === ROOT_NODE_ID) count += this.restoreReservations.size;
    return count;
  }

  private countLiveProcesses(): number {
    let count = this.dispatchProcessReservations;
    for (const child of this.children.values())
      if (!this.isTerminal(child)) count += 1;
    count += this.restoreReservations.size;
    return count;
  }

  private reserveDispatch(parentId: string): void {
    this.dispatchReservations.set(
      parentId,
      (this.dispatchReservations.get(parentId) ?? 0) + 1,
    );
    this.dispatchProcessReservations += 1;
  }

  private releaseDispatch(parentId: string): void {
    const reserved = this.dispatchReservations.get(parentId) ?? 0;
    if (reserved <= 1) this.dispatchReservations.delete(parentId);
    else this.dispatchReservations.set(parentId, reserved - 1);
    if (this.dispatchProcessReservations > 0)
      this.dispatchProcessReservations -= 1;
  }

  private isTerminal(child: PiRpcChild): boolean {
    return child.isDisposed() || child.isSettled();
  }

  /**
   * Resolves a live, non-terminal child for mutation seams. Missing and
   * settled/disposed children share one bounded interaction-unavailable code.
   */
  private withLiveChild(
    childId: string,
    fn: (child: PiRpcChild) => ResultAsync<void, PiAdapterFailure>,
  ): ResultAsync<void, PiAdapterFailure> {
    if (this.disposedAll) {
      return errAsync(makeChildInteractionUnavailableFailure(childId));
    }
    const child = this.children.get(childId);
    if (child === undefined || this.isTerminal(child)) {
      return errAsync(makeChildInteractionUnavailableFailure(childId));
    }
    return fn(child);
  }

  /**
   * Retains the newest queue depth a live child reported about itself.
   *
   * Only the parser-approved `queue_change` event may write it, and only when
   * that event actually carried a size: an event without one leaves the last
   * proven depth in place rather than resetting it to a guess.
   */
  private recordQueueDepth(childId: string, event: PiChildSessionEvent): void {
    if (event.type !== "queue_change") return;
    // The event schema carries a bounded catch-all, so the parsed `size` is
    // only trusted when it really is a non-negative integer.
    const size = event.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return;
    this.liveQueueDepths.set(childId, size);
  }

  private findLiveThreadState(childId: string): PiThreadState | undefined {
    const byThread = this.threads.get(childId);
    if (byThread !== undefined) return byThread;
    for (const state of this.threads.values()) {
      if (state.latestChildId === childId) return state;
    }
    return undefined;
  }

  private resolveLiveOverlayChild(
    childId: string,
  ): PiOverlayChildDescriptor | undefined {
    const state = this.findLiveThreadState(childId);
    if (state === undefined) {
      // A live process may exist before thread registration finishes; surface
      // it from the child tree with a thread id equal to the child id.
      const child = this.children.get(childId);
      if (child === undefined) return undefined;
      const snap = child.snapshot();
      const live = !this.isTerminal(child);
      const record = this.threadRecords.get(childId);
      return {
        childId,
        threadId: childId,
        activeChildId: childId,
        status: live ? "live" : "settled",
        title: snap.name,
        generationId: this.deps.generationId,
        parentChildId:
          snap.parentId === ROOT_NODE_ID ? undefined : snap.parentId,
        runs: recordToOverlayRuns(record),
        branchIds: [],
        descendantChildIds: [],
        sessionRef: record?.sessionRef,
        // The tree node's own `name` IS the agent name it was spawned with,
        // so this is authoritative even before thread registration lands.
        agentName: snap.name,
        ...this.roleFact(snap.name),
        ...this.liveOperationalFacts(childId, snap),
      };
    }
    const record = this.threadRecords.get(state.threadId);
    const treeChild =
      this.children.get(state.latestChildId) ?? this.children.get(childId);
    const title =
      record?.title ?? treeChild?.snapshot().name ?? state.agentName;
    let status: PiOverlayChildDescriptor["status"];
    if (state.running) {
      status = "live";
    } else if (state.status === "tombstoned") {
      status = "orphan";
    } else {
      status = "settled";
    }
    return {
      childId: state.latestChildId,
      threadId: state.threadId,
      activeChildId: state.latestChildId,
      status,
      title,
      generationId: this.deps.generationId,
      parentChildId:
        state.parentId === ROOT_NODE_ID ? undefined : state.parentId,
      runs: recordToOverlayRuns(record),
      branchIds: [],
      descendantChildIds: [],
      sessionRef: record?.sessionRef,
      agentName: state.agentName,
      parentAgentName: state.parentAgentName,
      ...this.roleFact(state.agentName),
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(state.reasoning === undefined ? {} : { reasoning: state.reasoning }),
      ...this.liveOperationalFacts(state.latestChildId, treeChild?.snapshot()),
    };
  }

  /**
   * The configured category name for one agent, as a spreadable fragment.
   *
   * An unconfigured agent, or a configured agent with no category, yields an
   * empty fragment: the inspector then prints no role at all rather than a
   * fabricated one.
   */
  private roleFact(agentName: string): { role?: string } {
    const role = Result.fromThrowable(
      () => this.deps.resolveAgentRole?.(agentName),
      () => undefined,
    )().match(
      (value) => value,
      () => undefined,
    );
    return role === undefined || role.length === 0 ? {} : { role };
  }

  /**
   * Live operational facts for one run, taken only from the child's own tree
   * node and its own reported queue depth.
   *
   * A node this generation no longer holds yields nothing: turn, elapsed and
   * usage are live measurements, and a stale copy would be a lie rather than
   * an absence.
   */
  private liveOperationalFacts(
    childId: string,
    snapshot: PiChildTreeNode | undefined,
  ): {
    turn?: number;
    elapsedMs?: number;
    usage?: PiOverlayChildUsage;
    queueDepth?: number;
  } {
    const queueDepth = this.liveQueueDepths.get(childId);
    return {
      ...(snapshot === undefined
        ? {}
        : {
            turn: snapshot.currentTurn,
            elapsedMs: snapshot.elapsedMs,
            usage: {
              inputTokens: snapshot.usage.inputTokens,
              outputTokens: snapshot.usage.outputTokens,
              cacheReadTokens: snapshot.usage.cacheReadTokens,
              cacheWriteTokens: snapshot.usage.cacheWriteTokens,
              cost: snapshot.usage.cost,
            },
          }),
      ...(queueDepth === undefined ? {} : { queueDepth }),
    };
  }

  private resolveHistoricalOverlayChild(
    childId: string,
  ): ResultAsync<PiOverlayChildDescriptor, PiAdapterFailure> {
    const cached = this.threadRecords.get(childId);
    if (cached !== undefined) return this.describeHistoricalRecord(cached);
    for (const record of this.threadRecords.values()) {
      if (record.childId === childId) {
        return this.describeHistoricalRecord(record);
      }
    }
    const refs = this.deps.threadRefs?.();
    if (refs === undefined) {
      return errAsync(makeThreadNotFoundFailure(childId, "unknown-thread"));
    }
    return refs
      .readRefs({ limit: 256 })
      .mapErr(() => makeThreadNotFoundFailure(childId, "refs-unavailable"))
      .andThen((scan) => {
        const match = scan.refs.find(
          (record) => record.childId === childId || record.threadId === childId,
        );
        if (match === undefined) {
          return errAsync(makeThreadNotFoundFailure(childId, "unknown-thread"));
        }
        this.rememberThreadRecord(match);
        return this.describeHistoricalRecord(match);
      });
  }

  /**
   * Completes a historical descriptor from the child's own `weave.child.thread`
   * metadata entry, so a settled child reports the same agent, parent agent,
   * model and reasoning a live one does.
   *
   * The metadata read is best effort *for description only*: an unreadable or
   * absent entry leaves those facts absent instead of failing the inspector,
   * because a describe is a read of history, not an authorization to resume.
   * Any metadata that disagrees with the ref it was reached through is
   * discarded rather than trusted.
   */
  private describeHistoricalRecord(
    record: PiChildRefRecord,
  ): ResultAsync<PiOverlayChildDescriptor, PiAdapterFailure> {
    const base = refRecordToOverlayDescriptor(record, this.deps.generationId);
    const sessions = this.deps.threadSessions?.();
    if (sessions === undefined) return okAsync(base);
    return ResultAsync.fromSafePromise(
      sessions
        .readThreadMetadata(record.sessionRef, record.originParentSessionId)
        .match(
          (metadata): PiOverlayChildDescriptor =>
            metadata.threadId !== record.threadId ||
            metadata.ownerParentSessionId !== record.originParentSessionId
              ? base
              : {
                  ...base,
                  agentName: metadata.agentName,
                  parentAgentName: metadata.parentAgentName,
                  ...this.roleFact(metadata.agentName),
                  ...(metadata.model === undefined
                    ? {}
                    : { model: metadata.model }),
                  ...(metadata.reasoning === undefined
                    ? {}
                    : { reasoning: metadata.reasoning }),
                },
          () => base,
        ),
    );
  }

  private persistPrivateOutput(
    childId: string,
    capture: PiChildPrivateOutputCapture,
  ): PiChildSessionObserverResult {
    const external = this.deps.onPrivateOutput?.(childId, capture);
    const sessions = this.deps.threadSessions?.();
    const thread = this.findLiveThreadState(childId);
    const record =
      this.threadRecords.get(thread?.threadId ?? childId) ??
      this.threadRecords.get(childId);
    const append = sessions?.appendResultOutput;
    if (record === undefined || append === undefined) {
      return external ?? ok(undefined);
    }
    const persisted = append
      .call(sessions, record.sessionRef, capture.output, {
        childId: record.childId,
        nativeSessionId: record.nativeSessionId,
        parentSession: record.originParentSessionId,
      })
      .mapErr(() => makeChildRecoveryUnavailableFailure(childId));
    if (external === undefined) return persisted;
    return persisted.andThen(() => external);
  }

  private enqueue(
    childId: string,
    request: PiDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const limits = resolveEffectiveDelegationLimits(
      this.deps.config,
      request.parentAgentName,
    );
    if (limits.isErr() || this.queue.length >= limits.value.maxProcesses) {
      return errAsync(
        makeChildCapacityExceededFailure(childId, "queue_capacity"),
      );
    }
    return new ResultAsync(
      new Promise((resolve) => {
        this.queue.push({ childId, request, resolve });
        this.notifyTreeChanged();
      }),
    );
  }

  private historyFailure(
    childId: string,
    failure: PiChildInspectionHistoryError,
  ): PiAdapterFailure {
    if (failure.reason === "quota")
      return makeChildRecordQuotaExceededFailure(childId);
    if (failure.reason === "corrupt")
      return makeChildRecordCorruptFailure(childId);
    if (failure.reason === "unavailable")
      return makeChildRecoveryUnavailableFailure(childId);
    return makeChildRecordQuarantinedFailure(childId);
  }

  private finalizeChild(
    childId: string,
    child: PiRpcChild,
    result: ResultAsync<PiChildSettlement, PiAdapterFailure>,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    return new ResultAsync(
      (async () => {
        const outcome = await result;
        const finalOutput =
          outcome.isOk() && outcome.value.outcome === "completed"
            ? outcome.value.assistantOutput
            : undefined;
        const persisted =
          this.deps.inspectionRegistry === undefined
            ? ok(undefined)
            : await this.deps.inspectionRegistry
                .retainTerminal(childId, child.snapshot(), finalOutput)
                .match(
                  () => ok(undefined),
                  (error) => err(error),
                );
        // Disposal and capacity promotion are cleanup, so they happen even when
        // terminal persistence fails. The persistence result is still returned.
        child.dispose();
        // A queue depth is a live fact only: a settled child reports no queue.
        this.liveQueueDepths.delete(childId);
        this.promoteQueued();
        this.notifyTreeChanged();
        this.maybeStopTreeRefreshTimer();
        if (persisted.isErr())
          return err(this.historyFailure(childId, persisted.error));
        return outcome;
      })(),
    );
  }

  // -------------------------------------------------------------------------
  // Thread lifecycle
  // -------------------------------------------------------------------------

  /**
   * Records the logical thread a newly dispatched run belongs to. A thread's
   * id is the id of its first run's child and never changes; each later run
   * mints a new child id under the same thread.
   */
  private registerThreadRun(
    threadId: string,
    childId: string,
    request: PiDelegationRequest,
  ): void {
    const existing = this.threads.get(threadId);
    if (existing !== undefined) {
      existing.latestChildId = childId;
      existing.status = "running";
      existing.running = true;
      return;
    }
    const runtime = bootstrapRuntimeMeta(request.bootstrap);
    const liveParent = this.deps.threadRefs?.()?.liveParentSessionId();
    this.threads.set(threadId, {
      threadId,
      agentName: request.agentName,
      parentId: request.parentId,
      parentDepth: request.parentDepth,
      parentAgentName: request.parentAgentName,
      ownerParentSessionId:
        liveParent !== undefined && liveParent.length > 0
          ? liveParent
          : this.deps.parentSessionId?.(),
      cwd: request.cwd,
      env: request.env,
      model: runtime.model,
      reasoning: runtime.thinkingLevel,
      latestChildId: childId,
      status: "running",
      runs: 1,
      lastRetryable: undefined,
      running: true,
    });
  }

  /**
   * Settles the thread a run belonged to. Capacity is released by the child's
   * own disposal; this only records the outcome the next run is judged
   * against, so a non-retryable failure can never be retried later.
   */
  private settleThread(
    threadId: string,
    outcome: Result<PiChildSettlement, PiAdapterFailure>,
  ): void {
    const state = this.threads.get(threadId);
    if (state === undefined) return;
    state.running = false;
    if (outcome.isErr()) {
      state.status = "failed";
      state.lastRetryable = outcome.error.retryable;
    } else if (outcome.value.outcome === "completed") {
      state.status = "completed";
      state.lastRetryable = false;
    } else if (outcome.value.outcome === "cancelled") {
      state.status = "cancelled";
      state.lastRetryable = true;
    } else {
      state.status = "failed";
      state.lastRetryable = true;
    }
    // The run's own terminal state is a tree change: it is the moment the
    // child stops being live, and every surface projected from the tree — the
    // delegation card AND a mounted child inspector — must be told once, here,
    // rather than waiting for the next refresh tick that may never come.
    this.notifyTreeChanged();
  }

  /**
   * Grants one authenticated live descendant explicit authority over one
   * thread. Without a grant, only the owning parent session may run a thread:
   * an ancestor is never implicitly entitled to another agent's thread.
   */
  grantThreadTransfer(
    threadId: string,
    ancestorChildId: string,
  ): Result<void, PiAdapterFailure> {
    const state = this.threads.get(threadId);
    if (state === undefined) {
      return err(makeThreadNotFoundFailure(threadId, "unknown-thread"));
    }
    const ancestor = this.children.get(ancestorChildId);
    if (ancestor === undefined || this.isTerminal(ancestor)) {
      return err(
        makeThreadAuthorityDeniedFailure(
          threadId,
          "ancestor-not-authenticated",
        ),
      );
    }
    this.threadTransfers.set(threadId, ancestorChildId);
    return ok(undefined);
  }

  /** Bounded snapshot of one thread's public lifecycle state. */
  threadStatus(threadId: string):
    | {
        readonly threadId: string;
        readonly runs: number;
        readonly status: PiChildRefStatus;
        readonly retryable: boolean;
      }
    | undefined {
    const state = this.threads.get(threadId);
    if (state === undefined) return undefined;
    return {
      threadId: state.threadId,
      runs: state.runs,
      status: state.status,
      retryable: state.lastRetryable === true,
    };
  }

  /**
   * Runs one more run of an existing thread: `retry` after a retryable failed
   * or cancelled run, `continue` after a completed one.
   *
   * Every run re-derives its own authority, source integrity, policy, and
   * capacity. Nothing about a prior run is trusted except its recorded
   * outcome, and no previous run record is ever mutated.
   */
  resumeThread(
    request: PiThreadRunRequest,
  ): ResultAsync<PiThreadRunOutcome, PiAdapterFailure> {
    const storageAuthority = this.requireSessionStorageAuthority("thread-run");
    if (storageAuthority.isErr()) return errAsync(storageAuthority.error);
    const threadId = request.threadId;
    if (this.disposedAll) {
      return errAsync(
        makeThreadResumeUnavailableFailure(threadId, "lifecycle-unavailable"),
      );
    }
    const instruction = this.resolveThreadInstruction(request);
    if (instruction.isErr()) return errAsync(instruction.error);
    return this.resolveThreadState(threadId).andThen((state) => {
      if (state.running) {
        return errAsync(makeThreadAlreadyRunningFailure(threadId));
      }
      const authority = this.authorizeThreadInitiator(state, request.initiator);
      if (authority.isErr()) return errAsync(authority.error);
      const readiness = this.checkThreadReadiness(state, request.action);
      if (readiness.isErr()) return errAsync(readiness.error);
      const target = this.resolveThreadTarget(state);
      if (target.isErr()) return errAsync(target.error);
      const buildBootstrap = this.deps.buildBootstrap;
      if (buildBootstrap === undefined) {
        return errAsync(
          makeThreadResumeUnavailableFailure(threadId, "lifecycle-unavailable"),
        );
      }

      return this.resolveThreadSource(state).andThen((source) => {
        // Capacity is revalidated here, after every authority and integrity
        // check and immediately before dispatch, so a run only ever holds a
        // slot it was authorized for at the moment it starts.
        const decision = this.authorize({
          parentId: state.parentId,
          parentDepth: state.parentDepth,
          parentAgentName: state.parentAgentName,
          agentName: state.agentName,
          task: instruction.value,
          cwd: state.cwd,
          env: state.env,
          bootstrap: null,
        });
        if (decision.isErr() || decision.value.outcome !== "authorized") {
          return errAsync<PiThreadRunOutcome, PiAdapterFailure>(
            makeChildCapacityExceededFailure(threadId, "max_children"),
          );
        }
        const runNumber = state.runs + 1;
        // A new run is a new tool block and a new child id. The previous run's
        // record keeps its own id and is never reopened or rewritten.
        const runChildId = this.deps.idGenerator.next();
        // The grant is minted for this run's child id, from the store that
        // owns the session, before the divider is written or any process
        // starts. A thread with no proven source stays path-free too.
        const sessions = this.deps.threadSessions?.();
        const launchSource = source.launch;
        // Minting reopens and revalidates the proven session, so it is part
        // of the async chain rather than a synchronous precondition.
        const mintedSession = ((): ResultAsync<
          PiRpcChildSpawnSession | undefined,
          PiAdapterFailure
        > => {
          if (launchSource === undefined) return okAsync(undefined);
          if (sessions === undefined) {
            return errAsync(
              makeThreadResumeUnavailableFailure(
                threadId,
                "session-unavailable",
              ),
            );
          }
          return this.mintLaunchSession(sessions, launchSource, runChildId)
            .map((session): PiRpcChildSpawnSession | undefined => session)
            .mapErr(() =>
              makeThreadResumeUnavailableFailure(
                threadId,
                "session-unavailable",
              ),
            );
        })();
        return mintedSession.andThen((runSession) => {
          const priorOutcome = state.status;
          return this.appendThreadDivider(
            source.ref,
            request,
            priorOutcome,
            state,
          ).andThen((divider) => {
            state.runs = runNumber;
            state.running = true;
            state.status = "running";
            state.latestChildId = runChildId;
            const runRequest: PiDelegationRequest = {
              parentId: state.parentId,
              parentDepth: state.parentDepth,
              parentAgentName: state.parentAgentName,
              agentName: state.agentName,
              task: instruction.value,
              cwd: state.cwd,
              env: state.env,
              bootstrap: buildBootstrap(target.value, runChildId, {
                parentAgentName: state.parentAgentName,
                parentDepth: state.parentDepth,
                cwd: state.cwd,
              }),
              ...(runSession === undefined ? {} : { session: runSession }),
              ...(request.onSessionEvent === undefined
                ? {}
                : { onSessionEvent: request.onSessionEvent }),
            };
            return new ResultAsync<PiThreadRunOutcome, PiAdapterFailure>(
              (async () => {
                this.invokeRunAssignedCallback(request.onRunAssigned, {
                  threadId,
                  runNumber,
                  action: request.action,
                  agentName: state.agentName,
                  childId: runChildId,
                });
                const settled = await this.spawnNow(runChildId, runRequest);
                this.settleThread(threadId, settled);
                this.recordThreadSettlement(
                  divider,
                  this.threads.get(threadId),
                );
                if (settled.isErr()) return err(settled.error);
                return ok({
                  threadId,
                  run: runNumber,
                  settlement: settled.value,
                });
              })(),
            );
          });
        });
      });
    });
  }

  /**
   * Returns the in-memory thread when this generation already tracked it;
   * otherwise rebuilds it from the authoritative parent ref plus the native
   * session's thread metadata. Missing agent/owner/runtime fields are refused
   * rather than invented.
   */
  private resolveThreadState(
    threadId: string,
  ): ResultAsync<PiThreadState, PiAdapterFailure> {
    const existing = this.threads.get(threadId);
    if (existing !== undefined) return okAsync(existing);
    return this.reconstructThreadState(threadId);
  }

  /**
   * Rebuilds one thread for a fresh controller generation from the parent ref
   * and the native session's own metadata entry. The ref supplies observation
   * status and run count; the session supplies the agent, owner, cwd, and
   * model/reasoning intent that every later run must preserve.
   */
  private reconstructThreadState(
    threadId: string,
  ): ResultAsync<PiThreadState, PiAdapterFailure> {
    const refs = this.deps.threadRefs?.();
    const sessions = this.deps.threadSessions?.();
    if (refs === undefined || sessions === undefined) {
      return errAsync(makeThreadNotFoundFailure(threadId, "unknown-thread"));
    }
    return refs
      .readRefs()
      .mapErr(() => makeThreadNotFoundFailure(threadId, "refs-unavailable"))
      .andThen((scan) => {
        const record = scan.refs.find(
          (candidate) => candidate.threadId === threadId,
        );
        if (record === undefined) {
          return errAsync<PiThreadState, PiAdapterFailure>(
            this.threadScanFailure(threadId, scan),
          );
        }
        if (record.originParentSessionId !== refs.liveParentSessionId()) {
          return errAsync<PiThreadState, PiAdapterFailure>(
            makeThreadNotFoundFailure(threadId, "origin-mismatch"),
          );
        }
        if (record.status === "tombstoned") {
          return errAsync<PiThreadState, PiAdapterFailure>(
            makeThreadStaleFailure(threadId, "tombstoned"),
          );
        }
        return sessions
          .readThreadMetadata(record.sessionRef, record.originParentSessionId)
          .mapErr((error) => this.nativeSessionFailure(threadId, error))
          .andThen((metadata) => {
            const validated = this.validateReconstructedThread(
              threadId,
              record,
              metadata,
            );
            if (validated.isErr()) return errAsync(validated.error);
            this.threads.set(threadId, validated.value);
            return okAsync(validated.value);
          });
      });
  }

  /**
   * Proves the authoritative sources agree before a reconstructed thread is
   * admitted. Any missing or mismatched agent/owner/runtime field fails closed.
   */
  private validateReconstructedThread(
    threadId: string,
    record: PiChildRefRecord,
    metadata: PiNativeThreadMetadata,
  ): Result<PiThreadState, PiAdapterFailure> {
    if (
      metadata.threadId !== threadId ||
      metadata.threadId !== record.threadId ||
      metadata.ownerParentSessionId !== record.originParentSessionId ||
      metadata.agentName.length === 0 ||
      metadata.parentId.length === 0 ||
      metadata.parentAgentName.length === 0 ||
      metadata.cwd.length === 0
    ) {
      return err(makeThreadIntegrityFailure(threadId, "session-corrupt"));
    }
    // Cumulative, not the retained window: a reconstructed thread must resume
    // its real run ordinal even after the window dropped its oldest entries.
    const runs = childRefTotalRuns(record);
    if (runs < 1) {
      // A thread with no recorded run has no proven prior outcome to resume.
      return err(makeThreadIntegrityFailure(threadId, "session-corrupt"));
    }
    return ok({
      threadId,
      agentName: metadata.agentName,
      parentId: metadata.parentId,
      parentDepth: metadata.parentDepth,
      parentAgentName: metadata.parentAgentName,
      ownerParentSessionId: metadata.ownerParentSessionId,
      cwd: metadata.cwd,
      env: {},
      model: metadata.model,
      reasoning: metadata.reasoning,
      latestChildId: record.childId,
      status: record.status,
      runs,
      lastRetryable: retryableFromRefStatus(record.status),
      running: record.status === "running" || record.status === "queued",
    });
  }

  /** Applies the action's own text contract before anything else is touched. */
  private resolveThreadInstruction(
    request: PiThreadRunRequest,
  ): Result<string, PiAdapterFailure> {
    const supplied = request.instruction;
    if (supplied !== undefined && supplied.trim().length === 0) {
      return err(
        makeThreadResumeUnavailableFailure(
          request.threadId,
          "lifecycle-unavailable",
        ),
      );
    }
    if (request.action === "continue") {
      // A continue without a task is a validation error, never a default.
      if (supplied === undefined) {
        return err(
          makeThreadNotResumableFailure(
            request.threadId,
            "status-not-completed",
          ),
        );
      }
      return ok(supplied);
    }
    return ok(supplied ?? DEFAULT_THREAD_RETRY_INSTRUCTION);
  }

  /** Owner or explicitly transferred authenticated ancestor. Nothing else. */
  private authorizeThreadInitiator(
    state: PiThreadState,
    initiator: PiThreadInitiator,
  ): Result<void, PiAdapterFailure> {
    if (initiator.kind === "owner") {
      const live =
        this.deps.threadRefs?.()?.liveParentSessionId() ??
        this.deps.parentSessionId?.();
      if (
        state.ownerParentSessionId === undefined ||
        initiator.parentSessionId !== state.ownerParentSessionId ||
        (live !== undefined && live !== state.ownerParentSessionId)
      ) {
        return err(
          makeThreadAuthorityDeniedFailure(state.threadId, "not-owner"),
        );
      }
      return ok(undefined);
    }
    const ancestor = this.children.get(initiator.ancestorChildId);
    if (ancestor === undefined || this.isTerminal(ancestor)) {
      return err(
        makeThreadAuthorityDeniedFailure(
          state.threadId,
          "ancestor-not-authenticated",
        ),
      );
    }
    if (
      this.threadTransfers.get(state.threadId) !== initiator.ancestorChildId
    ) {
      return err(
        makeThreadAuthorityDeniedFailure(state.threadId, "transfer-missing"),
      );
    }
    return ok(undefined);
  }

  /** State machine: retry needs a retryable failure or a cancellation. */
  private checkThreadReadiness(
    state: PiThreadState,
    action: PiThreadAction,
  ): Result<void, PiAdapterFailure> {
    if (state.status === "running" || state.status === "queued") {
      return err(makeThreadAlreadyRunningFailure(state.threadId));
    }
    if (state.status === "tombstoned") {
      return err(makeThreadStaleFailure(state.threadId, "tombstoned"));
    }
    if (action === "continue") {
      if (state.status !== "completed") {
        return err(
          makeThreadNotResumableFailure(state.threadId, "status-not-completed"),
        );
      }
      return ok(undefined);
    }
    if (state.status === "cancelled") return ok(undefined);
    if (state.status !== "failed") {
      return err(
        makeThreadNotRetryableFailure(
          state.threadId,
          "status-not-failed-or-cancelled",
        ),
      );
    }
    // A failure whose retryability was never recorded fails closed: the
    // adapter never assumes an unproven failure is safe to repeat.
    if (state.lastRetryable === undefined) {
      return err(
        makeThreadNotRetryableFailure(state.threadId, "retryability-unknown"),
      );
    }
    if (!state.lastRetryable) {
      return err(
        makeThreadNotRetryableFailure(state.threadId, "outcome-not-retryable"),
      );
    }
    return ok(undefined);
  }

  /** Re-reads the current config's own eligibility for this thread's agent. */
  private resolveThreadTarget(
    state: PiThreadState,
  ): Result<DelegationTarget, PiAdapterFailure> {
    const target =
      state.parentId === ROOT_NODE_ID
        ? this.deps.resolveRootDelegationTarget?.(state.agentName)
        : this.deps.resolveDelegationTarget?.(
            state.parentAgentName,
            state.agentName,
          );
    if (target === undefined) {
      return err(
        makeThreadResumeUnavailableFailure(state.threadId, "policy-revoked"),
      );
    }
    return ok(target);
  }

  /**
   * Resolves the thread's Task 5 ref and verifies the Task 4 native session it
   * points at, then reopens that session at its active leaf. Missing, corrupt,
   * origin-mismatched, and conflicting sources are all refused here, before
   * any divider is written or any process is started.
   */
  private resolveThreadSource(state: PiThreadState): ResultAsync<
    {
      readonly ref: PiChildRefRecord | undefined;
      readonly launch: PiThreadLaunchSource | undefined;
    },
    PiAdapterFailure
  > {
    const refs = this.deps.threadRefs?.();
    if (refs === undefined) {
      // No ref store wired for this generation: the thread's authoritative
      // source cannot be proven, so it is not resumable. It is never resumed
      // on the adapter's own in-memory word alone.
      return errAsync(
        makeThreadResumeUnavailableFailure(
          state.threadId,
          "lifecycle-unavailable",
        ),
      );
    }
    return refs
      .readRefs()
      .mapErr(() =>
        makeThreadNotFoundFailure(state.threadId, "refs-unavailable"),
      )
      .andThen((scan) => {
        const record = scan.refs.find(
          (candidate) => candidate.threadId === state.threadId,
        );
        if (record === undefined) {
          return errAsync<
            {
              readonly ref: PiChildRefRecord | undefined;
              readonly launch: PiThreadLaunchSource | undefined;
            },
            PiAdapterFailure
          >(this.threadScanFailure(state.threadId, scan));
        }
        if (record.originParentSessionId !== refs.liveParentSessionId()) {
          return errAsync<
            {
              readonly ref: PiChildRefRecord | undefined;
              readonly launch: PiThreadLaunchSource | undefined;
            },
            PiAdapterFailure
          >(makeThreadNotFoundFailure(state.threadId, "origin-mismatch"));
        }
        if (record.status === "tombstoned") {
          return errAsync<
            {
              readonly ref: PiChildRefRecord | undefined;
              readonly launch: PiThreadLaunchSource | undefined;
            },
            PiAdapterFailure
          >(makeThreadStaleFailure(state.threadId, "tombstoned"));
        }
        return this.openThreadSession(state, record).map((launch) => ({
          ref: record,
          launch,
        }));
      });
  }

  /**
   * Explains why a thread has no usable ref. The scan already excludes
   * origin-mismatched and source-unusable children, so the reason lives in its
   * issues; an unexplained absence is simply an unknown thread.
   */
  private threadScanFailure(
    threadId: string,
    scan: PiChildRefScan,
  ): PiAdapterFailure {
    for (const issue of scan.issues) {
      if (!("childId" in issue) || issue.childId !== threadId) continue;
      if (issue.kind === "origin-mismatch") {
        return makeThreadNotFoundFailure(threadId, "origin-mismatch");
      }
      if (
        issue.kind === "conflicting-entry" ||
        issue.kind === "duplicate-entry"
      ) {
        return makeThreadIntegrityFailure(threadId, "ref-conflict");
      }
      if (issue.kind === "source-unusable") {
        if (issue.state === "missing") {
          return makeThreadStaleFailure(threadId, "session-missing");
        }
        if (issue.state === "tombstoned") {
          return makeThreadStaleFailure(threadId, "tombstoned");
        }
        if (issue.state === "corrupt") {
          return makeThreadIntegrityFailure(threadId, "session-corrupt");
        }
        return makeThreadResumeUnavailableFailure(
          threadId,
          "session-unavailable",
        );
      }
    }
    return makeThreadNotFoundFailure(threadId, "unknown-thread");
  }

  private openThreadSession(
    state: PiThreadState,
    record: PiChildRefRecord,
  ): ResultAsync<PiThreadLaunchSource, PiAdapterFailure> {
    const sessions = this.deps.threadSessions?.();
    if (sessions === undefined) {
      return errAsync(
        makeThreadResumeUnavailableFailure(
          state.threadId,
          "session-unavailable",
        ),
      );
    }
    const parentSession = record.originParentSessionId;
    return sessions
      .readSessionEntries(record.sessionRef, parentSession)
      .mapErr((error) => this.nativeSessionFailure(state.threadId, error))
      .andThen((opened) => {
        const activeLeaf = readActiveLeafId(opened.entries);
        if (activeLeaf === undefined) {
          return err<PiThreadLaunchSource, PiAdapterFailure>(
            makeThreadIntegrityFailure(state.threadId, "session-corrupt"),
          );
        }
        // The record stays inside the controller. Only the store may turn it
        // into a launch grant, and only for the child that will start.
        return ok<PiThreadLaunchSource, PiAdapterFailure>({
          record: opened.record,
          activeLeafId: activeLeaf,
        });
      });
  }

  /**
   * Mints this run's launch grant from the store that owns the session.
   * Every resumed or restored run passes through here, so no launch path
   * ever receives a caller-constructed session path.
   */
  private mintLaunchSession(
    sessions: PiThreadSessionPort,
    launch: PiThreadLaunchSource,
    childId: string,
  ): ResultAsync<PiRpcChildSpawnSession, PiAdapterFailure> {
    return sessions
      .mintLaunchGrant({
        childId,
        record: launch.record,
        activeLeafId: launch.activeLeafId,
      })
      .map((grant): PiRpcChildSpawnSession => ({ mode: "native", grant }))
      .mapErr(() =>
        makeThreadResumeUnavailableFailure(childId, "session-unavailable"),
      );
  }

  private nativeSessionFailure(
    threadId: string,
    error: PiNativeSessionError,
  ): PiAdapterFailure {
    if (error.type === "SessionMissing") {
      return makeThreadStaleFailure(threadId, "session-missing");
    }
    if (error.type === "SessionCorrupt") {
      return makeThreadIntegrityFailure(threadId, "session-corrupt");
    }
    return makeThreadResumeUnavailableFailure(threadId, "session-unavailable");
  }

  /**
   * Appends the metadata-only run divider that opens the new run. The divider
   * carries the run number, action, time, prior outcome, model, reasoning, and
   * initiator - never the instruction, the response, or a path.
   */
  private appendThreadDivider(
    record: PiChildRefRecord | undefined,
    request: PiThreadRunRequest,
    priorOutcome: PiChildRefStatus,
    state: PiThreadState,
  ): ResultAsync<PiChildRefRecord | undefined, PiAdapterFailure> {
    const refs = this.deps.threadRefs?.();
    if (refs === undefined || record === undefined) {
      return errAsync(
        makeThreadResumeUnavailableFailure(
          state.threadId,
          "lifecycle-unavailable",
        ),
      );
    }
    const runtime = this.threadRuntimeMeta(state);
    return refs
      .appendRunDivider(record, {
        action: request.action,
        priorOutcome,
        initiator:
          request.initiator.kind === "owner" ? "owner" : "transferred-ancestor",
        status: "running",
        ...(runtime.model === undefined ? {} : { model: runtime.model }),
        ...(runtime.reasoning === undefined
          ? {}
          : { reasoning: runtime.reasoning }),
      })
      .mapErr(() =>
        makeThreadResumeUnavailableFailure(
          state.threadId,
          "divider-write-failed",
        ),
      )
      .map((next) => {
        this.rememberThreadRecord(next);
        return next;
      });
  }

  /** Names the model and reasoning the resumed run will use, when known. */
  private threadRuntimeMeta(state: PiThreadState): {
    readonly model?: string;
    readonly reasoning?: string;
  } {
    return {
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(state.reasoning === undefined ? {} : { reasoning: state.reasoning }),
    };
  }

  /** Records the settled run in the refs and the cache. Never blocks a result. */
  private recordThreadSettlement(
    record: PiChildRefRecord | undefined,
    state: PiThreadState | undefined,
  ): void {
    const refs = this.deps.threadRefs?.();
    if (refs === undefined || record === undefined || state === undefined)
      return;
    this.rememberThreadRecord(record);
    // Shared with the session-transition write-back: whichever path gets there
    // first owns the single append, and the other joins the same promise.
    void this.settlementWrite(state.threadId, record, refs, state.status);
  }

  /**
   * The single exactly-once settlement append for one `thread + status`.
   *
   * Returns the shared in-flight promise when one exists, so the ordinary
   * asynchronous settlement path and the session-transition path never append
   * the same outcome twice and either one can await the other. Resolves `true`
   * only for the caller whose call actually performed the append, so a
   * transition can report a truthful write count.
   */
  private settlementWrite(
    threadId: string,
    record: PiChildRefRecord,
    refs: PiThreadRefPort,
    status: PiChildRefStatus,
  ): ResultAsync<boolean, PiAdapterFailure> {
    const key = `${threadId}\u0000${status}`;
    if (this.threadSettlementWritten.has(key)) return okAsync(false);
    const joined = this.threadSettlementWrites.get(key);
    // A second caller never issues its own append: it observes the first
    // caller's outcome, including its failure.
    if (joined !== undefined)
      return new ResultAsync(joined.then((result) => result.map(() => false)));
    const pending = (async (): Promise<Result<void, PiAdapterFailure>> => {
      const result = await refs
        .appendLifecycle(record, { status })
        .map((next) => {
          this.threadSettlementWritten.add(key);
          this.rememberThreadRecord(next);
          return undefined;
        })
        .mapErr(() =>
          // Closed reason string: never the ref store's own error text.
          makeChildAbortFailedFailure(threadId, "settlement-writeback-failed"),
        );
      this.threadSettlementWrites.delete(key);
      return result;
    })();
    this.threadSettlementWrites.set(key, pending);
    return new ResultAsync(pending.then((result) => result.map(() => true)));
  }

  /**
   * Awaits every settlement append currently in flight. A transition runs this
   * before it classifies threads, so an ordinary settlement write that is
   * still landing is never duplicated and its failure is never swallowed.
   */
  private async drainSettlementWrites(): Promise<
    Result<void, PiAdapterFailure>
  > {
    while (this.threadSettlementWrites.size > 0) {
      const inflight = [...this.threadSettlementWrites.values()];
      const results = await Promise.all(inflight);
      const failure = results.find((result) => result.isErr());
      if (failure !== undefined && failure.isErr()) return err(failure.error);
    }
    return ok(undefined);
  }

  /**
   * Keeps the newest ref record for a thread and projects it into the cache.
   * Every ref-producing path routes through here so a later transition
   * write-back always has the current record to append against.
   */
  private rememberThreadRecord(record: PiChildRefRecord): void {
    this.threadRecords.set(record.threadId, record);
    this.updateThreadCache(record);
  }

  /**
   * Projects one ref into the metadata cache. The cache is derivative: any
   * failure is dropped, and no caller ever waits on it.
   */
  private updateThreadCache(record: PiChildRefRecord): void {
    const cache = this.deps.threadCache?.();
    if (cache === undefined) return;
    const workspaceKey = this.deps.threadWorkspaceKey?.();
    if (workspaceKey === undefined || workspaceKey.length === 0) return;
    Result.fromThrowable(
      () => cache.upsertRef(record, workspaceKey),
      () => undefined,
    )().match(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Delivers one parser-approved session event to an optional caller sink.
   * Failures are logged with a stable code and never propagate to the child.
   */
  private invokeSessionEventCallback(
    childId: string,
    callback: ((event: PiChildSessionEvent) => void) | undefined,
    event: PiChildSessionEvent,
  ): void {
    if (callback === undefined) return;
    Result.fromThrowable(
      () => {
        callback(event);
      },
      () => "onSessionEvent_failed" as const,
    )().match(
      () => undefined,
      (code) => {
        this.deps.logger.warn(
          { childId, code },
          "delegation onSessionEvent callback failed",
        );
      },
    );
  }

  /**
   * Delivers one parser-approved session event to the controller-deps sink
   * after inspection checkpointing. Failures are logged and never propagate.
   */
  private invokeChildSessionEventDep(
    childId: string,
    event: PiChildSessionEvent,
  ): void {
    const callback = this.deps.onChildSessionEvent;
    if (callback === undefined) return;
    Result.fromThrowable(
      () => {
        callback(childId, event);
      },
      () => "onChildSessionEvent_failed" as const,
    )().match(
      () => undefined,
      (code) => {
        this.deps.logger.warn(
          { childId, code },
          "delegation onChildSessionEvent callback failed",
        );
      },
    );
  }

  /**
   * Reports the assigned retry/continue run identity before spawn. Failures
   * are logged with a stable code and never propagate to the child.
   */
  private invokeRunAssignedCallback(
    callback: ((assignment: PiThreadRunAssignment) => void) | undefined,
    assignment: PiThreadRunAssignment,
  ): void {
    if (callback === undefined) return;
    Result.fromThrowable(
      () => {
        callback(assignment);
      },
      () => "onRunAssigned_failed" as const,
    )().match(
      () => undefined,
      (code) => {
        this.deps.logger.warn(
          { childId: assignment.childId, code },
          "delegation onRunAssigned callback failed",
        );
      },
    );
  }

  private spawnNow(
    childId: string,
    request: PiDelegationRequest,
    onRegistered?: () => void,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const depth = request.parentDepth + 1;
    const child = new PiRpcChild(
      childId,
      request.parentId,
      this.deps.generationId,
      request.agentName,
      depth,
      {
        processPort: this.deps.processPort,
        sessionStorageAuthority: this.sessionStorageAuthority,
        randomPort: this.deps.randomPort,
        hmacPort: this.deps.hmacPort,
        timerPort: this.deps.timerPort,
        handshakeTimeoutMs: this.deps.handshakeTimeoutMs,
        replyTimeoutMs: this.deps.replyTimeoutMs,
        settlementTimeoutMs: this.deps.settlementTimeoutMs,
        runtimeBudgetMs: this.deps.runtimeBudgetMs,
        cancelGraceMs: this.deps.cancelGraceMs,
        responseDrainMs: this.deps.responseDrainMs,
        baseEnv: this.deps.baseEnv,
        logger: this.deps.logger,
        command: this.deps.command,
        now: this.deps.now,
        onDelegationRequest: (
          relayChildId,
          correlationId,
          body: PiDelegateRequestBody,
        ) =>
          this.handleChildDelegationRequest(relayChildId, correlationId, body),
        onAssistantUsageObserved: (usage) => {
          this.deps.telemetry
            ?.recordAssistantUsage({
              id: usage.id,
              source: "child",
              agentName: request.agentName,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              cost: usage.cost,
            })
            .orElse(() => okAsync("noop" as const));
        },
        sessionObserver: {
          onEvent: (event) => {
            this.deps.inspectionRegistry?.checkpointEvent(childId, event).match(
              () => undefined,
              () => undefined,
            );
            this.recordQueueDepth(childId, event);
            this.invokeChildSessionEventDep(childId, event);
            this.invokeSessionEventCallback(
              childId,
              request.onSessionEvent,
              event,
            );
            return ok(undefined);
          },
        },
        onStreamingUpdate: (snapshot) => {
          request.onUpdate?.(snapshot);
          this.deps.inspectionRegistry?.checkpoint(childId).match(
            () => undefined,
            () => undefined,
          );
          this.notifyTreeChanged();
        },
        onPrivateOutput: (capture) =>
          this.persistPrivateOutput(childId, capture),
      },
    );
    const registration =
      this.deps.inspectionRegistry?.register({
        id: childId,
        parentId: request.parentId,
        name: request.agentName,
        kind: request.parentId === ROOT_NODE_ID ? "ordinary" : "nested",
        snapshot: () => child.snapshot(),
        ...bootstrapRuntimeMeta(request.bootstrap),
      }) ?? okAsync<void, never>(undefined);
    return registration
      .mapErr((failure): PiAdapterFailure => {
        if (failure.reason === "quota")
          return makeChildRecordQuotaExceededFailure(childId);
        if (failure.reason === "corrupt")
          return makeChildRecordCorruptFailure(childId);
        if (failure.reason === "unavailable")
          return makeChildRecoveryUnavailableFailure(childId);
        return makeChildRecordQuarantinedFailure(childId);
      })
      .andThen(() => {
        this.children.set(childId, child);
        onRegistered?.();
        this.notifyTreeChanged();
        this.ensureTreeRefreshTimer();
        const spawnInput = {
          childId,
          parentId: request.parentId,
          generationId: this.deps.generationId,
          agentName: request.agentName,
          depth,
          cwd: request.cwd,
          env: request.env,
          task: request.task,
          ...(request.session === undefined
            ? {}
            : { session: request.session }),
        };
        return this.finalizeChild(
          childId,
          child,
          child
            .spawnAndHandshake(spawnInput)
            .andThen(() => child.runTask(spawnInput, request.bootstrap)),
        );
      });
  }

  /**
   * Handles a live child's own relayed delegation request (Pi adapter contract
   *): nested/descendant delegation is never an independent,
   * untracked budget - it is authorized and spawned through this exact
   * same `delegate` method, under the requesting child's own
   * identity/depth, against the same global tree/process budget as every
   * other delegation. Every outcome - invalid body, ineligible target,
   * capacity denial, or settlement - always sends exactly one correlated
   * `delegate-response` back to the requesting child; it never spawns
   * silently without a reply.
   */
  private handleChildDelegationRequest(
    childId: string,
    correlationId: string,
    body: PiDelegateRequestBody,
  ): void {
    const requester = this.children.get(childId);
    if (requester === undefined) return;
    const target = this.deps.resolveDelegationTarget?.(
      requester.getAgentName(),
      body.agentName,
    );
    if (target === undefined || this.deps.buildBootstrap === undefined) {
      void requester.sendDelegationResponse(correlationId, {
        ok: false,
        error: "invalid-delegation-target",
      });
      return;
    }
    // Generated up front (Pi adapter contract) so it can be embedded as the
    // bootstrap's own `correlationId`, and reused verbatim as this request's
    // `childId` - the child that eventually spawns cross-checks the two
    // against each other and rejects a mismatch.
    const nestedChildId = this.deps.idGenerator.next();
    const bootstrap = this.deps.buildBootstrap(target, nestedChildId, {
      parentAgentName: requester.getAgentName(),
      parentDepth: requester.getDepth(),
      cwd: requester.getCwd(),
    });
    void this.delegate({
      parentId: childId,
      parentDepth: requester.getDepth(),
      parentAgentName: requester.getAgentName(),
      agentName: body.agentName,
      task: body.task,
      cwd: requester.getCwd(),
      env: {},
      bootstrap,
      childId: nestedChildId,
    }).match(
      (settlement) => {
        void requester.sendDelegationResponse(correlationId, {
          ok: true,
          settlement,
        });
      },
      (failure) => {
        void requester.sendDelegationResponse(correlationId, {
          ok: false,
          error: failure.code,
        });
      },
    );
  }

  /**
   * The timer the delegation card's update coalescer schedules its repaints on.
   *
   * The controller already owns the adapter's one injected {@link TimerPort},
   * so exposing it here keeps the card on the same discipline as every other
   * bounded wait: a test drives repaints deterministically, and no card path
   * ever reaches for `setTimeout` on its own.
   */
  get cardTimerPort(): TimerPort {
    const injected = this.deps.timerPort;
    if (injected !== undefined) return injected;
    this.fallbackTimerPort ??= new SystemTimerPort();
    return this.fallbackTimerPort;
  }

  private notifyTreeChanged(): void {
    this.deps.onTreeChanged?.();
  }

  private ensureTreeRefreshTimer(): void {
    if (this.treeRefreshTimer !== undefined) return;
    if (this.deps.onTreeChanged === undefined) return;
    const timerPort = this.deps.timerPort;
    if (timerPort === undefined) return;
    const intervalMs =
      this.deps.treeRefreshIntervalMs ?? DEFAULT_TREE_REFRESH_INTERVAL_MS;
    const tick = (): void => {
      if (this.disposedAll) return;
      this.notifyTreeChanged();
      if (this.snapshotTree().length === 0) {
        this.treeRefreshTimer = undefined;
        return;
      }
      this.treeRefreshTimer = timerPort.schedule(tick, intervalMs);
    };
    this.treeRefreshTimer = timerPort.schedule(tick, intervalMs);
  }

  private maybeStopTreeRefreshTimer(): void {
    if (this.snapshotTree().length > 0) return;
    this.treeRefreshTimer?.cancel();
    this.treeRefreshTimer = undefined;
  }

  /** Scans the queue front-to-back and promotes the first entry whose authorization now succeeds. Repeats until no progress. */
  private promoteQueued(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
        if (entry === undefined) continue;
        const decision = this.authorize(entry.request);
        if (decision.isErr() || decision.value.outcome !== "authorized")
          continue;
        this.queue.splice(i, 1);
        this.reserveDispatch(entry.request.parentId);
        let reserved = true;
        const release = (): void => {
          if (!reserved) return;
          this.releaseDispatch(entry.request.parentId);
          reserved = false;
        };
        void this.spawnNow(entry.childId, entry.request, release).match(
          (settlement) => {
            release();
            entry.resolve(ok(settlement));
          },
          (failure) => {
            release();
            entry.resolve(err(failure));
          },
        );
        progressed = true;
        break;
      }
    }
  }

  /**
   * Bounded count of owned descendants that still occupy capacity: every live
   * child that has not reached a terminal state, plus every not-yet-spawned
   * queued request. Session-transition guards read this to decide whether a
   * transition needs confirmation at all - a zero count must allow the
   * transition immediately, with no prompt and no data copied anywhere.
   */
  countUnsettledDescendants(): number {
    if (this.disposedAll) return 0;
    let count = 0;
    for (const child of this.children.values())
      if (!this.isTerminal(child)) count += 1;
    return count + this.queue.length;
  }

  /**
   * Confirmed session-transition path (Pi adapter contract): cancels the full
   * owned subtree - live descendants and not-yet-spawned queued requests
   * alike - waits for every child process and its bounded final-event drain
   * to settle, then appends the settlement metadata to the *origin* parent's
   * refs before resolving.
   *
   * The order is deliberate and observable: cancel, then drain, then origin
   * write-back, then (for the caller) allow the transition. The origin ref
   * port is captured before any cancellation runs, so a destination session
   * activated afterwards can never receive another parent's write-back.
   *
   * Any cancellation or write-back failure resolves to a bounded, secret-free
   * `PiAdapterFailure` the caller turns into a veto.
   */
  settleForTransition(): ResultAsync<
    PiTransitionSettlementReport,
    PiAdapterFailure
  > {
    if (this.disposedAll)
      return okAsync({ cancelled: 0, settlementsWritten: 0 });
    const originRefs = this.deps.threadRefs?.();
    const roots = this.transitionCancellationRoots();
    if (roots.length === 0)
      return okAsync({ cancelled: 0, settlementsWritten: 0 });
    return new ResultAsync(
      (async (): Promise<
        Result<PiTransitionSettlementReport, PiAdapterFailure>
      > => {
        // A generation that captured origin records must still be able to
        // reach them. Losing the port mid-transition means the settlement can
        // never be written back, so the transition is refused rather than
        // reported as a success with nothing written.
        if (originRefs === undefined && this.threadRecords.size > 0)
          return err(
            makeChildAbortFailedFailure(
              roots[0] ?? "",
              "settlement-refs-unavailable",
            ),
          );
        const drained = await this.drainSettlementWrites();
        if (drained.isErr()) return err(drained.error);
        for (const rootId of roots) {
          // Transition cancels must surface undelivered cancel/abort writes as
          // `ChildAbortFailed` after forced cleanup. Ordinary Escape cleanup
          // keeps using `cancelSubtree` so delivery failures stay soft.
          const cancelled = await this.cancelSubtreeForTransition(rootId);
          if (cancelled.isErr()) {
            const first = cancelled.error[0];
            return err(
              first ??
                makeChildAbortFailedFailure(rootId, "transition-cancel-failed"),
            );
          }
        }
        const settled = this.markTransitionCancelledThreads();
        let written = 0;
        for (const threadId of settled) {
          const appended = await this.appendThreadSettlement(
            threadId,
            originRefs,
          );
          if (appended.isErr()) return err(appended.error);
          if (appended.value) written += 1;
        }
        const settling = await this.drainSettlementWrites();
        if (settling.isErr()) return err(settling.error);
        return ok({ cancelled: roots.length, settlementsWritten: written });
      })(),
    );
  }

  /**
   * Quit/reload path: a bounded graceful cancellation window followed by an
   * unconditional force-stop of whatever is still alive. Expected stop
   * failures are counted in the report, never thrown and never surfaced as a
   * rejected result - shutdown must always complete.
   */
  shutdownWithinBudget(
    budgetMs?: number,
  ): ResultAsync<PiShutdownReport, never> {
    if (this.disposedAll)
      return okAsync({
        gracefullyCancelled: 0,
        forceStopped: 0,
        timedOut: false,
      });
    const budget = budgetMs ?? DEFAULT_TRANSITION_SHUTDOWN_BUDGET_MS;
    const timerPort = this.deps.timerPort ?? new SystemTimerPort();
    const roots = this.transitionCancellationRoots();
    return ResultAsync.fromSafePromise(
      (async (): Promise<PiShutdownReport> => {
        let timedOut = false;
        if (roots.length > 0) {
          const graceful = Promise.all(
            roots.map(async (rootId) => {
              await this.cancelSubtree(rootId);
            }),
          ).then(() => false);
          const bounded = new Promise<boolean>((resolve) => {
            const handle = timerPort.schedule(() => resolve(true), budget);
            void graceful.then(() => handle.cancel());
          });
          timedOut = await Promise.race([graceful, bounded]);
        }
        let alive = 0;
        for (const child of this.children.values())
          if (!this.isTerminal(child)) alive += 1;
        // Force-stop is unconditional: `disposeAll()` kills every remaining
        // process and zeroes its secret, so no residual process, lease, or
        // capacity survives quit/reload.
        this.disposeAll();
        return {
          gracefullyCancelled: Math.max(roots.length - alive, 0),
          forceStopped: alive,
          timedOut,
        };
      })(),
    );
  }

  /**
   * Top-of-subtree node ids for a whole-tree cancellation: every live or
   * queued node whose parent is the synthetic root or is not itself part of
   * the snapshot. Cancelling these covers the entire owned forest exactly
   * once, because `cancelSubtree` already walks descendants.
   */
  private transitionCancellationRoots(): readonly string[] {
    const nodes = this.snapshotTree();
    const present = new Set(nodes.map((node) => node.id));
    return nodes
      .filter((node) => {
        const parentId = node.parentId;
        return parentId === undefined || !present.has(parentId);
      })
      .map((node) => node.id);
  }

  /**
   * Marks every thread whose run was still in flight as cancelled, so the
   * transition write-back records a deterministic outcome instead of racing
   * the run promise's own `settleThread` call. Returns the thread ids whose
   * settlement still needs to reach the origin parent.
   */
  private markTransitionCancelledThreads(): readonly string[] {
    const pending: string[] = [];
    for (const state of this.threads.values()) {
      if (state.running) {
        state.running = false;
        state.status = "cancelled";
        state.lastRetryable = true;
      }
      if (
        !this.threadSettlementWritten.has(
          `${state.threadId}\u0000${state.status}`,
        )
      ) {
        pending.push(state.threadId);
      }
    }
    return pending;
  }

  /**
   * Appends one thread's settled status to the supplied origin ref store.
   * Resolves `false` when there is nothing to write (no store, no record, or
   * this exact status already recorded) and `true` when an append landed.
   */
  private appendThreadSettlement(
    threadId: string,
    originRefs: PiThreadRefPort | undefined,
  ): ResultAsync<boolean, PiAdapterFailure> {
    const state = this.threads.get(threadId);
    if (state === undefined) return okAsync(false);
    // No ref store is wired for this generation at all, so this thread never
    // captured an origin record and none is owed.
    if (originRefs === undefined) return okAsync(false);
    const record = this.threadRecords.get(threadId);
    // A ref store exists but this pending thread has no authoritative record to
    // append against. Guessing one would write settlement metadata into the
    // wrong place, so the transition is vetoed instead.
    if (record === undefined)
      return errAsync(
        makeChildAbortFailedFailure(threadId, "settlement-record-missing"),
      );
    return this.settlementWrite(threadId, record, originRefs, state.status);
  }

  /** Cancels a node and every descendant, removing any not-yet-spawned queued requests under that subtree. */
  cancelSubtree(
    nodeId: string,
  ): ResultAsync<void, readonly PiAdapterFailure[]> {
    return this.cancelSubtreeWith(nodeId, (child) => child.cancel());
  }

  /**
   * Session-transition cancel: same subtree walk and forced cleanup as
   * `cancelSubtree`, but each live child uses
   * `PiRpcChild.cancelForTransition` so an undelivered cancel/abort
   * becomes a typed veto instead of a soft warning.
   */
  private cancelSubtreeForTransition(
    nodeId: string,
  ): ResultAsync<void, readonly PiAdapterFailure[]> {
    return this.cancelSubtreeWith(nodeId, (child) =>
      child.cancelForTransition(),
    );
  }

  private cancelSubtreeWith(
    nodeId: string,
    cancelChild: (child: PiRpcChild) => ResultAsync<void, PiAdapterFailure>,
  ): ResultAsync<void, readonly PiAdapterFailure[]> {
    if (this.disposedAll) return ResultAsync.fromSafePromise(Promise.resolve());
    const ids = subtreeIds(this.snapshotNodesForSubtreeLookup(), nodeId);
    const idSet = new Set(ids);
    this.dropQueuedUnder(idSet);
    const cancellations = ids
      .map((id) => this.children.get(id))
      .filter((child): child is PiRpcChild => child !== undefined)
      .map(
        (child) =>
          new ResultAsync(
            (async () => {
              const marked =
                this.deps.inspectionRegistry === undefined
                  ? ok(undefined)
                  : await this.deps.inspectionRegistry
                      .markInterrupted(child.getId())
                      .match(
                        () => ok(undefined),
                        (error) => err(error),
                      );
              // Never leave a process alive because history persistence failed.
              const cancelled = await cancelChild(child);
              if (marked.isErr())
                return err(this.historyFailure(child.getId(), marked.error));
              return cancelled;
            })(),
          ),
      );
    return ResultAsync.combineWithAllErrors(cancellations).map(() => {
      this.notifyTreeChanged();
      this.maybeStopTreeRefreshTimer();
      return undefined;
    });
  }

  private dropQueuedUnder(idSet: ReadonlySet<string>): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const entry = this.queue[i];
      if (entry === undefined) continue;
      if (!idSet.has(entry.request.parentId) && !idSet.has(entry.childId))
        continue;
      this.queue.splice(i, 1);
      entry.resolve(
        err(
          makeChildAbortFailedFailure(
            entry.childId,
            "queued request cancelled",
          ),
        ),
      );
    }
  }

  /**
   * Builds the node map `subtreeIds` walks for cancellation (Pi adapter contract
   *). MUST include not-yet-spawned queued requests, not just live
   * children: a queued descendant's own `parentId` may itself be another
   * queued (not-yet-live) request, never present in `this.children` -
   * omitting queued nodes here would make depth-2+ queued chains under a
   * cancelled subtree invisible to the BFS traversal and leave them
   * un-cancelled, spawning later under a since-cancelled ancestor. Uses
   * the exact same live+queued node set, in the exact same deterministic
   * order, as `snapshotTree` so tree state and cancellation always
   * agree on what the tree currently contains.
   */
  private snapshotNodesForSubtreeLookup(): ReadonlyMap<
    string,
    PiChildTreeNode
  > {
    const map = new Map<string, PiChildTreeNode>();
    for (const node of this.snapshotTree()) map.set(node.id, node);
    return map;
  }

  /**
   * Bounded inspectable tree state for all children in this generation
   * (Pi adapter contract), including not-yet-spawned queued requests (shown with
   * status `"queued"`) so a caller-side FIFO backlog is never invisible.
   * Excludes the synthetic root node.
   */
  snapshotTree(): readonly PiChildTreeNode[] {
    const live = Array.from(this.children.values(), (child) =>
      child.snapshot(),
    );
    const now = this.deps.now?.() ?? Date.now();
    const queued: PiChildTreeNode[] = this.queue.map((entry) => ({
      id: entry.childId,
      parentId: entry.request.parentId,
      name: entry.request.agentName,
      status: "queued",
      currentTurn: 0,
      currentTool: undefined,
      startedAtMs: now,
      elapsedMs: 0,
      usage: EMPTY_USAGE_AGGREGATE,
      latestOutput: "",
    }));
    return [...live, ...queued];
  }

  /** Cumulative usage across every child in this generation's tree (Pi adapter contract), live and terminal alike. */
  snapshotCumulativeUsage(): PiChildTreeNode["usage"] {
    let total = EMPTY_USAGE_AGGREGATE;
    for (const child of this.children.values()) {
      total = addUsage(total, child.snapshot().usage);
    }
    return total;
  }

  /** Restore an ordinary child through the controller's authenticated boundary. */
  restoreOrdinaryChild(
    input: PiChildRecoverySpawnInput,
  ): ResultAsync<PiChildRecoverySettlement, PiChildRestoreFailure> {
    const unavailable = (
      reason: PiChildRestoreUnavailableReason,
    ): ResultAsync<PiChildRecoverySettlement, PiChildRestoreFailure> =>
      errAsync({ type: "ChildRecoveryUnavailable" as const, reason });
    const storageAuthority = this.requireSessionStorageAuthority("restore");
    if (storageAuthority.isErr())
      return unavailable("restore dependencies unavailable");
    if (this.disposedAll || input.generationId !== this.deps.generationId)
      return unavailable("stale generation");
    const record = input.record;
    if (
      (record.status !== "running" && record.status !== "queued") ||
      record.settledAt !== undefined
    )
      return unavailable("record is not an interrupted ordinary child");
    if (this.children.has(record.childId))
      return unavailable("duplicate live child");
    if (record.sessionRef.length === 0)
      return unavailable("session reference is missing");
    const target = this.deps.resolveRootDelegationTarget?.(
      input.descriptor.name,
    );
    const buildBootstrap = this.deps.buildBootstrap;
    const sessions = this.deps.threadSessions?.();
    const rootAgentName = this.deps.rootAgentName?.();
    if (
      target === undefined ||
      buildBootstrap === undefined ||
      sessions === undefined
    )
      return unavailable("restore dependencies unavailable");
    if (rootAgentName === undefined)
      return unavailable("root authority unavailable");

    // The native session tree is the only source of the session location. The
    // ref carries the root-relative reference; the store proves containment,
    // ownership and no-follow safety before returning an absolute path.
    // Never turn childId into a path.
    return sessions
      .readSessionEntries(record.sessionRef, record.originParentSessionId)
      .mapErr(() => ({
        type: "ChildRecoveryUnavailable" as const,
        reason: "containment failed" as const,
      }))
      .andThen((opened) => {
        const activeLeaf = readActiveLeafId(opened.entries);
        type RestoreSession = { readonly session: PiRpcChildSpawnSession };
        if (activeLeaf === undefined || activeLeaf.length === 0)
          return errAsync<RestoreSession, PiChildRestoreFailure>({
            type: "ChildRecoveryUnavailable",
            reason: "active leaf is missing",
          });
        // Only the store may authorize this launch, and only for the exact
        // child being restored. The absolute path never leaves the store.
        return sessions
          .mintLaunchGrant({
            childId: record.childId,
            record: opened.record,
            activeLeafId: activeLeaf,
          })
          .mapErr(
            (): PiChildRestoreFailure => ({
              type: "ChildRecoveryUnavailable",
              reason: "containment failed",
            }),
          )
          .map(
            (grant): RestoreSession => ({
              session: { mode: "native", grant },
            }),
          );
      })
      .andThen(({ session }) => {
        const authorization = this.authorize({
          parentId: ROOT_NODE_ID,
          parentDepth: 0,
          parentAgentName: rootAgentName,
          agentName: input.descriptor.name,
          task: input.continuation,
          cwd: this.deps.currentCwd?.() ?? ".",
          env: this.deps.currentEnv?.() ?? {},
          bootstrap: null,
        });
        if (
          authorization.isErr() ||
          authorization.value.outcome !== "authorized"
        )
          return unavailable("capacity unavailable");
        const childId = record.childId;
        const cwd = this.deps.currentCwd?.() ?? ".";
        const env = this.deps.currentEnv?.() ?? this.deps.baseEnv ?? {};
        const child = new PiRpcChild(
          childId,
          ROOT_NODE_ID,
          this.deps.generationId,
          input.descriptor.name,
          1,
          {
            processPort: this.deps.processPort,
            sessionStorageAuthority: this.sessionStorageAuthority,
            randomPort: this.deps.randomPort,
            hmacPort: this.deps.hmacPort,
            timerPort: this.deps.timerPort,
            handshakeTimeoutMs: this.deps.handshakeTimeoutMs,
            replyTimeoutMs: this.deps.replyTimeoutMs,
            settlementTimeoutMs: this.deps.settlementTimeoutMs,
            runtimeBudgetMs: this.deps.runtimeBudgetMs,
            cancelGraceMs: this.deps.cancelGraceMs,
            responseDrainMs: this.deps.responseDrainMs,
            baseEnv: this.deps.baseEnv,
            logger: this.deps.logger,
            command: this.deps.command,
            now: this.deps.now,
            onDelegationRequest: (relayId, correlationId, body) =>
              this.handleChildDelegationRequest(relayId, correlationId, body),
            onAssistantUsageObserved: (usage) => {
              this.deps.telemetry
                ?.recordAssistantUsage({
                  id: usage.id,
                  source: "child",
                  agentName: input.descriptor.name,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                  cost: usage.cost,
                })
                .match(
                  () => undefined,
                  () => undefined,
                );
            },
            onStreamingUpdate: () => {
              this.deps.inspectionRegistry?.checkpoint(childId).match(
                () => undefined,
                () => undefined,
              );
              this.notifyTreeChanged();
            },
            onPrivateOutput: (capture) =>
              this.persistPrivateOutput(childId, capture),
            sessionObserver: {
              onEvent: (event) => {
                this.deps.inspectionRegistry
                  ?.checkpointEvent(childId, event)
                  .match(
                    () => undefined,
                    () => undefined,
                  );
                this.invokeChildSessionEventDep(childId, event);
                this.invokeSessionEventCallback(
                  childId,
                  input.onSessionEvent,
                  event,
                );
                return ok(undefined);
              },
            },
          },
        );
        const spawn = {
          childId,
          parentId: ROOT_NODE_ID,
          generationId: this.deps.generationId,
          agentName: input.descriptor.name,
          depth: 1,
          cwd,
          env,
          task: input.continuation,
          session,
        };
        this.restoreReservations.add(childId);
        const attached =
          this.deps.inspectionRegistry?.attachRecovered({
            id: childId,
            parentId: ROOT_NODE_ID,
            name: input.descriptor.name,
            kind: "ordinary",
            snapshot: () => child.snapshot(),
          }) ?? okAsync(undefined);
        const finalize = (
          terminal: boolean,
          summary?: string,
        ): ResultAsync<void, PiChildRestoreFailure> => {
          let persistence: ResultAsync<void, PiChildInspectionHistoryError>;
          if (this.deps.inspectionRegistry === undefined) {
            persistence = okAsync(undefined);
          } else if (terminal) {
            persistence = this.deps.inspectionRegistry.retainTerminal(
              childId,
              child.snapshot(),
              summary,
            );
          } else {
            persistence = this.deps.inspectionRegistry.markInterrupted(childId);
          }
          return new ResultAsync(
            persistence.match(
              () => {
                child.dispose();
                this.children.delete(childId);
                this.restoreReservations.delete(childId);
                this.promoteQueued();
                this.notifyTreeChanged();
                return ok(undefined);
              },
              () => {
                child.dispose();
                this.children.delete(childId);
                this.restoreReservations.delete(childId);
                this.promoteQueued();
                this.notifyTreeChanged();
                return err({
                  type: "ChildRecoverySpawnFailed" as const,
                  phase: "persistence" as const,
                });
              },
            ),
          );
        };
        const bootstrap = Result.fromThrowable(
          () =>
            buildBootstrap(target, childId, {
              parentAgentName: rootAgentName,
              parentDepth: 0,
              cwd,
            }),
          () => ({
            type: "ChildRecoverySpawnFailed" as const,
            phase: "bootstrap" as const,
          }),
        )();
        if (bootstrap.isErr())
          return finalize(false).andThen(() => errAsync(bootstrap.error));
        return ResultAsync.fromThrowable(
          async () => {
            const attachedResult = await attached;
            if (attachedResult.isErr()) throw new Error("attachment failed");
            this.children.set(childId, child);
            if (bootstrap.isErr()) throw new Error("bootstrap failed");
            const started = await child
              .spawnAndHandshake(spawn)
              .andThen(() => child.runTask(spawn, bootstrap.value));
            if (started.isErr()) throw new Error("run failed");
            if (started.value.outcome !== "completed")
              throw new Error("settlement failed");
            const finalOutput = started.value.assistantOutput ?? "";
            const cleaned = await finalize(true, finalOutput);
            if (cleaned.isErr()) throw new Error("persistence failed");
            return {
              finalOutput,
              interventionCount: started.value.interventionCount ?? 0,
            };
          },
          () => ({
            type: "ChildRecoverySpawnFailed" as const,
            phase: "run" as const,
          }),
        )().orElse((failure) =>
          finalize(false)
            .orElse(() => errAsync(failure))
            .andThen(() => errAsync(failure)),
        );
      });
  }

  disposeAll(): void {
    if (this.disposedAll) return;
    this.disposedAll = true;
    for (const entry of this.queue.splice(0)) {
      entry.resolve(
        err(makeChildAbortFailedFailure(entry.childId, "controller shut down")),
      );
    }
    for (const child of this.children.values()) {
      const interrupted = !this.isTerminal(child);
      const history = this.deps.inspectionRegistry;
      const persist = (() => {
        if (history === undefined) return okAsync(undefined);
        // Enqueue both writes before awaiting either result. A failed
        // interrupted write must not suppress terminal retention.
        const interruptedWrite = interrupted
          ? history.markInterrupted(child.getId())
          : okAsync(undefined);
        const terminalWrite = history.retainTerminal(
          child.getId(),
          interrupted
            ? { ...child.snapshot(), status: "cancelled" }
            : child.snapshot(),
        );
        return interruptedWrite.andThen(() => terminalWrite);
      })();
      // Disposal is deliberately downstream of both interrupted and terminal
      // persistence, but still runs when either write fails.
      void persist.match(
        () => child.dispose(),
        () => child.dispose(),
      );
    }
    this.deps.inspectionRegistry?.closeGeneration();
    this.treeRefreshTimer?.cancel();
    this.treeRefreshTimer = undefined;
    this.notifyTreeChanged();
  }
}

function recordToOverlayRuns(
  record: PiChildRefRecord | undefined,
): PiOverlayChildDescriptor["runs"] {
  if (record === undefined) return [];
  return record.runs.map((run) => ({
    run: run.run,
    action: run.action,
    startedAt: run.startedAt,
    ...(run.priorOutcome === undefined
      ? {}
      : { priorOutcome: run.priorOutcome }),
    ...(run.initiator === undefined ? {} : { initiator: run.initiator }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...(run.reasoning === undefined ? {} : { reasoning: run.reasoning }),
  }));
}

function refStatusToOverlayStatus(
  status: PiChildRefStatus,
): PiOverlayChildDescriptor["status"] {
  if (status === "running" || status === "queued") return "live";
  if (status === "tombstoned") return "orphan";
  return "settled";
}

function refRecordToOverlayDescriptor(
  record: PiChildRefRecord,
  generationId: string,
): PiOverlayChildDescriptor {
  return {
    childId: record.childId,
    threadId: record.threadId,
    activeChildId: record.childId,
    status: refStatusToOverlayStatus(record.status),
    title: record.title,
    generationId,
    parentChildId: undefined,
    runs: recordToOverlayRuns(record),
    branchIds: [],
    descendantChildIds: [],
    sessionRef: record.sessionRef,
  };
}

export type { DelegationAuthorizationError, DelegationLimitsError };
