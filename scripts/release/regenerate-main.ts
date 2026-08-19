/**
 * Automatic stable release-PR regeneration controller.
 *
 * A push to `main` is an automatic convergence event, not a request to make a
 * release. This controller keeps that distinction explicit: it never owns PR
 * creation, and it only hands an already-open PR to Task 9's compare-and-swap
 * regeneration operation. The workflow uses this module's phase names to keep
 * the plan, docs audit, changelog agent, and App-token update jobs separate.
 */
import { logger } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import { AiAuditMetadataSchema } from "./ai/audit-metadata.js";
import {
  CHANGELOG_LIMITS,
  type ChangelogEntry,
  type ChangelogEvidence,
} from "./changelog-format.js";
import type { ChangesetIdentity } from "./changeset-policy.js";
import type {
  DocsAuditGateError,
  DocsAuditGateSuccess,
  DocsAuditPublicImpactClassification,
} from "./docs-audit/gate.js";
import type {
  PreparationFailure,
  PreparedRelease,
  RegenerationBuilder,
  RegenerationDraft,
  RegenerationOutcome,
  ReleasePrError,
  ReleasePrState,
} from "./release-pr.js";
import {
  entryIdentityKey,
  evidenceDigest,
  type ProseReusePlan,
  planProseReuse,
} from "./release-pr.js";

const log = logger.child({ module: "regenerate-main" });

/** The statically-unrolled jobs in the regeneration workflow. */
export const REGENERATION_PHASES = [
  "detect",
  "plan",
  "docs-release-audit",
  "changelog-ai",
  "update-pr",
] as const;
export type RegenerationPhase = (typeof REGENERATION_PHASES)[number];

/** A regeneration always carries its origin in a bounded, machine-readable form. */
export const REGENERATION_ATTRIBUTIONS = [
  "automatic-main-advance",
  "maintainer-retry",
] as const;
export type RegenerationAttribution =
  (typeof REGENERATION_ATTRIBUTIONS)[number];

/** The check emitted when a release-time docs re-audit blocks an update. */
export const REGENERATION_DOCS_CHECK_NAME = "docs-audit" as const;
/** The required policy check that independently rejects stale release plans. */
export const RELEASE_POLICY_CHECK_NAME = "release-policy" as const;
/** The marker carried by every updated PR body. */
export const AUTOMATIC_REGENERATION_MARKER =
  "<!-- weave-release-regeneration: automatic -->" as const;
export const MAINTAINER_RETRY_REGENERATION_MARKER =
  "<!-- weave-release-regeneration: maintainer-retry -->" as const;

export const REGENERATION_LIMITS = {
  attempts: 4,
  pathChars: 4_096,
  messageChars: 16_384,
  entries: 512,
  identitySets: 512,
  refs: 512,
  summaryBytes: 16 * 1024,
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = (value: string): boolean =>
  value.length > 0 &&
  value.length <= REGENERATION_LIMITS.pathChars &&
  !value.includes("\0") &&
  !/[;&|`$<>\n\r]/.test(value) &&
  !value.split("/").includes("..");

const ChangesetIdentitySchema = z
  .object({
    id: z.string().min(1).max(REGENERATION_LIMITS.pathChars),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const ChangelogRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pull-request"),
      number: z
        .number()
        .int()
        .positive()
        .max(CHANGELOG_LIMITS.pullRequestNumber),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    })
    .strict(),
]);
const ChangelogEntrySchema = z
  .object({
    prose: z.string().min(1).max(CHANGELOG_LIMITS.proseLength),
    sourceChangesets: z
      .array(ChangesetIdentitySchema)
      .min(1)
      .max(CHANGELOG_LIMITS.entryChangesets),
    refs: z
      .array(ChangelogRefSchema)
      .max(CHANGELOG_LIMITS.entryRefs)
      .optional(),
  })
  .strict();
const ChangelogEvidenceSchema = z
  .object({
    pullRequests: z
      .array(
        z.number().int().positive().max(CHANGELOG_LIMITS.pullRequestNumber),
      )
      .max(REGENERATION_LIMITS.refs)
      .optional(),
    commits: z
      .array(z.string().regex(/^[0-9a-f]{7,40}$/))
      .max(REGENERATION_LIMITS.refs)
      .optional(),
  })
  .strict();

/** Validated cross-job carriers. Workflow artifacts are never trusted by type alone. */
export const RegenerationPlanArtifactSchema = z
  .object({
    baseSha: z.string().regex(FULL_SHA),
    expectedHead: z.string().regex(FULL_SHA),
    publicImpact: z.enum(["public-impact", "no-impact"]),
    currentEntries: z
      .array(ChangelogEntrySchema)
      .max(REGENERATION_LIMITS.entries),
    currentEvidence: ChangelogEvidenceSchema,
    candidateSources: z
      .array(
        z
          .array(ChangesetIdentitySchema)
          .min(1)
          .max(CHANGELOG_LIMITS.entryChangesets),
      )
      .max(REGENERATION_LIMITS.identitySets),
    evidence: ChangelogEvidenceSchema,
  })
  .strict();

export const RegenerationChangelogArtifactSchema = z
  .object({
    generated: z.array(ChangelogEntrySchema).max(REGENERATION_LIMITS.entries),
    current: z.array(ChangelogEntrySchema).max(REGENERATION_LIMITS.entries),
    evidence: ChangelogEvidenceSchema,
    docsAuditedSha: z.string().regex(FULL_SHA),
    aiAudit: AiAuditMetadataSchema.optional(),
  })
  .strict();

export type RegenerationArtifactError = {
  readonly type: "InvalidRegenerationArtifact";
  readonly artifact: "plan" | "changelog";
  readonly issues: readonly string[];
};

function artifactIssues(error: z.ZodError): readonly string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "artifact"}: ${issue.message}`,
  );
}

export function parseRegenerationPlanArtifact(
  input: unknown,
): Result<RegenerationPlanArtifact, RegenerationArtifactError> {
  const parsed = RegenerationPlanArtifactSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidRegenerationArtifact",
      artifact: "plan",
      issues: artifactIssues(parsed.error),
    });
  return ok(parsed.data);
}

export function parseRegenerationChangelogArtifact(
  input: unknown,
): Result<RegenerationChangelogArtifact, RegenerationArtifactError> {
  const parsed = RegenerationChangelogArtifactSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidRegenerationArtifact",
      artifact: "changelog",
      issues: artifactIssues(parsed.error),
    });
  return ok(parsed.data);
}

/** Events accepted by the workflow. */
export const REGENERATION_EVENTS = ["push", "workflow_dispatch"] as const;
export type RegenerationEvent = (typeof REGENERATION_EVENTS)[number];

export interface RegenerationEventInput {
  readonly event: RegenerationEvent;
  readonly ref: string;
  readonly actor?: string;
  readonly commitMessage?: string;
  readonly pendingChangesChanged?: boolean;
  readonly selfReleaseMerge?: boolean;
  readonly changesetCleanupMerge?: boolean;
}

export type RegenerationEventError =
  | {
      readonly type: "InvalidRegenerationEvent";
      readonly issues: readonly string[];
    }
  | { readonly type: "RegenerationRefNotMain"; readonly ref: string };

const RegenerationEventSchema = z
  .object({
    event: z.enum(REGENERATION_EVENTS),
    ref: z.string().min(1).max(256),
    actor: z.string().max(128).optional(),
    commitMessage: z.string().max(REGENERATION_LIMITS.messageChars).optional(),
    pendingChangesChanged: z.boolean().default(false),
    selfReleaseMerge: z.boolean().default(false),
    changesetCleanupMerge: z.boolean().default(false),
  })
  .strict();

/**
 * Validates the small event carrier before any GitHub or model port runs.
 * Pushes and manual retries must both target protected `main`.
 */
export function parseRegenerationEvent(
  input: unknown,
): Result<RegenerationEventInput, RegenerationEventError> {
  const parsed = RegenerationEventSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidRegenerationEvent",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "event"}: ${issue.message}`,
      ),
    });
  if (parsed.data.ref !== "refs/heads/main")
    return err({ type: "RegenerationRefNotMain", ref: parsed.data.ref });
  return ok(parsed.data);
}

/** Converts the bounded GitHub environment representation without coercion. */
export function parseRegenerationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Result<RegenerationEventInput, RegenerationEventError> {
  const booleanInput = (
    name: string,
  ): Result<boolean, RegenerationEventError> => {
    const value = env[name];
    if (value === undefined || value === "") return ok(false);
    if (value === "true") return ok(true);
    if (value === "false") return ok(false);
    return err({
      type: "InvalidRegenerationEvent",
      issues: [`${name}: expected true or false`],
    });
  };
  const pending = booleanInput("PENDING_CHANGES_CHANGED");
  if (pending.isErr())
    return err<RegenerationEventInput, RegenerationEventError>(pending.error);
  const selfMerge = booleanInput("SELF_RELEASE_MERGE");
  if (selfMerge.isErr())
    return err<RegenerationEventInput, RegenerationEventError>(selfMerge.error);
  const cleanupMerge = booleanInput("CHANGESET_CLEANUP_MERGE");
  if (cleanupMerge.isErr())
    return err<RegenerationEventInput, RegenerationEventError>(
      cleanupMerge.error,
    );
  const event = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF;
  if (event === undefined || ref === undefined)
    return err({
      type: "InvalidRegenerationEvent",
      issues: ["GITHUB_EVENT_NAME and GITHUB_REF are required"],
    });
  return parseRegenerationEvent({
    event,
    ref,
    actor: env.GITHUB_ACTOR,
    commitMessage: env.GITHUB_COMMIT_MESSAGE,
    pendingChangesChanged: pending.value,
    selfReleaseMerge: selfMerge.value,
    changesetCleanupMerge: cleanupMerge.value,
  });
}

export interface RegenerationSkip {
  readonly kind: "skip";
  readonly reason:
    | "self-release-merge-without-pending-changes"
    | "changeset-cleanup-merge-without-pending-changes";
  readonly attribution: "automatic-main-advance";
}

export interface RegenerationRunDecision {
  readonly kind: "run";
  readonly attribution: RegenerationAttribution;
}

/**
 * Classifies event-only skips. A release merge or cleanup merge is skipped
 * only when it introduced no new or changed pending Changeset. A push that
 * carries a pending Changeset always continues to discovery.
 */
export function classifyRegenerationEvent(
  input: RegenerationEventInput,
): Result<RegenerationRunDecision | RegenerationSkip, RegenerationEventError> {
  const parsed = parseRegenerationEvent(input);
  if (parsed.isErr()) return err(parsed.error);
  const value = parsed.value;
  const selfReleaseMerge =
    value.selfReleaseMerge === true ||
    isSelfReleaseMergeMessage(value.commitMessage ?? "");
  const cleanupMerge =
    value.changesetCleanupMerge === true ||
    isChangesetCleanupMergeMessage(value.commitMessage ?? "");
  if (
    value.event === "push" &&
    value.pendingChangesChanged !== true &&
    selfReleaseMerge
  )
    return ok({
      kind: "skip",
      reason: "self-release-merge-without-pending-changes",
      attribution: "automatic-main-advance",
    });
  if (
    value.event === "push" &&
    value.pendingChangesChanged !== true &&
    cleanupMerge
  )
    return ok({
      kind: "skip",
      reason: "changeset-cleanup-merge-without-pending-changes",
      attribution: "automatic-main-advance",
    });
  return ok({
    kind: "run",
    attribution:
      value.event === "push" ? "automatic-main-advance" : "maintainer-retry",
  });
}

export function isSelfReleaseMergeMessage(message: string): boolean {
  return /chore\(release\):\s+(?:version packages|prepare stable release)/i.test(
    message,
  );
}

export function isChangesetCleanupMergeMessage(message: string): boolean {
  return /chore\(release\):\s+remove consumed changesets/i.test(message);
}

/** A bounded plan artifact handed from the read-only plan job to later jobs. */
export interface RegenerationPlanArtifact {
  readonly baseSha: string;
  readonly expectedHead: string;
  readonly publicImpact: DocsAuditPublicImpactClassification;
  readonly currentEntries: readonly ChangelogEntry[];
  readonly currentEvidence: ChangelogEvidence;
  readonly candidateSources: readonly (readonly ChangesetIdentity[])[];
  readonly evidence: ChangelogEvidence;
}

/** The changelog job returns only prose for entries that need generation. */
export interface RegenerationChangelogArtifact {
  readonly generated: readonly ChangelogEntry[];
  readonly current: readonly ChangelogEntry[];
  readonly evidence: ChangelogEvidence;
  readonly docsAuditedSha: string;
  readonly aiAudit?: PreparedRelease["aiAudit"];
}

export type RegenerationStageError =
  | {
      readonly type: "RegenerationPlanFailed";
      readonly message: string;
      readonly retryable?: boolean;
    }
  | {
      readonly type: "RegenerationDocsAuditFailed";
      readonly error: DocsAuditGateError;
    }
  | {
      readonly type: "RegenerationChangelogFailed";
      readonly message: string;
      readonly retryable?: boolean;
    }
  | {
      readonly type: "RegenerationRenderFailed";
      readonly message: string;
      readonly retryable?: boolean;
    };

export interface RegenerationPlanRequest {
  readonly baseSha: string;
  readonly expectedHead: string;
}

export interface RegenerationDocsAuditRequest {
  readonly baseSha: string;
  readonly expectedHead: string;
  readonly plan: RegenerationPlanArtifact;
}

export interface RegenerationChangelogRequest {
  readonly baseSha: string;
  readonly expectedHead: string;
  readonly plan: RegenerationPlanArtifact;
  readonly docsAudit: DocsAuditGateSuccess;
  readonly generate: readonly ProseReusePlan["regenerate"][number][];
  readonly preserve: readonly ProseReusePlan["reused"][number][];
}

export interface RegenerationRenderRequest {
  readonly baseSha: string;
  readonly entries: readonly ChangelogEntry[];
}

/** Read-only stages and the final renderer. None of these ports mutates refs. */
export interface RegenerationStagePorts {
  readonly computePlan: (
    input: RegenerationPlanRequest,
  ) => ResultAsync<RegenerationPlanArtifact, RegenerationStageError>;
  readonly runDocsAudit: (
    input: RegenerationDocsAuditRequest,
  ) => ResultAsync<DocsAuditGateSuccess, DocsAuditGateError>;
  readonly runChangelogAi: (
    input: RegenerationChangelogRequest,
  ) => ResultAsync<RegenerationChangelogArtifact, RegenerationStageError>;
  readonly render: (
    input: RegenerationRenderRequest,
  ) => ResultAsync<PreparedRelease, RegenerationStageError>;
}

export interface RegenerationDocsFailureContext {
  readonly baseSha: string;
  readonly expectedHead: string;
  readonly pullRequestUrl: string | null;
}

export interface RegenerationBuilderOptions {
  readonly attribution: RegenerationAttribution;
  readonly onDocsAuditFailure?: (
    error: DocsAuditGateError,
    context: Omit<RegenerationDocsFailureContext, "pullRequestUrl">,
  ) => void;
}

/**
 * Creates the Task 9 builder used by the update job. The builder re-runs the
 * full plan/docs/changelog sequence for every CAS attempt, so a lease retry or
 * pre-CAS main advance can never reuse an older docs result or AI submission.
 */
export function createRegenerationBuilder(
  ports: RegenerationStagePorts,
  options: RegenerationBuilderOptions,
): RegenerationBuilder {
  return {
    build: ({ baseSha, expectedHead }) =>
      ports
        .computePlan({ baseSha, expectedHead })
        .mapErr(toPreparationFailure)
        .andThen((plan) => {
          const parsedPlan = parseRegenerationPlanArtifact(plan);
          if (parsedPlan.isErr())
            return errAsync(
              boundedPreparationFailure(
                "plan-rebinding",
                parsedPlan.error.issues.join("; "),
              ),
            );
          const validatedPlan = parsedPlan.value;
          const planCheck = validatePlanArtifact(
            validatedPlan,
            baseSha,
            expectedHead,
          );
          if (planCheck.isErr()) return errAsync(planCheck.error);
          return ports
            .runDocsAudit({
              baseSha,
              expectedHead,
              plan: validatedPlan,
            })
            .mapErr((error) => {
              options.onDocsAuditFailure?.(error, { baseSha, expectedHead });
              return docsAuditPreparationFailure(error);
            })
            .andThen((docsAudit) => {
              if (docsAudit.outcome.auditedSha !== baseSha) {
                const error: DocsAuditGateError = {
                  type: "DocsAuditShaMismatch",
                  auditedShas: [
                    baseSha,
                    validatedPlan.baseSha,
                    docsAudit.outcome.auditedSha,
                    undefined,
                  ],
                };
                options.onDocsAuditFailure?.(error, { baseSha, expectedHead });
                return errAsync<RegenerationDraft, PreparationFailure>(
                  docsAuditPreparationFailure(error),
                );
              }
              const reuse = planProseReuse({
                previous: validatedPlan.currentEntries,
                previousEvidence: validatedPlan.currentEvidence,
                candidates: validatedPlan.candidateSources,
                evidence: validatedPlan.evidence,
              });
              if (reuse.regenerate.length === 0)
                return okAsync<RegenerationDraft, PreparationFailure>({
                  generated: reuse.reused.map(({ entry }) => entry),
                  current: validatedPlan.currentEntries,
                  evidence: validatedPlan.evidence,
                  docsAuditedSha: baseSha,
                });
              return ports
                .runChangelogAi({
                  baseSha,
                  expectedHead,
                  plan: validatedPlan,
                  docsAudit,
                  generate: reuse.regenerate,
                  preserve: reuse.reused,
                })
                .mapErr(toPreparationFailure)
                .andThen((changelog) =>
                  combineChangelogArtifact({
                    baseSha,
                    plan: validatedPlan,
                    reuse,
                    changelog,
                  }),
                );
            });
        }),
    render: ({ baseSha, entries }) =>
      ports
        .render({ baseSha, entries })
        .mapErr(toPreparationFailure)
        .map((prepared) => decorateAttribution(prepared, options.attribution)),
  };
}

/** The explicit check payload written before a docs-blocked run terminates. */
export interface RegenerationBlockingCheck {
  readonly name: typeof REGENERATION_DOCS_CHECK_NAME;
  readonly conclusion: "failure";
  readonly status: "completed";
  readonly auditedSha: string;
  readonly pullRequestUrl: string | null;
  readonly error: DocsAuditGateError;
  readonly mergeBlockedBy: typeof RELEASE_POLICY_CHECK_NAME;
  readonly attribution: RegenerationAttribution;
}

export type RegenerationCheckError = {
  readonly type: "RegenerationBlockingCheckFailed";
  readonly message: string;
};

export interface RegenerationCheckPort {
  readonly publishBlockingCheck: (
    input: RegenerationBlockingCheck,
  ) => ResultAsync<void, RegenerationCheckError>;
}

export interface RegenerationManagerPort {
  readonly discover: (request?: {
    readonly creationPollExhausted?: boolean;
  }) => ResultAsync<ReleasePrState, ReleasePrError>;
  readonly regenerate: (input: {
    readonly builder: RegenerationBuilder;
  }) => ResultAsync<RegenerationOutcome, ReleasePrError>;
  readonly assertStableRequestAuthorized?: (
    actor: string,
  ) => ResultAsync<string, ReleasePrError>;
}

export interface RegenerationMainDependencies {
  readonly manager: RegenerationManagerPort;
  readonly stages: RegenerationStagePorts;
  readonly checks: RegenerationCheckPort;
}

export interface RegenerationMainSuccess {
  readonly trigger: RegenerationEvent;
  readonly attribution: RegenerationAttribution;
  readonly outcome:
    | RegenerationOutcome
    | {
        readonly kind: "Skipped";
        readonly reason: RegenerationSkip["reason"];
      };
}

export type RegenerationMainError =
  | RegenerationEventError
  | ReleasePrError
  | RegenerationCheckError
  | {
      readonly type: "NoReleasePrToRegenerate";
      readonly trigger: "workflow_dispatch";
    }
  | {
      readonly type: "ManualRegenerationAuthorizationUnavailable";
    }
  | {
      readonly type: "RegenerationDocsBlocked";
      readonly check: RegenerationBlockingCheck;
    };

/**
 * Runs one event. Pushes that have no release PR finish green with a neutral
 * no-op. Manual dispatch is deliberately stricter: no release PR is a typed
 * retry failure, never an invitation to create one.
 */
export function runRegenerateMain(
  input: RegenerationEventInput,
  dependencies: RegenerationMainDependencies,
): ResultAsync<RegenerationMainSuccess, RegenerationMainError> {
  const decision = classifyRegenerationEvent(input);
  if (decision.isErr()) return errAsync(decision.error);
  if (decision.value.kind === "skip")
    return okAsync({
      trigger: input.event,
      attribution: decision.value.attribution,
      outcome: { kind: "Skipped", reason: decision.value.reason },
    });
  const runDecision: RegenerationRunDecision = decision.value;

  const authorized =
    input.event !== "workflow_dispatch"
      ? okAsync<string, RegenerationMainError>(input.actor ?? "github-actions")
      : authorizeManualRetry(input, dependencies.manager);
  return authorized.andThen(() =>
    runRegenerationAfterAuthorization(input, runDecision, dependencies),
  );
}

function authorizeManualRetry(
  input: RegenerationEventInput,
  manager: RegenerationManagerPort,
): ResultAsync<string, RegenerationMainError> {
  if (input.actor === undefined || input.actor.length === 0)
    return errAsync({ type: "ManualRegenerationAuthorizationUnavailable" });
  if (manager.assertStableRequestAuthorized === undefined)
    return errAsync({ type: "ManualRegenerationAuthorizationUnavailable" });
  return manager.assertStableRequestAuthorized(input.actor);
}

function runRegenerationAfterAuthorization(
  input: RegenerationEventInput,
  decision: RegenerationRunDecision,
  dependencies: RegenerationMainDependencies,
): ResultAsync<RegenerationMainSuccess, RegenerationMainError> {
  return dependencies.manager.discover().andThen((state) => {
    if (state.kind === "absent" || state.kind === "pending-merged-release") {
      if (input.event === "push")
        return okAsync<RegenerationMainSuccess, RegenerationMainError>({
          trigger: input.event,
          attribution: decision.attribution,
          outcome: { kind: "NoReleasePrToRegenerate" },
        });
      return errAsync<RegenerationMainSuccess, RegenerationMainError>({
        type: "NoReleasePrToRegenerate",
        trigger: "workflow_dispatch",
      });
    }

    let docsFailure: {
      error: DocsAuditGateError;
      context: Omit<RegenerationDocsFailureContext, "pullRequestUrl">;
    } | null = null;
    const builder = createRegenerationBuilder(dependencies.stages, {
      attribution: decision.attribution,
      onDocsAuditFailure: (error, context) => {
        docsFailure = { error, context };
      },
    });
    const result = dependencies.manager.regenerate({ builder });
    return result
      .andThen((outcome) => {
        if (
          input.event === "workflow_dispatch" &&
          outcome.kind === "NoReleasePrToRegenerate"
        )
          return errAsync<RegenerationMainSuccess, RegenerationMainError>({
            type: "NoReleasePrToRegenerate",
            trigger: "workflow_dispatch",
          });
        return okAsync<RegenerationMainSuccess, RegenerationMainError>({
          trigger: input.event,
          attribution: decision.attribution,
          outcome,
        });
      })
      .mapErr((error): RegenerationMainError => error)
      .orElse((error) => {
        if (docsFailure === null) return errAsync(error);
        const target = releasePullRequestUrl(state);
        const check: RegenerationBlockingCheck = {
          name: REGENERATION_DOCS_CHECK_NAME,
          conclusion: "failure",
          status: "completed",
          auditedSha: docsFailure.context.baseSha,
          pullRequestUrl: target,
          error: docsFailure.error,
          mergeBlockedBy: RELEASE_POLICY_CHECK_NAME,
          attribution: decision.attribution,
        };
        return dependencies.checks
          .publishBlockingCheck(check)
          .map(() => undefined)
          .mapErr((checkError): RegenerationMainError => checkError)
          .andThen(() =>
            errAsync<RegenerationMainSuccess, RegenerationMainError>({
              type: "RegenerationDocsBlocked",
              check,
            }),
          );
      });
  });
}

function releasePullRequestUrl(state: ReleasePrState): string | null {
  if (state.kind === "live" || state.kind === "pr-metadata-pending")
    return state.pullRequest.url;
  if (state.kind === "marker-cleanup-pending") return state.pullRequest.url;
  return null;
}

function boundedPreparationFailure(
  stage: PreparationFailure["stage"],
  message: string,
): PreparationFailure {
  return { stage, message, retryable: false };
}

function validateIdentitySet(
  sources: readonly ChangesetIdentity[],
  label: string,
): string | null {
  if (sources.length === 0 || sources.length > CHANGELOG_LIMITS.entryChangesets)
    return `${label} must contain between one and ${CHANGELOG_LIMITS.entryChangesets} identities`;
  const seen = new Set<string>();
  for (const source of sources) {
    if (
      source.id.length === 0 ||
      source.id.length > REGENERATION_LIMITS.pathChars
    )
      return `${label} contains an invalid changeset id`;
    if (!/^[0-9a-f]{64}$/.test(source.sourceDigest))
      return `${label} contains an invalid changeset digest`;
    const key = `${source.id}@${source.sourceDigest}`;
    if (seen.has(key)) return `${label} contains a duplicate identity`;
    seen.add(key);
  }
  return null;
}

function validateEntryCollection(
  entries: readonly ChangelogEntry[],
  label: string,
): string | null {
  if (entries.length > REGENERATION_LIMITS.entries)
    return `${label} exceeds the entry bound`;
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (
      entry.prose.length === 0 ||
      entry.prose.length > CHANGELOG_LIMITS.proseLength
    )
      return `${label}[${index}] prose exceeds the changelog bound`;
    const identityError = validateIdentitySet(
      entry.sourceChangesets,
      `${label}[${index}].sourceChangesets`,
    );
    if (identityError !== null) return identityError;
    const key = entryIdentityKey(entry.sourceChangesets);
    if (seen.has(key)) return `${label} contains a duplicate identity set`;
    seen.add(key);
    if ((entry.refs?.length ?? 0) > CHANGELOG_LIMITS.entryRefs)
      return `${label}[${index}] refs exceed the changelog bound`;
    for (const ref of entry.refs ?? []) {
      if (
        ref.kind === "pull-request" &&
        (!Number.isSafeInteger(ref.number) ||
          ref.number < 1 ||
          ref.number > CHANGELOG_LIMITS.pullRequestNumber)
      )
        return `${label}[${index}] contains an invalid pull request ref`;
      if (ref.kind === "commit" && !/^[0-9a-f]{7,40}$/.test(ref.commit))
        return `${label}[${index}] contains an invalid commit ref`;
    }
  }
  return null;
}

function validateEvidence(
  evidence: ChangelogEvidence,
  label: string,
): string | null {
  if ((evidence.pullRequests?.length ?? 0) > REGENERATION_LIMITS.refs)
    return `${label} pull-request refs exceed the bound`;
  if ((evidence.commits?.length ?? 0) > REGENERATION_LIMITS.refs)
    return `${label} commit refs exceed the bound`;
  for (const number of evidence.pullRequests ?? []) {
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > CHANGELOG_LIMITS.pullRequestNumber
    )
      return `${label} contains an invalid pull request ref`;
  }
  for (const commit of evidence.commits ?? []) {
    if (!/^[0-9a-f]{7,40}$/.test(commit))
      return `${label} contains an invalid commit ref`;
  }
  return null;
}

function validatePlanArtifact(
  plan: RegenerationPlanArtifact,
  baseSha: string,
  expectedHead: string,
): Result<void, PreparationFailure> {
  if (!FULL_SHA.test(baseSha) || !FULL_SHA.test(expectedHead))
    return err(
      boundedPreparationFailure(
        "plan-rebinding",
        "regeneration plan heads must be full lowercase SHA values",
      ),
    );
  if (plan.baseSha !== baseSha || plan.expectedHead !== expectedHead)
    return err(
      boundedPreparationFailure(
        "plan-rebinding",
        "regeneration plan is not bound to the requested marker and main heads",
      ),
    );
  if (
    plan.publicImpact !== "public-impact" &&
    plan.publicImpact !== "no-impact"
  )
    return err(
      boundedPreparationFailure(
        "plan-rebinding",
        "regeneration plan has an unknown public-impact classification",
      ),
    );
  const entriesError = validateEntryCollection(
    plan.currentEntries,
    "regeneration plan current entries",
  );
  if (entriesError !== null)
    return err(boundedPreparationFailure("plan-rebinding", entriesError));
  if (plan.candidateSources.length > REGENERATION_LIMITS.identitySets)
    return err(
      boundedPreparationFailure(
        "plan-rebinding",
        "regeneration plan identity sets exceed the bound",
      ),
    );
  const candidateKeys = new Set<string>();
  for (const [index, sources] of plan.candidateSources.entries()) {
    const identityError = validateIdentitySet(
      sources,
      `regeneration plan identity set ${index}`,
    );
    if (identityError !== null)
      return err(boundedPreparationFailure("plan-rebinding", identityError));
    const key = entryIdentityKey(sources);
    if (candidateKeys.has(key))
      return err(
        boundedPreparationFailure(
          "plan-rebinding",
          "regeneration plan contains a duplicate identity set",
        ),
      );
    candidateKeys.add(key);
  }
  const currentEvidenceError = validateEvidence(
    plan.currentEvidence,
    "regeneration plan current evidence",
  );
  if (currentEvidenceError !== null)
    return err(
      boundedPreparationFailure("plan-rebinding", currentEvidenceError),
    );
  const evidenceError = validateEvidence(
    plan.evidence,
    "regeneration plan evidence",
  );
  if (evidenceError !== null)
    return err(boundedPreparationFailure("plan-rebinding", evidenceError));
  return ok(undefined);
}

function combineChangelogArtifact(input: {
  baseSha: string;
  plan: RegenerationPlanArtifact;
  reuse: ProseReusePlan;
  changelog: RegenerationChangelogArtifact;
}): ResultAsync<RegenerationDraft, PreparationFailure> {
  const parsedChangelog = parseRegenerationChangelogArtifact(input.changelog);
  if (parsedChangelog.isErr())
    return errAsync(
      boundedPreparationFailure(
        "changelog-ai",
        parsedChangelog.error.issues.join("; "),
      ),
    );
  const changelog = parsedChangelog.value;
  const generatedError = validateEntryCollection(
    changelog.generated,
    "changelog AI generated entries",
  );
  if (generatedError !== null)
    return errAsync(boundedPreparationFailure("changelog-ai", generatedError));
  const currentError = validateEntryCollection(
    changelog.current,
    "changelog AI current entries",
  );
  if (currentError !== null)
    return errAsync(boundedPreparationFailure("changelog-ai", currentError));
  const evidenceError = validateEvidence(
    changelog.evidence,
    "changelog AI evidence",
  );
  if (evidenceError !== null)
    return errAsync(boundedPreparationFailure("changelog-ai", evidenceError));
  if (changelog.docsAuditedSha !== input.baseSha)
    return errAsync({
      stage: "changelog-ai",
      message: "changelog AI result is not bound to the docs-audited main head",
      retryable: false,
    });
  if (
    evidenceDigest(changelog.evidence) !== evidenceDigest(input.plan.evidence)
  )
    return errAsync({
      stage: "changelog-ai",
      message: "changelog AI evidence differs from the planned evidence",
      retryable: false,
    });
  const requested = new Set(
    input.reuse.regenerate.map(({ sources }) => entryIdentityKey(sources)),
  );
  const generated = new Map<string, ChangelogEntry>();
  for (const entry of changelog.generated) {
    const key = entryIdentityKey(entry.sourceChangesets);
    if (!requested.has(key))
      return errAsync({
        stage: "changelog-ai",
        message:
          "changelog AI returned an entry outside the requested identity set",
        retryable: false,
      });
    generated.set(key, entry);
  }
  const preserved = new Map(
    input.reuse.reused.map(({ entry }) => [
      entryIdentityKey(entry.sourceChangesets),
      entry,
    ]),
  );
  const all: ChangelogEntry[] = [];
  for (const sources of input.plan.candidateSources) {
    const key = entryIdentityKey(sources);
    const entry = generated.get(key) ?? preserved.get(key);
    if (entry === undefined)
      return errAsync({
        stage: "changelog-ai",
        message: "changelog AI omitted a new or changed identity set",
        retryable: false,
      });
    all.push(entry);
  }
  if (all.length > REGENERATION_LIMITS.entries)
    return errAsync({
      stage: "changelog-ai",
      message: "regeneration entries exceed the bound",
      retryable: false,
    });
  return okAsync({
    generated: all,
    current: input.plan.currentEntries,
    evidence: changelog.evidence,
    docsAuditedSha: changelog.docsAuditedSha,
    aiAudit: changelog.aiAudit,
  });
}

function docsAuditPreparationFailure(
  error: DocsAuditGateError,
): PreparationFailure {
  return {
    stage: "docs-gate",
    message: error.type,
    retryable: false,
  };
}

function toPreparationFailure(
  error: RegenerationStageError,
): PreparationFailure {
  switch (error.type) {
    case "RegenerationPlanFailed":
      return {
        stage: "plan-rebinding",
        message: error.message,
        retryable: error.retryable,
      };
    case "RegenerationDocsAuditFailed":
      return docsAuditPreparationFailure(error.error);
    case "RegenerationChangelogFailed":
      return {
        stage: "changelog-ai",
        message: error.message,
        retryable: error.retryable,
      };
    case "RegenerationRenderFailed":
      return {
        stage: "prepared-commit",
        message: error.message,
        retryable: error.retryable,
      };
  }
}

function decorateAttribution(
  prepared: PreparedRelease,
  attribution: RegenerationAttribution,
): PreparedRelease {
  const marker =
    attribution === "automatic-main-advance"
      ? AUTOMATIC_REGENERATION_MARKER
      : MAINTAINER_RETRY_REGENERATION_MARKER;
  if (prepared.body.includes(marker)) return prepared;
  return {
    ...prepared,
    body: `${prepared.body.trimEnd()}\n\n${marker}\n`,
  };
}

export type RegenerationCliError =
  | {
      readonly type: "InvalidRegenerationCommand";
      readonly issues: readonly string[];
    }
  | { readonly type: "InvalidRegenerationAttempt"; readonly attempt: string };

export interface RegenerationMainCliOptions {
  readonly phase: RegenerationPhase;
  readonly attempt: number;
  readonly event?: RegenerationEvent;
  readonly ref?: string;
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly planPath?: string;
  readonly docsAuditPath?: string;
  readonly changelogPath?: string;
  readonly reportCheck?: boolean;
}

const CliPathSchema = z
  .string()
  .min(1)
  .max(REGENERATION_LIMITS.pathChars)
  .refine(SAFE_PATH, "path must be a bounded safe path");

/** Parses only the bounded command carrier; it does not perform a mutation. */
export function parseRegenerateMainArgs(
  argv: readonly string[],
): Result<RegenerationMainCliOptions, RegenerationCliError> {
  const values: Record<string, string> = {};
  const allowedKeys = new Set([
    "phase",
    "attempt",
    "event",
    "ref",
    "input",
    "output",
    "plan",
    "docs-audit",
    "changelog",
    "report-check",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--"))
      return err({
        type: "InvalidRegenerationCommand",
        issues: ["unknown argument"],
      });
    const key = token.slice(2);
    if (!allowedKeys.has(key))
      return err({
        type: "InvalidRegenerationCommand",
        issues: [`unknown option --${key}`],
      });
    if (Object.hasOwn(values, key))
      return err({
        type: "InvalidRegenerationCommand",
        issues: [`duplicate option --${key}`],
      });
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return err({
        type: "InvalidRegenerationCommand",
        issues: [`--${key} requires a value`],
      });
    values[key] = value;
    index += 1;
  }
  const attemptText = values.attempt ?? "1";
  const attempt = Number(attemptText);
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > REGENERATION_LIMITS.attempts
  )
    return err({ type: "InvalidRegenerationAttempt", attempt: attemptText });
  const parsed = z
    .object({
      phase: z.enum(REGENERATION_PHASES),
      attempt: z.number().int().positive().max(REGENERATION_LIMITS.attempts),
      event: z.enum(REGENERATION_EVENTS).optional(),
      ref: z.string().max(256).optional(),
      inputPath: CliPathSchema.optional(),
      outputPath: CliPathSchema.optional(),
      planPath: CliPathSchema.optional(),
      docsAuditPath: CliPathSchema.optional(),
      changelogPath: CliPathSchema.optional(),
      reportCheck: z.boolean().optional(),
    })
    .strict()
    .safeParse({
      phase: values.phase,
      attempt,
      ...(values.event === undefined ? {} : { event: values.event }),
      ...(values.ref === undefined ? {} : { ref: values.ref }),
      ...(values.input === undefined ? {} : { inputPath: values.input }),
      ...(values.output === undefined ? {} : { outputPath: values.output }),
      ...(values.plan === undefined ? {} : { planPath: values.plan }),
      ...(values["docs-audit"] === undefined
        ? {}
        : { docsAuditPath: values["docs-audit"] }),
      ...(values.changelog === undefined
        ? {}
        : { changelogPath: values.changelog }),
      ...(values["report-check"] === undefined
        ? {}
        : { reportCheck: values["report-check"] === "true" }),
    });
  if (!parsed.success)
    return err({
      type: "InvalidRegenerationCommand",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

/** Alias used by workflow adapters and tests. */
export const parseRegenerationMainArgs = parseRegenerateMainArgs;

export function runRegenerateMainCli(
  argv: readonly string[],
): Result<RegenerationMainCliOptions, RegenerationCliError> {
  return parseRegenerateMainArgs(argv);
}

/** Bounded, secret-free summary text for a typed docs blocking result. */
export function renderRegenerationBlockingSummary(
  check: RegenerationBlockingCheck,
): Result<
  string,
  { readonly type: "RegenerationSummaryTooLarge"; readonly bytes: number }
> {
  const text = [
    "## Stable release PR regeneration blocked",
    `check: ${check.name}`,
    `conclusion: ${check.conclusion}`,
    `auditedSha: ${check.auditedSha}`,
    `pullRequest: ${check.pullRequestUrl ?? "none"}`,
    `reason: ${check.error.type}`,
    `merge gate: ${check.mergeBlockedBy}`,
    `attribution: ${check.attribution}`,
    "The release PR and marker were not mutated.",
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > REGENERATION_LIMITS.summaryBytes)
    return err({ type: "RegenerationSummaryTooLarge", bytes });
  return ok(text);
}

if (import.meta.main) {
  const parsed = runRegenerateMainCli(Bun.argv.slice(2));
  if (parsed.isErr()) {
    log.error({ error: parsed.error }, "invalid stable regeneration command");
    process.exitCode = 2;
  } else {
    const event = parseRegenerationEnvironment(Bun.env);
    if (event.isErr()) {
      log.error({ error: event.error }, "invalid stable regeneration event");
      process.exitCode = 2;
    } else {
      const decision = classifyRegenerationEvent(event.value);
      if (decision.isErr()) {
        log.error(
          { error: decision.error },
          "stable regeneration event rejected",
        );
        process.exitCode = 2;
      } else {
        log.info(
          {
            phase: parsed.value.phase,
            attempt: parsed.value.attempt,
            event: event.value.event,
            attribution:
              decision.value.kind === "skip"
                ? decision.value.attribution
                : decision.value.attribution,
          },
          "stable regeneration phase validated",
        );
      }
    }
  }
}
