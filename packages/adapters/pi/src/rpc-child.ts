/**
 * Owns one delegated child's full parent-side lifecycle (Pi adapter contract
 *): spawns `pi --mode rpc --no-session` via the injected
 * process port, injects an independent 256-bit secret via environment
 * only, awaits the authenticated handshake before treating the child as
 * live, sends bootstrap and task prompts through legitimate `prompt` RPC
 * commands, and uses Pi's native correlated RPC channel for `steer`,
 * `follow_up`, `get_entries`, and extension UI responses. Native live
 * commands are accepted only while the expected child identity and lifecycle
 * are live. Authenticated bootstrap, cancellation, settlement, and
 * delegation remain private control envelopes; the child also streams
 * ordinary RPC events into bounded tree telemetry and deduplicated usage
 * projection, with fail-closed timeouts and idempotent cleanup.
 *
 * Every terminal outcome - success, protocol failure, authentication
 * failure, framing violation, timeout, or unexpected process exit - flows
 * through exactly one place, {@link PiRpcChild.failOutstanding} (for
 * failures) or the success paths that call
 * {@link PiRpcChild.terminateResources} directly, so the underlying
 * process is always killed and the secret always erased on every path,
 * while the final inspectable `status` (`"failed"` vs `"completed"` vs
 * `"cancelled"`) is preserved rather than clobbered by later cleanup.
 */
import { isAbsolute } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  type PiBootstrapAckBody,
  type PiBootstrapBody,
  type PiDelegateRequestBody,
  type PiTransferChunkBody,
  type PiTransferResultBody,
  parseControlBody,
} from "./child-control-bodies.js";
import {
  bytesToHex,
  type ErasableSecret,
  generateChildSecret,
  generateNonceHex,
  type HmacPort,
  type RandomPort,
} from "./child-crypto.js";
import {
  WEAVE_CHILD_AGENT_NAME_ENV,
  WEAVE_CHILD_DEPTH_ENV,
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_PARENT_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "./child-env.js";
import {
  looksLikeControlEnvelope,
  PiChildAuthState,
  type PiControlEnvelope,
  type PiControlKind,
  signEnvelope,
  verifyEnvelope,
} from "./child-envelope.js";
import { normalizePiExtensionUiRequest } from "./child-extension-ui.js";
import { PiLineFramer } from "./child-framing.js";
import type {
  PiChildProcessPort,
  PiSpawnedChildProcess,
} from "./child-process-port.js";
import {
  type PiChildSessionEvent,
  PiExtensionUiResponseSchema,
  parsePiChildSessionEvent,
} from "./child-session-events.js";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REPLY_TIMEOUT_MS,
  DEFAULT_SETTLEMENT_TIMEOUT_MS,
  SystemTimerPort,
  type TimerHandle,
  type TimerPort,
} from "./child-timer.js";
import { ChunkTransferAssembler } from "./child-transfer.js";
import {
  addUsage,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantTextDeltaPreview,
  extractAssistantThinkingDeltaPreview,
  type PiChildStatus,
  type PiChildTreeNode,
  type PiChildUsageAggregate,
  truncateLatestOutput,
} from "./child-tree.js";
import { DelegateRequestAssembler } from "./delegate-request-chunking.js";
import {
  makeChildAbortFailedFailure,
  makeChildAuthenticationFailedFailure,
  makeChildDeliveryFailedFailure,
  makeChildEnvelopeMalformedFailure,
  makeChildEnvelopeReplayFailure,
  makeChildExitedUnexpectedlyFailure,
  makeChildHandshakeMissingFailure,
  makeChildInteractionUnavailableFailure,
  makeChildReplyDuplicateFailure,
  makeChildReplyLateFailure,
  makeChildReplyMissingFailure,
  makeChildSettlementMissingFailure,
  makeChildSpawnFailedFailure,
  makeChildTransferRejectedFailure,
  makeChildTransferTimedOutFailure,
  makeChildTransferTooLargeFailure,
  PI_TRANSPORT_LIMITS,
  type PiAdapterFailure,
} from "./errors.js";
import {
  encodePromptChunksBounded,
  MAX_OUTBOUND_PROMPT_RECORD_BYTES,
  PROMPT_CHUNK_COMMAND,
} from "./prompt-chunking.js";
import type { JsonValue } from "./strict-json.js";
import type { PiAdapterLogger } from "./types.js";

export type PiChildSessionObserverResult =
  | Result<void, PiAdapterFailure>
  | ResultAsync<void, PiAdapterFailure>;

/**
 * Bounded restore metadata emitted only after Pi confirms the stored active
 * leaf. `sessionPath` is intentionally omitted to avoid disclosing a host
 * filesystem path to observer implementations.
 */
export interface PiRestoreContextMetadata {
  readonly activeLeafId: string;
  readonly checkpointCursor?: number;
}

/** Receives validated, bounded events without owning child persistence. */
export interface PiChildSessionObserver {
  readonly onEvent: (
    event: PiChildSessionEvent,
  ) => PiChildSessionObserverResult;
}

export interface PiRpcChildDeps {
  readonly processPort: PiChildProcessPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly timerPort?: TimerPort;
  readonly logger: PiAdapterLogger;
  readonly command?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  /** Maximum silence while awaiting settlement; valid child activity renews it. */
  readonly settlementTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly now?: () => number;
  /**
   * A sanitized base environment (e.g. `PATH`/`HOME`) merged in *before*
   * `input.env` and the `WEAVE_CHILD_*` bootstrap variables, so the
   * spawned `pi` process can actually be located and run. Defaults to `{}`
   * (tests are unaffected); production wiring supplies a real sanitized
   * snapshot (see `sanitizedBaseEnv` in `child-env.ts`).
   */
  readonly baseEnv?: Readonly<Record<string, string>>;
  /**
   * Invoked when this child relays a request to delegate further work of
   * its own (Pi adapter contract: nested/descendant delegation). The caller
   * (the delegation controller) must authorize it under this child's own
   * identity/depth against the SAME global tree/process budget as every
   * other delegation - never an independent, untracked budget - and
   * eventually call {@link PiRpcChild.sendDelegationResponse} with the
   * matching correlationId.
   */
  readonly onDelegationRequest?: (
    childId: string,
    correlationId: string,
    request: PiDelegateRequestBody,
  ) => void;
  /**
   * Invoked once per settled assistant message this child reports (Pi adapter contract
   *), immediately after the existing in-memory `usage` aggregate is
   * updated. Carries only bounded safe scalars (a stable message id and
   * optional non-negative token/cost counters) — never raw text. The
   * caller (delegation controller) is responsible for recording this as a
   * durable usage observation via the injected telemetry seam; a no-op
   * default here keeps every existing construction site unaffected.
   */
  readonly onAssistantUsageObserved?: (usage: {
    readonly id: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly cost?: number;
  }) => void;
  /**
   * Invoked whenever this child's status, output, or usage updates,
   * allowing the parent (delegation controller/tool) to stream progress
   * updates to the harness UI. Called on turn_start, tool_execution_start,
   * message_update, tool_execution_end, message_end, and status changes.
   */
  readonly onStreamingUpdate?: (snapshot: PiChildTreeNode) => void;
  /** Receives each validated bounded child-session event. */
  readonly sessionObserver?: PiChildSessionObserver;
  /** Receives the full private terminal output; never projected to the model. */
  readonly onPrivateOutput?: (capture: {
    readonly output: string;
    readonly byteLength: number;
  }) => PiChildSessionObserverResult;
  /**
   * Receives bounded restore metadata only after the authenticated child
   * confirms the stored active leaf. It never receives entries or sessionPath.
   */
  readonly onRestoreContextVerified?: (
    metadata: PiRestoreContextMetadata,
  ) => PiChildSessionObserverResult;
  /** Receives the new count after Pi accepts a live-session intervention. */
  readonly onInterventionCountChanged?: (count: number) => void;
}

export type PiRpcChildSpawnSession =
  | { readonly mode: "ephemeral" }
  | { readonly mode: "new"; readonly sessionDir: string }
  | {
      readonly mode: "restore";
      readonly sessionDir: string;
      readonly sessionPath: string;
      readonly activeLeafId: string;
      readonly checkpointCursor?: number;
    };

export interface PiRpcChildSpawnInput {
  readonly childId: string;
  readonly parentId: string;
  readonly generationId: string;
  readonly agentName: string;
  readonly depth: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly task: string;
  /** Trusted adapter-owned history selection; omitted means ephemeral. */
  readonly session?: PiRpcChildSpawnSession;
}

export type PiChildSettlement =
  | {
      readonly outcome: "completed";
      readonly summary: string;
      readonly completionCandidate?: string;
      readonly outputByteLength?: number;
      /** Present on settlements produced by PiRpcChild; optional for legacy callers. */
      readonly interventionCount?: number;
    }
  | { readonly outcome: "failed"; readonly reason: string }
  | { readonly outcome: "cancelled" };

const DEFAULT_COMMAND = ["pi", "--mode", "rpc"] as const;
const SESSION_FLAGS = [
  "--no-session",
  "--session-dir",
  "--session",
  "--continue",
  "--resume",
  "--fork",
] as const;
const MAX_SPAWN_SESSION_ID_BYTES = 256;
const MAX_SPAWN_CHECKPOINT_CURSOR = Number.MAX_SAFE_INTEGER;
const MAX_LIVE_RPC_ID_LENGTH = 256;
const MAX_LIVE_RPC_MESSAGE_LENGTH = 64 * 1024;
const MAX_GET_ENTRIES = 256;
const MAX_GET_ENTRIES_BYTES = 512 * 1024;
const MAX_LIVE_JSON_DEPTH = 8;

type SpawnSessionValidationResult = Result<readonly string[], string>;

function invalidSpawnSession(reason: string): SpawnSessionValidationResult {
  return err(`invalid session spawn configuration: ${reason}`);
}

function validateAbsoluteSpawnPath(
  value: unknown,
  field: string,
): Result<string, string> {
  if (typeof value !== "string" || value.length === 0) {
    return err(`${field} must be a non-empty absolute path`);
  }
  if (value.includes("\0") || value.includes("\\")) {
    return err(`${field} contains an unsafe path character`);
  }
  if (!isAbsolute(value)) {
    return err(`${field} must be absolute`);
  }
  const components = value.split("/");
  if (
    components.some(
      (component, index) =>
        index > 0 && (component === "." || component === ".."),
    )
  ) {
    return err(`${field} contains a traversal component`);
  }
  return ok(value);
}

function validateSpawnSessionId(value: unknown): Result<string, string> {
  if (typeof value !== "string" || value.length === 0) {
    return err("activeLeafId must be non-empty");
  }
  if (
    value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > MAX_SPAWN_SESSION_ID_BYTES
  ) {
    return err("activeLeafId exceeds its bound");
  }
  return ok(value);
}

function buildSpawnCommand(
  baseCommand: readonly string[],
  session: PiRpcChildSpawnSession | undefined,
): SpawnSessionValidationResult {
  for (const argument of baseCommand) {
    if (
      typeof argument !== "string" ||
      SESSION_FLAGS.some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      )
    ) {
      return invalidSpawnSession("base command contains a session flag");
    }
  }

  const selected = session ?? { mode: "ephemeral" as const };
  if (typeof selected !== "object" || selected === null) {
    return invalidSpawnSession("session must be an object");
  }
  if (selected.mode === "ephemeral") {
    return ok([...baseCommand, "--no-session"]);
  }

  const sessionDir = validateAbsoluteSpawnPath(
    selected.sessionDir,
    "sessionDir",
  );
  if (sessionDir.isErr()) return invalidSpawnSession(sessionDir.error);

  if (selected.mode === "new") {
    return ok([...baseCommand, "--session-dir", sessionDir.value]);
  }

  if (selected.mode !== "restore") {
    return invalidSpawnSession("unknown session mode");
  }

  const sessionPath = validateAbsoluteSpawnPath(
    selected.sessionPath,
    "sessionPath",
  );
  if (sessionPath.isErr()) return invalidSpawnSession(sessionPath.error);
  if (!sessionPath.value.endsWith(".jsonl")) {
    return invalidSpawnSession("sessionPath must end in .jsonl");
  }
  const directory = sessionDir.value.replace(/\/+$/, "") || "/";
  const containmentPrefix = directory === "/" ? "/" : `${directory}/`;
  if (!sessionPath.value.startsWith(containmentPrefix)) {
    return invalidSpawnSession("sessionPath must be contained by sessionDir");
  }

  const activeLeafId = validateSpawnSessionId(selected.activeLeafId);
  if (activeLeafId.isErr()) return invalidSpawnSession(activeLeafId.error);
  if (
    selected.checkpointCursor !== undefined &&
    (!Number.isSafeInteger(selected.checkpointCursor) ||
      selected.checkpointCursor < 0 ||
      selected.checkpointCursor > MAX_SPAWN_CHECKPOINT_CURSOR)
  ) {
    return invalidSpawnSession("checkpointCursor is out of bounds");
  }

  return ok([
    ...baseCommand,
    "--session-dir",
    sessionDir.value,
    "--session",
    sessionPath.value,
  ]);
}

/** Native Pi commands, kept outside the authenticated private envelope kinds. */
const LiveRpcCommandSchema = z.enum(["steer", "follow_up", "get_entries"]);
const LiveRpcResponseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(MAX_LIVE_RPC_ID_LENGTH)
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <= MAX_LIVE_RPC_ID_LENGTH,
        "id is too large",
      ),
    type: z.literal("response"),
    command: LiveRpcCommandSchema,
    success: z.boolean(),
  })
  .passthrough();

const boundedJsonSchema = z.custom<JsonValue>(
  (value) => isBoundedGetEntriesJson(value as JsonValue),
  { message: "bounded JSON value required" },
);

const boundedField = (maxBytes = MAX_LIVE_RPC_MESSAGE_LENGTH, min = 0) =>
  z
    .string()
    .min(min)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      "field is too large",
    );
const entryIdSchema = boundedField(MAX_LIVE_RPC_ID_LENGTH, 1);
const entryBaseShape = {
  id: entryIdSchema,
  parentId: z.union([entryIdSchema, z.null()]),
  timestamp: boundedField(128, 1),
};

const PiGetEntriesEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      ...entryBaseShape,
      message: boundedJsonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("thinking_level_change"),
      ...entryBaseShape,
      thinkingLevel: boundedField(),
    })
    .strict(),
  z
    .object({
      type: z.literal("model_change"),
      ...entryBaseShape,
      provider: boundedField(),
      modelId: boundedField(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compaction"),
      ...entryBaseShape,
      summary: boundedField(),
      firstKeptEntryId: entryIdSchema,
      tokensBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      details: boundedJsonSchema.optional(),
      usage: boundedJsonSchema.optional(),
      fromHook: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("branch_summary"),
      ...entryBaseShape,
      fromId: entryIdSchema,
      summary: boundedField(),
      details: boundedJsonSchema.optional(),
      usage: boundedJsonSchema.optional(),
      fromHook: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("custom"),
      ...entryBaseShape,
      customType: boundedField(MAX_LIVE_RPC_ID_LENGTH, 1),
      data: boundedJsonSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("custom_message"),
      ...entryBaseShape,
      customType: boundedField(MAX_LIVE_RPC_ID_LENGTH, 1),
      content: z.union([
        boundedField(),
        z.array(boundedJsonSchema).max(MAX_GET_ENTRIES),
      ]),
      details: boundedJsonSchema.optional(),
      display: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("label"),
      ...entryBaseShape,
      targetId: entryIdSchema,
      label: boundedField().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("session_info"),
      ...entryBaseShape,
      name: boundedField().optional(),
    })
    .strict(),
]);

const PiGetEntriesDataSchema = z
  .object({
    entries: z.array(PiGetEntriesEntrySchema).max(MAX_GET_ENTRIES),
    leafId: z.union([entryIdSchema, z.null()]),
  })
  .strict();

export type PiGetEntriesEntry = z.infer<typeof PiGetEntriesEntrySchema>;

export interface PiGetEntriesResult {
  readonly entries: readonly PiGetEntriesEntry[];
  readonly leafId: string | null;
}

export interface PiExtensionUiResponseInput {
  readonly type: "extension_ui_response";
  readonly requestId: string;
  readonly response?: JsonValue;
  readonly cancelled?: boolean;
  readonly error?: string;
}

type LiveRpcResult = undefined | PiGetEntriesResult;
type LiveRpcPending = {
  readonly command: "steer" | "follow_up" | "get_entries";
  timer: { cancel: () => void };
  readonly resolve: (result: Result<LiveRpcResult, PiAdapterFailure>) => void;
};

/** Parent-to-child kinds a well-behaved child never sends back to the parent; receiving one is always an unknown/illegal incoming kind. */
const ILLEGAL_INCOMING_KINDS: ReadonlySet<PiControlKind> = new Set([
  "bootstrap",
  "cancel",
  "delegate-response",
]);

export class PiRpcChild {
  private readonly childId: string;
  private readonly parentId: string;
  private readonly generationId: string;
  private readonly agentName: string;
  private readonly depth: number;
  private readonly processPort: PiChildProcessPort;
  private readonly randomPort: RandomPort;
  private readonly hmacPort: HmacPort;
  private readonly timerPort: TimerPort;
  private readonly logger: PiAdapterLogger;
  private readonly command: readonly string[];
  private readonly handshakeTimeoutMs: number;
  private readonly settlementTimeoutMs: number;
  private readonly now: () => number;
  private readonly onDelegationRequest:
    | ((
        childId: string,
        correlationId: string,
        request: PiDelegateRequestBody,
      ) => void)
    | undefined;
  private readonly onAssistantUsageObserved:
    | ((usage: {
        readonly id: string;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
        readonly cost?: number;
      }) => void)
    | undefined;
  private readonly onStreamingUpdate:
    | ((snapshot: PiChildTreeNode) => void)
    | undefined;
  private readonly sessionObserver: PiChildSessionObserver | undefined;
  private readonly onPrivateOutput:
    | ((capture: {
        readonly output: string;
        readonly byteLength: number;
      }) => PiChildSessionObserverResult)
    | undefined;
  private readonly onRestoreContextVerified:
    | ((metadata: PiRestoreContextMetadata) => PiChildSessionObserverResult)
    | undefined;
  private readonly onInterventionCountChanged:
    | ((count: number) => void)
    | undefined;
  private cwd = "";

  private secret: ErasableSecret | undefined;
  private authState: PiChildAuthState | undefined;
  private process: PiSpawnedChildProcess | undefined;
  private readonly framer = new PiLineFramer();
  private readonly delegateRequestAssembler = new DelegateRequestAssembler();
  private readonly outputTransferAssembler = new ChunkTransferAssembler();
  private readonly completedOutputTransfers = new Map<string, string>();
  private disposed = false;
  private startedAtMs = 0;

  private status: PiChildStatus = "queued";
  private currentTurn = 0;
  private currentTool: string | undefined;
  private usage: PiChildUsageAggregate = EMPTY_USAGE_AGGREGATE;
  private latestOutput = "";
  /**
   * Transient reasoning preview for the current turn, held separately from
   * `latestOutput` so visible answer text always takes precedence. Cleared
   * when a new turn emits its first delta and as soon as real text arrives;
   * never persisted and never part of a settlement summary.
   */
  private latestThinking = "";
  private resetPreviewOnNextDelta = false;
  private latestCompletedAssistantOutput = "";
  private readonly seenUsageMessageIds = new Set<string>();
  private readonly liveRpcPending = new Map<string, LiveRpcPending>();
  /** Native Pi sends no response acknowledgement, so successful writes consume these IDs. */
  private readonly outstandingExtensionUiRequestIds = new Set<string>();
  private liveRpcCounter = 0;
  private interventionCount = 0;
  private promptTransferCounter = 0;

  private handshakeResolvers:
    | { resolve: () => void; reject: (failure: PiAdapterFailure) => void }
    | undefined;
  private bootstrapAckResolvers:
    | {
        resolve: (body: PiBootstrapAckBody) => void;
        reject: (failure: PiAdapterFailure) => void;
      }
    | undefined;
  private promptTransferResolvers:
    | {
        readonly transferId: string;
        resolve: (body: PiTransferResultBody) => void;
        reject: (failure: PiAdapterFailure) => void;
      }
    | undefined;
  private settlementResolvers:
    | {
        resolve: (settlement: PiChildSettlement) => void;
        reject: (failure: PiAdapterFailure) => void;
      }
    | undefined;
  private cancelResolvers: { resolve: () => void } | undefined;
  private settled = false;
  private settlementTimer: TimerHandle | undefined;
  private readonly replyTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly baseEnv: Readonly<Record<string, string>>;
  /** The restore selector used by the actual spawn; never inferred from task input. */
  private restoreSession:
    | Extract<PiRpcChildSpawnSession, { readonly mode: "restore" }>
    | undefined;

  constructor(
    childId: string,
    parentId: string,
    generationId: string,
    agentName: string,
    depth: number,
    deps: PiRpcChildDeps,
  ) {
    this.childId = childId;
    this.parentId = parentId;
    this.generationId = generationId;
    this.agentName = agentName;
    this.depth = depth;
    this.processPort = deps.processPort;
    this.randomPort = deps.randomPort;
    this.hmacPort = deps.hmacPort;
    this.timerPort = deps.timerPort ?? new SystemTimerPort();
    this.logger = deps.logger;
    this.command = deps.command ?? DEFAULT_COMMAND;
    this.handshakeTimeoutMs =
      deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.settlementTimeoutMs =
      deps.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
    this.replyTimeoutMs = deps.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.baseEnv = deps.baseEnv ?? {};
    this.now = deps.now ?? (() => Date.now());
    this.onDelegationRequest = deps.onDelegationRequest;
    this.onAssistantUsageObserved = deps.onAssistantUsageObserved;
    this.onStreamingUpdate = deps.onStreamingUpdate;
    this.sessionObserver = deps.sessionObserver;
    this.onPrivateOutput = deps.onPrivateOutput;
    this.onRestoreContextVerified = deps.onRestoreContextVerified;
    this.onInterventionCountChanged = deps.onInterventionCountChanged;
  }

  getId(): string {
    return this.childId;
  }
  getParentId(): string {
    return this.parentId;
  }
  getAgentName(): string {
    return this.agentName;
  }
  getDepth(): number {
    return this.depth;
  }
  getCwd(): string {
    return this.cwd;
  }
  isSettled(): boolean {
    return this.settled;
  }
  isDisposed(): boolean {
    return this.disposed;
  }

  getInterventionCount(): number {
    return this.interventionCount;
  }

  snapshot(): PiChildTreeNode {
    return {
      id: this.childId,
      parentId: this.parentId,
      name: this.agentName,
      status: this.status,
      currentTurn: this.currentTurn,
      currentTool: this.currentTool,
      startedAtMs: this.startedAtMs,
      elapsedMs: Math.max(0, this.now() - this.startedAtMs),
      usage: this.usage,
      latestOutput:
        this.latestOutput.length > 0 ? this.latestOutput : this.latestThinking,
    };
  }

  /** Spawns the process, injects the secret via environment only, and awaits the authenticated handshake before returning. */
  spawnAndHandshake(
    input: PiRpcChildSpawnInput,
  ): ResultAsync<void, PiAdapterFailure> {
    const command = buildSpawnCommand(this.command, input.session);
    if (command.isErr()) {
      const failure = makeChildSpawnFailedFailure(this.childId, command.error);
      this.failOutstanding(failure);
      return errAsync(failure);
    }

    this.restoreSession =
      input.session?.mode === "restore" ? { ...input.session } : undefined;
    this.startedAtMs = this.now();
    this.status = "spawning";
    this.onStreamingUpdate?.(this.snapshot());
    this.cwd = input.cwd;
    this.secret = generateChildSecret(this.randomPort);
    this.authState = new PiChildAuthState(this.childId, this.generationId);
    const secretBytes = this.secret.peek();
    if (secretBytes === undefined) {
      const failure = makeChildSpawnFailedFailure(
        this.childId,
        "secret unavailable",
      );
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    const env: Record<string, string> = {
      ...this.baseEnv,
      ...input.env,
      [WEAVE_CHILD_SECRET_ENV]: bytesToHex(secretBytes),
      [WEAVE_CHILD_ID_ENV]: this.childId,
      [WEAVE_CHILD_PARENT_ID_ENV]: this.parentId,
      [WEAVE_CONTROLLER_GENERATION_ENV]: this.generationId,
      [WEAVE_CHILD_AGENT_NAME_ENV]: this.agentName,
      [WEAVE_CHILD_DEPTH_ENV]: String(this.depth),
    };
    return this.processPort
      .spawn({ command: command.value, env, cwd: input.cwd })
      .mapErr((spawnError) =>
        makeChildSpawnFailedFailure(this.childId, spawnError.reason),
      )
      .andThen((spawned) => {
        this.process = spawned;
        this.status = "handshaking";
        this.onStreamingUpdate?.(this.snapshot());
        // Install the resolver *before* wiring the transport, so any
        // authenticated handshake dispatched the instant the listener is
        // attached (or, in principle, buffered/replayed by the port)
        // always finds a live waiter rather than racing it (Pi adapter contract
        // fail-closed authentication - a lost handshake must never look
        // like an unauthenticated child).
        const handshakeWait = this.awaitHandshake();
        this.wireStdout(spawned);
        this.wireExit(spawned);
        return handshakeWait;
      })
      .orElse((failure) => {
        // Every terminal failure - spawn, framing, or a handshake that
        // never arrives - must stop/kill the process and erase the secret,
        // never merely reject the current waiter and leak the rest.
        this.failOutstanding(failure);
        return errAsync(failure);
      });
  }

  private wireStdout(spawned: PiSpawnedChildProcess): void {
    spawned.stdout.onData((chunk) => {
      const result = this.framer.push(chunk);
      if (result.isErr()) {
        this.logger.warn(
          { childId: this.childId, framingError: result.error.type },
          "private child transport framing violation; stopping child",
        );
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(this.childId, result.error.type),
        );
        return;
      }
      for (const frame of result.value) this.handleLine(frame.json);
    });
    spawned.stdout.onEnd(() => this.handleProcessExit(null));
    spawned.stdout.onError(() => this.handleProcessExit(null));
  }

  /** Observes the process's own real exit code (Pi adapter contract) rather than relying solely on the stdout stream ending. */
  private wireExit(spawned: PiSpawnedChildProcess): void {
    spawned.exited.then(
      (exitCode) => this.handleProcessExit(exitCode),
      () => this.handleProcessExit(null),
    );
  }

  private handleProcessExit(exitCode: number | null): void {
    if (this.disposed || this.settled) return;
    if (this.status === "cancelling") {
      // Exit during a cancellation in progress is the expected outcome,
      // not an unexpected-exit failure - complete the cancellation
      // immediately (resolving both the bounded cancel wait and this
      // child's own settlement as `cancelled`, as required by the Pi adapter contract) rather than
      // force-waiting out the grace period.
      this.completeCancellation();
      return;
    }
    this.failOutstanding(
      makeChildExitedUnexpectedlyFailure(this.childId, exitCode),
    );
  }

  private handleLine(json: JsonValue): void {
    if (looksLikeControlEnvelope(json)) {
      this.handleControlLine(json);
      return;
    }
    this.handleOrdinaryEvent(json);
  }

  private handleControlLine(json: JsonValue): void {
    if (this.disposed) return;
    const secretBytes = this.secret?.peek();
    const authState = this.authState;
    if (secretBytes === undefined || authState === undefined) {
      // Never silently ignore an incoming control line just because our
      // own activation state is missing - fail closed rather than leave
      // the caller waiting on a resolver that can now never be satisfied.
      this.failOutstanding(
        makeChildAuthenticationFailedFailure(this.childId, "not-activated"),
      );
      return;
    }
    void verifyEnvelope(json, secretBytes, this.hmacPort).match(
      (envelope) => this.admitControlEnvelope(envelope, authState),
      (envelopeError) => {
        this.logger.warn(
          { childId: this.childId, reason: envelopeError.type },
          "private control envelope failed verification",
        );
        this.failOutstanding(
          makeChildAuthenticationFailedFailure(
            this.childId,
            envelopeError.type,
          ),
        );
      },
    );
  }

  private admitControlEnvelope(
    envelope: PiControlEnvelope,
    authState: PiChildAuthState,
  ): void {
    const admitted = authState.admitIncoming(envelope);
    if (admitted.isErr()) {
      const failure =
        admitted.error.type === "NonceReplay"
          ? makeChildEnvelopeReplayFailure(this.childId)
          : makeChildEnvelopeMalformedFailure(
              this.childId,
              admitted.error.type,
            );
      this.failOutstanding(failure);
      return;
    }
    this.renewSettlementTimeout();
    this.dispatchControlKind(envelope);
  }

  /**
   * Enforces the child's strict protocol state machine (Pi adapter contract):
   * `handshake` only while awaiting it, `bootstrap-ack` only while a
   * bootstrap is outstanding, `settled` only once bootstrap has been
   * confirmed applied, `cancelled` only while a cancellation is in
   * flight, and `delegate-request` only once running. Any message arriving
   * out of this order - duplicated, premature, late, or
   * of an unknown/illegal kind - fails closed instead of being silently
   * accepted or merely observed.
   */
  private dispatchControlKind(envelope: PiControlEnvelope): void {
    if (envelope.kind === "handshake") {
      if (this.status !== "handshaking") {
        // The only way to observe a second `handshake` is a duplicate or a
        // late arrival after the child's lifecycle already advanced past
        // it - never a genuinely new/different kind of protocol error.
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const resolvers = this.handshakeResolvers;
      this.handshakeResolvers = undefined;
      resolvers?.resolve();
      return;
    }
    if (envelope.kind === "bootstrap-ack") {
      if (
        this.status !== "bootstrapping" ||
        this.bootstrapAckResolvers === undefined
      ) {
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const parsedAck = parseControlBody("bootstrap-ack", envelope.body);
      if (!parsedAck.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(this.childId, "bootstrap-ack-body"),
        );
        return;
      }
      this.status = "running";
      this.onStreamingUpdate?.(this.snapshot());
      const resolvers = this.bootstrapAckResolvers;
      this.bootstrapAckResolvers = undefined;
      resolvers.resolve(parsedAck.value);
      return;
    }
    if (envelope.kind === "transfer-chunk") {
      this.handleOutputTransferChunk(envelope);
      return;
    }
    if (envelope.kind === "transfer-result") {
      const parsed = parseControlBody("transfer-result", envelope.body);
      if (!parsed.ok || parsed.value.channel !== "prompt") {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "prompt-transfer-result-invalid",
          ),
        );
        return;
      }
      const resolvers = this.promptTransferResolvers;
      if (
        resolvers === undefined ||
        resolvers.transferId !== parsed.value.transferId ||
        envelope.correlationId !== parsed.value.transferId
      ) {
        // A late ACK from the first attempt can arrive after retry starts.
        // It has already passed authentication, nonce, and sequence checks,
        // so drop it without disturbing the live attempt.
        this.logger.warn(
          { childId: this.childId },
          "dropped unmatched prompt transfer result",
        );
        return;
      }
      this.promptTransferResolvers = undefined;
      if (parsed.value.status === "nack") {
        resolvers.reject(
          makeChildTransferRejectedFailure(
            this.childId,
            "prompt",
            parsed.value.reason,
          ),
        );
        return;
      }
      resolvers.resolve(parsed.value);
      return;
    }
    if (envelope.kind === "settled") {
      if (this.status === "cancelling") {
        // Legitimate race, never a protocol violation (Pi adapter contract): the
        // raw RPC `abort` command this parent writes right after the
        // authenticated `cancel` envelope (see `cancel()`) can end the
        // child's current turn before the queued hidden-command prompt
        // carrying that `cancel` envelope is even dispatched by the exact
        // host, so the child's own extension reports an ordinary
        // `settled` envelope for the aborted turn before it ever admits
        // the cancel and reports `cancelled` itself. Cancelling an
        // ordinary helper always yields a structured cancelled result to
        // its parent regardless of which control kind this race lets the
        // child report first - still validate the body shape (defense in
        // depth) before treating it as the cancellation's own outcome.
        const parsed = parseControlBody("settled", envelope.body);
        if (!parsed.ok) {
          this.failOutstanding(
            makeChildEnvelopeMalformedFailure(
              this.childId,
              "settled-body-invalid",
            ),
          );
          return;
        }
        this.completeCancellation();
        return;
      }
      if (!this.settled && this.status !== "running") {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "premature-settlement",
          ),
        );
        return;
      }
      this.completeSettlement(envelope);
      return;
    }
    if (envelope.kind === "cancelled") {
      if (this.status !== "cancelling") {
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const parsed = parseControlBody("cancelled", envelope.body);
      if (!parsed.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "cancelled-body-invalid",
          ),
        );
        return;
      }
      this.completeCancellation();
      return;
    }
    if (envelope.kind === "error") {
      const parsed = parseControlBody("error", envelope.body);
      const reason = parsed.ok ? parsed.value.reason : "child reported error";
      this.failOutstanding(
        makeChildEnvelopeMalformedFailure(this.childId, reason),
      );
      return;
    }
    if (
      envelope.kind === "delegate-request" ||
      envelope.kind === "delegate-request-chunk"
    ) {
      if (this.status !== "running") {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "unexpected-delegate-request",
          ),
        );
        return;
      }
      if (envelope.kind === "delegate-request") {
        const parsed = parseControlBody("delegate-request", envelope.body);
        if (!parsed.ok) {
          this.failOutstanding(
            makeChildEnvelopeMalformedFailure(
              this.childId,
              "delegate-request-body-invalid",
            ),
          );
          return;
        }
        this.onDelegationRequest?.(
          this.childId,
          envelope.correlationId,
          parsed.value,
        );
        return;
      }
      const chunk = parseControlBody("delegate-request-chunk", envelope.body);
      if (!chunk.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "delegate-request-chunk-invalid",
          ),
        );
        return;
      }
      const task = this.delegateRequestAssembler.accept({
        ...chunk.value,
        transferId: `${envelope.correlationId}:${chunk.value.transferId}`,
      });
      if (task.isErr()) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            `delegate-request-chunk-${task.error.type}`,
          ),
        );
        return;
      }
      if (task.value === undefined) return;
      const parsed = parseControlBody("delegate-request", {
        agentName: chunk.value.agentName,
        task: task.value,
      });
      if (!parsed.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "delegate-request-body-invalid",
          ),
        );
        return;
      }
      this.onDelegationRequest?.(
        this.childId,
        envelope.correlationId,
        parsed.value,
      );
      return;
    }
    // `envelope.kind` is one of the closed `PiControlKind` enum, but the
    // remaining values (`bootstrap`, `cancel`, `delegate-response`) are
    // parent-to-child-only kinds a well-behaved
    // child never sends back to us. Receiving one here is always an
    // unknown/illegal incoming kind and must fail closed rather than be
    // silently ignored.
    if (ILLEGAL_INCOMING_KINDS.has(envelope.kind)) {
      this.failOutstanding(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "unexpected-incoming-kind",
        ),
      );
    }
  }

  /**
   * Sends a native Pi steering intervention through the correlated live RPC
   * channel; `sendLiveRpc` applies the child identity and lifecycle guards.
   */
  steer(
    childId: string,
    generationId: string,
    message: string,
  ): ResultAsync<void, PiAdapterFailure> {
    const validMessage = z
      .string()
      .min(1)
      .max(MAX_LIVE_RPC_MESSAGE_LENGTH)
      .safeParse(message);
    if (
      !validMessage.success ||
      new TextEncoder().encode(message).byteLength > MAX_LIVE_RPC_MESSAGE_LENGTH
    ) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "steer-message-invalid",
        ),
      );
    }
    return this.sendLiveRpc<undefined>(childId, generationId, "steer", {
      message: validMessage.data,
      images: [],
    }).map(() => {
      this.interventionCount += 1;
      this.notifyInterventionCount();
      return undefined;
    });
  }

  /**
   * Sends a native Pi follow-up through the correlated live RPC channel;
   * `sendLiveRpc` applies the child identity and lifecycle guards.
   */
  followUp(
    childId: string,
    generationId: string,
    message: string,
  ): ResultAsync<void, PiAdapterFailure> {
    const validMessage = z
      .string()
      .min(1)
      .max(MAX_LIVE_RPC_MESSAGE_LENGTH)
      .safeParse(message);
    if (
      !validMessage.success ||
      new TextEncoder().encode(message).byteLength > MAX_LIVE_RPC_MESSAGE_LENGTH
    ) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "follow-up-message-invalid",
        ),
      );
    }
    return this.sendLiveRpc<undefined>(childId, generationId, "follow_up", {
      message: validMessage.data,
      images: [],
    }).map(() => {
      this.interventionCount += 1;
      this.notifyInterventionCount();
      return undefined;
    });
  }

  /**
   * Reads a bounded transcript slice through Pi's correlated native RPC
   * channel; `sendLiveRpc` applies the child identity and lifecycle guards.
   */
  getEntries(
    childId: string,
    generationId: string,
    since?: string,
  ): ResultAsync<PiGetEntriesResult, PiAdapterFailure> {
    if (since !== undefined && !entryIdSchema.safeParse(since).success) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "get-entries-since-invalid",
        ),
      );
    }
    const payload: Record<string, JsonValue> = {};
    if (since !== undefined) payload.since = since;
    return this.sendLiveRpc<PiGetEntriesResult>(
      childId,
      generationId,
      "get_entries",
      payload,
    );
  }

  /**
   * Relays a normalized extension UI response through Pi's native correlated
   * channel. The request ID and live-session guards prevent stale responses;
   * UI responses are not authenticated envelope kinds.
   */
  sendExtensionUiResponse(
    childId: string,
    generationId: string,
    response: PiExtensionUiResponseInput,
  ): ResultAsync<void, PiAdapterFailure> {
    const normalized = normalizeExtensionUiResponse(response);
    if (normalized.isErr()) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "extension-ui-response-invalid",
        ),
      );
    }
    const guard = this.guardLiveSession(childId, generationId);
    if (guard.isErr()) return errAsync(guard.error);
    const requestId = normalized.value.id;
    if (!this.outstandingExtensionUiRequestIds.has(requestId)) {
      return errAsync(makeChildInteractionUnavailableFailure(this.childId));
    }
    const process = this.process;
    if (process === undefined) {
      return errAsync(makeChildInteractionUnavailableFailure(this.childId));
    }

    const encoded = Result.fromThrowable(
      () => new TextEncoder().encode(`${JSON.stringify(normalized.value)}\n`),
      () =>
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "extension-ui-response-invalid",
        ),
    )();
    if (encoded.isErr()) return errAsync(encoded.error);

    // Pi does not acknowledge this line. A write failure is therefore
    // terminal for the child, while a successful flushed write consumes the
    // ID once.
    return process
      .writeStdin(encoded.value)
      .mapErr(() =>
        makeChildSpawnFailedFailure(this.childId, "stdin-write-failed"),
      )
      .map(() => {
        this.outstandingExtensionUiRequestIds.delete(requestId);
        return undefined;
      })
      .orElse((failure) => {
        this.failOutstanding(failure);
        return errAsync(failure);
      });
  }

  /** Compatibility spelling for callers that use the native command name. */
  extensionUiResponse(
    childId: string,
    generationId: string,
    response: PiExtensionUiResponseInput,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.sendExtensionUiResponse(childId, generationId, response);
  }

  /** Answers a relayed delegation request through the authenticated private envelope channel. */
  sendDelegationResponse(
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.sendControl("delegate-response", correlationId, body);
  }

  private guardLiveSession(
    childId: string,
    generationId: string,
  ): Result<void, PiAdapterFailure> {
    if (
      childId !== this.childId ||
      generationId !== this.generationId ||
      this.disposed ||
      this.settled ||
      this.status !== "running" ||
      this.authState === undefined ||
      this.secret?.peek() === undefined ||
      this.process === undefined
    ) {
      return err(makeChildInteractionUnavailableFailure(this.childId));
    }
    return ok(undefined);
  }

  /**
   * Sends only native live commands. Private lifecycle and delegation traffic
   * must use `sendControl` instead; this path guards identity, lifecycle, and
   * correlated responses independently of envelope authentication.
   */
  private sendLiveRpc<T extends LiveRpcResult>(
    childId: string,
    generationId: string,
    command: "steer" | "follow_up" | "get_entries",
    payload: Record<string, JsonValue>,
  ): ResultAsync<T, PiAdapterFailure> {
    const guard = this.guardLiveSession(childId, generationId);
    if (guard.isErr()) return errAsync(guard.error);
    const process = this.process;
    if (process === undefined) {
      return errAsync(makeChildInteractionUnavailableFailure(this.childId));
    }
    const id = `${this.childId}:rpc:${this.liveRpcCounter + 1}:${generateNonceHex(this.randomPort)}`;
    this.liveRpcCounter += 1;
    if (id.length > MAX_LIVE_RPC_ID_LENGTH) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(this.childId, "rpc-id-too-long"),
      );
    }

    return new ResultAsync(
      new Promise((resolve) => {
        const pending: LiveRpcPending = {
          command,
          // Install the pending call before scheduling or writing. This keeps
          // synchronous timer/process test doubles from racing the map entry.
          timer: { cancel: () => undefined },
          resolve: (result) => resolve(result as Result<T, PiAdapterFailure>),
        };
        this.liveRpcPending.set(id, pending);
        pending.timer = this.timerPort.schedule(() => {
          this.settleLiveRpc(
            id,
            err(makeChildReplyMissingFailure(this.childId)),
          );
        }, this.replyTimeoutMs);
        // A synchronous timer callback may have settled the call already.
        if (!this.liveRpcPending.has(id)) return;

        const line = `${JSON.stringify({ id, type: command, ...payload })}\n`;
        void process
          .writeStdin(new TextEncoder().encode(line))
          .mapErr(() =>
            makeChildSpawnFailedFailure(this.childId, "stdin-write-failed"),
          )
          .match(
            () => undefined,
            (failure) => {
              this.settleLiveRpc(id, err(failure));
              this.failOutstanding(failure);
            },
          );
      }),
    );
  }

  private handleLiveRpcResponse(record: Record<string, JsonValue>): void {
    const responseId = record.id;
    if (typeof responseId !== "string") return;
    const pending = this.liveRpcPending.get(responseId);
    // Unknown ids are late or duplicate replies. They must not affect a new
    // call, its count, or the child's lifecycle.
    if (pending === undefined) return;
    const parsed = LiveRpcResponseSchema.safeParse(record);
    if (!parsed.success) {
      this.settleLiveRpc(
        responseId,
        err(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "rpc-response-invalid",
          ),
        ),
      );
      return;
    }
    if (parsed.data.command !== pending.command) {
      this.settleLiveRpc(
        parsed.data.id,
        err(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "rpc-command-mismatch",
          ),
        ),
      );
      return;
    }
    if (!parsed.data.success) {
      this.settleLiveRpc(
        parsed.data.id,
        err(makeChildInteractionUnavailableFailure(this.childId)),
      );
      return;
    }
    const result =
      pending.command === "get_entries"
        ? this.parseGetEntriesResponse(record)
        : ok(undefined);
    this.settleLiveRpc(parsed.data.id, result);
  }

  private parseGetEntriesResponse(
    record: Record<string, JsonValue>,
  ): Result<PiGetEntriesResult, PiAdapterFailure> {
    const responseBytes = encodedJsonByteLength(record as JsonValue);
    if (responseBytes === undefined || responseBytes > MAX_GET_ENTRIES_BYTES) {
      return err(
        makeChildEnvelopeMalformedFailure(this.childId, "entries-too-large"),
      );
    }

    const parsed = PiGetEntriesDataSchema.safeParse(record.data);
    if (!parsed.success) {
      return err(
        makeChildEnvelopeMalformedFailure(this.childId, "entries-data-invalid"),
      );
    }
    return ok({ entries: parsed.data.entries, leafId: parsed.data.leafId });
  }

  private settleLiveRpc(
    id: string,
    result: Result<LiveRpcResult, PiAdapterFailure>,
  ): void {
    const pending = this.liveRpcPending.get(id);
    if (pending === undefined) return;
    this.liveRpcPending.delete(id);
    pending.timer.cancel();
    pending.resolve(result);
  }

  private rejectLiveRpc(failure: PiAdapterFailure): void {
    for (const [id, pending] of this.liveRpcPending) {
      this.liveRpcPending.delete(id);
      pending.timer.cancel();
      pending.resolve(err(failure));
    }
  }

  private notifyInterventionCount(): void {
    const callback = this.onInterventionCountChanged;
    if (callback === undefined) return;
    Result.fromThrowable(
      () => callback(this.interventionCount),
      () => undefined,
    )();
  }

  /**
   * The single terminal-cancellation path (Pi adapter contract): resolves this
   * child's own outstanding settlement wait (`runTask()`/`awaitSettlement`)
   * with a structured `{ outcome: "cancelled" }` result - never an error -
   * and resolves the bounded `cancel()` wait too, before terminating
   * resources. Reachable from every legitimate way a requested
   * cancellation can actually conclude: an authenticated `cancelled` ack,
   * a racing `settled` report for the aborted turn, the process exiting
   * mid-cancellation, or the bounded grace period elapsing with no reply
   * at all. Idempotent via the same `settled` guard as normal settlement.
   */
  private completeCancellation(): void {
    if (this.settled) return;
    this.settled = true;
    this.status = "cancelled";
    const settlementResolvers = this.settlementResolvers;
    this.settlementResolvers = undefined;
    if (settlementResolvers !== undefined) {
      // A task was genuinely dispatched and running - Pi adapter contract
      // requires cancelling an ordinary helper to resolve as a structured
      // cancelled result, never an error.
      settlementResolvers.resolve({ outcome: "cancelled" });
    } else {
      // Cancelled before the child ever reached a running task (still
      // handshaking or awaiting its bootstrap-ack) - there is no
      // in-flight task to report a structured cancelled *settlement* for,
      // so the caller's own spawn/handshake/bootstrap wait must still
      // fail closed rather than hang forever with nothing to resolve it.
      const failure = makeChildAbortFailedFailure(
        this.childId,
        "cancelled-before-running",
      );
      const handshakeResolvers = this.handshakeResolvers;
      this.handshakeResolvers = undefined;
      handshakeResolvers?.reject(failure);
      const bootstrapAckResolvers = this.bootstrapAckResolvers;
      this.bootstrapAckResolvers = undefined;
      bootstrapAckResolvers?.reject(failure);
    }
    const cancelResolvers = this.cancelResolvers;
    this.cancelResolvers = undefined;
    cancelResolvers?.resolve();
    this.terminateResources();
  }

  private handleOutputTransferChunk(envelope: PiControlEnvelope): void {
    const parsed = parseControlBody("transfer-chunk", envelope.body);
    if (
      !parsed.ok ||
      parsed.value.channel !== "output" ||
      parsed.value.transferId !== envelope.correlationId
    ) {
      void this.sendControl("transfer-result", envelope.correlationId, {
        channel: "output",
        transferId: envelope.correlationId,
        status: "nack",
        reason: "malformed-chunk",
      }).mapErr((failure) => {
        this.failOutstanding(failure);
        return failure;
      });
      return;
    }

    const accepted = this.outputTransferAssembler.accept(
      parsed.value as PiTransferChunkBody,
    );
    if (accepted.isErr()) {
      this.outputTransferAssembler.drop(parsed.value.transferId);
      void this.sendControl("transfer-result", parsed.value.transferId, {
        channel: "output",
        transferId: parsed.value.transferId,
        status: "nack",
        reason: accepted.error.reason,
      }).mapErr((failure) => {
        this.failOutstanding(failure);
        return failure;
      });
      return;
    }
    if (accepted.value === undefined) return;

    this.completedOutputTransfers.set(parsed.value.transferId, accepted.value);
    void this.sendControl("transfer-result", parsed.value.transferId, {
      channel: "output",
      transferId: parsed.value.transferId,
      status: "ack",
    }).mapErr((failure) => {
      this.completedOutputTransfers.delete(parsed.value.transferId);
      this.failOutstanding(failure);
      return failure;
    });
  }

  private completeSettlement(envelope: PiControlEnvelope): void {
    if (this.settled) {
      this.failOutstanding(makeChildReplyDuplicateFailure(this.childId));
      return;
    }
    const parsed = parseControlBody("settled", envelope.body);
    if (!parsed.ok) {
      this.failOutstanding(
        makeChildEnvelopeMalformedFailure(this.childId, "settled-body-invalid"),
      );
      return;
    }
    const completed =
      parsed.value.outcome === "completed" ? parsed.value : undefined;
    let privateOutput = "";
    // A private output transfer is an optimisation, not the settlement
    // authority. If it is missing or corrupt, retain the bounded inline
    // projection and settle normally; otherwise a delivery hiccup would
    // incorrectly turn a completed child into ChildDeliveryFailed.
    let outputTransferUsable = true;
    if (completed !== undefined) {
      if (completed.outputTransferId !== undefined) {
        const transferred = this.completedOutputTransfers.get(
          completed.outputTransferId,
        );
        if (transferred === undefined) {
          outputTransferUsable = false;
        } else {
          this.completedOutputTransfers.delete(completed.outputTransferId);
          privateOutput = transferred;
        }
      }
      if (privateOutput === "") {
        privateOutput =
          completed.assistantOutput ?? this.latestCompletedAssistantOutput;
      }
      const actualByteLength = new TextEncoder().encode(
        privateOutput,
      ).byteLength;
      if (
        outputTransferUsable &&
        completed.outputByteLength !== undefined &&
        completed.outputByteLength !== actualByteLength
      ) {
        outputTransferUsable = false;
        privateOutput =
          completed.assistantOutput ?? this.latestCompletedAssistantOutput;
      }
    }

    const finish = (): void => {
      this.settled = true;
      this.status = "completed";
      const interventionCount = this.interventionCount;
      const settlement: PiChildSettlement =
        parsed.value.outcome === "failed"
          ? { outcome: "failed", reason: parsed.value.reason ?? "unknown" }
          : {
              outcome: "completed",
              // Only this bounded projection crosses to the parent model.
              summary:
                parsed.value.assistantOutput ??
                truncateLatestOutput(privateOutput),
              ...(parsed.value.completionCandidate !== undefined
                ? { completionCandidate: parsed.value.completionCandidate }
                : {}),
              ...(outputTransferUsable && parsed.value.outputByteLength !== undefined
                ? { outputByteLength: parsed.value.outputByteLength }
                : {}),
              interventionCount,
            };
      const resolvers = this.settlementResolvers;
      this.settlementResolvers = undefined;
      resolvers?.resolve(settlement);
      // A settled child is done for good - kill the now-ephemeral process
      // and erase its secret immediately rather than leaving it running
      // until some later, unrelated cleanup call happens to arrive.
      this.terminateResources();
    };

    const capture = this.onPrivateOutput;
    if (capture === undefined || parsed.value.outcome === "failed") {
      finish();
      return;
    }
    const invoked = Result.fromThrowable(
      () =>
        capture({
          output: privateOutput,
          byteLength: new TextEncoder().encode(privateOutput).byteLength,
        }),
      () => makeChildInteractionUnavailableFailure(this.childId),
    )();
    if (invoked.isErr()) {
      this.failOutstanding(invoked.error);
      return;
    }
    if (invoked.value instanceof ResultAsync) {
      void invoked.value.match(
        () => finish(),
        (failure) => this.failOutstanding(failure),
      );
      return;
    }
    if (invoked.value.isErr()) {
      this.failOutstanding(invoked.value.error);
      return;
    }
    finish();
  }

  private normalizeUiRequestForSession(
    record: Record<string, JsonValue>,
  ): Result<Record<string, JsonValue>, PiAdapterFailure> {
    if (record.type !== "extension_ui_request") return ok(record);

    // Scripted/test hosts and older Pi builds may already emit Weave's
    // normalized request shape. Preserve it exactly; only native Pi requests
    // (`id` + `method`) need translation.
    if (parsePiChildSessionEvent(record).success) return ok(record);

    const normalized = normalizePiExtensionUiRequest(record);
    if (normalized.isErr()) {
      return err(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          `extension-ui-${normalized.error.code}`,
        ),
      );
    }
    return ok(normalized.value as unknown as Record<string, JsonValue>);
  }

  private handleOrdinaryEvent(json: JsonValue): void {
    if (typeof json !== "object" || json === null || Array.isArray(json))
      return;
    const record = json as Record<string, JsonValue>;
    if (record.type === "response") {
      this.handleLiveRpcResponse(record);
      return;
    }
    const normalized = this.normalizeUiRequestForSession(record);
    if (normalized.isErr()) {
      this.failOutstanding(normalized.error);
      return;
    }
    const parsed = parsePiChildSessionEvent(normalized.value);
    if (parsed.success) {
      this.renewSettlementTimeout();
      if (
        parsed.data.type === "extension_ui_request" &&
        parsed.data.requestType === "dialog" &&
        this.status === "running" &&
        !this.disposed
      ) {
        this.outstandingExtensionUiRequestIds.add(
          parsed.data.requestId as string,
        );
      }
      this.forwardSessionEvent(parsed.data);
    }
    const type = normalized.value.type;
    if (type === "turn_start") {
      this.currentTurn += 1;
      // Keep the prior turn visible until this turn produces replacement text.
      // Clearing here makes the preview flash briefly and then disappear while
      // the child starts its next model or tool step.
      this.resetPreviewOnNextDelta = true;
      this.onStreamingUpdate?.(this.snapshot());
      return;
    }
    if (type === "tool_execution_start") {
      const toolName = (normalized.value as Record<string, JsonValue>).toolName;
      if (typeof toolName === "string") this.currentTool = toolName;
      this.onStreamingUpdate?.(this.snapshot());
      return;
    }
    if (type === "tool_execution_end") {
      this.currentTool = undefined;
      this.onStreamingUpdate?.(this.snapshot());
      return;
    }
    if (type === "message_update") {
      const preview = extractAssistantTextDeltaPreview(record);
      if (preview !== undefined) {
        if (this.resetPreviewOnNextDelta) {
          this.latestOutput = "";
          this.latestThinking = "";
          this.resetPreviewOnNextDelta = false;
        }
        // Accumulate streamed deltas into the current transient buffer
        // rather than replacing it with only the very last delta -
        // `truncateLatestOutput` keeps the combined buffer bounded to
        // <=4KiB of valid UTF-8 at a code-point boundary.
        this.latestOutput = truncateLatestOutput(this.latestOutput + preview);
        // Real answer text always wins over reasoning: once the model
        // starts speaking, the thinking buffer stops being what the parent
        // shows, so drop it instead of letting it linger behind the text.
        this.latestThinking = "";
        this.onStreamingUpdate?.(this.snapshot());
        return;
      }
      const thinking = extractAssistantThinkingDeltaPreview(record);
      if (thinking !== undefined) {
        if (this.resetPreviewOnNextDelta) {
          this.latestOutput = "";
          this.latestThinking = "";
          this.resetPreviewOnNextDelta = false;
        }
        this.latestThinking = truncateLatestOutput(
          this.latestThinking + thinking,
        );
        // Only surface reasoning while there is no visible answer text yet -
        // a reasoning model can think for a long time before its first
        // token, and an empty preview makes a working child look frozen.
        if (this.latestOutput.length === 0) {
          this.onStreamingUpdate?.(this.snapshot());
        }
      }
      return;
    }
    if (type === "message_end") {
      const assistantOutput = extractCompletedAssistantText(record.message);
      if (assistantOutput !== undefined)
        this.latestCompletedAssistantOutput = assistantOutput;
      this.projectUsageFromMessage(record);
      return;
    }
    if (type === "agent_settled") this.projectUsageFromMessage(record);
  }

  /**
   * Delivers only parser-approved, bounded events to the injected observer.
   * Observer failures are deliberately collapsed to a safe child failure: an
   * observer must not be able to leak event payloads through logs or errors.
   */
  private forwardSessionEvent(event: PiChildSessionEvent): void {
    const observer = this.sessionObserver;
    if (observer === undefined || this.disposed) return;

    const callback = Result.fromThrowable(
      () => observer.onEvent(event),
      () => makeChildInteractionUnavailableFailure(this.childId),
    )();
    if (callback.isErr()) {
      this.handleSessionObserverFailure();
      return;
    }

    const result = callback.value;
    if (result instanceof ResultAsync) {
      void ResultAsync.fromPromise(result, () =>
        makeChildInteractionUnavailableFailure(this.childId),
      ).match(
        () => undefined,
        () => this.handleSessionObserverFailure(),
      );
      return;
    }
    if (result.isErr()) this.handleSessionObserverFailure();
  }

  private handleSessionObserverFailure(): void {
    if (this.disposed) return;
    const failure = makeChildInteractionUnavailableFailure(this.childId);
    this.logger.warn(
      { childId: this.childId, code: failure.code },
      "child session observer failed",
    );
    this.failOutstanding(failure);
  }

  private projectUsageFromMessage(record: Record<string, JsonValue>): void {
    const message = record.message;
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    )
      return;
    const messageRecord = message as Record<string, JsonValue>;
    if (messageRecord.role !== "assistant") return;
    const idCandidate = messageRecord.id ?? messageRecord.responseId;
    if (typeof idCandidate !== "string" || idCandidate.length === 0) return;
    const id = idCandidate;
    if (this.seenUsageMessageIds.has(id)) return;
    const usageValue = messageRecord.usage;
    if (
      typeof usageValue !== "object" ||
      usageValue === null ||
      Array.isArray(usageValue)
    )
      return;
    const usageRecord = usageValue as Record<string, JsonValue>;
    this.seenUsageMessageIds.add(id);
    const projected = {
      inputTokens: safeNumberField(usageRecord, "input"),
      outputTokens: safeNumberField(usageRecord, "output"),
      cacheReadTokens: safeNumberField(usageRecord, "cacheRead"),
      cacheWriteTokens: safeNumberField(usageRecord, "cacheWrite"),
      cost: extractCostTotal(usageRecord),
    };
    this.usage = addUsage(this.usage, projected);
    this.onAssistantUsageObserved?.({ id, ...projected });
  }

  private awaitHandshake(): ResultAsync<void, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          this.failOutstanding(makeChildHandshakeMissingFailure(this.childId));
        }, this.handshakeTimeoutMs);
        this.handshakeResolvers = {
          resolve: () => {
            timer.cancel();
            resolve(ok(undefined));
          },
          reject: (failure) => {
            timer.cancel();
            resolve(err(failure));
          },
        };
      }),
    );
  }

  private sendControl(
    kind: PiControlKind,
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiAdapterFailure> {
    const secretBytes = this.secret?.peek();
    const authState = this.authState;
    if (
      secretBytes === undefined ||
      authState === undefined ||
      this.process === undefined
    ) {
      return errAsync(
        makeChildAuthenticationFailedFailure(
          this.childId,
          "secret unavailable",
        ),
      );
    }
    const sequence = authState.allocateOutgoingSequence();
    return signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "parent-to-child",
        sequence,
        nonce: generateNonceHex(this.randomPort),
        correlationId,
        kind,
        body,
      },
      secretBytes,
      this.hmacPort,
    )
      .mapErr(
        (envelopeError): PiAdapterFailure =>
          makeChildEnvelopeMalformedFailure(this.childId, envelopeError.type),
      )
      .andThen((envelope) => this.deliverControlEnvelope(envelope))
      .orElse((failure) => {
        authState.releaseOutgoingSequence(sequence);
        return errAsync(failure);
      });
  }

  private deliverControlEnvelope(
    envelope: PiControlEnvelope,
  ): ResultAsync<void, PiAdapterFailure> {
    const process = this.process;
    if (process === undefined) {
      return errAsync(
        makeChildAuthenticationFailedFailure(
          this.childId,
          "process unavailable",
        ),
      );
    }
    const commandLine = `${JSON.stringify({
      type: "prompt",
      message: `/weave:__control__ ${JSON.stringify(envelope)}`,
    })}\n`;
    return process
      .writeStdin(new TextEncoder().encode(commandLine))
      .mapErr((failure) =>
        makeChildSpawnFailedFailure(this.childId, failure.reason),
      );
  }

  /**
   * Sends the bootstrap descriptor and waits for the child's authenticated
   * `bootstrap-ack` before sending any task work, then awaits authenticated
   * settlement. Never sends work on the strength of the bootstrap send
   * alone. Both waits are installed *before* the corresponding send, so a
   * synchronous/fast reply can never race ahead of the resolver meant to
   * catch it (Pi adapter contract).
   */
  runTask(
    input: PiRpcChildSpawnInput,
    bootstrap: JsonValue,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    if (input.task.length < 1) {
      const failure = makeChildEnvelopeMalformedFailure(
        this.childId,
        "task-empty",
      );
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    // Re-parses what this parent itself is about to send, so the ack
    // validation below has a trustworthy expectation to compare against
    // rather than trusting the caller-supplied `bootstrap` value blindly
    // (Pi adapter contract).
    const expectedBootstrap = parseControlBody("bootstrap", bootstrap);
    if (!expectedBootstrap.ok) {
      const failure = makeChildEnvelopeMalformedFailure(
        this.childId,
        "bootstrap-body-invalid",
      );
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    this.status = "bootstrapping";
    const bootstrapAckWait = this.awaitBootstrapAck();
    return this.sendControl("bootstrap", input.childId, bootstrap)
      .andThen(() => bootstrapAckWait)
      .andThen((ack) => this.validateBootstrapAck(expectedBootstrap.value, ack))
      .andThen(() => this.verifyRestoreContext())
      .andThen(() => {
        const settlementWait = this.awaitSettlement();
        return this.sendTaskPrompt(input.task).andThen(() => settlementWait);
      })
      .orElse((failure) => {
        this.failOutstanding(failure);
        return errAsync(failure);
      });
  }

  /**
   * Verifies that a restored child is still on the exact persisted active
   * leaf. Pi exposes no safe in-place branch-selection RPC, so a mismatch is
   * terminal rather than an invitation to issue an unsupported switch/fork.
   */
  private verifyRestoreContext(): ResultAsync<void, PiAdapterFailure> {
    const restore = this.restoreSession;
    if (restore === undefined) return okAsync(undefined);

    const activeLeafId = validateSpawnSessionId(restore.activeLeafId);
    if (activeLeafId.isErr()) {
      return errAsync(
        makeChildAuthenticationFailedFailure(
          this.childId,
          "restore-active-leaf-unknown",
        ),
      );
    }

    return this.getEntries(
      this.childId,
      this.generationId,
      activeLeafId.value,
    ).andThen((entries) => {
      if (entries.leafId !== activeLeafId.value) {
        return errAsync(
          makeChildAuthenticationFailedFailure(
            this.childId,
            "restore-active-leaf-mismatch",
          ),
        );
      }
      return this.notifyRestoreContextVerified({
        activeLeafId: activeLeafId.value,
        ...(restore.checkpointCursor === undefined
          ? {}
          : { checkpointCursor: restore.checkpointCursor }),
      });
    });
  }

  /** Delivers only bounded restore metadata; observer failure blocks task send. */
  private notifyRestoreContextVerified(
    metadata: PiRestoreContextMetadata,
  ): ResultAsync<void, PiAdapterFailure> {
    const observer = this.onRestoreContextVerified;
    if (observer === undefined) return okAsync(undefined);

    const observerFailure = () =>
      makeChildInteractionUnavailableFailure(this.childId);
    const callback = Result.fromThrowable(
      () => observer(metadata),
      observerFailure,
    )();
    if (callback.isErr()) return errAsync(callback.error);

    if (callback.value instanceof ResultAsync) {
      return ResultAsync.fromPromise(callback.value, observerFailure).andThen(
        (result) =>
          result.isErr() ? errAsync(observerFailure()) : okAsync(undefined),
      );
    }
    return callback.value.isErr()
      ? errAsync(observerFailure())
      : okAsync(undefined);
  }

  /** Verifies the concrete model identity when the parent supplied one. */
  private validateBootstrapAck(
    expected: PiBootstrapBody,
    ack: PiBootstrapAckBody,
  ): ResultAsync<void, PiAdapterFailure> {
    // Only enforced when this parent itself resolved a concrete model
    // identity (root-level delegation): the child must apply and echo
    // back exactly that identity, no substitutions. When this parent sent
    // no `resolvedModel` (nested/relayed delegation), the child resolved
    // against its own authenticated catalog and its ack is informational
    // only - Pi adapter contract graceful degradation applies, so no match is
    // required here.
    if (expected.resolvedModel !== undefined) {
      const modelMatches =
        ack.resolvedModel !== undefined &&
        expected.resolvedModel.provider === ack.resolvedModel.provider &&
        expected.resolvedModel.id === ack.resolvedModel.id;
      if (!modelMatches) {
        return errAsync(
          makeChildAuthenticationFailedFailure(
            this.childId,
            "bootstrap-ack-model-mismatch",
          ),
        );
      }
    }
    return okAsync(undefined);
  }

  private awaitBootstrapAck(): ResultAsync<
    PiBootstrapAckBody,
    PiAdapterFailure
  > {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          this.failOutstanding(makeChildReplyMissingFailure(this.childId));
        }, this.replyTimeoutMs);
        this.bootstrapAckResolvers = {
          resolve: (body) => {
            timer.cancel();
            resolve(ok(body));
          },
          reject: (failure) => {
            timer.cancel();
            resolve(err(failure));
          },
        };
      }),
    );
  }

  private sendTaskPrompt(task: string): ResultAsync<void, PiAdapterFailure> {
    if (task.length < 1) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(this.childId, "task-empty"),
      );
    }
    const encoder = new TextEncoder();
    const directLine = `${JSON.stringify({ type: "prompt", message: task })}\n`;
    if (encoder.encode(directLine).length <= MAX_OUTBOUND_PROMPT_RECORD_BYTES) {
      return this.writePromptLine(directLine);
    }
    const taskBytes = encoder.encode(task).byteLength;
    if (taskBytes > PI_TRANSPORT_LIMITS.transferAggregateBytes) {
      return errAsync(
        makeChildTransferTooLargeFailure(this.childId, "prompt", taskBytes),
      );
    }
    return this.sendPromptTransferAttempt(task, 0);
  }

  private sendPromptTransferAttempt(
    task: string,
    attempt: number,
  ): ResultAsync<void, PiAdapterFailure> {
    this.promptTransferCounter += 1;
    const transferId = `${this.childId}:${this.promptTransferCounter}:${generateNonceHex(this.randomPort)}`;
    const chunks = encodePromptChunksBounded(task, transferId);
    if (chunks.isErr()) {
      return errAsync(
        makeChildDeliveryFailedFailure(this.childId, "prompt", "encode-failed"),
      );
    }

    // Install the waiter before writing any chunk: a fast child can ACK in
    // the same turn as the final write and must never race past its resolver.
    const acknowledged = this.awaitPromptTransferResult(transferId);
    let writes: ResultAsync<void, PiAdapterFailure> = okAsync(undefined);
    for (const chunk of chunks.value) {
      const line = `${JSON.stringify({
        type: "prompt",
        message: `${PROMPT_CHUNK_COMMAND} ${JSON.stringify(chunk)}`,
      })}\n`;
      writes = writes.andThen(() => this.writePromptLine(line));
    }

    return writes
      .orElse((failure) => {
        if (this.promptTransferResolvers?.transferId === transferId) {
          this.promptTransferResolvers.reject(failure);
        }
        return errAsync(failure);
      })
      .andThen(() => acknowledged)
      .map(() => undefined)
      .orElse((failure) => {
        if (attempt < PI_TRANSPORT_LIMITS.transferMaxRetries) {
          return this.sendPromptTransferAttempt(task, attempt + 1);
        }
        return errAsync(failure);
      });
  }

  private awaitPromptTransferResult(
    transferId: string,
  ): ResultAsync<PiTransferResultBody, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          if (this.promptTransferResolvers?.transferId !== transferId) return;
          this.promptTransferResolvers = undefined;
          resolve(
            err(makeChildTransferTimedOutFailure(this.childId, "prompt")),
          );
        }, PI_TRANSPORT_LIMITS.transferAckTimeoutMs);
        this.promptTransferResolvers = {
          transferId,
          resolve: (body) => {
            timer.cancel();
            resolve(ok(body));
          },
          reject: (failure) => {
            timer.cancel();
            this.promptTransferResolvers = undefined;
            resolve(err(failure));
          },
        };
      }),
    );
  }

  private writePromptLine(line: string): ResultAsync<void, PiAdapterFailure> {
    const process = this.process;
    if (process === undefined) {
      return errAsync(
        makeChildDeliveryFailedFailure(
          this.childId,
          "prompt",
          "process-unavailable",
        ),
      );
    }
    return process
      .writeStdin(new TextEncoder().encode(line))
      .mapErr(() =>
        makeChildDeliveryFailedFailure(this.childId, "prompt", "write-failed"),
      );
  }

  private awaitSettlement(): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        this.settlementResolvers = {
          resolve: (settlement) => {
            this.clearSettlementTimeout();
            resolve(ok(settlement));
          },
          reject: (failure) => {
            this.clearSettlementTimeout();
            resolve(err(failure));
          },
        };
        this.renewSettlementTimeout();
      }),
    );
  }

  /**
   * Treats the settlement budget as an inactivity timeout, not a hard runtime
   * cap. A child that keeps sending parser-approved session events or
   * authenticated control envelopes is still making observable progress and
   * must not be killed merely because its task lasts longer than the budget.
   */
  private renewSettlementTimeout(): void {
    if (
      this.disposed ||
      this.status !== "running" ||
      this.settlementResolvers === undefined
    ) {
      return;
    }
    this.clearSettlementTimeout();
    this.settlementTimer = this.timerPort.schedule(() => {
      this.settlementTimer = undefined;
      this.failOutstanding(makeChildSettlementMissingFailure(this.childId));
    }, this.settlementTimeoutMs);
  }

  private clearSettlementTimeout(): void {
    this.settlementTimer?.cancel();
    this.settlementTimer = undefined;
  }

  /**
   * The single terminal-failure path: rejects every outstanding waiter
   * with `failure`, then kills the process and erases the secret. Safe to
   * call more than once (idempotent via the same `disposed` guard as
   * `dispose`) and preserves the `"failed"` status against later
   * cleanup calls, so the child's final snapshot stays inspectable.
   */
  private failOutstanding(failure: PiAdapterFailure): void {
    if (this.disposed) return;
    this.status = "failed";
    this.rejectOutstanding(failure);
    this.terminateResources();
  }

  private rejectOutstanding(failure: PiAdapterFailure): void {
    this.rejectLiveRpc(failure);
    const handshakeResolvers = this.handshakeResolvers;
    this.handshakeResolvers = undefined;
    handshakeResolvers?.reject(failure);
    const bootstrapAckResolvers = this.bootstrapAckResolvers;
    this.bootstrapAckResolvers = undefined;
    bootstrapAckResolvers?.reject(failure);
    const promptTransferResolvers = this.promptTransferResolvers;
    this.promptTransferResolvers = undefined;
    promptTransferResolvers?.reject(failure);
    const settlementResolvers = this.settlementResolvers;
    this.settlementResolvers = undefined;
    settlementResolvers?.reject(failure);
    const cancelResolvers = this.cancelResolvers;
    this.cancelResolvers = undefined;
    cancelResolvers?.resolve();
  }

  /**
   * The single terminal cleanup step (Pi adapter contract): force-kills
   * the process (if any) and erases the secret/auth state. Idempotent;
   * never touches `status`. Always uses {@link PiSpawnedChildProcess.forceKill}
   * rather than the cooperative default `kill()` - this is the *only*
   * place any child process is ever terminated, and a non-cooperative or
   * stopped (`SIGSTOP`'d) child must not be able to survive it (the exact
   * bug a plain default-signal `kill()` here previously allowed: a
   * stopped child left `T+` in `ps` well past the bounded cancellation
   * grace, never actually reaped).
   */
  private terminateResources(): void {
    this.outstandingExtensionUiRequestIds.clear();
    if (this.disposed) return;
    this.rejectLiveRpc(makeChildReplyLateFailure(this.childId));
    this.disposed = true;
    this.process?.forceKill();
    this.secret?.dispose();
    this.secret = undefined;
    this.authState?.dispose();
    this.authState = undefined;
  }

  /**
   * Cancels this child: sends the authenticated `cancel` envelope *before*
   * the ordinary RPC `abort` command (Pi adapter contract), then waits boundedly
   * for either an authenticated `cancelled` ack or process exit, and only
   * then force-kills if neither arrived in time. Guarantees termination of
   * the underlying process on every path - authenticated notice delivered
   * or not.
   */
  cancel(): ResultAsync<void, PiAdapterFailure> {
    if (this.disposed || this.settled)
      return new ResultAsync(Promise.resolve(ok(undefined)));
    this.status = "cancelling";
    return this.sendControl("cancel", this.childId, {
      reason: "cancelled-by-parent",
    })
      .orElse((failure) => {
        this.logger.warn(
          { childId: this.childId, code: failure.code },
          "authenticated cancel notice failed to deliver; proceeding to raw abort and bounded force-kill",
        );
        return new ResultAsync(Promise.resolve(ok(undefined)));
      })
      .andThen(() => {
        const process = this.process;
        const abortWrite =
          process === undefined
            ? okAsync(undefined)
            : process
                .writeStdin(
                  new TextEncoder().encode(
                    `${JSON.stringify({ type: "abort" })}\n`,
                  ),
                )
                .orElse((failure) => {
                  this.logger.warn(
                    { childId: this.childId, code: failure.type },
                    "raw abort command failed to write; proceeding to bounded force-kill regardless",
                  );
                  return okAsync(undefined);
                });
        return abortWrite.andThen(() => this.waitBoundedThenForceKill());
      });
  }

  private waitBoundedThenForceKill(): ResultAsync<void, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          // Neither an authenticated `cancelled`/`settled` reply nor a
          // process exit arrived in time - force-kill, but this is still a
          // legitimate, requested cancellation (Pi adapter contract), so it must
          // still resolve as a structured cancelled result, never as an
          // abort-failed error.
          this.cancelResolvers = undefined;
          this.completeCancellation();
          resolve(ok(undefined));
        }, this.cancelGraceMs);
        this.cancelResolvers = {
          // `completeCancellation()` (the only caller of this resolver, from
          // `dispatchControlKind`'s `cancelled`/raced-`settled` handling or
          // `handleProcessExit`) has already finalized status/settlement and
          // terminated resources by the time this runs - just clear the
          // timer and settle this bounded wait.
          resolve: () => {
            timer.cancel();
            resolve(ok(undefined));
          },
        };
      }),
    );
  }

  /** Idempotent terminal cleanup: kills the process if still alive and zeroes the secret. Safe to call more than once. Never overwrites a status already made terminal by `failOutstanding`/settlement. */
  dispose(): void {
    if (this.disposed) return;
    this.delegateRequestAssembler.clear();
    if (this.status !== "completed" && this.status !== "failed") {
      this.status = "cancelled";
    }
    // Any caller still awaiting handshake/bootstrap-ack/settlement must
    // never hang forever past a terminal disposal - reject with a closed
    // abort failure instead.
    this.rejectOutstanding(
      makeChildAbortFailedFailure(this.childId, "disposed"),
    );
    this.terminateResources();
  }
}

type NativeExtensionUiResponse = {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly cancelled?: true;
  readonly confirmed?: boolean;
  readonly value?: JsonValue;
};

const NORMALIZED_EXTENSION_UI_RESPONSE_KEYS = new Set([
  "type",
  "requestId",
  "response",
  "cancelled",
  "error",
]);

/**
 * Converts the bounded normalized shape into Pi's deliberately smaller native
 * shape. In particular, never spread normalized input into the native line:
 * Task 2's schema preserves bounded extension fields for callers, but Pi only
 * accepts cancellation, `confirmed`, or `value` here.
 */
function normalizeExtensionUiResponse(
  input: PiExtensionUiResponseInput,
): Result<NativeExtensionUiResponse, "invalid"> {
  const parsed = Result.fromThrowable(
    () => PiExtensionUiResponseSchema.safeParse(input),
    () => "invalid" as const,
  )();
  if (
    parsed.isErr() ||
    !parsed.value.success ||
    Object.keys(parsed.value.data).some(
      (key) => !NORMALIZED_EXTENSION_UI_RESPONSE_KEYS.has(key),
    )
  ) {
    return err("invalid");
  }
  if (parsed.value.data.error !== undefined) return err("invalid");
  const requestId = parsed.value.data.requestId as string;

  const response = parsed.value.data.response as JsonValue | undefined;
  if (parsed.value.data.cancelled === true) {
    // A cancelled request has no second native result. Rejecting mixed input
    // keeps a caller from smuggling a value alongside cancellation.
    if (response !== undefined) return err("invalid");
    return ok({
      type: "extension_ui_response",
      id: requestId,
      cancelled: true,
    });
  }
  if (response === undefined) return err("invalid");
  if (!isBoundedJson(response)) return err("invalid");

  if (typeof response === "boolean") {
    return ok({
      type: "extension_ui_response",
      id: requestId,
      confirmed: response,
    });
  }
  if (isJsonRecord(response)) {
    const keys = Object.keys(response);
    if (
      keys.length === 1 &&
      keys[0] === "confirmed" &&
      typeof response.confirmed === "boolean"
    ) {
      return ok({
        type: "extension_ui_response",
        id: requestId,
        confirmed: response.confirmed,
      });
    }
    if (keys.length === 1 && keys[0] === "value") {
      const value = response.value;
      if (value !== undefined && isBoundedJson(value)) {
        return ok({
          type: "extension_ui_response",
          id: requestId,
          value,
        });
      }
      return err("invalid");
    }
  }
  return ok({
    type: "extension_ui_response",
    id: requestId,
    value: response,
  });
}

function extractCompletedAssistantText(message: JsonValue): string | undefined {
  if (!isJsonRecord(message) || message.role !== "assistant") return undefined;

  const content = message.content;
  if (typeof content === "string") return truncateLatestOutput(content);
  if (!Array.isArray(content)) return "";

  let containsToolUse = false;
  let hasTerminalText = false;
  let text = "";
  for (const block of content) {
    if (!isJsonRecord(block)) continue;
    const type = block.type;
    if (typeof type !== "string") continue;
    const normalizedType = type.toLowerCase();
    if (
      normalizedType.includes("tool") ||
      normalizedType.includes("function_call") ||
      normalizedType.includes("functioncall")
    ) {
      containsToolUse = true;
      continue;
    }
    if (type !== "text" || typeof block.text !== "string") continue;
    if (block.text.length > 0) hasTerminalText = true;
    text += block.text;
  }

  if (containsToolUse || !hasTerminalText) return "";
  return truncateLatestOutput(text);
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedJson(value: JsonValue, depth = 0): boolean {
  if (depth > MAX_LIVE_JSON_DEPTH) return false;
  if (typeof value === "string")
    return value.length <= MAX_LIVE_RPC_MESSAGE_LENGTH;
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return true;
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_GET_ENTRIES &&
      value.every((entry) => isBoundedJson(entry, depth + 1))
    );
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_GET_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        key.length <= MAX_LIVE_RPC_ID_LENGTH && isBoundedJson(entry, depth + 1),
    )
  );
}

function isBoundedGetEntriesJson(value: JsonValue, depth = 0): boolean {
  if (value === undefined || depth > MAX_LIVE_JSON_DEPTH) return false;
  if (typeof value === "string")
    return (
      new TextEncoder().encode(value).byteLength <= MAX_LIVE_RPC_MESSAGE_LENGTH
    );
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_GET_ENTRIES &&
      value.every((entry) => isBoundedGetEntriesJson(entry, depth + 1))
    );
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_GET_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        new TextEncoder().encode(key).byteLength <= MAX_LIVE_RPC_ID_LENGTH &&
        isBoundedGetEntriesJson(entry, depth + 1),
    )
  );
}

function encodedJsonByteLength(value: JsonValue): number | undefined {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(value),
    () => undefined,
  )();
  if (serialized.isErr() || serialized.value === undefined) return undefined;
  return new TextEncoder().encode(serialized.value).byteLength;
}

function safeNumberField(
  record: Record<string, JsonValue>,
  field: string,
): number {
  const candidate = record[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return 0;
  // Usage figures must never regress the running aggregate via a
  // negative/malformed value reported by the child.
  return Math.max(0, candidate);
}

function extractCostTotal(usageRecord: Record<string, JsonValue>): number {
  const cost = usageRecord.cost;
  if (typeof cost !== "object" || cost === null || Array.isArray(cost))
    return 0;
  const total = (cost as Record<string, JsonValue>).total;
  if (typeof total !== "number" || !Number.isFinite(total)) return 0;
  return Math.max(0, total);
}

export { DEFAULT_REPLY_TIMEOUT_MS };
