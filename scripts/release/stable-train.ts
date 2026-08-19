import { err, ok, type Result } from "neverthrow";
import type {
  ChangesetBump,
  ChangesetPartition,
  ParsedChangeset,
} from "./changeset-policy.js";
import type { Clock } from "./clock.js";
import type { PublicPackageName } from "./constants.js";
import { PUBLIC_PACKAGE_NAMES, STABLE_TRAIN_TRANSITIONS } from "./constants.js";
import {
  canonicalizeJson,
  digestJson,
  type JsonCanonicalizationError,
  type JsonValue,
  validateJsonValue,
} from "./json.js";
import { type StableTrainRecord, StableTrainRecordSchema } from "./model.js";

export type StableTrainError =
  | { type: "InvalidTrainRecord"; issues: readonly string[] }
  | {
      type: "InvalidTransition";
      from: StableTrainRecord["state"];
      to: StableTrainRecord["state"];
    }
  | { type: "DigestMismatch"; expected: string; actual: string }
  | { type: "ExpiredTrain"; expiresAt: string; now: string }
  | { type: "InvalidCut"; reason: string }
  | { type: "UnmergedCommit"; sha: string }
  | { type: "NonGreenCommit"; sha: string }
  | { type: "ReservedVersion"; packageName: string; version: string }
  | { type: "CanonicalJsonFailed"; reason: string };

export interface StableTrainContent {
  schemaVersion: 1;
  trainRef: string;
  subjectSha: string;
  cutAt: string;
  expiresAt: string;
  state: StableTrainRecord["state"];
  packages: readonly string[];
  versions: Readonly<Record<string, string>>;
  artifactManifestDigest?: string;
  consumedChangesets?: readonly {
    path: string;
    preimageDigest: string;
  }[];
  metadataWrites?: readonly StableMetadataWrite[];
  artifactIds?: readonly number[];
}

export interface StableCutInput {
  mainHeadSha: string;
  serverCutAt: Date;
  partition: ChangesetPartition;
  changesets: readonly ParsedChangeset[];
  packageVersions: Readonly<Record<PublicPackageName, string>>;
  changesetContents: Readonly<Record<string, string>>;
  /** Versions consumed by a partial publish; a fresh cut must never reuse one. */
  reservedVersions?: Readonly<Record<string, readonly string[]>>;
}
export interface StableFixInput {
  record: StableTrainRecord;
  commits: readonly { sha: string; green: boolean; mergedToMain: boolean }[];
  expectedHeadSha: string;
  clock: Clock;
}
export interface StableWorktreePlan {
  consumedChangesets: readonly { path: string; preimageDigest: string }[];
  metadataWrites: readonly {
    path: string;
    contentsDigest: string;
    contents: string;
  }[];
  preservedPaths: readonly string[];
}
export interface StableCutPlan {
  record: StableTrainRecord;
  worktree: StableWorktreePlan;
  expectedHeadSha: string;
}
export interface StableFixPlan {
  record: StableTrainRecord;
  expectedHeadSha: string;
  commits: readonly string[];
}

type StableTrainDigestInput =
  | StableTrainContent
  | StableTrainRecord
  | JsonValue;

/** Content-addressed evidence written after a partial npm publish. */
export interface PartialPublishRecoveryMetadata {
  schemaVersion: 1;
  trainDigest: string;
  subjectSha: string;
  usedVersions: Readonly<Record<string, string>>;
  recovery: "fresh-main-cut";
  metadataDigest: string;
}

function canonicalJsonError(
  error: JsonCanonicalizationError,
): StableTrainError {
  return { type: "CanonicalJsonFailed", reason: error.reason };
}

export function canonicalTrainJson(
  record: StableTrainDigestInput,
): Result<string, StableTrainError> {
  return validateJsonValue(record)
    .andThen((value) => canonicalizeJson(value))
    .mapErr(canonicalJsonError);
}

export function trainRecordDigest(
  record: StableTrainDigestInput,
): Result<string, StableTrainError> {
  return validateJsonValue(record)
    .andThen((value) => digestJson(value))
    .mapErr(canonicalJsonError);
}

export function partialPublishRecoveryMetadata(
  record: StableTrainRecord,
): Result<PartialPublishRecoveryMetadata, StableTrainError> {
  const content = {
    schemaVersion: 1 as const,
    trainDigest: record.recordDigest,
    subjectSha: record.subjectSha,
    usedVersions: record.versions,
    recovery: "fresh-main-cut" as const,
  };
  return digestJson(content)
    .mapErr(canonicalJsonError)
    .map((metadataDigest) => ({
      ...content,
      metadataDigest,
    }));
}

/** Rejects stale artifact identity after a rebuild, rerun, or fix. */
export function assertCurrentArtifactIdentity(
  record: StableTrainRecord,
  artifactManifestDigest: string,
  artifactIds: readonly number[],
): Result<void, StableTrainError> {
  if (
    record.artifactManifestDigest !== artifactManifestDigest ||
    JSON.stringify(record.artifactIds ?? []) !== JSON.stringify(artifactIds)
  )
    return err({
      type: "InvalidCut",
      reason:
        "artifact identity is stale; rebuild and bind the current attempt",
    });
  return ok();
}

type StableTrainInput = Parameters<typeof StableTrainRecordSchema.safeParse>[0];

export function validateStableTrain(
  record: StableTrainInput,
): Result<StableTrainRecord, StableTrainError> {
  const parsed = StableTrainRecordSchema.safeParse(record);
  if (!parsed.success)
    return err({
      type: "InvalidTrainRecord",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  const { recordDigest, ...content } = parsed.data;
  const actual = trainRecordDigest(content);
  if (actual.isErr()) return err(actual.error);
  if (recordDigest !== actual.value)
    return err({
      type: "DigestMismatch",
      expected: actual.value,
      actual: recordDigest,
    });
  return ok(parsed.data);
}

export function transitionStableTrain(
  record: StableTrainRecord,
  state: StableTrainRecord["state"],
): Result<StableTrainRecord, StableTrainError> {
  const allowed = STABLE_TRAIN_TRANSITIONS[record.state];
  if (!allowed.some((candidate) => candidate === state))
    return err({ type: "InvalidTransition", from: record.state, to: state });
  const { recordDigest: _recordDigest, ...content } = record;
  const next = { ...content, state };
  return trainRecordDigest(next).map((recordDigest) => ({
    ...next,
    recordDigest,
  }));
}

/**
 * Advances a cut record through the build and binding gates. Artifact identity
 * is introduced exactly once, on the bound record, after Actions assigned its
 * immutable artifact IDs.
 */
export function bindStableTrain(
  record: StableTrainRecord,
  artifactManifestDigest: string,
  artifactIds: readonly number[],
): Result<StableTrainRecord, StableTrainError> {
  const validated = validateStableTrain(record);
  if (validated.isErr()) return err(validated.error);
  if (record.state !== "prepared" && record.state !== "built")
    return err({ type: "InvalidTransition", from: record.state, to: "bound" });
  if (
    record.artifactManifestDigest !== undefined ||
    record.artifactIds !== undefined
  )
    return err({
      type: "InvalidCut",
      reason: "artifact identity may only be set while binding a fresh train",
    });
  const built =
    record.state === "prepared"
      ? transitionStableTrain(record, "built")
      : ok(record);
  if (built.isErr()) return err(built.error);
  const bound = transitionStableTrain(built.value, "bound");
  if (bound.isErr()) return err(bound.error);
  const { recordDigest: _recordDigest, ...content } = bound.value;
  const next = {
    ...content,
    artifactManifestDigest,
    artifactIds: [...artifactIds],
  };
  return trainRecordDigest(next).andThen((recordDigest) =>
    validateStableTrain({
      ...next,
      recordDigest,
    }),
  );
}

/** Expiry is exclusive: a train is unusable at precisely expiresAt. */
export function guardTrainExpiry(
  record: StableTrainRecord,
  clock: Clock,
): Result<void, StableTrainError> {
  const now = clock.now();
  if (now.getTime() >= Date.parse(record.expiresAt))
    return err({
      type: "ExpiredTrain",
      expiresAt: record.expiresAt,
      now: now.toISOString(),
    });
  return ok();
}

/** Creates a content-addressed stable train from the server's main ref and clock. */
export function planStableCut(
  input: StableCutInput,
): Result<StableCutPlan, StableTrainError> {
  if (!/^[0-9a-f]{40}$/.test(input.mainHeadSha))
    return err({ type: "InvalidCut", reason: "main head must be a full SHA" });
  const stable = new Set(input.partition.stableFiles);
  const selected = input.changesets.filter((changeset) =>
    stable.has(changeset.path),
  );
  if (selected.length !== input.partition.stableFiles.length)
    return err({
      type: "InvalidCut",
      reason: "partition paths must resolve to changesets",
    });
  const versions = deriveVersions(
    selected,
    input.packageVersions,
    input.reservedVersions ?? {},
  );
  if (Object.keys(versions).length === 0)
    return err({ type: "InvalidCut", reason: "no stable changesets" });
  const cutAt = input.serverCutAt.toISOString();
  const expiresAt = new Date(
    input.serverCutAt.getTime() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const consumedChangesets = input.partition.stableFiles.map((path) => ({
    path,
    preimageDigest: digest(input.changesetContents[path] ?? ""),
  }));
  const metadataWrites = Object.entries(versions).map(([name, version]) =>
    metadataWrite(name, version),
  );
  const content: StableTrainContent = {
    schemaVersion: 1,
    trainRef: `release/${cutAt.slice(0, 10).replaceAll("-", "")}-${input.mainHeadSha.slice(0, 12)}`,
    subjectSha: input.mainHeadSha,
    cutAt,
    expiresAt,
    state: "prepared",
    packages: Object.keys(versions),
    versions,
    consumedChangesets,
    metadataWrites,
  };
  return trainRecordDigest(content).andThen((recordDigest) => {
    const candidate = { ...content, recordDigest };
    const checked = StableTrainRecordSchema.safeParse(candidate);
    if (!checked.success)
      return err({
        type: "InvalidTrainRecord" as const,
        issues: checked.error.issues.map((issue) => issue.message),
      });
    return ok({
      record: checked.data,
      expectedHeadSha: input.mainHeadSha,
      worktree: {
        consumedChangesets,
        metadataWrites,
        preservedPaths: input.partition.remainOnMainFiles,
      },
    });
  });
}

/** Validates explicit, main-merged green fixes and discards stale artifact bindings. */
export function planStableFix(
  input: StableFixInput,
): Result<StableFixPlan, StableTrainError> {
  const expiry = guardTrainExpiry(input.record, input.clock);
  if (expiry.isErr()) return err(expiry.error);
  if (!["prepared", "built", "bound"].includes(input.record.state))
    return err({
      type: "InvalidTransition",
      from: input.record.state,
      to: "built",
    });
  if (input.commits.length === 0)
    return err({
      type: "InvalidCut",
      reason: "stable fix requires explicit commits",
    });
  for (const commit of input.commits) {
    if (!commit.mergedToMain)
      return err({ type: "UnmergedCommit", sha: commit.sha });
    if (!commit.green) return err({ type: "NonGreenCommit", sha: commit.sha });
  }
  return invalidateArtifacts(input.record).map((record) => ({
    record,
    expectedHeadSha: input.expectedHeadSha,
    commits: input.commits.map(({ sha }) => sha),
  }));
}

export function invalidateArtifacts(
  record: StableTrainRecord,
): Result<StableTrainRecord, StableTrainError> {
  const {
    recordDigest: _digest,
    artifactIds: _artifactIds,
    artifactManifestDigest: _manifest,
    ...content
  } = record;
  return trainRecordDigest(content).andThen((recordDigest) => {
    const checked = StableTrainRecordSchema.safeParse({
      ...content,
      recordDigest,
    });
    if (!checked.success)
      return err({
        type: "InvalidTrainRecord" as const,
        issues: checked.error.issues.map((issue) => issue.message),
      });
    return ok(checked.data);
  });
}

interface DerivedVersions {
  [packageName: string]: string;
}

function deriveVersions(
  changesets: readonly ParsedChangeset[],
  base: Readonly<Record<PublicPackageName, string>>,
  reserved: Readonly<Record<string, readonly string[]>>,
): DerivedVersions {
  const bumps = new Map<string, ChangesetBump>();
  const weight = { patch: 1, minor: 2, major: 3 } as const;
  for (const changeset of changesets)
    for (const [name, bump] of changeset.releases) {
      const previous = bumps.get(name);
      if (previous === undefined || weight[bump] > weight[previous])
        bumps.set(name, bump);
    }
  const versions: DerivedVersions = {};
  for (const [name, bump] of bumps) {
    if (!isPublicPackageName(name)) continue;
    let version = bumpVersion(base[name], bump);
    while (reserved[name]?.includes(version))
      version = bumpVersion(version, "patch");
    versions[name] = version;
  }
  return versions;
}
function isPublicPackageName(value: string): value is PublicPackageName {
  return PUBLIC_PACKAGE_NAMES.some((name) => name === value);
}

function bumpVersion(version: string, bump: ChangesetBump): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
interface StableMetadataWrite {
  readonly path: string;
  readonly contentsDigest: string;
  readonly contents: string;
}

function metadataWrite(name: string, version: string): StableMetadataWrite {
  const contents = `${name} ${version}\n`;
  return {
    path: `.release/versions/${name.replace("/", "-")}.txt`,
    contents,
    contentsDigest: digest(contents),
  };
}
function digest(value: string): string {
  return `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
}
