import { err, ok, type Result } from "neverthrow";
import type {
  ChangesetBump,
  ChangesetPartition,
  ParsedChangeset,
} from "./changeset-policy.js";
import type { Clock } from "./clock.js";
import type { PublicPackageName } from "./constants.js";
import {
  type STABLE_TRAIN_STATES,
  STABLE_TRAIN_TRANSITIONS,
} from "./constants.js";
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
  | { type: "NonGreenCommit"; sha: string };

export interface StableTrainContent {
  schemaVersion: 1;
  trainRef: string;
  subjectSha: string;
  cutAt: string;
  expiresAt: string;
  state: string;
  packages: readonly string[];
  versions: Readonly<Record<string, string>>;
  artifactManifestDigest?: string;
  consumedChangesets?: readonly { path: string; preimageDigest: string }[];
  metadataWrites?: readonly {
    path: string;
    contentsDigest: string;
    contents: string;
  }[];
  artifactIds?: readonly number[];
}

export interface StableCutInput {
  mainHeadSha: string;
  serverCutAt: Date;
  partition: ChangesetPartition;
  changesets: readonly ParsedChangeset[];
  packageVersions: Readonly<Record<PublicPackageName, string>>;
  changesetContents: Readonly<Record<string, string>>;
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

export function canonicalTrainJson(record: StableTrainContent): string {
  return JSON.stringify(sortObject(record));
}

export function trainRecordDigest(record: StableTrainContent): string {
  return `sha256:${Bun.CryptoHasher.hash("sha256", canonicalTrainJson(record), "hex")}`;
}

export function validateStableTrain(
  record: unknown,
): Result<StableTrainRecord, StableTrainError> {
  const parsed = StableTrainRecordSchema.safeParse(record);
  if (!parsed.success)
    return err({
      type: "InvalidTrainRecord",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  const { recordDigest, ...content } = parsed.data;
  const actual = trainRecordDigest(content);
  if (recordDigest !== actual)
    return err({
      type: "DigestMismatch",
      expected: actual,
      actual: recordDigest,
    });
  return ok(parsed.data);
}

export function transitionStableTrain(
  record: StableTrainRecord,
  state: StableTrainRecord["state"],
): Result<StableTrainRecord, StableTrainError> {
  const allowed = STABLE_TRAIN_TRANSITIONS[
    record.state
  ] as readonly (typeof STABLE_TRAIN_STATES)[number][];
  if (!allowed.includes(state))
    return err({ type: "InvalidTransition", from: record.state, to: state });
  const { recordDigest: _recordDigest, ...content } = record;
  const next = { ...content, state };
  return ok({ ...next, recordDigest: trainRecordDigest(next) });
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
  return ok(undefined);
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
  const versions = deriveVersions(selected, input.packageVersions);
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
  const record = {
    ...content,
    recordDigest: trainRecordDigest(content),
  } as StableTrainRecord;
  return ok({
    record,
    expectedHeadSha: input.mainHeadSha,
    worktree: {
      consumedChangesets,
      metadataWrites,
      preservedPaths: input.partition.remainOnMainFiles,
    },
  });
}

/** Validates explicit, main-merged green fixes and discards stale artifact bindings. */
export function planStableFix(
  input: StableFixInput,
): Result<StableFixPlan, StableTrainError> {
  const expiry = guardTrainExpiry(input.record, input.clock);
  if (expiry.isErr()) return err(expiry.error);
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
  const invalidated = invalidateArtifacts(input.record);
  return ok({
    record: invalidated,
    expectedHeadSha: input.expectedHeadSha,
    commits: input.commits.map(({ sha }) => sha),
  });
}

export function invalidateArtifacts(
  record: StableTrainRecord,
): StableTrainRecord {
  const {
    recordDigest: _digest,
    artifactIds: _artifactIds,
    artifactManifestDigest: _manifest,
    ...content
  } = record;
  return {
    ...content,
    recordDigest: trainRecordDigest(content),
  } as StableTrainRecord;
}

function deriveVersions(
  changesets: readonly ParsedChangeset[],
  base: Readonly<Record<PublicPackageName, string>>,
): Record<string, string> {
  const bumps = new Map<string, ChangesetBump>();
  const weight = { patch: 1, minor: 2, major: 3 } as const;
  for (const changeset of changesets)
    for (const [name, bump] of changeset.releases) {
      const previous = bumps.get(name);
      if (previous === undefined || weight[bump] > weight[previous])
        bumps.set(name, bump);
    }
  return Object.fromEntries(
    [...bumps].map(([name, bump]) => [
      name,
      bumpVersion(base[name as PublicPackageName], bump),
    ]),
  );
}
function bumpVersion(version: string, bump: ChangesetBump): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
function metadataWrite(
  name: string,
  version: string,
): { path: string; contentsDigest: string; contents: string } {
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

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, sortObject(child)]),
    );
  return value;
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
