/**
 * The guarded `next` prerelease controller.
 *
 * `next` is a read-only projection of current green `main`. It closes the
 * maintainer's four-package seed over the same changeset and bundled-artifact
 * rules as stable, computes a date/SHA prerelease, and hands Task 10 a scratch
 * tree. The source checkout is never edited and no changeset is consumed.
 *
 * The workflow adapter is intentionally thin. The pure functions in this
 * module are also the proof boundary used by tests and by the protected build
 * and prerelease jobs.
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
import {
  ADAPTER_HOST_MATRICES,
  requiredHostSlots,
} from "./acceptance-manifest.js";
import { canonicalJson } from "./chain-step-support.js";
import {
  type AdapterPackageName,
  resolveNextChangedAdapters,
} from "./changed-adapters.js";
import { subtractConsumedLedger } from "./changeset-consumption.js";
import {
  BunChangesetFileSystem,
  type ChangesetIdentity,
  type ChangesetPolicyError,
  ChangesetPolicyValidator,
  PRIVATE_SOURCE_DIRECTORIES,
  type ValidatedChangeset,
} from "./changeset-policy.js";
import {
  type ChannelPackageVersion,
  type ChannelVersionError,
  computeChannelVersions,
} from "./channel-versions.js";
import {
  PRIVATE_PACKAGE_NAMES,
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_CONTROL_REF,
  RELEASE_REPOSITORY,
} from "./constants.js";
import {
  assertConsumerProofDigest,
  type ConsumerProof,
  type ConsumerProofError,
  validateConsumerProof,
} from "./consumer-proof-main.js";
import {
  type ConsumptionLedger,
  EMPTY_CONSUMPTION_LEDGER,
  loadConsumptionLedger,
} from "./consumption-ledger.js";
import { BunFileSystem } from "./filesystem.js";
import {
  assertHarnessProofDigest,
  type HarnessProofMainError,
  type HarnessProofRecord,
  validateHarnessProof,
} from "./harness-proof-main.js";
import { PackageNameSchema, SemVerSchema } from "./model.js";
import {
  composeReleaseNotes,
  type NotesWrapperError,
  releaseTagName,
} from "./notes-wrapper.js";
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
  type AttestationCheckResult,
  type AttestationExpectation,
  type AttestationGateError,
  verifyAttestationResult,
} from "./publish-chain.js";
import type {
  PublicationError,
  PublicationMember,
  PublicationReport,
} from "./publish-executor.js";
import {
  attachReleasePlanBinding,
  parseReleasePlanArtifact,
  type ReleasePlan,
  type ReleasePlanError,
  serializeReleasePlanArtifact,
  validateReleasePlan,
} from "./release-plan.js";
import type {
  ReleasePackageVersion,
  ReleaseRefsError,
  ReleaseRefsGitHub,
  ReleaseRefsInput,
  ReleaseRefsResult,
} from "./release-refs.js";
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

/** The exact four `workflow_dispatch` checkboxes for `channel: next`. */
export const NEXT_PACKAGE_INPUTS = [
  "cli",
  "opencode",
  "claude-code",
  "pi",
] as const;
export type NextPackageInput = (typeof NEXT_PACKAGE_INPUTS)[number];

const NEXT_SOURCE_HISTORY_LIMIT = 32;

const NEXT_PACKAGE_NAMES: Readonly<
  Record<NextPackageInput, PublicPackageName>
> = {
  cli: "@weaveio/weave-cli",
  opencode: "@weaveio/weave-adapter-opencode",
  "claude-code": "@weaveio/weave-adapter-claude-code",
  pi: "@weaveio/weave-adapter-pi",
};

/** Strict schema: no thinking/model or hidden fifth checkbox is accepted. */
export const NextInputSchema = z
  .object({
    cli: z.boolean(),
    opencode: z.boolean(),
    claudeCode: z.boolean(),
    pi: z.boolean(),
  })
  .strict();
export type NextInput = z.infer<typeof NextInputSchema>;

export type NextInputError =
  | { readonly type: "InvalidNextInput"; readonly issues: readonly string[] }
  | { readonly type: "EmptySelection" };

/** Parses the four checkboxes without coercing arbitrary strings. */
export function parseNextInput(
  input: unknown,
): Result<NextInput, NextInputError> {
  const parsed = NextInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidNextInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
      ),
    });
  return selectNextPackages(parsed.data).map(() => parsed.data);
}

/** Converts GitHub's boolean environment values at the one input boundary. */
export function parseNextEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Result<NextInput, NextInputError> {
  const booleanInput = (name: string): boolean | undefined => {
    const value = env[name];
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  };
  return parseNextInput({
    cli: booleanInput("INPUT_CLI"),
    opencode: booleanInput("INPUT_OPENCODE"),
    claudeCode: booleanInput("INPUT_CLAUDE_CODE"),
    pi: booleanInput("INPUT_PI"),
  });
}

/** Selected public packages in the canonical catalog order. */
export function selectNextPackages(
  input: NextInput,
): Result<readonly PublicPackageName[], NextInputError> {
  const selected = NEXT_PACKAGE_INPUTS.filter((name) => {
    if (name === "claude-code") return input.claudeCode;
    return input[name];
  }).map((name) => NEXT_PACKAGE_NAMES[name]);
  if (selected.length === 0) return err({ type: "EmptySelection" });
  return ok(selected);
}

/** Turns the selected package list into Task 5's exact boolean seed. */
export function nextSelectionSeed(
  selected: readonly PublicPackageName[],
): SelectionSeed {
  const chosen = new Set(selected);
  return {
    "@weaveio/weave-cli": chosen.has("@weaveio/weave-cli"),
    "@weaveio/weave-adapter-opencode": chosen.has(
      "@weaveio/weave-adapter-opencode",
    ),
    "@weaveio/weave-adapter-claude-code": chosen.has(
      "@weaveio/weave-adapter-claude-code",
    ),
    "@weaveio/weave-adapter-pi": chosen.has("@weaveio/weave-adapter-pi"),
  };
}

/** Human-readable, deterministic closure evidence for the workflow summary. */
export function explainNextClosure(closure: SelectionClosure): string {
  const seed = closure.seed.join(", ");
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
    `Seed packages: ${seed}.`,
    `Closed publish set: ${closure.selected.join(", ")}.`,
    `Forced additions: ${additions}.`,
    "The closure is computed from shared changesets and bundled-artifact impacts; no changeset is consumed by next.",
  ].join("\n");
}

/** The strict manual-dispatch event carrier. */
export const NextRouteEventSchema = z
  .object({
    repository: z.literal(RELEASE_REPOSITORY),
    eventName: z.literal("workflow_dispatch"),
    action: z.literal("workflow_dispatch"),
    ref: z.literal(RELEASE_CONTROL_REF),
    actor: z.string().min(1).max(128),
    maintainerAuthorized: z.boolean(),
    channel: z.literal("next"),
    selection: NextInputSchema,
  })
  .strict();
export type NextRouteEvent = z.infer<typeof NextRouteEventSchema>;

export interface ValidatedNextRoute extends NextRouteEvent {
  readonly selected: readonly PublicPackageName[];
}

export type NextRouteError =
  | { readonly type: "InvalidNextRoute"; readonly issues: readonly string[] }
  | { readonly type: "UnsupportedNextEvent"; readonly eventName: string }
  | { readonly type: "WrongNextRepository"; readonly repository: string }
  | { readonly type: "WrongNextMainLineage"; readonly reason: string }
  | { readonly type: "UnauthorizedNextRoute"; readonly actor: string }
  | { readonly type: "UnsupportedNextChannel"; readonly channel: string }
  | NextInputError;

/** Validates event, ref, channel, and maintainer authorization before work. */
export function validateNextRouteEvent(
  input: unknown,
): Result<ValidatedNextRoute, NextRouteError> {
  if (isRecord(input)) {
    if (input.eventName !== "workflow_dispatch")
      return err({
        type: "UnsupportedNextEvent",
        eventName: String(input.eventName ?? ""),
      });
    if (input.channel !== "next")
      return err({
        type: "UnsupportedNextChannel",
        channel: String(input.channel ?? ""),
      });
    if (input.repository !== RELEASE_REPOSITORY)
      return err({
        type: "WrongNextRepository",
        repository: String(input.repository ?? ""),
      });
    if (input.ref !== RELEASE_CONTROL_REF)
      return err({
        type: "WrongNextMainLineage",
        reason: `next route must run on ${RELEASE_CONTROL_REF}`,
      });
  }
  const parsed = NextRouteEventSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidNextRoute",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  if (!parsed.data.maintainerAuthorized)
    return err({
      type: "UnauthorizedNextRoute",
      actor: parsed.data.actor,
    });
  return selectNextPackages(parsed.data.selection).map((packages) => ({
    ...parsed.data,
    selected: packages,
  }));
}

/** Parses the route job's environment without accepting event fallbacks. */
export function parseNextRouteEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Result<ValidatedNextRoute, NextRouteError> {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    return err({
      type: "UnsupportedNextEvent",
      eventName: env.GITHUB_EVENT_NAME ?? "",
    });
  const selection = parseNextEnvironment(env);
  if (selection.isErr()) return err(selection.error);
  return validateNextRouteEvent({
    repository: env.GITHUB_REPOSITORY ?? "",
    eventName: "workflow_dispatch",
    action: env.GITHUB_EVENT_ACTION ?? "",
    ref: env.GITHUB_REF ?? "",
    actor: env.GITHUB_ACTOR ?? "",
    maintainerAuthorized: env.RELEASE_MAINTAINER_AUTHORIZED === "true",
    channel: env.INPUT_CHANNEL ?? "",
    selection: selection.value,
  });
}

/** Authorization port shared with Task 9's stable request helper. */
export interface NextMaintainerAuthorizationPort {
  assertStableRequestAuthorized(
    actor: string,
  ): ResultAsyncType<unknown, unknown>;
}

export type NextAuthorizationError =
  | NextRouteError
  | { readonly type: "NextAuthorizationFailed"; readonly actor: string };

/** Runs the Task 9 authorization helper after local event validation. */
export function authorizeNextRoute(
  input: unknown,
  authorization: NextMaintainerAuthorizationPort,
): ResultAsync<ValidatedNextRoute, NextAuthorizationError> {
  const route = validateNextRouteEvent(input);
  if (route.isErr()) return errAsync(route.error);
  const invoked = Result.fromThrowable(
    () => authorization.assertStableRequestAuthorized(route.value.actor),
    () => ({
      type: "NextAuthorizationFailed" as const,
      actor: route.value.actor,
    }),
  )();
  if (invoked.isErr()) return errAsync(invoked.error);
  return invoked.value
    .map(() => route.value)
    .mapErr(
      () =>
        ({
          type: "NextAuthorizationFailed",
          actor: route.value.actor,
        }) satisfies NextAuthorizationError,
    );
}

export type NextRolloutError =
  | { readonly type: "RolloutDisabled"; readonly channel: "next" }
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

export interface NextRolloutDecision {
  readonly stage: string;
  readonly mode: "dry-run" | "enabled";
  readonly work: true;
  readonly publish: boolean;
  readonly outcome: "dry-run" | "ready";
}

/** Applies the same checked-in rollout tuple to a next dispatch. */
export function evaluateNextRollout(input: {
  readonly declaration: unknown;
  readonly mode: unknown;
  readonly topology: unknown;
}): Result<NextRolloutDecision, NextRolloutError> {
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
    return err({ type: "RolloutDisabled", channel: "next" });
  return ok({
    stage: tuple.value.stage,
    mode: mode.value,
    work: true,
    publish: mode.value === "enabled" && tuple.value.publicationCapable,
    outcome: mode.value === "enabled" ? "ready" : "dry-run",
  });
}

/** Workspace data used to update only staged dependency ranges. */
export interface NextWorkspaceManifest extends WorkspaceManifest {
  readonly dependencyRanges?: Readonly<Record<string, string>>;
}

export interface NextPlanInput {
  readonly selection: NextInput | SelectionSeed;
  readonly packageVersions: Readonly<Record<PublicPackageName, string>>;
  readonly changesets: readonly ValidatedChangeset[];
  readonly ledger: ConsumptionLedger;
  readonly manifests: readonly NextWorkspaceManifest[];
  readonly sourceSha: string;
  readonly now: Date;
  readonly canonicalNotesUrl: string;
  readonly sourceHistory?: readonly ScratchHistoryEntry[];
  readonly registry?: Parameters<typeof computeChannelVersions>[0]["registry"];
}

export type NextPlanError =
  | NextInputError
  | { readonly type: "InvalidNextSourceSha"; readonly sourceSha: string }
  | {
      readonly type: "ConsumedChangesetModified";
      readonly changesets: readonly unknown[];
    }
  | {
      readonly type: "NextSelectionFailed";
      readonly error: SelectionClosureError;
    }
  | { readonly type: "NextVersionFailed"; readonly error: ChannelVersionError }
  | {
      readonly type: "NextChangelogFailed";
      readonly error: ScratchChangelogError;
    }
  | { readonly type: "InvalidNextPlan"; readonly error: ReleasePlanError };

/** Pending identities and scratch documents carried between workflow jobs. */
export const NEXT_METADATA_SCHEMA_VERSION = 1 as const;
const FullShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RawDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ChangesetIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ScratchHistorySchema = z
  .object({
    subject: z.string().min(1).max(512),
    sha: FullShaSchema.optional(),
  })
  .strict();
const NextMetadataSchema = z
  .object({
    schemaVersion: z.literal(NEXT_METADATA_SCHEMA_VERSION),
    channel: z.literal("next"),
    sourceSha: FullShaSchema,
    canonicalNotesUrl: z
      .string()
      .url()
      .max(2_048)
      .refine(
        (value) => value.startsWith("https://"),
        "canonical notes URL must use HTTPS",
      ),
    sourceHistory: z.array(ScratchHistorySchema).max(128),
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
    for (const [index, changelog] of metadata.changelogs.entries()) {
      if (sha256Digest(changelog.content) !== changelog.documentDigest)
        context.addIssue({
          code: "custom",
          path: ["changelogs", index, "documentDigest"],
          message: "documentDigest must match content",
        });
    }
  });
export type NextReleaseMetadata = z.infer<typeof NextMetadataSchema>;

export interface NextScratchChangelog {
  readonly packageName: PublicPackageName;
  readonly version: string;
  readonly content: string;
  readonly documentDigest: string;
}

/** Renders one deterministic scratch document per closed package set. */
export function renderNextScratchChangelogs(input: {
  readonly versions: readonly {
    readonly packageName: PublicPackageName;
    readonly version: string;
  }[];
  readonly sourceSha: string;
  readonly canonicalNotesUrl: string;
  readonly sourceHistory?: readonly ScratchHistoryEntry[];
  readonly pendingChangesets?: readonly ChangesetIdentity[];
}): Result<readonly NextScratchChangelog[], ScratchChangelogError> {
  const pending = (input.pendingChangesets ?? []).map(
    (identity): ScratchChangesetIdentity => ({
      id: identity.id,
      sourceDigest: `sha256:${identity.sourceDigest}`,
    }),
  );
  const rendered: NextScratchChangelog[] = [];
  for (const version of input.versions) {
    const content = renderScratchChangelog({
      purpose: "next",
      packageName: version.packageName,
      version: version.version,
      sourceSha: input.sourceSha,
      canonicalNotesUrl: input.canonicalNotesUrl,
      sourceHistory: input.sourceHistory,
      pendingChangesets: pending,
    });
    if (content.isErr()) return err(content.error);
    rendered.push({
      packageName: version.packageName,
      version: version.version,
      content: content.value,
      documentDigest: sha256Digest(content.value),
    });
  }
  return ok(rendered);
}

/** Alias used by build adapters that call the file a scratch changelog set. */
export const renderNextScratchChangelogSet = renderNextScratchChangelogs;

/** Computes exact staged dependency ranges for selected prerelease packages. */
export function computeNextDependencyRangeOverrides(
  manifests: readonly NextWorkspaceManifest[],
  versions: readonly { packageName: PublicPackageName; version: string }[],
): readonly DependencyRangeOverride[] {
  const selected = new Map(
    versions.map((version) => [version.packageName, version.version]),
  );
  const overrides: DependencyRangeOverride[] = [];
  for (const manifest of manifests) {
    if (!selected.has(manifest.name as PublicPackageName)) continue;
    const ranges: Record<string, string> = {};
    const dependencyNames = new Set(manifest.dependencies);
    for (const dependency of dependencyNames) {
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

/** Creates the unbound next plan and its bounded cross-job metadata. */
export function createNextReleasePlan(
  input: NextPlanInput,
): ResultAsync<
  { readonly plan: ReleasePlan; readonly metadata: NextReleaseMetadata },
  NextPlanError
> {
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha))
    return errAsync({
      type: "InvalidNextSourceSha",
      sourceSha: input.sourceSha,
    });
  const selected = selectionFromInput(input.selection);
  if (selected.isErr()) return errAsync(selected.error);
  const pending = subtractConsumedLedger({
    changesets: input.changesets,
    ledger: input.ledger,
  });
  if (pending.modified.length > 0)
    return errAsync({
      type: "ConsumedChangesetModified",
      changesets: pending.modified,
    });
  const closure = computeSelectionClosure({
    seed: nextSelectionSeed(selected.value),
    changesets: pending.pending,
    manifests: input.manifests,
  });
  if (closure.isErr())
    return errAsync({ type: "NextSelectionFailed", error: closure.error });
  return computeChannelVersions({
    packageVersions: input.packageVersions,
    changesets: input.changesets,
    ledger: input.ledger,
    channel: "next",
    sourceSha: input.sourceSha,
    now: input.now,
    affected: closure.value.selected,
    registry: input.registry,
  })
    .mapErr((error): NextPlanError => ({ type: "NextVersionFailed", error }))
    .andThen((versions) => {
      const scratch = renderNextScratchChangelogs({
        versions: versions.packages,
        sourceSha: input.sourceSha,
        canonicalNotesUrl: input.canonicalNotesUrl,
        sourceHistory: input.sourceHistory,
        pendingChangesets: pending.pending.map((entry) => entry.identity),
      });
      if (scratch.isErr())
        return errAsync<
          {
            readonly plan: ReleasePlan;
            readonly metadata: NextReleaseMetadata;
          },
          NextPlanError
        >({ type: "NextChangelogFailed", error: scratch.error });
      const planClosure: ReleasePlan["closure"] = {
        seed: [...closure.value.seed],
        selected: [...closure.value.selected],
        added: closure.value.added.map((addition) =>
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
                    dependencyPath: [
                      ...addition.reason.evidence.dependencyPath,
                    ],
                  },
                },
              },
        ),
      };
      const planCandidate: ReleasePlan = {
        schemaVersion: 1,
        channel: "next",
        seed: [...closure.value.seed],
        closure: planClosure,
        consumed: [],
        versions: versions.packages.map((entry) => ({
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
              channel: "next",
              sourceSha: input.sourceSha,
              selected: closure.value.selected,
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
            readonly metadata: NextReleaseMetadata;
          },
          NextPlanError
        >({ type: "InvalidNextPlan", error: plan.error });
      const metadata: NextReleaseMetadata = {
        schemaVersion: NEXT_METADATA_SCHEMA_VERSION,
        channel: "next",
        sourceSha: input.sourceSha,
        canonicalNotesUrl: input.canonicalNotesUrl,
        sourceHistory: [...(input.sourceHistory ?? [])],
        pendingChangesets: pending.pending.map((entry) => ({
          id: entry.identity.id,
          sourceDigest: entry.identity.sourceDigest,
        })),
        changelogs: scratch.value.map((entry) => ({ ...entry })),
      };
      return okAsync({ plan: plan.value, metadata });
    });
}

/** Canonical workflow carrier for the next metadata. */
export function serializeNextMetadata(
  metadata: NextReleaseMetadata,
): Result<string, NextPlanError> {
  const parsed = NextMetadataSchema.safeParse(metadata);
  if (!parsed.success)
    return err({
      type: "InvalidNextPlan",
      error: {
        type: "InvalidReleasePlan",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
      },
    });
  return ok(`${canonicalJson(parsed.data)}\n`);
}

/** Bounded parser for the metadata artifact. */
export function parseNextMetadata(
  input: unknown,
): Result<NextReleaseMetadata, NextPlanError> {
  const parsed = NextMetadataSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidNextPlan",
      error: {
        type: "InvalidReleasePlan",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
      },
    });
  return ok(parsed.data);
}

function nextMetadataPlanMismatch(
  plan: ReleasePlan,
  metadata: NextReleaseMetadata,
): string | undefined {
  if (plan.channel !== "next") return "plan channel is not next";
  if (plan.releasedSha !== metadata.sourceSha)
    return "plan and metadata source SHA differ";
  if (plan.changelogDigests.length !== metadata.changelogs.length)
    return "plan and metadata changelog sets differ";
  const metadataByPackage = new Map(
    metadata.changelogs.map((entry) => [entry.packageName, entry]),
  );
  for (const expected of plan.changelogDigests) {
    const actual = metadataByPackage.get(expected.packageName);
    if (actual === undefined)
      return `metadata is missing the ${expected.packageName} changelog`;
    if (actual.version !== expected.version)
      return `metadata version differs for ${expected.packageName}`;
    if (actual.documentDigest !== expected.documentDigest)
      return `metadata digest differs for ${expected.packageName}`;
  }
  return undefined;
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

/** Compares source bytes exactly; staging must never write these paths. */
export function assertSourceFilesUnchanged(input: {
  readonly before:
    | SourceByteSnapshot
    | ReadonlyMap<string, string | Uint8Array>;
  readonly after: SourceByteSnapshot | ReadonlyMap<string, string | Uint8Array>;
}): Result<void, SourceImmutabilityError> {
  const before = snapshotEntries(input.before);
  const after = snapshotEntries(input.after);
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

/** Names used by callers that describe the same no-Git-mutation assertion. */
export const assertSourceImmutability = assertSourceFilesUnchanged;
export const verifySourceImmutability = assertSourceFilesUnchanged;

export interface NextStageInput {
  readonly root: string;
  readonly sourceRoot?: string;
  readonly plan: ReleasePlan;
  readonly metadata: NextReleaseMetadata;
  readonly manifests?: readonly NextWorkspaceManifest[];
  readonly packager?: PublicPackagePackager;
}

export type NextStageError =
  | { readonly type: "InvalidNextStage"; readonly reason: string }
  | {
      readonly type: "NextSourceReadFailed";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly type: "NextSourceMutation";
      readonly error: SourceImmutabilityError;
    }
  | { readonly type: "NextPackFailed"; readonly error: PackagerError }
  | { readonly type: "NextBindingFailed"; readonly error: PackagerError }
  | {
      readonly type: "NextPlanBindingFailed";
      readonly error: ReleasePlanError;
    };

export interface NextStageResult {
  readonly plan: ReleasePlan;
  readonly records: readonly PackageStagingRecord[];
  readonly binding: NonNullable<ReleasePlan["binding"]>;
}

/** Packs through Task 10 while proving the source snapshot stayed unchanged. */
export function stageNextPackages(
  input: NextStageInput,
): ResultAsync<NextStageResult, NextStageError> {
  if (input.plan.channel !== "next")
    return errAsync({
      type: "InvalidNextStage",
      reason: "plan channel is not next",
    });
  const metadataMismatch = nextMetadataPlanMismatch(input.plan, input.metadata);
  if (metadataMismatch !== undefined)
    return errAsync({
      type: "InvalidNextStage",
      reason: metadataMismatch,
    });
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  const packages = input.plan.closure.selected;
  return snapshotNextSourceFiles(sourceRoot, packages)
    .mapErr((error): NextStageError => error)
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
          channel: "next",
          packages,
          sourceRoot,
          sourceSha: input.metadata.sourceSha,
          canonicalNotesUrl: input.metadata.canonicalNotesUrl,
          sourceHistory: input.metadata.sourceHistory,
          pendingChangesets,
          changelogOverrides,
          dependencyRangeOverrides: computeNextDependencyRangeOverrides(
            input.manifests ?? [],
            input.plan.versions,
          ),
        })
        .mapErr((error): NextStageError => ({ type: "NextPackFailed", error }))
        .andThen((records) =>
          snapshotNextSourceFiles(sourceRoot, packages)
            .mapErr((error): NextStageError => error)
            .andThen((after) => {
              const unchanged = assertSourceFilesUnchanged({ before, after });
              if (unchanged.isErr())
                return errAsync<NextStageResult, NextStageError>({
                  type: "NextSourceMutation",
                  error: unchanged.error,
                });
              const binding = buildReleaseStagingBinding(
                input.plan.releasedSha ?? "",
                records,
              );
              if (binding.isErr())
                return errAsync<NextStageResult, NextStageError>({
                  type: "NextBindingFailed",
                  error: binding.error,
                });
              const bound = attachReleasePlanBinding(input.plan, binding.value);
              if (bound.isErr())
                return errAsync<NextStageResult, NextStageError>({
                  type: "NextPlanBindingFailed",
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

/** Reads only selected source manifests and changelogs for the mutation proof. */
export function snapshotNextSourceFiles(
  sourceRoot: string,
  packages: readonly PublicPackageName[],
): ResultAsync<SourceByteSnapshot, NextStageError> {
  const snapshot: Record<string, string | Uint8Array> = {};
  let result = okAsync<void, NextStageError>(undefined);
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
          (cause): NextStageError => ({
            type: "NextSourceReadFailed",
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

export interface NextPrereleaseNote {
  readonly packageName: PublicPackageName;
  readonly version: string;
  readonly tag: string;
  readonly tarballSha256: string;
  readonly notes: string;
  readonly prerelease: true;
}

export type NextNotesError =
  | {
      readonly type: "NextNotesMissingChangelog";
      readonly packageName: PublicPackageName;
    }
  | { readonly type: "NextNotesMemberMismatch"; readonly packageName: string }
  | { readonly type: "NextNotesFailed"; readonly error: NotesWrapperError };

/** Builds the deterministic GitHub prerelease wrapper from scratch changelogs. */
export function renderNextPrereleaseNotes(input: {
  readonly releasedSha: string;
  readonly versions: readonly ReleasePackageVersion[];
  readonly tarballDigests: readonly {
    readonly packageName: PublicPackageName;
    readonly sha256: string;
  }[];
  readonly changelogs: Readonly<Record<string, string>>;
}): Result<readonly NextPrereleaseNote[], NextNotesError> {
  const digests = new Map(
    input.tarballDigests.map((entry) => [entry.packageName, entry.sha256]),
  );
  const notes: NextPrereleaseNote[] = [];
  for (const version of input.versions) {
    const changelog = input.changelogs[version.packageName];
    if (changelog === undefined)
      return err({
        type: "NextNotesMissingChangelog",
        packageName: version.packageName,
      });
    const digest = digests.get(version.packageName);
    if (digest === undefined)
      return err({
        type: "NextNotesMemberMismatch",
        packageName: version.packageName,
      });
    const wrapped = composeReleaseNotes({
      packageName: version.packageName,
      version: version.version,
      previousVersion: version.previousVersion,
      releasedSha: input.releasedSha,
      tarballSha256: digest,
      changelog,
    });
    if (wrapped.isErr())
      return err({ type: "NextNotesFailed", error: wrapped.error });
    notes.push({
      packageName: version.packageName,
      version: version.version,
      tag: releaseTagName(version.packageName, version.version),
      tarballSha256: digest,
      notes: wrapped.value,
      prerelease: true,
    });
  }
  return ok(notes);
}

export const composeNextPrereleaseNotes = renderNextPrereleaseNotes;

const NextPublicationMemberSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    tarballSha256: DigestSchema,
    status: z.enum(["published", "already-published", "failed", "pending"]),
    verification: z.enum(["digest-verified", "unverified"]),
    error: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((member, context) => {
    const ready =
      member.status === "published" || member.status === "already-published";
    if (ready && member.verification !== "digest-verified")
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "published members must be digest-verified",
      });
    if (!ready && member.verification !== "unverified")
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "unfinished members stay unverified",
      });
    if (member.status === "failed" && member.error === undefined)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "failed members must carry an error",
      });
    if (member.status !== "failed" && member.error !== undefined)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "only failed members carry an error",
      });
  });

const NextPublicationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.enum(["stable", "next", "nightly"]),
    tag: z.enum(["latest", "next", "nightly"]),
    releasedSha: FullShaSchema,
    members: z.array(NextPublicationMemberSchema).min(1).max(4),
  })
  .strict()
  .superRefine((report, context) => {
    const expectedTag = report.channel === "stable" ? "latest" : report.channel;
    if (report.tag !== expectedTag)
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "tag must match the channel",
      });
    const names = report.members.map((member) => member.packageName);
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "members must be unique",
      });
    const catalog = Object.keys(PUBLIC_PACKAGES);
    const ordered = [...names].sort(
      (left, right) => catalog.indexOf(left) - catalog.indexOf(right),
    );
    if (names.some((name, index) => name !== ordered[index]))
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "members must use catalog order",
      });
  });

function validateNextPublicationReport(
  input: unknown,
): Result<PublicationReport, PublicationError> {
  const parsed = NextPublicationReportSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidPublicationReport",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data as PublicationReport);
}

function isNextRefsReadyMember(member: PublicationMember): boolean {
  return (
    member.verification === "digest-verified" &&
    (member.status === "published" || member.status === "already-published")
  );
}

function assertNextPublicationGate(
  input: Pick<
    ReleaseRefsInput,
    "channel" | "releasedSha" | "closure" | "report"
  >,
): Result<void, ReleaseRefsError> {
  const report = validateNextPublicationReport(input.report);
  if (report.isErr())
    return err({ type: "InvalidPublicationReport", error: report.error });
  if (report.value.channel !== input.channel)
    return err({
      type: "PublicationMemberMismatch",
      packageName: input.closure[0] ?? "@weaveio/weave-cli",
      field: "channel",
      expected: input.channel,
      actual: report.value.channel,
    });
  if (report.value.releasedSha !== input.releasedSha)
    return err({
      type: "ReleasedShaMismatch",
      field: "publicationReport",
      expected: input.releasedSha,
      actual: report.value.releasedSha,
    });
  const selected = [...new Set(input.closure)];
  const reported = new Map(
    report.value.members.map((member) => [member.packageName, member]),
  );
  const missing = selected.filter((name) => !reported.has(name));
  const unexpected = report.value.members
    .map((member) => member.packageName)
    .filter((name) => !selected.includes(name));
  if (missing.length > 0 || unexpected.length > 0)
    return err({ type: "PublicationClosureMismatch", missing, unexpected });
  const unfinished = report.value.members.filter(
    (member) => !isNextRefsReadyMember(member),
  );
  if (unfinished.length > 0)
    return err({ type: "PublicationReportIncomplete", members: unfinished });
  return ok(undefined);
}

function assertNextReleasedShaTarget(
  input: Pick<
    ReleaseRefsInput,
    "releasedSha" | "tagTargetSha" | "baseSha" | "builtSha" | "headSha"
  >,
): Result<void, ReleaseRefsError> {
  if (!FullShaSchema.safeParse(input.releasedSha).success)
    return err({ type: "InvalidReleasedSha", sha: input.releasedSha });
  if (!FullShaSchema.safeParse(input.tagTargetSha).success)
    return err({ type: "InvalidReleasedSha", sha: input.tagTargetSha });
  if (input.tagTargetSha !== input.releasedSha) {
    let field: "tagTarget" | "baseSha" | "builtSha" | "headSha" = "tagTarget";
    if (input.tagTargetSha === input.baseSha) field = "baseSha";
    else if (
      input.builtSha !== undefined &&
      input.tagTargetSha === input.builtSha
    )
      field = "builtSha";
    else if (
      input.headSha !== undefined &&
      input.tagTargetSha === input.headSha
    )
      field = "headSha";
    return err({
      type: "ReleasedShaMismatch",
      field,
      expected: input.releasedSha,
      actual: input.tagTargetSha,
    });
  }
  return ok(undefined);
}

interface NextPlannedRef {
  readonly packageName: PublicPackageName;
  readonly tag: string;
  readonly notes: string;
  readonly prerelease: true;
}

interface NextRefItem {
  readonly packageName: PublicPackageName;
  readonly tag: string;
  readonly tagOutcome: "created" | "skipped";
  readonly releaseOutcome: "created" | "skipped";
}

/** Applies Task 12's create-once refs semantics without reaching publish code. */
export function applyNextPrereleases(
  input: Omit<ReleaseRefsInput, "channel">,
  github: ReleaseRefsGitHub,
): ResultAsync<ReleaseRefsResult, ReleaseRefsError> {
  const full: ReleaseRefsInput = { ...input, channel: "next" };
  const gate = assertNextPublicationGate(full).andThen(() =>
    assertNextReleasedShaTarget(full),
  );
  if (gate.isErr()) return errAsync(gate.error);
  return applyNextRefMembers(full, github, full.report.members, 0, []);
}

function applyNextRefMembers(
  input: ReleaseRefsInput,
  github: ReleaseRefsGitHub,
  members: readonly PublicationMember[],
  index: number,
  done: readonly NextRefItem[],
): ResultAsync<ReleaseRefsResult, ReleaseRefsError> {
  const member = members[index];
  if (member === undefined) return okAsync({ status: "applied", items: done });
  const planned = planNextRef(input, member);
  if (planned.isErr()) return errAsync(planned.error);
  return syncNextRef(input, github, planned.value).andThen((item) =>
    applyNextRefMembers(input, github, members, index + 1, [...done, item]),
  );
}

function planNextRef(
  input: ReleaseRefsInput,
  member: PublicationMember,
): Result<NextPlannedRef, ReleaseRefsError> {
  const version = input.versions.find(
    (entry) => entry.packageName === member.packageName,
  );
  if (version === undefined || version.version !== member.version)
    return err({
      type: "PublicationMemberMismatch",
      packageName: member.packageName,
      field: "version",
      expected: version?.version ?? "",
      actual: member.version,
    });
  const changelog = input.changelogs[member.packageName];
  if (changelog === undefined)
    return err({ type: "ChangelogMissing", packageName: member.packageName });
  const notes = composeReleaseNotes({
    packageName: member.packageName,
    version: member.version,
    previousVersion: version.previousVersion,
    releasedSha: input.releasedSha,
    tarballSha256: member.tarballSha256,
    changelog,
  });
  if (notes.isErr())
    return err({ type: "ReleaseNotesFailed", error: notes.error });
  return ok({
    packageName: member.packageName,
    tag: releaseTagName(member.packageName, member.version),
    notes: notes.value,
    prerelease: true,
  });
}

function syncNextRef(
  input: ReleaseRefsInput,
  github: ReleaseRefsGitHub,
  planned: NextPlannedRef,
): ResultAsync<NextRefItem, ReleaseRefsError> {
  return github.readTag(planned.tag).andThen((existingTag) => {
    let tag: ResultAsync<"created" | "skipped", ReleaseRefsError>;
    if (existingTag === null) {
      tag = github
        .createAnnotatedTag({
          tag: planned.tag,
          commitSha: input.releasedSha,
          message: planned.tag,
        })
        .map(() => "created" as const);
    } else if (existingTag.commitSha === input.releasedSha) {
      tag = okAsync("skipped" as const);
    } else {
      tag = errAsync({
        type: "ExistingTagConflict" as const,
        tag: planned.tag,
        expectedSha: input.releasedSha,
        actualSha: existingTag.commitSha,
      });
    }
    return tag.andThen((tagOutcome) =>
      github.readRelease(planned.tag).andThen((existingRelease) => {
        if (existingRelease === null)
          return github
            .createRelease({
              tag: planned.tag,
              targetSha: input.releasedSha,
              name: planned.tag,
              notes: planned.notes,
              prerelease: true,
            })
            .map(() => ({
              packageName: planned.packageName,
              tag: planned.tag,
              tagOutcome,
              releaseOutcome: "created" as const,
            }));
        if (
          existingRelease.draft ||
          !existingRelease.prerelease ||
          existingRelease.targetSha !== input.releasedSha ||
          existingRelease.notes !== planned.notes
        )
          return errAsync({
            type: "ExistingReleaseConflict" as const,
            tag: planned.tag,
            reason: "existing release does not match the immutable prerelease",
          });
        return okAsync({
          packageName: planned.packageName,
          tag: planned.tag,
          tagOutcome,
          releaseOutcome: "skipped" as const,
        });
      }),
    );
  });
}

export type NextProofStage = "attestation" | "consumer" | "harness";
export interface NextProofChainInput {
  readonly expectation: AttestationExpectation;
  readonly attestation: unknown;
  readonly closure: Pick<SelectionClosure, "selected">;
  readonly consumerProofs: readonly unknown[];
  readonly harnessProofs: readonly unknown[];
}

export interface NextProofChain {
  readonly attestation: AttestationCheckResult;
  readonly consumers: readonly ConsumerProof[];
  readonly harness: readonly HarnessProofRecord[];
}

export type NextProofError = {
  readonly type: "NextProofBlocked";
  readonly stage: NextProofStage;
  readonly reason: string;
};

/**
 * Verifies every exact proof before the publish job can be reached. The
 * expected consumer set is the complete closure; the harness set is exactly
 * its adapter members.
 */
export function assertNextProofChain(
  input: NextProofChainInput,
): Result<NextProofChain, NextProofError> {
  if (input.attestation === undefined || input.attestation === null)
    return err({
      type: "NextProofBlocked",
      stage: "attestation",
      reason: "attestation result is missing",
    });
  const attestation = verifyAttestationResult(
    input.attestation,
    input.expectation,
  );
  if (attestation.isErr())
    return err(blocked("attestation", attestation.error));
  const expectedDigests = new Map(
    input.expectation.tarballDigests.map((entry) => [
      entry.packageName,
      entry.sha256,
    ]),
  );
  if (
    expectedDigests.size !== input.closure.selected.length ||
    input.closure.selected.some(
      (packageName) => !expectedDigests.has(packageName),
    )
  )
    return err({
      type: "NextProofBlocked",
      stage: "consumer",
      reason: "attestation publish set does not equal the selection closure",
    });
  const consumers: ConsumerProof[] = [];
  const consumerNames = new Set<string>();
  for (const candidate of input.consumerProofs) {
    const parsed = validateConsumerProof(candidate);
    if (parsed.isErr()) return err(blocked("consumer", parsed.error));
    if (consumerNames.has(parsed.value.packageName))
      return err({
        type: "NextProofBlocked",
        stage: "consumer",
        reason: `duplicate consumer proof for ${parsed.value.packageName}`,
      });
    consumerNames.add(parsed.value.packageName);
    const expected = expectedDigests.get(
      parsed.value.packageName as PublicPackageName,
    );
    if (expected === undefined)
      return err({
        type: "NextProofBlocked",
        stage: "consumer",
        reason: `unexpected consumer proof for ${parsed.value.packageName}`,
      });
    const checked = assertConsumerProofDigest(candidate, {
      packageName: parsed.value.packageName as PublicPackageName,
      digest: expected,
    });
    if (checked.isErr()) return err(blocked("consumer", checked.error));
    consumers.push(checked.value);
  }
  if (consumers.length !== input.closure.selected.length)
    return err({
      type: "NextProofBlocked",
      stage: "consumer",
      reason: "a closure member has no clean-consumer proof",
    });
  const adapters = resolveNextChangedAdapters(input.closure);
  if (adapters.isErr())
    return err({
      type: "NextProofBlocked",
      stage: "harness",
      reason: adapters.error.type,
    });
  const requiredVersions = new Map<AdapterPackageName, readonly string[]>();
  for (const adapter of adapters.value.adapters) {
    const slots = requiredHostSlots(adapter, ADAPTER_HOST_MATRICES);
    if (slots.isErr())
      return err({
        type: "NextProofBlocked",
        stage: "harness",
        reason: slots.error.type,
      });
    requiredVersions.set(
      adapter,
      slots.value.map((slot) => slot.version),
    );
  }
  const harness: HarnessProofRecord[] = [];
  const harnessKeys = new Set<string>();
  for (const candidate of input.harnessProofs) {
    const parsed = validateHarnessProof(candidate);
    if (parsed.isErr()) return err(blocked("harness", parsed.error));
    const adapter = parsed.value.adapter as AdapterPackageName;
    const expected = expectedDigests.get(parsed.value.adapter);
    const versions = requiredVersions.get(adapter);
    if (expected === undefined || versions === undefined)
      return err({
        type: "NextProofBlocked",
        stage: "harness",
        reason: `unexpected harness proof for ${parsed.value.adapter}`,
      });
    if (!versions.includes(parsed.value.version))
      return err({
        type: "NextProofBlocked",
        stage: "harness",
        reason: `unexpected host version ${parsed.value.version} for ${parsed.value.adapter}`,
      });
    const key = `${parsed.value.adapter}\u0000${parsed.value.version}`;
    if (harnessKeys.has(key))
      return err({
        type: "NextProofBlocked",
        stage: "harness",
        reason: `duplicate harness proof for ${parsed.value.adapter}@${parsed.value.version}`,
      });
    harnessKeys.add(key);
    const checked = assertHarnessProofDigest(candidate, {
      adapter,
      digest: expected,
    });
    if (checked.isErr()) return err(blocked("harness", checked.error));
    harness.push(checked.value);
  }
  for (const [adapter, versions] of requiredVersions) {
    for (const version of versions)
      if (
        !harness.some(
          (proof) => proof.adapter === adapter && proof.version === version,
        )
      )
        return err({
          type: "NextProofBlocked",
          stage: "harness",
          reason: `missing ${adapter} ${version} harness proof`,
        });
  }
  return ok({ attestation: attestation.value, consumers, harness });
}

/** Alias for callers that use a publish-gate name. */
export const assertNextPublishProofs = assertNextProofChain;

export const NEXT_PHASES = ["route", "plan", "build", "prerelease"] as const;
export type NextPhase = (typeof NEXT_PHASES)[number];

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

export interface NextMainCliOptions {
  readonly phase: NextPhase;
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly metadataPath?: string;
  readonly rootPath?: string;
  readonly planPath?: string;
  readonly publicationPath?: string;
}

export type NextCliError = {
  readonly type: "InvalidNextCommand";
  readonly issues: readonly string[];
};

/** Parses the small, statically-invoked workflow command surface. */
export function parseNextMainArgs(
  argv: readonly string[],
): Result<NextMainCliOptions, NextCliError> {
  const values: Record<string, string> = {};
  const allowed = new Set([
    "phase",
    "input",
    "output",
    "metadata",
    "root",
    "plan",
    "publication",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === undefined || value === undefined || !token.startsWith("--"))
      return err({
        type: "InvalidNextCommand",
        issues: ["expected --name value"],
      });
    const key = token.slice(2);
    if (!allowed.has(key))
      return err({
        type: "InvalidNextCommand",
        issues: [`unknown option --${key}`],
      });
    if (Object.hasOwn(values, key))
      return err({
        type: "InvalidNextCommand",
        issues: [`duplicate option --${key}`],
      });
    const parsed = SafePathSchema.safeParse(value);
    if (key !== "phase" && !parsed.success)
      return err({
        type: "InvalidNextCommand",
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    values[key] = value;
    index += 1;
  }
  const parsed = z
    .object({
      phase: z.enum(NEXT_PHASES),
      inputPath: SafePathSchema.optional(),
      outputPath: SafePathSchema.optional(),
      metadataPath: SafePathSchema.optional(),
      rootPath: SafePathSchema.optional(),
      planPath: SafePathSchema.optional(),
      publicationPath: SafePathSchema.optional(),
    })
    .strict()
    .safeParse({
      phase: values.phase,
      inputPath: values.input,
      outputPath: values.output,
      metadataPath: values.metadata,
      rootPath: values.root,
      planPath: values.plan,
      publicationPath: values.publication,
    });
  if (!parsed.success)
    return err({
      type: "InvalidNextCommand",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

export const runNextMainCli = parseNextMainArgs;

export type NextMainError =
  | NextCliError
  | NextRouteError
  | NextRolloutError
  | NextPlanError
  | NextStageError
  | NextNotesError
  | {
      readonly type: "NextCarrierError";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly type: "NextPublicationGateFailed";
      readonly error: ReleaseRefsError;
    };

/** Executes the phase adapter without giving the route job npm credentials. */
export function runNextMain(
  options: NextMainCliOptions,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): ResultAsync<unknown, NextMainError> {
  switch (options.phase) {
    case "route":
      return runNextRoute(env);
    case "plan":
      return runNextPlan(options, env);
    case "build":
      return runNextBuild(options, env);
    case "prerelease":
      return runNextPrerelease(options, env);
  }
}

function runNextRoute(
  env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NextMainError> {
  const route = parseNextRouteEnvironment(env);
  if (route.isErr()) return errAsync(route.error);
  const root = resolve(import.meta.dir, "../..");
  return readLocalWorkflowTopology(root)
    .mapErr(
      (error): NextMainError => ({
        type: "InvalidRolloutTopology",
        issues: [error.reason],
      }),
    )
    .andThen((topology) => {
      const rollout = evaluateNextRollout({
        declaration: ROLLOUT_STAGE_DECLARATION,
        mode: env.RELEASE_ROLLOUT_MODE ?? "disabled",
        topology,
      }).mapErr((error): NextMainError => error);
      if (rollout.isErr()) return errAsync(rollout.error);
      return okAsync(rollout.value).andThen((decision) => {
        const output = {
          channel: "next",
          work: decision.work,
          publish: decision.publish,
          releasedSha: env.GITHUB_SHA ?? "",
          closureExplanation: `Seed packages: ${route.value.selected.join(", ")}. Closure is recomputed in the plan job; no changeset is consumed.`,
          outcome: decision.outcome,
        };
        return writeOutputs(env.GITHUB_OUTPUT, output)
          .mapErr((error): NextMainError => error)
          .andThen(() =>
            writeSummary(
              env.GITHUB_STEP_SUMMARY,
              [
                "## next route",
                "",
                "- Channel: next",
                `- Seed packages: ${route.value.selected.join(", ")}`,
                "- Closure: computed later from shared changesets and bundled-artifact impacts.",
                "- Changesets: none are consumed or deleted by this channel.",
                `- Rollout: ${decision.outcome}`,
              ].join("\n"),
            ),
          )
          .map(() => output);
      });
    });
}

function runNextPlan(
  options: NextMainCliOptions,
  env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NextMainError> {
  const outputPath = options.outputPath;
  if (outputPath === undefined)
    return errAsync({
      type: "NextCarrierError",
      path: "",
      reason: "plan phase requires --output",
    });
  const root = resolve(options.rootPath ?? resolve(import.meta.dir, "../.."));
  const sourceSha = env.NEXT_SOURCE_SHA ?? env.GITHUB_SHA ?? "";
  const selected = parseNextEnvironment(env);
  if (selected.isErr()) return errAsync(selected.error);
  return loadNextPlanInput(
    root,
    selected.value,
    sourceSha,
    env.NEXT_NOW,
    env.NEXT_CANONICAL_NOTES_URL,
  )
    .andThen((input) =>
      createNextReleasePlan(input).mapErr((error): NextMainError => error),
    )
    .andThen(({ plan, metadata }) => {
      const serialized = serializeReleasePlanArtifact(plan);
      if (serialized.isErr())
        return errAsync<unknown, NextMainError>({
          type: "InvalidNextPlan",
          error: serialized.error,
        });
      const metadataPath =
        options.metadataPath ?? join(dirname(outputPath), "next-metadata.json");
      const metadataText = serializeNextMetadata(metadata);
      if (metadataText.isErr()) return errAsync(metadataText.error);
      return writeText(outputPath, serialized.value)
        .andThen(() => writeText(metadataPath, metadataText.value))
        .andThen(() =>
          writeSummary(
            env.GITHUB_STEP_SUMMARY,
            [
              "## next plan",
              "",
              explainNextClosure(plan.closure),
              "",
              "- Versions and changelogs are staging-only; no changeset is consumed.",
              "- AI prose is not used for next scratch changelogs.",
            ].join("\n"),
          ),
        )
        .map(() => ({ plan, metadata, planPath: outputPath, metadataPath }));
    });
}

function runNextBuild(
  options: NextMainCliOptions,
  env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NextMainError> {
  const planPath = options.planPath ?? options.inputPath;
  const outputPath = options.outputPath ?? planPath;
  const metadataPath = options.metadataPath;
  if (
    planPath === undefined ||
    outputPath === undefined ||
    metadataPath === undefined
  )
    return errAsync({
      type: "NextCarrierError",
      path: planPath ?? "",
      reason: "build phase requires --plan, --metadata, and --output",
    });
  return readText(planPath)
    .andThen((text) =>
      parseReleasePlanArtifact(text).mapErr(
        (error): NextMainError => ({ type: "InvalidNextPlan", error }),
      ),
    )
    .andThen((artifact) =>
      readText(metadataPath).andThen((metadataText) => {
        const decoded = Result.fromThrowable(
          () => JSON.parse(metadataText) as unknown,
          (cause): NextMainError => ({
            type: "NextCarrierError",
            path: metadataPath,
            reason: String(cause),
          }),
        )();
        if (decoded.isErr()) return errAsync(decoded.error);
        const metadata = parseNextMetadata(decoded.value);
        if (metadata.isErr()) return errAsync(metadata.error);
        const sourceRoot = resolve(process.cwd());
        return new BunReleaseCheckout()
          .head(sourceRoot)
          .mapErr(
            (error): NextMainError => ({
              type: "NextCarrierError",
              path: sourceRoot,
              reason: `source checkout: ${error.type}`,
            }),
          )
          .andThen((head) => {
            if (head !== metadata.value.sourceSha)
              return errAsync<unknown, NextMainError>({
                type: "NextCarrierError",
                path: sourceRoot,
                reason: `source checkout ${head} does not match planned SHA ${metadata.value.sourceSha}`,
              });
            return loadWorkspaceManifests(sourceRoot).andThen((manifests) =>
              stageNextPackages({
                root: resolve(options.rootPath ?? dirname(outputPath)),
                sourceRoot,
                manifests,
                plan: artifact.plan,
                metadata: metadata.value,
              }).andThen((staged) => {
                const serialized = serializeReleasePlanArtifact(staged.plan);
                if (serialized.isErr())
                  return errAsync<unknown, NextMainError>({
                    type: "InvalidNextPlan",
                    error: serialized.error,
                  });
                const notes = renderNextPrereleaseNotes({
                  releasedSha:
                    staged.plan.releasedSha ?? env.NEXT_SOURCE_SHA ?? "",
                  versions: staged.plan.versions,
                  tarballDigests: staged.binding.tarballs.map((entry) => ({
                    packageName: entry.packageName,
                    sha256: entry.sha256,
                  })),
                  changelogs: Object.fromEntries(
                    metadata.value.changelogs.map((entry) => [
                      entry.packageName,
                      entry.content,
                    ]),
                  ),
                });
                if (notes.isErr()) return errAsync(notes.error);
                const root = resolve(options.rootPath ?? dirname(outputPath));
                const artifacts = join(root, "artifacts");
                return ResultAsync.fromThrowable(
                  async () => {
                    await Bun.write(join(artifacts, ".keep"), "");
                    for (const record of staged.records) {
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
                  (cause): NextMainError => ({
                    type: "NextCarrierError",
                    path: artifacts,
                    reason: String(cause),
                  }),
                )()
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
                  .andThen(() =>
                    writeText(
                      join(root, "next-notes.json"),
                      `${canonicalJson(notes.value)}\n`,
                    ),
                  )
                  .map(() => ({
                    plan: staged.plan,
                    binding: staged.binding,
                    notes: notes.value,
                  }));
              }),
            );
          });
      }),
    );
}

function runNextPrerelease(
  options: NextMainCliOptions,
  _env: Readonly<Record<string, string | undefined>>,
): ResultAsync<unknown, NextMainError> {
  const planPath = options.planPath ?? options.inputPath;
  const metadataPath = options.metadataPath;
  const publicationPath = options.publicationPath;
  if (
    planPath === undefined ||
    metadataPath === undefined ||
    publicationPath === undefined
  )
    return errAsync({
      type: "NextCarrierError",
      path: planPath ?? "",
      reason: "prerelease phase requires --plan, --metadata, and --publication",
    });
  return readText(planPath)
    .andThen((text) =>
      parseReleasePlanArtifact(text).mapErr(
        (error): NextMainError => ({ type: "InvalidNextPlan", error }),
      ),
    )
    .andThen((artifact) =>
      readText(metadataPath).andThen((metadataText) => {
        const decoded = Result.fromThrowable(
          () => JSON.parse(metadataText) as unknown,
          (cause): NextMainError => ({
            type: "NextCarrierError",
            path: metadataPath,
            reason: String(cause),
          }),
        )();
        if (decoded.isErr()) return errAsync(decoded.error);
        const metadata = parseNextMetadata(decoded.value);
        if (metadata.isErr()) return errAsync(metadata.error);
        const metadataMismatch = nextMetadataPlanMismatch(
          artifact.plan,
          metadata.value,
        );
        if (metadataMismatch !== undefined)
          return errAsync<unknown, NextMainError>({
            type: "NextCarrierError",
            path: metadataPath,
            reason: metadataMismatch,
          });
        const reportResult = readText(publicationPath).andThen((reportText) => {
          const reportJson = Result.fromThrowable(
            () => JSON.parse(reportText) as unknown,
            (cause): NextMainError => ({
              type: "NextCarrierError",
              path: publicationPath,
              reason: String(cause),
            }),
          )();
          if (reportJson.isErr()) return errAsync(reportJson.error);
          const report = validateNextPublicationReport(reportJson.value);
          if (report.isErr())
            return errAsync<PublicationReport, NextMainError>({
              type: "NextPublicationGateFailed",
              error: {
                type: "InvalidPublicationReport",
                error: report.error,
              },
            });
          return okAsync<PublicationReport, NextMainError>(report.value);
        });
        return reportResult.andThen((report) => {
          const gated = assertNextPublicationGate({
            channel: "next",
            releasedSha: artifact.plan.releasedSha ?? "",
            closure: artifact.plan.closure.selected,
            report,
          });
          if (gated.isErr())
            return errAsync<unknown, NextMainError>({
              type: "NextPublicationGateFailed",
              error: gated.error,
            });
          const notes = renderNextPrereleaseNotes({
            releasedSha: artifact.plan.releasedSha ?? metadata.value.sourceSha,
            versions: artifact.plan.versions,
            tarballDigests:
              artifact.plan.binding?.tarballs.map((entry) => ({
                packageName: entry.packageName,
                sha256: entry.sha256,
              })) ?? [],
            changelogs: Object.fromEntries(
              metadata.value.changelogs.map((entry) => [
                entry.packageName,
                entry.content,
              ]),
            ),
          });
          if (notes.isErr()) return errAsync(notes.error);
          const output =
            options.outputPath ?? join(dirname(planPath), "next-notes.json");
          return writeText(output, `${canonicalJson(notes.value)}\n`).map(
            () => ({
              notes: notes.value,
              prerelease: true,
              latestMoved: false,
              sourceMutated: false,
            }),
          );
        });
      }),
    );
}

function loadNextPlanInput(
  root: string,
  selection: NextInput,
  sourceSha: string,
  nowText: string | undefined,
  canonicalNotesUrl: string | undefined,
): ResultAsync<NextPlanInput, NextMainError> {
  const now = new Date(nowText ?? new Date().toISOString());
  if (Number.isNaN(now.valueOf()))
    return errAsync({ type: "InvalidNextSourceSha", sourceSha: sourceSha });
  let versions = okAsync<
    Partial<Record<PublicPackageName, string>>,
    NextMainError
  >({});
  for (const packageName of Object.keys(PUBLIC_PACKAGES) as PublicPackageName[])
    versions = versions.andThen((found) =>
      readJsonRecord(
        join(root, PUBLIC_PACKAGES[packageName].directory, "package.json"),
      ).andThen((manifest) => {
        const version = manifest.version;
        if (typeof version !== "string")
          return errAsync({
            type: "NextCarrierError" as const,
            path: packageName,
            reason: "public manifest has no version",
          });
        return okAsync({ ...found, [packageName]: version });
      }),
    );
  const changesets = new ChangesetPolicyValidator(new BunChangesetFileSystem())
    .validateDirectory(join(root, ".changeset"))
    .mapErr(
      (errors): NextMainError => ({
        type: "NextCarrierError",
        path: join(root, ".changeset"),
        reason: errors.map(describeChangesetError).join("; "),
      }),
    );
  const ledger = loadConsumptionLedger(new BunFileSystem(), root).mapErr(
    (error): NextMainError => ({
      type: "NextCarrierError",
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
        return errAsync<NextPlanInput, NextMainError>({
          type: "NextCarrierError",
          path: packageName,
          reason: "public manifest has no version",
        });
      packageVersions[packageName] = version;
    }
    return changesets.andThen((validated) =>
      ledger.andThen((consumption) =>
        loadWorkspaceManifests(root).andThen((manifests) =>
          readNextSourceHistory(root, sourceSha).map((sourceHistory) => ({
            selection,
            packageVersions,
            changesets: validated,
            ledger: consumption,
            manifests,
            sourceSha,
            now,
            canonicalNotesUrl:
              canonicalNotesUrl ?? "https://github.com/weave-io/weave/releases",
            sourceHistory,
          })),
        ),
      ),
    );
  });
}

function readNextSourceHistory(
  root: string,
  sourceSha: string,
): ResultAsync<readonly ScratchHistoryEntry[], NextMainError> {
  return ResultAsync.fromThrowable(
    async () => {
      const command = Bun.spawn(
        [
          "git",
          "-C",
          root,
          "log",
          `--format=%H%x09%s`,
          `-n${NEXT_SOURCE_HISTORY_LIMIT}`,
          sourceSha,
        ],
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
          throw new Error("git log returned malformed source history");
        const sha = line.slice(0, separator);
        const subject = line.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/.test(sha) || subject.length === 0)
          throw new Error("git log returned invalid source history");
        entries.push({ sha, subject });
      }
      return entries;
    },
    (cause): NextMainError => ({
      type: "NextCarrierError",
      path: root,
      reason: `source history: ${String(cause)}`,
    }),
  )();
}

function loadWorkspaceManifests(
  root: string,
): ResultAsync<readonly NextWorkspaceManifest[], NextMainError> {
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
  let result = okAsync<readonly NextWorkspaceManifest[], NextMainError>([]);
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
  const result: Record<string, string> = {};
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const values = manifest[field];
    if (!isRecord(values)) continue;
    for (const [name, range] of Object.entries(values))
      if (typeof range === "string") result[name] = range;
  }
  return result;
}

function readJsonRecord(
  path: string,
): ResultAsync<Record<string, unknown>, NextMainError> {
  return ResultAsync.fromThrowable(
    async () => JSON.parse(await Bun.file(path).text()) as unknown,
    (cause): NextMainError => ({
      type: "NextCarrierError",
      path,
      reason: String(cause),
    }),
  )().andThen((value) =>
    isRecord(value)
      ? okAsync(value)
      : errAsync({
          type: "NextCarrierError" as const,
          path,
          reason: "JSON carrier must be an object",
        }),
  );
}

function readText(path: string): ResultAsync<string, NextMainError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).text(),
    (cause): NextMainError => ({
      type: "NextCarrierError",
      path,
      reason: String(cause),
    }),
  )();
}

function writeText(
  path: string,
  contents: string,
): ResultAsync<void, NextMainError> {
  return ResultAsync.fromThrowable(
    () => Bun.write(path, contents).then(() => undefined),
    (cause): NextMainError => ({
      type: "NextCarrierError",
      path,
      reason: String(cause),
    }),
  )();
}

function writeOutputs(
  path: string | undefined,
  values: Readonly<Record<string, string | boolean>>,
): ResultAsync<void, NextMainError> {
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
): ResultAsync<void, NextMainError> {
  return path === undefined
    ? okAsync(undefined)
    : writeText(path, `${contents}\n`);
}

function snapshotEntries(
  input: SourceByteSnapshot | ReadonlyMap<string, string | Uint8Array>,
): Map<string, string | Uint8Array> {
  return input instanceof Map ? new Map(input) : new Map(Object.entries(input));
}

function selectionFromInput(
  input: NextInput | SelectionSeed,
): Result<readonly PublicPackageName[], NextInputError> {
  if ("claudeCode" in input) return selectNextPackages(input as NextInput);
  const selected = Object.entries(input)
    .filter(([, value]) => value)
    .map(([name]) => name as PublicPackageName);
  return selected.length === 0 ? err({ type: "EmptySelection" }) : ok(selected);
}

function blocked(
  stage: "attestation",
  error: AttestationGateError,
): NextProofError;
function blocked(stage: "consumer", error: ConsumerProofError): NextProofError;
function blocked(
  stage: "harness",
  error: HarnessProofMainError,
): NextProofError;
function blocked(
  stage: NextProofStage,
  error: AttestationGateError | ConsumerProofError | HarnessProofMainError,
): NextProofError {
  return { type: "NextProofBlocked", stage, reason: error.type };
}

function mapRolloutError(error: RolloutTupleError): NextRolloutError {
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
  const parsed = parseNextMainArgs(Bun.argv.slice(2));
  if (parsed.isErr()) {
    process.exitCode = 2;
  } else {
    const result = await runNextMain(parsed.value, Bun.env);
    process.exitCode = result.isErr() ? 1 : 0;
  }
}

export type { ChannelPackageVersion, PublicationReport };
export { EMPTY_CONSUMPTION_LEDGER, PRIVATE_PACKAGE_NAMES };
