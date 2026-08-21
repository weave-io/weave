/**
 * Required `release-policy` check for pull requests.
 *
 * The ordinary path validates the Changesets policy and proves that the
 * consumption ledger has not been edited. Stable release PRs add the exact
 * release surface, plan freshness/digest, and SHA-bound docs-audit checks.
 * Cleanup PRs use the same ledger identities to allow deletions only.
 *
 * This module keeps the policy pure at its boundary. The CLI adapter at the
 * bottom reads the pull-request event and git diff, then supplies bounded
 * facts to `checkReleasePolicy`. No GitHub write or release mutation occurs.
 */
import { join, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { consumedChangesetPath } from "./changeset-cleanup.js";
import { subtractConsumedLedger } from "./changeset-consumption.js";
import {
  BunChangesetFileSystem,
  type ChangesetPolicyError,
  ChangesetPolicyValidator,
  requireChangesetCoverage,
  type ValidatedChangeset,
} from "./changeset-policy.js";
import {
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_REPOSITORY,
} from "./constants.js";
import {
  type ConsumptionLedger,
  type ConsumptionLedgerError,
  parseConsumptionLedger,
} from "./consumption-ledger.js";
import { docsAuditOutcomeDigest } from "./docs-audit/gate.js";
import { publishablePackageNames } from "./package-policy.js";
import {
  parsePlanMetadataBlock,
  type ReleasePlan,
  releasePlanDigest,
  validateReleasePlan,
  validateReleasePlanArtifact,
} from "./release-plan.js";
import {
  type ReleaseChange,
  type ReleasePrError,
  validateCleanupPrDiff,
  validateReleasePrDiff,
} from "./release-pr-contract.js";

const log = logger.child({ module: "release-policy-check" });

export const RELEASE_POLICY_CHECK_NAME = "release-policy" as const;
export const RELEASE_DOCS_AUDIT_MARKER = "weave-release-docs-audit" as const;
export const RELEASE_PLAN_DIGEST_MARKER = "weave-release-plan-digest" as const;
export const RELEASE_POLICY_RECOVERY_URL =
  `https://github.com/${RELEASE_REPOSITORY}/actions/workflows/release-stable-regenerate.yml` as const;
export const RELEASE_POLICY_RECOVERY_HINT =
  `Regeneration pending or required. Run or re-dispatch the stable regeneration workflow: ${RELEASE_POLICY_RECOVERY_URL}` as const;
export const CONSUMED_CHANGESET_FIX =
  "Restore the consumed changeset bytes exactly as recorded by the ledger; do not edit a consumed changeset. If it needs removal, use a release:cleanup PR." as const;

/** Bounds for all values supplied by an event, body, or workflow carrier. */
export const RELEASE_POLICY_LIMITS = {
  changedPaths: 512,
  changes: 512,
  consumedPaths: 512,
  changedChangesets: 512,
  planBodyBytes: 256 * 1024,
  metadataBytes: 16 * 1024,
  pathLength: 256,
  digestLength: 71,
  shaLength: 40,
  gitOutputBytes: 512 * 1024,
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).{1,256}$/;
const PLAN_DIGEST_HEADER = new RegExp(`^${RELEASE_PLAN_DIGEST_MARKER}:1$`);
const DOCS_AUDIT_HEADER = new RegExp(`^${RELEASE_DOCS_AUDIT_MARKER}:1$`);

export const RELEASE_POLICY_MODES = ["ordinary", "stable", "cleanup"] as const;
export type ReleasePolicyMode = (typeof RELEASE_POLICY_MODES)[number];

const SafePathSchema = z
  .string()
  .min(1)
  .max(RELEASE_POLICY_LIMITS.pathLength)
  .regex(SAFE_PATH);

const ReleaseChangeSchema = z
  .object({
    path: SafePathSchema,
    status: z.enum(["added", "modified", "removed"]),
    manifestFields: z.array(z.string().min(1).max(64)).max(16).optional(),
  })
  .strict();

const ReleasePolicyMetadataInputSchema = z
  .object({
    mode: z.enum(RELEASE_POLICY_MODES),
    changedPaths: z
      .array(SafePathSchema)
      .max(RELEASE_POLICY_LIMITS.changedPaths),
    changes: z.array(ReleaseChangeSchema).max(RELEASE_POLICY_LIMITS.changes),
    consumedPaths: z
      .array(SafePathSchema)
      .max(RELEASE_POLICY_LIMITS.consumedPaths)
      .optional(),
    changedChangesetPaths: z
      .array(SafePathSchema)
      .max(RELEASE_POLICY_LIMITS.changedChangesets)
      .optional(),
    currentMainSha: z.string().regex(FULL_SHA).optional(),
    planBody: z.string().max(RELEASE_POLICY_LIMITS.planBodyBytes).optional(),
    planDigest: z.string().regex(DIGEST).optional(),
    docsAuditMetadata: z.unknown().optional(),
  })
  .strict();

export interface ReleasePolicyMetadataInput {
  readonly mode: ReleasePolicyMode;
  readonly changedPaths: readonly string[];
  readonly changes: readonly ReleaseChange[];
  readonly consumedPaths?: readonly string[];
  readonly changedChangesetPaths?: readonly string[];
  readonly currentMainSha?: string;
  readonly planBody?: string;
  readonly planDigest?: string;
  readonly docsAuditMetadata?: unknown;
}

export type ReleasePolicyInputError =
  | { type: "InvalidReleasePolicyInput"; issues: readonly string[] }
  | {
      type: "ReleasePolicyInputBoundExceeded";
      field: string;
      limit: number;
      actual: number;
    };

/**
 * Validates the JSON-shaped portion of the policy input before it reaches the
 * pure checker. Tests and integrations can use this at their own boundary.
 */
export function validateReleasePolicyInput(
  input: unknown,
): Result<ReleasePolicyMetadataInput, ReleasePolicyInputError> {
  const bytes = boundedJsonBytes(input);
  if (bytes > RELEASE_POLICY_LIMITS.planBodyBytes)
    return err({
      type: "ReleasePolicyInputBoundExceeded",
      field: "input",
      limit: RELEASE_POLICY_LIMITS.planBodyBytes,
      actual: bytes,
    });
  if (isRecord(input)) {
    const arrayBounds = [
      ["changedPaths", RELEASE_POLICY_LIMITS.changedPaths],
      ["changes", RELEASE_POLICY_LIMITS.changes],
      ["consumedPaths", RELEASE_POLICY_LIMITS.consumedPaths],
      ["changedChangesetPaths", RELEASE_POLICY_LIMITS.changedChangesets],
    ] as const;
    for (const [field, limit] of arrayBounds) {
      const value = input[field];
      if (Array.isArray(value) && value.length > limit)
        return err({
          type: "ReleasePolicyInputBoundExceeded",
          field,
          limit,
          actual: value.length,
        });
    }
    const planBody = input.planBody;
    if (typeof planBody === "string") {
      const actual = new TextEncoder().encode(planBody).byteLength;
      if (actual > RELEASE_POLICY_LIMITS.planBodyBytes)
        return err({
          type: "ReleasePolicyInputBoundExceeded",
          field: "planBody",
          limit: RELEASE_POLICY_LIMITS.planBodyBytes,
          actual,
        });
    }
  }
  const parsed = ReleasePolicyMetadataInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidReleasePolicyInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

export interface ReleasePolicyCheckInput extends ReleasePolicyMetadataInput {
  /** A direct plan or workflow-artifact fixture may be supplied instead of a PR body. */
  readonly plan?: unknown;
  /** All policy-validated changeset files present at the checked-out head. */
  readonly changesets: readonly ValidatedChangeset[];
  /** The ledger read from the protected base/main tree. */
  readonly ledger: ConsumptionLedger;
}

export interface ReleaseDocsAuditMetadata {
  readonly schemaVersion: 1;
  readonly auditedSha: string;
  readonly outcome: "not-required" | "pass";
  readonly outcomeDigest: string;
  readonly warnings: number;
}

export type ReleasePolicySuccess = {
  readonly status: "passed";
  readonly mode: ReleasePolicyMode;
  /** Stable/cleanup policy was checked; ordinary release-only rules skipped. */
  readonly releaseRules: "checked" | "skipped";
  readonly changedPaths: readonly string[];
};

export type ReleasePolicyCheckResult =
  | ReleasePolicySuccess
  | { readonly status: "skipped"; readonly reason: "not-a-pull-request" };

export type ReleasePolicyError =
  | ReleasePolicyInputError
  | { type: "ChangesetPolicyFailed"; errors: readonly ChangesetPolicyError[] }
  | {
      type: "ChangesetCoverageFailed";
      errors: readonly ChangesetPolicyError[];
    }
  | {
      type: "ConsumedChangesetModified";
      changesets: readonly {
        id: string;
        path: string;
        consumedDigest: string;
        currentDigest: string;
      }[];
      fix: typeof CONSUMED_CHANGESET_FIX;
    }
  | {
      type: "UnconsumedChangesetDeletion";
      path: string;
      fix: "Only ledger-consumed changesets may be deleted by release cleanup.";
    }
  | ReleasePrError
  | {
      type: "MissingCurrentMainSha";
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "MissingReleasePlanMetadata";
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "InvalidReleasePlanMetadata";
      reason: string;
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "StaleBaseSha";
      baseSha: string;
      currentMainSha: string;
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "PlanDigestMismatch";
      expected: string;
      actual: string;
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "MissingDocsAuditMetadata";
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "InvalidDocsAuditMetadata";
      reason: string;
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "DocsAuditShaMismatch";
      auditedSha: string;
      baseSha: string;
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "DocsAuditDigestMismatch";
      expected: string;
      actual: string;
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "DocsAuditOutcomeMismatch";
      expected: ReleaseDocsAuditMetadata["outcome"];
      actual: ReleaseDocsAuditMetadata["outcome"];
      recovery: typeof RELEASE_POLICY_RECOVERY_HINT;
    }
  | {
      type: "ReleasePolicyGitFailed";
      operation: string;
      message: string;
    }
  | { type: "LedgerInvalid"; error: ConsumptionLedgerError };

/** Validate the typed request and apply the mode-specific release policy. */
export function checkReleasePolicy(
  input: ReleasePolicyCheckInput,
): Result<ReleasePolicySuccess, ReleasePolicyError> {
  const bounded = validateRequestBounds(input);
  if (bounded.isErr()) return err(bounded.error);

  const consumed = subtractConsumedLedger({
    changesets: input.changesets,
    ledger: input.ledger,
  });
  if (consumed.modified.length > 0)
    return err({
      type: "ConsumedChangesetModified",
      changesets: consumed.modified,
      fix: CONSUMED_CHANGESET_FIX,
    });

  if (input.mode === "ordinary") {
    const deleted = input.changes.filter(
      (change) => change.status === "removed" && isChangesetPath(change.path),
    );
    const consumedPaths = new Set(
      input.consumedPaths ??
        input.ledger.records.map((record) =>
          consumedChangesetPath(record.identity.id),
        ),
    );
    const unconsumed = deleted.find(
      (change) => !consumedPaths.has(change.path),
    );
    if (unconsumed !== undefined)
      return err({
        type: "UnconsumedChangesetDeletion",
        path: unconsumed.path,
        fix: "Only ledger-consumed changesets may be deleted by release cleanup.",
      });

    const changedChangesetPaths = new Set(
      input.changedChangesetPaths ?? input.changedPaths.filter(isChangesetPath),
    );
    const changedChangesets = input.changesets.filter((changeset) =>
      changedChangesetPaths.has(changesetPolicyPath(changeset.path)),
    );
    const coverage = requireChangesetCoverage({
      changedPaths: input.changedPaths,
      changesets: changedChangesets,
    });
    if (coverage.isErr())
      return err({
        type: "ChangesetCoverageFailed",
        errors: coverage.error,
      });
    return ok({
      status: "passed",
      mode: input.mode,
      releaseRules: "skipped",
      changedPaths: input.changedPaths,
    });
  }

  if (input.mode === "cleanup") {
    const consumedPaths =
      input.consumedPaths ??
      input.ledger.records.map((record) =>
        consumedChangesetPath(record.identity.id),
      );
    const surface = validateCleanupPrDiff({
      changes: input.changes,
      consumedPaths,
    });
    if (surface.isErr()) return err(surface.error);
    return ok({
      status: "passed",
      mode: input.mode,
      releaseRules: "checked",
      changedPaths: input.changedPaths,
    });
  }

  const releaseSurface = validateReleasePrDiff(input.changes);
  if (releaseSurface.isErr()) return err(releaseSurface.error);
  return validateStableReleasePolicy(input);
}

/** Alias used by callers that describe this as a validator. */
export const validateReleasePolicy = checkReleasePolicy;

function validateStableReleasePolicy(
  input: ReleasePolicyCheckInput,
): Result<ReleasePolicySuccess, ReleasePolicyError> {
  const currentMainSha = input.currentMainSha;
  if (currentMainSha === undefined)
    return err({
      type: "MissingCurrentMainSha",
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });

  const planResult = readPlan(input);
  if (planResult.isErr()) return err(planResult.error);
  const plan = planResult.value.plan;
  if (plan.baseSha !== currentMainSha)
    return err({
      type: "StaleBaseSha",
      baseSha: plan.baseSha,
      currentMainSha,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });

  const expectedDigest = releasePlanDigest(plan);
  if (expectedDigest.isErr())
    return err({
      type: "InvalidReleasePlanMetadata",
      reason: expectedDigest.error.type,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  const suppliedDigest = readPlanDigest(input, planResult.value);
  if (suppliedDigest.isErr()) return err(suppliedDigest.error);
  if (
    suppliedDigest.value !== undefined &&
    suppliedDigest.value !== expectedDigest.value
  )
    return err({
      type: "PlanDigestMismatch",
      expected: suppliedDigest.value,
      actual: expectedDigest.value,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });

  const docsMetadata = readDocsAuditMetadata(input);
  if (docsMetadata.isErr()) return err(docsMetadata.error);
  if (docsMetadata.value === null)
    return err({
      type: "MissingDocsAuditMetadata",
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  if (docsMetadata.value.auditedSha !== currentMainSha)
    return err({
      type: "DocsAuditShaMismatch",
      auditedSha: docsMetadata.value.auditedSha,
      baseSha: currentMainSha,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  if (plan.docsAudit.auditedSha !== currentMainSha)
    return err({
      type: "DocsAuditShaMismatch",
      auditedSha: plan.docsAudit.auditedSha,
      baseSha: currentMainSha,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  const expectedDocsDigest = docsAuditOutcomeDigest(plan.docsAudit);
  if (docsMetadata.value.outcomeDigest !== expectedDocsDigest)
    return err({
      type: "DocsAuditDigestMismatch",
      expected: expectedDocsDigest,
      actual: docsMetadata.value.outcomeDigest,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  const expectedOutcome =
    plan.docsAudit.aiResultDigestOrStatus === "not-required"
      ? "not-required"
      : "pass";
  if (docsMetadata.value.outcome !== expectedOutcome)
    return err({
      type: "DocsAuditOutcomeMismatch",
      expected: expectedOutcome,
      actual: docsMetadata.value.outcome,
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  return ok({
    status: "passed",
    mode: input.mode,
    releaseRules: "checked",
    changedPaths: input.changedPaths,
  });
}

interface ReadPlanResult {
  readonly plan: ReleasePlan;
  readonly embeddedDigest?: string;
}

function readPlanDigest(
  input: ReleasePolicyCheckInput,
  plan: ReadPlanResult,
): Result<string | undefined, ReleasePolicyError> {
  if (input.planDigest !== undefined) return ok(input.planDigest);
  if (input.planBody === undefined) return ok(plan.embeddedDigest);
  const body = input.planBody;
  if (!body.includes(RELEASE_PLAN_DIGEST_MARKER)) return ok(undefined);
  const digest = extractPlanDigest(body);
  if (digest === undefined)
    return err({
      type: "InvalidReleasePlanMetadata",
      reason: "plan digest metadata is missing or invalid",
      recovery: RELEASE_POLICY_RECOVERY_HINT,
    });
  return ok(digest);
}

function readPlan(
  input: ReleasePolicyCheckInput,
): Result<ReadPlanResult, ReleasePolicyError> {
  if (input.planBody !== undefined) {
    const parsed = parsePlanMetadataBlock(input.planBody);
    if (parsed.isErr())
      return err({
        type: "InvalidReleasePlanMetadata",
        reason: describeUnknown(parsed.error),
        recovery: RELEASE_POLICY_RECOVERY_HINT,
      });
    return ok({ plan: parsed.value });
  }
  if (input.plan !== undefined) {
    const artifact = validateReleasePlanArtifact(input.plan);
    if (artifact.isOk())
      return ok({
        plan: artifact.value.plan,
        embeddedDigest: artifact.value.planDigest,
      });
    const parsed = validateReleasePlan(input.plan);
    if (parsed.isErr())
      return err({
        type: "InvalidReleasePlanMetadata",
        reason: describeUnknown(parsed.error),
        recovery: RELEASE_POLICY_RECOVERY_HINT,
      });
    return ok({ plan: parsed.value });
  }
  return err({
    type: "MissingReleasePlanMetadata",
    recovery: RELEASE_POLICY_RECOVERY_HINT,
  });
}

/** Parses the optional explicit digest carrier used by newer PR renderers. */
export function extractPlanDigest(body: string): string | undefined {
  const payload = findCommentPayload(body, PLAN_DIGEST_HEADER);
  if (payload === null) return undefined;
  const object = parseJsonValue(payload);
  if (object !== undefined && isRecord(object)) {
    const value = object.planDigest;
    return typeof value === "string" && DIGEST.test(value) ? value : undefined;
  }
  const trimmed = payload.trim();
  return DIGEST.test(trimmed) ? trimmed : undefined;
}

/** Parses the SHA-bound docs-audit record embedded in a release PR body. */
export function parseDocsAuditMetadata(
  input: unknown,
): Result<
  ReleaseDocsAuditMetadata,
  { type: "InvalidDocsAuditMetadata"; reason: string }
> {
  return parseDocsAuditMetadataValue(input, false);
}

function parseDocsAuditMetadataValue(
  input: unknown,
  implicitSchemaVersion: boolean,
): Result<
  ReleaseDocsAuditMetadata,
  { type: "InvalidDocsAuditMetadata"; reason: string }
> {
  const value = typeof input === "string" ? parseJsonValue(input) : input;
  if (value === undefined)
    return err({
      type: "InvalidDocsAuditMetadata",
      reason: "metadata is not valid bounded JSON",
    });
  const candidate =
    implicitSchemaVersion &&
    isRecord(value) &&
    value.schemaVersion === undefined
      ? { ...value, schemaVersion: 1 }
      : value;
  const parsed = z
    .object({
      schemaVersion: z.literal(1),
      auditedSha: z.string().regex(FULL_SHA),
      outcome: z.enum(["not-required", "pass"]),
      outcomeDigest: z.string().regex(DIGEST),
      warnings: z.number().int().nonnegative().max(256),
    })
    .strict()
    .safeParse(candidate);
  if (!parsed.success)
    return err({
      type: "InvalidDocsAuditMetadata",
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("; "),
    });
  return ok(parsed.data);
}

function readDocsAuditMetadata(
  input: ReleasePolicyCheckInput,
): Result<ReleaseDocsAuditMetadata | null, ReleasePolicyError> {
  if (input.docsAuditMetadata !== undefined) {
    const parsed = parseDocsAuditMetadata(input.docsAuditMetadata);
    return parsed.isErr()
      ? err({
          type: "InvalidDocsAuditMetadata",
          reason: parsed.error.reason,
          recovery: RELEASE_POLICY_RECOVERY_HINT,
        })
      : ok(parsed.value);
  }
  if (input.planBody === undefined) return ok(null);
  const payload = findCommentPayload(input.planBody, DOCS_AUDIT_HEADER);
  if (payload === null) return ok(null);
  const parsed = parseDocsAuditMetadataValue(payload, true);
  return parsed.isErr()
    ? err({
        type: "InvalidDocsAuditMetadata",
        reason: parsed.error.reason,
        recovery: RELEASE_POLICY_RECOVERY_HINT,
      })
    : ok(parsed.value);
}

function findCommentPayload(
  body: string,
  headerPattern: RegExp,
): string | null {
  if (
    new TextEncoder().encode(body).byteLength >
    RELEASE_POLICY_LIMITS.planBodyBytes
  )
    return null;
  const comments = body.matchAll(/<!--([\s\S]*?)-->/g);
  let found: string | null = null;
  for (const comment of comments) {
    const inner = comment[1]?.trim() ?? "";
    const newline = inner.indexOf("\n");
    const header = (newline === -1 ? inner : inner.slice(0, newline)).trim();
    if (!headerPattern.test(header)) continue;
    if (found !== null) return null;
    found = newline === -1 ? "" : inner.slice(newline + 1).trim();
  }
  return found;
}

function parseJsonValue(value: string): unknown | undefined {
  if (
    new TextEncoder().encode(value).byteLength >
    RELEASE_POLICY_LIMITS.metadataBytes
  )
    return undefined;
  const parsed = Result.fromThrowable(
    () => JSON.parse(value) as unknown,
    () => undefined,
  )();
  return parsed.isOk() ? parsed.value : undefined;
}

function validateRequestBounds(
  input: ReleasePolicyCheckInput,
): Result<void, ReleasePolicyError> {
  const basic = validateReleasePolicyInput({
    mode: input.mode,
    changedPaths: input.changedPaths,
    changes: input.changes,
    ...(input.consumedPaths === undefined
      ? {}
      : { consumedPaths: input.consumedPaths }),
    ...(input.changedChangesetPaths === undefined
      ? {}
      : { changedChangesetPaths: input.changedChangesetPaths }),
    ...(input.currentMainSha === undefined
      ? {}
      : { currentMainSha: input.currentMainSha }),
    ...(input.planBody === undefined ? {} : { planBody: input.planBody }),
    ...(input.planDigest === undefined ? {} : { planDigest: input.planDigest }),
    ...(input.docsAuditMetadata === undefined
      ? {}
      : { docsAuditMetadata: input.docsAuditMetadata }),
  });
  if (basic.isErr()) return err(basic.error);
  if (input.changesets.length > RELEASE_POLICY_LIMITS.changedChangesets)
    return err({
      type: "ReleasePolicyInputBoundExceeded",
      field: "changesets",
      limit: RELEASE_POLICY_LIMITS.changedChangesets,
      actual: input.changesets.length,
    });
  if (input.ledger.records.length > RELEASE_POLICY_LIMITS.consumedPaths)
    return err({
      type: "ReleasePolicyInputBoundExceeded",
      field: "ledger.records",
      limit: RELEASE_POLICY_LIMITS.consumedPaths,
      actual: input.ledger.records.length,
    });
  if (input.plan !== undefined) {
    const bytes = boundedJsonBytes(input.plan);
    if (bytes > RELEASE_POLICY_LIMITS.planBodyBytes)
      return err({
        type: "ReleasePolicyInputBoundExceeded",
        field: "plan",
        limit: RELEASE_POLICY_LIMITS.planBodyBytes,
        actual: bytes,
      });
  }
  for (const changeset of input.changesets) {
    if (changeset.path.length > RELEASE_POLICY_LIMITS.pathLength)
      return err({
        type: "ReleasePolicyInputBoundExceeded",
        field: "changesets.path",
        limit: RELEASE_POLICY_LIMITS.pathLength,
        actual: changeset.path.length,
      });
  }
  return ok(undefined);
}

function isChangesetPath(path: string): boolean {
  return /^\.changeset\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(
    normalizePolicyPath(path),
  );
}

function normalizePolicyPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function changesetPolicyPath(path: string): string {
  const normalized = normalizePolicyPath(path);
  const marker = normalized.indexOf(".changeset/");
  return marker === -1 ? normalized : normalized.slice(marker);
}

function boundedJsonBytes(value: unknown): number {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(value) ?? "",
    () => "",
  )();
  return serialized.isOk()
    ? new TextEncoder().encode(serialized.value).byteLength
    : Number.POSITIVE_INFINITY;
}

function describeUnknown(value: unknown): string {
  if (typeof value === "object" && value !== null && "type" in value)
    return String((value as { type: unknown }).type);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// CI adapter
// ---------------------------------------------------------------------------

interface PullRequestEvent {
  readonly pull_request?: {
    readonly base?: { readonly sha?: unknown };
    readonly head?: { readonly sha?: unknown };
    readonly body?: unknown;
    readonly labels?: readonly { readonly name?: unknown }[];
  };
}

export interface ReleasePolicyEnvironment {
  readonly root?: string;
  readonly eventName?: string;
  readonly eventPath?: string;
  readonly currentMainSha?: string;
}

export function runReleasePolicyCheck(
  environment: ReleasePolicyEnvironment = {},
): ResultAsync<ReleasePolicyCheckResult, ReleasePolicyError> {
  const root = resolve(environment.root ?? resolve(import.meta.dir, "../.."));
  const eventName =
    environment.eventName ?? process.env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "pull_request")
    return okAsync<ReleasePolicyCheckResult, ReleasePolicyError>({
      status: "skipped",
      reason: "not-a-pull-request",
    });
  const eventPath = environment.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined)
    return errAsync({
      type: "ReleasePolicyGitFailed",
      operation: "read event",
      message: "GITHUB_EVENT_PATH is missing",
    });
  return readBoundedText(
    eventPath,
    RELEASE_POLICY_LIMITS.planBodyBytes,
  ).andThen(
    (eventText): ResultAsync<ReleasePolicyCheckResult, ReleasePolicyError> => {
      const event = parseEvent(eventText);
      if (event.isErr()) return errAsync(event.error);
      const pullValue = event.value.pull_request;
      if (pullValue === undefined)
        return okAsync<ReleasePolicyCheckResult, ReleasePolicyError>({
          status: "skipped",
          reason: "not-a-pull-request",
        });
      if (!isRecord(pullValue))
        return errAsync({
          type: "ReleasePolicyGitFailed",
          operation: "read pull request",
          message: "pull_request must be an object",
        });
      const pull = pullValue as NonNullable<PullRequestEvent["pull_request"]>;
      const baseSha = stringValue(pull.base?.sha);
      if (baseSha === undefined || !FULL_SHA.test(baseSha))
        return errAsync({
          type: "ReleasePolicyGitFailed",
          operation: "read pull request base",
          message: "pull_request.base.sha is missing or invalid",
        });
      if (pull.labels !== undefined && !Array.isArray(pull.labels))
        return errAsync({
          type: "ReleasePolicyGitFailed",
          operation: "read pull request labels",
          message: "pull_request.labels must be an array",
        });
      const labels = (pull.labels ?? [])
        .map((label) => (isRecord(label) ? stringValue(label.name) : undefined))
        .filter((label): label is string => label !== undefined);
      const cleanupLabel = labels.includes("release:cleanup");
      const stableLabel = labels.includes("release:stable");
      if (cleanupLabel && stableLabel)
        return errAsync({
          type: "ReleasePolicyGitFailed",
          operation: "read pull request labels",
          message: "release:stable and release:cleanup cannot be combined",
        });
      let mode: ReleasePolicyMode = "ordinary";
      if (cleanupLabel) mode = "cleanup";
      else if (stableLabel) mode = "stable";
      const headRef =
        process.env.GITHUB_SHA ?? stringValue(pull.head?.sha) ?? "HEAD";
      if (headRef !== "HEAD" && !FULL_SHA.test(headRef))
        return errAsync({
          type: "ReleasePolicyGitFailed",
          operation: "read pull request head",
          message: "pull request head SHA is missing or invalid",
        });
      return readPullRequestFacts(root, baseSha, headRef).andThen((facts) =>
        loadPolicyFiles(root, baseSha).andThen(({ changesets, ledger }) => {
          const currentMain =
            environment.currentMainSha ?? process.env.GITHUB_MAIN_SHA;
          const mainResult =
            currentMain !== undefined
              ? okAsync(currentMain)
              : readGit(root, ["rev-parse", "refs/remotes/origin/main"]);
          return mainResult.andThen((mainSha) => {
            const request: ReleasePolicyCheckInput = {
              mode,
              changedPaths: facts.changes.map((change) => change.path),
              changes: facts.changes,
              changedChangesetPaths: facts.changes
                .filter((change) => isChangesetPath(change.path))
                .map((change) => change.path),
              changesets,
              ledger,
              consumedPaths: ledger.records.map((record) =>
                consumedChangesetPath(record.identity.id),
              ),
              currentMainSha: mainSha.trim(),
              planBody: stringValue(pull.body) ?? "",
            };
            return liftResult(checkReleasePolicy(request));
          });
        }),
      );
    },
  );
}

/** Alias that makes the workflow adapter's purpose explicit. */
export const runReleasePolicy = runReleasePolicyCheck;

function readPullRequestFacts(
  root: string,
  baseSha: string,
  headRef: string,
): ResultAsync<{ changes: readonly ReleaseChange[] }, ReleasePolicyError> {
  return readGit(root, [
    "diff",
    "--name-status",
    "--find-renames",
    `${baseSha}...${headRef}`,
  ]).andThen((text) => {
    const parsed = parseGitChanges(text);
    if (parsed.isErr()) return errAsync(parsed.error);
    return enrichManifestFields(root, baseSha, parsed.value).map((changes) => ({
      changes,
    }));
  });
}

function loadPolicyFiles(
  root: string,
  ledgerRef: string,
): ResultAsync<
  { changesets: readonly ValidatedChangeset[]; ledger: ConsumptionLedger },
  ReleasePolicyError
> {
  const changesetDirectory = join(root, ".changeset");
  const validated = new ChangesetPolicyValidator(new BunChangesetFileSystem())
    .validateDirectory(changesetDirectory)
    .mapErr(
      (errors): ReleasePolicyError => ({
        type: "ChangesetPolicyFailed",
        errors,
      }),
    );
  return validated.andThen((changesets) =>
    loadLedgerAtRef(root, ledgerRef).map((ledger) => ({ changesets, ledger })),
  );
}

function loadLedgerAtRef(
  root: string,
  ref: string,
): ResultAsync<ConsumptionLedger, ReleasePolicyError> {
  let loaded: ResultAsync<
    { packageName: PublicPackageName; path: string; contents: string }[],
    ReleasePolicyError
  > = okAsync([]);
  for (const packageName of publishablePackageNames()) {
    const path = `${PUBLIC_PACKAGES[packageName].directory}/CHANGELOG.md`;
    loaded = loaded.andThen((sources) =>
      readGit(root, ["show", `${ref}:${path}`], true).map((contents) =>
        contents.length === 0
          ? sources
          : [...sources, { packageName, path, contents }],
      ),
    );
  }
  return loaded.andThen((sources) =>
    liftResult(parseConsumptionLedger(sources)).mapErr(
      (error): ReleasePolicyError => ({ type: "LedgerInvalid", error }),
    ),
  );
}

function parseGitChanges(
  text: string,
): Result<readonly ReleaseChange[], ReleasePolicyError> {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length > RELEASE_POLICY_LIMITS.changes)
    return err({
      type: "ReleasePolicyInputBoundExceeded",
      field: "changes",
      limit: RELEASE_POLICY_LIMITS.changes,
      actual: lines.length,
    });
  const changes: ReleaseChange[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const code = parts[0];
    if (code === undefined) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath === undefined || newPath === undefined)
        return err({
          type: "ReleasePolicyGitFailed",
          operation: "parse diff",
          message: `rename/copy entry is incomplete: ${line}`,
        });
      changes.push({ path: oldPath, status: "removed" });
      changes.push({ path: newPath, status: "added" });
      continue;
    }
    const path = parts.slice(1).join(" ");
    if (path.length === 0)
      return err({
        type: "ReleasePolicyGitFailed",
        operation: "parse diff",
        message: `diff entry has no path: ${line}`,
      });
    let status: ReleaseChange["status"] = "modified";
    if (code[0] === "A") status = "added";
    else if (code[0] === "D") status = "removed";
    changes.push({ path, status });
  }
  return ok(changes);
}

function enrichManifestFields(
  root: string,
  baseSha: string,
  changes: readonly ReleaseChange[],
): ResultAsync<readonly ReleaseChange[], ReleasePolicyError> {
  let result: ResultAsync<readonly ReleaseChange[], ReleasePolicyError> =
    okAsync([]);
  for (const change of changes) {
    if (!change.path.endsWith("/package.json")) {
      result = result.map((items) => [...items, change]);
      continue;
    }
    result = result.andThen((items) =>
      readGit(root, ["show", `${baseSha}:${change.path}`], true).andThen(
        (before) =>
          readText(join(root, change.path)).map((after) => [
            ...items,
            {
              ...change,
              manifestFields: changedJsonFields(before, after),
            },
          ]),
      ),
    );
  }
  return result;
}

function changedJsonFields(before: string, after: string): readonly string[] {
  const oldValue = parseJsonValue(before);
  const newValue = parseJsonValue(after);
  if (!isRecord(oldValue) || !isRecord(newValue)) return ["invalid-json"];
  const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  return [...keys].filter(
    (key) => JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key]),
  );
}

function parseEvent(
  text: string,
): Result<PullRequestEvent, ReleasePolicyError> {
  const parsed = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => ({
      type: "ReleasePolicyGitFailed" as const,
      operation: "parse event",
      message: "GitHub event JSON is invalid",
    }),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (!isRecord(parsed.value))
    return err({
      type: "ReleasePolicyGitFailed",
      operation: "parse event",
      message: "GitHub event JSON must be an object",
    });
  return ok(parsed.value as PullRequestEvent);
}

function readBoundedText(
  path: string,
  limit: number,
): ResultAsync<string, ReleasePolicyError> {
  return ResultAsync.fromPromise(Bun.file(path).text(), () => ({
    type: "ReleasePolicyGitFailed" as const,
    operation: `read ${path}`,
    message: "event file could not be read",
  })).andThen((text) => {
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes > limit
      ? errAsync({
          type: "ReleasePolicyInputBoundExceeded" as const,
          field: path,
          limit,
          actual: bytes,
        })
      : okAsync(text);
  });
}

function readText(path: string): ResultAsync<string, ReleasePolicyError> {
  return ResultAsync.fromPromise(Bun.file(path).text(), () => ({
    type: "ReleasePolicyGitFailed" as const,
    operation: `read ${path}`,
    message: "file could not be read",
  }));
}

function readGit(
  root: string,
  args: readonly string[],
  allowMissing = false,
): ResultAsync<string, ReleasePolicyError> {
  const argv = ["git", "-C", root, ...args];
  return ResultAsync.fromThrowable(
    () => {
      const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      return Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    },
    (cause) => ({
      type: "ReleasePolicyGitFailed" as const,
      operation: args.join(" "),
      message: String(cause),
    }),
  )().andThen(([exitCode, stdout, stderr]) => {
    if (exitCode === 0) {
      const bytes = new TextEncoder().encode(stdout).byteLength;
      if (bytes > RELEASE_POLICY_LIMITS.gitOutputBytes)
        return errAsync({
          type: "ReleasePolicyInputBoundExceeded" as const,
          field: `git ${args.join(" ")}`,
          limit: RELEASE_POLICY_LIMITS.gitOutputBytes,
          actual: bytes,
        });
      return okAsync(stdout);
    }
    if (allowMissing && args[0] === "show") return okAsync("");
    return errAsync({
      type: "ReleasePolicyGitFailed" as const,
      operation: args.join(" "),
      message: stderr.trim().slice(0, 2_000),
    });
  });
}

function liftResult<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

if (import.meta.main) {
  const result = await runReleasePolicyCheck();
  result.match(
    (value) => {
      if (value.status === "skipped") {
        log.info(value, "Release policy skipped outside a pull request");
        return;
      }
      log.info(
        {
          mode: value.mode,
          releaseRules: value.releaseRules,
          changedPaths: value.changedPaths.length,
        },
        "Release policy passed",
      );
    },
    (error) => {
      log.error(
        {
          error,
          recovery: "recovery" in error ? error.recovery : undefined,
        },
        "Release policy failed",
      );
      process.exitCode = 1;
    },
  );
}
