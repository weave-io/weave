/**
 * Guarded nightly channel controller.
 *
 * Nightly is a deterministic projection of the packages that changed since
 * the last successful nightly. It never consumes changesets, edits the source
 * checkout, calls an AI model, or creates Git refs. The workflow adapts the
 * phases in this module to the shared build, attestation, consumer, harness,
 * and OIDC publication chain.
 */
import { dirname, join, resolve } from "node:path";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import { z } from "zod";
import { canonicalJson } from "./chain-step-support.js";
import {
  ADAPTER_PACKAGE_NAMES,
  type AdapterPackageName,
} from "./changed-adapters.js";
import {
  type PendingChangesetSet,
  subtractConsumedLedger,
} from "./changeset-consumption.js";
import {
  BunChangesetFileSystem,
  type ChangesetIdentity,
  type ChangesetPolicyError,
  ChangesetPolicyValidator,
  PRIVATE_SOURCE_DIRECTORIES,
  type ValidatedChangeset,
} from "./changeset-policy.js";
import type { ChannelRegistry } from "./channel-versions.js";
import {
  type ChannelVersionError,
  type ChannelVersionPlan,
  computeChannelVersions,
  computeNightlyAffectedSet,
  type NightlyAffectedSet,
} from "./channel-versions.js";
import { BunCommandRunner } from "./command-runner.js";
import {
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_CONTROL_REF,
  RELEASE_REPOSITORY,
} from "./constants.js";
import {
  type ConsumptionLedger,
  EMPTY_CONSUMPTION_LEDGER,
  loadConsumptionLedger,
} from "./consumption-ledger.js";
import { BunFileSystem } from "./filesystem.js";
import { PackageNameSchema } from "./model.js";
import {
  assertNextProofChain,
  type NextProofChain,
  type NextProofChainInput,
} from "./next-main.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { PackagePolicyValidator } from "./package-policy.js";
import {
  BunPackageCommandRunner,
  BunReleaseCheckout,
  buildReleaseStagingBinding,
  type DependencyRangeOverride,
  type PackagerError,
  type PackageStagingRecord,
  PublicPackagePackager,
} from "./packager.js";
import {
  attachReleasePlanBinding,
  parseReleasePlanArtifact,
  type ReleasePlan,
  type ReleasePlanError,
  serializeReleasePlanArtifact,
  validateReleasePlan,
} from "./release-plan.js";
import { readLocalWorkflowTopology } from "./rollout-gate.js";
import {
  parseReleaseRolloutMode,
  ROLLOUT_STAGE_DECLARATION,
  type RolloutTupleError,
  validateRolloutTuple,
} from "./rollout-stage.js";
import {
  renderScratchChangelog,
  type ScratchChangelogError,
  type ScratchChangesetIdentity,
  type ScratchHistoryEntry,
} from "./scratch-changelog.js";
import {
  computeSelectionClosure,
  type SelectionClosure,
  type SelectionClosureError,
  type SelectionSeed,
  type WorkspaceManifest,
} from "./selection-closure.js";
import { sha256Digest } from "./tar-inspector.js";

/** Nightly has one route: an authorized manual dispatch on protected main. */
export const NIGHTLY_PACKAGE_INPUTS = [
  "cli",
  "opencode",
  "claude-code",
  "pi",
] as const;
export type NightlyPackageInput = (typeof NIGHTLY_PACKAGE_INPUTS)[number];

/** The optional checkboxes are accepted for dispatch compatibility but are not
 * used to select the publish set. The affected-since-nightly computation is
 * the only selection authority. */
export const NightlyInputSchema = z
  .object({
    cli: z.boolean().optional(),
    opencode: z.boolean().optional(),
    claudeCode: z.boolean().optional(),
    pi: z.boolean().optional(),
  })
  .strict();
export type NightlyInput = z.infer<typeof NightlyInputSchema>;

export type NightlyInputError = {
  readonly type: "InvalidNightlyInput";
  readonly issues: readonly string[];
};

export function parseNightlyInput(
  input: unknown,
): Result<NightlyInput, NightlyInputError> {
  const parsed = NightlyInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidNightlyInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

/** Strict route carrier. Schedule support is intentionally added at cutover. */
export const NightlyRouteEventSchema = z
  .object({
    repository: z.literal(RELEASE_REPOSITORY),
    eventName: z.literal("workflow_dispatch"),
    action: z.literal("workflow_dispatch"),
    ref: z.literal(RELEASE_CONTROL_REF),
    actor: z.string().min(1).max(128),
    maintainerAuthorized: z.boolean(),
    channel: z.literal("nightly"),
  })
  .strict();
export type NightlyRouteEvent = z.infer<typeof NightlyRouteEventSchema>;

export type NightlyRouteError =
  | { readonly type: "InvalidNightlyRoute"; readonly issues: readonly string[] }
  | { readonly type: "UnsupportedNightlyEvent"; readonly eventName: string }
  | { readonly type: "WrongNightlyRepository"; readonly repository: string }
  | { readonly type: "WrongNightlyMainLineage"; readonly reason: string }
  | { readonly type: "UnauthorizedNightlyRoute"; readonly actor: string }
  | { readonly type: "UnsupportedNightlyChannel"; readonly channel: string };

export interface ValidatedNightlyRoute extends NightlyRouteEvent {}

/** Validates the event, repository, protected ref, channel, and actor gate. */
export function validateNightlyRouteEvent(
  input: unknown,
): Result<ValidatedNightlyRoute, NightlyRouteError> {
  if (isRecord(input)) {
    if (input.eventName !== "workflow_dispatch")
      return err({
        type: "UnsupportedNightlyEvent",
        eventName: String(input.eventName ?? ""),
      });
    if (input.channel !== "nightly")
      return err({
        type: "UnsupportedNightlyChannel",
        channel: String(input.channel ?? ""),
      });
    if (input.repository !== RELEASE_REPOSITORY)
      return err({
        type: "WrongNightlyRepository",
        repository: String(input.repository ?? ""),
      });
    if (input.ref !== RELEASE_CONTROL_REF)
      return err({
        type: "WrongNightlyMainLineage",
        reason: `nightly route must run on ${RELEASE_CONTROL_REF}`,
      });
  }
  const parsed = NightlyRouteEventSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidNightlyRoute",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  if (!parsed.data.maintainerAuthorized)
    return err({
      type: "UnauthorizedNightlyRoute",
      actor: parsed.data.actor,
    });
  return ok(parsed.data);
}

/** Converts the workflow environment into the strict route carrier. */
export function parseNightlyRouteEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Result<ValidatedNightlyRoute, NightlyRouteError> {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    return err({
      type: "UnsupportedNightlyEvent",
      eventName: env.GITHUB_EVENT_NAME ?? "",
    });
  return validateNightlyRouteEvent({
    repository: env.GITHUB_REPOSITORY ?? "",
    eventName: "workflow_dispatch",
    action: env.GITHUB_EVENT_ACTION ?? "",
    ref: env.GITHUB_REF ?? "",
    actor: env.GITHUB_ACTOR ?? "",
    maintainerAuthorized: env.RELEASE_MAINTAINER_AUTHORIZED === "true",
    channel: env.INPUT_CHANNEL ?? "",
  });
}

export interface NightlyMaintainerAuthorizationPort {
  assertStableRequestAuthorized(
    actor: string,
  ): ResultAsyncType<unknown, unknown>;
}

export type NightlyAuthorizationError =
  | NightlyRouteError
  | { readonly type: "NightlyAuthorizationFailed"; readonly actor: string };

/** Uses the same Task 9 maintainer authorization port as stable and next. */
export function authorizeNightlyRoute(
  input: unknown,
  authorization: NightlyMaintainerAuthorizationPort,
): ResultAsync<ValidatedNightlyRoute, NightlyAuthorizationError> {
  const route = validateNightlyRouteEvent(input);
  if (route.isErr()) return errAsync(route.error);
  const invoked = Result.fromThrowable(
    () => authorization.assertStableRequestAuthorized(route.value.actor),
    () => ({
      type: "NightlyAuthorizationFailed" as const,
      actor: route.value.actor,
    }),
  )();
  if (invoked.isErr()) return errAsync(invoked.error);
  return invoked.value
    .map(() => route.value)
    .mapErr(
      () =>
        ({
          type: "NightlyAuthorizationFailed",
          actor: route.value.actor,
        }) satisfies NightlyAuthorizationError,
    );
}

export type NightlyRolloutError =
  | { readonly type: "RolloutDisabled"; readonly channel: "nightly" }
  | {
      readonly type: "RolloutInvalidState";
      readonly reason: string;
      readonly stage?: string;
      readonly mode?: string;
    }
  | {
      readonly type: "InvalidRolloutTopology";
      readonly issues: readonly string[];
    }
  | { readonly type: "InvalidRolloutMode"; readonly mode: unknown };

export interface NightlyRolloutDecision {
  readonly stage: string;
  readonly mode: "dry-run" | "enabled";
  readonly work: true;
  readonly publish: boolean;
  readonly outcome: "dry-run" | "ready";
}

/** Applies the single rollout tuple. Disabled is an early typed exit. */
export function evaluateNightlyRollout(input: {
  readonly declaration: unknown;
  readonly mode: unknown;
  readonly topology: unknown;
}): Result<NightlyRolloutDecision, NightlyRolloutError> {
  const mode = parseReleaseRolloutMode(input.mode);
  if (mode.isErr())
    return err({ type: "InvalidRolloutMode", mode: input.mode });
  const tuple = validateRolloutTuple(
    input.declaration,
    mode.value,
    input.topology,
  );
  if (tuple.isErr()) return err(mapRolloutError(tuple.error));
  if (mode.value === "disabled")
    return err({ type: "RolloutDisabled", channel: "nightly" });
  return ok({
    stage: tuple.value.stage,
    mode: mode.value,
    work: true,
    publish: mode.value === "enabled" && tuple.value.publicationCapable,
    outcome: mode.value === "enabled" ? "ready" : "dry-run",
  });
}

export interface NightlyWorkspaceManifest extends WorkspaceManifest {
  readonly dependencyRanges?: Readonly<Record<string, string>>;
}

export interface NightlyPlanInput {
  readonly packageVersions: Readonly<Record<PublicPackageName, string>>;
  readonly changesets: readonly ValidatedChangeset[];
  readonly ledger: ConsumptionLedger;
  readonly manifests: readonly NightlyWorkspaceManifest[];
  readonly sourceSha: string;
  readonly now: Date;
  readonly canonicalNotesUrl: string;
  readonly registry?: ChannelRegistry;
  readonly changedPathsSince?: (
    fromSha: string | null,
    toSha: string,
  ) =>
    | readonly string[]
    | Result<readonly string[], unknown>
    | Promise<readonly string[]>
    | ResultAsyncType<readonly string[], unknown>;
  readonly affected?: readonly PublicPackageName[];
  readonly sourceHistory?: readonly ScratchHistoryEntry[];
}

export type NightlyPlanError =
  | { readonly type: "InvalidNightlySourceSha"; readonly sourceSha: string }
  | {
      readonly type: "ConsumedChangesetModified";
      readonly changesets: readonly unknown[];
    }
  | {
      readonly type: "NightlySelectionFailed";
      readonly error: SelectionClosureError;
    }
  | {
      readonly type: "NightlyVersionFailed";
      readonly error: ChannelVersionError;
    }
  | {
      readonly type: "NightlyChangelogFailed";
      readonly error: ScratchChangelogError;
    }
  | { readonly type: "InvalidNightlyPlan"; readonly error: ReleasePlanError };

export const NIGHTLY_METADATA_SCHEMA_VERSION = 1 as const;
const FullShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const ShortShaSchema = z.string().regex(/^[0-9a-f]{12}$/);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RawDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const PathSchema = z.string().min(1).max(1_024);
const ChangesetIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ScratchHistorySchema = z
  .object({
    subject: z.string().min(1).max(512),
    sha: FullShaSchema.optional(),
  })
  .strict();
const NightlyClosureSchema = z
  .object({
    seed: z.array(PackageNameSchema).min(1).max(4),
    selected: z.array(PackageNameSchema).min(1).max(4),
    added: z.array(z.unknown()).max(16),
  })
  .strict();
const NightlyMetadataSchema = z
  .object({
    schemaVersion: z.literal(NIGHTLY_METADATA_SCHEMA_VERSION),
    channel: z.literal("nightly"),
    sourceSha: FullShaSchema,
    sinceSha: z.union([FullShaSchema, ShortShaSchema]).nullable(),
    canonicalNotesUrl: z
      .string()
      .url()
      .max(2_048)
      .refine(
        (value) => value.startsWith("https://"),
        "canonical notes URL must use HTTPS",
      ),
    sourceHistory: z.array(ScratchHistorySchema).max(128),
    changedPaths: z.array(PathSchema).max(4_096),
    affected: z.array(PackageNameSchema).min(1).max(4),
    closure: NightlyClosureSchema,
    pendingChangesets: z
      .array(
        z
          .object({ id: ChangesetIdSchema, sourceDigest: RawDigestSchema })
          .strict(),
      )
      .max(512),
    changelogs: z
      .array(
        z
          .object({
            packageName: PackageNameSchema,
            version: z.string().min(1).max(64),
            content: z
              .string()
              .min(1)
              .max(16 * 1024),
            documentDigest: DigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()
  .superRefine((metadata, context) => {
    for (const [index, changelog] of metadata.changelogs.entries())
      if (sha256Digest(changelog.content) !== changelog.documentDigest)
        context.addIssue({
          code: "custom",
          path: ["changelogs", index, "documentDigest"],
          message: "documentDigest must match content",
        });
  });
export type NightlyReleaseMetadata = z.infer<typeof NightlyMetadataSchema>;

export interface NightlyScratchChangelog {
  readonly packageName: PublicPackageName;
  readonly version: string;
  readonly content: string;
  readonly documentDigest: string;
}

/** Renders fixed, deterministic nightly snapshot notes with no AI input. */
export function renderNightlyScratchChangelogs(input: {
  readonly versions: readonly {
    readonly packageName: PublicPackageName;
    readonly version: string;
  }[];
  readonly sourceSha: string;
  readonly canonicalNotesUrl: string;
  readonly sourceHistory?: readonly ScratchHistoryEntry[];
  readonly pendingChangesets?: readonly ChangesetIdentity[];
}): Result<readonly NightlyScratchChangelog[], ScratchChangelogError> {
  const pending = (input.pendingChangesets ?? []).map(
    (identity): ScratchChangesetIdentity => ({
      id: identity.id,
      sourceDigest: `sha256:${identity.sourceDigest}`,
    }),
  );
  const result: NightlyScratchChangelog[] = [];
  for (const version of input.versions) {
    const content = renderScratchChangelog({
      purpose: "nightly",
      packageName: version.packageName,
      version: version.version,
      sourceSha: input.sourceSha,
      canonicalNotesUrl: input.canonicalNotesUrl,
      sourceHistory: input.sourceHistory,
      pendingChangesets: pending,
    });
    if (content.isErr()) return err(content.error);
    result.push({
      packageName: version.packageName,
      version: version.version,
      content: content.value,
      documentDigest: sha256Digest(content.value),
    });
  }
  return ok(result);
}
export const renderNightlyScratchChangelogSet = renderNightlyScratchChangelogs;

/** Computes exact dependency ranges in the scratch tree only. */
export function computeNightlyDependencyRangeOverrides(
  manifests: readonly NightlyWorkspaceManifest[],
  versions: readonly { packageName: PublicPackageName; version: string }[],
): readonly DependencyRangeOverride[] {
  const selected = new Map(
    versions.map((version) => [version.packageName, version.version]),
  );
  const overrides: DependencyRangeOverride[] = [];
  for (const manifest of manifests) {
    if (!selected.has(manifest.name as PublicPackageName)) continue;
    const ranges: Record<string, string> = {};
    for (const dependency of manifest.dependencies) {
      const version = selected.get(dependency as PublicPackageName);
      if (version !== undefined) ranges[dependency] = version;
    }
    if (Object.keys(ranges).length > 0)
      overrides.push({
        packageName: manifest.name as PublicPackageName,
        dependencies: ranges,
      });
  }
  return overrides;
}

/** The richer projection retained by the nightly metadata carrier. */
interface NightlyComputedPlan extends ChannelVersionPlan {
  readonly changedPaths: readonly string[];
  readonly closure: SelectionClosure;
}

/** Computes the affected-since-nightly closure and its scratch documents. */
export function createNightlyReleasePlan(
  input: NightlyPlanInput,
): ResultAsync<
  { readonly plan: ReleasePlan; readonly metadata: NightlyReleaseMetadata },
  NightlyPlanError
> {
  if (!FullShaSchema.safeParse(input.sourceSha).success)
    return errAsync({
      type: "InvalidNightlySourceSha",
      sourceSha: input.sourceSha,
    });
  const pending = subtractPending(input.changesets, input.ledger);
  if (pending.isErr()) return errAsync(pending.error);
  const pendingChangesets = pending.value;
  const computed = computeNightlyProjection(input, pendingChangesets);
  return computed
    .mapErr(
      (error): NightlyPlanError =>
        isNightlyPlanError(error)
          ? error
          : { type: "NightlyVersionFailed", error },
    )
    .andThen((versionPlan) => {
      const scratch = renderNightlyScratchChangelogs({
        versions: versionPlan.packages,
        sourceSha: input.sourceSha,
        canonicalNotesUrl: input.canonicalNotesUrl,
        sourceHistory: input.sourceHistory,
        pendingChangesets: pendingChangesets.pending.map(
          (entry) => entry.identity,
        ),
      });
      if (scratch.isErr())
        return errAsync<
          {
            readonly plan: ReleasePlan;
            readonly metadata: NightlyReleaseMetadata;
          },
          NightlyPlanError
        >({ type: "NightlyChangelogFailed", error: scratch.error });
      const planCandidate: ReleasePlan = {
        schemaVersion: 1,
        channel: "nightly",
        seed: [...versionPlan.closure.seed],
        closure: releaseClosure(versionPlan.closure),
        consumed: [],
        versions: versionPlan.packages.map((entry) => ({
          packageName: entry.packageName,
          previousVersion: entry.stableVersion,
          version: entry.version,
        })),
        changelogDigests: scratch.value.map((entry) => ({
          packageName: entry.packageName,
          version: entry.version,
          documentDigest: entry.documentDigest,
        })),
        baseSha: input.sourceSha,
        releasedSha: input.sourceSha,
        docsAudit: {
          auditedSha: input.sourceSha,
          deterministicResultDigest: sha256Digest(
            canonicalJson({
              channel: "nightly",
              sourceSha: input.sourceSha,
              selected: versionPlan.closure.selected,
              sourceMutation: "forbidden",
              ai: "not-required",
            }),
          ),
          aiResultDigestOrStatus: "not-required",
        },
        binding: null,
      };
      const plan = validateReleasePlan(planCandidate);
      if (plan.isErr())
        return errAsync<
          {
            readonly plan: ReleasePlan;
            readonly metadata: NightlyReleaseMetadata;
          },
          NightlyPlanError
        >({ type: "InvalidNightlyPlan", error: plan.error });
      const metadata: NightlyReleaseMetadata = {
        schemaVersion: NIGHTLY_METADATA_SCHEMA_VERSION,
        channel: "nightly",
        sourceSha: input.sourceSha,
        sinceSha: versionPlan.sinceSha ?? null,
        canonicalNotesUrl: input.canonicalNotesUrl,
        sourceHistory: [...(input.sourceHistory ?? [])],
        changedPaths: [...versionPlan.changedPaths],
        affected: [...versionPlan.affected],
        closure: {
          seed: [...versionPlan.closure.seed],
          selected: [...versionPlan.closure.selected],
          added: [...versionPlan.closure.added],
        },
        pendingChangesets: pendingChangesets.pending.map((entry) => ({
          id: entry.identity.id,
          sourceDigest: entry.identity.sourceDigest,
        })),
        changelogs: scratch.value.map((entry) => ({ ...entry })),
      };
      return okAsync({ plan: plan.value, metadata });
    });
}

function computeNightlyProjection(
  input: NightlyPlanInput,
  pending: PendingChangesetSet,
): ResultAsync<NightlyComputedPlan, ChannelVersionError | NightlyPlanError> {
  if (input.affected !== undefined) {
    const closure = computeSelectionClosure({
      seed: seedRecord(input.affected),
      changesets: pending.pending,
      manifests: input.manifests,
    });
    if (closure.isErr())
      return errAsync({ type: "NightlySelectionFailed", error: closure.error });
    return computeSelectedNightlyVersions(input, closure.value.selected).map(
      (plan) => ({
        ...plan,
        changedPaths: [],
        closure: closure.value,
      }),
    );
  }
  if (input.registry === undefined || input.changedPathsSince === undefined)
    return errAsync({
      type: "NightlyVersionFailed",
      error: {
        type: "GitDiffFailed",
        fromSha: null,
        toSha: input.sourceSha,
        message: "nightly planning requires a registry and git diff reader",
      },
    });
  return computeNightlyAffectedSet({
    packageVersions: input.packageVersions,
    changesets: input.changesets,
    ledger: input.ledger,
    sourceSha: input.sourceSha,
    registry: input.registry,
    manifests: input.manifests,
    changedPathsSince: input.changedPathsSince,
  }).andThen((affected: NightlyAffectedSet) =>
    computeChannelVersions({
      packageVersions: input.packageVersions,
      changesets: input.changesets,
      ledger: input.ledger,
      channel: "nightly",
      sourceSha: input.sourceSha,
      now: input.now,
      affected: affected.affected,
      registry: input.registry,
    }).map((plan) => ({
      ...plan,
      sinceSha: affected.sinceSha ?? undefined,
      changedPaths: affected.changedPaths,
      closure: affected.closure as SelectionClosure,
    })),
  );
}

export function serializeNightlyMetadata(
  metadata: NightlyReleaseMetadata,
): Result<string, NightlyPlanError> {
  const parsed = NightlyMetadataSchema.safeParse(metadata);
  if (!parsed.success)
    return err({
      type: "InvalidNightlyPlan",
      error: {
        type: "InvalidReleasePlan",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
      },
    });
  return ok(`${canonicalJson(parsed.data)}\n`);
}

export function parseNightlyMetadata(
  input: unknown,
): Result<NightlyReleaseMetadata, NightlyPlanError> {
  const parsed = NightlyMetadataSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidNightlyPlan",
      error: {
        type: "InvalidReleasePlan",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
      },
    });
  return ok(parsed.data);
}

export interface SourceByteSnapshot {
  readonly [path: string]: string | Uint8Array;
}

export type SourceImmutabilityError =
  | { readonly type: "SourceFileAdded"; readonly path: string }
  | { readonly type: "SourceFileRemoved"; readonly path: string }
  | {
      readonly type: "SourceMutationDetected";
      readonly path: string;
      readonly expected: string;
      readonly actual: string;
    };

export function assertNightlySourceFilesUnchanged(input: {
  readonly before:
    | SourceByteSnapshot
    | ReadonlyMap<string, string | Uint8Array>;
  readonly after: SourceByteSnapshot | ReadonlyMap<string, string | Uint8Array>;
}): Result<void, SourceImmutabilityError> {
  const before =
    input.before instanceof Map
      ? new Map(input.before)
      : new Map(Object.entries(input.before));
  const after =
    input.after instanceof Map
      ? new Map(input.after)
      : new Map(Object.entries(input.after));
  for (const path of before.keys())
    if (!after.has(path)) return err({ type: "SourceFileRemoved", path });
  for (const path of after.keys())
    if (!before.has(path)) return err({ type: "SourceFileAdded", path });
  for (const [path, expected] of before) {
    const actual = after.get(path);
    if (actual === undefined) continue;
    const expectedDigest = sha256Digest(expected);
    const actualDigest = sha256Digest(actual);
    if (expectedDigest !== actualDigest)
      return err({
        type: "SourceMutationDetected",
        path,
        expected: expectedDigest,
        actual: actualDigest,
      });
  }
  return ok(undefined);
}
export const assertSourceFilesUnchanged = assertNightlySourceFilesUnchanged;
export const assertSourceImmutability = assertNightlySourceFilesUnchanged;
export const verifySourceImmutability = assertNightlySourceFilesUnchanged;

export interface NightlyStageInput {
  readonly root: string;
  readonly sourceRoot?: string;
  readonly plan: ReleasePlan;
  readonly metadata: NightlyReleaseMetadata;
  readonly manifests?: readonly NightlyWorkspaceManifest[];
  readonly packager?: PublicPackagePackager;
}

export type NightlyStageError =
  | { readonly type: "InvalidNightlyStage"; readonly reason: string }
  | {
      readonly type: "NightlySourceReadFailed";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly type: "NightlySourceMutation";
      readonly error: SourceImmutabilityError;
    }
  | { readonly type: "NightlyPackFailed"; readonly error: PackagerError }
  | { readonly type: "NightlyBindingFailed"; readonly error: PackagerError }
  | {
      readonly type: "NightlyPlanBindingFailed";
      readonly error: ReleasePlanError;
    };

export interface NightlyStageResult {
  readonly plan: ReleasePlan;
  readonly records: readonly PackageStagingRecord[];
  readonly binding: NonNullable<ReleasePlan["binding"]>;
}

/** Packs nightly overrides in a scratch tree and checks source bytes. */
export function stageNightlyPackages(
  input: NightlyStageInput,
): ResultAsync<NightlyStageResult, NightlyStageError> {
  if (input.plan.channel !== "nightly")
    return errAsync({
      type: "InvalidNightlyStage",
      reason: "plan channel is not nightly",
    });
  const mismatch = nightlyMetadataPlanMismatch(input.plan, input.metadata);
  if (mismatch !== undefined)
    return errAsync({ type: "InvalidNightlyStage", reason: mismatch });
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  const packages = input.plan.closure.selected;
  return snapshotNightlySourceFiles(sourceRoot, packages)
    .mapErr((error): NightlyStageError => error)
    .andThen((before) => {
      const packager =
        input.packager ??
        new PublicPackagePackager(
          new BunPackageCommandRunner(),
          new PackagePolicyValidator(),
          undefined,
          { sourceRoot },
        );
      const planned = Object.fromEntries(
        input.plan.versions.map((version) => [
          version.packageName,
          version.version,
        ]),
      );
      const changelogOverrides = Object.fromEntries(
        input.metadata.changelogs.map((entry) => [
          entry.packageName,
          entry.content,
        ]),
      ) as Partial<Record<PublicPackageName, string>>;
      const pendingChangesets = input.metadata.pendingChangesets.map(
        (entry): ScratchChangesetIdentity => ({
          id: entry.id,
          sourceDigest: `sha256:${entry.sourceDigest}`,
        }),
      );
      return packager
        .packAllDetailed(input.root, planned, {
          channel: "nightly",
          packages,
          sourceRoot,
          sourceSha: input.metadata.sourceSha,
          canonicalNotesUrl: input.metadata.canonicalNotesUrl,
          sourceHistory: input.metadata.sourceHistory,
          pendingChangesets,
          changelogOverrides,
          dependencyRangeOverrides: computeNightlyDependencyRangeOverrides(
            input.manifests ?? [],
            input.plan.versions,
          ),
        })
        .mapErr(
          (error): NightlyStageError => ({ type: "NightlyPackFailed", error }),
        )
        .andThen((records) =>
          snapshotNightlySourceFiles(sourceRoot, packages)
            .mapErr((error): NightlyStageError => error)
            .andThen((after) => {
              const unchanged = assertNightlySourceFilesUnchanged({
                before,
                after,
              });
              if (unchanged.isErr())
                return errAsync<NightlyStageResult, NightlyStageError>({
                  type: "NightlySourceMutation",
                  error: unchanged.error,
                });
              const binding = buildReleaseStagingBinding(
                input.plan.releasedSha ?? "",
                records,
              );
              if (binding.isErr())
                return errAsync<NightlyStageResult, NightlyStageError>({
                  type: "NightlyBindingFailed",
                  error: binding.error,
                });
              const bound = attachReleasePlanBinding(input.plan, binding.value);
              if (bound.isErr())
                return errAsync<NightlyStageResult, NightlyStageError>({
                  type: "NightlyPlanBindingFailed",
                  error: bound.error,
                });
              return okAsync({
                plan: bound.value,
                records,
                binding: bound.value.binding as NonNullable<
                  ReleasePlan["binding"]
                >,
              });
            }),
        );
    });
}

export function snapshotNightlySourceFiles(
  sourceRoot: string,
  packages: readonly PublicPackageName[],
): ResultAsync<SourceByteSnapshot, NightlyStageError> {
  const snapshot: Record<string, string | Uint8Array> = {};
  let result = okAsync<void, NightlyStageError>(undefined);
  for (const packageName of packages) {
    const directory = resolve(
      sourceRoot,
      PUBLIC_PACKAGES[packageName].directory,
    );
    for (const filename of ["package.json", "CHANGELOG.md"] as const) {
      const path = join(directory, filename);
      result = result.andThen(() =>
        ResultAsync.fromThrowable(
          () => Bun.file(path).bytes(),
          (cause): NightlyStageError => ({
            type: "NightlySourceReadFailed",
            path,
            reason: String(cause),
          }),
        )().map((bytes) => {
          snapshot[path] = bytes;
          return undefined;
        }),
      );
    }
  }
  return result.map(() => snapshot);
}

export type NightlyProofStage = "attestation" | "consumer" | "harness";
export interface NightlyProofChainInput extends NextProofChainInput {}
export type NightlyProofChain = NextProofChain;
export type NightlyProofError = {
  readonly type: "NightlyProofBlocked";
  readonly stage: NightlyProofStage;
  readonly reason: string;
};

/** Requires exact attestation, every consumer, and min/latest harness proof. */
export function assertNightlyProofChain(
  input: NightlyProofChainInput,
): Result<NightlyProofChain, NightlyProofError> {
  const result = assertNextProofChain(input);
  if (result.isErr())
    return err({
      type: "NightlyProofBlocked",
      stage: result.error.stage,
      reason: result.error.reason,
    });
  return ok(result.value);
}
export const assertNightlyPublishProofs = assertNightlyProofChain;

export const NIGHTLY_PHASES = ["route", "plan", "build"] as const;
export type NightlyPhase = (typeof NIGHTLY_PHASES)[number];

const SafePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[;&|`$<>{}\n\r]/.test(value) &&
      !value.split("/").includes(".."),
    "path must be a bounded safe path",
  );

export interface NightlyMainCliOptions {
  readonly phase: NightlyPhase;
  readonly outputPath?: string;
  readonly metadataPath?: string;
  readonly rootPath?: string;
  readonly planPath?: string;
}

export type NightlyCliError = {
  readonly type: "InvalidNightlyCommand";
  readonly issues: readonly string[];
};

export function parseNightlyMainArgs(
  argv: readonly string[],
): Result<NightlyMainCliOptions, NightlyCliError> {
  const values: Record<string, string> = {};
  const allowed = new Set(["phase", "output", "metadata", "root", "plan"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === undefined || value === undefined || !token.startsWith("--"))
      return err({
        type: "InvalidNightlyCommand",
        issues: ["expected --name value"],
      });
    const key = token.slice(2);
    if (!allowed.has(key))
      return err({
        type: "InvalidNightlyCommand",
        issues: [`unknown option --${key}`],
      });
    if (Object.hasOwn(values, key))
      return err({
        type: "InvalidNightlyCommand",
        issues: [`duplicate option --${key}`],
      });
    if (key !== "phase" && !SafePathSchema.safeParse(value).success)
      return err({
        type: "InvalidNightlyCommand",
        issues: ["path must be a bounded safe path"],
      });
    values[key] = value;
    index += 1;
  }
  const parsed = z
    .object({
      phase: z.enum(NIGHTLY_PHASES),
      outputPath: SafePathSchema.optional(),
      metadataPath: SafePathSchema.optional(),
      rootPath: SafePathSchema.optional(),
      planPath: SafePathSchema.optional(),
    })
    .strict()
    .safeParse({
      phase: values.phase,
      outputPath: values.output,
      metadataPath: values.metadata,
      rootPath: values.root,
      planPath: values.plan,
    });
  if (!parsed.success)
    return err({
      type: "InvalidNightlyCommand",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

export const runNightlyMainCli = parseNightlyMainArgs;

export type NightlyMainError =
  | NightlyCliError
  | NightlyRouteError
  | NightlyAuthorizationError
  | NightlyRolloutError
  | NightlyPlanError
  | NightlyStageError
  | {
      readonly type: "NightlyCarrierError";
      readonly path: string;
      readonly reason: string;
    };

export function runNightlyMain(
  options: NightlyMainCliOptions,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): ResultAsync<unknown, NightlyMainError> {
  switch (options.phase) {
    case "route":
      return runNightlyRoute(env);
    case "plan":
      return runNightlyPlan(options, env);
    case "build":
      return runNightlyBuild(options, env);
  }
}

function runNightlyRoute(
  env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NightlyMainError> {
  const route = parseNightlyRouteEnvironment(env);
  if (route.isErr()) return errAsync(route.error);
  const root = resolve(import.meta.dir, "../..");
  return readLocalWorkflowTopology(root)
    .mapErr(
      (error): NightlyMainError => ({
        type: "InvalidRolloutTopology",
        issues: [error.reason],
      }),
    )
    .andThen((topology) => {
      const rollout = evaluateNightlyRollout({
        declaration: ROLLOUT_STAGE_DECLARATION,
        mode: env.RELEASE_ROLLOUT_MODE ?? "disabled",
        topology,
      });
      let output: {
        readonly channel: "nightly";
        readonly work: boolean;
        readonly publish: boolean;
        readonly releasedSha: string;
        readonly outcome: "RolloutDisabled" | "dry-run" | "ready";
      };
      if (rollout.isErr()) {
        if (rollout.error.type !== "RolloutDisabled")
          return errAsync(rollout.error);
        output = {
          channel: "nightly",
          work: false,
          publish: false,
          releasedSha: env.GITHUB_SHA ?? "",
          outcome: "RolloutDisabled",
        };
      } else {
        output = {
          channel: "nightly",
          work: rollout.value.work,
          publish: rollout.value.publish,
          releasedSha: env.GITHUB_SHA ?? "",
          outcome: rollout.value.outcome,
        };
      }
      return writeOutputs(env.GITHUB_OUTPUT, output)
        .mapErr((error): NightlyMainError => error)
        .andThen(() =>
          writeSummary(
            env.GITHUB_STEP_SUMMARY,
            [
              "## nightly route",
              "",
              "- Channel: nightly",
              "- Selection: affected packages since the last successful nightly, closed over shared changesets and bundled artifacts.",
              "- Changesets: none are consumed or deleted by this channel.",
              `- Rollout: ${output.outcome}`,
              "- Schedule: not active in this task; manual maintainer dispatch only.",
            ].join("\n"),
          ),
        )
        .map(() => output);
    });
}

function runNightlyPlan(
  options: NightlyMainCliOptions,
  env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NightlyMainError> {
  const outputPath = options.outputPath;
  if (outputPath === undefined)
    return errAsync({
      type: "NightlyCarrierError",
      path: "",
      reason: "plan phase requires --output",
    });
  const root = resolve(options.rootPath ?? resolve(import.meta.dir, "../.."));
  const sourceSha = env.NIGHTLY_SOURCE_SHA ?? env.GITHUB_SHA ?? "";
  const now = new Date(env.NIGHTLY_NOW ?? new Date().toISOString());
  if (Number.isNaN(now.valueOf()))
    return errAsync<NightlyMainError, NightlyMainError>({
      type: "NightlyCarrierError",
      path: "NIGHTLY_NOW",
      reason: "nightly planning date is invalid",
    });
  return loadNightlyPlanInput(
    root,
    sourceSha,
    now,
    env.NIGHTLY_CANONICAL_NOTES_URL,
  )
    .andThen((input) =>
      createNightlyReleasePlan(input).mapErr(
        (error): NightlyMainError => error,
      ),
    )
    .orElse((error) => {
      if (
        error.type !== "NightlyVersionFailed" ||
        error.error.type !== "NothingToPublish"
      )
        return errAsync(error);
      const skip = `${canonicalJson({
        schemaVersion: 1,
        channel: "nightly",
        skip: "NothingToPublish",
        sourceSha,
      })}\n`;
      return writeText(outputPath, skip)
        .andThen(() =>
          writeOutputs(env.GITHUB_OUTPUT, {
            "nothing-to-publish": true,
            "source-sha": sourceSha,
          }),
        )
        .andThen(() =>
          writeSummary(
            env.GITHUB_STEP_SUMMARY,
            [
              "## nightly plan",
              "",
              "- NothingToPublish: no public package changed since the last successful nightly.",
              "- No build, attestation, proof, OIDC, registry, or Git ref work is required.",
            ].join("\n"),
          ),
        )
        .map(() => ({ skip: "NothingToPublish", sourceSha }));
    })
    .andThen((value) => {
      if (!("plan" in value)) return okAsync(value);
      const serialized = serializeReleasePlanArtifact(value.plan);
      if (serialized.isErr())
        return errAsync<unknown, NightlyMainError>({
          type: "InvalidNightlyPlan",
          error: serialized.error,
        });
      const metadataPath =
        options.metadataPath ??
        join(dirname(outputPath), "nightly-metadata.json");
      const metadata = serializeNightlyMetadata(value.metadata);
      if (metadata.isErr()) return errAsync(metadata.error);
      return writeText(outputPath, serialized.value)
        .andThen(() => writeText(metadataPath, metadata.value))
        .andThen(() =>
          writeOutputs(env.GITHUB_OUTPUT, {
            "nothing-to-publish": false,
            "source-sha": sourceSha,
            "affected-count": value.plan.closure.selected.length,
          }),
        )
        .andThen(() =>
          writeSummary(
            env.GITHUB_STEP_SUMMARY,
            [
              "## nightly plan",
              "",
              explainNightlyClosure(value.plan.closure),
              "",
              "- Versions and changelogs are staging-only; no changeset is consumed.",
              "- AI prose is not used for nightly scratch changelogs.",
            ].join("\n"),
          ),
        )
        .map(() => ({ ...value, planPath: outputPath, metadataPath }));
    });
}

function runNightlyBuild(
  options: NightlyMainCliOptions,
  _env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NightlyMainError> {
  const planPath = options.planPath;
  const outputPath = options.outputPath ?? planPath;
  const metadataPath = options.metadataPath;
  if (
    planPath === undefined ||
    outputPath === undefined ||
    metadataPath === undefined
  )
    return errAsync({
      type: "NightlyCarrierError",
      path: planPath ?? "",
      reason: "build phase requires --plan, --metadata, and --output",
    });
  return readText(planPath)
    .andThen((text) =>
      parseReleasePlanArtifact(text).mapErr(
        (error): NightlyMainError => ({ type: "InvalidNightlyPlan", error }),
      ),
    )
    .andThen((artifact) =>
      readText(metadataPath).andThen((metadataText) => {
        const decoded = Result.fromThrowable(
          () => JSON.parse(metadataText) as unknown,
          (cause): NightlyMainError => ({
            type: "NightlyCarrierError",
            path: metadataPath,
            reason: String(cause),
          }),
        )();
        if (decoded.isErr()) return errAsync(decoded.error);
        const metadata = parseNightlyMetadata(decoded.value);
        if (metadata.isErr()) return errAsync(metadata.error);
        const sourceRoot = resolve(process.cwd());
        return new BunReleaseCheckout()
          .head(sourceRoot)
          .mapErr(
            (error): NightlyMainError => ({
              type: "NightlyCarrierError",
              path: sourceRoot,
              reason: `source checkout: ${error.type}`,
            }),
          )
          .andThen((head) => {
            if (head !== metadata.value.sourceSha)
              return errAsync<unknown, NightlyMainError>({
                type: "NightlyCarrierError",
                path: sourceRoot,
                reason: `source checkout ${head} does not match planned SHA ${metadata.value.sourceSha}`,
              });
            return loadNightlyWorkspaceManifests(sourceRoot).andThen(
              (manifests) =>
                stageNightlyPackages({
                  root: resolve(options.rootPath ?? dirname(outputPath)),
                  sourceRoot,
                  manifests,
                  plan: artifact.plan,
                  metadata: metadata.value,
                }).andThen((staged) => {
                  const serialized = serializeReleasePlanArtifact(staged.plan);
                  if (serialized.isErr())
                    return errAsync<unknown, NightlyMainError>({
                      type: "InvalidNightlyPlan",
                      error: serialized.error,
                    });
                  const root = resolve(options.rootPath ?? dirname(outputPath));
                  const artifacts = join(root, "artifacts");
                  return copyNightlyArtifacts(staged.records, artifacts)
                    .andThen(() => writeText(outputPath, serialized.value))
                    .andThen(() =>
                      writeText(
                        join(root, "tarball-digests.json"),
                        `${canonicalJson(
                          staged.binding.tarballs.map((entry) => ({
                            packageName: entry.packageName,
                            sha256: entry.sha256,
                          })),
                        )}\n`,
                      ),
                    )
                    .map(() => ({
                      plan: staged.plan,
                      binding: staged.binding,
                      sourceMutated: false,
                    }));
                }),
            );
          });
      }),
    );
}

function loadNightlyPlanInput(
  root: string,
  sourceSha: string,
  now: Date,
  canonicalNotesUrl: string | undefined,
): ResultAsync<NightlyPlanInput, NightlyMainError> {
  let versions = okAsync<
    Partial<Record<PublicPackageName, string>>,
    NightlyMainError
  >({});
  for (const packageName of Object.keys(PUBLIC_PACKAGES) as PublicPackageName[])
    versions = versions.andThen((found) =>
      readJsonRecord(
        join(root, PUBLIC_PACKAGES[packageName].directory, "package.json"),
      ).andThen((manifest) => {
        const version = manifest.version;
        if (typeof version !== "string")
          return errAsync({
            type: "NightlyCarrierError" as const,
            path: packageName,
            reason: "public manifest has no version",
          });
        return okAsync({ ...found, [packageName]: version });
      }),
    );
  const changesets = new ChangesetPolicyValidator(new BunChangesetFileSystem())
    .validateDirectory(join(root, ".changeset"))
    .mapErr(
      (errors): NightlyMainError => ({
        type: "NightlyCarrierError",
        path: join(root, ".changeset"),
        reason: errors.map(describeChangesetError).join("; "),
      }),
    );
  const ledger = loadConsumptionLedger(new BunFileSystem(), root).mapErr(
    (error): NightlyMainError => ({
      type: "NightlyCarrierError",
      path: root,
      reason: error.type,
    }),
  );
  return versions.andThen((partialVersions) => {
    const packageVersions = {} as Record<PublicPackageName, string>;
    for (const packageName of Object.keys(
      PUBLIC_PACKAGES,
    ) as PublicPackageName[]) {
      const version = partialVersions[packageName];
      if (version === undefined)
        return errAsync<NightlyPlanInput, NightlyMainError>({
          type: "NightlyCarrierError",
          path: packageName,
          reason: "public manifest has no version",
        });
      packageVersions[packageName] = version;
    }
    return changesets.andThen((validated) =>
      ledger.andThen((consumption) =>
        loadNightlyWorkspaceManifests(root).andThen((manifests) =>
          readNightlySourceHistory(root, sourceSha).map((sourceHistory) => ({
            packageVersions,
            changesets: validated,
            ledger: consumption,
            manifests,
            sourceSha,
            now,
            canonicalNotesUrl:
              canonicalNotesUrl ?? "https://github.com/weave-io/weave/releases",
            registry: new NpmCliRegistryClient(new BunCommandRunner()),
            changedPathsSince: (fromSha: string | null, toSha: string) =>
              readNightlyChangedPaths(root, fromSha, toSha),
            sourceHistory,
          })),
        ),
      ),
    );
  });
}

function loadNightlyWorkspaceManifests(
  root: string,
): ResultAsync<readonly NightlyWorkspaceManifest[], NightlyMainError> {
  const directories: readonly [string, string][] = [
    ...(
      Object.entries(PUBLIC_PACKAGES) as [
        PublicPackageName,
        { directory: string },
      ][]
    ).map(([name, metadata]): [string, string] => [name, metadata.directory]),
    ...Object.entries(PRIVATE_SOURCE_DIRECTORIES).map(
      ([name, directory]): [string, string] => [name, directory],
    ),
  ];
  let result = okAsync<readonly NightlyWorkspaceManifest[], NightlyMainError>(
    [],
  );
  for (const [name, directory] of directories)
    result = result.andThen((manifests) =>
      readJsonRecord(join(root, directory, "package.json")).map((manifest) => [
        ...manifests,
        {
          name,
          dependencies: workspaceDependencies(manifest),
          dependencyRanges: workspaceDependencyRanges(manifest),
        },
      ]),
    );
  return result;
}

function workspaceDependencies(
  manifest: Record<string, unknown>,
): readonly string[] {
  return Object.keys(workspaceDependencyRanges(manifest));
}

function workspaceDependencyRanges(
  manifest: Record<string, unknown>,
): Readonly<Record<string, string>> {
  const ranges: Record<string, string> = {};
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const values = manifest[field];
    if (!isRecord(values)) continue;
    for (const [name, range] of Object.entries(values))
      if (typeof range === "string") ranges[name] = range;
  }
  return ranges;
}

function readNightlySourceHistory(
  root: string,
  sourceSha: string,
): ResultAsync<readonly ScratchHistoryEntry[], NightlyMainError> {
  return ResultAsync.fromThrowable(
    async () => {
      const command = Bun.spawn(
        ["git", "-C", root, "log", "--format=%H%x09%s", "-n32", sourceSha],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
      ]);
      if (exitCode !== 0)
        throw new Error(stderr.trim() || `git log exited with ${exitCode}`);
      const entries: ScratchHistoryEntry[] = [];
      for (const line of stdout.split("\n")) {
        if (line.length === 0) continue;
        const separator = line.indexOf("\t");
        if (separator <= 0)
          throw new Error("git log returned malformed history");
        const sha = line.slice(0, separator);
        const subject = line.slice(separator + 1);
        if (!FullShaSchema.safeParse(sha).success || subject.length === 0)
          throw new Error("git log returned invalid source history");
        entries.push({ sha, subject });
      }
      return entries;
    },
    (cause): NightlyMainError => ({
      type: "NightlyCarrierError",
      path: root,
      reason: `source history: ${String(cause)}`,
    }),
  )();
}

function readNightlyChangedPaths(
  root: string,
  fromSha: string | null,
  toSha: string,
): ResultAsync<readonly string[], unknown> {
  return ResultAsync.fromThrowable(
    async () => {
      const command = fromSha
        ? Bun.spawn(
            ["git", "-C", root, "diff", "--name-only", fromSha, toSha],
            {
              stdout: "pipe",
              stderr: "pipe",
            },
          )
        : Bun.spawn(["git", "-C", root, "ls-files"], {
            stdout: "pipe",
            stderr: "pipe",
          });
      const [exitCode, stdout, stderr] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
      ]);
      if (exitCode !== 0)
        throw new Error(stderr.trim() || `git diff exited with ${exitCode}`);
      return stdout.split("\n").filter((path) => path.length > 0);
    },
    (cause) => cause,
  )();
}

function readJsonRecord(
  path: string,
): ResultAsync<Record<string, unknown>, NightlyMainError> {
  return ResultAsync.fromThrowable(
    async () => JSON.parse(await Bun.file(path).text()) as unknown,
    (cause): NightlyMainError => ({
      type: "NightlyCarrierError",
      path,
      reason: String(cause),
    }),
  )().andThen((value) =>
    isRecord(value)
      ? okAsync(value)
      : errAsync({
          type: "NightlyCarrierError" as const,
          path,
          reason: "JSON carrier must be an object",
        }),
  );
}

function copyNightlyArtifacts(
  records: readonly PackageStagingRecord[],
  artifacts: string,
): ResultAsync<void, NightlyMainError> {
  return ResultAsync.fromThrowable(
    async () => {
      await Bun.write(join(artifacts, ".keep"), "");
      for (const record of records) {
        const bytes = await Bun.file(record.tarballPath).bytes();
        await Bun.write(
          join(
            artifacts,
            record.tarballPath.split("/").pop() ?? "artifact.tgz",
          ),
          bytes,
        );
      }
    },
    (cause): NightlyMainError => ({
      type: "NightlyCarrierError",
      path: artifacts,
      reason: String(cause),
    }),
  )();
}

function readText(path: string): ResultAsync<string, NightlyMainError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).text(),
    (cause): NightlyMainError => ({
      type: "NightlyCarrierError",
      path,
      reason: String(cause),
    }),
  )();
}

function writeText(
  path: string | undefined,
  contents: string,
): ResultAsync<void, NightlyMainError> {
  if (path === undefined) return okAsync(undefined);
  return ResultAsync.fromThrowable(
    () => Bun.write(path, contents).then(() => undefined),
    (cause): NightlyMainError => ({
      type: "NightlyCarrierError",
      path,
      reason: String(cause),
    }),
  )();
}

function writeOutputs(
  path: string | undefined,
  values: Readonly<Record<string, string | number | boolean>>,
): ResultAsync<void, NightlyMainError> {
  if (path === undefined) return okAsync(undefined);
  return writeText(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("\n")}\n`,
  );
}

function writeSummary(
  path: string | undefined,
  contents: string,
): ResultAsync<void, NightlyMainError> {
  return path === undefined
    ? okAsync(undefined)
    : writeText(path, `${contents}\n`);
}

function nightlyMetadataPlanMismatch(
  plan: ReleasePlan,
  metadata: NightlyReleaseMetadata,
): string | undefined {
  if (plan.channel !== "nightly") return "plan channel is not nightly";
  if (plan.releasedSha !== metadata.sourceSha)
    return "plan and metadata source SHA differ";
  if (
    plan.closure.selected.length !== metadata.affected.length ||
    plan.closure.selected.some(
      (packageName, index) => packageName !== metadata.affected[index],
    ) ||
    plan.closure.selected.length !== metadata.closure.selected.length ||
    plan.closure.selected.some(
      (packageName, index) => packageName !== metadata.closure.selected[index],
    ) ||
    plan.seed.length !== metadata.closure.seed.length ||
    plan.seed.some(
      (packageName, index) => packageName !== metadata.closure.seed[index],
    ) ||
    canonicalJson(plan.closure.added) !== canonicalJson(metadata.closure.added)
  )
    return "metadata affected set differs from the plan closure";
  if (plan.changelogDigests.length !== metadata.changelogs.length)
    return "plan and metadata changelog sets differ";
  const byPackage = new Map(
    metadata.changelogs.map((entry) => [entry.packageName, entry]),
  );
  for (const expected of plan.changelogDigests) {
    const actual = byPackage.get(expected.packageName);
    if (actual === undefined)
      return `metadata is missing the ${expected.packageName} changelog`;
    if (actual.version !== expected.version)
      return `metadata version differs for ${expected.packageName}`;
    if (actual.documentDigest !== expected.documentDigest)
      return `metadata digest differs for ${expected.packageName}`;
  }
  return undefined;
}

function subtractPending(
  changesets: readonly ValidatedChangeset[],
  ledger: ConsumptionLedger,
): Result<PendingChangesetSet, NightlyPlanError> {
  const pending = subtractConsumedLedger({ changesets, ledger });
  if (pending.modified.length > 0)
    return err({
      type: "ConsumedChangesetModified",
      changesets: pending.modified,
    });
  return ok(pending);
}

function computeSelectedNightlyVersions(
  input: NightlyPlanInput,
  affected: readonly PublicPackageName[],
): ResultAsync<
  import("./channel-versions.js").ChannelVersionPlan,
  ChannelVersionError
> {
  return computeChannelVersions({
    packageVersions: input.packageVersions,
    changesets: input.changesets,
    ledger: input.ledger,
    channel: "nightly",
    sourceSha: input.sourceSha,
    now: input.now,
    affected,
    registry: input.registry,
  });
}

function releaseClosure(closure: SelectionClosure): ReleasePlan["closure"] {
  return {
    seed: [...closure.seed],
    selected: [...closure.selected],
    added: closure.added.map((addition) =>
      addition.reason.kind === "shared-changeset"
        ? {
            package: addition.package,
            reason: {
              kind: "shared-changeset" as const,
              evidence: {
                ...addition.reason.evidence,
                members: [...addition.reason.evidence.members],
              },
            },
          }
        : {
            package: addition.package,
            reason: {
              kind: "artifact-dependency" as const,
              evidence: {
                ...addition.reason.evidence,
                dependencyPath: [...addition.reason.evidence.dependencyPath],
              },
            },
          },
    ),
  };
}

function seedRecord(packages: readonly PublicPackageName[]): SelectionSeed {
  const selected = new Set(packages);
  return {
    "@weaveio/weave-cli": selected.has("@weaveio/weave-cli"),
    "@weaveio/weave-adapter-opencode": selected.has(
      "@weaveio/weave-adapter-opencode",
    ),
    "@weaveio/weave-adapter-claude-code": selected.has(
      "@weaveio/weave-adapter-claude-code",
    ),
    "@weaveio/weave-adapter-pi": selected.has("@weaveio/weave-adapter-pi"),
  };
}

export function explainNightlyClosure(closure: SelectionClosure): string {
  const additions =
    closure.added.length === 0
      ? "none"
      : closure.added
          .map((addition) => {
            const evidence = addition.reason.evidence;
            return `${addition.package} (${addition.reason.kind}; changeset ${evidence.changesetId})`;
          })
          .join(", ");
  return [
    `Affected packages: ${closure.seed.join(", ")}.`,
    `Closed publish set: ${closure.selected.join(", ")}.`,
    `Forced additions: ${additions}.`,
    "The set is based on changes since the last nightly and is closed over shared changesets and bundled-artifact impacts.",
  ].join("\n");
}

function isNightlyPlanError(value: unknown): value is NightlyPlanError {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    (value.type === "ConsumedChangesetModified" ||
      value.type === "NightlySelectionFailed" ||
      value.type === "NightlyVersionFailed" ||
      value.type === "NightlyChangelogFailed" ||
      value.type === "InvalidNightlyPlan")
  );
}

function mapRolloutError(error: RolloutTupleError): NightlyRolloutError {
  if (error.type === "InvalidRolloutMode")
    return { type: "InvalidRolloutMode", mode: error.mode };
  if (error.type === "InvalidWorkflowTopology")
    return { type: "InvalidRolloutTopology", issues: error.issues };
  if (error.type === "InvalidRolloutStageDeclaration")
    return { type: "RolloutInvalidState", reason: error.issues.join("; ") };
  return {
    type: "RolloutInvalidState",
    reason: error.reason,
    stage: error.stage,
    mode: error.mode,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeChangesetError(error: ChangesetPolicyError): string {
  return error.type;
}

if (import.meta.main) {
  const parsed = parseNightlyMainArgs(Bun.argv.slice(2));
  if (parsed.isErr()) process.exitCode = 2;
  else {
    const result = await runNightlyMain(parsed.value, Bun.env);
    process.exitCode = result.isErr() ? 1 : 0;
  }
}

export type { AdapterPackageName };
export { ADAPTER_PACKAGE_NAMES, EMPTY_CONSUMPTION_LEDGER };
