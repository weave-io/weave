/**
 * Stable release-PR preparation controller.
 *
 * This module is the request boundary for the stable release workflow. It
 * deliberately separates the data-producing stages (plan, docs gate, and
 * changelog AI) from Task 9's mutation boundary. The first stages run before
 * marker ownership. The final call delegates creation, freshness replans, race
 * handling, and transactional cleanup to {@link StableReleasePrManager}.
 *
 * The controller has no GitHub or model singleton. Workflow code supplies
 * ports, which keeps tests hermetic and keeps credentials in the job that
 * needs them.
 */
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  type AiAuditMetadata,
  createAiAuditMetadata,
} from "./ai/audit-metadata.js";
import {
  type ChangelogAgentError,
  type ChangelogAgentResult,
  type ChangelogAgentVersion,
  runChangelogAgent,
} from "./ai/changelog-agent.js";
import type { BoundedEvidence } from "./ai/evidence.js";
import {
  CHANGELOG_AGENT_DEFAULT_THINKING,
  HEADLESS_THINKING_LEVELS,
  type HeadlessSessionDriver,
  type HeadlessThinkingLevel,
} from "./ai/headless-session.js";
import type {
  ChangelogDocument,
  ChangelogEntry,
  ChangelogEvidence,
} from "./changelog-format.js";
import { parseChangelog } from "./changelog-format.js";
import type { ChangesetIdentity } from "./changeset-policy.js";
import { PUBLIC_PACKAGES, type PublicPackageName } from "./constants.js";
import {
  type DocsAuditAgentError,
  type DocsAuditAgentInput,
  type DocsAuditAgentResult,
  runDocsAuditAgent,
} from "./docs-audit/agent.js";
import {
  type DeterministicDocsCheckError,
  type DeterministicDocsCheckResult,
  docsAuditDigest,
  runDeterministicDocsCheck,
} from "./docs-audit/deterministic.js";
import {
  combineDocsAuditGate,
  type DocsAuditAiInput,
  type DocsAuditDeterministicInput,
  type DocsAuditFollowUpInput,
  type DocsAuditGateError,
  type DocsAuditGateSuccess,
  type DocsAuditPublicImpactClassification,
} from "./docs-audit/gate.js";
import type { GitHubError } from "./errors.js";
import type { GitHubCommitFile } from "./github-client.js";
import type {
  ReleasePlanChangelogDigest,
  ReleasePlanVersion,
} from "./release-plan.js";
import {
  type AbortOwnedCreationOutcome,
  type CreatedReleasePr,
  type CreationPreparer,
  type MergedReleaseObservation,
  type PreparationFailure,
  type PreparedRelease,
  preparationBlock,
  RELEASE_PR_BOUNDS,
  type ReleaseChange,
  type ReleasePrError,
  type ReleasePrOwnership,
  type ReleasePrState,
} from "./release-pr.js";
import type { SelectionClosure } from "./selection-closure.js";

const log = logger.child({ module: "prepare-main" });

/** Four and only four workflow dispatch checkboxes. */
export const PREPARE_PACKAGE_INPUTS = [
  "cli",
  "opencode",
  "claude-code",
  "pi",
] as const;
export type PreparePackageInput = (typeof PREPARE_PACKAGE_INPUTS)[number];

/** The fixed catalog order used for selection and every serialized artifact. */
const PREPARE_PACKAGE_NAMES: Readonly<
  Record<PreparePackageInput, PublicPackageName>
> = {
  cli: "@weaveio/weave-cli",
  opencode: "@weaveio/weave-adapter-opencode",
  "claude-code": "@weaveio/weave-adapter-claude-code",
  pi: "@weaveio/weave-adapter-pi",
};

/**
 * Dispatch input is strict. GitHub sends boolean inputs as strings through
 * environment variables, so {@link parsePrepareEnvironment} performs the
 * only explicit string-to-boolean conversion at that boundary.
 */
export const PrepareInputSchema = z
  .object({
    cli: z.boolean(),
    opencode: z.boolean(),
    claudeCode: z.boolean(),
    pi: z.boolean(),
    thinking: z
      .enum(HEADLESS_THINKING_LEVELS)
      .default(CHANGELOG_AGENT_DEFAULT_THINKING),
  })
  .strict();

export type StablePrepareInput = z.infer<typeof PrepareInputSchema>;

export type PrepareInputError =
  | {
      readonly type: "InvalidPrepareInput";
      readonly issues: readonly string[];
    }
  | { readonly type: "EmptySelection" };

export function parsePrepareInput(
  input: unknown,
): Result<StablePrepareInput, PrepareInputError> {
  const parsed = PrepareInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidPrepareInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
      ),
    });
  return selectPackages(parsed.data).map(() => parsed.data);
}

/** Converts GitHub Actions' environment representation without coercing junk. */
export function parsePrepareEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Result<StablePrepareInput, PrepareInputError> {
  const booleanInput = (name: string): boolean | undefined => {
    const value = env[name];
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  };
  const raw = {
    cli: booleanInput("INPUT_CLI"),
    opencode: booleanInput("INPUT_OPENCODE"),
    claudeCode: booleanInput("INPUT_CLAUDE_CODE"),
    pi: booleanInput("INPUT_PI"),
    thinking: env.INPUT_THINKING ?? CHANGELOG_AGENT_DEFAULT_THINKING,
  };
  return parsePrepareInput(raw);
}

/** Returns the selected package names in catalog order, or a typed empty set. */
export function selectPackages(
  input: Pick<StablePrepareInput, "cli" | "opencode" | "claudeCode" | "pi">,
): Result<readonly PublicPackageName[], PrepareInputError> {
  const selected = PREPARE_PACKAGE_INPUTS.filter((name) => {
    if (name === "claude-code") return input.claudeCode;
    return input[name];
  }).map((name) => PREPARE_PACKAGE_NAMES[name]);
  if (selected.length === 0) return err({ type: "EmptySelection" });
  return ok(selected);
}

/** One plan result handed from the deterministic plan stage to later jobs. */
export interface StableReleasePlan {
  readonly baseSha: string;
  readonly seed: readonly PublicPackageName[];
  readonly closure: SelectionClosure;
  readonly consumed: readonly ChangesetIdentity[];
  readonly versions: readonly ReleasePlanVersion[];
  readonly changelogDigests?: readonly ReleasePlanChangelogDigest[];
  readonly evidence: BoundedEvidence;
  readonly changelogEvidence: ChangelogEvidence;
  readonly publicImpact: DocsAuditPublicImpactClassification;
  readonly title: string;
  readonly body: string;
  readonly commitSubject: string;
  readonly manifestFiles: readonly GitHubCommitFile[];
  readonly manifestChanges: readonly ReleaseChange[];
  /** Task 8's canonical hidden plan block, when the planner has rendered it. */
  readonly planMetadataBlock?: string;
  /** Filesystem root whose exact tree was used by the docs gate. */
  readonly contentRoot?: string;
}

/** Result of Task 17's isolated changelog-AI job. */
export interface StableChangelogPreparation {
  readonly entries: readonly ChangelogEntry[];
  readonly files: readonly GitHubCommitFile[];
  readonly changes: readonly ReleaseChange[];
  readonly aiAudit?: AiAuditMetadata;
}

/** Errors at a pre-ownership stage retain the stage and, for docs, the gate. */
export type PrepareStageError =
  | {
      readonly type: "PreparePlanFailed";
      readonly message: string;
      readonly retryable?: boolean;
    }
  | {
      readonly type: "PrepareDocsAuditFailed";
      readonly error: DocsAuditGateError;
    }
  | {
      readonly type: "PrepareChangelogFailed";
      readonly message: string;
      readonly retryable?: boolean;
    }
  | {
      readonly type: "PrepareRenderFailed";
      readonly message: string;
      readonly retryable?: boolean;
    };

export interface PreparePlanRequest {
  readonly baseSha: string;
  readonly seed: readonly PublicPackageName[];
  readonly previous: PreparedRelease | null;
  readonly thinking: HeadlessThinkingLevel;
}

export interface PrepareDocsAuditRequest {
  readonly baseSha: string;
  readonly plan: StableReleasePlan;
  readonly previous: PreparedRelease | null;
  readonly thinking: HeadlessThinkingLevel;
}

export interface PrepareChangelogRequest {
  readonly baseSha: string;
  readonly plan: StableReleasePlan;
  readonly docsAudit: DocsAuditGateSuccess;
  readonly previous: PreparedRelease | null;
  readonly thinking: HeadlessThinkingLevel;
}

export interface PrepareRenderRequest {
  readonly baseSha: string;
  readonly plan: StableReleasePlan;
  readonly docsAudit: DocsAuditGateSuccess;
  readonly changelog: StableChangelogPreparation;
  readonly previous: PreparedRelease | null;
}

/** Pure data-producing ports. No port is allowed to mutate release refs. */
export interface StablePreparationPorts {
  readonly computePlan: (
    input: PreparePlanRequest,
  ) => ResultAsync<StableReleasePlan, PrepareStageError>;
  readonly runDocsAudit: (
    input: PrepareDocsAuditRequest,
  ) => ResultAsync<DocsAuditGateSuccess, PrepareStageError>;
  readonly runChangelogAi: (
    input: PrepareChangelogRequest,
  ) => ResultAsync<StableChangelogPreparation, PrepareStageError>;
  readonly renderPrepared?: (
    input: PrepareRenderRequest,
  ) => ResultAsync<PreparedRelease, PrepareStageError>;
}

/** The subset of Task 9 used by the request path. */
export interface StablePrepareReleasePrPort {
  assertStableRequestAuthorized(
    actor: string,
  ): ResultAsync<string, ReleasePrError>;
  discover(request?: {
    readonly creationPollExhausted?: boolean;
  }): ResultAsync<ReleasePrState, ReleasePrError>;
  createStableReleasePr(request: {
    readonly plannedBaseSha: string;
    readonly preparer: CreationPreparer;
  }): ResultAsync<CreatedReleasePr, ReleasePrError>;
  /**
   * The explicit phase surface lets a workflow keep AI artifacts in the AI
   * jobs. Task 9's combined create method remains available for callers that
   * already run all phases in one trusted process.
   */
  readonly acquireCreationOwnership?: (request: {
    readonly plannedBaseSha: string;
  }) => ResultAsync<ReleasePrOwnership, ReleasePrError>;
  readonly finalizeCreation?: (request: {
    readonly ownership: ReleasePrOwnership;
    readonly prepared: PreparedRelease;
  }) => ResultAsync<CreatedReleasePr, ReleasePrError>;
  readonly abortOwnedCreation?: (request: {
    readonly ownership: ReleasePrOwnership;
    readonly reconcile?: boolean;
  }) => ResultAsync<AbortOwnedCreationOutcome, ReleasePrError>;
}

export interface StablePrepareDependencies extends StablePreparationPorts {
  readonly manager: StablePrepareReleasePrPort;
  readonly readGreenMainHead: () => ResultAsync<string, GitHubError>;
}

export interface PrepareMainSuccess {
  readonly selected: readonly PublicPackageName[];
  readonly plannedBaseSha: string;
  readonly created: CreatedReleasePr;
}

export type PrepareMainError =
  | PrepareInputError
  | PrepareStageError
  | ReleasePrError
  | {
      readonly type: "PreparePortFailed";
      readonly operation:
        | "readGreenMainHead"
        | "acquireCreationOwnership"
        | "finalizeCreation"
        | "abortOwnedCreation";
      readonly message: string;
    }
  | {
      readonly type: "InvalidPlannedBaseSha";
      readonly sha: string;
    };

/**
 * Runs one complete request. Authorization and the green-main/preparation
 * block happen before the first plan, docs, or model call. Task 9 then owns
 * marker creation, bounded freshness replans, races, and cleanup.
 */
export function runPrepareMain(
  input: StablePrepareInput,
  actor: string,
  dependencies: StablePrepareDependencies,
): ResultAsync<PrepareMainSuccess, PrepareMainError> {
  const selected = selectPackages(input);
  if (selected.isErr()) return errAsync(selected.error);

  return dependencies.manager
    .assertStableRequestAuthorized(actor)
    .andThen(() =>
      dependencies.readGreenMainHead().mapErr(
        (error): PrepareMainError => ({
          type: "PreparePortFailed",
          operation: "readGreenMainHead",
          message: error.message,
        }),
      ),
    )
    .andThen((plannedBaseSha) => {
      if (!/^[0-9a-f]{40}$/.test(plannedBaseSha))
        return errAsync<PrepareMainSuccess, PrepareMainError>({
          type: "InvalidPlannedBaseSha",
          sha: plannedBaseSha,
        });
      return dependencies.manager.discover().andThen((state) => {
        const blocked = preparationBlock(state);
        if (blocked !== null)
          return errAsync<PrepareMainSuccess, PrepareMainError>(blocked);

        let initial: PreparedRelease | undefined;
        const prepare = (
          baseSha: string,
          previous: PreparedRelease | null,
        ): ResultAsync<PreparedRelease, PreparationFailure> => {
          if (
            initial !== undefined &&
            previous === null &&
            baseSha === plannedBaseSha
          )
            return okAsync(initial);
          return prepareAt(
            {
              baseSha,
              seed: selected.value,
              previous,
              thinking: input.thinking,
            },
            dependencies,
          ).mapErr(toPreparationFailure);
        };

        return prepareAt(
          {
            baseSha: plannedBaseSha,
            seed: selected.value,
            previous: null,
            thinking: input.thinking,
          },
          dependencies,
        ).andThen((prepared) => {
          initial = prepared;
          const explicitPhases =
            dependencies.manager.acquireCreationOwnership !== undefined &&
            dependencies.manager.finalizeCreation !== undefined &&
            dependencies.manager.abortOwnedCreation !== undefined;
          if (explicitPhases)
            return runPreparedCreation(
              {
                selected: selected.value,
                plannedBaseSha,
                prepared,
                reprepare: ({ baseSha, previous }) =>
                  prepare(baseSha, previous),
              },
              dependencies.manager,
            );
          return dependencies.manager
            .createStableReleasePr({
              plannedBaseSha,
              preparer: {
                prepare: ({ baseSha, previous }) => prepare(baseSha, previous),
              },
            })
            .map((created) => ({
              selected: selected.value,
              plannedBaseSha,
              created,
            }));
        });
      });
    });
}

/**
 * Finalizes a prepared artifact through Task 9's explicit ownership phases.
 *
 * The initial plan/docs/changelog work can run in read-only jobs. Only this
 * function needs the App-backed ownership port. A stale head carries the new
 * ownership identity forward; the caller regenerates all content at that head
 * and retries. A failed replan is cleaned through the same owner-generation
 * checked abort path before it is returned.
 */
export function runPreparedCreation(
  request: {
    readonly selected: readonly PublicPackageName[];
    readonly plannedBaseSha: string;
    readonly prepared: PreparedRelease;
    readonly reprepare: (input: {
      readonly baseSha: string;
      readonly previous: PreparedRelease;
    }) => ResultAsync<PreparedRelease, PreparationFailure>;
  },
  manager: StablePrepareReleasePrPort,
): ResultAsync<PrepareMainSuccess, PrepareMainError> {
  const acquire = manager.acquireCreationOwnership;
  const finalize = manager.finalizeCreation;
  const abort = manager.abortOwnedCreation;
  if (acquire === undefined || finalize === undefined || abort === undefined) {
    let operation:
      | "acquireCreationOwnership"
      | "finalizeCreation"
      | "abortOwnedCreation";
    if (acquire === undefined) operation = "acquireCreationOwnership";
    else if (finalize === undefined) operation = "finalizeCreation";
    else operation = "abortOwnedCreation";
    return errAsync({
      type: "PreparePortFailed",
      operation,
      message: "Task 9 explicit creation phases are not available",
    });
  }
  if (request.prepared.baseSha !== request.plannedBaseSha)
    return errAsync({
      type: "PrepareRenderFailed",
      message: `prepared baseSha ${request.prepared.baseSha} does not equal planned ${request.plannedBaseSha}`,
      retryable: false,
    });

  return acquire({ plannedBaseSha: request.plannedBaseSha }).andThen(
    (ownership) =>
      finalizeAttempt(ownership, request.prepared, 1, request, finalize, abort),
  );
}

function finalizeAttempt(
  ownership: ReleasePrOwnership,
  prepared: PreparedRelease,
  attempt: number,
  request: {
    readonly selected: readonly PublicPackageName[];
    readonly plannedBaseSha: string;
    readonly prepared: PreparedRelease;
    readonly reprepare: (input: {
      readonly baseSha: string;
      readonly previous: PreparedRelease;
    }) => ResultAsync<PreparedRelease, PreparationFailure>;
  },
  finalize: NonNullable<StablePrepareReleasePrPort["finalizeCreation"]>,
  abort: NonNullable<StablePrepareReleasePrPort["abortOwnedCreation"]>,
): ResultAsync<PrepareMainSuccess, PrepareMainError> {
  return ResultAsync.fromPromise(
    finalizeAttemptValue(
      ownership,
      prepared,
      attempt,
      request,
      finalize,
      abort,
    ),
    (cause): PrepareMainError => ({
      type: "PreparePortFailed",
      operation: "finalizeCreation",
      message: String(cause),
    }),
  ).andThen((result) => result);
}

async function finalizeAttemptValue(
  ownership: ReleasePrOwnership,
  prepared: PreparedRelease,
  attempt: number,
  request: {
    readonly selected: readonly PublicPackageName[];
    readonly plannedBaseSha: string;
    readonly prepared: PreparedRelease;
    readonly reprepare: (input: {
      readonly baseSha: string;
      readonly previous: PreparedRelease;
    }) => ResultAsync<PreparedRelease, PreparationFailure>;
  },
  finalize: NonNullable<StablePrepareReleasePrPort["finalizeCreation"]>,
  abort: NonNullable<StablePrepareReleasePrPort["abortOwnedCreation"]>,
): Promise<Result<PrepareMainSuccess, PrepareMainError>> {
  const finalized = await finalize({ ownership, prepared });
  if (finalized.isOk())
    return ok({
      selected: request.selected,
      plannedBaseSha: request.plannedBaseSha,
      created: finalized.value,
    });
  const error = finalized.error;
  if (error.type !== "PreparationStale") return err(error);
  if (attempt >= RELEASE_PR_BOUNDS.freshnessAttempts)
    return await abortAfterOwnedFailure(abort, error.ownership, (outcome) =>
      outcome.kind === "pull-request-visible"
        ? { type: "ReleasePrExists", url: outcome.url }
        : {
            type: "PreparationFreshnessExhausted",
            attempts: attempt,
            retryable: true,
            cleanup:
              outcome.kind === "marker-deleted"
                ? "marker-deleted"
                : "marker-absent",
          },
    );

  const replanned = await request.reprepare({
    baseSha: error.newHead,
    previous: prepared,
  });
  if (replanned.isErr()) {
    const failure = toReleasePreparationError(replanned.error);
    return await abortAfterOwnedFailure(abort, error.ownership, (outcome) =>
      outcome.kind === "pull-request-visible"
        ? { type: "ReleasePrExists", url: outcome.url }
        : failure,
    );
  }
  if (replanned.value.baseSha !== error.newHead) {
    const failure: PrepareMainError = {
      type: "PreparePlanFailed",
      message: `replanned baseSha ${replanned.value.baseSha} does not equal fresh ${error.newHead}`,
      retryable: false,
    };
    return await abortAfterOwnedFailure(abort, error.ownership, (outcome) =>
      outcome.kind === "pull-request-visible"
        ? { type: "ReleasePrExists", url: outcome.url }
        : failure,
    );
  }
  return finalizeAttemptValue(
    error.ownership,
    replanned.value,
    attempt + 1,
    request,
    finalize,
    abort,
  );
}

function abortAfterOwnedFailure(
  abort: NonNullable<StablePrepareReleasePrPort["abortOwnedCreation"]>,
  ownership: ReleasePrOwnership,
  mapOutcome: (outcome: AbortOwnedCreationOutcome) => PrepareMainError,
): ResultAsync<PrepareMainSuccess, PrepareMainError> {
  return abort({ ownership, reconcile: false })
    .mapErr((error): PrepareMainError => error)
    .andThen((outcome) => errAsync(mapOutcome(outcome)))
    .orElse((error) => errAsync(error));
}

function toReleasePreparationError(
  failure: PreparationFailure,
): PrepareMainError {
  return {
    type: "ReleasePreparationFailed",
    stage: failure.stage,
    message: failure.message,
    retryable: failure.retryable ?? true,
  };
}

/** Runs the complete plan → docs gate → changelog AI → render sequence. */
export function prepareAt(
  input: PreparePlanRequest,
  dependencies: StablePreparationPorts,
): ResultAsync<PreparedRelease, PrepareStageError> {
  return dependencies.computePlan(input).andThen((plan) => {
    if (plan.baseSha !== input.baseSha)
      return errAsync<PreparedRelease, PrepareStageError>({
        type: "PreparePlanFailed",
        message: `plan baseSha ${plan.baseSha} does not equal requested ${input.baseSha}`,
        retryable: false,
      });
    return dependencies
      .runDocsAudit({
        baseSha: input.baseSha,
        plan,
        previous: input.previous,
        thinking: input.thinking,
      })
      .mapErr(
        (error): PrepareStageError =>
          error.type === "PrepareDocsAuditFailed"
            ? error
            : {
                type: "PrepareDocsAuditFailed",
                error: {
                  type: "DocsAuditShaMismatch",
                  auditedShas: [input.baseSha, undefined, undefined, undefined],
                },
              },
      )
      .andThen((docsAudit) => {
        if (docsAudit.outcome.auditedSha !== input.baseSha)
          return errAsync<PreparedRelease, PrepareStageError>({
            type: "PrepareDocsAuditFailed",
            error: {
              type: "DocsAuditShaMismatch",
              auditedShas: [
                input.baseSha,
                undefined,
                docsAudit.outcome.auditedSha,
                undefined,
              ],
            },
          });
        return dependencies
          .runChangelogAi({
            baseSha: input.baseSha,
            plan,
            docsAudit,
            previous: input.previous,
            thinking: input.thinking,
          })
          .mapErr(
            (error): PrepareStageError =>
              error.type === "PrepareChangelogFailed"
                ? error
                : {
                    type: "PrepareChangelogFailed",
                    message: "changelog AI stage failed",
                    retryable: true,
                  },
          )
          .andThen((changelog) => {
            const render = dependencies.renderPrepared ?? renderPreparedRelease;
            return render({
              baseSha: input.baseSha,
              plan,
              docsAudit,
              changelog,
              previous: input.previous,
            }).mapErr(
              (error): PrepareStageError =>
                error.type === "PrepareRenderFailed"
                  ? error
                  : {
                      type: "PrepareRenderFailed",
                      message: "release rendering failed",
                      retryable: false,
                    },
            );
          });
      });
  });
}

/**
 * Default renderer used by the workflow adapter. The planner still owns
 * canonical plan serialization; this fallback carries its block verbatim and
 * always adds a compact SHA-bound docs-audit record.
 */
export function renderPreparedRelease(
  input: PrepareRenderRequest,
): ResultAsync<PreparedRelease, PrepareStageError> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha))
    return errAsync({
      type: "PrepareRenderFailed",
      message: "baseSha must be a full lowercase SHA",
      retryable: false,
    });
  if (input.docsAudit.outcome.auditedSha !== input.baseSha)
    return errAsync({
      type: "PrepareRenderFailed",
      message: "docs audit is not bound to the prepared base SHA",
      retryable: false,
    });

  const files = [
    ...input.plan.manifestFiles,
    ...input.changelog.files,
  ] as readonly GitHubCommitFile[];
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path))
      return errAsync({
        type: "PrepareRenderFailed",
        message: `duplicate release file ${file.path}`,
        retryable: false,
      });
    paths.add(file.path);
  }
  const changes = [
    ...input.plan.manifestChanges,
    ...input.changelog.changes,
  ] as readonly ReleaseChange[];
  const docsMetadata = renderDocsAuditMetadata(input.baseSha, input.docsAudit);
  const body = [
    input.plan.body.trimEnd(),
    input.plan.planMetadataBlock,
    docsMetadata,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  return okAsync({
    baseSha: input.baseSha,
    title: input.plan.title,
    body,
    commitSubject: input.plan.commitSubject,
    files,
    changes,
    docsAuditedSha: input.docsAudit.outcome.auditedSha,
    entries: input.changelog.entries,
    evidence: input.plan.changelogEvidence,
    aiAudit: input.changelog.aiAudit,
  });
}

export const PREPARE_DOCS_AUDIT_MARKER = "weave-release-docs-audit" as const;

/** The small hidden record is safe to carry even when no full plan is present. */
export function renderDocsAuditMetadata(
  auditedSha: string,
  gate: DocsAuditGateSuccess,
): string {
  const digest = docsAuditDigest(gate.outcome);
  return [
    `<!-- ${PREPARE_DOCS_AUDIT_MARKER}:1`,
    JSON.stringify({
      auditedSha,
      outcome: gate.type,
      outcomeDigest: digest,
      warnings: gate.type === "pass" ? gate.warnings.length : 0,
    }),
    "-->",
  ].join("\n");
}

export interface PrepareDocsAuditInput {
  readonly contentRoot: string;
  readonly auditedSha: string;
  readonly classification: DocsAuditPublicImpactClassification;
  readonly thinking?: string;
}

export interface PrepareDocsAuditDependencies {
  readonly deterministic?: (
    contentRoot: string,
  ) => ResultAsync<DeterministicDocsCheckResult, DeterministicDocsCheckError>;
  readonly agent?: (
    input: DocsAuditAgentInput,
  ) => ResultAsync<DocsAuditAgentResult, DocsAuditAgentError>;
  readonly driver?: HeadlessSessionDriver;
}

/**
 * Executes Task 19's complete release-time gate. A provider failure is mapped
 * to the gate's required-result failure; it never becomes a warning. The
 * deterministic and AI inputs always carry the caller's exact audited SHA.
 */
export function runPrepareDocsAudit(
  input: PrepareDocsAuditInput,
  dependencies: PrepareDocsAuditDependencies = {},
): ResultAsync<DocsAuditGateSuccess, DocsAuditGateError> {
  const deterministicProvider =
    dependencies.deterministic ?? runDeterministicDocsCheck;
  const deterministicRun = invokeResultAsync(
    () => deterministicProvider(input.contentRoot),
    (): DeterministicDocsCheckError => ({
      type: "DeterministicDocsIoFailed",
      path: input.contentRoot,
      message: "deterministic docs provider threw",
    }),
  ).map(
    (result): DocsAuditDeterministicInput => ({
      auditedSha: input.auditedSha,
      digest: result.digest,
      passed: result.passed,
    }),
  );
  const deterministic = deterministicRun.orElse((error) =>
    okAsync<DocsAuditDeterministicInput, never>({
      auditedSha: input.auditedSha,
      digest: docsAuditDigest({ type: "deterministic-error", error }),
      passed: false,
    }),
  );

  return deterministic.andThen((deterministicInput) => {
    if (input.classification === "no-impact")
      return combineDocsAuditGate({
        publicImpact: {
          auditedSha: input.auditedSha,
          classification: input.classification,
        },
        deterministic: deterministicInput,
        ai: {
          auditedSha: input.auditedSha,
          status: "not-required",
        },
        followUp: notApplicableFollowUp(input.auditedSha),
      });

    if (dependencies.agent === undefined && dependencies.driver === undefined)
      return combineDocsAuditGate({
        publicImpact: {
          auditedSha: input.auditedSha,
          classification: input.classification,
        },
        deterministic: deterministicInput,
        ai: missingAi(input.auditedSha),
        followUp: notApplicableFollowUp(input.auditedSha),
      });

    const runAgent =
      dependencies.agent ??
      ((agentInput: DocsAuditAgentInput) => runDocsAuditAgent(agentInput));
    return invokeResultAsync(
      () =>
        runAgent({
          contentRoot: input.contentRoot,
          auditedSha: input.auditedSha,
          driver: dependencies.driver as HeadlessSessionDriver,
          thinking: input.thinking,
        }),
      (): DocsAuditAgentError => ({
        type: "HeadlessSessionFailed",
        reason: "docs audit provider threw",
      }),
    )
      .map(
        (result): DocsAuditAiInput => ({
          auditedSha: result.auditedSha,
          status: "submitted",
          digest: result.digest,
          findings: result.findings,
        }),
      )
      .orElse((_error) =>
        okAsync<DocsAuditAiInput, never>({
          // Keep the provider failure out of the gate payload. The typed
          // unavailable status is the only safe cross-job representation.
          auditedSha: input.auditedSha,
          status: "unavailable",
        }),
      )
      .andThen((ai) =>
        combineDocsAuditGate({
          publicImpact: {
            auditedSha: input.auditedSha,
            classification: input.classification,
          },
          deterministic: deterministicInput,
          ai,
          followUp: notApplicableFollowUp(input.auditedSha),
        }),
      );
  });
}

function invokeResultAsync<T, E>(
  provider: () => ResultAsync<T, E>,
  onThrow: () => E,
): ResultAsync<T, E> {
  const started = Result.fromThrowable(provider, onThrow)();
  return started.isErr() ? errAsync(started.error) : started.value;
}

function missingAi(auditedSha: string): DocsAuditAiInput {
  return { auditedSha, status: "missing" };
}

function notApplicableFollowUp(auditedSha: string): DocsAuditFollowUpInput {
  return { auditedSha, status: "not-applicable" };
}

function toPreparationFailure(error: PrepareStageError): PreparationFailure {
  switch (error.type) {
    case "PreparePlanFailed":
      return {
        stage: "plan-rebinding",
        message: error.message,
        retryable: error.retryable,
      };
    case "PrepareDocsAuditFailed":
      return {
        stage: "docs-gate",
        message: error.error.type,
        retryable: false,
      };
    case "PrepareChangelogFailed":
      return {
        stage: "changelog-ai",
        message: error.message,
        retryable: error.retryable,
      };
    case "PrepareRenderFailed":
      return {
        stage: "prepared-commit",
        message: error.message,
        retryable: error.retryable,
      };
  }
}

/** Result shape written by the statically-unrolled workflow jobs. */
export const PREPARE_PHASES = [
  "authorize",
  "plan",
  "docs-release-audit",
  "changelog-ai",
  "open-pr",
] as const;
export type PreparePhase = (typeof PREPARE_PHASES)[number];

export interface PrepareMainCliOptions {
  readonly phase: PreparePhase;
  readonly attempt: number;
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly docsAuditPath?: string;
  readonly changelogPath?: string;
  readonly ownershipPath?: string;
}

export type PrepareCliError =
  | {
      readonly type: "InvalidPrepareCommand";
      readonly issues: readonly string[];
    }
  | { readonly type: "InvalidPrepareAttempt"; readonly attempt: string };

const CliPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[;&|`$<>\n\r]/.test(value) &&
      !value.split("/").includes(".."),
    "path must be a bounded safe path",
  );

const CliOptionsSchema = z
  .object({
    phase: z.enum(PREPARE_PHASES),
    attempt: z.number().int().positive().max(4),
    inputPath: CliPathSchema.optional(),
    outputPath: CliPathSchema.optional(),
    docsAuditPath: CliPathSchema.optional(),
    changelogPath: CliPathSchema.optional(),
    ownershipPath: CliPathSchema.optional(),
  })
  .strict();

/** Parses the small workflow command surface without running a side effect. */
export function parsePrepareMainArgs(
  argv: readonly string[],
): Result<PrepareMainCliOptions, PrepareCliError> {
  const values: Record<string, string> = {};
  const allowedKeys = new Set([
    "phase",
    "attempt",
    "input",
    "output",
    "input-path",
    "output-path",
    "docs-audit",
    "changelog",
    "ownership",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--"))
      return err({
        type: "InvalidPrepareCommand",
        issues: ["unknown argument"],
      });
    const key = token.slice(2);
    if (!allowedKeys.has(key))
      return err({
        type: "InvalidPrepareCommand",
        issues: [`unknown option --${key}`],
      });
    if (Object.hasOwn(values, key))
      return err({
        type: "InvalidPrepareCommand",
        issues: [`duplicate option --${key}`],
      });
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return err({
        type: "InvalidPrepareCommand",
        issues: [`--${key} requires a value`],
      });
    values[key] = value;
    index += 1;
  }
  const attemptText = values.attempt ?? "1";
  const attempt = Number(attemptText);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 4)
    return err({ type: "InvalidPrepareAttempt", attempt: attemptText });
  const parsed = CliOptionsSchema.safeParse({
    phase: values.phase,
    attempt,
    inputPath: values.input ?? values["input-path"],
    outputPath: values.output ?? values["output-path"],
    ...(values["docs-audit"] === undefined
      ? {}
      : { docsAuditPath: values["docs-audit"] }),
    ...(values.changelog === undefined
      ? {}
      : { changelogPath: values.changelog }),
    ...(values.ownership === undefined
      ? {}
      : { ownershipPath: values.ownership }),
  });
  if (!parsed.success)
    return err({
      type: "InvalidPrepareCommand",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

/**
 * The executable only parses its phase here. Workflow jobs inject the
 * controller ports through their phase adapters; keeping this boundary pure
 * prevents a command invocation from silently constructing an untrusted
 * GitHub/model client.
 */
export function runPrepareMainCli(
  argv: readonly string[],
): Result<PrepareMainCliOptions, PrepareCliError> {
  return parsePrepareMainArgs(argv);
}

if (import.meta.main) {
  const parsed = runPrepareMainCli(Bun.argv.slice(2));
  if (parsed.isErr()) {
    log.error({ error: parsed.error }, "invalid stable preparation command");
    process.exitCode = 2;
  } else {
    const input = parsePrepareEnvironment(Bun.env);
    if (input.isErr()) {
      log.error({ error: input.error }, "invalid stable preparation request");
      process.exitCode = 2;
    } else {
      const selected = selectPackages(input.value);
      if (selected.isErr()) {
        log.error(
          { error: selected.error },
          "stable preparation selection failed",
        );
        process.exitCode = 2;
      } else {
        log.info(
          {
            phase: parsed.value.phase,
            attempt: parsed.value.attempt,
            selected: selected.value,
          },
          "stable preparation phase validated",
        );
      }
    }
  }
}

export type {
  ChangelogAgentError,
  ChangelogAgentResult,
  ChangelogAgentVersion,
  ChangelogDocument,
  MergedReleaseObservation,
  ReleasePrOwnership,
};
/** Re-exported for tests and workflow adapters that need the exact catalog. */
export { PUBLIC_PACKAGES };

/**
 * Adapter helper for Task 17 callers. It converts canonical agent output into
 * the release-PR file surface and creates only compact audit metadata.
 */
export function runPrepareChangelogAi(input: {
  readonly baseSha: string;
  readonly evidence: BoundedEvidence;
  readonly versions: readonly ChangelogAgentVersion[];
  readonly driver: HeadlessSessionDriver;
  readonly thinking?: string;
  readonly refs?: ChangelogEvidence;
  readonly history?: readonly ChangelogDocument[];
  readonly generatedAt?: string | Date;
}): ResultAsync<StableChangelogPreparation, PrepareStageError> {
  return runChangelogAgent(input)
    .mapErr((error) => ({
      type: "PrepareChangelogFailed" as const,
      message: describeChangelogFailure(error),
      retryable: true,
    }))
    .andThen((result) => renderChangelogAgentResult(result, input));
}

function renderChangelogAgentResult(
  result: ChangelogAgentResult,
  input: {
    readonly refs?: ChangelogEvidence;
    readonly generatedAt?: string | Date;
  },
): ResultAsync<StableChangelogPreparation, PrepareStageError> {
  const files: GitHubCommitFile[] = [];
  const changes: ReleaseChange[] = [];
  const entries: ChangelogEntry[] = [];
  for (const changelog of result.changelogs) {
    const path = `${PUBLIC_PACKAGES[changelog.packageName].directory}/CHANGELOG.md`;
    const parsed = parseChangelog(
      {
        packageName: changelog.packageName,
        path,
        contents: changelog.markdown,
      },
      input.refs,
    );
    if (parsed.isErr())
      return errAsync({
        type: "PrepareRenderFailed",
        message: `invalid generated changelog for ${changelog.packageName}`,
        retryable: false,
      });
    files.push({ path, contents: changelog.markdown });
    changes.push({ path, status: "modified" });
    for (const version of parsed.value.document.versions)
      for (const section of version.sections) entries.push(...section.entries);
  }
  const audit = createAiAuditMetadata({
    thinking: result.thinking,
    attempts: result.attempts,
    evidenceDigest: result.evidenceDigest,
    submission: result.submission,
    generatedAt: input.generatedAt ?? new Date(),
  });
  if (audit.isErr())
    return errAsync({
      type: "PrepareRenderFailed",
      message: "changelog AI audit metadata was invalid",
      retryable: false,
    });
  return okAsync({ entries, files, changes, aiAudit: audit.value });
}

function describeChangelogFailure(error: ChangelogAgentError): string {
  return error.type;
}
