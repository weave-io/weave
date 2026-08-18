/**
 * Pure, read-only version planning for the `next` and `nightly` channels.
 *
 * Stable version computation remains owned by Task 6. This module consumes the
 * same ledger-aware changeset set and only adds channel decoration. Nothing in
 * this file writes a manifest, consumes a changeset, or mutates a registry.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import { z } from "zod";
import { subtractConsumedLedger } from "./changeset-consumption.js";
import {
  collectPublicImpact,
  type ValidatedChangeset,
} from "./changeset-policy.js";
import type { PublicPackageName } from "./constants.js";
import type { ConsumptionLedger } from "./consumption-ledger.js";
import type { RegistryError } from "./errors.js";
import type { NpmRegistryClient } from "./npm-registry-client.js";
import { publishablePackageNames } from "./package-policy.js";
import {
  computeSelectionClosure,
  type SelectionClosureError,
  type SelectionSeed,
  type WorkspaceManifest,
} from "./selection-closure.js";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{12}$/;
const CHANNEL_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(next|nightly)\.\d{8}\.[0-9a-f]{12}$/;
const NIGHTLY_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.(\d{8})\.([0-9a-f]{12})$/;

export const StableVersionSchema = z.string().regex(STABLE_VERSION);
export const ChannelVersionSchema = z.string().regex(CHANNEL_VERSION);
export const ShortShaSchema = z.string().regex(SHORT_SHA);

export type Channel = "next" | "nightly";

export type ChannelVersionError =
  | { type: "InvalidSourceSha"; sourceSha: string }
  | { type: "InvalidStableVersion"; packageName: string; version: string }
  | { type: "InvalidDate"; value: string }
  | { type: "InvalidChannel"; channel: string }
  | { type: "InvalidGeneratedVersion"; packageName: string; version: string }
  | { type: "RegistryCollision"; packageName: string; version: string }
  | {
      type: "RegistryLookupFailed";
      packageName: string;
      operation: string;
      message: string;
    }
  | { type: "NothingToPublish"; channel: Channel; sourceSha: string }
  | { type: "NoNightlyBaseline" }
  | { type: "MalformedNightlyVersion"; packageName: string; version: string }
  | {
      type: "GitDiffFailed";
      fromSha: string | null;
      toSha: string;
      message: string;
    }
  | { type: "ChangesetSelectionFailed"; error: SelectionClosureError }
  | { type: "InvalidPackageVersionMap"; packageName: string }
  | { type: "InvalidChangesetInput"; reason: string };

/** A package and the exact version planned for a channel. */
export interface ChannelPackageVersion {
  readonly packageName: PublicPackageName;
  readonly stableVersion: string;
  readonly version: string;
}

export interface ChannelVersionPlan {
  readonly channel: Channel;
  readonly sourceSha: string;
  readonly sourceSha12: string;
  readonly date: string;
  readonly packages: readonly ChannelPackageVersion[];
  readonly affected: readonly PublicPackageName[];
  /** The nightly baseline source, when one was found in the registry. */
  readonly sinceSha?: string;
}

/** The registry operation needed by this module. */
export interface ChannelRegistry {
  listVersions(
    packageName: string,
  ): ResultAsyncType<readonly string[], RegistryError>;
}

/** Read-only commit-diff port used by nightly planning. */
export interface CommitDiffReader {
  changedPathsSince(
    fromSha: string | null,
    toSha: string,
  ): ResultAsyncType<readonly string[], unknown>;
}

/** A synchronous or asynchronous diff implementation is convenient in tests. */
export type ChangedPathsSince = (
  fromSha: string | null,
  toSha: string,
) =>
  | readonly string[]
  | Result<readonly string[], unknown>
  | Promise<readonly string[]>
  | ResultAsyncType<readonly string[], unknown>;

export interface StableVersionInput {
  readonly packageVersions: Readonly<Record<PublicPackageName, string>>;
  readonly changesets: readonly ValidatedChangeset[];
  readonly ledger: ConsumptionLedger;
}

/**
 * Computes the stable versions that the pending set would produce.
 *
 * Task 6's Changesets scratch runner remains the authority for release plans;
 * this small read-only projection is useful to channel planners and tests that
 * already have the validated pending set. It uses Task 6's ledger subtraction
 * contract and applies its pre-1.0 bump mapping without touching the inputs.
 */
export function computeWouldBeNextStableVersions(
  input: StableVersionInput,
): Result<Readonly<Record<PublicPackageName, string>>, ChannelVersionError> {
  const pending = subtractConsumedLedger({
    changesets: input.changesets,
    ledger: input.ledger,
  });
  if (pending.modified.length > 0)
    return err({
      type: "InvalidChangesetInput",
      reason: "a consumed changeset was modified after ledger consumption",
    });
  const versions = { ...input.packageVersions } as Record<
    PublicPackageName,
    string
  >;
  const catalog = publishablePackageNames();
  for (const packageName of catalog) {
    if (versions[packageName] === undefined)
      return err({ type: "InvalidPackageVersionMap", packageName });
  }
  for (const packageName of Object.keys(versions)) {
    if (!catalog.includes(packageName as PublicPackageName))
      return err({ type: "InvalidPackageVersionMap", packageName });
  }
  for (const [packageName, version] of Object.entries(versions) as [
    PublicPackageName,
    string,
  ][]) {
    if (!STABLE_VERSION.test(version))
      return err({ type: "InvalidStableVersion", packageName, version });
  }
  const bumps = new Map<PublicPackageName, "patch" | "minor">();
  for (const changeset of pending.pending) {
    if (changeset.kind === "empty") continue;
    for (const [packageName, bump] of changeset.releases) {
      if (versions[packageName] === undefined)
        return err({ type: "InvalidPackageVersionMap", packageName });
      const previous = bumps.get(packageName);
      if (previous === "minor" || bump === "minor")
        bumps.set(packageName, "minor");
      else bumps.set(packageName, "patch");
    }
  }
  for (const [packageName, bump] of bumps) {
    const current = versions[packageName];
    if (current === undefined)
      return err({ type: "InvalidPackageVersionMap", packageName });
    versions[packageName] = highestBumpVersion(current, bump);
  }
  return ok(Object.freeze(versions));
}

/**
 * Renders one channel version. The date is formatted in UTC, not local time.
 * A full commit SHA is accepted at the workflow boundary and shortened only
 * after validation; a short SHA is accepted by hermetic callers.
 */
export function renderChannelVersion(input: {
  readonly stableVersion: string;
  readonly channel: Channel;
  readonly now: Date;
  readonly sourceSha: string;
}): Result<string, ChannelVersionError> {
  if (input.channel !== "next" && input.channel !== "nightly")
    return err({ type: "InvalidChannel", channel: input.channel });
  if (!STABLE_VERSION.test(input.stableVersion))
    return err({
      type: "InvalidStableVersion",
      packageName: "",
      version: input.stableVersion,
    });
  const sourceSha12 = normalizeSha12(input.sourceSha);
  if (sourceSha12 === null)
    return err({ type: "InvalidSourceSha", sourceSha: input.sourceSha });
  if (Number.isNaN(input.now.valueOf()))
    return err({ type: "InvalidDate", value: String(input.now) });
  const date = input.now.toISOString().slice(0, 10).replaceAll("-", "");
  const version = `${input.stableVersion}-${input.channel}.${date}.${sourceSha12}`;
  if (!ChannelVersionSchema.safeParse(version).success)
    return err({
      type: "InvalidGeneratedVersion",
      packageName: "",
      version,
    });
  return ok(version);
}

export interface ComputeChannelVersionsInput extends StableVersionInput {
  readonly channel: Channel;
  readonly sourceSha: string;
  readonly now: Date;
  readonly registry?: ChannelRegistry;
  /** For `next`, defaults to packages named by pending changesets. */
  readonly affected?: readonly PublicPackageName[];
}

/** Computes versions for an explicitly selected next/nightly package set. */
export function computeChannelVersions(
  input: ComputeChannelVersionsInput,
): ResultAsync<ChannelVersionPlan, ChannelVersionError> {
  const stable = computeWouldBeNextStableVersions(input);
  if (stable.isErr()) return errAsync(stable.error);
  const sha12 = normalizeSha12(input.sourceSha);
  if (sha12 === null)
    return errAsync({ type: "InvalidSourceSha", sourceSha: input.sourceSha });
  if (Number.isNaN(input.now.valueOf()))
    return errAsync({ type: "InvalidDate", value: String(input.now) });
  const selected =
    input.affected ?? pendingPackages(input.changesets, input.ledger);
  const affected = orderPackages(selected);
  if (affected.length === 0)
    return errAsync({
      type: "NothingToPublish",
      channel: input.channel,
      sourceSha: input.sourceSha,
    });
  let planned: ResultAsync<
    readonly ChannelPackageVersion[],
    ChannelVersionError
  > = okAsync([]);
  for (const packageName of affected) {
    const stableVersion = stable.value[packageName];
    if (stableVersion === undefined)
      return errAsync({ type: "InvalidPackageVersionMap", packageName });
    const rendered = renderChannelVersion({
      stableVersion,
      channel: input.channel,
      now: input.now,
      sourceSha: input.sourceSha,
    });
    if (rendered.isErr()) return errAsync(rendered.error);
    planned = planned.andThen((packages) =>
      checkCollision(input.registry, packageName, rendered.value).map(() => [
        ...packages,
        { packageName, stableVersion, version: rendered.value },
      ]),
    );
  }
  const date = input.now.toISOString().slice(0, 10).replaceAll("-", "");
  return planned.map((packages) => ({
    channel: input.channel,
    sourceSha: input.sourceSha,
    sourceSha12: sha12,
    date,
    packages,
    affected,
  }));
}

export interface NightlyAffectedInput extends StableVersionInput {
  readonly sourceSha: string;
  readonly registry: ChannelRegistry;
  readonly manifests: readonly WorkspaceManifest[];
  readonly changedPathsSince: ChangedPathsSince | CommitDiffReader;
  /** A missing baseline is allowed when the diff port accepts null. */
  readonly requireBaseline?: boolean;
}

export interface NightlyAffectedSet {
  readonly affected: readonly PublicPackageName[];
  readonly sinceSha: string | null;
  readonly changedPaths: readonly string[];
  readonly closure: {
    readonly selected: readonly PublicPackageName[];
    readonly added: readonly unknown[];
  };
}

/**
 * Finds the latest successful nightly source SHA and closes the affected set
 * over Task 5's shared-changeset and artifact-dependency rules.
 */
export function computeNightlyAffectedSet(
  input: NightlyAffectedInput,
): ResultAsync<NightlyAffectedSet, ChannelVersionError> {
  const sha12 = normalizeSha12(input.sourceSha);
  if (sha12 === null)
    return errAsync({ type: "InvalidSourceSha", sourceSha: input.sourceSha });
  return latestNightlySourceSha(input.registry).andThen((sinceSha) =>
    readChangedPaths(
      input.changedPathsSince,
      sinceSha,
      input.sourceSha,
    ).andThen((changedPaths) => {
      const pending = subtractConsumedLedger({
        changesets: input.changesets,
        ledger: input.ledger,
      });
      if (pending.modified.length > 0)
        return errAsync<never, ChannelVersionError>({
          type: "InvalidChangesetInput",
          reason: "a consumed changeset was modified after ledger consumption",
        });
      const impact = collectPublicImpact(changedPaths);
      const changedByChangeset = pending.pending.flatMap((changeset) =>
        changeset.kind === "public-impact"
          ? [...changeset.releases.keys()]
          : [],
      );
      const seed = uniquePackages([...impact.packages, ...changedByChangeset]);
      if (seed.length === 0)
        return errAsync<never, ChannelVersionError>({
          type: "NothingToPublish",
          channel: "nightly",
          sourceSha: input.sourceSha,
        });
      const selection = computeSelectionClosure({
        seed: seedRecord(seed),
        changesets: pending.pending,
        manifests: input.manifests,
      });
      if (selection.isErr())
        return errAsync<never, ChannelVersionError>({
          type: "ChangesetSelectionFailed",
          error: selection.error,
        });
      return okAsync({
        affected: selection.value.selected,
        sinceSha,
        changedPaths,
        closure: selection.value,
      });
    }),
  );
}

export interface NightlyVersionInput extends NightlyAffectedInput {
  readonly now: Date;
}

/** Computes the complete nightly plan, including affected-set closure. */
export function computeNightlyVersions(
  input: NightlyVersionInput,
): ResultAsync<ChannelVersionPlan, ChannelVersionError> {
  return computeNightlyAffectedSet(input).andThen((affected) =>
    computeChannelVersions({
      ...input,
      channel: "nightly",
      affected: affected.affected,
    }).map((plan) => ({ ...plan, sinceSha: affected.sinceSha ?? undefined })),
  );
}

/** Alias used by workflow callers that call this operation "nightly plan". */
export const computeNightlyPlan = computeNightlyVersions;

function checkCollision(
  registry: ChannelRegistry | undefined,
  packageName: PublicPackageName,
  version: string,
): ResultAsync<void, ChannelVersionError> {
  if (registry === undefined) return okAsync(undefined);
  return registry
    .listVersions(packageName)
    .mapErr((error) => ({
      type: "RegistryLookupFailed" as const,
      packageName,
      operation: "listVersions",
      message: error.message,
    }))
    .andThen((versions) =>
      versions.includes(version)
        ? errAsync({ type: "RegistryCollision" as const, packageName, version })
        : okAsync(undefined),
    );
}

function latestNightlySourceSha(
  registry: ChannelRegistry,
): ResultAsync<string | null, ChannelVersionError> {
  const packages = publishablePackageNames();
  let found: { date: string; version: string; sha: string } | undefined;
  let result: ResultAsync<void, ChannelVersionError> = okAsync(undefined);
  for (const packageName of packages)
    result = result.andThen(() =>
      registry
        .listVersions(packageName)
        .mapErr((error) => ({
          type: "RegistryLookupFailed" as const,
          packageName,
          operation: "listVersions",
          message: error.message,
        }))
        .andThen((versions) => {
          for (const version of versions) {
            const match = NIGHTLY_VERSION.exec(version);
            if (match === null) {
              if (version.includes("-nightly."))
                return errAsync({
                  type: "MalformedNightlyVersion" as const,
                  packageName,
                  version,
                });
              continue;
            }
            const date = match[1] ?? "";
            const sha = match[2] ?? "";
            if (
              found === undefined ||
              `${date}.${version}` > `${found.date}.${found.version}`
            )
              found = { date, version, sha };
          }
          return okAsync(undefined);
        }),
    );
  return result.map(() => found?.sha ?? null);
}

function readChangedPaths(
  reader: ChangedPathsSince | CommitDiffReader,
  fromSha: string | null,
  toSha: string,
): ResultAsync<readonly string[], ChannelVersionError> {
  const value =
    "changedPathsSince" in reader
      ? reader.changedPathsSince(fromSha, toSha)
      : reader(fromSha, toSha);
  if (value instanceof ResultAsync) {
    return value.mapErr((error) => ({
      type: "GitDiffFailed" as const,
      fromSha,
      toSha,
      message: String(error),
    }));
  }
  if (isResultLike(value))
    return value.match(
      (paths) => okAsync(paths),
      (error) =>
        errAsync({
          type: "GitDiffFailed" as const,
          fromSha,
          toSha,
          message: String(error),
        }),
    );
  if (isPromiseLike(value))
    return ResultAsync.fromPromise(value, (error) => ({
      type: "GitDiffFailed" as const,
      fromSha,
      toSha,
      message: String(error),
    }));
  return okAsync(value);
}

function isResultLike(
  value: unknown,
): value is Result<readonly string[], unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    "match" in value &&
    typeof value.match === "function"
  );
}

function isPromiseLike(
  value: unknown,
): value is PromiseLike<readonly string[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function normalizeSha12(sourceSha: string): string | null {
  if (SHORT_SHA.test(sourceSha)) return sourceSha;
  if (FULL_SHA.test(sourceSha)) return sourceSha.slice(0, 12);
  return null;
}

function highestBumpVersion(version: string, bump: "patch" | "minor"): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function pendingPackages(
  changesets: readonly ValidatedChangeset[],
  ledger: ConsumptionLedger,
): readonly PublicPackageName[] {
  const pending = subtractConsumedLedger({ changesets, ledger }).pending;
  return uniquePackages(
    pending.flatMap((changeset) =>
      changeset.kind === "public-impact" ? [...changeset.releases.keys()] : [],
    ),
  );
}

function uniquePackages(
  packages: readonly PublicPackageName[],
): readonly PublicPackageName[] {
  return orderPackages([...new Set(packages)]);
}

function orderPackages(
  packages: readonly PublicPackageName[],
): readonly PublicPackageName[] {
  const order = [
    "@weaveio/weave-cli",
    "@weaveio/weave-adapter-opencode",
    "@weaveio/weave-adapter-claude-code",
    "@weaveio/weave-adapter-pi",
  ] as const;
  const allowed = new Set(packages);
  return order.filter((packageName) => allowed.has(packageName));
}

function seedRecord(packages: readonly PublicPackageName[]): SelectionSeed {
  return {
    "@weaveio/weave-cli": packages.includes("@weaveio/weave-cli"),
    "@weaveio/weave-adapter-opencode": packages.includes(
      "@weaveio/weave-adapter-opencode",
    ),
    "@weaveio/weave-adapter-claude-code": packages.includes(
      "@weaveio/weave-adapter-claude-code",
    ),
    "@weaveio/weave-adapter-pi": packages.includes("@weaveio/weave-adapter-pi"),
  };
}

/** Adapter for the existing npm registry client. */
export function asChannelRegistry(client: NpmRegistryClient): ChannelRegistry {
  return client;
}

/** Strictly extracts the source SHA carried by a nightly version. */
export function sourceShaFromNightlyVersion(
  version: string,
): Result<string, ChannelVersionError> {
  const match = NIGHTLY_VERSION.exec(version);
  if (match === null)
    return err({ type: "MalformedNightlyVersion", packageName: "", version });
  return ok(match[2] ?? "");
}
