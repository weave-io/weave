/**
 * The single typed release record, and the recompute boundary around it.
 *
 * A {@link ReleasePlan} binds one release's seed selection, the closure that
 * expanded it with reasons, the consumed changeset identities, the per-package
 * versions, the canonical changelog digests, the green `main` SHA the release
 * PR was generated from (`baseSha`), the squash-merge commit it was released
 * as (`releasedSha`), the docs-release-audit outcome bound to that same
 * `baseSha`, and — only after a build — the tarball binding.
 *
 * Three rules shape the whole module:
 *
 * - **Recompute before trust.** A stored plan is data, never authority.
 *   {@link recomputePlan} rebuilds every authoritative field from the tree at a
 *   ref plus merge state, then structurally compares, naming the exact field
 *   path that diverged.
 * - **`baseSha` and `releasedSha` are never conflated.** Freshness and the docs
 *   audit bind to `baseSha`; builds, proofs, publication, and tags bind to
 *   `releasedSha`. A binding built at any other SHA is unusable.
 * - **No committed release state.** Plans travel in workflow artifacts and the
 *   hidden release-PR metadata block only. {@link readPlanCarrier} refuses
 *   `.release/` and every other repository state path, and workflow artifacts
 *   stay cache: their presence is cross-checked, never trusted.
 */
import { isAbsolute, normalize } from "node:path";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import type { ChangesetIdentity } from "./changeset-policy.js";
import {
  NPM_DIGEST_PREFIX,
  PRIVATE_PACKAGE_NAMES,
  type PublicPackageName,
  RELEASE_CHANNELS,
  RELEASE_CONTROL_REF,
  RELEASE_INPUT_LIMITS,
  RELEASE_PR_MARKER_REF,
  type ReleaseChannel,
} from "./constants.js";
import { LedgerBlockSchema } from "./consumption-ledger.js";
import { publishablePackageNames } from "./package-policy.js";
import type {
  ChangedSourceName,
  SelectionClosure,
} from "./selection-closure.js";

/** Schema version of the plan contract this module reads and writes. */
export const RELEASE_PLAN_SCHEMA_VERSION = 1 as const;

/** Opening word of the hidden release-PR metadata block. */
export const RELEASE_PLAN_MARKER = "weave-release-plan" as const;

/** Bounds, so no carrier, plan, or binding is ever unbounded input. */
export const RELEASE_PLAN_LIMITS = {
  carrierBytes: 256 * 1024,
  jsonDepth: 32,
  consumedChangesets: 512,
  packages: RELEASE_INPUT_LIMITS.packageCount,
  entryPoints: 32,
  dependencyPath: 16,
  pathLength: 256,
} as const;

/**
 * The states the docs-release-audit AI half may be in when no AI digest
 * exists. Task 19 fills the real outcome; this module only owns the slot.
 */
export const DOCS_AUDIT_AI_STATUSES = ["not-required", "unavailable"] as const;

export type DocsAuditAiStatus = (typeof DOCS_AUDIT_AI_STATUSES)[number];

/** The branch a release PR must merge into for its merge commit to count. */
const MAIN_BRANCH = RELEASE_CONTROL_REF.slice("refs/heads/".length);

const FULL_SHA = /^[0-9a-f]{40}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RELATIVE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@][A-Za-z0-9@._/-]*$/;
const WORKSPACE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,127}$/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const BLOCK_HEADER = new RegExp(`^${RELEASE_PLAN_MARKER}:(\\d+)$`);
const RELEASE_STATE_DIRECTORY = ".release";

/**
 * Package, identity, and version contracts come from the ledger block and the
 * catalog, so the plan can never drift from what a changeset or a publishable
 * package is anywhere else in the pipeline.
 */
const ChangesetIdentitySchema = LedgerBlockSchema.shape.changesets.element;
const PublicPackageNameSchema = LedgerBlockSchema.shape.package;
const StableVersionSchema = LedgerBlockSchema.shape.version;

const FullShaSchema = z.string().regex(FULL_SHA);
const SemVerSchema = z.string().min(1).max(64).regex(SEMVER);
const DigestSchema = z
  .string()
  .regex(new RegExp(`^${NPM_DIGEST_PREFIX}[0-9a-f]{64}$`));
const CHANGED_SOURCE_NAMES: ChangedSourceName[] = [
  ...publishablePackageNames(),
  ...PRIVATE_PACKAGE_NAMES,
];
const ChangedSourceNameSchema = z.enum(
  CHANGED_SOURCE_NAMES as [ChangedSourceName, ...ChangedSourceName[]],
);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(RELEASE_PLAN_LIMITS.pathLength)
  .regex(RELATIVE_PATH);

// ---------------------------------------------------------------------------
// Selection closure (Task 5's result, carried verbatim)
// ---------------------------------------------------------------------------

const SharedChangesetEvidenceSchema = z
  .object({
    changesetId: ChangesetIdentitySchema.shape.id,
    sourceDigest: ChangesetIdentitySchema.shape.sourceDigest,
    trigger: PublicPackageNameSchema,
    members: z
      .array(PublicPackageNameSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
  })
  .strict();

const ArtifactDependencyEvidenceSchema = z
  .object({
    changesetId: ChangesetIdentitySchema.shape.id,
    sourceDigest: ChangesetIdentitySchema.shape.sourceDigest,
    trigger: PublicPackageNameSchema,
    source: ChangedSourceNameSchema,
    relationship: z.enum([
      "changed-artifact",
      "manifest-dependency",
      "declared-impact",
    ]),
    dependencyPath: z
      .array(z.string().regex(WORKSPACE_NAME))
      .max(RELEASE_PLAN_LIMITS.dependencyPath),
  })
  .strict();

const SelectionReasonSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shared-changeset"),
      evidence: SharedChangesetEvidenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact-dependency"),
      evidence: ArtifactDependencyEvidenceSchema,
    })
    .strict(),
]);

const SelectionClosureSchema = z
  .object({
    seed: z
      .array(PublicPackageNameSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    selected: z
      .array(PublicPackageNameSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    added: z
      .array(
        z
          .object({
            package: PublicPackageNameSchema,
            reason: SelectionReasonSchema,
          })
          .strict(),
      )
      .max(RELEASE_PLAN_LIMITS.packages),
  })
  .strict();

// ---------------------------------------------------------------------------
// Plan sections
// ---------------------------------------------------------------------------

/** One released package's version move. */
export const ReleasePlanVersionSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    previousVersion: SemVerSchema,
    version: SemVerSchema,
  })
  .strict();

/** The canonical changelog document digest a release published for a package. */
export const ReleasePlanChangelogDigestSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    version: SemVerSchema,
    documentDigest: DigestSchema,
  })
  .strict();

/**
 * The docs-release-audit gate outcome (Task 19), bound to the SHA it audited.
 * `auditedSha` must equal the plan's `baseSha`, so a docs result computed at an
 * older SHA can never authorize newer release content.
 */
export const ReleaseDocsAuditSchema = z
  .object({
    auditedSha: FullShaSchema,
    deterministicResultDigest: DigestSchema,
    aiResultDigestOrStatus: z.union([
      DigestSchema,
      z.enum(DOCS_AUDIT_AI_STATUSES),
    ]),
  })
  .strict();

/** A proof slot later tasks fill; `pending` is the honest empty state. */
export const ReleaseProofMarkerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("recorded"), digest: DigestSchema }).strict(),
]);

/** Every proof the publication chain must record against built bytes. */
export const ReleaseProofMarkersSchema = z
  .object({
    attestation: ReleaseProofMarkerSchema,
    cleanConsumer: ReleaseProofMarkerSchema,
    harnessProof: ReleaseProofMarkerSchema,
    registryVerification: ReleaseProofMarkerSchema,
  })
  .strict();

const ReleasePlanTarballSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    version: SemVerSchema,
    path: RelativePathSchema.regex(/\.tgz$/),
    sha256: DigestSchema,
  })
  .strict();

const ReleasePlanManifestDigestSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    stagedManifestDigest: DigestSchema,
    publicManifestDigest: DigestSchema,
  })
  .strict();

const ReleasePlanEntryPointDigestSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    entryPoint: RelativePathSchema,
    digest: DigestSchema,
  })
  .strict();

/**
 * What a build proved about one exact SHA.
 *
 * The binding is cache: losing it never blocks, and holding it never
 * authorizes. It becomes usable for publication only when `builtSha` equals a
 * non-null `releasedSha`.
 */
export const ReleasePlanBindingSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_PLAN_SCHEMA_VERSION),
    builtSha: FullShaSchema,
    tarballs: z
      .array(ReleasePlanTarballSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    manifestDigests: z
      .array(ReleasePlanManifestDigestSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    changelogDigests: z
      .array(ReleasePlanChangelogDigestSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    entryPointDigests: z
      .array(ReleasePlanEntryPointDigestSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.entryPoints),
    proofMarkers: ReleaseProofMarkersSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    const packages = binding.tarballs.map((tarball) => tarball.packageName);
    requireUnique(packages, context, ["tarballs"], "package");
    requireUnique(
      binding.tarballs.map((tarball) => tarball.path),
      context,
      ["tarballs"],
      "path",
    );
    requireSameSequence(
      binding.manifestDigests.map((entry) => entry.packageName),
      packages,
      context,
      ["manifestDigests"],
    );
    requireSameSequence(
      binding.changelogDigests.map((entry) => entry.packageName),
      packages,
      context,
      ["changelogDigests"],
    );
    requireUnique(
      binding.entryPointDigests.map(
        (entry) => `${entry.packageName}\u0000${entry.entryPoint}`,
      ),
      context,
      ["entryPointDigests"],
      "entry point",
    );
    for (const entry of binding.entryPointDigests)
      if (!packages.includes(entry.packageName))
        context.addIssue({
          code: "custom",
          path: ["entryPointDigests"],
          message: `entry point digest for unbuilt package ${entry.packageName}`,
        });
  });

/** The one record that binds a release. */
export const ReleasePlanSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_PLAN_SCHEMA_VERSION),
    channel: z.enum(RELEASE_CHANNELS),
    /** The maintainer's exact seed, before closure. */
    seed: z
      .array(PublicPackageNameSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    closure: SelectionClosureSchema,
    consumed: z
      .array(ChangesetIdentitySchema)
      .max(RELEASE_PLAN_LIMITS.consumedChangesets),
    versions: z
      .array(ReleasePlanVersionSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    changelogDigests: z
      .array(ReleasePlanChangelogDigestSchema)
      .min(1)
      .max(RELEASE_PLAN_LIMITS.packages),
    /** The green `main` SHA this plan was generated from. */
    baseSha: FullShaSchema,
    /** The squash-merge commit on `main`; null until the release PR merges. */
    releasedSha: FullShaSchema.nullable(),
    docsAudit: ReleaseDocsAuditSchema,
    binding: ReleasePlanBindingSchema.nullable(),
  })
  .strict()
  .superRefine((plan, context) => {
    validateSelection(plan, context);
    validateVersions(plan, context);
    validateConsumed(plan, context);
    if (plan.docsAudit.auditedSha !== plan.baseSha)
      context.addIssue({
        code: "custom",
        path: ["docsAudit", "auditedSha"],
        message: "the docs audit must be bound to this plan's baseSha",
      });
    validateBinding(plan, context);
  });

/** The envelope a workflow artifact carries: cache, and self-describing. */
export const ReleasePlanArtifactSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_PLAN_SCHEMA_VERSION),
    planDigest: DigestSchema,
    plan: ReleasePlanSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.planDigest !== releasePlanDigest(artifact.plan))
      context.addIssue({
        code: "custom",
        path: ["planDigest"],
        message: "planDigest must be the digest of the carried plan",
      });
  });

export type ReleasePlan = z.infer<typeof ReleasePlanSchema>;
export type ReleasePlanBinding = z.infer<typeof ReleasePlanBindingSchema>;
export type ReleasePlanVersion = z.infer<typeof ReleasePlanVersionSchema>;
export type ReleasePlanChangelogDigest = z.infer<
  typeof ReleasePlanChangelogDigestSchema
>;
export type ReleaseDocsAudit = z.infer<typeof ReleaseDocsAuditSchema>;
export type ReleaseProofMarker = z.infer<typeof ReleaseProofMarkerSchema>;
export type ReleaseProofMarkers = z.infer<typeof ReleaseProofMarkersSchema>;
export type ReleasePlanArtifact = z.infer<typeof ReleasePlanArtifactSchema>;

type Assert<T extends true> = T;
/** The plan carries Task 5's closure and Task 3's identities, not copies. */
export type _ClosureContract = Assert<
  ReleasePlan["closure"] extends SelectionClosure ? true : false
>;
export type _IdentityContract = Assert<
  ReleasePlan["consumed"][number] extends ChangesetIdentity ? true : false
>;
export type _ChannelContract = Assert<
  ReleasePlan["channel"] extends ReleaseChannel ? true : false
>;
export type _PackageContract = Assert<
  ReleasePlan["seed"][number] extends PublicPackageName ? true : false
>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReleasePlanError =
  /** Validation and bounded parsing. */
  | { type: "InvalidReleasePlan"; issues: readonly string[] }
  | { type: "InvalidReleasePlanArtifact"; issues: readonly string[] }
  | { type: "InvalidReleasePlanBinding"; issues: readonly string[] }
  | { type: "ReleasePlanTooLarge"; bytes: number; limit: number }
  | { type: "ReleasePlanTooDeep"; depth: number; limit: number }
  | { type: "MalformedReleasePlanJson"; reason: string }
  | { type: "DuplicateReleasePlanKey"; path: string; key: string }
  /** Carriers. */
  | { type: "MissingPlanMetadataBlock" }
  | { type: "MultiplePlanMetadataBlocks"; count: number }
  | { type: "UnsupportedPlanSchema"; schemaVersion: number }
  | {
      type: "ForbiddenPlanCarrier";
      path: string;
      reason:
        | "committed-repository-path"
        | "relative-path"
        | "release-state-directory";
    }
  /** Identity. */
  | { type: "PlanDigestMismatch"; expected: string; actual: string }
  | { type: "PlanDivergence"; path: string; expected: unknown; actual: unknown }
  /** Docs audit. */
  | { type: "MissingDocsAudit"; ref: string }
  | { type: "DocsAuditShaMismatch"; auditedSha: string; baseSha: string }
  /** Binding. */
  | { type: "MissingBinding" }
  | { type: "PlanNotReleased" }
  | { type: "BindingShaMismatch"; expected: string; actual: string }
  | {
      type: "BindingMismatch";
      path: string;
      expected: unknown;
      actual: unknown;
    }
  /** Released-SHA resolution and recompute. */
  | { type: "InvalidRecomputeRef"; ref: string }
  | { type: "ReleasePrNotMerged"; pullRequestNumber: number }
  | { type: "MissingMergeCommitSha"; pullRequestNumber: number }
  | {
      type: "UnexpectedReleasePrRef";
      pullRequestNumber: number;
      field: "baseRef" | "headRef";
      expected: string;
      actual: string;
    }
  | { type: "MergedShaMismatch"; expected: string; actual: string }
  | { type: "MergedPullRequestPortMissing" }
  | { type: "RecomputePortFailed"; port: string; message: string }
  | { type: "InvalidRecomputedPlan"; issues: readonly string[] };

// ---------------------------------------------------------------------------
// Validation, serialization, and identity
// ---------------------------------------------------------------------------

/** Validates an untrusted value as a plan. Validation is not authority. */
export function validateReleasePlan(
  input: unknown,
): Result<ReleasePlan, ReleasePlanError> {
  const parsed = ReleasePlanSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidReleasePlan",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

/** Validates an untrusted value as a workflow-artifact plan envelope. */
export function validateReleasePlanArtifact(
  input: unknown,
): Result<ReleasePlanArtifact, ReleasePlanError> {
  const parsed = ReleasePlanArtifactSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidReleasePlanArtifact",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

/**
 * Renders the canonical bytes of a plan: keys sorted at every depth, so the
 * same plan always serializes to the same string and the same digest.
 */
export function serializeReleasePlan(
  plan: ReleasePlan,
): Result<string, ReleasePlanError> {
  return validateReleasePlan(plan).map((validated) =>
    JSON.stringify(sortValue(validated), null, 2),
  );
}

/** Reads canonical plan bytes back, bounded and duplicate-key intolerant. */
export function parseReleasePlan(
  text: string,
): Result<ReleasePlan, ReleasePlanError> {
  return parseBoundedJson(text).andThen(validateReleasePlan);
}

/** Renders the workflow-artifact envelope for a plan. */
export function serializeReleasePlanArtifact(
  plan: ReleasePlan,
): Result<string, ReleasePlanError> {
  return validateReleasePlan(plan).map((validated) =>
    JSON.stringify(
      sortValue({
        schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
        planDigest: releasePlanDigest(validated),
        plan: validated,
      }),
      null,
      2,
    ),
  );
}

/** Reads a workflow-artifact envelope back. The plan still needs recompute. */
export function parseReleasePlanArtifact(
  text: string,
): Result<ReleasePlanArtifact, ReleasePlanError> {
  return parseBoundedJson(text).andThen(validateReleasePlanArtifact);
}

/** The plan's identity: SHA-256 over its canonical bytes. */
export function releasePlanDigest(plan: ReleasePlan): string {
  return digestOf(JSON.stringify(sortValue(plan)));
}

/** Fails closed when a carried digest does not identify the carried plan. */
export function verifyReleasePlanDigest(
  plan: ReleasePlan,
  expected: string,
): Result<string, ReleasePlanError> {
  const actual = releasePlanDigest(plan);
  if (actual !== expected)
    return err({ type: "PlanDigestMismatch", expected, actual });
  return ok(actual);
}

// ---------------------------------------------------------------------------
// Carriers: workflow artifacts and the hidden release-PR metadata block
// ---------------------------------------------------------------------------

export interface PlanCarrierOptions {
  /** Absolute path of the repository working tree, so committed state is known. */
  repositoryRoot: string;
}

/** The only two places a plan may be read from. */
export type PlanCarrier =
  | { kind: "workflow-artifact"; path: string; contents: string }
  | { kind: "pull-request-metadata"; body: string };

/** The only two places a plan may be written to. */
export type PlanCarrierTarget =
  | { kind: "workflow-artifact"; path: string }
  | { kind: "pull-request-metadata" };

/**
 * Refuses any plan path that is repository state.
 *
 * Committed release state is prohibited outright (decision 13), and `.release/`
 * stays gitignored cache, so neither may ever carry a plan.
 */
export function assertPlanPathAllowed(
  path: string,
  options: PlanCarrierOptions,
): Result<string, ReleasePlanError> {
  if (!isAbsolute(path))
    return err({
      type: "ForbiddenPlanCarrier",
      path,
      reason: "relative-path",
    });
  const normalized = stripTrailingSlash(normalize(path));
  const root = stripTrailingSlash(normalize(options.repositoryRoot));
  if (normalized === root || normalized.startsWith(`${root}/`))
    return err({
      type: "ForbiddenPlanCarrier",
      path: normalized,
      reason: "committed-repository-path",
    });
  if (normalized.split("/").includes(RELEASE_STATE_DIRECTORY))
    return err({
      type: "ForbiddenPlanCarrier",
      path: normalized,
      reason: "release-state-directory",
    });
  return ok(normalized);
}

/** Reads a plan from a validated carrier. The plan still needs recompute. */
export function readPlanCarrier(
  carrier: PlanCarrier,
  options: PlanCarrierOptions,
): Result<ReleasePlan, ReleasePlanError> {
  if (carrier.kind === "pull-request-metadata")
    return parsePlanMetadataBlock(carrier.body);
  return assertPlanPathAllowed(carrier.path, options).andThen(() =>
    parseReleasePlanArtifact(carrier.contents).map((artifact) => artifact.plan),
  );
}

/** Renders the bytes a validated carrier may persist. Callers own the I/O. */
export function writePlanCarrier(
  plan: ReleasePlan,
  target: PlanCarrierTarget,
  options: PlanCarrierOptions,
): Result<string, ReleasePlanError> {
  if (target.kind === "pull-request-metadata")
    return renderPlanMetadataBlock(plan);
  return assertPlanPathAllowed(target.path, options).andThen(() =>
    serializeReleasePlanArtifact(plan),
  );
}

/** Renders the hidden metadata block a release PR body embeds. */
export function renderPlanMetadataBlock(
  plan: ReleasePlan,
): Result<string, ReleasePlanError> {
  return serializeReleasePlan(plan).map(
    (body) =>
      `${COMMENT_OPEN} ${RELEASE_PLAN_MARKER}:${RELEASE_PLAN_SCHEMA_VERSION}\n${body}\n${COMMENT_CLOSE}`,
  );
}

/**
 * Reads the one hidden metadata block out of a release-PR body.
 *
 * Ordinary HTML comments are skipped, so human PR prose never becomes a parse
 * failure; two plan blocks are a typed failure, because a body that claims two
 * plans has no single identity.
 */
export function parsePlanMetadataBlock(
  body: string,
): Result<ReleasePlan, ReleasePlanError> {
  if (body.length > RELEASE_PLAN_LIMITS.carrierBytes)
    return err({
      type: "ReleasePlanTooLarge",
      bytes: body.length,
      limit: RELEASE_PLAN_LIMITS.carrierBytes,
    });
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const open = body.indexOf(COMMENT_OPEN, cursor);
    if (open === -1) break;
    const close = body.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) {
      const rest = body.slice(open);
      if (!rest.includes(RELEASE_PLAN_MARKER)) break;
      return err({
        type: "MalformedReleasePlanJson",
        reason: "a plan metadata comment is never closed",
      });
    }
    const inner = body.slice(open + COMMENT_OPEN.length, close);
    cursor = close + COMMENT_CLOSE.length;
    if (inner.trim().startsWith(RELEASE_PLAN_MARKER)) blocks.push(inner.trim());
  }
  if (blocks.length === 0) return err({ type: "MissingPlanMetadataBlock" });
  if (blocks.length > 1)
    return err({ type: "MultiplePlanMetadataBlocks", count: blocks.length });
  return readMetadataBlock(blocks[0] ?? "");
}

function readMetadataBlock(
  block: string,
): Result<ReleasePlan, ReleasePlanError> {
  const newline = block.indexOf("\n");
  const header = (newline === -1 ? block : block.slice(0, newline)).trim();
  const match = BLOCK_HEADER.exec(header);
  if (match === null)
    return err({
      type: "MalformedReleasePlanJson",
      reason: `expected ${RELEASE_PLAN_MARKER}:<schema version>`,
    });
  const schemaVersion = Number(match[1]);
  if (schemaVersion !== RELEASE_PLAN_SCHEMA_VERSION)
    return err({ type: "UnsupportedPlanSchema", schemaVersion });
  return parseReleasePlan(newline === -1 ? "" : block.slice(newline + 1));
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/**
 * Attaches a build's binding to the plan it was built for.
 *
 * A binding is publication material only when it was built at the exact
 * released SHA, so a preparation plan can never carry one and a build at any
 * other commit is refused by SHA, not by name.
 */
export function attachReleasePlanBinding(
  plan: ReleasePlan,
  binding: unknown,
): Result<ReleasePlan, ReleasePlanError> {
  return validateBindingShape(binding)
    .andThen((validated) => checkBindingAgainstPlan(plan, validated))
    .andThen((validated) =>
      validateReleasePlan({ ...plan, binding: validated }),
    );
}

/**
 * Verifies the plan's own binding, or an external candidate, against the plan.
 *
 * Verification never upgrades cache into authority: it only proves that these
 * bytes belong to this released SHA.
 */
export function verifyReleasePlanBinding(
  plan: ReleasePlan,
  candidate?: unknown,
): Result<ReleasePlanBinding, ReleasePlanError> {
  const supplied = candidate ?? plan.binding;
  if (supplied === null || supplied === undefined)
    return err({ type: "MissingBinding" });
  return validateBindingShape(supplied).andThen((validated) =>
    checkBindingAgainstPlan(plan, validated),
  );
}

function validateBindingShape(
  binding: unknown,
): Result<ReleasePlanBinding, ReleasePlanError> {
  const parsed = ReleasePlanBindingSchema.safeParse(binding);
  if (!parsed.success)
    return err({
      type: "InvalidReleasePlanBinding",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

function checkBindingAgainstPlan(
  plan: ReleasePlan,
  binding: ReleasePlanBinding,
): Result<ReleasePlanBinding, ReleasePlanError> {
  if (plan.releasedSha === null) return err({ type: "PlanNotReleased" });
  if (binding.builtSha !== plan.releasedSha)
    return err({
      type: "BindingShaMismatch",
      expected: plan.releasedSha,
      actual: binding.builtSha,
    });
  const built = binding.tarballs.map((tarball) => tarball.packageName);
  const released = plan.versions.map((entry) => entry.packageName);
  const divergence = firstDivergentPath(released, built, "binding.tarballs");
  if (divergence !== null)
    return err({ type: "BindingMismatch", ...divergence });
  for (const [index, tarball] of binding.tarballs.entries()) {
    const expected = plan.versions[index];
    if (expected !== undefined && tarball.version !== expected.version)
      return err({
        type: "BindingMismatch",
        path: `binding.tarballs.${index}.version`,
        expected: expected.version,
        actual: tarball.version,
      });
  }
  // Only stable packs the canonical source changelog; `next` and nightly pack
  // deterministic scratch overrides, so their packed digests legitimately
  // differ from the plan's source-document digests.
  if (plan.channel === "stable") {
    const changelogs = firstDivergentPath(
      plan.changelogDigests,
      binding.changelogDigests,
      "binding.changelogDigests",
    );
    if (changelogs !== null)
      return err({ type: "BindingMismatch", ...changelogs });
  }
  return ok(binding);
}

// ---------------------------------------------------------------------------
// Released-SHA resolution
// ---------------------------------------------------------------------------

/** The merged release PR, as an injected port reports it. */
export interface MergedReleasePullRequest {
  number: number;
  merged: boolean;
  /** GitHub's `merge_commit_sha`; null while the PR is open. */
  mergeCommitSha: string | null;
  /** The SHA the PR was opened against: the plan's `baseSha`. */
  baseSha: string;
  baseRef: string;
  headRef: string;
}

export interface RecomputePortFailure {
  port: string;
  message: string;
}

/** Reads merge state without this module ever touching GitHub. */
export interface MergedPullRequestPort {
  readMergedReleasePullRequest(request: {
    pullRequestNumber: number;
  }): ResultAsync<MergedReleasePullRequest, RecomputePortFailure>;
}

/**
 * Resolves and validates the squash-merge commit a release was published as.
 *
 * The merge commit counts only when it came from the one release ref into
 * `main`; anything else is a typed refusal rather than a SHA to build from.
 */
export function resolveReleasedSha(
  request: { pullRequestNumber: number },
  port: MergedPullRequestPort,
): ResultAsync<MergedReleasePullRequest, ReleasePlanError> {
  return port
    .readMergedReleasePullRequest(request)
    .mapErr(toPortError)
    .andThen((merged) => validateMergedPullRequest(request, merged));
}

function validateMergedPullRequest(
  request: { pullRequestNumber: number },
  merged: MergedReleasePullRequest,
): Result<MergedReleasePullRequest, ReleasePlanError> {
  if (!merged.merged)
    return err({
      type: "ReleasePrNotMerged",
      pullRequestNumber: request.pullRequestNumber,
    });
  if (merged.baseRef !== MAIN_BRANCH)
    return err({
      type: "UnexpectedReleasePrRef",
      pullRequestNumber: request.pullRequestNumber,
      field: "baseRef",
      expected: MAIN_BRANCH,
      actual: merged.baseRef,
    });
  if (merged.headRef !== RELEASE_PR_MARKER_REF)
    return err({
      type: "UnexpectedReleasePrRef",
      pullRequestNumber: request.pullRequestNumber,
      field: "headRef",
      expected: RELEASE_PR_MARKER_REF,
      actual: merged.headRef,
    });
  if (
    merged.mergeCommitSha === null ||
    !FULL_SHA.test(merged.mergeCommitSha) ||
    !FULL_SHA.test(merged.baseSha)
  )
    return err({
      type: "MissingMergeCommitSha",
      pullRequestNumber: request.pullRequestNumber,
    });
  return ok(merged);
}

// ---------------------------------------------------------------------------
// Recompute-and-compare
// ---------------------------------------------------------------------------

/** Everything a plan asserts that a tree plus merge state can prove. */
export interface RecomputedPlanFacts {
  closure: SelectionClosure;
  consumed: readonly ChangesetIdentity[];
  versions: readonly ReleasePlanVersion[];
  changelogDigests: readonly ReleasePlanChangelogDigest[];
  /** Absent when the docs-release-audit gate produced no outcome at this ref. */
  docsAudit: ReleaseDocsAudit | null;
}

export interface RecomputeFactsRequest {
  ref: string;
  channel: ReleaseChannel;
  /** The maintainer's seed: an input to recomputation, not a fact about it. */
  seed: readonly PublicPackageName[];
}

/** The injected boundary that rebuilds authority; no live GitHub in tests. */
export interface ReleasePlanRecomputePorts
  extends Partial<MergedPullRequestPort> {
  recomputeFacts(
    request: RecomputeFactsRequest,
  ): ResultAsync<RecomputedPlanFacts, RecomputePortFailure>;
}

/**
 * Preparation binds to `baseSha` and carries no publication binding;
 * post-merge binds to the merged PR's `merge_commit_sha`.
 */
export type RecomputeMode =
  | { kind: "preparation" }
  | { kind: "post-merge"; pullRequestNumber: number };

export interface RecomputePlanRequest {
  /** The exact commit whose tree the recomputation reads. */
  ref: string;
  /** The stored plan. Untrusted until this call returns. */
  stored: unknown;
  mode: RecomputeMode;
}

/**
 * Rebuilds every authoritative field from `ref` and compares it structurally
 * against the stored plan.
 *
 * The returned plan is the recomputed one, never the stored one, so a caller
 * that acts on this result is acting on authority. Any difference is a typed
 * {@link ReleasePlanError} naming the exact field path.
 */
export function recomputePlan(
  request: RecomputePlanRequest,
  ports: ReleasePlanRecomputePorts,
): ResultAsync<ReleasePlan, ReleasePlanError> {
  if (!FULL_SHA.test(request.ref))
    return errAsync({ type: "InvalidRecomputeRef", ref: request.ref });
  const stored = validateReleasePlan(request.stored);
  if (stored.isErr()) return errAsync(stored.error);
  const plan = stored.value;
  return resolveRecomputeShas(request, ports).andThen((shas) =>
    ports
      .recomputeFacts({
        ref: request.ref,
        channel: plan.channel,
        seed: plan.seed,
      })
      .mapErr(toPortError)
      .andThen((facts) => comparePlan(request, plan, shas, facts)),
  );
}

interface RecomputedShas {
  baseSha: string;
  releasedSha: string | null;
}

function resolveRecomputeShas(
  request: RecomputePlanRequest,
  ports: ReleasePlanRecomputePorts,
): ResultAsync<RecomputedShas, ReleasePlanError> {
  if (request.mode.kind === "preparation")
    return okAsync({ baseSha: request.ref, releasedSha: null });
  const port = ports.readMergedReleasePullRequest;
  if (port === undefined)
    return errAsync({ type: "MergedPullRequestPortMissing" });
  return resolveReleasedSha(
    { pullRequestNumber: request.mode.pullRequestNumber },
    { readMergedReleasePullRequest: port.bind(ports) },
  ).andThen((merged) => {
    const releasedSha = merged.mergeCommitSha ?? "";
    if (releasedSha !== request.ref)
      return err({
        type: "MergedShaMismatch" as const,
        expected: releasedSha,
        actual: request.ref,
      });
    return ok({ baseSha: merged.baseSha, releasedSha });
  });
}

function comparePlan(
  request: RecomputePlanRequest,
  stored: ReleasePlan,
  shas: RecomputedShas,
  facts: RecomputedPlanFacts,
): Result<ReleasePlan, ReleasePlanError> {
  if (facts.docsAudit === null)
    return err({ type: "MissingDocsAudit", ref: request.ref });
  if (facts.docsAudit.auditedSha !== shas.baseSha)
    return err({
      type: "DocsAuditShaMismatch",
      auditedSha: facts.docsAudit.auditedSha,
      baseSha: shas.baseSha,
    });
  if (stored.binding !== null && stored.binding.builtSha !== shas.releasedSha)
    return err({
      type: "BindingShaMismatch",
      expected: shas.releasedSha ?? "",
      actual: stored.binding.builtSha,
    });
  const candidate = {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    channel: stored.channel,
    seed: stored.seed,
    closure: facts.closure,
    consumed: facts.consumed,
    versions: facts.versions,
    changelogDigests: facts.changelogDigests,
    baseSha: shas.baseSha,
    releasedSha: shas.releasedSha,
    docsAudit: facts.docsAudit,
    // Bindings are cache, so they are carried, never recomputed — and they are
    // already proven to belong to this released SHA.
    binding: stored.binding,
  };
  const recomputed = ReleasePlanSchema.safeParse(candidate);
  if (!recomputed.success)
    return err({
      type: "InvalidRecomputedPlan",
      issues: describeIssues(recomputed.error.issues),
    });
  const divergence = firstDivergentPath(recomputed.data, stored, "");
  if (divergence !== null)
    return err({ type: "PlanDivergence", ...divergence });
  return ok(recomputed.data);
}

// ---------------------------------------------------------------------------
// Structural comparison
// ---------------------------------------------------------------------------

interface Divergence {
  path: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Finds the first field path at which two plan-shaped values differ.
 *
 * Naming the path is the point: a divergence report that says only "the plans
 * differ" cannot be acted on, while `closure.added.0.package` can.
 */
export function firstDivergentPath(
  expected: unknown,
  actual: unknown,
  path = "",
): Divergence | null {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual))
      return { path: path || "$", expected, actual };
    if (expected.length !== actual.length)
      return { path: `${path || "$"}.length`, expected, actual };
    for (const [index, item] of expected.entries()) {
      const nested = firstDivergentPath(item, actual[index], join(path, index));
      if (nested !== null) return nested;
    }
    return null;
  }
  if (isPlainObject(expected) || isPlainObject(actual)) {
    if (!isPlainObject(expected) || !isPlainObject(actual))
      return { path: path || "$", expected, actual };
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
    ].sort();
    for (const key of keys) {
      const nested = firstDivergentPath(
        expected[key],
        actual[key],
        join(path, key),
      );
      if (nested !== null) return nested;
    }
    return null;
  }
  if (expected !== actual) return { path: path || "$", expected, actual };
  return null;
}

// ---------------------------------------------------------------------------
// Bounded JSON
// ---------------------------------------------------------------------------

const parseJson = Result.fromThrowable(
  (source: string) => JSON.parse(source) as unknown,
  (cause): ReleasePlanError => ({
    type: "MalformedReleasePlanJson",
    reason: cause instanceof Error ? cause.message : String(cause),
  }),
);

/**
 * Parses plan JSON under explicit bounds.
 *
 * `JSON.parse` silently keeps the last of two identical keys, so a second scan
 * rejects duplicates: an object that names a field twice has no single meaning
 * and must never reach a schema that would validate only one of the values.
 */
export function parseBoundedJson(
  text: string,
): Result<unknown, ReleasePlanError> {
  if (text.length > RELEASE_PLAN_LIMITS.carrierBytes)
    return err({
      type: "ReleasePlanTooLarge",
      bytes: text.length,
      limit: RELEASE_PLAN_LIMITS.carrierBytes,
    });
  return parseJson(text).andThen((value) =>
    scanJsonStructure(text).map(() => value),
  );
}

interface ScanFrame {
  object: boolean;
  keys: Set<string>;
  path: string;
  awaitingKey: boolean;
  lastKey: string;
}

function scanJsonStructure(text: string): Result<void, ReleasePlanError> {
  const stack: ScanFrame[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "{" || char === "[") {
      if (stack.length >= RELEASE_PLAN_LIMITS.jsonDepth)
        return err({
          type: "ReleasePlanTooDeep",
          depth: stack.length + 1,
          limit: RELEASE_PLAN_LIMITS.jsonDepth,
        });
      stack.push({
        object: char === "{",
        keys: new Set(),
        path: framePath(stack[stack.length - 1]),
        awaitingKey: char === "{",
        lastKey: "",
      });
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (char === "," || char === ":") {
      const frame = stack[stack.length - 1];
      if (frame?.object) frame.awaitingKey = char === ",";
      index += 1;
      continue;
    }
    if (char === '"') {
      const read = readJsonString(text, index);
      if (read === null)
        return err({
          type: "MalformedReleasePlanJson",
          reason: "unterminated string",
        });
      const frame = stack[stack.length - 1];
      if (frame?.object && frame.awaitingKey) {
        if (frame.keys.has(read.value))
          return err({
            type: "DuplicateReleasePlanKey",
            path: join(frame.path, read.value) || read.value,
            key: read.value,
          });
        frame.keys.add(read.value);
        frame.lastKey = read.value;
      }
      index = read.next;
      continue;
    }
    index += 1;
  }
  return ok(undefined);
}

function framePath(parent: ScanFrame | undefined): string {
  if (parent === undefined) return "";
  return parent.object ? join(parent.path, parent.lastKey) : `${parent.path}[]`;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function readJsonString(
  text: string,
  start: number,
): { value: string; next: number } | null {
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\") {
      const escaped = text[index + 1];
      if (escaped === undefined) return null;
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (hex.length < 4) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += JSON_ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema refinements
// ---------------------------------------------------------------------------

type PlanShape = {
  channel: ReleaseChannel;
  seed: readonly string[];
  closure: {
    seed: readonly string[];
    selected: readonly string[];
    added: readonly { package: string }[];
  };
  consumed: readonly { id: string }[];
  versions: readonly {
    packageName: string;
    previousVersion: string;
    version: string;
  }[];
  changelogDigests: readonly { packageName: string; version: string }[];
  releasedSha: string | null;
  binding: { builtSha: string } | null;
};

function validateSelection(plan: PlanShape, context: z.RefinementCtx): void {
  requireUnique(plan.seed, context, ["seed"], "package");
  requireCatalogOrder(plan.seed, context, ["seed"]);
  requireCatalogOrder(plan.closure.selected, context, ["closure", "selected"]);
  requireSameSequence(plan.closure.seed, plan.seed, context, [
    "closure",
    "seed",
  ]);
  for (const packageName of plan.seed)
    if (!plan.closure.selected.includes(packageName))
      context.addIssue({
        code: "custom",
        path: ["closure", "selected"],
        message: `closure dropped the seed package ${packageName}`,
      });
  const added = plan.closure.added.map((entry) => entry.package);
  const expected = plan.closure.selected.filter(
    (packageName) => !plan.seed.includes(packageName),
  );
  requireSameSequence(added, expected, context, ["closure", "added"]);
}

function validateVersions(plan: PlanShape, context: z.RefinementCtx): void {
  requireSameSequence(
    plan.versions.map((entry) => entry.packageName),
    plan.closure.selected,
    context,
    ["versions"],
  );
  requireSameSequence(
    plan.changelogDigests.map((entry) => entry.packageName),
    plan.closure.selected,
    context,
    ["changelogDigests"],
  );
  for (const [index, entry] of plan.versions.entries()) {
    if (entry.version === entry.previousVersion)
      context.addIssue({
        code: "custom",
        path: ["versions", index, "version"],
        message: "a release must move the version",
      });
    const changelog = plan.changelogDigests[index];
    if (changelog !== undefined && changelog.version !== entry.version)
      context.addIssue({
        code: "custom",
        path: ["changelogDigests", index, "version"],
        message: "changelog digests must describe the released version",
      });
    if (plan.channel !== "stable") continue;
    for (const [field, version] of [
      ["version", entry.version],
      ["previousVersion", entry.previousVersion],
    ] as const)
      if (!StableVersionSchema.safeParse(version).success)
        context.addIssue({
          code: "custom",
          path: ["versions", index, field],
          message: "stable versions carry no prerelease or build metadata",
        });
  }
}

function validateConsumed(plan: PlanShape, context: z.RefinementCtx): void {
  const ids = plan.consumed.map((identity) => identity.id);
  requireUnique(ids, context, ["consumed"], "changeset");
  const sorted = [...ids].sort(compareText);
  if (ids.join("\u0000") !== sorted.join("\u0000"))
    context.addIssue({
      code: "custom",
      path: ["consumed"],
      message: "consumed identities must be ordered by changeset id",
    });
}

function validateBinding(plan: PlanShape, context: z.RefinementCtx): void {
  if (plan.releasedSha === null && plan.binding !== null)
    context.addIssue({
      code: "custom",
      path: ["binding"],
      message: "a preparation plan carries no publication binding",
    });
  if (
    plan.binding !== null &&
    plan.releasedSha !== null &&
    plan.binding.builtSha !== plan.releasedSha
  )
    context.addIssue({
      code: "custom",
      path: ["binding", "builtSha"],
      message: "a binding is usable only when built at the released SHA",
    });
}

function requireUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  label: string,
): void {
  if (new Set(values).size === values.length) return;
  context.addIssue({
    code: "custom",
    path: [...path],
    message: `every ${label} must appear once`,
  });
}

function requireSameSequence(
  actual: readonly string[],
  expected: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (actual.join("\u0000") === expected.join("\u0000")) return;
  context.addIssue({
    code: "custom",
    path: [...path],
    message: `expected exactly [${expected.join(", ")}]`,
  });
}

function requireCatalogOrder(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  const catalog = publishablePackageNames() as readonly string[];
  const expected = catalog.filter((name) => values.includes(name));
  requireSameSequence(values, expected, context, path);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toPortError(failure: RecomputePortFailure): ReleasePlanError {
  return {
    type: "RecomputePortFailed",
    port: failure.port,
    message: failure.message,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, segment: string | number): string {
  return path === "" ? String(segment) : `${path}.${segment}`;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortValue(value[key])]),
  );
}

function digestOf(value: string): string {
  return `${NPM_DIGEST_PREFIX}${new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")}`;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): readonly string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}
