/**
 * Read-only release setup doctor.
 *
 * The doctor is deliberately port-shaped. External npm and GitHub reads are
 * collected into a bounded snapshot, then a pure verifier checks that snapshot
 * against the selected rollout rung. It never writes a ref, registry record,
 * secret, workflow, or release state. An unknown or unparseable value is a
 * failure with an exact manual fix; it is never treated as healthy.
 */
import { resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RELEASE_ATTEST_WORKFLOW_PATH,
  RELEASE_PR_MARKER_REF,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
} from "./constants.js";
import { runDeterministicDocsCheck } from "./docs-audit/deterministic.js";
import {
  collectAuthoritativeReleaseLifecycle,
  type DoctorCreationCleanupReader,
  type DoctorMarkerObservation,
  type DoctorMergedReleaseObservation,
  type DoctorReleaseAuthorityReader,
  type DoctorReleaseLifecycleObservation,
  unavailableReleaseLifecycle,
} from "./doctor-lifecycle.js";
import {
  boundedResponseBytes,
  DOCTOR_TRANSPORT_LIMITS,
  type DoctorPortError,
  resolveGitHubApiUrl,
  runBoundedProcess,
  withDoctorTimeout,
} from "./doctor-transports.js";
import type { GitHubFetch } from "./github-client.js";
import {
  type ReleasePrOwnership,
  TERMINAL_RELEASE_COMPLETION_STATES,
} from "./release-pr-contract.js";
import { isTerminalPrimaryState } from "./release-state.js";
import {
  NEW_PIPELINE_SCHEDULE,
  type ReleaseRolloutMode,
  ROLLOUT_STAGE_DECLARATION,
  type RolloutStage,
  type RolloutTuple,
  type RolloutTupleError,
  validateRolloutTuple,
  type WorkflowTopology,
} from "./rollout-stage.js";

const log = logger.child({ module: "release-doctor" });

const OLD_WORKFLOW_REF = `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/heads/main`;
// GitHub's list-runs examples use the bare path and the @main forms below.
// These are exact compatibility forms, not optional identity fields.
const OLD_WORKFLOW_API_PATHS = [
  RELEASE_WORKFLOW_PATH,
  `${RELEASE_WORKFLOW_PATH}@main`,
  `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@main`,
] as const;

export const DOCTOR_MODES = [
  "pre-cutover",
  "cutover",
  "post-bootstrap-frozen",
  "activation-ready",
  "final",
] as const;
export type DoctorMode = (typeof DOCTOR_MODES)[number];

export const DOCTOR_MODE_FLAGS = {
  "--pre-cutover": "pre-cutover",
  "--cutover": "cutover",
  "--post-bootstrap-frozen": "post-bootstrap-frozen",
  "--activation-ready": "activation-ready",
} as const satisfies Readonly<Record<string, Exclude<DoctorMode, "final">>>;

export const REQUIRED_RULESET_CHECKS = [
  "ci",
  "release-policy",
  "api-reports",
  "docs-audit",
] as const;

/** Secret names are checked only as metadata. Values never enter a report. */
export const RELEASE_APP_CREDENTIAL_NAMES = [
  "RELEASE_APP_ID",
  "RELEASE_APP_PRIVATE_KEY",
] as const;
export const RELEASE_APP_SECRET_ENVIRONMENTS = [
  "release-app",
  "docs-audit-patch",
  "release-refs",
] as const;
const OBSOLETE_STORED_INSTALLATION_SECRET_NAME = [
  "RELEASE",
  "APP",
  "TOKEN",
].join("_");
export const REQUIRED_RELEASE_SECRET_NAMES = [
  ...RELEASE_APP_CREDENTIAL_NAMES,
  "WEAVE_RELEASE_AI_API_KEY",
] as const;

export const RESUME_RECOVERY_COMMAND =
  "gh workflow run release-publish.yml --ref main -f channel=stable-resume" as const;
export const INCIDENT_RECOVERY_COMMAND =
  "gh workflow run release-publish.yml --ref main -f channel=incident-resolution" as const;
export const INTERACTIVE_DEPRECATION_FIX =
  "run the generated npm deprecate commands in an interactive, authenticated maintainer session, then rerun the protected incident-resolution dispatch" as const;

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly group: string;
  readonly status: DoctorCheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export type DoctorVerdict =
  | "ReadyForCutover"
  | "CutoverVerified"
  | "ReadyForActivation"
  | "ActivationReadyVerified"
  | "FinalVerified";

export interface DoctorReport {
  readonly status: DoctorVerdict | "failed";
  readonly mode: DoctorMode;
  readonly checks: readonly DoctorCheck[];
  readonly rollout: RolloutTuple | null;
}

export type DoctorSuccess = DoctorReport & {
  readonly status: DoctorVerdict;
};

export type DoctorCheckFailure = {
  readonly type: "DoctorCheckFailed";
  readonly id: string;
  readonly detail: string;
  readonly fix: string;
};

export type DoctorVerificationError =
  | { readonly type: "InvalidDoctorMode"; readonly value: unknown }
  | {
      readonly type: "DoctorFailed";
      readonly report: DoctorReport;
      readonly failures: readonly DoctorCheckFailure[];
    }
  | {
      readonly type: "InvalidDoctorSnapshot";
      readonly issues: readonly string[];
    }
  | RolloutTupleError;

export type {
  DoctorLifecycleCollectorInput,
  DoctorReleaseAuthorityRequest,
} from "./doctor-lifecycle.js";
export type {
  DoctorCreationCleanupReader,
  DoctorMarkerObservation,
  DoctorMergedReleaseObservation,
  DoctorPortError,
  DoctorReleaseAuthorityReader,
  DoctorReleaseLifecycleObservation,
};
export { collectAuthoritativeReleaseLifecycle, unavailableReleaseLifecycle };

export interface NpmPackageObservation {
  readonly packageName: PublicPackageName;
  readonly exists: boolean;
  readonly published: boolean;
  readonly ownershipVerified: boolean;
  readonly owners?: readonly string[];
  readonly distTags: Readonly<Record<string, string>>;
}

export interface TrustedPublisherConfiguration {
  readonly provider: "github-actions";
  readonly workflow: string;
  readonly action: string;
  readonly repository: string;
  readonly environment: string | null;
}

export type TrustedPublisherParseError = {
  readonly type: "TrustedPublisherUnverifiable";
  readonly reason: string;
};

export interface DoctorEnvironmentObservation {
  readonly name: "release" | "prerelease";
  readonly exists: boolean;
  readonly readable: boolean;
  readonly protectionConfigured?: boolean;
}

export interface DoctorRulesetObservation {
  readonly exists: boolean;
  readonly readable: boolean;
  readonly targetBranch: string;
  readonly requiredChecks: readonly string[];
  readonly dismissStalePullRequestApprovals: boolean;
}

export interface DoctorTeamObservation {
  readonly organization: string;
  readonly slug: string;
  readonly exists: boolean;
  readonly readable: boolean;
}

export interface DoctorAppObservation {
  readonly installationReadable: boolean;
  readonly permissions: {
    readonly contents: string;
    readonly pullRequests: string;
    readonly checks: string;
    readonly members: string;
  };
}

export interface DoctorSecretObservation {
  readonly readable: boolean;
  readonly repositoryNames: readonly string[];
  readonly environmentNames: Readonly<Record<string, readonly string[]>>;
}

export interface DoctorGitHubObservation {
  readonly environments: Readonly<
    Record<"release" | "prerelease", DoctorEnvironmentObservation>
  >;
  readonly ruleset: DoctorRulesetObservation;
  readonly team: DoctorTeamObservation;
  readonly app: DoctorAppObservation;
  readonly secrets: DoctorSecretObservation;
}

export interface DoctorAttestationWorkflowObservation {
  readonly readable: boolean;
  readonly present: boolean;
  readonly declaresWorkflowCall: boolean;
}

export interface OldSystemOperationalProof {
  readonly authoritative: boolean;
  readonly publicationPathEnabled: boolean;
  /** True only for an accepted recent scheduled run on protected main. */
  readonly recentSuccessfulRun: boolean;
  readonly runId?: number;
  readonly evidence?: string;
}

export type OldSystemRunEvidence = {
  readonly kind: "scheduled";
  readonly runId: number;
  readonly evidence: string;
};

export interface DoctorHarnessObservation {
  readonly binaries: Readonly<Record<string, boolean>>;
  readonly proofJobsAvailable: boolean;
}

export interface DoctorModelObservation {
  readonly provider: string;
  readonly model: string;
  readonly reachable: boolean;
  readonly minimalPingPerformed: boolean;
}

export interface DoctorPolicyObservation {
  readonly packagePolicyPassed: boolean;
  readonly packagePolicyDetail?: string;
  readonly docsPolicyPassed: boolean;
  readonly docsPolicyDetail?: string;
}

export interface DoctorCollectionOptions {
  /** Injected only for bounded tests; production uses global fetch. */
  readonly githubFetch?: GitHubFetch;
  readonly githubApiUrl?: string;
  readonly registryFetch?: GitHubFetch;
  readonly readReleaseAuthority?: DoctorReleaseAuthorityReader;
  readonly readCreationCleanupIdentity?: DoctorCreationCleanupReader;
}

/** All data needed by the pure verifier. No field contains a secret value. */
export interface DoctorSnapshot {
  readonly declaration: unknown;
  readonly rolloutMode: unknown;
  readonly topology: unknown;
  readonly packages: readonly NpmPackageObservation[];
  /** Raw output from the authoritative npm trust query, one entry per package. */
  readonly trustedPublishers: Readonly<Record<string, unknown>>;
  readonly github: DoctorGitHubObservation;
  readonly attestationWorkflow: DoctorAttestationWorkflowObservation;
  readonly oldSystem: OldSystemOperationalProof;
  readonly harness: DoctorHarnessObservation;
  readonly model: DoctorModelObservation;
  readonly policy: DoctorPolicyObservation;
  readonly lifecycle: DoctorReleaseLifecycleObservation;
  readonly collectionErrors?: Readonly<Record<string, string>>;
}

export interface DoctorSnapshotPort {
  readSnapshot(mode: DoctorMode): ResultAsync<DoctorSnapshot, DoctorPortError>;
}

/** The bounded outer shape for data crossing the collector/verifier boundary. */
export const DoctorSnapshotSchema = z
  .object({
    declaration: z.unknown(),
    rolloutMode: z.unknown(),
    topology: z.unknown(),
    packages: z.array(z.unknown()).max(32),
    trustedPublishers: z.record(z.string(), z.unknown()),
    github: z.unknown(),
    attestationWorkflow: z.unknown(),
    oldSystem: z.unknown(),
    harness: z.unknown(),
    model: z.unknown(),
    policy: z.unknown(),
    lifecycle: z.unknown(),
    collectionErrors: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export function validateDoctorSnapshot(
  input: unknown,
): Result<DoctorSnapshot, DoctorVerificationError> {
  const parsed = DoctorSnapshotSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidDoctorSnapshot",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data as DoctorSnapshot);
}

/** Parse exactly one doctor flag. An unknown or repeated flag fails closed. */
export function parseDoctorMode(
  argv: readonly string[],
): Result<DoctorMode, DoctorVerificationError> {
  if (argv.length === 0) return ok("final");
  if (argv.length !== 1)
    return err({ type: "InvalidDoctorMode", value: [...argv] });
  const value = argv[0];
  if (typeof value === "string" && Object.hasOwn(DOCTOR_MODE_FLAGS, value))
    return ok(DOCTOR_MODE_FLAGS[value as keyof typeof DOCTOR_MODE_FLAGS]);
  return err({ type: "InvalidDoctorMode", value });
}

/**
 * Parse npm's authoritative trusted-publisher response. No human-provided
 * fallback is accepted: missing, malformed, ambiguous, or extra records are
 * represented as an error and block the doctor.
 */
export function parseTrustedPublisherResponse(
  input: unknown,
): Result<
  readonly TrustedPublisherConfiguration[],
  TrustedPublisherParseError
> {
  const decoded = decodeJsonIfNeeded(input);
  if (decoded.isErr()) return err(decoded.error);
  const raw = decoded.value;
  if (containsAttestationWorkflow(raw))
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: `${RELEASE_ATTEST_WORKFLOW_PATH} must never be npm-trusted`,
    });
  const records = trustedRecordArray(raw);
  if (records === null)
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: "npm trust response has no recognizable configuration list",
    });
  if (records.length > 8)
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: "npm trust response contains too many configurations",
    });
  const parsed: TrustedPublisherConfiguration[] = [];
  for (const record of records) {
    const normalized = normalizeTrustedPublisher(record);
    if (normalized.isErr()) return err(normalized.error);
    parsed.push(normalized.value);
  }
  return ok(parsed);
}

/** Validate a single canonical trust identity. */
export function validateTrustedPublisherConfiguration(
  value: unknown,
): Result<TrustedPublisherConfiguration, TrustedPublisherParseError> {
  const parsed = parseTrustedPublisherResponse([value]);
  if (parsed.isErr()) return err(parsed.error);
  const configuration = parsed.value[0];
  if (configuration === undefined)
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: "trusted-publisher configuration is missing",
    });
  return ok(configuration);
}

/** Pure verification entry point used by tests and the executable. */
export function verifyDoctorSnapshot(
  snapshot: unknown,
  modeInput: DoctorMode | string = "final",
): Result<DoctorSuccess, DoctorVerificationError> {
  const mode = normalizeDoctorMode(modeInput);
  if (mode.isErr()) return err(mode.error);
  const validated = validateDoctorSnapshot(snapshot);
  if (validated.isErr()) return err(validated.error);
  const verified = Result.fromThrowable(
    () => verifySnapshot(validated.value, mode.value),
    () => ({
      type: "InvalidDoctorSnapshot" as const,
      issues: ["snapshot contains an unverifiable nested value"],
    }),
  )();
  if (verified.isErr()) return err(verified.error);
  return verified.value;
}

/** Short alias for callers that use the command name as the API name. */
export const runDoctor = verifyDoctorSnapshot;

/** Runs the verifier through an injected read-only collection port. */
export function runDoctorWithPort(
  modeInput: DoctorMode | string,
  port: DoctorSnapshotPort,
): ResultAsync<DoctorSuccess, DoctorVerificationError | DoctorPortError> {
  const mode = normalizeDoctorMode(modeInput);
  if (mode.isErr()) return errAsync(mode.error);
  return port.readSnapshot(mode.value).andThen((snapshot) =>
    ResultAsync.fromPromise(
      Promise.resolve().then(() => verifyDoctorSnapshot(snapshot, mode.value)),
      (): DoctorPortError => ({
        type: "DoctorPortFailed",
        operation: "verifySnapshot",
        message: "doctor verification threw unexpectedly",
      }),
    ).andThen((result) =>
      result.isOk()
        ? okAsync<DoctorSuccess, DoctorVerificationError | DoctorPortError>(
            result.value,
          )
        : errAsync<DoctorSuccess, DoctorVerificationError | DoctorPortError>(
            result.error,
          ),
    ),
  );
}

/** Alias used by executable integrations. */
export const runReleaseDoctor = runDoctorWithPort;

function verifySnapshot(
  snapshot: DoctorSnapshot,
  mode: DoctorMode,
): Result<DoctorSuccess, DoctorVerificationError> {
  const checks: DoctorCheck[] = [];
  const failures: DoctorCheckFailure[] = [];
  let rollout: RolloutTuple | null = null;

  const record = (
    id: string,
    group: string,
    result: Result<void, DoctorCheckFailure>,
  ): void => {
    if (result.isOk()) {
      checks.push({ id, group, status: "pass", detail: "verified" });
      return;
    }
    checks.push({
      id,
      group,
      status: "fail",
      detail: result.error.detail,
      fix: result.error.fix,
    });
    failures.push(result.error);
  };

  const rolloutResult = validateRolloutTuple(
    snapshot.declaration,
    snapshot.rolloutMode,
    snapshot.topology,
  );
  if (rolloutResult.isOk()) rollout = rolloutResult.value;
  record(
    "rollout.tuple",
    "rollout",
    rolloutResult.isOk()
      ? verifyModeTuple(rolloutResult.value, mode)
      : rolloutFailure(rolloutResult.error),
  );

  const collectionErrors = snapshot.collectionErrors ?? {};
  for (const [id, message] of Object.entries(collectionErrors))
    record(
      id,
      "collection",
      failCheck(id, message, manualFixForCollectionError(id)),
    );

  record("npm.packages", "npm", verifyPackages(snapshot.packages, mode));
  record(
    "npm.trusted-publisher.catalog",
    "npm",
    verifyTrustedPublisherCatalog(snapshot.trustedPublishers),
  );
  for (const packageName of Object.keys(PUBLIC_PACKAGES) as PublicPackageName[])
    record(
      `npm.trusted-publisher.${packageName}`,
      "npm",
      verifyTrustedPublisher(snapshot, packageName, mode),
    );
  record(
    "npm.attestation-trust-boundary",
    "npm",
    verifyNoAttestationTrust(snapshot),
  );
  record(
    "github.attestation-workflow",
    "github",
    verifyAttestationWorkflow(snapshot.attestationWorkflow, mode),
  );
  record("github.environments", "github", verifyEnvironments(snapshot.github));
  record("github.ruleset", "github", verifyRuleset(snapshot.github));
  record("github.team", "github", verifyTeam(snapshot.github));
  record("github.app", "github", verifyApp(snapshot.github));
  record("github.secrets", "github", verifySecrets(snapshot.github));
  record(
    "release.lifecycle",
    "release",
    verifyReleaseLifecycle(snapshot.lifecycle),
  );
  if (mode === "pre-cutover")
    record(
      "release.old-system-operational",
      "release",
      verifyOldSystem(snapshot.oldSystem, snapshot.topology),
    );
  record("harness.binaries", "proof", verifyHarness(snapshot.harness));
  record("model.reachability", "proof", verifyModel(snapshot.model));
  record("policy.package", "policy", verifyPackagePolicy(snapshot.policy));
  record("policy.docs", "policy", verifyDocsPolicy(snapshot.policy));

  if (snapshot.lifecycle.marker.openReleasePr)
    checks.push({
      id: "release.marker.active",
      group: "release",
      status: "warn",
      detail: "an open release PR owns the marker; no cleanup is required",
    });

  const status = verdictForMode(mode);
  const report: DoctorReport = {
    status: failures.length === 0 ? status : "failed",
    mode,
    checks,
    rollout,
  };
  if (failures.length > 0)
    return err({ type: "DoctorFailed", report, failures });
  return ok({ ...report, status });
}

function verifyModeTuple(
  tuple: RolloutTuple,
  mode: DoctorMode,
): Result<void, DoctorCheckFailure> {
  const expectedByMode: Record<
    DoctorMode,
    { stage: RolloutStage; modes: readonly ReleaseRolloutMode[] }
  > = {
    "pre-cutover": { stage: "pre-cutover", modes: ["disabled", "dry-run"] },
    cutover: { stage: "frozen", modes: ["disabled"] },
    "post-bootstrap-frozen": { stage: "frozen", modes: ["disabled"] },
    "activation-ready": { stage: "ready", modes: ["disabled"] },
    final: { stage: "ready", modes: ["enabled"] },
  };
  const expected = expectedByMode[mode];
  if (tuple.stage !== expected.stage || !expected.modes.includes(tuple.mode))
    return failCheck(
      "rollout.tuple",
      `${mode} requires stage ${expected.stage} with mode ${expected.modes.join(" or ")}; observed ${tuple.stage}/${tuple.mode}`,
      `change only the reviewed rollout declaration and RELEASE_ROLLOUT_MODE for the ${mode} rung, then rerun bun run release:doctor ${mode === "final" ? "" : `--${mode}`}`.trim(),
    );
  return ok(undefined);
}

function rolloutFailure(
  error: RolloutTupleError,
): Result<void, DoctorCheckFailure> {
  return failCheck(
    "rollout.tuple",
    describeRolloutError(error),
    "restore the checked-in rollout declaration, RELEASE_ROLLOUT_MODE, and workflow topology to one documented tuple; do not enable publication manually",
  );
}

function verifyPackages(
  packages: readonly NpmPackageObservation[],
  mode: DoctorMode,
): Result<void, DoctorCheckFailure> {
  const expectedPublished = expectedPublishedPackages(mode);
  const knownPackages = new Set(Object.keys(PUBLIC_PACKAGES));
  const byName = new Map<string, NpmPackageObservation>();
  for (const entry of packages) {
    if (!knownPackages.has(entry.packageName))
      return failCheck(
        "npm.packages",
        `${entry.packageName}: npm response included an unknown package`,
        "remove the unknown package from the doctor input and rerun the authoritative npm package queries",
      );
    if (byName.has(entry.packageName))
      return failCheck(
        "npm.packages",
        `${entry.packageName}: npm response included duplicate observations`,
        "collect exactly one npm view response per catalog package and rerun the doctor",
      );
    byName.set(entry.packageName, entry);
  }
  for (const packageName of Object.keys(
    PUBLIC_PACKAGES,
  ) as PublicPackageName[]) {
    const observed = byName.get(packageName);
    if (observed === undefined)
      return failCheck(
        "npm.packages",
        `${packageName}: npm view was unavailable`,
        `run npm view ${packageName} --json as an authenticated maintainer and rerun bun run release:doctor`,
      );
    const shouldBePublished = expectedPublished.has(packageName);
    if (shouldBePublished) {
      if (!observed.exists || !observed.published)
        return failCheck(
          "npm.packages",
          `${packageName}: expected a published package`,
          `publish ${packageName} through the reviewed release workflow; do not use a token or npm unpublish`,
        );
      if (!observed.ownershipVerified)
        return failCheck(
          "npm.packages",
          `${packageName}: ownership was not verified`,
          `open npm package settings for ${packageName}, confirm the weave-io maintainer owns it, then rerun the doctor`,
        );
      if (
        typeof observed.distTags.latest !== "string" ||
        observed.distTags.latest.length === 0
      )
        return failCheck(
          "npm.packages",
          `${packageName}: latest dist-tag is missing or unreadable`,
          `verify the package dist-tags in npm's package settings; do not change latest from CI`,
        );
    } else if (observed.published || observed.distTags.latest !== undefined) {
      return failCheck(
        "npm.packages",
        `${packageName}: package is published before its rollout rung`,
        `keep ${packageName} unpublished until the bootstrap step for the selected rollout rung`,
      );
    }
  }
  return ok(undefined);
}

function verifyTrustedPublisherCatalog(
  trustedPublishers: Readonly<Record<string, unknown>>,
): Result<void, DoctorCheckFailure> {
  const knownPackages = new Set(Object.keys(PUBLIC_PACKAGES));
  for (const packageName of Object.keys(trustedPublishers))
    if (!knownPackages.has(packageName))
      return failCheck(
        "npm.trusted-publisher.catalog",
        `${packageName}: authoritative trust input included an unknown package`,
        "collect trusted-publisher records only for the exact public package catalog and rerun npm trust list for each package",
      );
  return ok(undefined);
}

function verifyTrustedPublisher(
  snapshot: DoctorSnapshot,
  packageName: PublicPackageName,
  mode: DoctorMode,
): Result<void, DoctorCheckFailure> {
  const raw = snapshot.trustedPublishers[packageName];
  if (raw === undefined)
    return failCheck(
      `npm.trusted-publisher.${packageName}`,
      `${packageName}: authoritative npm trust query returned no response`,
      `authenticate as a maintainer and run npm trust list ${packageName} --json; manual inspection cannot satisfy this check`,
    );
  const parsed = parseTrustedPublisherResponse(raw);
  if (parsed.isErr())
    return failCheck(
      `npm.trusted-publisher.${packageName}`,
      `${packageName}: ${parsed.error.reason}`,
      `upgrade or authenticate the npm CLI, then rerun npm trust list ${packageName} --json; no manual fallback is accepted`,
    );
  if (containsAttestationWorkflow(raw))
    return failCheck(
      `npm.trusted-publisher.${packageName}`,
      `${packageName}: ${RELEASE_ATTEST_WORKFLOW_PATH} appears in npm trust`,
      `remove the attestation workflow from this package's npm trusted-publisher configurations in npm package settings`,
    );
  const expected = expectedTrustedWorkflow(packageName, mode);
  if (expected === null) {
    if (parsed.value.length !== 0)
      return failCheck(
        `npm.trusted-publisher.${packageName}`,
        `${packageName}: trusted publisher exists before this package's bootstrap rung`,
        `remove the premature trusted-publisher configuration and rerun the doctor; do not switch it early`,
      );
    return ok(undefined);
  }
  if (parsed.value.length !== 1)
    return failCheck(
      `npm.trusted-publisher.${packageName}`,
      `${packageName}: expected exactly one trusted-publisher configuration, found ${parsed.value.length}`,
      `in npm package settings, keep exactly one GitHub Actions trusted publisher for ${packageName} with no environment restriction`,
    );
  const actual = parsed.value[0];
  if (actual === undefined)
    return failCheck(
      `npm.trusted-publisher.${packageName}`,
      `${packageName}: trusted-publisher response was empty`,
      `rerun npm trust list ${packageName} --json with maintainer authentication`,
    );
  const mismatches: string[] = [];
  if (actual.workflow !== expected)
    mismatches.push(`workflow=${actual.workflow}`);
  if (actual.action !== "npm publish")
    mismatches.push(`action=${actual.action}`);
  if (actual.repository !== RELEASE_REPOSITORY)
    mismatches.push(`repository=${actual.repository}`);
  if (actual.environment !== null)
    mismatches.push(`environment=${actual.environment}`);
  if (mismatches.length > 0)
    return failCheck(
      `npm.trusted-publisher.${packageName}`,
      `${packageName}: wrong trusted-publisher identity (${mismatches.join(", ")})`,
      `edit the sole npm trusted publisher to workflow ${expected}, action npm publish, repository ${RELEASE_REPOSITORY}, and no environment restriction`,
    );
  return ok(undefined);
}

function verifyNoAttestationTrust(
  snapshot: DoctorSnapshot,
): Result<void, DoctorCheckFailure> {
  for (const [packageName, raw] of Object.entries(snapshot.trustedPublishers))
    if (containsAttestationWorkflow(raw))
      return failCheck(
        "npm.attestation-trust-boundary",
        `${packageName}: ${RELEASE_ATTEST_WORKFLOW_PATH} is trusted by npm`,
        `remove ${RELEASE_ATTEST_WORKFLOW_PATH} from every npm trusted-publisher record; only ${RELEASE_PUBLISH_WORKFLOW_PATH} may publish`,
      );
  return ok(undefined);
}

function verifyAttestationWorkflow(
  observation: DoctorAttestationWorkflowObservation,
  mode: DoctorMode,
): Result<void, DoctorCheckFailure> {
  if (!observation.readable)
    return failCheck(
      "github.attestation-workflow",
      `${RELEASE_ATTEST_WORKFLOW_PATH}: repository-side workflow read was unverifiable`,
      `read ${RELEASE_ATTEST_WORKFLOW_PATH} from the protected repository and confirm its contract manually`,
    );
  if (mode !== "pre-cutover" && !observation.present)
    return failCheck(
      "github.attestation-workflow",
      `${RELEASE_ATTEST_WORKFLOW_PATH}: workflow is missing`,
      `commit the independent attestation workflow before the cutover or activation rung`,
    );
  if (observation.declaresWorkflowCall)
    return failCheck(
      "github.attestation-workflow",
      `${RELEASE_ATTEST_WORKFLOW_PATH}: workflow_call is declared`,
      `remove the workflow_call trigger; the attestation workflow must be non-reusable and never npm-trusted`,
    );
  return ok(undefined);
}

function verifyEnvironments(
  github: DoctorGitHubObservation,
): Result<void, DoctorCheckFailure> {
  for (const name of ["release", "prerelease"] as const) {
    const environment = github.environments[name];
    if (
      environment === undefined ||
      !environment.readable ||
      !environment.exists
    )
      return failCheck(
        "github.environments",
        `${name}: environment is missing or unreadable`,
        `verify manually: in GitHub Settings → Environments → ${name}, create it with its protection rules; code cannot create secrets`,
      );
    if (environment.protectionConfigured !== true)
      return failCheck(
        "github.environments",
        `${name}: environment exists but names no required reviewer`,
        `verify manually: in GitHub Settings → Environments → ${name}, add a required-reviewer protection rule naming at least one maintainer or team; an environment without reviewers gates nothing`,
      );
  }
  return ok(undefined);
}

function verifyRuleset(
  github: DoctorGitHubObservation,
): Result<void, DoctorCheckFailure> {
  const ruleset = github.ruleset;
  if (!ruleset.readable || !ruleset.exists)
    return failCheck(
      "github.ruleset",
      "release branch ruleset is missing or unreadable",
      `verify manually: in GitHub Settings → Rules → Rulesets, create/read the main ruleset with required checks ${REQUIRED_RULESET_CHECKS.join(", ")}`,
    );
  if (ruleset.targetBranch !== "main")
    return failCheck(
      "github.ruleset",
      `ruleset targets ${ruleset.targetBranch}, not main`,
      "verify manually: edit the release ruleset target to the main branch in GitHub Settings → Rules → Rulesets",
    );
  const actual = [...ruleset.requiredChecks].sort();
  const expected = [...REQUIRED_RULESET_CHECKS].sort();
  if (actual.join("\0") !== expected.join("\0"))
    return failCheck(
      "github.ruleset",
      `required checks are [${ruleset.requiredChecks.join(", ")}], expected [${REQUIRED_RULESET_CHECKS.join(", ")}]`,
      `verify manually: edit GitHub Settings → Rules → Rulesets so main requires exactly ${REQUIRED_RULESET_CHECKS.join(", ")}; feeder docs jobs are not required directly`,
    );
  if (!ruleset.dismissStalePullRequestApprovals)
    return failCheck(
      "github.ruleset",
      "dismiss stale pull request approvals on push is disabled",
      "verify manually: enable GitHub Settings → Rules → Rulesets → Require a pull request → dismiss stale pull request approvals on push",
    );
  return ok(undefined);
}

function verifyTeam(
  github: DoctorGitHubObservation,
): Result<void, DoctorCheckFailure> {
  if (
    !github.team.exists ||
    !github.team.readable ||
    github.team.organization !== "weave-io" ||
    github.team.slug !== "release-maintainers"
  )
    return failCheck(
      "github.team",
      "release-maintainers team is missing or unreadable",
      "verify manually: in GitHub, create/read organization weave-io team release-maintainers and grant its members the release-maintainer role",
    );
  return ok(undefined);
}

function verifyApp(
  github: DoctorGitHubObservation,
): Result<void, DoctorCheckFailure> {
  if (!github.app.installationReadable)
    return failCheck(
      "github.app",
      "release GitHub App installation permissions are unverifiable",
      "verify manually: open GitHub Settings → Developer settings → GitHub Apps, inspect the installation, and grant Contents: write and Pull requests: write",
    );
  if (github.app.permissions.contents !== "write")
    return failCheck(
      "github.app",
      `GitHub App Contents permission is ${github.app.permissions.contents}, expected write`,
      "verify manually: grant the release App Contents: write permission in the GitHub App installation and accept the pending permission update",
    );
  if (github.app.permissions.pullRequests !== "write")
    return failCheck(
      "github.app",
      `GitHub App Pull requests permission is ${github.app.permissions.pullRequests}, expected write`,
      "verify manually: grant the release App Pull requests: write permission in the GitHub App installation and accept the pending permission update",
    );
  if (github.app.permissions.checks !== "write")
    return failCheck(
      "github.app",
      `GitHub App Checks permission is ${github.app.permissions.checks}, expected write`,
      "verify manually: grant the release App Checks: write permission in the GitHub App installation and accept the pending permission update",
    );
  if (github.app.permissions.members !== "read")
    return failCheck(
      "github.app",
      `GitHub App Members permission is ${github.app.permissions.members}, expected read`,
      "verify manually: grant the release App Members: read organization permission in the GitHub App installation and accept the pending permission update",
    );
  return ok(undefined);
}

function verifySecrets(
  github: DoctorGitHubObservation,
): Result<void, DoctorCheckFailure> {
  if (!github.secrets.readable)
    return failCheck(
      "github.secrets",
      "secret-name metadata is unreadable",
      "verify manually: inspect repository and protected environment secret names in GitHub; never print or paste secret values",
    );
  const environmentEntries = Object.entries(github.secrets.environmentNames);
  const obsoleteSecretPresent =
    github.secrets.repositoryNames.includes(
      OBSOLETE_STORED_INSTALLATION_SECRET_NAME,
    ) ||
    environmentEntries.some(([, names]) =>
      names.includes(OBSOLETE_STORED_INSTALLATION_SECRET_NAME),
    );
  if (obsoleteSecretPresent)
    return failCheck(
      "github.secrets",
      "the obsolete stored App installation-token secret name is present",
      "remove the obsolete installation-token secret from repository and environment metadata; only short-lived action output may carry an App token",
    );
  for (const name of RELEASE_APP_CREDENTIAL_NAMES)
    if (github.secrets.repositoryNames.includes(name))
      return failCheck(
        "github.secrets",
        `repository-wide App credential ${name} is not allowed`,
        `remove ${name} from repository secrets and keep it only in the exact protected App environments: ${RELEASE_APP_SECRET_ENVIRONMENTS.join(", ")}`,
      );
  for (const [environment, names] of environmentEntries) {
    if (
      RELEASE_APP_SECRET_ENVIRONMENTS.includes(
        environment as (typeof RELEASE_APP_SECRET_ENVIRONMENTS)[number],
      )
    )
      continue;
    const misplaced = RELEASE_APP_CREDENTIAL_NAMES.find((name) =>
      names.includes(name),
    );
    if (misplaced !== undefined)
      return failCheck(
        "github.secrets",
        `${environment}: protected App credential ${misplaced} is outside the authorized App environment set`,
        `remove ${misplaced} from ${environment}; keep it only in ${RELEASE_APP_SECRET_ENVIRONMENTS.join(", ")}`,
      );
  }
  const secretNames = new Set([
    ...github.secrets.repositoryNames,
    ...Object.values(github.secrets.environmentNames).flat(),
  ]);
  for (const name of REQUIRED_RELEASE_SECRET_NAMES)
    if (!secretNames.has(name))
      return failCheck(
        "github.secrets",
        `required secret name ${name} is missing`,
        `verify manually: in GitHub Settings → Secrets and variables → Actions, create the ${name} secret name at the documented protected scope; code cannot create secrets`,
      );
  for (const environment of RELEASE_APP_SECRET_ENVIRONMENTS) {
    const names = new Set(github.secrets.environmentNames[environment] ?? []);
    for (const name of RELEASE_APP_CREDENTIAL_NAMES)
      if (!names.has(name))
        return failCheck(
          "github.secrets",
          `${environment}: protected App credential name ${name} is missing`,
          `verify manually: create ${name} in the ${environment} environment; do not create a repository-wide App credential or store an installation token`,
        );
  }
  return ok(undefined);
}

function verifyOldSystem(
  oldSystem: OldSystemOperationalProof,
  topologyInput: unknown,
): Result<void, DoctorCheckFailure> {
  const topology = topologyInput as Partial<WorkflowTopology>;
  if (!topology.oldWorkflowPresent || !topology.oldWorkflowScheduled)
    return failCheck(
      "release.old-system-operational",
      "old publish.yml is missing or has no schedule trigger",
      `restore ${RELEASE_WORKFLOW_PATH} with its schedule until the cutover freeze; file presence alone is not operational proof`,
    );
  if (!oldSystem.authoritative || !oldSystem.publicationPathEnabled)
    return failCheck(
      "release.old-system-operational",
      "old publication path is not authoritatively enabled",
      "inspect a recent successful scheduled run on protected main",
    );
  if (!oldSystem.recentSuccessfulRun)
    return failCheck(
      "release.old-system-operational",
      "no recent successful scheduled run was observed",
      "prove a recent successful scheduled run on protected main, then rerun this mode",
    );
  if (
    oldSystem.runId === undefined ||
    !Number.isSafeInteger(oldSystem.runId) ||
    oldSystem.runId <= 0 ||
    oldSystem.evidence === undefined ||
    oldSystem.evidence.length === 0
  )
    return failCheck(
      "release.old-system-operational",
      "accepted old-system proof is missing its authoritative run identity",
      "capture the GitHub workflow run ID and exact scheduled evidence before rerunning the doctor",
    );
  const expectedEvidence = `successful scheduled run ${oldSystem.runId} on protected main`;
  if (oldSystem.evidence !== expectedEvidence)
    return failCheck(
      "release.old-system-operational",
      "accepted old-system proof has an unrecognized run identity",
      "capture the exact GitHub run evidence emitted by the bounded old-publisher collector before rerunning the doctor",
    );
  return ok(undefined);
}

function verifyHarness(
  harness: DoctorHarnessObservation,
): Result<void, DoctorCheckFailure> {
  if (!harness.proofJobsAvailable)
    return failCheck(
      "harness.binaries",
      "harness proof jobs are unavailable",
      "install the declared OpenCode, Claude Code, and Pi proof hosts on the runner and rerun the doctor",
    );
  const binaryNames: Readonly<Record<string, readonly string[]>> = {
    opencode: ["opencode"],
    claude: ["claude", "claude-code", "claudeCode"],
    pi: ["pi"],
  };
  for (const [name, aliases] of Object.entries(binaryNames))
    if (!aliases.some((alias) => harness.binaries[alias] === true))
      return failCheck(
        "harness.binaries",
        `${name}: harness binary is unavailable`,
        `install the supported ${name} harness binary in the proof environment; do not substitute a source checkout`,
      );
  return ok(undefined);
}

function verifyModel(
  model: DoctorModelObservation,
): Result<void, DoctorCheckFailure> {
  if (model.provider !== "opencode-go" || model.model !== "gpt-5.6-luna")
    return failCheck(
      "model.reachability",
      `model identity is ${model.provider}/${model.model}, expected opencode-go/gpt-5.6-luna`,
      "configure the release AI job with provider opencode-go and model gpt-5.6-luna",
    );
  if (!model.minimalPingPerformed || !model.reachable)
    return failCheck(
      "model.reachability",
      "provider/model reachability was not proved by a minimal ping",
      "set RELEASE_DOCTOR_PROBE_MODELS=true for one bounded minimal ping, then rerun the doctor; no completion request is used",
    );
  return ok(undefined);
}

function verifyPackagePolicy(
  policy: DoctorPolicyObservation,
): Result<void, DoctorCheckFailure> {
  if (!policy.packagePolicyPassed)
    return failCheck(
      "policy.package",
      policy.packagePolicyDetail ?? "package policy dry check failed",
      "run bun run release:validate and fix the reported package-policy violation before rollout",
    );
  return ok(undefined);
}

function verifyDocsPolicy(
  policy: DoctorPolicyObservation,
): Result<void, DoctorCheckFailure> {
  if (!policy.docsPolicyPassed)
    return failCheck(
      "policy.docs",
      policy.docsPolicyDetail ?? "docs policy dry check failed",
      "run bun run docs:check-links and the deterministic docs-policy check, then merge the documentation fix on main",
    );
  return ok(undefined);
}

function verifyReleaseLifecycle(
  lifecycle: DoctorReleaseLifecycleObservation,
): Result<void, DoctorCheckFailure> {
  if (!lifecycle.authoritative)
    return failCheck(
      "release.lifecycle",
      "merged-release and marker state was not recomputed from GitHub authority",
      `run ${RESUME_RECOVERY_COMMAND} only after the Task 14 state reader is available; doctor never trusts comments or artifacts`,
    );
  const marker = lifecycle.marker;
  if (
    marker.present &&
    (marker.markerSha === undefined ||
      !isFullSha(marker.markerSha) ||
      marker.ownerGeneration === undefined ||
      !isOwnerGeneration(marker.ownerGeneration) ||
      marker.plannedBaseSha === undefined ||
      !isFullSha(marker.plannedBaseSha))
  )
    return failCheck(
      "release.lifecycle",
      "live release-pr/stable marker ownership identity is missing or malformed",
      `reread ${RELEASE_PR_MARKER_REF} through the authoritative Git ref and release-PR metadata; resume must prove ownerGeneration, expectedMarkerSha, and plannedBaseSha before any cleanup`,
    );
  if (!marker.present && marker.openReleasePr)
    return failCheck(
      "release.lifecycle",
      "an open release PR is reported without the release-pr/stable marker",
      `reread ${RELEASE_PR_MARKER_REF} and the open release PR from GitHub authority; the marker is the active release-PR lock and must not be inferred from a PR alone`,
    );
  if (
    !marker.present &&
    (marker.markerCleanupPending === true ||
      marker.associatedPullRequestSettled === true ||
      (marker.recordedCleanup !== undefined && marker.recordedCleanup !== null))
  )
    return failCheck(
      "release.lifecycle",
      "marker cleanup metadata exists but the live release-pr/stable marker is absent",
      `reread ${RESUME_RECOVERY_COMMAND} inputs from GitHub authority; doctor never treats an absent marker as proof that a cleanup record was applied`,
    );
  if (
    marker.openReleasePr &&
    (marker.markerCleanupPending === true ||
      marker.associatedPullRequestSettled === true ||
      (marker.recordedCleanup !== undefined && marker.recordedCleanup !== null))
  )
    return failCheck(
      "release.lifecycle",
      "release-pr/stable is open but its cleanup metadata says the PR settled",
      `reread the release PR and marker ownership from GitHub authority; resume may clear cleanup only after authoritative merged or closed proof`,
    );
  for (const discovered of lifecycle.discovered ?? []) {
    if (discovered.kind === "creation-cleanup-pending")
      return verifyCreationCleanup(
        lifecycle.marker,
        discovered.ownership,
        "recorded creation-phase cleanup is pending",
      );
    const state = discovered.state.primary;
    if (state === "IntegrityIncident")
      return incidentFailure(lifecycle.mergedRelease);
    if (discovered.state.markerCleanupPending)
      return failCheck(
        "release.lifecycle",
        `terminal or incomplete release ${state} has MarkerCleanupPending`,
        `run ${RESUME_RECOVERY_COMMAND}; resume proves the merged/closed PR and clears the marker, while doctor never deletes refs`,
      );
    if (!isTerminalPrimaryState(state))
      return failCheck(
        "release.lifecycle",
        `merged release is incomplete at recomputed state ${state}`,
        `run ${RESUME_RECOVERY_COMMAND} to resume the missing ${state} transitions`,
      );
  }
  if (marker.present && !marker.openReleasePr) {
    if (marker.recordedCleanup !== undefined && marker.recordedCleanup !== null)
      return verifyCreationCleanup(
        marker,
        marker.recordedCleanup,
        "creation-phase cleanup record remains while no open release PR is visible",
      );
    if (marker.markerCleanupPending || marker.associatedPullRequestSettled)
      return failCheck(
        "release.lifecycle",
        `marker ${marker.markerSha ?? "release-pr/stable"} remains after its PR settled (MarkerCleanupPending)`,
        `run ${RESUME_RECOVERY_COMMAND}; resume clears MarkerCleanupPending after authoritative merged/closed proof; doctor never deletes the ref`,
      );
    if (marker.creationPollExhausted)
      return failCheck(
        "release.lifecycle",
        "release-pr/stable is an orphan/stalled creation marker with no open PR",
        `run ${RESUME_RECOVERY_COMMAND} to reconcile the marker ownership; if no PR exists, resume performs the generation-verified cleanup`,
      );
    return failCheck(
      "release.lifecycle",
      "release-pr/stable is present but no open release PR is visible",
      `run ${RESUME_RECOVERY_COMMAND} for bounded authoritative reconciliation; doctor never deletes the ref`,
    );
  }
  const merged = lifecycle.mergedRelease;
  if (merged !== undefined && merged !== null) {
    if (merged.state === "IntegrityIncident") return incidentFailure(merged);
    if (merged.markerCleanupPending)
      return failCheck(
        "release.lifecycle",
        `merged release ${merged.state} has marker cleanup pending`,
        `run ${RESUME_RECOVERY_COMMAND}; marker cleanup is independent of tags, releases, and npm publication`,
      );
    if (!isTerminalStateName(merged.state))
      return failCheck(
        "release.lifecycle",
        `merged release is incomplete at recomputed state ${merged.state}`,
        `run ${RESUME_RECOVERY_COMMAND} to finish the pending release state`,
      );
  }
  return ok(undefined);
}

function verifyCreationCleanup(
  marker: DoctorMarkerObservation,
  recorded: ReleasePrOwnership,
  detail: string,
): Result<void, DoctorCheckFailure> {
  if (
    recorded.ref !== RELEASE_PR_MARKER_REF ||
    !isOwnerGeneration(recorded.ownerGeneration) ||
    !isFullSha(recorded.expectedMarkerSha) ||
    !isFullSha(recorded.plannedBaseSha)
  )
    return failCheck(
      "release.lifecycle",
      "recorded creation cleanup identity is malformed",
      `reread the ${RELEASE_PR_MARKER_REF} CreationCleanupPending record from the authoritative release state; resume must use the complete ownerGeneration/expectedMarkerSha/plannedBaseSha identity`,
    );
  const liveGeneration = marker.ownerGeneration;
  const generationMismatch =
    liveGeneration !== undefined && liveGeneration !== recorded.ownerGeneration;
  const baseMismatch =
    marker.plannedBaseSha !== undefined &&
    marker.plannedBaseSha !== recorded.plannedBaseSha;
  const markerMismatch =
    marker.markerSha !== undefined &&
    marker.markerSha !== recorded.expectedMarkerSha;
  let suffix = `; live ownerGeneration=${liveGeneration ?? "<missing>"}, live plannedBaseSha=${marker.plannedBaseSha ?? "<missing>"}; recorded ownerGeneration=${recorded.ownerGeneration}, recorded plannedBaseSha=${recorded.plannedBaseSha}`;
  if (generationMismatch)
    suffix += `; stale cleanup generation ${recorded.ownerGeneration} does not match live generation ${liveGeneration} (successor marker is protected)`;
  else if (baseMismatch)
    suffix += `; stale cleanup plannedBaseSha ${recorded.plannedBaseSha} does not match live plannedBaseSha ${marker.plannedBaseSha} (successor marker is protected)`;
  else if (markerMismatch)
    suffix += `; stale cleanup marker SHA ${recorded.expectedMarkerSha} does not match live marker SHA ${marker.markerSha} (successor marker is protected)`;
  return failCheck(
    "release.lifecycle",
    `${detail}${suffix}`,
    `run ${RESUME_RECOVERY_COMMAND}; resume clears CreationCleanupPending only after authoritative PR absence and a generation-verified CAS delete`,
  );
}

function incidentFailure(
  merged: DoctorMergedReleaseObservation | null | undefined,
): Result<void, DoctorCheckFailure> {
  const deprecationOutstanding =
    merged?.incidentAuthorizationRecordPresent === true &&
    merged.incidentDeprecatedVerified !== true;
  const detail = deprecationOutstanding
    ? `merged release is IntegrityIncident; registry deprecated verification is incomplete and the outstanding step is the maintainer's interactive deprecation`
    : "merged release is IntegrityIncident";
  const fix = deprecationOutstanding
    ? `${INTERACTIVE_DEPRECATION_FIX}; recovery dispatch: ${INCIDENT_RECOVERY_COMMAND}`
    : `use the protected incident-resolution dispatch ${INCIDENT_RECOVERY_COMMAND}; normal resume and stable preparation must remain blocked`;
  return failCheck("release.lifecycle", detail, fix);
}

function expectedPublishedPackages(
  mode: DoctorMode,
): ReadonlySet<PublicPackageName> {
  if (mode === "pre-cutover" || mode === "cutover")
    return new Set(["@weaveio/weave-cli", "@weaveio/weave-adapter-opencode"]);
  return new Set(Object.keys(PUBLIC_PACKAGES) as PublicPackageName[]);
}

function expectedTrustedWorkflow(
  packageName: PublicPackageName,
  mode: DoctorMode,
): string | null {
  if (
    (mode === "pre-cutover" || mode === "cutover") &&
    (packageName === "@weaveio/weave-cli" ||
      packageName === "@weaveio/weave-adapter-opencode")
  )
    return mode === "pre-cutover"
      ? RELEASE_WORKFLOW_PATH
      : RELEASE_PUBLISH_WORKFLOW_PATH;
  if (mode === "pre-cutover" || mode === "cutover") return null;
  return RELEASE_PUBLISH_WORKFLOW_PATH;
}

function verdictForMode(mode: DoctorMode): DoctorVerdict {
  switch (mode) {
    case "pre-cutover":
      return "ReadyForCutover";
    case "cutover":
      return "CutoverVerified";
    case "post-bootstrap-frozen":
      return "ReadyForActivation";
    case "activation-ready":
      return "ActivationReadyVerified";
    case "final":
      return "FinalVerified";
  }
}

function normalizeDoctorMode(
  value: DoctorMode | string,
): Result<DoctorMode, DoctorVerificationError> {
  if ((DOCTOR_MODES as readonly string[]).includes(value))
    return ok(value as DoctorMode);
  return err({ type: "InvalidDoctorMode", value });
}

function failCheck(
  id: string,
  detail: string,
  fix: string,
): Result<never, DoctorCheckFailure> {
  return err({ type: "DoctorCheckFailed", id, detail, fix });
}

function manualFixForCollectionError(id: string): string {
  if (id.startsWith("npm.trusted-publisher"))
    return "authenticate as an npm maintainer and rerun the exact npm trust list query; manual inspection cannot satisfy trusted-publisher verification";
  if (id.startsWith("github"))
    return "read the setting through the GitHub API or inspect the exact GitHub Settings console path documented in docs/contributing/release-setup.md";
  if (id === "release.lifecycle")
    return `reread GitHub release and marker state, then run ${RESUME_RECOVERY_COMMAND} only after the Task 14 authority reader is available; doctor never trusts comments or artifacts`;
  return "rerun the bounded read-only doctor input and resolve the reported source error";
}

function describeRolloutError(error: RolloutTupleError): string {
  if (error.type === "RolloutInvalidState")
    return `${error.stage}/${error.mode}: ${error.reason}`;
  if (error.type === "InvalidRolloutMode")
    return `RELEASE_ROLLOUT_MODE is invalid or missing (${String(error.mode)})`;
  if (error.type === "InvalidWorkflowTopology")
    return `workflow topology is invalid: ${error.issues.join("; ")}`;
  return `rollout declaration is invalid: ${error.issues.join("; ")}`;
}

function decodeJsonIfNeeded(
  input: unknown,
): Result<unknown, TrustedPublisherParseError> {
  if (typeof input !== "string") return ok(input);
  if (input.length > 256 * 1024)
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: "npm trust response exceeds the bounded response size",
    });
  return Result.fromThrowable(
    () => JSON.parse(input) as unknown,
    () => ({
      type: "TrustedPublisherUnverifiable" as const,
      reason: "npm trust response is not valid JSON",
    }),
  )();
}

function trustedRecordArray(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record === undefined) return null;
  for (const key of [
    "configurations",
    "trustedPublishers",
    "publishers",
    "records",
    "data",
  ]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  if (hasTrustedFields(record)) return [record];
  return null;
}

function normalizeTrustedPublisher(
  input: unknown,
): Result<TrustedPublisherConfiguration, TrustedPublisherParseError> {
  const outer = asRecord(input);
  if (outer === undefined)
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: "trusted-publisher configuration is not an object",
    });
  const record = unwrapTrustedPublisher(outer);
  const claims = asRecord(record.claims);
  const workflowRef = asRecord(claims?.workflow_ref);
  const workflowRefString =
    typeof claims?.workflow_ref === "string" ? claims.workflow_ref : undefined;
  const workflowValue =
    stringField(record, [
      "workflow",
      "workflowFile",
      "workflowPath",
      "workflow_path",
      "file",
    ]) ??
    stringField(claims, [
      "workflow",
      "workflowFile",
      "workflowPath",
      "workflow_path",
      "file",
    ]) ??
    stringField(workflowRef, ["file", "workflow", "path"]) ??
    workflowRefString;
  const action = stringField(record, ["action", "actionName", "action_name"]);
  const repository =
    stringField(record, ["repository", "repo"]) ??
    stringField(claims, ["repository", "repo"]);
  const provider = stringField(record, ["provider", "type"]);
  const environmentValue =
    record.environment ??
    record.environmentName ??
    claims?.environment ??
    claims?.environmentName;
  const environmentsValue = record.environments ?? claims?.environments;
  let environment: string | null = null;
  if (typeof environmentValue === "string") environment = environmentValue;
  else if (environmentValue !== undefined && environmentValue !== null)
    return err({
      type: "TrustedPublisherUnverifiable",
      reason: "trusted-publisher environment field is not a string or null",
    });
  if (environmentsValue !== undefined) {
    if (
      !Array.isArray(environmentsValue) ||
      environmentsValue.some((value) => typeof value !== "string")
    )
      return err({
        type: "TrustedPublisherUnverifiable",
        reason: "trusted-publisher environments field is malformed",
      });
    if (environmentsValue.length > 0) environment = environmentsValue[0] ?? "";
  }

  const isGitHub =
    provider === "github" ||
    provider === "github-actions" ||
    provider === "github_actions";
  const isNpmGitHubClaimsRecord = claims !== undefined && isGitHub;
  const workflow = normalizeWorkflowPath(workflowValue);
  const normalizedAction =
    action ?? (isNpmGitHubClaimsRecord ? "npm publish" : undefined);
  if (
    workflow === undefined ||
    normalizedAction === undefined ||
    repository === undefined ||
    !isGitHub
  )
    return err({
      type: "TrustedPublisherUnverifiable",
      reason:
        "trusted-publisher configuration lacks exact GitHub provider, workflow, action, or repository fields",
    });
  return ok({
    provider: "github-actions",
    workflow,
    action: normalizedAction,
    repository,
    environment,
  });
}

function normalizeWorkflowPath(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.startsWith(".github/workflows/")) return value;
  if (value.includes("/")) return value;
  return `.github/workflows/${value}`;
}

function unwrapTrustedPublisher(
  record: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of ["publisher", "trustedPublisher", "configuration"]) {
    const nested = asRecord(record[key]);
    if (nested !== undefined) return nested;
  }
  return record;
}

function hasTrustedFields(record: Record<string, unknown>): boolean {
  return [
    "workflow",
    "workflowFile",
    "workflowPath",
    "workflow_path",
    "file",
    "repository",
    "repo",
    "claims",
  ].some((key) => record[key] !== undefined);
}

function containsAttestationWorkflow(value: unknown): boolean {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(value) as string,
    () => "",
  )();
  return (
    serialized.isOk() &&
    typeof serialized.value === "string" &&
    (serialized.value.includes(RELEASE_ATTEST_WORKFLOW_PATH) ||
      serialized.value.includes("release-attest.yml"))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Read-only production collector
// ---------------------------------------------------------------------------

/** Creates the environment-backed collector used by `bun run release:doctor`. */
export function createDefaultDoctorPort(
  root: string,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  options: DoctorCollectionOptions = {},
): DoctorSnapshotPort {
  return {
    readSnapshot(mode) {
      return collectSnapshot(root, mode, environment, options);
    },
  };
}

/** Runs the executable doctor against read-only environment ports. */
export function runEnvironmentDoctor(
  mode: DoctorMode,
  root: string,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): ResultAsync<DoctorSuccess, DoctorVerificationError | DoctorPortError> {
  return runDoctorWithPort(mode, createDefaultDoctorPort(root, environment));
}

function collectSnapshot(
  root: string,
  mode: DoctorMode,
  environment: Readonly<Record<string, string | undefined>>,
  options: DoctorCollectionOptions = {},
): ResultAsync<DoctorSnapshot, DoctorPortError> {
  const collectionErrors: Record<string, string> = {};
  return ResultAsync.fromPromise(
    (async () => {
      const topology = await readLocalTopology(root);
      const packages: NpmPackageObservation[] = [];
      const trustedPublishers: Record<string, unknown> = {};
      for (const packageName of Object.keys(
        PUBLIC_PACKAGES,
      ) as PublicPackageName[]) {
        const packageResult = await collectNpmPackage(packageName);
        const packageAbsent =
          packageResult.isErr() &&
          isNpmNotFoundError(packageResult.error.message);
        if (packageResult.isOk()) packages.push(packageResult.value);
        else {
          if (!packageAbsent)
            collectionErrors[`npm.packages.${packageName}`] =
              packageResult.error.message;
          packages.push({
            packageName,
            exists: false,
            published: false,
            ownershipVerified: false,
            distTags: {},
          });
        }
        const trustResult = await collectTrustedPublisher(packageName);
        if (trustResult.isOk())
          trustedPublishers[packageName] = trustResult.value;
        else if (
          packageAbsent &&
          isNpmNotFoundError(trustResult.error.message) &&
          expectedTrustedWorkflow(packageName, mode) === null
        )
          trustedPublishers[packageName] = [];
        else
          collectionErrors[`npm.trusted-publisher.${packageName}`] =
            trustResult.error.message;
      }
      const github = await collectGitHub(
        environment,
        collectionErrors,
        options,
      );
      const lifecycleResult = await collectAuthoritativeReleaseLifecycle({
        token: environment.GITHUB_TOKEN,
        fetchImpl: options.githubFetch,
        apiUrl: options.githubApiUrl ?? environment.GITHUB_API_URL,
        registryFetch: options.registryFetch,
        readAuthority: options.readReleaseAuthority,
        readCreationCleanupIdentity: options.readCreationCleanupIdentity,
      });
      const lifecycle = lifecycleResult.isOk()
        ? lifecycleResult.value
        : (() => {
            collectionErrors["release.lifecycle"] =
              lifecycleResult.error.message;
            return unavailableReleaseLifecycle();
          })();
      const policy = await collectPolicy(root);
      const attest = await readAttestationWorkflow(root);
      const oldSystem = await collectOldSystem(
        root,
        environment,
        collectionErrors,
      );
      const binaries = {
        opencode: Bun.which("opencode") !== null,
        claude: Bun.which("claude") !== null,
        pi: Bun.which("pi") !== null,
      };
      const harness: DoctorHarnessObservation = {
        binaries,
        proofJobsAvailable: Object.values(binaries).every(Boolean),
      };
      const model = await collectModel(environment);
      return {
        declaration: ROLLOUT_STAGE_DECLARATION,
        rolloutMode: environment.RELEASE_ROLLOUT_MODE,
        topology: {
          ...topology,
          attestationWorkflowPresent: attest.present,
          attestationWorkflowCalls: attest.declaresWorkflowCall,
        },
        packages,
        trustedPublishers,
        github,
        attestationWorkflow: attest,
        oldSystem,
        harness,
        model,
        policy,
        lifecycle,
        collectionErrors,
      } satisfies DoctorSnapshot;
    })(),
    (cause): DoctorPortError => ({
      type: "DoctorPortFailed",
      operation: "collectSnapshot",
      message: String(cause),
    }),
  );
}

function collectNpmPackage(
  packageName: PublicPackageName,
): ResultAsync<NpmPackageObservation, DoctorPortError> {
  return runNpm(["view", packageName, "--json"]).andThen((stdout) => {
    const parsed = Result.fromThrowable(
      () => JSON.parse(stdout) as unknown,
      () => undefined,
    )();
    if (parsed.isErr() || asRecord(parsed.value) === undefined)
      return errAsync({
        type: "DoctorPortFailed" as const,
        operation: `npm view ${packageName}`,
        message: "invalid npm package response",
      });
    const record = asRecord(parsed.value);
    const distTags = asStringRecord(record?.["dist-tags"]);
    const maintainers = Array.isArray(record?.maintainers)
      ? record.maintainers.flatMap((entry) => {
          const item = asRecord(entry);
          return typeof item?.name === "string" ? [item.name] : [];
        })
      : [];
    const exists = true;
    const published = typeof distTags.latest === "string";
    return okAsync({
      packageName,
      exists,
      published,
      ownershipVerified: maintainers.includes("weave-io"),
      owners: maintainers,
      distTags,
    });
  });
}

function collectTrustedPublisher(
  packageName: PublicPackageName,
): ResultAsync<unknown, DoctorPortError> {
  return runNpm(["trust", "list", packageName, "--json"]).andThen((stdout) => {
    const parsed = Result.fromThrowable(
      () => JSON.parse(stdout) as unknown,
      () => undefined,
    )();
    if (parsed.isErr())
      return errAsync({
        type: "DoctorPortFailed" as const,
        operation: `npm trust list ${packageName}`,
        message: "invalid npm trust response",
      });
    return okAsync(parsed.value);
  });
}

function isNpmNotFoundError(message: string): boolean {
  return message.includes("E404") || message.includes("404 Not Found");
}

function escapeRegExp(value: string): string {
  return value.replaceAll("*", "\\*");
}

/**
 * Runs one bounded `npm` read.
 *
 * The registry is an external system that can hang or answer at length, so the
 * subprocess is bounded by a wall clock and by stdout/stderr byte counts taken
 * while the streams drain. Crossing any bound kills the child and fails the
 * read rather than growing the doctor's heap or holding CI open.
 */
function runNpm(argv: readonly string[]): ResultAsync<string, DoctorPortError> {
  return ResultAsync.fromSafePromise(
    runBoundedProcess(["npm", ...argv], {
      timeoutMs: DOCTOR_TRANSPORT_LIMITS.processTimeoutMs,
      maxStdoutBytes: DOCTOR_TRANSPORT_LIMITS.processStdoutBytes,
      maxStderrBytes: DOCTOR_TRANSPORT_LIMITS.processStderrBytes,
    }),
  ).andThen((result) =>
    result.isErr()
      ? errAsync<string, DoctorPortError>(result.error)
      : okAsync<string, DoctorPortError>(result.value.stdout),
  );
}

async function readLocalTopology(root: string): Promise<WorkflowTopology> {
  const oldPath = `${root}/${RELEASE_WORKFLOW_PATH}`;
  const newPath = `${root}/${RELEASE_PUBLISH_WORKFLOW_PATH}`;
  const oldPresent = await Bun.file(oldPath).exists();
  const newPresent = await Bun.file(newPath).exists();
  const oldText = oldPresent ? await Bun.file(oldPath).text() : "";
  const newText = newPresent ? await Bun.file(newPath).text() : "";
  const oldSchedule =
    /(^|\n)\s*schedule\s*:/m.test(oldText) &&
    /(^|\n)\s*-\s*cron\s*:\s*["']?[^"'\n]+["']?/m.test(oldText);
  const newSchedule = new RegExp(
    `(^|\\n)\\s*-\\s*cron\\s*:\\s*["']?${escapeRegExp(NEW_PIPELINE_SCHEDULE)}["']?`,
    "m",
  ).test(newText);
  return {
    oldWorkflowPresent: oldPresent,
    oldWorkflowScheduled: oldSchedule,
    newWorkflowPresent: newPresent,
    newWorkflowScheduled: newSchedule,
    newWorkflowGateDisabled: newPresent
      ? newText.includes("RELEASE_ROLLOUT_MODE")
      : undefined,
  };
}

async function collectOldSystem(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  errors: Record<string, string>,
): Promise<OldSystemOperationalProof> {
  const workflowPath = `${root}/${RELEASE_WORKFLOW_PATH}`;
  const workflow = Bun.file(workflowPath);
  if (!(await workflow.exists()))
    return {
      authoritative: false,
      publicationPathEnabled: false,
      recentSuccessfulRun: false,
    };
  const text = await workflow.text();
  const hasSchedule = /(^|\n)\s*schedule\s*:/m.test(text);
  const publicationPathEnabled =
    /\bnpm\s+publish\b/.test(text) ||
    /scripts\/release\/(?:stable-plan-main|metadata-replay-main|publish-main)\.ts/.test(
      text,
    );
  const token = environment.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    errors["release.old-system-operational"] =
      "GITHUB_TOKEN is missing for the authoritative old-workflow run query";
    return {
      authoritative: false,
      publicationPathEnabled,
      recentSuccessfulRun: false,
    };
  }
  const oldSystemApiUrl = resolveGitHubApiUrl(environment.GITHUB_API_URL);
  if (oldSystemApiUrl.isErr()) {
    errors["release.old-system-operational"] = oldSystemApiUrl.error.message;
    return {
      authoritative: false,
      publicationPathEnabled,
      recentSuccessfulRun: false,
    };
  }
  const runs = await new GitHubReadClient(
    RELEASE_REPOSITORY,
    token,
    undefined,
    oldSystemApiUrl.value,
  ).readWorkflowRuns("publish.yml");
  if (runs.isErr()) {
    errors["release.old-system-operational"] = runs.error.message;
    return {
      authoritative: false,
      publicationPathEnabled,
      recentSuccessfulRun: false,
    };
  }
  const recent = recentSuccessfulOldRun(runs.value);
  return {
    authoritative: hasSchedule && publicationPathEnabled,
    publicationPathEnabled,
    recentSuccessfulRun: recent?.kind === "scheduled",
    ...(recent === null
      ? {}
      : { runId: recent.runId, evidence: recent.evidence }),
  };
}

/**
 * Selects only bounded, positively identified scheduled old-publisher
 * evidence. The workflow endpoint is already scoped to publish.yml; branch,
 * repository, and run-name checks below prevent an unrelated run from
 * becoming operational proof.
 */
export function recentSuccessfulOldRun(
  value: unknown,
  now = Date.now(),
): OldSystemRunEvidence | null {
  const record = asRecord(value);
  const runs = Array.isArray(record?.workflow_runs)
    ? record.workflow_runs.slice(0, 20)
    : [];
  const maxAgeMs = 90 * 24 * 60 * 60 * 1_000;
  const candidates: (OldSystemRunEvidence & { readonly time: number })[] = [];
  for (const entry of runs) {
    const run = asRecord(entry);
    if (run === undefined || !isProtectedOldRun(run)) continue;
    const timestamp = runTimestamp(run);
    if (timestamp === undefined) continue;
    const time = Date.parse(timestamp);
    if (Number.isNaN(time) || time > now || now - time > maxAgeMs) continue;
    const runId = run.id;
    if (typeof runId !== "number" || !Number.isSafeInteger(runId) || runId <= 0)
      continue;
    if (run.event !== "schedule") continue;
    candidates.push({
      kind: "scheduled",
      runId,
      time,
      evidence: `successful scheduled run ${runId} on protected main`,
    });
  }
  candidates.sort((left, right) => right.time - left.time);
  const selected = candidates[0];
  if (selected === undefined) return null;
  return {
    kind: selected.kind,
    runId: selected.runId,
    evidence: selected.evidence,
  };
}

function isProtectedOldRun(run: Record<string, unknown>): boolean {
  if (
    run.conclusion !== "success" ||
    run.event !== "schedule" ||
    run.head_branch !== "main"
  )
    return false;
  if (
    typeof run.path !== "string" ||
    !OLD_WORKFLOW_API_PATHS.some((path) => path === run.path)
  )
    return false;
  if (run.name !== "Publish control plane") return false;
  if (!isDateTime(run.created_at) || !isDateTime(run.updated_at)) return false;
  for (const key of ["repository", "head_repository"]) {
    const repository = asRecord(run[key]);
    if (repository?.full_name !== RELEASE_REPOSITORY) return false;
  }
  for (const key of ["workflow_ref", "workflowRef"]) {
    const workflowRef = run[key];
    if (
      workflowRef !== undefined &&
      (typeof workflowRef !== "string" || workflowRef !== OLD_WORKFLOW_REF)
    )
      return false;
  }
  if (typeof run.display_title !== "string") return false;
  return true;
}

function runTimestamp(run: Record<string, unknown>): string | undefined {
  const updated = run.updated_at;
  return isDateTime(updated) ? updated : undefined;
}

function isDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.includes("T") &&
    !Number.isNaN(Date.parse(value))
  );
}

async function readAttestationWorkflow(
  root: string,
): Promise<DoctorAttestationWorkflowObservation> {
  const path = `${root}/${RELEASE_ATTEST_WORKFLOW_PATH}`;
  const file = Bun.file(path);
  const present = await file.exists();
  if (!present)
    return { readable: true, present: false, declaresWorkflowCall: false };
  const text = await file.text();
  return {
    readable: true,
    present: true,
    declaresWorkflowCall: /["']?workflow_call["']?\s*:/.test(text),
  };
}

async function collectPolicy(root: string): Promise<DoctorPolicyObservation> {
  const packageNames = Object.keys(PUBLIC_PACKAGES) as PublicPackageName[];
  let packagePolicyPassed = true;
  let packagePolicyDetail = "all public package manifests are readable";
  for (const packageName of packageNames) {
    const path = `${root}/${PUBLIC_PACKAGES[packageName].directory}/package.json`;
    const file = Bun.file(path);
    if (!(await file.exists())) {
      packagePolicyPassed = false;
      packagePolicyDetail = `${path} is missing`;
      break;
    }
    const text = await file.text();
    const parsed = Result.fromThrowable(
      () => JSON.parse(text) as unknown,
      () => undefined,
    )();
    if (parsed.isErr() || asRecord(parsed.value) === undefined) {
      packagePolicyPassed = false;
      packagePolicyDetail = `${path} is not valid JSON`;
      break;
    }
  }
  const docs = await runDeterministicDocsCheck(root);
  const docsPolicyPassed = docs.isOk() && docs.value.passed;
  return {
    packagePolicyPassed,
    packagePolicyDetail,
    docsPolicyPassed,
    docsPolicyDetail: docs.isErr()
      ? docs.error.type
      : docs.value.issues
          .map((issue) => `${issue.kind}:${issue.path}`)
          .join(", "),
  };
}

async function collectGitHub(
  environment: Readonly<Record<string, string | undefined>>,
  errors: Record<string, string>,
  options: DoctorCollectionOptions = {},
): Promise<DoctorGitHubObservation> {
  const token = environment.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    errors["github.api"] = "GITHUB_TOKEN is missing";
    return unavailableGitHub();
  }
  // The API is intentionally read-only. A malformed response is represented as
  // unavailable rather than guessed healthy. Detailed console paths are in the
  // verifier fixes above.
  // The token is attached only after the origin proves it is the official
  // GitHub API. An unusable GITHUB_API_URL makes GitHub state unavailable; it
  // never causes a credentialed request to another origin.
  const apiUrl = resolveGitHubApiUrl(
    options.githubApiUrl ?? environment.GITHUB_API_URL,
  );
  if (apiUrl.isErr()) {
    errors["github.api"] = apiUrl.error.message;
    return unavailableGitHub();
  }
  const api = new GitHubReadClient(
    RELEASE_REPOSITORY,
    token,
    options.githubFetch,
    apiUrl.value,
  );
  const [
    release,
    prerelease,
    ruleset,
    team,
    app,
    secrets,
    releaseSecrets,
    prereleaseSecrets,
    releaseAiSecrets,
    releaseAppSecrets,
    docsAuditPatchSecrets,
    releaseRefsSecrets,
  ] = await Promise.all([
    api.readEnvironment("release"),
    api.readEnvironment("prerelease"),
    api.readRuleset(),
    api.readTeam(),
    api.readInstallation(),
    api.readSecrets(),
    api.readEnvironmentSecrets("release"),
    api.readEnvironmentSecrets("prerelease"),
    api.readEnvironmentSecrets("release-ai"),
    api.readEnvironmentSecrets("release-app"),
    api.readEnvironmentSecrets("docs-audit-patch"),
    api.readEnvironmentSecrets("release-refs"),
  ]);
  const environmentValue = (name: "release" | "prerelease", value: unknown) => {
    const present = value !== undefined;
    return {
      name,
      exists: present,
      readable: present,
      // Existence is not protection. `{}` and an empty rule list are readable
      // environments with no reviewer gate at all, so the observation reports
      // protection only when GitHub names at least one required reviewer.
      protectionConfigured: present && hasRequiredReviewerProtection(value),
    } satisfies DoctorEnvironmentObservation;
  };
  if (release.isErr())
    errors["github.environments.release"] = release.error.message;
  if (prerelease.isErr())
    errors["github.environments.prerelease"] = prerelease.error.message;
  if (ruleset.isErr()) errors["github.ruleset"] = ruleset.error.message;
  if (team.isErr()) errors["github.team"] = team.error.message;
  if (app.isErr()) errors["github.app"] = app.error.message;
  if (secrets.isErr()) errors["github.secrets"] = secrets.error.message;
  const environmentSecretReads = [
    ["release", releaseSecrets],
    ["prerelease", prereleaseSecrets],
    ["release-ai", releaseAiSecrets],
    ["release-app", releaseAppSecrets],
    ["docs-audit-patch", docsAuditPatchSecrets],
    ["release-refs", releaseRefsSecrets],
  ] as const;
  for (const [name, result] of environmentSecretReads)
    if (result.isErr()) errors[`github.secrets.${name}`] = result.error.message;
  const repositorySecrets = secrets.isOk()
    ? normalizeSecrets(secrets.value)
    : unavailableSecrets();
  return {
    environments: {
      release: environmentValue(
        "release",
        release.isOk() ? release.value : undefined,
      ),
      prerelease: environmentValue(
        "prerelease",
        prerelease.isOk() ? prerelease.value : undefined,
      ),
    },
    ruleset: ruleset.isOk()
      ? normalizeRuleset(ruleset.value)
      : unavailableRuleset(),
    team: team.isOk()
      ? normalizeTeam(team.value)
      : {
          organization: "",
          slug: "",
          exists: false,
          readable: false,
        },
    app: app.isOk()
      ? normalizeApp(app.value)
      : {
          installationReadable: false,
          permissions: {
            contents: "",
            pullRequests: "",
            checks: "",
            members: "",
          },
        },
    secrets: {
      readable:
        repositorySecrets.readable &&
        environmentSecretReads.every(([, result]) => result.isOk()),
      repositoryNames: repositorySecrets.repositoryNames,
      environmentNames: Object.fromEntries(
        environmentSecretReads.map(([name, result]) => [
          name,
          result.isOk() ? normalizeSecrets(result.value).repositoryNames : [],
        ]),
      ),
    },
  };
}

/**
 * Strictly parses GitHub's environment protection rules.
 *
 * The doctor accepts protection only when `protection_rules` contains a
 * `required_reviewers` rule that names at least one reviewer with a usable
 * identity. A missing key, a non-array, an empty array, a rule of another type,
 * an empty reviewer list, or a malformed reviewer entry is not protection.
 */
export function hasRequiredReviewerProtection(value: unknown): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  const rules = record.protection_rules;
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 32)
    return false;
  return rules.some((entry) => {
    const rule = asRecord(entry);
    if (rule === undefined || rule.type !== "required_reviewers") return false;
    const reviewers = rule.reviewers;
    if (!Array.isArray(reviewers) || reviewers.length === 0) return false;
    if (reviewers.length > 64) return false;
    return reviewers.every((candidate) => {
      const reviewer = asRecord(candidate);
      if (reviewer === undefined) return false;
      if (reviewer.type !== "User" && reviewer.type !== "Team") return false;
      const reviewerRecord = asRecord(reviewer.reviewer);
      if (reviewerRecord === undefined) return false;
      const id = reviewerRecord.id;
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
    });
  });
}

function unavailableGitHub(): DoctorGitHubObservation {
  return {
    environments: {
      release: { name: "release", exists: false, readable: false },
      prerelease: { name: "prerelease", exists: false, readable: false },
    },
    ruleset: unavailableRuleset(),
    team: {
      organization: "",
      slug: "",
      exists: false,
      readable: false,
    },
    app: {
      installationReadable: false,
      permissions: {
        contents: "",
        pullRequests: "",
        checks: "",
        members: "",
      },
    },
    secrets: {
      readable: false,
      repositoryNames: [],
      environmentNames: emptySecretEnvironmentNames(),
    },
  };
}

function unavailableSecrets(): DoctorSecretObservation {
  return {
    readable: false,
    repositoryNames: [],
    environmentNames: emptySecretEnvironmentNames(),
  };
}

function emptySecretEnvironmentNames(): Readonly<
  Record<string, readonly string[]>
> {
  return {
    release: [],
    prerelease: [],
    "release-ai": [],
    "release-app": [],
    "docs-audit-patch": [],
    "release-refs": [],
  };
}

function unavailableRuleset(): DoctorRulesetObservation {
  return {
    exists: false,
    readable: false,
    targetBranch: "",
    requiredChecks: [],
    dismissStalePullRequestApprovals: false,
  };
}

function normalizeRuleset(value: unknown): DoctorRulesetObservation {
  const records = Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record === undefined ? [] : [record];
      })
    : (() => {
        const record = asRecord(value);
        return record === undefined ? [] : [record];
      })();
  const record =
    records.find((candidate) => {
      const name = candidate.name;
      const branch = rulesetTargetBranch(candidate);
      return name === "main" || name === "release" || branch === "main";
    }) ?? (records.length === 1 ? records[0] : undefined);
  if (record === undefined)
    return {
      exists: false,
      readable: false,
      targetBranch: "",
      requiredChecks: [],
      dismissStalePullRequestApprovals: false,
    };

  const rules = Array.isArray(record.rules)
    ? record.rules.flatMap((item) => {
        const candidate = asRecord(item);
        return candidate === undefined ? [] : [candidate];
      })
    : [];
  const legacyRules = asRecord(record.rules);
  let required: readonly string[] = [];
  if (Array.isArray(record.requiredChecks))
    required = record.requiredChecks.filter(
      (item): item is string => typeof item === "string",
    );
  else if (Array.isArray(legacyRules?.required_status_checks))
    required = legacyRules.required_status_checks.flatMap((item) => {
      const candidate = asRecord(item);
      return typeof candidate?.context === "string" ? [candidate.context] : [];
    });
  else {
    const requiredRule = rules.find(
      (item) => item.type === "required_status_checks",
    );
    const parameters = asRecord(requiredRule?.parameters);
    const contexts = parameters?.required_status_checks;
    if (Array.isArray(contexts))
      required = contexts.flatMap((item) => {
        const candidate = asRecord(item);
        return typeof candidate?.context === "string"
          ? [candidate.context]
          : [];
      });
  }
  const requiredRule = rules.find(
    (item) => item.type === "required_status_checks",
  );
  const requiredParameters = asRecord(requiredRule?.parameters);
  const pullRequestRule = rules.find((item) => item.type === "pull_request");
  const pullRequestParameters = asRecord(pullRequestRule?.parameters);
  return {
    exists: true,
    readable: true,
    targetBranch: rulesetTargetBranch(record),
    requiredChecks: required,
    dismissStalePullRequestApprovals:
      record.dismissStalePullRequestApprovals === true ||
      legacyRules?.dismiss_stale_reviews === true ||
      requiredParameters?.dismiss_stale_reviews === true ||
      requiredParameters?.dismiss_stale_reviews_on_push === true ||
      requiredParameters?.dismiss_stale_pull_request_approvals === true ||
      pullRequestParameters?.dismiss_stale_reviews === true ||
      pullRequestParameters?.dismiss_stale_reviews_on_push === true ||
      pullRequestParameters?.dismiss_stale_pull_request_approvals === true,
  };
}

function rulesetTargetBranch(record: Record<string, unknown>): string {
  if (typeof record.targetBranch === "string") return record.targetBranch;
  const conditions = asRecord(record.conditions);
  const refs = asRecord(conditions?.ref_name);
  const includes = refs?.include;
  if (Array.isArray(includes)) {
    const main = includes.find(
      (value): value is string =>
        typeof value === "string" &&
        (value === "main" ||
          value === "refs/heads/main" ||
          value === "~DEFAULT_BRANCH"),
    );
    if (main !== undefined) return "main";
  }
  return typeof record.name === "string" ? record.name : "";
}

function normalizeTeam(value: unknown): DoctorTeamObservation {
  const record = asRecord(value);
  const organization = asRecord(record?.organization);
  let organizationName = "";
  if (typeof record?.organization === "string")
    organizationName = record.organization;
  else if (typeof organization?.login === "string")
    organizationName = organization.login;
  return {
    organization: organizationName,
    slug: typeof record?.slug === "string" ? record.slug : "",
    exists: record !== undefined,
    readable: record !== undefined,
  };
}

function normalizeApp(value: unknown): DoctorAppObservation {
  const record = asRecord(value);
  const permissions = asRecord(record?.permissions);
  let pullRequests = "";
  if (typeof permissions?.pull_requests === "string")
    pullRequests = permissions.pull_requests;
  else if (typeof permissions?.pullRequests === "string")
    pullRequests = permissions.pullRequests;
  return {
    installationReadable: record !== undefined,
    permissions: {
      contents:
        typeof permissions?.contents === "string" ? permissions.contents : "",
      pullRequests,
      checks: typeof permissions?.checks === "string" ? permissions.checks : "",
      members:
        typeof permissions?.members === "string" ? permissions.members : "",
    },
  };
}

function normalizeSecrets(value: unknown): DoctorSecretObservation {
  const record = asRecord(value);
  const directNames = Array.isArray(record?.names)
    ? record.names.filter((item): item is string => typeof item === "string")
    : [];
  const listedNames = Array.isArray(record?.secrets)
    ? record.secrets.flatMap((item) => {
        const secret = asRecord(item);
        return typeof secret?.name === "string" ? [secret.name] : [];
      })
    : [];
  const names = [...new Set([...directNames, ...listedNames])];
  const environments = asRecord(record?.environmentNames);
  const environmentNames: Record<string, readonly string[]> = {};
  for (const name of [
    "release",
    "prerelease",
    "release-ai",
    "release-app",
    "docs-audit-patch",
    "release-refs",
  ])
    environmentNames[name] = arrayOfStrings(environments?.[name]);
  return {
    readable: record !== undefined,
    repositoryNames: names,
    environmentNames,
  };
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function collectModel(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<DoctorModelObservation> {
  const provider = environment.RELEASE_DOCTOR_MODEL_PROVIDER ?? "opencode-go";
  const model = environment.RELEASE_DOCTOR_MODEL ?? "gpt-5.6-luna";
  const shouldPing = environment.RELEASE_DOCTOR_PROBE_MODELS === "true";
  if (!shouldPing)
    return {
      provider,
      model,
      reachable: false,
      minimalPingPerformed: false,
    };
  const pingUrl = environment.RELEASE_DOCTOR_MODEL_PING_URL;
  if (pingUrl === undefined || pingUrl.length === 0)
    return {
      provider,
      model,
      reachable: false,
      minimalPingPerformed: false,
    };
  const response = await ResultAsync.fromThrowable(
    () =>
      fetch(pingUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      }),
    () => undefined,
  )();
  return {
    provider,
    model,
    reachable: response.isOk() && response.value.ok,
    minimalPingPerformed: true,
  };
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record))
    if (typeof item === "string") output[key] = item;
  return output;
}

class GitHubReadClient {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: GitHubFetch = fetch,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  readEnvironment(name: string): ResultAsync<unknown, DoctorPortError> {
    return this.read(`/environments/${name}`);
  }

  readRuleset(): ResultAsync<unknown, DoctorPortError> {
    return this.read("/rulesets?includes_parents=true");
  }

  readTeam(): ResultAsync<unknown, DoctorPortError> {
    return this.readAbsolute(
      `${this.apiUrl}/orgs/weave-io/teams/release-maintainers`,
    );
  }

  readWorkflowRuns(
    workflowFile: string,
  ): ResultAsync<unknown, DoctorPortError> {
    return this.read(
      `/actions/workflows/${workflowFile}/runs?branch=main&per_page=20`,
    );
  }

  readInstallation(): ResultAsync<unknown, DoctorPortError> {
    return this.read("/installation");
  }

  readSecrets(): ResultAsync<unknown, DoctorPortError> {
    return this.read("/actions/secrets");
  }

  readEnvironmentSecrets(name: string): ResultAsync<unknown, DoctorPortError> {
    return this.read(`/environments/${name}/secrets`);
  }

  private read(path: string): ResultAsync<unknown, DoctorPortError> {
    return this.readAbsolute(`${this.apiUrl}/repos/${this.repository}${path}`);
  }

  private readAbsolute(url: string): ResultAsync<unknown, DoctorPortError> {
    return ResultAsync.fromThrowable(
      () =>
        withDoctorTimeout(
          () =>
            this.fetchImpl(url, {
              method: "GET",
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${this.token}`,
              },
            }),
          DOCTOR_TRANSPORT_LIMITS.requestTimeoutMs,
        ),
      (cause): DoctorPortError => ({
        type: "DoctorPortFailed",
        operation: url,
        message: String(cause),
      }),
    )().andThen(
      (response): ResultAsync<unknown, DoctorPortError> =>
        response.ok
          ? ResultAsync.fromThrowable(
              () =>
                boundedResponseBytes(
                  response,
                  DOCTOR_TRANSPORT_LIMITS.jsonResponseBytes,
                  DOCTOR_TRANSPORT_LIMITS.requestTimeoutMs,
                ).then(
                  (bytes) =>
                    JSON.parse(
                      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                    ) as unknown,
                ),
              (cause): DoctorPortError => ({
                type: "DoctorPortFailed",
                operation: url,
                message: String(cause),
              }),
            )()
          : errAsync<unknown, DoctorPortError>({
              type: "DoctorPortFailed",
              operation: url,
              message: `${response.status} ${response.statusText}`,
            }),
    );
  }
}

function isTerminalStateName(state: string): boolean {
  return (TERMINAL_RELEASE_COMPLETION_STATES as readonly string[]).includes(
    state,
  );
}

function isFullSha(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{40}$/.test(value) &&
    value !== "0".repeat(40)
  );
}

function isOwnerGeneration(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function groupedChecks(
  checks: readonly DoctorCheck[],
): Readonly<Record<DoctorCheckStatus, readonly DoctorCheck[]>> {
  return {
    pass: checks.filter((check) => check.status === "pass"),
    warn: checks.filter((check) => check.status === "warn"),
    fail: checks.filter((check) => check.status === "fail"),
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const parsed = parseDoctorMode(process.argv.slice(2));
  if (parsed.isErr()) {
    log.error({ error: parsed.error }, "invalid release doctor mode");
    process.exitCode = 2;
  } else {
    const result = await runEnvironmentDoctor(parsed.value, root);
    if (result.isErr()) {
      const failure =
        result.error.type === "DoctorFailed" ? result.error : undefined;
      log.error(
        {
          error: result.error,
          ...(failure === undefined
            ? {}
            : {
                checks: groupedChecks(failure.report.checks),
                failures: failure.failures,
              }),
        },
        "release doctor failed",
      );
      process.exitCode = 1;
    } else {
      log.info(
        {
          mode: result.value.mode,
          status: result.value.status,
          checks: groupedChecks(result.value.checks),
        },
        "release doctor passed",
      );
    }
  }
}
