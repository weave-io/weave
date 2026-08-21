import type { ResultAsync } from "neverthrow";
import type {
  ExtensionBuildIdentityManifest,
  ExtensionBuildIdentityProof,
  ExtensionBuildIdentityState,
} from "../../packages/adapters/pi/src/extension-build-identity.js";

export type VerifyChildStreamingArgs =
  | {
      readonly command: "identity";
      readonly pi: string;
      readonly requireCurrentBuild: boolean;
    }
  | {
      readonly command: "capture";
      readonly pi: string;
      readonly requireHostVersion: string;
      readonly omitReasoningContent: true;
      readonly sanitize: true;
      readonly verifyBounds: true;
      readonly fixtureDir?: string;
    }
  | {
      readonly command: "replay";
      readonly fixture: string;
      readonly injectControlledReasoningInMemory: true;
      readonly verifyManifest: true;
      readonly runRedControls: true;
    };

export type VerifyChildStreamingFailureType =
  | "invalid-args"
  | "git-mismatch"
  | "source-mismatch"
  | "output-mismatch"
  | "stale-on-disk"
  | "manifest-mismatch"
  | "unverifiable"
  | "probe-failed"
  | "pi-version-mismatch"
  | "pi-ai-unavailable"
  | "workspace-failed"
  | "spawn-failed"
  | "capture-timeout"
  | "bounds-exceeded"
  | "forbidden-content"
  | "sanitization-failed"
  | "fixture-exists"
  | "write-failed"
  | "manifest-corrupt"
  | "fixture-corrupt"
  | "missing-text-delta"
  | "broken-tool-correlation"
  | "malformed-thinking-lifecycle";

export type VerifyChildStreamingFailure = {
  readonly type: VerifyChildStreamingFailureType;
  readonly state?: Exclude<ExtensionBuildIdentityState, "current">;
  readonly evidence: "blocked";
};

export function blocked(
  type: VerifyChildStreamingFailureType,
  state?: Exclude<ExtensionBuildIdentityState, "current">,
): VerifyChildStreamingFailure {
  return {
    type,
    ...(state === undefined ? {} : { state }),
    evidence: "blocked",
  };
}

export interface IdentityVerificationSuccess {
  readonly state: "current";
  readonly evidence: "identity-proven";
  readonly subject: string;
  readonly dirty: boolean;
  readonly artifactSha256: string;
  readonly loadTimeMs: number;
  readonly processStartMs: number;
}

export interface IdentityVerificationFacts {
  readonly manifest: ExtensionBuildIdentityManifest;
  readonly currentBuildInputs: readonly string[];
  readonly currentOutputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly currentSubject: string;
  readonly currentDirty: boolean;
  readonly loadedProof?: ExtensionBuildIdentityProof;
  readonly nowMs?: number;
}

export interface VerifyCurrentBuildIdentityInput {
  readonly repoRoot: string;
  readonly pi: string;
  readonly requireCurrentBuild?: boolean;
  readonly nowMs?: number;
  /** Test seam. Production starts the requested Pi executable. */
  readonly probe?: () => ResultAsync<
    ExtensionBuildIdentityProof,
    VerifyChildStreamingFailure
  >;
}

export interface IdentityProbeIsolationPaths {
  readonly root: string;
  readonly home: string;
  readonly agent: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly temporary: string;
}

export type ChildStreamingEvidenceClass =
  | "stale-screenshot"
  | "post-build-red-reproduction"
  | "identity-proven";
