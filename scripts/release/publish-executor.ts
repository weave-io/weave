/**
 * OIDC publication planner and serial resumable executor.
 *
 * A validated plan binding is the only publishable input. The executor
 * preflights every closure member against the registry, skips exact digest
 * matches, fail-closes on a digest mismatch before any mutation, then publishes
 * remaining tarballs in catalog order with provenance. It never unpublished,
 * never moves `latest` backward, and never promotes a dist-tag.
 */
import { isAbsolute, join, normalize } from "node:path";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import {
  NPM_DIGEST_PREFIX,
  type PublicPackageName,
  RELEASE_INPUT_LIMITS,
  type ReleaseChannel,
} from "./constants.js";
import type { FileSystemError, RegistryError } from "./errors.js";
import type { FileSystem } from "./filesystem.js";
import {
  DigestSchema,
  FullShaSchema,
  PackageNameSchema,
  SemVerSchema,
} from "./model.js";
import type { PublishRegistry, PublishTag } from "./npm-registry-client.js";
import {
  type CredentialScanInput,
  publishablePackageNames,
  scanCredentialSources,
} from "./package-policy.js";
import {
  type ReleasePlan,
  type ReleasePlanBinding,
  type ReleasePlanError,
  validateReleasePlan,
  verifyReleasePlanBinding,
} from "./release-plan.js";

export const PUBLICATION_REPORT_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_PROOF_CHAIN_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_REPORT_LIMITS = {
  bytes: 64 * 1024,
  members: RELEASE_INPUT_LIMITS.packageCount,
  errorLength: 128,
  directoryLength: 256,
} as const;
export const PUBLISH_TAGS = ["latest", "next", "nightly"] as const;
export const PUBLICATION_MEMBER_STATUSES = [
  "already-published",
  "published",
  "failed",
  "pending",
] as const;

const parseJson = Result.fromThrowable(
  (source: string) => JSON.parse(source) as unknown,
  (cause): PublicationError => ({
    type: "MalformedPublicationJson",
    reason: cause instanceof Error ? cause.message : String(cause),
  }),
);

const ArtifactDirectorySchema = z
  .string()
  .min(1)
  .max(PUBLICATION_REPORT_LIMITS.directoryLength)
  .refine(
    (value) => !value.includes("..") && !/[;&|`$<>\n\r]/.test(value),
    "artifact directory must be a bounded safe path",
  );

const RecordedProofSchema = z
  .object({
    status: z.literal("recorded"),
    digest: DigestSchema,
  })
  .strict();

export const TarballProofMarkerSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    tarballSha256: DigestSchema,
    cleanConsumer: RecordedProofSchema,
    harnessProof: RecordedProofSchema.optional(),
  })
  .strict();

export const PublicationProofChainSchema = z
  .object({
    schemaVersion: z.literal(PUBLICATION_PROOF_CHAIN_SCHEMA_VERSION),
    markers: z
      .array(TarballProofMarkerSchema)
      .min(1)
      .max(PUBLICATION_REPORT_LIMITS.members),
  })
  .strict()
  .superRefine((chain, context) => {
    const packages = chain.markers.map((marker) => marker.packageName);
    requireUnique(packages, context, ["markers"], "package");
    requireUnique(
      chain.markers.map((marker) => marker.tarballSha256),
      context,
      ["markers"],
      "tarball digest",
    );
    requireCatalogOrder(packages, context, ["markers"]);
  });

const PublicationMemberSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    tarballSha256: DigestSchema,
    status: z.enum(PUBLICATION_MEMBER_STATUSES),
    verification: z.enum(["digest-verified", "unverified"]),
    error: z
      .string()
      .min(1)
      .max(PUBLICATION_REPORT_LIMITS.errorLength)
      .optional(),
  })
  .strict()
  .superRefine((member, context) => {
    if (
      (member.status === "published" ||
        member.status === "already-published") &&
      member.verification !== "digest-verified"
    )
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "published members must be digest-verified",
      });
    if (
      (member.status === "failed" || member.status === "pending") &&
      member.verification !== "unverified"
    )
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "unfinished members stay unverified",
      });
    if (member.status === "failed" && member.error === undefined)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "failed members must name the typed error",
      });
    if (member.status !== "failed" && member.error !== undefined)
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "only failed members carry an error",
      });
  });

export const PublicationReportSchema = z
  .object({
    schemaVersion: z.literal(PUBLICATION_REPORT_SCHEMA_VERSION),
    channel: z.enum(["stable", "next", "nightly"]),
    tag: z.enum(PUBLISH_TAGS),
    releasedSha: FullShaSchema,
    members: z
      .array(PublicationMemberSchema)
      .min(1)
      .max(PUBLICATION_REPORT_LIMITS.members),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.tag !== publishTagForChannel(report.channel))
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "tag must be the direct channel tag",
      });
    const packages = report.members.map((member) => member.packageName);
    requireUnique(packages, context, ["members"], "package");
    requireCatalogOrder(packages, context, ["members"]);
  });

export type TarballProofMarker = z.infer<typeof TarballProofMarkerSchema>;
export type PublicationProofChain = z.infer<typeof PublicationProofChainSchema>;
export type PublicationMember = z.infer<typeof PublicationMemberSchema>;
export type PublicationReport = z.infer<typeof PublicationReportSchema>;

export type PublicationError =
  | { type: "InvalidPublicationInput"; issues: readonly string[] }
  | { type: "InvalidPublicationReport"; issues: readonly string[] }
  | { type: "MalformedPublicationJson"; reason: string }
  | { type: "PublicationReportTooLarge"; bytes: number; limit: number }
  | { type: "InvalidPublicationPlan"; error: ReleasePlanError }
  | { type: "CredentialSourceDetected"; source: string }
  | {
      type: "ProofMarkerMissing";
      marker: "cleanConsumer" | "harnessProof";
      packageName?: PublicPackageName;
    }
  | {
      type: "ProofMarkerMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string;
    }
  | {
      type: "RegistryDigestMismatch";
      packageName: PublicPackageName;
      version: string;
      expected: string;
      actual: string;
    }
  | {
      type: "LocalDigestMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string;
    }
  | { type: "TarballPathEscapesDirectory"; path: string }
  | {
      type: "PublicationIncomplete";
      report: PublicationReport;
      cause: PublicationError;
    }
  | RegistryError
  | FileSystemError;

export interface PublicationRequestInput {
  plan: unknown;
  proofChain: unknown;
  artifactDirectory: unknown;
  credentialScan?: CredentialScanInput;
}

export interface ValidatedPublicationRequest {
  plan: ReleasePlan;
  binding: ReleasePlanBinding;
  proofChain: PublicationProofChain;
  artifactDirectory: string;
  credentialScan?: CredentialScanInput;
}

export interface PublicationDependencies {
  registry: PublishRegistry;
  files: FileSystem;
}

/** Stable publishes as `latest` directly. Prerelease channels keep their name. */
export function publishTagForChannel(channel: ReleaseChannel): PublishTag {
  if (channel === "stable") return "latest";
  return channel;
}

export function requiresHarnessProof(packageName: PublicPackageName): boolean {
  return packageName !== "@weaveio/weave-cli";
}

export function validatePublicationProofChain(
  input: unknown,
): Result<PublicationProofChain, PublicationError> {
  const parsed = PublicationProofChainSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidPublicationInput",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

export function validatePublicationReport(
  input: unknown,
): Result<PublicationReport, PublicationError> {
  const parsed = PublicationReportSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidPublicationReport",
      issues: describeIssues(parsed.error.issues),
    });
  return ok(parsed.data);
}

export function parsePublicationReport(
  text: string,
): Result<PublicationReport, PublicationError> {
  if (text.length > PUBLICATION_REPORT_LIMITS.bytes)
    return err({
      type: "PublicationReportTooLarge",
      bytes: text.length,
      limit: PUBLICATION_REPORT_LIMITS.bytes,
    });
  return parseJson(text).andThen(validatePublicationReport);
}

export function serializePublicationReport(
  report: PublicationReport,
): Result<string, PublicationError> {
  return validatePublicationReport(report).map(
    (validated) => `${JSON.stringify(validated, null, 2)}\n`,
  );
}

export function validatePublicationRequest(
  input: PublicationRequestInput,
): Result<ValidatedPublicationRequest, PublicationError> {
  const directory = ArtifactDirectorySchema.safeParse(input.artifactDirectory);
  if (!directory.success)
    return err({
      type: "InvalidPublicationInput",
      issues: describeIssues(directory.error.issues),
    });
  const plan = validateReleasePlan(input.plan);
  if (plan.isErr())
    return err({ type: "InvalidPublicationPlan", error: plan.error });
  const binding = verifyReleasePlanBinding(plan.value);
  if (binding.isErr())
    return err({ type: "InvalidPublicationPlan", error: binding.error });
  return validatePublicationProofChain(input.proofChain)
    .andThen((proofChain) => matchProofChain(binding.value, proofChain))
    .andThen((proofChain) =>
      requireBindingProofMarkers(binding.value).map(() => ({
        plan: plan.value,
        binding: binding.value,
        proofChain,
        artifactDirectory: directory.data,
        credentialScan: input.credentialScan,
      })),
    );
}

/** Serial, idempotent publication over one validated binding. */
export class PublishExecutor {
  constructor(private readonly deps: PublicationDependencies) {}

  execute(
    input: PublicationRequestInput,
  ): ResultAsync<PublicationReport, PublicationError> {
    const request = validatePublicationRequest(input);
    if (request.isErr()) return errAsync(request.error);
    return this.executeValidated(request.value);
  }

  executeValidated(
    request: ValidatedPublicationRequest,
  ): ResultAsync<PublicationReport, PublicationError> {
    const credentials = this.rejectCredentials(request.credentialScan);
    if (credentials.isErr()) return errAsync(credentials.error);
    return this.preflight(request).andThen((decision) =>
      this.publishRemaining(request, decision),
    );
  }

  private rejectCredentials(
    scan: CredentialScanInput | undefined,
  ): Result<void, PublicationError> {
    if (scan === undefined) return ok(undefined);
    const credentials = scanCredentialSources(scan);
    if (credentials.isErr())
      return err({
        type: "CredentialSourceDetected",
        source: credentials.error,
      });
    return ok(undefined);
  }

  private preflight(
    request: ValidatedPublicationRequest,
  ): ResultAsync<PreflightDecision, PublicationError> {
    const members = orderedMembers(request.binding);
    return members
      .reduce<
        ResultAsync<
          { skip: PublicationMember[]; publish: BoundTarball[] },
          PublicationError
        >
      >(
        (chain, tarball) =>
          chain.andThen((acc) =>
            this.deps.registry
              .readPublishedTarballDigest(tarball.packageName, tarball.version)
              .mapErr(registryError)
              .andThen((state) => classifyPreflight(tarball, state, acc)),
          ),
        okAsync({ skip: [], publish: [] }),
      )
      .andThen((decision) => this.verifyLocalTarballs(request, decision));
  }

  private verifyLocalTarballs(
    request: ValidatedPublicationRequest,
    decision: PreflightDecision,
  ): ResultAsync<PreflightDecision, PublicationError> {
    return decision.publish
      .reduce<ResultAsync<void, PublicationError>>(
        (chain, tarball) =>
          chain.andThen(() =>
            resolveTarballPath(
              request.artifactDirectory,
              tarball.path,
            ).asyncAndThen((path) =>
              this.deps.files.readBytes(path).andThen((bytes) => {
                const actual = digestBytes(bytes);
                if (actual !== tarball.sha256)
                  return errAsync({
                    type: "LocalDigestMismatch" as const,
                    packageName: tarball.packageName,
                    expected: tarball.sha256,
                    actual,
                  });
                return okAsync(undefined);
              }),
            ),
          ),
        okAsync(undefined),
      )
      .map(() => decision);
  }

  private publishRemaining(
    request: ValidatedPublicationRequest,
    decision: PreflightDecision,
  ): ResultAsync<PublicationReport, PublicationError> {
    const tag = publishTagForChannel(request.plan.channel);
    return publishAt(
      this.deps,
      request,
      tag,
      decision.publish,
      0,
      decision.skip,
    ).andThen((members) =>
      toReport(request, mergeMembers(request.binding, members)),
    );
  }
}

interface BoundTarball {
  packageName: PublicPackageName;
  version: string;
  path: string;
  sha256: string;
}

interface PreflightDecision {
  skip: PublicationMember[];
  publish: BoundTarball[];
}

function classifyPreflight(
  tarball: BoundTarball,
  state: { state: "unpublished" } | { state: "published"; sha256: string },
  acc: PreflightDecision,
): Result<PreflightDecision, PublicationError> {
  if (state.state === "unpublished")
    return ok({
      skip: acc.skip,
      publish: [...acc.publish, tarball],
    });
  if (state.sha256 !== tarball.sha256)
    return err({
      type: "RegistryDigestMismatch",
      packageName: tarball.packageName,
      version: tarball.version,
      expected: tarball.sha256,
      actual: state.sha256,
    });
  return ok({
    skip: [
      ...acc.skip,
      member(tarball, {
        status: "already-published",
        verification: "digest-verified",
      }),
    ],
    publish: acc.publish,
  });
}

function publishAt(
  deps: PublicationDependencies,
  request: ValidatedPublicationRequest,
  tag: PublishTag,
  remaining: readonly BoundTarball[],
  index: number,
  done: readonly PublicationMember[],
): ResultAsync<readonly PublicationMember[], PublicationError> {
  const current = remaining[index];
  if (current === undefined) return okAsync(done);
  return resolveTarballPath(request.artifactDirectory, current.path)
    .asyncAndThen((path) =>
      deps.registry
        .publishWithProvenance(path, tag)
        .mapErr(registryError)
        .andThen(() =>
          deps.registry
            .verifyPublished(
              current.packageName,
              current.version,
              current.sha256,
            )
            .mapErr((error) =>
              error.message === "tarball digest mismatch"
                ? {
                    type: "RegistryDigestMismatch" as const,
                    packageName: current.packageName,
                    version: current.version,
                    expected: current.sha256,
                    actual: "registry-digest-mismatch",
                  }
                : registryError(error),
            ),
        ),
    )
    .andThen(() =>
      publishAt(deps, request, tag, remaining, index + 1, [
        ...done,
        member(current, {
          status: "published",
          verification: "digest-verified",
        }),
      ]),
    )
    .orElse((cause) => {
      if (cause.type === "PublicationIncomplete") return errAsync(cause);
      return incomplete(
        request,
        [
          ...done,
          member(current, {
            status: "failed",
            verification: "unverified",
            error: cause.type,
          }),
          ...remaining.slice(index + 1).map((tarball) =>
            member(tarball, {
              status: "pending",
              verification: "unverified",
            }),
          ),
        ],
        cause,
      );
    });
}

function incomplete(
  request: ValidatedPublicationRequest,
  members: readonly PublicationMember[],
  cause: PublicationError,
): ResultAsync<readonly PublicationMember[], PublicationError> {
  return toReport(request, mergeMembers(request.binding, members)).asyncAndThen(
    (report) =>
      errAsync({
        type: "PublicationIncomplete" as const,
        report,
        cause,
      }),
  );
}

function toReport(
  request: ValidatedPublicationRequest,
  members: readonly PublicationMember[],
): Result<PublicationReport, PublicationError> {
  return validatePublicationReport({
    schemaVersion: PUBLICATION_REPORT_SCHEMA_VERSION,
    channel: request.plan.channel,
    tag: publishTagForChannel(request.plan.channel),
    releasedSha: request.plan.releasedSha,
    members,
  });
}

function matchProofChain(
  binding: ReleasePlanBinding,
  chain: PublicationProofChain,
): Result<PublicationProofChain, PublicationError> {
  if (chain.markers.length !== binding.tarballs.length)
    return err({
      type: "ProofMarkerMissing",
      marker: "cleanConsumer",
    });
  for (const tarball of binding.tarballs) {
    const marker = chain.markers.find(
      (entry) => entry.packageName === tarball.packageName,
    );
    if (marker === undefined)
      return err({
        type: "ProofMarkerMissing",
        marker: "cleanConsumer",
        packageName: tarball.packageName,
      });
    if (
      marker.version !== tarball.version ||
      marker.tarballSha256 !== tarball.sha256
    )
      return err({
        type: "ProofMarkerMismatch",
        packageName: tarball.packageName,
        expected: tarball.sha256,
        actual: marker.tarballSha256,
      });
    if (
      requiresHarnessProof(tarball.packageName) &&
      marker.harnessProof === undefined
    )
      return err({
        type: "ProofMarkerMissing",
        marker: "harnessProof",
        packageName: tarball.packageName,
      });
  }
  return ok(chain);
}

function requireBindingProofMarkers(
  binding: ReleasePlanBinding,
): Result<void, PublicationError> {
  if (binding.proofMarkers.cleanConsumer.status !== "recorded")
    return err({ type: "ProofMarkerMissing", marker: "cleanConsumer" });
  if (
    binding.tarballs.some((tarball) =>
      requiresHarnessProof(tarball.packageName),
    ) &&
    binding.proofMarkers.harnessProof.status !== "recorded"
  )
    return err({ type: "ProofMarkerMissing", marker: "harnessProof" });
  return ok(undefined);
}

function orderedMembers(binding: ReleasePlanBinding): BoundTarball[] {
  const catalog = publishablePackageNames();
  return [...binding.tarballs]
    .map((tarball) => ({
      packageName: tarball.packageName,
      version: tarball.version,
      path: tarball.path,
      sha256: tarball.sha256,
    }))
    .sort(
      (left, right) =>
        catalog.indexOf(left.packageName) - catalog.indexOf(right.packageName),
    );
}

function mergeMembers(
  binding: ReleasePlanBinding,
  outcomes: readonly PublicationMember[],
): PublicationMember[] {
  const byPackage = new Map(
    outcomes.map((member) => [member.packageName, member]),
  );
  return orderedMembers(binding).map((tarball) => {
    const existing = byPackage.get(tarball.packageName);
    if (existing !== undefined) return existing;
    return member(tarball, {
      status: "pending",
      verification: "unverified",
    });
  });
}

function member(
  tarball: BoundTarball,
  fields: Pick<PublicationMember, "status" | "verification"> &
    Partial<Pick<PublicationMember, "error">>,
): PublicationMember {
  return {
    packageName: tarball.packageName,
    version: tarball.version,
    tarballSha256: tarball.sha256,
    status: fields.status,
    verification: fields.verification,
    ...(fields.error === undefined ? {} : { error: fields.error }),
  };
}

function resolveTarballPath(
  directory: string,
  relativePath: string,
): Result<string, PublicationError> {
  if (isAbsolute(relativePath))
    return err({ type: "TarballPathEscapesDirectory", path: relativePath });
  const root = normalize(directory);
  const resolved = normalize(join(directory, relativePath));
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (resolved !== root && !resolved.startsWith(prefix))
    return err({ type: "TarballPathEscapesDirectory", path: relativePath });
  return ok(resolved);
}

function registryError(error: RegistryError): PublicationError {
  return error;
}

function digestBytes(bytes: Uint8Array): string {
  return `${NPM_DIGEST_PREFIX}${new Bun.CryptoHasher("sha256")
    .update(bytes)
    .digest("hex")}`;
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

function requireCatalogOrder(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  const expected = publishablePackageNames().filter((name) =>
    values.includes(name),
  );
  if (values.join("\u0000") === expected.join("\u0000")) return;
  context.addIssue({
    code: "custom",
    path: [...path],
    message: `expected catalog order [${expected.join(", ")}]`,
  });
}

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): readonly string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}
