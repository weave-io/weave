import { join } from "node:path";
import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings as getHostKeybindings,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_RUNTIME_SETTINGS,
  type ThinkingLevelDecl,
} from "@weaveio/weave-core";
import type {
  AdapterCommandHandler,
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
  type ActivePlanReadPort,
  type ActivePlanUiError,
  type ActivePlanView,
  createActivePlanUiState,
} from "./active-plan-ui-state.js";
import {
  createPiAdapterCommandHandlers,
  createPiChildrenCommandPort,
  type PiAdapterChildrenPort,
  type PiAdapterDoctorPort,
} from "./adapter-cli-commands.js";
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
  type PiDelegationAuthorityReadiness,
  WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV,
} from "./capability-prober.js";
import {
  type ChildTurnEpoch,
  PiChildAbortSettlementGate,
} from "./child-compaction-settlement.js";
import {
  MAX_SETTLEMENT_OUTPUT_BYTES,
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
  createPiDoctorPort,
  createSkippedDoctorCheckPorts,
  createStoreBackedDoctorCheckPorts,
  doctorCapabilitiesFromProbes,
  failedDoctorCheck,
  type PiDoctorCheckPorts,
  passedDoctorCheck,
} from "./child-doctor.js";
import {
  BunEnvPort,
  buildDefaultPiChildCommand,
  sanitizedBaseEnv,
  WEAVE_CHILD_SECRET_ENV,
} from "./child-env.js";
import {
  CHILD_EXTENSION_SELECTION_KEY,
  decodeChildExtensionSelection,
  encodeChildExtensionSelection,
  PI_PREFERENCE_NAMESPACE,
} from "./child-extension-selection.js";
import { createChildInspectionCustomComponent } from "./child-inspection-custom.js";
import {
  createChildInspectionEditor,
  type PiChildInspectionEditor,
} from "./child-inspection-editor.js";
import type { PiChildInspectionRenderInput } from "./child-inspection-render.js";
import {
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
} from "./child-inspection-runtime.js";
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
import type { PiChildMetadataCache } from "./child-metadata-cache.js";
import type {
  PiNativeSessionEntryPage,
  PiNativeSessionEntryPageOptions,
  PiNativeSessionError,
  PiNativeSessionStore,
} from "./child-native-sessions.js";
import {
  type ChildOverlayChild,
  type ChildOverlayFallbackRequired,
  type ChildOverlayLiveStream,
  type ChildOverlayPlanContext,
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createChildOverlayLiveStream,
  createReadSessionEntryPageOverlaySource,
  mapPiDelegationFailureToOverlaySourceError,
  PI_CHILD_OVERLAY_CUSTOM_OPTIONS,
} from "./child-overlay.js";
import {
  formatPiChildOverlayFallbackDiagnostic,
  type PiChildOverlayFallbackReasonCode,
  piChildOverlayFallbackReasonCode,
  piChildOverlayOpenErrorReasonCode,
} from "./child-overlay-fallback-diagnostics.js";
import {
  captureChildOverlayKeybindings,
  childOverlayConflictPortFromHost,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  resolveChildOverlaySearchRoute,
} from "./child-overlay-keys.js";
import {
  buildChildPickerEntries,
  childPickerPreview,
  type PiChildPickerNode,
  sanitizeChildPickerPreview,
} from "./child-picker.js";
import {
  BunPiChildProcessPort,
  type PiChildProcessPort,
} from "./child-process-port.js";
import {
  type PiChildProviderError,
  projectAssistantProviderError,
} from "./child-provider-error.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import type {
  PiChildRecoveryRecord,
  PiChildRecoverySpawnInput,
} from "./child-recovery.js";
import { PiChildRecoveryCoordinator } from "./child-recovery.js";
import {
  type PiChildOutputError,
  type PiChildOutputPort,
  PiChildRuntime,
  type PiChildRuntimeError,
} from "./child-runtime.js";
import {
  clearChildReconstruction,
  countParentLocalChildren,
  createChildReconstructionCell,
  describeChildReconstructionError,
  mergeReconstructedHistoryRows,
  type PiChildReconstructionSummary,
  type PiHistoryRow,
  publishChildReconstruction,
  readChildReconstruction,
  reconstructParentLocalChildren,
  renderReconstructedStatusLines,
} from "./child-session-reconstruction.js";
import {
  createPiChildSessionStorageAuthority,
  type PiChildSessionStorageAuthority,
  provePiChildSessionRoot,
} from "./child-session-storage-authority.js";
import { SystemTimerPort, type TimerPort } from "./child-timer.js";
import {
  applyTreeControlKey,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantMessageId,
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
import type {
  CodexFastAttemptSink,
  CodexFastIntent,
  CodexFastIntentPort,
} from "./codex-fast/provider.js";
import {
  type CodexFastRegistrationDegradation,
  registerCodexFastProvider,
} from "./codex-fast/register.js";
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
  type PiOverlayChildDescriptor,
  type PiThreadRefPort,
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
  createGenerationSessionCtxCell,
  type PiChildRefEntryReadDegradation,
  PiGenerationResourceOwner,
  readSessionManagerEntries,
} from "./generation-resources.js";
import {
  BunHostPackageReader,
  type HostPackageReader,
  hostRuntimeHealthLineFromOutcome,
  renderHostCapabilityGapDiagnostic,
} from "./host-compatibility.js";
import {
  DefaultPiHostSurfaceReader,
  emptyHostSurfaceReport,
  type PiHostSurfaceReader,
  readValidatedCommands,
  safeReadHostSurfaceReport,
} from "./host-inventory.js";
import { getHostModuleOutcome } from "./host-module-loader.js";
import {
  PiModelActivator,
  type PiModelApplyPort,
  type PiModelResolution,
  PiModelResolver,
  type PiThinkingApplyPort,
} from "./model-resolution.js";
import { createBunPiNativeSessionFs } from "./native-session-fs.js";
import {
  BunPathContainmentPort,
  type PathContainmentPort,
} from "./path-containment.js";
import {
  createPiConfigComponent,
  type PiConfigKeybindingsPort,
  type PiConfigSaveError,
  type PiConfigSaveIntent,
  type PiConfigThemePort,
} from "./pi-config-ui.js";
import type {
  PiExtensionInventory,
  PiExtensionInventoryDegradation,
} from "./pi-extension-inventory.js";
import {
  type ChildExtensionArgsResolution,
  collectPiExtensionInventoryFromHost,
  resolveChildExtensionSpawnArgs,
} from "./pi-extension-inventory-port.js";
import {
  BunPiPlanCatalogPort,
  type PiPlanCatalogPort,
} from "./plan-catalog.js";
import { createPiPlanStateProvider } from "./plan-provider.js";
import {
  buildPlanRailFacts,
  type PlanRailFacts,
  renderPlanRailWidgetLines,
} from "./plan-render.js";
import {
  createPlanTaskListComponent,
  PI_PLAN_TASK_LIST_SHORTCUT,
  type PlanTaskListKeybindingsPort,
  type PlanTaskListThemePort,
} from "./plan-task-list.js";
import { safelyListAvailableModels } from "./port-safety.js";
import {
  DEFAULT_PRIMARY_AGENT_NAME,
  type PiPrimaryActivationError,
  PiPrimarySession,
  UNKNOWN_PARENT_SESSION,
} from "./primary-session.js";
import {
  PROMPT_CHUNK_COMMAND,
  PromptChunkAssembler,
  parsePromptChunk,
  promptTransferNackReason,
} from "./prompt-chunking.js";
import {
  classifyProviderFastIntent,
  type ProviderFastPublicSnapshot,
  projectCodexFastSnapshot,
} from "./provider-fast-activation.js";
import {
  activeInstanceFromRecoveryPointer,
  BunJsonlRecoveryPointerStore,
  isPointerEligibleForExplicitResume,
  type PiRecoveryPointerStore,
} from "./recovery-pointer.js";
import {
  createSessionMutationGate,
  findSessionMutationGap,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
} from "./required-capability-gate.js";
import type { PiChildPrivateOutputCapture } from "./rpc-child.js";
import {
  type PiRuntimeStoreFactory,
  SqliteRuntimeStoreFactory,
} from "./runtime-store-port.js";
import { PiSafeInitializer } from "./safe-initializer.js";
import {
  createSessionTransitionNoticeCell,
  createSessionTransitionRuntime,
} from "./session-transition-runtime.js";
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
  renderProviderFastStatusLine,
} from "./telemetry.js";
import {
  createProductionPiThreadSourceFactory,
  type PiThreadSourceFactory,
} from "./thread-sources.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiEnvPort,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiSkillInfo,
  PiTrustState,
} from "./types.js";
import { makePaint, plainPaint } from "./ui-paint.js";
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

type PiBootPrimaryActivationFailure =
  | { readonly type: "PrimaryDescriptorMissing"; readonly agentName: string }
  | {
      readonly type: "PrimarySkillCatalogUnavailable";
      readonly agentName: string;
    }
  | {
      readonly type: "PrimaryModelCatalogUnavailable";
      readonly agentName: string;
    }
  | { readonly type: "PrimaryActivationStale"; readonly agentName: string }
  | {
      readonly type: "PrimaryActivationFailed";
      readonly agentName: string;
      readonly cause: PiPrimaryActivationError;
    };

type PiPrimarySessionFailure =
  | PiPrimaryActivationError
  | PiBootPrimaryActivationFailure;

function renderPlanStartPrompt(planName: string): string {
  return `Execute the existing Weave plan at \`.weave/plans/${planName}.md\`. Begin with the first unchecked task and continue until every task is complete.`;
}

interface PiGenerationGuard {
  assertStillCurrent(): Result<void, PiAdapterFailure>;
}

export interface PiSharedLogRedirector {
  redirect(filePath: string): ResultAsync<void, PiAdapterFailure>;
}

/**
 * The inherit-all child-extension argv: no `--no-extensions` and no `-e`, so
 * a spawned child receives exactly the extensions it receives today.
 */
const EMPTY_CHILD_EXTENSION_ARGS: readonly string[] = Object.freeze([]);

const PI_SKILL_CATALOG_ERROR = "boot-skill-catalog-malformed" as const;
const PI_SKILL_CATALOG_START = "<available_skills>";
const PI_SKILL_CATALOG_END = "</available_skills>";
const MAX_PI_SYSTEM_PROMPT_CHARS = 4 * 1024 * 1024;
const MAX_PI_SKILL_COUNT = 2_048;
const MAX_PI_SKILL_NAME_CHARS = 256;
const MAX_PI_SKILL_DESCRIPTION_CHARS = 64 * 1024;
const MAX_PI_SKILL_LOCATION_CHARS = 16 * 1024;

type PiSkillCatalogParseError = typeof PI_SKILL_CATALOG_ERROR;

function decodePiSkillXml(
  value: string,
  maxChars: number,
): Result<string, PiSkillCatalogParseError> {
  if (value.length > maxChars || /&(?!(?:amp|apos|gt|lt|quot);)/u.test(value)) {
    return err(PI_SKILL_CATALOG_ERROR);
  }
  const entities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return ok(
    value.replace(
      /&(amp|apos|gt|lt|quot);/gu,
      (_match, entity: string) => entities[entity] ?? "",
    ),
  );
}

function findPiSkillCatalogStarts(systemPrompt: string): readonly number[] {
  const positions: number[] = [];
  let cursor = 0;
  while (cursor < systemPrompt.length) {
    const position = systemPrompt.indexOf(PI_SKILL_CATALOG_START, cursor);
    if (position === -1) break;
    const remainder = systemPrompt.slice(
      position + PI_SKILL_CATALOG_START.length,
    );
    if (/^[\t \r\n]*(?:<skill>|<\/available_skills>|$)/u.test(remainder)) {
      positions.push(position);
    }
    cursor = position + PI_SKILL_CATALOG_START.length;
  }
  return positions;
}

export function parsePiSkillsFromSystemPrompt(
  systemPrompt: string,
): Result<readonly PiSkillInfo[], PiSkillCatalogParseError> {
  if (systemPrompt.length > MAX_PI_SYSTEM_PROMPT_CHARS) {
    return err(PI_SKILL_CATALOG_ERROR);
  }

  const catalogStarts = findPiSkillCatalogStarts(systemPrompt);
  if (catalogStarts.length === 0) {
    return systemPrompt.includes(PI_SKILL_CATALOG_END)
      ? err(PI_SKILL_CATALOG_ERROR)
      : ok([]);
  }
  const catalogStart = catalogStarts[0];
  if (catalogStarts.length !== 1 || catalogStart === undefined) {
    return err(PI_SKILL_CATALOG_ERROR);
  }
  const catalogEnd = systemPrompt.indexOf(
    PI_SKILL_CATALOG_END,
    catalogStart + PI_SKILL_CATALOG_START.length,
  );
  if (
    catalogEnd === -1 ||
    systemPrompt.indexOf(
      PI_SKILL_CATALOG_END,
      catalogEnd + PI_SKILL_CATALOG_END.length,
    ) !== -1
  ) {
    return err(PI_SKILL_CATALOG_ERROR);
  }

  const bodyStart = catalogStart + PI_SKILL_CATALOG_START.length;
  const body = systemPrompt.slice(bodyStart, catalogEnd);
  const blockPattern =
    /<skill>\s*<name>([^<]*)<\/name>\s*<description>([^<]*)<\/description>\s*<location>([^<]*)<\/location>\s*<\/skill>/gu;
  const skills: PiSkillInfo[] = [];
  const names = new Set<string>();
  let cursor = 0;
  for (const block of body.matchAll(blockPattern)) {
    if ((block.index ?? -1) < cursor) return err(PI_SKILL_CATALOG_ERROR);
    if (body.slice(cursor, block.index).trim().length !== 0) {
      return err(PI_SKILL_CATALOG_ERROR);
    }
    if (skills.length >= MAX_PI_SKILL_COUNT) {
      return err(PI_SKILL_CATALOG_ERROR);
    }

    const name = decodePiSkillXml(block[1] ?? "", MAX_PI_SKILL_NAME_CHARS);
    const description = decodePiSkillXml(
      block[2] ?? "",
      MAX_PI_SKILL_DESCRIPTION_CHARS,
    );
    const filePath = decodePiSkillXml(
      block[3] ?? "",
      MAX_PI_SKILL_LOCATION_CHARS,
    );
    if (
      name.isErr() ||
      description.isErr() ||
      filePath.isErr() ||
      name.value.length === 0 ||
      filePath.value.length === 0 ||
      names.has(name.value)
    ) {
      return err(PI_SKILL_CATALOG_ERROR);
    }
    names.add(name.value);
    skills.push({ name: name.value, filePath: filePath.value });
    cursor = (block.index ?? 0) + block[0].length;
  }
  if (body.slice(cursor).trim().length !== 0) {
    return err(PI_SKILL_CATALOG_ERROR);
  }
  return ok(skills);
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
  /**
   * The host's process-wide keybindings manager, used only to inspect
   * existing bindings before registering overlay shortcuts. Production reads
   * Pi's public `getKeybindings()`; tests inject a modelled manager (or none,
   * to prove the fail-closed path).
   */
  readonly hostKeybindings?: () => unknown;
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
   * Test-only descriptor-safe host authority. Production omits this and the
   * controller keeps its fail-closed path-only-session default.
   */
  readonly sessionStorageAuthority?: PiChildSessionStorageAuthority;
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
  /**
   * Timer seam for the private child's bounded abort/compaction settlement
   * gate. Production uses `SystemTimerPort`; tests MUST override with a
   * deterministic fake so no regression depends on wall-clock delay.
   */
  readonly childTimerPort: TimerPort;
  /** Optional private inspector/history sink for complete child output. */
  readonly onChildPrivateOutput?: (
    childId: string,
    capture: PiChildPrivateOutputCapture,
  ) => Result<void, PiAdapterFailure> | ResultAsync<void, PiAdapterFailure>;
  /**
   * Opens the engine's Runtime Store (Pi adapter contract) - injected so no test
   * ever performs a real SQLite open/migration against a real (or
   * nonexistent, unwritable) path. Production wiring MUST use
   * `SqliteRuntimeStoreFactory`; tests MUST override with
   * `InMemoryRuntimeStoreFactory`/`FailingRuntimeStoreFactory`.
   */
  readonly runtimeStoreFactory: PiRuntimeStoreFactory;
  /**
   * Collects the host's extension inventory for `/weave:pi-config` - injected
   * so no test scans the developer's real `~/.pi/agent/extensions` directory.
   * Production wiring uses `collectPiExtensionInventoryFromHost`.
   */
  readonly piExtensionInventory?: (input: {
    readonly api: PiExtensionApi;
    readonly trust: PiTrustState;
    readonly cwd: string;
  }) => ResultAsync<PiExtensionInventory, PiExtensionInventoryDegradation>;
  /** Stable identity supplied by the host; unlike a generation ID it survives reload. */
  readonly parentSessionId?: (ctx: PiSessionContext) => string;
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
   * Adapter-local recovery-pointer seam. Absent means "append to the real
   * `.weave/runtime` JSONL file" (production default). Tests MUST override
   * with `InMemoryRecoveryPointerStore` or a failing fake, because the
   * startup banner and the read-only active-plan resolver both read this
   * store and a unit test may not touch a real filesystem.
   */
  readonly recoveryPointerStoreFactory?: (
    projectRoot: string,
  ) => PiRecoveryPointerStore;
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
  /**
   * Opens Task 4/5/6 thread sources for a persistent trusted generation.
   * Production wiring MUST use `createProductionPiThreadSourceFactory`.
   * Unit embeddings opt out by setting this to `undefined` so tests keep
   * legacy ephemeral start semantics without a real session host.
   */
  readonly threadSourceFactory: PiThreadSourceFactory | undefined;
  /**
   * Optional post-settlement response-drain budget forwarded to
   * `PiDelegationController`. Absent keeps the production default.
   * Tests that exercise session-transition cancellation set a short value
   * so they finish under the normal Bun timeout.
   */
  readonly childResponseDrainMs?: number;
  /**
   * Optional cancel-ack grace budget forwarded to
   * `PiDelegationController`. Absent keeps the production default.
   * Session-transition unit tests set a short value because fakes never
   * emit an authenticated `cancelled` ack.
   */
  readonly childCancelGraceMs?: number;
  /**
   * Host probes for the wrapped `openai-codex` provider registration
   * (`docs/specs/fast-provider-acceleration-contract.md`, OD-4). Production
   * reads Pi's own public `VERSION` export and dynamically imports pi-ai's
   * codex provider subpath; a test MUST override both, because neither the
   * installed host version nor the real provider module is a fact a unit test
   * may depend on. `pi.registerProvider` itself is never injected — it is read
   * from the host object the extension was handed, so the host-surface gate
   * stays real.
   */
  readonly codexFastProviderSeam: PiCodexFastProviderSeam;
}

/** The two injectable probes the codex-fast registration gate depends on. */
export interface PiCodexFastProviderSeam {
  /** The host's public `VERSION` export. */
  readonly readHostVersion: () => unknown;
  /** Dynamic import of `@earendil-works/pi-ai/providers/openai-codex`. */
  readonly importProviderModule: () => Promise<unknown>;
}

/**
 * Production probes. The specifier stays a literal so the bundler keeps the
 * peer dependency external instead of inlining a second copy of pi-ai, and the
 * import stays lazy so a host below the version floor never loads it at all.
 */
export const productionCodexFastProviderSeam: PiCodexFastProviderSeam =
  Object.freeze({
    readHostVersion: () =>
      (PiPublicExports as { readonly VERSION?: unknown }).VERSION,
    importProviderModule: (): Promise<unknown> =>
      import("@earendil-works/pi-ai/providers/openai-codex"),
  });

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
    hostPackageReader: new BunHostPackageReader({
      provenVersion: getHostModuleOutcome()?.hostVersion,
      onDuplicateDiagnostic: (diagnostic) => {
        log.warn(
          {
            type: diagnostic.type,
            importedVersion: diagnostic.importedVersion,
            provenVersion: diagnostic.provenVersion,
            mode: diagnostic.mode,
          },
          "host-runtime-duplicate",
        );
      },
    }),
    hostSurfaceReader: new DefaultPiHostSurfaceReader(),
    hostKeybindings: () => getHostKeybindings(),
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
    childTimerPort: new SystemTimerPort(),
    runtimeStoreFactory: new SqliteRuntimeStoreFactory(),
    pathContainmentPort: new BunPathContainmentPort(),
    planCatalogPort: new BunPiPlanCatalogPort(),
    threadSourceFactory: createProductionPiThreadSourceFactory(),
    codexFastProviderSeam: productionCodexFastProviderSeam,
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
 * Primary activation (skills + model, together) is committed during
 * `session_start` itself: the boot skill catalog comes from Pi's host-owned
 * system prompt (or the command-context snapshot when the host exposes one),
 * preserving Pi's own discovery, collision, trust, and package decisions.
 * Nothing else in the generation (ready status, active-agent badge, tool
 * registration, delegation transport) is granted until that single atomic
 * activation succeeds.
 * `before_agent_start` only appends the already committed prompt.
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
  primaryActivationFailure: PiPrimarySessionFailure | undefined;
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
  /** Literal provider-acceleration intent. Omission preserves the provider default. */
  readonly fast?: true;
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
/**
 * Resolves the concrete model identity and thinking intent a delegated agent
 * will run with. The delegation tool shows this before a child exists, so it
 * has to come from the same resolution the bootstrap will carry.
 */
export function resolveAgentRuntimeMeta(
  descriptorsByName: ReadonlyMap<string, AgentDescriptor>,
  agentName: string,
  ctx?: PiSessionContext,
): { readonly model?: string; readonly reasoningLevel?: string } {
  if (ctx === undefined) return {};
  const models = descriptorsByName.get(agentName)?.models ?? [];
  const availableModels = safelyListAvailableModels(ctx.modelRegistry).unwrapOr(
    [],
  );
  const resolution = new PiModelResolver().resolve(models, availableModels);
  if (resolution.resolved !== true) return {};
  return {
    ...(resolution.model.id === undefined
      ? {}
      : { model: resolution.model.id }),
    ...(resolution.thinkingLevel === undefined
      ? {}
      : { reasoningLevel: resolution.thinkingLevel }),
  };
}

/**
 * The generation-scoped primary-activation state the delegation tool needs to
 * decide, at call time, which agent is delegating and which targets it may
 * reach. Structural on purpose so the resolution rule can be tested without
 * constructing a whole Pi session.
 */
export interface PiDelegationInvocationSource {
  readonly generationId: string;
  /** The primary committed atomically during `session_start`. */
  readonly activeDescriptor: AgentDescriptor | undefined;
  /** The configured primary this generation intends to activate. */
  readonly pendingPrimaryName: string | undefined;
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>;
  readonly primaryActivationAttempted: boolean;
  readonly primaryActivationFailure: PiPrimarySessionFailure | undefined;
}

/**
 * Resolves the delegation tool's runtime invocation context.
 *
 * Primary activation normally commits before tool registration during
 * `session_start`. The pending-primary branch remains a fail-closed guard for
 * lifecycle transitions where Pi retains an older tool registration while a
 * replacement generation is still booting; it never widens authority to the
 * static union advertised by the tool schema.
 *
 * Fail-closed rules:
 * - A superseded (or unknown) generation never delegates. This is checked
 *   first, so even a committed active primary loses delegation authority the
 *   moment its generation is no longer current.
 * - Once `primaryActivationAttempted` is set, that attempt's outcome is
 *   authoritative: a missing active primary means activation failed or was
 *   declined, so the pending name must not resurrect delegation authority.
 *   A recorded `primaryActivationFailure` blocks the fallback for the same
 *   reason.
 * - The pending descriptor must exist, be eligible as a primary, and declare
 *   at least one delegation target.
 *
 * Once a primary is active, that descriptor stays authoritative regardless of
 * any earlier attempt or failure - but only within the current generation.
 */
export function resolveDelegationInvocationContext(
  source: PiDelegationInvocationSource | undefined,
  currentGenerationId: string | undefined,
):
  | {
      readonly parentAgentName: string;
      readonly targets: readonly DelegationTarget[];
    }
  | undefined {
  if (source === undefined) return undefined;

  if (
    currentGenerationId === undefined ||
    currentGenerationId !== source.generationId
  ) {
    return undefined;
  }

  const active = source.activeDescriptor;
  if (active !== undefined) {
    return { parentAgentName: active.name, targets: active.delegationTargets };
  }

  if (
    source.primaryActivationAttempted ||
    source.primaryActivationFailure !== undefined
  ) {
    return undefined;
  }

  const pendingName = source.pendingPrimaryName;
  if (pendingName === undefined) return undefined;
  const pending = source.descriptors.get(pendingName);
  if (pending === undefined || pending.mode === "subagent") return undefined;
  if (pending.delegationTargets.length === 0) return undefined;

  return {
    parentAgentName: pending.name,
    targets: pending.delegationTargets,
  };
}

/**
 * Synchronous, fail-closed agreement check for the delegation controller's
 * generation identity.
 *
 * A live controller belongs to exactly one generation. Session/generation
 * replacement must never let a prior generation's controller keep answering
 * `weave_delegate`, especially when the *new* generation is health-only or
 * trust-withheld and therefore constructs no controller at all. Delegation is
 * only permitted when all three views of "which generation is in charge" agree:
 * the controller the cell holds, the active session, and the runtime's own
 * current generation.
 *
 * Any undefined view means authority cannot be proven, so delegation is denied.
 */
export function delegationControllerGenerationsAgree(
  controllerGenerationId: string | undefined,
  activeSessionGenerationId: string | undefined,
  currentGenerationId: string | undefined,
): boolean {
  if (
    controllerGenerationId === undefined ||
    activeSessionGenerationId === undefined ||
    currentGenerationId === undefined
  ) {
    return false;
  }
  return (
    controllerGenerationId === activeSessionGenerationId &&
    controllerGenerationId === currentGenerationId
  );
}

/**
 * Minimal delegation-controller surface the overlay page reader needs.
 */
export interface PiOverlaySessionPageControllerPort {
  readonly resolveOverlayChild: (
    childId: string,
  ) => ResultAsync<PiOverlayChildDescriptor, PiAdapterFailure>;
}

/** Injected sources for {@link readOverlaySessionEntryPage}. */
export interface PiOverlaySessionPageDeps {
  /** Present only while a delegation controller owns this generation. */
  readonly controller: () => PiOverlaySessionPageControllerPort | undefined;
  /** Present only while native thread sources are open for this generation. */
  readonly sessions: () =>
    | Partial<Pick<PiNativeSessionStore, "readSessionEntryPage">>
    | undefined;
  /** Parent session id when the parent session is persistent. */
  readonly parentSessionId: () => string | undefined;
}

function unreadableSessionError(ref: string): PiNativeSessionError {
  return { type: "SessionCorrupt", ref, reason: "unreadable" };
}

/**
 * Reads one bounded native entry page for an overlay child.
 *
 * Exactly one failure here is a recoverable startup gap: a native
 * `SessionMissing` raised while reading a session ref the resolved child
 * already claims to own. Downstream that becomes `SourceStartupNotReady`, and
 * a live child opens on an empty live-tail page instead of borrowing the
 * primary editor.
 *
 * Every other condition is a wiring or integrity defect and stays fail-closed:
 * an absent controller, an unresolvable child, and absent session
 * infrastructure for a child that does have a session ref. A resolved child
 * with no session ref has nothing persisted to read, so it returns the empty
 * native page without consulting session infrastructure at all.
 */
/**
 * The parent session identity a persisted child session must be verified
 * against. A persisted session ref always belongs to a parent session, so an
 * absent expected parent is a wiring defect, never a licence to read a session
 * without checking its header. `undefined` here would make the native store
 * skip parent equality entirely, so the caller fails closed instead.
 */
function expectedParentSessionForChild(
  deps: PiOverlaySessionPageDeps,
): string | undefined {
  const live = deps.parentSessionId();
  if (live === undefined || live.length === 0) return undefined;
  return live;
}

export function readOverlaySessionEntryPage(
  deps: PiOverlaySessionPageDeps,
  childId: string,
  options: PiNativeSessionEntryPageOptions,
): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> {
  const controller = deps.controller();
  if (controller === undefined) {
    return errAsync(unreadableSessionError(childId));
  }
  return controller
    .resolveOverlayChild(childId)
    .mapErr(() => unreadableSessionError(childId))
    .andThen(
      (
        descriptor,
      ): ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError> => {
        const ref = descriptor.sessionRef;
        if (ref === undefined) {
          return okAsync({ entries: [], bytesRead: 0, linesScanned: 0 });
        }
        const sessions = deps.sessions();
        if (
          sessions === undefined ||
          typeof sessions.readSessionEntryPage !== "function"
        ) {
          return errAsync(unreadableSessionError(ref));
        }
        const expectedParent = expectedParentSessionForChild(deps);
        if (expectedParent === undefined) {
          // Fail closed: reading without an expected parent would skip the
          // header parent-equality check for a persisted session.
          return errAsync(unreadableSessionError(ref));
        }
        return sessions.readSessionEntryPage(ref, expectedParent, options);
      },
    );
}

function copyDelegationTargets(
  targets: readonly DelegationTarget[],
): DelegationTarget[] {
  return targets.map((target) => ({
    name: target.name,
    ...(target.description === undefined
      ? {}
      : { description: target.description }),
    triggers: [...target.triggers],
    isCategory: target.isCategory,
  }));
}

function copyBootstrapModels(models: readonly string[]): string[] {
  return [...models];
}

export function buildChildBootstrapBody(
  descriptorsByName: ReadonlyMap<string, AgentDescriptor>,
  target: DelegationTarget,
  childId: string,
  context: PiDelegationContext,
  ctx?: PiSessionContext,
  prepareComposedPrompt?: (descriptor: AgentDescriptor) => string,
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
    composedPrompt:
      full === undefined
        ? ""
        : (prepareComposedPrompt?.(full) ?? full.composedPrompt),
    models: copyBootstrapModels(full?.models ?? []),
    // Target catalogs can exceed one authenticated control body. The child
    // uses a generic relay tool; the parent authorizes every requested name
    // against this descriptor's full catalog.
    delegationTargets: [],
    correlationId: childId,
    context,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(full?.fast === true ? { fast: true as const } : {}),
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
    models: copyBootstrapModels(parsed.value.models),
    delegationTargets: copyDelegationTargets(
      parsed.value.delegationTargets ?? [],
    ),
    correlationId: parsed.value.correlationId,
    context: parsed.value.context,
    ...(parsed.value.resolvedModel === undefined
      ? {}
      : { resolvedModel: parsed.value.resolvedModel }),
    ...(parsed.value.fast === true ? { fast: true as const } : {}),
    ...(parsed.value.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: parsed.value.thinkingLevel }),
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
  /** Authenticated descriptor intent committed with the bootstrap state. */
  fast: true | undefined;
  /**
   * The model id this child actually runs on, committed with the bootstrap
   * state. It is the id of the model bootstrap really applied - the parent's
   * resolved identity, or this child's own catalog match - and stays
   * `undefined` when no override took effect, because an unproven model may
   * not be claimed as a fast owner's model.
   */
  resolvedModelId: string | undefined;
  /**
   * Incremented once per committed bootstrap. Provider hooks use it as this
   * child's intent generation, so an attempt cannot survive a re-bootstrap.
   */
  bootstrapGeneration: number;
  /** Defensive copy of the authenticated delegation policy committed with the bootstrap state. */
  delegationTargets: readonly DelegationTarget[];
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
   * Monotonic index of the turn the host is currently running, advanced by
   * every `turn_start`. It is the structural identity a captured verdict and a
   * compaction lifecycle event are correlated by.
   */
  turnEpoch: number;
  /**
   * The run `lastAssistantStopReason` was read from: the turn that was active
   * when the assistant message ended, plus the host's own id for it. A verdict
   * keeps this identity even when it is only reported (via `agent_settled`)
   * after a later turn already started.
   */
  lastAssistantEpoch: ChildTurnEpoch | undefined;
  /** Latest closed sanitized provider-error projection for this turn. */
  terminalError: PiChildProviderError | undefined;
  /**
   * Present only for a direct-step child (Pi adapter contract) - `undefined`
   * for every ordinary-delegation child. Drives `weave_complete_step`
   * registration and structured (not free-text) settlement reporting.
   */
  directStep: PiDirectStepChildState | undefined;
}

/**
 * The one committed owner of neutral fast intent for this process.
 *
 * Both fast seams read this single record, for different reasons: the hook
 * fallback classifies `intent` (the exact object the adapter committed), while
 * the wrapped provider needs the literal intent and the model it resolved to.
 * Deriving them together is what keeps a status line and a provider request
 * from ever describing two different owners.
 */
interface PiProviderFastOwner {
  /** The committed record whose own `fast` property declares intent. */
  readonly intent: unknown;
  /** Committed literal intent, read from this adapter's own typed state. */
  readonly fast: true | undefined;
  /** The owner's resolved model id, absent when none was proven. */
  readonly modelId: string | undefined;
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
    fast: undefined,
    resolvedModelId: undefined,
    bootstrapGeneration: 0,
    delegationTargets: [],
    promptAppended: false,
    bootstrapApplied: false,
    runtime: undefined,
    directStep: undefined,
    latestAssistantOutput: "",
    fullAssistantOutput: "",
    lastAssistantStopReason: undefined,
    turnEpoch: 0,
    lastAssistantEpoch: undefined,
    terminalError: undefined,
  };
}

function reportChildSettlement(
  runtime: PiChildRuntime,
  outcome: "completed" | "failed",
  detail: {
    assistantOutput?: string;
    completionCandidate?: string;
    completionCandidateTransferred?: boolean;
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
  // The child relay uses the authenticated parent as target authority. This
  // avoids forcing a potentially large target catalog through one envelope.
  const toolRegistrations = [
    buildRelayedDelegationToolRegistration({
      targets: parsed.delegationTargets,
      // A relayed child cannot observe the host's session-I/O contract
      // itself. Its parent already passed the gate before this child
      // existed, and the parent authorizes every relayed delegation
      // request, so the relay does not re-gate here.
      getRuntime: () => state.runtime,
      onCompactRenderFailure: (code) => {
        deps.logger.warn({ code }, "weave_delegate compact render failed");
      },
    }),
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
  state.fast = parsed.fast === true ? true : undefined;
  // The provider seam compares the request's model against the owner's own
  // resolved model, so the child records the identity it really applied.
  state.resolvedModelId =
    typeof appliedModel?.id === "string" ? appliedModel.id : undefined;
  state.delegationTargets = copyDelegationTargets(parsed.delegationTargets);
  state.bootstrapApplied = true;
  state.bootstrapGeneration += 1;
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
      completionCandidateTransferred?: boolean;
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

  /**
   * Bounded gate that keeps a compaction-intent local abort from becoming a
   * terminal failure. See `child-compaction-settlement.ts` for the observed
   * Pi 0.84 event order this models.
   */
  const abortGate = new PiChildAbortSettlementGate({
    timerPort: deps.childTimerPort,
    onExpire: (failure) => {
      // The deferred verdict is now terminal, so no late completion candidate
      // may still be recorded for it.
      if (state.directStep !== undefined) state.directStep.windowOpen = false;
      void reportSettlement("failed", { reason: failure.reason });
    },
  });

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
        onCancel: () => {
          // Cancellation is terminal, so it must close the compaction gate
          // BEFORE `cancelled` is published: a deferred or compacting gate
          // still holds an armed timer, and a timer that survived this point
          // would publish a second authenticated `settled` failure after the
          // parent already recorded the cancellation. `dispose()` is
          // synchronous, so no await can interleave between closing the gate
          // and reporting.
          abortGate.dispose();
          return runtime.reportCancelled().match(
            () => undefined,
            () => undefined,
          );
        },
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
    state.terminalError = undefined;
    // A new turn is a new epoch. Verdicts already captured keep the epoch they
    // were read in, which is what tells a pre-compaction abort apart from the
    // resumed run's own failure.
    state.turnEpoch += 1;
    // A turn that begins after a deferred abort is the resumed run the
    // compaction extension asked for - the only structural resumption
    // evidence Pi exposes. It hands the outcome back to the ordinary path.
    abortGate.observeTurnStart();
  });

  // The two structural compaction-lifecycle events. Their *existence* - not
  // any error prose - is what distinguishes a compaction-intent abort from a
  // genuine failure. Both are observed because `session_compact` is emitted
  // only when a compaction entry was actually saved, while
  // `session_before_compact` is emitted first and always.
  /**
   * The run a compaction lifecycle event was observed for: the turn now
   * running, refined by that turn's own last assistant message when one has
   * already ended. An assistant identity from an EARLIER turn is not adopted,
   * so evidence never claims a message it did not follow.
   */
  const compactionEpoch = (): ChildTurnEpoch =>
    state.lastAssistantEpoch !== undefined &&
    state.lastAssistantEpoch.turn === state.turnEpoch
      ? state.lastAssistantEpoch
      : { turn: state.turnEpoch, assistantMessageId: undefined };

  const observeCompaction = (): undefined => {
    abortGate.observeCompactionLifecycle(compactionEpoch());
    return undefined;
  };
  pi.on("session_before_compact", observeCompaction);
  pi.on("session_compact", observeCompaction);

  // By the time this fires the adapter's own shutdown handler (registered at
  // factory time, so always first) has already torn the child runtime down -
  // an envelope sent from here is rejected as `runtime not activated`. So the
  // gate only drops its armed timer; the parent's existing
  // exit-without-settlement classification owns that outcome.
  pi.on("session_shutdown", () => {
    abortGate.dispose();
    return undefined;
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
    if (stopReason !== undefined) {
      state.lastAssistantStopReason = stopReason;
      // The verdict and the run it belongs to are recorded together: they
      // describe the same assistant message.
      state.lastAssistantEpoch = {
        turn: state.turnEpoch,
        assistantMessageId: extractAssistantMessageId(record),
      };
    }
    const projectedError = projectAssistantProviderError(record.message);
    state.terminalError = projectedError.match(
      (projection) => projection,
      (absence) =>
        absence.type === "ProviderErrorCleared"
          ? undefined
          : state.terminalError,
    );
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
    if (
      state.lastAssistantStopReason === "error" ||
      state.lastAssistantStopReason === "aborted"
    ) {
      // A third-party compaction extension forces a threshold compaction by
      // aborting the run and then compacting from its own `agent_settled`
      // handler. Pi awaits extension handlers sequentially, so this handler
      // must return immediately: awaiting a grace period here would stop a
      // later-ordered `ctx.compact()` from ever running. The sanitized
      // verdict is captured now (it belongs to *this* turn) and published on
      // a bounded deferral unless compaction evidence arrives first.
      abortGate.observeAbortSettlement(
        {
          reason:
            state.lastAssistantStopReason === "error"
              ? formatPiChildProviderError(state.terminalError)
              : "assistant stop reason: aborted",
        },
        state.lastAssistantEpoch ?? {
          turn: state.turnEpoch,
          assistantMessageId: undefined,
        },
      );
      return;
    }
    // A genuine settlement always wins over any deferred abort verdict, so no
    // settlement is lost and none is ever reported twice.
    if (abortGate.admitSettlement().kind === "suppress") return;
    // Direct-step completion window closes the instant a settlement is
    // admitted (Pi adapter contract) - a tool call that races in afterward
    // must observe `windowOpen === false` and be rejected as late, never
    // recorded.
    if (state.directStep !== undefined) state.directStep.windowOpen = false;
    if (state.directStep !== undefined) {
      // A direct-step child's settlement is NEVER free-form prose (Pi adapter contract
      //): report the one recorded structured completion candidate as
      // JSON, or a specific typed failure reason - `missing`/`duplicate`/
      // `late`/`malformed:<msg>` - that `direct-dispatch.ts`'s
      // `interpretSettlement` parses on the parent side. Process exit or
      // prose is never success.
      const candidate = state.directStep.recorder.take();
      if (candidate !== undefined) {
        const serialized = serializeCompletionCandidate(candidate);
        const candidateBytes = new TextEncoder().encode(serialized).byteLength;
        if (candidateBytes > MAX_SETTLEMENT_OUTPUT_BYTES) {
          const transferred = await runtime.transferOutput(serialized);
          if (transferred.isErr()) {
            await reportSettlement("failed", {
              reason: `completion-transfer:${transferred.error.type}`,
            });
            return;
          }
          await reportSettlement("completed", {
            completionCandidateTransferred: true,
            outputTransferId: transferred.value.transferId,
            outputByteLength: transferred.value.byteLength,
          });
          return;
        }
        await reportSettlement("completed", {
          completionCandidate: serialized,
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
      // The bounded projection is not an authoritative result. Fail closed so
      // the parent never persists or reports a partial result as complete.
      await reportSettlement("failed", {
        reason: `output-transfer:${transferred.error.type}`,
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

/** Reads one string field from an event payload, or `undefined`. Never throws. */
function readStringField(event: unknown, field: string): string | undefined {
  const record = asJsonRecord(event);
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
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

/**
 * What one `/weave:pi-config` overlay reported when it closed.
 *
 * The overlay settles with exactly one of these and performs no I/O. The
 * command awaits the outcome and only then writes, so a save can never be a
 * detached promise racing the Runtime Store's close or a session restart, and
 * a stale generation can settle without writing anything at all.
 */
type PiConfigOverlayOutcome =
  | { readonly kind: "cancel" }
  | { readonly kind: "stale" }
  | { readonly kind: "save"; readonly intent: PiConfigSaveIntent }
  | { readonly kind: "rejected"; readonly error: PiConfigSaveError };

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
    case "weave:history":
      return "Show bounded cross-session Weave child history";
    case "weave:doctor":
      return "Run Weave Pi adapter diagnostics";
    case "weave:clear-children":
      return "Clear terminal Weave child history";
    case "weave:recover-children":
      return "Recover interrupted Weave children";
    case "weave:pi-config":
      return "Choose which Pi extensions Weave children load";
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

/**
 * Upper bound on rendered host-surface gap diagnostics, so a pathological
 * host cannot flood `/weave:health` output.
 */
const MAX_RENDERED_HOST_SURFACE_GAPS = 10;

function renderHealthMessage(
  controller: PiExtensionController,
  activeSession: PiActiveSession | undefined,
  bootActivationFailure: PiPrimarySessionFailure | undefined,
  /**
   * Bounded overlay diagnostics: key-binding conflicts and every
   * native-overlay fallback reason code recorded this generation. A proof run
   * reads the fallback cause from here.
   */
  overlayKeyDiagnostics: readonly string[] = [],
): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return bootActivationFailure === undefined
      ? "Weave has not completed activation yet."
      : `Weave adapter mode: unavailable\nprimary activation failed: ${bootActivationFailure.type}`;
  }
  const { healthReport } = generation.preflight;
  const lines = healthReport.effectiveCapabilities.map(
    (capability) =>
      `${capability.id}: ${capability.effectiveReadiness} (declared ${capability.declaredReadiness})`,
  );
  const mode = effectiveHealthOnly(generation) ? "health-only" : "ready";
  const result = [`Weave adapter mode: ${mode}`, ...lines];
  result.push(hostRuntimeHealthLineFromOutcome(getHostModuleOutcome()));

  for (const diagnostic of generation.preflight.hostSurfaceGapDiagnostics.slice(
    0,
    MAX_RENDERED_HOST_SURFACE_GAPS,
  )) {
    result.push(
      `host surface gap: ${renderHostCapabilityGapDiagnostic(diagnostic)}`,
    );
  }
  if (
    generation.preflight.hostSurfaceGapDiagnostics.length >
    MAX_RENDERED_HOST_SURFACE_GAPS
  ) {
    result.push(
      `host surface gaps omitted: ${generation.preflight.hostSurfaceGapDiagnostics.length - MAX_RENDERED_HOST_SURFACE_GAPS}`,
    );
  }
  result.push(
    `child inspection: ${generation.preflight.childInspectionFallback}`,
  );
  for (const diagnostic of overlayKeyDiagnostics.slice(
    0,
    PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics,
  )) {
    result.push(`overlay: ${diagnostic}`);
  }

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
  reconstructed?: PiChildReconstructionSummary | undefined,
  providerFastLatest?: ProviderFastPublicSnapshot,
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
  const fastLine = renderProviderFastStatusLine(providerFastLatest);
  if (fastLine.isOk() && fastLine.value !== undefined) {
    lines.push(fastLine.value);
  }
  const tree = delegationController?.snapshotTree() ?? [];
  // A returning source parent has an empty live tree but may still own
  // settled children in its own authoritative refs. Counting both is what
  // makes status survive a `/clone`, `/fork`, or `/tree` round trip.
  lines.push(`children: ${countParentLocalChildren(tree, reconstructed)}`);
  if (tree.length > 0 && delegationController !== undefined) {
    lines.push(
      ...renderChildTreeLines(
        tree,
        ROOT_NODE_ID,
        delegationController.snapshotCumulativeUsage(),
      ),
    );
  }
  lines.push(...renderReconstructedStatusLines(tree, reconstructed));
  return lines.join("\n");
}

const WEAVE_AGENT_STATUS_KEY = "weave-agent";
const WEAVE_CHILD_TREE_WIDGET_KEY = "weave-children";
const WEAVE_PLAN_WIDGET_KEY = "weave-plan";

/**
 * The non-widget fallback for agent identity.
 *
 * The Plan Rail owns ambient parent context wherever it can mount. This
 * status line exists only for the surfaces the rail cannot reach - a
 * non-interactive session, or a host without a usable widget slot - so the
 * selected agent is still stated somewhere. Whenever the rail is available it
 * is cleared, because two owners of the same identity is exactly the failure
 * the rail was built to end.
 */
function setActiveAgentStatusFallback(
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
 * Whether this session can mount the Plan Rail at all.
 *
 * Widgets are a TUI affordance; a headless or scripted session has no editor
 * to sit above, so it degrades to the status-line fallback rather than
 * mounting a surface nobody will see.
 */
function isPlanRailAvailable(ctx: PiSessionContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui.setWidget === "function";
}

function setWeaveUnavailableStatus(ctx: PiSessionContext): void {
  ctx.ui.setStatus("weave", "unavailable - run /weave:health for details");
}

function bootActivationSafeMessage(
  failure: PiBootPrimaryActivationFailure,
): string {
  switch (failure.type) {
    case "PrimaryDescriptorMissing":
      return `The default Weave primary agent (${failure.agentName}) is not configured.`;
    case "PrimarySkillCatalogUnavailable":
      return "Pi did not provide the skill catalog needed to load the default Weave primary agent.";
    case "PrimaryModelCatalogUnavailable":
      return "Pi did not provide the model catalog needed to load the default Weave primary agent.";
    case "PrimaryActivationStale":
      return "The Pi session changed before the default Weave primary agent finished loading.";
    case "PrimaryActivationFailed":
      return "The default Weave primary agent could not load during session startup.";
  }
}

/**
 * The narrow read port the direct-step badge decision needs: only the
 * *committed* primary this session actually holds. Deliberately exposes no
 * pending selection at all, so a pending name cannot be painted by mistake.
 */
export interface PiCommittedPrimaryReadPort {
  getCurrent(): { readonly descriptor: { readonly name: string } } | undefined;
}

/**
 * Resolves the exact badge name a direct-step activity change must paint.
 *
 * While a direct step is active the badge names that step's own agent. When
 * it ends, the badge falls back to the *committed* primary only: a merely
 * pending primary selection is never restored, because the badge names only
 * what Pi actually holds (`getCurrent()`), never what a session intends to
 * activate later.
 */
export function resolveDirectStepBadgeAgent(
  active: boolean,
  directStepAgentName: string | undefined,
  committedPrimary: PiCommittedPrimaryReadPort | undefined,
): string | undefined {
  if (active) return directStepAgentName;
  return committedPrimary?.getCurrent()?.descriptor.name;
}

/**
 * Builds the narrow read-only port the one active-plan resolver needs from a
 * workflow controller. `undefined` whenever this session has no controller at
 * all, which the caller renders as "nothing to show" rather than an error.
 *
 * `currentWorkflowInstanceId` is always the session's own authoritative tracker
 * state. Nothing else - not a lifecycle callback's argument, not a previously
 * painted identity - may name the workflow the UI resolves; when the tracker
 * holds nothing the resolver may fall back to an eligible recovery pointer.
 */
function buildActivePlanReadPort(
  controller: PiWorkflowController | undefined,
  currentWorkflowInstanceId: string | undefined,
): ActivePlanReadPort | undefined {
  if (controller === undefined) return undefined;
  return {
    currentWorkflowInstanceId,
    inspect: (workflowInstanceId) =>
      controller.inspect(workflowInstanceId).map((snapshot) => ({
        slug: snapshot.slug,
        status: snapshot.status as string,
      })),
    readPlanSnapshot: (planName) => controller.readPlanSnapshot(planName),
    readRecoveryPointer: () => controller.readRecoveryPointer(),
  };
}

/**
 * Mounts the Plan Rail above the editor from one agent identity and one
 * resolved plan view, so ambient parent context has exactly one owner.
 *
 * The rail is mounted as a component rather than as fixed lines because its
 * degradation ladder is *measured*: Pi calls `render(width)` with the real
 * viewport width on every resize, and the rail picks its tier from that
 * number instead of guessing at one.
 *
 * Two things are cleared here, always:
 *
 * - the fallback agent status, so identity is never stated twice; and
 * - the widget itself when there are no facts to show, which is what makes a
 *   completed, aborted, or unreadable plan with no active primary remove the
 *   surface exactly rather than freeze its last paint.
 */
function applyActivePlanSurfaces(
  ctx: PiSessionContext,
  facts: PlanRailFacts | undefined,
): void {
  if (!isPlanRailAvailable(ctx)) {
    // Remove the rail rather than leave one a previous interactive generation
    // mounted: a session that cannot repaint the rail must not keep showing
    // whatever it last said.
    ctx.ui.setWidget(WEAVE_PLAN_WIDGET_KEY, undefined, {
      placement: "aboveEditor",
    });
    setActiveAgentStatusFallback(ctx, facts?.agent);
    return;
  }
  const paint =
    ctx.ui.theme === undefined ? plainPaint() : makePaint(ctx.ui.theme);
  ctx.ui.setWidget(
    WEAVE_PLAN_WIDGET_KEY,
    facts === undefined
      ? undefined
      : () => ({
          render: (width: number) =>
            renderPlanRailWidgetLines(facts, width, paint),
          invalidate: () => undefined,
        }),
    { placement: "aboveEditor" },
  );
  // The rail is the single owner while it can mount. Clearing the fallback
  // unconditionally is what stops the agent name appearing in two places.
  setActiveAgentStatusFallback(ctx, undefined);
}

/**
 * Narrows one controller descriptor to the overlay's own bounded child shape.
 *
 * This is the source boundary: only path-free identity, run, and operational
 * facts cross it. `sessionRef` and every other storage identity stay behind
 * it by omission, and each optional fact is copied only when the controller
 * proved it, so an unknown reaches the inspector as an absence.
 */
function toChildOverlayDescriptor(
  descriptor: PiOverlayChildDescriptor,
): ChildOverlayChild {
  return {
    childId: descriptor.childId,
    threadId: descriptor.threadId,
    ...(descriptor.parentChildId === undefined
      ? {}
      : { parentChildId: descriptor.parentChildId }),
    status: descriptor.status,
    // The authoritative terminal verdict crosses only when the controller
    // proved one; an unknown outcome stays an absence.
    ...(descriptor.outcome === undefined
      ? {}
      : { outcome: descriptor.outcome }),
    title: descriptor.title,
    generationId: descriptor.generationId,
    runs: descriptor.runs.map((run) => ({
      run: run.run,
      action: run.action,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.priorOutcome === undefined
        ? {}
        : { priorOutcome: run.priorOutcome }),
      ...(run.initiator === undefined ? {} : { initiator: run.initiator }),
      ...(run.model === undefined ? {} : { model: run.model }),
      ...(run.reasoning === undefined ? {} : { reasoning: run.reasoning }),
    })),
    branchIds: [...descriptor.branchIds],
    descendantChildIds: [...descriptor.descendantChildIds],
    ...(descriptor.agentName === undefined
      ? {}
      : { agentName: descriptor.agentName }),
    ...(descriptor.parentAgentName === undefined
      ? {}
      : { parentAgentName: descriptor.parentAgentName }),
    ...(descriptor.role === undefined ? {} : { role: descriptor.role }),
    ...(descriptor.model === undefined ? {} : { model: descriptor.model }),
    ...(descriptor.reasoning === undefined
      ? {}
      : { reasoning: descriptor.reasoning }),
    ...(descriptor.assignment === undefined
      ? {}
      : { assignment: descriptor.assignment }),
    ...(descriptor.turn === undefined ? {} : { turn: descriptor.turn }),
    ...(descriptor.queueDepth === undefined
      ? {}
      : { queueDepth: descriptor.queueDepth }),
    ...(descriptor.elapsedMs === undefined
      ? {}
      : { elapsedMs: descriptor.elapsedMs }),
    ...(descriptor.usage === undefined
      ? {}
      : { usage: { ...descriptor.usage } }),
  };
}

/**
 * Projects the parent's own plan breadcrumb for the child inspector header.
 *
 * Reads only an already-resolved `ActivePlanView`, so it never starts a plan
 * lookup and can never disagree with the plan widget: an empty, failed, or
 * terminal resolution yields `undefined` and the header simply omits row 2.
 * The subtask is present only when the active task really is a child task.
 */
function readActivePlanBreadcrumb(
  view: ActivePlanView | undefined,
): ChildOverlayPlanContext | undefined {
  if (view === undefined || view.kind !== "active") return undefined;
  const task = view.activeTask;
  if (task === undefined) return { planName: view.planName };
  return {
    planName: view.planName,
    taskOrdinal: task.parentOrdinal,
    taskTotal: task.totalParentCount,
    taskTitle: task.parentTitle,
    ...(task.isChild ? { subtask: task.taskTitle } : {}),
  };
}

/**
 * Narrow projection of the `tui` object Pi injects into `ctx.ui.custom()`.
 * Only the two capabilities this read-only overlay needs are named:
 * re-render requests and the current terminal height.
 */
interface PiCustomOverlayTui {
  requestRender(): void;
  readonly terminal?: { readonly rows?: number };
}

type PiChildOverlayTui = TUI & PiCustomOverlayTui;

/** Reads the live terminal height, or `undefined` when the host has none. */
function overlayTerminalRows(tui: unknown): number | undefined {
  const rows = (tui as PiCustomOverlayTui | undefined)?.terminal?.rows;
  return typeof rows === "number" && Number.isFinite(rows) && rows > 0
    ? rows
    : undefined;
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
export type PiExtensionInstance = ((pi: PiExtensionApi) => void) & {
  readonly providerFastLatestForTest: () =>
    | ProviderFastPublicSnapshot
    | undefined;
};

export function createPiExtension(
  overrides: Partial<PiExtensionDeps> = {},
): PiExtensionInstance {
  const defaults = createDefaultPiExtensionDeps();
  const deps: PiExtensionDeps = {
    ...defaults,
    ...overrides,
    // A custom logger denotes an embedding/test-owned sink. Those embeddings
    // opt out of production Task 4/5/6 source opening (real XDG + SessionManager)
    // unless they explicitly pass `threadSourceFactory` (including `undefined`).
    ...(!("threadSourceFactory" in overrides) && overrides.logger !== undefined
      ? { threadSourceFactory: undefined }
      : {}),
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
  // The generation the held controller belongs to stays beside the instance
  // so replacement and authority checks can never drift apart.
  const delegationControllerCell = createDelegationControllerCell();
  /**
   * The single generation-scoped native-session authority (Spec 33 §5.6).
   *
   * It is built once per `session_start`, before preflight, from three real
   * facts: Pi's public `SessionManager`, the resolved Weave session root, and
   * the child process launch surface. The *same object* then feeds capability
   * probing, thread sources, the session store that mints launch grants, the
   * delegation controller, direct dispatch, and every `PiRpcChild`. Because
   * readiness and every launch consult one authority, a generation can no
   * longer report delegation ready while each spawn refuses.
   */
  const sessionAuthorityCell: {
    authority: PiChildSessionStorageAuthority | undefined;
  } = { authority: undefined };
  const readDelegationAuthorityReadiness =
    (): PiDelegationAuthorityReadiness => {
      const authority = sessionAuthorityCell.authority;
      if (authority === undefined) {
        return { status: "unavailable", reason: "pi-session-api-unavailable" };
      }
      const reason = authority.readinessReason();
      return reason === undefined
        ? { status: "ready" }
        : { status: "unavailable", reason };
    };
  const sessionTransitionNoticeCell = createSessionTransitionNoticeCell();
  /**
   * Generation-scoped thread sources: the parent ref store (Task 5), the
   * native child session store (Task 4), and the metadata cache (Task 6).
   *
   * They stay `undefined` until a host that can supply a no-follow session
   * filesystem and Pi's own session constructors is wired. The thread
   * lifecycle reads them through the controller and refuses to resume a
   * thread whose authoritative source it cannot read, so an unwired source
   * degrades to a structured refusal and never to an unverified resume.
   */
  const threadSourcesCell = createThreadSourcesCell();
  /**
   * Parent-local children reconstructed from the live parent's own
   * authoritative refs. A session transition revokes the delegation
   * controller, so a *returning* source parent starts with an empty live tree
   * even though it still owns settled children. This cell is what lets
   * `/weave:status` and `/weave:history` answer from bounded authoritative
   * data again, and it is generation- and parent-scoped so a clone/fork
   * destination can never read a source's children.
   */
  const childReconstructionCell = createChildReconstructionCell();
  /** Production sets true only after a successful required factory open. */
  let threadSourcesRequired = false;
  const recoveryCoordinatorCell: {
    coordinator: PiChildRecoveryCoordinator | undefined;
  } = { coordinator: undefined };
  // Bounded, live child-tree selection state (Pi adapter contract) - reset to the
  // root whenever a fresh generation activates.
  const treeSelectionCell = createChildTreeSelectionCell();
  const childInspectionEditorCell = createChildInspectionEditorCell();
  /** Generation-scoped native child overlay (Task 12). */
  const childOverlayCell = createChildOverlayCell();
  /**
   * Task 13 overlay-key registration. Raw keys are claimed exactly once, at
   * session activation, from the host's process-wide keybindings manager, so
   * registration never depends on Weave owning the primary editor; the
   * composed editor and overlay custom factories only re-offer their injected
   * manager when no host manager could be read.
   */
  const overlayKeysCell = createChildOverlayKeysCell();
  // One allocator lives for the extension instance, so editor replacement does
  // not renumber live children.
  const childSlots = new PiChildSlots();
  // Per-generation workflow controller (Pi adapter contract) - projects all ten
  // engine lifecycle operations. Constructed only when trusted and not
  // health-only, mirroring `delegationControllerCell`'s gating.
  const directStepChildRegistry = new PiDirectStepChildRegistry();
  const inspectionRegistryCell = createChildInspectionRegistryCell();
  const unavailableChildrenPort: PiAdapterChildrenPort = {
    list: () => okAsync({ children: [] }),
    show: () =>
      errAsync({
        type: "Unavailable",
        message: "native child stores are not ready",
      }),
    result: () =>
      errAsync({
        type: "Unavailable",
        message: "native child stores are not ready",
      }),
    resolve: () =>
      errAsync({
        type: "Unavailable",
        message: "native child stores are not ready",
      }),
    delete: () =>
      errAsync({
        type: "Unavailable",
        message: "native child stores are not ready",
      }),
  };
  const doctorCheckPortsCell: { ports: PiDoctorCheckPorts } = {
    ports: createSkippedDoctorCheckPorts("doctor source not wired"),
  };
  const doctorHealthOnlyCell: { value: boolean } = { value: false };
  const doctorPort: PiAdapterDoctorPort = createPiDoctorPort({
    ports: {
      capabilities: () => doctorCheckPortsCell.ports.capabilities(),
      permissions: () => doctorCheckPortsCell.ports.permissions(),
      sessions: () => doctorCheckPortsCell.ports.sessions(),
      refs: () => doctorCheckPortsCell.ports.refs(),
      cache: () => doctorCheckPortsCell.ports.cache(),
      stale: () => doctorCheckPortsCell.ports.stale(),
      orphans: () => doctorCheckPortsCell.ports.orphans(),
    },
    healthOnly: () => doctorHealthOnlyCell.value,
  });
  /**
   * The one required-capability gate every mutating route consults before it
   * reaches a delegation controller, session service, filesystem, metadata
   * cache, execution lease, or child process. It reads the live controller
   * generation, so it always reflects the current activation, and it fails
   * closed when no generation is active.
   */
  const sessionMutationGate = createSessionMutationGate(
    () =>
      controller.getCurrentGeneration()?.preflight.requiredCapabilityGaps ?? [
        {
          capabilityId: SESSION_MUTATION_REQUIRED_CAPABILITY,
          reason: "no-active-generation",
        },
      ],
  );
  const adapterCommandHandlersCell: {
    handlers: Readonly<Record<string, AdapterCommandHandler>>;
  } = {
    handlers: createPiAdapterCommandHandlers({
      children: unavailableChildrenPort,
      doctor: doctorPort,
      sessionMutationGate,
    }),
  };
  const refreshAdapterCommandHandlers = (
    children: PiAdapterChildrenPort,
  ): void => {
    adapterCommandHandlersCell.handlers = createPiAdapterCommandHandlers({
      children,
      doctor: doctorPort,
      sessionMutationGate,
    });
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
  const generationResourcesCell: {
    owner: PiGenerationResourceOwner | undefined;
  } = { owner: undefined };
  let currentWorkflows: Record<
    string,
    import("@weaveio/weave-engine").WorkflowExecutionContext["workflows"][string]
  > = {};
  let activeSession: PiActiveSession | undefined;
  /**
   * The reconstruction summary the *current* generation and *live* parent may
   * read. Everything else reads as absent, so a stale callback or a
   * clone/fork destination can never render another parent's children.
   */
  const currentChildReconstruction = ():
    | PiChildReconstructionSummary
    | undefined => {
    const parent = activeSession?.primarySession.getParentSession();
    const parentSessionId =
      parent?.persistence === "persistent" ? parent.sessionId : undefined;
    return readChildReconstruction(
      childReconstructionCell,
      activeSession?.generationId,
      parentSessionId,
    );
  };
  /**
   * Settlement handle for the Alt+T overlay that is currently mounted, if any.
   *
   * `ctx.ui.custom()` returns a promise that only settles when the component
   * calls `done()`. A generation guard that renders `[]` and ignores input is
   * therefore not enough on its own: replacement or shutdown would leave the
   * overlay mounted and its promise pending forever. This cell is the one
   * place that knows how to settle it, so lifecycle events can close it
   * exactly once without reaching into component internals.
   */
  const planTaskOverlayCell: { close: (() => void) | undefined } = {
    close: undefined,
  };

  /** Same single-settlement handle for the `/weave:pi-config` overlay. */
  const piConfigOverlayCell: { close: (() => void) | undefined } = {
    close: undefined,
  };

  /**
   * This generation's open Runtime Store, when the trusted project has one.
   *
   * `/weave:pi-config` writes a durable preference, so it needs the same store
   * the generation already opened rather than opening a second connection of
   * its own.
   */
  const runtimeStoreCell: { store: RuntimeStore | undefined } = {
    store: undefined,
  };

  /**
   * Closes the open Alt+T overlay if there is one. Idempotent by construction:
   * the handle is cleared before it is invoked, and each handle is itself
   * single-shot, so replacement, shutdown, a user cancel, and a stale callback
   * can all race without settling the same promise twice.
   */
  function closePlanTaskOverlay(): void {
    const close = planTaskOverlayCell.close;
    planTaskOverlayCell.close = undefined;
    close?.();
  }
  let lastBootActivationFailure: PiPrimarySessionFailure | undefined;
  let sessionStartSequence = 0;
  let primaryActivationTail: Promise<void> = Promise.resolve();
  const reservePrimaryActivation = (): {
    readonly waitForPrior: Promise<void>;
    readonly release: () => void;
  } => {
    const waitForPrior = primaryActivationTail;
    let release = (): void => undefined;
    primaryActivationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { waitForPrior, release };
  };
  /**
   * The most recent session context. Tool renderers run outside any call, so
   * naming a target's model needs a context the extension already holds.
   */
  let latestSessionCtx: PiSessionContext | undefined;
  /**
   * The owner whose committed neutral intent applies to this session: an
   * authenticated child bootstrap in child mode, otherwise the committed
   * primary of the current generation.
   *
   * `intent` is the record the hook-seam fallback classifies, kept as the very
   * object the adapter already committed so nothing is re-derived. `fast` and
   * `modelId` are read from this adapter's own typed state for the provider
   * seam, which needs both the literal intent and the model it resolved to.
   * There is exactly one ownership rule and it lives here, so the two seams
   * can never disagree about who is speaking.
   */
  const activeProviderFastIntentOwner = (): PiProviderFastOwner | undefined => {
    if (childModeState.active) {
      // Pending, unauthenticated, or failed bootstrap owns nothing. Intent
      // arrives only with the applied bootstrap state, so a child can never
      // accelerate a request before the parent authenticated it.
      if (
        !childModeState.bootstrapApplied ||
        childModeState.agentName.length === 0
      ) {
        return undefined;
      }
      return {
        intent: childModeState,
        fast: childModeState.fast,
        modelId: childModeState.resolvedModelId,
      };
    }
    const session = activeSession;
    const generation = controller.getCurrentGeneration();
    if (
      session === undefined ||
      generation === undefined ||
      session.generationId !== generation.id ||
      effectiveHealthOnly(generation)
    ) {
      return undefined;
    }
    const snapshot = session.primarySession.captureRequestSnapshot();
    if (snapshot === undefined) {
      return undefined;
    }
    return {
      intent: snapshot,
      fast: snapshot.fast === true ? true : undefined,
      modelId: snapshot.selectedModel?.id,
    };
  };

  /**
   * The latest state a correlated Codex attempt projected into the public
   * vocabulary, or `undefined` while this session has produced no mapped
   * attempt at all. It is session-scoped exactly like the telemetry dedupe
   * window, so a replaced session or a new primary never inherits it.
   */
  const codexFastLatestCell: {
    snapshot: ProviderFastPublicSnapshot | undefined;
  } = { snapshot: undefined };

  /**
   * The per-call intent the wrapped provider reads. It is a port rather than a
   * value because eligibility must reflect the owner at the moment of the
   * call: a primary switch, a session replacement, or a re-bootstrap between
   * two calls has to be visible to the second one.
   */
  const codexFastIntentPort: CodexFastIntentPort = {
    readIntent: (): CodexFastIntent | undefined => {
      const owner = activeProviderFastIntentOwner();
      if (owner === undefined) {
        return undefined;
      }
      return { fast: owner.fast, modelId: owner.modelId };
    },
  };

  /**
   * Where the wrapper's sanitized attempt states land. Three things happen and
   * nothing else: the snapshot passes the projection boundary, it becomes the
   * latest reportable state, and it is journaled once per distinct outcome.
   *
   * The journal write is deliberately not awaited and its failure is bounded
   * into a degradation record: this runs inside a live provider call, so a
   * slow or broken Runtime Store must never delay or fail a user's request.
   */
  const codexFastAttemptSink: CodexFastAttemptSink = {
    record: (snapshot): void => {
      const projected = projectCodexFastSnapshot(snapshot);
      if (projected === undefined) {
        return;
      }
      codexFastLatestCell.snapshot = projected;
      const telemetry = telemetryCell.telemetry;
      if (telemetry === undefined) {
        return;
      }
      void telemetry
        .recordProviderFastTransition(projected)
        .orElse((failure) => {
          telemetry.recordDegradation(failure);
          return okAsync(undefined);
        });
    },
  };

  /**
   * The sanitized acceleration state for this session.
   *
   * A correlated Codex attempt is the strongest evidence this adapter can
   * hold - it describes a request that really went out - so its latest state
   * wins. With no such attempt the hook-seam fallback answers instead: a
   * declaring owner reports the terminal unsupported outcome and an owner
   * without intent reports no state at all.
   */
  const resolveProviderFastState = ():
    | ProviderFastPublicSnapshot
    | undefined => {
    const resolve = Result.fromThrowable(
      (): ProviderFastPublicSnapshot | undefined => {
        const mapped = codexFastLatestCell.snapshot;
        if (mapped !== undefined) {
          return mapped;
        }
        const classified = classifyProviderFastIntent(
          activeProviderFastIntentOwner()?.intent,
        );
        return classified.kind === "unsupported"
          ? classified.snapshot
          : undefined;
      },
      () => undefined,
    );
    return resolve().unwrapOr(undefined);
  };

  /**
   * Persist the one bounded terminal outcome for a declaring owner. The
   * telemetry dedupe window keeps this to a single durable record per
   * state/reason, so repeated turns do not grow the journal.
   */
  const reportProviderFastIntent = (): void => {
    const snapshot = resolveProviderFastState();
    if (snapshot === undefined) {
      return;
    }
    const telemetry = telemetryCell.telemetry;
    if (telemetry === undefined) {
      return;
    }
    void telemetry.recordProviderFastTransition(snapshot).orElse((failure) => {
      telemetry.recordDegradation(failure);
      return okAsync(undefined);
    });
  };

  /**
   * Drop the in-memory reporting dedupe so a replaced session or a new
   * primary records its own terminal outcome, and drop the latest mapped
   * state with it: a snapshot describes one session's request and must not
   * outlive the session that produced it. Durable journal events stay as
   * bounded audit facts.
   */
  const resetProviderFastReporting = (): void => {
    codexFastLatestCell.snapshot = undefined;
    telemetryCell.telemetry?.resetProviderFastReporting();
  };

  /**
   * One process registers the wrapped provider at most once.
   *
   * The flag is claimed before the first await, so two startups racing (a
   * child session starting while a parent generation activates cannot happen,
   * but two `session_start` events can) still produce a single registration.
   * A `/reload` re-evaluates this module and therefore starts a new lifecycle
   * with a fresh cell; that is safe because the seam always wraps a newly
   * created native provider and never reads back whatever is registered now,
   * so no wrapper can ever wrap another wrapper.
   */
  const codexFastRegistrationCell: { attempted: boolean } = {
    attempted: false,
  };

  /**
   * Register the wrapped `openai-codex` provider for this process, once.
   *
   * Every failure is one bounded token: nothing is registered, the host keeps
   * its native provider, declared intent keeps reporting the hook seam's
   * `unsupported` / `harness-seam-unavailable`, and agent activation is
   * untouched. This is an optional capability and never a startup gate.
   */
  const ensureCodexFastProviderRegistered = async (
    pi: PiExtensionApi,
  ): Promise<void> => {
    if (codexFastRegistrationCell.attempted) {
      return;
    }
    codexFastRegistrationCell.attempted = true;
    const hostRegisterProvider = pi.registerProvider;
    const outcome = await registerCodexFastProvider({
      readHostVersion: deps.codexFastProviderSeam.readHostVersion,
      importProviderModule: deps.codexFastProviderSeam.importProviderModule,
      // Bound to the host object: a detached method would lose its receiver.
      // A host without the surface passes the raw value through, and the seam
      // reports `register-provider-unavailable` for it.
      registerProvider:
        typeof hostRegisterProvider === "function"
          ? (provider: unknown): void => {
              hostRegisterProvider.call(pi, provider);
            }
          : hostRegisterProvider,
      intentPort: codexFastIntentPort,
      attemptSink: codexFastAttemptSink,
    });
    outcome.match(
      (registered) => {
        deps.logger.info(
          { providerId: registered.providerId },
          "registered the Weave codex subscription fast provider",
        );
      },
      (failure: { readonly reason: CodexFastRegistrationDegradation }) => {
        deps.logger.warn(
          { reason: failure.reason },
          "codex subscription fast provider not registered; the host keeps its native provider",
        );
      },
    );
  };
  /**
   * The most recent session context *per generation*. Pi replaces
   * `ctx.sessionManager` across a session load, so a context captured at
   * `session_start` can stop reporting the parent's entries while the session
   * is still the same file. Long-lived readers therefore resolve the context
   * at call time, and only ever the one their own generation observed: a
   * retained closure from a replaced generation must never reach a newer
   * generation's manager.
   */
  const generationSessionCtxCell = createGenerationSessionCtxCell();
  /**
   * Records the context a public callback or command boundary was handed, so
   * the child-ref entry read follows the live session manager instead of the
   * one captured when the generation started.
   */
  const noteGenerationSessionCtx = (ctx: PiSessionContext): void => {
    const generationId = controller.getCurrentGeneration()?.id;
    if (generationId === undefined) return;
    generationSessionCtxCell.note(generationId, ctx);
  };
  let editorInstallCell:
    | {
        generationId: string;
        ctx: PiSessionContext;
        previousFactory: unknown;
        factory: unknown;
        /**
         * The session editor is a single, shared Pi surface. Another
         * extension (for example `pi-vim`'s modal editor) may own it, and
         * Weave's root-level child-tree keys are a convenience, not a
         * requirement. Once a foreign factory is observed, Weave yields the
         * session editor for the rest of the generation instead of
         * reasserting its own on every lifecycle event.
         */
        yielded: boolean;
      }
    | undefined;
  /**
   * Yields the session editor to a foreign owner, recording it as the factory
   * to hand back when a child-inspection view closes.
   */
  const yieldSessionEditor = (
    editorInstall: NonNullable<typeof editorInstallCell>,
    foreignFactory: unknown,
  ): void => {
    editorInstall.yielded = true;
    editorInstall.previousFactory = foreignFactory;
  };
  const ensureInspectionEditor = (
    ctx: PiSessionContext,
    generationId: string,
  ): void => {
    const editorInstall = editorInstallCell;
    if (editorInstall?.generationId !== generationId) return;
    if (editorInstall.yielded) return;
    const currentFactory = ctx.ui.getEditorComponent?.();
    if (currentFactory === editorInstall.factory) return;
    // Only Pi's own default (no installed factory) may be reclaimed. Anything
    // else belongs to another extension and must survive this turn.
    if (currentFactory !== undefined) {
      yieldSessionEditor(editorInstall, currentFactory);
      return;
    }
    editorInstall.previousFactory = currentFactory;
    ctx.ui.setEditorComponent?.(editorInstall.factory);
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
      // Probing reads the same authority object every launch path consumes.
      delegationAuthority: readDelegationAuthorityReadiness,
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
            sessionMutationGate,
            getInvocationContext: () =>
              resolveDelegationInvocationContext(
                activeSession === undefined
                  ? undefined
                  : {
                      generationId: activeSession.generationId,
                      activeDescriptor:
                        activeSession.primarySession.getCurrent()?.descriptor,
                      pendingPrimaryName: activeSession.pendingPrimaryName,
                      descriptors: activeSession.descriptors,
                      primaryActivationAttempted:
                        activeSession.primaryActivationAttempted,
                      primaryActivationFailure:
                        activeSession.primaryActivationFailure,
                    },
                controller.getCurrentGeneration()?.id,
              ),
            getController: () =>
              delegationControllerGenerationsAgree(
                delegationControllerCell.generationId,
                activeSession?.generationId,
                controller.getCurrentGeneration()?.id,
              )
                ? delegationControllerCell.controller
                : undefined,
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
                (descriptor) =>
                  activeSession?.primarySession.prepareComposedPrompt(
                    descriptor,
                    activeSession.disabledSkills,
                  ) ?? descriptor.composedPrompt,
              ),
            buildEnv: () => ({}),
            getParentSessionState: () =>
              activeSession?.primarySession.getParentSession() ??
              UNKNOWN_PARENT_SESSION,
            resolveAgentRuntime: (agentName) =>
              latestSessionCtx === undefined
                ? {}
                : resolveAgentRuntimeMeta(
                    activation.descriptors.byName,
                    agentName,
                    latestSessionCtx,
                  ),
            onCompactRenderFailure: (code) => {
              deps.logger.warn(
                { code },
                "weave_delegate compact render failed",
              );
            },
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

  /**
   * The one active-plan resolution/state path for this session.
   *
   * Widget, footer, and the Alt+T popup all read through this object, so they
   * resolve one identity and one `PlanTaskSnapshot` per repaint and cannot
   * retain different workflows across a current/recovery transition.
   */
  const activePlanUiState = createActivePlanUiState();

  /**
   * The whole of this session's ambient parent context, in one place.
   *
   * The Plan Rail shows the selected agent *and* the active plan together, so
   * neither half may be painted without the other. Holding both here means an
   * agent switch repaints the plan it belongs to, and a plan repaint keeps the
   * agent it was resolved under, instead of one surface blanking the other.
   */
  const parentContextCell: {
    agentName: string | undefined;
    view: ActivePlanView | undefined;
  } = { agentName: undefined, view: undefined };

  /**
   * Projects the retained parent context into the rail's closed fact type.
   * `undefined` whenever no Weave primary is active, which removes the rail.
   */
  function currentPlanRailFacts(): PlanRailFacts | undefined {
    const view = parentContextCell.view;
    const session = activeSession;
    return buildPlanRailFacts({
      agentName: parentContextCell.agentName,
      cycleCandidateCount:
        session === undefined
          ? 0
          : listCycleablePrimaryAgents(session.descriptors).length,
      snapshot: view?.kind === "active" ? view.snapshot : undefined,
      activeTask: view?.kind === "active" ? view.activeTask : undefined,
    });
  }

  /** Repaints the single parent-context surface from the retained facts. */
  function paintParentContext(ctx: PiSessionContext): void {
    applyActivePlanSurfaces(ctx, currentPlanRailFacts());
  }

  /**
   * Records the agent the rail must name and repaints.
   *
   * Callers resolve the name exactly as the badge always has - a direct step's
   * own agent while one is active, and otherwise only the *committed* primary
   * (`resolveDirectStepBadgeAgent`). A merely pending selection passes
   * `undefined`, so the rail never names authority the session does not hold.
   */
  function setActiveAgent(
    ctx: PiSessionContext,
    agentName: string | undefined,
  ): void {
    parentContextCell.agentName = agentName;
    paintParentContext(ctx);
  }

  /** Records the resolved plan view the rail must show and repaints. */
  function setActivePlanView(
    ctx: PiSessionContext,
    view: ActivePlanView | undefined,
  ): void {
    parentContextCell.view = view;
    paintParentContext(ctx);
  }

  /**
   * Resolves the active plan once and repaints both always-on surfaces from
   * that single result, returning the outcome for callers (Alt+T) that need to
   * say something about it.
   *
   * The identity comes only from authoritative state: this session's own
   * workflow tracker, or - when the tracker holds nothing - an eligible
   * recovery pointer. There is deliberately no way for a caller to pass in the
   * workflow to paint, so a lifecycle callback carrying a just-settled instance
   * cannot force a dead workflow back onto the screen.
   *
   * Read-only: it may surface an eligible recoverable plan, but it never
   * starts, resumes, or authorizes execution. Every empty or failed outcome
   * clears the retained identity and both surfaces first, so nothing stale can
   * survive a transition.
   */
  async function syncActivePlanSurfaces(
    ctx: PiSessionContext,
    authorityIsCurrent: () => boolean = () => true,
    allowRecoveryRerun = true,
  ): Promise<Result<ActivePlanView, ActivePlanUiError>> {
    if (!authorityIsCurrent()) {
      return ok({ kind: "empty", reason: "no-controller" });
    }
    const tracker = buildWorkflowTracker(ctx.cwd);
    const currentWorkflowInstanceId =
      tracker.getActiveInstance()?.workflowInstanceId;
    const port = buildActivePlanReadPort(
      workflowControllerCell.controller,
      currentWorkflowInstanceId,
    );
    if (port === undefined) {
      activePlanUiState.clear();
      setActivePlanView(ctx, undefined);
      return ok({ kind: "empty", reason: "no-controller" });
    }
    const resolution = await activePlanUiState.resolve(port);
    if (!authorityIsCurrent()) {
      return ok({ kind: "empty", reason: "no-controller" });
    }
    // Last request wins. Two repaints started in the same generation can
    // overlap (every caller is fire-and-forget), so an older lookup that
    // finishes after a newer one must paint nothing at all - not an empty
    // view, which would blank the surfaces the newer lookup just filled.
    if (resolution.isOk() && resolution.value.status === "superseded") {
      return ok({ kind: "empty", reason: "no-controller" });
    }
    // Same race, seen from the authoritative side: the identity this lookup
    // was started for must still be the one the session tracks. If the
    // tracker moved on (or picked up a workflow while this recovery-sourced
    // lookup was in flight), this result describes a workflow that is no
    // longer current and may neither paint nor clear anything.
    if (
      tracker.getActiveInstance()?.workflowInstanceId !==
      currentWorkflowInstanceId
    ) {
      return ok({ kind: "empty", reason: "no-controller" });
    }
    if (resolution.isErr()) {
      setActivePlanView(ctx, undefined);
      return err(resolution.error);
    }
    const view =
      resolution.value.status === "applied"
        ? resolution.value.view
        : ({ kind: "empty", reason: "no-controller" } as const);
    // A settled execution stops being this session's tracked instance the
    // moment the resolver observes the settlement, so the next repaint (and
    // every command that reads the tracker) starts from nothing rather than
    // from a workflow that can never advance again. Only the workflow this
    // lookup actually inspected may be cleared: the tracker was rechecked
    // above, so an older terminal result can never drop a newer workflow.
    if (
      view.kind === "empty" &&
      view.reason === "workflow-terminal" &&
      currentWorkflowInstanceId !== undefined
    ) {
      tracker.setActiveInstance(undefined);
    }
    // Recovery-sourced identity carries no tracker id, so the tracker recheck
    // above compares `undefined` with `undefined` and proves nothing: the
    // recovery pointer itself could have moved from workflow A to workflow B
    // while A's snapshot read was still pending. Confirm the pointer one last
    // time, through the same read-only port, before A's paint is final.
    if (view.kind === "active" && view.identity.source === "recovery") {
      const pointerState = await recheckRecoveryPointer(
        port,
        view.identity.workflowInstanceId,
      );
      // Ownership recheck. `resolve()` and `clear()` both drop the retained
      // view immediately, so a retained view that is still this exact object
      // is proof that no newer resolution took over during the await. If one
      // did, this result may neither paint nor clear.
      if (!authorityIsCurrent() || activePlanUiState.view() !== view) {
        return ok({ kind: "empty", reason: "no-controller" });
      }
      if (pointerState !== "confirmed") {
        clearActivePlanSurfaces(ctx);
        // The pointer now names a different eligible workflow. Resolve that
        // one instead, exactly once: the fresh resolution takes a newer token,
        // so last-request-wins still holds and the retry cannot recurse.
        if (pointerState === "changed" && allowRecoveryRerun) {
          return syncActivePlanSurfaces(ctx, authorityIsCurrent, false);
        }
        return ok({ kind: "empty", reason: "no-eligible-recovery-pointer" });
      }
    }
    setActivePlanView(ctx, view);
    return ok(view);
  }

  /**
   * Re-reads the recovery pointer through the read-only port and reports
   * whether it still names the workflow a completed resolution wants to paint.
   *
   * Read-only by construction: it reads one pointer and starts, resumes, and
   * acquires nothing. An unreadable pointer is reported as `gone` rather than
   * as an error, because the only safe response is to show nothing, and the
   * raw failure (which can carry a filesystem path) must not reach the UI.
   */
  async function recheckRecoveryPointer(
    port: ActivePlanReadPort,
    workflowInstanceId: string,
  ): Promise<"confirmed" | "changed" | "gone"> {
    const read = await port.readRecoveryPointer();
    if (read.isErr()) return "gone";
    const pointer = read.value;
    if (
      pointer === undefined ||
      pointer.workflowId === undefined ||
      !isPointerEligibleForExplicitResume(pointer)
    ) {
      return "gone";
    }
    return pointer.workflowId === workflowInstanceId ? "confirmed" : "changed";
  }

  /** Drops the retained active-plan identity and clears both surfaces. */
  function clearActivePlanSurfaces(ctx: PiSessionContext | undefined): void {
    activePlanUiState.clear();
    if (ctx !== undefined) setActivePlanView(ctx, undefined);
  }

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
    refs: PiThreadRefPort | undefined,
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
        // Answer text, else a canonical activity fact. Never chain-of-thought.
        preview: childPickerPreview(snapshot),
        live: true,
        currentTool: snapshot.currentTool,
        generationId,
        workflowInstanceId: registration.workflowInstanceId,
        stepName: registration.stepName,
      }),
    );
    // The parent session's child-ref ledger is the only durable source of
    // non-live children. It carries metadata only, so no preview text exists
    // for a child this generation never ran.
    const scan =
      refs === undefined
        ? ok(undefined)
        : await refs.readRefs().match(
            (value) => ok(value),
            () => err("refs unavailable" as const),
          );
    if (scan.isErr()) {
      ctx.ui.notify(
        "Child inspection is unavailable in this session.",
        "warning",
      );
      return;
    }
    const records = scan.value?.refs ?? [];
    const liveIds = new Set(live.map((node) => node.childId));
    const history = records
      .filter((record) => !liveIds.has(record.childId))
      .map((record): PiChildPickerNode => {
        const interrupted =
          (record.status === "running" || record.status === "queued") &&
          record.settledAt === undefined;
        return {
          childId: record.childId,
          name: record.title,
          kind: "ordinary",
          status: interrupted ? "interrupted" : "settled",
          preview: sanitizeChildPickerPreview(undefined),
          live: false,
          recoverable: interrupted,
          resumable: false,
        };
      });
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
      // Child refs are append-only observations in the parent session; there
      // is no adapter-owned copy to clear.
      if (activeSession?.generationId !== generationId) return;
      ctx.ui.notify("Child records are managed by Pi's session.", "info");
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
    // Command boundary: Pi hands every command a freshly built context, so
    // this is the newest session manager the generation has seen. Recording
    // it here keeps `/weave:inspect` reading live refs even when the context
    // captured at `session_start` has since been replaced.
    noteGenerationSessionCtx(ctx);
    if (name === "weave:recover-children" && activeSession === undefined) {
      ctx.ui.notify("Child recovery is unavailable in this session.", "info");
      return;
    }
    // Health is the one command that must remain available when boot failed
    // before a generation could retain authority. It reads diagnostics only.
    if (name === "weave:health") {
      ctx.ui.notify(
        renderHealthMessage(
          controller,
          activeSession,
          lastBootActivationFailure,
          overlayKeysCell.diagnostics,
        ),
        "info",
      );
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
    const commandSession = activeSession;
    const commandOwnsGeneration = (): boolean =>
      commandSession !== undefined && activeSession === commandSession;

    if (name === "weave:status") {
      ctx.ui.notify(
        renderStatusMessage(
          controller,
          activeSession,
          delegationControllerCell.controller,
          currentChildReconstruction(),
          resolveProviderFastState(),
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
        threadSourcesCell.refs,
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
    if (name === "weave:history") {
      const handlers = adapterCommandHandlersCell.handlers;
      if (handlers === undefined) {
        ctx.ui.notify("Child history is unavailable in this session.", "info");
        return;
      }
      const reconstructed = currentChildReconstruction();
      const listed = await handlers["children.list"]?.(
        JSON.stringify({
          workspaceKey: ctx.cwd,
          includeTombstoned: true,
        }),
      );
      if (listed === undefined || listed.isErr()) {
        ctx.ui.notify("Could not load bounded child history.", "warning");
        return;
      }
      const body = JSON.parse(listed.value) as {
        readonly children: readonly PiHistoryRow[];
        readonly nextCursor?: string;
      };
      // The metadata cache is derivative and generation-local. A returning
      // source parent merges its own authoritative parent-local refs in, so a
      // child settled before the transition is still listed. Cache rows win
      // on child id, and origin-mismatched refs were already excluded.
      const rows = mergeReconstructedHistoryRows(body.children, reconstructed);
      if (rows.length === 0) {
        ctx.ui.notify("No child history for this workspace.", "info");
        return;
      }
      const lines = rows.map(
        (row) =>
          `${row.childId}  ${row.status}${row.tombstoned ? " (tombstone)" : ""}  ${row.title}`,
      );
      if (body.nextCursor !== undefined) {
        lines.push(`next cursor: ${body.nextCursor}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }
    if (name === "weave:doctor") {
      const handlers = adapterCommandHandlersCell.handlers;
      const doctor = handlers?.["doctor"];
      if (doctor === undefined) {
        ctx.ui.notify("Doctor is unavailable in this session.", "info");
        return;
      }
      const report = await doctor(JSON.stringify({}));
      if (report.isErr()) {
        ctx.ui.notify(`Doctor failed: ${report.error.message}`, "warning");
        return;
      }
      const body = JSON.parse(report.value) as {
        readonly status: string;
        readonly checks: readonly {
          readonly id: string;
          readonly status: string;
          readonly detail?: string;
        }[];
      };
      const lines = [
        `Doctor status: ${body.status}`,
        ...body.checks.map(
          (check) =>
            `${check.id}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
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
    // Configuring the child's extension set depends on the Runtime Store and
    // the host's extension inventory, never on a workflow, so it is handled
    // before the workflow tracker and controller are required.
    if (name === "weave:pi-config") {
      await openPiConfig(pi, ctx);
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
      // The tracker is authoritative again the instant the command returns:
      // a successful start has an instance to paint, and a refused start
      // leaves nothing, which clears both surfaces.
      await syncActivePlanSurfaces(ctx, commandOwnsGeneration);
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
      // Both the "no active execution to abort" refusal and a successful
      // cancellation must end with nothing painted: the first because there
      // was never anything to show, the second because the tracker has just
      // been emptied.
      await syncActivePlanSurfaces(ctx, commandOwnsGeneration);
      return;
    }
    if (name === "weave:advance") {
      await handleWeaveAdvance(ctx.ui, workflowController, tracker);
      await syncActivePlanSurfaces(ctx, commandOwnsGeneration);
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
      await syncActivePlanSurfaces(ctx, commandOwnsGeneration);
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
      setActiveAgent(ctx, descriptor.name);
      return okAsync(undefined);
    }
    if (current === undefined && options.activateImmediately !== true) {
      session.pendingPrimaryName = descriptor.name;
      session.primaryActivationAttempted = false;
      session.primaryActivationFailure = undefined;
      // A pending selection is not a committed primary. This branch grants
      // no authority and paints no badge; a caller must request explicit
      // immediate activation before the selection can become active.
      setActiveAgent(ctx, undefined);
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

    const activationReservation = reservePrimaryActivation();
    return ResultAsync.fromPromise(
      activationReservation.waitForPrior,
      (): PiPrimarySwitchFailure => ({
        type: "PrimarySwitchGenerationStale",
      }),
    ).andThen(() => {
      if (
        activeSession !== session ||
        controller.getCurrentGeneration()?.id !== session.generationId
      ) {
        activationReservation.release();
        return errAsync<void, PiPrimarySwitchFailure>({
          type: "PrimarySwitchGenerationStale",
        });
      }
      const operation = controller.beginOperation();
      if (operation.isErr()) {
        activationReservation.release();
        return errAsync<void, PiPrimarySwitchFailure>({
          type: "PrimarySwitchGenerationStale",
        });
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
          resetProviderFastReporting();
          setActiveAgent(ctx, descriptor.name);
          return undefined;
        })
        .map((value) => {
          activationReservation.release();
          return value;
        })
        .mapErr((failure) => {
          activationReservation.release();
          return failure;
        });
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

  function activateBootPrimary(
    pi: PiExtensionApi,
    ctx: PiSessionContext,
    session: PiActiveSession,
  ): ResultAsync<void, PiBootPrimaryActivationFailure> {
    const agentName = session.pendingPrimaryName ?? DEFAULT_PRIMARY_AGENT_NAME;
    session.primaryActivationAttempted = true;

    const fail = (
      failure: PiBootPrimaryActivationFailure,
    ): ResultAsync<void, PiBootPrimaryActivationFailure> => {
      session.primaryActivationFailure = failure;
      return errAsync(failure);
    };

    const descriptor = session.descriptors.get(agentName);
    if (descriptor === undefined) {
      return fail({ type: "PrimaryDescriptorMissing", agentName });
    }

    const readSystemPromptOptions = ctx.getSystemPromptOptions;
    let skills: Result<readonly PiSkillInfo[], PiSkillCatalogParseError>;
    if (readSystemPromptOptions !== undefined) {
      skills = Result.fromThrowable(
        () => readSystemPromptOptions.call(ctx).skills ?? [],
        () => PI_SKILL_CATALOG_ERROR,
      )();
    } else if (ctx.getSystemPrompt !== undefined) {
      skills = Result.fromThrowable(
        () => ctx.getSystemPrompt?.() ?? "",
        () => PI_SKILL_CATALOG_ERROR,
      )().andThen(parsePiSkillsFromSystemPrompt);
    } else {
      skills = err(PI_SKILL_CATALOG_ERROR);
    }
    if (skills.isErr()) {
      return fail({ type: "PrimarySkillCatalogUnavailable", agentName });
    }

    const availableModels = safelyListAvailableModels(ctx.modelRegistry);
    if (availableModels.isErr()) {
      return fail({ type: "PrimaryModelCatalogUnavailable", agentName });
    }

    const operation = controller.beginOperation();
    if (operation.isErr()) {
      return fail({ type: "PrimaryActivationStale", agentName });
    }

    session.primarySession.refreshSkills(skills.value);
    return session.primarySession
      .activate(descriptor, {
        availableModels: availableModels.value,
        currentModel: ctx.model,
        modelApplier: createPiModelApplyPort(pi),
        thinkingApplier: createPiThinkingApplyPort(pi),
        disabledSkills: session.disabledSkills,
      })
      .mapErr((cause): PiBootPrimaryActivationFailure => {
        const failure: PiBootPrimaryActivationFailure = {
          type: "PrimaryActivationFailed",
          agentName,
          cause,
        };
        session.primaryActivationFailure = failure;
        return failure;
      })
      .andThen(() =>
        operation.value.assertStillCurrent().mapErr(
          (): PiBootPrimaryActivationFailure => ({
            type: "PrimaryActivationStale",
            agentName,
          }),
        ),
      )
      .map(() => {
        session.pendingPrimaryName = descriptor.name;
        session.primaryActivationFailure = undefined;
        return undefined;
      });
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

  /**
   * Opens the read-only Alt+T plan-task popup over the active durable
   * workflow's plan.
   *
   * Every outcome says something: no workflow, an unreadable plan, and a plan
   * with no tasks each produce their own message rather than an empty overlay.
   * The popup itself needs Pi's real custom-UI surface, so non-TUI sessions are
   * told that instead of silently doing nothing.
   */
  async function openPlanTaskList(ctx: PiSessionContext): Promise<void> {
    if (childModeState.active) return;
    const session = activeSession;
    const operation = controller.beginOperation();
    if (session === undefined || operation.isErr()) return;
    const authorityIsCurrent = (): boolean =>
      activeSession?.generationId === session.generationId &&
      operation.value.assertStillCurrent().isOk();
    // Exactly the resolution the widget and footer just used, through the same
    // state object, so the popup can never open on a different workflow.
    const resolved = await syncActivePlanSurfaces(ctx, authorityIsCurrent);
    if (!authorityIsCurrent()) return;
    if (resolved.isErr()) {
      ctx.ui.notify(resolved.error.safeMessage, "warning");
      return;
    }
    if (resolved.value.kind === "empty") {
      ctx.ui.notify(
        "No Weave workflow is active, so there is no plan to show.",
        "info",
      );
      return;
    }
    if (ctx.mode !== "tui" || ctx.ui.custom === undefined) {
      ctx.ui.notify("The Weave plan task list requires Pi TUI mode.", "info");
      return;
    }

    const snapshot = resolved.value.snapshot;
    if (!authorityIsCurrent()) return;
    // Opening replaces any overlay that is still mounted: the prior promise is
    // settled first, so at most one Alt+T overlay is ever outstanding.
    closePlanTaskOverlay();
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        const host = tui as PiCustomOverlayTui;
        let settled = false;
        // The single settlement path for this overlay. User cancel, a stale
        // callback, generation replacement, and shutdown all funnel through
        // it, and only the first caller ever reaches `done()`.
        const settle = (): void => {
          if (settled) return;
          settled = true;
          if (planTaskOverlayCell.close === settle) {
            planTaskOverlayCell.close = undefined;
          }
          done(undefined);
        };
        planTaskOverlayCell.close = settle;
        const component = createPlanTaskListComponent({
          snapshot,
          // Pi hands the live theme and keybindings to the factory; using them
          // (rather than importing globals) is what makes theme changes and
          // user keybinding configuration take effect here.
          theme: theme as PlanTaskListThemePort | undefined,
          keybindings: keybindings as PlanTaskListKeybindingsPort | undefined,
          getTerminalRows: () => overlayTerminalRows(tui),
          isCurrent: authorityIsCurrent,
          // A replaced generation must never act on a workflow, but the
          // overlay it left behind still has to close. Settling is the only
          // effect a stale generation is allowed to have here, and it is
          // single-shot, so a stale render cannot loop.
          onStale: settle,
          onCancel: settle,
          onChange: () => {
            host.requestRender?.();
          },
        });
        return {
          render: (width: number) => component.render(width),
          handleInput: (data: string) => {
            component.handleInput(data);
          },
          invalidate: () => {
            component.invalidate();
          },
        };
      },
      { overlay: true },
    );
  }

  /**
   * Persists one `/weave:pi-config` outcome.
   *
   * `inherit-all` removes the row rather than storing a record that says
   * "default": an absent row is what every other code path already treats as
   * the default, and keeping one representation avoids a second decode rule.
   */
  async function persistPiConfigIntent(
    store: RuntimeStore,
    intent: PiConfigSaveIntent,
  ): Promise<Result<void, "write-failed" | "encode-failed">> {
    if (intent.kind === "inherit-all") {
      const removed = await store.preferences.remove(
        PI_PREFERENCE_NAMESPACE,
        CHILD_EXTENSION_SELECTION_KEY,
      );
      return removed.isOk() ? ok(undefined) : err("write-failed" as const);
    }
    const encoded = encodeChildExtensionSelection(intent.record);
    if (encoded.isErr()) return err("encode-failed" as const);
    const written = await store.preferences.set(
      PI_PREFERENCE_NAMESPACE,
      CHILD_EXTENSION_SELECTION_KEY,
      encoded.value,
    );
    return written.isOk() ? ok(undefined) : err("write-failed" as const);
  }

  /**
   * Opens the `/weave:pi-config` overlay: which Pi extensions a Weave RPC
   * child loads.
   *
   * Every unavailable path says why rather than opening an empty overlay: a
   * non-TUI session, a session with no Runtime Store, and a generation that
   * has already been replaced each produce their own message. A degraded
   * inventory still opens, read-only, because an incomplete list saved as a
   * selection would read as "the user deselected everything missing".
   *
   * The selection deliberately does not affect this generation's already
   * resolved spawn arguments; the notice says so.
   */
  async function openPiConfig(
    pi: PiExtensionApi,
    ctx: PiSessionContext,
  ): Promise<void> {
    if (childModeState.active) return;
    const session = activeSession;
    const generation = controller.getCurrentGeneration();
    const operation = controller.beginOperation();
    if (
      session === undefined ||
      generation === undefined ||
      session.generationId !== generation.id ||
      operation.isErr()
    ) {
      ctx.ui.notify(
        "Weave child-extension configuration is unavailable in this session.",
        "info",
      );
      return;
    }
    const handle = operation.value;
    const authorityIsCurrent = (): boolean =>
      activeSession?.generationId === session.generationId &&
      handle.assertStillCurrent().isOk();

    if (ctx.mode !== "tui" || ctx.ui.custom === undefined) {
      ctx.ui.notify(
        "Weave child-extension configuration requires Pi TUI mode.",
        "info",
      );
      return;
    }
    const store = runtimeStoreCell.store;
    if (store === undefined) {
      ctx.ui.notify(
        "The Weave Runtime Store is unavailable in this session, so the child-extension selection cannot be read or changed.",
        "warning",
      );
      return;
    }

    const stored = await store.preferences.get(
      PI_PREFERENCE_NAMESPACE,
      CHILD_EXTENSION_SELECTION_KEY,
    );
    if (!authorityIsCurrent()) return;
    if (stored.isErr()) {
      ctx.ui.notify(
        "Could not read the stored Weave child-extension selection.",
        "warning",
      );
      return;
    }
    const decoded = decodeChildExtensionSelection(stored.value?.valueJson);

    // Exactly the collection the spawn path uses, so the overlay can never
    // offer an extension a child could not actually load.
    const collect =
      deps.piExtensionInventory ??
      ((input: {
        readonly api: PiExtensionApi;
        readonly trust: PiTrustState;
        readonly cwd: string;
      }) =>
        collectPiExtensionInventoryFromHost({
          api: input.api,
          rootExports: PiPublicExports as unknown as Readonly<
            Record<string, unknown>
          >,
          trust: input.trust,
          cwd: input.cwd,
        }));
    const collected = await collect({
      api: pi,
      trust: generation.preflight.trust,
      cwd: ctx.cwd,
    }).match(
      (inventory) => ({ inventory, degraded: false }),
      (degradation) => ({ inventory: degradation.inventory, degraded: true }),
    );
    if (!authorityIsCurrent()) return;
    const readOnly = collected.degraded || collected.inventory.truncated;

    // Opening replaces any overlay still mounted: the prior promise settles
    // first, so at most one pi-config overlay is ever outstanding.
    const previous = piConfigOverlayCell.close;
    piConfigOverlayCell.close = undefined;
    previous?.();

    // The overlay reports an outcome; it never performs the write itself. The
    // command owns persistence so the write cannot outlive this handler and
    // race the store's close or a session restart.
    const outcome = await ctx.ui.custom<PiConfigOverlayOutcome | undefined>(
      (tui, theme, keybindings, done) => {
        const host = tui as PiCustomOverlayTui;
        let settled = false;
        let ownsCell = false;
        // The single settlement path: save, cancel, a refused payload, a stale
        // generation, and replacement all funnel through it, and only the
        // first caller ever reaches `done()`.
        const settle = (result: PiConfigOverlayOutcome): void => {
          if (settled) return;
          settled = true;
          if (ownsCell) {
            ownsCell = false;
            piConfigOverlayCell.close = undefined;
          }
          done(result);
        };
        // Replacement and a stale generation are the same outcome: settle, and
        // never write on behalf of an authority that no longer holds.
        const settleStale = (): void => {
          settle({ kind: "stale" });
        };
        piConfigOverlayCell.close = settleStale;
        ownsCell = true;
        const component = createPiConfigComponent({
          entries: collected.inventory.entries,
          record: decoded.record,
          ...(readOnly ? { readOnly: true } : {}),
          theme: theme as PiConfigThemePort | undefined,
          keybindings: keybindings as PiConfigKeybindingsPort | undefined,
          getTerminalRows: () => overlayTerminalRows(tui),
          isCurrent: authorityIsCurrent,
          onStale: settleStale,
          onCancel: () => {
            settle({ kind: "cancel" });
          },
          onRejected: (rejection) => {
            settle({ kind: "rejected", error: rejection });
          },
          onSave: (intent) => {
            settle({ kind: "save", intent });
          },
          onChange: () => {
            host.requestRender?.();
          },
        });
        return {
          render: (width: number) => component.render(width),
          handleInput: (data: string) => {
            component.handleInput(data);
          },
          invalidate: () => {
            component.invalidate();
          },
        };
      },
      { overlay: true },
    );

    // A host that resolves without an outcome is treated as a replaced
    // overlay: settled, silent, and never a write.
    if (outcome === undefined || outcome.kind === "stale") return;
    if (outcome.kind === "rejected") {
      deps.logger.warn(
        { reason: outcome.error.reason },
        "pi-config save payload rejected",
      );
      if (!authorityIsCurrent()) return;
      ctx.ui.notify(
        "Weave could not save that child-extension selection.",
        "warning",
      );
      return;
    }
    if (outcome.kind === "cancel") {
      if (!authorityIsCurrent()) return;
      ctx.ui.notify("Weave child-extension selection unchanged.", "info");
      return;
    }
    // A generation replaced while the overlay was open may settle, but its
    // stale selection must never reach the store.
    if (!authorityIsCurrent()) return;
    const intent = outcome.intent;
    const written = await persistPiConfigIntent(store, intent);
    if (!authorityIsCurrent()) return;
    if (written.isErr()) {
      ctx.ui.notify(
        "Weave could not save the child-extension selection.",
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      intent.kind === "inherit-all"
        ? "Weave children will inherit every Pi extension again. This applies to children spawned after this session's next start, never to running children."
        : `Weave children will load ${intent.record.entries.length} selected extension${intent.record.entries.length === 1 ? "" : "s"} plus Weave. This applies to children spawned after this session's next start, never to running children.`,
      "info",
    );
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

  const childInspectionRuntime = createChildInspectionRuntime({
    overlayCell: childOverlayCell,
    overlayKeysCell,
    inspectionEditorCell: childInspectionEditorCell,
    inspectionRegistryCell,
    treeSelectionCell,
    threadSourcesCell,
    delegationControllerCell,
    latestSessionCtx: () => latestSessionCtx,
    activeGenerationId: () => activeSession?.generationId,
    parentSessionState: () => {
      const state = activeSession?.primarySession.getParentSession();
      if (state === undefined) {
        return { persistence: "unknown", sessionId: "" };
      }
      if (state.persistence === "persistent") {
        return {
          persistence: state.persistence,
          sessionId: state.sessionId,
        };
      }
      return { persistence: state.persistence, sessionId: "" };
    },
    childInspectionSettings: (generationId) => {
      const generation = controller.getCurrentGeneration();
      return generation?.id === generationId
        ? generation.preflight.childInspection.settings
        : undefined;
    },
    closeOverlay: () => closeChildOverlay(childOverlayCell, overlayKeysCell),
    // Ownership-independent conflict source. Pi's process-wide keybindings
    // manager is public, so overlay shortcuts no longer require Weave's
    // composed editor factory to run - which it never does when another
    // extension such as `pi-vim` owns the primary editor.
    ...(deps.hostKeybindings === undefined
      ? {}
      : { hostKeybindings: deps.hostKeybindings }),
  });

  const sessionTransitionRuntime = createSessionTransitionRuntime({
    noticeCell: sessionTransitionNoticeCell,
    delegationControllerCell,
    threadSourcesCell,
    treeSelectionCell,
    inspectionRegistryCell,
    childOverlayCell,
    overlayKeysCell,
    workflowControllerCell,
    activeWorkflowInstanceCell,
    recoveryCoordinatorCell,
    planStateProviderCell,
    telemetryCell,
    generationResourcesCell,
    bumpSessionStartSequence: () => {
      sessionStartSequence += 1;
    },
    closePlanTaskOverlay,
    shutdownExtensionController: () => {
      resetProviderFastReporting();
      controller.shutdown();
    },
    clearBootActivationFailure: () => {
      lastBootActivationFailure = undefined;
    },
    takeActiveSession: () => {
      const session = activeSession;
      activeSession = undefined;
      if (session === undefined) return undefined;
      return {
        primaryAgentName: session.primarySession.getCurrent()?.descriptor.name,
      };
    },
    setThreadSourcesRequired: (required) => {
      threadSourcesRequired = required;
    },
    clearCurrentWorkflows: () => {
      currentWorkflows = {};
    },
    cancelDirectStep: () =>
      directStepChildRegistry.cancel() ?? okAsync(undefined),
    clearActivePlanSurfaces,
    restoreEditor: () => {
      const editorInstall = editorInstallCell;
      if (editorInstall !== undefined) {
        if (
          editorInstall.ctx.ui.getEditorComponent?.() === editorInstall.factory
        ) {
          editorInstall.ctx.ui.setEditorComponent?.(
            editorInstall.previousFactory,
          );
        }
        editorInstallCell = undefined;
      }
    },
    disposeChildMode: () => {
      childModeState.runtime?.dispose();
    },
    warnObserveFailure: (failure) => {
      deps.logger.warn({ failure }, "observeSession failed; degrading");
    },
  });

  const piAdapterExtension = function piAdapterExtension(
    pi: PiExtensionApi,
  ): void {
    pi.registerShortcut?.(PI_PRIMARY_AGENT_CYCLE_SHORTCUT, {
      description: "Cycle Weave primary agent",
      handler: async (ctx: PiSessionContext) => {
        await cyclePrimaryAgent(pi, ctx);
      },
    });

    // Read-only companion to the always-on compact plan widget: the widget is
    // deliberately tiny, so Alt+T is where the whole plan can be read. It never
    // mutates a workflow, never resumes anything, and is unavailable in child
    // mode, where the session belongs to the parent's dispatch rather than the
    // user.
    pi.registerShortcut?.(PI_PLAN_TASK_LIST_SHORTCUT, {
      description: "Show Weave plan tasks",
      handler: async (ctx: PiSessionContext) => {
        await openPlanTaskList(ctx);
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

    // No provider request or header hook is registered. Pi cannot bind a
    // transport proof or a response proof to one prepared request, so the
    // adapter sends no acceleration control and leaves every provider payload
    // and header exactly as other handlers left it.
    //
    // A settled turn is the point where the session's committed intent is
    // known and stable, so the bounded terminal unsupported outcome is
    // recorded here. Telemetry dedupes it to one durable record.
    pi.on("agent_settled", () => {
      reportProviderFastIntent();
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
      latestSessionCtx = ctx;
      resetProviderFastReporting();
      // Revoke the prior generation synchronously, before the first await.
      // Overlays settle first, then the startup sequence bumps, then every
      // live authority cell is dropped so a retained tool registration or
      // late callback cannot outlive the replaced generation - even if this
      // new startup later fails. A fresh destination starts with no
      // old-child notice.
      sessionTransitionRuntime.revokeForReplacement((prior) => {
        (prior as PiDelegationController).disposeAll();
      });
      const startupSequence = sessionStartSequence;
      const startupStillCurrent = (): boolean =>
        sessionStartSequence === startupSequence;
      ctx.ui.setStatus("weave", "starting");

      // First statement of the generation, before log redirect, child-mode
      // activation, command validation, preflight, config activation, tool
      // registration, and every early return below. Any of those can end this
      // handler without ever reaching the render path, and the previous
      // generation's identity and painted surfaces would otherwise survive
      // into a session that has no controller to back them.
      clearActivePlanSurfaces(ctx);
      // The active-agent badge is generation-scoped exactly like those
      // surfaces. A prior generation may have committed a primary and
      // painted its name; nothing in *this* generation is committed yet, so
      // the badge starts hidden and is only repainted once this generation's
      // boot activation commits. Clearing here - ahead of child-mode
      // activation, command validation, preflight, config
      // activation and every early return - is what stops a stale badge from
      // outliving the session that earned it. Child sessions have painted
      // nothing at this point, so this is a no-op for them.
      setActiveAgent(ctx, undefined);
      if (ctx.mode === "tui" && shouldRedirectSharedLogs) {
        const redirected = await deps.logRedirector.redirect(
          join(ctx.cwd, PI_SHARED_LOG_PATH),
        );
        if (!startupStillCurrent()) return;
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
      if (!startupStillCurrent()) {
        childModeState.runtime?.dispose();
        return;
      }
      if (isChild) {
        // Both child shapes - an ordinary delegated child and a direct
        // workflow step - run this same extension, and both receive their
        // `fast` intent later, through the authenticated bootstrap. The
        // provider is therefore registered as soon as the handshake proved
        // this process is a real Weave child; until bootstrap applies, the
        // intent port reports no owner and every request passes through
        // untouched. A failed handshake registers nothing.
        if (childModeState.childId.length > 0) {
          await ensureCodexFastProviderRegistered(pi);
        }
        return;
      }
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
      if (!startupStillCurrent()) return;
      // Built before preflight so capability probing, and every later launch
      // consumer, share one authority. The root is *proven* here, once, by
      // really opening it no-follow through the production filesystem port;
      // the raw violation never leaves `provePiChildSessionRoot`.
      const injectedAuthority = deps.sessionStorageAuthority;
      const sessionRootProof =
        injectedAuthority === undefined
          ? await provePiChildSessionRoot({
              env: {
                XDG_DATA_HOME: deps.envPort.read("XDG_DATA_HOME"),
                HOME: deps.envPort.read("HOME"),
              },
              fs: createBunPiNativeSessionFs(),
            }).unwrapOr(undefined)
          : undefined;
      if (!startupStillCurrent()) return;
      sessionAuthorityCell.authority =
        injectedAuthority ??
        createPiChildSessionStorageAuthority({
          SessionManager: (PiPublicExports as { SessionManager?: unknown })
            .SessionManager,
          ...(sessionRootProof === undefined
            ? {}
            : { sessionRoot: sessionRootProof }),
          processLaunch: deps.processPort,
          scopeId: `pi-startup-${startupSequence}`,
        });
      const sessionAuthority = sessionAuthorityCell.authority;
      const activation = await controller.activate(
        ctx,
        commands.value,
        hostSurface,
      );
      childInspectionSettingsUi.ui = undefined;
      if (!startupStillCurrent()) return;
      if (activation.isErr()) {
        ctx.ui.notify(activation.error.safeMessage, "error");
        return;
      }
      const generation = activation.value;
      const startupOperation = controller.beginOperation();
      if (startupOperation.isErr()) return;
      const startupHandle = startupOperation.value;
      const startupOwnsGeneration = (): boolean =>
        startupStillCurrent() && startupHandle.assertStillCurrent().isOk();
      const generationResources = new PiGenerationResourceOwner(
        generation.id,
        () => generationSessionCtxCell.clear(generation.id),
      );
      const generationTelemetryCell: { telemetry: PiTelemetry | undefined } = {
        telemetry: undefined,
      };
      generationResourcesCell.owner = generationResources;
      // Seeds this generation's context slot, which also drops the replaced
      // generation's context: the cell holds exactly one generation at a time.
      generationSessionCtxCell.note(generation.id, ctx);
      doctorHealthOnlyCell.value = generation.healthOnlyMode;
      // Doctor stays registered in health-only; capability probes are always
      // available from preflight even when thread sources are not open yet.
      doctorCheckPortsCell.ports = createStoreBackedDoctorCheckPorts({
        capabilities: () =>
          doctorCapabilitiesFromProbes(
            generation.preflight.healthReport.probeResults,
          ),
      });
      // Strict boot: `ready` is not a preflight outcome, it is the reward
      // for a committed primary. Only the closed states can be painted
      // before boot activation has settled below.
      if (generation.healthOnlyMode) {
        ctx.ui.setStatus(
          "weave",
          "health-only - run /weave:health for details",
        );
      }

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
        setWeaveUnavailableStatus(ctx);
        deps.logger.warn(
          { code: failure.code, safeMessage: failure.safeMessage },
          "config activation failed",
        );
        return;
      }

      const configActivation = generation.preflight.configActivation;
      if (configActivation === undefined) {
        setWeaveUnavailableStatus(ctx);
        return;
      }

      logMaterializationErrors(
        configActivation.descriptors.errors,
        deps.logger,
      );

      // Open the trusted project's Runtime Store once and share it between
      // telemetry and workflow lifecycle.
      let runtimeStore: RuntimeStore | undefined;
      runtimeStoreCell.store = undefined;
      if (
        !generation.healthOnlyMode &&
        generation.preflight.trust === "trusted"
      ) {
        const opened = await deps.runtimeStoreFactory.open(ctx.cwd);
        if (opened.isOk()) generationResources.adoptRuntimeStore(opened.value);
        if (!startupOwnsGeneration()) {
          void generationResources.dispose();
          return;
        }
        if (opened.isErr()) {
          deps.logger.warn(
            { failure: opened.error },
            "Runtime Store open/migration failed; workflow lifecycle commands unavailable this generation",
          );
        } else {
          runtimeStore = opened.value;
          // `/weave:pi-config` reads and writes through this generation's own
          // store rather than opening a second connection.
          runtimeStoreCell.store = opened.value;
        }
      }

      // Child-extension selection is resolved exactly once per generation,
      // only after the Runtime Store is open, and never per spawn: a child
      // must not pay for a preference read, an inventory scan, or a directory
      // walk. Absent an explicit stored selection this stays empty, which
      // makes child argv byte-identical to a spawn with no provider at all.
      let childExtensionArgs: readonly string[] = EMPTY_CHILD_EXTENSION_ARGS;
      if (runtimeStore !== undefined) {
        // The resolution is typed as infallible: every failure inside it
        // already degrades to the inherit-all default.
        const resolved: ChildExtensionArgsResolution =
          await resolveChildExtensionSpawnArgs({
            store: runtimeStore,
            // Every public host surface the inventory can read is wired
            // here: loaded commands and tools, Pi's own configured-package
            // evidence, the agent directory, and this loader's own entry
            // fact. A surface the host does not expose degrades; a surface it
            // does expose is never left unread.
            collectInventory: () =>
              collectPiExtensionInventoryFromHost({
                api: pi,
                rootExports: PiPublicExports as unknown as Readonly<
                  Record<string, unknown>
                >,
                trust: generation.preflight.trust,
                cwd: ctx.cwd,
              }),
          }).unwrapOr({ args: EMPTY_CHILD_EXTENSION_ARGS });
        if (!startupOwnsGeneration()) {
          void generationResources.dispose();
          return;
        }
        childExtensionArgs = resolved.args;
        if (resolved.diagnostics !== undefined) {
          // Bounded counts and closed reason codes only: an entry id is an
          // absolute path for every non-package extension.
          deps.logger.warn(
            {
              ...resolved.diagnostics,
              selectedExtensions:
                resolved.args.length === 0 ? 0 : (resolved.args.length - 1) / 2,
            },
            "child extension selection degraded",
          );
        }
      }
      const resolveChildExtensionArgs = (): readonly string[] =>
        childExtensionArgs;

      currentWorkflows = configActivation.config.workflows ?? {};
      planStateProviderCell.value =
        deps.planStateProviderFactory?.(ctx.cwd) ??
        createPiPlanStateProvider(ctx.cwd);

      const session: PiActiveSession = {
        generationId: generation.id,
        childInspectionSettings: generation.preflight.childInspection,
        primarySession: new PiPrimarySession({
          skillCatalog: new PiSkillCatalog([]),
          logger: deps.logger,
          parentSessionProbe: ctx.sessionManager,
        }),
        descriptors: configActivation.descriptors.byName,
        disabledSkills: configActivation.config.disabled?.skills ?? [],
        pendingPrimaryName: DEFAULT_PRIMARY_AGENT_NAME,
        primaryActivationAttempted: false,
        primaryActivationFailure: undefined,
      };
      activeSession = session;

      const sessionHealthOnly = effectiveHealthOnly(generation);

      // Strict boot activation (Pi adapter contract): the default primary is
      // resolved, skill-resolved and model-applied *here*, atomically, before
      // this generation is granted any primary authority. Nothing downstream -
      // tool registration, the delegation transport, the `ready` status or the
      // active-agent badge - exists for a generation whose primary never
      // committed, and no later turn retries it.
      if (!sessionHealthOnly) {
        const activationReservation = reservePrimaryActivation();
        await activationReservation.waitForPrior;
        if (!startupOwnsGeneration()) {
          activationReservation.release();
          void generationResources.dispose();
          return;
        }
        const booted = await activateBootPrimary(pi, ctx, session);
        activationReservation.release();
        if (!startupOwnsGeneration()) {
          void generationResources.dispose();
          return;
        }
        if (booted.isErr()) {
          if (booted.error.type === "PrimaryActivationStale") {
            // A newer generation already owns every session-scoped surface.
            // Painting anything here would erase a newer, correct badge.
            return;
          }
          lastBootActivationFailure = booted.error;
          resetProviderFastReporting();
          activeSession = undefined;
          controller.shutdown();
          clearThreadSources(threadSourcesCell);
          clearChildReconstruction(childReconstructionCell);
          threadSourcesRequired = false;
          currentWorkflows = {};
          planStateProviderCell.value = undefined;
          activeWorkflowInstanceCell.value = undefined;
          setActiveAgent(ctx, undefined);
          setWeaveUnavailableStatus(ctx);
          deps.logger.warn(
            {
              agentName:
                booted.error.type === "PrimarySkillCatalogUnavailable"
                  ? DEFAULT_PRIMARY_AGENT_NAME
                  : booted.error.agentName,
              failure: booted.error.type,
            },
            "boot primary activation failed; this generation has no active Weave primary",
          );
          ctx.ui.notify(bootActivationSafeMessage(booted.error), "error");
          void generationResources.dispose();
          if (generationResourcesCell.owner === generationResources) {
            generationResourcesCell.owner = undefined;
          }
          return;
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
          resetProviderFastReporting();
          activeSession = undefined;
          controller.shutdown();
          clearThreadSources(threadSourcesCell);
          clearChildReconstruction(childReconstructionCell);
          threadSourcesRequired = false;
          setActiveAgent(ctx, undefined);
          ctx.ui.setStatus(
            "weave",
            "health-only - run /weave:health for details",
          );
          ctx.ui.notify("Weave tool registration failed.", "error");
          void generationResources.dispose();
          if (generationResourcesCell.owner === generationResources) {
            generationResourcesCell.owner = undefined;
          }
          return;
        }
      }

      // A trusted, non-health-only generation that committed a primary is the
      // only parent state where a fast owner can exist, so it is the only one
      // that overrides a host provider. Health-only sessions and withheld
      // trust leave Pi's native provider exactly as it was.
      if (!sessionHealthOnly && generation.preflight.trust === "trusted") {
        await ensureCodexFastProviderRegistered(pi);
      }

      if (!startupOwnsGeneration()) {
        void generationResources.dispose();
        return;
      }
      // Durable child records live in the parent session's child-ref ledger
      // and the native session tree, so the registry keeps no adapter-owned
      // persistence port of its own.
      const inspectionRegistry = new PiChildInspectionRegistry();
      inspectionRegistryCell.registry = inspectionRegistry;
      ctx.ui.setStatus(
        "weave",
        sessionHealthOnly
          ? "health-only - run /weave:health for details"
          : "ready",
      );
      // The badge names the *committed* primary this generation actually
      // holds. Boot activation above has already committed it for every
      // non-health-only generation that reached this point; health-only
      // generations never commit one, so their badge stays hidden.
      setActiveAgent(
        ctx,
        sessionHealthOnly
          ? undefined
          : session.primarySession.getCurrent()?.descriptor.name,
      );

      // Task 4/5/6 sources open for trusted generations so history/doctor stay
      // read-only in health-only. Delegation still requires a full ready
      // generation (Pi adapter contract).
      if (generation.preflight.trust !== "withheld") {
        // Bounded: one warning per degradation shape for this generation, so a
        // session whose manager never returns entries cannot flood the log
        // through the ref reads that run on every picker open.
        const reportedRefEntryReadDegradations =
          new Set<PiChildRefEntryReadDegradation>();
        const reportRefEntryReadDegradation = (
          degradation: PiChildRefEntryReadDegradation,
        ): void => {
          if (reportedRefEntryReadDegradations.has(degradation)) return;
          reportedRefEntryReadDegradations.add(degradation);
          deps.logger.warn(
            { degradation },
            "child ref entry read found no usable session manager",
          );
        };
        let allowDelegationController = !effectiveHealthOnly(generation);
        const parentForSources = session.primarySession.getParentSession();
        // The native-session authority is checked before mutation-capable
        // thread sources, cache create/open, reconstruction, recovery
        // prompting, or upsert. A host without the public session
        // create/open API refuses with `pi-session-api-unavailable`;
        // health-only and refused generations open non-creating read-only
        // sources only and skip every write path.
        const sessionStorage = sessionAuthority;
        const sessionStorageDecision = Result.fromThrowable(
          () => sessionStorage.requireNativeSessionAuthority(),
          () => ({
            type: "SessionStorageUnavailable" as const,
            reason: "pi-session-api-unavailable" as const,
          }),
        )();
        const nativeSessionAuthorityGranted =
          sessionStorageDecision.isOk() && sessionStorageDecision.value.isOk();
        const useReadOnlyThreadSources =
          !nativeSessionAuthorityGranted || effectiveHealthOnly(generation);
        if (
          deps.threadSourceFactory !== undefined &&
          parentForSources.persistence === "persistent"
        ) {
          const opened = await deps.threadSourceFactory({
            workspaceKey: ctx.cwd,
            parentSessionId: parentForSources.sessionId,
            append: {
              appendEntry: (type, data) => {
                pi.appendEntry(type, data);
              },
            },
            read: {
              // Resolved at call time, never captured: Pi replaces
              // `ctx.sessionManager` across a session load, so the manager
              // held at `session_start` can stop reporting this parent's
              // entries while the session file is unchanged. The generation
              // id pins the lookup, so a replaced generation's retained
              // closure falls back to its own startup context instead of
              // reading its successor's manager.
              getEntries: () =>
                readSessionManagerEntries(
                  generationSessionCtxCell.read(generation.id) ?? ctx,
                  reportRefEntryReadDegradation,
                ),
            },
            env: {
              XDG_DATA_HOME: deps.envPort.read("XDG_DATA_HOME"),
              HOME: deps.envPort.read("HOME"),
            },
            storageAuthority: sessionStorage,
            ...(useReadOnlyThreadSources ? { readOnly: true as const } : {}),
          });
          if (!startupOwnsGeneration()) {
            void generationResources.dispose();
            return;
          }
          if (opened.isErr()) {
            clearThreadSources(threadSourcesCell);
            clearChildReconstruction(childReconstructionCell);
            threadSourcesRequired = false;
            allowDelegationController = false;
            deps.logger.warn(
              {
                failure: opened.error.type,
                reason: opened.error.reason,
              },
              "thread source factory failed; delegation unavailable this generation",
            );
            if (!effectiveHealthOnly(generation)) {
              ctx.ui.notify(
                "Weave could not open native child session sources for this parent session.",
                "error",
              );
            }
          } else {
            threadSourcesCell.refs = opened.value.refs;
            threadSourcesCell.sessions = opened.value.sessions;
            threadSourcesCell.cache = opened.value.cache;
            threadSourcesCell.cacheMode = opened.value.cacheMode;
            threadSourcesRequired = !effectiveHealthOnly(generation);
            // Reconstruction upserts into the derivative cache and must not
            // run on path-only / health-only generations. A future
            // descriptor-safe ready host retains the existing reconstruct
            // + publish path below.
            if (useReadOnlyThreadSources) {
              clearChildReconstruction(childReconstructionCell);
            } else {
              // A session transition revoked the previous generation, so this
              // parent's own settled children exist only in its authoritative
              // ref ledger. Reconstruct them once per generation, project them
              // into the derivative metadata cache, and publish a
              // generation-scoped summary the status and history surfaces read.
              // `readRefs` already excludes refs another parent minted, so a
              // clone or fork destination reconstructs nothing from its
              // inherited entries.
              await reconstructParentLocalChildren({
                refs: opened.value.refs,
                cache: opened.value.cache,
                workspaceKey: ctx.cwd,
                parentSessionId: parentForSources.sessionId,
              }).match(
                (summary) => {
                  if (!startupOwnsGeneration()) return;
                  publishChildReconstruction(
                    childReconstructionCell,
                    generation.id,
                    summary,
                  );
                },
                (error) => {
                  if (!startupOwnsGeneration()) return;
                  clearChildReconstruction(childReconstructionCell);
                  deps.logger.warn(
                    {
                      failure: error.type,
                      reason: error.reason,
                      safeMessage: describeChildReconstructionError(error),
                    },
                    "parent-local child reconstruction failed; status and history stay live-only",
                  );
                },
              );
            }
            const sessionStore = opened.value.sessions as PiNativeSessionStore;
            const discoveryCache = opened.value.cache as PiChildMetadataCache;
            const canList =
              typeof discoveryCache.list === "function" &&
              typeof discoveryCache.get === "function" &&
              typeof discoveryCache.tombstone === "function";
            doctorCheckPortsCell.ports = createStoreBackedDoctorCheckPorts({
              capabilities: () =>
                doctorCapabilitiesFromProbes(
                  generation.preflight.healthReport.probeResults,
                ),
              permissions: () => {
                const root = sessionStore.sessionRoot?.();
                if (typeof root !== "string" || root.length === 0) {
                  return okAsync(
                    failedDoctorCheck(
                      "session root unavailable",
                      "ChildSessionRootViolation",
                    ),
                  );
                }
                return okAsync(passedDoctorCheck("session root resolved"));
              },
              readRefs: () =>
                opened.value.refs.readRefs({
                  limit: 50,
                }),
              listSessionsByRef: (refs) =>
                typeof sessionStore.listByRef === "function"
                  ? sessionStore.listByRef(refs, {
                      limit: 50,
                      expectedParentSession: parentForSources.sessionId,
                    })
                  : okAsync([]),
              cacheMode: opened.value.cacheMode,
              listMetadata: () => {
                if (!canList) {
                  return okAsync([]);
                }
                const listed = discoveryCache.list({
                  workspaceKey: ctx.cwd,
                  limit: 50,
                  includeTombstoned: true,
                });
                if (listed.isErr()) {
                  return errAsync(listed.error);
                }
                return okAsync(
                  listed.value.records.map((row) => ({
                    childId: row.childId,
                    originParentSessionId: row.originParentSessionId,
                    stale: row.stale,
                    tombstoned: row.tombstoned,
                  })),
                );
              },
              liveParentSessionId: parentForSources.sessionId,
            });
            if (
              canList &&
              typeof sessionStore.openSession === "function" &&
              typeof sessionStore.readSessionEntryPage === "function" &&
              typeof sessionStore.deleteSession === "function"
            ) {
              refreshAdapterCommandHandlers(
                createPiChildrenCommandPort({
                  cache: discoveryCache,
                  sessions: sessionStore,
                }),
              );
            }
          }
        }

        // The one live-event gate for this generation's overlay. It is
        // constructed with the overlay controller below and read by the
        // delegation callbacks above, which run only after that point.
        let childOverlayLiveStream: ChildOverlayLiveStream | undefined;
        if (allowDelegationController) {
          delegationControllerCell.generationId = generation.id;
          delegationControllerCell.controller = new PiDelegationController({
            config: configActivation.config,
            generationId: generation.id,
            idGenerator: deps.idGenerator,
            logger: deps.logger,
            processPort: deps.processPort,
            sessionStorageAuthority: sessionAuthority,
            randomPort: deps.randomPort,
            hmacPort: deps.hmacPort,
            handshakeTimeoutMs:
              configActivation.childLifecycleSettings.handshakeTimeoutMs,
            replyTimeoutMs:
              configActivation.childLifecycleSettings.replyTimeoutMs,
            settlementTimeoutMs:
              configActivation.childLifecycleSettings
                .settlementInactivityTimeoutMs,
            runtimeBudgetMs:
              configActivation.childLifecycleSettings.absoluteRuntimeBudgetMs,
            ...(deps.childResponseDrainMs === undefined
              ? {}
              : { responseDrainMs: deps.childResponseDrainMs }),
            ...(deps.childCancelGraceMs === undefined
              ? {}
              : { cancelGraceMs: deps.childCancelGraceMs }),
            // The exact executable that launched this host, never a bare
            // "pi" a spawner would have to re-resolve via `PATH` (Pi adapter contract
            //).
            command: deps.childCommand,
            resolveExtensionArgs: resolveChildExtensionArgs,
            // Preserves ordinary runtime necessities (PATH/HOME/etc.) for the
            // spawned `pi` process, while never forwarding secrets/credentials
            // or this adapter's own private child-bootstrap variables.
            baseEnv: buildPiChildBaseEnv(),
            pathContainment: deps.pathContainmentPort,
            currentCwd: () => ctx.cwd,
            currentEnv: () => buildPiChildBaseEnv(),
            // Thread ownership is measured against the live persistent parent
            // session, so a session transition can never let a new parent
            // inherit or resume another parent's threads.
            parentSessionId: () => {
              const parent = session.primarySession.getParentSession();
              return parent.persistence === "persistent"
                ? parent.sessionId
                : undefined;
            },
            // Task 4/5/6 thread sources. `resumeThread` refuses to run a thread
            // whose authoritative ref and native session it cannot read, so an
            // absent source here fails closed with a structured
            // `ThreadResumeUnavailable` instead of resuming on memory alone.
            threadRefs: () => threadSourcesCell.refs,
            threadSessions: () => threadSourcesCell.sessions,
            threadCache: () => threadSourcesCell.cache,
            threadWorkspaceKey: () => ctx.cwd,
            threadSourcesRequired,
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
            // The inspector's `role` fact. An agent this session did not
            // configure resolves to `undefined`, so the header prints no role
            // rather than inventing one.
            resolveAgentRole: (agentName) =>
              configActivation.descriptors.byName.get(agentName)?.category
                ?.name,
            buildBootstrap: (target, childId, context) =>
              buildChildBootstrapBody(
                configActivation.descriptors.byName,
                target,
                childId,
                context,
                ctx,
                (descriptor) =>
                  session.primarySession.prepareComposedPrompt(
                    descriptor,
                    session.disabledSkills,
                  ),
              ),
            onTreeChanged: () => {
              if (!startupOwnsGeneration()) return;
              // The focused child leaving the live set is the only settlement
              // signal the overlay gets; no session event carries one.
              childOverlayLiveStream?.noteTreeChanged();
              renderChildTreeWidget(
                ctx,
                delegationControllerCell.controller,
                treeSelectionCell,
                inspectionRegistry,
              );
            },
            onPrivateOutput: deps.onChildPrivateOutput,
            inspectionRegistry,
            // One gate, one pipeline. Focus, generation, settlement and
            // repaint coalescing all live in `ChildOverlayLiveStream`; this
            // callback only hands it the event.
            onChildSessionEvent: (childId, event) => {
              if (!startupOwnsGeneration()) return;
              if (childOverlayCell.generationId !== generation.id) return;
              childOverlayLiveStream?.ingest(childId, event);
            },
            // Lazy wrapper (Pi adapter contract): `telemetryCell.telemetry` is only
            // populated once the Runtime Store opens successfully, below -
            // reading it here would always see `undefined`. A settled child
            // assistant message always arrives well after that point, so the
            // lazy read is safe; absent telemetry degrades to a silent no-op
            // rather than blocking child settlement.
            telemetry: {
              recordAssistantUsage: (input) => {
                if (!startupOwnsGeneration()) return okAsync("noop" as const);
                const telemetry = generationTelemetryCell.telemetry;
                if (telemetry === undefined) return okAsync("noop" as const);
                return telemetry
                  .recordAssistantUsage(input)
                  .mapErr((failure) => {
                    telemetry.recordDegradation(failure);
                    return failure;
                  });
              },
            },
          });
          childOverlayCell.generationId = generation.id;
          childOverlayCell.controller = createChildOverlayController(
            createReadSessionEntryPageOverlaySource({
              describe: (id) => {
                const ctrl = delegationControllerCell.controller;
                if (ctrl === undefined) {
                  return errAsync({
                    type: "SourceUnavailable" as const,
                    operation: "describe",
                  });
                }
                return ctrl
                  .resolveOverlayChild(id)
                  .map(toChildOverlayDescriptor)
                  .mapErr((failure) =>
                    mapPiDelegationFailureToOverlaySourceError(failure, id),
                  );
              },
              readSessionEntryPage: (id, options) =>
                readOverlaySessionEntryPage(
                  {
                    controller: () => delegationControllerCell.controller,
                    sessions: () => threadSourcesCell.sessions,
                    parentSessionId: () => {
                      const parent = session.primarySession.getParentSession();
                      return parent.persistence === "persistent"
                        ? parent.sessionId
                        : undefined;
                    },
                  },
                  id,
                  options,
                ),
            }),
            {},
            {
              steer: (childId, generationId, text) => {
                if (
                  !startupOwnsGeneration() ||
                  generationId !== generation.id ||
                  delegationControllerCell.controller === undefined
                ) {
                  return errAsync({ type: "MutationFailed" as const });
                }
                return delegationControllerCell.controller
                  .steerChild(childId, text)
                  .mapErr(() => ({ type: "MutationFailed" as const }));
              },
              followUp: (childId, generationId, text) => {
                if (
                  !startupOwnsGeneration() ||
                  generationId !== generation.id ||
                  delegationControllerCell.controller === undefined
                ) {
                  return errAsync({ type: "MutationFailed" as const });
                }
                return delegationControllerCell.controller
                  .followUpChild(childId, text)
                  .mapErr(() => ({ type: "MutationFailed" as const }));
              },
            },
            // Header row 2's breadcrumb. It reads only the one already-resolved
            // active-plan view `active-plan-ui-state.ts` owns, and never starts
            // a plan lookup of its own from a repaint.
            () => readActivePlanBreadcrumb(activePlanUiState.view()),
          );
          childOverlayLiveStream?.dispose();
          childOverlayLiveStream = createChildOverlayLiveStream({
            controller: childOverlayCell.controller,
            // Reads the mounted pane at paint time: the overlay mounts and
            // unmounts many times over one generation, and a captured
            // component would repaint a pane that is already gone.
            repaint: {
              invalidate: () => childOverlayCell.component?.invalidate(),
              requestRender: () => childOverlayCell.tui?.requestRender(),
            },
            timer:
              delegationControllerCell.controller?.cardTimerPort ??
              new SystemTimerPort(),
            generationId: generation.id,
            currentGenerationId: () =>
              startupOwnsGeneration() ? generation.id : undefined,
            resolveLiveThreadId: (childId) =>
              delegationControllerCell.controller?.resolveThreadIdForLiveChild(
                childId,
              ),
          });
        }

        // Child recovery is generation-scoped. Construct it only after the
        // child-ref ledger is open, then prompt exactly once for this stable
        // parent session.
        //
        // Recovery mutates the child-ref ledger and spawns a restored child,
        // so it requires the same native-session authority already checked
        // before source construction. Refused and health-only generations
        // skip without prompting. Lower
        // ref-mutation checks stay independent, and ref reads stay ungated.
        const recoveryRefs = threadSourcesCell.refs;
        if (
          recoveryRefs !== undefined &&
          !useReadOnlyThreadSources &&
          nativeSessionAuthorityGranted
        ) {
          const historyPort = {
            list: () => recoveryRefs.readRefs().map((scan) => scan.refs),
            updateStatus: (
              record: PiChildRecoveryRecord,
              status: PiChildRecoveryRecord["status"],
            ) =>
              recoveryRefs
                .appendLifecycle(record, { status })
                .map(() => undefined),
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
              if (!startupOwnsGeneration() || sendMessage === undefined) {
                return errAsync<void, unknown>({ type: "stale" });
              }
              return ResultAsync.fromPromise(
                Promise.resolve().then(() => {
                  if (!startupOwnsGeneration()) {
                    throw new Error("stale-recovery-generation");
                  }
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
            () => {
              if (startupOwnsGeneration()) {
                ctx.ui.notify(
                  "Child recovery is unavailable in this session.",
                  "info",
                );
              }
            },
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
          if (!telemetryResult.isErr()) {
            generationResources.adoptTelemetry(telemetryResult.value.telemetry);
          }
          if (!startupOwnsGeneration()) {
            void generationResources.dispose();
            return;
          }
          // `createPiTelemetry`'s error type is `never` - it always
          // degrades internally rather than failing. `.isErr()` is checked
          // only to satisfy Result narrowing, never expected to be true.
          if (!telemetryResult.isErr()) {
            const { telemetry, logDegradation } = telemetryResult.value;
            generationTelemetryCell.telemetry = telemetry;
            telemetryCell.telemetry = telemetry;
            const ui: PiTelemetryUiPort = {
              notify: (message, level) => {
                if (startupOwnsGeneration()) ctx.ui.notify(message, level);
              },
            };
            if (logDegradation !== undefined) {
              telemetry.recordDegradation(logDegradation);
              telemetry.notifyFailureOnce(ui, logDegradation);
            }
            const retentionActivation = await telemetry.activate();
            if (!startupOwnsGeneration()) {
              void generationResources.dispose();
              return;
            }
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
            if (!startupOwnsGeneration()) {
              void generationResources.dispose();
              return;
            }
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
                  sessionStorageAuthority: sessionAuthority,
                  randomPort: deps.randomPort,
                  hmacPort: deps.hmacPort,
                  logger: deps.logger,
                  handshakeTimeoutMs:
                    configActivation.childLifecycleSettings.handshakeTimeoutMs,
                  replyTimeoutMs:
                    configActivation.childLifecycleSettings.replyTimeoutMs,
                  settlementTimeoutMs:
                    configActivation.childLifecycleSettings
                      .settlementInactivityTimeoutMs,
                  runtimeBudgetMs:
                    configActivation.childLifecycleSettings
                      .absoluteRuntimeBudgetMs,
                  idGenerator: deps.idGenerator,
                  // The exact executable that launched this host, never a
                  // bare "pi" a spawner would have to re-resolve via `PATH`
                  // (Pi adapter contract).
                  command: deps.childCommand,
                  resolveExtensionArgs: resolveChildExtensionArgs,
                  baseEnv: buildPiChildBaseEnv(),
                  registry: directStepChildRegistry,
                  inspectionRegistry,
                  // A direct workflow step is a real Pi-native child session,
                  // provisioned through the same approved store/ref authority
                  // ordinary delegation uses. Production requires it, so an
                  // absent store, an ephemeral session, or a directory-only
                  // session refuses before any spawn.
                  threadSessions: () => threadSourcesCell.sessions,
                  threadRefs: () => threadSourcesCell.refs,
                  // Production always configures a thread source factory, so a
                  // production direct step always requires a validated native
                  // session - including when this generation's sources failed
                  // to open, where refusing beats an ephemeral fallback.
                  requireNativeSession: () =>
                    deps.threadSourceFactory !== undefined,
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
                  onPrivateOutput: (childId, capture) =>
                    deps.onChildPrivateOutput?.(childId, capture) ??
                    ok(undefined),
                },
                generation.id,
              ),
            ),
            // Resolves a direct-step agent's own real descriptor (composed
            // prompt, models, delegation targets) from this
            // generation's own activated catalog by name (Pi adapter contract,
            //) - never the engine effect's own always-empty
            // `agentDescriptor` fields.
            resolveAgentDescriptor: (agentName) => {
              const descriptor =
                configActivation.descriptors.byName.get(agentName);
              if (descriptor === undefined) return undefined;
              return {
                ...descriptor,
                composedPrompt: session.primarySession.prepareComposedPrompt(
                  descriptor,
                  session.disabledSkills,
                ),
              };
            },
            onDirectStepActiveChange: (active, agentName) => {
              if (!startupOwnsGeneration()) return;
              setActiveAgent(
                ctx,
                resolveDirectStepBadgeAgent(
                  active,
                  agentName,
                  session.primarySession,
                ),
              );
            },
            recoveryPointerStore:
              deps.recoveryPointerStoreFactory?.(ctx.cwd) ??
              new BunJsonlRecoveryPointerStore(
                join(
                  ctx.cwd,
                  ".weave",
                  "runtime",
                  "pi-recovery-pointer.ndjson",
                ),
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
            onPlanSnapshotChanged: () => {
              if (!startupOwnsGeneration()) return;
              // Deliberately ignores the callback's own workflow id. The
              // callback fires for settlements too, so trusting its argument
              // would repaint a workflow that has just gone terminal or been
              // aborted. Re-reading authoritative tracker/recovery state is
              // what makes a settlement clear the surfaces instead of
              // freezing them. One resolution, both surfaces: the widget and
              // the durable current-task footer are painted from the same
              // view, so they can never lag behind or disagree.
              void syncActivePlanSurfaces(ctx, startupOwnsGeneration);
            },
          });
          // Nothing resolved before this point may survive into recovery: the
          // retained identity and both surfaces are cleared first, so a stale
          // workflow can never be shown beside a recovered one.
          clearActivePlanSurfaces(ctx);
          // Recovery banner (Pi adapter contract): read-only on every session start.
          // Never resumes anything itself - only `/weave:resume` (with its
          // own fresh confirm and generation/lease recheck, above) may ever
          // reacquire a paused execution.
          const recoveryPointer =
            await workflowControllerCell.controller.readRecoveryPointer();
          if (!startupOwnsGeneration()) return;
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
          // Pi adapter contract: initial plan widget/footer render at session
          // start/recovery - shows the recovered pending workflow's plan
          // immediately, or hides both surfaces when nothing is recoverable.
          // The resolver observes the eligible pointer itself; it never
          // auto-resumes anything.
          await syncActivePlanSurfaces(ctx, startupOwnsGeneration);
          if (!startupOwnsGeneration()) return;
        }
        treeSelectionCell.selectedId = ROOT_NODE_ID;
        const rootChild: PiInspectorChild = {
          childId: ROOT_NODE_ID,
          name: "Weave execution",
          kind: "ordinary",
          live: true,
          status: "running",
        };
        let customInspectionComponent:
          | ReturnType<typeof createChildInspectionCustomComponent>
          | undefined;
        let customInspectionTui: { requestRender(): void } | undefined;
        const fallbackTerminalErrors = new Map<string, PiChildProviderError>();
        // Settles the currently mounted inspection overlay: releases the
        // borrowed session editor, returns the view to the root, and resolves
        // the host `custom()` promise exactly once. `undefined` whenever no
        // overlay is mounted.
        let settleCustomInspection: (() => void) | undefined;
        let inspectionEditor: PiChildInspectionEditor | undefined;
        inspectionEditor = createChildInspectionEditor(
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
            beforeInput: () => {
              inspectionEditor?.syncChildren([
                rootChild,
                ...inspectionRegistry.snapshotLive().map((item) => ({
                  childId: item.id,
                  name: item.name,
                  kind: "ordinary" as PiInspectorChild["kind"],
                  live: true,
                  status: item.status as PiInspectorChild["status"],
                  parentId: item.parentId,
                  generationId: generation.id,
                })),
              ]);
            },
            openPicker: () => {
              // Pi's selector is a nested overlay: mounting it removes this
              // custom component without ever settling its promise. Settle the
              // mounted inspection first, so the borrowed session editor goes
              // back to its previous owner (possibly `pi-vim`) and no stale
              // component/editor state survives into the next activation.
              settleCustomInspection?.();
              closeChildOverlay(childOverlayCell, overlayKeysCell);
              childSlots.assignTree(inspectionRegistry.snapshotLive());
              void childInspectionRuntime.openChildPicker(ctx, generation.id);
            },
            onViewChange: () => {
              customInspectionComponent?.invalidate();
              customInspectionTui?.requestRender();
            },
            defaultInput: (data) => undefined,
          },
        );
        childInspectionEditorCell.editor = inspectionEditor;
        // Overlay shortcuts must not depend on Weave owning the primary
        // editor: when another extension (for example `pi-vim`) installs the
        // editor first, the composed factory below never runs. Registering
        // here, from the host keybindings port, keeps Alt+I / Alt+1..Alt+9 a
        // real route to the overlay under any editor ownership, while still
        // honouring this generation's `child_inspection.keys` overrides.
        // Raw keys are handed to the host exactly once; the handlers resolve
        // the live generation at key-press time, so this call only re-plans
        // for a replacement generation.
        childInspectionRuntime.maybeRegisterOverlayKeys(
          pi,
          undefined,
          generation.id,
        );
        const editorFactory = (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
        ) => {
          // Task 13: capture the public live keybindings object. Shortcuts are
          // planned/applied exactly once when getEffectiveConfig() is present.
          childInspectionRuntime.maybeRegisterOverlayKeys(
            pi,
            keybindings,
            generation.id,
          );
          return new WeaveChildInspectionEditor(
            tui,
            theme,
            keybindings,
            inspectionEditor,
          );
        };
        let customInspectionOpen = false;
        /**
         * Records one native-overlay → custom-editor fallback decision as a
         * bounded reason code. Every path that leaves the native overlay goes
         * through here, so a live run always answers "why did this land in the
         * fallback?" from `/weave:health` alone. Codes carry no identifiers.
         */
        const reportOverlayFallback = (
          code: PiChildOverlayFallbackReasonCode,
        ): void => {
          childInspectionRuntime.recordOverlayDiagnostic(
            formatPiChildOverlayFallbackDiagnostic(code),
          );
        };
        const isFallbackRequired = (
          error: unknown,
        ): error is ChildOverlayFallbackRequired =>
          typeof error === "object" &&
          error !== null &&
          "kind" in error &&
          (error as { kind?: unknown }).kind === "fallback-required";
        const activateCustomEditorInspection = (
          childId: string,
          terminalError?: PiChildProviderError,
        ): void => {
          if (terminalError === undefined)
            fallbackTerminalErrors.delete(childId);
          else fallbackTerminalErrors.set(childId, terminalError);
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
          // Custom-editor fallback borrows the session editor for the
          // duration of the inspection view. Native overlay never does this.
          const ownerBeforeInspection = ctx.ui.getEditorComponent?.();
          if (
            editorInstallCell !== undefined &&
            ownerBeforeInspection !== editorFactory
          ) {
            editorInstallCell.previousFactory = ownerBeforeInspection;
          }
          ctx.ui.setEditorComponent?.(editorFactory);
          openCustomInspection();
        };
        let searchRouteReported = false;
        /**
         * Resolves the in-overlay search key against the host's own bindings.
         * A key the host already owns is never stolen: the route is disabled
         * and the conflict is reported once through the overlay diagnostics
         * that `/weave:health` prints.
         */
        const searchRouteTrigger = (
          keybindings: unknown,
        ): { readonly trigger: string | undefined } => {
          const route = resolveChildOverlaySearchRoute(
            childOverlayConflictPortFromHost(
              captureChildOverlayKeybindings(keybindings),
            ),
          );
          if (!searchRouteReported) {
            searchRouteReported = true;
            for (const diagnostic of route.diagnostics) {
              childInspectionRuntime.reportOverlayKeyDiagnostic(diagnostic);
            }
          }
          return { trigger: route.trigger };
        };
        const mountNativeOverlay = (): void => {
          const overlay = childOverlayCell.controller;
          if (
            overlay === undefined ||
            ctx.mode !== "tui" ||
            ctx.ui.custom === undefined
          ) {
            reportOverlayFallback(
              overlay === undefined
                ? "controller-absent"
                : "no-tui-custom-surface",
            );
            ctx.ui.notify("Child inspection requires Pi TUI mode.", "warning");
            return;
          }
          if (
            childOverlayCell.open &&
            childOverlayCell.component !== undefined
          ) {
            childOverlayCell.component.invalidate();
            childOverlayCell.tui?.requestRender();
            return;
          }
          childOverlayCell.open = true;
          let finished = false;
          const finish = (): void => {
            if (finished) return;
            finished = true;
            childOverlayCell.open = false;
            childOverlayCell.component = undefined;
            childOverlayCell.tui = undefined;
            if (childOverlayCell.settle === settleMounted) {
              childOverlayCell.settle = undefined;
            }
            if (overlay.isOpen()) {
              Result.fromThrowable(
                () => overlay.close(),
                () => "overlay_close_failed" as const,
              )().match(
                () => undefined,
                () => undefined,
              );
            }
          };
          let settleMounted: (() => void) | undefined;
          void ctx.ui
            .custom<void>((tui, theme, keybindings, done) => {
              const overlayTui = tui as PiChildOverlayTui;
              const overlayKeybindings = keybindings as KeybindingsManager;
              childOverlayCell.tui = overlayTui;
              // Also capture keybindings here so pi-vim-yielded sessions still
              // register Task 13 shortcuts the first time the overlay mounts.
              childInspectionRuntime.maybeRegisterOverlayKeys(
                pi,
                overlayKeybindings,
                generation.id,
              );
              childInspectionRuntime.bindOverlayKeyInterceptor(generation.id);
              const settle = (): void => {
                if (finished) return;
                finish();
                treeSelectionCell.selectedId = ROOT_NODE_ID;
                done(undefined);
              };
              settleMounted = settle;
              childOverlayCell.settle = settle;
              const mounted = createChildOverlayCustomComponent(
                overlayTui,
                theme,
                overlayKeybindings,
                overlay,
                settle,
                (fallback) => {
                  // Settle native once, then hand off to the custom-editor path.
                  settle();
                  if (!startupOwnsGeneration()) return;
                  reportOverlayFallback(
                    piChildOverlayFallbackReasonCode(
                      fallback.metadata.reason,
                      "mounted",
                    ),
                  );
                  activateCustomEditorInspection(
                    fallback.metadata.childId,
                    fallback.terminalError,
                  );
                },
                { cwd: ctx.cwd },
                overlayKeysCell.interceptor,
                searchRouteTrigger(overlayKeybindings),
                // The in-overlay `y` answer runs the cancellation; the overlay
                // owns the question, the runtime owns the effect.
                (childId) =>
                  childInspectionRuntime.cancelOverlaySubtree(
                    childId,
                    generation.id,
                  ),
              );
              if (mounted.focused !== undefined) mounted.focused = true;
              childOverlayCell.component = mounted;
              return mounted;
            }, PI_CHILD_OVERLAY_CUSTOM_OPTIONS)
            .finally(() => {
              finish();
            });
        };
        const activateNativeOverlay = (childId: string): void => {
          const overlay = childOverlayCell.controller;
          if (overlay === undefined || !startupOwnsGeneration()) {
            reportOverlayFallback(
              overlay === undefined
                ? "controller-absent"
                : "generation-changed",
            );
            activateCustomEditorInspection(childId);
            return;
          }
          treeSelectionCell.selectedId = childId;
          void (async () => {
            const opened = await overlay.open(childId);
            if (!startupOwnsGeneration()) return;
            if (opened.isOk()) {
              // Never touch setEditorComponent: ui.custom owns input while
              // mounted, so pi-vim / primary editor ownership stays intact.
              mountNativeOverlay();
              return;
            }
            closeChildOverlay(childOverlayCell, overlayKeysCell);
            if (isFallbackRequired(opened.error)) {
              reportOverlayFallback(
                piChildOverlayFallbackReasonCode(
                  opened.error.metadata.reason,
                  "open",
                  opened.error.metadata.sourceErrorType,
                ),
              );
              activateCustomEditorInspection(
                opened.error.metadata.childId,
                opened.error.terminalError,
              );
              return;
            }
            reportOverlayFallback(
              piChildOverlayOpenErrorReasonCode(opened.error),
            );
            activateCustomEditorInspection(childId);
          })();
        };
        const activateChild = (childId: string): void => {
          if (!startupOwnsGeneration()) return;
          if (
            generation.preflight.childInspectionFallback === "native-overlay" &&
            childOverlayCell.controller !== undefined
          ) {
            activateNativeOverlay(childId);
            return;
          }
          reportOverlayFallback(
            childOverlayCell.controller === undefined
              ? "controller-absent"
              : "preflight-not-native",
          );
          activateCustomEditorInspection(childId);
        };
        const openCustomInspection = (): void => {
          if (ctx.mode !== "tui" || ctx.ui.custom === undefined) {
            ctx.ui.notify("Child inspection requires Pi TUI mode.", "warning");
            return;
          }
          // A picker opened from inside the view can tear the overlay down
          // without settling its promise, so trust the mounted component
          // rather than the open flag alone.
          if (customInspectionOpen && customInspectionComponent !== undefined) {
            customInspectionComponent.invalidate();
            customInspectionTui?.requestRender();
            return;
          }
          customInspectionOpen = true;
          let finished = false;
          const finish = (): void => {
            if (finished) return;
            finished = true;
            customInspectionOpen = false;
            inspectionRegistry.onTranscriptUpdate(undefined);
            // Every teardown path (Esc, an inner picker, a settled `done`)
            // must hand the borrowed session editor back to whoever owned it,
            // which may be another extension such as `pi-vim`. Release it only
            // while Weave still owns it, so a foreign owner installed during
            // the overlay's lifetime is never clobbered.
            if (ctx.ui.getEditorComponent?.() === editorFactory) {
              ctx.ui.setEditorComponent?.(editorInstallCell?.previousFactory);
            }
          };
          inspectionRegistry.onTranscriptUpdate((childId) => {
            if (inspectionEditor.currentView()?.childId !== childId) return;
            customInspectionComponent?.invalidate();
            customInspectionTui?.requestRender();
          });
          let mountedComponent:
            | ReturnType<typeof createChildInspectionCustomComponent>
            | undefined;
          let settleMountedInspection: (() => void) | undefined;
          void ctx.ui
            .custom<void>((tui, theme, keybindings, done) => {
              customInspectionTui = tui as { requestRender(): void };
              const settle = (): void => {
                if (finished) return;
                finish();
                // Leaving the child view must also leave the child's input:
                // the tree editor stays installed, so its view has to return
                // to the root or keystrokes keep steering the child.
                inspectionEditor.open(rootChild, [
                  rootChild,
                  ...inspectionRegistry.snapshotLive().map((item) => ({
                    childId: item.id,
                    name: item.name,
                    kind: "ordinary" as PiInspectorChild["kind"],
                    live: true,
                    status: item.status as PiInspectorChild["status"],
                    parentId: item.parentId,
                    generationId: generation.id,
                  })),
                ]);
                treeSelectionCell.selectedId = ROOT_NODE_ID;
                done(undefined);
              };
              settleMountedInspection = settle;
              settleCustomInspection = settle;
              mountedComponent = createChildInspectionCustomComponent(
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
                  const childId = node?.id ?? view?.childId ?? "";
                  const runtimeMeta =
                    inspectionRegistry.getChildRuntimeMeta(childId);
                  const latestTerminalEntry = [...transcriptState.entries]
                    .reverse()
                    .find(
                      (entry) =>
                        entry.kind === "assistant" &&
                        entry.stopReason !== undefined,
                    );
                  const terminalError =
                    latestTerminalEntry?.kind === "assistant"
                      ? latestTerminalEntry.terminalError
                      : fallbackTerminalErrors.get(childId);
                  return {
                    topologyPath: [],
                    childName: node?.name ?? view?.childId ?? "child",
                    ...(runtimeMeta.model === undefined
                      ? {}
                      : { model: runtimeMeta.model }),
                    ...(runtimeMeta.thinkingLevel === undefined
                      ? {}
                      : { reasoningLevel: runtimeMeta.thinkingLevel }),
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
                    terminalError,
                  };
                },
                () => inspectionEditor.currentView()?.state.draft ?? "",
                (draft) => inspectionEditor.updateDraft(draft),
                settle,
                { cwd: ctx.cwd },
              );
              customInspectionComponent = mountedComponent;
              return mountedComponent;
            })
            .finally(() => {
              if (customInspectionComponent === mountedComponent) {
                customInspectionComponent = undefined;
                customInspectionTui = undefined;
              }
              if (settleCustomInspection === settleMountedInspection) {
                settleCustomInspection = undefined;
              }
              finish();
            });
        };
        childInspectionEditorCell.activate = activateChild;
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
          if (
            editorInstallCell.ctx.ui.getEditorComponent?.() ===
            editorInstallCell.factory
          ) {
            editorInstallCell.ctx.ui.setEditorComponent?.(
              editorInstallCell.previousFactory,
            );
          }
          editorInstallCell = undefined;
        }
        const previousFactory = ctx.ui.getEditorComponent?.();
        // Another extension already owns the session editor (for example
        // `pi-vim`'s modal editor). Weave never claims it globally: the
        // root-level child-tree keys are optional, while replacing a foreign
        // editor would silently break the harness the user configured.
        const yielded = previousFactory !== undefined;
        editorInstallCell = {
          generationId: generation.id,
          ctx,
          previousFactory,
          factory: editorFactory,
          yielded,
        };
        if (!yielded) ctx.ui.setEditorComponent?.(editorFactory);
      }
    });

    pi.on("before_agent_start", (event, ctx: PiSessionContext) => {
      latestSessionCtx = ctx;
      noteGenerationSessionCtx(ctx);
      if (childModeState.active) return undefined;
      const session = activeSession;
      if (
        session === undefined ||
        session.generationId !== controller.getCurrentGeneration()?.id
      ) {
        return undefined;
      }

      ensureInspectionEditor(ctx, session.generationId);
      // Overlay keys are planned once, during session start, but the raw
      // terminal-input route they depend on can only be installed from a
      // session context that exposes `ui.onTerminalInput`. Under a foreign
      // primary editor (`pi-vim`) the composed editor factory never runs and
      // the overlay's custom factory only runs once an overlay is already
      // mounted, so this is the one lifecycle event that recurs while the
      // generation is live. The call is inert once the listener exists: raw
      // shortcut registration stays exactly-once and the listener is bound at
      // most once per generation.
      childInspectionRuntime.maybeRegisterOverlayKeys(
        pi,
        undefined,
        session.generationId,
      );
      // Prompt append, badge, and later request mapping all read the same
      // committed snapshot. A pending or failed switch has no snapshot.
      if (session.primarySession.captureRequestSnapshot() === undefined) {
        return undefined;
      }

      return {
        systemPrompt: session.primarySession.appendToSystemPrompt(
          readSystemPrompt(event),
        ),
      };
    });

    pi.on("agent_start", (_event, ctx) => {
      if (childModeState.active) return;
      if (activeSession !== undefined) {
        ensureInspectionEditor(ctx, activeSession.generationId);
      }
    });

    // Pi adapter contract: one exact-once usage observation per settled primary
    // assistant message. Identity is the message's own id, never text -
    // `extractAssistantUsageFromMessage` returns only bounded safe token/
    // cost scalars, never message content. A no-op when telemetry hasn't
    // been constructed (health-only/untrusted generation, or store open
    // failure) or when the generation has already been replaced.
    pi.on("message_end", async (event, ctx) => {
      if (childModeState.active) return undefined;
      const session = activeSession;
      if (session === undefined) return undefined;
      const operation = controller.beginOperation();
      if (
        operation.isErr() ||
        session.generationId !== controller.getCurrentGeneration()?.id
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
        session.primarySession.getCurrent()?.descriptor.name ??
        DEFAULT_PRIMARY_AGENT_NAME;
      const recorded = await telemetry.recordAssistantUsage({
        id: extracted.id,
        source: "primary",
        agentName,
        ...extracted.usage,
      });
      if (
        activeSession !== session ||
        operation.value.assertStillCurrent().isErr()
      ) {
        return undefined;
      }
      if (recorded.isErr()) {
        telemetry.recordDegradation(recorded.error);
        telemetry.notifyFailureOnce(
          { notify: (message, level) => ctx.ui.notify(message, level) },
          recorded.error,
        );
      }
      return undefined;
    });

    // Every Pi 0.83 session-transition surface that exposes an awaited,
    // vetoable pre-event is registered here via the transition runtime.
    sessionTransitionRuntime.register(pi);

    pi.on("session_shutdown", async (_event, ctx?: PiSessionContext) => {
      // Revoke synchronously, clear UI, then await bounded child stop. The
      // runtime owns the order so a replacement startup can publish new state
      // while best-effort cleanup continues on the captured snapshot.
      await sessionTransitionRuntime.runBoundedShutdown(ctx);
    });
  };
  piAdapterExtension.providerFastLatestForTest = () =>
    resolveProviderFastState();
  return piAdapterExtension;
}

export default createPiExtension();
