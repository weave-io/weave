/**
 * Typed `submit_changelog` payload for the headless changelog agent.
 *
 * The model writes prose only. Identities, refs, and section names are
 * validated here against Task 7's changelog contract before the controller
 * renders a document.
 */
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  CHANGELOG_LIMITS,
  CHANGELOG_SECTIONS,
  type ChangelogEntry,
  type ChangelogEvidence,
  type ChangelogFormatError,
  type ChangelogRef,
  ChangelogRefSchema,
  type ChangelogSection,
  type ChangelogSectionName,
  type ChangelogVersion,
  renderChangelog,
} from "../changelog-format.js";
import type { ChangesetIdentity } from "../changeset-policy.js";
import type { PublicPackageName } from "../constants.js";
import { LedgerBlockSchema } from "../consumption-ledger.js";
import { publishablePackageNames } from "../package-policy.js";

/** The only tool the changelog session may expose. */
export const SUBMIT_CHANGELOG_TOOL = "submit_changelog" as const;

/** Bounds for an untrusted model submission. */
export const CHANGELOG_SUBMISSION_LIMITS = {
  packages: 4,
  jsonBytes: 256 * 1024,
  issues: 32,
  issuePathChars: 160,
  issueCodeChars: 64,
} as const;

const PublicPackageNameSchema = z.enum(
  publishablePackageNames() as [PublicPackageName, ...PublicPackageName[]],
);
const ChangesetIdentitySchema = LedgerBlockSchema.shape.changesets.element;

export const ChangelogSubmissionEntrySchema = z
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

export const ChangelogSubmissionSectionSchema = z
  .object({
    name: z.enum(CHANGELOG_SECTIONS),
    entries: z
      .array(ChangelogSubmissionEntrySchema)
      .min(1)
      .max(CHANGELOG_LIMITS.sectionEntries),
  })
  .strict();

export const ChangelogSubmissionPackageSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    sections: z
      .array(ChangelogSubmissionSectionSchema)
      .min(1)
      .max(CHANGELOG_SECTIONS.length),
  })
  .strict();

/** Per-package sections → entries with complete source identities. */
export const ChangelogSubmissionSchema = z
  .object({
    packages: z
      .array(ChangelogSubmissionPackageSchema)
      .min(1)
      .max(CHANGELOG_SUBMISSION_LIMITS.packages),
  })
  .strict();

export type ChangelogSubmissionEntry = z.infer<
  typeof ChangelogSubmissionEntrySchema
>;
export type ChangelogSubmissionSection = z.infer<
  typeof ChangelogSubmissionSectionSchema
>;
export type ChangelogSubmissionPackage = z.infer<
  typeof ChangelogSubmissionPackageSchema
>;
export type ChangelogSubmission = z.infer<typeof ChangelogSubmissionSchema>;

/** One consumed identity the submission must cover. */
export interface SubmissionIdentityRequirement {
  packageName: PublicPackageName;
  identity: ChangesetIdentity;
}

/** A compact, non-content-bearing validation issue. */
export interface ChangelogSubmissionIssue {
  code: string;
  path: string;
}

export type ChangelogSubmissionError =
  | {
      type: "InvalidChangelogSubmission";
      issues: readonly ChangelogSubmissionIssue[];
    }
  | {
      type: "ChangelogSubmissionTooLarge";
      bytes: number;
      limit: number;
    };

export interface SubmissionValidationContext {
  required: readonly SubmissionIdentityRequirement[];
  refs: ChangelogEvidence;
  versions: ReadonlyMap<PublicPackageName, string>;
}

export interface ValidatedChangelogSubmission {
  submission: ChangelogSubmission;
  versions: readonly ChangelogVersionDocument[];
}

export interface ChangelogVersionDocument {
  packageName: PublicPackageName;
  version: ChangelogVersion;
}

/**
 * Parses and checks an untrusted tool payload.
 *
 * Every required identity must appear at least once, refs must be supplied,
 * and the resulting model must be renderable by Task 7.
 */
export function validateChangelogSubmission(
  input: unknown,
  context: SubmissionValidationContext,
): Result<ValidatedChangelogSubmission, ChangelogSubmissionError> {
  const cloned = cloneSubmission(input);
  if (cloned.isErr()) return err(cloned.error);

  const parsed = ChangelogSubmissionSchema.safeParse(cloned.value);
  if (!parsed.success)
    return err({
      type: "InvalidChangelogSubmission",
      issues: boundIssues(
        parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join("."),
        })),
      ),
    });

  const issues: ChangelogSubmissionIssue[] = [];
  const seenPackages = new Set<PublicPackageName>();
  for (const [packageIndex, entry] of parsed.data.packages.entries()) {
    if (seenPackages.has(entry.packageName))
      issues.push({
        code: "duplicate_package",
        path: `packages.${packageIndex}.packageName`,
      });
    seenPackages.add(entry.packageName);
    if (!context.versions.has(entry.packageName))
      issues.push({
        code: "foreign_package",
        path: `packages.${packageIndex}.packageName`,
      });
    collectSectionIssues(entry, packageIndex, issues);
    collectIdentityIssues(entry, packageIndex, context, issues);
    collectRefIssues(entry, packageIndex, context.refs, issues);
  }
  for (const requirement of context.required) {
    if (!seenPackages.has(requirement.packageName))
      issues.push({
        code: "missing_package",
        path: requirement.packageName,
      });
    else if (
      !packageClaims(parsed.data, requirement.packageName, requirement.identity)
    )
      issues.push({
        code: "missing_identity",
        path: `${requirement.packageName}.${requirement.identity.id}`,
      });
  }
  if (issues.length > 0)
    return err({
      type: "InvalidChangelogSubmission",
      issues: boundIssues(issues),
    });

  const versions: ChangelogVersionDocument[] = [];
  for (const entry of parsed.data.packages) {
    const version = context.versions.get(entry.packageName);
    if (version === undefined) continue;
    const model: ChangelogVersion = {
      version,
      sections: entry.sections.map(toSection),
    };
    const rendered = renderChangelog(
      { packageName: entry.packageName, versions: [model] },
      context.refs,
    );
    if (rendered.isErr()) {
      issues.push(issueFromFormatError(rendered.error, entry.packageName));
      continue;
    }
    versions.push({ packageName: entry.packageName, version: model });
  }
  if (issues.length > 0)
    return err({
      type: "InvalidChangelogSubmission",
      issues: boundIssues(issues),
    });
  return ok({ submission: parsed.data, versions });
}

function toSection(section: ChangelogSubmissionSection): ChangelogSection {
  return {
    name: section.name as ChangelogSectionName,
    entries: section.entries.map(toEntry),
  };
}

function toEntry(entry: ChangelogSubmissionEntry): ChangelogEntry {
  return entry.refs === undefined
    ? { prose: entry.prose, sourceChangesets: entry.sourceChangesets }
    : {
        prose: entry.prose,
        sourceChangesets: entry.sourceChangesets,
        refs: entry.refs,
      };
}

function collectSectionIssues(
  entry: ChangelogSubmissionPackage,
  packageIndex: number,
  issues: ChangelogSubmissionIssue[],
): void {
  const seen = new Set<string>();
  for (const [sectionIndex, section] of entry.sections.entries()) {
    if (seen.has(section.name))
      issues.push({
        code: "duplicate_section",
        path: `packages.${packageIndex}.sections.${sectionIndex}.name`,
      });
    seen.add(section.name);
  }
}

function collectIdentityIssues(
  entry: ChangelogSubmissionPackage,
  packageIndex: number,
  context: SubmissionValidationContext,
  issues: ChangelogSubmissionIssue[],
): void {
  const allowed = new Map<string, string>();
  for (const requirement of context.required) {
    if (requirement.packageName !== entry.packageName) continue;
    allowed.set(requirement.identity.id, requirement.identity.sourceDigest);
  }
  const claimed = new Set<string>();
  for (const [sectionIndex, section] of entry.sections.entries()) {
    for (const [entryIndex, item] of section.entries.entries()) {
      for (const [identityIndex, identity] of item.sourceChangesets.entries()) {
        const path =
          `packages.${packageIndex}.sections.${sectionIndex}` +
          `.entries.${entryIndex}.sourceChangesets.${identityIndex}`;
        const expected = allowed.get(identity.id);
        if (expected === undefined || expected !== identity.sourceDigest) {
          issues.push({ code: "foreign_identity", path });
          continue;
        }
        if (claimed.has(identity.id)) {
          issues.push({ code: "duplicate_identity", path });
          continue;
        }
        claimed.add(identity.id);
      }
    }
  }
}

function collectRefIssues(
  entry: ChangelogSubmissionPackage,
  packageIndex: number,
  refs: ChangelogEvidence,
  issues: ChangelogSubmissionIssue[],
): void {
  const allowed = new Set<string>();
  for (const number of refs.pullRequests ?? [])
    allowed.add(`pull-request:${number}`);
  for (const commit of refs.commits ?? []) allowed.add(`commit:${commit}`);
  for (const [sectionIndex, section] of entry.sections.entries()) {
    for (const [entryIndex, item] of section.entries.entries()) {
      const seen = new Set<string>();
      for (const [refIndex, ref] of (item.refs ?? []).entries()) {
        const key = refKey(ref);
        const path =
          `packages.${packageIndex}.sections.${sectionIndex}` +
          `.entries.${entryIndex}.refs.${refIndex}`;
        if (seen.has(key)) {
          issues.push({ code: "duplicate_ref", path });
          continue;
        }
        seen.add(key);
        if (!allowed.has(key)) issues.push({ code: "unsupplied_ref", path });
      }
    }
  }
}

function packageClaims(
  submission: ChangelogSubmission,
  packageName: PublicPackageName,
  identity: ChangesetIdentity,
): boolean {
  const entry = submission.packages.find(
    (item) => item.packageName === packageName,
  );
  if (entry === undefined) return false;
  return entry.sections.some((section) =>
    section.entries.some((item) =>
      item.sourceChangesets.some(
        (candidate) =>
          candidate.id === identity.id &&
          candidate.sourceDigest === identity.sourceDigest,
      ),
    ),
  );
}

function refKey(ref: ChangelogRef): string {
  if (ref.kind === "pull-request") return `pull-request:${ref.number}`;
  return `commit:${ref.commit}`;
}

function issueFromFormatError(
  error: ChangelogFormatError,
  packageName: PublicPackageName,
): ChangelogSubmissionIssue {
  return {
    code: error.type,
    path: packageName,
  };
}

function boundIssues(
  issues: readonly ChangelogSubmissionIssue[],
): readonly ChangelogSubmissionIssue[] {
  return issues.slice(0, CHANGELOG_SUBMISSION_LIMITS.issues).map((issue) => ({
    code: boundText(issue.code, CHANGELOG_SUBMISSION_LIMITS.issueCodeChars),
    path: boundText(issue.path, CHANGELOG_SUBMISSION_LIMITS.issuePathChars),
  }));
}

function boundText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

function cloneSubmission(
  input: unknown,
): Result<unknown, ChangelogSubmissionError> {
  const encoded = Result.fromThrowable(
    () => JSON.stringify(input),
    () => ({
      type: "InvalidChangelogSubmission" as const,
      issues: [{ code: "unserializable", path: "" }],
    }),
  )();
  if (encoded.isErr()) return err(encoded.error);
  const bytes = utf8ByteLength(encoded.value);
  if (bytes > CHANGELOG_SUBMISSION_LIMITS.jsonBytes)
    return err({
      type: "ChangelogSubmissionTooLarge",
      bytes,
      limit: CHANGELOG_SUBMISSION_LIMITS.jsonBytes,
    });
  return Result.fromThrowable(
    () => JSON.parse(encoded.value) as unknown,
    () => ({
      type: "InvalidChangelogSubmission" as const,
      issues: [{ code: "unparseable", path: "" }],
    }),
  )();
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
