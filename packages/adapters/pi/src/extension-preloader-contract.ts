import {
  EXTENSION_RUNTIME_OUTPUT_FILES,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  type ExtensionRuntimeOutputName,
} from "./extension-build-identity-types.js";

/** The query is the capability token for one pinned module graph. */
export const PIN_QUERY_PREFIX = "?weave=";
export const PINNED_PRELOADER_PLUGIN_NAME =
  "weave-pi-trusted-runtime-preloader-v2";

/** Keep the preloader's file graph aligned with the identity contract. */
export const RUNTIME_OUTPUTS = Object.freeze(
  EXTENSION_RUNTIME_OUTPUT_NAMES.map((name) => ({
    name,
    fileName: EXTENSION_RUNTIME_OUTPUT_FILES[name],
  })),
);

export type RuntimeOutputName = ExtensionRuntimeOutputName;

export interface ExtensionPreloaderDigest {
  readonly name: RuntimeOutputName;
  readonly sha256: string;
}

export type RuntimeDigest = ExtensionPreloaderDigest;

export type PreloadManifest = {
  readonly buildBinding: string;
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly outputs: ReadonlyMap<string, string>;
  readonly subject: string;
};

export type PinnedRuntime = {
  readonly ok: true;
  readonly artifactPath: string;
  readonly buildBinding: string;
  readonly loadedOutputs: readonly RuntimeDigest[];
  readonly modulePaths: ReadonlyMap<RuntimeOutputName, string>;
  readonly token: string;
};

export type PreloaderFailureReason =
  | PreloadFailure["reason"]
  | "load-cap-exceeded"
  | "module-path-missing"
  | "module-evaluation-failed"
  | "extension-start-failed";

export type PreloaderHealthStatus =
  | "idle"
  | "loading"
  | "loaded"
  | "failed"
  | "rejected";

export type PreloaderHealth = {
  readonly status: PreloaderHealthStatus;
  readonly lastAttemptAtMs?: number;
  readonly lastSettledAtMs?: number;
  readonly buildBinding?: string;
  readonly loadedOutputs?: readonly RuntimeDigest[];
  readonly reason?: PreloaderFailureReason;
};

export type LoadSlot = {
  bytes: number;
};

export type LoaderRegistration = {
  readonly pinnedPaths: Set<string>;
};

export interface ExtensionPreloaderRetentionSnapshot {
  readonly retainedPinnedBytes: number;
  readonly retainedPinnedEntries: number;
  readonly inFlightLoadCount: number;
  readonly inFlightPinnedBytes: number;
  readonly activeLoaderRegistrations: number;
  readonly pluginInstalled: boolean;
  readonly status: PreloaderHealthStatus;
  readonly lastAttemptAtMs?: number;
  readonly lastSettledAtMs?: number;
  readonly buildBinding?: string;
  readonly loadedOutputs?: readonly ExtensionPreloaderDigest[];
  readonly reason?: PreloaderFailureReason;
}

export interface GlobalLoaderState {
  readonly pins: Map<string, Uint8Array>;
  readonly registrations: Map<string, LoaderRegistration>;
  readonly inFlightLoads: Set<LoadSlot>;
  pluginInstalled: boolean;
  inFlightPinnedBytes: number;
  sequence: number;
  health: PreloaderHealth;
}

export type LoaderState = GlobalLoaderState;

export type TrustedModuleLoader = {
  readonly extensionProcessStartMs: () => number;
  readonly maybeWriteExtensionBuildIdentityProofLine: (
    identity: unknown,
  ) => boolean;
  readonly recordHostModuleOutcome: (outcome: unknown) => void;
  readonly recordPiExtensionEntryPath: (path: unknown) => void;
  readonly resolveHostModules: (environment: unknown) => Promise<unknown>;
  readonly BunPiHostModuleEnvironment: new () => unknown;
};

export type TrustedIdentityModule = {
  readonly maybeWriteExtensionBuildIdentityProofLine: (
    identity: unknown,
  ) => boolean;
  readonly extensionProcessStartMs: () => number;
};

export type TrustedImplementationModule = {
  readonly default: (pi: unknown) => void;
  readonly setLoadedPiExtensionIdentity?: (identity: unknown) => void;
};

export type PreloadFailure = {
  readonly ok: false;
  readonly reason:
    | "entry-path-missing"
    | "manifest-invalid"
    | "runtime-read-failed"
    | "runtime-digest-mismatch"
    | "binding-mismatch"
    | "pinned-loader-unavailable";
};

export type PreloadResult = PinnedRuntime | PreloadFailure;
