import { join } from "node:path";
import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_RUNTIME_SETTINGS,
  type ThinkingLevelDecl,
} from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  DelegationTarget,
  PlanStateProvider,
  RuntimeLogFileSystem,
  RuntimeStore,
} from "@weaveio/weave-engine";
import {
  env,
  isDeniedKey,
  logger,
  redirectLogsToFile,
} from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  listCycleablePrimaryAgents,
  nextCycleablePrimaryAgent,
  PI_PRIMARY_AGENT_CYCLE_SHORTCUT,
  renderActiveAgentBadge,
} from "./agent-cycle.js";
import { BunPiArtifactProvider } from "./artifact-provider.js";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
  WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV,
} from "./capability-prober.js";
import {
  parseControlBody,
  toModelIdentityBody,
} from "./child-control-bodies.js";
import {
  type HmacPort,
  type RandomPort,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "./child-crypto.js";
import {
  BunEnvPort,
  buildDefaultPiChildCommand,
  sanitizedBaseEnv,
  WEAVE_CHILD_SECRET_ENV,
} from "./child-env.js";
import type { PiChildHistoryRecord } from "./child-history-schema.js";
import { PiChildHistoryStore } from "./child-history-store.js";
import { createChildInspectionCustomComponent } from "./child-inspection-custom.js";
import {
  createChildInspectionEditor,
  type PiChildInspectionEditor,
} from "./child-inspection-editor.js";
import type { PiChildInspectionRenderInput } from "./child-inspection-render.js";
import {
  formatPiChildInspectionSettingsIssues,
  type PiChildInspectionEffectiveSettings,
  type PiChildInspectionSettingsChoice,
} from "./child-inspection-settings.js";
import {
  PiChildInspector,
  PiChildSlots,
  type PiInspectorChild,
  type PiInspectorView,
} from "./child-inspector.js";
import {
  buildChildPickerEntries,
  type PiChildPickerNode,
  sanitizeChildPickerPreview,
} from "./child-picker.js";
import {
  BunPiChildProcessPort,
  type PiChildProcessPort,
} from "./child-process-port.js";
import type { PiChildRecoverySpawnInput } from "./child-recovery.js";
import { PiChildRecoveryCoordinator } from "./child-recovery.js";
import {
  type PiChildOutputError,
  type PiChildOutputPort,
  PiChildRuntime,
  type PiChildRuntimeError,
} from "./child-runtime.js";
import {
  applyTreeControlKey,
  createPiChildHistoryPort,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantStopReason,
  extractAssistantTextDeltaPreview,
  PiChildInspectionRegistry,
  type PiChildTreeNode,
  ROOT_NODE_ID,
  truncateLatestOutput,
} from "./child-tree.js";
import {
  classifyChildInspectorKey,
  classifyChildTreeKey,
} from "./child-tree-keys.js";
import { renderChildTreeLines } from "./child-tree-render.js";
import {
  WEAVE_COMMAND_NAMES,
  type WeaveCommandName,
} from "./commands.js";
import {
  logMaterializationErrors,
  PiConfigActivator,
} from "./config-activator.js";
import {
  PiExtensionController,
  type PiExtensionControllerDeps,
} from "./controller.js";
import {
  type PiDelegationContext,
  PiDelegationController,
} from "./delegation-controller.js";
import {
  buildDelegationToolRegistration,
  buildRelayedDelegationToolRegistration,
} from "./delegation-tool.js";
import { TransportDirectDispatchPort } from "./direct-dispatch.js";
import {
  createDirectDispatchTransport,
  PiDirectStepChildRegistry,
} from "./direct-dispatch-transport.js";
import {
  makeChildAbortFailedFailure,
  makeLogWriteFailedFailure,
  mapPlanStateErrorToPiFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  BunHostPackageReader,
  type HostPackageReader,
} from "./host-compatibility.js";
import {
  DefaultPiHostSurfaceReader,
  emptyHostSurfaceReport,
  type PiHostSurfaceReader,
  readValidatedCommands,
  safeReadHostSurfaceReport,
} from "./host-inventory.js";
import {
  PiModelActivator,
  type PiModelApplyPort,
  type PiModelResolution,
  PiModelResolver,
  type PiThinkingApplyPort,
} from "./model-resolution.js";
import {
  BunPathContainmentPort,
  type PathContainmentPort,
} from "./path-containment.js";
import {
  BunPiPlanCatalogPort,
  type PiPlanCatalogPort,
} from "./plan-catalog.js";
import { createPiPlanStateProvider } from "./plan-provider.js";
import { renderPlanWidgetLines } from "./plan-render.js";
import { safelyListAvailableModels } from "./port-safety.js";
import {
  DEFAULT_PRIMARY_AGENT_NAME,
  type PiPrimaryActivationError,
  PiPrimarySession,
} from "./primary-session.js";
import {
  PROMPT_CHUNK_COMMAND,
  PromptChunkAssembler,
  parsePromptChunk,
  promptTransferNackReason,
} from "./prompt-chunking.js";
import {
  activeInstanceFromRecoveryPointer,
  BunJsonlRecoveryPointerStore,
  isPointerEligibleForExplicitResume,
} from "./recovery-pointer.js";
import {
  type PiRuntimeStoreFactory,
  SqliteRuntimeStoreFactory,
} from "./runtime-store-port.js";
import { PiSafeInitializer } from "./safe-initializer.js";
import { PiSkillCatalog } from "./skill-catalog.js";
import { type JsonValue, parseStrictJson } from "./strict-json.js";
import {
  buildWeaveCompleteStepToolRegistration,
  type CompletionRecordAttempt,
  SingleCompletionCandidateRecorder,
  serializeCompletionCandidate,
  type WEAVE_COMPLETE_STEP_TOOL_NAME,
} from "./structured-completion.js";
import {
  createPiTelemetry,
  extractAssistantUsageFromMessage,
  type PiJournalPort,
  type PiRetentionPort,
  type PiTelemetry,
  type PiTelemetryUiPort,
  type PiUsagePort,
} from "./telemetry.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiEnvPort,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiSkillInfo,
} from "./types.js";
import {
  buildPaletteActions,
  handleWeaveAbort,
  handleWeaveAdvance,
  handleWeaveArtifact,
  handleWeavePlan,
  handleWeaveResume,
  handleWeaveRun,
  handleWeaveStart,
  handleWeaveStatus,
  type PiActiveWorkflowTracker,
  type PiForegroundPlanStartFailure,
  type PiPaletteAction,
} from "./workflow-commands.js";
import { PiWorkflowController } from "./workflow-controller.js";

export const PI_SHARED_LOG_PATH = ".weave/weave.log";
const TAPESTRY_PRIMARY_AGENT_NAME = "tapestry";

type PiPrimarySwitchFailure =
  | { readonly type: "PrimarySwitchUnavailable" }
  | { readonly type: "DirectStepActive" }
  | { readonly type: "PrimaryDescriptorMissing"; readonly agentName: string }
  | { readonly type: "PrimaryDescriptorIneligible"; readonly agentName: string }
  | { readonly type: "PrimarySkillCatalogUnavailable" }
  | { readonly type: "PrimarySwitchGenerationStale" }
  | {
      readonly type: "PrimaryActivationFailed";
      readonly agentName: string;
      readonly cause: PiPrimaryActivationError;
    };

function renderPlanStartPrompt(planName: string): string {
  return `Execute the existing Weave plan at \`.weave/plans/${planName}.md\`. Begin with the first unchecked task and continue until every task is complete.`;
}

interface PiGenerationGuard {
  assertStillCurrent(): Result<void, PiAdapterFailure>;
}

export interface PiSharedLogRedirector {
  redirect(filePath: string): ResultAsync<void, PiAdapterFailure>;
}

class DefaultPiSharedLogRedirector implements PiSharedLogRedirector {
  redirect(filePath: string): ResultAsync<void, PiAdapterFailure> {
    if (env.WEAVE_LOG_FILE !== undefined) return okAsync(undefined);
    return ResultAsync.fromPromise(redirectLogsToFile(filePath), () =>
      makeLogWriteFailedFailure("shared-log-redirect-failed"),
    );
  }
}

/** Every dependency this extension needs beyond what Pi hands it directly. Fully injectable for tests. */
export interface PiExtensionDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly hostSurfaceReader?: PiHostSurfaceReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: PiAdapterLogger;
  readonly logRedirector: PiSharedLogRedirector;
  readonly configActivator: PiConfigActivator;
  readonly envPort: PiEnvPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly processPort: PiChildProcessPort;
  /**
   * The private RPC child's default spawn command (Pi adapter contract finding
   * 1): the exact executable that launched this host process, never a bare
   * `"pi"` a spawner would have to re-resolve via `PATH` (which can
   * silently select an unrelated, PATH-shadowing `pi` install). Production
   * wiring MUST derive this via `buildDefaultPiChildCommand(envPort)`;
   * tests MUST override with a fixed command, independent of both `PATH`
   * and the real launching executable.
   */
  readonly childCommand: readonly string[];
  readonly childOutputPort: PiChildOutputPort;
  /** Optional private inspector/history sink for complete child output. */
  readonly onChildPrivateOutput?: (
    childId: string,
    capture: { readonly output: string; readonly byteLength: number },
  ) => Result<void, PiAdapterFailure> | ResultAsync<void, PiAdapterFailure>;
  /**
   * Opens the engine's Runtime Store (Pi adapter contract) - injected so no test
   * ever performs a real SQLite open/migration against a real (or
   * nonexistent, unwritable) path. Production wiring MUST use
   * `SqliteRuntimeStoreFactory`; tests MUST override with
   * `InMemoryRuntimeStoreFactory`/`FailingRuntimeStoreFactory`.
   */
  readonly runtimeStoreFactory: PiRuntimeStoreFactory;
  /** Stable identity supplied by the host; unlike a generation ID it survives reload. */
  readonly parentSessionId?: (ctx: PiSessionContext) => string;
  /** Opens the one per-parent-session child history store. Injectable for tests. */
  readonly childHistoryStoreFactory?: (
    parentSessionId: string,
    settings: PiActiveSession["childInspectionSettings"],
  ) => ResultAsync<PiChildHistoryStore, unknown>;
  /** Injectable ordinary-child recovery seam. Production falls back to the
   * authenticated delegation controller restore path. */
  readonly restoreOrdinaryChild?: (
    input: PiChildRecoverySpawnInput,
  ) => ReturnType<PiDelegationController["restoreOrdinaryChild"]>;
  /**
   * Real, no-follow-safe containment proof for `.weave/runtime`/
   * `.weave/plans` (Pi adapter contract) - injected into
   * `PiSafeInitializer` so capability probing never merely trusts
   * `configLoaded`. Production wiring MUST use `BunPathContainmentPort`;
   * tests MUST override with `FakePathContainmentPort`/
   * `NullPathContainmentPort` (Pi adapter contract: no real process spawn
   * in a test).
   */
  readonly pathContainmentPort: PathContainmentPort;
  /**
   * Production, no-follow-safe `.weave/plans` directory listing (Pi adapter contract
   *) - backs `/weave:start`'s plan-selection prompt and `/weave:plan`'s
   * catalog. Production wiring MUST use `BunPiPlanCatalogPort`; tests MUST
   * override with `FakePiPlanCatalogPort` (Pi adapter contract: no real
   * filesystem scan in a test).
   */
  readonly planCatalogPort: PiPlanCatalogPort;
  /** Adapter-local plan state seam for trusted-session tests. */
  readonly planStateProviderFactory?: (
    projectRoot: string,
  ) => PlanStateProvider;
  /**
   * Injectable telemetry seams (Pi adapter contract) — journal/usage/retention
   * ports and the rotating log-sink filesystem. Absent means "construct
   * the real engine-backed implementation against the opened Runtime
   * Store" (production default). Tests MUST override with in-memory/fake
   * seams (Pi adapter contract: no real filesystem/log rotation in a
   * unit test).
   */
  readonly telemetryLogFileSystem?: RuntimeLogFileSystem;
  readonly telemetryJournal?: PiJournalPort;
  readonly telemetryUsage?: PiUsagePort;
  readonly telemetryRetention?: PiRetentionPort;
}

/** Production child-side stdout writer: writes directly to this process's own real stdout, interleaved with Pi's own event/response lines. */
class StdoutChildOutputPort implements PiChildOutputPort {
  // Bun's own stdout `FileSink` writer, never Node's `process.stdout`.
  private readonly writer = Bun.stdout.writer();

  writeLine(bytes: Uint8Array): ResultAsync<void, PiChildOutputError> {
    return ResultAsync.fromThrowable(
      async () => {
        this.writer.write(bytes);
        await this.writer.flush();
      },
      (): PiChildOutputError => ({
        type: "ChildOutputWriteFailed",
        reason: "stdout-write-failed",
      }),
    )();
  }
}

class CryptoIdGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Production dependency set. No I/O happens here - everything is deferred to `session_start`. */
export function createDefaultPiExtensionDeps(): PiExtensionDeps {
  const log = logger.child({ module: "adapter-pi" });
  const envPort = new BunEnvPort();
  return {
    hostPackageReader: new BunHostPackageReader(),
    hostSurfaceReader: new DefaultPiHostSurfaceReader(),
    capabilityProber: new DefaultPiCapabilityProber({
      enforceCommandProvenance:
        envPort.read(WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV) !== "1",
    }),
    idGenerator: new CryptoIdGenerator(),
    clock: new SystemClock(),
    logger: log,
    logRedirector: new DefaultPiSharedLogRedirector(),
    configActivator: new PiConfigActivator(),
    envPort,
    randomPort: new WebCryptoRandomPort(),
    hmacPort: new WebCryptoHmacPort(),
    processPort: new BunPiChildProcessPort(),
    childCommand: buildDefaultPiChildCommand(envPort),
    childOutputPort: new StdoutChildOutputPort(),
    runtimeStoreFactory: new SqliteRuntimeStoreFactory(),
    childHistoryStoreFactory: (parentSessionId, settings) =>
      PiChildHistoryStore.open(parentSessionId, settings),
    pathContainmentPort: new BunPathContainmentPort(),
    planCatalogPort: new BunPiPlanCatalogPort(),
  };
}

/** Builds the sanitized base environment forwarded to private Pi children. */
function buildPiChildBaseEnv(): Record<string, string> {
  return sanitizedBaseEnv(isDeniedKey);
}

/**
 * The materialized descriptor catalog and primary-activation state for one
 * generation under the Pi adapter contract. Kept out of
 * `PiExtensionController`'s own `PiGeneration` type to keep the controller
 * contract stable; a future change may fold this in.
 *
 * Primary activation (skills + model, together) is deferred from
 * `session_start` to the *first* `before_agent_start` on purpose: Pi only
 * exposes its loaded skill catalog via `systemPromptOptions.skills` at that
 * point (not at `session_start`), and the Pi adapter contract requires activation
 * to be atomic across skills and model together - so neither can be
 * committed before both are knowable.
 */
interface PiActiveSession {
  readonly generationId: string;
  /** One identity shared by future store, inspector, and recovery seams. */
  readonly childInspectionSettings: PiChildInspectionEffectiveSettings;
  readonly primarySession: PiPrimarySession;
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>;
  readonly disabledSkills: readonly string[];
  pendingPrimaryName: string | undefined;
  primaryActivationAttempted: boolean;
  /** A native set/cycle made before first activation owns that first turn's model. */
  userSelectedModelBeforeActivation: boolean;
  primaryActivationFailure: PiPrimaryActivationError | undefined;
}

/** Reads `event.systemPrompt` (Pi adapter contract) without assuming any other event shape. */
function readSystemPrompt(event: unknown): string {
  if (typeof event === "object" && event !== null && "systemPrompt" in event) {
    const value = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Reads `event.systemPromptOptions.skills` (Pi's real, already-loaded skill
 * catalog for this turn under the Pi adapter contract without assuming any other shape.
 * Malformed or missing entries are dropped rather than throwing.
 */
function readBeforeAgentStartSkills(event: unknown): readonly PiSkillInfo[] {
  if (typeof event !== "object" || event === null) return [];
  const options = (event as { systemPromptOptions?: unknown })
    .systemPromptOptions;
  if (typeof options !== "object" || options === null) return [];
  const skills = (options as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter(
    (skill): skill is PiSkillInfo =>
      typeof skill === "object" &&
      skill !== null &&
      typeof (skill as { name?: unknown }).name === "string",
  );
}

/**
 * Wraps Pi's real `ExtensionAPI.setModel(model)` (Pi adapter contract) so a
 * throwing or rejecting host call never escapes as an unhandled exception -
 * it is captured and reported as a degraded model activation instead.
 */
function createPiModelApplyPort(pi: PiExtensionApi): PiModelApplyPort {
  return {
    applyModel: (model: PiModelInfo) =>
      ResultAsync.fromThrowable(
        async () => {
          const applied = await pi.setModel(model);
          // `setModel` may resolve to `false` without throwing (the host
          // declined the selection) - that is a failed application, not a
          // success, and must not be silently treated as one.
          if (applied === false) {
            throw new Error("Pi declined the model selection");
          }
        },
        (cause): Error =>
          cause instanceof Error ? cause : new Error(String(cause)),
      )(),
  };
}

function createPiThinkingApplyPort(
  pi: PiExtensionApi,
): PiThinkingApplyPort | undefined {
  if (pi.setThinkingLevel === undefined) return undefined;
  return {
    applyThinkingLevel: (level) =>
      ResultAsync.fromThrowable(
        async () => {
          await pi.setThinkingLevel?.(level);
        },
        (cause): Error =>
          cause instanceof Error ? cause : new Error(String(cause)),
      )(),
  };
}

/**
 * Hidden, non-public command a private child process's own extension
 * instance uses to receive parent-to-child authenticated control envelopes
 * (Pi adapter contract). Delivered as ordinary RPC `prompt` command text
 * (`/weave:__control__ <json>`) - never `steer`/`follow_up` - so it rides
 * Pi's own documented command dispatch rather than any raw sideband.
 */
const HIDDEN_CONTROL_COMMAND_NAME = "weave:__control__";

interface PiChildBootstrapCommon {
  readonly agentName: string;
  readonly composedPrompt: string;
  readonly models: readonly string[];
  readonly delegationTargets: readonly DelegationTarget[];
  /** Must equal this child's own env-derived child id (Pi adapter contract); a mismatch fails closed. */
  readonly correlationId: string;
  readonly context: PiDelegationContext;
  /** Present only when the parent itself resolved a concrete model identity (root-level delegation, live `ctx.modelRegistry`); absent means this child must resolve against its own authenticated catalog (Pi adapter contract). */
  readonly resolvedModel?: PiModelInfo;
  /** Core-owned thinking intent selected alongside the transport model identity. */
  readonly thinkingLevel?: ThinkingLevelDecl;
}

/**
 * Strict, mode-discriminated bootstrap union (Pi adapter contract): `mode:
 * "ordinary"` for a delegation-spawned child (`weave_delegate` or relayed
 * nested delegation), `mode: "direct-step"` for a workflow-step child
 * spawned directly by `PiWorkflowController`. Only the direct-step variant
 * carries workflow instance/lease/step correlation and receives the
 * governed `weave_complete_step` tool - nested helpers spawned BY a
 * direct-step child are always bootstrapped through the ordinary path, so
 * completion authority never propagates below the root direct-step child.
 */
type PiChildBootstrapBody =
  | (PiChildBootstrapCommon & { readonly mode: "ordinary" })
  | (PiChildBootstrapCommon & {
      readonly mode: "direct-step";
      readonly workflowInstanceId: string;
      readonly leaseId: string;
      readonly stepName: string;
      readonly completionTool: typeof WEAVE_COMPLETE_STEP_TOOL_NAME;
    });

/**
 * Builds one delegated child's bootstrap payload from its own resolved
 * descriptor (Pi adapter contract) - critically including that
 * descriptor's own `delegationTargets`, so a running child can register
 * its own nested/descendant delegation tool once bootstrapped, relayed
 * through its authenticated parent/root coordinator rather than an
 * independent, untracked budget. When a live session `ctx` is available
 * (root-level delegation only), it also carries a concrete parent-resolved
 * model identity.
 */
export function buildChildBootstrapBody(
  descriptorsByName: ReadonlyMap<string, AgentDescriptor>,
  target: DelegationTarget,
  childId: string,
  context: PiDelegationContext,
  ctx?: PiSessionContext,
): JsonValue {
  const full = descriptorsByName.get(target.name);
  const resolution = ((): PiModelResolution | undefined => {
    if (ctx === undefined) return undefined;
    const availableModels = safelyListAvailableModels(
      ctx.modelRegistry,
    ).unwrapOr([]);
    return new PiModelResolver().resolve(full?.models ?? [], availableModels);
  })();
  // The matched entry is drawn straight from the host's own
  // `ctx.modelRegistry.getAvailable()` results and may carry fields
  // beyond provider/id/name; project it down before it ever reaches a
  // `ModelIdentityBodySchema`-validated control body (Pi adapter contract
  //). The thinking declaration is core-owned intent, not part of
  // the compact host model identity.
  const resolvedModel =
    resolution?.resolved === true
      ? toModelIdentityBody(resolution.model)
      : undefined;
  const thinkingLevel =
    resolution?.resolved === true ? resolution.thinkingLevel : undefined;
  const bootstrap: PiChildBootstrapBody = {
    mode: "ordinary",
    agentName: target.name,
    composedPrompt: full?.composedPrompt ?? "",
    models: full?.models ?? [],
    delegationTargets: full?.delegationTargets ?? [],
    correlationId: childId,
    context,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  return bootstrap as unknown as JsonValue;
}

/**
 * Validates a raw bootstrap body against the real strict schema (Pi adapter contract
 *) instead of ad hoc field reads with silent defaults. A malformed
 * body fails closed: bootstrap is never applied and the parent's own
 * `awaitBootstrapAck` times out, producing a typed `ChildReplyMissing`
 * failure for that child rather than silently proceeding with empty
 * descriptor/model/policy state.
 */
function parseChildBootstrapBody(
  body: JsonValue,
): PiChildBootstrapBody | undefined {
  const parsed = parseControlBody("bootstrap", body);
  if (!parsed.ok) return undefined;
  const common = {
    agentName: parsed.value.agentName,
    composedPrompt: parsed.value.composedPrompt,
    models: parsed.value.models,
    delegationTargets: parsed.value.delegationTargets ?? [],
    correlationId: parsed.value.correlationId,
    context: parsed.value.context,
    resolvedModel: parsed.value.resolvedModel,
    thinkingLevel: parsed.value.thinkingLevel,
  };
  if (parsed.value.mode === "direct-step") {
    return {
      ...common,
      mode: "direct-step",
      workflowInstanceId: parsed.value.workflowInstanceId,
      leaseId: parsed.value.leaseId,
      stepName: parsed.value.stepName,
      completionTool: parsed.value.completionTool,
    };
  }
  return { ...common, mode: "ordinary" };
}

/**
 * Per-generation state for a spawned private child's own extension
 * instance. Distinct from `PiActiveSession` (the parent's own generation
 * state) - a real process is either a parent TUI session or a private RPC
 * child, never both at once, but both share this one compiled extension
 * module.
 */
interface PiChildModeState {
  active: boolean;
  childId: string;
  agentName: string;
  composedPrompt: string;
  promptAppended: boolean;
  /** True only once the bootstrap descriptor and model have been applied and acked. */
  bootstrapApplied: boolean;
  runtime: PiChildRuntime | undefined;
  /**
   * The current turn's accumulated assistant text, truncated to <=4KiB
   * valid UTF-8 (Task 9). Reset on every `turn_start` so a stale
   * previous turn's text is never reported as this turn's settlement
   * output; fed by `message_update` deltas; read (and re-truncated as a
   * belt-and-suspenders bound) when `agent_settled` fires.
   */
  latestAssistantOutput: string;
  /** Full terminal assistant text kept private for transfer/history capture. */
  fullAssistantOutput: string;
  /**
   * The most recently observed assistant `stopReason` from a `message_end`
   * event (Task 9) - `"stop"`, `"length"`, `"toolUse"`, `"error"`,
   * or `"aborted"`. `agent_settled` itself carries no payload, so this is
   * the only observable signal available to derive a failed outcome.
   */
  lastAssistantStopReason: string | undefined;
  /**
   * Present only for a direct-step child (Pi adapter contract) - `undefined`
   * for every ordinary-delegation child. Drives `weave_complete_step`
   * registration and structured (not free-text) settlement reporting.
   */
  directStep: PiDirectStepChildState | undefined;
}

/** Per-turn direct-step completion state (Pi adapter contract). */
interface PiDirectStepChildState {
  readonly stepName: string;
  readonly recorder: SingleCompletionCandidateRecorder;
  /** Flips to `false` the instant `agent_settled` fires, closing the completion window for any late tool call. */
  windowOpen: boolean;
  /** The last recorded attempt outcome, consulted only when no candidate was ever recorded (missing/duplicate/late/malformed). */
  lastAttempt: CompletionRecordAttempt | undefined;
}

function createChildModeState(): PiChildModeState {
  return {
    active: false,
    childId: "",
    agentName: "",
    composedPrompt: "",
    promptAppended: false,
    bootstrapApplied: false,
    runtime: undefined,
    directStep: undefined,
    latestAssistantOutput: "",
    fullAssistantOutput: "",
    lastAssistantStopReason: undefined,
  };
}

function reportChildSettlement(
  runtime: PiChildRuntime,
  outcome: "completed" | "failed",
  detail: {
    assistantOutput?: string;
    completionCandidate?: string;
    outputTransferId?: string;
    outputByteLength?: number;
    reason?: string;
  },
): ResultAsync<void, PiChildRuntimeError> {
  return runtime
    .reportSettled(outcome, detail)
    .orElse(() => runtime.reportSettled(outcome, detail));
}

async function applyChildThinkingLevel(
  pi: PiExtensionApi,
  thinkingLevel: ThinkingLevelDecl | undefined,
  logger: PiExtensionDeps["logger"],
): Promise<void> {
  if (thinkingLevel === undefined) return;
  const thinkingApplier = createPiThinkingApplyPort(pi);
  if (thinkingApplier === undefined) return;
  const result = await thinkingApplier.applyThinkingLevel(thinkingLevel);
  if (result.isErr()) {
    logger.warn(
      { thinkingLevel, error: result.error },
      "child thinking-level activation failed; keeping model activation successful",
    );
  }
}

/**
 * Applies the parent's bootstrap payload to this child's own extension
 * state: records the descriptor's composed prompt for one-time append in
 * `before_agent_start`, registers its Weave tools, and resolves and applies
 * its own model intent without overriding the parent's primary session.
 */
async function applyChildBootstrap(
  pi: PiExtensionApi,
  ctx: PiSessionContext,
  deps: PiExtensionDeps,
  state: PiChildModeState,
  runtime: PiChildRuntime,
  body: JsonValue,
): Promise<void> {
  const parsed = parseChildBootstrapBody(body);
  if (parsed === undefined) {
    deps.logger.error(
      {},
      "malformed bootstrap body; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }
  // Correlation check (Pi adapter contract): the bootstrap's own
  // `correlationId` must match this child's own env-derived child id -
  // anything else means this bootstrap targets a different child (or is
  // forged), and must never be applied.
  if (parsed.correlationId !== state.childId) {
    deps.logger.error(
      {},
      "bootstrap correlationId mismatch; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }
  // Constructed unconditionally (cheap, no side effects) so the tool
  // registration closure below can capture it regardless of `parsed.mode`;
  // only ever consulted when `parsed.mode === "direct-step"`.
  const directStepRecorder = new SingleCompletionCandidateRecorder();
  // A bootstrapped child with its own declared delegation targets gets its
  // own weave_delegate tool, relayed through this exact child's own
  // authenticated runtime rather than an independent budget.
  const toolRegistrations = [
    ...(parsed.delegationTargets.length === 0
      ? []
      : [
          buildRelayedDelegationToolRegistration({
            targets: parsed.delegationTargets,
            getRuntime: () => state.runtime,
          }),
        ]),
    // Only a direct-step child (Pi adapter contract) ever receives
    // `weave_complete_step`; nested helpers it may itself spawn always use
    // the ordinary path above and never get this registration, so
    // completion authority never propagates below the root direct-step
    // child.
    ...(parsed.mode === "direct-step"
      ? [
          buildWeaveCompleteStepToolRegistration({
            stepName: parsed.stepName,
            recorder: directStepRecorder,
            isWindowOpen: () => state.directStep?.windowOpen ?? false,
            onAttempt: (attempt) => {
              if (state.directStep !== undefined) {
                state.directStep.lastAttempt = attempt;
              }
            },
          }),
        ]
      : []),
  ];
  const registerTools = Result.fromThrowable(
    () => {
      for (const registration of toolRegistrations) {
        pi.registerTool(registration);
      }
    },
    (error) => (error instanceof Error ? error : new Error(String(error))),
  );
  if (registerTools().isErr()) {
    deps.logger.error(
      {},
      "child Weave tool registration failed; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }

  // Model activation (Pi adapter contract): rehydrate the parent's
  // compact resolved identity from this child's authenticated catalog when
  // present (root-level delegation); otherwise resolve the descriptor's
  // intent against that catalog. Only a full catalog model may reach
  // `pi.setModel()`; the compact identity exists only on the control channel.
  // Only a genuine *activation* failure (a model resolved but the host
  // rejected applying it) fails bootstrap closed. "Nothing in the intent
  // resolved" is not a failure - the Pi adapter contract requires gracefully keeping
  // whatever model Pi already had active in that case, so `appliedModel`
  // may legitimately stay `undefined` (no override took effect) without
  // blocking the rest of bootstrap.
  let appliedModel: PiModelInfo | undefined;
  if (parsed.resolvedModel !== undefined) {
    const availableModels = safelyListAvailableModels(
      ctx.modelRegistry,
    ).unwrapOr([]);
    const resolved = new PiModelResolver().resolveIdentity(
      parsed.resolvedModel,
      availableModels,
    );
    if (resolved.isErr()) {
      deps.logger.error(
        { reason: resolved.error.type },
        "parent-resolved model is not a unique child catalog entry; failing closed and never acking bootstrap",
      );
      runtime.dispose();
      return;
    }
    const applyResult = await createPiModelApplyPort(pi).applyModel(
      resolved.value,
    );
    if (applyResult.isErr()) {
      deps.logger.error(
        {},
        "host rejected parent-resolved model; failing closed and never acking bootstrap",
      );
      runtime.dispose();
      return;
    }
    appliedModel = toModelIdentityBody(resolved.value);
    await applyChildThinkingLevel(pi, parsed.thinkingLevel, deps.logger);
  } else {
    const availableModels = safelyListAvailableModels(
      ctx.modelRegistry,
    ).unwrapOr([]);
    const outcomeResult = await new PiModelActivator().activate(
      parsed.models,
      availableModels,
      ctx.model,
      createPiModelApplyPort(pi),
    );
    // `activate()` is typed `ResultAsync<PiModelActivationOutcome, never>` -
    // it never fails, only ever reports "applied" or "degraded" outcomes -
    // so unwrapping here can never throw.
    const outcome = outcomeResult._unsafeUnwrap();
    if (outcome.status === "degraded" && outcome.reason === "apply-failed") {
      deps.logger.error(
        {},
        "host rejected child-resolved model; failing closed and never acking bootstrap",
      );
      runtime.dispose();
      return;
    }
    // Both `outcome.model` (a `PiModelResolver` match) and
    // `outcome.currentModel` (`ctx.model`, forwarded through unchanged on a
    // degraded outcome) are raw host objects that may carry fields beyond
    // provider/id/name; project before this ever reaches the ack body's
    // `ModelIdentityBodySchema`-validated field (Pi adapter contract).
    const rawAppliedModel =
      outcome.status === "applied" ? outcome.model : outcome.currentModel;
    appliedModel =
      rawAppliedModel === undefined
        ? undefined
        : toModelIdentityBody(rawAppliedModel);
    if (outcome.status === "applied") {
      await applyChildThinkingLevel(
        pi,
        parsed.thinkingLevel ?? outcome.thinkingLevel,
        deps.logger,
      );
    }
  }

  // Only now - descriptor prompt recorded, Weave tools registered, and the
  // model applied - is bootstrap safe to acknowledge.
  state.agentName = parsed.agentName;
  state.composedPrompt = parsed.composedPrompt;
  state.bootstrapApplied = true;
  state.directStep =
    parsed.mode === "direct-step"
      ? {
          stepName: parsed.stepName,
          recorder: directStepRecorder,
          windowOpen: true,
          lastAttempt: undefined,
        }
      : undefined;
  // `resolvedModel` is genuinely optional in `PiBootstrapAckBody` (Pi adapter contract
  //) - the key must be entirely absent, not present with an
  // `undefined` value, since `undefined` is not a valid `JsonValue` and
  // would make the ack envelope fail canonical (JCS) signing, silently
  // discarded by this `void` call and leaving the parent waiting forever.
  await runtime.reportBootstrapAck(
    appliedModel !== undefined ? { resolvedModel: appliedModel } : {},
  );
}

/**
 * Detects whether this process is a private RPC child (Pi adapter contract)
 * by reading its bootstrap secret from the environment only.
 * A real user-started RPC session never sets this variable, so it never
 * activates any of this child-only behavior. Returns `true` once child
 * mode is fully wired (the caller must not run its own parent-oriented
 * `session_start` logic in that case), `false` for every ordinary session.
 */
async function activateChildModeIfApplicable(
  pi: PiExtensionApi,
  ctx: PiSessionContext,
  deps: PiExtensionDeps,
  state: PiChildModeState,
): Promise<boolean> {
  if (deps.envPort.read(WEAVE_CHILD_SECRET_ENV) === undefined) return false;
  const runtime = new PiChildRuntime({
    envPort: deps.envPort,
    randomPort: deps.randomPort,
    hmacPort: deps.hmacPort,
    outputPort: deps.childOutputPort,
    logger: deps.logger,
  });
  const outcome = await runtime.start();
  state.active = true;
  state.runtime = runtime;
  if (outcome.isErr() || outcome.value.kind !== "activated") {
    deps.logger.error({}, "private child bootstrap handshake failed");
    return true;
  }
  state.childId = outcome.value.childId;
  const promptChunks = new PromptChunkAssembler();
  const reportedPromptTransfers = new Set<string>();
  const reportSettlement = (
    settlement: "completed" | "failed",
    detail: {
      assistantOutput?: string;
      completionCandidate?: string;
      outputTransferId?: string;
      outputByteLength?: number;
      reason?: string;
    },
  ): Promise<void> =>
    reportChildSettlement(runtime, settlement, detail).match(
      () => undefined,
      (error) => {
        deps.logger.error(
          { childId: state.childId, error },
          "child settlement reporting failed after retry",
        );
      },
    );

  pi.registerCommand(PROMPT_CHUNK_COMMAND.slice(1), {
    handler: async (rawArgs: string) => {
      const parsed = parsePromptChunk(rawArgs);
      if (parsed.isErr()) return;
      const { transferId } = parsed.value;
      if (reportedPromptTransfers.has(transferId)) return;

      const task = promptChunks.accept(parsed.value);
      if (task.isErr()) {
        promptChunks.drop(transferId);
        const reported = await runtime.reportTransferResult({
          channel: "prompt",
          transferId,
          status: "nack",
          reason: promptTransferNackReason(task.error),
        });
        if (reported.isOk()) reportedPromptTransfers.add(transferId);
        return;
      }
      if (task.value === undefined) return;

      const reported = await runtime.reportTransferResult({
        channel: "prompt",
        transferId,
        status: "ack",
      });
      if (reported.isErr()) return;
      reportedPromptTransfers.add(transferId);
      await pi.sendUserMessage(task.value);
    },
  });

  pi.registerCommand(HIDDEN_CONTROL_COMMAND_NAME, {
    handler: async (rawArgs: string) => {
      const parsed = parseStrictJson(rawArgs);
      if (parsed.isErr()) return;
      // `admitControlLine` verifies asynchronously (real HMAC signing/
      // verification) and, for `bootstrap`/`cancel`, awaits the
      // caller-supplied handler's own async work too - awaiting it here
      // (rather than firing it and returning) is what lets every caller of
      // this command handler observe bootstrap/cancel side effects as
      // actually applied, never merely dispatched.
      await runtime.admitControlLine(parsed.value, {
        onBootstrap: (body) =>
          applyChildBootstrap(pi, ctx, deps, state, runtime, body),
        onCancel: () =>
          runtime.reportCancelled().match(
            () => undefined,
            () => undefined,
          ),
      });
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!state.bootstrapApplied || state.promptAppended) return undefined;
    state.promptAppended = true;
    const nativePrompt = readSystemPrompt(event);
    const systemPrompt =
      nativePrompt.length > 0
        ? `${nativePrompt}\n\n${state.composedPrompt}`
        : state.composedPrompt;
    return { systemPrompt };
  });

  // A new turn starts a fresh transient output buffer rather than carrying
  // a previous turn's trailing text forward forever (mirrors the parent's
  // own `PiChildRpc` buffer semantics under the Pi adapter contract.
  pi.on("turn_start", () => {
    state.latestAssistantOutput = "";
    state.fullAssistantOutput = "";
  });

  pi.on("message_update", (event) => {
    const record = asJsonRecord(event);
    if (record === undefined) return undefined;
    const preview = extractAssistantTextDeltaPreview(record);
    if (preview !== undefined) {
      state.latestAssistantOutput = truncateLatestOutput(
        state.latestAssistantOutput + preview,
      );
    }
    return undefined;
  });

  // `agent_settled` itself carries no payload at all
  // (`{"type":"agent_settled"}` per the pi-coding-agent RPC docs) - it
  // cannot tell us whether the run that just settled ended in error. The
  // last observed assistant message's `stopReason` (`"error"`/`"aborted"`
  // vs. `"stop"`/`"length"`/`"toolUse"`), delivered on `message_end`, is the
  // one observable signal the RPC protocol exposes for this (Task 9 finding
  // 2). We track it here and consult it below instead of trusting
  // `agent_settled` to carry an outcome it structurally cannot express.
  pi.on("message_end", (event) => {
    const record = asJsonRecord(event);
    if (record === undefined) return undefined;
    const stopReason = extractAssistantStopReason(record);
    if (stopReason !== undefined) state.lastAssistantStopReason = stopReason;
    const completed = extractFullAssistantText(record.message);
    // Only a terminal assistant response is eligible for settlement output.
    // Intermediate tool-use assistant messages and non-terminal canaries never
    // replace the final answer.
    if (
      completed !== undefined &&
      (stopReason === undefined ||
        stopReason === "stop" ||
        stopReason === "length")
    ) {
      state.fullAssistantOutput = completed;
    }
    return undefined;
  });

  pi.on("agent_settled", async () => {
    // A cancellation already in flight (or already reported) owns the
    // terminal outcome - never race a stray `"completed"` report past a
    // `"cancelled"` one that already went out, and never report completed
    // more than once (Task 9).
    if (runtime.isCancelled()) return;
    // Direct-step completion window closes the instant this event fires
    // (Pi adapter contract) - a tool call that races in afterward must observe
    // `windowOpen === false` and be rejected as late, never recorded.
    if (state.directStep !== undefined) state.directStep.windowOpen = false;
    if (
      state.lastAssistantStopReason === "error" ||
      state.lastAssistantStopReason === "aborted"
    ) {
      await reportSettlement("failed", {
        reason: `assistant stop reason: ${state.lastAssistantStopReason}`,
      });
      return;
    }
    if (state.directStep !== undefined) {
      // A direct-step child's settlement is NEVER free-form prose (Pi adapter contract
      //): report the one recorded structured completion candidate as
      // JSON, or a specific typed failure reason - `missing`/`duplicate`/
      // `late`/`malformed:<msg>` - that `direct-dispatch.ts`'s
      // `interpretSettlement` parses on the parent side. Process exit or
      // prose is never success.
      const candidate = state.directStep.recorder.take();
      if (candidate !== undefined) {
        await reportSettlement("completed", {
          completionCandidate: serializeCompletionCandidate(candidate),
        });
        return;
      }
      const attempt = state.directStep.lastAttempt;
      if (attempt === undefined) {
        await reportSettlement("failed", { reason: "missing" });
        return;
      }
      if (attempt.outcome === "malformed") {
        await reportSettlement("failed", {
          reason: `malformed:${attempt.malformedReason ?? "unknown"}`,
        });
        return;
      }
      await reportSettlement("failed", { reason: attempt.outcome });
      return;
    }
    // Only message_end populates fullAssistantOutput. Streamed previews are
    // intermediate state and must never become a parent result.
    const fullOutput = state.fullAssistantOutput;
    if (fullOutput.length === 0) {
      await reportSettlement("completed", {});
      return;
    }
    const projection = truncateLatestOutput(fullOutput);
    const byteLength = new TextEncoder().encode(fullOutput).byteLength;
    if (byteLength > 8 * 1024) {
      const transferred = await runtime.transferOutput(fullOutput);
      if (transferred.isOk()) {
        await reportSettlement("completed", {
          assistantOutput: projection,
          outputTransferId: transferred.value.transferId,
          outputByteLength: transferred.value.byteLength,
        });
        return;
      }
      // Output transfer failure must still settle exactly once. The bounded
      // projection and byte count name the degradation without exposing the
      // private full output to the parent model.
      await reportSettlement("completed", {
        assistantOutput: projection,
        outputByteLength: byteLength,
      });
      return;
    }
    await reportSettlement("completed", {
      assistantOutput: projection,
      outputByteLength: byteLength,
    });
  });

  return true;
}

/** Narrows an event payload to a plain JSON-ish record, or `undefined` if it is not one. Never throws. */
function asJsonRecord(event: unknown): Record<string, JsonValue> | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return undefined;
  }
  return event as Record<string, JsonValue>;
}

/** Extracts only assistant text blocks; thinking, tool calls, and results stay private events. */
function extractFullAssistantText(message: JsonValue): string | undefined {
  const record = asJsonRecord(message);
  if (record === undefined || record.role !== "assistant") return undefined;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";

  let output = "";
  for (const block of record.content) {
    const item = asJsonRecord(block);
    if (
      item !== undefined &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      output += item.text;
    }
  }
  return output;
}

function commandDescription(name: WeaveCommandName): string {
  switch (name) {
    case "weave:start":
      return "Start an explicit Weave plan";
    case "weave:run":
      return "Start a configured Weave workflow";
    case "weave:status":
      return "Show the current Weave adapter and execution status";
    case "weave:abort":
      return "Cancel the active Weave execution and its child tree";
    case "weave:advance":
      return "Apply an explicit user confirmation to the current step";
    case "weave:health":
      return "Show Weave adapter capability and readiness diagnostics";
    case "weave:resume":
      return "Explicitly resume a paused or recoverable execution";
    case "weave:plan":
      return "Show the full read-only plan task tree";
    case "weave:artifact":
      return "Approve or reject a pending artifact revision";
    case "weave:inspect":
      return "Inspect the Weave child hierarchy and history";
    case "weave:clear-children":
      return "Clear terminal Weave child history";
    case "weave:recover-children":
      return "Recover interrupted Weave children";
  }
}

function renderHealthOnlyBlockedMessage(name: WeaveCommandName): string {
  return `Weave is in health-only mode; ${name} is unavailable until required capabilities recover. Run /weave:health for details.`;
}

function effectiveHealthOnly(generation: {
  readonly healthOnlyMode: boolean;
}): boolean {
  return generation.healthOnlyMode;
}

function renderHealthMessage(
  controller: PiExtensionController,
  activeSession: PiActiveSession | undefined,
): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return "Weave has not completed activation yet.";
  }
  const { healthReport } = generation.preflight;
  const lines = healthReport.effectiveCapabilities.map(
    (capability) =>
      `${capability.id}: ${capability.effectiveReadiness} (declared ${capability.declaredReadiness})`,
  );
  const mode = effectiveHealthOnly(generation) ? "health-only" : "ready";
  const result = [`Weave adapter mode: ${mode}`, ...lines];

  if (activeSession?.generationId === generation.id) {
    for (const warning of activeSession.primarySession.getCapabilityWarnings()) {
      result.push(
        `warning [${warning.capability}] ${warning.agentName}: ${warning.detail}`,
      );
    }
    if (activeSession.primaryActivationFailure !== undefined) {
      result.push(
        `primary activation failed: ${activeSession.primaryActivationFailure.type}`,
      );
    }
  }
  return result.join("\n");
}

function renderStatusMessage(
  controller: PiExtensionController,
  _activeSession: PiActiveSession | undefined,
  delegationController?: PiDelegationController,
): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return "Weave has not completed activation yet.";
  }
  const lines = [
    `generation: ${generation.id}`,
    `trust: ${generation.preflight.trust}`,
    `mode: ${generation.preflight.mode}`,
    `health-only: ${effectiveHealthOnly(generation)}`,
  ];
  const tree = delegationController?.snapshotTree() ?? [];
  lines.push(`children: ${tree.length}`);
  if (tree.length > 0 && delegationController !== undefined) {
    lines.push(
      ...renderChildTreeLines(
        tree,
        ROOT_NODE_ID,
        delegationController.snapshotCumulativeUsage(),
      ),
    );
  }
  return lines.join("\n");
}

const WEAVE_AGENT_STATUS_KEY = "weave-agent";
const WEAVE_CHILD_TREE_WIDGET_KEY = "weave-children";
const WEAVE_PLAN_WIDGET_KEY = "weave-plan";

/** Shows one exact normalized descriptor name in Pi's persistent footer. */
function setActiveAgentStatus(
  ctx: PiSessionContext,
  agentName: string | undefined,
): void {
  ctx.ui.setStatus(
    WEAVE_AGENT_STATUS_KEY,
    agentName === undefined
      ? undefined
      : renderActiveAgentBadge(agentName, ctx.ui.theme),
  );
}

/**
 * Renders the bounded compact plan widget (Pi adapter contract) via the real,
 * always-available `ctx.ui.setWidget` surface. Read-only: resolves the
 * active workflow instance's plan name via `inspect()`/`InspectExecutionOutput.slug`
 * (never assumes a name), then reads that plan's snapshot via
 * `readPlanSnapshot()` - a thin passthrough to `PlanStateProvider.readSnapshot`.
 * Hides the widget entirely (`undefined`) whenever there is no controller,
 * no tracked workflow instance, or the lookup fails for any reason (a
 * missing/unreadable plan is never surfaced as an error here - `/weave:plan`
 * is the place for that).
 */
async function refreshPlanWidget(
  ctx: PiSessionContext,
  controller: PiWorkflowController | undefined,
  workflowInstanceId: string | undefined,
): Promise<void> {
  if (controller === undefined || workflowInstanceId === undefined) {
    ctx.ui.setWidget(WEAVE_PLAN_WIDGET_KEY, undefined);
    return;
  }
  const inspected = await controller.inspect(workflowInstanceId);
  if (inspected.isErr()) {
    ctx.ui.setWidget(WEAVE_PLAN_WIDGET_KEY, undefined);
    return;
  }
  const snapshot = await controller.readPlanSnapshot(inspected.value.slug);
  const lines = renderPlanWidgetLines(
    snapshot.isOk() ? snapshot.value : undefined,
  );
  ctx.ui.setWidget(
    WEAVE_PLAN_WIDGET_KEY,
    lines.length === 0 ? undefined : lines,
    { placement: "belowEditor" },
  );
}

/** Renders the bounded child-tree widget (Pi adapter contract) via the real, always-available `ctx.ui.setWidget` surface. Hides the widget entirely (empty array) once there are no children left. */
function renderChildTreeWidget(
  _ctx: PiSessionContext,
  _controller: PiDelegationController | undefined,
  _selectionCell: { selectedId: string },
  _inspectionRegistry?: PiChildInspectionRegistry,
): void {
  // Child topology is now rendered by the compositional inspector editor.
}

class WeaveChildInspectionEditor extends CustomEditor {
  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    private readonly composed: PiChildInspectionEditor,
  ) {
    const [ctorTui, ctorTheme, ctorKeybindings] = [
      tui,
      theme,
      keybindings,
    ] as ConstructorParameters<typeof CustomEditor>;
    super(ctorTui, ctorTheme, ctorKeybindings);
  }

  override handleInput(data: string): void {
    const result = this.composed.handleInput(data);
    if (result.isOk() && result.value.kind !== "host-default") {
      const view = this.composed.currentView();
      if (view !== undefined) this.setText(view.state.draft);
      return;
    }
    super.handleInput(data);
    const view = this.composed.currentView();
    if (view !== undefined && !view.readOnly) {
      this.composed.updateDraft(this.getText());
    }
  }
}

interface WeaveChildTreeEditorDeps {
  getNodesMap(): ReadonlyMap<string, PiChildTreeNode>;
  getSelection(): string;
  setSelection(nodeId: string): void;
  cancelSubtree(nodeId: string): void;
  slots: PiChildSlots;
  openInspector?(): void;
}

/**
 * Compositional custom editor (Pi adapter contract, per `docs/tui.md` "Pattern
 * 7"/`examples/extensions/modal-editor.ts`) production-wiring Alt+1..Alt+9
 * (direct-child selection), Backspace (parent selection), and Esc (cancel
 * selected subtree). Extends the real `CustomEditor` (not a bare shortcut)
 * specifically to inherit Pi's own app keybindings and preserve every host
 * default: any key `classifyChildTreeKey` does not recognize, and any
 * recognized key whose pure `applyTreeControlKey` reducer reports
 * `{ kind: "host-default" }` (Backspace/Esc at the root node) or
 * `{ kind: "no-target" }`, falls straight through to `super.handleInput`.
 */
class WeaveChildTreeEditor extends CustomEditor {
  private readonly weaveDeps: WeaveChildTreeEditorDeps;

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    deps: WeaveChildTreeEditorDeps,
  ) {
    // Adapts the narrow port's deliberately opaque (tui, theme, keybindings)
    // values back to Pi's own real `CustomEditor` constructor parameter
    // types - this is the one adapter-boundary cast, never propagated
    // beyond this constructor call, and never uses `any`.
    const [ctorTui, ctorTheme, ctorKeybindings] = [
      tui,
      theme,
      keybindings,
    ] as ConstructorParameters<typeof CustomEditor>;
    super(ctorTui, ctorTheme, ctorKeybindings);
    this.weaveDeps = deps;
  }

  override handleInput(data: string): void {
    this.weaveDeps.slots.assignTree(
      [...this.weaveDeps.getNodesMap().values()].map((node) => ({
        id: node.id,
        status: node.status,
      })),
    );
    const inspectorKey = classifyChildInspectorKey(data);
    if (inspectorKey?.kind === "open-picker") {
      this.weaveDeps.openInspector?.();
      return;
    }
    // Direct-child selection uses the persistent allocator, not the current
    // tree ordering. This keeps Alt+1..9 stable across insertion/reordering.
    const altSlot =
      inspectorKey?.kind === "select-direct-child"
        ? inspectorKey.index
        : undefined;
    if (altSlot !== undefined) {
      const nodeId = this.weaveDeps.slots.childAt(altSlot);
      if (nodeId !== undefined) this.weaveDeps.setSelection(nodeId);
      return;
    }
    const key = classifyChildTreeKey(data);
    if (key === undefined) {
      super.handleInput(data);
      return;
    }
    const outcome = applyTreeControlKey(
      this.weaveDeps.getNodesMap(),
      this.weaveDeps.getSelection(),
      key,
    );
    if (outcome.kind === "selected") {
      this.weaveDeps.setSelection(outcome.nodeId);
      return;
    }
    if (outcome.kind === "cancel-requested") {
      this.weaveDeps.cancelSubtree(outcome.nodeId);
      return;
    }
    // `host-default` (root-level Backspace/Esc - the Pi adapter contract requires
    // preserving normal host behavior here with no exception, including
    // for a live direct-step child; pausing a running workflow is only
    // ever done through the explicit, confirmed parent-chat interrupt path
    // in the `input` handler below, under the Pi adapter contract) or `no-target`:
    // preserve Pi's own default editor behavior exactly.
    super.handleInput(data);
  }
}

/**
 * The one compiled extension entry (Pi adapter contract). The returned factory is
 * synchronous and, under the Pi adapter contract, only: constructs the controller, registers the
 * inert `/weave:*` command shells and the lifecycle delegates, and
 * returns. It never loads project config, opens the Runtime Store, starts a
 * timer, or launches a child process at factory time.
 */
export function createPiExtension(
  overrides: Partial<PiExtensionDeps> = {},
): (pi: PiExtensionApi) => void {
  const deps: PiExtensionDeps = {
    ...createDefaultPiExtensionDeps(),
    ...overrides,
  };
  // A custom logger denotes an embedding/test-owned sink. Production uses
  // the shared logger and must redirect it before any session log can reach
  // Pi's stdout. Supplying a redirector explicitly opts back into this path.
  const shouldRedirectSharedLogs =
    overrides.logger === undefined || overrides.logRedirector !== undefined;
  // Populated only once `session_start` has activated a real generation and
  // constructed a live delegation controller for it (Pi adapter contract). The
  // registration's static shape/resolver are built here, at preflight time,
  // from the *declared* primary descriptor alone; the lazy accessor lets the
  // coverage proof describe the tool before a controller instance can exist,
  // while `execute()` always runs on a later turn, well after the cell below
  // is populated.
  const delegationControllerCell: {
    controller: PiDelegationController | undefined;
  } = {
    controller: undefined,
  };
  const recoveryCoordinatorCell: {
    coordinator: PiChildRecoveryCoordinator | undefined;
  } = { coordinator: undefined };
  // Bounded, live child-tree selection state (Pi adapter contract) - reset to the
  // root whenever a fresh generation activates.
  const treeSelectionCell: { selectedId: string } = {
    selectedId: ROOT_NODE_ID,
  };
  const childInspectionEditorCell: {
    editor: PiChildInspectionEditor | undefined;
    activate?: (childId: string) => void;
  } = { editor: undefined };
  // One allocator lives for the extension instance, so editor replacement does
  // not renumber live children.
  const childSlots = new PiChildSlots();
  // Per-generation workflow controller (Pi adapter contract) - projects all ten
  // engine lifecycle operations. Constructed only when trusted and not
  // health-only, mirroring `delegationControllerCell`'s gating.
  const directStepChildRegistry = new PiDirectStepChildRegistry();
  const inspectionRegistryCell: {
    registry: PiChildInspectionRegistry | undefined;
  } = {
    registry: undefined,
  };
  const workflowControllerCell: {
    controller: PiWorkflowController | undefined;
  } = {
    controller: undefined,
  };
  const planStateProviderCell: { value: PlanStateProvider | undefined } = {
    value: undefined,
  };
  const readPlanSnapshot = (projectRoot: string, planName: string) =>
    (planStateProviderCell.value ?? createPiPlanStateProvider(projectRoot))
      .readSnapshot(planName)
      .mapErr(mapPlanStateErrorToPiFailure);
  const activeWorkflowInstanceCell: {
    value:
      | {
          workflowInstanceId: string;
          leaseId?: string;
          controllerGeneration?: string;
        }
      | undefined;
  } = { value: undefined };
  // Per-generation telemetry unit (Pi adapter contract) - constructed only once the
  // Runtime Store opens for a trusted, non-health-only generation. Read
  // lazily (never captured by value) by the delegation controller's
  // `telemetry` wrapper below, since children may spawn well after this
  // cell is populated.
  const telemetryCell: { telemetry: PiTelemetry | undefined } = {
    telemetry: undefined,
  };
  let currentWorkflows: Record<
    string,
    import("@weaveio/weave-engine").WorkflowExecutionContext["workflows"][string]
  > = {};
  let activeSession: PiActiveSession | undefined;
  let editorInstallCell:
    | { generationId: string; ctx: PiSessionContext; previousFactory: unknown }
    | undefined;
  const historyStoreCell: { store: PiChildHistoryStore | undefined } = {
    store: undefined,
  };
  // The controller performs read-only preflight, but invalid settings need an
  // explicit user choice. Keep the current UI only for the duration of one
  // activation so a retry cannot prompt twice or use stale session state.
  const childInspectionSettingsUi: {
    ui: PiSessionContext["ui"] | undefined;
  } = { ui: undefined };
  const controllerDeps: PiExtensionControllerDeps = {
    safeInitializer: new PiSafeInitializer({
      hostPackageReader: deps.hostPackageReader,
      capabilityProber: deps.capabilityProber,
      configActivator: deps.configActivator,
      pathContainmentPort: deps.pathContainmentPort,
      chooseInvalidChildInspectionSettings: (issues) => {
        const ui = childInspectionSettingsUi.ui;
        if (ui === undefined) return okAsync("health-only" as const);

        const title = [
          "Invalid Pi child-inspection settings.",
          "No configured value was applied.",
          formatPiChildInspectionSettingsIssues(issues),
          "Choose how to continue.",
        ].join("\n");
        return ResultAsync.fromPromise(
          // Omit dialog options deliberately: this popup has no timeout.
          ui.select(title, ["Use defaults", "Enter health-only mode"]),
          (): "settings-dialog-failed" => "settings-dialog-failed",
        )
          .map(
            (choice): PiChildInspectionSettingsChoice =>
              choice === "Use defaults" ? "defaults" : "health-only",
          )
          .orElse(() => okAsync("health-only" as const));
      },
      buildDelegationToolRegistrations: (primary, activation) => {
        const targetsByName = new Map<string, DelegationTarget>();
        for (const descriptor of listCycleablePrimaryAgents(
          activation.descriptors.byName,
        )) {
          for (const target of descriptor.delegationTargets) {
            targetsByName.set(target.name, target);
          }
        }
        const targets = [...targetsByName.values()];
        if (targets.length === 0) return [];

        return [
          buildDelegationToolRegistration({
            targets,
            getInvocationContext: () => {
              const descriptor =
                activeSession?.primarySession.getCurrent()?.descriptor;
              if (descriptor === undefined) return undefined;
              return {
                parentAgentName: descriptor.name,
                targets: descriptor.delegationTargets,
              };
            },
            getController: () => delegationControllerCell.controller,
            parentId: ROOT_NODE_ID,
            parentDepth: 0,
            parentAgentName: primary.name,
            idGenerator: deps.idGenerator,
            buildBootstrap: (target, _task, childId, ctx, parentAgentName) =>
              buildChildBootstrapBody(
                activation.descriptors.byName,
                target,
                childId,
                {
                  parentAgentName,
                  parentDepth: 0,
                  cwd: ctx.cwd,
                },
                ctx,
              ),
            buildEnv: () => ({}),
          }),
        ];
      },
    }),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    logger: deps.logger,
  };
  const controller = new PiExtensionController(controllerDeps);
  const childModeState = createChildModeState();

  function buildWorkflowTracker(projectRoot: string): PiActiveWorkflowTracker {
    return {
      getActiveInstance: () => activeWorkflowInstanceCell.value,
      setActiveInstance: (instance) => {
        activeWorkflowInstanceCell.value = instance;
      },
      listPlanNames: () => deps.planCatalogPort.listPlanNames(projectRoot),
      listWorkflowNames: () => Object.keys(currentWorkflows),
      buildContext: (workflowName) => {
        const workflow = currentWorkflows[workflowName];
        if (workflow === undefined) return undefined;
        return {
          workflowName,
          goal: workflowName,
          slug: workflowName,
          workflows: currentWorkflows,
        };
      },
      currentAgentName: () =>
        activeSession?.primarySession.getCurrent()?.descriptor.name,
    };
  }

  // Pi adapter contract: `observeSession` must fire for primary/direct-step
  // activation and for termination, not only for run/resume and
  // direct-step settlement - but only "while a lease is active" (i.e. a
  // workflow instance/lease is presently tracked). Best-effort and never a
  // gate on real lifecycle progress, mirroring `PiWorkflowController`'s own
  // internal `observeBestEffort` (this cannot call that private method
  // directly, so it goes through the same public `observe()` projection and
  // applies the identical warn-and-continue degradation on failure).
  async function observeActiveLeaseBestEffort(
    agentName: string,
    sessionStatus: "active" | "terminated",
    stepName?: string,
  ): Promise<void> {
    const instance = activeWorkflowInstanceCell.value;
    const workflowController = workflowControllerCell.controller;
    if (
      instance === undefined ||
      instance.leaseId === undefined ||
      workflowController === undefined
    ) {
      return;
    }
    const result = await workflowController.observe({
      workflowInstanceId: instance.workflowInstanceId,
      leaseId: instance.leaseId,
      harnessName: "pi",
      agentName,
      sessionStatus,
      ...(stepName !== undefined ? { stepName } : {}),
    });
    if (result.isErr()) {
      deps.logger.warn(
        { failure: result.error },
        "observeSession failed; degrading",
      );
    }
  }

  async function openChildInspector(
    ctx: PiSessionContext,
    registry: PiChildInspectionRegistry,
    historyStore: PiChildHistoryStore | undefined,
    coordinator: PiChildRecoveryCoordinator | undefined,
    generationId: string,
    setSelection?: (childId: string) => void,
    sendResume?: () => Promise<void>,
  ): Promise<void> {
    const live = registry.snapshotLiveRegistrations().map(
      ({ registration, snapshot }): PiChildPickerNode => ({
        childId: snapshot.id,
        name: registration.name,
        kind: registration.kind,
        parentId: snapshot.parentId,
        status: snapshot.status,
        preview: sanitizeChildPickerPreview(snapshot.latestOutput),
        live: true,
        currentTool: snapshot.currentTool,
        generationId,
        workflowInstanceId: registration.workflowInstanceId,
        stepName: registration.stepName,
      }),
    );
    const indexResult =
      historyStore === undefined
        ? ok({ records: [] as const })
        : Result.fromThrowable(
            () => historyStore.getIndex(),
            () => "history unavailable",
          )();
    if (indexResult.isErr()) {
      ctx.ui.notify(
        "Child inspection is unavailable in this session.",
        "warning",
      );
      return;
    }
    const records = indexResult.value.records;
    const liveIds = new Set(live.map((node) => node.childId));
    const history = records
      .filter((record) => !liveIds.has(record.childId))
      .map(
        (record): PiChildPickerNode => ({
          childId: record.childId,
          name: record.descriptorName ?? record.childId,
          kind: record.kind,
          ...(record.parentChildId === undefined
            ? {}
            : { parentId: record.parentChildId }),
          status: record.status,
          preview: sanitizeChildPickerPreview(record.finalOutput),
          live: false,
          recoverable:
            record.kind === "ordinary" &&
            record.parentChildId === undefined &&
            record.status === "interrupted" &&
            record.recovery.eligible,
          resumable:
            record.kind === "workflow-step" &&
            record.status === "interrupted" &&
            record.recovery.eligible,
          workflowInstanceId: record.workflow.workflow,
          stepName: record.workflow.step,
        }),
      );
    const entries = buildChildPickerEntries({
      rootLabel: "Weave execution",
      live,
      history,
    });
    if (entries.isErr()) {
      ctx.ui.notify(
        "Child inspection is unavailable in this session.",
        "warning",
      );
      return;
    }
    const selected = await ResultAsync.fromThrowable(
      () =>
        ctx.ui.select(
          "Weave child inspection",
          entries.value.map((entry) => entry.label),
        ),
      () => "inspection unavailable",
    )();
    if (selected.isErr() || selected.value === undefined) {
      if (selected.isErr())
        ctx.ui.notify(
          "Child inspection is unavailable in this session.",
          "warning",
        );
      return;
    }
    const entry = entries.value.find((item) => item.label === selected.value);
    if (entry === undefined || activeSession?.generationId !== generationId)
      return;
    if (entry.action === "clear") {
      const clearNode = entry.node;
      if (
        historyStore === undefined ||
        clearNode === undefined ||
        activeSession?.generationId !== generationId
      )
        return;
      const result = await historyStore.clear(clearNode.childId);
      if (activeSession?.generationId !== generationId) return;
      if (result.isErr())
        ctx.ui.notify("Could not clear terminal child history.", "warning");
      return;
    }
    if (entry.action === "recover") {
      if (coordinator === undefined) return;
      if (activeSession?.generationId !== generationId) return;
      const result = await coordinator.recoverByChildId(
        entry.node?.childId ?? "",
      );
      if (activeSession?.generationId !== generationId) return;
      if (result.isErr())
        ctx.ui.notify(
          "Child recovery is unavailable in this session.",
          "warning",
        );
      return;
    }
    if (entry.action === "resume") {
      if (activeSession?.generationId !== generationId) return;
      const result = await ResultAsync.fromThrowable(
        () => sendResume?.() ?? Promise.resolve(),
        () => "resume unavailable",
      )();
      if (activeSession?.generationId !== generationId) return;
      if (result.isErr())
        ctx.ui.notify(
          "Workflow resume is unavailable in this session.",
          "warning",
        );
      return;
    }
    if (entry.id === "root") {
      setSelection?.(ROOT_NODE_ID);
      return;
    }
    setSelection?.(entry.node?.childId ?? entry.id);
  }

  // Shared dispatch used by both the colon-prefixed direct commands and the
  // bare `/weave` native palette (Pi adapter contract): every action, regardless of
  // how it was invoked, goes through this exact one gate/generation/health
  // check and the exact same handleWeaveXxx() handler - the palette never
  // gets a second, looser code path.
  async function dispatchWeaveCommand(
    pi: PiExtensionApi,
    name: WeaveCommandName,
    _rawArgs: string,
    ctx: PiSessionContext,
  ): Promise<void> {
    // A private delegated child never exposes the parent's public
    // /weave:* commands, even though registerCommand runs once at
    // factory time before child mode can be detected (Pi adapter contract,
    // - public adapter surface stays TUI-only).
    if (childModeState.active) return;
    if (name === "weave:recover-children" && activeSession === undefined) {
      ctx.ui.notify("Child recovery is unavailable in this session.", "info");
      return;
    }
    const gate = controller.evaluateCommandGate(name);
    if (gate.isErr()) {
      ctx.ui.notify(gate.error.safeMessage, "error");
      return;
    }
    if (!gate.value.allowed) {
      if (name === "weave:recover-children") {
        ctx.ui.notify("Child recovery is unavailable in this session.", "info");
      } else {
        ctx.ui.notify(renderHealthOnlyBlockedMessage(name), "warning");
      }
      return;
    }
    if (name === "weave:health") {
      ctx.ui.notify(renderHealthMessage(controller, activeSession), "info");
      return;
    }
    if (name === "weave:status") {
      ctx.ui.notify(
        renderStatusMessage(
          controller,
          activeSession,
          delegationControllerCell.controller,
        ),
        "info",
      );
      const trackedInstance = activeWorkflowInstanceCell.value;
      const statusWorkflowController = workflowControllerCell.controller;
      if (
        trackedInstance !== undefined &&
        statusWorkflowController !== undefined
      ) {
        await handleWeaveStatus(
          ctx.ui,
          statusWorkflowController,
          buildWorkflowTracker(ctx.cwd),
        );
      }
      return;
    }
    if (name === "weave:inspect") {
      const registry = inspectionRegistryCell.registry;
      if (registry === undefined) {
        ctx.ui.notify(
          "Child inspection is unavailable in this session.",
          "info",
        );
        return;
      }
      await openChildInspector(
        ctx,
        registry,
        historyStoreCell.store,
        recoveryCoordinatorCell.coordinator,
        activeSession?.generationId ?? "",
        (childId) => {
          treeSelectionCell.selectedId = childId;
          childInspectionEditorCell.activate?.(childId);
        },
        () => dispatchWeaveCommand(pi, "weave:resume", "", ctx),
      );
      return;
    }
    if (name === "weave:clear-children") {
      const registry = inspectionRegistryCell.registry;
      if (registry === undefined) {
        ctx.ui.notify("Child history is unavailable in this session.", "info");
        return;
      }
      const generationId = activeSession?.generationId;
      const result = await registry.clearTerminal(
        () => activeSession?.generationId === generationId,
      );
      let historyMessage = "Could not clear terminal child history.";
      if (result.isOk() && result.value === 0)
        historyMessage = "No terminal child history to clear.";
      if (result.isOk() && result.value > 0)
        historyMessage = `Cleared ${result.value} terminal child record${result.value === 1 ? "" : "s"}.`;
      ctx.ui.notify(historyMessage, result.isOk() ? "info" : "warning");
      return;
    }
    if (name === "weave:recover-children") {
      const coordinator = recoveryCoordinatorCell.coordinator;
      if (coordinator === undefined) {
        ctx.ui.notify("Child recovery is unavailable in this session.", "info");
        return;
      }
      const result = await coordinator.recoverAll();
      let recoveryMessage = "Child recovery is unavailable in this session.";
      if (result.isOk() && result.value === 0)
        recoveryMessage = "No interrupted children are recoverable.";
      if (result.isOk() && result.value > 0)
        recoveryMessage = `Recovered ${result.value} child${result.value === 1 ? "" : "ren"}.`;
      ctx.ui.notify(recoveryMessage, result.isErr() ? "warning" : "info");
      return;
    }
    const tracker: PiActiveWorkflowTracker = buildWorkflowTracker(ctx.cwd);
    if (name === "weave:start") {
      const operation = controller.beginOperation();
      if (operation.isErr()) {
        ctx.ui.notify(
          "Could not start a plan in this Weave session.",
          "warning",
        );
        return;
      }
      const ready = ensureForegroundStartReady(ctx, operation.value);
      if (ready.isErr()) {
        ctx.ui.notify(ready.error.safeMessage, "warning");
        return;
      }
      await handleWeaveStart(
        _rawArgs,
        ctx.ui,
        {
          start: (planName) =>
            startPlanInForeground(pi, ctx, planName, operation.value),
        },
        tracker,
      );
      return;
    }

    const workflowController = workflowControllerCell.controller;
    if (workflowController === undefined) {
      if (name === "weave:abort") {
        const delegationController = delegationControllerCell.controller;
        if (
          delegationController === undefined ||
          delegationController.snapshotTree().length === 0
        ) {
          ctx.ui.notify("No active Weave execution to abort.", "info");
          return;
        }
        const confirmedFallbackAbort = await ctx.ui.confirm(
          "Abort execution",
          "Cancel the active Weave child tree? This cannot be undone.",
        );
        if (!confirmedFallbackAbort) {
          ctx.ui.notify("Abort cancelled.", "info");
          return;
        }
        const cancelled =
          await delegationController.cancelSubtree(ROOT_NODE_ID);
        ctx.ui.notify(
          cancelled.isOk()
            ? "Cancelled the active Weave child tree."
            : "Cancel requested; some children may still be shutting down.",
          cancelled.isOk() ? "info" : "warning",
        );
        return;
      }
      ctx.ui.notify(renderHealthOnlyBlockedMessage(name), "warning");
      return;
    }
    if (name === "weave:run") {
      await handleWeaveRun(_rawArgs, ctx.ui, workflowController, tracker);
      return;
    }
    if (name === "weave:abort") {
      await handleWeaveAbort(ctx.ui, workflowController, tracker);
      const delegationController = delegationControllerCell.controller;
      if (
        delegationController !== undefined &&
        delegationController.snapshotTree().length > 0
      ) {
        await delegationController.cancelSubtree(ROOT_NODE_ID);
      }
      return;
    }
    if (name === "weave:advance") {
      await handleWeaveAdvance(ctx.ui, workflowController, tracker);
      return;
    }
    if (name === "weave:resume") {
      // Fresh confirm alone is not enough (Pi adapter contract): a stale
      // recovery pointer (wrong controller generation, or a
      // pointer already marked "terminal") must refuse resume
      // before the engine is ever asked, rather than let a paused
      // execution be reacquired against state that no longer
      // matches this session.
      const pointer = await workflowController.readRecoveryPointer();
      if (pointer.isErr()) {
        ctx.ui.notify(
          `Could not resume: ${pointer.error.safeMessage}`,
          "error",
        );
        return;
      }
      if (pointer.value !== undefined) {
        // Issue #21 S019/S020: terminal pointers always fail closed;
        // recoverable pointers are eligible even from a prior generation.
        // The pointer provides correlation only - Runtime Store + lease
        // semantics remain authoritative.
        if (!isPointerEligibleForExplicitResume(pointer.value)) {
          ctx.ui.notify(
            "Resume refused: the last recovery pointer is terminal. Nothing was resumed.",
            "warning",
          );
          return;
        }
        // Issue #21 S020: reload/restart installs a fresh generation
        // whose in-memory tracker starts empty even though the durable
        // pointer survives on disk (by design - reload must never itself
        // auto-resume or spawn a child). Only here, inside the explicit
        // user-invoked `/weave:resume` path, and only when this generation
        // has not already tracked an instance of its own, reconstruct the
        // tracker's correlation from the pointer so `handleWeaveResume`
        // below has something to hand the engine. `handleWeaveResume`
        // still requires a fresh confirm and still round-trips through
        // `controller.inspect()`/`resumeExecution()`, so the Runtime Store
        // and lease semantics remain the sole authority over whether resume
        // actually succeeds - this only supplies correlation.
        if (tracker.getActiveInstance() === undefined) {
          const reconstructed = activeInstanceFromRecoveryPointer(
            pointer.value,
          );
          if (reconstructed !== undefined) {
            tracker.setActiveInstance(reconstructed);
          }
        }
      }
      await handleWeaveResume(ctx.ui, workflowController, tracker);
      return;
    }
    if (name === "weave:plan") {
      await handleWeavePlan(_rawArgs, ctx.ui, workflowController, tracker);
      return;
    }
    if (name === "weave:artifact") {
      await handleWeaveArtifact(_rawArgs, ctx.ui, workflowController, tracker);
      return;
    }
  }

  function switchPrimaryAgent(
    pi: PiExtensionApi,
    ctx: PiSessionContext,
    agentName: string,
    options: {
      readonly activateImmediately?: boolean;
      readonly availableSkills?: readonly PiSkillInfo[];
    } = {},
  ): ResultAsync<void, PiPrimarySwitchFailure> {
    if (childModeState.active) {
      return errAsync({ type: "PrimarySwitchUnavailable" });
    }

    const session = activeSession;
    const generation = controller.getCurrentGeneration();
    if (
      session === undefined ||
      generation === undefined ||
      session.generationId !== generation.id ||
      effectiveHealthOnly(generation)
    ) {
      return errAsync({ type: "PrimarySwitchUnavailable" });
    }
    if (directStepChildRegistry.isActive()) {
      return errAsync({ type: "DirectStepActive" });
    }

    const descriptor = session.descriptors.get(agentName);
    if (descriptor === undefined) {
      return errAsync({ type: "PrimaryDescriptorMissing", agentName });
    }
    if (descriptor.mode === "subagent") {
      return errAsync({ type: "PrimaryDescriptorIneligible", agentName });
    }

    const current = session.primarySession.getCurrent();
    if (current?.descriptor.name === descriptor.name) {
      session.pendingPrimaryName = descriptor.name;
      session.primaryActivationAttempted = true;
      session.primaryActivationFailure = undefined;
      setActiveAgentStatus(ctx, descriptor.name);
      return okAsync(undefined);
    }
    if (current === undefined && options.activateImmediately !== true) {
      session.pendingPrimaryName = descriptor.name;
      session.primaryActivationAttempted = false;
      session.primaryActivationFailure = undefined;
      setActiveAgentStatus(ctx, descriptor.name);
      return okAsync(undefined);
    }
    if (
      options.activateImmediately === true &&
      options.availableSkills === undefined
    ) {
      return errAsync({ type: "PrimarySkillCatalogUnavailable" });
    }
    if (options.availableSkills !== undefined) {
      session.primarySession.refreshSkills(options.availableSkills);
    }

    const operation = controller.beginOperation();
    if (operation.isErr()) {
      return errAsync({ type: "PrimarySwitchGenerationStale" });
    }

    const availableModels = safelyListAvailableModels(ctx.modelRegistry);
    if (availableModels.isErr()) {
      deps.logger.warn(
        { agentName: descriptor.name, reason: availableModels.error },
        "ctx.modelRegistry.getAvailable() threw while switching primary agents; treating as no available models",
      );
    }

    return session.primarySession
      .activate(descriptor, {
        availableModels: availableModels.unwrapOr([]),
        currentModel: ctx.model,
        modelApplier: createPiModelApplyPort(pi),
        thinkingApplier: createPiThinkingApplyPort(pi),
        disabledSkills: session.disabledSkills,
      })
      .mapErr((cause): PiPrimarySwitchFailure => {
        session.primaryActivationFailure = cause;
        return {
          type: "PrimaryActivationFailed",
          agentName: descriptor.name,
          cause,
        };
      })
      .andThen(() =>
        operation.value.assertStillCurrent().mapErr(
          (): PiPrimarySwitchFailure => ({
            type: "PrimarySwitchGenerationStale",
          }),
        ),
      )
      .map(() => {
        session.pendingPrimaryName = descriptor.name;
        session.primaryActivationAttempted = true;
        session.primaryActivationFailure = undefined;
        setActiveAgentStatus(ctx, descriptor.name);
        return undefined;
      });
  }

  function primarySwitchSafeMessage(failure: PiPrimarySwitchFailure): string {
    switch (failure.type) {
      case "PrimarySwitchUnavailable":
        return "Tapestry is unavailable in this session.";
      case "DirectStepActive":
        return "Finish or pause the active workflow switching to Tapestry.";
      case "PrimaryDescriptorMissing":
        return "The Tapestry primary agent is not configured.";
      case "PrimaryDescriptorIneligible":
        return "The configured Tapestry agent cannot run as a primary agent.";
      case "PrimarySkillCatalogUnavailable":
        return "Pi did not provide the skill catalog needed to activate Tapestry.";
      case "PrimarySwitchGenerationStale":
        return "The session changed before Tapestry could activate.";
      case "PrimaryActivationFailed":
        return "Tapestry could not activate in this session.";
    }
  }

  function ensureForegroundStartReady(
    ctx: PiSessionContext,
    generationGuard: PiGenerationGuard,
  ): Result<void, PiForegroundPlanStartFailure> {
    if (generationGuard.assertStillCurrent().isErr()) {
      return err({
        type: "SessionUnavailable",
        safeMessage: "The Pi session changed before the plan could start.",
      });
    }
    const readIdle = Result.fromThrowable(
      () => ctx.isIdle(),
      (): PiForegroundPlanStartFailure => ({
        type: "SessionUnavailable",
        safeMessage: "Pi could not confirm that the session is idle.",
      }),
    );
    const idle = readIdle();
    if (idle.isErr()) return err(idle.error);
    if (!idle.value) {
      return err({
        type: "SessionUnavailable",
        safeMessage:
          "Wait for the current turn to finish before starting a plan.",
      });
    }
    return ok(undefined);
  }

  function readCommandSkills(
    ctx: PiSessionContext,
  ): Result<readonly PiSkillInfo[], PiForegroundPlanStartFailure> {
    const getSystemPromptOptions = ctx.getSystemPromptOptions;
    if (getSystemPromptOptions === undefined) {
      return err({
        type: "SessionUnavailable",
        safeMessage:
          "Pi did not provide command context needed to activate Tapestry.",
      });
    }
    const readOptions = Result.fromThrowable(
      () => getSystemPromptOptions.call(ctx),
      (): PiForegroundPlanStartFailure => ({
        type: "SessionUnavailable",
        safeMessage:
          "Pi could not read the command context needed to activate Tapestry.",
      }),
    );
    return readOptions().map((options) => options.skills ?? []);
  }

  function startPlanInForeground(
    pi: PiExtensionApi,
    ctx: PiSessionContext,
    planName: string,
    generationGuard: PiGenerationGuard,
  ): ResultAsync<void, PiForegroundPlanStartFailure> {
    const ready = ensureForegroundStartReady(ctx, generationGuard);
    if (ready.isErr()) return errAsync(ready.error);

    const skills = readCommandSkills(ctx);
    if (skills.isErr()) return errAsync(skills.error);

    return switchPrimaryAgent(pi, ctx, TAPESTRY_PRIMARY_AGENT_NAME, {
      activateImmediately: true,
      availableSkills: skills.value,
    })
      .mapErr(
        (failure): PiForegroundPlanStartFailure => ({
          type: "PrimarySwitchFailed",
          safeMessage: primarySwitchSafeMessage(failure),
        }),
      )
      .andThen(() => ensureForegroundStartReady(ctx, generationGuard))
      .andThen(() => {
        const sendStartPrompt = Result.fromThrowable(
          () => pi.sendUserMessage(renderPlanStartPrompt(planName)),
          (): PiForegroundPlanStartFailure => ({
            type: "MessageDispatchFailed",
            safeMessage:
              "Pi could not submit the Tapestry start prompt to this session.",
          }),
        );
        return sendStartPrompt();
      });
  }

  async function cyclePrimaryAgent(
    pi: PiExtensionApi,
    ctx: PiSessionContext,
  ): Promise<void> {
    if (childModeState.active) return;

    const session = activeSession;
    const generation = controller.getCurrentGeneration();
    if (
      session === undefined ||
      generation === undefined ||
      session.generationId !== generation.id ||
      effectiveHealthOnly(generation)
    ) {
      ctx.ui.notify(
        "Weave primary-agent cycling is unavailable in this session.",
        "warning",
      );
      return;
    }
    if (directStepChildRegistry.isActive()) {
      ctx.ui.notify(
        "Finish or pause the active workflow step before switching primary agents.",
        "warning",
      );
      return;
    }

    const current = session.primarySession.getCurrent();
    const next = nextCycleablePrimaryAgent(
      session.descriptors,
      current?.descriptor.name ?? session.pendingPrimaryName,
    );
    if (next === undefined) {
      ctx.ui.notify("No other Weave primary agent is available.", "info");
      return;
    }

    const switched = await switchPrimaryAgent(pi, ctx, next.name);
    if (
      switched.isErr() &&
      switched.error.type === "PrimarySwitchGenerationStale"
    ) {
      return;
    }
    if (switched.isErr()) {
      ctx.ui.notify(
        `Could not switch Weave primary agent to ${next.name}.`,
        "error",
      );
      return;
    }

    ctx.ui.notify(`Switched Weave primary agent to ${next.name}.`, "info");
    await observeActiveLeaseBestEffort(next.name, "active");
  }

  return function piAdapterExtension(pi: PiExtensionApi): void {
    pi.registerShortcut?.(PI_PRIMARY_AGENT_CYCLE_SHORTCUT, {
      description: "Cycle Weave primary agent",
      handler: async (ctx: PiSessionContext) => {
        await cyclePrimaryAgent(pi, ctx);
      },
    });

    for (const name of WEAVE_COMMAND_NAMES) {
      pi.registerCommand(name, {
        description: commandDescription(name),
        handler: async (_rawArgs: string, ctx: PiSessionContext) => {
          await dispatchWeaveCommand(pi, name, _rawArgs, ctx);
        },
      });
    }

    // Native `/weave` palette (Pi adapter contract) derives actions from current
    // state and routes them through the same dispatch gate.
    pi.registerCommand("weave", {
      description: "Weave: choose an action from the current state",
      handler: async (_rawArgs: string, ctx: PiSessionContext) => {
        if (childModeState.active) return;
        const generation = controller.getCurrentGeneration();
        const healthOnly =
          generation === undefined ? true : effectiveHealthOnly(generation);
        const tracker = buildWorkflowTracker(ctx.cwd);
        const active = tracker.getActiveInstance();
        const workflowController = workflowControllerCell.controller;
        const inspected =
          workflowController !== undefined && active !== undefined
            ? await workflowController.inspect(active.workflowInstanceId)
            : undefined;
        const hasPendingArtifact =
          inspected?.isOk() === true &&
          inspected.value.artifacts.some(
            (artifact) => artifact.approvalState === "pending",
          );
        const actions = buildPaletteActions({
          healthOnly,
          hasActiveInstance: active !== undefined,
          hasPendingArtifact,
        });
        const visible = actions.filter((action) => action.visible);
        if (visible.length === 0) {
          ctx.ui.notify("No Weave actions are available right now.", "info");
          return;
        }
        const labelFor = (action: PiPaletteAction): string =>
          action.disabledReason !== undefined
            ? `${action.label} (${action.disabledReason})`
            : action.label;
        const chosen = await ctx.ui.select("Weave", visible.map(labelFor));
        if (chosen === undefined) return;
        const match = visible.find((action) => labelFor(action) === chosen);
        if (match === undefined) return;
        if (match.disabledReason !== undefined) {
          ctx.ui.notify(match.disabledReason, "warning");
          return;
        }
        const commandName = match.id.replace(
          "weave.",
          "weave:",
        ) as WeaveCommandName;
        await dispatchWeaveCommand(pi, commandName, "", ctx);
      },
    });

    // Parent-chat/workflow concurrency (Pi adapter contract): an ordinary prompt
    // arriving while a direct-step child is active must never be silently
    // interleaved with the workflow's own mutation. Ask first; only a
    // confirmed pause cancels the direct-step subtree and lets the prompt
    // continue to Loom - a reject leaves the workflow running untouched and
    // never submits the prompt.
    pi.on("input", async (_event, ctx: PiSessionContext) => {
      if (childModeState.active) return { action: "continue" };
      if (!directStepChildRegistry.isActive()) return { action: "continue" };
      const confirmed = await ctx.ui.confirm(
        "Weave workflow active",
        "A workflow step is currently running. Pause it and interrupt with this message?",
      );
      if (!confirmed) return { action: "handled" };
      const active = activeWorkflowInstanceCell.value;
      const workflowController = workflowControllerCell.controller;
      // No fabricated empty-string lease id: a direct-step child reported
      // active but no lease is tracked is an invariant we cannot safely
      // pause against, so this fails open (lets the prompt through) rather
      // than send an interrupt scoped to a lease that was never granted.
      if (active?.leaseId === undefined || workflowController === undefined) {
        deps.logger.warn(
          {
            hasActiveInstance: active !== undefined,
            hasLeaseId: active?.leaseId !== undefined,
          },
          "cannot pause the active direct-step child: no tracked lease id; letting the prompt through unpaused",
        );
        return { action: "continue" };
      }
      const interrupted = await workflowController.handleUserInterrupt({
        workflowInstanceId: active.workflowInstanceId,
        leaseId: active.leaseId,
        signal: "pause",
      });
      if (interrupted.isErr()) {
        deps.logger.warn(
          { failure: interrupted.error },
          "pause-before-prompt handleUserInterrupt failed",
        );
        ctx.ui.notify(
          "Could not pause the workflow; it may still be running.",
          "warning",
        );
      }
      return { action: "continue" };
    });

    pi.on("session_start", async (_event, ctx: PiSessionContext) => {
      if (ctx.mode === "tui" && shouldRedirectSharedLogs) {
        const redirected = await deps.logRedirector.redirect(
          join(ctx.cwd, PI_SHARED_LOG_PATH),
        );
        if (redirected.isErr()) {
          ctx.ui.notify(redirected.error.safeMessage, "error");
          return;
        }
      }
      const isChild = await activateChildModeIfApplicable(
        pi,
        ctx,
        deps,
        childModeState,
      );
      if (isChild) return;
      const commands = readValidatedCommands(pi);
      if (commands.isErr()) {
        ctx.ui.notify(commands.error.safeMessage, "error");
        return;
      }
      childInspectionSettingsUi.ui = ctx.hasUI ? ctx.ui : undefined;
      const hostSurfaceInput = {
        api: pi,
        ui: ctx.ui,
        rootExports: PiPublicExports as unknown as Readonly<
          Record<string, unknown>
        >,
      };
      const hostSurface = (
        await safeReadHostSurfaceReport(
          deps.hostSurfaceReader ?? new DefaultPiHostSurfaceReader(),
          hostSurfaceInput,
        )
      ).match(
        (report) => report,
        () => emptyHostSurfaceReport(),
      );
      const activation = await controller.activate(
        ctx,
        commands.value,
        hostSurface,
      );
      childInspectionSettingsUi.ui = undefined;
      if (activation.isErr()) {
        ctx.ui.notify(activation.error.safeMessage, "error");
        return;
      }
      const generation = activation.value;
      ctx.ui.setStatus(
        "weave",
        generation.healthOnlyMode
          ? "health-only - run /weave:health for details"
          : "ready",
      );

      // Pi adapter contract: wrong mode/host/version blocks config activation
      // entirely - `PiSafeInitializer.preflight` never calls
      // `PiConfigActivator` in that state, so `configActivation` below is
      // always `undefined` here. This check makes that guarantee explicit
      // at the call site too.
      if (
        !generation.preflight.modeSupported ||
        !generation.preflight.hostSupported
      ) {
        return;
      }

      if (generation.preflight.configActivationFailure !== undefined) {
        const failure = generation.preflight.configActivationFailure;
        deps.logger.warn(
          { code: failure.code, safeMessage: failure.safeMessage },
          "config activation failed",
        );
        return;
      }

      const configActivation = generation.preflight.configActivation;
      if (configActivation === undefined) return;

      logMaterializationErrors(
        configActivation.descriptors.errors,
        deps.logger,
      );

      // Open the trusted project's Runtime Store once and share it between
      // telemetry and workflow lifecycle.
      let runtimeStore: RuntimeStore | undefined;
      if (
        !generation.healthOnlyMode &&
        generation.preflight.trust === "trusted"
      ) {
        const opened = await deps.runtimeStoreFactory.open(ctx.cwd);
        if (opened.isErr()) {
          deps.logger.warn(
            { failure: opened.error },
            "Runtime Store open/migration failed; workflow lifecycle commands unavailable this generation",
          );
        } else {
          runtimeStore = opened.value;
        }
      }

      if (
        !generation.healthOnlyMode &&
        generation.preflight.trust === "trusted"
      ) {
        const registerTools = Result.fromThrowable(
          () => {
            for (const registration of generation.preflight.toolRegistrations) {
              pi.registerTool(registration);
            }
          },
          (error) =>
            error instanceof Error ? error : new Error(String(error)),
        );
        if (registerTools().isErr()) {
          ctx.ui.setStatus(
            "weave",
            "health-only - run /weave:health for details",
          );
          ctx.ui.notify("Weave tool registration failed.", "error");
          return;
        }
      }

      currentWorkflows = configActivation.config.workflows ?? {};
      planStateProviderCell.value =
        deps.planStateProviderFactory?.(ctx.cwd) ??
        createPiPlanStateProvider(ctx.cwd);
      activeSession = {
        generationId: generation.id,
        childInspectionSettings: generation.preflight.childInspection,
        primarySession: new PiPrimarySession({
          skillCatalog: new PiSkillCatalog([]),
          logger: deps.logger,
        }),
        descriptors: configActivation.descriptors.byName,
        disabledSkills: configActivation.config.disabled?.skills ?? [],
        pendingPrimaryName: DEFAULT_PRIMARY_AGENT_NAME,
        primaryActivationAttempted: false,
        userSelectedModelBeforeActivation: false,
        primaryActivationFailure: undefined,
      };

      const sessionHealthOnly = effectiveHealthOnly(generation);
      const parentSessionId =
        deps.parentSessionId?.(ctx) ??
        (ctx as PiSessionContext & { readonly sessionId?: string }).sessionId;
      const historyStore =
        deps.childHistoryStoreFactory === undefined ||
        parentSessionId === undefined
          ? undefined
          : await deps.childHistoryStoreFactory(
              parentSessionId,
              generation.preflight.childInspection,
            );
      if (historyStore?.isErr()) {
        deps.logger.warn(
          { failure: historyStore.error },
          "child history store open failed; inspection remains memory-only",
        );
      }
      historyStoreCell.store = historyStore?.isOk()
        ? historyStore.value
        : undefined;
      const inspectionRegistry = new PiChildInspectionRegistry(
        historyStore?.isOk()
          ? createPiChildHistoryPort(historyStore.value)
          : undefined,
      );
      inspectionRegistryCell.registry = inspectionRegistry;
      ctx.ui.setStatus(
        "weave",
        sessionHealthOnly
          ? "health-only - run /weave:health for details"
          : "ready",
      );
      setActiveAgentStatus(
        ctx,
        sessionHealthOnly ? undefined : activeSession.pendingPrimaryName,
      );

      // The delegation transport is only ever constructed for a fully
      // activated generation, never at factory time (Pi adapter contract) and
      // never for a health-only/trust-withheld generation - delegation is a
      // registered capability tool and durable operation exactly like the
      // ones Pi adapter contract already disable in those states.
      if (
        !effectiveHealthOnly(generation) &&
        generation.preflight.trust !== "withheld"
      ) {
        delegationControllerCell.controller = new PiDelegationController({
          config: configActivation.config,
          generationId: generation.id,
          idGenerator: deps.idGenerator,
          logger: deps.logger,
          processPort: deps.processPort,
          randomPort: deps.randomPort,
          hmacPort: deps.hmacPort,
          // The exact executable that launched this host, never a bare
          // "pi" a spawner would have to re-resolve via `PATH` (Pi adapter contract
          //).
          command: deps.childCommand,
          // Preserves ordinary runtime necessities (PATH/HOME/etc.) for the
          // spawned `pi` process, while never forwarding secrets/credentials
          // or this adapter's own private child-bootstrap variables.
          baseEnv: buildPiChildBaseEnv(),
          pathContainment: deps.pathContainmentPort,
          historyRoot: () =>
            historyStore?.isOk() ? historyStore.value.getRootPath() : "",
          currentCwd: () => ctx.cwd,
          currentEnv: () => buildPiChildBaseEnv(),
          resolveRootDelegationTarget: (name) =>
            configActivation.descriptors.byName
              .get(DEFAULT_PRIMARY_AGENT_NAME)
              ?.delegationTargets.find((target) => target.name === name),
          rootAgentName: () =>
            activeSession?.primarySession.getCurrent()?.descriptor.name ??
            DEFAULT_PRIMARY_AGENT_NAME,
          // Nested/descendant delegation (Pi adapter contract): a requesting
          // child is only ever resolved against ITS OWN declared
          // `delegationTargets`, never the full descriptor set - exactly
          // the same restriction the root's own tool already applies.
          resolveDelegationTarget: (requestingAgentName, targetAgentName) =>
            configActivation.descriptors.byName
              .get(requestingAgentName)
              ?.delegationTargets.find(
                (target) => target.name === targetAgentName,
              ),
          buildBootstrap: (target, childId, context) =>
            buildChildBootstrapBody(
              configActivation.descriptors.byName,
              target,
              childId,
              context,
              ctx,
            ),
          onTreeChanged: () => {
            renderChildTreeWidget(
              ctx,
              delegationControllerCell.controller,
              treeSelectionCell,
              inspectionRegistry,
            );
          },
          onPrivateOutput: deps.onChildPrivateOutput,
          inspectionRegistry,
          // Lazy wrapper (Pi adapter contract): `telemetryCell.telemetry` is only
          // populated once the Runtime Store opens successfully, below -
          // reading it here would always see `undefined`. A settled child
          // assistant message always arrives well after that point, so the
          // lazy read is safe; absent telemetry degrades to a silent no-op
          // rather than blocking child settlement.
          telemetry: {
            recordAssistantUsage: (input) => {
              const telemetry = telemetryCell.telemetry;
              if (telemetry === undefined) return okAsync("noop" as const);
              return telemetry.recordAssistantUsage(input).mapErr((failure) => {
                telemetry.recordDegradation(failure);
                return failure;
              });
            },
          },
        });

        // Child recovery is generation-scoped. Construct it only after history
        // is open, then prompt exactly once for this stable parent session.
        if (historyStore?.isOk()) {
          const history = historyStore.value;
          const historyPort = {
            list: () => okAsync(history.getIndex().records),
            updateRecord: (
              childId: string,
              patch: Partial<PiChildHistoryRecord>,
            ) => history.updateRecord(childId, patch),
          };
          const recovery = new PiChildRecoveryCoordinator({
            history: historyPort,
            generationId: generation.id,
            isGenerationCurrent: (id) => activeSession?.generationId === id,
            trustedProject: generation.preflight.trust === "trusted",
            recoveryEnabled:
              generation.preflight.childInspection.settings.recovery_enabled,
            countdownSeconds:
              generation.preflight.childInspection.settings
                .recovery_countdown_seconds,
            resolveDescriptor: (name) =>
              configActivation.descriptors.byName.get(name),
            currentModel: ctx.model?.id,
            currentPolicy: configActivation.config.settings,
            currentLimits: generation.preflight.childInspection.settings,
            ui: {
              select: (title, options, optionsConfig) =>
                ctx.ui.select(title, options, optionsConfig),
              notify: (message, level) => ctx.ui.notify(message, level),
              inspect: (record) =>
                ctx.ui.notify(
                  `Interrupted child ${record.childId} is available for inspection.`,
                  "info",
                ),
            },
            // The authenticated restore seam is intentionally owned by the
            // controller. Until a controller is active, fail closed.
            spawn: (input) =>
              deps.restoreOrdinaryChild !== undefined
                ? deps.restoreOrdinaryChild(input)
                : (delegationControllerCell.controller?.restoreOrdinaryChild(
                    input,
                  ) ?? errAsync({ type: "unavailable" })),
            injectParentContext: (content, _options) => {
              const sendMessage = pi.sendMessage;
              if (
                activeSession?.generationId !== generation.id ||
                sendMessage === undefined
              )
                return errAsync<void, unknown>({ type: "stale" });
              return ResultAsync.fromPromise(
                Promise.resolve().then(() => {
                  sendMessage(
                    {
                      customType: "weave-child-recovery",
                      content,
                      display: true,
                    },
                    { triggerTurn: false },
                  );
                }),
                (error) => ({ type: "send-message-failed" as const, error }),
              );
            },
          });
          recoveryCoordinatorCell.coordinator = recovery;
          void recovery.startup().match(
            () => undefined,
            () =>
              ctx.ui.notify(
                "Child recovery is unavailable in this session.",
                "info",
              ),
          );
        }
        // Workflow lifecycle projection reuses the trusted Runtime Store.
        if (runtimeStore !== undefined) {
          // Adapter telemetry (Pi adapter contract): activated only now that the
          // Runtime Store is open for a trusted, non-health-only
          // generation. Never blocks activation - a rotating-log-sink or
          // retention failure degrades visibly instead.
          const telemetryResult = await createPiTelemetry({
            store: runtimeStore,
            settings:
              configActivation.config.settings?.runtime ??
              DEFAULT_RUNTIME_SETTINGS,
            projectRoot: ctx.cwd,
            clock: deps.clock,
            fallbackLogger: deps.logger,
            logFileSystem: deps.telemetryLogFileSystem,
            journal: deps.telemetryJournal,
            usage: deps.telemetryUsage,
            retention: deps.telemetryRetention,
          });
          // `createPiTelemetry`'s error type is `never` - it always
          // degrades internally rather than failing. `.isErr()` is checked
          // only to satisfy Result narrowing, never expected to be true.
          if (!telemetryResult.isErr()) {
            const { telemetry, logDegradation } = telemetryResult.value;
            telemetryCell.telemetry = telemetry;
            const ui: PiTelemetryUiPort = {
              notify: (message, level) => ctx.ui.notify(message, level),
            };
            if (logDegradation !== undefined) {
              telemetry.recordDegradation(logDegradation);
              telemetry.notifyFailureOnce(ui, logDegradation);
            }
            const retentionActivation = await telemetry.activate();
            if (retentionActivation.isErr()) {
              telemetry.recordDegradation(retentionActivation.error);
              telemetry.notifyFailureOnce(ui, retentionActivation.error);
            }
            await telemetry
              .recordJournalEvent({
                family: "generation",
                event: "activated",
                severity: "info",
                data: {
                  generationId: generation.id,
                  healthOnly: generation.healthOnlyMode,
                  trust: generation.preflight.trust,
                },
              })
              .orElse(() => okAsync(undefined));
          }
          const directStepDelegationController =
            delegationControllerCell.controller;
          workflowControllerCell.controller = new PiWorkflowController({
            store: runtimeStore,
            planStateProvider:
              planStateProviderCell.value ?? createPiPlanStateProvider(ctx.cwd),
            artifactProvider: new BunPiArtifactProvider(),
            directDispatch: new TransportDirectDispatchPort(
              createDirectDispatchTransport(
                {
                  processPort: deps.processPort,
                  randomPort: deps.randomPort,
                  hmacPort: deps.hmacPort,
                  logger: deps.logger,
                  idGenerator: deps.idGenerator,
                  // The exact executable that launched this host, never a
                  // bare "pi" a spawner would have to re-resolve via `PATH`
                  // (Pi adapter contract).
                  command: deps.childCommand,
                  baseEnv: buildPiChildBaseEnv(),
                  registry: directStepChildRegistry,
                  inspectionRegistry,
                  availableModels: safelyListAvailableModels(
                    ctx.modelRegistry,
                  ).unwrapOr([]),
                  relayDelegation:
                    directStepDelegationController === undefined
                      ? undefined
                      : (request) =>
                          directStepDelegationController.delegateFromAuthenticatedParent(
                            request,
                          ),
                },
                generation.id,
              ),
            ),
            // Resolves a direct-step agent's own real descriptor (composed
            // prompt, models, delegation targets) from this
            // generation's own activated catalog by name (Pi adapter contract,
            //) - never the engine effect's own always-empty
            // `agentDescriptor` fields.
            resolveAgentDescriptor: (agentName) =>
              configActivation.descriptors.byName.get(agentName),
            onDirectStepActiveChange: (active, agentName) => {
              if (active) {
                setActiveAgentStatus(ctx, agentName);
                return;
              }
              const currentPrimaryName =
                activeSession?.primarySession.getCurrent()?.descriptor.name ??
                activeSession?.pendingPrimaryName;
              setActiveAgentStatus(ctx, currentPrimaryName);
            },
            recoveryPointerStore: new BunJsonlRecoveryPointerStore(
              join(ctx.cwd, ".weave", "runtime", "pi-recovery-pointer.ndjson"),
            ),
            clock: deps.clock,
            idGenerator: deps.idGenerator,
            logger: deps.logger,
            controllerGenerationId: generation.id,
            assertGenerationCurrent: () =>
              controller.beginOperation().map(() => undefined),
            ownerId: generation.id,
            projectRoot: ctx.cwd,
            cancelActiveDirectStepChild: () => {
              const directChildId = directStepChildRegistry.getActiveChildId();
              const cancelDirectChild =
                directStepChildRegistry.cancel() ?? okAsync(undefined);
              if (
                directChildId === undefined ||
                directStepDelegationController === undefined
              ) {
                return cancelDirectChild;
              }
              return cancelDirectChild.andThen(() =>
                directStepDelegationController
                  .cancelSubtree(directChildId)
                  .mapErr(
                    (failures) =>
                      failures[0] ??
                      makeChildAbortFailedFailure(
                        directChildId,
                        "descendant cancellation failed",
                      ),
                  ),
              );
            },
            // Pi adapter contract: refreshes the bounded compact plan widget after
            // every dispatch/completion/resume/interrupt/reconcile outcome.
            // Best-effort and fire-and-forget - this class never reads plan
            // state itself, and a rendering failure must never affect the
            // lifecycle result it is reacting to.
            onPlanSnapshotChanged: (workflowInstanceId) => {
              void refreshPlanWidget(
                ctx,
                workflowControllerCell.controller,
                workflowInstanceId,
              );
            },
          });
          // Recovery banner (Pi adapter contract): read-only on every session start.
          // Never resumes anything itself - only `/weave:resume` (with its
          // own fresh confirm and generation/lease recheck, above) may ever
          // reacquire a paused execution.
          const recoveryPointer =
            await workflowControllerCell.controller.readRecoveryPointer();
          if (recoveryPointer.isOk() && recoveryPointer.value !== undefined) {
            const pointer = recoveryPointer.value;
            ctx.ui.notify(
              `Weave recovery: workflow ${pointer.workflowId ?? "(unknown)"} is ${pointer.status}${
                pointer.planName !== undefined
                  ? ` (plan ${pointer.planName} rev ${pointer.planRevision})`
                  : ""
              } as of ${pointer.observedAt}. Use /weave:resume to continue it.`,
              "info",
            );
          }
          // Pi adapter contract: initial compact plan widget render at session
          // start/recovery - shows the recovered pending workflow's plan
          // immediately, or hides the widget when nothing is recoverable.
          // Never auto-resumes anything itself.
          await refreshPlanWidget(
            ctx,
            workflowControllerCell.controller,
            recoveryPointer.isOk()
              ? recoveryPointer.value?.workflowId
              : undefined,
          );
        }
        treeSelectionCell.selectedId = ROOT_NODE_ID;
        let customInspectionComponent:
          | ReturnType<typeof createChildInspectionCustomComponent>
          | undefined;
        let customInspectionTui: { requestRender(): void } | undefined;
        childInspectionEditorCell.editor = createChildInspectionEditor(
          new PiChildInspector(ROOT_NODE_ID, {
            steer: () => errAsync("child steering unavailable"),
            followUp: () => errAsync("child follow-up unavailable"),
            cancel: (childId, generationId) =>
              generationId === generation.id
                ? (delegationControllerCell.controller?.cancelSubtree(
                    childId,
                  ) ?? okAsync(undefined))
                : errAsync("stale child view"),
          }),
          {
            openPicker: () => {
              childSlots.assignTree(inspectionRegistry.snapshotLive());
              void openChildInspector(
                ctx,
                inspectionRegistry,
                historyStoreCell.store,
                recoveryCoordinatorCell.coordinator,
                generation.id,
                (childId) => activateChild(childId),
                () => dispatchWeaveCommand(pi, "weave:resume", "", ctx),
              );
            },
            onViewChange: () => {
              customInspectionComponent?.invalidate();
              customInspectionTui?.requestRender();
            },
            defaultInput: (data) => undefined,
          },
        );
        const inspectionEditor = childInspectionEditorCell.editor;
        const editorFactory = (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
        ) =>
          new WeaveChildInspectionEditor(
            tui,
            theme,
            keybindings,
            inspectionEditor,
          );
        let customInspectionOpen = false;
        const activateChild = (childId: string): void => {
          if (inspectionEditor === undefined) return;
          const node = inspectionRegistry
            .snapshotLive()
            .find((item) => item.id === childId);
          const child: PiInspectorChild =
            node === undefined
              ? {
                  childId,
                  name: childId,
                  kind: "ordinary",
                  live: false,
                  status: "interrupted",
                }
              : {
                  childId: node.id,
                  name: node.name,
                  kind: "ordinary",
                  live: true,
                  status: node.status as PiInspectorChild["status"],
                  parentId: node.parentId,
                  generationId: generation.id,
                };
          const known = [
            child,
            ...inspectionRegistry.snapshotLive().map((item) => ({
              childId: item.id,
              name: item.name,
              kind: "ordinary" as PiInspectorChild["kind"],
              live: true,
              status: item.status as PiInspectorChild["status"],
              parentId: item.parentId,
              generationId: generation.id,
            })),
          ];
          inspectionEditor.open(child, known);
          treeSelectionCell.selectedId = childId;
          ctx.ui.setEditorComponent?.(editorFactory);
          openCustomInspection();
        };
        const openCustomInspection = (): void => {
          if (ctx.mode !== "tui" || ctx.ui.custom === undefined) {
            ctx.ui.notify("Child inspection requires Pi TUI mode.", "warning");
            return;
          }
          if (customInspectionOpen) {
            customInspectionComponent?.invalidate();
            customInspectionTui?.requestRender();
            return;
          }
          customInspectionOpen = true;
          let finished = false;
          const finish = (): void => {
            if (finished) return;
            finished = true;
            customInspectionOpen = false;
          };
          void ctx.ui
            .custom<void>((tui, theme, keybindings, done) => {
              customInspectionTui = tui as { requestRender(): void };
              customInspectionComponent = createChildInspectionCustomComponent(
                customInspectionTui as never,
                theme as never,
                keybindings as never,
                inspectionEditor,
                () => {
                  const view = inspectionEditor.currentView();
                  const node = inspectionRegistry
                    .snapshotLive()
                    .find((item) => item.id === view?.childId);
                  const transcriptState =
                    node === undefined
                      ? inspectionRegistry.getTranscriptState(
                          view?.childId ?? "",
                        )
                      : inspectionRegistry.getTranscriptState(node.id);
                  return {
                    topologyPath: [{ name: view?.childId ?? "child" }],
                    childName: node?.name ?? view?.childId ?? "child",
                    status: (node?.status ??
                      "running") as PiChildInspectionRenderInput["status"],
                    currentTool: node?.currentTool,
                    interventionCount: 0,
                    summary: {
                      queueSize: 0,
                      turnCount: node?.currentTurn ?? 0,
                      usage: node?.usage,
                    },
                    generationId: view?.generationId ?? generation.id,
                    trimmed: false,
                    recoveryContinuation: false,
                    recoverableInterruption: false,
                    interruptedHistory: false,
                    readOnlyCompletion: view?.readOnly ?? false,
                    transcriptState,
                  };
                },
                () => inspectionEditor.currentView()?.state.draft ?? "",
                (draft) => inspectionEditor.updateDraft(draft),
                () => {
                  if (finished) return;
                  finish();
                  ctx.ui.setEditorComponent?.(
                    editorInstallCell?.previousFactory,
                  );
                  done(undefined);
                },
              );
              return customInspectionComponent;
            })
            .finally(() => {
              customInspectionComponent = undefined;
              customInspectionTui = undefined;
              finish();
            });
        };
        childInspectionEditorCell.activate = activateChild;
        const rootChild: PiInspectorChild = {
          childId: ROOT_NODE_ID,
          name: "Weave execution",
          kind: "ordinary",
          live: true,
          status: "running",
        };
        inspectionEditor.open(rootChild, [rootChild]);
        renderChildTreeWidget(
          ctx,
          delegationControllerCell.controller,
          treeSelectionCell,
          inspectionRegistry,
        );
        // Compositional custom editor (Pi adapter contract): production-wires
        // Alt+1..Alt+9/Backspace/Esc against the live child tree while
        // preserving every Pi host default (see `WeaveChildTreeEditor`).
        if (editorInstallCell !== undefined) {
          editorInstallCell.ctx.ui.setEditorComponent?.(
            editorInstallCell.previousFactory,
          );
          editorInstallCell = undefined;
        }
        const previousFactory = ctx.ui.getEditorComponent?.();
        editorInstallCell = {
          generationId: generation.id,
          ctx,
          previousFactory,
        };
        ctx.ui.setEditorComponent?.(editorFactory);
      }
    });

    pi.on("model_select", (event) => {
      if (childModeState.active || activeSession === undefined) return;
      if (
        activeSession.primaryActivationAttempted ||
        activeSession.primarySession.getCurrent() !== undefined
      ) {
        return;
      }
      if (typeof event !== "object" || event === null) return;
      const source = (event as { source?: unknown }).source;
      if (source === "set" || source === "cycle") {
        activeSession.userSelectedModelBeforeActivation = true;
      }
    });

    pi.on("before_agent_start", async (event, ctx: PiSessionContext) => {
      if (childModeState.active) return undefined;
      if (activeSession === undefined) return undefined;
      if (
        activeSession.generationId !== controller.getCurrentGeneration()?.id
      ) {
        return undefined;
      }

      const session = activeSession;
      const systemPrompt = readSystemPrompt(event);

      // Already committed this generation: just append. Re-resolving here
      // would silently override a native mid-session user model change
      // (Pi adapter contract "a native user model change governs the current
      // active period"), so activation only happens once per generation.
      if (session.primarySession.getCurrent() !== undefined) {
        return {
          systemPrompt:
            session.primarySession.appendToSystemPrompt(systemPrompt),
        };
      }

      if (session.primaryActivationAttempted) return undefined;
      session.primaryActivationAttempted = true;

      const pendingName = session.pendingPrimaryName;
      if (pendingName === undefined) return undefined;
      const descriptor = session.descriptors.get(pendingName);
      if (descriptor === undefined) {
        deps.logger.warn(
          { agentName: pendingName },
          "default primary descriptor unavailable; ordinary chat has no active Weave primary",
        );
        return undefined;
      }

      // Pi only exposes its loaded skill catalog here, at the first turn
      // (Pi adapter contract) - refresh the catalog immediately before the
      // atomic activation that depends on it.
      session.primarySession.refreshSkills(readBeforeAgentStartSkills(event));

      // Capture a staleness handle *before* the await below: activation
      // (including `pi.setModel`) can take an arbitrary amount of time, and
      // a session replacement (reload/fork/switch/new session_start) can
      // install a fresh generation and a fresh `activeSession` while this
      // call is still in flight.
      const operation = controller.beginOperation();
      if (operation.isErr()) return undefined;
      const handle = operation.value;

      // `ctx.modelRegistry` is host-supplied; a throwing `getAvailable()`
      // must not crash this turn - fall back to an empty catalog, which
      // safely degrades model resolution rather than failing activation.
      const availableModelsResult = safelyListAvailableModels(
        ctx.modelRegistry,
      );
      if (availableModelsResult.isErr()) {
        // `availableModelsResult.error` is always the fixed, closed-set
        // `MODEL_REGISTRY_THREW_REASON` literal - never anything derived
        // from what the host actually threw, since that content cannot be
        // trusted not to contain private paths, environment values, or
        // secrets (Pi adapter contract closed-failure contract).
        deps.logger.warn(
          {
            agentName: descriptor.name,
            reason: availableModelsResult.error,
          },
          "ctx.modelRegistry.getAvailable() threw; treating as no available models this turn",
        );
      }

      const activationResult = await session.primarySession.activate(
        descriptor,
        {
          availableModels: availableModelsResult.unwrapOr([]),
          currentModel: ctx.model,
          modelApplier: createPiModelApplyPort(pi),
          thinkingApplier: createPiThinkingApplyPort(pi),
          disabledSkills: session.disabledSkills,
          preserveCurrentModel: session.userSelectedModelBeforeActivation,
        },
      );

      if (handle.assertStillCurrent().isErr()) {
        // A newer generation replaced this one while we were awaiting
        // skill/model activation. `pi.setModel` may already have been
        // applied against a session that is no longer current and cannot
        // safely be undone - surface that as a visible degradation rather
        // than silently dropping it, but never return this stale call's
        // descriptor prompt as authoritative for the new generation.
        if (activationResult.isOk()) {
          deps.logger.warn(
            { agentName: descriptor.name, generationId: session.generationId },
            "primary activation settled after session replacement; discarding stale authority (a model change may already be applied and cannot be safely restored)",
          );
        }
        return undefined;
      }

      if (activationResult.isErr()) {
        session.primaryActivationFailure = activationResult.error;
        deps.logger.warn(
          { agentName: descriptor.name, error: activationResult.error.type },
          "primary activation failed; prompt not appended this turn",
        );
        return undefined;
      }

      // Pi adapter contract: a primary activation that actually took authority this
      // generation (Loom/Tapestry becoming the active primary) is one of
      // the required `observeSession` trigger points, when a workflow lease
      // is presently active (e.g. Loom re-activating while a workflow is
      // paused). A no-op when no lease is tracked.
      await observeActiveLeaseBestEffort(descriptor.name, "active");

      return {
        systemPrompt: session.primarySession.appendToSystemPrompt(systemPrompt),
      };
    });

    pi.on("agent_start", () => {
      if (childModeState.active) return;
    });

    // Pi adapter contract: one exact-once usage observation per settled primary
    // assistant message. Identity is the message's own id, never text -
    // `extractAssistantUsageFromMessage` returns only bounded safe token/
    // cost scalars, never message content. A no-op when telemetry hasn't
    // been constructed (health-only/untrusted generation, or store open
    // failure) or when the generation has already been replaced.
    pi.on("message_end", async (event, ctx) => {
      if (childModeState.active) return undefined;
      if (activeSession === undefined) return undefined;
      if (
        activeSession.generationId !== controller.getCurrentGeneration()?.id
      ) {
        return undefined;
      }
      const record = asJsonRecord(event);
      if (record === undefined) return undefined;
      const extracted = extractAssistantUsageFromMessage(record);
      if (extracted === undefined) return undefined;
      const telemetry = telemetryCell.telemetry;
      if (telemetry === undefined) return undefined;
      const agentName =
        activeSession.primarySession.getCurrent()?.descriptor.name ??
        DEFAULT_PRIMARY_AGENT_NAME;
      const recorded = await telemetry.recordAssistantUsage({
        id: extracted.id,
        source: "primary",
        agentName,
        ...extracted.usage,
      });
      if (recorded.isErr()) {
        telemetry.recordDegradation(recorded.error);
        telemetry.notifyFailureOnce(
          { notify: (message, level) => ctx.ui.notify(message, level) },
          recorded.error,
        );
      }
      return undefined;
    });

    pi.on("session_shutdown", async (_event, ctx?: PiSessionContext) => {
      // Pi adapter contract: termination while a lease is active is a required
      // `observeSession` trigger point - observe *before* clearing the
      // tracked instance/controller below (a no-op when no lease is
      // tracked). Best-effort only: shutdown must still proceed even if
      // this fails.
      await observeActiveLeaseBestEffort(
        activeSession?.primarySession.getCurrent()?.descriptor.name ??
          "workflow-controller",
        "terminated",
      );
      activeSession = undefined;
      inspectionRegistryCell.registry?.closeGeneration();
      inspectionRegistryCell.registry = undefined;
      recoveryCoordinatorCell.coordinator = undefined;
      delegationControllerCell.controller?.disposeAll();
      delegationControllerCell.controller = undefined;
      workflowControllerCell.controller = undefined;
      planStateProviderCell.value = undefined;
      activeWorkflowInstanceCell.value = undefined;
      currentWorkflows = {};
      treeSelectionCell.selectedId = ROOT_NODE_ID;
      // Adapter telemetry cleanup (Pi adapter contract): records one best-effort
      // shutdown journal entry, then stops retention scheduling and
      // releases the rotating log sink. Idempotent - a repeated
      // `session_shutdown` (or one with no telemetry ever constructed)
      // is a no-op.
      if (telemetryCell.telemetry !== undefined) {
        await telemetryCell.telemetry
          .recordJournalEvent({
            family: "generation",
            event: "shutdown",
            severity: "info",
          })
          .orElse(() => okAsync(undefined));
        await telemetryCell.telemetry
          .shutdown()
          .orElse(() => okAsync(undefined));
        telemetryCell.telemetry = undefined;
      }
      // Bounded child-tree widget/editor state must never survive past this
      // generation (Pi adapter contract cleanup-idempotence) - clear it even
      // though `disposeAll()` above already terminated every child.
      ctx?.ui.setStatus(WEAVE_AGENT_STATUS_KEY, undefined);
      ctx?.ui.setWidget(WEAVE_PLAN_WIDGET_KEY, undefined);
      const editorInstall = editorInstallCell;
      if (editorInstall !== undefined) {
        editorInstall.ctx.ui.setEditorComponent?.(
          editorInstall.previousFactory,
        );
        editorInstallCell = undefined;
      }
      historyStoreCell.store = undefined;
      controller.shutdown();
      // Idempotent regardless of role: a no-op for an ordinary parent
      // session, and terminal secret/process cleanup for a private child.
      childModeState.runtime?.dispose();
    });
  };
}

export default createPiExtension();
