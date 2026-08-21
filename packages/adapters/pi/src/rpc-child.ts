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
  makeCancelBody,
  modelIdentityBodiesEqual,
  modelTransitionFactsEqual,
  type PiBootstrapAckBody,
  type PiBootstrapBody,
  type PiDelegateRequestBody,
  type PiModelIdentityBody,
  type PiModelTransitionBody,
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
  ChildRuntimeBudget,
  makeChildRuntimeExceededFailure,
} from "./child-runtime-budget.js";
import {
  type PiChildSessionEvent,
  PiExtensionUiResponseSchema,
  parsePiChildSessionEvent,
} from "./child-session-events.js";
import {
  describePiChildSessionLaunchRejection,
  type PiChildSessionLaunchAuthority,
  type PiChildSessionLaunchDetails,
  type PiChildSessionLaunchGrant,
  redeemPiChildSessionLaunchGrant,
} from "./child-session-launch.js";
import {
  describeChildSessionStorageUnavailable,
  type PiChildSessionStorageAuthority,
} from "./child-session-storage-authority.js";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_CHILD_RUNTIME_BUDGET_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REPLY_TIMEOUT_MS,
  DEFAULT_RESPONSE_DRAIN_MS,
  DEFAULT_SETTLEMENT_TIMEOUT_MS,
  SystemTimerPort,
  type TimerHandle,
  type TimerPort,
} from "./child-timer.js";
import { ChunkTransferAssembler } from "./child-transfer.js";
import {
  addUsage,
  EMPTY_USAGE_AGGREGATE,
  nextLiveAnswerId,
  type PiChildLiveAnswerState,
  type PiChildStatus,
  type PiChildTreeNode,
  type PiChildUsageAggregate,
  truncateFinalOutput,
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
  makeChildResponseMissingFailure,
  makeChildSettlementMissingFailure,
  makeChildSpawnFailedFailure,
  makeChildTransferRejectedFailure,
  makeChildTransferTimedOutFailure,
  makeChildTransferTooLargeFailure,
  PI_TRANSPORT_LIMITS,
  type PiAdapterFailure,
  type PiChildResponseMissingReason,
} from "./errors.js";
import { classifyPiMessageUpdate } from "./message-update-carrier.js";
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

/**
 * Where the captured private terminal output actually came from.
 *
 * A caller that must persist an authoritative result cannot treat these as
 * equivalent. `transferred-candidate` and `inline-candidate` are the child's
 * verified structured completion candidate; `transferred-output` is its
 * complete free-text terminal output; `observed-terminal` is only the last
 * parser-approved terminal assistant message the parent happened to observe,
 * which is unrelated prose for a structured direct step.
 */
export type PiChildPrivateOutputSource =
  | "transferred-candidate"
  | "inline-candidate"
  | "transferred-output"
  | "observed-terminal";

/** One complete private terminal output capture and its provenance. */
export interface PiChildPrivateOutputCapture {
  readonly output: string;
  readonly byteLength: number;
  readonly source: PiChildPrivateOutputSource;
}

/** Receives validated, bounded events without owning child persistence. */
export interface PiChildSessionObserver {
  readonly onEvent: (
    event: PiChildSessionEvent,
  ) => PiChildSessionObserverResult;
}

export interface PiRpcChildDeps {
  readonly processPort: PiChildProcessPort;
  /**
   * Storage authority consulted before anything else this child does. There
   * is no default: every construction site must state, explicitly and by
   * name, which authority governs this launch. The production authority
   * ({@link createPiChildSessionStorageAuthority}) always refuses, and no
   * environment variable or configuration key relaxes it.
   */
  readonly sessionStorageAuthority: PiChildSessionStorageAuthority;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly timerPort?: TimerPort;
  readonly logger: PiAdapterLogger;
  readonly command?: readonly string[];
  /**
   * Supplies this child's extension-selection arguments, evaluated once per
   * spawn so a selection resolved after this child was constructed still
   * applies. The result is appended after the base command and before the
   * session flags.
   *
   * Returning an empty array means "inherit every extension the host would
   * give a child", which is the default and produces argv byte-identical to a
   * spawn with no provider at all. Any other result must be exactly
   * `--no-extensions` followed by `-e <absolute path>` pairs; anything else
   * fails the spawn with `ChildSpawnFailed` rather than being dropped.
   */
  readonly resolveExtensionArgs?: () => readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  /** Maximum silence while awaiting settlement; valid child activity renews it. */
  readonly settlementTimeoutMs?: number;
  /**
   * Absolute wall-clock budget for this child's whole lifetime, measured from
   * the spawn boundary and never renewed by activity. Defaults to
   * Defaults to the adapter child-runtime budget; tests inject a small value.
   */
  readonly runtimeBudgetMs?: number;
  /**
   * Bounded window kept open after a `completed` settlement that has not yet
   * satisfied the child result contract, so final in-flight session events are
   * drained before classification (Pi adapter contract §10).
   */
  readonly responseDrainMs?: number;
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
   * Receives one authenticated, nonterminal child model transition. `applied`
   * updates parent model truth; `recovery-confirmed` is an admission fact for
   * a later projection. Neither phase owns settlement.
   */
  readonly onModelTransition?: (
    childId: string,
    transition: PiModelTransitionBody,
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
  readonly onPrivateOutput?: (
    capture: PiChildPrivateOutputCapture,
  ) => PiChildSessionObserverResult;
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

/**
 * How this child's transcript is stored.
 *
 * There is no caller-constructed path mode. A persistent child launches only
 * against an opaque, store-minted {@link PiChildSessionLaunchGrant} bound to
 * the generation's validated session root, the validated child directory, the
 * exact validated session file, and this child's identity (Spec 33 §5.3 /
 * R5). A public caller therefore cannot ask Weave to launch `pi` against an
 * arbitrary absolute path, however well-formed that path looks.
 */
export type PiRpcChildSpawnSession =
  | { readonly mode: "ephemeral" }
  | {
      readonly mode: "native";
      readonly grant: PiChildSessionLaunchGrant;
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
      readonly assistantOutput?: string;
      readonly completionCandidate?: string;
      readonly completionCandidateTransferred?: boolean;
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
/**
 * Pi's own session-directory environment variable. Inherited values, whether
 * from the parent process or a caller-supplied environment, must not redirect
 * a child away from the validated `--session-dir`.
 */
const PI_INHERITED_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/**
 * Pi's own extension-selection flags. `--no-extensions` suppresses every
 * extension the host would otherwise hand the child; each `-e <source>` adds
 * one back. Weave only ever emits absolute paths: `-e npm:<pkg>` makes Pi
 * install into a fresh temporary directory per child.
 */
const NO_EXTENSIONS_FLAG = "--no-extensions";
const EXTENSION_FLAG = "-e";
/**
 * Bound on `-e <path>` pairs: the mandatory Weave entry plus the 64 optional
 * entries the selection record can persist.
 */
const MAX_EXTENSION_ARG_PATHS = 65;
/** Per-path bound in UTF-8 bytes, matching the persisted per-field bound. */
const MAX_EXTENSION_ARG_PATH_BYTES = 512;
/** `--no-extensions` plus one flag and one path per selected extension. */
const MAX_EXTENSION_ARGS = 1 + 2 * MAX_EXTENSION_ARG_PATHS;

const MAX_SPAWN_SESSION_ID_BYTES = 256;
const MAX_SPAWN_CHECKPOINT_CURSOR = Number.MAX_SAFE_INTEGER;
const MAX_LIVE_RPC_ID_LENGTH = 256;
const MAX_LIVE_RPC_MESSAGE_LENGTH = 64 * 1024;
const MAX_GET_ENTRIES = 256;
const MAX_GET_ENTRIES_BYTES = 512 * 1024;
const MAX_LIVE_JSON_DEPTH = 8;
/** Candidate catalogs are bounded; retain at most one transition per candidate. */
const MAX_MODEL_TRANSITIONS = 64;

function freezeModelTransitionBody(
  transition: PiModelTransitionBody,
): PiModelTransitionBody {
  return Object.freeze({
    ...transition,
    from: Object.freeze({ ...transition.from }),
    to: Object.freeze({ ...transition.to }),
  });
}

/**
 * Gives observers a fresh descriptor-safe copy while keeping the child's own
 * admitted model truth immutable. Observer consumers re-validate the copy at
 * their boundaries, so frozen internal state must never cross this seam.
 */
function copyModelTransitionBody(
  transition: PiModelTransitionBody,
): PiModelTransitionBody {
  return {
    ...transition,
    from: { ...transition.from },
    to: { ...transition.to },
  };
}

function invalidSpawnSession<T>(reason: string): Result<T, string> {
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

function isSessionFlagArgument(value: string): boolean {
  return SESSION_FLAGS.some(
    (flag) => value === flag || value.startsWith(`${flag}=`),
  );
}

/**
 * Validates one provider result before any of it can reach argv.
 *
 * The accepted shape is deliberately closed: either nothing at all, or
 * exactly `--no-extensions` followed by `-e <absolute safe path>` pairs. A
 * provider that returns anything else - an npm spec, a relative or traversal
 * path, a control character, a session flag, a duplicate, a trailing `-e`
 * with no value, or more entries than the selection record can hold - fails
 * the spawn. Silently dropping a malformed entry would either leave a child
 * without the Weave adapter or quietly hand it extensions the user
 * deselected, and both are worse than a typed `ChildSpawnFailed`.
 */
function validateExtensionArguments(
  values: readonly string[],
): Result<readonly string[], string> {
  if (!Array.isArray(values)) {
    return err("extension arguments must be an array");
  }
  if (values.length === 0) return ok([]);
  if (values.length > MAX_EXTENSION_ARGS) {
    return err("extension arguments exceed their bound");
  }
  for (const value of values) {
    if (typeof value !== "string") {
      return err("extension arguments must be strings");
    }
    if (isSessionFlagArgument(value)) {
      return err("extension arguments contain a session flag");
    }
  }
  if (values[0] !== NO_EXTENSIONS_FLAG) {
    return err(`extension arguments must start with ${NO_EXTENSIONS_FLAG}`);
  }
  const pairs = values.slice(1);
  if (pairs.length === 0) {
    // `--no-extensions` alone would spawn a child without the Weave adapter,
    // which cannot handshake and can only fail later, more confusingly.
    return err("extension arguments select no extension");
  }
  if (pairs.length % 2 !== 0) {
    return err("extension arguments have a flag without a path");
  }
  const seen = new Set<string>();
  for (let index = 0; index < pairs.length; index += 2) {
    if (pairs[index] !== EXTENSION_FLAG) {
      return err(`extension arguments expect ${EXTENSION_FLAG} before a path`);
    }
    const candidate = pairs[index + 1] ?? "";
    const path = validateAbsoluteSpawnPath(candidate, "extension path");
    if (path.isErr()) return err(path.error);
    if (
      new TextEncoder().encode(path.value).byteLength >
      MAX_EXTENSION_ARG_PATH_BYTES
    ) {
      return err("extension path exceeds its bound");
    }
    if (seen.has(path.value)) {
      return err("extension arguments repeat a path");
    }
    seen.add(path.value);
  }
  return ok(values);
}

function resolveExtensionArguments(
  resolve: (() => readonly string[]) | undefined,
): Result<readonly string[], string> {
  if (resolve === undefined) return ok([]);
  const resolved = Result.fromThrowable(
    resolve,
    () => "extension argument provider failed",
  )();
  if (resolved.isErr()) return err(resolved.error);
  return validateExtensionArguments(resolved.value);
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

interface SpawnSessionPlan {
  readonly command: readonly string[];
  readonly launch?: PiChildSessionLaunchDetails;
}

type SpawnSessionPlanResult = Result<SpawnSessionPlan, string>;

function buildSpawnCommand(
  baseCommand: readonly string[],
  session: PiRpcChildSpawnSession | undefined,
  identity: {
    readonly childId: string;
    readonly authority: PiChildSessionLaunchAuthority;
  },
  resolveExtensionArgs?: () => readonly string[],
): SpawnSessionPlanResult {
  for (const argument of baseCommand) {
    if (typeof argument !== "string" || isSessionFlagArgument(argument)) {
      return invalidSpawnSession("base command contains a session flag");
    }
  }

  // Extension selection sits between the base command and the session flags:
  // after the executable and its mode, before the session selection this
  // transport alone owns.
  const extensionArgs = resolveExtensionArguments(resolveExtensionArgs);
  if (extensionArgs.isErr()) return invalidSpawnSession(extensionArgs.error);
  const launchCommand = [...baseCommand, ...extensionArgs.value];

  const selected = session ?? { mode: "ephemeral" as const };
  if (typeof selected !== "object" || selected === null) {
    return invalidSpawnSession("session must be an object");
  }
  if (selected.mode === "ephemeral") {
    return ok({ command: [...launchCommand, "--no-session"] });
  }
  if (selected.mode !== "native") {
    return invalidSpawnSession("unknown session mode");
  }

  // The only path authority: an opaque grant this process minted through the
  // store, bound to the generation's validated root and to this child. A
  // caller-supplied path, however well-formed, has no grant and stops here.
  const launch = redeemPiChildSessionLaunchGrant(selected.grant, {
    childId: identity.childId,
    authority: identity.authority,
  });
  if (launch.isErr()) {
    return err(describePiChildSessionLaunchRejection(launch.error));
  }
  const details = launch.value;

  // Defence in depth: the grant was validated at mint time, and is validated
  // again here so the exact argv this transport emits is proven independently
  // of the minting path.
  const sessionDir = validateAbsoluteSpawnPath(
    details.sessionDir,
    "sessionDir",
  );
  if (sessionDir.isErr()) return invalidSpawnSession(sessionDir.error);
  const sessionPath = validateAbsoluteSpawnPath(
    details.sessionPath,
    "sessionPath",
  );
  if (sessionPath.isErr()) return invalidSpawnSession(sessionPath.error);
  if (!sessionPath.value.endsWith(".jsonl")) {
    return invalidSpawnSession("sessionPath must end in .jsonl");
  }
  // Containment is canonical immediate-child equality, never a prefix: a
  // prefix test also accepts `<dir>/nested/leaf.jsonl`, which is not the leaf
  // the adapter validated and handed to Pi's own `SessionManager`.
  const directory = sessionDir.value.replace(/\/+$/, "") || "/";
  const separator = sessionPath.value.lastIndexOf("/");
  const parent = separator <= 0 ? "/" : sessionPath.value.slice(0, separator);
  const basename = sessionPath.value.slice(separator + 1);
  if (parent !== directory || basename.length === 0) {
    return invalidSpawnSession(
      "sessionPath must be an immediate child of sessionDir",
    );
  }

  const activeLeafId = validateSpawnSessionId(details.activeLeafId);
  if (activeLeafId.isErr()) return invalidSpawnSession(activeLeafId.error);
  if (
    details.checkpointCursor !== undefined &&
    (!Number.isSafeInteger(details.checkpointCursor) ||
      details.checkpointCursor < 0 ||
      details.checkpointCursor > MAX_SPAWN_CHECKPOINT_CURSOR)
  ) {
    return invalidSpawnSession("checkpointCursor is out of bounds");
  }

  return ok({
    command: [
      ...launchCommand,
      "--session-dir",
      sessionDir.value,
      "--session",
      sessionPath.value,
    ],
    launch: details,
  });
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

/**
 * Entry kinds Pi 0.83 itself appends to a restored session during child
 * startup, before the parent can authenticate the restore. These carry no
 * transcript content: `model_change` records the resolved provider/model and
 * `thinking_level_change` records the resolved reasoning level. Every other
 * kind (messages, tool activity, custom/custom_message, compaction, branch
 * summaries, labels, session info) is task-bearing or branch-bearing and is
 * never accepted as an unauthenticated startup suffix.
 */
const RESTORE_STARTUP_SUFFIX_KINDS: ReadonlySet<PiGetEntriesEntry["type"]> =
  new Set(["model_change", "thinking_level_change"] as const);

/**
 * Pi 0.83 appends its resolved model and thinking level on startup, and
 * bootstrap model activation can append a second pair. Six leaves bounded slack
 * over that observed four-entry suffix without admitting an open-ended tail.
 */
const MAX_RESTORE_STARTUP_SUFFIX_ENTRIES = 6;
const MAX_RESTORE_STARTUP_SUFFIX_BYTES = 8 * 1024;

/** Stable, non-revealing failure reasons for restore authentication. */
export type PiRestoreAuthenticationReason =
  | "restore-active-leaf-mismatch"
  | "restore-startup-suffix-forbidden-kind"
  | "restore-startup-suffix-disconnected"
  | "restore-startup-suffix-cycle"
  | "restore-startup-suffix-malformed"
  | "restore-startup-suffix-too-large";

function measureRestoreSuffixEntry(entry: PiGetEntriesEntry): number {
  const encoded = Result.fromThrowable(
    () => new TextEncoder().encode(JSON.stringify(entry)).byteLength,
    () => undefined,
  )();
  // An unserializable entry is treated as over budget rather than free.
  return encoded.isOk() ? encoded.value : Number.POSITIVE_INFINITY;
}

/**
 * Authenticates a restored child's reported active leaf against the leaf this
 * parent established, tolerating only a bounded contiguous suffix of Pi-owned
 * startup state entries.
 *
 * The persisted leaf must be an ancestor of the reported leaf through an
 * unbroken `parentId` chain built solely from {@link RESTORE_STARTUP_SUFFIX_KINDS}
 * entries with valid unique ids, within the entry-count and byte bounds.
 * Anything else - a disconnected or branched leaf, a repeated id, a malformed
 * id/parent, a forbidden kind, or an oversized suffix - fails closed.
 */
export function authenticateRestoreStartupSuffix(
  establishedLeafId: string,
  page: PiGetEntriesResult,
): Result<void, PiRestoreAuthenticationReason> {
  const { entries, leafId } = page;
  if (entries.length === 0) {
    return leafId === establishedLeafId
      ? ok(undefined)
      : err("restore-active-leaf-mismatch");
  }
  if (typeof leafId !== "string" || leafId.length === 0) {
    return err("restore-active-leaf-mismatch");
  }
  if (entries.length > MAX_RESTORE_STARTUP_SUFFIX_ENTRIES) {
    return err("restore-startup-suffix-too-large");
  }

  const seenIds = new Set<string>([establishedLeafId]);
  let expectedParentId = establishedLeafId;
  let suffixBytes = 0;
  for (const entry of entries) {
    if (!RESTORE_STARTUP_SUFFIX_KINDS.has(entry.type)) {
      return err("restore-startup-suffix-forbidden-kind");
    }
    if (!entryIdSchema.safeParse(entry.id).success) {
      return err("restore-startup-suffix-malformed");
    }
    if (
      entry.parentId !== null &&
      !entryIdSchema.safeParse(entry.parentId).success
    ) {
      return err("restore-startup-suffix-malformed");
    }
    if (seenIds.has(entry.id)) {
      return err("restore-startup-suffix-cycle");
    }
    if (entry.parentId !== expectedParentId) {
      return err("restore-startup-suffix-disconnected");
    }
    suffixBytes += measureRestoreSuffixEntry(entry);
    if (suffixBytes > MAX_RESTORE_STARTUP_SUFFIX_BYTES) {
      return err("restore-startup-suffix-too-large");
    }
    seenIds.add(entry.id);
    expectedParentId = entry.id;
  }

  return expectedParentId === leafId
    ? ok(undefined)
    : err("restore-active-leaf-mismatch");
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
  private readonly sessionStorageAuthority: PiChildSessionStorageAuthority;
  private readonly randomPort: RandomPort;
  private readonly hmacPort: HmacPort;
  private readonly timerPort: TimerPort;
  private readonly logger: PiAdapterLogger;
  private readonly command: readonly string[];
  private readonly resolveExtensionArgs: (() => readonly string[]) | undefined;
  private readonly handshakeTimeoutMs: number;
  private readonly settlementTimeoutMs: number;
  private readonly runtimeBudget: ChildRuntimeBudget;
  private readonly responseDrainMs: number;
  private readonly now: () => number;
  private readonly onDelegationRequest:
    | ((
        childId: string,
        correlationId: string,
        request: PiDelegateRequestBody,
      ) => void)
    | undefined;
  private readonly onModelTransition:
    | ((childId: string, transition: PiModelTransitionBody) => void)
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
    | ((capture: PiChildPrivateOutputCapture) => PiChildSessionObserverResult)
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
  /**
   * Serializes asynchronous control-envelope verification so envelopes are
   * admitted in the order they arrived, not the order their HMAC checks
   * happen to finish.
   */
  private controlAdmitTail: Promise<void> = Promise.resolve();
  private process: PiSpawnedChildProcess | undefined;
  private readonly framer = new PiLineFramer();
  private readonly delegateRequestAssembler = new DelegateRequestAssembler();
  private readonly outputTransferAssembler = new ChunkTransferAssembler();
  private readonly completedOutputTransfers = new Map<string, string>();
  private disposed = false;
  /**
   * The first terminal failure this child observed, kept so a `spawn` that
   * resolves after the child was already concluded can be rejected with the
   * real cause rather than a fabricated one.
   */
  private terminalFailure: PiAdapterFailure | undefined;
  private startedAtMs = 0;

  private status: PiChildStatus = "queued";
  private currentTurn = 0;
  private currentTool: string | undefined;
  private usage: PiChildUsageAggregate = EMPTY_USAGE_AGGREGATE;
  private latestOutput = "";
  /**
   * Content-free marker that the current turn has streamed raw reasoning.
   *
   * The prose itself is NEVER kept. A reasoning model can think for a long
   * time before its first visible token, and this flag is what lets the parent
   * say "the child is reasoning" during that stretch without restating a
   * single word of chain-of-thought. Cleared when a new turn emits its first
   * delta and as soon as real answer text arrives.
   */
  private reasoningObserved = false;
  private resetPreviewOnNextDelta = false;
  /**
   * The assistant message being written RIGHT NOW, as its own bounded
   * lifecycle: an explicit identity, an open/closed state, and the exact
   * ordered concatenation of that message's own answer deltas.
   *
   * It is kept separately from `latestOutput`, which is a per-TURN
   * preview and deliberately survives the end of a message. A reader catching
   * up mid-stream needs to know which message it is looking at and whether
   * that message is still open; asking it to guess from the preview's PROSE is
   * what made a finished answer reappear as a live one, and made a new message
   * that happened to repeat an older answer invisible.
   */
  private liveAnswer: PiChildLiveAnswerState = {
    id: 0,
    open: false,
    text: "",
  };
  private latestCompletedAssistantOutput = "";
  /**
   * Result-contract observation, tracked separately from the parent-visible
   * projection (Pi adapter contract §10). Only a terminal assistant message
   * carrying non-whitespace text sets `terminalResponse`; thinking blocks and
   * tool activity are recorded on their own so a failed contract can name its
   * real reason without ever inspecting the transcript.
   */
  private terminalResponseObserved = false;
  private terminalAssistantMessageObserved = false;
  private thinkingObserved = false;
  private toolActivityObserved = false;
  private readonly seenUsageMessageIds = new Set<string>();
  /** The complete authenticated model identity last accepted for this child. */
  private currentModelIdentity: PiModelIdentityBody | undefined;
  /** The one transition currently awaiting its recovery-confirmed phase. */
  private modelTransition: PiModelTransitionBody | undefined;
  /** Retains accepted transition IDs so stale phases cannot be replayed. */
  private readonly seenModelTransitionIds = new Set<string>();
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
  /**
   * True between an authenticated `completed` settlement that has not yet met
   * the child result contract and the end of its bounded drain window. The
   * child is no longer accepting work, so a second settlement in this window is
   * still a duplicate reply.
   */
  private settlementDraining = false;
  /**
   * Reserves terminal authority for the first authenticated settlement while
   * its private-output observer is pending. A second settlement is a protocol
   * duplicate even though the first has not reached the drain or settled state.
   */
  private settlementCapturePending = false;
  /**
   * Monotonic lifecycle epoch for asynchronous settlement work.
   *
   * An authenticated `settled` envelope may hand the private output to an
   * observer that answers asynchronously. While that capture is pending the
   * child can still be concluded terminally by a path that owes nothing to the
   * capture - absolute runtime-budget expiry, cancellation, or disposal. The
   * capture's continuation is already queued at that point and cannot be
   * unsubscribed, so it is fenced instead: the epoch is read *before* the async
   * call, every terminal path bumps it, and a continuation whose token no
   * longer matches is inert. That is what stops a late success from calling
   * `settleUnderResultContract()` and overwriting `ChildRuntimeExceeded` or
   * installing a response-drain timer on an already-disposed child.
   */
  private settlementCaptureEpoch = 0;
  private drainCorrelationId = "";
  private responseDrainTimer: TimerHandle | undefined;
  private finishSettlement: (() => void) | undefined;
  private settlementTimer: TimerHandle | undefined;
  private readonly replyTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly baseEnv: Readonly<Record<string, string>>;
  /** The restore selector used by the actual spawn; never inferred from task input. */
  private restoreSession: PiChildSessionLaunchDetails | undefined;

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
    this.sessionStorageAuthority = deps.sessionStorageAuthority;
    this.randomPort = deps.randomPort;
    this.hmacPort = deps.hmacPort;
    this.timerPort = deps.timerPort ?? new SystemTimerPort();
    this.logger = deps.logger;
    this.command = deps.command ?? DEFAULT_COMMAND;
    this.resolveExtensionArgs = deps.resolveExtensionArgs;
    this.handshakeTimeoutMs =
      deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.settlementTimeoutMs =
      deps.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
    this.runtimeBudget = new ChildRuntimeBudget(
      this.timerPort,
      deps.runtimeBudgetMs ?? DEFAULT_CHILD_RUNTIME_BUDGET_MS,
    );
    this.responseDrainMs = deps.responseDrainMs ?? DEFAULT_RESPONSE_DRAIN_MS;
    this.replyTimeoutMs = deps.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.baseEnv = deps.baseEnv ?? {};
    this.now = deps.now ?? (() => Date.now());
    this.onDelegationRequest = deps.onDelegationRequest;
    this.onModelTransition = deps.onModelTransition;
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
      // Answer text only. Raw reasoning never becomes the parent-visible
      // preview: this value reaches the child picker, the tree render and the
      // delegation card, so a thinking fallback here would publish
      // chain-of-thought in four places at once.
      latestOutput: this.latestOutput,
      reasoningObserved: this.reasoningObserved,
      // Present only while a message is genuinely open and has answer text.
      // Absence is therefore the honest statement "nothing is being written",
      // which is what stops a reader adopting a finished answer as live.
      ...(this.liveAnswer.open && this.liveAnswer.text.length > 0
        ? {
            liveAnswer: {
              id: this.liveAnswer.id,
              text: this.liveAnswer.text,
            },
          }
        : {}),
    };
  }

  /** Opens a new assistant answer lifecycle with a fresh bounded identity. */
  private openLiveAnswer(): void {
    this.liveAnswer = {
      id: nextLiveAnswerId(this.liveAnswer.id),
      open: true,
      text: "",
    };
  }

  /**
   * Closes the open lifecycle. The identity is retained (it is never reused
   * for a later message), the text is not.
   */
  private closeLiveAnswer(): void {
    this.liveAnswer = { id: this.liveAnswer.id, open: false, text: "" };
  }

  /**
   * Storage-authority preflight. The first externally observable action of
   * every launch: it runs before the argument vector is built, before any
   * session path is read or interpreted, before the secret is generated,
   * before any environment or bootstrap value is assembled, and before the
   * process port is touched. A refusal is mapped onto the closed transport
   * failure carrying the same bounded, path-free reason.
   */
  private requireSessionStorageAuthority(): Result<
    PiChildSessionLaunchAuthority,
    PiAdapterFailure
  > {
    return this.sessionStorageAuthority
      .requireNativeSessionAuthority()
      .andThen(() => this.sessionStorageAuthority.requireLaunchAuthority())
      .mapErr((unavailable) =>
        makeChildSpawnFailedFailure(
          this.childId,
          describeChildSessionStorageUnavailable(unavailable),
        ),
      );
  }

  /** Spawns the process, injects the secret via environment only, and awaits the authenticated handshake before returning. */
  spawnAndHandshake(
    input: PiRpcChildSpawnInput,
  ): ResultAsync<void, PiAdapterFailure> {
    // Storage authority first: `input` is not read at all until this passes,
    // so a hostile or malformed session path is never interpreted and no
    // argument, lease, control channel, or process exists to clean up.
    const authority = this.requireSessionStorageAuthority();
    if (authority.isErr()) {
      this.failOutstanding(authority.error);
      return errAsync(authority.error);
    }

    const plan = buildSpawnCommand(
      this.command,
      input.session,
      {
        childId: this.childId,
        authority: authority.value,
      },
      this.resolveExtensionArgs,
    );
    if (plan.isErr()) {
      const failure = makeChildSpawnFailedFailure(this.childId, plan.error);
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    const command = plan.value.command;

    this.restoreSession = plan.value.launch;
    this.startedAtMs = this.now();
    // The absolute budget covers the child's entire wall-clock lifetime,
    // including the pre-handshake window, and is armed exactly once here.
    this.runtimeBudget.start(() => this.handleRuntimeBudgetExpiry());
    if (this.disposed || this.terminalFailure !== undefined) {
      return errAsync(
        this.terminalFailure ??
          makeChildSpawnFailedFailure(
            this.childId,
            "child terminated before spawn started",
          ),
      );
    }
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
    // The explicit `--session-dir` argument is the sole authority over child
    // session storage. An inherited or caller-supplied session directory is
    // untrusted for that choice, so it never reaches the child environment.
    delete env[PI_INHERITED_SESSION_DIR_ENV];
    return this.processPort
      .spawn({ command, env, cwd: input.cwd })
      .mapErr((spawnError) =>
        makeChildSpawnFailedFailure(this.childId, spawnError.reason),
      )
      .andThen((spawned) => {
        if (this.disposed) {
          // The child was concluded terminally (absolute runtime budget
          // expiry, cancellation, disposal) while `spawn` was still pending,
          // so this process was never covered by any live cleanup path. It is
          // force-killed here and never installed as `this.process`, never
          // wired to the transport, and never given a handshake waiter -
          // otherwise a post-terminal child would keep running with a timer
          // and a resolver nobody can ever reject.
          spawned.forceKill();
          return errAsync(
            this.terminalFailure ??
              makeChildSpawnFailedFailure(
                this.childId,
                "child terminated before spawn completed",
              ),
          );
        }
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
    if (this.settlementDraining) {
      // The child already sent its authenticated settlement; its exit ends the
      // event stream, so every final event has now been drained and the result
      // contract can be classified (Pi adapter contract §10).
      this.clearResponseDrainTimer();
      this.concludeResponseDrain(this.drainCorrelationId);
      return;
    }
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
    if (this.secret?.peek() === undefined || this.authState === undefined) {
      // Never silently ignore an incoming control line just because our
      // own activation state is missing - fail closed rather than leave
      // the caller waiting on a resolver that can now never be satisfied.
      this.failOutstanding(
        makeChildAuthenticationFailedFailure(this.childId, "not-activated"),
      );
      return;
    }
    // `admitIncoming` enforces a strict per-child sequence, so admission
    // order *is* arrival order. `verifyEnvelope` is asynchronous (HMAC runs
    // off-thread), so two control lines read back to back - which is exactly
    // what a multi-chunk output transfer produces - can otherwise finish
    // verifying in the opposite order and be admitted as a `SequenceMismatch`
    // against a child that did nothing wrong. Serializing verification keeps
    // admission in arrival order; every fail-closed check below is unchanged.
    this.controlAdmitTail = this.controlAdmitTail.then(
      () => this.verifyAndAdmitControlLine(json),
      () => this.verifyAndAdmitControlLine(json),
    );
  }

  private async verifyAndAdmitControlLine(json: JsonValue): Promise<void> {
    if (this.disposed) return;
    const secretBytes = this.secret?.peek();
    const authState = this.authState;
    if (secretBytes === undefined || authState === undefined) {
      this.failOutstanding(
        makeChildAuthenticationFailedFailure(this.childId, "not-activated"),
      );
      return;
    }
    await verifyEnvelope(json, secretBytes, this.hmacPort).match(
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
   * Admits one model transition after the envelope-level authentication and
   * running-state checks. The complete identity is compared as one value so a
   * provider/model pair can never be observed half-updated by the parent.
   */
  private admitModelTransition(transition: PiModelTransitionBody): boolean {
    const prior = this.modelTransition;
    if (transition.phase === "applied") {
      if (
        this.seenModelTransitionIds.has(transition.transitionId) ||
        prior?.phase === "applied" ||
        this.seenModelTransitionIds.size >= MAX_MODEL_TRANSITIONS ||
        modelIdentityBodiesEqual(transition.from, transition.to) ||
        this.currentModelIdentity === undefined ||
        !modelIdentityBodiesEqual(transition.from, this.currentModelIdentity) ||
        (prior !== undefined &&
          !modelIdentityBodiesEqual(transition.from, prior.to))
      ) {
        return false;
      }
      this.seenModelTransitionIds.add(transition.transitionId);
      this.modelTransition = transition;
      this.currentModelIdentity = transition.to;
      return true;
    }
    if (
      prior === undefined ||
      prior.phase !== "applied" ||
      !modelTransitionFactsEqual(transition, prior) ||
      !modelIdentityBodiesEqual(transition.from, prior.from) ||
      !modelIdentityBodiesEqual(transition.to, prior.to) ||
      this.currentModelIdentity === undefined ||
      !modelIdentityBodiesEqual(transition.to, this.currentModelIdentity)
    ) {
      return false;
    }
    this.modelTransition = transition;
    return true;
  }

  /** Delivers only bounded transition facts; callback failures never leak data. */
  private notifyModelTransition(transition: PiModelTransitionBody): void {
    if (this.onModelTransition === undefined) return;
    const callback = Result.fromThrowable(
      () => this.onModelTransition?.(this.childId, transition),
      () => "onModelTransition_failed" as const,
    )();
    callback.match(
      () => undefined,
      (code) => {
        this.logger.warn(
          { childId: this.childId, code },
          "child model transition callback failed",
        );
      },
    );
  }

  /**
   * Enforces the child's strict protocol state machine (Pi adapter contract):
   * `handshake` only while awaiting it, `bootstrap-ack` only while a
   * bootstrap is outstanding, `settled` only once bootstrap has been
   * confirmed applied, `cancelled` only while a cancellation is in
   * flight, `model-transition` only while running and before settlement, and
   * `delegate-request` only once running. Any message arriving
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
    if (envelope.kind === "model-transition") {
      if (
        this.status !== "running" ||
        this.settled ||
        this.disposed ||
        this.settlementDraining ||
        this.settlementCapturePending
      ) {
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const parsed = parseControlBody("model-transition", envelope.body);
      if (!parsed.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "model-transition-invalid",
          ),
        );
        return;
      }
      const transition = freezeModelTransitionBody(parsed.value);
      if (!this.admitModelTransition(transition)) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "model-transition-invalid",
          ),
        );
        return;
      }
      this.notifyModelTransition(copyModelTransitionBody(parsed.value));
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
    if (
      this.settled ||
      this.settlementDraining ||
      this.settlementCapturePending
    ) {
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
    let privateOutputSource: PiChildPrivateOutputSource = "observed-terminal";
    // A private output transfer is an optimisation, not the settlement
    // authority. If it is missing or corrupt, retain the bounded inline
    // projection and settle normally; otherwise a delivery hiccup would
    // incorrectly turn a completed child into ChildDeliveryFailed.
    let outputTransferUsable = true;
    if (completed !== undefined) {
      let transferredOutput: string | undefined;
      if (completed.outputTransferId !== undefined) {
        const transferred = this.completedOutputTransfers.get(
          completed.outputTransferId,
        );
        if (transferred === undefined) {
          outputTransferUsable = false;
        } else {
          this.completedOutputTransfers.delete(completed.outputTransferId);
          transferredOutput = transferred;
        }
      }
      if (
        outputTransferUsable &&
        transferredOutput !== undefined &&
        completed.outputByteLength !== undefined &&
        completed.outputByteLength !==
          new TextEncoder().encode(transferredOutput).byteLength
      ) {
        outputTransferUsable = false;
        transferredOutput = undefined;
      }
      // Selection order follows authority, not availability. A structured
      // completion candidate - transferred or inline - is the child's actual
      // verified result, so it outranks free-text output. Only when no
      // candidate exists at all does the capture fall back to observed
      // terminal prose, and it says so through its source.
      if (
        transferredOutput !== undefined &&
        completed.completionCandidateTransferred === true
      ) {
        privateOutput = transferredOutput;
        privateOutputSource = "transferred-candidate";
      } else if (completed.completionCandidate !== undefined) {
        privateOutput = completed.completionCandidate;
        privateOutputSource = "inline-candidate";
      } else if (transferredOutput !== undefined) {
        privateOutput = transferredOutput;
        privateOutputSource = "transferred-output";
      } else {
        privateOutput = this.latestCompletedAssistantOutput;
        privateOutputSource = "observed-terminal";
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
              // Only the last observer-approved terminal message_end crosses
              // to the parent model. A transferred/private payload, including
              // one supplied by a child, is never parent-projection authority.
              ...(this.latestCompletedAssistantOutput.length > 0
                ? {
                    assistantOutput: truncateFinalOutput(
                      this.latestCompletedAssistantOutput,
                    ),
                  }
                : {}),
              ...(parsed.value.completionCandidate !== undefined
                ? { completionCandidate: parsed.value.completionCandidate }
                : {}),
              ...(parsed.value.completionCandidateTransferred === true &&
              outputTransferUsable
                ? { completionCandidate: privateOutput }
                : {}),
              ...(outputTransferUsable &&
              parsed.value.outputByteLength !== undefined
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

    /**
     * Applies the child result contract (Pi adapter contract §10). A completed
     * child is only successful once the parent has observed a terminal
     * assistant response holding non-whitespace text. When it has not, the
     * child keeps a bounded drain window open so a terminal event still in
     * flight - settlement and message may be delivered out of order - is
     * classified as the response it is rather than as a missing one.
     */
    const settleUnderResultContract = (): void => {
      // Only a parser-approved terminal assistant `message_end` with
      // non-whitespace text satisfies this contract. Control-envelope
      // `assistantOutput` / `completionCandidate` are not authority here;
      // structured workflow completion (`CompletionSignalMissing`) owns
      // candidate validation on its own path and must not bypass this gate.
      if (
        parsed.value.outcome !== "completed" ||
        this.terminalResponseObserved
      ) {
        finish();
        return;
      }
      this.settlementDraining = true;
      this.finishSettlement = finish;
      this.drainCorrelationId = envelope.correlationId;
      // The inactivity budget belongs to a running turn, not to this window.
      this.clearSettlementTimeout();
      const correlationId = envelope.correlationId;
      this.responseDrainTimer = this.timerPort.schedule(() => {
        this.responseDrainTimer = undefined;
        this.concludeResponseDrain(correlationId);
      }, this.responseDrainMs);
    };

    const capture = this.onPrivateOutput;
    if (capture === undefined || parsed.value.outcome === "failed") {
      settleUnderResultContract();
      return;
    }
    // Reserve terminal authority before the observer runs. Its callback can
    // resolve synchronously through an arbitrary Result implementation, so no
    // second settlement may enter once this flag is visible.
    this.settlementCapturePending = true;
    // Minted before the observer is called, so it names *this* capture. Any
    // terminal conclusion reached while the capture is pending bumps the epoch
    // and strands the continuation below.
    const captureToken = this.settlementCaptureEpoch;
    const invoked = Result.fromThrowable(
      () =>
        capture({
          output: privateOutput,
          byteLength: new TextEncoder().encode(privateOutput).byteLength,
          source: privateOutputSource,
        }),
      () => makeChildInteractionUnavailableFailure(this.childId),
    )();
    // The observer may synchronously re-enter the child and conclude it before
    // returning. Recheck the epoch before inspecting or acting on its result.
    if (!this.isSettlementCaptureLive(captureToken)) return;
    if (invoked.isErr()) {
      if (!this.isSettlementCaptureLive(captureToken)) return;
      this.failOutstanding(invoked.error);
      return;
    }
    if (invoked.value instanceof ResultAsync) {
      void invoked.value.match(
        () => {
          // A stale continuation is an inert handled value: it must not throw
          // (that would surface as an unhandled rejection) and must not settle
          // or install a drain timer on a child that already concluded.
          if (!this.isSettlementCaptureLive(captureToken)) return;
          this.settlementCapturePending = false;
          settleUnderResultContract();
        },
        (failure) => {
          if (!this.isSettlementCaptureLive(captureToken)) return;
          this.settlementCapturePending = false;
          this.failOutstanding(failure);
        },
      );
      return;
    }
    if (invoked.value.isErr()) {
      if (!this.isSettlementCaptureLive(captureToken)) return;
      this.failOutstanding(invoked.value.error);
      return;
    }
    if (!this.isSettlementCaptureLive(captureToken)) return;
    this.settlementCapturePending = false;
    settleUnderResultContract();
  }

  /**
   * Completes a drained settlement as soon as a terminal assistant response
   * arrives inside the drain window (Pi adapter contract §10).
   */
  private maybeFinishDrainedSettlement(): void {
    if (!this.settlementDraining || !this.terminalResponseObserved) return;
    const finish = this.finishSettlement;
    this.clearResponseDrainTimer();
    this.settlementDraining = false;
    this.finishSettlement = undefined;
    finish?.();
  }

  /**
   * Closes the drain window. Every final in-flight event has now been
   * observed, so a still-missing terminal response is a real result-contract
   * failure rather than a delivery race. The transcript and native history are
   * left exactly as recorded; only the outstanding waiter is failed.
   */
  private concludeResponseDrain(correlationId: string): void {
    if (!this.settlementDraining) return;
    if (this.terminalResponseObserved) {
      this.maybeFinishDrainedSettlement();
      return;
    }
    this.settlementDraining = false;
    this.finishSettlement = undefined;
    this.failOutstanding(
      makeChildResponseMissingFailure(this.childId, {
        reason: this.responseMissingReason(),
        parentId: this.parentId,
        correlationId,
      }),
    );
  }

  /** Names the contract failure from adapter-owned constants only. */
  private responseMissingReason(): PiChildResponseMissingReason {
    if (this.latestCompletedAssistantOutput.length > 0)
      return "whitespace-only";
    if (this.toolActivityObserved) return "tool-only";
    if (this.thinkingObserved) return "thinking-only";
    if (this.terminalAssistantMessageObserved) return "empty";
    return "no-response";
  }

  private clearResponseDrainTimer(): void {
    this.responseDrainTimer?.cancel();
    this.responseDrainTimer = undefined;
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
      this.observeResultContractEvent(parsed.data);
    }
    const type = normalized.value.type;
    if (type === "turn_start") {
      this.currentTurn += 1;
      // Keep the prior turn visible until this turn produces replacement text.
      // Clearing here makes the preview flash briefly and then disappear while
      // the child starts its next model or tool step.
      this.resetPreviewOnNextDelta = true;
      // No message is being written between turns, whatever the preview still
      // shows.
      this.closeLiveAnswer();
      this.onStreamingUpdate?.(this.snapshot());
      return;
    }
    if (type === "message_start") {
      // A new assistant message: a new lifecycle identity, and nothing written
      // into it yet. This is the only place an identity is minted from an
      // authoritative host statement.
      this.openLiveAnswer();
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
      // One classification for the whole frame. A frame carrying answer text
      // AND raw reasoning is rejected there, so it can neither publish
      // chain-of-thought as the parent-visible preview nor claim the child was
      // only thinking while it spoke.
      const carrier = classifyPiMessageUpdate(record);
      if (carrier.kind === "answer") {
        if (this.resetPreviewOnNextDelta) {
          this.latestOutput = "";
          this.reasoningObserved = false;
          this.resetPreviewOnNextDelta = false;
        }
        // Accumulate streamed deltas into the current transient buffer
        // rather than replacing it with only the very last delta -
        // `truncateLatestOutput` keeps the combined buffer bounded to
        // <=4KiB of valid UTF-8 at a code-point boundary.
        this.latestOutput = truncateLatestOutput(
          this.latestOutput + carrier.text,
        );
        // A host that streams text without ever framing a message still gets a
        // lifecycle identity, allocated on the first delta it writes.
        if (!this.liveAnswer.open) this.openLiveAnswer();
        this.liveAnswer = {
          ...this.liveAnswer,
          text: truncateLatestOutput(this.liveAnswer.text + carrier.text),
        };
        // Real answer text always wins over reasoning: once the model starts
        // speaking, the reasoning marker stops being what the parent shows.
        this.reasoningObserved = false;
        this.onStreamingUpdate?.(this.snapshot());
        return;
      }
      if (carrier.kind === "reasoning") {
        if (this.resetPreviewOnNextDelta) {
          this.latestOutput = "";
          this.reasoningObserved = false;
          this.resetPreviewOnNextDelta = false;
        }
        // The frame's PROSE never leaves the classifier; only the fact that it
        // arrived survives.
        this.reasoningObserved = true;
        // Only announce reasoning while there is no visible answer text yet -
        // a reasoning model can think for a long time before its first
        // token, and a silent snapshot makes a working child look frozen.
        if (this.latestOutput.length === 0) {
          this.onStreamingUpdate?.(this.snapshot());
        }
      }
      return;
    }
    if (type === "message_end") {
      // The message stops being written here, whatever the turn preview keeps
      // showing. Everything downstream reads this as "no answer is in flight".
      this.closeLiveAnswer();
      const message = record.message;
      const stopReason =
        isJsonRecord(message) && typeof message.stopReason === "string"
          ? message.stopReason
          : undefined;
      const assistantOutput = extractCompletedAssistantText(message);
      if (
        assistantOutput !== undefined &&
        (stopReason === undefined ||
          stopReason === "stop" ||
          stopReason === "length")
      ) {
        this.latestCompletedAssistantOutput = assistantOutput;
        this.terminalAssistantMessageObserved = true;
        if (assistantOutput.trim().length > 0)
          this.terminalResponseObserved = true;
      }
      this.projectUsageFromMessage(record);
      // A terminal message may legitimately arrive after the authenticated
      // settlement; classification waits for it (Pi adapter contract §10).
      this.maybeFinishDrainedSettlement();
      return;
    }
    if (type === "agent_settled") this.projectUsageFromMessage(record);
  }

  /**
   * Records what a parser-approved event contributes to the child result
   * contract (Pi adapter contract §10). Thinking blocks and tool activity are
   * tracked apart from assistant text so a contract failure can name its
   * reason from adapter-owned constants alone.
   */
  private observeResultContractEvent(event: PiChildSessionEvent): void {
    switch (event.type) {
      case "thinking":
        this.thinkingObserved = true;
        return;
      case "tool_call":
      case "tool_partial_result":
      case "tool_result":
      case "tool_error":
        this.toolActivityObserved = true;
        return;
      default:
        return;
    }
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
   * Verifies that a restored child is still anchored to the persisted active
   * leaf. Pi exposes no safe in-place branch-selection RPC, so anything the
   * parent cannot authenticate is terminal rather than an invitation to issue
   * an unsupported switch/fork.
   *
   * Pi 0.83 appends its own startup state entries (`model_change`,
   * `thinking_level_change`) to a restored session before the parent gets to
   * run this check, so the reported active leaf legitimately moves past the
   * persisted leaf. The persisted leaf is therefore authenticated as an
   * *ancestor* of the reported leaf, and only a bounded contiguous suffix of
   * Pi-owned startup state entries is tolerated between them. Any message,
   * tool, custom, or other transcript-bearing entry, any broken/duplicated
   * parent link, and any oversized suffix fail closed.
   *
   * The read is a bounded cursor page (`get_entries` with `since` = persisted
   * leaf), never a full transcript read.
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

    const establishedLeafId = activeLeafId.value;
    return this.getEntries(
      this.childId,
      this.generationId,
      establishedLeafId,
    ).andThen((entries) => {
      const authenticated = authenticateRestoreStartupSuffix(
        establishedLeafId,
        entries,
      );
      if (authenticated.isErr()) {
        return errAsync(
          makeChildAuthenticationFailedFailure(
            this.childId,
            authenticated.error,
          ),
        );
      }
      return this.notifyRestoreContextVerified({
        activeLeafId: establishedLeafId,
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
    // Bootstrap acknowledgement establishes the one complete identity against
    // which the first authenticated `applied` phase must compare. Prefer the
    // child's bounded echo because it is the identity it actually applied;
    // retain the parent's expected identity only when the echo is omitted.
    this.currentModelIdentity = ack.resolvedModel ?? expected.resolvedModel;
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
   * The absolute wall-clock cap expired (Pi adapter contract). Unlike the
   * renewable inactivity budget this can fire while the child is perfectly
   * busy, so it fails closed: every outstanding waiter is rejected with the
   * distinct `ChildRuntimeExceeded` failure and `failOutstanding` force-kills
   * the process and erases the secret. The child's thread and native session
   * are left untouched, so the run stays explicitly recoverable.
   *
   * The cap stays authoritative over the post-settlement response drain: the
   * drain window keeps a settlement waiter outstanding, so deferring to it
   * would let the absolute budget be silently ignored at the exact moment the
   * parent is still blocked. `failOutstanding` rejects that waiter and
   * `terminateResources` cancels the drain timer and clears
   * `settlementDraining`, so `concludeResponseDrain` /
   * `maybeFinishDrainedSettlement` can no longer settle the child a second
   * time.
   *
   * Work that is already finished is never retroactively failed: a disposed or
   * settled child, and a cancellation already in progress (itself bounded by
   * the cancel grace timer), ignore the cap and let their own terminal path
   * run. The timer is cleared first on every path, so it never outlives this
   * call.
   */
  private handleRuntimeBudgetExpiry(): void {
    this.runtimeBudget.clear();
    if (this.disposed || this.settled || this.status === "cancelling") {
      return;
    }
    this.logger.warn(
      { childId: this.childId, budgetMs: this.runtimeBudget.getBudgetMs() },
      "child exceeded its absolute runtime budget; force-killing",
    );
    this.failOutstanding(
      makeChildRuntimeExceededFailure(
        this.childId,
        this.runtimeBudget.getBudgetMs(),
      ),
    );
  }

  /**
   * Invalidates any settlement capture still in flight. Called by every
   * terminal path before it mutates status or resolvers, so a continuation
   * queued earlier can no longer act on this child.
   */
  private invalidateSettlementCapture(): void {
    this.settlementCaptureEpoch += 1;
    this.settlementCapturePending = false;
  }

  /**
   * True only when `token` is still the live capture *and* the child has not
   * reached any terminal state. Both halves matter: the epoch catches the
   * ordering the token was minted for, and the terminal-state checks catch a
   * conclusion that (today or after a future edit) forgets to bump it.
   */
  private isSettlementCaptureLive(token: number): boolean {
    return (
      token === this.settlementCaptureEpoch &&
      !this.disposed &&
      !this.settled &&
      this.terminalFailure === undefined &&
      this.status !== "failed" &&
      this.status !== "cancelled" &&
      this.status !== "cancelling"
    );
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
    // Fences any settlement capture still in flight before status changes, so
    // its continuation cannot re-enter and rewrite this terminal cause.
    this.invalidateSettlementCapture();
    // Recorded before cleanup so a spawn still in flight can be rejected with
    // the real terminal cause instead of inventing a second one.
    this.terminalFailure ??= failure;
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
    // Terminal cleanup always invalidates a pending capture, even on the paths
    // that reach here without going through `failOutstanding` (settlement's
    // own `finish()`, `dispose()`, completed cancellation).
    this.invalidateSettlementCapture();
    this.outstandingExtensionUiRequestIds.clear();
    this.clearResponseDrainTimer();
    this.runtimeBudget.clear();
    this.settlementDraining = false;
    this.finishSettlement = undefined;
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
   *
   * Delivery failures are swallowed after forced cleanup so ordinary
   * Escape/subtree cancellation still resolves cleanly. Session transitions
   * that must veto on an undelivered cancel use
   * `cancelForTransition` instead.
   */
  cancel(): ResultAsync<void, PiAdapterFailure> {
    return this.runCancellation({ reportDeliveryFailure: false });
  }

  /**
   * Session-transition cancel path: same forced cleanup as `cancel`,
   * but an undelivered authenticated cancel or raw abort surfaces as a
   * closed `ChildAbortFailed` so the transition guard can veto. Ordinary
   * cleanup callers must keep using `cancel`.
   */
  cancelForTransition(): ResultAsync<void, PiAdapterFailure> {
    return this.runCancellation({ reportDeliveryFailure: true });
  }

  private runCancellation(options: {
    readonly reportDeliveryFailure: boolean;
  }): ResultAsync<void, PiAdapterFailure> {
    if (this.disposed || this.settled)
      return new ResultAsync(Promise.resolve(ok(undefined)));
    this.status = "cancelling";
    let deliveryFailed = false;
    return this.sendControl(
      "cancel",
      this.childId,
      makeCancelBody("cancelled-by-parent"),
    )
      .orElse((failure) => {
        deliveryFailed = true;
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
                  deliveryFailed = true;
                  this.logger.warn(
                    { childId: this.childId, code: failure.type },
                    "raw abort command failed to write; proceeding to bounded force-kill regardless",
                  );
                  return okAsync(undefined);
                });
        return abortWrite.andThen(() => this.waitBoundedThenForceKill());
      })
      .andThen(() => {
        if (options.reportDeliveryFailure && deliveryFailed) {
          return errAsync(
            makeChildAbortFailedFailure(
              this.childId,
              "transition-cancel-delivery-failed",
            ),
          );
        }
        return okAsync(undefined);
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
    this.invalidateSettlementCapture();
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
  if (typeof content === "string") return content;
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
  return text;
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
