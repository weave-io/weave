import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import {
  type BindingVerificationContext,
  verifyBindingRecord,
} from "./artifact-binding.js";
import { validateArtifactManifest } from "./artifact-manifest.js";
import type { Clock } from "./clock.js";
import type { ReleaseError } from "./errors.js";
import type { FileSystem } from "./filesystem.js";
import type {
  GitHubClient,
  GitHubRelease,
  GitHubReleaseClient,
} from "./github-client.js";
import type { ReleaseInvocation } from "./input-validation.js";
import {
  MetadataReplay,
  type MetadataReplayError,
  type ReplayPlan,
} from "./metadata-replay.js";
import type { MetadataReplayRecord, StableTrainRecord } from "./model.js";
import {
  DigestSchema,
  FullShaSchema,
  PackageNameSchema,
  packageArtifactFilename,
  SemVerSchema,
  StableTrainRecordSchema,
} from "./model.js";
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
import {
  guardTrainExpiry,
  planStableCut,
  planStableFix,
  transitionStableTrain,
} from "./stable-train.js";
import { TarInspector } from "./tar-inspector.js";

const IMMUTABLE_POLL_ATTEMPTS = 5;
const IMMUTABLE_POLL_DELAY_MS = 1_000;
interface ExpectedReleaseAsset {
  name: string;
  bytes: Uint8Array;
  size: number;
  digest: string;
}
function digestBytes(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}
export const PromotionAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("stable-publish"),
    state: z.literal("awaiting-promotion"),
    subjectSha: FullShaSchema,
    packages: z.array(PackageNameSchema).min(1),
    versions: z.record(z.string(), SemVerSchema),
    artifactDigests: z.record(z.string(), DigestSchema),
    originRunId: z.number().int().positive(),
    awaitingPromotionTrain: StableTrainRecordSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = new Set<string>(value.packages);
    if (expected.size !== value.packages.length)
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "promotion packages must be unique",
      });
    for (const packageName of value.packages)
      if (
        value.versions[packageName] === undefined ||
        value.artifactDigests[packageName] === undefined
      )
        context.addIssue({
          code: "custom",
          path: ["packages"],
          message: "promotion record must bind every train package",
        });
    if (
      Object.keys(value.versions).some((name) => !expected.has(name)) ||
      Object.keys(value.artifactDigests).some((name) => !expected.has(name))
    )
      context.addIssue({
        code: "custom",
        path: ["versions"],
        message: "promotion maps must contain exactly the authorized packages",
      });
    const train = value.awaitingPromotionTrain;
    if (
      train.state !== "awaiting-promotion" ||
      train.subjectSha !== value.subjectSha ||
      JSON.stringify(train.packages) !== JSON.stringify(value.packages) ||
      JSON.stringify(train.versions) !== JSON.stringify(value.versions) ||
      train.artifactManifestDigest === undefined ||
      train.artifactIds === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["awaitingPromotionTrain"],
        message: "authorization must embed its bound awaiting-promotion train",
      });
  });

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
  /** Stable operations carry the content-addressed train they are advancing. */
  stableTrain?: StableTrainRecord;
}
export interface PromotionAuthorization {
  schemaVersion: 1;
  operation: "stable-publish";
  state: "awaiting-promotion";
  subjectSha: string;
  packages: readonly string[];
  versions: Readonly<Record<string, string>>;
  artifactDigests: Readonly<Record<string, string>>;
  originRunId: number;
  awaitingPromotionTrain: StableTrainRecord;
}
export interface PromotionCommandRequest {
  authorization: unknown;
  /** Values transcribed by the second maintainer from the prior `dist-tag ls`. */
  priorLatestVersions: Readonly<Record<string, string>>;
}
export interface PromotionCommands {
  state: "awaiting-human-promotion";
  priorLatestCaptureCommands: readonly string[];
  promoteCommands: readonly string[];
  rollbackCommands: readonly string[];
}
export interface StableFinalizeResult {
  state: "promoted";
  authorization: PromotionAuthorization;
  stableTrain: StableTrainRecord;
}
export interface StableReleaseRefsRequest {
  authorization: unknown;
  manifest: unknown;
  artifactDirectory: string;
  github: GitHubReleaseClient;
  /** Recorded changelog text. Its digest is compared exactly for idempotence. */
  notes: string;
  immutablePollAttempts?: number;
  stableTrain?: StableTrainRecord;
}
export interface StableReleaseRefsResult {
  state: "released" | "already-immutable";
  tags: Readonly<Record<string, "verified" | "unsigned">>;
}
export type PublishResult =
  | {
      state: "published";
      promotionAuthorization?: PromotionAuthorization;
      stableTrain?: StableTrainRecord;
    }
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
    if (
      request.invocation.eventName === "workflow_dispatch" &&
      request.invocation.channel === "stable" &&
      request.stableTrain === undefined
    )
      return errAsync({
        type: "StableTrainRequired",
        operation: request.invocation.operation,
      });
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

  /**
   * Emits instructions only after independently proving both `next` packages.
   * npm trusted publishing cannot mutate dist-tags (npm/cli#8547), so these
   * commands are deliberately never passed to CommandRunner.
   */
  generatePromotionCommands(
    request: PromotionCommandRequest,
  ): ResultAsync<PromotionCommands, ReleaseError> {
    return this.validatePromotionAuthorization(request.authorization).andThen(
      (authorization) =>
        this.verifyTagAndDigests(authorization, "next").andThen(() => {
          const prior = this.validatePriorLatest(
            request.priorLatestVersions,
            authorization.packages,
          );
          if (prior.isErr()) return errAsync(prior.error);
          return okAsync({
            state: "awaiting-human-promotion" as const,
            priorLatestCaptureCommands: authorization.packages.map(
              (packageName) => `npm dist-tag ls ${packageName} --json`,
            ),
            promoteCommands: authorization.packages.map(
              (packageName) =>
                `npm dist-tag add ${packageName}@${authorization.versions[packageName]} latest`,
            ),
            rollbackCommands: authorization.packages.map(
              (packageName) =>
                `npm dist-tag add ${packageName}@${prior.value[packageName]} latest`,
            ),
          });
        }),
    );
  }

  /** Read-only final gate; Task 19 may attach App tag/release actions after this proof. */
  stableFinalize(
    authorization: unknown,
    stableTrain?: StableTrainRecord,
  ): ResultAsync<StableFinalizeResult, ReleaseError> {
    return this.validatePromotionAuthorization(authorization).andThen(
      (record) => {
        const lineage = this.assertPromotionAuthorizationLineage(
          record,
          stableTrain,
        );
        if (lineage.isErr()) return errAsync(lineage.error);
        const transition = this.assertStableTransition(stableTrain, "promoted");
        if (transition.isErr()) return errAsync(transition.error);
        return this.verifyTagAndDigests(record, "latest").map(() => ({
          state: "promoted" as const,
          authorization: record,
          stableTrain: transition.value,
        }));
      },
    );
  }

  /**
   * App-only post-finalize release operation. Drafts can be reconciled, but a
   * published release is never updated: only exact immutable state is success.
   */
  stableReleaseRefs(
    request: StableReleaseRefsRequest,
  ): ResultAsync<StableReleaseRefsResult, ReleaseError> {
    const transition = this.assertStableTransition(
      request.stableTrain,
      "release-draft",
    );
    if (transition.isErr()) return errAsync(transition.error);
    return this.validatePromotionAuthorization(request.authorization).andThen(
      (authorization) => {
        const manifest = validateArtifactManifest(request.manifest);
        if (manifest.isErr())
          return errAsync({
            type: "InvalidManifest" as const,
            issues: manifest.error.issues,
          });
        if (manifest.value.releaseSubjectSha !== authorization.subjectSha)
          return errAsync({
            type: "ReleaseMismatch" as const,
            tag: "train",
            reason: "manifest subject differs from promotion record",
          });
        const attempts =
          request.immutablePollAttempts ?? IMMUTABLE_POLL_ATTEMPTS;
        if (!Number.isSafeInteger(attempts) || attempts < 1)
          return errAsync({
            type: "ReleaseMismatch" as const,
            tag: "train",
            reason: "immutable poll attempts must be positive",
          });
        return this.ensureTags(authorization, request.github).andThen((tags) =>
          authorization.packages
            .reduce<
              ResultAsync<"released" | "already-immutable", ReleaseError>
            >(
              (chain, packageName) =>
                chain.andThen((state) =>
                  this.releasePackage(
                    packageName,
                    authorization,
                    manifest.value,
                    request,
                    attempts,
                  ).map((next) =>
                    state === "released" || next === "released"
                      ? "released"
                      : "already-immutable",
                  ),
                ),
              okAsync("already-immutable"),
            )
            .map((state) => ({ state, tags })),
        );
      },
    );
  }

  /** Verifies a human-executed rollback is back at both recorded prior versions. */
  verifyPromotionRollback(
    authorization: unknown,
    priorLatestVersions: Readonly<Record<string, string>>,
  ): ResultAsync<{ state: "rolled-back" }, ReleaseError> {
    return this.validatePromotionAuthorization(authorization).andThen(
      (record) => {
        const prior = this.validatePriorLatest(
          priorLatestVersions,
          record.packages,
        );
        if (prior.isErr()) return errAsync(prior.error);
        return record.packages
          .reduce<ResultAsync<void, ReleaseError>>(
            (chain, packageName) =>
              chain.andThen(() =>
                this.npm.distTagLs(packageName).andThen((tags) => {
                  if (tags.latest === prior.value[packageName])
                    return okAsync(undefined);
                  return errAsync({
                    type: "RollbackVerificationFailed" as const,
                    packageName,
                    expected: prior.value[packageName],
                    actual: tags.latest,
                  });
                }),
              ),
            okAsync(undefined),
          )
          .map(() => ({ state: "rolled-back" as const }));
      },
    );
  }

  /** Task 20 may map post-publish stable failures to `partial` without authorization. */
  private publishVerified(
    request: PublishRequest,
  ): ResultAsync<PublishResult, ReleaseError> {
    if (request.invocation.eventName !== "workflow_dispatch")
      return errAsync({ type: "UnsupportedOperation", operation: "schedule" });
    const stablePublication = request.invocation.operation === "stable-publish";
    let publishedTrain: StableTrainRecord | undefined;
    if (stablePublication) {
      const transition = this.assertStableTransition(
        request.stableTrain,
        "published-next",
      );
      if (transition.isErr()) return errAsync(transition.error);
      publishedTrain = transition.value;
    }
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
      .andThen(() => {
        if (!stablePublication) return okAsync({ state: "published" as const });
        const awaiting = this.assertStableTransition(
          publishedTrain,
          "awaiting-promotion",
        );
        if (awaiting.isErr()) return errAsync(awaiting.error);
        return okAsync({
          state: "published" as const,
          stableTrain: awaiting.value,
          promotionAuthorization: {
            schemaVersion: 1,
            operation: "stable-publish",
            state: "awaiting-promotion",
            subjectSha: manifest.value.releaseSubjectSha,
            packages: manifest.value.packages,
            versions: manifest.value.versions,
            artifactDigests: Object.fromEntries(
              manifest.value.packages.map((packageName) => [
                packageName,
                manifest.value.artifacts.find((artifact) =>
                  artifact.filename.includes(packageName.replace("/", "-")),
                )?.sha256 ?? `sha256:${"0".repeat(64)}`,
              ]),
            ),
            originRunId: request.bindingVerification.context.expectedRunId,
            awaitingPromotionTrain: awaiting.value,
          },
        });
      });
  }

  private ensureTags(
    authorization: PromotionAuthorization,
    github: GitHubReleaseClient,
  ): ResultAsync<Record<string, "verified" | "unsigned">, ReleaseError> {
    return authorization.packages.reduce<
      ResultAsync<Record<string, "verified" | "unsigned">, ReleaseError>
    >(
      (chain, packageName) =>
        chain.andThen((result) => {
          const tag = this.releaseTag(
            packageName,
            authorization.versions[packageName],
          );
          return github
            .getRef(`refs/tags/${tag}`)
            .andThen((sha) =>
              this.verifyExistingTag(
                tag,
                authorization.subjectSha,
                sha,
                github,
              ),
            )
            .orElse((error) => {
              if (error.type !== "GitHubError" || error.status !== 404)
                return errAsync(error);
              return github
                .createRef(`refs/tags/${tag}`, authorization.subjectSha)
                .andThen(() => github.getTagVerification(tag));
            })
            .map((verification) => ({ ...result, [tag]: verification }));
        }),
      okAsync<Record<string, "verified" | "unsigned">, ReleaseError>({}),
    );
  }

  private verifyExistingTag(
    tag: string,
    expectedSha: string,
    actualSha: string,
    github: GitHubReleaseClient,
  ): ResultAsync<"verified" | "unsigned", ReleaseError> {
    if (actualSha !== expectedSha)
      return errAsync({
        type: "ReleaseRefMismatch",
        tag,
        expectedSha,
        actualSha,
      });
    return github.getTagVerification(tag);
  }

  private releasePackage(
    packageName: string,
    authorization: PromotionAuthorization,
    manifest: import("./model.js").ArtifactManifest,
    request: StableReleaseRefsRequest,
    attempts: number,
  ): ResultAsync<"released" | "already-immutable", ReleaseError> {
    const version = authorization.versions[packageName];
    const tag = this.releaseTag(packageName, version);
    return this.expectedAssets(
      packageName,
      version,
      manifest,
      request.artifactDirectory,
    ).andThen((assets) =>
      request.github
        .getRelease(tag)
        .andThen((release) =>
          this.handleExistingRelease(
            release,
            tag,
            authorization.subjectSha,
            request.notes,
            assets,
            request,
            attempts,
          ),
        )
        .orElse((error) => {
          if (error.type !== "GitHubError" || error.status !== 404)
            return errAsync(error);
          return request.github
            .createDraftRelease({
              tag,
              targetSha: authorization.subjectSha,
              name: tag,
              notes: request.notes,
            })
            .andThen((release) =>
              this.reconcileDraft(
                release,
                tag,
                authorization.subjectSha,
                request.notes,
                assets,
                request.github,
              ).andThen((draft) =>
                this.publishAndVerify(draft, tag, request.github, attempts),
              ),
            );
        }),
    );
  }

  private handleExistingRelease(
    release: GitHubRelease,
    tag: string,
    targetSha: string,
    notes: string,
    assets: readonly ExpectedReleaseAsset[],
    request: StableReleaseRefsRequest,
    attempts: number,
  ): ResultAsync<"released" | "already-immutable", ReleaseError> {
    const checked = this.verifyRelease(release, tag, targetSha, notes, assets);
    if (release.immutable)
      return checked.andThen(() =>
        request.github.hasReleaseAttestation(release.id).andThen((present) =>
          present
            ? okAsync("already-immutable" as const)
            : errAsync({
                type: "ReleaseAttestationNotVerifiable" as const,
                tag,
                reason: "GitHub returned no platform attestation",
              }),
        ),
      );
    if (!release.draft)
      return errAsync({
        type: "ReleaseMismatch",
        tag,
        reason: "published release is not immutable and cannot be edited",
      });
    // Draft-only reconciliation is the sole mutation path for an existing release.
    return this.reconcileDraft(
      release,
      tag,
      targetSha,
      notes,
      assets,
      request.github,
    ).andThen((draft) =>
      this.publishAndVerify(draft, tag, request.github, attempts),
    );
  }

  private expectedAssets(
    packageName: string,
    version: string,
    manifest: import("./model.js").ArtifactManifest,
    directory: string,
  ): ResultAsync<readonly ExpectedReleaseAsset[], ReleaseError> {
    const filename = packageArtifactFilename(packageName, version);
    const artifact = manifest.artifacts.find(
      (entry) => entry.filename === filename,
    );
    if (artifact === undefined)
      return errAsync({
        type: "ReleaseMismatch" as const,
        tag: packageName,
        reason: "manifest artifact missing",
      });
    return this.files
      .readBytes(`${directory}/${filename}`)
      .andThen((tarball) => {
        const digest = digestBytes(tarball);
        if (digest !== artifact.sha256)
          return errAsync({
            type: "DigestMismatch" as const,
            expected: artifact.sha256,
            actual: digest,
          });
        if (tarball.byteLength !== artifact.sizeBytes)
          return errAsync({
            type: "ReleaseMismatch" as const,
            tag: packageName,
            reason: "tarball size differs from manifest",
          });
        return this.files
          .readBytes(`${directory}/${artifact.checksumFilename}`)
          .map((checksum) => [
            {
              name: filename,
              bytes: tarball,
              size: artifact.sizeBytes,
              digest: artifact.sha256,
            },
            {
              name: artifact.checksumFilename,
              bytes: checksum,
              size: checksum.byteLength,
              digest: digestBytes(checksum),
            },
          ]);
      });
  }

  private reconcileDraft(
    release: GitHubRelease,
    tag: string,
    targetSha: string,
    notes: string,
    assets: readonly ExpectedReleaseAsset[],
    github: GitHubReleaseClient,
  ): ResultAsync<GitHubRelease, ReleaseError> {
    if (!release.draft)
      return errAsync({
        type: "ReleaseMismatch",
        tag,
        reason: "published releases are never edited",
      });
    if (
      release.tag !== tag ||
      release.targetSha !== targetSha ||
      release.notes !== notes
    )
      return errAsync({
        type: "ReleaseMismatch",
        tag,
        reason: "draft identity differs from train record",
      });
    return assets
      .reduce<ResultAsync<void, ReleaseError>>(
        (chain, expected) =>
          chain.andThen(() => {
            const current = release.assets.find(
              (asset) => asset.name === expected.name,
            );
            if (current === undefined)
              return github
                .uploadReleaseAsset(release.id, expected.name, expected.bytes)
                .map(() => undefined);
            if (
              current.size === expected.size &&
              current.digest === expected.digest
            )
              return okAsync(undefined);
            // Strict policy: delete and replace only while the release remains a draft.
            return github
              .deleteReleaseAsset(release.id, current.id)
              .andThen(() =>
                github.uploadReleaseAsset(
                  release.id,
                  expected.name,
                  expected.bytes,
                ),
              )
              .map(() => undefined);
          }),
        okAsync<void, ReleaseError>(undefined),
      )
      .andThen(() => github.getRelease(tag))
      .andThen((draft) =>
        this.verifyRelease(draft, tag, targetSha, notes, assets).map(
          () => draft,
        ),
      );
  }

  private publishAndVerify(
    draft: GitHubRelease,
    tag: string,
    github: GitHubReleaseClient,
    attempts: number,
  ): ResultAsync<"released", ReleaseError> {
    if (!draft.draft)
      return errAsync({
        type: "ReleaseMismatch",
        tag,
        reason: "release became published before controlled publish",
      });
    return github
      .publishRelease(draft.id)
      .andThen(() => this.pollImmutable(tag, github, attempts, 1));
  }

  private pollImmutable(
    tag: string,
    github: GitHubReleaseClient,
    attempts: number,
    current: number,
  ): ResultAsync<"released", ReleaseError> {
    return github.getRelease(tag).andThen((release) => {
      if (!release.immutable) {
        if (current >= attempts)
          return errAsync({
            type: "ReleaseImmutableTimeout" as const,
            tag,
            attempts,
          });
        return this.clock
          .sleep(IMMUTABLE_POLL_DELAY_MS)
          .andThen(() =>
            this.pollImmutable(tag, github, attempts, current + 1),
          );
      }
      return github.hasReleaseAttestation(release.id).andThen((present) =>
        present
          ? okAsync("released" as const)
          : errAsync({
              type: "ReleaseAttestationNotVerifiable" as const,
              tag,
              reason: "GitHub returned no platform attestation",
            }),
      );
    });
  }

  private verifyRelease(
    release: GitHubRelease,
    tag: string,
    targetSha: string,
    notes: string,
    assets: readonly ExpectedReleaseAsset[],
  ): ResultAsync<void, ReleaseError> {
    if (
      release.tag !== tag ||
      release.targetSha !== targetSha ||
      release.notes !== notes
    )
      return errAsync({
        type: "ReleaseMismatch",
        tag,
        reason: "tag, target, or notes identity differs",
      });
    if (release.assets.length !== assets.length)
      return errAsync({
        type: "ReleaseMismatch",
        tag,
        reason: "asset set is incomplete or contains extras",
      });
    for (const expected of assets) {
      const actual = release.assets.find(
        (asset) => asset.name === expected.name,
      );
      if (
        actual === undefined ||
        actual.size !== expected.size ||
        actual.digest !== expected.digest
      )
        return errAsync({
          type: "ReleaseMismatch",
          tag,
          reason: `asset ${expected.name} differs`,
        });
    }
    return okAsync(undefined);
  }

  private releaseTag(packageName: string, version: string): string {
    return `weave-${packageName === "@weaveio/weave-cli" ? "cli" : "adapter-opencode"}-v${version}`;
  }

  private validatePromotionAuthorization(
    authorization: unknown,
  ): ResultAsync<PromotionAuthorization, ReleaseError> {
    const parsed = PromotionAuthorizationSchema.safeParse(authorization);
    if (parsed.success) return okAsync(parsed.data);
    return errAsync({
      type: "InvalidPromotionAuthorization",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    });
  }

  private assertStableTransition(
    record: StableTrainRecord | undefined,
    target: StableTrainRecord["state"],
  ): Result<StableTrainRecord, ReleaseError> {
    if (record === undefined)
      return err({
        type: "StableTrainRequired",
        operation: "stable release operation",
      });
    const expiry = guardTrainExpiry(record, this.clock);
    if (expiry.isErr())
      return err({
        type: "StableTrainStateInvalid",
        reason: expiry.error.type,
      });
    const transition = transitionStableTrain(record, target);
    if (transition.isErr()) {
      if (transition.error.type !== "InvalidTransition")
        return err({
          type: "StableTrainStateInvalid",
          reason: transition.error.type,
        });
      return err({
        type: "StableTrainStateInvalid",
        reason: `${transition.error.from}->${transition.error.to}`,
      });
    }
    return ok(transition.value);
  }

  private assertPromotionAuthorizationLineage(
    authorization: PromotionAuthorization,
    train: StableTrainRecord | undefined,
  ): Result<void, ReleaseError> {
    if (train === undefined)
      return err({ type: "StableTrainRequired", operation: "stable finalize" });
    if (authorization.subjectSha !== train.subjectSha)
      return err({
        type: "StableTrainStateInvalid",
        reason: "authorization subject differs from train",
      });
    if (
      authorization.awaitingPromotionTrain.recordDigest !== train.recordDigest
    )
      return err({
        type: "StableTrainStateInvalid",
        reason: "authorization train differs from finalize input",
      });
    if (
      JSON.stringify(authorization.packages) !== JSON.stringify(train.packages)
    )
      return err({
        type: "StableTrainStateInvalid",
        reason: "authorization packages differ from train",
      });
    if (
      JSON.stringify(authorization.versions) !== JSON.stringify(train.versions)
    )
      return err({
        type: "StableTrainStateInvalid",
        reason: "authorization versions differ from train",
      });
    if (
      train.artifactManifestDigest === undefined ||
      train.artifactIds === undefined
    )
      return err({
        type: "StableTrainStateInvalid",
        reason: "train lacks bound artifact identity",
      });
    return ok(undefined);
  }

  private validatePriorLatest(
    versions: Readonly<Record<string, string>>,
    packages: readonly string[],
  ): Result<Record<string, string>, ReleaseError> {
    const result: Record<string, string> = {};
    for (const packageName of packages) {
      const version = versions[packageName];
      if (version === undefined || !SemVerSchema.safeParse(version).success)
        return err({
          type: "InvalidPromotionAuthorization",
          issues: [`prior latest is missing or invalid for ${packageName}`],
        });
      result[packageName] = version;
    }
    return ok(result);
  }

  private verifyTagAndDigests(
    authorization: PromotionAuthorization,
    tag: "next" | "latest",
  ): ResultAsync<void, ReleaseError> {
    return authorization.packages
      .reduce<ResultAsync<void, ReleaseError>>(
        (chain, packageName) =>
          chain.andThen(() =>
            this.npm.distTagLs(packageName).andThen((tags) => {
              const expectedVersion = authorization.versions[packageName];
              if (tags[tag] !== expectedVersion)
                return errAsync({
                  type: "PromotionRegistryMismatch" as const,
                  packageName,
                  reason: `${tag} is ${tags[tag] ?? "absent"}, expected ${expectedVersion}`,
                });
              return this.npm
                .verifyPublished(
                  packageName,
                  expectedVersion,
                  authorization.artifactDigests[packageName],
                )
                .mapErr((error) => ({
                  type: "PromotionRegistryMismatch" as const,
                  packageName,
                  reason: error.message,
                }));
            }),
          ),
        okAsync(undefined),
      )
      .andThen(() => okAsync(undefined))
      .orElse((error) => {
        if (error.type !== "PromotionRegistryMismatch" || tag !== "latest")
          return errAsync(error);
        return this.promotionState(authorization).andThen((state) =>
          state.promoted.length === 1
            ? errAsync({
                type: "PartialPromotion" as const,
                promotedPackages: state.promoted,
                unpromotedPackages: state.unpromoted,
              })
            : errAsync(error),
        );
      });
  }

  private promotionState(
    authorization: PromotionAuthorization,
  ): ResultAsync<{ promoted: string[]; unpromoted: string[] }, ReleaseError> {
    return authorization.packages
      .reduce<ResultAsync<string[], ReleaseError>>(
        (chain, packageName) =>
          chain.andThen((promoted) =>
            this.npm
              .distTagLs(packageName)
              .map((tags) =>
                tags.latest === authorization.versions[packageName]
                  ? [...promoted, packageName]
                  : promoted,
              ),
          ),
        okAsync([]),
      )
      .map((promoted) => ({
        promoted,
        unpromoted: authorization.packages.filter(
          (packageName) => !promoted.includes(packageName),
        ),
      }));
  }
}
