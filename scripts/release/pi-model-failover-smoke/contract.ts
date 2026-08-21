import type { Result } from "neverthrow";
import type { TarEntry } from "../tar-inspector.js";
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
export const ADAPTER_READY_MARKER = "◆ WEAVE" as const;
export const FIXTURE_CREDENTIAL = "pi-model-fallback-fixture-key";
export const SAFE_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
export const XDG_CONFIG_ENV = "XDG_CONFIG_HOME";
export const XDG_DATA_ENV = "XDG_DATA_HOME";
export const XDG_CACHE_ENV = "XDG_CACHE_HOME";
export const XDG_STATE_ENV = "XDG_STATE_HOME";
export const EXPECTED_PACKAGE_ROOT_ENV = "PI_MODEL_SMOKE_EXPECTED_PACKAGE_ROOT";
export const EXPECTED_EXTENSION_SHA_ENV =
  "PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256";
export const EXPECTED_PACKAGE_VERSION_ENV =
  "PI_MODEL_SMOKE_EXPECTED_PACKAGE_VERSION";
export const ADAPTER_SOURCE_PROVEN_ENV = "PI_MODEL_SMOKE_ADAPTER_SOURCE_PROVEN";
export const FORBIDDEN_ENV_KEY_PATTERN =
  /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|PASSWORD|SECRET|TOKEN)(?:$|_)/iu;
export const FORBIDDEN_PI_WEAVE_ENV_PATTERN =
  /^(?:PI|WEAVE)_(?:.*(?:HOME|DIR|SESSION|AUTH|CONFIG|CREDENTIAL|TOKEN|KEY|PASSWORD|SECRET).*)$/iu;
export const SAFE_RUNTIME_ENV_KEYS = new Set([
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
export const FORBIDDEN_RUNTIME_ENV_KEYS = new Set([
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
/** Root removal has its own bounded budget because large fixture trees need more than a probe window. */
export const CLEANUP_ROOT_TIMEOUT_MS = 30_000;
export const CLEANUP_ROOT_MAX_ATTEMPTS = 3;
/** Existence and other cheap cleanup probes must stay short. */
export const CLEANUP_PROBE_TIMEOUT_MS = 2_000;

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
/** User-facing fixture text must not contain the private correlation markers. */
export const PARENT_TASK_TEXT = "delegate one child to inspect the README";
export const ROLLBACK_TASK_TEXT = "run the rollback health check";
export const CHILD_TASK_TEXT = "read the README and report the result";
export const FALLBACK_SUCCESS_TEXT = "fallback completed successfully";
export const ROLLBACK_SHIM_FILENAME = "rollback-shim.js";
export const ROLLBACK_DISABLED_SURFACE = "callable-send-message" as const;
export const ROLLBACK_SHIM_BOUNDARY = "extension-factory-proxy" as const;
export const ROLLBACK_REQUIRED_DELEGATION_SURFACES = [
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
export const ORIGINAL_USER = "PI_MODEL_FAILOVER_SMOKE_ORIGINAL_USER_31a7";
export const STEERING_USER = "PI_MODEL_FAILOVER_SMOKE_STEERING_USER_4c2b";
export const FOLLOW_UP_USER = "PI_MODEL_FAILOVER_SMOKE_FOLLOW_UP_USER_8e19";
export const QUEUED_USER = "PI_MODEL_FAILOVER_SMOKE_QUEUED_USER_6d44";
export const UNRELATED_CUSTOM_TYPE = "trusted-extension.note";
export const ORIGINAL_TASK_ID = "task-1";
export const ORIGINAL_USER_ID = "user-1";
export const STEERING_USER_ID = "steering-1";
export const FOLLOW_UP_USER_ID = "follow-up-1";
export const QUEUED_USER_ID = "queued-user-1";
export const PARENT_TOOL_CALL_ID = "smoke-parent-tool-call";
export const CHILD_TOOL_CALL_ID = "smoke-child-tool-call";

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

export const SHA256 = /^[a-f0-9]{64}$/u;
export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const UUID_V4_OCCURRENCE =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
export const PACKAGE_NAME = "@weaveio/weave-adapter-pi";
export const PACKAGE_VERSION = "0.0.1";
export const FIXTURE_PACKAGE_NAME = "@weaveio/pi-model-fallback-smoke-fixture";
export const FIXTURE_PACKAGE_VERSION = "1.0.0";
export const UNSAFE_PROVENANCE_ENV =
  "WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE";
export const SAFE_PATH_PREFIXES = ["/tmp/", "/private/tmp/"] as const;
export const PI_NATIVE_THREAD_ENTRY_TYPE = "weave.child.thread";
/** Durable child output bookkeeping, not transcript context. */
export const PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE = "weave.child.result-chunk";
export const PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE = "weave.child.result-commit";
export const NATIVE_RECOVERY_MARKER_TYPE =
  "weave.model-fallback.recovery-marker";
export const NATIVE_RECOVERY_ENTRY_TYPE = "weave.model-failover";
export const HEALTH_MODE_PATTERN = /Weave adapter mode:\s*([^\r\n]*)/giu;
export const HEALTH_ONLY_FACT_PATTERN = /health-only:\s*([^\r\n]*)/giu;
export const HEALTH_SURFACE_GAP_PATTERN =
  /host surface gap:\s*([\s\S]*?)(?=\r?\n\s*(?:host surface gap:|child inspection:|overlay:)|$)/giu;
export const RUNTIME_MODEL_FALLBACK_PROBE_REASONS = new Set([
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
export const MAX_HEALTH_SURFACE_GAPS = 16;

export type FailureBase = { readonly type: string; readonly detail?: string };
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

export const CLEANUP_VERIFICATION_KEYS = [
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

export interface ScenarioPaths {
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

export interface ScenarioObservation {
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

export function failure<T extends SmokeFailure["type"]>(
  type: T,
  detail?: string,
): SmokeFailure {
  return detail === undefined ? { type } : { type, detail };
}

export function artifactDigest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function hashDescriptorPart(namespace: string, value: string): string {
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

/**
 * The fallback fixture on Pi 0.84.2 sends only the task, tool call, and tool
 * result to the provider. Steering, follow-up, and queued input are not part
 * of this fixture run.
 */
export const EXPECTED_PROVIDER_FACTS: readonly FixtureContextFact[] = [
  "original-task-user",
  "tool-call",
  "tool-result",
];
export const EXPECTED_HISTORY_FACTS: readonly FixtureContextFact[] = [
  "original-task-user",
  "tool-call",
  "tool-result",
  "failed-assistant",
  "recovery-marker",
  "successful-assistant",
];

export const FACT_ROLES: Readonly<
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

export const FACT_CUSTOM_TYPES: Partial<Record<FixtureContextFact, string>> = {
  "unrelated-custom": UNRELATED_CUSTOM_TYPE,
  "recovery-marker": NATIVE_RECOVERY_MARKER_TYPE,
};
export const FACT_PROVIDER_ROLES: Readonly<
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

export function descriptorCounts(
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

export function boundText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export function safeDiagnostic(value: unknown): string {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function boundedCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 256
  );
}
