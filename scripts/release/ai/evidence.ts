/**
 * Deterministic, bounded evidence for the changelog agent.
 *
 * The controller supplies already-collected Changesets, GitHub metadata, and
 * text diffs. This module is deliberately a pure assembly boundary: it does
 * not run git, call GitHub, or read a repository. It validates the descriptor
 * shape of that input, confines diffs to the selected package and the private
 * workspaces that package bundles, removes unsafe material, applies per-
 * package section budgets, and hashes only the resulting safe payload.
 *
 * Changeset bodies are the one required section. They are either included in
 * full or the assembly fails with `EvidenceOverflow`. The other sections are
 * advisory context and may be omitted at item boundaries. No omitted bytes
 * are represented in the output, errors, or digest.
 */
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { ChangesetIdentity } from "../changeset-policy.js";
import {
  PRIVATE_SOURCE_DIRECTORIES,
  PRIVATE_SOURCE_IMPACTS,
} from "../changeset-policy.js";
import {
  type PrivatePackageName,
  PUBLIC_PACKAGES,
  type PublicPackageName,
} from "../constants.js";
import { publishablePackageNames } from "../package-policy.js";
import type { ReleasePlan } from "../release-plan.js";

/** Schema version of the evidence payload consumed by the changelog agent. */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Sections that receive independent byte budgets for each selected package. */
export const EVIDENCE_SECTIONS = [
  "changesets",
  "pullRequests",
  "commits",
  "diffs",
] as const;
export type EvidenceSection = (typeof EVIDENCE_SECTIONS)[number];

/** Bounds applied before any input can enter the evidence payload. */
export const EVIDENCE_LIMITS = {
  maxPackages: 4,
  maxItemsPerSection: 512,
  maxChangesetChars: 256 * 1024,
  maxTitleChars: 32 * 1024,
  maxSubjectChars: 32 * 1024,
  maxDiffChars: 512 * 1024,
  maxPathChars: 512,
  maxSectionBudgetBytes: 4 * 1024 * 1024,
  maxTotalBudgetBytes: 16 * 1024 * 1024,
  maxInputBytes: 16 * 1024 * 1024,
  maxDescriptorDepth: 16,
  maxDescriptorNodes: 10_000,
  maxDescriptorKeysPerObject: 1_024,
} as const;

/** Safe defaults for callers that want the standard advisory context bound. */
export const DEFAULT_EVIDENCE_BUDGETS = {
  changesets: 512 * 1024,
  pullRequests: 128 * 1024,
  commits: 128 * 1024,
  diffs: 2 * 1024 * 1024,
} as const satisfies EvidenceBudgets;

/** Byte limits for each per-package section. */
export interface EvidenceBudgets {
  changesets: number;
  pullRequests: number;
  commits: number;
  diffs: number;
}

/** One required Changesets body and its Task 6 identity. */
export interface EvidenceChangeset {
  identity: ChangesetIdentity;
  text: string;
}

/** A pull request fact that is safe to show to the prose agent. */
export interface EvidencePullRequest {
  number: number;
  title: string;
}

/** A commit fact that is safe to show to the prose agent. */
export interface EvidenceCommit {
  subject: string;
}

/** A source diff, retained only when its path is in the package's scope. */
export interface EvidenceDiff {
  path: string;
  patch: string;
}

/** Evidence supplied for one selected public package. */
export interface PackageEvidenceInput {
  packageName: PublicPackageName;
  changesets: readonly EvidenceChangeset[];
  pullRequests: readonly EvidencePullRequest[];
  commits: readonly EvidenceCommit[];
  diffs: readonly EvidenceDiff[];
}

/** The pure input boundary for evidence assembly. */
export interface EvidencePlanContext {
  closure: Pick<ReleasePlan["closure"], "selected">;
  consumed: ReleasePlan["consumed"];
}

export interface EvidenceAssemblyInput {
  selectedPackages: readonly PublicPackageName[];
  packages: readonly PackageEvidenceInput[];
  budgets: EvidenceBudgets;
  /** Optional Task 8 binding used to prove the supplied set is consumed. */
  plan?: EvidencePlanContext;
}

/** One structured record for an advisory section that did not fit. */
export interface EvidenceTruncation {
  section: EvidenceSection;
  includedBytes: number;
  omittedCount: number;
}

/** Safe evidence for one package after filtering and budgeting. */
export interface PackageEvidence {
  packageName: PublicPackageName;
  changesets: readonly EvidenceChangeset[];
  pullRequests: readonly EvidencePullRequest[];
  commits: readonly EvidenceCommit[];
  diffs: readonly EvidenceDiff[];
  truncations: readonly EvidenceTruncation[];
}

/** The digest input. It contains no digest of its own. */
export interface EvidencePayload {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  packages: readonly PackageEvidence[];
}

/** A bounded payload plus its content digest for Task 18's audit record. */
export interface BoundedEvidence extends EvidencePayload {
  digest: EvidenceDigest;
}

/** SHA-256 in the repository's content-addressed form. */
export type EvidenceDigest = `sha256:${string}`;

/** A safe, non-content-bearing schema issue. */
export interface EvidenceSchemaIssue {
  code: string;
  pathDepth: number;
}

/** Errors returned while validating the untrusted descriptor-shaped input. */
export type EvidenceInputError =
  | {
      type: "DescriptorUnsafeInput";
    }
  | {
      type: "InvalidEvidenceInput";
      issues: readonly EvidenceSchemaIssue[];
    }
  | {
      type: "DuplicateSelectedPackage";
      packageName: PublicPackageName;
    }
  | {
      type: "EvidencePackageSetMismatch";
      reason: "missing" | "extra" | "duplicate";
    }
  | {
      type: "DuplicateChangesetIdentity";
      packageName: PublicPackageName;
      index: number;
    }
  | {
      type: "ConflictingChangesetIdentity";
      packageName: PublicPackageName;
      index: number;
    }
  | {
      type: "EvidenceInputTooLarge";
      bytes: number;
      limit: number;
    }
  | {
      type: "EvidenceBudgetTooLarge";
      bytes: number;
      limit: number;
    }
  | {
      type: "EvidencePlanMismatch";
      reason: "selected" | "changesets";
    };

/** A required changeset could not fit without being cut. */
export interface EvidenceOverflow {
  type: "EvidenceOverflow";
  packageName: PublicPackageName;
  section: "changesets";
  includedBytes: number;
  requiredBytes: number;
  budgetBytes: number;
  omittedCount: number;
}

/** A secret-shaped body was found in required evidence. */
export interface EvidenceSecretDetected {
  type: "EvidenceSecretDetected";
  packageName: PublicPackageName;
  section: EvidenceSection;
  index: number;
}

/** A required changeset was not text-safe. */
export interface EvidenceBinaryChangeset {
  type: "EvidenceBinaryChangeset";
  packageName: PublicPackageName;
  index: number;
}

export type EvidenceAssemblyError =
  | EvidenceInputError
  | EvidenceOverflow
  | EvidenceSecretDetected
  | EvidenceBinaryChangeset;

const PublicPackageNameSchema = z.enum(
  publishablePackageNames() as [PublicPackageName, ...PublicPackageName[]],
);
const ChangesetIdentitySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const EvidenceChangesetSchema = z
  .object({
    identity: ChangesetIdentitySchema,
    text: z.string().min(1).max(EVIDENCE_LIMITS.maxChangesetChars),
  })
  .strict();
const EvidencePullRequestSchema = z
  .object({
    number: z.number().int().positive().max(1_000_000_000),
    title: z.string().min(1).max(EVIDENCE_LIMITS.maxTitleChars),
  })
  .strict();
const EvidenceCommitSchema = z
  .object({
    subject: z.string().min(1).max(EVIDENCE_LIMITS.maxSubjectChars),
  })
  .strict();
const EvidenceDiffSchema = z
  .object({
    path: z.string().min(1).max(EVIDENCE_LIMITS.maxPathChars),
    patch: z.string().max(EVIDENCE_LIMITS.maxDiffChars),
  })
  .strict();
const PackageEvidenceInputSchema = z
  .object({
    packageName: PublicPackageNameSchema,
    changesets: z
      .array(EvidenceChangesetSchema)
      .max(EVIDENCE_LIMITS.maxItemsPerSection),
    pullRequests: z
      .array(EvidencePullRequestSchema)
      .max(EVIDENCE_LIMITS.maxItemsPerSection),
    commits: z
      .array(EvidenceCommitSchema)
      .max(EVIDENCE_LIMITS.maxItemsPerSection),
    diffs: z.array(EvidenceDiffSchema).max(EVIDENCE_LIMITS.maxItemsPerSection),
  })
  .strict();
const EvidenceBudgetsSchema = z
  .object({
    changesets: z
      .number()
      .int()
      .nonnegative()
      .max(EVIDENCE_LIMITS.maxSectionBudgetBytes),
    pullRequests: z
      .number()
      .int()
      .nonnegative()
      .max(EVIDENCE_LIMITS.maxSectionBudgetBytes),
    commits: z
      .number()
      .int()
      .nonnegative()
      .max(EVIDENCE_LIMITS.maxSectionBudgetBytes),
    diffs: z
      .number()
      .int()
      .nonnegative()
      .max(EVIDENCE_LIMITS.maxSectionBudgetBytes),
  })
  .strict();
const EvidencePlanContextSchema = z
  .object({
    closure: z
      .object({
        selected: z
          .array(PublicPackageNameSchema)
          .min(1)
          .max(EVIDENCE_LIMITS.maxPackages),
      })
      .strict(),
    consumed: z
      .array(ChangesetIdentitySchema)
      .max(EVIDENCE_LIMITS.maxItemsPerSection),
  })
  .strict();

/** Exported for callers that validate workflow artifacts before assembly. */
export const EvidenceAssemblyInputSchema = z
  .object({
    selectedPackages: z
      .array(PublicPackageNameSchema)
      .min(1)
      .max(EVIDENCE_LIMITS.maxPackages),
    packages: z
      .array(PackageEvidenceInputSchema)
      .min(1)
      .max(EVIDENCE_LIMITS.maxPackages),
    budgets: EvidenceBudgetsSchema,
    plan: EvidencePlanContextSchema.optional(),
  })
  .strict();

/**
 * Validates unknown input without invoking accessors or retaining inherited
 * properties. This is separate from Zod because a hostile descriptor must not
 * be able to run code merely by being parsed.
 */
export function validateEvidenceInput(
  input: unknown,
): Result<EvidenceAssemblyInput, EvidenceInputError> {
  const copied = cloneDescriptorSafe(input);
  if (copied.isErr()) return err(copied.error);

  const parsed = EvidenceAssemblyInputSchema.safeParse(copied.value);
  if (!parsed.success)
    return err({
      type: "InvalidEvidenceInput",
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        pathDepth: issue.path.length,
      })),
    });

  const selected = parsed.data.selectedPackages;
  const selectedSet = new Set<PublicPackageName>();
  for (const packageName of selected) {
    if (selectedSet.has(packageName))
      return err({ type: "DuplicateSelectedPackage", packageName });
    selectedSet.add(packageName);
  }

  const packageNames = parsed.data.packages.map((entry) => entry.packageName);
  const packageSet = new Set<PublicPackageName>();
  for (const packageName of packageNames) {
    if (packageSet.has(packageName))
      return err({ type: "EvidencePackageSetMismatch", reason: "duplicate" });
    packageSet.add(packageName);
  }
  if (
    selected.length !== packageNames.length ||
    selected.some((packageName) => !packageSet.has(packageName))
  )
    return err({ type: "EvidencePackageSetMismatch", reason: "missing" });
  if (packageNames.some((packageName) => !selectedSet.has(packageName)))
    return err({ type: "EvidencePackageSetMismatch", reason: "extra" });

  const planValidation = validatePlanContext(parsed.data);
  if (planValidation.isErr()) return err(planValidation.error);

  const inputBytes = evidenceInputBytes(parsed.data);
  if (inputBytes > EVIDENCE_LIMITS.maxInputBytes)
    return err({
      type: "EvidenceInputTooLarge",
      bytes: inputBytes,
      limit: EVIDENCE_LIMITS.maxInputBytes,
    });

  const budgetBytes = Object.values(parsed.data.budgets).reduce(
    (total, value) => total + value,
    0,
  );
  if (budgetBytes > EVIDENCE_LIMITS.maxTotalBudgetBytes)
    return err({
      type: "EvidenceBudgetTooLarge",
      bytes: budgetBytes,
      limit: EVIDENCE_LIMITS.maxTotalBudgetBytes,
    });

  return ok(parsed.data);
}

/**
 * Assembles safe evidence. Every expected failure is returned as an `Err`;
 * no source text is placed in an error object.
 */
export function assembleEvidence(
  input: EvidenceAssemblyInput,
): Result<BoundedEvidence, EvidenceAssemblyError> {
  const validated = validateEvidenceInput(input);
  if (validated.isErr()) return err(validated.error);

  const packageOrder = publishablePackageNames();
  const packageEntries = [...validated.value.packages].sort(
    (left, right) =>
      packageOrder.indexOf(left.packageName) -
      packageOrder.indexOf(right.packageName),
  );
  const globalChangesets = new Map<string, { digest: string; text: string }>();
  const outputPackages: PackageEvidence[] = [];

  for (const entry of packageEntries) {
    const changesets = prepareChangesets(
      entry.packageName,
      entry.changesets,
      globalChangesets,
    );
    if (changesets.isErr()) return err(changesets.error);

    const pullRequests = preparePullRequests(entry.pullRequests);
    const commits = prepareCommits(entry.commits);
    const diffs = prepareDiffs(entry.packageName, entry.diffs);

    const budget = validated.value.budgets;
    const boundedChangesets = fitSection(
      "changesets",
      changesets.value,
      budget.changesets,
      entry.packageName,
      true,
    );
    if (boundedChangesets.isErr()) return err(boundedChangesets.error);
    const boundedPullRequests = fitSection(
      "pullRequests",
      pullRequests,
      budget.pullRequests,
      entry.packageName,
      false,
    );
    const boundedCommits = fitSection(
      "commits",
      commits,
      budget.commits,
      entry.packageName,
      false,
    );
    const boundedDiffs = fitSection(
      "diffs",
      diffs,
      budget.diffs,
      entry.packageName,
      false,
    );
    if (boundedPullRequests.isErr()) return err(boundedPullRequests.error);
    if (boundedCommits.isErr()) return err(boundedCommits.error);
    if (boundedDiffs.isErr()) return err(boundedDiffs.error);

    outputPackages.push({
      packageName: entry.packageName,
      changesets: boundedChangesets.value.items,
      pullRequests: boundedPullRequests.value.items,
      commits: boundedCommits.value.items,
      diffs: boundedDiffs.value.items,
      truncations: [
        ...boundedChangesets.value.truncations,
        ...boundedPullRequests.value.truncations,
        ...boundedCommits.value.truncations,
        ...boundedDiffs.value.truncations,
      ],
    });
  }

  const payload: EvidencePayload = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    packages: outputPackages,
  };
  return ok({ ...payload, digest: digestEvidence(payload) });
}

/** Alias that makes the bounded nature explicit at call sites. */
export const assembleBoundedEvidence = assembleEvidence;

/** Computes the digest over the canonical, digest-free evidence payload. */
export function digestEvidence(
  payload: EvidencePayload | BoundedEvidence,
): EvidenceDigest {
  const digestFreePayload: EvidencePayload = {
    schemaVersion: payload.schemaVersion,
    packages: payload.packages,
  };
  const digest = Bun.CryptoHasher.hash(
    "sha256",
    canonicalJson(digestFreePayload),
    "hex",
  );
  return `sha256:${digest}`;
}

/**
 * Returns the exact UTF-8 byte length used by the section budget accounting.
 * Item bytes are canonical JSON bytes, without separators or a trailing line.
 */
export function evidenceItemBytes(item: EvidenceSectionItem): number {
  return utf8ByteLength(canonicalJson(item));
}

export type EvidenceSectionItem =
  | EvidenceChangeset
  | EvidencePullRequest
  | EvidenceCommit
  | EvidenceDiff;

interface FitSectionResult<T extends EvidenceSectionItem> {
  items: readonly T[];
  truncations: readonly EvidenceTruncation[];
}

function fitSection<T extends EvidenceSectionItem>(
  section: EvidenceSection,
  items: readonly T[],
  budgetBytes: number,
  packageName: PublicPackageName,
  required: boolean,
): Result<FitSectionResult<T>, EvidenceOverflow> {
  let includedBytes = 0;
  let includedCount = 0;
  for (const item of items) {
    const itemBytes = evidenceItemBytes(item);
    if (itemBytes > budgetBytes - includedBytes) {
      const omittedCount = items.length - includedCount;
      if (required)
        return err({
          type: "EvidenceOverflow",
          packageName,
          section: "changesets",
          includedBytes,
          requiredBytes: itemBytes,
          budgetBytes,
          omittedCount,
        });
      return ok({
        items: items.slice(0, includedCount),
        truncations: [{ section, includedBytes, omittedCount }],
      });
    }
    includedBytes += itemBytes;
    includedCount += 1;
  }
  return ok({ items, truncations: [] });
}

function prepareChangesets(
  packageName: PublicPackageName,
  input: readonly EvidenceChangeset[],
  globalChangesets: Map<string, { digest: string; text: string }>,
): Result<readonly EvidenceChangeset[], EvidenceAssemblyError> {
  const unique = new Map<string, EvidenceChangeset>();
  for (const [index, changeset] of input.entries()) {
    if (looksSecretShaped(changeset.text))
      return err({
        type: "EvidenceSecretDetected",
        packageName,
        section: "changesets",
        index,
      });
    if (looksBinaryText(changeset.text))
      return err({ type: "EvidenceBinaryChangeset", packageName, index });

    const key = `${changeset.identity.id}\u0000${changeset.identity.sourceDigest}`;
    const previous = unique.get(key);
    if (previous !== undefined) {
      if (previous.text !== changeset.text)
        return err({
          type: "ConflictingChangesetIdentity",
          packageName,
          index,
        });
      return err({
        type: "DuplicateChangesetIdentity",
        packageName,
        index,
      });
    }
    const byId = globalChangesets.get(changeset.identity.id);
    if (
      byId !== undefined &&
      (byId.digest !== changeset.identity.sourceDigest ||
        byId.text !== changeset.text)
    )
      return err({
        type: "ConflictingChangesetIdentity",
        packageName,
        index,
      });
    globalChangesets.set(changeset.identity.id, {
      digest: changeset.identity.sourceDigest,
      text: changeset.text,
    });
    unique.set(key, changeset);
  }
  return ok(
    [...unique.values()].sort((left, right) =>
      compareStrings(changesetSortKey(left), changesetSortKey(right)),
    ),
  );
}

function preparePullRequests(
  input: readonly EvidencePullRequest[],
): readonly EvidencePullRequest[] {
  const unique = new Map<string, EvidencePullRequest>();
  for (const pullRequest of input) {
    if (looksSecretShaped(pullRequest.title)) continue;
    const key = `${pullRequest.number}\u0000${pullRequest.title}`;
    unique.set(key, pullRequest);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.number - right.number || compareStrings(left.title, right.title),
  );
}

function prepareCommits(
  input: readonly EvidenceCommit[],
): readonly EvidenceCommit[] {
  const unique = new Map<string, EvidenceCommit>();
  for (const commit of input) {
    if (looksSecretShaped(commit.subject)) continue;
    unique.set(commit.subject, commit);
  }
  return [...unique.values()].sort((left, right) =>
    compareStrings(left.subject, right.subject),
  );
}

function prepareDiffs(
  packageName: PublicPackageName,
  input: readonly EvidenceDiff[],
): readonly EvidenceDiff[] {
  const unique = new Map<string, EvidenceDiff>();
  for (const diff of input) {
    if (!isAllowedDiffPath(packageName, diff.path)) continue;
    if (looksBinaryPathOrText(diff.path, diff.patch)) continue;
    if (looksSecretShaped(diff.patch)) continue;
    const key = `${diff.path}\u0000${diff.patch}`;
    unique.set(key, diff);
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.patch, right.patch),
  );
}

function isAllowedDiffPath(
  packageName: PublicPackageName,
  path: string,
): boolean {
  if (!isCanonicalRelativePath(path)) return false;
  const segments = path.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = lowerSegments[lowerSegments.length - 1] ?? "";

  if (basename === "bun.lock" || basename === "bun.lockb") return false;
  if (basename.startsWith(".env")) return false;
  if (lowerSegments.some((segment) => segment.startsWith("dist"))) return false;
  if (
    /\.d\.(?:ts|mts|cts)$/i.test(basename) ||
    /(?:^|[._-])generated(?:[._-]|$)/i.test(basename) ||
    /(?:^|[._-])gen(?:[._-]|$)/i.test(basename)
  )
    return false;
  if (
    lowerSegments.some((segment) =>
      ["node_modules", ".git", "coverage"].includes(segment),
    )
  )
    return false;
  if (BINARY_EXTENSIONS.has(extensionOf(basename))) return false;

  const allowedRoots = allowedDiffRoots(packageName);
  return allowedRoots.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function allowedDiffRoots(packageName: PublicPackageName): readonly string[] {
  const roots: string[] = [PUBLIC_PACKAGES[packageName].directory];
  for (const privatePackage of Object.keys(
    PRIVATE_SOURCE_DIRECTORIES,
  ) as PrivatePackageName[]) {
    const impactedPackages = PRIVATE_SOURCE_IMPACTS[
      privatePackage
    ] as readonly PublicPackageName[];
    if (impactedPackages.includes(packageName))
      roots.push(PRIVATE_SOURCE_DIRECTORIES[privatePackage]);
  }
  return roots.sort(compareStrings);
}

function isCanonicalRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > EVIDENCE_LIMITS.maxPathChars)
    return false;
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.includes("\u0000")
  )
    return false;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

const BINARY_EXTENSIONS = new Set([
  "bmp",
  "class",
  "dll",
  "dylib",
  "eot",
  "exe",
  "gif",
  "gz",
  "ico",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "otf",
  "pdf",
  "so",
  "tar",
  "tgz",
  "ttf",
  "wasm",
  "webp",
  "woff",
  "woff2",
  "zip",
]);

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

function looksBinaryPathOrText(path: string, text: string): boolean {
  if (BINARY_EXTENSIONS.has(extensionOf(path))) return true;
  if (/^\s*Binary files?\b/im.test(text)) return true;
  return looksBinaryText(text);
}

function looksBinaryText(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let controls = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 7 || (code > 14 && code < 32) || code === 127) && code !== 9)
      controls += 1;
  }
  return text.length > 0 && controls / text.length > 0.01;
}

/**
 * Conservative secret-shape detection. It detects credential syntax, not
 * ordinary words such as "token" in prose. The matched bytes are never
 * returned or interpolated into an error.
 */
const SECRET_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i,
  /\b(?:ghp|github_pat|gho|ghs|ghr)_[A-Za-z0-9_]{10,}\b/,
  /\b(?:sk|rk|pk)-live-[A-Za-z0-9]{8,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\b(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|credential|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+._=-]{8,}/i,
];

function looksSecretShaped(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function changesetSortKey(changeset: EvidenceChangeset): string {
  return `${changeset.identity.id}\u0000${changeset.identity.sourceDigest}\u0000${changeset.text}`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validatePlanContext(
  input: EvidenceAssemblyInput,
): Result<void, EvidenceInputError> {
  if (input.plan === undefined) return ok(undefined);

  const planSelected = new Set(input.plan.closure.selected);
  if (
    planSelected.size !== input.selectedPackages.length ||
    input.selectedPackages.some((packageName) => !planSelected.has(packageName))
  )
    return err({ type: "EvidencePlanMismatch", reason: "selected" });

  const planIdentities = new Map<string, string>();
  for (const identity of input.plan.consumed) {
    const previousDigest = planIdentities.get(identity.id);
    if (
      previousDigest !== undefined &&
      previousDigest !== identity.sourceDigest
    )
      return err({ type: "EvidencePlanMismatch", reason: "changesets" });
    planIdentities.set(identity.id, identity.sourceDigest);
  }

  const evidenceIdentities = new Map<string, string>();
  for (const entry of input.packages) {
    for (const changeset of entry.changesets) {
      const expectedDigest = planIdentities.get(changeset.identity.id);
      if (expectedDigest !== changeset.identity.sourceDigest)
        return err({ type: "EvidencePlanMismatch", reason: "changesets" });
      evidenceIdentities.set(
        changeset.identity.id,
        changeset.identity.sourceDigest,
      );
    }
  }
  if (
    input.plan.consumed.some(
      (identity) =>
        evidenceIdentities.get(identity.id) !== identity.sourceDigest,
    )
  )
    return err({ type: "EvidencePlanMismatch", reason: "changesets" });
  return ok(undefined);
}

function evidenceInputBytes(input: EvidenceAssemblyInput): number {
  let bytes = 0;
  for (const packageName of input.selectedPackages)
    bytes += utf8ByteLength(packageName);
  if (input.plan !== undefined) {
    for (const packageName of input.plan.closure.selected)
      bytes += utf8ByteLength(packageName);
    for (const identity of input.plan.consumed) {
      bytes += utf8ByteLength(identity.id);
      bytes += utf8ByteLength(identity.sourceDigest);
    }
  }
  for (const entry of input.packages) {
    bytes += utf8ByteLength(entry.packageName);
    for (const changeset of entry.changesets) {
      bytes += utf8ByteLength(changeset.identity.id);
      bytes += utf8ByteLength(changeset.identity.sourceDigest);
      bytes += utf8ByteLength(changeset.text);
    }
    for (const pullRequest of entry.pullRequests)
      bytes += utf8ByteLength(pullRequest.title);
    for (const commit of entry.commits) bytes += utf8ByteLength(commit.subject);
    for (const diff of entry.diffs) {
      bytes += utf8ByteLength(diff.path);
      bytes += utf8ByteLength(diff.patch);
    }
  }
  return bytes;
}

/** Canonical JSON with recursively sorted object keys and stable arrays. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

type DescriptorCopyError =
  | { type: "DescriptorUnsafeInput" }
  | {
      type: "EvidenceInputTooLarge";
      bytes: number;
      limit: number;
    };

function cloneDescriptorSafe(
  value: unknown,
): Result<unknown, DescriptorCopyError> {
  return cloneDescriptorValue(value, 0, new Set<object>(), {
    value: 0,
    bytes: 0,
  });
}

function cloneDescriptorValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  nodes: { value: number; bytes: number },
): Result<unknown, DescriptorCopyError> {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      nodes.bytes += utf8ByteLength(value);
      if (nodes.bytes > EVIDENCE_LIMITS.maxInputBytes)
        return err({
          type: "EvidenceInputTooLarge",
          bytes: nodes.bytes,
          limit: EVIDENCE_LIMITS.maxInputBytes,
        });
    }
    return ok(value);
  }
  if (depth > EVIDENCE_LIMITS.maxDescriptorDepth)
    return err({ type: "DescriptorUnsafeInput" });
  nodes.value += 1;
  if (nodes.value > EVIDENCE_LIMITS.maxDescriptorNodes)
    return err({ type: "DescriptorUnsafeInput" });
  if (seen.has(value)) return err({ type: "DescriptorUnsafeInput" });
  seen.add(value);

  const snapshot = Result.fromThrowable(
    () => ({
      prototype: Object.getPrototypeOf(value),
      descriptors: Object.getOwnPropertyDescriptors(value),
    }),
    () => ({ type: "DescriptorUnsafeInput" as const }),
  )();
  if (snapshot.isErr()) return err(snapshot.error);
  const isArray = Array.isArray(value);
  if (
    (isArray && snapshot.value.prototype !== Array.prototype) ||
    (!isArray &&
      snapshot.value.prototype !== Object.prototype &&
      snapshot.value.prototype !== null)
  )
    return err({ type: "DescriptorUnsafeInput" });

  const keys = Object.keys(snapshot.value.descriptors);
  if (keys.length > EVIDENCE_LIMITS.maxDescriptorKeysPerObject)
    return err({ type: "DescriptorUnsafeInput" });

  if (isArray) {
    const lengthDescriptor = snapshot.value.descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value > EVIDENCE_LIMITS.maxItemsPerSection
    )
      return err({ type: "DescriptorUnsafeInput" });
    const output: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = snapshot.value.descriptors[String(index)];
      if (descriptor === undefined) continue;
      if (!descriptor.enumerable || !("value" in descriptor))
        return err({ type: "DescriptorUnsafeInput" });
      const child = cloneDescriptorValue(
        descriptor.value,
        depth + 1,
        seen,
        nodes,
      );
      if (child.isErr()) return err(child.error);
      output[index] = child.value;
    }
    seen.delete(value);
    return ok(output);
  }

  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = snapshot.value.descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable) continue;
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      !("value" in descriptor)
    )
      return err({ type: "DescriptorUnsafeInput" });
    const child = cloneDescriptorValue(
      descriptor.value,
      depth + 1,
      seen,
      nodes,
    );
    if (child.isErr()) return err(child.error);
    output[key] = child.value;
  }
  seen.delete(value);
  return ok(output);
}
