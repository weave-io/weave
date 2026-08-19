import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { type TarEntry, TarInspector } from "./tar-inspector.js";

/** The only host version for which this smoke makes an exact claim. */
export const EXACT_PI_VERSION = "0.84.2" as const;
/** The current checked-in smoke checklist binding. */
export const CHECKLIST_VERSION = 6 as const;
export const SMOKE_CASES = ["fallback", "rollback", "all"] as const;
export type SmokeCase = (typeof SMOKE_CASES)[number];

export const MAX_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;
export const MAX_CAPTURE_BYTES = 64 * 1024;
export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_REPORT_STRING_LENGTH = 256;
export const MAX_REPORT_INTEGER = 1_000_000;
/** Absolute lifecycle timestamps remain bounded and safe without exposing paths. */
export const MAX_REPORT_TIMESTAMP_MS = 10_000_000_000_000;
export const MAX_REPORT_ARRAY_LENGTH = 256;
export const MAX_REPORT_OBJECT_KEYS = 64;
export const MAX_DIAGNOSTIC_LENGTH = 256;
export const MAX_DIAGNOSTIC_COUNT = 8;
export const EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT = 1;
export const EXPECTED_NATIVE_LINE = "model fallback · smoke/second" as const;
const FIXTURE_CREDENTIAL = "pi-model-fallback-fixture-key";
const SAFE_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const XDG_CONFIG_ENV = "XDG_CONFIG_HOME";
const XDG_DATA_ENV = "XDG_DATA_HOME";
const XDG_CACHE_ENV = "XDG_CACHE_HOME";
const XDG_STATE_ENV = "XDG_STATE_HOME";
const EXPECTED_PACKAGE_ROOT_ENV = "PI_MODEL_SMOKE_EXPECTED_PACKAGE_ROOT";
const EXPECTED_EXTENSION_SHA_ENV = "PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256";
const EXPECTED_PACKAGE_VERSION_ENV = "PI_MODEL_SMOKE_EXPECTED_PACKAGE_VERSION";
const ADAPTER_SOURCE_PROVEN_ENV = "PI_MODEL_SMOKE_ADAPTER_SOURCE_PROVEN";
const FORBIDDEN_ENV_KEY_PATTERN =
  /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|PASSWORD|SECRET|TOKEN)(?:$|_)/iu;
const FORBIDDEN_PI_WEAVE_ENV_PATTERN =
  /^(?:PI|WEAVE)_(?:.*(?:HOME|DIR|SESSION|AUTH|CONFIG|CREDENTIAL|TOKEN|KEY|PASSWORD|SECRET).*)$/iu;
const SAFE_RUNTIME_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  XDG_CONFIG_ENV,
  XDG_DATA_ENV,
  XDG_CACHE_ENV,
  XDG_STATE_ENV,
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV,
  "PI_OFFLINE",
  "PI_MODEL_SMOKE_CASE",
  "PI_MODEL_SMOKE_CAPTURE_DIR",
  EXPECTED_PACKAGE_ROOT_ENV,
  EXPECTED_EXTENSION_SHA_ENV,
  EXPECTED_PACKAGE_VERSION_ENV,
  ADAPTER_SOURCE_PROVEN_ENV,
]);
const FORBIDDEN_RUNTIME_ENV_KEYS = new Set([
  "BUN_INSTALL",
  "NODE_PATH",
  "NODE_OPTIONS",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_SHARE_VIEWER_URL",
  "WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE",
  "WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT",
  "WEAVE_PI_HOST_MODULE_PROOF",
  "WEAVE_HOME",
  "WEAVE_CONFIG",
  "WEAVE_CONFIG_PATH",
  "WEAVE_DATA_HOME",
  "WEAVE_STATE_HOME",
  "WEAVE_SESSION_DIR",
  "WEAVE_SESSION_ID",
]);
/** Graceful and forced cleanup windows are intentionally short and fixed. */
export const CLEANUP_GRACE_TIMEOUT_MS = 1_000;
export const CLEANUP_FORCE_TIMEOUT_MS = 1_000;

/**
 * Cleanup failures are closed codes. Paths, process output, and host errors
 * never cross this boundary.
 */
export const CLEANUP_DIAGNOSTIC_CODES = [
  "root-not-owned",
  "process-observation-failed",
  "process-graceful-timeout",
  "process-force-timeout",
  "process-survivor",
  "lease-observation-failed",
  "active-lease",
  "active-pane",
  "active-fixture",
  "active-child",
  "active-pi",
  "root-remove-failed",
  "root-still-present",
  "resource-dispose-failed",
  "resource-still-open",
] as const;
export type CleanupDiagnosticCode = (typeof CLEANUP_DIAGNOSTIC_CODES)[number];

/**
 * Report values are deliberately closed. A diagnostic is a code, not a copy
 * of a host, provider, or cleanup message.
 */
export const REPORT_DIAGNOSTIC_CODES = [
  "real-pi-tui",
  "isolated-home",
  "strict-npm-provenance",
  "packed-artifact",
  "bounded-timeout",
  "ephemeral-report",
] as const;
export type ReportDiagnosticCode = (typeof REPORT_DIAGNOSTIC_CODES)[number];
export const REPORT_OUTCOME_CODES = [
  "fallback-confirmed",
  "legacy-settlement",
] as const;
export type ReportOutcomeCode = (typeof REPORT_OUTCOME_CODES)[number];

/** These values stay in the ephemeral fixture and are never copied to a report. */
export const PROVIDER_FAILURE_MARKER =
  "PI_MODEL_FAILOVER_SMOKE_PROVIDER_FAILURE_7f1e";
export const RECOVERY_MARKER = "PI_MODEL_FAILOVER_SMOKE_RECOVERY_9d2a";
export const PARENT_TASK = "PI_MODEL_FAILOVER_SMOKE_PARENT_TASK";
export const ROLLBACK_TASK = "PI_MODEL_FAILOVER_SMOKE_ROLLBACK_TASK";
export const CHILD_TASK = "PI_MODEL_FAILOVER_SMOKE_CHILD_TASK";
export const FALLBACK_SUCCESS = "PI_MODEL_FAILOVER_SMOKE_FALLBACK_SUCCESS";
const ROLLBACK_SHIM_FILENAME = "rollback-shim.js";
export const ROLLBACK_DISABLED_SURFACE = "callable-send-message" as const;
export const ROLLBACK_SHIM_BOUNDARY = "extension-factory-proxy" as const;
const ROLLBACK_REQUIRED_DELEGATION_SURFACES = [
  "registerCommand",
  "getCommands",
  "on",
  "sendUserMessage",
  "appendEntry",
  "getActiveTools",
  "setActiveTools",
  "registerTool",
  "setModel",
] as const;
const ORIGINAL_USER = "PI_MODEL_FAILOVER_SMOKE_ORIGINAL_USER_31a7";
const STEERING_USER = "PI_MODEL_FAILOVER_SMOKE_STEERING_USER_4c2b";
const FOLLOW_UP_USER = "PI_MODEL_FAILOVER_SMOKE_FOLLOW_UP_USER_8e19";
const QUEUED_USER = "PI_MODEL_FAILOVER_SMOKE_QUEUED_USER_6d44";
const UNRELATED_CUSTOM_TYPE = "trusted-extension.note";
const ORIGINAL_TASK_ID = "task-1";
const ORIGINAL_USER_ID = "user-1";
const STEERING_USER_ID = "steering-1";
const FOLLOW_UP_USER_ID = "follow-up-1";
const QUEUED_USER_ID = "queued-user-1";
const PARENT_TOOL_CALL_ID = "smoke-parent-tool-call";
const CHILD_TOOL_CALL_ID = "smoke-child-tool-call";

export const FIXTURE_CONTEXT_FACTS = [
  "original-task-user",
  "original-user",
  "tool-call",
  "tool-result",
  "steering-user",
  "follow-up-user",
  "unrelated-custom",
  "failed-assistant",
  "recovery-marker",
  "successful-assistant",
  "queued-user",
] as const;
export type FixtureContextFact = (typeof FIXTURE_CONTEXT_FACTS)[number];

export const MAX_CONTEXT_DESCRIPTOR_COUNT = 64;
export const MAX_HISTORY_DESCRIPTOR_COUNT = 256;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V4_OCCURRENCE =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
const PACKAGE_NAME = "@weaveio/weave-adapter-pi";
const PACKAGE_VERSION = "0.0.1";
const FIXTURE_PACKAGE_NAME = "@weaveio/pi-model-fallback-smoke-fixture";
const FIXTURE_PACKAGE_VERSION = "1.0.0";
const UNSAFE_PROVENANCE_ENV = "WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE";
const SAFE_PATH_PREFIXES = ["/tmp/", "/private/tmp/"] as const;
const PI_NATIVE_THREAD_ENTRY_TYPE = "weave.child.thread";
const NATIVE_RECOVERY_MARKER_TYPE = "weave.model-fallback.recovery-marker";
const NATIVE_RECOVERY_ENTRY_TYPE = "weave.model-failover";
const HEALTH_MODE_PATTERN = /Weave adapter mode:\s*([^\r\n]*)/giu;
const HEALTH_ONLY_FACT_PATTERN = /health-only:\s*([^\r\n]*)/giu;
const HEALTH_SURFACE_GAP_PATTERN =
  /host surface gap:\s*([\s\S]*?)(?=\r?\n\s*(?:host surface gap:|child inspection:|overlay:)|$)/giu;
const RUNTIME_MODEL_FALLBACK_PROBE_REASONS = new Set([
  "agent-settled-registration-unsupported",
  "terminal-message-end-unsupported",
  "replacement-context-unsupported",
  "message-start-unsupported",
  "model-select-unsupported",
  "callable-set-model-unsupported",
  "callable-send-message-unsupported",
  "callable-idle-helper-unsupported",
  "callable-pending-message-helper-unsupported",
]);
const MAX_HEALTH_SURFACE_GAPS = 16;

type FailureBase = { readonly type: string; readonly detail?: string };
export type SmokeFailure =
  | (FailureBase & { readonly type: "InvalidInvocation" })
  | (FailureBase & { readonly type: "InvalidReportPath" })
  | (FailureBase & { readonly type: "WrongExpectedPiVersion" })
  | (FailureBase & { readonly type: "WrongPiVersion" })
  | (FailureBase & { readonly type: "ArtifactSourceRejected" })
  | (FailureBase & { readonly type: "ArtifactMissing" })
  | (FailureBase & { readonly type: "ArtifactDigestMismatch" })
  | (FailureBase & { readonly type: "ArtifactMalformed" })
  | (FailureBase & { readonly type: "StrictProvenanceViolation" })
  | (FailureBase & { readonly type: "PathIsolationViolation" })
  | (FailureBase & { readonly type: "CommandSpawnFailed" })
  | (FailureBase & { readonly type: "CommandFailed" })
  | (FailureBase & { readonly type: "CommandTimeout" })
  | (FailureBase & { readonly type: "CleanupFailed" })
  | (FailureBase & { readonly type: "CaptureMalformed" })
  | (FailureBase & { readonly type: "FixtureBoundaryViolation" })
  | (FailureBase & { readonly type: "UnexpectedEventCount" })
  | (FailureBase & { readonly type: "ProviderContextViolation" })
  | (FailureBase & { readonly type: "LeakedContent" })
  | (FailureBase & { readonly type: "ReportMalformed" })
  | (FailureBase & { readonly type: "ReportTooLarge" })
  | (FailureBase & { readonly type: "ReportWriteFailed" })
  | (FailureBase & { readonly type: "UnexpectedFailure" });

export interface SmokeCliArgs {
  readonly artifact: string;
  readonly expectedArtifactSha256: string;
  readonly expectedPiVersion: string;
  readonly smokeCase: SmokeCase;
  readonly reportPath: string;
  readonly timeoutMs: number;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface SpawnedProcessLike {
  readonly stdout: ReadableStream<Uint8Array> | null | undefined;
  readonly stderr: ReadableStream<Uint8Array> | null | undefined;
  readonly exited: Promise<number>;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly killed?: boolean;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type CleanupResourceKind =
  | "pi-tui"
  | "provider-fixture"
  | "child"
  | "helper"
  | "pty"
  | "fixture-server"
  | "file-handle"
  | "timer";

export interface CleanupClock {
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly cancel?: (wait: Promise<void>) => void;
}

export interface CleanupProcessHandle {
  readonly id: string;
  readonly kind: CleanupResourceKind;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly killed?: boolean;
  readonly exited: Promise<unknown>;
  readonly terminate?: (signal: "SIGTERM" | "SIGKILL") => void;
  readonly dispose?: () => void | Promise<void>;
}

export interface CleanupProcessObservation {
  readonly pids: readonly number[];
  readonly piTuiPids: readonly number[];
  readonly fixturePids: readonly number[];
  readonly childPids: readonly number[];
  readonly helperPids: readonly number[];
  readonly panePids: readonly number[];
}

export interface CleanupResourceTracker {
  readonly root: string;
  readonly ownedPaths: readonly string[];
  readonly processHandles: readonly CleanupProcessHandle[];
  readonly activeResourceCount: number;
  registerOwnedPath(path: string): boolean;
  registerProcess(handle: CleanupProcessHandle): () => void;
  registerDisposer(disposer: () => void | Promise<void>): () => void;
  registerTimer(disposer: () => void): () => void;
  disposeResources(): Promise<boolean>;
  pruneExited(): void;
  rememberCleanup(result: Result<CleanupVerification, SmokeFailure>): void;
  rememberedCleanup(): Result<CleanupVerification, SmokeFailure> | undefined;
  cleanupInFlight():
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined;
  rememberCleanupInFlight(
    promise: Promise<Result<CleanupVerification, SmokeFailure>>,
  ): void;
}

const CLEANUP_VERIFICATION_KEYS = [
  "noChildProcess",
  "noNativeChild",
  "noActiveLease",
  "noTemporaryPane",
  "noFixtureProcess",
  "noPiProcess",
  "noHelperProcess",
  "temporaryRootRemoved",
  "timersDisposed",
  "resourcesDisposed",
] as const;

export interface CleanupVerification {
  readonly noChildProcess: boolean;
  readonly noNativeChild: boolean;
  readonly noActiveLease: boolean;
  readonly noTemporaryPane: boolean;
  readonly noFixtureProcess: boolean;
  readonly noPiProcess: boolean;
  readonly noHelperProcess: boolean;
  readonly temporaryRootRemoved: boolean;
  readonly timersDisposed: boolean;
  readonly resourcesDisposed: boolean;
}

export interface CleanupHooks {
  readonly clock?: CleanupClock;
  readonly observeProcesses?: (input: {
    readonly root: string;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly tracker: CleanupResourceTracker;
    readonly timeoutMs: number;
  }) => Promise<Result<CleanupProcessObservation, CleanupDiagnosticCode>>;
  readonly observeLease?: (input: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    readonly tracker: CleanupResourceTracker;
  }) => Promise<Result<boolean, CleanupDiagnosticCode>>;
  readonly removeRoot?: (input: {
    readonly root: string;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    readonly tracker: CleanupResourceTracker;
  }) => Promise<Result<void, CleanupDiagnosticCode>>;
  readonly pathExists?: (
    path: string,
  ) => Promise<Result<boolean, CleanupDiagnosticCode>>;
}

export interface CleanupRootOptions {
  readonly tracker?: CleanupResourceTracker;
  readonly hooks?: CleanupHooks;
  readonly runtimeStatusCommand?: {
    readonly args: readonly string[];
    readonly cwd: string;
  };
}

export interface SpawnOptionsLike {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export type SpawnFactory = (
  args: readonly string[],
  options: SpawnOptionsLike,
) => SpawnedProcessLike;

export interface PackedArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly packageVersion: string;
  readonly extensionSha256: string;
  readonly entries: readonly TarEntry[];
}

export interface InstalledAdapterProvenance {
  readonly packageVersion: string;
  readonly extensionSha256: string;
  readonly packageRootMatched: boolean;
  readonly extensionHashMatched: boolean;
}

/** Safe, path-free provenance facts retained in the smoke report. */
export interface SmokeProvenance {
  readonly artifactUnchanged: boolean;
  readonly installedPackageVersion: string;
  readonly installedExtensionSha256: string;
  readonly loadedAdapterPackageVersion: string;
  readonly loadedAdapterExtensionSha256: string;
  readonly packageSourceProven: boolean;
  readonly packageRootMatched: boolean;
  readonly loadedExtensionHashMatched: boolean;
  readonly piPackageVersion: typeof EXACT_PI_VERSION;
}

/**
 * A descriptor contains structure only. Role, custom type, content shape,
 * complete-message fingerprint, and fixture correlation are all hashes. Raw
 * message content is never part of a persisted capture.
 */
export interface FixtureMessageDescriptor {
  readonly ordinal: number;
  readonly roleHash: string;
  readonly customTypeHash?: string;
  readonly contentShapeHash: string;
  readonly contentFingerprintHash: string;
  readonly contentBlockCount: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  /** Stable fixture-issued fact hash; dynamic marker correlation uses token hash. */
  readonly correlationHash?: string;
}

export interface FixtureHistoryDescriptor extends FixtureMessageDescriptor {
  /** Native JSONL record index, including the session header. */
  readonly entryIndex: number;
  readonly entryTypeHash: string;
}

export interface FixtureMarkerCorrelation {
  readonly failedAssistantOrdinal: number;
  readonly markerOrdinal: number;
  readonly failedAssistantEntryIndex: number;
  readonly markerEntryIndex: number;
  /** Count of non-context native records between the correlated entries. */
  readonly interveningNativeEntryCount: number;
  readonly failedAssistantFingerprintHash: string;
  /** Hash of the marker token. The token itself is never retained. */
  readonly markerTokenHash: string;
}

export interface FixtureDescriptorCounts {
  readonly descriptorCount: number;
  readonly userCount: number;
  readonly assistantCount: number;
  readonly toolResultCount: number;
  readonly customCount: number;
}

/** Facts the provider fixture may observe from one bounded request. */
export interface FixtureMessageFacts extends FixtureDescriptorCounts {
  readonly requestNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly messageCount: number;
  readonly contextHash: string;
  readonly descriptors: readonly FixtureMessageDescriptor[];
  readonly originalUserPresent: boolean;
  readonly taskPresent: boolean;
  readonly toolCallPresent: boolean;
  readonly toolResultPresent: boolean;
  readonly failedAssistantPresent: boolean;
  readonly recoveryMarkerPresent: boolean;
  readonly syntheticProviderUserMessagePresent: boolean;
}

/** The provider fixture's complete persisted capture. Nothing else belongs here. */
export interface FixtureProviderCapture {
  readonly schemaVersion: 1;
  readonly kind: "provider";
  readonly role: "parent" | "child";
  readonly requestCount: number;
  readonly requests: readonly FixtureMessageFacts[];
}

/** Facts observed by the read-only harness extension from real Pi events. */
export interface FixtureControlFacts {
  readonly schemaVersion: 1;
  readonly kind: "control";
  readonly role: "parent" | "child";
  /** Hash-only marker token observed at the exact marker message_start. */
  readonly markerTokenHash?: string;
  /** Hash-only terminal assistant evidence captured at message_end. */
  readonly failedAssistantFingerprintHash?: string;
  readonly failedAssistantShapeHash?: string;
  /** Process identity observed at the first and last public lifecycle events. */
  readonly processIdBeforeHash?: string;
  readonly processIdAfterHash?: string;
  /** Final process identity retained for compatibility with the snapshot view. */
  readonly processIdHash: string;
  /** Child identity comes from the authenticated child process environment. */
  readonly childIdBeforeHash?: string;
  readonly childIdAfterHash?: string;
  /** Final child identity retained for compatibility with the snapshot view. */
  readonly childIdHash?: string;
  readonly lifecycle: FixtureLifecycleFacts;
  readonly parentToolCallIdHash?: string;
  readonly parentToolEndCallIdHash?: string;
  readonly parentToolStartedAtMs?: number;
  readonly parentToolEndedAtMs?: number;
  readonly parentToolPendingMs?: number;
  readonly parentToolStartCount?: number;
  readonly parentToolEndCount?: number;
  readonly parentToolStartTimesMs?: readonly number[];
  readonly parentToolEndTimesMs?: readonly number[];
  readonly pendingMessageHelperPresent?: boolean;
  /** Hash-only evidence collected from Pi's normal command sourceInfo. */
  readonly adapterPackageVersion?: string;
  readonly adapterExtensionSha256?: string;
  readonly adapterPackageSourceProven?: boolean;
  readonly adapterPackageRootMatched?: boolean;
  readonly adapterExtensionHashMatched?: boolean;
}

export interface FixtureShimFacts {
  readonly schemaVersion: 1;
  readonly kind: "rollback-shim";
  readonly role: "parent" | "child";
  readonly phase: "before-adapter" | "after-adapter";
  readonly boundary: typeof ROLLBACK_SHIM_BOUNDARY;
  readonly disabledSurface: typeof ROLLBACK_DISABLED_SURFACE;
  readonly originalSurfacePresent: true;
  readonly disabledBeforeAdapterInitialization: true;
  readonly requiredDelegationSurfacesIntact: true;
  readonly adapterInitialized: boolean;
}

export interface FixtureHistoryFacts extends FixtureDescriptorCounts {
  readonly entryCount: number;
  readonly historyHash: string;
  readonly descriptors: readonly FixtureHistoryDescriptor[];
  readonly failedAssistantPresent: boolean;
  readonly recoveryMarkerPresent: boolean;
  readonly successfulAssistantPresent: boolean;
  readonly recoveryEntryPresent: boolean;
  /** Hash only; the marker token never enters the report. */
  readonly markerTokenHash?: string;
  readonly markerTokenValid?: boolean;
  /** Correlation and adjacency evidence derived from native records. */
  readonly markerCorrelation?: FixtureMarkerCorrelation;
}

/** Lifecycle facts are host observations, never provider-fixture state. */
export interface FixtureLifecycleFacts {
  readonly beforeAgentStartCount: number;
  readonly messageStartCount: number;
  readonly messageEndCount: number;
  readonly contextCount: number;
  readonly contextRepairCount: number;
  readonly contextRepairTimesMs: readonly number[];
  readonly modelSelectCount: number;
  readonly modelSelectTimesMs: readonly number[];
  readonly settlementCount: number;
  readonly settlementTimesMs: readonly number[];
  /** Exact `message_start` observations for the recovery marker. */
  readonly markerMessageStartCount: number;
  readonly markerMessageStartTimesMs: readonly number[];
  /** Compatibility spelling for the marker count. */
  readonly recoveryMarkerCount: number;
  readonly recoveryMarkerObserved: boolean;
  readonly appliedIdentity?: SafeModelIdentity;
}

/** A bounded host-surface diagnostic parsed from real `/weave:health` output. */
export interface HostSurfaceGapFact {
  readonly capability: string;
  readonly probe: string;
  readonly mode:
    | "health-only"
    | "custom-editor-fallback"
    | "feature-unavailable";
}

/** Bounded facts parsed from the real `/weave:health` TUI notification. */
export interface HealthFacts {
  /** Only the parser over the real Pi TUI may create this marker. */
  readonly source?: "real-pi-tui";
  readonly ready: boolean;
  readonly healthOnly: boolean;
  readonly hostSurfaceGaps?: readonly HostSurfaceGapFact[];
  readonly runtimeModelFallback?: HostSurfaceGapFact;
}

export interface SafeModelIdentity {
  readonly provider: string;
  readonly id: string;
}

/** Native history facts read by the smoke process after the real TUI exits. */
export interface NativeSessionObservation {
  readonly role: "parent" | "child";
  /** Session identity is read only from the native session header. */
  readonly sessionIdHash: string;
  readonly sessionIdBeforeHash?: string;
  readonly sessionIdAfterHash?: string;
  /** Read only from `weave.child.thread` metadata; never inferred from a path. */
  readonly threadIdHash?: string;
  readonly threadIdBeforeHash?: string;
  readonly threadIdAfterHash?: string;
  readonly history: FixtureHistoryFacts;
  readonly modelTransitions: number;
  readonly modelTransitionTimesMs: readonly number[];
  /** Native model_change identities; initial Pi records are not fallback proof. */
  readonly modelTransitionIdentities: readonly SafeModelIdentity[];
  readonly recoveryMarkerCount: number;
  readonly appliedIdentity?: SafeModelIdentity;
}

/** Host-assembled view used by assertions; it is not written by the fixture. */
export interface FixtureSnapshot {
  readonly schemaVersion: 1;
  readonly role: "parent" | "child";
  readonly processIdHash?: string;
  readonly processIdBeforeHash?: string;
  readonly processIdAfterHash?: string;
  readonly childIdHash?: string;
  readonly childIdBeforeHash?: string;
  readonly childIdAfterHash?: string;
  readonly sessionIdHash?: string;
  readonly sessionIdBeforeHash?: string;
  readonly sessionIdAfterHash?: string;
  readonly threadIdHash?: string;
  readonly threadIdBeforeHash?: string;
  readonly threadIdAfterHash?: string;
  readonly markerTokenHash?: string;
  readonly failedAssistantFingerprintHash?: string;
  readonly failedAssistantShapeHash?: string;
  readonly requestCount: number;
  readonly requests: readonly FixtureMessageFacts[];
  readonly history?: FixtureHistoryFacts;
  readonly lifecycle: FixtureLifecycleFacts;
  readonly parentToolCallIdHash?: string;
  readonly parentToolEndCallIdHash?: string;
  readonly parentToolStartedAtMs?: number;
  readonly parentToolEndedAtMs?: number;
  readonly parentToolPendingMs?: number;
  readonly parentToolStartCount?: number;
  readonly parentToolEndCount?: number;
  readonly parentToolStartTimesMs?: readonly number[];
  readonly parentToolEndTimesMs?: readonly number[];
  /** Derived from the observed host helper, never set by a fixture. */
  readonly optionalSurfaceDisabled?: boolean;
  /** Derived from the observed host settlement count, never set by a fixture. */
  readonly legacySettlement?: boolean;
}

export interface FallbackScenarioFacts {
  readonly processIdentityStable: boolean;
  readonly nativeSessionIdentityStable: boolean;
  readonly threadIdentityStable: boolean;
  readonly parentToolCallIdentityStable: boolean;
  readonly providerRequest: FixtureMessageFacts;
  readonly durableHistory: FixtureHistoryFacts;
  readonly lifecycle: FixtureLifecycleFacts;
  readonly visibleEventCount: number;
  readonly cardAppliedIdentity: SafeModelIdentity;
  readonly nativeLine: typeof EXPECTED_NATIVE_LINE;
  readonly parentPendingIntervalMs: number;
  readonly parentSettlementCount: 1;
  readonly cleanup: CleanupVerification;
}

export interface RollbackScenarioFacts {
  readonly optionalSurfaceDisabled: true;
  readonly healthReady: true;
  readonly healthOnly: false;
  readonly legacySettlementCount: 1;
  readonly fallbackAttempted: false;
  readonly cleanup: CleanupVerification;
}

export interface SmokeReport {
  readonly schemaVersion: 1;
  readonly checklistVersion: typeof CHECKLIST_VERSION;
  readonly artifact: {
    readonly packageName: typeof PACKAGE_NAME;
    readonly packageVersion: string;
    readonly sha256: string;
  };
  readonly pi: {
    readonly expectedVersion: typeof EXACT_PI_VERSION;
    readonly observedVersion: typeof EXACT_PI_VERSION;
  };
  readonly provenance?: SmokeProvenance;
  readonly fallback?: FallbackScenarioFacts;
  readonly rollback?: RollbackScenarioFacts;
  readonly diagnostics: readonly ReportDiagnosticCode[];
}

/**
 * The only shape that can cross the report-writing boundary. The projection
 * adds closed outcomes and replaces the human-facing Native Line with an
 * outcome code. It never exposes provider bodies, message content, tokens, or
 * command output.
 */
export type SanitizedFallbackScenarioFacts = Omit<
  FallbackScenarioFacts,
  "nativeLine"
> & {
  readonly nativeLine: "model-fallback";
  readonly outcome: "fallback-confirmed";
};
export type SanitizedRollbackScenarioFacts = RollbackScenarioFacts & {
  readonly outcome: "legacy-settlement";
};
export interface SanitizedSmokeReport {
  readonly schemaVersion: 1;
  readonly checklistVersion: typeof CHECKLIST_VERSION;
  readonly artifact: {
    readonly packageName: typeof PACKAGE_NAME;
    readonly packageVersion: typeof PACKAGE_VERSION;
    readonly sha256: string;
  };
  readonly pi: {
    readonly expectedVersion: typeof EXACT_PI_VERSION;
    readonly observedVersion: typeof EXACT_PI_VERSION;
  };
  readonly provenance?: SmokeProvenance;
  readonly fallback?: SanitizedFallbackScenarioFacts;
  readonly rollback?: SanitizedRollbackScenarioFacts;
  readonly diagnostics: readonly ReportDiagnosticCode[];
}

interface ScenarioPaths {
  readonly root: string;
  readonly home: string;
  readonly piHome: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly cacheHome: string;
  readonly stateHome: string;
  readonly sessionDir: string;
  readonly project: string;
  readonly capture: string;
  readonly packagePath: string;
  readonly fixturePath: string;
  readonly piCli: string;
  readonly piCliPackageRoot: string;
  readonly piCliPackageVersion: typeof EXACT_PI_VERSION;
  readonly bunCli: string;
  readonly expectCli: string;
}

interface ScenarioObservation {
  readonly output: string;
  readonly provenance?: SmokeProvenance;
  /** Parsed only from the real `/weave:health` command output. */
  readonly health?: HealthFacts;
  /** Counted from the bounded PTY output, not from a fixture marker. */
  readonly visibleEventCount?: number;
  /** Host-assembled snapshots from provider capture, control capture, and native files. */
  readonly captures: readonly FixtureSnapshot[];
  readonly providerCaptures: readonly FixtureProviderCapture[];
  readonly nativeSessions: readonly NativeSessionObservation[];
  readonly controls: readonly FixtureControlFacts[];
  /** Optional boundary captures; rollback requires the two real shim phases. */
  readonly shims?: readonly FixtureShimFacts[];
  /** Verified by CleanupResourceTracker, never inferred from TUI text. */
  readonly cleanup?: CleanupVerification;
  /** Compatibility field retained for the report contract. */
  readonly temporaryRootRemoved: boolean;
}

function failure<T extends SmokeFailure["type"]>(
  type: T,
  detail?: string,
): SmokeFailure {
  return detail === undefined ? { type } : { type, detail };
}

export function artifactDigest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function hashDescriptorPart(namespace: string, value: string): string {
  return artifactDigest(new TextEncoder().encode(`${namespace}:${value}`));
}

export function fixtureCorrelationHash(fact: FixtureContextFact): string {
  return hashDescriptorPart("fixture-correlation", fact);
}

export function fixtureRoleHash(
  role: "user" | "assistant" | "toolResult" | "custom",
): string {
  return hashDescriptorPart("fixture-role", role);
}

export function fixtureCustomTypeHash(customType: string): string {
  return hashDescriptorPart("fixture-custom-type", customType);
}

export function fixtureEntryTypeHash(
  entryType: "message" | "custom_message" | "custom",
): string {
  return hashDescriptorPart("fixture-entry-type", entryType);
}

export function fixtureMarkerTokenHash(token: string): string {
  return hashDescriptorPart("marker-token", token);
}

const EXPECTED_PROVIDER_FACTS: readonly FixtureContextFact[] = [
  "original-task-user",
  "original-user",
  "tool-call",
  "tool-result",
  "steering-user",
  "follow-up-user",
  "unrelated-custom",
  "queued-user",
];
const EXPECTED_HISTORY_FACTS: readonly FixtureContextFact[] = [
  "original-task-user",
  "original-user",
  "tool-call",
  "tool-result",
  "steering-user",
  "follow-up-user",
  "unrelated-custom",
  "failed-assistant",
  "recovery-marker",
  "successful-assistant",
  "queued-user",
];

const FACT_ROLES: Readonly<
  Record<FixtureContextFact, "user" | "assistant" | "toolResult" | "custom">
> = {
  "original-task-user": "user",
  "original-user": "user",
  "tool-call": "assistant",
  "tool-result": "toolResult",
  "steering-user": "user",
  "follow-up-user": "user",
  "unrelated-custom": "custom",
  "failed-assistant": "assistant",
  "recovery-marker": "custom",
  "successful-assistant": "assistant",
  "queued-user": "user",
};

const FACT_CUSTOM_TYPES: Partial<Record<FixtureContextFact, string>> = {
  "unrelated-custom": UNRELATED_CUSTOM_TYPE,
  "recovery-marker": NATIVE_RECOVERY_MARKER_TYPE,
};
const FACT_PROVIDER_ROLES: Readonly<
  Record<FixtureContextFact, "user" | "assistant" | "toolResult" | "custom">
> = {
  ...FACT_ROLES,
  // Pi converts custom_message entries to provider-level user messages. The
  // correlation hash still identifies this as real custom history, not a
  // synthetic user entry.
  "unrelated-custom": "user",
};

export function fixtureDescriptorForFact(
  fact: FixtureContextFact,
  ordinal: number,
  overrides: Partial<FixtureMessageDescriptor> = {},
): FixtureMessageDescriptor {
  const role = FACT_ROLES[fact];
  const customType = FACT_CUSTOM_TYPES[fact];
  return {
    ordinal,
    roleHash: fixtureRoleHash(role),
    ...(customType === undefined
      ? {}
      : { customTypeHash: fixtureCustomTypeHash(customType) }),
    contentShapeHash: hashDescriptorPart("fixture-shape", fact),
    contentFingerprintHash: hashDescriptorPart("fixture-fingerprint", fact),
    contentBlockCount: 1,
    toolCallCount: fact === "tool-call" ? 1 : 0,
    toolResultCount: fact === "tool-result" ? 1 : 0,
    correlationHash: fixtureCorrelationHash(fact),
    ...overrides,
  };
}

export function fixtureHistoryDescriptorForFact(
  fact: FixtureContextFact,
  ordinal: number,
  entryIndex: number,
  overrides: Partial<FixtureHistoryDescriptor> = {},
): FixtureHistoryDescriptor {
  const entryType =
    fact === "unrelated-custom" || fact === "recovery-marker"
      ? "custom_message"
      : "message";
  return {
    ...fixtureDescriptorForFact(fact, ordinal, overrides),
    entryIndex,
    entryTypeHash: fixtureEntryTypeHash(entryType),
    ...overrides,
  };
}

function descriptorCounts(
  descriptors: readonly FixtureMessageDescriptor[],
): FixtureDescriptorCounts {
  const userRole = fixtureRoleHash("user");
  const assistantRole = fixtureRoleHash("assistant");
  const toolResultRole = fixtureRoleHash("toolResult");
  const customRole = fixtureRoleHash("custom");
  return {
    descriptorCount: descriptors.length,
    userCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === userRole,
    ).length,
    assistantCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === assistantRole,
    ).length,
    toolResultCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === toolResultRole,
    ).length,
    customCount: descriptors.filter(
      (descriptor) => descriptor.roleHash === customRole,
    ).length,
  };
}

function boundText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function safeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return boundText(
    raw
      .replaceAll(
        /(secret|token|password|credential|authorization|api[-_]?key)\s*[:=]\s*\S+/giu,
        "[redacted]",
      )
      .replaceAll(
        /(secret|token|password|credential|authorization|api[-_]?key)/giu,
        "[redacted]",
      )
      .replaceAll(/(?:\/|\\)Users(?:\/|\\)\S+/gu, "[path-redacted]"),
    MAX_DIAGNOSTIC_LENGTH,
  );
}

export function redactDiagnostic(value: string): string {
  return safeDiagnostic(value);
}

export function containsForbiddenContent(
  value: string,
  forbidden: readonly string[],
): boolean {
  return forbidden.some(
    (needle) => needle.length > 0 && value.includes(needle),
  );
}

const DEFAULT_REPORT_FORBIDDEN_CONTENT = [
  PROVIDER_FAILURE_MARKER,
  RECOVERY_MARKER,
  PARENT_TASK,
  ROLLBACK_TASK,
  CHILD_TASK,
  FALLBACK_SUCCESS,
  ORIGINAL_USER,
  STEERING_USER,
  FOLLOW_UP_USER,
  QUEUED_USER,
  UNRELATED_CUSTOM_TYPE,
  NATIVE_RECOVERY_MARKER_TYPE,
  NATIVE_RECOVERY_ENTRY_TYPE,
  "provider unavailable",
  "pi-model-fallback-fixture-key",
] as const;

const REPORT_SAFE_KEYS = new Set([
  "schemaVersion",
  "checklistVersion",
  "artifact",
  "packageName",
  "packageVersion",
  "sha256",
  "provenance",
  "artifactUnchanged",
  "installedPackageVersion",
  "installedExtensionSha256",
  "loadedAdapterPackageVersion",
  "loadedAdapterExtensionSha256",
  "packageSourceProven",
  "packageRootMatched",
  "loadedExtensionHashMatched",
  "piPackageVersion",
  "pi",
  "expectedVersion",
  "observedVersion",
  "fallback",
  "rollback",
  "diagnostics",
  "outcome",
  "processIdentityStable",
  "nativeSessionIdentityStable",
  "threadIdentityStable",
  "parentToolCallIdentityStable",
  "providerRequest",
  "durableHistory",
  "lifecycle",
  "visibleEventCount",
  "cardAppliedIdentity",
  "nativeLine",
  "parentPendingIntervalMs",
  "parentSettlementCount",
  "cleanup",
  "noChildProcess",
  "noNativeChild",
  "noActiveLease",
  "noTemporaryPane",
  "noFixtureProcess",
  "noPiProcess",
  "noHelperProcess",
  "temporaryRootRemoved",
  "timersDisposed",
  "resourcesDisposed",
  "requestNumber",
  "provider",
  "model",
  "messageCount",
  "contextHash",
  "descriptors",
  "descriptorCount",
  "userCount",
  "assistantCount",
  "toolResultCount",
  "customCount",
  "originalUserPresent",
  "taskPresent",
  "toolCallPresent",
  "toolResultPresent",
  "failedAssistantPresent",
  "recoveryMarkerPresent",
  "syntheticProviderUserMessagePresent",
  "ordinal",
  "roleHash",
  "customTypeHash",
  "contentShapeHash",
  "contentFingerprintHash",
  "contentBlockCount",
  "toolCallCount",
  "toolResultCount",
  "correlationHash",
  "entryCount",
  "historyHash",
  "successfulAssistantPresent",
  "recoveryEntryPresent",
  "markerTokenHash",
  "markerTokenValid",
  "markerCorrelation",
  "failedAssistantOrdinal",
  "markerOrdinal",
  "failedAssistantEntryIndex",
  "markerEntryIndex",
  "interveningNativeEntryCount",
  "failedAssistantFingerprintHash",
  "entryIndex",
  "entryTypeHash",
  "beforeAgentStartCount",
  "messageStartCount",
  "messageEndCount",
  "contextCount",
  "contextRepairCount",
  "contextRepairTimesMs",
  "modelSelectCount",
  "modelSelectTimesMs",
  "settlementCount",
  "settlementTimesMs",
  "markerMessageStartCount",
  "markerMessageStartTimesMs",
  "recoveryMarkerCount",
  "recoveryMarkerObserved",
  "appliedIdentity",
  "id",
  "optionalSurfaceDisabled",
  "healthReady",
  "healthOnly",
  "legacySettlementCount",
  "fallbackAttempted",
]);

const REPORT_FORBIDDEN_KEY_PATTERN =
  /(?:api[-_ ]?key|assistant|body|command|content|control|credential|details|error|home|message|output|path|payload|password|request|secret|text|token|tool|type|user)/iu;
const REPORT_FORBIDDEN_TEXT_PATTERNS = [
  /PI_MODEL_FAILOVER_SMOKE/iu,
  /pi-model-fallback-fixture-key/iu,
  /(?:api[-_ ]?key|secret|token|password|credential|authorization|bearer)/iu,
  /(?:^|[\\/])(?:private[\\/])?(?:tmp|Users|home|var|Volumes)(?:[\\/]|$)/u,
  /^[A-Za-z]:[\\/]/u,
  /\.(?:tgz|tar\.gz)$/iu,
  /(?:provider|raw[-_ ]?provider)[-_ ]?(?:request|body|error|response|output)/iu,
  /(?:assistant|user|tool)[-_ ]?(?:text|content|message|output|request|body)/iu,
  /"(?:messages?|content|body|tool(?:Call|Result)?|assistant|user|error(?:Message)?)"\s*:/iu,
  /(?:control|child[-_ ]control)[-_ ]?(?:payload|body|envelope)/iu,
  /(?:rm|kill|chmod|mv)[ ]+-[A-Za-z]/iu,
  /(?:unauthorized|forbidden|rate[- ]limit|service unavailable|connection refused|provider unavailable)/iu,
];

function reportMalformed(detail = "report schema is invalid"): SmokeFailure {
  return failure("ReportMalformed", detail);
}

function reportTooLarge(detail = "report exceeds a fixed bound"): SmokeFailure {
  return failure("ReportTooLarge", detail);
}

type ReportDataEntry = readonly [PropertyKey, unknown];

/**
 * Read only data descriptors. This is intentionally separate from JSON.stringify:
 * JSON serialization invokes getters, proxies, and toJSON hooks before it can
 * reject them. The report boundary must not execute untrusted report data.
 */
function safeReportDataEntries(
  value: object,
): Result<readonly ReportDataEntry[], SmokeFailure> {
  try {
    const descriptorMap = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptorMap);
    const keyLimit = Array.isArray(value)
      ? MAX_REPORT_ARRAY_LENGTH + 1
      : MAX_REPORT_OBJECT_KEYS;
    if (keys.length > keyLimit)
      return err(reportTooLarge("report object has too many keys"));
    const entries: ReportDataEntry[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(descriptorMap, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "object" ||
        descriptor.value === null
      ) {
        return err(reportMalformed());
      }
      const source = descriptor.value as PropertyDescriptor;
      if (
        source.get !== undefined ||
        source.set !== undefined ||
        !("value" in source)
      ) {
        return err(reportMalformed("report contains an accessor"));
      }
      if (!source.enumerable && key !== "length")
        return err(reportMalformed("report contains a non-enumerable key"));
      entries.push([key, source.value]);
    }
    return ok(entries);
  } catch {
    return err(reportMalformed("report descriptor inspection failed"));
  }
}

function inspectReportGraph(report: unknown): Result<void, SmokeFailure> {
  const active = new WeakSet<object>();
  let nodeCount = 0;
  const visit = (value: unknown, depth: number): Result<void, SmokeFailure> => {
    if (typeof value === "string") {
      if (value.length > MAX_REPORT_STRING_LENGTH)
        return err(reportTooLarge("report contains an overlong string"));
      return ok(undefined);
    }
    if (value === null || typeof value === "boolean") return ok(undefined);
    if (typeof value === "number") {
      return Number.isFinite(value)
        ? ok(undefined)
        : err(reportMalformed("report contains a non-finite number"));
    }
    if (typeof value !== "object")
      return err(reportMalformed("report contains an unsupported value"));
    if (depth > 12) return err(reportTooLarge("report nesting is too deep"));
    if (active.has(value)) return err(reportMalformed("report is cyclic"));
    nodeCount += 1;
    if (nodeCount > 2_048)
      return err(reportTooLarge("report contains too many values"));
    let prototype: object | null;
    let array = false;
    try {
      prototype = Object.getPrototypeOf(value);
      array = Array.isArray(value);
    } catch {
      return err(reportMalformed("report object inspection failed"));
    }
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype)
    ) {
      return err(reportMalformed("report contains an unsupported object"));
    }
    const entries = safeReportDataEntries(value);
    if (entries.isErr()) return err(entries.error);
    active.add(value);
    if (array) {
      const lengthEntry = entries.value.find(([key]) => key === "length");
      if (lengthEntry === undefined || typeof lengthEntry[1] !== "number") {
        active.delete(value);
        return err(reportMalformed("report array length is invalid"));
      }
      const length = lengthEntry[1];
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_REPORT_ARRAY_LENGTH
      ) {
        active.delete(value);
        return err(reportTooLarge("report array is outside its bound"));
      }
      const indexes = new Set<number>();
      for (const [key, child] of entries.value) {
        if (key === "length") continue;
        if (typeof key !== "string") {
          active.delete(value);
          return err(reportMalformed("report contains a symbol key"));
        }
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key ||
          indexes.has(index)
        ) {
          active.delete(value);
          return err(reportMalformed("report array contains an extra key"));
        }
        indexes.add(index);
        const childResult = visit(child, depth + 1);
        if (childResult.isErr()) {
          active.delete(value);
          return err(childResult.error);
        }
      }
      if (indexes.size !== length) {
        active.delete(value);
        return err(reportMalformed("report array contains a hole"));
      }
      active.delete(value);
      return ok(undefined);
    }
    if (entries.value.length > MAX_REPORT_OBJECT_KEYS) {
      active.delete(value);
      return err(reportTooLarge("report object is outside its bound"));
    }
    for (const [key, child] of entries.value) {
      if (typeof key !== "string") {
        active.delete(value);
        return err(reportMalformed("report contains a symbol key"));
      }
      const childResult = visit(child, depth + 1);
      if (childResult.isErr()) {
        active.delete(value);
        return err(childResult.error);
      }
    }
    active.delete(value);
    return ok(undefined);
  };
  const inspected = visit(report, 0);
  if (inspected.isErr()) return err(inspected.error);
  const cloned = Result.fromThrowable(
    () => structuredClone(report),
    () => reportMalformed("report contains a proxy or unclonable value"),
  )();
  return cloned.isErr() ? err(cloned.error) : ok(undefined);
}

function reportStringHasForbiddenContent(
  value: string,
  forbidden: readonly string[],
): boolean {
  if (containsForbiddenContent(value, forbidden)) return true;
  if (UUID_V4.test(value) || UUID_V4_OCCURRENCE.test(value)) return true;
  return REPORT_FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function scanReportForForbiddenContent(
  report: unknown,
  forbidden: readonly string[],
): Result<void, SmokeFailure> {
  const active = new WeakSet<object>();
  const scan = (value: unknown): Result<void, SmokeFailure> => {
    if (typeof value === "string") {
      const isDiagnostic = (
        REPORT_DIAGNOSTIC_CODES as readonly string[]
      ).includes(value);
      if (
        containsForbiddenContent(value, forbidden) ||
        (!isDiagnostic && reportStringHasForbiddenContent(value, forbidden))
      )
        return err(
          failure("LeakedContent", "report contains forbidden content"),
        );
      return ok(undefined);
    }
    if (value === null || typeof value !== "object") return ok(undefined);
    if (active.has(value)) return err(reportMalformed("report is cyclic"));
    active.add(value);
    const entries = safeReportDataEntries(value);
    if (entries.isErr()) {
      active.delete(value);
      return err(entries.error);
    }
    for (const [key, child] of entries.value) {
      if (
        typeof key === "string" &&
        (containsForbiddenContent(key, forbidden) ||
          (!REPORT_SAFE_KEYS.has(key) &&
            REPORT_FORBIDDEN_KEY_PATTERN.test(key)))
      ) {
        active.delete(value);
        return err(
          failure("LeakedContent", "report contains forbidden fields"),
        );
      }
      const childResult = scan(child);
      if (childResult.isErr()) {
        active.delete(value);
        return err(childResult.error);
      }
    }
    active.delete(value);
    return ok(undefined);
  };
  return scan(report);
}

function strictReportRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Result<Record<string, unknown>, SmokeFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return err(reportMalformed());
  const entries = safeReportDataEntries(value);
  if (entries.isErr()) return err(entries.error);
  const allowed = new Set([...required, ...optional]);
  const present = new Set<string>();
  for (const [key] of entries.value) {
    if (typeof key !== "string" || !allowed.has(key))
      return err(reportMalformed("report contains an extra key"));
    present.add(key);
  }
  for (const key of required) {
    if (!present.has(key)) return err(reportMalformed("report key is missing"));
  }
  return ok(value as Record<string, unknown>);
}

function reportValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
  } catch {
    return undefined;
  }
}

function reportExact(
  value: unknown,
  expected: string | number | boolean,
): Result<void, SmokeFailure> {
  return value === expected ? ok(undefined) : err(reportMalformed());
}

function reportBoolean(value: unknown): Result<boolean, SmokeFailure> {
  return typeof value === "boolean"
    ? ok(value)
    : err(reportMalformed("report boolean is invalid"));
}

function reportCount(
  value: unknown,
  maximum = MAX_REPORT_INTEGER,
): Result<number, SmokeFailure> {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? ok(value)
    : err(reportMalformed("report count is not a bounded safe integer"));
}

function reportHash(value: unknown): Result<string, SmokeFailure> {
  return typeof value === "string" && SHA256.test(value)
    ? ok(value)
    : err(reportMalformed("report hash is invalid"));
}

const CANONICAL_REPORT_IDENTITY = /^[a-z0-9](?:[a-z0-9._:/-]{0,63})$/u;
const NON_IDENTITY_REPORT_WORD =
  /(?:^|[._:/-])(?:assistant|body|credential|error|forbidden|password|rate|request|secret|timeout|token|tool|unauthorized|unavailable|user)(?:$|[._:/-])/u;
function reportIdentity(value: unknown): Result<string, SmokeFailure> {
  return typeof value === "string" &&
    value.length <= MAX_REPORT_STRING_LENGTH &&
    CANONICAL_REPORT_IDENTITY.test(value) &&
    !NON_IDENTITY_REPORT_WORD.test(value)
    ? ok(value)
    : err(reportMalformed("provider or model identity is invalid"));
}

function reportArray(value: unknown): Result<readonly unknown[], SmokeFailure> {
  if (!Array.isArray(value) || value.length > MAX_REPORT_ARRAY_LENGTH)
    return err(reportMalformed("report array is invalid"));
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor))
      return err(reportMalformed("report array is sparse"));
    values.push(descriptor.value);
  }
  return ok(values);
}

function validateReportIdentity(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, ["provider", "id"]);
  if (record.isErr()) return err(record.error);
  const provider = reportIdentity(reportValue(record.value, "provider"));
  if (provider.isErr()) return err(provider.error);
  const id = reportIdentity(reportValue(record.value, "id"));
  return id.isErr() ? err(id.error) : ok(undefined);
}

function validateReportDescriptor(
  value: unknown,
  history: boolean,
): Result<void, SmokeFailure> {
  const required = [
    "ordinal",
    "roleHash",
    "contentShapeHash",
    "contentFingerprintHash",
    "contentBlockCount",
    "toolCallCount",
    "toolResultCount",
  ];
  const optional = ["customTypeHash", "correlationHash"];
  if (history) required.push("entryIndex", "entryTypeHash");
  const record = strictReportRecord(value, required, optional);
  if (record.isErr()) return err(record.error);
  for (const key of [
    "ordinal",
    "contentBlockCount",
    "toolCallCount",
    "toolResultCount",
    ...(history ? ["entryIndex"] : []),
  ]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  for (const key of [
    "roleHash",
    "contentShapeHash",
    "contentFingerprintHash",
    ...(history ? ["entryTypeHash"] : []),
  ]) {
    const hash = reportHash(reportValue(record.value, key));
    if (hash.isErr()) return err(hash.error);
  }
  for (const key of ["customTypeHash", "correlationHash"]) {
    if (reportValue(record.value, key) !== undefined) {
      const hash = reportHash(reportValue(record.value, key));
      if (hash.isErr()) return err(hash.error);
    }
  }
  return ok(undefined);
}

function validateReportDescriptorArray(
  value: unknown,
  history: boolean,
): Result<void, SmokeFailure> {
  const descriptors = reportArray(value);
  if (descriptors.isErr()) return err(descriptors.error);
  const maximum = history
    ? MAX_HISTORY_DESCRIPTOR_COUNT
    : MAX_CONTEXT_DESCRIPTOR_COUNT;
  if (descriptors.value.length > maximum)
    return err(reportTooLarge("report descriptor count is outside its bound"));
  for (const descriptor of descriptors.value) {
    const result = validateReportDescriptor(descriptor, history);
    if (result.isErr()) return err(result.error);
  }
  return ok(undefined);
}

function validateReportDescriptorCounts(
  record: Record<string, unknown>,
): Result<void, SmokeFailure> {
  for (const key of [
    "descriptorCount",
    "userCount",
    "assistantCount",
    "toolResultCount",
    "customCount",
  ]) {
    const count = reportCount(reportValue(record, key));
    if (count.isErr()) return err(count.error);
  }
  return ok(undefined);
}

function validateReportMessageFacts(
  value: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "requestNumber",
    "provider",
    "model",
    "messageCount",
    "contextHash",
    "descriptors",
    "descriptorCount",
    "userCount",
    "assistantCount",
    "toolResultCount",
    "customCount",
    "originalUserPresent",
    "taskPresent",
    "toolCallPresent",
    "toolResultPresent",
    "failedAssistantPresent",
    "recoveryMarkerPresent",
    "syntheticProviderUserMessagePresent",
  ]);
  if (record.isErr()) return err(record.error);
  for (const key of ["requestNumber", "messageCount"]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  for (const key of ["provider", "model"]) {
    const identity = reportIdentity(reportValue(record.value, key));
    if (identity.isErr()) return err(identity.error);
  }
  const contextHash = reportHash(reportValue(record.value, "contextHash"));
  if (contextHash.isErr()) return err(contextHash.error);
  const descriptors = validateReportDescriptorArray(
    reportValue(record.value, "descriptors"),
    false,
  );
  if (descriptors.isErr()) return err(descriptors.error);
  const counts = validateReportDescriptorCounts(record.value);
  if (counts.isErr()) return err(counts.error);
  for (const key of [
    "originalUserPresent",
    "taskPresent",
    "toolCallPresent",
    "toolResultPresent",
    "failedAssistantPresent",
    "recoveryMarkerPresent",
    "syntheticProviderUserMessagePresent",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
  }
  return ok(undefined);
}

function validateReportMarkerCorrelation(
  value: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "failedAssistantOrdinal",
    "markerOrdinal",
    "failedAssistantEntryIndex",
    "markerEntryIndex",
    "interveningNativeEntryCount",
    "failedAssistantFingerprintHash",
    "markerTokenHash",
  ]);
  if (record.isErr()) return err(record.error);
  for (const key of [
    "failedAssistantOrdinal",
    "markerOrdinal",
    "failedAssistantEntryIndex",
    "markerEntryIndex",
    "interveningNativeEntryCount",
  ]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  for (const key of ["failedAssistantFingerprintHash", "markerTokenHash"]) {
    const hash = reportHash(reportValue(record.value, key));
    if (hash.isErr()) return err(hash.error);
  }
  return ok(undefined);
}

function validateReportHistoryFacts(
  value: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "entryCount",
      "historyHash",
      "descriptors",
      "descriptorCount",
      "userCount",
      "assistantCount",
      "toolResultCount",
      "customCount",
      "failedAssistantPresent",
      "recoveryMarkerPresent",
      "successfulAssistantPresent",
      "recoveryEntryPresent",
    ],
    ["markerTokenHash", "markerTokenValid", "markerCorrelation"],
  );
  if (record.isErr()) return err(record.error);
  const entryCount = reportCount(reportValue(record.value, "entryCount"));
  if (entryCount.isErr()) return err(entryCount.error);
  if (entryCount.value > MAX_HISTORY_DESCRIPTOR_COUNT)
    return err(reportTooLarge("report native history exceeds its bound"));
  const historyHash = reportHash(reportValue(record.value, "historyHash"));
  if (historyHash.isErr()) return err(historyHash.error);
  const descriptors = validateReportDescriptorArray(
    reportValue(record.value, "descriptors"),
    true,
  );
  if (descriptors.isErr()) return err(descriptors.error);
  const counts = validateReportDescriptorCounts(record.value);
  if (counts.isErr()) return err(counts.error);
  for (const key of [
    "failedAssistantPresent",
    "recoveryMarkerPresent",
    "successfulAssistantPresent",
    "recoveryEntryPresent",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
  }
  if (reportValue(record.value, "markerTokenHash") !== undefined) {
    const hash = reportHash(reportValue(record.value, "markerTokenHash"));
    if (hash.isErr()) return err(hash.error);
  }
  if (reportValue(record.value, "markerTokenValid") !== undefined) {
    const boolean = reportBoolean(
      reportValue(record.value, "markerTokenValid"),
    );
    if (boolean.isErr()) return err(boolean.error);
  }
  if (reportValue(record.value, "markerCorrelation") !== undefined) {
    const correlation = validateReportMarkerCorrelation(
      reportValue(record.value, "markerCorrelation"),
    );
    if (correlation.isErr()) return err(correlation.error);
  }
  return ok(undefined);
}

function validateReportLifecycle(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "beforeAgentStartCount",
      "messageStartCount",
      "messageEndCount",
      "contextCount",
      "contextRepairCount",
      "contextRepairTimesMs",
      "modelSelectCount",
      "modelSelectTimesMs",
      "settlementCount",
      "settlementTimesMs",
      "markerMessageStartCount",
      "markerMessageStartTimesMs",
      "recoveryMarkerCount",
      "recoveryMarkerObserved",
    ],
    ["appliedIdentity"],
  );
  if (record.isErr()) return err(record.error);
  for (const key of [
    "beforeAgentStartCount",
    "messageStartCount",
    "messageEndCount",
    "contextCount",
    "contextRepairCount",
    "modelSelectCount",
    "settlementCount",
    "markerMessageStartCount",
    "recoveryMarkerCount",
  ]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  const arrays: readonly (readonly [string, string])[] = [
    ["contextRepairTimesMs", "contextRepairCount"],
    ["modelSelectTimesMs", "modelSelectCount"],
    ["settlementTimesMs", "settlementCount"],
    ["markerMessageStartTimesMs", "markerMessageStartCount"],
  ];
  for (const [arrayKey, countKey] of arrays) {
    const values = reportArray(reportValue(record.value, arrayKey));
    if (values.isErr()) return err(values.error);
    const count = reportCount(reportValue(record.value, countKey));
    if (count.isErr()) return err(count.error);
    if (values.value.length !== count.value)
      return err(reportMalformed("lifecycle count does not match timestamps"));
    for (const timestamp of values.value) {
      const validTimestamp = reportCount(timestamp, MAX_REPORT_TIMESTAMP_MS);
      if (validTimestamp.isErr()) return err(validTimestamp.error);
    }
  }
  const markerCount = reportCount(
    reportValue(record.value, "markerMessageStartCount"),
  );
  const recoveryCount = reportCount(
    reportValue(record.value, "recoveryMarkerCount"),
  );
  if (markerCount.isErr() || recoveryCount.isErr())
    return err(reportMalformed());
  if (markerCount.value !== recoveryCount.value)
    return err(reportMalformed("marker lifecycle counts disagree"));
  const observed = reportBoolean(
    reportValue(record.value, "recoveryMarkerObserved"),
  );
  if (observed.isErr()) return err(observed.error);
  if (reportValue(record.value, "appliedIdentity") !== undefined) {
    const identity = validateReportIdentity(
      reportValue(record.value, "appliedIdentity"),
    );
    if (identity.isErr()) return err(identity.error);
  }
  return ok(undefined);
}

function validateReportCleanup(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "noChildProcess",
    "noNativeChild",
    "noActiveLease",
    "noTemporaryPane",
    "noFixtureProcess",
    "noPiProcess",
    "noHelperProcess",
    "temporaryRootRemoved",
    "timersDisposed",
    "resourcesDisposed",
  ]);
  if (record.isErr()) return err(record.error);
  for (const key of [
    "noChildProcess",
    "noNativeChild",
    "noActiveLease",
    "noTemporaryPane",
    "noFixtureProcess",
    "noPiProcess",
    "noHelperProcess",
    "temporaryRootRemoved",
    "timersDisposed",
    "resourcesDisposed",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
    if (!boolean.value) return err(reportMalformed("cleanup proof is false"));
  }
  return ok(undefined);
}

function validateReportFallback(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "processIdentityStable",
      "nativeSessionIdentityStable",
      "threadIdentityStable",
      "parentToolCallIdentityStable",
      "providerRequest",
      "durableHistory",
      "lifecycle",
      "visibleEventCount",
      "cardAppliedIdentity",
      "nativeLine",
      "parentPendingIntervalMs",
      "parentSettlementCount",
      "cleanup",
    ],
    ["outcome"],
  );
  if (record.isErr()) return err(record.error);
  for (const key of [
    "processIdentityStable",
    "nativeSessionIdentityStable",
    "threadIdentityStable",
    "parentToolCallIdentityStable",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
    if (!boolean.value)
      return err(reportMalformed("fallback identity proof is false"));
  }
  const provider = validateReportMessageFacts(
    reportValue(record.value, "providerRequest"),
  );
  if (provider.isErr()) return err(provider.error);
  const history = validateReportHistoryFacts(
    reportValue(record.value, "durableHistory"),
  );
  if (history.isErr()) return err(history.error);
  const lifecycle = validateReportLifecycle(
    reportValue(record.value, "lifecycle"),
  );
  if (lifecycle.isErr()) return err(lifecycle.error);
  const visible = reportCount(reportValue(record.value, "visibleEventCount"));
  if (visible.isErr()) return err(visible.error);
  if (visible.value !== EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT)
    return err(reportMalformed("fallback event count is not exact"));
  const identity = validateReportIdentity(
    reportValue(record.value, "cardAppliedIdentity"),
  );
  if (identity.isErr()) return err(identity.error);
  if (
    reportValue(record.value, "nativeLine") !== EXPECTED_NATIVE_LINE &&
    reportValue(record.value, "nativeLine") !== "model-fallback"
  )
    return err(reportMalformed("Native Line outcome is not closed"));
  if (reportValue(record.value, "outcome") !== undefined) {
    const outcome = reportExact(
      reportValue(record.value, "outcome"),
      "fallback-confirmed",
    );
    if (outcome.isErr()) return err(outcome.error);
  }
  const pending = reportCount(
    reportValue(record.value, "parentPendingIntervalMs"),
    MAX_COMMAND_TIMEOUT_MS,
  );
  if (pending.isErr()) return err(pending.error);
  const settlement = reportExact(
    reportValue(record.value, "parentSettlementCount"),
    1,
  );
  if (settlement.isErr()) return err(settlement.error);
  return validateReportCleanup(reportValue(record.value, "cleanup"));
}

function validateReportRollback(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "optionalSurfaceDisabled",
      "healthReady",
      "healthOnly",
      "legacySettlementCount",
      "fallbackAttempted",
      "cleanup",
    ],
    ["outcome"],
  );
  if (record.isErr()) return err(record.error);
  for (const [key, expected] of [
    ["optionalSurfaceDisabled", true],
    ["healthReady", true],
    ["healthOnly", false],
    ["fallbackAttempted", false],
  ] as const) {
    const result = reportExact(reportValue(record.value, key), expected);
    if (result.isErr()) return err(result.error);
  }
  const settlement = reportExact(
    reportValue(record.value, "legacySettlementCount"),
    1,
  );
  if (settlement.isErr()) return err(settlement.error);
  if (reportValue(record.value, "outcome") !== undefined) {
    const outcome = reportExact(
      reportValue(record.value, "outcome"),
      "legacy-settlement",
    );
    if (outcome.isErr()) return err(outcome.error);
  }
  return validateReportCleanup(reportValue(record.value, "cleanup"));
}

function validateReportProvenance(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "artifactUnchanged",
    "installedPackageVersion",
    "installedExtensionSha256",
    "loadedAdapterPackageVersion",
    "loadedAdapterExtensionSha256",
    "packageSourceProven",
    "packageRootMatched",
    "loadedExtensionHashMatched",
    "piPackageVersion",
  ]);
  if (record.isErr()) return err(record.error);
  if (reportExact(reportValue(record.value, "artifactUnchanged"), true).isErr())
    return err(reportMalformed("artifact was changed during the smoke"));
  for (const key of [
    "packageSourceProven",
    "packageRootMatched",
    "loadedExtensionHashMatched",
  ]) {
    if (reportExact(reportValue(record.value, key), true).isErr())
      return err(reportMalformed("loaded package provenance is not proven"));
  }
  const installedHash = reportHash(
    reportValue(record.value, "installedExtensionSha256"),
  );
  if (installedHash.isErr()) return err(installedHash.error);
  const loadedHash = reportHash(
    reportValue(record.value, "loadedAdapterExtensionSha256"),
  );
  if (loadedHash.isErr()) return err(loadedHash.error);
  if (installedHash.value !== loadedHash.value)
    return err(reportMalformed("installed and loaded adapter hashes disagree"));
  for (const key of [
    "installedPackageVersion",
    "loadedAdapterPackageVersion",
  ]) {
    if (reportExact(reportValue(record.value, key), PACKAGE_VERSION).isErr())
      return err(reportMalformed("installed adapter version is not exact"));
  }
  if (
    reportExact(
      reportValue(record.value, "piPackageVersion"),
      EXACT_PI_VERSION,
    ).isErr()
  )
    return err(reportMalformed("Pi package version is not exact"));
  return ok(undefined);
}

function validateReportShape(report: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    report,
    ["schemaVersion", "checklistVersion", "artifact", "pi", "diagnostics"],
    ["fallback", "rollback", "provenance"],
  );
  if (record.isErr()) return err(record.error);
  if (reportExact(reportValue(record.value, "schemaVersion"), 1).isErr())
    return err(reportMalformed());
  if (
    reportExact(
      reportValue(record.value, "checklistVersion"),
      CHECKLIST_VERSION,
    ).isErr()
  )
    return err(reportMalformed());
  const artifact = strictReportRecord(reportValue(record.value, "artifact"), [
    "packageName",
    "packageVersion",
    "sha256",
  ]);
  if (artifact.isErr()) return err(artifact.error);
  if (
    reportExact(
      reportValue(artifact.value, "packageName"),
      PACKAGE_NAME,
    ).isErr() ||
    reportExact(
      reportValue(artifact.value, "packageVersion"),
      PACKAGE_VERSION,
    ).isErr()
  )
    return err(reportMalformed("adapter version is not exact"));
  const digest = reportHash(reportValue(artifact.value, "sha256"));
  if (digest.isErr()) return err(digest.error);
  const pi = strictReportRecord(reportValue(record.value, "pi"), [
    "expectedVersion",
    "observedVersion",
  ]);
  if (pi.isErr()) return err(pi.error);
  if (
    reportExact(
      reportValue(pi.value, "expectedVersion"),
      EXACT_PI_VERSION,
    ).isErr() ||
    reportExact(
      reportValue(pi.value, "observedVersion"),
      EXACT_PI_VERSION,
    ).isErr()
  )
    return err(reportMalformed("Pi version is not exact"));
  const diagnostics = reportArray(reportValue(record.value, "diagnostics"));
  if (diagnostics.isErr()) return err(diagnostics.error);
  if (
    diagnostics.value.length === 0 ||
    diagnostics.value.length > MAX_DIAGNOSTIC_COUNT
  )
    return err(reportMalformed("diagnostic count is outside its bound"));
  const seenDiagnostics = new Set<string>();
  for (const diagnostic of diagnostics.value) {
    if (
      typeof diagnostic !== "string" ||
      !(REPORT_DIAGNOSTIC_CODES as readonly string[]).includes(diagnostic) ||
      seenDiagnostics.has(diagnostic)
    )
      return err(reportMalformed("diagnostic code is not allowlisted"));
    seenDiagnostics.add(diagnostic);
  }
  const provenance = reportValue(record.value, "provenance");
  if (provenance !== undefined) {
    const result = validateReportProvenance(provenance);
    if (result.isErr()) return err(result.error);
  }
  const fallback = reportValue(record.value, "fallback");
  const rollback = reportValue(record.value, "rollback");
  if (fallback === undefined && rollback === undefined)
    return err(reportMalformed("report contains no scenario outcome"));
  if (fallback !== undefined) {
    const result = validateReportFallback(fallback);
    if (result.isErr()) return err(result.error);
  }
  if (rollback !== undefined) {
    const result = validateReportRollback(rollback);
    if (result.isErr()) return err(result.error);
  }
  return ok(undefined);
}

function cloneReportData(value: unknown): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      result.push(cloneReportData(descriptor?.value));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = safeReportDataEntries(value);
    if (entries.isErr()) return result;
    for (const [key, child] of entries.value) {
      if (typeof key === "string") result[key] = cloneReportData(child);
    }
    return result;
  }
  return value;
}

function encodeSanitizedReport(
  report: SanitizedSmokeReport,
): Result<string, SmokeFailure> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(report),
    () => reportMalformed("sanitized report is not serializable"),
  )();
  if (serialized.isErr()) return err(serialized.error);
  const body = `${serialized.value}\n`;
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES)
    return err(reportTooLarge("encoded report exceeds the byte bound"));
  return ok(body);
}

/** Validate the input graph, then project it into the closed report schema. */
export function projectSanitizedSmokeReport(
  report: unknown,
  forbidden: readonly string[] = DEFAULT_REPORT_FORBIDDEN_CONTENT,
): Result<SanitizedSmokeReport, SmokeFailure> {
  const graph = inspectReportGraph(report);
  if (graph.isErr()) return err(graph.error);
  const leaks = scanReportForForbiddenContent(report, forbidden);
  if (leaks.isErr()) return err(leaks.error);
  const shape = validateReportShape(report);
  if (shape.isErr()) return err(shape.error);
  const cloned = cloneReportData(report) as SmokeReport;
  const projected: SanitizedSmokeReport = {
    schemaVersion: cloned.schemaVersion,
    checklistVersion: cloned.checklistVersion,
    artifact: {
      packageName: cloned.artifact.packageName,
      packageVersion: PACKAGE_VERSION,
      sha256: cloned.artifact.sha256,
    },
    pi: cloned.pi,
    ...(cloned.provenance === undefined
      ? {}
      : { provenance: cloned.provenance }),
    ...(cloned.fallback === undefined
      ? {}
      : {
          fallback: {
            ...cloned.fallback,
            nativeLine: "model-fallback" as const,
            outcome: "fallback-confirmed" as const,
          },
        }),
    ...(cloned.rollback === undefined
      ? {}
      : {
          rollback: {
            ...cloned.rollback,
            outcome: "legacy-settlement" as const,
          },
        }),
    diagnostics: cloned.diagnostics as readonly ReportDiagnosticCode[],
  };
  const encoded = encodeSanitizedReport(projected);
  return encoded.isErr() ? err(encoded.error) : ok(projected);
}

/** Compatibility name for callers that only need a safety verdict. */
export function validateReportSafety(
  report: unknown,
  forbidden: readonly string[] = DEFAULT_REPORT_FORBIDDEN_CONTENT,
): Result<SanitizedSmokeReport, SmokeFailure> {
  return projectSanitizedSmokeReport(report, forbidden);
}

export function serializeSmokeReport(
  report: unknown,
): Result<string, SmokeFailure> {
  const projected = projectSanitizedSmokeReport(report);
  if (projected.isErr()) return err(projected.error);
  return encodeSanitizedReport(projected.value);
}

function isEphemeralPath(path: string): boolean {
  const absolute = resolve(path);
  const temp = resolve(tmpdir());
  if (absolute === temp || absolute.startsWith(`${temp}/`)) return true;
  return SAFE_PATH_PREFIXES.some((prefix) => absolute.startsWith(prefix));
}

function containsPathControlCharacter(path: string): boolean {
  return path.split("").some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

export function validateEphemeralReportPath(
  path: string,
): Result<string, SmokeFailure> {
  if (
    !path ||
    containsPathControlCharacter(path) ||
    !isAbsolute(path) ||
    !isEphemeralPath(path)
  ) {
    return err(
      failure(
        "InvalidReportPath",
        "report must be an absolute path below the operating-system temporary directory",
      ),
    );
  }
  return ok(resolve(path));
}

/** Reject symlink escapes before the report writer opens a staging file. */
async function validateReportTargetPath(
  path: string,
): Promise<Result<string, SmokeFailure>> {
  const lexical = validateEphemeralReportPath(path);
  if (lexical.isErr()) return err(lexical.error);
  const target = lexical.value;
  const parentSymlink = await hasSymlinkAncestor(target);
  if (parentSymlink.isErr() || parentSymlink.value)
    return err(
      failure(
        "InvalidReportPath",
        "report path has a symlinked parent outside the temporary root",
      ),
    );
  const targetSymlink = await pathIsSymlink(target);
  if (targetSymlink.isErr() || targetSymlink.value)
    return err(
      failure(
        "InvalidReportPath",
        "report path must not be a symlink",
      ),
    );
  return ok(target);
}

export function verifyArtifactDigest(
  actual: string,
  expected: string,
): Result<string, SmokeFailure> {
  if (!SHA256.test(expected))
    return err(
      failure("ArtifactDigestMismatch", "expected digest is malformed"),
    );
  if (actual !== expected)
    return err(
      failure("ArtifactDigestMismatch", "packed artifact digest mismatch"),
    );
  return ok(actual);
}

export function validatePiVersion(
  output: string,
  expected: string = EXACT_PI_VERSION,
): Result<string, SmokeFailure> {
  const observed = output.trim();
  if (observed !== expected) {
    return err(
      failure(
        "WrongPiVersion",
        `expected ${boundText(expected, 64)}, observed ${boundText(observed || "empty", 64)}`,
      ),
    );
  }
  return ok(observed);
}

export function validateExpectedPiVersion(
  expected: string,
): Result<typeof EXACT_PI_VERSION, SmokeFailure> {
  if (expected !== EXACT_PI_VERSION)
    return err(
      failure(
        "WrongExpectedPiVersion",
        `only ${EXACT_PI_VERSION} is supported`,
      ),
    );
  return ok(EXACT_PI_VERSION);
}

function pathWithin(path: string, parent: string): boolean {
  const child = resolve(path);
  const root = resolve(parent);
  return child === root || child.startsWith(`${root}/`);
}

function safeAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !containsPathControlCharacter(path);
}

export interface IsolatedPathPolicyInput {
  readonly root: string;
  readonly paths: Readonly<Record<string, string>>;
  readonly forbiddenPaths?: readonly string[];
}

/**
 * Validate the lexical part of the disposable-root boundary before any
 * directory is created. Realpath checks are repeated after creation, so a
 * symlink cannot turn a valid-looking path into a developer-owned path.
 */
export function validateIsolatedPathPolicy(
  input: IsolatedPathPolicyInput,
): Result<Readonly<Record<string, string>>, SmokeFailure> {
  if (!safeAbsolutePath(input.root) || !isEphemeralPath(input.root))
    return err(
      failure(
        "PathIsolationViolation",
        "the smoke root must be an absolute temporary path",
      ),
    );
  const root = resolve(input.root);
  const entries = Object.entries(input.paths);
  const seen = new Set<string>([root]);
  for (const [name, path] of entries) {
    if (!safeAbsolutePath(path) || !pathWithin(path, root))
      return err(
        failure(
          "PathIsolationViolation",
          `${name} is outside the disposable smoke root`,
        ),
      );
    const normalized = resolve(path);
    if (seen.has(normalized))
      return err(
        failure("PathIsolationViolation", "isolated paths alias each other"),
      );
    seen.add(normalized);
  }
  for (const forbidden of input.forbiddenPaths ?? []) {
    if (!safeAbsolutePath(forbidden)) continue;
    for (const [name, path] of entries) {
      if (pathWithin(path, forbidden))
        return err(
          failure(
            "PathIsolationViolation",
            `${name} aliases a forbidden developer path`,
          ),
        );
    }
  }
  return ok({ ...input.paths });
}

async function canonicalExistingPath(
  path: string,
): Promise<Result<string, SmokeFailure>> {
  if (!safeAbsolutePath(path))
    return err(
      failure("PathIsolationViolation", "isolated path is not absolute"),
    );
  const executable = Bun.which("realpath") ?? "/bin/realpath";
  const result = await runBoundedCommand([executable, path], {
    cwd: tmpdir(),
    env: { PATH: SAFE_SYSTEM_PATH },
    timeoutMs: 2_000,
  });
  if (result.isErr() || result.value.stdout.trim().includes("\n"))
    return err(
      failure(
        "PathIsolationViolation",
        "isolated path could not be canonicalized",
      ),
    );
  const canonical = result.value.stdout.trim();
  if (!safeAbsolutePath(canonical))
    return err(
      failure("PathIsolationViolation", "canonical isolated path is invalid"),
    );
  return ok(resolve(canonical));
}

/**
 * Repeat the disposable-root check after paths exist. This catches a
 * symlinked parent or package directory that lexical checks cannot see.
 */
export async function validateCreatedIsolatedPathPolicy(
  input: IsolatedPathPolicyInput,
): Promise<Result<Readonly<Record<string, string>>, SmokeFailure>> {
  const lexical = validateIsolatedPathPolicy(input);
  if (lexical.isErr()) return err(lexical.error);
  const root = await canonicalExistingPath(input.root);
  if (root.isErr()) return err(root.error);
  const seen = new Set<string>([root.value]);
  const canonicalEntries = new Map<string, string>();
  for (const [name, path] of Object.entries(input.paths)) {
    const canonical = await canonicalExistingPath(path);
    if (canonical.isErr()) return err(canonical.error);
    if (!pathWithin(canonical.value, root.value))
      return err(
        failure(
          "PathIsolationViolation",
          `${name} resolves outside the disposable smoke root`,
        ),
      );
    if (seen.has(canonical.value))
      return err(
        failure("PathIsolationViolation", "isolated paths resolve to aliases"),
      );
    seen.add(canonical.value);
    canonicalEntries.set(name, canonical.value);
  }
  for (const forbidden of input.forbiddenPaths ?? []) {
    if (!safeAbsolutePath(forbidden)) continue;
    const exists = await ResultAsync.fromThrowable(
      () => Bun.file(forbidden).exists(),
      () => false,
    )();
    if (exists.isErr() || !exists.value) continue;
    const canonicalForbidden = await canonicalExistingPath(forbidden);
    if (canonicalForbidden.isErr()) return err(canonicalForbidden.error);
    for (const [name, canonical] of canonicalEntries) {
      if (pathWithin(canonical, canonicalForbidden.value))
        return err(
          failure(
            "PathIsolationViolation",
            `${name} resolves to a forbidden developer path`,
          ),
        );
    }
  }
  return ok({ ...input.paths });
}

function isForbiddenInheritedEnvironmentKey(key: string): boolean {
  if (FORBIDDEN_RUNTIME_ENV_KEYS.has(key)) return true;
  if (FORBIDDEN_ENV_KEY_PATTERN.test(key)) return true;
  return FORBIDDEN_PI_WEAVE_ENV_PATTERN.test(key);
}

export function validateStrictProvenanceEnvironment(
  env: Readonly<Record<string, string>>,
): Result<Readonly<Record<string, string>>, SmokeFailure> {
  if (env[UNSAFE_PROVENANCE_ENV] !== undefined) {
    return err(
      failure(
        "StrictProvenanceViolation",
        `${UNSAFE_PROVENANCE_ENV} must be absent`,
      ),
    );
  }
  const requiredPaths = [
    "HOME",
    XDG_CONFIG_ENV,
    XDG_DATA_ENV,
    XDG_CACHE_ENV,
    XDG_STATE_ENV,
    PI_AGENT_DIR_ENV,
    PI_SESSION_DIR_ENV,
    "PI_MODEL_SMOKE_CAPTURE_DIR",
    EXPECTED_PACKAGE_ROOT_ENV,
  ];
  for (const key of requiredPaths) {
    const value = env[key];
    if (value === undefined || !safeAbsolutePath(value))
      return err(
        failure(
          "StrictProvenanceViolation",
          `isolated environment value ${key} is missing`,
        ),
      );
  }
  if (!SHA256.test(env[EXPECTED_EXTENSION_SHA_ENV] ?? ""))
    return err(
      failure(
        "StrictProvenanceViolation",
        "isolated adapter extension digest is missing",
      ),
    );
  if (env[EXPECTED_PACKAGE_VERSION_ENV] !== PACKAGE_VERSION)
    return err(
      failure(
        "StrictProvenanceViolation",
        "isolated adapter version is invalid",
      ),
    );
  if (env[ADAPTER_SOURCE_PROVEN_ENV] !== "1")
    return err(
      failure(
        "StrictProvenanceViolation",
        "adapter source proof is not enabled",
      ),
    );
  for (const [key, value] of Object.entries(env)) {
    if (value.length === 0 && key !== "PATH")
      return err(
        failure(
          "StrictProvenanceViolation",
          "isolated environment has an empty value",
        ),
      );
    const isPiOrWeaveKey = /^(?:PI|WEAVE)_/iu.test(key);
    if (
      !SAFE_RUNTIME_ENV_KEYS.has(key) &&
      (isForbiddenInheritedEnvironmentKey(key) || isPiOrWeaveKey)
    )
      return err(
        failure(
          "StrictProvenanceViolation",
          "inherited Pi, Weave, or credential environment is present",
        ),
      );
  }
  const distinctPaths = [
    env.HOME,
    env[XDG_CONFIG_ENV],
    env[XDG_DATA_ENV],
    env[XDG_CACHE_ENV],
    env[XDG_STATE_ENV],
    env[PI_AGENT_DIR_ENV],
    env[PI_SESSION_DIR_ENV],
    env.PI_MODEL_SMOKE_CAPTURE_DIR,
  ];
  if (new Set(distinctPaths).size !== distinctPaths.length)
    return err(
      failure("PathIsolationViolation", "isolated home paths alias each other"),
    );
  return ok({ ...env });
}

export function buildPiLaunchCommand(input: {
  readonly bunCli: string;
  readonly piCli: string;
  readonly launcher?: string;
}): readonly string[] {
  return input.launcher === undefined
    ? [input.bunCli, input.piCli, "--offline"]
    : [input.launcher, "--offline"];
}

/** Compatibility alias used by release callers and focused tests. */
export const buildPiCommand = buildPiLaunchCommand;

export function buildExpectDriver(input: {
  readonly command: readonly string[];
  readonly doneMarker: string;
  /** Legacy startup synchronization. It has no synthetic default. */
  readonly readyMarker?: string;
  /** A real TUI command to run before the smoke task. */
  readonly healthCommand?: string;
  readonly healthMarker?: string;
  readonly task: string;
  readonly timeoutSeconds: number;
}): string {
  const quote = (value: string): string =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\\\''")}'`;
  const command = input.command.map(shellQuote).join(" ");
  const lines = [
    `set timeout ${Math.max(1, Math.floor(input.timeoutSeconds))}`,
    "log_user 1",
    `spawn /bin/sh -c "exec ${command}"`,
  ];
  if (input.readyMarker !== undefined) {
    lines.push(
      "expect {",
      `  -re "${quote(input.readyMarker)}" {}`,
      `  timeout { send "\\003"; exit 124 }`,
      "}",
    );
  }
  if (input.healthCommand !== undefined) {
    lines.push(
      `send "${quote(input.healthCommand)}\\r"`,
      "expect {",
      `  -re "${quote(input.healthMarker ?? "Weave adapter mode: (ready|health-only)")}" {}`,
      `  timeout { send "\\003"; exit 124 }`,
      "}",
    );
  }
  lines.push(
    `send "${quote(input.task)}\\r"`,
    "expect {",
    `  -re "${quote(input.doneMarker)}" { send "/quit\\r" }`,
    `  timeout { send "\\003"; exit 124 }`,
    "}",
    "expect eof",
    "catch wait result",
    "exit [lindex $result 3]",
    "",
  );
  return lines.join("\n");
}

export function parseSmokeArgs(
  argv: readonly string[],
): Result<SmokeCliArgs, SmokeFailure> {
  let artifact = "";
  let expectedArtifactSha256 = "";
  let expectedPiVersion: string = EXACT_PI_VERSION;
  let smokeCase: SmokeCase = "all";
  let reportPath = "";
  let timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--artifact" && value !== undefined) {
      artifact = value;
      index += 1;
    } else if (
      (key === "--artifact-sha256" ||
        key === "--expected-artifact-sha256" ||
        key === "--expected-adapter-sha256") &&
      value !== undefined
    ) {
      expectedArtifactSha256 = value;
      index += 1;
    } else if (key === "--expected-pi-version" && value !== undefined) {
      expectedPiVersion = value;
      index += 1;
    } else if (key === "--case" && value !== undefined) {
      if (!(SMOKE_CASES as readonly string[]).includes(value))
        return err(
          failure("InvalidInvocation", `unknown case ${safeDiagnostic(value)}`),
        );
      smokeCase = value as SmokeCase;
      index += 1;
    } else if (key === "--report" && value !== undefined) {
      reportPath = value;
      index += 1;
    } else if (key === "--timeout-ms" && value !== undefined) {
      const parsed = Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_COMMAND_TIMEOUT_MS
      )
        return err(
          failure("InvalidInvocation", "timeout is outside the bounded range"),
        );
      timeoutMs = parsed;
      index += 1;
    } else {
      return err(
        failure(
          "InvalidInvocation",
          `unknown or incomplete argument ${safeDiagnostic(key ?? "")}`,
        ),
      );
    }
  }

  if (!artifact || !expectedArtifactSha256 || !reportPath) {
    return err(
      failure(
        "InvalidInvocation",
        "usage: --artifact <packed-tarball> --artifact-sha256 <sha256> --expected-pi-version 0.84.2 --case <fallback|rollback|all> --report <ephemeral-path>",
      ),
    );
  }
  if (!safeAbsolutePath(artifact) || !artifact.endsWith(".tgz"))
    return err(
      failure(
        "InvalidInvocation",
        "artifact must be an absolute packed .tgz path",
      ),
    );
  if (!SHA256.test(expectedArtifactSha256))
    return err(failure("InvalidInvocation", "artifact digest must be sha256"));
  const version = validateExpectedPiVersion(expectedPiVersion);
  if (version.isErr()) return err(version.error);
  const report = validateEphemeralReportPath(reportPath);
  if (report.isErr()) return err(report.error);
  return ok({
    artifact,
    expectedArtifactSha256,
    expectedPiVersion: version.value,
    smokeCase,
    reportPath: report.value,
    timeoutMs,
  });
}

class CleanupResourceTrackerImpl implements CleanupResourceTracker {
  readonly root: string;
  private readonly owned = new Set<string>();
  private readonly processes = new Map<string, CleanupProcessHandle>();
  private readonly disposers = new Map<number, () => void | Promise<void>>();
  private readonly timers = new Map<number, () => void>();
  private nextDisposerId = 1;
  private remembered?: Result<CleanupVerification, SmokeFailure>;
  private inFlight?: Promise<Result<CleanupVerification, SmokeFailure>>;

  constructor(root: string) {
    this.root = resolve(root);
    this.owned.add(this.root);
  }

  get ownedPaths(): readonly string[] {
    return [...this.owned];
  }

  get processHandles(): readonly CleanupProcessHandle[] {
    return [...this.processes.values()];
  }

  get activeResourceCount(): number {
    return this.processes.size + this.disposers.size + this.timers.size;
  }

  registerOwnedPath(path: string): boolean {
    const absolute = resolve(path);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}/`))
      return false;
    this.owned.add(absolute);
    return true;
  }

  registerProcess(handle: CleanupProcessHandle): () => void {
    const id = this.processes.has(handle.id)
      ? `${handle.id}-${this.processes.size}`
      : handle.id;
    const stored = { ...handle, id };
    this.processes.set(id, stored);
    void handle.exited.then(
      () => {
        if (this.processes.get(id) === stored) this.processes.delete(id);
      },
      () => undefined,
    );
    return () => {
      this.processes.delete(id);
    };
  }

  registerDisposer(disposer: () => void | Promise<void>): () => void {
    const id = this.nextDisposerId;
    this.nextDisposerId += 1;
    this.disposers.set(id, disposer);
    return () => {
      this.disposers.delete(id);
    };
  }

  registerTimer(disposer: () => void): () => void {
    const id = this.nextDisposerId;
    this.nextDisposerId += 1;
    this.timers.set(id, disposer);
    return () => {
      this.timers.delete(id);
    };
  }

  async disposeResources(): Promise<boolean> {
    let disposed = true;
    for (const [id, disposer] of this.timers) {
      const result = await ResultAsync.fromThrowable(
        async () => disposer(),
        () => undefined,
      )();
      if (result.isErr()) disposed = false;
      this.timers.delete(id);
    }
    for (const [id, disposer] of this.disposers) {
      const result = await ResultAsync.fromThrowable(
        async () => disposer(),
        () => undefined,
      )();
      if (result.isErr()) disposed = false;
      this.disposers.delete(id);
    }
    for (const handle of this.processes.values()) {
      if (handle.dispose === undefined) continue;
      const result = await ResultAsync.fromThrowable(
        async () => handle.dispose?.(),
        () => undefined,
      )();
      if (result.isErr()) disposed = false;
    }
    return disposed && this.activeResourceCount === this.processes.size;
  }

  rememberCleanup(result: Result<CleanupVerification, SmokeFailure>): void {
    this.remembered = result;
  }

  rememberedCleanup(): Result<CleanupVerification, SmokeFailure> | undefined {
    return this.remembered;
  }

  cleanupInFlight():
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined {
    return this.inFlight;
  }

  rememberCleanupInFlight(
    promise: Promise<Result<CleanupVerification, SmokeFailure>>,
  ): void {
    this.inFlight = promise;
  }

  pruneExited(): void {
    for (const [id, handle] of this.processes) {
      if (handleExited(handle)) this.processes.delete(id);
    }
  }
}

export function createCleanupResourceTracker(
  root: string,
): CleanupResourceTracker {
  return new CleanupResourceTrackerImpl(root);
}

function handleExited(handle: CleanupProcessHandle): boolean {
  const process = handle as CleanupProcessHandle & {
    readonly exitCode?: number | null;
    readonly killed?: boolean;
  };
  return process.exitCode !== undefined && process.exitCode !== null;
}

function processHandleFor(
  child: SpawnedProcessLike,
  kind: CleanupResourceKind,
  dispose?: () => void | Promise<void>,
): CleanupProcessHandle {
  const id = `${kind}:${child.pid ?? crypto.randomUUID()}`;
  return {
    id,
    kind,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    ...(child.exitCode === undefined ? {} : { exitCode: child.exitCode }),
    ...(child.killed === undefined ? {} : { killed: child.killed }),
    exited: child.exited,
    terminate: (signal) => killQuietly(child, signal),
    ...(dispose === undefined ? {} : { dispose }),
  };
}

interface BoundedReader {
  readonly promise: Promise<string>;
  readonly cancel: () => void;
}

function startBoundedReader(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maximum: number,
): BoundedReader {
  if (stream === null || stream === undefined)
    return { promise: Promise.resolve(""), cancel: () => undefined };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;
  const promise = (async (): Promise<string> => {
    let text = "";
    let totalBytes = 0;
    try {
      while (!cancelled) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (text.length < maximum) {
          text += decoder.decode(next.value, { stream: true });
          if (text.length > maximum) text = text.slice(0, maximum);
        }
      }
    } catch {
      // A timeout cancels the reader. The command result is already bounded.
    } finally {
      reader.releaseLock();
    }
    if (totalBytes > maximum) return `${text}\n[output truncated]`;
    return text + decoder.decode();
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      void ResultAsync.fromPromise(reader.cancel(), () => undefined);
    },
  };
}

const defaultSpawn: SpawnFactory = (args, options) =>
  Bun.spawn([...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as SpawnedProcessLike;

function killQuietly(
  child: SpawnedProcessLike,
  signal: "SIGTERM" | "SIGKILL",
): void {
  Result.fromThrowable(
    () => child.kill(signal),
    () => undefined,
  )();
}

function signalPidQuietly(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  Result.fromThrowable(
    () => process.kill(pid, signal),
    () => undefined,
  )();
}

const cleanupTimers = new Map<Promise<void>, ReturnType<typeof setTimeout>>();
const realCleanupClock: CleanupClock = {
  wait: (milliseconds) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitPromise: Promise<void>;
    waitPromise = new Promise((resolveWait) => {
      timer = setTimeout(() => {
        cleanupTimers.delete(waitPromise);
        resolveWait();
      }, milliseconds);
    });
    if (timer !== undefined) cleanupTimers.set(waitPromise, timer);
    return waitPromise;
  },
  cancel: (waitPromise) => {
    const timer = cleanupTimers.get(waitPromise);
    if (timer === undefined) return;
    clearTimeout(timer);
    cleanupTimers.delete(waitPromise);
  },
};

async function waitForExit(
  exited: Promise<unknown>,
  milliseconds: number,
  clock: CleanupClock,
): Promise<boolean> {
  const timeout = clock.wait(milliseconds);
  const completed = await Promise.race([
    exited.then(
      () => true,
      () => false,
    ),
    timeout.then(() => false),
  ]);
  if (completed) clock.cancel?.(timeout);
  return completed;
}

async function waitForHandles(
  handles: readonly CleanupProcessHandle[],
  milliseconds: number,
  clock: CleanupClock,
): Promise<void> {
  const timeout = clock.wait(milliseconds);
  const completed = await Promise.race([
    Promise.all(
      handles.map((handle) =>
        handle.exited.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ).then(() => true),
    timeout.then(() => false),
  ]);
  if (completed) clock.cancel?.(timeout);
}

async function terminateHandle(
  handle: CleanupProcessHandle,
  clock: CleanupClock,
): Promise<boolean> {
  handle.terminate?.("SIGTERM");
  const graceful = await waitForExit(
    handle.exited,
    CLEANUP_GRACE_TIMEOUT_MS,
    clock,
  );
  if (graceful) return true;
  handle.terminate?.("SIGKILL");
  return waitForExit(handle.exited, CLEANUP_FORCE_TIMEOUT_MS, clock);
}

export async function runBoundedCommand(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs?: number;
    readonly spawn?: SpawnFactory;
    readonly resources?: CleanupResourceTracker;
    readonly processKind?: CleanupResourceKind;
    readonly clock?: CleanupClock;
    readonly allowExitCodes?: readonly number[];
  },
): Promise<Result<CommandResult, SmokeFailure>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const spawn = options.spawn ?? defaultSpawn;
  const started = Result.fromThrowable(
    () => spawn(args, { cwd: options.cwd, env: options.env }),
    () => failure("CommandSpawnFailed", "could not start bounded command"),
  )();
  if (started.isErr()) return err(started.error);
  const child = started.value;
  const stdout = startBoundedReader(child.stdout, MAX_CAPTURE_BYTES);
  const stderr = startBoundedReader(child.stderr, MAX_CAPTURE_BYTES);
  const disposeReaders = () => {
    stdout.cancel();
    stderr.cancel();
  };
  const handle = processHandleFor(
    child,
    options.processKind ?? "helper",
    disposeReaders,
  );
  const unregister = options.resources?.registerProcess(handle);
  const processResult: Promise<Result<CommandResult, SmokeFailure>> =
    Promise.all([stdout.promise, stderr.promise, child.exited]).then(
      ([stdoutText, stderrText, code]) => {
        return ok({
          code,
          stdout: stdoutText,
          stderr: stderrText,
          timedOut: false,
        });
      },
      () =>
        err(
          failure("CommandFailed", "bounded command exited without a status"),
        ),
    );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let unregisterTimeoutTimer: (() => void) | undefined;
  const clearCommandTimeout = (): void => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    unregisterTimeoutTimer?.();
    unregisterTimeoutTimer = undefined;
  };
  const timeoutResult = new Promise<"timeout">((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
    unregisterTimeoutTimer = options.resources?.registerTimer(() => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    });
  });
  const winner = await Promise.race([processResult, timeoutResult]);
  clearCommandTimeout();
  if (winner === "timeout") {
    disposeReaders();
    const clock = options.clock ?? realCleanupClock;
    const terminated = await terminateHandle(handle, clock);
    if (terminated) {
      unregister?.();
    }
    if (!terminated) return err(failure("CleanupFailed", "process-survivor"));
    return err(
      failure(
        "CommandTimeout",
        `bounded command exceeded ${timeoutMs}ms: ${basename(args[0] ?? "command")}`,
      ),
    );
  }
  disposeReaders();
  if (winner.isErr()) {
    if (options.resources === undefined) unregister?.();
    return err(winner.error);
  }
  unregister?.();
  if (
    winner.value.code !== 0 &&
    !(options.allowExitCodes ?? []).includes(winner.value.code)
  ) {
    return err(
      failure(
        "CommandFailed",
        `${basename(args[0] ?? "command")} exited ${winner.value.code}: ${safeDiagnostic(`${winner.value.stdout} ${winner.value.stderr}`)}`,
      ),
    );
  }
  return ok(winner.value);
}

export interface CleanupSignalSource {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
}

export async function runWithCleanup<T, E>(input: {
  readonly action: () => Promise<Result<T, E>>;
  readonly cleanup: () => Promise<Result<unknown, SmokeFailure>>;
  readonly signals?: CleanupSignalSource;
}): Promise<Result<T, E | SmokeFailure>> {
  let signalCleanup: Promise<Result<unknown, SmokeFailure>> | undefined;
  const requestCleanup = (): void => {
    if (signalCleanup !== undefined) return;
    signalCleanup = (async () => {
      const result = await ResultAsync.fromThrowable(input.cleanup, () =>
        failure("CleanupFailed", "resource-dispose-failed"),
      )();
      return result.isErr() ? err(result.error) : result.value;
    })();
  };
  const unregisterSignals =
    input.signals === undefined
      ? []
      : (["SIGINT", "SIGTERM"] as const).map((signal) =>
          input.signals?.on(signal, requestCleanup),
        );
  let actionResult: Result<T, E>;
  try {
    actionResult = await input.action();
  } catch (caught) {
    actionResult = err(caught as E);
  } finally {
    for (const unregister of unregisterSignals) unregister?.();
  }
  if (signalCleanup === undefined) requestCleanup();
  if (signalCleanup === undefined)
    return err(failure("CleanupFailed", "resource-dispose-failed"));
  const cleanupResult = await signalCleanup;
  if (cleanupResult.isErr()) return err(cleanupResult.error);
  return actionResult.isOk() ? ok(actionResult.value) : err(actionResult.error);
}

function parseManifest(
  entries: readonly TarEntry[],
): Result<{ readonly packageVersion: string }, SmokeFailure> {
  const manifestEntry = entries.find(
    (entry) => entry.path === "package/package.json",
  );
  const extension = entries.find(
    (entry) => entry.path === "package/dist/extension.js",
  );
  if (manifestEntry === undefined || extension === undefined)
    return err(
      failure("ArtifactMalformed", "packed adapter entrypoint is missing"),
    );
  const parsed = Result.fromThrowable(
    () =>
      JSON.parse(new TextDecoder().decode(manifestEntry.contents)) as unknown,
    () => failure("ArtifactMalformed", "package manifest is invalid"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    (parsed.value as { readonly name?: unknown }).name !== PACKAGE_NAME ||
    typeof (parsed.value as { readonly version?: unknown }).version !== "string"
  ) {
    return err(
      failure("ArtifactMalformed", "packed package identity is invalid"),
    );
  }
  return ok({
    packageVersion: (parsed.value as { readonly version: string }).version,
  });
}

const readlinkExecutable = (): string =>
  Bun.which("readlink") ??
  (process.platform === "win32" ? "" : "/bin/readlink");

async function pathIsSymlink(
  path: string,
): Promise<Result<boolean, SmokeFailure>> {
  const executable = readlinkExecutable();
  if (!executable)
    return err(
      failure("ArtifactSourceRejected", "symlink inspection is unavailable"),
    );
  const result = await runBoundedCommand([executable, path], {
    cwd: tmpdir(),
    env: { PATH: SAFE_SYSTEM_PATH },
    timeoutMs: 2_000,
    allowExitCodes: [1],
  });
  if (result.isErr()) return err(result.error);
  return ok(result.value.code === 0);
}

const ALLOWED_SYSTEM_SYMLINKS = new Set([
  "/tmp",
  "/private",
  "/private/tmp",
  "/var",
]);

async function hasSymlinkAncestor(
  path: string,
): Promise<Result<boolean, SmokeFailure>> {
  let current = dirname(resolve(path));
  while (current !== "/") {
    if (!ALLOWED_SYSTEM_SYMLINKS.has(current)) {
      const symlink = await pathIsSymlink(current);
      if (symlink.isErr()) return err(symlink.error);
      if (symlink.value) return ok(true);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ok(false);
}

async function regularNonSymlinkFile(
  path: string,
  missing: SmokeFailure["type"],
  rejected:
    | "ArtifactSourceRejected"
    | "StrictProvenanceViolation" = "ArtifactSourceRejected",
): Promise<Result<void, SmokeFailure>> {
  const symlink = await pathIsSymlink(path);
  if (symlink.isErr()) return err(symlink.error);
  if (symlink.value)
    return err(failure(rejected, "symlink artifact paths are forbidden"));
  const stats = await ResultAsync.fromThrowable(
    () => Bun.file(path).stat(),
    () => failure(missing, "artifact does not exist"),
  )();
  if (stats.isErr()) return err(stats.error);
  if (!stats.value.isFile())
    return err(failure(rejected, "artifact must be a regular file"));
  return ok(undefined);
}

export async function verifyArtifactFileUnchanged(
  path: string,
  expectedSha256: string,
): Promise<Result<string, SmokeFailure>> {
  if (!isAbsolute(path) || containsPathControlCharacter(path))
    return err(
      failure("ArtifactSourceRejected", "artifact path must be absolute"),
    );
  if (!path.endsWith(".tgz"))
    return err(
      failure("ArtifactSourceRejected", "only a packed .tgz is accepted"),
    );
  const parentSymlink = await hasSymlinkAncestor(path);
  if (parentSymlink.isErr()) return err(parentSymlink.error);
  if (parentSymlink.value)
    return err(
      failure("ArtifactSourceRejected", "artifact path has a symlink parent"),
    );
  const regular = await regularNonSymlinkFile(path, "ArtifactMissing");
  if (regular.isErr()) return err(regular.error);
  const bytes = await ResultAsync.fromThrowable(
    () => Bun.file(path).bytes(),
    () => failure("ArtifactMissing", "packed artifact could not be read"),
  )();
  if (bytes.isErr()) return err(bytes.error);
  return verifyArtifactDigest(artifactDigest(bytes.value), expectedSha256);
}

export async function inspectPackedArtifact(
  path: string,
  expectedSha256: string,
): Promise<Result<PackedArtifact, SmokeFailure>> {
  if (!isAbsolute(path) || containsPathControlCharacter(path))
    return err(
      failure(
        "ArtifactSourceRejected",
        "packed artifact path must be absolute",
      ),
    );
  const absolute = resolve(path);
  if (!absolute.endsWith(".tgz"))
    return err(
      failure("ArtifactSourceRejected", "only a packed .tgz is accepted"),
    );
  const parentSymlink = await hasSymlinkAncestor(absolute);
  if (parentSymlink.isErr()) return err(parentSymlink.error);
  if (parentSymlink.value)
    return err(
      failure("ArtifactSourceRejected", "artifact path has a symlink parent"),
    );
  const regular = await regularNonSymlinkFile(absolute, "ArtifactMissing");
  if (regular.isErr()) return err(regular.error);
  const bytesResult = await ResultAsync.fromThrowable(
    () => Bun.file(absolute).bytes(),
    () => failure("ArtifactMissing", "packed artifact could not be read"),
  )();
  if (bytesResult.isErr()) return err(bytesResult.error);
  const digest = artifactDigest(bytesResult.value);
  const verified = verifyArtifactDigest(digest, expectedSha256);
  if (verified.isErr()) return err(verified.error);
  const inspected = new TarInspector().inspect(bytesResult.value);
  if (inspected.isErr())
    return err(
      failure(
        "ArtifactMalformed",
        `tar inspection failed: ${inspected.error.type}`,
      ),
    );
  const manifest = parseManifest(inspected.value);
  if (manifest.isErr()) return err(manifest.error);
  const extension = inspected.value.find(
    (entry) => entry.path === "package/dist/extension.js",
  );
  if (extension === undefined)
    return err(
      failure("ArtifactMalformed", "packed extension entrypoint is missing"),
    );
  return ok({
    path: absolute,
    sha256: verified.value,
    packageVersion: manifest.value.packageVersion,
    extensionSha256: artifactDigest(extension.contents),
    entries: inspected.value,
  });
}

export interface VerifyInstalledAdapterInput {
  readonly packageRoot: string;
  readonly expectedPackageRoot: string;
  readonly expectedPackageName?: string;
  readonly expectedPackageVersion: string;
  readonly expectedExtensionSha256: string;
}

export async function verifyInstalledAdapterPackage(
  input: VerifyInstalledAdapterInput,
): Promise<Result<InstalledAdapterProvenance, SmokeFailure>> {
  if (
    !safeAbsolutePath(input.packageRoot) ||
    !safeAbsolutePath(input.expectedPackageRoot)
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root must be absolute",
      ),
    );
  const packageRoot = resolve(input.packageRoot);
  const expectedRoot = resolve(input.expectedPackageRoot);
  const rootSymlink = await pathIsSymlink(packageRoot);
  if (rootSymlink.isErr()) return err(rootSymlink.error);
  if (rootSymlink.value)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root is a symlink",
      ),
    );
  const rootStats = await ResultAsync.fromThrowable(
    () => Bun.file(packageRoot).stat(),
    () =>
      failure("StrictProvenanceViolation", "installed package root is missing"),
  )();
  if (rootStats.isErr()) return err(rootStats.error);
  if (!rootStats.value.isDirectory())
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root is not a directory",
      ),
    );
  const canonicalRoot = await canonicalExistingPath(packageRoot);
  const canonicalExpectedRoot = await canonicalExistingPath(expectedRoot);
  if (canonicalRoot.isErr() || canonicalExpectedRoot.isErr())
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root could not be canonicalized",
      ),
    );
  if (canonicalRoot.value !== canonicalExpectedRoot.value)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root resolves to an alias",
      ),
    );
  const manifestPath = join(packageRoot, "package.json");
  const extensionPath = join(packageRoot, "dist/extension.js");
  const manifestBytes = await ResultAsync.fromThrowable(
    () => Bun.file(manifestPath).bytes(),
    () =>
      failure(
        "StrictProvenanceViolation",
        "installed package manifest is missing",
      ),
  )();
  if (manifestBytes.isErr()) return err(manifestBytes.error);
  const manifest = Result.fromThrowable(
    () => JSON.parse(new TextDecoder().decode(manifestBytes.value)) as unknown,
    () =>
      failure(
        "StrictProvenanceViolation",
        "installed package manifest is invalid",
      ),
  )();
  if (manifest.isErr()) return err(manifest.error);
  if (
    typeof manifest.value !== "object" ||
    manifest.value === null ||
    (manifest.value as { readonly name?: unknown }).name !==
      (input.expectedPackageName ?? PACKAGE_NAME) ||
    (manifest.value as { readonly version?: unknown }).version !==
      input.expectedPackageVersion
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package identity is invalid",
      ),
    );
  const extensionRegular = await regularNonSymlinkFile(
    extensionPath,
    "StrictProvenanceViolation",
    "StrictProvenanceViolation",
  );
  if (extensionRegular.isErr()) return err(extensionRegular.error);
  const canonicalExtension = await canonicalExistingPath(extensionPath);
  if (canonicalExtension.isErr())
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed extension could not be canonicalized",
      ),
    );
  if (
    canonicalExtension.value !== join(canonicalRoot.value, "dist/extension.js")
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed extension resolves outside the package",
      ),
    );
  const extensionBytes = await ResultAsync.fromThrowable(
    () => Bun.file(extensionPath).bytes(),
    () =>
      failure("StrictProvenanceViolation", "installed extension is unreadable"),
  )();
  if (extensionBytes.isErr()) return err(extensionBytes.error);
  const extensionSha256 = artifactDigest(extensionBytes.value);
  if (!SHA256.test(input.expectedExtensionSha256))
    return err(
      failure(
        "StrictProvenanceViolation",
        "expected extension digest is invalid",
      ),
    );
  if (packageRoot !== expectedRoot)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed package root does not match the isolated root",
      ),
    );
  if (extensionSha256 !== input.expectedExtensionSha256)
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed extension digest does not match the packed artifact",
      ),
    );
  return ok({
    packageVersion: input.expectedPackageVersion,
    extensionSha256,
    packageRootMatched: true,
    extensionHashMatched: true,
  });
}

export interface PiCliProvenance {
  readonly packageRoot: string;
  readonly packageVersion: typeof EXACT_PI_VERSION;
}

export async function inspectPiCliProvenance(
  cliPath: string,
  options: {
    readonly expectedVersion?: string;
    readonly forbiddenPaths?: readonly string[];
  } = {},
): Promise<Result<PiCliProvenance, SmokeFailure>> {
  const expectedVersion = options.expectedVersion ?? EXACT_PI_VERSION;
  if (!safeAbsolutePath(cliPath) || cliPath.includes("$bunfs"))
    return err(
      failure("StrictProvenanceViolation", "Pi CLI path is not a file path"),
    );
  const absolute = resolve(cliPath);
  if (!absolute.endsWith("/dist/cli.js"))
    return err(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI is not the package CLI entrypoint",
      ),
    );
  const parentSymlink = await hasSymlinkAncestor(absolute);
  if (parentSymlink.isErr())
    return err(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI path could not be inspected",
      ),
    );
  if (parentSymlink.value)
    return err(
      failure("StrictProvenanceViolation", "Pi CLI path has a symlink parent"),
    );
  for (const forbidden of options.forbiddenPaths ?? []) {
    if (safeAbsolutePath(forbidden) && pathWithin(absolute, forbidden))
      return err(
        failure(
          "StrictProvenanceViolation",
          "Pi CLI resolves to a forbidden source path",
        ),
      );
  }
  const cliRegular = await regularNonSymlinkFile(
    absolute,
    "StrictProvenanceViolation",
    "StrictProvenanceViolation",
  );
  if (cliRegular.isErr()) return err(cliRegular.error);
  const packageRoot = resolve(dirname(dirname(absolute)));
  const packageRootSymlink = await pathIsSymlink(packageRoot);
  if (packageRootSymlink.isErr()) return err(packageRootSymlink.error);
  if (packageRootSymlink.value)
    return err(
      failure("StrictProvenanceViolation", "Pi package root is a symlink"),
    );
  const manifestBytes = await ResultAsync.fromThrowable(
    () => Bun.file(join(packageRoot, "package.json")).bytes(),
    () =>
      failure("StrictProvenanceViolation", "Pi package manifest is missing"),
  )();
  if (manifestBytes.isErr()) return err(manifestBytes.error);
  const parsed = Result.fromThrowable(
    () => JSON.parse(new TextDecoder().decode(manifestBytes.value)) as unknown,
    () =>
      failure("StrictProvenanceViolation", "Pi package manifest is invalid"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    (parsed.value as { readonly name?: unknown }).name !==
      "@earendil-works/pi-coding-agent" ||
    (parsed.value as { readonly version?: unknown }).version !== expectedVersion
  )
    return err(failure("WrongPiVersion", "Pi package identity is not exact"));
  const version = validateExpectedPiVersion(expectedVersion);
  if (version.isErr()) return err(version.error);
  return ok({ packageRoot, packageVersion: version.value });
}

export function validateLoadedAdapterProvenance(input: {
  readonly controls: readonly FixtureControlFacts[];
  readonly expectedPackageVersion: string;
  readonly expectedExtensionSha256: string;
}): Result<
  {
    readonly packageVersion: string;
    readonly extensionSha256: string;
    readonly packageSourceProven: boolean;
    readonly packageRootMatched: boolean;
    readonly extensionHashMatched: boolean;
  },
  SmokeFailure
> {
  if (input.controls.length === 0)
    return err(
      failure("StrictProvenanceViolation", "Pi emitted no adapter provenance"),
    );
  const first = input.controls[0];
  if (first === undefined)
    return err(
      failure("StrictProvenanceViolation", "Pi adapter provenance is missing"),
    );
  const values = input.controls;
  for (const control of values) {
    if (
      control.adapterPackageVersion !== input.expectedPackageVersion ||
      control.adapterExtensionSha256 === undefined ||
      !SHA256.test(control.adapterExtensionSha256) ||
      control.adapterPackageSourceProven !== true ||
      control.adapterPackageRootMatched !== true ||
      control.adapterExtensionHashMatched !== true
    )
      return err(
        failure(
          "StrictProvenanceViolation",
          "loaded adapter provenance is not exact",
        ),
      );
    if (control.adapterExtensionSha256 !== first.adapterExtensionSha256)
      return err(
        failure("StrictProvenanceViolation", "loaded adapter hashes disagree"),
      );
  }
  const extensionSha256 = first.adapterExtensionSha256;
  if (extensionSha256 === undefined)
    return err(
      failure("StrictProvenanceViolation", "loaded adapter hash is missing"),
    );
  if (extensionSha256 !== input.expectedExtensionSha256)
    return err(
      failure(
        "StrictProvenanceViolation",
        "loaded adapter digest does not match the packed artifact",
      ),
    );
  return ok({
    packageVersion: input.expectedPackageVersion,
    extensionSha256,
    packageSourceProven: true,
    packageRootMatched: true,
    extensionHashMatched: true,
  });
}

function shellSafePath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

async function commandOk(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<void, SmokeFailure>> {
  const result = await runBoundedCommand(args, {
    cwd,
    env,
    timeoutMs,
    resources,
  });
  return result.map(() => undefined);
}

async function makeDirectory(
  path: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<void, SmokeFailure>> {
  const made = await commandOk(
    ["mkdir", "-m", "700", "-p", path],
    cwd,
    env,
    timeoutMs,
    resources,
  );
  if (made.isErr()) return err(made.error);
  return commandOk(["chmod", "700", path], cwd, env, timeoutMs, resources);
}

function fixtureDescriptorSource(): string {
  const encoded = (value: string): string => JSON.stringify(value);
  return `
const MAX_DESCRIPTOR_COUNT = ${MAX_CONTEXT_DESCRIPTOR_COUNT};
const RECOVERY_MARKER = ${encoded(RECOVERY_MARKER)};
const NATIVE_RECOVERY_MARKER_TYPE = ${encoded(NATIVE_RECOVERY_MARKER_TYPE)};
const PARENT_TASK = ${encoded(PARENT_TASK)};
const ROLLBACK_TASK = ${encoded(ROLLBACK_TASK)};
const CHILD_TASK = ${encoded(CHILD_TASK)};
const ORIGINAL_USER = ${encoded(ORIGINAL_USER)};
const STEERING_USER = ${encoded(STEERING_USER)};
const FOLLOW_UP_USER = ${encoded(FOLLOW_UP_USER)};
const QUEUED_USER = ${encoded(QUEUED_USER)};
const FALLBACK_SUCCESS = ${encoded(FALLBACK_SUCCESS)};
const UNRELATED_CUSTOM_TYPE = ${encoded(UNRELATED_CUSTOM_TYPE)};
const ORIGINAL_TASK_ID = ${encoded(ORIGINAL_TASK_ID)};
const ORIGINAL_USER_ID = ${encoded(ORIGINAL_USER_ID)};
const STEERING_USER_ID = ${encoded(STEERING_USER_ID)};
const FOLLOW_UP_USER_ID = ${encoded(FOLLOW_UP_USER_ID)};
const QUEUED_USER_ID = ${encoded(QUEUED_USER_ID)};
const PARENT_TOOL_CALL_ID = ${encoded(PARENT_TOOL_CALL_ID)};
const CHILD_TOOL_CALL_ID = ${encoded(CHILD_TOOL_CALL_ID)};
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const descriptorDigest = (namespace, value) => digest(namespace + ":" + value);
const descriptorCorrelation = (fact) => descriptorDigest("fixture-correlation", fact);
const markerTokenDigest = (token) => descriptorDigest("marker-token", token);
const descriptorRoleDigest = (role) => descriptorDigest("fixture-role", role);
const descriptorCustomTypeDigest = (customType) => descriptorDigest("fixture-custom-type", customType);
const serializedDescriptorValue = (value) => {
  try { return JSON.stringify(value); } catch { return ""; }
};
const boundedText = (value) => value.length > 4096 ? value.slice(0, 4096) : value;
const textOf = (value) => {
  const values = Array.isArray(value) ? value : [value];
  let text = "";
  for (const item of values.slice(0, 64)) {
    if (typeof item === "string") text += item;
    else if (item && typeof item === "object" && typeof item.text === "string") text += item.text;
  }
  return boundedText(text);
};
const shapeOf = (value, depth = 0) => {
  if (depth > 5) return "depth";
  if (value === null) return "null";
  if (Array.isArray(value)) return {
    kind: "array",
    length: Math.min(value.length, 256),
    items: value.slice(0, 16).map((item) => shapeOf(item, depth + 1))
  };
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value).sort().slice(0, 64);
  return {
    kind: "object",
    keys: keys.map((key) => [key, shapeOf(value[key], depth + 1)])
  };
};
const classifyDescriptor = (entry, role, toolCallCount) => {
  const contentText = textOf(entry?.content);
  const contentBlocks = Array.isArray(entry?.content) ? entry.content : [entry?.content];
  const fixtureToolCall = contentBlocks.some((block) =>
    block && typeof block === "object" &&
    block.type === "toolCall" &&
    (block.id === PARENT_TOOL_CALL_ID || block.id === CHILD_TOOL_CALL_ID)
  );
  if (role === "user") {
    // Pi converts custom_message entries into provider-level user messages.
    // The fixture-issued marker in the content keeps that real entry
    // distinguishable from a synthetic user message after conversion.
    if (contentText.includes(UNRELATED_CUSTOM_TYPE)) return "unrelated-custom";
    if (contentText.includes(PARENT_TASK) || contentText.includes(ROLLBACK_TASK) || contentText.includes(CHILD_TASK) || entry?.id === ORIGINAL_TASK_ID) return "original-task-user";
    if (contentText.includes(ORIGINAL_USER) || entry?.id === ORIGINAL_USER_ID) return "original-user";
    if (contentText.includes(STEERING_USER) || entry?.id === STEERING_USER_ID) return "steering-user";
    if (contentText.includes(FOLLOW_UP_USER) || entry?.id === FOLLOW_UP_USER_ID) return "follow-up-user";
    if (contentText.includes(QUEUED_USER) || entry?.id === QUEUED_USER_ID) return "queued-user";
    return undefined;
  }
  if (role === "assistant") {
    if (entry?.stopReason === "error") return "failed-assistant";
    if (toolCallCount > 0 && fixtureToolCall) return "tool-call";
    if (contentText.includes(FALLBACK_SUCCESS)) return "successful-assistant";
    return undefined;
  }
  if (
    role === "toolResult" &&
    (entry?.toolCallId === PARENT_TOOL_CALL_ID ||
      entry?.toolCallId === CHILD_TOOL_CALL_ID)
  ) return "tool-result";
  if (role === "custom" && entry?.customType === UNRELATED_CUSTOM_TYPE) return "unrelated-custom";
  return undefined;
};
const describeEntry = (entry, ordinal, entryType = "message") => {
  const role = entry && typeof entry.role === "string"
    ? entry.role
    : entryType === "message" ? "unknown" : "custom";
  const content = entry?.content;
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
  const toolCallCount = blocks.filter((block) => block && typeof block === "object" && block.type === "toolCall").length;
  const toolResultCount = role === "toolResult" ? 1 : 0;
  const customType = typeof entry?.customType === "string" ? entry.customType : undefined;
  const markerToken = (customType === NATIVE_RECOVERY_MARKER_TYPE || customType === RECOVERY_MARKER) && entry?.details && typeof entry.details.token === "string"
    ? entry.details.token
    : undefined;
  const fact = classifyDescriptor(entry, role, toolCallCount);
  const correlationHash = markerToken === undefined
    ? (fact === undefined ? undefined : descriptorCorrelation(fact))
    : markerTokenDigest(markerToken);
  return {
    ordinal,
    roleHash: descriptorRoleDigest(role),
    ...(customType === undefined ? {} : { customTypeHash: descriptorCustomTypeDigest(customType) }),
    contentShapeHash: descriptorDigest("fixture-shape", serializedDescriptorValue({
      content: shapeOf(typeof content === "string" ? [{ type: "text", text: content }] : content),
      stopReason: entry?.stopReason,
      toolCallCount,
      toolResultCount
    })),
    contentFingerprintHash: descriptorDigest("fixture-fingerprint", boundedText(serializedDescriptorValue(entry))),
    contentBlockCount: Math.min(blocks.length, 256),
    toolCallCount: Math.min(toolCallCount, 256),
    toolResultCount,
    ...(correlationHash === undefined ? {} : { correlationHash })
  };
};
const descriptorCounts = (descriptors) => ({
  descriptorCount: descriptors.length,
  userCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("user")).length,
  assistantCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("assistant")).length,
  toolResultCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("toolResult")).length,
  customCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("custom")).length
});
const descriptorFacts = (descriptors) => {
  const knownUsers = new Set(["original-task-user", "original-user", "steering-user", "follow-up-user", "unrelated-custom", "queued-user"].map(descriptorCorrelation));
  const userDescriptors = descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("user"));
  const facts = descriptorCounts(descriptors);
  return {
    ...facts,
    originalUserPresent: facts.userCount > 0,
    taskPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("original-task-user")),
    toolCallPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("tool-call")),
    toolResultPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("tool-result")),
    failedAssistantPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("failed-assistant")),
    recoveryMarkerPresent: descriptors.some((descriptor) => descriptor.customTypeHash === descriptorCustomTypeDigest(NATIVE_RECOVERY_MARKER_TYPE)),
    syntheticProviderUserMessagePresent: userDescriptors.some((descriptor) => descriptor.correlationHash === undefined || !knownUsers.has(descriptor.correlationHash))
  };
};
`;
}

function fixtureSource(): string {
  return `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const role = typeof Bun.env.WEAVE_CHILD_ID === "string" ? "child" : "parent";
const childId = Bun.env.WEAVE_CHILD_ID;
const captureDir = Bun.env.PI_MODEL_SMOKE_CAPTURE_DIR ?? "";
const fileName = role === "child"
  ? "provider-child-" + (childId ?? "unknown").replaceAll(/[^A-Za-z0-9_-]/gu, "_") + ".json"
  : "provider-parent.json";
const capturePath = captureDir.length === 0 ? "" : captureDir + "/" + fileName;
const fixturePidPath = captureDir.length === 0 ? "" : captureDir + "/fixture-" + role + ".pid";
if (fixturePidPath.length > 0) await Bun.write(fixturePidPath, String(process.pid) + "\\n");
let requestCount = 0;
const requests = [];
let pendingPersist = Promise.resolve();
const digest = (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const serialized = (value) => { try { return JSON.stringify(value); } catch { return ""; } };
${fixtureDescriptorSource()}
const messagesFacts = (messages, model) => {
  const list = Array.isArray(messages) ? messages : [];
  const body = serialized(list);
  const descriptors = list.slice(0, MAX_DESCRIPTOR_COUNT).map((entry, index) => describeEntry(entry, index));
  const facts = descriptorFacts(descriptors);
  return {
    requestNumber: requestCount,
    provider: String(model?.provider ?? ""),
    model: String(model?.id ?? ""),
    messageCount: Math.min(list.length, 256),
    contextHash: digest(body),
    descriptors,
    ...facts
  };
};
const persist = () => {
  if (capturePath.length === 0) return pendingPersist;
  const snapshot = {
    schemaVersion: 1,
    kind: "provider",
    role,
    requestCount,
    requests: requests.slice(-8)
  };
  const body = JSON.stringify(snapshot);
  if (body.length <= ${MAX_CAPTURE_BYTES}) {
    pendingPersist = pendingPersist.then(() => Bun.write(capturePath, body + "\\n").then(() => undefined));
  }
  return pendingPersist;
};
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (model, content, stopReason, errorMessage) => ({
  role: "assistant", content, api: "openai-completions", provider: model.provider, model: model.id,
  usage: usage(), stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: Date.now()
});
const streamFor = (model, facts) => {
  const stream = createAssistantMessageEventStream();
  const pending = assistant(model, [], "pending");
  stream.push({ type: "start", partial: pending });
  if (facts.kind === "tool") {
    const toolCall = { type: "toolCall", id: facts.id, name: facts.name, arguments: facts.arguments };
    const partial = assistant(model, [toolCall], "pending");
    stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    stream.push({ type: "done", reason: "toolUse", message: assistant(model, [toolCall], "toolUse") });
    return stream;
  }
  if (facts.kind === "error") {
    const failed = assistant(model, [], "error", "provider unavailable");
    failed.status = 503;
    stream.push({ type: "error", reason: "error", error: failed });
    return stream;
  }
  const content = [{ type: "text", text: facts.text }];
  const partial = assistant(model, content, "pending");
  stream.push({ type: "text_start", contentIndex: 0, partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: facts.text, partial });
  stream.push({ type: "text_end", contentIndex: 0, content: facts.text, partial });
  stream.push({ type: "done", reason: "stop", message: assistant(model, content, "stop") });
  return stream;
};
const providerRequest = (model, requestContext) => {
  requestCount += 1;
  const contextMessages = Array.isArray(requestContext?.messages) ? requestContext.messages : [];
  const rollbackTaskPresent = contextMessages.some((entry) => textOf(entry?.content).includes(ROLLBACK_TASK));
  requests.push(messagesFacts(contextMessages, model));
  void persist();
  if (role === "parent" && requestCount === 1) {
    if (rollbackTaskPresent) return streamFor(model, { kind: "error" });
    return streamFor(model, { kind: "tool", id: "smoke-parent-tool-call", name: "weave_delegate", arguments: { agent: "shuttle", task: CHILD_TASK } });
  }
  if (role === "child" && requestCount === 1) {
    return streamFor(model, { kind: "tool", id: "smoke-child-tool-call", name: "read", arguments: { path: "README.md" } });
  }
  if (role === "child" && requestCount === 2) {
    return streamFor(model, { kind: "error" });
  }
  return streamFor(model, { kind: "text", text: role === "child" ? FALLBACK_SUCCESS : "PI_MODEL_FAILOVER_SMOKE_PARENT_SUCCESS" });
};

export default function smokeFixture(pi) {
  pi.registerProvider("smoke", {
    name: "Pi model-fallback smoke fixture",
    api: "openai-completions",
    baseUrl: "https://pi-model-fallback.invalid",
    apiKey: ${JSON.stringify(FIXTURE_CREDENTIAL)},
    models: [
      { id: "first", name: "Smoke first", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 },
      { id: "second", name: "Smoke second", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }
    ],
    streamSimple: providerRequest
  });
}
`;
}

/**
 * This extension is a read-only control observer. It does not return replacement
 * context, call a Pi control method, or write native history. The smoke process
 * reads this bounded event capture only as evidence of events emitted by Pi.
 */
function controlObserverSource(): string {
  return `
const role = typeof Bun.env.WEAVE_CHILD_ID === "string" ? "child" : "parent";
const childId = Bun.env.WEAVE_CHILD_ID;
const captureDir = Bun.env.PI_MODEL_SMOKE_CAPTURE_DIR ?? "";
const capturePath = captureDir.length === 0
  ? ""
  : captureDir + "/control-" + (role === "child" ? "child-" + (Bun.env.WEAVE_CHILD_ID ?? "unknown").replaceAll(/[^A-Za-z0-9_-]/gu, "_") : "parent") + ".json";
const piPidPath = captureDir.length === 0 ? "" : captureDir + "/pi-" + role + ".pid";
if (piPidPath.length > 0) await Bun.write(piPidPath, String(process.pid) + "\\n");
const digest = (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
${fixtureDescriptorSource()}
let beforeAgentStartCount = 0;
let messageStartCount = 0;
let messageEndCount = 0;
let contextCount = 0;
let contextRepairCount = 0;
let modelSelectCount = 0;
let settlementCount = 0;
let recoveryMarkerCount = 0;
let recoveryMarkerObserved = false;
let markerMessageStartSeen = false;
let processIdBeforeHash;
let processIdAfterHash;
let childIdBeforeHash;
let childIdAfterHash;
let appliedIdentity;
let modelSelectTimesMs = [];
let contextRepairTimesMs = [];
let markerMessageStartTimesMs = [];
let settlementTimesMs = [];
let parentToolCallId;
let parentToolEndCallId;
let parentToolStartedAtMs;
let parentToolEndedAtMs;
let parentToolPendingMs;
let parentToolStartCount = 0;
let parentToolEndCount = 0;
let parentToolStartTimesMs = [];
let parentToolEndTimesMs = [];
let pendingMessageHelperPresent;
let adapterPackageVersion;
let adapterExtensionSha256;
let adapterPackageSourceProven = false;
let adapterPackageRootMatched = false;
let adapterExtensionHashMatched = false;
let markerTokenHash;
let failedAssistantFingerprintHash;
let failedAssistantShapeHash;
let pendingPersist = Promise.resolve();
let piApi;
const now = () => Date.now();
const inspectAdapterProvenance = async () => {
  try {
    const expectedRoot = Bun.env.PI_MODEL_SMOKE_EXPECTED_PACKAGE_ROOT ?? "";
    const expectedHash = Bun.env.PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256 ?? "";
    const expectedVersion = Bun.env.PI_MODEL_SMOKE_EXPECTED_PACKAGE_VERSION ?? "";
    const commands = typeof piApi?.getCommands === "function" ? piApi.getCommands() : [];
    const command = Array.isArray(commands)
      ? commands.find((entry) => entry?.name === "weave:health")
      : undefined;
    const info = command?.sourceInfo;
    if (
      !info ||
      typeof info.path !== "string" ||
      !info.path.startsWith("/") ||
      typeof info.source !== "string" ||
      typeof info.origin !== "string"
    ) return;
    const sourcePath = info.path.replaceAll("\\\\", "/");
    const expectedExtensionPath = expectedRoot.replaceAll("\\\\", "/") + "/dist/extension.js";
    const expectedShimPath = expectedRoot.replaceAll("\\\\", "/") + "/dist/${ROLLBACK_SHIM_FILENAME}";
    if (sourcePath !== expectedExtensionPath && sourcePath !== expectedShimPath) return;
    const packageRoot = expectedRoot.replaceAll("\\\\", "/");
    const bytes = await Bun.file(expectedExtensionPath).bytes();
    const sourceHash = digest(bytes);
    const manifest = await Bun.file(packageRoot + "/package.json").json();
    const manifestRecord = manifest && typeof manifest === "object" ? manifest : {};
    adapterPackageVersion = typeof manifestRecord.version === "string" ? manifestRecord.version : undefined;
    adapterExtensionSha256 = sourceHash;
    adapterPackageRootMatched = packageRoot === expectedRoot.replaceAll("\\\\", "/");
    adapterPackageSourceProven =
      info.origin === "package" &&
      /^npm:@weaveio\\/weave-adapter-pi(?:@|$)/u.test(info.source) &&
      manifestRecord.name === "@weaveio/weave-adapter-pi" &&
      adapterPackageRootMatched;
    adapterExtensionHashMatched = sourceHash === expectedHash && expectedVersion === adapterPackageVersion;
  } catch {
    adapterPackageVersion = undefined;
    adapterExtensionSha256 = undefined;
    adapterPackageSourceProven = false;
    adapterPackageRootMatched = false;
    adapterExtensionHashMatched = false;
  }
};
const observeIdentityBefore = () => {
  if (processIdBeforeHash === undefined) processIdBeforeHash = digest(String(process.pid));
  if (role === "child" && typeof childId === "string" && childId.length > 0 && childIdBeforeHash === undefined) {
    childIdBeforeHash = digest(childId);
  }
};
const observeIdentityAfter = () => {
  processIdAfterHash = digest(String(process.pid));
  if (role === "child" && typeof childId === "string" && childId.length > 0) {
    childIdAfterHash = digest(childId);
  }
};
const markerValue = (value) => {
  if (value && typeof value === "object" && value.message && typeof value.message === "object") {
    return markerValue(value.message);
  }
  return value;
};
const markerToken = (value) => {
  const message = markerValue(value);
  return message && typeof message === "object" &&
    (message.customType === NATIVE_RECOVERY_MARKER_TYPE || message.customType === RECOVERY_MARKER) &&
    message.details && typeof message.details.token === "string" &&
    UUID_V4.test(message.details.token)
    ? message.details.token
    : undefined;
};
const isMarker = (value) => markerToken(value) !== undefined;
const observeModel = (event) => {
  const model = event?.model;
  if (model?.provider && model?.id) appliedIdentity = { provider: String(model.provider), id: String(model.id) };
};
const persist = () => {
  if (capturePath.length === 0) return pendingPersist;
  const snapshot = {
    schemaVersion: 1,
    kind: "control",
    role,
    ...(markerTokenHash === undefined ? {} : { markerTokenHash }),
    ...(failedAssistantFingerprintHash === undefined ? {} : { failedAssistantFingerprintHash }),
    ...(failedAssistantShapeHash === undefined ? {} : { failedAssistantShapeHash }),
    processIdHash: digest(String(process.pid)),
    ...(processIdBeforeHash === undefined ? {} : { processIdBeforeHash }),
    ...(processIdAfterHash === undefined ? {} : { processIdAfterHash }),
    ...(role === "child" && childIdBeforeHash === undefined ? {} : { childIdBeforeHash }),
    ...(role === "child" && childIdAfterHash === undefined ? {} : { childIdAfterHash }),
    ...(role === "child" && typeof childId === "string" && childId.length > 0
      ? { childIdHash: digest(childId) }
      : {}),
    lifecycle: {
      beforeAgentStartCount,
      messageStartCount,
      messageEndCount,
      contextCount,
      contextRepairCount,
      contextRepairTimesMs,
      modelSelectCount,
      modelSelectTimesMs,
      settlementCount,
      settlementTimesMs,
      markerMessageStartCount: recoveryMarkerCount,
      markerMessageStartTimesMs,
      recoveryMarkerCount,
      recoveryMarkerObserved,
      ...(appliedIdentity === undefined ? {} : { appliedIdentity })
    },
    ...(parentToolCallId === undefined ? {} : { parentToolCallIdHash: digest(parentToolCallId) }),
    ...(parentToolEndCallId === undefined ? {} : { parentToolEndCallIdHash: digest(parentToolEndCallId) }),
    ...(parentToolStartedAtMs === undefined ? {} : { parentToolStartedAtMs }),
    ...(parentToolEndedAtMs === undefined ? {} : { parentToolEndedAtMs }),
    ...(parentToolPendingMs === undefined ? {} : { parentToolPendingMs }),
    ...(role === "parent" ? { parentToolStartCount, parentToolEndCount, parentToolStartTimesMs, parentToolEndTimesMs } : {}),
    ...(pendingMessageHelperPresent === undefined ? {} : { pendingMessageHelperPresent }),
    ...(adapterPackageVersion === undefined ? {} : { adapterPackageVersion }),
    ...(adapterExtensionSha256 === undefined ? {} : { adapterExtensionSha256 }),
    ...(adapterPackageSourceProven === undefined ? {} : { adapterPackageSourceProven }),
    ...(adapterPackageRootMatched === undefined ? {} : { adapterPackageRootMatched }),
    ...(adapterExtensionHashMatched === undefined ? {} : { adapterExtensionHashMatched })
  };
  const body = JSON.stringify(snapshot);
  if (body.length <= ${MAX_CAPTURE_BYTES}) {
    pendingPersist = pendingPersist.then(() => Bun.write(capturePath, body + "\\n").then(() => undefined));
  }
  return pendingPersist;
};
export default function controlObserver(pi) {
  piApi = pi;
  pi.on("before_agent_start", () => {
    beforeAgentStartCount += 1;
    observeIdentityBefore();
    void persist();
  });
  pi.on("message_start", (event) => {
    messageStartCount += 1;
    if (isMarker(event)) {
      const token = markerToken(event);
      if (token !== undefined) markerTokenHash = digest("marker-token:" + token);
      recoveryMarkerCount += 1;
      markerMessageStartTimesMs.push(now());
      markerMessageStartSeen = true;
      recoveryMarkerObserved = true;
    }
    void persist();
  });
  pi.on("message_end", (event) => {
    messageEndCount += 1;
    const message = event?.message;
    const descriptor = describeEntry(message, 0);
    if (descriptor.correlationHash === descriptorCorrelation("failed-assistant")) {
      failedAssistantFingerprintHash = descriptor.contentFingerprintHash;
      failedAssistantShapeHash = descriptor.contentShapeHash;
    }
    void persist();
  });
  pi.on("context", () => {
    contextCount += 1;
    if (markerMessageStartSeen) {
      contextRepairCount += 1;
      contextRepairTimesMs.push(now());
    }
    void persist();
  });
  pi.on("model_select", (event) => {
    modelSelectCount += 1;
    modelSelectTimesMs.push(now());
    observeModel(event);
    void persist();
  });
  pi.on("tool_execution_start", (event) => {
    if (
      role === "parent" &&
      event?.toolName === "weave_delegate" &&
      typeof event.toolCallId === "string" &&
      event.toolCallId.length > 0
    ) {
      parentToolStartCount += 1;
      parentToolStartTimesMs.push(now());
      if (parentToolCallId === undefined) {
        parentToolCallId = event.toolCallId;
        parentToolStartedAtMs = parentToolStartTimesMs.at(-1);
      }
    }
    void persist();
  });
  pi.on("tool_execution_end", (event) => {
    if (
      role === "parent" &&
      event?.toolName === "weave_delegate" &&
      typeof event.toolCallId === "string" &&
      event.toolCallId.length > 0
    ) {
      parentToolEndCount += 1;
      parentToolEndTimesMs.push(now());
      if (parentToolEndCallId === undefined) {
        parentToolEndCallId = event.toolCallId;
        parentToolEndedAtMs = parentToolEndTimesMs.at(-1);
      }
      if (parentToolStartedAtMs !== undefined && parentToolEndedAtMs !== undefined) {
        parentToolPendingMs = parentToolEndedAtMs - parentToolStartedAtMs;
      }
    }
    void persist();
  });
  pi.on("session_start", async (_event, session) => {
    observeIdentityBefore();
    pendingMessageHelperPresent = typeof session?.hasPendingMessages === "function";
    await inspectAdapterProvenance();
    await persist();
  });
  pi.on("agent_settled", async (_event, session) => {
    settlementCount += 1;
    settlementTimesMs.push(now());
    observeIdentityAfter();
    await persist();
    if (role === "parent") session?.ui?.notify?.("PI_MODEL_FAILOVER_SMOKE_DONE", "info");
  });
}
`;
}

function rollbackShimSource(): string {
  const encoded = (value: unknown): string => JSON.stringify(value);
  return `
import adapterFactory from "./extension.js";

const role = typeof Bun.env.WEAVE_CHILD_ID === "string" ? "child" : "parent";
const captureDir = Bun.env.PI_MODEL_SMOKE_CAPTURE_DIR ?? "";
const nameRole = role === "child"
  ? "child-" + (Bun.env.WEAVE_CHILD_ID ?? "unknown").replaceAll(/[^A-Za-z0-9_-]/gu, "_")
  : "parent";
const capturePath = captureDir.length === 0 ? "" : captureDir + "/shim-" + nameRole;
const requiredDelegationSurfaces = ${encoded(ROLLBACK_REQUIRED_DELEGATION_SURFACES)};
const write = async (phase, adapterInitialized, pi, isolatedApi) => {
  if (capturePath.length === 0) return;
  const originalSurfacePresent = typeof pi.sendMessage === "function";
  const disabledBeforeAdapterInitialization =
    typeof isolatedApi.sendMessage !== "function";
  const requiredDelegationSurfacesIntact = requiredDelegationSurfaces.every(
    (surface) => typeof pi[surface] === "function",
  );
  const body = JSON.stringify({
    schemaVersion: 1,
    kind: "rollback-shim",
    role,
    phase,
    boundary: ${encoded(ROLLBACK_SHIM_BOUNDARY)},
    disabledSurface: ${encoded(ROLLBACK_DISABLED_SURFACE)},
    originalSurfacePresent,
    disabledBeforeAdapterInitialization,
    requiredDelegationSurfacesIntact,
    adapterInitialized,
  });
  await Bun.write(capturePath + "-" + phase + ".json", body + "\\n");
};

export default async function rollbackShim(pi) {
  const originalSendMessage = typeof pi.sendMessage === "function";
  const delegationSurfacesIntact = requiredDelegationSurfaces.every(
    (surface) => typeof pi[surface] === "function",
  );
  const isolatedApi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "sendMessage") return undefined;
      return Reflect.get(target, property, receiver);
    },
  });
  const disabledBeforeAdapterInitialization =
    typeof isolatedApi.sendMessage !== "function";
  if (
    !originalSendMessage ||
    !delegationSurfacesIntact ||
    !disabledBeforeAdapterInitialization
  ) {
    throw new Error("rollback shim boundary contract failed");
  }
  await write("before-adapter", false, pi, isolatedApi);
  await adapterFactory(isolatedApi);
  await write("after-adapter", true, pi, isolatedApi);
}
`;
}

const ROLLBACK_SHIM_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bglobalThis\b/u,
  /\bprocess\.env\b/u,
  /\bBun\.env(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*["'](?:[^"']|\\.)+["']\s*\])?\s*=(?!=)/u,
  /\bObject\.prototype\b/u,
  /\b(?:Object|Reflect)\.(?:assign|defineProperty|deleteProperty|set|setPrototypeOf)\s*\(/u,
  /\bpi\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'](?:[^"']|\\.)+["']\s*\])\s*=(?!=)/u,
  /\bdelete\s+pi\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'](?:[^"']|\\.)+["']\s*\])/u,
];

/**
 * Keep the rollback shim a narrow extension-factory boundary. It may hide one
 * property on the proxy, but it must not mutate a host/global object or use an
 * environment switch to change adapter behavior.
 */
export function validateRollbackShimSource(
  source: string,
): Result<string, SmokeFailure> {
  for (const required of [
    'import adapterFactory from "./extension.js";',
    "new Proxy",
    'property === "sendMessage"',
    "phase, adapterInitialized",
    "before-adapter",
    "after-adapter",
  ]) {
    if (!source.includes(required))
      return err(
        failure(
          "FixtureBoundaryViolation",
          "rollback shim contract is incomplete",
        ),
      );
  }
  for (const pattern of ROLLBACK_SHIM_FORBIDDEN_PATTERNS) {
    if (pattern.test(source))
      return err(
        failure(
          "FixtureBoundaryViolation",
          `rollback shim matched ${pattern.source}`,
        ),
      );
  }
  return ok(source);
}

const FIXTURE_BOUNDARY_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bpi\.on\s*\(/u,
  /\bpi\.sendMessage\b/u,
  /\bsessionManager\b/u,
  /\bappendCustomMessageEntry\b/u,
  /\bObject\.defineProperty\b/u,
  /\bcrypto\.randomUUID\s*=/u,
  /\b(?:before_agent_start|message_start|message_end|model_select|agent_settled|tool_execution_start|tool_execution_end|session_start)\b/u,
  /\b(?:beforeAgentStartCount|messageStartCount|messageEndCount|contextCount|modelSelectCount|settlementCount|parentToolPendingMs|optionalSurfaceDisabled|legacySettlement|appliedIdentity)\b/u,
  /\b(?:markerFromHistory|augmentContext|recoveryMarkerMessage|contextRepairInjected|contextFailedAssistantFound)\b/u,
  /\bPI_MODEL_SMOKE_CASE\b/u,
  /\bhasPendingMessages\b/u,
  /\.messages\s*=/u,
];

/** Reject a provider fixture that can manufacture host lifecycle evidence. */
export function validateFixtureSourceBoundary(
  source: string,
): Result<string, SmokeFailure> {
  if (!source.includes("registerProvider")) {
    return err(
      failure("FixtureBoundaryViolation", "provider registration is missing"),
    );
  }
  for (const pattern of FIXTURE_BOUNDARY_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      return err(
        failure(
          "FixtureBoundaryViolation",
          `provider fixture matched ${pattern.source}`,
        ),
      );
    }
  }
  return ok(source);
}

const CONTROL_OBSERVER_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bpi\.sendMessage\b/u,
  /\bpi\.setModel\b/u,
  /\bregisterProvider\b/u,
  /\bsessionManager\b/u,
  /\bappendCustomMessageEntry\b/u,
  /\bObject\.defineProperty\b/u,
  /\.messages\s*=/u,
  /\bmessages\s*:/u,
];

/** Keep the event observer read-only: it may observe and notify, but not inject. */
export function validateControlObserverSource(
  source: string,
): Result<string, SmokeFailure> {
  if (!source.includes("pi.on")) {
    return err(
      failure(
        "FixtureBoundaryViolation",
        "control observer registration is missing",
      ),
    );
  }
  for (const pattern of CONTROL_OBSERVER_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      return err(
        failure(
          "FixtureBoundaryViolation",
          `control observer matched ${pattern.source}`,
        ),
      );
    }
  }
  return ok(source);
}

function fixturePackageJson(): string {
  return `${JSON.stringify(
    {
      name: FIXTURE_PACKAGE_NAME,
      version: FIXTURE_PACKAGE_VERSION,
      private: true,
      type: "module",
      pi: { extensions: ["./provider.js", "./control-observer.js"] },
    },
    null,
    2,
  )}\n`;
}

function weaveSmokeConfig(): string {
  return `agent loom {
  prompt "Run the deterministic model fallback smoke task."
  models ["smoke/first", "smoke/second"]
  mode primary
  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate allow
  }
}

agent shuttle {
  prompt "Run the deterministic model fallback child task."
  models ["smoke/first", "smoke/second"]
  mode subagent
  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate deny
  }
}

settings {
  log_level ERROR
}
`;
}

function settingsJson(): string {
  return `${JSON.stringify(
    {
      packages: [`npm:${FIXTURE_PACKAGE_NAME}`, `npm:${PACKAGE_NAME}`],
    },
    null,
    2,
  )}\n`;
}

function trustJson(project: string): string {
  return `${JSON.stringify({ [resolve(project)]: true }, null, 2)}\n`;
}

function runtimePackageJson(): string {
  return `${JSON.stringify(
    {
      name: "weave-pi-model-fallback-runtime",
      private: true,
      type: "module",
      dependencies: {
        "@earendil-works/pi-ai": EXACT_PI_VERSION,
        "@earendil-works/pi-coding-agent": EXACT_PI_VERSION,
        "@earendil-works/pi-tui": EXACT_PI_VERSION,
        kysely: "0.27.6",
        mustache: "4.2.0",
        neverthrow: "8.2.0",
        pino: "9.14.0",
        typebox: "1.1.38",
        zod: "4.4.3",
      },
    },
    null,
    2,
  )}\n`;
}

function isolatedEnvironment(
  paths: ScenarioPaths,
  artifact: PackedArtifact,
): Result<Record<string, string>, SmokeFailure> {
  const env = {
    PATH: `${dirname(paths.expectCli)}:${dirname(paths.bunCli)}:${SAFE_SYSTEM_PATH}`,
    HOME: paths.home,
    [XDG_CONFIG_ENV]: paths.configHome,
    [XDG_DATA_ENV]: paths.dataHome,
    [XDG_CACHE_ENV]: paths.cacheHome,
    [XDG_STATE_ENV]: paths.stateHome,
    [PI_AGENT_DIR_ENV]: paths.piHome,
    [PI_SESSION_DIR_ENV]: paths.sessionDir,
    PI_OFFLINE: "1",
    PI_MODEL_SMOKE_CAPTURE_DIR: paths.capture,
    [EXPECTED_PACKAGE_ROOT_ENV]: paths.packagePath,
    [EXPECTED_EXTENSION_SHA_ENV]: artifact.extensionSha256,
    [EXPECTED_PACKAGE_VERSION_ENV]: artifact.packageVersion,
    [ADAPTER_SOURCE_PROVEN_ENV]: "1",
  };
  return validateStrictProvenanceEnvironment(env).map((value) => ({
    ...value,
  }));
}

async function writeText(
  path: string,
  value: string,
): Promise<Result<void, SmokeFailure>> {
  const written = await ResultAsync.fromThrowable(
    async () => {
      await Bun.write(path, value);
      const chmod = Bun.spawn(
        [Bun.which("chmod") ?? "/bin/chmod", "600", path],
        {
          cwd: dirname(path),
          env: { PATH: SAFE_SYSTEM_PATH },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      if ((await chmod.exited) !== 0) throw new Error("chmod failed");
    },
    () => failure("UnexpectedFailure", "could not write ephemeral fixture"),
  )();
  return written.map(() => undefined);
}

async function installRollbackShim(
  packageRoot: string,
  tracker: CleanupResourceTracker,
): Promise<Result<void, SmokeFailure>> {
  const source = validateRollbackShimSource(rollbackShimSource());
  if (source.isErr()) return err(source.error);
  const manifestPath = join(packageRoot, "package.json");
  const manifest = await ResultAsync.fromThrowable(
    () => Bun.file(manifestPath).json() as Promise<unknown>,
    () =>
      failure("StrictProvenanceViolation", "adapter manifest is unreadable"),
  )();
  if (manifest.isErr()) return err(manifest.error);
  if (!isRecord(manifest.value) || !isRecord(manifest.value.pi))
    return err(
      failure(
        "StrictProvenanceViolation",
        "packed adapter has no extension manifest",
      ),
    );
  const extensions = manifest.value.pi.extensions;
  if (
    !Array.isArray(extensions) ||
    extensions.some((entry) => typeof entry !== "string")
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "packed adapter extension manifest is invalid",
      ),
    );
  const shimPath = join(packageRoot, "dist", ROLLBACK_SHIM_FILENAME);
  if (!tracker.registerOwnedPath(shimPath))
    return err(failure("PathIsolationViolation", "rollback shim is not owned"));
  const shim = await writeText(shimPath, source.value);
  if (shim.isErr()) return err(shim.error);
  const rewrittenManifest = {
    ...manifest.value,
    pi: {
      ...manifest.value.pi,
      extensions: [`./dist/${ROLLBACK_SHIM_FILENAME}`],
    },
  };
  return writeText(
    manifestPath,
    `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
  );
}

async function pathExists(
  path: string,
): Promise<Result<boolean, SmokeFailure>> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).exists(),
    () => failure("CleanupFailed", "root-still-present"),
  )();
}

async function removeOwnedFile(
  path: string,
): Promise<Result<void, SmokeFailure>> {
  const removed = await ResultAsync.fromThrowable(
    () => Bun.file(path).delete(),
    () => failure("CleanupFailed", "resource-dispose-failed"),
  )();
  if (removed.isErr()) return err(removed.error);
  const exists = await pathExists(path);
  if (exists.isErr()) return err(exists.error);
  return exists.value
    ? err(failure("CleanupFailed", "resource-still-open"))
    : ok(undefined);
}

async function removeReportTemp(
  path: string,
): Promise<Result<void, SmokeFailure>> {
  return removeOwnedFile(path);
}

/**
 * Validate first, write a 0600 sibling, then rename it into place. The target
 * is never opened for writing, so a failed projection or failed write cannot
 * leave a truncated report behind.
 */
export async function writeSmokeReportAtomically(
  path: string,
  report: unknown,
): Promise<Result<void, SmokeFailure>> {
  const validatedPath = await validateReportTargetPath(path);
  if (validatedPath.isErr()) return err(validatedPath.error);
  const serialized = serializeSmokeReport(report);
  if (serialized.isErr()) return err(serialized.error);
  const target = validatedPath.value;
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  const cwd = dirname(target);
  const env = { PATH: SAFE_SYSTEM_PATH };
  const written = await writeText(temporary, serialized.value);
  if (written.isErr()) {
    const removed = await removeReportTemp(temporary);
    return removed.isErr()
      ? err(removed.error)
      : err(
          failure("ReportWriteFailed", "could not write report staging file"),
        );
  }
  const restricted = await runBoundedCommand(["chmod", "600", temporary], {
    cwd,
    env,
    timeoutMs: 2_000,
  });
  if (restricted.isErr()) {
    const removed = await removeReportTemp(temporary);
    return removed.isErr()
      ? err(removed.error)
      : err(
          failure("ReportWriteFailed", "could not restrict report permissions"),
        );
  }
  const moved = await runBoundedCommand(["mv", "-f", temporary, target], {
    cwd,
    env,
    timeoutMs: 2_000,
  });
  if (moved.isErr()) {
    const removed = await removeReportTemp(temporary);
    return removed.isErr()
      ? err(removed.error)
      : err(
          failure("ReportWriteFailed", "could not atomically publish report"),
        );
  }
  return ok(undefined);
}

function resolveBunCliPath(): string {
  const requested = Bun.env.BUN_CLI;
  if (requested !== undefined) {
    return isAbsolute(requested)
      ? resolve(requested)
      : (Bun.which(requested) ?? "");
  }
  const voltaHome = Bun.env.VOLTA_HOME ?? join(Bun.env.HOME ?? "", ".volta");
  const candidates = [
    join(
      voltaHome,
      "tools/image/packages/bun/lib/node_modules/bun/bin/bun.exe",
    ),
    process.execPath,
    Bun.argv[0] ?? "",
    Bun.which("bun") ?? "",
  ];
  return (
    candidates.find(
      (candidate) =>
        isAbsolute(candidate) &&
        !candidate.endsWith("/volta-shim") &&
        !candidate.includes("/volta/bin/"),
    ) ?? ""
  );
}

async function setupScenario(
  artifact: PackedArtifact,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
): Promise<
  Result<
    {
      readonly paths: ScenarioPaths;
      readonly env: Record<string, string>;
      readonly tracker: CleanupResourceTracker;
      readonly runtimeStatusCommand: CleanupRootOptions["runtimeStatusCommand"];
      readonly installed: InstalledAdapterProvenance;
    },
    SmokeFailure
  >
> {
  const root = join(tmpdir(), `weave-pi-model-failover-${crypto.randomUUID()}`);
  const repoRoot = resolve(".");
  const artifactParent = resolve(dirname(artifact.path));
  const tempRoot = resolve(tmpdir());
  const privateArtifactParent =
    artifactParent === tempRoot || artifactParent === "/private/tmp"
      ? undefined
      : artifactParent;
  const forbiddenPaths = [
    Bun.env.HOME,
    Bun.env[PI_AGENT_DIR_ENV],
    Bun.env[PI_SESSION_DIR_ENV],
    Bun.env.PI_SESSION_FILE === undefined
      ? undefined
      : dirname(Bun.env.PI_SESSION_FILE),
    repoRoot,
    privateArtifactParent,
  ].filter((path): path is string => path !== undefined);
  const bunCli = resolveBunCliPath();
  const expectCli = Bun.which("expect") ?? "";
  if (!safeAbsolutePath(bunCli) || !safeAbsolutePath(expectCli))
    return err(
      failure(
        "StrictProvenanceViolation",
        "the isolated smoke requires absolute Bun and expect executables",
      ),
    );
  const paths: ScenarioPaths = {
    root,
    home: join(root, "home"),
    piHome: join(root, "pi"),
    configHome: join(root, "xdg-config"),
    dataHome: join(root, "xdg-data"),
    cacheHome: join(root, "xdg-cache"),
    stateHome: join(root, "xdg-state"),
    sessionDir: join(root, "pi/sessions"),
    project: join(root, "project"),
    capture: join(root, "capture"),
    packagePath: join(root, "pi/npm/node_modules/@weaveio/weave-adapter-pi"),
    fixturePath: join(root, "pi/npm/node_modules", FIXTURE_PACKAGE_NAME),
    piCli: join(
      root,
      "pi/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
    piCliPackageRoot: join(
      root,
      "pi/npm/node_modules/@earendil-works/pi-coding-agent",
    ),
    piCliPackageVersion: EXACT_PI_VERSION,
    bunCli,
    expectCli,
  };
  const completePaths = paths;
  const pathPolicy = validateIsolatedPathPolicy({
    root,
    paths: {
      home: paths.home,
      piHome: paths.piHome,
      configHome: paths.configHome,
      dataHome: paths.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      sessionDir: paths.sessionDir,
      project: paths.project,
      capture: paths.capture,
      packagePath: paths.packagePath,
      fixturePath: paths.fixturePath,
      piCli: paths.piCli,
      piCliPackageRoot: paths.piCliPackageRoot,
    },
    forbiddenPaths,
  });
  if (pathPolicy.isErr()) return err(pathPolicy.error);
  const existingRootSymlink = await pathIsSymlink(root);
  if (existingRootSymlink.isErr())
    return err(
      failure("PathIsolationViolation", "smoke root could not be inspected"),
    );
  if (existingRootSymlink.value || (await Bun.file(root).exists()))
    return err(failure("PathIsolationViolation", "smoke root already exists"));
  const runtimeStatusCommand = {
    args: [
      paths.bunCli,
      resolve("packages/cli/src/main.ts"),
      "runtime",
      "status",
    ] as const,
    cwd: repoRoot,
  };
  const envResult = isolatedEnvironment(paths, artifact);
  if (envResult.isErr()) return err(envResult.error);
  const env = { ...envResult.value, PI_MODEL_SMOKE_CASE: smokeCase };
  const tracker = createCleanupResourceTracker(root);
  const rootMade = await commandOk(
    ["mkdir", "-m", "700", paths.root],
    tmpdir(),
    env,
    timeoutMs,
    tracker,
  );
  if (rootMade.isErr()) return err(failure("CleanupFailed", "root-not-owned"));
  let setupSignalCleanup:
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined;
  let setupSignalsRegistered = true;
  const currentSetupSignalCleanup = ():
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined => setupSignalCleanup;
  const unregisterSetupSignals = (): void => {
    if (!setupSignalsRegistered) return;
    setupSignalsRegistered = false;
    process.off("SIGINT", setupSignalHandler);
    process.off("SIGTERM", setupSignalHandler);
  };
  const requestSetupSignalCleanup = (): void => {
    setupSignalCleanup ??= cleanupRoot(root, tmpdir(), env, timeoutMs, {
      tracker,
      runtimeStatusCommand,
    });
  };
  const setupSignalHandler = (): void => {
    requestSetupSignalCleanup();
  };
  process.on("SIGINT", setupSignalHandler);
  process.on("SIGTERM", setupSignalHandler);
  const failSetup = async (
    error: SmokeFailure,
  ): Promise<
    Result<
      {
        readonly paths: ScenarioPaths;
        readonly env: Record<string, string>;
        readonly tracker: CleanupResourceTracker;
        readonly runtimeStatusCommand: CleanupRootOptions["runtimeStatusCommand"];
        readonly installed: InstalledAdapterProvenance;
      },
      SmokeFailure
    >
  > => {
    unregisterSetupSignals();
    const cleaned =
      setupSignalCleanup ??
      cleanupRoot(root, tmpdir(), env, timeoutMs, {
        tracker,
        runtimeStatusCommand,
      });
    const cleanupResult = await cleaned;
    return cleanupResult.isErr() ? err(cleanupResult.error) : err(error);
  };
  const directories = [
    completePaths.home,
    completePaths.piHome,
    completePaths.configHome,
    completePaths.dataHome,
    completePaths.cacheHome,
    completePaths.stateHome,
    completePaths.sessionDir,
    completePaths.project,
    join(completePaths.project, ".weave"),
    completePaths.capture,
    join(completePaths.piHome, "npm"),
    join(completePaths.piHome, "npm/node_modules"),
    join(completePaths.piHome, "npm/node_modules/@weaveio"),
    completePaths.packagePath,
    completePaths.fixturePath,
    join(completePaths.root, "bin"),
  ];
  for (const directory of directories) {
    if (setupSignalCleanup !== undefined)
      return failSetup(failure("UnexpectedFailure", "setup interrupted"));
    tracker.registerOwnedPath(directory);
    const made = await makeDirectory(
      directory,
      tmpdir(),
      env,
      timeoutMs,
      tracker,
    );
    if (made.isErr()) return failSetup(made.error);
  }
  const createdPathPolicy = await validateCreatedIsolatedPathPolicy({
    root,
    paths: {
      home: paths.home,
      piHome: paths.piHome,
      configHome: paths.configHome,
      dataHome: paths.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      sessionDir: paths.sessionDir,
      project: paths.project,
      capture: paths.capture,
      packagePath: paths.packagePath,
      fixturePath: paths.fixturePath,
    },
    forbiddenPaths,
  });
  if (createdPathPolicy.isErr()) return failSetup(createdPathPolicy.error);
  const providerSource = validateFixtureSourceBoundary(fixtureSource());
  if (providerSource.isErr()) return failSetup(providerSource.error);
  const controlSource = validateControlObserverSource(controlObserverSource());
  if (controlSource.isErr()) return failSetup(controlSource.error);
  const writes: Array<Promise<Result<void, SmokeFailure>>> = [
    writeText(
      join(completePaths.project, ".weave/config.weave"),
      weaveSmokeConfig(),
    ),
    writeText(
      join(completePaths.piHome, "npm/package.json"),
      runtimePackageJson(),
    ),
    writeText(join(completePaths.piHome, "settings.json"), settingsJson()),
    writeText(
      join(completePaths.piHome, "trust.json"),
      trustJson(completePaths.project),
    ),
    writeText(
      join(completePaths.fixturePath, "package.json"),
      fixturePackageJson(),
    ),
    writeText(
      join(completePaths.fixturePath, "provider.js"),
      providerSource.value,
    ),
    writeText(
      join(completePaths.fixturePath, "control-observer.js"),
      controlSource.value,
    ),
  ];
  for (const result of await Promise.all(writes))
    if (result.isErr()) return failSetup(result.error);
  if (setupSignalCleanup !== undefined)
    return failSetup(failure("UnexpectedFailure", "setup interrupted"));
  const bunWrapper = `#!/bin/sh\nexec '${shellSafePath(completePaths.bunCli)}' '${shellSafePath(completePaths.piCli)}' "$@"\n`;
  const wrapper = await writeText(
    join(completePaths.root, "bin/pi"),
    bunWrapper,
  );
  if (wrapper.isErr()) return failSetup(wrapper.error);
  if (setupSignalCleanup !== undefined)
    return failSetup(failure("UnexpectedFailure", "setup interrupted"));
  const chmod = await commandOk(
    ["chmod", "700", join(completePaths.root, "bin/pi")],
    completePaths.project,
    env,
    timeoutMs,
    tracker,
  );
  if (chmod.isErr()) return failSetup(chmod.error);

  const installEnv = {
    ...env,
    ...(Bun.env.BUN_INSTALL !== undefined &&
    safeAbsolutePath(Bun.env.BUN_INSTALL)
      ? { BUN_INSTALL: resolve(Bun.env.BUN_INSTALL) }
      : {}),
  };
  const bunInstall = await runBoundedCommand(
    [
      completePaths.bunCli,
      "install",
      "--production",
      "--offline",
      "--ignore-scripts",
      "--backend=copyfile",
    ],
    {
      cwd: join(completePaths.piHome, "npm"),
      env: installEnv,
      timeoutMs,
      resources: tracker,
    },
  );
  if (bunInstall.isErr())
    return failSetup(
      failure(
        "StrictProvenanceViolation",
        "isolated Pi package installation failed",
      ),
    );
  const piProvenance = await inspectPiCliProvenance(completePaths.piCli, {
    expectedVersion: EXACT_PI_VERSION,
    forbiddenPaths,
  });
  if (piProvenance.isErr()) return failSetup(piProvenance.error);
  if (piProvenance.value.packageRoot !== completePaths.piCliPackageRoot)
    return failSetup(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI package root is not isolated",
      ),
    );

  if (setupSignalCleanup !== undefined)
    return failSetup(failure("UnexpectedFailure", "setup interrupted"));
  const extract = await commandOk(
    [
      "tar",
      "-xzf",
      artifact.path,
      "-C",
      completePaths.packagePath,
      "--strip-components=1",
    ],
    completePaths.project,
    env,
    timeoutMs,
    tracker,
  );
  if (extract.isErr())
    return failSetup(
      failure("ArtifactMalformed", "packed adapter could not be unpacked"),
    );
  const populatedPathPolicy = await validateCreatedIsolatedPathPolicy({
    root,
    paths: {
      home: paths.home,
      piHome: paths.piHome,
      configHome: paths.configHome,
      dataHome: paths.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      sessionDir: paths.sessionDir,
      project: paths.project,
      capture: paths.capture,
      packagePath: paths.packagePath,
      fixturePath: paths.fixturePath,
      piCli: paths.piCli,
      piCliPackageRoot: paths.piCliPackageRoot,
    },
    forbiddenPaths,
  });
  if (populatedPathPolicy.isErr()) return failSetup(populatedPathPolicy.error);
  const artifactUnchanged = await verifyArtifactFileUnchanged(
    artifact.path,
    artifact.sha256,
  );
  if (artifactUnchanged.isErr()) return failSetup(artifactUnchanged.error);
  const installed = await verifyInstalledAdapterPackage({
    packageRoot: completePaths.packagePath,
    expectedPackageRoot: completePaths.packagePath,
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedExtensionSha256: artifact.extensionSha256,
  });
  if (installed.isErr()) return failSetup(installed.error);
  if (
    !installed.value.packageRootMatched ||
    !installed.value.extensionHashMatched
  )
    return failSetup(
      failure(
        "StrictProvenanceViolation",
        "installed adapter provenance does not match the packed artifact",
      ),
    );
  if (smokeCase === "rollback") {
    const shim = await installRollbackShim(completePaths.packagePath, tracker);
    if (shim.isErr()) return failSetup(shim.error);
  }
  unregisterSetupSignals();
  const pendingSetupCleanup = currentSetupSignalCleanup();
  if (pendingSetupCleanup !== undefined) {
    const cleanupResult = await pendingSetupCleanup;
    return cleanupResult.isErr()
      ? err(cleanupResult.error)
      : err(failure("UnexpectedFailure", "setup interrupted"));
  }
  return ok({
    paths: completePaths,
    env,
    tracker,
    runtimeStatusCommand,
    installed: installed.value,
  });
}

async function runPty(
  paths: ScenarioPaths,
  env: Record<string, string>,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<CommandResult, SmokeFailure>> {
  const command = buildPiLaunchCommand({
    bunCli: paths.bunCli,
    piCli: paths.piCli,
    launcher: join(paths.root, "bin/pi"),
  });
  // The done marker is only a bounded TUI-driver synchronization point. The
  // rollback health observation waits for Pi's real Weave badge, invokes the
  // real `/weave:health` command, and parses that command's notification below.
  const doneMarker = "PI_MODEL_FAILOVER_SMOKE_DONE";
  const task = smokeCase === "rollback" ? ROLLBACK_TASK : PARENT_TASK;
  const rollbackHealth = smokeCase === "rollback";
  const driverPath = join(paths.root, `driver-${crypto.randomUUID()}.exp`);
  resources?.registerOwnedPath(driverPath);
  const driver = await writeText(
    driverPath,
    buildExpectDriver({
      command,
      doneMarker,
      ...(rollbackHealth ? { readyMarker: "◆ WEAVE" } : {}),
      ...(rollbackHealth
        ? {
            healthCommand: "/weave:health",
            healthMarker: "Weave adapter mode: (ready|health-only)",
          }
        : {}),
      task,
      timeoutSeconds: Math.ceil(timeoutMs / 1_000),
    }),
  );
  if (driver.isErr()) return err(driver.error);
  const result = await runBoundedCommand([paths.expectCli, "-f", driverPath], {
    cwd: paths.project,
    env,
    timeoutMs,
    resources,
    processKind: "pty",
  });
  const removed = await removeOwnedFile(driverPath);
  if (removed.isErr()) return err(removed.error);
  return result;
}

function stripAnsi(value: string): string {
  const escapeChar = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const csi = new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, "gu");
  const osc = new RegExp(
    `${escapeChar}\\][^${bell}]*(?:${bell}|${escapeChar}\\\\)`,
    "gu",
  );
  return value.replaceAll(csi, "").replaceAll(osc, "");
}

function normalizedTuiOutput(output: string): string {
  return stripAnsi(output).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function visibleEventCount(output: string): number {
  return (
    normalizedTuiOutput(output).match(/(?:^|\n)\s*MODEL FALLBACK\b/gm) ?? []
  ).length;
}

/** Parse only bounded mode facts emitted by `/weave:health`. */
export function parseHealthFacts(
  output: string,
): Result<HealthFacts, SmokeFailure> {
  if (new TextEncoder().encode(output).byteLength > MAX_CAPTURE_BYTES) {
    return err(
      failure(
        "CaptureMalformed",
        "real health observation exceeds the byte bound",
      ),
    );
  }
  const text = stripAnsi(output);
  const modes = [...text.matchAll(HEALTH_MODE_PATTERN)].map((match) =>
    match[1]?.trim().toLowerCase(),
  );
  if (
    modes.length === 0 ||
    modes.some((mode) => mode !== "ready" && mode !== "health-only")
  ) {
    return err(
      failure("CaptureMalformed", "real /weave:health adapter mode is invalid"),
    );
  }
  const mode = modes[0];
  if (modes.some((candidate) => candidate !== mode)) {
    return err(
      failure(
        "CaptureMalformed",
        "real health observation repeats conflicting modes",
      ),
    );
  }
  const healthOnly = mode === "health-only";
  const explicitHealthOnly = [...text.matchAll(HEALTH_ONLY_FACT_PATTERN)].map(
    (match) => match[1]?.trim().toLowerCase(),
  );
  if (
    explicitHealthOnly.some((value) => value !== "true" && value !== "false") ||
    (explicitHealthOnly.length > 0 &&
      explicitHealthOnly.some((value) => value !== explicitHealthOnly[0]))
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "real health observation health-only is invalid",
      ),
    );
  }
  if (
    explicitHealthOnly.length > 0 &&
    (explicitHealthOnly[0] === "true") !== healthOnly
  ) {
    return err(
      failure("CaptureMalformed", "real health observation facts disagree"),
    );
  }
  const gaps: HostSurfaceGapFact[] = [];
  const gapLines = [...text.matchAll(HEALTH_SURFACE_GAP_PATTERN)];
  if (gapLines.length > MAX_HEALTH_SURFACE_GAPS)
    return err(
      failure("CaptureMalformed", "health surface gap bound exceeded"),
    );
  const field = (line: string, name: string): string | undefined =>
    new RegExp(`(?:^|;\\s*)${name}:\\s*([^;]+)`, "iu").exec(line)?.[1]?.trim();
  for (const match of gapLines) {
    const line = (match[1] ?? "").replace(/\s+/gu, " ").trim();
    if (line.length === 0 || line.length > 2_048)
      return err(
        failure("CaptureMalformed", "health surface gap is malformed"),
      );
    const capability = field(line, "capability");
    const hostVersion = field(line, "host version");
    const probe = field(line, "probe");
    const gapMode = field(line, "mode");
    if (
      (hostVersion !== EXACT_PI_VERSION &&
        !hostVersion?.startsWith(`${EXACT_PI_VERSION} `)) ||
      capability === undefined ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(capability) ||
      probe === undefined ||
      !/^(?:native|fallback|unavailable):[a-z0-9][a-z0-9-]{0,95}$/u.test(
        probe,
      ) ||
      (gapMode !== "health-only" &&
        gapMode !== "custom-editor-fallback" &&
        gapMode !== "feature-unavailable")
    )
      return err(failure("CaptureMalformed", "health surface gap is invalid"));
    if (gaps.some((gap) => gap.capability === capability))
      return err(
        failure("CaptureMalformed", "health surface gap is duplicated"),
      );
    gaps.push({ capability, probe, mode: gapMode });
  }
  const runtimeModelFallback = gaps.find(
    (gap) => gap.capability === "runtime-model-fallback",
  );
  return ok({
    source: "real-pi-tui",
    ready: !healthOnly,
    healthOnly,
    ...(gaps.length === 0 ? {} : { hostSurfaceGaps: gaps }),
    ...(runtimeModelFallback === undefined ? {} : { runtimeModelFallback }),
  });
}

export function validateHealthObservation(
  health: HealthFacts | undefined,
): Result<HealthFacts, SmokeFailure> {
  if (health === undefined) {
    return err(
      failure("CaptureMalformed", "real health observation is missing"),
    );
  }
  if (
    health.source !== "real-pi-tui" ||
    typeof health.ready !== "boolean" ||
    typeof health.healthOnly !== "boolean"
  ) {
    return err(
      failure("CaptureMalformed", "health observation fields are invalid"),
    );
  }
  if (health.ready === health.healthOnly) {
    return err(
      failure("CaptureMalformed", "health observation mode is ambiguous"),
    );
  }
  const gaps = health.hostSurfaceGaps;
  if (gaps !== undefined) {
    if (
      gaps.length === 0 ||
      gaps.length > MAX_HEALTH_SURFACE_GAPS ||
      gaps.some(
        (gap) =>
          !isRecord(gap) ||
          typeof gap.capability !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(gap.capability) ||
          typeof gap.probe !== "string" ||
          !/^(?:native|fallback|unavailable):[a-z0-9][a-z0-9-]{0,95}$/u.test(
            gap.probe,
          ) ||
          (gap.mode !== "health-only" &&
            gap.mode !== "custom-editor-fallback" &&
            gap.mode !== "feature-unavailable"),
      )
    )
      return err(
        failure("CaptureMalformed", "health surface gaps are invalid"),
      );
    if (new Set(gaps.map((gap) => gap.capability)).size !== gaps.length)
      return err(
        failure("CaptureMalformed", "health surface gap is duplicated"),
      );
  }
  const runtimeGap = gaps?.find(
    (gap) => gap.capability === "runtime-model-fallback",
  );
  if (
    (health.runtimeModelFallback === undefined) !==
      (runtimeGap === undefined) ||
    (health.runtimeModelFallback !== undefined &&
      JSON.stringify(health.runtimeModelFallback) !==
        JSON.stringify(runtimeGap))
  )
    return err(
      failure(
        "CaptureMalformed",
        "runtime-model-fallback health evidence disagrees",
      ),
    );
  return ok(health);
}

interface RawFixtureCaptures {
  readonly providers: readonly FixtureProviderCapture[];
  readonly controls: readonly FixtureControlFacts[];
  readonly shims: readonly FixtureShimFacts[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 256
  );
}

const MESSAGE_DESCRIPTOR_KEYS = new Set([
  "ordinal",
  "roleHash",
  "customTypeHash",
  "contentShapeHash",
  "contentFingerprintHash",
  "contentBlockCount",
  "toolCallCount",
  "toolResultCount",
  "correlationHash",
]);
const HISTORY_DESCRIPTOR_KEYS = new Set([
  ...MESSAGE_DESCRIPTOR_KEYS,
  "entryIndex",
  "entryTypeHash",
]);
const PROVIDER_CAPTURE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "role",
  "requestCount",
  "requests",
]);
const CONTROL_CAPTURE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "role",
  "markerTokenHash",
  "failedAssistantFingerprintHash",
  "failedAssistantShapeHash",
  "processIdHash",
  "processIdBeforeHash",
  "processIdAfterHash",
  "childIdHash",
  "childIdBeforeHash",
  "childIdAfterHash",
  "lifecycle",
  "parentToolCallIdHash",
  "parentToolEndCallIdHash",
  "parentToolStartedAtMs",
  "parentToolEndedAtMs",
  "parentToolPendingMs",
  "parentToolStartCount",
  "parentToolEndCount",
  "parentToolStartTimesMs",
  "parentToolEndTimesMs",
  "pendingMessageHelperPresent",
  "adapterPackageVersion",
  "adapterExtensionSha256",
  "adapterPackageSourceProven",
  "adapterPackageRootMatched",
  "adapterExtensionHashMatched",
]);
const SHIM_CAPTURE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "role",
  "phase",
  "boundary",
  "disabledSurface",
  "originalSurfacePresent",
  "disabledBeforeAdapterInitialization",
  "requiredDelegationSurfacesIntact",
  "adapterInitialized",
]);
const MESSAGE_FACT_KEYS = new Set([
  "requestNumber",
  "provider",
  "model",
  "messageCount",
  "contextHash",
  "descriptors",
  "descriptorCount",
  "userCount",
  "assistantCount",
  "toolResultCount",
  "customCount",
  "originalUserPresent",
  "taskPresent",
  "toolCallPresent",
  "toolResultPresent",
  "failedAssistantPresent",
  "recoveryMarkerPresent",
  "syntheticProviderUserMessagePresent",
]);

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseDescriptorHash(
  value: unknown,
  field: string,
  label: string,
): Result<string, SmokeFailure> {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return err(failure("CaptureMalformed", `${label} ${field} is invalid`));
  }
  return ok(value);
}

function parseMessageDescriptor(
  value: unknown,
  label: string,
  history: boolean,
): Result<FixtureMessageDescriptor | FixtureHistoryDescriptor, SmokeFailure> {
  if (!isRecord(value))
    return err(failure("CaptureMalformed", `${label} is not an object`));
  const allowed = history ? HISTORY_DESCRIPTOR_KEYS : MESSAGE_DESCRIPTOR_KEYS;
  if (!hasOnlyKeys(value, allowed)) {
    return err(
      failure(
        "CaptureMalformed",
        `${label} contains an unapproved descriptor field`,
      ),
    );
  }
  if (
    !boundedCount(value.ordinal) ||
    value.ordinal >=
      (history ? MAX_HISTORY_DESCRIPTOR_COUNT : MAX_CONTEXT_DESCRIPTOR_COUNT) ||
    !boundedCount(value.contentBlockCount) ||
    !boundedCount(value.toolCallCount) ||
    !boundedCount(value.toolResultCount)
  ) {
    return err(
      failure("CaptureMalformed", `${label} descriptor bounds are invalid`),
    );
  }
  const roleHash = parseDescriptorHash(value.roleHash, "roleHash", label);
  if (roleHash.isErr()) return err(roleHash.error);
  if (
    ![
      fixtureRoleHash("user"),
      fixtureRoleHash("assistant"),
      fixtureRoleHash("toolResult"),
      fixtureRoleHash("custom"),
    ].includes(roleHash.value)
  ) {
    return err(failure("CaptureMalformed", `${label} role hash is unknown`));
  }
  const shapeHash = parseDescriptorHash(
    value.contentShapeHash,
    "contentShapeHash",
    label,
  );
  if (shapeHash.isErr()) return err(shapeHash.error);
  const fingerprintHash = parseDescriptorHash(
    value.contentFingerprintHash,
    "contentFingerprintHash",
    label,
  );
  if (fingerprintHash.isErr()) return err(fingerprintHash.error);
  const customTypeHash = value.customTypeHash;
  if (customTypeHash !== undefined) {
    const parsed = parseDescriptorHash(customTypeHash, "customTypeHash", label);
    if (parsed.isErr()) return err(parsed.error);
    if (roleHash.value !== fixtureRoleHash("custom")) {
      return err(
        failure(
          "CaptureMalformed",
          `${label} custom type has a non-custom role`,
        ),
      );
    }
  }
  const correlationHash = value.correlationHash;
  if (correlationHash !== undefined) {
    const parsed = parseDescriptorHash(
      correlationHash,
      "correlationHash",
      label,
    );
    if (parsed.isErr()) return err(parsed.error);
  }
  const descriptor: FixtureMessageDescriptor = {
    ordinal: value.ordinal,
    roleHash: roleHash.value,
    ...(customTypeHash === undefined
      ? {}
      : { customTypeHash: customTypeHash as string }),
    contentShapeHash: shapeHash.value,
    contentFingerprintHash: fingerprintHash.value,
    contentBlockCount: value.contentBlockCount,
    toolCallCount: value.toolCallCount,
    toolResultCount: value.toolResultCount,
    ...(correlationHash === undefined
      ? {}
      : { correlationHash: correlationHash as string }),
  };
  if (!history) return ok(descriptor);
  if (
    !boundedCount(value.entryIndex) ||
    value.entryIndex > MAX_HISTORY_DESCRIPTOR_COUNT
  ) {
    return err(failure("CaptureMalformed", `${label} entry index is invalid`));
  }
  const entryTypeHash = parseDescriptorHash(
    value.entryTypeHash,
    "entryTypeHash",
    label,
  );
  if (entryTypeHash.isErr()) return err(entryTypeHash.error);
  if (
    ![
      fixtureEntryTypeHash("message"),
      fixtureEntryTypeHash("custom_message"),
      fixtureEntryTypeHash("custom"),
    ].includes(entryTypeHash.value)
  ) {
    return err(
      failure("CaptureMalformed", `${label} entry type hash is unknown`),
    );
  }
  return ok({
    ...descriptor,
    entryIndex: value.entryIndex,
    entryTypeHash: entryTypeHash.value,
  });
}

function parseDescriptorCounts(
  value: Record<string, unknown>,
  descriptors: readonly FixtureMessageDescriptor[],
  label: string,
): Result<FixtureDescriptorCounts, SmokeFailure> {
  const fields = [
    "descriptorCount",
    "userCount",
    "assistantCount",
    "toolResultCount",
    "customCount",
  ] as const;
  if (fields.some((field) => !boundedCount(value[field]))) {
    return err(
      failure("CaptureMalformed", `${label} descriptor counts are invalid`),
    );
  }
  const expected = descriptorCounts(descriptors);
  if (fields.some((field) => value[field] !== expected[field])) {
    return err(
      failure("CaptureMalformed", `${label} descriptor counts disagree`),
    );
  }
  return ok(expected);
}

function descriptorFactsFromDescriptors(
  descriptors: readonly FixtureMessageDescriptor[],
): Pick<
  FixtureMessageFacts,
  | "originalUserPresent"
  | "taskPresent"
  | "toolCallPresent"
  | "toolResultPresent"
  | "failedAssistantPresent"
  | "recoveryMarkerPresent"
  | "syntheticProviderUserMessagePresent"
> {
  const knownUsers = new Set(
    (
      [
        "original-task-user",
        "original-user",
        "steering-user",
        "follow-up-user",
        "unrelated-custom",
        "queued-user",
      ] as const
    ).map(fixtureCorrelationHash),
  );
  const userRole = fixtureRoleHash("user");
  return {
    originalUserPresent: descriptors.some(
      (descriptor) => descriptor.roleHash === userRole,
    ),
    taskPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
        fixtureCorrelationHash("original-task-user"),
    ),
    toolCallPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash("tool-call"),
    ),
    toolResultPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash("tool-result"),
    ),
    failedAssistantPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
        fixtureCorrelationHash("failed-assistant"),
    ),
    recoveryMarkerPresent: descriptors.some(
      (descriptor) =>
        descriptor.customTypeHash ===
        fixtureCustomTypeHash(NATIVE_RECOVERY_MARKER_TYPE),
    ),
    syntheticProviderUserMessagePresent: descriptors.some(
      (descriptor) =>
        descriptor.roleHash === userRole &&
        (descriptor.correlationHash === undefined ||
          !knownUsers.has(descriptor.correlationHash)),
    ),
  };
}

function sameDescriptor(
  left: FixtureMessageDescriptor,
  right: FixtureMessageDescriptor,
  includeOrdinal = true,
): boolean {
  return (
    (!includeOrdinal || left.ordinal === right.ordinal) &&
    left.roleHash === right.roleHash &&
    left.customTypeHash === right.customTypeHash &&
    left.contentShapeHash === right.contentShapeHash &&
    left.contentFingerprintHash === right.contentFingerprintHash &&
    left.contentBlockCount === right.contentBlockCount &&
    left.toolCallCount === right.toolCallCount &&
    left.toolResultCount === right.toolResultCount &&
    left.correlationHash === right.correlationHash
  );
}

function sameHistoryDescriptor(
  left: FixtureHistoryDescriptor,
  right: FixtureHistoryDescriptor,
): boolean {
  return (
    sameDescriptor(left, right) &&
    left.entryIndex === right.entryIndex &&
    left.entryTypeHash === right.entryTypeHash
  );
}

/** Provider conversion may normalize metadata, but not context structure. */
function sameContextDescriptor(
  left: FixtureMessageDescriptor,
  right: FixtureMessageDescriptor,
): boolean {
  return (
    left.roleHash === right.roleHash &&
    left.customTypeHash === right.customTypeHash &&
    left.contentShapeHash === right.contentShapeHash &&
    left.contentBlockCount === right.contentBlockCount &&
    left.toolCallCount === right.toolCallCount &&
    left.toolResultCount === right.toolResultCount &&
    left.correlationHash === right.correlationHash
  );
}

function boundedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTimestampArray(
  value: unknown,
  field: string,
  expectedCount: number,
): Result<readonly number[], SmokeFailure> {
  if (
    !Array.isArray(value) ||
    value.length !== expectedCount ||
    value.length > 256
  ) {
    return err(
      failure("CaptureMalformed", `control ${field} count is invalid`),
    );
  }
  if (value.some((candidate) => !boundedTimestamp(candidate))) {
    return err(
      failure("CaptureMalformed", `control ${field} timestamp is invalid`),
    );
  }
  return ok(value as number[]);
}

function parseIdentity(
  value: unknown,
): Result<SafeModelIdentity | undefined, SmokeFailure> {
  if (value === undefined) return ok(undefined);
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    typeof value.id !== "string"
  ) {
    return err(
      failure("CaptureMalformed", "control model identity is malformed"),
    );
  }
  if (value.provider.length > 64 || value.id.length > 128) {
    return err(
      failure("CaptureMalformed", "control model identity is too large"),
    );
  }
  return ok({ provider: value.provider, id: value.id });
}

function parseLifecycle(
  value: unknown,
): Result<FixtureLifecycleFacts, SmokeFailure> {
  if (!isRecord(value))
    return err(failure("CaptureMalformed", "control lifecycle is missing"));
  const fields = [
    "beforeAgentStartCount",
    "messageStartCount",
    "messageEndCount",
    "contextCount",
    "contextRepairCount",
    "modelSelectCount",
    "settlementCount",
    "markerMessageStartCount",
    "recoveryMarkerCount",
  ] as const;
  const counts = fields.map((field) => value[field]);
  if (counts.some((count) => !boundedCount(count))) {
    return err(
      failure("CaptureMalformed", "control lifecycle count is invalid"),
    );
  }
  if (counts[7] !== counts[8]) {
    return err(failure("CaptureMalformed", "control marker counts disagree"));
  }
  if (
    (counts[4] as number) > (counts[3] as number) ||
    (counts[7] as number) > (counts[1] as number)
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "control lifecycle event counts are inconsistent",
      ),
    );
  }
  if (typeof value.recoveryMarkerObserved !== "boolean") {
    return err(
      failure("CaptureMalformed", "control marker observation is invalid"),
    );
  }
  const contextRepairTimes = parseTimestampArray(
    value.contextRepairTimesMs,
    "contextRepairTimesMs",
    counts[4] as number,
  );
  if (contextRepairTimes.isErr()) return err(contextRepairTimes.error);
  const modelSelectTimes = parseTimestampArray(
    value.modelSelectTimesMs,
    "modelSelectTimesMs",
    counts[5] as number,
  );
  if (modelSelectTimes.isErr()) return err(modelSelectTimes.error);
  const settlementTimes = parseTimestampArray(
    value.settlementTimesMs,
    "settlementTimesMs",
    counts[6] as number,
  );
  if (settlementTimes.isErr()) return err(settlementTimes.error);
  const markerTimes = parseTimestampArray(
    value.markerMessageStartTimesMs,
    "markerMessageStartTimesMs",
    counts[7] as number,
  );
  if (markerTimes.isErr()) return err(markerTimes.error);
  const identity = parseIdentity(value.appliedIdentity);
  if (identity.isErr()) return err(identity.error);
  return ok({
    beforeAgentStartCount: counts[0] as number,
    messageStartCount: counts[1] as number,
    messageEndCount: counts[2] as number,
    contextCount: counts[3] as number,
    contextRepairCount: counts[4] as number,
    contextRepairTimesMs: contextRepairTimes.value,
    modelSelectCount: counts[5] as number,
    modelSelectTimesMs: modelSelectTimes.value,
    settlementCount: counts[6] as number,
    settlementTimesMs: settlementTimes.value,
    markerMessageStartCount: counts[7] as number,
    markerMessageStartTimesMs: markerTimes.value,
    recoveryMarkerCount: counts[8] as number,
    recoveryMarkerObserved: value.recoveryMarkerObserved,
    ...(identity.value === undefined
      ? {}
      : { appliedIdentity: identity.value }),
  });
}

function parseProviderCapture(
  value: unknown,
): Result<FixtureProviderCapture, SmokeFailure> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "provider"
  ) {
    return err(
      failure("CaptureMalformed", "provider capture header is invalid"),
    );
  }
  if (value.role !== "parent" && value.role !== "child") {
    return err(failure("CaptureMalformed", "provider capture role is invalid"));
  }
  if (!hasOnlyKeys(value, PROVIDER_CAPTURE_KEYS)) {
    return err(
      failure(
        "CaptureMalformed",
        "provider capture contains an unapproved field",
      ),
    );
  }
  if (
    !boundedCount(value.requestCount) ||
    value.requestCount > 8 ||
    !Array.isArray(value.requests) ||
    value.requests.length > 8 ||
    value.requests.length !== value.requestCount
  ) {
    return err(
      failure("CaptureMalformed", "provider capture request bound is invalid"),
    );
  }
  const requests: FixtureMessageFacts[] = [];
  for (const request of value.requests) {
    if (!isRecord(request))
      return err(
        failure("CaptureMalformed", "provider request is not an object"),
      );
    if (!hasOnlyKeys(request, MESSAGE_FACT_KEYS)) {
      return err(
        failure(
          "CaptureMalformed",
          "provider request contains an unapproved field",
        ),
      );
    }
    const booleanFields = [
      "originalUserPresent",
      "taskPresent",
      "toolCallPresent",
      "toolResultPresent",
      "failedAssistantPresent",
      "recoveryMarkerPresent",
      "syntheticProviderUserMessagePresent",
    ] as const;
    if (
      !boundedCount(request.requestNumber) ||
      request.requestNumber < 1 ||
      typeof request.provider !== "string" ||
      request.provider.length > 64 ||
      typeof request.model !== "string" ||
      request.model.length > 128 ||
      !boundedCount(request.messageCount) ||
      request.messageCount > MAX_CONTEXT_DESCRIPTOR_COUNT ||
      typeof request.contextHash !== "string" ||
      !SHA256.test(request.contextHash) ||
      !Array.isArray(request.descriptors) ||
      request.descriptors.length !== request.messageCount ||
      request.descriptors.length > MAX_CONTEXT_DESCRIPTOR_COUNT ||
      booleanFields.some((field) => typeof request[field] !== "boolean")
    ) {
      return err(
        failure("CaptureMalformed", "provider request facts are invalid"),
      );
    }
    const descriptors: FixtureMessageDescriptor[] = [];
    for (const [index, descriptor] of request.descriptors.entries()) {
      const parsed = parseMessageDescriptor(
        descriptor,
        `provider request ${request.requestNumber} descriptor ${index}`,
        false,
      );
      if (parsed.isErr()) return err(parsed.error);
      if (parsed.value.ordinal !== index) {
        return err(
          failure(
            "CaptureMalformed",
            "provider descriptor ordinal is not ordered",
          ),
        );
      }
      descriptors.push(parsed.value as FixtureMessageDescriptor);
    }
    const counts = parseDescriptorCounts(
      request,
      descriptors,
      `provider request ${request.requestNumber}`,
    );
    if (counts.isErr()) return err(counts.error);
    const derived = descriptorFactsFromDescriptors(descriptors);
    if (booleanFields.some((field) => request[field] !== derived[field])) {
      return err(
        failure(
          "CaptureMalformed",
          `provider request ${request.requestNumber} facts disagree with descriptors`,
        ),
      );
    }
    requests.push({
      requestNumber: request.requestNumber,
      provider: request.provider,
      model: request.model,
      messageCount: request.messageCount,
      contextHash: request.contextHash,
      descriptors,
      ...counts.value,
      ...derived,
    });
  }
  return ok({
    schemaVersion: 1,
    kind: "provider",
    role: value.role,
    requestCount: value.requestCount,
    requests,
  });
}

function parseControlCapture(
  value: unknown,
): Result<FixtureControlFacts, SmokeFailure> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "control"
  ) {
    return err(
      failure("CaptureMalformed", "control capture header is invalid"),
    );
  }
  if (
    !hasOnlyKeys(value, CONTROL_CAPTURE_KEYS) ||
    (value.role !== "parent" && value.role !== "child") ||
    typeof value.processIdHash !== "string" ||
    !SHA256.test(value.processIdHash)
  ) {
    return err(
      failure("CaptureMalformed", "control capture identity is invalid"),
    );
  }
  const identityHash = (
    field:
      | "processIdBeforeHash"
      | "processIdAfterHash"
      | "childIdBeforeHash"
      | "childIdAfterHash",
    required: boolean,
  ): Result<string | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined && !required) return ok(undefined);
    if (typeof candidate !== "string" || !SHA256.test(candidate)) {
      return err(failure("CaptureMalformed", `control ${field} is invalid`));
    }
    return ok(candidate);
  };
  const processBefore = identityHash("processIdBeforeHash", true);
  if (processBefore.isErr()) return err(processBefore.error);
  const processAfter = identityHash("processIdAfterHash", true);
  if (processAfter.isErr()) return err(processAfter.error);
  if (processAfter.value !== value.processIdHash) {
    return err(
      failure("CaptureMalformed", "control process identity sources disagree"),
    );
  }
  const childIdHash = value.childIdHash;
  if (
    childIdHash !== undefined &&
    (typeof childIdHash !== "string" || !SHA256.test(childIdHash))
  ) {
    return err(
      failure("CaptureMalformed", "control child identity is invalid"),
    );
  }
  const childBefore = identityHash("childIdBeforeHash", value.role === "child");
  if (childBefore.isErr()) return err(childBefore.error);
  const childAfter = identityHash("childIdAfterHash", value.role === "child");
  if (childAfter.isErr()) return err(childAfter.error);
  if (
    value.role === "child" &&
    (childIdHash === undefined || childAfter.value !== childIdHash)
  ) {
    return err(
      failure("CaptureMalformed", "child control identity sources disagree"),
    );
  }
  if (
    value.role === "parent" &&
    (childIdHash !== undefined ||
      childBefore.value !== undefined ||
      childAfter.value !== undefined)
  ) {
    return err(
      failure("CaptureMalformed", "parent control contains child identity"),
    );
  }
  const lifecycle = parseLifecycle(value.lifecycle);
  if (lifecycle.isErr()) return err(lifecycle.error);
  const optionalHash = (
    field: "parentToolCallIdHash" | "parentToolEndCallIdHash",
  ) => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return typeof candidate === "string" && SHA256.test(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const callId = optionalHash("parentToolCallIdHash");
  if (callId.isErr()) return err(callId.error);
  const endCallId = optionalHash("parentToolEndCallIdHash");
  if (endCallId.isErr()) return err(endCallId.error);
  const optionalDescriptorHash = (
    field:
      | "markerTokenHash"
      | "failedAssistantFingerprintHash"
      | "failedAssistantShapeHash",
  ): Result<string | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return typeof candidate === "string" && SHA256.test(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const markerTokenHash = optionalDescriptorHash("markerTokenHash");
  if (markerTokenHash.isErr()) return err(markerTokenHash.error);
  const failedAssistantFingerprintHash = optionalDescriptorHash(
    "failedAssistantFingerprintHash",
  );
  if (failedAssistantFingerprintHash.isErr())
    return err(failedAssistantFingerprintHash.error);
  const failedAssistantShapeHash = optionalDescriptorHash(
    "failedAssistantShapeHash",
  );
  if (failedAssistantShapeHash.isErr())
    return err(failedAssistantShapeHash.error);
  const optionalTimestamp = (
    field: "parentToolStartedAtMs" | "parentToolEndedAtMs",
  ): Result<number | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return boundedTimestamp(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const startedAt = optionalTimestamp("parentToolStartedAtMs");
  if (startedAt.isErr()) return err(startedAt.error);
  const endedAt = optionalTimestamp("parentToolEndedAtMs");
  if (endedAt.isErr()) return err(endedAt.error);
  if (
    value.parentToolPendingMs !== undefined &&
    (typeof value.parentToolPendingMs !== "number" ||
      !Number.isSafeInteger(value.parentToolPendingMs) ||
      value.parentToolPendingMs < 0 ||
      value.parentToolPendingMs > MAX_COMMAND_TIMEOUT_MS)
  ) {
    return err(
      failure("CaptureMalformed", "control pending interval is invalid"),
    );
  }
  const optionalToolCount = (
    field: "parentToolStartCount" | "parentToolEndCount",
  ): Result<number | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return boundedCount(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const startCount = optionalToolCount("parentToolStartCount");
  if (startCount.isErr()) return err(startCount.error);
  const endCount = optionalToolCount("parentToolEndCount");
  if (endCount.isErr()) return err(endCount.error);
  const optionalToolTimes = (
    field: "parentToolStartTimesMs" | "parentToolEndTimesMs",
    count: number | undefined,
  ): Result<readonly number[] | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined && count === undefined) return ok(undefined);
    if (count === undefined)
      return err(
        failure("CaptureMalformed", `control ${field} count is missing`),
      );
    return parseTimestampArray(candidate, field, count);
  };
  const startTimes = optionalToolTimes(
    "parentToolStartTimesMs",
    startCount.value,
  );
  if (startTimes.isErr()) return err(startTimes.error);
  const endTimes = optionalToolTimes("parentToolEndTimesMs", endCount.value);
  if (endTimes.isErr()) return err(endTimes.error);
  if (
    value.role === "parent" &&
    (startCount.value === undefined) !== (endCount.value === undefined)
  ) {
    return err(
      failure("CaptureMalformed", "parent tool event counts are incomplete"),
    );
  }
  if (
    value.role === "child" &&
    (startCount.value !== undefined ||
      endCount.value !== undefined ||
      startTimes.value !== undefined ||
      endTimes.value !== undefined)
  ) {
    return err(
      failure("CaptureMalformed", "child control contains parent tool events"),
    );
  }
  if (
    value.pendingMessageHelperPresent !== undefined &&
    typeof value.pendingMessageHelperPresent !== "boolean"
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "control pending helper observation is invalid",
      ),
    );
  }
  const adapterPackageVersion = value.adapterPackageVersion;
  if (
    adapterPackageVersion !== undefined &&
    (typeof adapterPackageVersion !== "string" ||
      adapterPackageVersion.length === 0 ||
      adapterPackageVersion.length > MAX_REPORT_STRING_LENGTH)
  )
    return err(
      failure("CaptureMalformed", "adapter package version is invalid"),
    );
  const adapterExtensionSha256 = value.adapterExtensionSha256;
  if (
    adapterExtensionSha256 !== undefined &&
    (typeof adapterExtensionSha256 !== "string" ||
      !SHA256.test(adapterExtensionSha256))
  )
    return err(
      failure("CaptureMalformed", "adapter extension hash is invalid"),
    );
  const adapterBoolean = (
    field:
      | "adapterPackageSourceProven"
      | "adapterPackageRootMatched"
      | "adapterExtensionHashMatched",
  ): Result<boolean | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return typeof candidate === "boolean"
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const adapterPackageSourceProven = adapterBoolean(
    "adapterPackageSourceProven",
  );
  if (adapterPackageSourceProven.isErr())
    return err(adapterPackageSourceProven.error);
  const adapterPackageRootMatched = adapterBoolean("adapterPackageRootMatched");
  if (adapterPackageRootMatched.isErr())
    return err(adapterPackageRootMatched.error);
  const adapterExtensionHashMatched = adapterBoolean(
    "adapterExtensionHashMatched",
  );
  if (adapterExtensionHashMatched.isErr())
    return err(adapterExtensionHashMatched.error);
  return ok({
    schemaVersion: 1,
    kind: "control",
    role: value.role,
    ...(markerTokenHash.value === undefined
      ? {}
      : { markerTokenHash: markerTokenHash.value }),
    ...(failedAssistantFingerprintHash.value === undefined
      ? {}
      : {
          failedAssistantFingerprintHash: failedAssistantFingerprintHash.value,
        }),
    ...(failedAssistantShapeHash.value === undefined
      ? {}
      : { failedAssistantShapeHash: failedAssistantShapeHash.value }),
    processIdHash: value.processIdHash,
    ...(processBefore.value === undefined
      ? {}
      : { processIdBeforeHash: processBefore.value }),
    ...(processAfter.value === undefined
      ? {}
      : { processIdAfterHash: processAfter.value }),
    ...(childBefore.value === undefined
      ? {}
      : { childIdBeforeHash: childBefore.value }),
    ...(childAfter.value === undefined
      ? {}
      : { childIdAfterHash: childAfter.value }),
    ...(childIdHash === undefined ? {} : { childIdHash }),
    lifecycle: lifecycle.value,
    ...(callId.value === undefined
      ? {}
      : { parentToolCallIdHash: callId.value }),
    ...(endCallId.value === undefined
      ? {}
      : { parentToolEndCallIdHash: endCallId.value }),
    ...(startedAt.value === undefined
      ? {}
      : { parentToolStartedAtMs: startedAt.value }),
    ...(endedAt.value === undefined
      ? {}
      : { parentToolEndedAtMs: endedAt.value }),
    ...(value.parentToolPendingMs === undefined
      ? {}
      : { parentToolPendingMs: value.parentToolPendingMs }),
    ...(startCount.value === undefined
      ? {}
      : { parentToolStartCount: startCount.value }),
    ...(endCount.value === undefined
      ? {}
      : { parentToolEndCount: endCount.value }),
    ...(startTimes.value === undefined
      ? {}
      : { parentToolStartTimesMs: startTimes.value }),
    ...(endTimes.value === undefined
      ? {}
      : { parentToolEndTimesMs: endTimes.value }),
    ...(value.pendingMessageHelperPresent === undefined
      ? {}
      : { pendingMessageHelperPresent: value.pendingMessageHelperPresent }),
    ...(adapterPackageVersion === undefined ? {} : { adapterPackageVersion }),
    ...(adapterExtensionSha256 === undefined ? {} : { adapterExtensionSha256 }),
    ...(adapterPackageSourceProven.value === undefined
      ? {}
      : { adapterPackageSourceProven: adapterPackageSourceProven.value }),
    ...(adapterPackageRootMatched.value === undefined
      ? {}
      : { adapterPackageRootMatched: adapterPackageRootMatched.value }),
    ...(adapterExtensionHashMatched.value === undefined
      ? {}
      : { adapterExtensionHashMatched: adapterExtensionHashMatched.value }),
  });
}

function parseRollbackShimCapture(
  value: unknown,
): Result<FixtureShimFacts, SmokeFailure> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "rollback-shim" ||
    !hasOnlyKeys(value, SHIM_CAPTURE_KEYS) ||
    (value.role !== "parent" && value.role !== "child") ||
    (value.phase !== "before-adapter" && value.phase !== "after-adapter") ||
    value.boundary !== ROLLBACK_SHIM_BOUNDARY ||
    value.disabledSurface !== ROLLBACK_DISABLED_SURFACE ||
    value.originalSurfacePresent !== true ||
    value.disabledBeforeAdapterInitialization !== true ||
    value.requiredDelegationSurfacesIntact !== true ||
    typeof value.adapterInitialized !== "boolean" ||
    value.adapterInitialized !== (value.phase === "after-adapter")
  )
    return err(failure("CaptureMalformed", "rollback shim capture is invalid"));
  return ok({
    schemaVersion: 1,
    kind: "rollback-shim",
    role: value.role,
    phase: value.phase,
    boundary: ROLLBACK_SHIM_BOUNDARY,
    disabledSurface: ROLLBACK_DISABLED_SURFACE,
    originalSurfacePresent: true,
    disabledBeforeAdapterInitialization: true,
    requiredDelegationSurfacesIntact: true,
    adapterInitialized: value.adapterInitialized,
  });
}

async function readCaptureSnapshots(
  captureDirectory: string,
): Promise<Result<RawFixtureCaptures, SmokeFailure>> {
  const files: string[] = [];
  for await (const entry of new Bun.Glob("*.json").scan({
    cwd: captureDirectory,
    absolute: true,
  })) {
    files.push(entry);
    if (files.length > 8)
      return err(failure("CaptureMalformed", "capture file bound exceeded"));
  }
  const providers: FixtureProviderCapture[] = [];
  const controls: FixtureControlFacts[] = [];
  const shims: FixtureShimFacts[] = [];
  for (const file of files) {
    const parsed = await ResultAsync.fromThrowable(
      () => Bun.file(file).json() as Promise<unknown>,
      () => failure("CaptureMalformed", "fixture capture could not be read"),
    )();
    if (parsed.isErr()) return err(parsed.error);
    if (!isRecord(parsed.value))
      return err(
        failure("CaptureMalformed", "fixture capture is not an object"),
      );
    if (parsed.value.kind === "provider") {
      const provider = parseProviderCapture(parsed.value);
      if (provider.isErr()) return err(provider.error);
      providers.push(provider.value);
    } else if (parsed.value.kind === "control") {
      const control = parseControlCapture(parsed.value);
      if (control.isErr()) return err(control.error);
      controls.push(control.value);
    } else if (parsed.value.kind === "rollback-shim") {
      const shim = parseRollbackShimCapture(parsed.value);
      if (shim.isErr()) return err(shim.error);
      shims.push(shim.value);
    } else {
      return err(failure("CaptureMalformed", "unknown fixture capture kind"));
    }
  }
  return ok({ providers, controls, shims });
}

const MAX_NATIVE_SESSION_BYTES = MAX_CAPTURE_BYTES * 32;
const MAX_NATIVE_SESSION_FILES = 8;

async function directoryExists(
  path: string,
  resources?: CleanupResourceTracker,
): Promise<Result<boolean, SmokeFailure>> {
  const result = await runBoundedCommand(["test", "-d", path], {
    cwd: resolve("."),
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 2_000,
    resources,
    processKind: "helper",
    allowExitCodes: [1],
  });
  if (result.isErr())
    return err(
      failure("CaptureMalformed", "native session root could not be inspected"),
    );
  return ok(result.value.code === 0);
}

function parseNativeTimestamp(value: unknown): number | undefined {
  if (boundedTimestamp(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function nativeEntryValue(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return record.type === "message" && isRecord(record.message)
    ? record.message
    : record;
}

function nativeText(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  let text = "";
  for (const item of values.slice(0, 64)) {
    if (typeof item === "string") text += item;
    else if (isRecord(item) && typeof item.text === "string") text += item.text;
  }
  return boundText(text, 4_096);
}

function nativeShape(value: unknown, depth = 0): unknown {
  if (depth > 5) return "depth";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: Math.min(value.length, 256),
      items: value.slice(0, 16).map((item) => nativeShape(item, depth + 1)),
    };
  }
  if (!isRecord(value)) return typeof value;
  return {
    kind: "object",
    keys: Object.keys(value)
      .sort()
      .slice(0, 64)
      .map((key) => [key, nativeShape(value[key], depth + 1)]),
  };
}

function classifyNativeFact(
  entry: Record<string, unknown>,
  role: string,
  toolCallCount: number,
): FixtureContextFact | undefined {
  const contentText = nativeText(entry.content);
  const contentBlocks = Array.isArray(entry.content)
    ? entry.content
    : [entry.content];
  const fixtureToolCall = contentBlocks.some(
    (block) =>
      isRecord(block) &&
      block.type === "toolCall" &&
      (block.id === PARENT_TOOL_CALL_ID || block.id === CHILD_TOOL_CALL_ID),
  );
  if (role === "user") {
    // Custom messages become provider user messages in Pi's conversion.
    if (contentText.includes(UNRELATED_CUSTOM_TYPE)) return "unrelated-custom";
    if (
      contentText.includes(PARENT_TASK) ||
      contentText.includes(ROLLBACK_TASK) ||
      contentText.includes(CHILD_TASK) ||
      entry.id === ORIGINAL_TASK_ID
    )
      return "original-task-user";
    if (contentText.includes(ORIGINAL_USER) || entry.id === ORIGINAL_USER_ID)
      return "original-user";
    if (contentText.includes(STEERING_USER) || entry.id === STEERING_USER_ID)
      return "steering-user";
    if (contentText.includes(FOLLOW_UP_USER) || entry.id === FOLLOW_UP_USER_ID)
      return "follow-up-user";
    if (contentText.includes(QUEUED_USER) || entry.id === QUEUED_USER_ID)
      return "queued-user";
    return undefined;
  }
  if (role === "assistant") {
    if (entry.stopReason === "error") return "failed-assistant";
    if (toolCallCount > 0 && fixtureToolCall) return "tool-call";
    if (contentText.includes(FALLBACK_SUCCESS)) return "successful-assistant";
    return undefined;
  }
  if (
    role === "toolResult" &&
    (entry.toolCallId === PARENT_TOOL_CALL_ID ||
      entry.toolCallId === CHILD_TOOL_CALL_ID)
  )
    return "tool-result";
  if (
    role === "custom" &&
    typeof entry.customType === "string" &&
    entry.customType === UNRELATED_CUSTOM_TYPE
  ) {
    return "unrelated-custom";
  }
  return undefined;
}

function describeNativeEntry(
  record: Record<string, unknown>,
  ordinal: number,
  entryIndex: number,
): FixtureHistoryDescriptor | undefined {
  const recordType = record.type;
  if (
    recordType !== "message" &&
    recordType !== "custom_message" &&
    recordType !== "custom"
  ) {
    return undefined;
  }
  if (
    recordType === "custom" &&
    (record.customType === NATIVE_RECOVERY_ENTRY_TYPE ||
      record.customType === PI_NATIVE_THREAD_ENTRY_TYPE)
  ) {
    return undefined;
  }
  const entry = nativeEntryValue(record);
  let role: string;
  if (typeof entry.role === "string") {
    role = entry.role;
  } else {
    role = recordType === "message" ? "unknown" : "custom";
  }
  const content = entry.content;
  let blocks: readonly unknown[];
  if (Array.isArray(content)) {
    blocks = content;
  } else if (content === undefined) {
    blocks = [];
  } else {
    blocks = [content];
  }
  const toolCallCount = blocks.filter(
    (block) => isRecord(block) && block.type === "toolCall",
  ).length;
  const toolResultCount = role === "toolResult" ? 1 : 0;
  const customType =
    typeof entry.customType === "string" ? entry.customType : undefined;
  const markerDetails = isRecord(entry.details) ? entry.details : undefined;
  const markerToken =
    (customType === NATIVE_RECOVERY_MARKER_TYPE ||
      customType === RECOVERY_MARKER) &&
    typeof markerDetails?.token === "string"
      ? markerDetails.token
      : undefined;
  const fact = classifyNativeFact(entry, role, toolCallCount);
  const serialized = Result.fromThrowable(
    () => JSON.stringify(entry),
    () => "",
  )().match(
    (value) => value,
    () => "",
  );
  const shape = Result.fromThrowable(
    () =>
      JSON.stringify({
        content: nativeShape(
          typeof content === "string"
            ? [{ type: "text", text: content }]
            : content,
        ),
        stopReason: entry.stopReason,
        toolCallCount,
        toolResultCount,
      }),
    () => "",
  )().match(
    (value) => value,
    () => "",
  );
  let correlationHash: string | undefined;
  if (markerToken !== undefined) {
    correlationHash = fixtureMarkerTokenHash(markerToken);
  } else if (fact !== undefined) {
    correlationHash = fixtureCorrelationHash(fact);
  }
  const entryType = recordType === "message" ? "message" : recordType;
  return {
    ordinal,
    entryIndex,
    entryTypeHash: fixtureEntryTypeHash(entryType),
    roleHash: fixtureRoleHash(
      role === "user" ||
        role === "assistant" ||
        role === "toolResult" ||
        role === "custom"
        ? role
        : "custom",
    ),
    ...(customType === undefined
      ? {}
      : { customTypeHash: fixtureCustomTypeHash(customType) }),
    contentShapeHash: hashDescriptorPart("fixture-shape", shape),
    contentFingerprintHash: hashDescriptorPart(
      "fixture-fingerprint",
      serialized,
    ),
    contentBlockCount: Math.min(blocks.length, 256),
    toolCallCount: Math.min(toolCallCount, 256),
    toolResultCount,
    ...(correlationHash === undefined ? {} : { correlationHash }),
  };
}

async function readNativeSessionSnapshots(
  paths: ScenarioPaths,
  resources?: CleanupResourceTracker,
): Promise<Result<readonly NativeSessionObservation[], SmokeFailure>> {
  const roots = [
    { role: "parent" as const, root: join(paths.piHome, "sessions") },
    {
      role: "child" as const,
      root: join(paths.dataHome, "weave", "adapters", "pi", "sessions"),
    },
  ];
  const observations: NativeSessionObservation[] = [];
  for (const { role, root } of roots) {
    const exists = await directoryExists(root, resources);
    if (exists.isErr()) return err(exists.error);
    if (!exists.value) continue;
    const files: string[] = [];
    for await (const file of new Bun.Glob("**/*.jsonl").scan({
      cwd: root,
      absolute: true,
    })) {
      files.push(file);
      if (files.length > MAX_NATIVE_SESSION_FILES) {
        return err(
          failure("CaptureMalformed", "native session file bound exceeded"),
        );
      }
    }
    for (const file of files) {
      const bytes = await ResultAsync.fromThrowable(
        () => Bun.file(file).bytes(),
        () => failure("CaptureMalformed", "native session could not be read"),
      )();
      if (bytes.isErr()) return err(bytes.error);
      if (bytes.value.byteLength > MAX_NATIVE_SESSION_BYTES) {
        return err(
          failure(
            "CaptureMalformed",
            "native session exceeds the bounded read",
          ),
        );
      }
      const body = new TextDecoder().decode(bytes.value);
      const records: Record<string, unknown>[] = [];
      for (const line of body.split(/\r?\n/u)) {
        if (line.trim().length === 0) continue;
        const parsed = Result.fromThrowable(
          () => JSON.parse(line) as unknown,
          () =>
            failure("CaptureMalformed", "native session contains invalid JSON"),
        )();
        if (parsed.isErr() || !isRecord(parsed.value)) {
          return err(
            parsed.isErr()
              ? parsed.error
              : failure(
                  "CaptureMalformed",
                  "native session entry is not an object",
                ),
          );
        }
        records.push(parsed.value);
      }
      const header = records[0];
      if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        header.id.length === 0
      ) {
        return err(
          failure("CaptureMalformed", "native session header is invalid"),
        );
      }
      const entries = records.slice(1);
      if (entries.length > MAX_HISTORY_DESCRIPTOR_COUNT) {
        return err(
          failure("CaptureMalformed", "native history entry bound exceeded"),
        );
      }
      const threadIds = entries.flatMap((entry) => {
        if (entry.customType !== PI_NATIVE_THREAD_ENTRY_TYPE) return [];
        const data = isRecord(entry.data) ? entry.data : undefined;
        return typeof data?.threadId === "string" && data.threadId.length > 0
          ? [data.threadId]
          : [];
      });
      const distinctThreadIds = [...new Set(threadIds)];
      if (distinctThreadIds.length > 1) {
        return err(
          failure(
            "CaptureMalformed",
            "native thread identity sources disagree",
          ),
        );
      }
      const threadId = distinctThreadIds[0];
      const descriptors: FixtureHistoryDescriptor[] = [];
      for (const [entryOffset, entry] of entries.entries()) {
        const descriptor = describeNativeEntry(
          entry,
          descriptors.length,
          entryOffset + 1,
        );
        if (descriptor === undefined) continue;
        descriptors.push(descriptor);
        if (descriptors.length > MAX_HISTORY_DESCRIPTOR_COUNT) {
          return err(
            failure("CaptureMalformed", "native descriptor bound exceeded"),
          );
        }
      }
      const markerEntries = entries
        .map((entry, index) => ({ entry, index: index + 1 }))
        .filter(
          ({ entry }) =>
            entry.type === "custom_message" &&
            (entry.customType === NATIVE_RECOVERY_MARKER_TYPE ||
              entry.customType === RECOVERY_MARKER),
        );
      const markerEntry = markerEntries[0]?.entry;
      const markerDescriptor = descriptors.find(
        (descriptor) =>
          descriptor.customTypeHash ===
            fixtureCustomTypeHash(NATIVE_RECOVERY_MARKER_TYPE) &&
          markerEntries.some(({ index }) => descriptor.entryIndex === index),
      );
      const markerDescriptorPosition =
        markerDescriptor === undefined
          ? -1
          : descriptors.indexOf(markerDescriptor);
      // Pi appends a model_change record when setModel applies the fallback.
      // Adjacency is therefore proven among context-bearing descriptors, not
      // by pretending that metadata records are messages. Any real context
      // entry between the failed assistant and marker would break this exact
      // descriptor predecessor relation.
      const failedAssistantDescriptor =
        markerDescriptorPosition <= 0
          ? undefined
          : descriptors[markerDescriptorPosition - 1];
      const markerValue =
        markerEntry === undefined ? undefined : nativeEntryValue(markerEntry);
      const markerDetails = isRecord(markerValue?.details)
        ? markerValue.details
        : undefined;
      const markerToken =
        typeof markerDetails?.token === "string"
          ? markerDetails.token
          : undefined;
      const interveningNativeEntryCount =
        markerDescriptor === undefined ||
        failedAssistantDescriptor === undefined
          ? undefined
          : markerDescriptor.entryIndex -
            failedAssistantDescriptor.entryIndex -
            1;
      const markerCorrelation =
        markerEntries.length === 1 &&
        markerDescriptorPosition > 0 &&
        markerDescriptor !== undefined &&
        failedAssistantDescriptor?.correlationHash ===
          fixtureCorrelationHash("failed-assistant") &&
        interveningNativeEntryCount !== undefined &&
        interveningNativeEntryCount >= 0 &&
        markerToken !== undefined
          ? {
              failedAssistantOrdinal: failedAssistantDescriptor.ordinal,
              markerOrdinal: markerDescriptor.ordinal,
              failedAssistantEntryIndex: failedAssistantDescriptor.entryIndex,
              markerEntryIndex: markerDescriptor.entryIndex,
              interveningNativeEntryCount,
              failedAssistantFingerprintHash:
                failedAssistantDescriptor.contentFingerprintHash,
              markerTokenHash: fixtureMarkerTokenHash(markerToken),
            }
          : undefined;
      const counts = descriptorCounts(descriptors);
      const facts = descriptorFactsFromDescriptors(descriptors);
      const history: FixtureHistoryFacts = {
        entryCount: entries.length,
        historyHash: artifactDigest(bytes.value),
        descriptors,
        ...counts,
        ...facts,
        successfulAssistantPresent: descriptors.some(
          (descriptor) =>
            descriptor.correlationHash ===
            fixtureCorrelationHash("successful-assistant"),
        ),
        recoveryEntryPresent: entries.some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === NATIVE_RECOVERY_ENTRY_TYPE,
        ),
        ...(markerToken === undefined
          ? {}
          : {
              markerTokenHash: fixtureMarkerTokenHash(markerToken),
              markerTokenValid: UUID_V4.test(markerToken),
            }),
        ...(markerCorrelation === undefined ? {} : { markerCorrelation }),
      };
      const modelChanges = entries.filter(
        (entry) => entry.type === "model_change",
      );
      const modelTransitionTimesMs: number[] = [];
      const modelTransitionIdentities: SafeModelIdentity[] = [];
      for (const modelChange of modelChanges) {
        const timestamp = parseNativeTimestamp(modelChange.timestamp);
        if (timestamp === undefined) {
          return err(
            failure(
              "CaptureMalformed",
              "native model transition timestamp is missing",
            ),
          );
        }
        if (
          typeof modelChange.provider !== "string" ||
          typeof modelChange.modelId !== "string" ||
          modelChange.provider.length > 64 ||
          modelChange.modelId.length > 128
        ) {
          return err(
            failure(
              "CaptureMalformed",
              "native model transition identity is malformed",
            ),
          );
        }
        modelTransitionTimesMs.push(timestamp);
        modelTransitionIdentities.push({
          provider: modelChange.provider,
          id: modelChange.modelId,
        });
      }
      const appliedIdentity = modelTransitionIdentities.at(-1);
      observations.push({
        role,
        sessionIdHash: artifactDigest(new TextEncoder().encode(header.id)),
        ...(threadId === undefined
          ? {}
          : {
              threadIdHash: artifactDigest(new TextEncoder().encode(threadId)),
            }),
        history,
        modelTransitions: modelChanges.length,
        modelTransitionTimesMs,
        modelTransitionIdentities,
        recoveryMarkerCount: markerEntries.length,
        ...(appliedIdentity === undefined ? {} : { appliedIdentity }),
      });
    }
  }
  return ok(observations);
}

/**
 * Compare the facts from two independent native-session reads before keeping
 * either read. This closes the time-of-check/time-of-use gap around durable
 * history and model-transition evidence.
 */
function sameNativeSessionFacts(
  left: NativeSessionObservation,
  right: NativeSessionObservation,
): boolean {
  return (
    left.role === right.role &&
    left.sessionIdHash === right.sessionIdHash &&
    left.threadIdHash === right.threadIdHash &&
    sameHistoryFacts(left.history, right.history) &&
    left.modelTransitions === right.modelTransitions &&
    left.modelTransitionTimesMs.length === right.modelTransitionTimesMs.length &&
    left.modelTransitionTimesMs.every(
      (timestamp, index) => timestamp === right.modelTransitionTimesMs[index],
    ) &&
    left.modelTransitionIdentities.length ===
      right.modelTransitionIdentities.length &&
    left.modelTransitionIdentities.every((identity, index) =>
      sameIdentity(identity, right.modelTransitionIdentities[index]),
    ) &&
    left.recoveryMarkerCount === right.recoveryMarkerCount &&
    sameIdentity(left.appliedIdentity, right.appliedIdentity)
  );
}

/**
 * Bind two separate bounded reads of the native session source. Neither side
 * may be filled from the other or from a child-control identity.
 */
function mergeNativeSessionObservations(
  before: readonly NativeSessionObservation[],
  after: readonly NativeSessionObservation[],
): Result<readonly NativeSessionObservation[], SmokeFailure> {
  const roles = new Set([
    ...before.map((entry) => entry.role),
    ...after.map((entry) => entry.role),
  ]);
  const merged: NativeSessionObservation[] = [];
  for (const role of roles) {
    const beforeMatches = before.filter((entry) => entry.role === role);
    const afterMatches = after.filter((entry) => entry.role === role);
    if (beforeMatches.length !== 1 || afterMatches.length !== 1) {
      return err(
        failure(
          "CaptureMalformed",
          `native ${role} identity observation is missing or duplicated`,
        ),
      );
    }
    const beforeEntry = beforeMatches[0];
    const afterEntry = afterMatches[0];
    if (!sameNativeSessionFacts(beforeEntry, afterEntry)) {
      return err(
        failure(
          "CaptureMalformed",
          `native ${role} bounded reads disagree`,
        ),
      );
    }
    const beforeThread = beforeEntry.threadIdHash;
    const afterThread = afterEntry.threadIdHash;
    if ((beforeThread === undefined) !== (afterThread === undefined)) {
      return err(
        failure(
          "CaptureMalformed",
          `native ${role} thread identity observation is incomplete`,
        ),
      );
    }
    merged.push({
      ...afterEntry,
      sessionIdBeforeHash: beforeEntry.sessionIdHash,
      sessionIdAfterHash: afterEntry.sessionIdHash,
      ...(beforeThread === undefined || afterThread === undefined
        ? {}
        : { threadIdBeforeHash: beforeThread, threadIdAfterHash: afterThread }),
    });
  }
  return ok(merged);
}

function assembleSnapshots(
  captures: RawFixtureCaptures,
  nativeSessions: readonly NativeSessionObservation[],
): Result<readonly FixtureSnapshot[], SmokeFailure> {
  const roles = ["parent", "child"] as const;
  const snapshots: FixtureSnapshot[] = [];
  for (const role of roles) {
    const providers = captures.providers.filter(
      (capture) => capture.role === role,
    );
    const controls = captures.controls.filter(
      (capture) => capture.role === role,
    );
    const natives = nativeSessions.filter((session) => session.role === role);
    if (providers.length === 0 && controls.length === 0 && natives.length === 0)
      continue;
    if (
      providers.length !== 1 ||
      controls.length !== 1 ||
      natives.length !== 1
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${role} observation is missing or duplicated`,
        ),
      );
    }
    const provider = providers[0];
    const control = controls[0];
    const native = natives[0];
    const controlIdentity = control.lifecycle.appliedIdentity;
    const nativeIdentity = native.appliedIdentity;
    if (
      controlIdentity !== undefined &&
      nativeIdentity !== undefined &&
      !sameIdentity(controlIdentity, nativeIdentity)
    ) {
      return err(
        failure("CaptureMalformed", `${role} model identities disagree`),
      );
    }
    const identity = controlIdentity ?? nativeIdentity;
    snapshots.push({
      schemaVersion: 1,
      role,
      processIdHash: control.processIdHash,
      ...(control.processIdBeforeHash === undefined
        ? {}
        : { processIdBeforeHash: control.processIdBeforeHash }),
      ...(control.processIdAfterHash === undefined
        ? {}
        : { processIdAfterHash: control.processIdAfterHash }),
      ...(native.sessionIdHash === undefined
        ? {}
        : { sessionIdHash: native.sessionIdHash }),
      ...(native.sessionIdBeforeHash === undefined
        ? {}
        : { sessionIdBeforeHash: native.sessionIdBeforeHash }),
      ...(native.sessionIdAfterHash === undefined
        ? {}
        : { sessionIdAfterHash: native.sessionIdAfterHash }),
      ...(native.threadIdHash === undefined
        ? {}
        : { threadIdHash: native.threadIdHash }),
      ...(native.threadIdBeforeHash === undefined
        ? {}
        : { threadIdBeforeHash: native.threadIdBeforeHash }),
      ...(native.threadIdAfterHash === undefined
        ? {}
        : { threadIdAfterHash: native.threadIdAfterHash }),
      ...(control.childIdHash === undefined
        ? {}
        : { childIdHash: control.childIdHash }),
      ...(control.childIdBeforeHash === undefined
        ? {}
        : { childIdBeforeHash: control.childIdBeforeHash }),
      ...(control.childIdAfterHash === undefined
        ? {}
        : { childIdAfterHash: control.childIdAfterHash }),
      ...(control.markerTokenHash === undefined
        ? {}
        : { markerTokenHash: control.markerTokenHash }),
      ...(control.failedAssistantFingerprintHash === undefined
        ? {}
        : {
            failedAssistantFingerprintHash:
              control.failedAssistantFingerprintHash,
          }),
      ...(control.failedAssistantShapeHash === undefined
        ? {}
        : { failedAssistantShapeHash: control.failedAssistantShapeHash }),
      requestCount: provider.requestCount,
      requests: provider.requests,
      history: native.history,
      lifecycle:
        identity === undefined
          ? control.lifecycle
          : { ...control.lifecycle, appliedIdentity: identity },
      ...(control.parentToolCallIdHash === undefined
        ? {}
        : { parentToolCallIdHash: control.parentToolCallIdHash }),
      ...(control.parentToolEndCallIdHash === undefined
        ? {}
        : { parentToolEndCallIdHash: control.parentToolEndCallIdHash }),
      ...(control.parentToolStartedAtMs === undefined
        ? {}
        : { parentToolStartedAtMs: control.parentToolStartedAtMs }),
      ...(control.parentToolEndedAtMs === undefined
        ? {}
        : { parentToolEndedAtMs: control.parentToolEndedAtMs }),
      ...(control.parentToolPendingMs === undefined
        ? {}
        : { parentToolPendingMs: control.parentToolPendingMs }),
      ...(control.parentToolStartCount === undefined
        ? {}
        : { parentToolStartCount: control.parentToolStartCount }),
      ...(control.parentToolEndCount === undefined
        ? {}
        : { parentToolEndCount: control.parentToolEndCount }),
      ...(control.parentToolStartTimesMs === undefined
        ? {}
        : { parentToolStartTimesMs: control.parentToolStartTimesMs }),
      ...(control.parentToolEndTimesMs === undefined
        ? {}
        : { parentToolEndTimesMs: control.parentToolEndTimesMs }),
      ...(captures.shims.some(
        (shim) =>
          shim.role === role &&
          shim.disabledSurface === ROLLBACK_DISABLED_SURFACE &&
          shim.disabledBeforeAdapterInitialization,
      )
        ? { optionalSurfaceDisabled: true }
        : {}),
      ...(control.lifecycle.settlementCount === 1
        ? { legacySettlement: true }
        : {}),
    });
  }
  return ok(snapshots);
}

function verifiedCleanup(
  observation: ScenarioObservation,
): Result<CleanupVerification, SmokeFailure> {
  if (observation.cleanup === undefined)
    return err(
      failure("CaptureMalformed", "cleanup has no independent verification"),
    );
  const verified = Result.fromThrowable(
    () => {
      const value: unknown = observation.cleanup;
      if (!isRecord(value)) return undefined;
      const keys = Object.keys(value);
      if (
        keys.length !== CLEANUP_VERIFICATION_KEYS.length ||
        CLEANUP_VERIFICATION_KEYS.some((key) => !keys.includes(key))
      )
        return undefined;
      for (const key of CLEANUP_VERIFICATION_KEYS)
        if (typeof value[key] !== "boolean") return undefined;
      return {
        noChildProcess: value.noChildProcess as boolean,
        noNativeChild: value.noNativeChild as boolean,
        noActiveLease: value.noActiveLease as boolean,
        noTemporaryPane: value.noTemporaryPane as boolean,
        noFixtureProcess: value.noFixtureProcess as boolean,
        noPiProcess: value.noPiProcess as boolean,
        noHelperProcess: value.noHelperProcess as boolean,
        temporaryRootRemoved: value.temporaryRootRemoved as boolean,
        timersDisposed: value.timersDisposed as boolean,
        resourcesDisposed: value.resourcesDisposed as boolean,
      };
    },
    () => undefined,
  )();
  if (verified.isErr() || verified.value === undefined)
    return err(failure("CaptureMalformed", "cleanup verification is invalid"));
  return ok(verified.value);
}

function sameMessageFacts(
  left: FixtureMessageFacts,
  right: FixtureMessageFacts | undefined,
): boolean {
  return (
    right !== undefined &&
    left.requestNumber === right.requestNumber &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.messageCount === right.messageCount &&
    left.contextHash === right.contextHash &&
    left.descriptorCount === right.descriptorCount &&
    left.userCount === right.userCount &&
    left.assistantCount === right.assistantCount &&
    left.toolResultCount === right.toolResultCount &&
    left.customCount === right.customCount &&
    left.descriptors.length === right.descriptors.length &&
    left.descriptors.every((descriptor, index) =>
      sameDescriptor(
        descriptor,
        right.descriptors[index] as FixtureMessageDescriptor,
      ),
    ) &&
    left.originalUserPresent === right.originalUserPresent &&
    left.taskPresent === right.taskPresent &&
    left.toolCallPresent === right.toolCallPresent &&
    left.toolResultPresent === right.toolResultPresent &&
    left.failedAssistantPresent === right.failedAssistantPresent &&
    left.recoveryMarkerPresent === right.recoveryMarkerPresent &&
    left.syntheticProviderUserMessagePresent ===
      right.syntheticProviderUserMessagePresent
  );
}

function sameHistoryFacts(
  left: FixtureHistoryFacts,
  right: FixtureHistoryFacts | undefined,
): boolean {
  return (
    right !== undefined &&
    left.entryCount === right.entryCount &&
    left.historyHash === right.historyHash &&
    left.descriptorCount === right.descriptorCount &&
    left.userCount === right.userCount &&
    left.assistantCount === right.assistantCount &&
    left.toolResultCount === right.toolResultCount &&
    left.customCount === right.customCount &&
    left.descriptors.length === right.descriptors.length &&
    left.descriptors.every((descriptor, index) =>
      sameHistoryDescriptor(
        descriptor,
        right.descriptors[index] as FixtureHistoryDescriptor,
      ),
    ) &&
    left.failedAssistantPresent === right.failedAssistantPresent &&
    left.recoveryMarkerPresent === right.recoveryMarkerPresent &&
    left.successfulAssistantPresent === right.successfulAssistantPresent &&
    left.recoveryEntryPresent === right.recoveryEntryPresent &&
    left.markerTokenHash === right.markerTokenHash &&
    left.markerTokenValid === right.markerTokenValid &&
    JSON.stringify(left.markerCorrelation) ===
      JSON.stringify(right.markerCorrelation)
  );
}

function sameIdentity(
  left: SafeModelIdentity | undefined,
  right: SafeModelIdentity | undefined,
): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function sameNumberArray(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateObservationBindings(
  observation: ScenarioObservation,
  snapshots: readonly FixtureSnapshot[],
  smokeCase: Exclude<SmokeCase, "all">,
): Result<void, SmokeFailure> {
  for (const role of ["parent", "child"] as const) {
    if (
      observation.providerCaptures.filter((capture) => capture.role === role)
        .length > 1
    ) {
      return err(
        failure("CaptureMalformed", `duplicate provider capture for ${role}`),
      );
    }
    if (
      observation.controls.filter((capture) => capture.role === role).length > 1
    ) {
      return err(
        failure("CaptureMalformed", `duplicate control capture for ${role}`),
      );
    }
    if (
      observation.nativeSessions.filter((session) => session.role === role)
        .length > 1
    ) {
      return err(
        failure("CaptureMalformed", `duplicate native capture for ${role}`),
      );
    }
  }
  for (const snapshot of snapshots) {
    const provider = observation.providerCaptures.find(
      (capture) => capture.role === snapshot.role,
    );
    const control = observation.controls.find(
      (capture) => capture.role === snapshot.role,
    );
    const native = observation.nativeSessions.find(
      (session) => session.role === snapshot.role,
    );
    if (
      provider === undefined ||
      control === undefined ||
      native === undefined
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `missing host observation for ${snapshot.role}`,
        ),
      );
    }
    const controlIdentity = control.lifecycle.appliedIdentity;
    const nativeIdentity = native.appliedIdentity;
    if (
      controlIdentity !== undefined &&
      nativeIdentity !== undefined &&
      !sameIdentity(controlIdentity, nativeIdentity)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} model identities disagree`,
        ),
      );
    }
    const mismatches = [
      [
        "provider.requestCount",
        provider.requestCount !== snapshot.requestCount,
      ],
      [
        "provider.requests",
        provider.requests.length !== snapshot.requests.length ||
          provider.requests.some(
            (request, index) =>
              !sameMessageFacts(request, snapshot.requests[index]),
          ),
      ],
      [
        "control.processIdHash",
        control.processIdHash !== snapshot.processIdHash,
      ],
      [
        "control.processIdBeforeHash",
        control.processIdBeforeHash !== snapshot.processIdBeforeHash,
      ],
      [
        "control.processIdAfterHash",
        control.processIdAfterHash !== snapshot.processIdAfterHash,
      ],
      ["control.childIdHash", control.childIdHash !== snapshot.childIdHash],
      [
        "control.childIdBeforeHash",
        control.childIdBeforeHash !== snapshot.childIdBeforeHash,
      ],
      [
        "control.childIdAfterHash",
        control.childIdAfterHash !== snapshot.childIdAfterHash,
      ],
      [
        "control.markerTokenHash",
        control.markerTokenHash !== snapshot.markerTokenHash,
      ],
      [
        "control.failedAssistantFingerprintHash",
        control.failedAssistantFingerprintHash !==
          snapshot.failedAssistantFingerprintHash,
      ],
      [
        "control.failedAssistantShapeHash",
        control.failedAssistantShapeHash !== snapshot.failedAssistantShapeHash,
      ],
      ["native.sessionIdHash", native.sessionIdHash !== snapshot.sessionIdHash],
      [
        "native.sessionIdBeforeHash",
        native.sessionIdBeforeHash !== snapshot.sessionIdBeforeHash,
      ],
      [
        "native.sessionIdAfterHash",
        native.sessionIdAfterHash !== snapshot.sessionIdAfterHash,
      ],
      ["native.threadIdHash", native.threadIdHash !== snapshot.threadIdHash],
      [
        "native.threadIdBeforeHash",
        native.threadIdBeforeHash !== snapshot.threadIdBeforeHash,
      ],
      [
        "native.threadIdAfterHash",
        native.threadIdAfterHash !== snapshot.threadIdAfterHash,
      ],
      [
        "native.history",
        snapshot.history !== undefined &&
          !sameHistoryFacts(native.history, snapshot.history),
      ],
      [
        "native.modelTransitions",
        (smokeCase === "rollback"
          ? native.modelTransitions < control.lifecycle.modelSelectCount
          : native.modelTransitions !== control.lifecycle.modelSelectCount) ||
          native.modelTransitionTimesMs.length !== native.modelTransitions ||
          native.modelTransitionIdentities.length !== native.modelTransitions,
      ],
      [
        "native.recoveryMarkerCount",
        snapshot.role === "child" &&
          native.recoveryMarkerCount !==
            control.lifecycle.markerMessageStartCount,
      ],
      [
        "lifecycle.beforeAgentStartCount",
        control.lifecycle.beforeAgentStartCount !==
          snapshot.lifecycle.beforeAgentStartCount,
      ],
      [
        "lifecycle.messageStartCount",
        control.lifecycle.messageStartCount !==
          snapshot.lifecycle.messageStartCount,
      ],
      [
        "lifecycle.messageEndCount",
        control.lifecycle.messageEndCount !==
          snapshot.lifecycle.messageEndCount,
      ],
      [
        "lifecycle.contextCount",
        control.lifecycle.contextCount !== snapshot.lifecycle.contextCount,
      ],
      [
        "lifecycle.contextRepairCount",
        control.lifecycle.contextRepairCount !==
          snapshot.lifecycle.contextRepairCount ||
          !sameNumberArray(
            control.lifecycle.contextRepairTimesMs,
            snapshot.lifecycle.contextRepairTimesMs,
          ),
      ],
      [
        "lifecycle.modelSelectCount",
        control.lifecycle.modelSelectCount !==
          snapshot.lifecycle.modelSelectCount ||
          !sameNumberArray(
            control.lifecycle.modelSelectTimesMs,
            snapshot.lifecycle.modelSelectTimesMs,
          ),
      ],
      [
        "lifecycle.settlementCount",
        control.lifecycle.settlementCount !==
          snapshot.lifecycle.settlementCount ||
          !sameNumberArray(
            control.lifecycle.settlementTimesMs,
            snapshot.lifecycle.settlementTimesMs,
          ),
      ],
      [
        "lifecycle.markerMessageStartCount",
        control.lifecycle.markerMessageStartCount !==
          snapshot.lifecycle.markerMessageStartCount ||
          !sameNumberArray(
            control.lifecycle.markerMessageStartTimesMs,
            snapshot.lifecycle.markerMessageStartTimesMs,
          ),
      ],
      [
        "lifecycle.recoveryMarker",
        control.lifecycle.recoveryMarkerCount !==
          snapshot.lifecycle.recoveryMarkerCount ||
          control.lifecycle.recoveryMarkerObserved !==
            snapshot.lifecycle.recoveryMarkerObserved,
      ],
      [
        "parentTool.timestamps",
        control.parentToolStartedAtMs !== snapshot.parentToolStartedAtMs ||
          control.parentToolEndedAtMs !== snapshot.parentToolEndedAtMs ||
          control.parentToolPendingMs !== snapshot.parentToolPendingMs,
      ],
      [
        "parentTool.counts",
        control.parentToolStartCount !== snapshot.parentToolStartCount ||
          control.parentToolEndCount !== snapshot.parentToolEndCount ||
          !sameNumberArray(
            control.parentToolStartTimesMs,
            snapshot.parentToolStartTimesMs,
          ) ||
          !sameNumberArray(
            control.parentToolEndTimesMs,
            snapshot.parentToolEndTimesMs,
          ),
      ],
      [
        "parentTool.identity",
        control.parentToolCallIdHash !== snapshot.parentToolCallIdHash ||
          control.parentToolEndCallIdHash !== snapshot.parentToolEndCallIdHash,
      ],
      [
        "model.identity",
        smokeCase === "rollback"
          ? controlIdentity !== undefined &&
            !sameIdentity(controlIdentity, snapshot.lifecycle.appliedIdentity)
          : !sameIdentity(
              controlIdentity ?? nativeIdentity,
              snapshot.lifecycle.appliedIdentity,
            ),
      ],
    ]
      .filter(([, mismatch]) => mismatch)
      .map(([field]) => field);
    if (mismatches.length > 0) {
      return err(
        failure(
          "CaptureMalformed",
          `host observations do not bind to ${snapshot.role}: ${mismatches.join(",")}`,
        ),
      );
    }
  }
  return ok(undefined);
}

function requireStableHash(
  before: string | undefined,
  after: string | undefined,
  label: string,
): Result<true, SmokeFailure> {
  if (
    before === undefined ||
    after === undefined ||
    !SHA256.test(before) ||
    !SHA256.test(after)
  ) {
    return err(failure("CaptureMalformed", `${label} identity is missing`));
  }
  if (before !== after) {
    return err(
      failure(
        "CaptureMalformed",
        `${label} identity changed between observations`,
      ),
    );
  }
  return ok(true);
}

function validateLifecycleEvidence(
  lifecycle: FixtureLifecycleFacts,
  role: FixtureSnapshot["role"],
): Result<void, SmokeFailure> {
  if (
    [
      lifecycle.beforeAgentStartCount,
      lifecycle.messageStartCount,
      lifecycle.messageEndCount,
      lifecycle.contextCount,
      lifecycle.contextRepairCount,
      lifecycle.modelSelectCount,
      lifecycle.settlementCount,
      lifecycle.markerMessageStartCount,
      lifecycle.recoveryMarkerCount,
    ].some((count) => !boundedCount(count)) ||
    lifecycle.contextRepairCount > lifecycle.contextCount ||
    lifecycle.markerMessageStartCount > lifecycle.messageStartCount ||
    lifecycle.markerMessageStartCount !== lifecycle.recoveryMarkerCount ||
    lifecycle.recoveryMarkerObserved !==
      lifecycle.markerMessageStartCount > 0 ||
    lifecycle.contextRepairTimesMs.length !== lifecycle.contextRepairCount ||
    lifecycle.modelSelectTimesMs.length !== lifecycle.modelSelectCount ||
    lifecycle.settlementTimesMs.length !== lifecycle.settlementCount ||
    lifecycle.markerMessageStartTimesMs.length !==
      lifecycle.markerMessageStartCount ||
    lifecycle.contextRepairTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    ) ||
    lifecycle.modelSelectTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    ) ||
    lifecycle.settlementTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    ) ||
    lifecycle.markerMessageStartTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    )
  ) {
    return err(
      failure(
        "UnexpectedEventCount",
        `${role} lifecycle evidence is inconsistent`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Fail closed when the real smoke did not provide an independent observation
 * source. Identity stability is accepted only when two bounded observations
 * of the same public source compare equal.
 */
export function validateObservedSources(input: {
  readonly observation: ScenarioObservation;
  readonly snapshots: readonly FixtureSnapshot[];
  readonly smokeCase: Exclude<SmokeCase, "all">;
}): Result<void, SmokeFailure> {
  if (input.smokeCase === "rollback") {
    const health = validateHealthObservation(input.observation.health);
    if (health.isErr()) return err(health.error);
    if ((input.observation.shims ?? []).length === 0)
      return err(
        failure(
          "CaptureMalformed",
          "rollback shim boundary observation is missing",
        ),
      );
  } else if (input.observation.health !== undefined) {
    const health = validateHealthObservation(input.observation.health);
    if (health.isErr()) return err(health.error);
  }
  if (
    input.observation.visibleEventCount === undefined ||
    !boundedCount(input.observation.visibleEventCount)
  ) {
    return err(failure("CaptureMalformed", "visible event count is missing"));
  }
  const observedVisibleEventCount = visibleEventCount(input.observation.output);
  if (observedVisibleEventCount !== input.observation.visibleEventCount) {
    return err(
      failure(
        "UnexpectedEventCount",
        "visible event count disagrees with bounded TUI output",
      ),
    );
  }
  const bindings = validateObservationBindings(
    input.observation,
    input.snapshots,
    input.smokeCase,
  );
  if (bindings.isErr()) return err(bindings.error);
  const parent = input.snapshots.find((snapshot) => snapshot.role === "parent");
  const child = input.snapshots.find((snapshot) => snapshot.role === "child");
  if (parent === undefined) {
    return err(failure("CaptureMalformed", "parent observation is missing"));
  }
  if (input.smokeCase === "fallback" && child === undefined) {
    return err(failure("CaptureMalformed", "child observation is missing"));
  }
  for (const snapshot of input.snapshots) {
    const process = requireStableHash(
      snapshot.processIdBeforeHash,
      snapshot.processIdAfterHash,
      `${snapshot.role} process`,
    );
    if (process.isErr()) return err(process.error);
    if (
      snapshot.processIdHash !== snapshot.processIdAfterHash ||
      snapshot.processIdHash === undefined ||
      !SHA256.test(snapshot.processIdHash)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} process identity sources disagree`,
        ),
      );
    }
    const session = requireStableHash(
      snapshot.sessionIdBeforeHash,
      snapshot.sessionIdAfterHash,
      `${snapshot.role} native session`,
    );
    if (session.isErr()) return err(session.error);
    if (
      snapshot.sessionIdHash !== snapshot.sessionIdAfterHash ||
      snapshot.sessionIdHash === undefined ||
      !SHA256.test(snapshot.sessionIdHash)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} native session identity sources disagree`,
        ),
      );
    }
    const lifecycle = validateLifecycleEvidence(
      snapshot.lifecycle,
      snapshot.role,
    );
    if (lifecycle.isErr()) return err(lifecycle.error);
    if (
      snapshot.role === "parent" &&
      (snapshot.childIdHash !== undefined ||
        snapshot.threadIdHash !== undefined)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          "parent observation contains child identity",
        ),
      );
    }
    if (snapshot.processIdHash === snapshot.sessionIdHash) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} process identity was aliased to native session identity`,
        ),
      );
    }
    if (snapshot.role === "child") {
      const childIdentity = requireStableHash(
        snapshot.childIdBeforeHash,
        snapshot.childIdAfterHash,
        "child process control",
      );
      if (childIdentity.isErr()) return err(childIdentity.error);
      const thread = requireStableHash(
        snapshot.threadIdBeforeHash,
        snapshot.threadIdAfterHash,
        "child native thread",
      );
      if (thread.isErr()) return err(thread.error);
      if (
        snapshot.childIdHash !== snapshot.childIdAfterHash ||
        snapshot.threadIdHash !== snapshot.threadIdAfterHash ||
        snapshot.childIdHash === undefined ||
        snapshot.threadIdHash === undefined ||
        snapshot.childIdHash === snapshot.threadIdHash
      ) {
        return err(
          failure(
            "CaptureMalformed",
            "thread identity was aliased to child identity",
          ),
        );
      }
      if (
        snapshot.sessionIdHash === snapshot.threadIdHash ||
        snapshot.processIdHash === snapshot.childIdHash ||
        snapshot.processIdHash === snapshot.threadIdHash ||
        snapshot.sessionIdHash === snapshot.childIdHash
      ) {
        return err(
          failure("CaptureMalformed", "child runtime identities were aliased"),
        );
      }
    }
    const native = input.observation.nativeSessions.find(
      (sessionObservation) => sessionObservation.role === snapshot.role,
    );
    if (native === undefined) {
      return err(
        failure(
          "CaptureMalformed",
          `native observation is missing for ${snapshot.role}`,
        ),
      );
    }
    if (
      (input.smokeCase === "rollback"
        ? native.modelTransitions < snapshot.lifecycle.modelSelectCount
        : native.modelTransitions !== snapshot.lifecycle.modelSelectCount) ||
      native.modelTransitionTimesMs.length !== native.modelTransitions ||
      native.modelTransitionIdentities.length !== native.modelTransitions ||
      native.modelTransitionTimesMs.some(
        (timestamp) => !boundedTimestamp(timestamp),
      )
    ) {
      return err(
        failure(
          "UnexpectedEventCount",
          `${snapshot.role} model transition evidence is inconsistent`,
        ),
      );
    }
    if (
      snapshot.role === "child" &&
      native.recoveryMarkerCount !== snapshot.lifecycle.markerMessageStartCount
    ) {
      return err(
        failure(
          "UnexpectedEventCount",
          "native marker count disagrees with exact message_start evidence",
        ),
      );
    }
  }
  if (
    parent !== undefined &&
    child !== undefined &&
    (parent.processIdHash === child.processIdHash ||
      parent.sessionIdHash === child.sessionIdHash ||
      parent.processIdBeforeHash === child.processIdBeforeHash ||
      parent.sessionIdBeforeHash === child.sessionIdBeforeHash)
  ) {
    return err(
      failure("CaptureMalformed", "parent and child identities were aliased"),
    );
  }
  if (input.smokeCase === "fallback") {
    if (
      parent.parentToolCallIdHash === undefined ||
      parent.parentToolEndCallIdHash === undefined ||
      !SHA256.test(parent.parentToolCallIdHash) ||
      !SHA256.test(parent.parentToolEndCallIdHash) ||
      parent.parentToolCallIdHash !== parent.parentToolEndCallIdHash ||
      parent.parentToolStartCount !== 1 ||
      parent.parentToolEndCount !== 1 ||
      parent.parentToolStartTimesMs?.length !== 1 ||
      parent.parentToolEndTimesMs?.length !== 1 ||
      parent.parentToolStartedAtMs === undefined ||
      parent.parentToolEndedAtMs === undefined ||
      parent.parentToolStartTimesMs[0] !== parent.parentToolStartedAtMs ||
      parent.parentToolEndTimesMs[0] !== parent.parentToolEndedAtMs ||
      parent.parentToolEndedAtMs < parent.parentToolStartedAtMs ||
      parent.parentToolPendingMs === undefined ||
      parent.parentToolPendingMs !==
        parent.parentToolEndedAtMs - parent.parentToolStartedAtMs ||
      parent.parentToolPendingMs > MAX_COMMAND_TIMEOUT_MS
    ) {
      return err(
        failure(
          "CaptureMalformed",
          "parent tool identity or timestamps are missing",
        ),
      );
    }
    if (
      parent.parentToolCallIdHash === parent.processIdHash ||
      parent.parentToolCallIdHash === parent.sessionIdHash ||
      parent.parentToolCallIdHash === child?.childIdHash ||
      parent.parentToolCallIdHash === child?.threadIdHash
    ) {
      return err(
        failure("CaptureMalformed", "parent tool identity was aliased"),
      );
    }
  }
  return ok(undefined);
}

function isSafeDescriptor(
  value: unknown,
  history: boolean,
): value is FixtureMessageDescriptor | FixtureHistoryDescriptor {
  if (!isRecord(value)) return false;
  const allowed = history ? HISTORY_DESCRIPTOR_KEYS : MESSAGE_DESCRIPTOR_KEYS;
  if (!hasOnlyKeys(value, allowed)) return false;
  if (
    !boundedCount(value.ordinal) ||
    value.ordinal >=
      (history ? MAX_HISTORY_DESCRIPTOR_COUNT : MAX_CONTEXT_DESCRIPTOR_COUNT) ||
    !boundedCount(value.contentBlockCount) ||
    !boundedCount(value.toolCallCount) ||
    !boundedCount(value.toolResultCount) ||
    typeof value.roleHash !== "string" ||
    ![
      fixtureRoleHash("user"),
      fixtureRoleHash("assistant"),
      fixtureRoleHash("toolResult"),
      fixtureRoleHash("custom"),
    ].includes(value.roleHash) ||
    typeof value.contentShapeHash !== "string" ||
    !SHA256.test(value.contentShapeHash) ||
    typeof value.contentFingerprintHash !== "string" ||
    !SHA256.test(value.contentFingerprintHash)
  ) {
    return false;
  }
  if (
    value.customTypeHash !== undefined &&
    (typeof value.customTypeHash !== "string" ||
      !SHA256.test(value.customTypeHash) ||
      value.roleHash !== fixtureRoleHash("custom"))
  ) {
    return false;
  }
  if (
    value.correlationHash !== undefined &&
    (typeof value.correlationHash !== "string" ||
      !SHA256.test(value.correlationHash))
  ) {
    return false;
  }
  if (!history) return true;
  return (
    boundedCount(value.entryIndex) &&
    value.entryIndex <= MAX_HISTORY_DESCRIPTOR_COUNT &&
    typeof value.entryTypeHash === "string" &&
    SHA256.test(value.entryTypeHash) &&
    [
      fixtureEntryTypeHash("message"),
      fixtureEntryTypeHash("custom_message"),
      fixtureEntryTypeHash("custom"),
    ].includes(value.entryTypeHash)
  );
}

function descriptorMatchesFact(
  descriptor: FixtureMessageDescriptor,
  fact: FixtureContextFact,
  history: boolean,
): boolean {
  const customType = history ? FACT_CUSTOM_TYPES[fact] : undefined;
  const expectedRole = history ? FACT_ROLES[fact] : FACT_PROVIDER_ROLES[fact];
  const correlationMatches =
    fact === "recovery-marker"
      ? descriptor.correlationHash !== undefined &&
        SHA256.test(descriptor.correlationHash) &&
        descriptor.correlationHash !== fixtureCorrelationHash("recovery-marker")
      : descriptor.correlationHash === fixtureCorrelationHash(fact);
  return (
    descriptor.roleHash === fixtureRoleHash(expectedRole) &&
    descriptor.customTypeHash ===
      (customType === undefined
        ? undefined
        : fixtureCustomTypeHash(customType)) &&
    correlationMatches
  );
}

function validateDescriptorSequence(
  descriptors: readonly FixtureMessageDescriptor[],
  expectedFacts: readonly FixtureContextFact[],
  label: string,
  history = false,
): Result<void, SmokeFailure> {
  if (descriptors.length !== expectedFacts.length) {
    return err(
      failure(
        "ProviderContextViolation",
        `${label} descriptor count is not exact`,
      ),
    );
  }
  for (const [index, fact] of expectedFacts.entries()) {
    const descriptor = descriptors[index];
    const expectedEntryType =
      fact === "unrelated-custom" || fact === "recovery-marker"
        ? "custom_message"
        : "message";
    if (
      descriptor === undefined ||
      !isSafeDescriptor(descriptor, history) ||
      descriptor.ordinal !== index ||
      !descriptorMatchesFact(descriptor, fact, history) ||
      ("entryTypeHash" in descriptor &&
        descriptor.entryTypeHash !== fixtureEntryTypeHash(expectedEntryType))
    ) {
      return err(
        failure(
          "ProviderContextViolation",
          `${label} descriptor sequence is missing, reordered, duplicated, or ambiguous`,
        ),
      );
    }
  }
  return ok(undefined);
}

function validateExactProviderContext(
  request: FixtureMessageFacts,
): Result<void, SmokeFailure> {
  const counts = descriptorCounts(request.descriptors);
  if (
    request.messageCount !== request.descriptors.length ||
    request.descriptorCount !== counts.descriptorCount ||
    request.userCount !== counts.userCount ||
    request.assistantCount !== counts.assistantCount ||
    request.toolResultCount !== counts.toolResultCount ||
    request.customCount !== counts.customCount
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "fallback provider descriptor counts disagree",
      ),
    );
  }
  const sequence = validateDescriptorSequence(
    request.descriptors,
    EXPECTED_PROVIDER_FACTS,
    "fallback provider",
  );
  if (sequence.isErr()) return err(sequence.error);
  const derived = descriptorFactsFromDescriptors(request.descriptors);
  if (
    request.originalUserPresent !== derived.originalUserPresent ||
    request.taskPresent !== derived.taskPresent ||
    request.toolCallPresent !== derived.toolCallPresent ||
    request.toolResultPresent !== derived.toolResultPresent ||
    request.failedAssistantPresent !== false ||
    request.recoveryMarkerPresent !== false ||
    request.syntheticProviderUserMessagePresent !== false
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback provider facts do not match the exact descriptor set",
      ),
    );
  }
  const userDescriptors = request.descriptors.filter(
    (descriptor) => descriptor.roleHash === fixtureRoleHash("user"),
  );
  const expectedUsers = EXPECTED_PROVIDER_FACTS.filter(
    (fact) => FACT_PROVIDER_ROLES[fact] === "user",
  );
  if (
    userDescriptors.length !== expectedUsers.length ||
    userDescriptors.some(
      (descriptor, index) =>
        descriptor.correlationHash !==
        fixtureCorrelationHash(expectedUsers[index]),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "provider context contains an extra or synthetic user",
      ),
    );
  }
  return ok(undefined);
}

function validateFailedProviderContext(
  request: FixtureMessageFacts,
): Result<void, SmokeFailure> {
  const expectedFacts: readonly FixtureContextFact[] = [
    ...EXPECTED_PROVIDER_FACTS,
    "failed-assistant",
  ];
  const sequence = validateDescriptorSequence(
    request.descriptors,
    expectedFacts,
    "failed provider",
  );
  if (sequence.isErr()) return err(sequence.error);
  const derived = descriptorFactsFromDescriptors(request.descriptors);
  if (
    request.messageCount !== request.descriptors.length ||
    request.descriptorCount !== request.descriptors.length ||
    request.failedAssistantPresent !== true ||
    request.recoveryMarkerPresent !== false ||
    request.syntheticProviderUserMessagePresent !== false ||
    derived.failedAssistantPresent !== true ||
    derived.recoveryMarkerPresent !== false
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "failed provider context does not contain the exact real prefix",
      ),
    );
  }
  const expectedUsers = EXPECTED_PROVIDER_FACTS.filter(
    (fact) => FACT_PROVIDER_ROLES[fact] === "user",
  );
  const userDescriptors = request.descriptors.filter(
    (descriptor) => descriptor.roleHash === fixtureRoleHash("user"),
  );
  if (
    userDescriptors.length !== expectedUsers.length ||
    userDescriptors.some(
      (descriptor, index) =>
        descriptor.correlationHash !==
        fixtureCorrelationHash(expectedUsers[index]),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "failed provider context contains an extra or synthetic user",
      ),
    );
  }
  return ok(undefined);
}

function validateProviderContextContinuity(
  failedRequest: FixtureMessageFacts,
  fallbackRequest: FixtureMessageFacts,
): Result<void, SmokeFailure> {
  if (
    failedRequest.descriptors.length !== EXPECTED_PROVIDER_FACTS.length + 1 ||
    fallbackRequest.descriptors.length !== EXPECTED_PROVIDER_FACTS.length
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "provider context prefix length is not exact",
      ),
    );
  }
  for (const [index, fact] of EXPECTED_PROVIDER_FACTS.entries()) {
    const failedDescriptor = failedRequest.descriptors[index];
    const fallbackDescriptor = fallbackRequest.descriptors[index];
    if (
      failedDescriptor === undefined ||
      fallbackDescriptor === undefined ||
      failedDescriptor.correlationHash !== fixtureCorrelationHash(fact) ||
      fallbackDescriptor.correlationHash !== fixtureCorrelationHash(fact) ||
      !sameContextDescriptor(failedDescriptor, fallbackDescriptor)
    ) {
      return err(
        failure(
          "ProviderContextViolation",
          "failed and fallback provider contexts do not preserve the same ordered prefix",
        ),
      );
    }
  }
  return ok(undefined);
}

function validateExactDurableHistory(
  history: FixtureHistoryFacts,
  control: FixtureControlFacts | undefined,
): Result<void, SmokeFailure> {
  const counts = descriptorCounts(history.descriptors);
  if (
    !boundedCount(history.entryCount) ||
    history.entryCount < history.descriptors.length ||
    history.descriptorCount !== counts.descriptorCount ||
    history.userCount !== counts.userCount ||
    history.assistantCount !== counts.assistantCount ||
    history.toolResultCount !== counts.toolResultCount ||
    history.customCount !== counts.customCount
  ) {
    return err(
      failure("CaptureMalformed", "durable descriptor counts disagree"),
    );
  }
  const sequence = validateDescriptorSequence(
    history.descriptors,
    EXPECTED_HISTORY_FACTS,
    "durable native history",
    true,
  );
  if (sequence.isErr()) return err(sequence.error);
  const failed = history.descriptors[7];
  const marker = history.descriptors[8];
  const successful = history.descriptors[9];
  if (
    failed === undefined ||
    marker === undefined ||
    successful === undefined
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "durable failed, marker, or successful descriptor is missing",
      ),
    );
  }
  if (
    history.failedAssistantPresent !== true ||
    history.recoveryMarkerPresent !== true ||
    history.successfulAssistantPresent !== true ||
    history.recoveryEntryPresent !== true ||
    history.markerTokenValid !== true ||
    history.markerTokenHash === undefined ||
    history.markerCorrelation === undefined
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "durable history facts are incomplete",
      ),
    );
  }
  const entryIndexes = history.descriptors.map(
    (descriptor) => descriptor.entryIndex,
  );
  if (
    entryIndexes.some(
      (entryIndex, index) =>
        entryIndex < 1 ||
        entryIndex > history.entryCount ||
        (index > 0 && entryIndex <= (entryIndexes[index - 1] as number)),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "durable native descriptor indexes are missing, duplicated, or reordered",
      ),
    );
  }
  const correlation = history.markerCorrelation;
  const interveningNativeEntryCount = marker.entryIndex - failed.entryIndex - 1;
  if (
    correlation.failedAssistantOrdinal !== failed.ordinal ||
    correlation.markerOrdinal !== marker.ordinal ||
    correlation.failedAssistantEntryIndex !== failed.entryIndex ||
    correlation.markerEntryIndex !== marker.entryIndex ||
    interveningNativeEntryCount < 0 ||
    correlation.interveningNativeEntryCount !== interveningNativeEntryCount ||
    correlation.failedAssistantFingerprintHash !==
      failed.contentFingerprintHash ||
    correlation.markerTokenHash !== marker.correlationHash ||
    correlation.markerTokenHash !== history.markerTokenHash ||
    control?.markerTokenHash !== history.markerTokenHash ||
    correlation.failedAssistantFingerprintHash ===
      successful.contentFingerprintHash ||
    successful.ordinal <= marker.ordinal ||
    successful.entryIndex <= marker.entryIndex ||
    control === undefined ||
    control.failedAssistantFingerprintHash !== failed.contentFingerprintHash ||
    control.failedAssistantShapeHash !== failed.contentShapeHash
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "marker adjacency or fingerprint correlation is not exact",
      ),
    );
  }
  if (marker.roleHash !== fixtureRoleHash("custom")) {
    return err(
      failure("ProviderContextViolation", "recovery marker role is ambiguous"),
    );
  }
  return ok(undefined);
}

function validateProviderDurableCommonFacts(
  provider: FixtureMessageFacts,
  history: FixtureHistoryFacts,
): Result<void, SmokeFailure> {
  for (const fact of EXPECTED_PROVIDER_FACTS) {
    const providerDescriptor = provider.descriptors.find(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash(fact),
    );
    const historyDescriptor = history.descriptors.find(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash(fact),
    );
    const sameFact =
      fact === "unrelated-custom"
        ? providerDescriptor !== undefined &&
          historyDescriptor !== undefined &&
          providerDescriptor.roleHash === fixtureRoleHash("user") &&
          providerDescriptor.customTypeHash === undefined &&
          historyDescriptor.roleHash === fixtureRoleHash("custom") &&
          historyDescriptor.customTypeHash ===
            fixtureCustomTypeHash(UNRELATED_CUSTOM_TYPE) &&
          providerDescriptor.contentShapeHash ===
            historyDescriptor.contentShapeHash &&
          providerDescriptor.contentBlockCount ===
            historyDescriptor.contentBlockCount &&
          providerDescriptor.toolCallCount ===
            historyDescriptor.toolCallCount &&
          providerDescriptor.toolResultCount ===
            historyDescriptor.toolResultCount &&
          providerDescriptor.correlationHash ===
            historyDescriptor.correlationHash
        : providerDescriptor !== undefined &&
          historyDescriptor !== undefined &&
          sameContextDescriptor(providerDescriptor, historyDescriptor);
    if (
      providerDescriptor === undefined ||
      historyDescriptor === undefined ||
      !sameFact
    ) {
      return err(
        failure(
          "ProviderContextViolation",
          `provider and durable ${fact} descriptors disagree`,
        ),
      );
    }
  }
  return ok(undefined);
}

export function validateFallbackFacts(input: {
  readonly observation: ScenarioObservation;
  readonly child: FixtureSnapshot;
  readonly parent: FixtureSnapshot;
}): Result<FallbackScenarioFacts, SmokeFailure> {
  const { observation, child, parent } = input;
  const sources = validateObservedSources({
    observation,
    snapshots: [child, parent],
    smokeCase: "fallback",
  });
  if (sources.isErr()) return err(sources.error);
  const childControl = observation.controls.find(
    (capture) => capture.role === "child",
  );
  const childNative = observation.nativeSessions.find(
    (session) => session.role === "child",
  );
  if (
    childControl?.lifecycle.appliedIdentity === undefined ||
    childNative?.appliedIdentity === undefined ||
    !sameIdentity(
      childControl.lifecycle.appliedIdentity,
      childNative.appliedIdentity,
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "model_select and native model identities are incomplete",
      ),
    );
  }
  const requests = child.requests;
  const fallbackRequests = requests.filter(
    (request) => request.model === "second",
  );
  const fallbackRequest = fallbackRequests[0];
  if (fallbackRequest === undefined)
    return err(
      failure(
        "ProviderContextViolation",
        "fallback provider request was not captured",
      ),
    );
  if (
    requests.length !== 3 ||
    requests.some((request, index) => request.requestNumber !== index + 1) ||
    requests[0]?.model !== "first" ||
    requests[1]?.model !== "first" ||
    fallbackRequests.length !== 1 ||
    fallbackRequest.requestNumber !== 3
  ) {
    return err(
      failure("UnexpectedEventCount", "provider request sequence changed"),
    );
  }
  const failedProviderRequest = requests[1];
  if (failedProviderRequest === undefined) {
    return err(
      failure("ProviderContextViolation", "failed provider request is missing"),
    );
  }
  const failedProvider = validateFailedProviderContext(failedProviderRequest);
  if (failedProvider.isErr()) return err(failedProvider.error);
  const exactProvider = validateExactProviderContext(fallbackRequest);
  if (exactProvider.isErr()) return err(exactProvider.error);
  const providerContinuity = validateProviderContextContinuity(
    failedProviderRequest,
    fallbackRequest,
  );
  if (providerContinuity.isErr()) return err(providerContinuity.error);
  const history = child.history;
  if (history === undefined) {
    return err(
      failure("ProviderContextViolation", "native history is missing"),
    );
  }
  const exactHistory = validateExactDurableHistory(history, childControl);
  if (exactHistory.isErr()) return err(exactHistory.error);
  const commonFacts = validateProviderDurableCommonFacts(
    fallbackRequest,
    history,
  );
  if (commonFacts.isErr()) return err(commonFacts.error);
  const failedAssistant = history.descriptors[7];
  if (
    failedAssistant === undefined ||
    fallbackRequest.descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
          fixtureCorrelationHash("failed-assistant") ||
        descriptor.contentFingerprintHash ===
          failedAssistant.contentFingerprintHash ||
        descriptor.customTypeHash ===
          fixtureCustomTypeHash(NATIVE_RECOVERY_MARKER_TYPE),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback provider still contains the correlated failed assistant or marker",
      ),
    );
  }
  if (
    child.lifecycle.messageEndCount !== 3 ||
    child.lifecycle.contextCount !== 1 ||
    child.lifecycle.contextRepairCount !== 1 ||
    child.lifecycle.markerMessageStartCount !== 1 ||
    child.lifecycle.modelSelectCount !== 1 ||
    child.lifecycle.settlementCount !== 2
  ) {
    return err(
      failure("UnexpectedEventCount", "child lifecycle event count changed"),
    );
  }
  if (child.lifecycle.beforeAgentStartCount !== 1) {
    return err(
      failure(
        "UnexpectedEventCount",
        "recovery unexpectedly ran before_agent_start",
      ),
    );
  }
  if (
    !child.lifecycle.recoveryMarkerObserved ||
    child.lifecycle.markerMessageStartTimesMs.length !== 1 ||
    child.lifecycle.contextRepairTimesMs.length !== 1 ||
    child.lifecycle.modelSelectTimesMs.length !== 1 ||
    child.lifecycle.settlementTimesMs.length !== 2
  ) {
    return err(
      failure(
        "UnexpectedEventCount",
        "exact recovery event timestamps are incomplete",
      ),
    );
  }
  const cleanupResult = verifiedCleanup(observation);
  if (cleanupResult.isErr()) return err(cleanupResult.error);
  if (
    parent.lifecycle.settlementCount !== 1 ||
    parent.lifecycle.settlementTimesMs.length !== 1 ||
    parent.parentToolPendingMs === undefined ||
    !Number.isFinite(parent.parentToolPendingMs) ||
    parent.parentToolPendingMs < 0 ||
    parent.parentToolPendingMs > MAX_COMMAND_TIMEOUT_MS ||
    Object.values(cleanupResult.value).some((value) => value !== true)
  ) {
    return err(
      failure(
        "UnexpectedEventCount",
        "parent tool did not settle exactly once and clean up",
      ),
    );
  }
  const identity = child.lifecycle.appliedIdentity;
  if (identity?.provider !== "smoke" || identity.id !== "second")
    return err(
      failure(
        "ProviderContextViolation",
        "applied model identity is not authenticated",
      ),
    );
  const count = observation.visibleEventCount;
  if (count !== EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT)
    return err(
      failure(
        "UnexpectedEventCount",
        `expected one visible fallback event, got ${count}`,
      ),
    );
  if (
    containsForbiddenContent(observation.output, [
      PROVIDER_FAILURE_MARKER,
      RECOVERY_MARKER,
      PARENT_TASK,
      ROLLBACK_TASK,
      CHILD_TASK,
    ])
  ) {
    return err(
      failure("LeakedContent", "provider or marker content reached the report"),
    );
  }
  const visible = normalizedTuiOutput(observation.output);
  if (!visible.includes(EXPECTED_NATIVE_LINE))
    return err(
      failure(
        "UnexpectedEventCount",
        "card Native Line or applied identity was not visible",
      ),
    );
  const cleanup = cleanupResult.value;
  const processIdentityStable =
    child.processIdBeforeHash === child.processIdAfterHash &&
    parent.processIdBeforeHash === parent.processIdAfterHash;
  const nativeSessionIdentityStable =
    child.sessionIdBeforeHash === child.sessionIdAfterHash;
  const threadIdentityStable =
    child.threadIdBeforeHash === child.threadIdAfterHash;
  const parentToolCallIdentityStable =
    parent.parentToolCallIdHash === parent.parentToolEndCallIdHash;
  if (
    !processIdentityStable ||
    !nativeSessionIdentityStable ||
    !threadIdentityStable ||
    !parentToolCallIdentityStable
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "stable runtime identity facts are incomplete",
      ),
    );
  }
  return ok({
    processIdentityStable,
    nativeSessionIdentityStable,
    threadIdentityStable,
    parentToolCallIdentityStable,
    providerRequest: fallbackRequest,
    durableHistory: history,
    lifecycle: child.lifecycle,
    visibleEventCount: count,
    cardAppliedIdentity: identity,
    nativeLine: EXPECTED_NATIVE_LINE,
    parentPendingIntervalMs: Math.min(
      parent.parentToolPendingMs,
      MAX_COMMAND_TIMEOUT_MS,
    ),
    parentSettlementCount: 1,
    cleanup,
  });
}

export function validateRollbackFacts(input: {
  readonly observation: ScenarioObservation;
  readonly parent: FixtureSnapshot;
}): Result<RollbackScenarioFacts, SmokeFailure> {
  const sources = validateObservedSources({
    observation: input.observation,
    snapshots: [input.parent],
    smokeCase: "rollback",
  });
  if (sources.isErr()) return err(sources.error);
  const health = validateHealthObservation(input.observation.health);
  if (health.isErr()) return err(health.error);
  const cleanupResult = verifiedCleanup(input.observation);
  if (cleanupResult.isErr()) return err(cleanupResult.error);

  const shims = input.observation.shims ?? [];
  const parentShims = shims.filter((shim) => shim.role === "parent");
  if (
    shims.length !== 2 ||
    parentShims.length !== 2 ||
    shims.some((shim) => shim.role === "child")
  )
    return err(
      failure(
        "FixtureBoundaryViolation",
        "rollback did not observe exactly one isolated parent shim boundary",
      ),
    );
  const before = parentShims.find((shim) => shim.phase === "before-adapter");
  const after = parentShims.find((shim) => shim.phase === "after-adapter");
  if (
    before === undefined ||
    after === undefined ||
    before.disabledSurface !== ROLLBACK_DISABLED_SURFACE ||
    after.disabledSurface !== ROLLBACK_DISABLED_SURFACE ||
    before.boundary !== ROLLBACK_SHIM_BOUNDARY ||
    after.boundary !== ROLLBACK_SHIM_BOUNDARY ||
    before.originalSurfacePresent !== true ||
    after.originalSurfacePresent !== true ||
    before.disabledBeforeAdapterInitialization !== true ||
    after.disabledBeforeAdapterInitialization !== true ||
    before.requiredDelegationSurfacesIntact !== true ||
    after.requiredDelegationSurfacesIntact !== true ||
    before.adapterInitialized !== false ||
    after.adapterInitialized !== true
  )
    return err(
      failure(
        "FixtureBoundaryViolation",
        "rollback shim did not hide exactly one optional surface before adapter initialization",
      ),
    );

  const gaps = health.value.hostSurfaceGaps ?? [];
  const runtimeGap = health.value.runtimeModelFallback;
  const runtimeProbe = runtimeGap?.probe.replace(/^unavailable:/u, "");
  if (
    health.value.ready !== true ||
    health.value.healthOnly !== false ||
    gaps.length !== 1 ||
    runtimeGap === undefined ||
    runtimeGap.capability !== "runtime-model-fallback" ||
    runtimeGap.mode !== "feature-unavailable" ||
    !runtimeGap.probe.startsWith("unavailable:") ||
    runtimeProbe === undefined ||
    !RUNTIME_MODEL_FALLBACK_PROBE_REASONS.has(runtimeProbe)
  )
    return err(
      failure(
        "ProviderContextViolation",
        "rollback health did not report one bounded optional runtime-model-fallback gap",
      ),
    );

  const childCapturePresent = [
    ...input.observation.providerCaptures,
    ...input.observation.controls,
    ...input.observation.nativeSessions,
  ].some((capture) => capture.role === "child");
  if (childCapturePresent)
    return err(
      failure(
        "UnexpectedEventCount",
        "rollback unexpectedly created a delegated child run",
      ),
    );
  const request = input.parent.requests[0];
  const history = input.parent.history;
  const native = input.observation.nativeSessions.find(
    (session) => session.role === "parent",
  );
  const control = input.observation.controls.find(
    (capture) => capture.role === "parent",
  );
  const initialModel: SafeModelIdentity = { provider: "smoke", id: "first" };
  const nativeTransitionsAreInitial =
    native !== undefined &&
    native.modelTransitions > 0 &&
    native.modelTransitionIdentities.length === native.modelTransitions &&
    native.modelTransitionIdentities.every((identity) =>
      sameIdentity(identity, initialModel),
    );
  const failedAssistant = history?.descriptors.find(
    (descriptor) =>
      descriptor.correlationHash === fixtureCorrelationHash("failed-assistant"),
  );
  if (
    request === undefined ||
    request.requestNumber !== 1 ||
    request.provider !== "smoke" ||
    request.model !== "first" ||
    request.taskPresent !== true ||
    request.originalUserPresent !== true ||
    request.failedAssistantPresent !== false ||
    request.recoveryMarkerPresent !== false ||
    request.syntheticProviderUserMessagePresent !== false ||
    input.parent.requestCount !== 1 ||
    input.parent.requests.length !== 1 ||
    history === undefined ||
    history.failedAssistantPresent !== true ||
    history.recoveryMarkerPresent !== false ||
    history.successfulAssistantPresent !== false ||
    history.recoveryEntryPresent !== false ||
    history.markerTokenHash !== undefined ||
    history.markerTokenValid !== undefined ||
    history.markerCorrelation !== undefined ||
    failedAssistant === undefined ||
    input.parent.failedAssistantFingerprintHash !==
      failedAssistant.contentFingerprintHash ||
    input.parent.failedAssistantShapeHash !==
      failedAssistant.contentShapeHash ||
    native === undefined ||
    !nativeTransitionsAreInitial ||
    native.recoveryMarkerCount !== 0 ||
    !sameIdentity(native.appliedIdentity, initialModel) ||
    control === undefined ||
    control.lifecycle.modelSelectCount !== 0 ||
    control.lifecycle.appliedIdentity !== undefined ||
    (input.parent.lifecycle.appliedIdentity !== undefined &&
      !sameIdentity(input.parent.lifecycle.appliedIdentity, initialModel))
  )
    return err(
      failure(
        "ProviderContextViolation",
        "rollback did not retain the real failed low-level run without fallback artifacts",
      ),
    );

  const lifecycle = input.parent.lifecycle;
  if (
    input.parent.optionalSurfaceDisabled !== true ||
    input.parent.legacySettlement !== true ||
    lifecycle.beforeAgentStartCount !== 1 ||
    // Pi 0.84.2 emits two ordinary message lifecycle pairs and one context
    // observation for the single provider request. These are host facts, not
    // fallback dispatch; the provider request and settlement counts below are
    // the low-level-run proof.
    lifecycle.messageStartCount !== 2 ||
    lifecycle.messageEndCount !== 2 ||
    lifecycle.contextCount !== 1 ||
    lifecycle.contextRepairCount !== 0 ||
    lifecycle.modelSelectCount !== 0 ||
    lifecycle.settlementCount !== 1 ||
    lifecycle.markerMessageStartCount !== 0 ||
    lifecycle.recoveryMarkerCount !== 0 ||
    lifecycle.recoveryMarkerObserved !== false ||
    (lifecycle.appliedIdentity !== undefined &&
      !sameIdentity(lifecycle.appliedIdentity, initialModel)) ||
    lifecycle.settlementTimesMs.length !== 1 ||
    Object.values(cleanupResult.value).some((value) => value !== true)
  )
    return err(
      failure(
        "UnexpectedEventCount",
        "rollback did not use one legacy low-level settlement and normal cleanup",
      ),
    );

  const visible = normalizedTuiOutput(input.observation.output);
  const visibleFallbackClaim =
    /model fallback\s*[·•]\s*smoke\/[a-z0-9._-]+/iu.test(visible);
  if (
    input.observation.visibleEventCount !== 0 ||
    visibleFallbackClaim ||
    visible.includes(NATIVE_RECOVERY_ENTRY_TYPE) ||
    visible.includes(NATIVE_RECOVERY_MARKER_TYPE)
  )
    return err(
      failure(
        "UnexpectedEventCount",
        "rollback exposed a model-transition or fallback artifact",
      ),
    );

  return ok({
    optionalSurfaceDisabled: true,
    healthReady: true,
    healthOnly: false,
    legacySettlementCount: 1,
    fallbackAttempted: false,
    cleanup: cleanupResult.value,
  });
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly tag?: "pi" | "fixture" | "child";
}

function parseProcessRows(output: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] ?? "";
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      Number.isSafeInteger(ppid) &&
      ppid >= 0
    )
      rows.push({ pid, ppid, command });
  }
  return rows;
}

function processDescendants(
  rows: readonly ProcessRow[],
  root: string,
  tracker: CleanupResourceTracker,
  observedPids: readonly ProcessRow[] = [],
): readonly ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const known = new Set(
    tracker.processHandles.flatMap((handle) =>
      handle.pid === undefined ? [] : [handle.pid],
    ),
  );
  for (const row of rows) if (row.command.includes(root)) known.add(row.pid);
  for (const row of observedPids) known.add(row.pid);
  const observedByPid = new Map(
    observedPids.map((row) => [row.pid, row] as const),
  );
  const found = new Map<number, ProcessRow>();
  const queue = [...known];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) continue;
    for (const child of byParent.get(parent) ?? []) {
      if (found.has(child.pid)) continue;
      found.set(child.pid, observedByPid.get(child.pid) ?? child);
      queue.push(child.pid);
    }
  }
  for (const pid of known) {
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row !== undefined) found.set(pid, observedByPid.get(pid) ?? row);
  }
  return [...found.values()];
}

async function readObservedPidFiles(
  root: string,
  processRows: readonly ProcessRow[],
): Promise<readonly ProcessRow[] | undefined> {
  const files: string[] = [];
  let exceeded = false;
  const scanned = await ResultAsync.fromThrowable(
    async () => {
      for await (const path of new Bun.Glob("*.pid").scan({
        cwd: join(root, "capture"),
        absolute: true,
      })) {
        files.push(path);
        if (files.length > 8) {
          exceeded = true;
          break;
        }
      }
    },
    () => undefined,
  )();
  if (scanned.isErr()) return [];
  if (exceeded) return undefined;
  const observedRows = new Map<number, ProcessRow>();
  for (const path of files) {
    const text = await ResultAsync.fromThrowable(
      () => Bun.file(path).text(),
      () => "",
    )();
    if (text.isErr()) continue;
    const pid = Number(text.value.trim());
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    const name = basename(path);
    let tag: ProcessRow["tag"];
    if (name.startsWith("fixture-")) tag = "fixture";
    else if (name.startsWith("pi-child")) tag = "child";
    else if (name.startsWith("pi-")) tag = "pi";
    const observed = processRows.find((row) => row.pid === pid);
    if (observed === undefined) continue;
    const command = observed.command;
    const trustedCommand =
      command.includes(root) ||
      command.includes("pi-coding-agent") ||
      command.includes(FIXTURE_PACKAGE_NAME) ||
      command.includes("provider.js");
    if (!trustedCommand) continue;
    const existing = observedRows.get(pid);
    const tagPriority = { fixture: 1, pi: 2, child: 3 } as const;
    const mergedTag =
      existing?.tag === undefined ||
      (tag !== undefined && tagPriority[tag] > tagPriority[existing.tag])
        ? tag
        : existing.tag;
    observedRows.set(pid, {
      ...observed,
      ...(mergedTag === undefined ? {} : { tag: mergedTag }),
    });
  }
  return [...observedRows.values()];
}

async function defaultObserveProcesses(input: {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly tracker: CleanupResourceTracker;
  readonly timeoutMs: number;
}): Promise<Result<CleanupProcessObservation, CleanupDiagnosticCode>> {
  const ps = await runBoundedCommand(["ps", "-axo", "pid=,ppid=,command="], {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: Math.min(input.timeoutMs, 2_000),
    resources: input.tracker,
    processKind: "helper",
  });
  if (ps.isErr()) return err("process-observation-failed");
  const processRows = parseProcessRows(
    `${ps.value.stdout}\n${ps.value.stderr}`,
  );
  const observedPids = await readObservedPidFiles(input.root, processRows);
  if (observedPids === undefined) return err("process-observation-failed");
  const rows = processDescendants(
    processRows,
    input.root,
    input.tracker,
    observedPids,
  );
  const processKinds = new Map(
    input.tracker.processHandles.flatMap((handle) =>
      handle.pid === undefined ? [] : [[handle.pid, handle.kind] as const],
    ),
  );
  const piTuiPids = rows
    .filter(
      (row) =>
        row.tag === "pi" ||
        row.tag === "child" ||
        row.command.includes(`${input.root}/bin/pi`) ||
        row.command.includes("pi-coding-agent"),
    )
    .map((row) => row.pid);
  const piSet = new Set(piTuiPids);
  const childPids = rows
    .filter((row) => {
      if (row.tag === "child") return true;
      let parent = row.ppid;
      const seen = new Set<number>();
      while (!seen.has(parent)) {
        seen.add(parent);
        if (piSet.has(parent)) return row.pid !== parent;
        const next = rows.find((candidate) => candidate.pid === parent);
        if (next === undefined) break;
        parent = next.ppid;
      }
      return false;
    })
    .map((row) => row.pid);
  const helperPids = rows
    .filter((row) => {
      const kind = processKinds.get(row.pid);
      return (
        kind === "helper" || kind === "pty" || row.command.includes("expect")
      );
    })
    .map((row) => row.pid);
  const panePids = rows
    .filter(
      (row) =>
        processKinds.get(row.pid) === "pty" || row.command.includes("expect"),
    )
    .map((row) => row.pid);
  const fixturePids = rows
    .filter(
      (row) =>
        row.tag === "fixture" ||
        row.command.includes(FIXTURE_PACKAGE_NAME) ||
        row.command.includes("provider.js") ||
        piSet.has(row.pid),
    )
    .map((row) => row.pid);
  return ok({
    pids: rows.map((row) => row.pid),
    piTuiPids,
    fixturePids,
    childPids,
    helperPids,
    panePids,
  });
}

async function defaultObserveLease(input: {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly tracker: CleanupResourceTracker;
  readonly runtimeStatusCommand?: CleanupRootOptions["runtimeStatusCommand"];
}): Promise<Result<boolean, CleanupDiagnosticCode>> {
  if (input.runtimeStatusCommand === undefined)
    return err("lease-observation-failed");
  const status = await runBoundedCommand(input.runtimeStatusCommand.args, {
    cwd: input.runtimeStatusCommand.cwd,
    env: input.env,
    timeoutMs: Math.min(input.timeoutMs, 2_000),
    resources: input.tracker,
    processKind: "helper",
  });
  if (status.isErr()) return err("lease-observation-failed");
  const output = `${status.value.stdout}\n${status.value.stderr}`;
  if (
    output.includes("No active lease.") ||
    output.includes("No runtime store found")
  )
    return ok(true);
  if (output.includes("Active Lease")) return ok(false);
  return err("lease-observation-failed");
}

async function defaultRemoveRoot(input: {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly tracker: CleanupResourceTracker;
}): Promise<Result<void, CleanupDiagnosticCode>> {
  const removed = await runBoundedCommand(["rm", "-rf", "--", input.root], {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: Math.min(input.timeoutMs, 2_000),
    resources: input.tracker,
    processKind: "helper",
  });
  return removed.isErr() ? err("root-remove-failed") : ok(undefined);
}

async function performCleanupRoot(
  root: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  options: CleanupRootOptions,
  tracker: CleanupResourceTracker,
): Promise<Result<CleanupVerification, SmokeFailure>> {
  if (tracker.root !== resolve(root) || !isEphemeralPath(root))
    return err(failure("CleanupFailed", "root-not-owned"));

  const hooks = options.hooks ?? {};
  const clock = hooks.clock ?? realCleanupClock;
  const observe = hooks.observeProcesses ?? defaultObserveProcesses;
  const lease =
    hooks.observeLease ??
    ((input) =>
      defaultObserveLease({
        ...input,
        runtimeStatusCommand: options.runtimeStatusCommand,
      }));
  const removeRoot = hooks.removeRoot ?? defaultRemoveRoot;
  const exists =
    hooks.pathExists ??
    (async (path: string) => {
      const result = await runBoundedCommand(["test", "-e", path], {
        cwd,
        env,
        timeoutMs: Math.min(timeoutMs, 2_000),
        resources: tracker,
        processKind: "helper",
        allowExitCodes: [1],
      });
      if (result.isErr()) return err("root-still-present");
      return ok(result.value.code === 0);
    });

  const initiallyDisposed = await tracker.disposeResources();
  const initialHandles = [...tracker.processHandles];
  for (const handle of initialHandles) handle.terminate?.("SIGTERM");
  const initial = await observe({
    root,
    cwd,
    env,
    tracker,
    timeoutMs,
  });
  if (initial.isErr()) {
    await waitForHandles(initialHandles, CLEANUP_GRACE_TIMEOUT_MS, clock);
    const remainingHandles = [...tracker.processHandles];
    for (const handle of remainingHandles) handle.terminate?.("SIGKILL");
    await waitForHandles(remainingHandles, CLEANUP_FORCE_TIMEOUT_MS, clock);
    return err(failure("CleanupFailed", initial.error));
  }
  const initialPids = new Set(initial.value.pids);
  for (const pid of initialPids) signalPidQuietly(pid, "SIGTERM");
  await waitForHandles(initialHandles, CLEANUP_GRACE_TIMEOUT_MS, clock);
  tracker.pruneExited();
  const afterGrace = await observe({
    root,
    cwd,
    env,
    tracker,
    timeoutMs,
  });
  if (afterGrace.isErr()) {
    for (const pid of initialPids) signalPidQuietly(pid, "SIGKILL");
    const remainingHandles = [...tracker.processHandles];
    for (const handle of remainingHandles) handle.terminate?.("SIGKILL");
    await waitForHandles(remainingHandles, CLEANUP_FORCE_TIMEOUT_MS, clock);
    return err(failure("CleanupFailed", afterGrace.error));
  }
  const gracefulSurvivors = new Set(afterGrace.value.pids);
  for (const handle of tracker.processHandles) {
    if (handle.pid !== undefined) gracefulSurvivors.add(handle.pid);
  }
  for (const handle of tracker.processHandles) handle.terminate?.("SIGKILL");
  for (const pid of gracefulSurvivors) signalPidQuietly(pid, "SIGKILL");
  await waitForHandles(
    [...tracker.processHandles],
    CLEANUP_FORCE_TIMEOUT_MS,
    clock,
  );
  tracker.pruneExited();
  const finalProcesses = await observe({
    root,
    cwd,
    env,
    tracker,
    timeoutMs,
  });
  if (finalProcesses.isErr()) {
    for (const pid of gracefulSurvivors) signalPidQuietly(pid, "SIGKILL");
    const remainingHandles = [...tracker.processHandles];
    for (const handle of remainingHandles) handle.terminate?.("SIGKILL");
    await waitForHandles(remainingHandles, CLEANUP_FORCE_TIMEOUT_MS, clock);
    return err(failure("CleanupFailed", finalProcesses.error));
  }
  if (
    tracker.processHandles.length > 0 ||
    finalProcesses.value.pids.length > 0
  ) {
    return err(failure("CleanupFailed", "process-survivor"));
  }

  const leaseResult = await lease({ cwd, env, timeoutMs, tracker });
  if (leaseResult.isErr())
    return err(failure("CleanupFailed", leaseResult.error));
  if (!leaseResult.value) return err(failure("CleanupFailed", "active-lease"));

  const resourceDisposed =
    initiallyDisposed && (await tracker.disposeResources());
  if (!resourceDisposed || tracker.activeResourceCount !== 0)
    return err(failure("CleanupFailed", "resource-still-open"));

  const removed = await removeRoot({ root, cwd, env, timeoutMs, tracker });
  if (removed.isErr()) return err(failure("CleanupFailed", removed.error));
  const rootExists = await exists(root);
  if (rootExists.isErr())
    return err(failure("CleanupFailed", rootExists.error));
  if (rootExists.value)
    return err(failure("CleanupFailed", "root-still-present"));
  for (const ownedPath of tracker.ownedPaths) {
    const present = await exists(ownedPath);
    if (present.isErr()) return err(failure("CleanupFailed", present.error));
    if (present.value)
      return err(failure("CleanupFailed", "root-still-present"));
  }

  const verification: CleanupVerification = {
    noChildProcess: finalProcesses.value.childPids.length === 0,
    noNativeChild: finalProcesses.value.childPids.length === 0,
    noActiveLease: leaseResult.value,
    noTemporaryPane: finalProcesses.value.panePids.length === 0,
    noFixtureProcess: finalProcesses.value.fixturePids.length === 0,
    noPiProcess: finalProcesses.value.piTuiPids.length === 0,
    noHelperProcess: finalProcesses.value.helperPids.length === 0,
    temporaryRootRemoved: true,
    timersDisposed: true,
    resourcesDisposed: true,
  };
  return ok(verification);
}

async function cleanupRoot(
  root: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  options: CleanupRootOptions = {},
): Promise<Result<CleanupVerification, SmokeFailure>> {
  if (options.tracker === undefined)
    return err(failure("CleanupFailed", "root-not-owned"));
  const tracker = options.tracker;
  const remembered = tracker.rememberedCleanup();
  if (remembered !== undefined) return remembered;
  const inFlight = tracker.cleanupInFlight();
  if (inFlight !== undefined) return inFlight;
  const promise = (async (): Promise<
    Result<CleanupVerification, SmokeFailure>
  > => {
    const result = await ResultAsync.fromThrowable(
      () => performCleanupRoot(root, cwd, env, timeoutMs, options, tracker),
      () => failure("CleanupFailed", "resource-dispose-failed"),
    )();
    return result.isErr() ? err(result.error) : result.value;
  })();
  tracker.rememberCleanupInFlight(promise);
  const result = await promise;
  tracker.rememberCleanup(result);
  return result;
}

async function verifyScenarioProvenance(input: {
  readonly paths: ScenarioPaths;
  readonly artifact: PackedArtifact;
  readonly installed: InstalledAdapterProvenance;
  readonly controls: readonly FixtureControlFacts[];
}): Promise<Result<SmokeProvenance, SmokeFailure>> {
  const pi = await inspectPiCliProvenance(input.paths.piCli, {
    expectedVersion: EXACT_PI_VERSION,
    forbiddenPaths: [resolve(".")],
  });
  if (pi.isErr()) return err(pi.error);
  if (
    pi.value.packageRoot !== input.paths.piCliPackageRoot ||
    pi.value.packageVersion !== input.paths.piCliPackageVersion
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI did not load from the isolated package",
      ),
    );
  const installed = await verifyInstalledAdapterPackage({
    packageRoot: input.paths.packagePath,
    expectedPackageRoot: input.paths.packagePath,
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedExtensionSha256: input.artifact.extensionSha256,
  });
  if (installed.isErr()) return err(installed.error);
  if (
    !installed.value.packageRootMatched ||
    !installed.value.extensionHashMatched ||
    installed.value.packageVersion !== input.installed.packageVersion ||
    installed.value.extensionSha256 !== input.installed.extensionSha256
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed adapter changed after startup",
      ),
    );
  const artifact = await verifyArtifactFileUnchanged(
    input.artifact.path,
    input.artifact.sha256,
  );
  if (artifact.isErr()) return err(artifact.error);
  const loaded = validateLoadedAdapterProvenance({
    controls: input.controls,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedExtensionSha256: input.artifact.extensionSha256,
  });
  if (loaded.isErr()) return err(loaded.error);
  if (
    !loaded.value.packageSourceProven ||
    !loaded.value.packageRootMatched ||
    !loaded.value.extensionHashMatched
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "loaded adapter source is not the isolated package",
      ),
    );
  return ok({
    artifactUnchanged: artifact.value === input.artifact.sha256,
    installedPackageVersion: installed.value.packageVersion,
    installedExtensionSha256: installed.value.extensionSha256,
    loadedAdapterPackageVersion: loaded.value.packageVersion,
    loadedAdapterExtensionSha256: loaded.value.extensionSha256,
    packageSourceProven: loaded.value.packageSourceProven,
    packageRootMatched:
      installed.value.packageRootMatched && loaded.value.packageRootMatched,
    loadedExtensionHashMatched:
      installed.value.extensionHashMatched && loaded.value.extensionHashMatched,
    piPackageVersion: pi.value.packageVersion,
  });
}

async function runScenario(
  artifact: PackedArtifact,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
): Promise<
  Result<ScenarioObservation & { readonly paths: ScenarioPaths }, SmokeFailure>
> {
  const setup = await setupScenario(artifact, smokeCase, timeoutMs);
  if (setup.isErr()) return err(setup.error);
  const { paths, env, tracker, runtimeStatusCommand, installed } = setup.value;
  let signalCleanup:
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined;
  const requestSignalCleanup = (): void => {
    signalCleanup ??= cleanupRoot(paths.root, tmpdir(), env, timeoutMs, {
      tracker,
      runtimeStatusCommand,
    });
  };
  const signalHandler = (): void => {
    requestSignalCleanup();
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  let scenarioResult: Result<
    ScenarioObservation & { readonly paths: ScenarioPaths },
    SmokeFailure
  >;
  try {
    const version = await runBoundedCommand(
      [paths.bunCli, paths.piCli, "--version"],
      { cwd: paths.project, env, timeoutMs, resources: tracker },
    );
    if (version.isErr()) {
      scenarioResult = err(version.error);
    } else {
      const parsedVersion = validatePiVersion(version.value.stdout);
      if (parsedVersion.isErr()) {
        scenarioResult = err(parsedVersion.error);
      } else {
        const pty = await runPty(paths, env, smokeCase, timeoutMs, tracker);
        if (pty.isErr()) {
          scenarioResult = err(pty.error);
        } else {
          const captures = await readCaptureSnapshots(paths.capture);
          if (captures.isErr()) {
            scenarioResult = err(captures.error);
          } else {
            // Read the native source twice. Stability is accepted only after
            // the two independently observed bounded reads compare equal.
            const nativeBefore = await readNativeSessionSnapshots(
              paths,
              tracker,
            );
            if (nativeBefore.isErr()) {
              scenarioResult = err(nativeBefore.error);
            } else {
              const nativeAfter = await readNativeSessionSnapshots(
                paths,
                tracker,
              );
              if (nativeAfter.isErr()) {
                scenarioResult = err(nativeAfter.error);
              } else {
                const nativeSessions = mergeNativeSessionObservations(
                  nativeBefore.value,
                  nativeAfter.value,
                );
                if (nativeSessions.isErr()) {
                  scenarioResult = err(nativeSessions.error);
                } else {
                  const snapshots = assembleSnapshots(
                    captures.value,
                    nativeSessions.value,
                  );
                  const output = `${pty.value.stdout}\n${pty.value.stderr}`;
                  const health =
                    smokeCase === "rollback"
                      ? parseHealthFacts(output)
                      : ok<HealthFacts | undefined, SmokeFailure>(undefined);
                  const provenance = await verifyScenarioProvenance({
                    paths,
                    artifact,
                    installed,
                    controls: captures.value.controls,
                  });
                  if (health.isErr()) {
                    scenarioResult = err(health.error);
                  } else if (snapshots.isErr()) {
                    scenarioResult = err(snapshots.error);
                  } else if (provenance.isErr()) {
                    scenarioResult = err(provenance.error);
                  } else {
                    scenarioResult = ok({
                      output,
                      provenance: provenance.value,
                      health: health.value,
                      visibleEventCount: visibleEventCount(output),
                      captures: snapshots.value,
                      providerCaptures: captures.value.providers,
                      nativeSessions: nativeSessions.value,
                      controls: captures.value.controls,
                      shims: captures.value.shims,
                      temporaryRootRemoved: false,
                      paths,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (caught) {
    scenarioResult = err(failure("UnexpectedFailure", safeDiagnostic(caught)));
  }
  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
  const cleaned =
    signalCleanup ??
    cleanupRoot(paths.root, tmpdir(), env, timeoutMs, {
      tracker,
      runtimeStatusCommand,
    });
  const cleanupResult = await cleaned;
  if (cleanupResult.isErr()) return err(cleanupResult.error);
  return scenarioResult.map((value) => ({
    ...value,
    cleanup: cleanupResult.value,
    temporaryRootRemoved: cleanupResult.value.temporaryRootRemoved,
  }));
}

function findSnapshot(
  snapshots: readonly FixtureSnapshot[],
  role: FixtureSnapshot["role"],
): FixtureSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.role === role);
}

function sameSmokeProvenance(
  left: SmokeProvenance,
  right: SmokeProvenance,
): boolean {
  return (
    left.artifactUnchanged === right.artifactUnchanged &&
    left.installedPackageVersion === right.installedPackageVersion &&
    left.installedExtensionSha256 === right.installedExtensionSha256 &&
    left.loadedAdapterPackageVersion === right.loadedAdapterPackageVersion &&
    left.loadedAdapterExtensionSha256 === right.loadedAdapterExtensionSha256 &&
    left.packageSourceProven === right.packageSourceProven &&
    left.packageRootMatched === right.packageRootMatched &&
    left.loadedExtensionHashMatched === right.loadedExtensionHashMatched &&
    left.piPackageVersion === right.piPackageVersion
  );
}

async function runReleaseSmoke(
  args: SmokeCliArgs,
): Promise<Result<SmokeReport, SmokeFailure>> {
  const artifact = await inspectPackedArtifact(
    args.artifact,
    args.expectedArtifactSha256,
  );
  if (artifact.isErr()) return err(artifact.error);
  if (artifact.value.packageVersion !== PACKAGE_VERSION)
    return err(
      failure(
        "ArtifactMalformed",
        "adapter package version is not the release version",
      ),
    );
  let provenance: SmokeProvenance | undefined;
  const recordProvenance = (
    candidate: SmokeProvenance | undefined,
  ): Result<void, SmokeFailure> => {
    if (candidate === undefined)
      return err(
        failure(
          "StrictProvenanceViolation",
          "scenario omitted package provenance",
        ),
      );
    if (provenance !== undefined && !sameSmokeProvenance(provenance, candidate))
      return err(
        failure(
          "StrictProvenanceViolation",
          "scenario package provenance disagrees",
        ),
      );
    provenance = candidate;
    return ok(undefined);
  };
  let fallback: FallbackScenarioFacts | undefined;
  let rollback: RollbackScenarioFacts | undefined;
  if (args.smokeCase === "fallback" || args.smokeCase === "all") {
    const run = await runScenario(artifact.value, "fallback", args.timeoutMs);
    if (run.isErr()) return err(run.error);
    const provenanceResult = recordProvenance(run.value.provenance);
    if (provenanceResult.isErr()) return err(provenanceResult.error);
    const child = findSnapshot(run.value.captures, "child");
    const parent = findSnapshot(run.value.captures, "parent");
    if (child === undefined || parent === undefined)
      return err(
        failure(
          "CaptureMalformed",
          "fallback fixture did not capture parent and child",
        ),
      );
    const facts = validateFallbackFacts({
      observation: run.value,
      child,
      parent,
    });
    if (facts.isErr()) return err(facts.error);
    fallback = facts.value;
  }
  if (args.smokeCase === "rollback" || args.smokeCase === "all") {
    const run = await runScenario(artifact.value, "rollback", args.timeoutMs);
    if (run.isErr()) return err(run.error);
    const provenanceResult = recordProvenance(run.value.provenance);
    if (provenanceResult.isErr()) return err(provenanceResult.error);
    const parent = findSnapshot(run.value.captures, "parent");
    if (parent === undefined)
      return err(
        failure("CaptureMalformed", "rollback fixture did not capture parent"),
      );
    const facts = validateRollbackFacts({ observation: run.value, parent });
    if (facts.isErr()) return err(facts.error);
    rollback = facts.value;
  }
  if (provenance === undefined)
    return err(
      failure(
        "StrictProvenanceViolation",
        "no scenario produced package provenance",
      ),
    );
  return ok({
    schemaVersion: 1,
    checklistVersion: CHECKLIST_VERSION,
    artifact: {
      packageName: PACKAGE_NAME,
      packageVersion: artifact.value.packageVersion,
      sha256: artifact.value.sha256,
    },
    pi: {
      expectedVersion: EXACT_PI_VERSION,
      observedVersion: provenance.piPackageVersion,
    },
    provenance,
    ...(fallback === undefined ? {} : { fallback }),
    ...(rollback === undefined ? {} : { rollback }),
    diagnostics: [
      "real-pi-tui",
      "isolated-home",
      "strict-npm-provenance",
      "packed-artifact",
      "bounded-timeout",
      "ephemeral-report",
    ],
  });
}

async function writeStdout(value: string): Promise<void> {
  await Bun.write(Bun.stdout, value);
}

async function writeStderr(value: string): Promise<void> {
  await Bun.write(Bun.stderr, value);
}

async function cli(): Promise<number> {
  const parsed = parseSmokeArgs(Bun.argv.slice(2));
  if (parsed.isErr()) {
    await writeStderr(
      `${JSON.stringify({ ok: false, error: parsed.error.type, detail: safeDiagnostic(parsed.error.detail ?? "") })}\n`,
    );
    return 2;
  }
  const result = await runReleaseSmoke(parsed.value);
  if (result.isErr()) {
    await writeStderr(
      `${JSON.stringify({ ok: false, error: result.error.type, detail: safeDiagnostic(result.error.detail ?? "") })}\n`,
    );
    return 1;
  }
  const serialized = serializeSmokeReport(result.value);
  if (serialized.isErr()) {
    await writeStderr(
      `${JSON.stringify({ ok: false, error: serialized.error.type, detail: safeDiagnostic(serialized.error.detail ?? "") })}\n`,
    );
    return 1;
  }
  const validatedReportPath = await validateReportTargetPath(
    parsed.value.reportPath,
  );
  if (validatedReportPath.isErr()) {
    await writeStderr(
      `${JSON.stringify({ ok: false, error: validatedReportPath.error.type, detail: safeDiagnostic(validatedReportPath.error.detail ?? "") })}\n`,
    );
    return 1;
  }
  const reportParent = dirname(validatedReportPath.value);
  const reportParentProbe = await runBoundedCommand(
    ["test", "-d", reportParent],
    {
      cwd: ".",
      env: { PATH: SAFE_SYSTEM_PATH },
      timeoutMs: 2_000,
      allowExitCodes: [1],
    },
  );
  if (reportParentProbe.isErr()) {
    await writeStderr(
      `${JSON.stringify({ ok: false, error: reportParentProbe.error.type, detail: safeDiagnostic(reportParentProbe.error.detail ?? "") })}\n`,
    );
    return 1;
  }
  if (reportParentProbe.value.code !== 0) {
    const parent = await makeDirectory(
      reportParent,
      ".",
      {
        PATH: SAFE_SYSTEM_PATH,
      },
      2_000,
    );
    if (parent.isErr()) {
      await writeStderr(
        `${JSON.stringify({ ok: false, error: parent.error.type, detail: safeDiagnostic(parent.error.detail ?? "") })}\n`,
      );
      return 1;
    }
  }
  const written = await writeSmokeReportAtomically(
    parsed.value.reportPath,
    result.value,
  );
  if (written.isErr()) {
    await writeStderr(
      `${JSON.stringify({ ok: false, error: written.error.type, detail: safeDiagnostic(written.error.detail ?? "") })}\n`,
    );
    return 1;
  }
  await writeStdout(serialized.value);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await cli();
}

export const __testing = {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  FIXTURE_PACKAGE_NAME,
  fixtureSource,
  controlObserverSource,
  rollbackShimSource,
  validateRollbackShimSource,
  fixturePackageJson,
  settingsJson,
  weaveSmokeConfig,
  visibleEventCount,
  validateFixtureSourceBoundary,
  validateControlObserverSource,
  inspectPackedArtifact,
  inspectPiCliProvenance,
  validateCreatedIsolatedPathPolicy,
  validateIsolatedPathPolicy,
  validateLoadedAdapterProvenance,
  validateStrictProvenanceEnvironment,
  verifyArtifactFileUnchanged,
  verifyInstalledAdapterPackage,
  readNativeSessionSnapshots,
  mergeNativeSessionObservations,
  assembleSnapshots,
  setupScenario,
  runPty,
  runScenario,
  cleanupRoot,
  projectSanitizedSmokeReport,
  serializeSmokeReport,
  validateReportSafety,
  writeSmokeReportAtomically,
};
