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
import type { GitHubClient } from "./github-client.js";
import type { ReleaseInvocation } from "./input-validation.js";
import {
  MetadataReplay,
  type MetadataReplayError,
  type ReplayPlan,
} from "./metadata-replay.js";
import type { MetadataReplayRecord } from "./model.js";
import {
  DigestSchema,
  FullShaSchema,
  PackageNameSchema,
  SemVerSchema,
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
import { planStableCut, planStableFix } from "./stable-train.js";
import { TarInspector } from "./tar-inspector.js";

const STABLE_PROMOTION_PACKAGES = [
  "@weaveio/weave-cli",
  "@weaveio/weave-adapter-opencode",
] as const;
const PromotionAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("stable-publish"),
    state: z.literal("awaiting-promotion"),
    subjectSha: FullShaSchema,
    packages: z.array(PackageNameSchema).length(2),
    versions: z.record(z.string(), SemVerSchema),
    artifactDigests: z.record(z.string(), DigestSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = new Set<string>(STABLE_PROMOTION_PACKAGES);
    if (value.packages.some((packageName) => !expected.has(packageName)))
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "stable promotion requires CLI and OpenCode",
      });
    for (const packageName of STABLE_PROMOTION_PACKAGES)
      if (
        !value.packages.includes(packageName) ||
        value.versions[packageName] === undefined ||
        value.artifactDigests[packageName] === undefined
      )
        context.addIssue({
          code: "custom",
          path: ["packages"],
          message: "promotion record must bind both stable packages",
        });
    if (
      Object.keys(value.versions).some((name) => !expected.has(name)) ||
      Object.keys(value.artifactDigests).some((name) => !expected.has(name))
    )
      context.addIssue({
        code: "custom",
        path: ["versions"],
        message: "promotion maps must contain only stable packages",
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
          const prior = this.validatePriorLatest(request.priorLatestVersions);
          if (prior.isErr()) return errAsync(prior.error);
          return okAsync({
            state: "awaiting-human-promotion" as const,
            priorLatestCaptureCommands: STABLE_PROMOTION_PACKAGES.map(
              (packageName) => `npm dist-tag ls ${packageName} --json`,
            ),
            promoteCommands: STABLE_PROMOTION_PACKAGES.map(
              (packageName) =>
                `npm dist-tag add ${packageName}@${authorization.versions[packageName]} latest`,
            ),
            rollbackCommands: STABLE_PROMOTION_PACKAGES.map(
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
  ): ResultAsync<StableFinalizeResult, ReleaseError> {
    return this.validatePromotionAuthorization(authorization).andThen(
      (record) =>
        this.verifyTagAndDigests(record, "latest").map(() => ({
          state: "promoted" as const,
          authorization: record,
        })),
    );
  }

  /** Verifies a human-executed rollback is back at both recorded prior versions. */
  verifyPromotionRollback(
    authorization: unknown,
    priorLatestVersions: Readonly<Record<string, string>>,
  ): ResultAsync<{ state: "rolled-back" }, ReleaseError> {
    return this.validatePromotionAuthorization(authorization).andThen(() => {
      const prior = this.validatePriorLatest(priorLatestVersions);
      if (prior.isErr()) return errAsync(prior.error);
      return STABLE_PROMOTION_PACKAGES.reduce<ResultAsync<void, ReleaseError>>(
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
      ).map(() => ({ state: "rolled-back" as const }));
    });
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
              manifest.value.packages.map((packageName) => [
                packageName,
                manifest.value.artifacts.find((artifact) =>
                  artifact.filename.includes(packageName.replace("/", "-")),
                )?.sha256 ?? `sha256:${"0".repeat(64)}`,
              ]),
            ),
          },
        };
      });
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

  private validatePriorLatest(
    versions: Readonly<Record<string, string>>,
  ): Result<Record<string, string>, ReleaseError> {
    const result: Record<string, string> = {};
    for (const packageName of STABLE_PROMOTION_PACKAGES) {
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
    return STABLE_PROMOTION_PACKAGES.reduce<ResultAsync<void, ReleaseError>>(
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
    return STABLE_PROMOTION_PACKAGES.reduce<
      ResultAsync<string[], ReleaseError>
    >(
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
    ).map((promoted) => ({
      promoted,
      unpromoted: STABLE_PROMOTION_PACKAGES.filter(
        (packageName) => !promoted.includes(packageName),
      ),
    }));
  }
}
