/** The sidecar schema is deliberately small and versioned independently. */
export const EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION = 1 as const;
export const EXTENSION_BUILD_BINDING_PLACEHOLDER =
  "0000000000000000000000000000000000000000000000000000000000000000" as const;
export const EXTENSION_BUILD_MANIFEST_FILENAME =
  "extension-build-identity.json" as const;
export const EXTENSION_BUILD_IDENTITY_PROOF_ENV =
  "WEAVE_PI_BUILD_IDENTITY_PROOF" as const;

/** Keep every identity surface bounded before it reaches a UI or proof line. */
export const MAX_EXTENSION_BUILD_MANIFEST_BYTES = 32 * 1024;
export const MAX_EXTENSION_BUILD_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH = 1_024;
export const MAX_EXTENSION_BUILD_INPUTS = 4_096;
export const MAX_EXTENSION_BUILD_OUTPUTS = 64;
export const MAX_EXTENSION_BUILD_SUBJECT_LENGTH = 128;
export const MAX_EXTENSION_BUILD_OUTPUT_NAME_LENGTH = 64;

/** Every runtime-loaded output is required for an exact loader attestation. */
export const EXTENSION_RUNTIME_OUTPUT_NAMES = Object.freeze([
  "extension",
  "extension-build-identity",
  "extension-impl",
  "host-module-loader",
] as const);

export type ExtensionRuntimeOutputName =
  (typeof EXTENSION_RUNTIME_OUTPUT_NAMES)[number];

/** The filenames are part of the loader/identity contract, not adapter wiring. */
export const EXTENSION_RUNTIME_OUTPUT_FILES = Object.freeze({
  extension: "extension.js",
  "extension-build-identity": "extension-build-identity.js",
  "extension-impl": "extension-impl.js",
  "host-module-loader": "host-module-loader.js",
} as const satisfies Record<ExtensionRuntimeOutputName, string>);

/** Bounds shared by the trusted preloader and identity readers. */
export const MAX_EXTENSION_ENTRY_PATH_LENGTH = 4_096;
export const MAX_EXTENSION_IN_FLIGHT_PRELOADS = 1;
export const MAX_EXTENSION_IN_FLIGHT_PINNED_BYTES =
  MAX_EXTENSION_BUILD_OUTPUT_BYTES;

/** A bounded, path-free digest for one logical build output. */
export interface ExtensionBuildOutputDigest {
  readonly name: string;
  readonly sha256: string;
}

export type ExtensionBuildIdentityState =
  | "current"
  | "stale-on-disk"
  | "manifest-mismatch"
  | "unverifiable";

export type ExtensionBuildIdentityReason =
  | "artifact-path-missing"
  | "artifact-read-failed"
  | "manifest-read-failed"
  | "manifest-malformed"
  | "build-binding-missing"
  | "build-binding-mismatch"
  | "loaded-artifact-missing"
  | "loaded-time-missing"
  | "process-start-missing"
  | "build-completion-invalid"
  | "build-completion-after-load"
  | "manifest-output-missing"
  | "proof-malformed";

export type ExtensionBuildIdentityError =
  | { readonly type: "ArtifactReadFailed" }
  | { readonly type: "ManifestReadFailed" }
  | { readonly type: "ManifestMalformed" }
  | { readonly type: "DigestFailed" };

export interface ExtensionBuildManifestGit {
  /** The repository subject SHA recorded by the build process. */
  readonly subject: string;
  readonly dirty: boolean;
}

/**
 * A path-free build manifest. Inputs are digest-only because source paths are
 * intentionally not part of an artifact identity record.
 */
export interface ExtensionBuildIdentityManifest {
  readonly schemaVersion: typeof EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION;
  /** Digest of the normalized runtime graph and build metadata. */
  readonly buildBinding: string;
  readonly git: ExtensionBuildManifestGit;
  readonly buildInputs: readonly string[];
  readonly outputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly buildCompletedAt: string;
}

/**
 * Facts captured by the loader before it evaluates the implementation. The
 * artifact path is an internal read capability and is never rendered.
 */
export interface ExtensionLoadedIdentity {
  readonly artifactPath?: string;
  /** The legacy entry digest, retained as the stable top-level fact. */
  readonly artifactSha256?: string;
  /** Digests captured before the loader evaluates the runtime graph. */
  readonly loadedOutputs?: readonly ExtensionBuildOutputDigest[];
  /** The entry's embedded binding, captured by the trusted preloader. */
  readonly buildBinding?: string;
  readonly loadTimeMs?: number;
  readonly processStartMs: number;
  readonly loadReason?: ExtensionBuildIdentityReason;
}

export interface ExtensionBuildIdentityHealth {
  readonly state: ExtensionBuildIdentityState;
  readonly loadedArtifactSha256?: string;
  readonly loadedOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly diskArtifactSha256?: string;
  readonly diskOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly manifestArtifactSha256?: string;
  readonly loadTimeMs?: number;
  readonly processStartMs?: number;
  readonly buildCompletedAt?: string;
  readonly sourceInputCount?: number;
  readonly gitSubject?: string;
  readonly gitDirty?: boolean;
  readonly reason?: ExtensionBuildIdentityReason;
}

export interface ExtensionBuildIdentityProof {
  readonly schemaVersion: typeof EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION;
  readonly artifactSha256?: string;
  readonly loadedOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly buildBinding?: string;
  readonly loadTimeMs?: number;
  readonly processStartMs?: number;
}

export type ExtensionBuildIdentityProofLine = {
  readonly weaveExtensionBuildIdentity: ExtensionBuildIdentityProof;
};
