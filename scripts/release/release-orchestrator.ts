import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  type BindingVerificationContext,
  verifyBindingRecord,
} from "./artifact-binding.js";
import { validateArtifactManifest } from "./artifact-manifest.js";
import type { Clock } from "./clock.js";
import type { ReleaseError } from "./errors.js";
import type { FileSystem } from "./filesystem.js";
import type { GitHubClient } from "./github-client.js";
import type { ReleaseInvocation } from "./input-validation.js";
import {
  MetadataReplay,
  type MetadataReplayError,
  type ReplayPlan,
} from "./metadata-replay.js";
import type { MetadataReplayRecord } from "./model.js";
import {
  type NightlyPlan,
  type NightlyPlanError,
  type NightlyPlanInput,
  NightlyPlanner,
} from "./nightly-plan.js";
import type { NpmRegistryClient } from "./npm-registry-client.js";
import {
  type CredentialScanInput,
  scanCredentialSources,
} from "./package-policy.js";
import type {
  StableCutInput,
  StableCutPlan,
  StableFixInput,
  StableFixPlan,
} from "./stable-train.js";
import { planStableCut, planStableFix } from "./stable-train.js";
import { TarInspector } from "./tar-inspector.js";

export interface PublishRequest {
  invocation: ReleaseInvocation;
  manifest: unknown;
  artifactDirectory: string;
  /** Live Actions proof is mandatory before any registry command. */
  bindingVerification: {
    record: unknown;
    context: BindingVerificationContext;
    github: GitHubClient;
  };
  credentialScan?: CredentialScanInput;
}
export interface PromotionAuthorization {
  schemaVersion: 1;
  operation: "stable-publish";
  state: "awaiting-promotion";
  subjectSha: string;
  packages: readonly string[];
  versions: Readonly<Record<string, string>>;
  artifactDigests: Readonly<Record<string, string>>;
}
export type PublishResult =
  | { state: "published"; promotionAuthorization?: PromotionAuthorization }
  | { state: "partial"; reason: string };
/** Composition root for npm publishing. GitHub/train workflows are added in Tasks 9/13/19/20. */
export class ReleaseOrchestrator {
  constructor(
    private readonly files: FileSystem,
    private readonly npm: NpmRegistryClient,
    private readonly clock: Clock,
    private readonly tarInspector = new TarInspector(),
  ) {}
  /** Plan-only nightly path; publication remains intentionally unavailable until Task 17. */
  planNightly(
    input: NightlyPlanInput,
  ): ResultAsync<NightlyPlan, NightlyPlanError> {
    return new NightlyPlanner(this.npm, this.clock).plan(input);
  }
  /** Pure cut planning; the release-refs job alone performs the corresponding ref mutation. */
  planStableCut(
    input: StableCutInput,
  ): ResultAsync<StableCutPlan, import("./stable-train.js").StableTrainError> {
    const plan = planStableCut(input);
    return plan.isOk() ? okAsync(plan.value) : errAsync(plan.error);
  }
  /** Pure fix planning; callers must execute only the listed CAS cherry-pick result. */
  planStableFix(
    input: StableFixInput,
  ): ResultAsync<StableFixPlan, import("./stable-train.js").StableTrainError> {
    const plan = planStableFix(input);
    return plan.isOk() ? okAsync(plan.value) : errAsync(plan.error);
  }
  /** Plans a replay onto a maintainer-created metadata branch; it never mutates refs. */
  planMetadataReplay(
    record: MetadataReplayRecord,
    branch: string,
  ): ResultAsync<ReplayPlan, MetadataReplayError> {
    return new MetadataReplay(this.files, this.clock).applyReplay(
      record,
      branch,
    );
  }
  publish(request: PublishRequest): ResultAsync<PublishResult, ReleaseError> {
    if (request.credentialScan !== undefined) {
      const credentials = scanCredentialSources(request.credentialScan);
      if (credentials.isErr())
        return errAsync({
          type: "CredentialSourceDetected",
          source: credentials.error,
        });
    }
    return verifyBindingRecord(
      request.bindingVerification.record,
      request.bindingVerification.context,
      request.bindingVerification.github,
    )
      .mapErr((error) => ({
        type: "BindingVerificationFailed" as const,
        reason: error.type === "BindingMismatch" ? error.field : error.type,
      }))
      .andThen(() => this.publishVerified(request));
  }

  /** Task 20 may map post-publish stable failures to `partial` without authorization. */
  private publishVerified(
    request: PublishRequest,
  ): ResultAsync<PublishResult, ReleaseError> {
    if (request.invocation.eventName !== "workflow_dispatch")
      return errAsync({ type: "UnsupportedOperation", operation: "schedule" });
    const stablePublication = request.invocation.operation === "stable-publish";
    if (
      request.invocation.operation !== "nightly" &&
      request.invocation.operation !== "stable-publish"
    )
      return errAsync({
        type: "UnsupportedOperation",
        operation: request.invocation.operation,
      });
    const manifest = validateArtifactManifest(request.manifest);
    if (manifest.isErr())
      return errAsync({
        type: "InvalidManifest",
        issues: manifest.error.issues,
      });
    const tag =
      request.invocation.operation === "nightly"
        ? "nightly"
        : ("next" as const);
    return manifest.value.artifacts
      .reduce<ResultAsync<void, ReleaseError>>(
        (chain, artifact) =>
          chain.andThen(() => {
            const path = `${request.artifactDirectory}/${artifact.filename}`;
            return this.files.readBytes(path).andThen((bytes) => {
              const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
              if (digest !== artifact.sha256)
                return errAsync({
                  type: "DigestMismatch" as const,
                  expected: artifact.sha256,
                  actual: digest,
                });
              const inspected = this.tarInspector.inspect(bytes);
              if (inspected.isErr())
                return errAsync({
                  type: "TarPreflightFailed" as const,
                  reason: inspected.error.type,
                });
              const packageName = manifest.value.packages.find((name) =>
                artifact.filename.includes(name.replace("/", "-")),
              );
              if (packageName === undefined)
                return errAsync({
                  type: "InvalidManifest" as const,
                  issues: ["artifact has no package"],
                });
              const version = manifest.value.versions[packageName];
              return this.npm.listVersions(packageName).andThen((versions) => {
                if (versions.includes(version))
                  return this.npm
                    .verifyPublished(packageName, version, artifact.sha256)
                    .mapErr((error) =>
                      error.message === "tarball digest mismatch"
                        ? {
                            type: "RegistryDigestConflict" as const,
                            packageName,
                            version,
                          }
                        : error,
                    );
                return this.npm.publish(path, tag).andThen(() => {
                  return this.npm.verifyPublished(
                    packageName,
                    version,
                    artifact.sha256,
                  );
                });
              });
            });
          }),
        okAsync(undefined),
      )
      .map(() => {
        if (!stablePublication) return { state: "published" };
        return {
          state: "published",
          promotionAuthorization: {
            schemaVersion: 1,
            operation: "stable-publish",
            state: "awaiting-promotion",
            subjectSha: manifest.value.releaseSubjectSha,
            packages: manifest.value.packages,
            versions: manifest.value.versions,
            artifactDigests: Object.fromEntries(
              manifest.value.artifacts.map((artifact) => [
                artifact.filename,
                artifact.sha256,
              ]),
            ),
          },
        };
      });
  }
}
