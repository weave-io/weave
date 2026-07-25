import { join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RUNTIME_SETTINGS } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  DelegationTarget,
  EffectiveToolPolicy,
  PermissionSession,
  RuntimeLogFileSystem,
  RuntimeStore,
} from "@weaveio/weave-engine";
import { isDeniedKey, logger } from "@weaveio/weave-engine";
import { okAsync, Result, ResultAsync } from "neverthrow";
import { BunPiArtifactProvider } from "./artifact-provider.js";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
} from "./capability-prober.js";
import {
  type PiApprovalRequestBody,
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
import {
  BunPiChildProcessPort,
  type PiChildProcessPort,
} from "./child-process-port.js";
import {
  type PiChildOutputError,
  type PiChildOutputPort,
  PiChildRuntime,
} from "./child-runtime.js";
import {
  applyTreeControlKey,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantStopReason,
  extractAssistantTextDeltaPreview,
  type PiChildTreeNode,
  ROOT_NODE_ID,
  truncateLatestOutput,
} from "./child-tree.js";
import { classifyChildTreeKey } from "./child-tree-keys.js";
import { renderChildTreeLines } from "./child-tree-render.js";
import { WEAVE_COMMAND_NAMES, type WeaveCommandName } from "./commands.js";
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
  WEAVE_DELEGATION_TOOL_NAME,
} from "./delegation-tool.js";
import { TransportDirectDispatchPort } from "./direct-dispatch.js";
import {
  createDirectDispatchTransport,
  PiDirectStepChildRegistry,
} from "./direct-dispatch-transport.js";
import {
  makeChildAbortFailedFailure,
  makeRequiredCapabilityUnavailableFailure,
} from "./errors.js";
import {
  BunHostPackageReader,
  type HostPackageReader,
} from "./host-compatibility.js";
import { readValidatedCommands, readValidatedTools } from "./host-inventory.js";
import {
  PiModelActivator,
  type PiModelApplyPort,
  PiModelResolver,
} from "./model-resolution.js";
import {
  BunPathContainmentPort,
  type PathContainmentPort,
} from "./path-containment.js";
import {
  APPROVAL_UI_TIMEOUT_MS,
  createChildRelayApprovalPort,
  type PiApprovalChoiceInput,
  type PiApprovalPromptRequest,
  type PiApprovalScope,
  type PiApprovalUiPort,
  type PiChildApprovalRelayPort,
  PiPermissionBridge,
  type PiToolPolicyPlan,
} from "./permission-bridge.js";
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
import {
  deriveActiveToolNames,
  PI_NATIVE_TOOL_CAPABILITY,
} from "./tool-governance.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiEnvPort,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiSkillInfo,
  PiToolCallEvent,
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
  type PiPaletteAction,
} from "./workflow-commands.js";
import { PiWorkflowController } from "./workflow-controller.js";

/** Every dependency this extension needs beyond what Pi hands it directly. Fully injectable for tests. */
export interface PiExtensionDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: PiAdapterLogger;
  readonly configActivator: PiConfigActivator;
  readonly permissionBridge: PiPermissionBridge;
  readonly envPort: PiEnvPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly processPort: PiChildProcessPort;
  /**
   * The private RPC child's default spawn command (Spec 33 §11.2 finding
   * 1): the exact executable that launched this host process, never a bare
   * `"pi"` a spawner would have to re-resolve via `PATH` (which can
   * silently select an unrelated, PATH-shadowing `pi` install). Production
   * wiring MUST derive this via `buildDefaultPiChildCommand(envPort)`;
   * tests MUST override with a fixed command, independent of both `PATH`
   * and the real launching executable.
   */
  readonly childCommand: readonly string[];
  readonly childOutputPort: PiChildOutputPort;
  /**
   * Opens the engine's Runtime Store (Spec 33 §18) - injected so no test
   * ever performs a real SQLite open/migration against a real (or
   * nonexistent, unwritable) path. Production wiring MUST use
   * `SqliteRuntimeStoreFactory`; tests MUST override with
   * `InMemoryRuntimeStoreFactory`/`FailingRuntimeStoreFactory`.
   */
  readonly runtimeStoreFactory: PiRuntimeStoreFactory;
  /**
   * Real, no-follow-safe containment proof for `.weave/runtime`/
   * `.weave/plans` (Spec 33 §17, §18, §21) - injected into
   * `PiSafeInitializer` so capability probing never merely trusts
   * `configLoaded`. Production wiring MUST use `BunPathContainmentPort`;
   * tests MUST override with `FakePathContainmentPort`/
   * `NullPathContainmentPort` (Spec 33 §24 layer D: no real process spawn
   * in a test).
   */
  readonly pathContainmentPort: PathContainmentPort;
  /**
   * Production, no-follow-safe `.weave/plans` directory listing (Spec 33
   * §16) - backs `/weave:start`'s plan-selection prompt and `/weave:plan`'s
   * catalog. Production wiring MUST use `BunPiPlanCatalogPort`; tests MUST
   * override with `FakePiPlanCatalogPort` (Spec 33 §24 layer D: no real
   * filesystem scan in a test).
   */
  readonly planCatalogPort: PiPlanCatalogPort;
  /**
   * Injectable telemetry seams (Spec 33 §19) — journal/usage/retention
   * ports and the rotating log-sink filesystem. Absent means "construct
   * the real engine-backed implementation against the opened Runtime
   * Store" (production default). Tests MUST override with in-memory/fake
   * seams (Spec 33 §24 layer B: no real filesystem/log rotation in a
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
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new CryptoIdGenerator(),
    clock: new SystemClock(),
    logger: log,
    configActivator: new PiConfigActivator(),
    permissionBridge: new PiPermissionBridge({ logger: log }),
    envPort,
    randomPort: new WebCryptoRandomPort(),
    hmacPort: new WebCryptoHmacPort(),
    processPort: new BunPiChildProcessPort(),
    childCommand: buildDefaultPiChildCommand(envPort),
    childOutputPort: new StdoutChildOutputPort(),
    runtimeStoreFactory: new SqliteRuntimeStoreFactory(),
    pathContainmentPort: new BunPathContainmentPort(),
    planCatalogPort: new BunPiPlanCatalogPort(),
  };
}

/**
 * The materialized descriptor catalog and primary-activation state for one
 * generation (Spec 33 §7.2 steps 5-8, 13-14). Kept out of
 * `PiExtensionController`'s own `PiGeneration` type for this task so the
 * task-6 controller contract stays stable; a future task may fold this in.
 *
 * Primary activation (skills + model, together) is deferred from
 * `session_start` to the *first* `before_agent_start` on purpose: Pi only
 * exposes its loaded skill catalog via `systemPromptOptions.skills` at that
 * point (not at `session_start`), and Spec 33 §8.2/§28 requires activation
 * to be atomic across skills and model together - so neither can be
 * committed before both are knowable.
 */
interface PiActiveSession {
  readonly generationId: string;
  readonly primarySession: PiPrimarySession;
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>;
  readonly disabledSkills: readonly string[];
  pendingPrimaryName: string | undefined;
  primaryActivationAttempted: boolean;
  primaryActivationFailure: PiPrimaryActivationError | undefined;
  /**
   * The active, sealed tool-policy plan and its bound permission session for
   * this generation (Spec 33 §12) - both `undefined` when the coverage proof
   * did not succeed this generation. `tool_call` interception is health-only
   * in that case: every governance-relevant name (native-capability-shaped
   * or Weave-owned) blocks rather than falling back to native behavior;
   * only genuinely unrelated third-party tools keep passing through
   * untouched (Spec 33 §12.1, §21).
   */
  readonly toolPolicy: PiToolPolicyPlan | undefined;
  readonly permissionSession: PermissionSession | undefined;
  /**
   * True when the coverage proof itself succeeded (the injected capability
   * prober reported `tool-policy-mapping` as `ok`) but the subsequent
   * mutating registration/activation step failed anyway (Spec 33 §21). The
   * static generation's `healthOnlyMode` cannot reflect this - it was
   * computed from the read-only probe, before this mutation ran - so
   * command gating and health/status output must consult this flag
   * directly rather than trusting `healthOnlyMode` alone.
   */
  readonly permissionActivationFailed: boolean;
}

/** Reads `event.systemPrompt` (Spec 33 §8.3) without assuming any other event shape. */
function readSystemPrompt(event: unknown): string {
  if (typeof event === "object" && event !== null && "systemPrompt" in event) {
    const value = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Reads `event.systemPromptOptions.skills` (Pi's real, already-loaded skill
 * catalog for this turn - Spec 33 §9.1) without assuming any other shape.
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
 * Wraps Pi's real `ExtensionAPI.setModel(model)` (Spec 33 §9.2) so a
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

const APPROVAL_SCOPE_LABELS: Readonly<Record<PiApprovalScope, string>> = {
  once: "Allow once",
  session: "Allow for this session",
  durable: "Allow always for this project",
};
const APPROVAL_REJECT_LABEL = "Reject";

/**
 * Hidden, non-public command a private child process's own extension
 * instance uses to receive parent-to-child authenticated control envelopes
 * (Spec 33 \u00a711.3). Delivered as ordinary RPC `prompt` command text
 * (`/weave:__control__ <json>`) - never `steer`/`follow_up` - so it rides
 * Pi's own documented command dispatch rather than any raw sideband.
 */
const HIDDEN_CONTROL_COMMAND_NAME = "weave:__control__";

interface PiChildBootstrapCommon {
  readonly agentName: string;
  readonly composedPrompt: string;
  readonly models: readonly string[];
  readonly effectiveToolPolicy: EffectiveToolPolicy | undefined;
  readonly delegationTargets: readonly DelegationTarget[];
  /** Must equal this child's own env-derived child id (Spec 33 §11.2 Task 9); a mismatch fails closed. */
  readonly correlationId: string;
  readonly context: PiDelegationContext;
  /** The exact, parent-derived active tool name list this child MUST apply via `pi.setActiveTools()` (Spec 33 §11.2 Task 9). */
  readonly activeTools: readonly string[];
  /** Present only when the parent itself resolved a concrete model identity (root-level delegation, live `ctx.modelRegistry`); absent means this child must resolve against its own authenticated catalog (Spec 33 §9.2, §11.2 Task 9). */
  readonly resolvedModel: PiModelInfo | undefined;
}

/**
 * Strict, mode-discriminated bootstrap union (Spec 33 §13-§15): `mode:
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
 * descriptor (Spec 33 §8, §10-11) - critically including that
 * descriptor's own `delegationTargets`, so a running child can register
 * its own nested/descendant delegation tool once bootstrapped, relayed
 * through its authenticated parent/root coordinator rather than an
 * independent, untracked budget. Also derives the exact active-tool set
 * (Spec 33 §11.2 Task 9) and, when a live session `ctx` is available
 * (root-level delegation only), a concrete parent-resolved model identity.
 */
function buildChildBootstrapBody(
  descriptorsByName: ReadonlyMap<string, AgentDescriptor>,
  target: DelegationTarget,
  childId: string,
  context: PiDelegationContext,
  ctx?: PiSessionContext,
): JsonValue {
  const full = descriptorsByName.get(target.name);
  const hasDelegationTool = (full?.delegationTargets.length ?? 0) > 0;
  const activeTools = deriveActiveToolNames(
    full?.effectiveToolPolicy,
    hasDelegationTool ? WEAVE_DELEGATION_TOOL_NAME : undefined,
  );
  const resolvedModel = ((): PiModelInfo | undefined => {
    if (ctx === undefined) return undefined;
    const availableModels = safelyListAvailableModels(
      ctx.modelRegistry,
    ).unwrapOr([]);
    const resolution = new PiModelResolver().resolve(
      full?.models ?? [],
      availableModels,
    );
    // The matched entry is drawn straight from the host's own
    // `ctx.modelRegistry.getAvailable()` results and may carry fields
    // beyond provider/id/name; project it down before it ever reaches a
    // `ModelIdentityBodySchema`-validated control body (Spec 33 §11.2
    // finding 2).
    return resolution.resolved
      ? toModelIdentityBody(resolution.model)
      : undefined;
  })();
  const bootstrap: PiChildBootstrapBody = {
    mode: "ordinary",
    agentName: target.name,
    composedPrompt: full?.composedPrompt ?? "",
    models: full?.models ?? [],
    effectiveToolPolicy: full?.effectiveToolPolicy,
    delegationTargets: full?.delegationTargets ?? [],
    correlationId: childId,
    context,
    activeTools,
    resolvedModel,
  };
  return bootstrap as unknown as JsonValue;
}

/**
 * Validates a raw bootstrap body against the real strict schema (Spec 33
 * §11.3) instead of ad hoc field reads with silent defaults. A malformed
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
    effectiveToolPolicy: parsed.value.effectiveToolPolicy as
      | EffectiveToolPolicy
      | undefined,
    delegationTargets: parsed.value.delegationTargets ?? [],
    correlationId: parsed.value.correlationId,
    context: parsed.value.context,
    activeTools: parsed.value.activeTools,
    resolvedModel: parsed.value.resolvedModel,
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
  /** True only once the bootstrap descriptor/model/policy have actually been applied and acked - never before. */
  bootstrapApplied: boolean;
  toolPolicy: PiToolPolicyPlan | undefined;
  permissionSession: PermissionSession | undefined;
  runtime: PiChildRuntime | undefined;
  /**
   * The current turn's accumulated assistant text, truncated to <=4KiB
   * valid UTF-8 (Task 9 finding 1). Reset on every `turn_start` so a stale
   * previous turn's text is never reported as this turn's settlement
   * summary; fed by `message_update` deltas; read (and re-truncated as a
   * belt-and-suspenders bound) when `agent_settled` fires.
   */
  latestAssistantOutput: string;
  /**
   * The most recently observed assistant `stopReason` from a `message_end`
   * event (Task 9 finding 2) - `"stop"`, `"length"`, `"toolUse"`, `"error"`,
   * or `"aborted"`. `agent_settled` itself carries no payload, so this is
   * the only observable signal available to derive a failed outcome.
   */
  lastAssistantStopReason: string | undefined;
  /**
   * Present only for a direct-step child (Spec 33 §13-§15) - `undefined`
   * for every ordinary-delegation child. Drives `weave_complete_step`
   * registration and structured (not free-text) settlement reporting.
   */
  directStep: PiDirectStepChildState | undefined;
}

/** Per-turn direct-step completion state (Spec 33 §15). */
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
    toolPolicy: undefined,
    permissionSession: undefined,
    runtime: undefined,
    directStep: undefined,
    latestAssistantOutput: "",
    lastAssistantStopReason: undefined,
  };
}

/** Safe, fixed fallback summary used only when a completed child produced no observable assistant text (Task 9 finding 1). */
const EMPTY_CHILD_SUMMARY_FALLBACK = "(child produced no assistant output)";

/**
 * Applies the parent's bootstrap payload to this child's own extension
 * state: records the descriptor's composed prompt for one-time append in
 * `before_agent_start`, plans+activates this child's own governed-tool
 * permission session (Spec 33 \u00a712) scoped to its own descriptor policy,
 * and resolves+applies its own model intent - all independent of, and
 * never overriding, the parent's own primary session.
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
  // Correlation check (Spec 33 §11.2 Task 9): the bootstrap's own
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
  const policies: Record<string, EffectiveToolPolicy> =
    parsed.effectiveToolPolicy !== undefined
      ? { [parsed.agentName]: parsed.effectiveToolPolicy }
      : {};
  // Constructed unconditionally (cheap, no side effects) so the
  // `weaveOwnedRegistrations` closure below can capture it regardless of
  // `parsed.mode`; only ever consulted when `parsed.mode === "direct-step"`.
  // `isWindowOpen` reads `state.directStep.windowOpen` (set at the final
  // commit point below, and flipped to `false` by the `agent_settled`
  // handler) as the single source of truth - never a second, independently
  // mutable flag that could drift from it.
  const directStepRecorder = new SingleCompletionCandidateRecorder();
  // A bootstrapped child with its own declared delegation targets gets its
  // own weave_delegate tool, relayed through this exact child's own
  // authenticated runtime rather than an independent budget (Spec 33
  // §10-11 nested/descendant delegation).
  const weaveOwnedRegistrations = [
    ...(parsed.delegationTargets.length === 0
      ? []
      : [
          buildRelayedDelegationToolRegistration({
            targets: parsed.delegationTargets,
            getRuntime: () => state.runtime,
          }),
        ]),
    // Only a direct-step child (Spec 33 §13-§15) ever receives
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
  const planned = deps.permissionBridge.planToolPolicy({
    allTools: pi.getAllTools(),
    weaveOwnedRegistrations,
    policies,
  });
  if (planned.isErr()) {
    deps.logger.error(
      { code: planned.error.code },
      "child tool-policy planning failed; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }
  const registered = deps.permissionBridge.registerWeaveOwnedTools(
    pi,
    weaveOwnedRegistrations,
  );
  if (registered.isErr()) {
    deps.logger.error(
      { code: registered.error.code },
      "child weave-owned tool registration failed; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }
  const activated = await deps.permissionBridge.activate({
    project: ctx.cwd,
    controllerSession: state.childId,
    plan: planned.value,
  });
  if (activated.isErr()) {
    deps.logger.error(
      { code: activated.error.code },
      "child permission-session activation failed; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }

  // Strict active-tool-set validation (Spec 33 §11.2 Task 9): every name
  // the parent requested must be one this child's own live plan actually
  // recognizes as governed (genuinely built-in native, or the exact
  // weave-owned registration just verified above) - an unknown name means
  // either a stale parent-side derivation or a forged bootstrap, and fails
  // closed either way rather than silently activating an unverified tool.
  const knownGoverned = new Set<string>([
    ...planned.value.verifiedNative,
    ...planned.value.weaveOwned,
  ]);
  const unknownTools = parsed.activeTools.filter(
    (name) => !knownGoverned.has(name),
  );
  if (unknownTools.length > 0) {
    deps.logger.error(
      { unknownTools },
      "bootstrap requested unknown active tool names; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }
  const applySetActiveTools = ResultAsync.fromThrowable(
    async (names: readonly string[]) => {
      await pi.setActiveTools(names);
    },
    (error) => (error instanceof Error ? error : new Error(String(error))),
  );
  const setActiveToolsResult = await applySetActiveTools(parsed.activeTools);
  if (setActiveToolsResult.isErr()) {
    deps.logger.error(
      {},
      "host rejected setActiveTools; failing closed and never acking bootstrap",
    );
    runtime.dispose();
    return;
  }
  let appliedActiveTools: string[] = [...parsed.activeTools];
  if (pi.getActiveTools !== undefined) {
    const readActiveTools = Result.fromThrowable(
      () => pi.getActiveTools?.() ?? [],
      (error) => (error instanceof Error ? error : new Error(String(error))),
    );
    const verifyResult = readActiveTools();
    if (verifyResult.isErr()) {
      deps.logger.error(
        {},
        "host rejected getActiveTools verification; failing closed and never acking bootstrap",
      );
      runtime.dispose();
      return;
    }
    const reported = new Set(verifyResult.value);
    const expected = new Set(parsed.activeTools);
    const matches =
      reported.size === expected.size &&
      [...expected].every((name) => reported.has(name));
    if (!matches) {
      deps.logger.error(
        {},
        "host active tools do not match requested set; failing closed and never acking bootstrap",
      );
      runtime.dispose();
      return;
    }
    appliedActiveTools = [...reported];
  }

  // Model activation (Spec 33 §9.2, §11.2 Task 9): rehydrate the parent's
  // compact resolved identity from this child's authenticated catalog when
  // present (root-level delegation); otherwise resolve the descriptor's
  // intent against that catalog. Only a full catalog model may reach
  // `pi.setModel()`; the compact identity exists only on the control channel.
  // Only a genuine *activation* failure (a model resolved but the host
  // rejected applying it) fails bootstrap closed. "Nothing in the intent
  // resolved" is not a failure - Spec 33 §9.2 requires gracefully keeping
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
    // `ModelIdentityBodySchema`-validated field (Spec 33 §11.2 finding 2).
    const rawAppliedModel =
      outcome.status === "applied" ? outcome.model : outcome.currentModel;
    appliedModel =
      rawAppliedModel === undefined
        ? undefined
        : toModelIdentityBody(rawAppliedModel);
  }

  // Only now - descriptor prompt recorded for append, tool policy planned/
  // registered/activated, active tools applied+verified, and a concrete
  // model actually applied - is bootstrap atomic and safe to ack (Spec 33
  // §11.2 Task 9). Every failure branch above disposed the runtime and
  // returned before this point; there is no partial-application state, and
  // the parent never sends task work on the strength of the bootstrap send
  // alone (Spec 33 §11.3/§11.5).
  state.agentName = parsed.agentName;
  state.composedPrompt = parsed.composedPrompt;
  state.toolPolicy = planned.value;
  state.permissionSession = activated.value;
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
  // `resolvedModel` is genuinely optional in `PiBootstrapAckBody` (Spec 33
  // §11.2 Task 9) - the key must be entirely absent, not present with an
  // `undefined` value, since `undefined` is not a valid `JsonValue` and
  // would make the ack envelope fail canonical (JCS) signing, silently
  // discarded by this `void` call and leaving the parent waiting forever.
  await runtime.reportBootstrapAck(
    appliedModel !== undefined
      ? { activeTools: appliedActiveTools, resolvedModel: appliedModel }
      : { activeTools: appliedActiveTools },
  );
}

/**
 * Fixed, closed-set classification of an approval-relay failure's `cause`
 * (Task 9 finding 3). The raw `cause` value is unknown, untyped content -
 * it could carry private paths, environment values, or secrets embedded in
 * an error message - so it must never be logged verbatim. Only this fixed
 * code is safe to emit.
 */
export function classifyApprovalRelayFailureCause(
  cause: unknown,
): "thrown-error" | "rejected-non-error" {
  return cause instanceof Error ? "thrown-error" : "rejected-non-error";
}

/**
 * Builds a plain `JsonValue` clone of an already-validated approval prompt
 * request via explicit, typed field-by-field construction (Task 9 finding
 * 3) - never `JSON.parse(JSON.stringify(...))`, which can throw on a
 * cyclic value or an accessor that throws, and can silently drop/alter
 * fields (e.g. `undefined`, `NaN`, non-plain prototypes) in ways a caller
 * would not expect from a "safe" clone. Every field read here is a plain,
 * already-schema-validated primitive or array of primitives, so this
 * cannot throw.
 */
export function cloneApprovalPromptRequestAsJson(
  request: PiApprovalPromptRequest,
): JsonValue {
  return {
    agentName: request.agentName,
    toolIdentity: request.toolIdentity,
    requests: request.requests.map((pending) => ({
      summary: pending.summary,
      ...(pending.details !== undefined ? { details: pending.details } : {}),
      unresolved: pending.unresolved,
    })),
    allowedScopes: [...request.allowedScopes],
  };
}

/**
 * Relays one of a live child's own governed tool-call approval prompts to
 * the sole parent TUI, preserving the child's identity, then delivers the
 * caller's choice back to that exact child over the authenticated channel
 * (Spec 33 \u00a711.5, \u00a712.4).
 */
function relayChildApprovalToParentUi(
  ctx: PiSessionContext,
  controllerCell: { controller: PiDelegationController | undefined },
  logger: PiAdapterLogger,
): (
  childId: string,
  correlationId: string,
  request: PiApprovalRequestBody,
) => void {
  // At most one outstanding parent-side correlation per (childId,
  // correlationId): a duplicate/replayed relay for the same decision must
  // never open a second concurrent UI prompt for it.
  const inFlight = new Set<string>();
  const rejectResponse: JsonValue = { scope: "reject" };
  return (childId, correlationId, request) => {
    const key = `${childId}:${correlationId}`;
    if (inFlight.has(key)) {
      logger.warn(
        { childId, correlationId },
        "dropped duplicate concurrent child approval-request relay",
      );
      return;
    }
    inFlight.add(key);
    // `PiApprovalRequestBody` (the already-validated wire body) and
    // `PiApprovalPromptRequest` (the UI-facing type) share the exact same
    // shape by construction - used directly here, no cast.
    const promptRequest: PiApprovalPromptRequest = {
      ...request,
      agentName: `${request.agentName} (child ${childId})`,
    };
    const approvalUi = createParentUiApprovalPort(ctx);
    void (async (): Promise<void> => {
      const choice = await approvalUi.promptApproval(promptRequest);
      const candidate: JsonValue = choice ?? rejectResponse;
      // Never forward a UI response to the child without validating it
      // against the exact same schema the child itself will re-validate on
      // arrival - a malformed/unexpected shape here always fails closed to
      // `reject` rather than being relayed as-is.
      const validated = parseControlBody("approval-response", candidate);
      const responseBody: JsonValue = validated.ok ? candidate : rejectResponse;
      await controllerCell.controller?.respondToApproval(
        childId,
        correlationId,
        responseBody,
      );
    })()
      .catch(async (cause: unknown) => {
        // A thrown/rejected UI or send failure must never become an
        // unhandled rejection - fail closed with an explicit reject rather
        // than leaving the child's own approval wait to time out silently.
        // Never log the raw `cause` value: it is unknown, untyped content
        // (it could carry private paths, environment values, or secrets
        // embedded in an error message) - only a fixed, closed-set
        // classification code is safe to emit (Task 9 finding 3).
        logger.error(
          {
            childId,
            correlationId,
            causeCode: classifyApprovalRelayFailureCause(cause),
          },
          "child approval relay failed; responding with reject",
        );
        await controllerCell.controller?.respondToApproval(
          childId,
          correlationId,
          rejectResponse,
        );
      })
      .finally(() => {
        inFlight.delete(key);
      });
  };
}

/**
 * Detects whether this process is a private RPC child (Spec 33 \u00a711.2
 * -\u00a711.5) by reading its bootstrap secret from the environment only.
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

  pi.on("tool_call", async (event, toolCtx: PiSessionContext) => {
    if (!state.active) return undefined;
    const toolCallEvent = event as PiToolCallEvent;
    const toolIdentity = toolCallEvent.toolName;
    const isNativeCapabilityName = Object.hasOwn(
      PI_NATIVE_TOOL_CAPABILITY,
      toolIdentity,
    );
    if (
      !state.bootstrapApplied ||
      state.toolPolicy === undefined ||
      state.permissionSession === undefined
    ) {
      // Never govern (nor silently pass through) a native-capability tool
      // call before bootstrap has actually been confirmed applied - the
      // child must not race its own bootstrap (Spec 33 §11.3/§11.5).
      if (isNativeCapabilityName) {
        return { block: true, reason: "tool-policy-unavailable" };
      }
      return undefined;
    }
    const isGovernanceRelevant =
      isNativeCapabilityName ||
      state.toolPolicy.weaveOwned.includes(toolIdentity);
    if (!isGovernanceRelevant) return undefined;
    const relay: PiChildApprovalRelayPort = {
      relay: async (_childId, request) => {
        const safeRequest = cloneApprovalPromptRequestAsJson(request);
        const result = await runtime.requestApproval(safeRequest);
        // `requestApproval` already validated the reply against the exact
        // same schema `PiApprovalChoiceInput` mirrors, so the resolved
        // value is used directly here - no cast.
        return result.match(
          (response) => response,
          () => undefined,
        );
      },
    };
    const result = await ResultAsync.fromPromise(
      deps.permissionBridge.intercept({
        session: state.permissionSession,
        plan: state.toolPolicy,
        project: toolCtx.cwd,
        controllerSession: state.childId,
        agentName: state.agentName,
        toolIdentity,
        call: toolCallEvent.input,
        approvalUiAvailable: true,
        approvalUi: createChildRelayApprovalPort(relay, state.childId),
        pi,
        // Live attestation for the bridge's narrow control-channel bypass
        // (Spec 33 §15): true only while THIS child owns direct-step state
        // (set at bootstrap commit, undefined for every ordinary/nested
        // child - see `PiChildModeState.directStep`). Read fresh on every
        // call, never cached. The completion recorder remains the authority
        // that classifies calls after its window closes as typed `late`
        // attempts rather than valid completion candidates.
        directStepActive: state.directStep !== undefined,
      }),
      () => "child-tool-policy-bridge-rejected" as const,
    ).andThen((decision) => decision);
    if (result.isErr()) {
      return { block: true, reason: "tool-policy-intercept-failed" };
    }
    const decision = result.value;
    if (decision.kind === "block")
      return { block: true, reason: decision.reason };
    if (decision.kind === "allow-unmanaged") return undefined;
    if (typeof decision.call === "object" && decision.call !== null) {
      // Identity guard (issue #21 Task 12): only destructively replace when
      // decision.call is a distinct normalized object. When the control-channel
      // bypass returns {kind:"allow",call:input.call} with the SAME reference
      // as toolCallEvent.input, deleting keys would empty both aliases before
      // Object.assign runs, leaving the recorder with a malformed empty shape.
      if (decision.call !== toolCallEvent.input) {
        for (const key of Object.keys(toolCallEvent.input))
          delete toolCallEvent.input[key];
        Object.assign(toolCallEvent.input, decision.call);
      }
    }
    return undefined;
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
  // own `PiChildRpc` buffer semantics, Spec 33 §11.5).
  pi.on("turn_start", () => {
    state.latestAssistantOutput = "";
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
    return undefined;
  });

  pi.on("agent_settled", async () => {
    // A cancellation already in flight (or already reported) owns the
    // terminal outcome - never race a stray `"completed"` report past a
    // `"cancelled"` one that already went out, and never report completed
    // more than once (Task 9 finding 2).
    if (runtime.isCancelled()) return;
    // Direct-step completion window closes the instant this event fires
    // (Spec 33 §15) - a tool call that races in afterward must observe
    // `windowOpen === false` and be rejected as late, never recorded.
    if (state.directStep !== undefined) state.directStep.windowOpen = false;
    if (
      state.lastAssistantStopReason === "error" ||
      state.lastAssistantStopReason === "aborted"
    ) {
      await runtime.reportSettled("failed", {
        reason: `assistant stop reason: ${state.lastAssistantStopReason}`,
      });
      return;
    }
    if (state.directStep !== undefined) {
      // A direct-step child's settlement is NEVER free-form prose (Spec 33
      // §15): report the one recorded structured completion candidate as
      // JSON, or a specific typed failure reason - `missing`/`duplicate`/
      // `late`/`malformed:<msg>` - that `direct-dispatch.ts`'s
      // `interpretSettlement` parses on the parent side. Process exit or
      // prose is never success.
      const candidate = state.directStep.recorder.take();
      if (candidate !== undefined) {
        await runtime.reportSettled("completed", {
          summary: serializeCompletionCandidate(candidate),
        });
        return;
      }
      const attempt = state.directStep.lastAttempt;
      if (attempt === undefined) {
        await runtime.reportSettled("failed", { reason: "missing" });
        return;
      }
      if (attempt.outcome === "malformed") {
        await runtime.reportSettled("failed", {
          reason: `malformed:${attempt.malformedReason ?? "unknown"}`,
        });
        return;
      }
      await runtime.reportSettled("failed", { reason: attempt.outcome });
      return;
    }
    const summary = truncateLatestOutput(state.latestAssistantOutput);
    await runtime.reportSettled("completed", {
      summary: summary.length > 0 ? summary : EMPTY_CHILD_SUMMARY_FALLBACK,
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

/**
 * Direct parent-TUI approval port (Spec 33 §12.4): prompts `ctx.ui.select`
 * with the sanitized pending-request summaries and maps the chosen label
 * back to a scope choice. A private child instead wraps
 * {@link createChildRelayApprovalPort} with the same request shape - this
 * function is never used for a child call.
 */
function createParentUiApprovalPort(ctx: PiSessionContext): PiApprovalUiPort {
  return {
    promptApproval: async (
      request: PiApprovalPromptRequest,
    ): Promise<PiApprovalChoiceInput | undefined> => {
      const title = `${request.agentName} wants to use "${request.toolIdentity}"`;
      const details = request.requests.map((r) => `- ${r.summary}`).join("\n");
      const options = [
        ...request.allowedScopes.map((scope) => APPROVAL_SCOPE_LABELS[scope]),
        APPROVAL_REJECT_LABEL,
      ];
      const choice = await ctx.ui.select(`${title}\n${details}`, options, {
        timeout: APPROVAL_UI_TIMEOUT_MS,
      });
      if (choice === undefined || choice === APPROVAL_REJECT_LABEL) {
        return { scope: "reject" };
      }
      const scope = request.allowedScopes.find(
        (candidate) => APPROVAL_SCOPE_LABELS[candidate] === choice,
      );
      return scope === undefined ? { scope: "reject" } : { scope };
    },
  };
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
  }
}

function renderHealthOnlyBlockedMessage(name: WeaveCommandName): string {
  return `Weave is in health-only mode; ${name} is unavailable until required capabilities recover. Run /weave:health for details.`;
}

/**
 * A post-preflight permission activation/registration failure must be
 * visible as health-only even when the injected capability prober reported
 * `tool-policy-mapping` as `ok` (Spec 33 §21) - the static generation's
 * `healthOnlyMode` was computed before that mutation ran and cannot reflect
 * it. Command gating and health/status output MUST consult both signals.
 */
function effectiveHealthOnly(
  generation: { readonly healthOnlyMode: boolean; readonly id: string },
  activeSession: PiActiveSession | undefined,
): boolean {
  if (generation.healthOnlyMode) return true;
  if (activeSession === undefined) return false;
  if (activeSession.generationId !== generation.id) return false;
  return activeSession.permissionActivationFailed;
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
  const mode = effectiveHealthOnly(generation, activeSession)
    ? "health-only"
    : "ready";
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
  activeSession: PiActiveSession | undefined,
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
    `health-only: ${effectiveHealthOnly(generation, activeSession)}`,
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

const WEAVE_CHILD_TREE_WIDGET_KEY = "weave-children";
const WEAVE_PLAN_WIDGET_KEY = "weave-plan";

/**
 * Renders the bounded compact plan widget (Spec 33 §16) via the real,
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

/** Renders the bounded child-tree widget (Spec 33 §11.5) via the real, always-available `ctx.ui.setWidget` surface. Hides the widget entirely (empty array) once there are no children left. */
function renderChildTreeWidget(
  ctx: PiSessionContext,
  controller: PiDelegationController | undefined,
  selectionCell: { selectedId: string },
): void {
  const nodes = controller?.snapshotTree() ?? [];
  const lines = renderChildTreeLines(
    nodes,
    selectionCell.selectedId,
    controller?.snapshotCumulativeUsage() ?? EMPTY_USAGE_AGGREGATE,
  );
  ctx.ui.setWidget(
    WEAVE_CHILD_TREE_WIDGET_KEY,
    lines.length === 0 ? undefined : lines,
    {
      placement: "belowEditor",
    },
  );
}

interface WeaveChildTreeEditorDeps {
  getNodesMap(): ReadonlyMap<string, PiChildTreeNode>;
  getSelection(): string;
  setSelection(nodeId: string): void;
  cancelSubtree(nodeId: string): void;
}

/**
 * Compositional custom editor (Spec 33 §11.5, per `docs/tui.md` "Pattern
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
    // `host-default` (root-level Backspace/Esc - Spec 33 §11.5 requires
    // preserving normal host behavior here with no exception, including
    // for a live direct-step child; pausing a running workflow is only
    // ever done through the explicit, confirmed parent-chat interrupt path
    // in the `input` handler below, per Spec 33 §14) or `no-target`:
    // preserve Pi's own default editor behavior exactly.
    super.handleInput(data);
  }
}

/**
 * The one compiled extension entry (Spec 33 §5/§7.1). The returned factory is
 * synchronous and, per Spec 33 §7.1, only: constructs the controller, registers the
 * nine inert `/weave:*` command shells and the lifecycle delegates, and
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
  // Populated only once `session_start` has activated a real generation and
  // constructed a live delegation controller for it (Spec 33 §11). The
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
  // Bounded, live child-tree selection state (Spec 33 §11.5) - reset to the
  // root whenever a fresh generation activates.
  const treeSelectionCell: { selectedId: string } = {
    selectedId: ROOT_NODE_ID,
  };
  // Per-generation workflow controller (Spec 33 §10/§14) - projects all ten
  // engine lifecycle operations. Constructed only when trusted and not
  // health-only, mirroring `delegationControllerCell`'s gating.
  const directStepChildRegistry = new PiDirectStepChildRegistry();
  const workflowControllerCell: {
    controller: PiWorkflowController | undefined;
  } = {
    controller: undefined,
  };
  const activeWorkflowInstanceCell: {
    value:
      | {
          workflowInstanceId: string;
          leaseId?: string;
          controllerGeneration?: string;
        }
      | undefined;
  } = { value: undefined };
  // Per-generation telemetry unit (Spec 33 §19) - constructed only once the
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
  const controllerDeps: PiExtensionControllerDeps = {
    safeInitializer: new PiSafeInitializer({
      hostPackageReader: deps.hostPackageReader,
      capabilityProber: deps.capabilityProber,
      configActivator: deps.configActivator,
      permissionBridge: deps.permissionBridge,
      pathContainmentPort: deps.pathContainmentPort,
      buildDelegationToolRegistrations: (primary, activation) =>
        primary.delegationTargets.length === 0
          ? []
          : [
              buildDelegationToolRegistration({
                targets: primary.delegationTargets,
                getController: () => delegationControllerCell.controller,
                parentId: ROOT_NODE_ID,
                parentDepth: 0,
                parentAgentName: primary.name,
                idGenerator: deps.idGenerator,
                buildBootstrap: (target, _task, childId, ctx) =>
                  buildChildBootstrapBody(
                    activation.descriptors.byName,
                    target,
                    childId,
                    {
                      parentAgentName: primary.name,
                      parentDepth: 0,
                      cwd: ctx.cwd,
                    },
                    ctx,
                  ),
                buildEnv: () => ({}),
              }),
            ],
    }),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    logger: deps.logger,
  };
  const controller = new PiExtensionController(controllerDeps);
  let activeSession: PiActiveSession | undefined;
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

  // Spec 33 §14: `observeSession` must fire for primary/direct-step
  // activation and for termination, not only for start/resume and
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

  // Shared dispatch used by both the colon-prefixed direct commands and the
  // bare `/weave` native palette (Spec 33 §13): every action, regardless of
  // how it was invoked, goes through this exact one gate/generation/health
  // check and the exact same handleWeaveXxx() handler - the palette never
  // gets a second, looser code path.
  async function dispatchWeaveCommand(
    name: WeaveCommandName,
    _rawArgs: string,
    ctx: PiSessionContext,
  ): Promise<void> {
    // A private delegated child never exposes the parent's public
    // /weave:* commands, even though registerCommand runs once at
    // factory time before child mode can be detected (Spec 33 §7.1,
    // §11.2 - public adapter surface stays TUI-only).
    if (childModeState.active) return;
    const gate = controller.evaluateCommandGate(name);
    if (gate.isErr()) {
      ctx.ui.notify(gate.error.safeMessage, "error");
      return;
    }
    // A post-preflight permission activation/registration failure
    // (Spec 33 §21) must also block mutating commands, even when the
    // static generation's `healthOnlyMode` (computed from the
    // read-only probe alone) reports `false`.
    const generation = controller.getCurrentGeneration();
    const blockedByPermissionFailure =
      gate.value.classification === "mutating" &&
      generation !== undefined &&
      effectiveHealthOnly(generation, activeSession);
    if (!gate.value.allowed || blockedByPermissionFailure) {
      ctx.ui.notify(renderHealthOnlyBlockedMessage(name), "warning");
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
    const tracker: PiActiveWorkflowTracker = buildWorkflowTracker(ctx.cwd);
    if (name === "weave:start") {
      await handleWeaveStart(_rawArgs, ctx.ui, workflowController, tracker);
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
      // Fresh confirm alone is not enough (Spec 33 §18): a stale
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
        // Issue #21 Task 12 S019/S020: terminal pointers always fail closed;
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
        // Issue #21 Task 12 S020: reload/restart installs a fresh generation
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

  return function piAdapterExtension(pi: PiExtensionApi): void {
    for (const name of WEAVE_COMMAND_NAMES) {
      pi.registerCommand(name, {
        description: commandDescription(name),
        handler: async (_rawArgs: string, ctx: PiSessionContext) => {
          await dispatchWeaveCommand(name, _rawArgs, ctx);
        },
      });
    }

    // Native `/weave` palette (Spec 33 §13): the same nine actions as the
    // colon commands, derived from `inspect()`/current state, with invalid
    // actions hidden/disabled with a reason - dispatched through the exact
    // same `dispatchWeaveCommand` gate/generation/health check, never a
    // second looser path.
    pi.registerCommand("weave", {
      description: "Weave: choose an action from the current state",
      handler: async (_rawArgs: string, ctx: PiSessionContext) => {
        if (childModeState.active) return;
        const generation = controller.getCurrentGeneration();
        const healthOnly =
          generation === undefined
            ? true
            : effectiveHealthOnly(generation, activeSession);
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
        await dispatchWeaveCommand(commandName, "", ctx);
      },
    });

    // Parent-chat/workflow concurrency (Spec 33 §14): an ordinary prompt
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
      const tools = readValidatedTools(pi);
      if (tools.isErr()) {
        ctx.ui.notify(tools.error.safeMessage, "error");
        return;
      }
      const activation = await controller.activate(
        ctx,
        commands.value,
        tools.value,
      );
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

      // Spec 33 §28: wrong mode/host/version blocks config activation
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

      // Open the trusted project's Runtime Store once and share that exact
      // instance with permissions, telemetry, and workflow lifecycle. Safe
      // preflight remains read-only; this is the first mutating activation
      // boundary. A failed open leaves durable grants and workflow commands
      // unavailable without falling back to a fake durable scope.
      let runtimeStore: RuntimeStore | undefined;
      if (
        !generation.healthOnlyMode &&
        generation.preflight.trust === "trusted"
      ) {
        const opened = await deps.runtimeStoreFactory.open(ctx.cwd);
        if (opened.isErr()) {
          deps.logger.warn(
            { failure: opened.error },
            "Runtime Store open/migration failed; durable permissions and workflow lifecycle commands unavailable this generation",
          );
        } else {
          runtimeStore = opened.value;
        }
      }

      // Registration/activation only proceeds once the sealed tool-policy
      // plan's coverage proof succeeded this generation (Spec 33 §7.2 step
      // 13, §12.1). An incomplete/invalid coverage proof leaves
      // `permissionSession` undefined below - the `tool_call` handler then
      // treats this as health-only for tool policy and BLOCKS every
      // governance-relevant name (Spec 33 §21); it does not fall back to
      // native behavior for those names, only genuinely unrelated
      // third-party tools keep passing through untouched.
      const toolPolicy = generation.preflight.toolPolicy;
      let permissionSession: PermissionSession | undefined;
      // Absent or failed coverage is itself a runtime permission-activation
      // failure - never rely solely on an injected/misbehaving capability
      // prober's optimism. This starts `true` whenever there is no sealed,
      // coverage-proven plan to activate against, and registration/session
      // activation failures below can only add to it, never clear it.
      let permissionActivationFailed =
        toolPolicy === undefined || toolPolicy.coverage.isErr();
      if (toolPolicy?.coverage.isOk()) {
        const registered = deps.permissionBridge.registerWeaveOwnedTools(
          pi,
          generation.preflight.weaveOwnedRegistrations,
        );
        if (registered.isErr()) {
          permissionActivationFailed = true;
          deps.logger.warn(
            { code: registered.error.code },
            "weave-owned tool registration failed; tool policy governance disabled this generation",
          );
        } else {
          const activated = await deps.permissionBridge.activate({
            project: ctx.cwd,
            controllerSession: generation.id,
            plan: toolPolicy,
            ...(runtimeStore === undefined ? {} : { runtimeStore }),
          });
          if (activated.isErr()) {
            permissionActivationFailed = true;
            deps.logger.warn(
              { code: activated.error.code },
              "permission session activation failed; tool policy governance disabled this generation",
            );
          } else {
            permissionSession = activated.value;
          }
        }
      }

      currentWorkflows = configActivation.config.workflows ?? {};
      activeSession = {
        generationId: generation.id,
        primarySession: new PiPrimarySession({
          skillCatalog: new PiSkillCatalog([]),
          logger: deps.logger,
        }),
        descriptors: configActivation.descriptors.byName,
        disabledSkills: configActivation.config.disabled?.skills ?? [],
        pendingPrimaryName: DEFAULT_PRIMARY_AGENT_NAME,
        primaryActivationAttempted: false,
        primaryActivationFailure: undefined,
        toolPolicy,
        permissionSession,
        permissionActivationFailed,
      };

      // The footer status set above (before this activation ran) can go
      // stale the moment registration/activation fails after an otherwise
      // healthy preflight - correct it now so the visible status always
      // reflects the adapter's true effective health for this generation
      // (Spec 33 §21).
      ctx.ui.setStatus(
        "weave",
        effectiveHealthOnly(generation, activeSession)
          ? "health-only - run /weave:health for details"
          : "ready",
      );

      // The delegation transport is only ever constructed for a fully
      // activated generation, never at factory time (Spec 33 §7.1) and
      // never for a health-only/trust-withheld generation - delegation is a
      // registered capability tool and durable operation exactly like the
      // ones Spec 33 §7.3/§21 already disable in those states.
      if (
        !effectiveHealthOnly(generation, activeSession) &&
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
          // "pi" a spawner would have to re-resolve via `PATH` (Spec 33
          // §11.2 finding 1).
          command: deps.childCommand,
          // Preserves ordinary runtime necessities (PATH/HOME/etc.) for the
          // spawned `pi` process, while never forwarding secrets/credentials
          // or this adapter's own private child-bootstrap variables.
          baseEnv: sanitizedBaseEnv(isDeniedKey),
          rootAgentName: () =>
            activeSession?.primarySession.getCurrent()?.descriptor.name ??
            DEFAULT_PRIMARY_AGENT_NAME,
          onChildApprovalRequest: relayChildApprovalToParentUi(
            ctx,
            delegationControllerCell,
            deps.logger,
          ),
          // Nested/descendant delegation (Spec 33 §10-11): a requesting
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
            );
          },
          // Lazy wrapper (Spec 33 §19.4): `telemetryCell.telemetry` is only
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
        // Workflow lifecycle projection (Spec 33 §10/§14) reuses the same
        // trusted Runtime Store already bound to durable permissions.
        if (runtimeStore !== undefined) {
          // Adapter telemetry (Spec 33 §19): activated only now that the
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
            planStateProvider: createPiPlanStateProvider(ctx.cwd),
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
                  // (Spec 33 §11.2 finding 1).
                  command: deps.childCommand,
                  baseEnv: sanitizedBaseEnv(isDeniedKey),
                  registry: directStepChildRegistry,
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
            // Resolves a direct-step agent's own REAL descriptor (composed
            // prompt, models, tool policy, delegation targets) from this
            // generation's own activated catalog by name (Spec 33 §6,
            // §13-§15) - never the engine effect's own always-empty
            // `agentDescriptor` fields.
            resolveAgentDescriptor: (agentName) =>
              configActivation.descriptors.byName.get(agentName),
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
            // Spec 33 §16: refreshes the bounded compact plan widget after
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
          // Recovery banner (Spec 33 §18): read-only on every session start.
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
          // Spec 33 §16: initial compact plan widget render at session
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
        renderChildTreeWidget(
          ctx,
          delegationControllerCell.controller,
          treeSelectionCell,
        );
        // Compositional custom editor (Spec 33 §11.5): production-wires
        // Alt+1..Alt+9/Backspace/Esc against the live child tree while
        // preserving every Pi host default (see `WeaveChildTreeEditor`).
        ctx.ui.setEditorComponent?.(
          (tui: unknown, theme: unknown, keybindings: unknown) =>
            new WeaveChildTreeEditor(tui, theme, keybindings, {
              getNodesMap: () => {
                const nodes =
                  delegationControllerCell.controller?.snapshotTree() ?? [];
                return new Map(nodes.map((node) => [node.id, node]));
              },
              getSelection: () => treeSelectionCell.selectedId,
              setSelection: (nodeId) => {
                treeSelectionCell.selectedId = nodeId;
                renderChildTreeWidget(
                  ctx,
                  delegationControllerCell.controller,
                  treeSelectionCell,
                );
              },
              cancelSubtree: (nodeId) => {
                void delegationControllerCell.controller?.cancelSubtree(nodeId);
              },
            }),
        );
      }
    });

    pi.on("tool_call", async (event, ctx: PiSessionContext) => {
      if (childModeState.active) return undefined;
      const toolCallEvent = event as PiToolCallEvent;
      const toolIdentity = toolCallEvent.toolName;
      // Structurally always-governance-relevant: Pi's closed native-capability
      // set. A name outside this set is only governance-relevant when this
      // generation's plan explicitly claims it as Weave-owned; every other
      // discovered name is a genuine, unrelated third-party tool (Spec 33
      // §12.1) that must keep its owner's behavior untouched even when we
      // cannot presently govern anything at all.
      const isNativeCapabilityName = Object.hasOwn(
        PI_NATIVE_TOOL_CAPABILITY,
        toolIdentity,
      );

      if (activeSession === undefined) {
        if (isNativeCapabilityName) {
          return { block: true, reason: "tool-policy-unavailable" };
        }
        return undefined;
      }
      const generation = controller.getCurrentGeneration();
      if (activeSession.generationId !== generation?.id) {
        // A stale generation must never silently allow a governed call: the
        // activation this decision would be based on has already been
        // superseded (Spec 33 §7.2's generation-gate re-check applies here
        // exactly as it does after the async approval round-trip below).
        const isGovernanceRelevantStale =
          isNativeCapabilityName ||
          (activeSession.toolPolicy?.weaveOwned.includes(toolIdentity) ??
            false);
        if (isGovernanceRelevantStale) {
          return { block: true, reason: "tool-policy-generation-stale" };
        }
        return undefined;
      }
      const session = activeSession;
      const { permissionSession, toolPolicy } = session;

      if (toolPolicy === undefined) {
        if (isNativeCapabilityName) {
          return { block: true, reason: "tool-policy-unavailable" };
        }
        return undefined;
      }

      const isGovernanceRelevant =
        isNativeCapabilityName || toolPolicy.weaveOwned.includes(toolIdentity);
      if (!isGovernanceRelevant) return undefined;

      // Health-only for tool policy (coverage never activated a session this
      // generation, Spec 33 §21): block every governance-relevant name -
      // never fall back to allow just because governance is unavailable.
      if (permissionSession === undefined) {
        return { block: true, reason: "tool-policy-unavailable" };
      }

      // Overall health-only mode (Spec 33 §21) must disable approval,
      // regardless of why the adapter is health-only - even an unrelated
      // degraded/unsupported capability. A policy-allow call still needs no
      // UI and proceeds normally; only the approval-prompt path is
      // disabled, so an ask-policy call blocks via the existing
      // no-UI-available path rather than opening a dialog while the
      // adapter is otherwise degraded.
      const approvalUiAvailable =
        ctx.hasUI && generation !== undefined
          ? !effectiveHealthOnly(generation, session)
          : false;

      // Recheck authority at the tool boundary (Spec 33 §7.2): capture a
      // staleness handle before the async approval/interception round-trip
      // and assert it is still current afterward. A registry/generation
      // replacement mid-approval must never let a decision computed against
      // a superseded generation take effect.
      const handle = controller.beginOperation();
      if (handle.isErr()) {
        return { block: true, reason: "tool-policy-generation-stale" };
      }

      const agentName =
        session.primarySession.getCurrent()?.descriptor.name ??
        DEFAULT_PRIMARY_AGENT_NAME;
      // `deps.permissionBridge` is an injected dependency - its `intercept`
      // return type promises `ResultAsync<PiToolCallDecision,
      // PiAdapterFailure>`, but a hostile or misbehaving implementation
      // could still return a rejecting promise despite that contract. Wrap
      // the call explicitly rather than let a rejection escape this event
      // handler as an unhandled promise rejection - mapped to the same
      // closed `PiAdapterFailure` shape `intercept()` itself already uses
      // for a genuine internal failure, so there is exactly one downstream
      // error channel to check, not a folded-away one plus a separate
      // always-Ok convention.
      const result = await ResultAsync.fromPromise(
        deps.permissionBridge.intercept({
          session: permissionSession,
          plan: toolPolicy,
          project: ctx.cwd,
          controllerSession: session.generationId,
          agentName,
          toolIdentity,
          call: toolCallEvent.input,
          approvalUiAvailable,
          approvalUi: createParentUiApprovalPort(ctx),
          pi,
        }),
        () => "tool-policy-bridge-rejected",
      ).andThen((decision) => decision);

      if (handle.value.assertStillCurrent().isErr()) {
        return { block: true, reason: "tool-policy-generation-stale" };
      }

      // A genuine `intercept()` failure (rejection at either layer above)
      // blocks - a governance decision is never treated as an allow unless
      // a real decision came back.
      if (result.isErr()) {
        const failure =
          typeof result.error === "string"
            ? makeRequiredCapabilityUnavailableFailure(
                "tool-policy-mapping",
                result.error,
              )
            : result.error;
        deps.logger.warn(
          { code: failure.code },
          "permission bridge intercept failed unexpectedly; blocking",
        );
        return { block: true, reason: "tool-policy-intercept-failed" };
      }
      const outcome = result.value;

      if (outcome.kind === "block" || outcome.kind === "allow-unmanaged") {
        // A governance-relevant name that the bridge itself reports
        // `allow-unmanaged` indicates a plan/session mismatch (e.g. a
        // shadowed native tool) - never treat that as an allow here.
        return outcome.kind === "block"
          ? { block: true, reason: outcome.reason }
          : { block: true, reason: "tool-policy-unexpected-unmanaged" };
      }
      if (
        outcome.kind === "allow" &&
        typeof outcome.call === "object" &&
        outcome.call !== null
      ) {
        // Write back exactly the engine's consumed snapshot - never the
        // caller's own `call` object reference (Spec 34 §8: "Adapters MUST
        // execute only this value").
        for (const key of Object.keys(toolCallEvent.input)) {
          delete toolCallEvent.input[key];
        }
        Object.assign(
          toolCallEvent.input,
          outcome.call as Record<string, unknown>,
        );
      }
      return undefined;
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
      // (Spec 33 §9.2 "a native user model change governs the current
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
      // (Spec 33 §9.1) - refresh the catalog immediately before the
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
        // secrets (Spec 33 closed-failure contract).
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
          disabledSkills: session.disabledSkills,
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

      // Spec 33 §14: a primary activation that actually took authority this
      // generation (Loom/Tapestry becoming the active primary) is one of
      // the required `observeSession` trigger points, when a workflow lease
      // is presently active (e.g. Loom re-activating while a workflow is
      // paused). A no-op when no lease is tracked.
      await observeActiveLeaseBestEffort(descriptor.name, "active");

      return {
        systemPrompt: session.primarySession.appendToSystemPrompt(systemPrompt),
      };
    });

    // Spec 33 §19.4: one exact-once usage observation per settled primary
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
      // Spec 33 §14/§18: termination while a lease is active is a required
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
      delegationControllerCell.controller?.disposeAll();
      delegationControllerCell.controller = undefined;
      workflowControllerCell.controller = undefined;
      activeWorkflowInstanceCell.value = undefined;
      currentWorkflows = {};
      treeSelectionCell.selectedId = ROOT_NODE_ID;
      // Adapter telemetry cleanup (Spec 33 §19.3): records one best-effort
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
      // generation (Spec 33 §11.5/§23 cleanup-idempotence) - clear it even
      // though `disposeAll()` above already terminated every child.
      ctx?.ui.setWidget(WEAVE_CHILD_TREE_WIDGET_KEY, undefined);
      ctx?.ui.setWidget(WEAVE_PLAN_WIDGET_KEY, undefined);
      ctx?.ui.setEditorComponent?.(undefined);
      controller.shutdown();
      // Idempotent regardless of role: a no-op for an ordinary parent
      // session, and terminal secret/process cleanup for a private child.
      childModeState.runtime?.dispose();
    });
  };
}

export default createPiExtension();
