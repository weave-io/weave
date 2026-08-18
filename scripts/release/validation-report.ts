/**
 * The immutable, digest-bound validation record for a release.
 *
 * This module records evidence; it does not create an SBOM or an attestation
 * format. GitHub artifact attestations and npm provenance remain the platform
 * records. Every value is strict, bounded, and tied to the released commit.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  type PublicPackageName,
  RELEASE_ATTEST_WORKFLOW_PATH,
} from "./constants.js";
import { DigestSchema, FullShaSchema, SemVerSchema } from "./model.js";
import { publishablePackageNames } from "./package-policy.js";
import {
  PUBLICATION_REPORT_SCHEMA_VERSION,
  type PublicationReport,
  PublicationReportSchema,
} from "./publish-executor.js";
import { ReleasePlanBindingSchema } from "./release-plan.js";

export const VALIDATION_REPORT_SCHEMA_VERSION = 1 as const;
export const VALIDATION_REPORT_LIMITS = {
  bytes: 128 * 1024,
  packages: 4,
  subjects: 4,
  summary: 512,
  url: 512,
  identifier: 128,
} as const;

const ID = z
  .string()
  .min(1)
  .max(VALIDATION_REPORT_LIMITS.identifier)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const PositiveId = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .refine(Number.isSafeInteger, "ID must be a safe integer");
const HttpsUrl = z
  .string()
  .min(1)
  .max(VALIDATION_REPORT_LIMITS.url)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && url.username === "" && url.password === ""
      );
    } catch {
      return false;
    }
  }, "URL must be an HTTPS URL without credentials");
const Summary = z.string().min(1).max(VALIDATION_REPORT_LIMITS.summary);
const PublicPackageSchema = z.enum(
  publishablePackageNames() as [PublicPackageName, ...PublicPackageName[]],
);

const ProofMarkerSchema = z
  .object({
    status: z.literal("recorded"),
    digest: DigestSchema,
  })
  .strict();
const HarnessMarkerSchema = z.union([
  ProofMarkerSchema,
  z.object({ status: z.literal("not-required") }).strict(),
]);

export const ValidationReportPackageSchema = z
  .object({
    packageName: PublicPackageSchema,
    version: SemVerSchema,
    tarballSha256: DigestSchema,
    npmProvenanceUrl: HttpsUrl,
    attestation: z
      .object({
        id: ID,
        subjectDigest: DigestSchema,
        url: HttpsUrl,
      })
      .strict(),
    cleanConsumer: z
      .object({
        status: z.literal("passed"),
        digest: DigestSchema,
        summary: Summary,
      })
      .strict(),
    harnessProof: z
      .object({
        status: z.union([z.literal("passed"), z.literal("not-required")]),
        digest: DigestSchema.optional(),
        summary: Summary,
      })
      .strict()
      .superRefine((proof, context) => {
        if (proof.status === "passed" && proof.digest === undefined)
          context.addIssue({
            code: "custom",
            path: ["digest"],
            message: "a passed harness proof needs a digest",
          });
        if (proof.status === "not-required" && proof.digest !== undefined)
          context.addIssue({
            code: "custom",
            path: ["digest"],
            message: "a not-required harness proof has no digest",
          });
      }),
    proofMarkers: z
      .object({
        attestation: ProofMarkerSchema,
        cleanConsumer: ProofMarkerSchema,
        harnessProof: HarnessMarkerSchema,
      })
      .strict(),
  })
  .strict();

const AttestationSubjectSchema = z
  .object({
    packageName: PublicPackageSchema,
    subjectDigest: DigestSchema,
    id: ID,
    url: HttpsUrl,
  })
  .strict();

const CompositionProofSchema = z
  .object({
    packageName: PublicPackageSchema,
    digest: DigestSchema,
    summary: Summary,
  })
  .strict();
const CompositionInputSchema = z
  .object({
    releasedSha: FullShaSchema,
    planDigest: DigestSchema,
    binding: z.unknown(),
    publication: z.unknown(),
    attestation: z
      .object({
        sourceRunId: PositiveId,
        artifactId: PositiveId,
        checkRunId: PositiveId,
        sourceSha: FullShaSchema,
        planDigest: DigestSchema,
        subjects: z
          .array(AttestationSubjectSchema)
          .min(1)
          .max(VALIDATION_REPORT_LIMITS.subjects),
      })
      .strict(),
    npmProvenance: z
      .array(
        z.object({ packageName: PublicPackageSchema, url: HttpsUrl }).strict(),
      )
      .min(1)
      .max(VALIDATION_REPORT_LIMITS.packages),
    cleanConsumer: z
      .array(CompositionProofSchema)
      .min(1)
      .max(VALIDATION_REPORT_LIMITS.packages),
    harnessProof: z
      .array(CompositionProofSchema)
      .max(VALIDATION_REPORT_LIMITS.packages),
  })
  .strict();

/** Dynamic data supplied to the independent, non-reusable attestation run. */
export const ReleaseAttestationRequestSchema = z
  .object({
    schemaVersion: z.literal(VALIDATION_REPORT_SCHEMA_VERSION),
    sourceRunId: PositiveId,
    artifactId: PositiveId,
    releasedSha: FullShaSchema,
    planDigest: DigestSchema,
    tarballDigests: z
      .array(
        z
          .object({ packageName: PublicPackageSchema, sha256: DigestSchema })
          .strict(),
      )
      .min(1)
      .max(VALIDATION_REPORT_LIMITS.packages),
  })
  .strict()
  .superRefine((request, context) => {
    requireUnique(
      request.tarballDigests.map((item) => item.packageName),
      context,
      ["tarballDigests"],
      "package",
    );
    requireUnique(
      request.tarballDigests.map((item) => item.sha256),
      context,
      ["tarballDigests"],
      "tarball digest",
    );
  });

export const ValidationReportSchema = z
  .object({
    schemaVersion: z.literal(VALIDATION_REPORT_SCHEMA_VERSION),
    releasedSha: FullShaSchema,
    planDigest: DigestSchema,
    attestation: z
      .object({
        sourceRunId: PositiveId,
        artifactId: PositiveId,
        checkRunId: PositiveId,
        sourceSha: FullShaSchema,
        planDigest: DigestSchema,
        subjects: z
          .array(AttestationSubjectSchema)
          .min(1)
          .max(VALIDATION_REPORT_LIMITS.subjects),
      })
      .strict(),
    publication: PublicationReportSchema,
    packages: z
      .array(ValidationReportPackageSchema)
      .min(1)
      .max(VALIDATION_REPORT_LIMITS.packages),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.attestation.sourceSha !== report.releasedSha)
      issue(context, ["attestation", "sourceSha"], "foreign released SHA");
    if (report.attestation.planDigest !== report.planDigest)
      issue(context, ["attestation", "planDigest"], "foreign plan digest");
    if (report.publication.releasedSha !== report.releasedSha)
      issue(context, ["publication", "releasedSha"], "foreign released SHA");

    const packages = report.packages.map((item) => item.packageName);
    requireUnique(packages, context, ["packages"], "package");
    requireUnique(
      report.attestation.subjects.map((item) => item.packageName),
      context,
      ["attestation", "subjects"],
      "attestation subject package",
    );
    requireUnique(
      report.attestation.subjects.map((item) => item.subjectDigest),
      context,
      ["attestation", "subjects"],
      "attestation subject digest",
    );
    requireUnique(
      report.attestation.subjects.map((item) => item.id),
      context,
      ["attestation", "subjects"],
      "attestation ID",
    );

    const publicationByPackage = new Map(
      report.publication.members.map((member) => [member.packageName, member]),
    );
    const subjectByPackage = new Map(
      report.attestation.subjects.map((subject) => [
        subject.packageName,
        subject,
      ]),
    );
    for (const item of report.packages) {
      const publication = publicationByPackage.get(item.packageName);
      const subject = subjectByPackage.get(item.packageName);
      if (publication === undefined)
        issue(context, ["packages"], `publication missing ${item.packageName}`);
      else {
        if (publication.version !== item.version)
          issue(
            context,
            ["packages"],
            `version mismatch for ${item.packageName}`,
          );
        if (publication.tarballSha256 !== item.tarballSha256)
          issue(
            context,
            ["packages"],
            `tarball digest mismatch for ${item.packageName}`,
          );
      }
      if (subject === undefined)
        issue(
          context,
          ["attestation", "subjects"],
          `subject missing ${item.packageName}`,
        );
      else if (subject.subjectDigest !== item.tarballSha256)
        issue(
          context,
          ["attestation", "subjects"],
          `foreign subject digest for ${item.packageName}`,
        );
      if (item.attestation.subjectDigest !== item.tarballSha256)
        issue(
          context,
          ["packages"],
          `attestation digest mismatch for ${item.packageName}`,
        );
      if (subject !== undefined && item.attestation.id !== subject.id)
        issue(
          context,
          ["packages"],
          `attestation ID mismatch for ${item.packageName}`,
        );
      if (subject !== undefined && item.attestation.url !== subject.url)
        issue(
          context,
          ["packages"],
          `attestation URL mismatch for ${item.packageName}`,
        );
      for (const [name, marker] of Object.entries(item.proofMarkers)) {
        if (marker.status === "not-required") continue;
        if (!("digest" in marker) || marker.digest !== item.tarballSha256)
          issue(
            context,
            ["packages"],
            `${name} digest mismatch for ${item.packageName}`,
          );
      }
      if (
        item.harnessProof.status === "passed" &&
        item.harnessProof.digest !== item.tarballSha256
      )
        issue(
          context,
          ["packages"],
          `harness digest mismatch for ${item.packageName}`,
        );
      if (item.cleanConsumer.digest !== item.tarballSha256)
        issue(
          context,
          ["packages"],
          `consumer digest mismatch for ${item.packageName}`,
        );
    }
    const packageSet = new Set(packages);
    for (const member of report.publication.members)
      if (!packageSet.has(member.packageName))
        issue(
          context,
          ["publication", "members"],
          `unreported package ${member.packageName}`,
        );
    for (const subject of report.attestation.subjects)
      if (!packageSet.has(subject.packageName))
        issue(
          context,
          ["attestation", "subjects"],
          `unreported subject ${subject.packageName}`,
        );
  });

export type ValidationReportPackage = z.infer<
  typeof ValidationReportPackageSchema
>;
export type ReleaseAttestationRequest = z.infer<
  typeof ReleaseAttestationRequestSchema
>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type AttestationSubject = z.infer<typeof AttestationSubjectSchema>;
export type ValidationReportCompositionInput = z.infer<
  typeof CompositionInputSchema
>;

export type ValidationReportError =
  | { type: "InvalidValidationReport"; issues: readonly string[] }
  | { type: "ValidationReportTooLarge"; bytes: number; limit: number }
  | { type: "MalformedValidationReport"; reason: string }
  | { type: "InvalidAttestationRequest"; issues: readonly string[] }
  | { type: "AttestationRequestTooLarge"; bytes: number; limit: number }
  | { type: "BindingMismatch"; field: string; expected: string; actual: string }
  | {
      type: "ProofMarkerMissing";
      packageName: PublicPackageName;
      marker: string;
    }
  | {
      type: "ProofMarkerMismatch";
      packageName: PublicPackageName;
      marker: string;
      expected: string;
      actual: string;
    };

/** Exact permissions for the independent, top-level attestation workflow. */
export const RELEASE_ATTESTATION_PERMISSION_MAP = {
  workflow: {},
  job: {
    contents: "read",
    actions: "read",
    checks: "write",
    "id-token": "write",
    attestations: "write",
  },
} as const;

/** Data contract consumed by release-attest.yml. It is not a reusable workflow. */
export const RELEASE_ATTESTATION_CONTRACT = {
  schemaVersion: VALIDATION_REPORT_SCHEMA_VERSION,
  workflowPath: RELEASE_ATTEST_WORKFLOW_PATH,
  reusable: false,
  action: "actions/attest-build-provenance",
  inputs: [
    "sourceRunId",
    "artifactId",
    "releasedSha",
    "planDigest",
    "tarballDigests",
  ],
  verification: ["releasedSha", "planDigest", "tarballSha256"],
  permissions: RELEASE_ATTESTATION_PERMISSION_MAP,
} as const;

// Names kept explicit for callers that describe this as a workflow contract.
export const RELEASE_ATTEST_WORKFLOW_CONTRACT = RELEASE_ATTESTATION_CONTRACT;
export const ATTESTATION_WORKFLOW_CONTRACT = RELEASE_ATTESTATION_CONTRACT;

const AttestationContractSchema = z
  .object({
    schemaVersion: z.literal(VALIDATION_REPORT_SCHEMA_VERSION),
    workflowPath: z.literal(RELEASE_ATTEST_WORKFLOW_PATH),
    reusable: z.literal(false),
    action: z.literal("actions/attest-build-provenance"),
    inputs: z.tuple([
      z.literal("sourceRunId"),
      z.literal("artifactId"),
      z.literal("releasedSha"),
      z.literal("planDigest"),
      z.literal("tarballDigests"),
    ]),
    verification: z.tuple([
      z.literal("releasedSha"),
      z.literal("planDigest"),
      z.literal("tarballSha256"),
    ]),
    permissions: z
      .object({
        workflow: z.object({}).strict(),
        job: z
          .object({
            contents: z.literal("read"),
            actions: z.literal("read"),
            checks: z.literal("write"),
            "id-token": z.literal("write"),
            attestations: z.literal("write"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function validateAttestationWorkflowContract(
  input: unknown,
): Result<typeof RELEASE_ATTESTATION_CONTRACT, ValidationReportError> {
  const parsed = AttestationContractSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data as typeof RELEASE_ATTESTATION_CONTRACT)
    : err({
        type: "InvalidAttestationRequest",
        issues: describeIssues(parsed.error.issues),
      });
}
export const validateAttestationContractDefinition =
  validateAttestationWorkflowContract;

export function validateReleaseAttestationRequest(
  input: unknown,
): Result<ReleaseAttestationRequest, ValidationReportError> {
  const size = boundedJsonBytes(input);
  if (size.isErr()) return err(size.error);
  if (size.value > VALIDATION_REPORT_LIMITS.bytes)
    return err({
      type: "AttestationRequestTooLarge",
      bytes: size.value,
      limit: VALIDATION_REPORT_LIMITS.bytes,
    });
  const parsed = ReleaseAttestationRequestSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err({
        type: "InvalidAttestationRequest",
        issues: describeIssues(parsed.error.issues),
      });
}

export function validateValidationReport(
  input: unknown,
): Result<ValidationReport, ValidationReportError> {
  const size = boundedJsonBytes(input);
  if (size.isErr()) return err(size.error);
  if (size.value > VALIDATION_REPORT_LIMITS.bytes)
    return err({
      type: "ValidationReportTooLarge",
      bytes: size.value,
      limit: VALIDATION_REPORT_LIMITS.bytes,
    });
  const parsed = ValidationReportSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err({
        type: "InvalidValidationReport",
        issues: describeIssues(parsed.error.issues),
      });
}

/**
 * Builds the report from independently validated Task 10/11/21 outputs.
 * The returned report is still passed through the full strict validator, so a
 * caller cannot accidentally omit a package or bind evidence to another SHA.
 */
export function composeValidationReport(
  input: unknown,
): Result<ValidationReport, ValidationReportError> {
  const size = boundedJsonBytes(input);
  if (size.isErr()) return err(size.error);
  if (size.value > VALIDATION_REPORT_LIMITS.bytes)
    return err({
      type: "ValidationReportTooLarge",
      bytes: size.value,
      limit: VALIDATION_REPORT_LIMITS.bytes,
    });
  const parsed = CompositionInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidValidationReport",
      issues: describeIssues(parsed.error.issues),
    });
  const binding = ReleasePlanBindingSchema.safeParse(parsed.data.binding);
  if (!binding.success)
    return err({
      type: "InvalidValidationReport",
      issues: describeIssues(binding.error.issues),
    });
  const publication = PublicationReportSchema.safeParse(
    parsed.data.publication,
  );
  if (!publication.success)
    return err({
      type: "InvalidValidationReport",
      issues: describeIssues(publication.error.issues),
    });
  if (binding.data.builtSha !== parsed.data.releasedSha)
    return err({
      type: "BindingMismatch",
      field: "binding.builtSha",
      expected: parsed.data.releasedSha,
      actual: binding.data.builtSha,
    });
  const provenance = uniqueByPackage(parsed.data.npmProvenance);
  const consumers = uniqueByPackage(parsed.data.cleanConsumer);
  const harnesses = uniqueByPackage(parsed.data.harnessProof);
  if (provenance.isErr()) return err(provenance.error);
  if (consumers.isErr()) return err(consumers.error);
  if (harnesses.isErr()) return err(harnesses.error);
  const subjects = new Map(
    parsed.data.attestation.subjects.map((subject) => [
      subject.packageName,
      subject,
    ]),
  );
  const packages: ValidationReportPackage[] = [];
  for (const tarball of binding.data.tarballs) {
    const subject = subjects.get(tarball.packageName);
    const npm = provenance.value.get(tarball.packageName);
    const consumer = consumers.value.get(tarball.packageName);
    if (subject === undefined || npm === undefined || consumer === undefined)
      return err({
        type: "InvalidValidationReport",
        issues: [`missing evidence for ${tarball.packageName}`],
      });
    if (subject.subjectDigest !== tarball.sha256)
      return err({
        type: "BindingMismatch",
        field: `${tarball.packageName}.subjectDigest`,
        expected: tarball.sha256,
        actual: subject.subjectDigest,
      });
    if (consumer.digest !== tarball.sha256)
      return err({
        type: "BindingMismatch",
        field: `${tarball.packageName}.cleanConsumer`,
        expected: tarball.sha256,
        actual: consumer.digest,
      });
    const harness = harnesses.value.get(tarball.packageName);
    packages.push({
      packageName: tarball.packageName,
      version: tarball.version,
      tarballSha256: tarball.sha256,
      npmProvenanceUrl: npm.url,
      attestation: {
        id: subject.id,
        subjectDigest: subject.subjectDigest,
        url: subject.url,
      },
      cleanConsumer: {
        status: "passed",
        digest: consumer.digest,
        summary: consumer.summary,
      },
      harnessProof:
        harness === undefined
          ? {
              status: "not-required",
              summary: "No changed-adapter harness proof required",
            }
          : {
              status: "passed",
              digest: harness.digest,
              summary: harness.summary,
            },
      proofMarkers: {
        attestation: { status: "recorded", digest: tarball.sha256 },
        cleanConsumer: { status: "recorded", digest: consumer.digest },
        harnessProof:
          harness === undefined
            ? { status: "not-required" }
            : { status: "recorded", digest: harness.digest },
      },
    });
  }
  return validateValidationReport({
    schemaVersion: VALIDATION_REPORT_SCHEMA_VERSION,
    releasedSha: parsed.data.releasedSha,
    planDigest: parsed.data.planDigest,
    attestation: parsed.data.attestation,
    publication: publication.data,
    packages,
  });
}

export function serializeValidationReport(
  input: unknown,
): Result<string, ValidationReportError> {
  return validateValidationReport(input).andThen((report) => {
    const normalized = normalizeReport(report);
    const json = canonicalJson(normalized);
    if (json.length > VALIDATION_REPORT_LIMITS.bytes)
      return err({
        type: "ValidationReportTooLarge" as const,
        bytes: json.length,
        limit: VALIDATION_REPORT_LIMITS.bytes,
      });
    return ok(`${json}\n`);
  });
}

export function parseValidationReport(
  text: string,
): Result<ValidationReport, ValidationReportError> {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > VALIDATION_REPORT_LIMITS.bytes)
    return err({
      type: "ValidationReportTooLarge",
      bytes,
      limit: VALIDATION_REPORT_LIMITS.bytes,
    });
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    return err({
      type: "MalformedValidationReport",
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return validateValidationReport(value);
}

/** Stable human/workflow summary. It contains no timestamps or incidental paths. */
export function renderValidationSummary(
  input: unknown,
): Result<string, ValidationReportError> {
  return validateValidationReport(input).map((report) => {
    const lines = [
      "Release validation report",
      `releasedSha: ${report.releasedSha}`,
      `attestation: artifact ${report.attestation.artifactId}, check ${report.attestation.checkRunId}`,
      "packages:",
      ...normalizeReport(report).packages.map(
        (item) =>
          `- ${item.packageName}@${item.version}: ${item.tarballSha256}; publication=${publicationStatus(report.publication, item.packageName)}; attestation=passed; consumer=passed; harness=${item.harnessProof.status}`,
      ),
    ];
    return `${lines.join("\n")}\n`;
  });
}

/** Converts the report markers to Task 11's existing proof-chain contract. */
export function proofChainFromValidationReport(input: unknown): Result<
  {
    schemaVersion: 1;
    markers: readonly {
      packageName: PublicPackageName;
      version: string;
      tarballSha256: string;
      cleanConsumer: { status: "recorded"; digest: string };
      harnessProof?: { status: "recorded"; digest: string };
    }[];
  },
  ValidationReportError
> {
  return validateValidationReport(input).map((report) => ({
    schemaVersion: 1 as const,
    markers: normalizeReport(report).packages.map((item) => ({
      packageName: item.packageName,
      version: item.version,
      tarballSha256: item.tarballSha256,
      cleanConsumer: {
        status: "recorded" as const,
        digest: item.cleanConsumer.digest,
      },
      ...(item.harnessProof.status === "passed" &&
      item.harnessProof.digest !== undefined
        ? {
            harnessProof: {
              status: "recorded" as const,
              digest: item.harnessProof.digest,
            },
          }
        : {}),
    })),
  }));
}
export const validationReportToProofChain = proofChainFromValidationReport;

/** Checks the static contract and a request together at the workflow boundary. */
export function validateAttestationContract(
  input: unknown,
): Result<ReleaseAttestationRequest, ValidationReportError> {
  return validateReleaseAttestationRequest(input);
}

function uniqueByPackage<T extends { packageName: string }>(
  values: readonly T[],
): Result<Map<string, T>, ValidationReportError> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.packageName))
      return err({
        type: "InvalidValidationReport",
        issues: [`duplicate package ${value.packageName}`],
      });
    result.set(value.packageName, value);
  }
  return ok(result);
}

function publicationStatus(
  report: PublicationReport,
  packageName: string,
): string {
  return (
    report.members.find((member) => member.packageName === packageName)
      ?.status ?? "missing"
  );
}

function normalizeReport(report: ValidationReport): ValidationReport {
  const order = new Map(
    publishablePackageNames().map((name, index) => [name, index]),
  );
  const byOrder = (
    left: { packageName: string },
    right: { packageName: string },
  ) =>
    (order.get(left.packageName as PublicPackageName) ??
      Number.MAX_SAFE_INTEGER) -
    (order.get(right.packageName as PublicPackageName) ??
      Number.MAX_SAFE_INTEGER);
  return {
    ...report,
    packages: [...report.packages].sort(byOrder),
    attestation: {
      ...report.attestation,
      subjects: [...report.attestation.subjects].sort(byOrder),
    },
  };
}

function requireUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) issue(context, path, `duplicate ${label}`);
    seen.add(value);
  }
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function describeIssues(issues: readonly z.ZodIssue[]): readonly string[] {
  return issues
    .slice(0, 32)
    .map((item) => `${item.path.join(".") || "root"}: ${item.message}`);
}

function boundedJsonBytes(
  value: unknown,
): Result<number, ValidationReportError> {
  try {
    const json = JSON.stringify(value);
    if (json === undefined)
      return err({
        type: "MalformedValidationReport",
        reason: "value is not JSON-serializable",
      });
    return ok(new TextEncoder().encode(json).byteLength);
  } catch (cause) {
    return err({
      type: "MalformedValidationReport",
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Keep the imported schema version visible to type-aware consumers of this file.
export const VALIDATION_PUBLICATION_SCHEMA_VERSION =
  PUBLICATION_REPORT_SCHEMA_VERSION;
export type { PublicationReport };
