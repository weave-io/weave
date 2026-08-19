/**
 * Changed-adapter set for every release channel.
 *
 * An adapter that appears in a channel's publish-set closure is changed and
 * needs packaged harness proof. There is no "unchanged but publishing"
 * carve-out: adapter ∈ publish set ⇒ changed ⇒ proof required.
 *
 * The publish set itself is always a closed selection:
 *
 * - stable: adapter members of the merged plan's closure
 * - next: adapter members of the maintainer-selection closure
 * - nightly: adapter members of Task 13's affected-since-last-nightly closure
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import {
  type ChannelVersionError,
  computeNightlyAffectedSet,
  type NightlyAffectedInput,
  type NightlyAffectedSet,
} from "./channel-versions.js";
import type { PublicPackageName, ReleaseChannel } from "./constants.js";
import { publishablePackageNames } from "./package-policy.js";

export const ADAPTER_PACKAGE_NAMES = [
  "@weaveio/weave-adapter-opencode",
  "@weaveio/weave-adapter-claude-code",
  "@weaveio/weave-adapter-pi",
] as const;

export type AdapterPackageName = (typeof ADAPTER_PACKAGE_NAMES)[number];

/** The closed publish set a channel is about to ship. */
export interface PublishClosure {
  readonly selected: readonly PublicPackageName[];
}

export interface ChangedAdapterSet {
  readonly channel: ReleaseChannel;
  readonly publishSet: readonly PublicPackageName[];
  readonly adapters: readonly AdapterPackageName[];
}

export type ChangedAdapterError =
  | { type: "EmptyPublishSet"; channel: ReleaseChannel }
  | { type: "UnknownPublishPackage"; packageName: string }
  | { type: "DuplicatePublishPackage"; packageName: PublicPackageName }
  | { type: "NightlyAffectedSetFailed"; error: ChannelVersionError };

export type ChangedAdaptersInput =
  | { channel: "stable"; closure: PublishClosure }
  | { channel: "next"; closure: PublishClosure }
  | { channel: "nightly"; affected: Pick<NightlyAffectedSet, "affected"> };

export function isAdapterPackage(
  packageName: string,
): packageName is AdapterPackageName {
  return (ADAPTER_PACKAGE_NAMES as readonly string[]).includes(packageName);
}

/**
 * Adapter members of a closed publish set, in catalog order.
 *
 * Every returned adapter requires proof. Non-adapter catalog members still
 * publish and still need clean-consumer proof, but not harness proof.
 */
export function adaptersInPublishSet(
  publishSet: readonly PublicPackageName[],
): readonly AdapterPackageName[] {
  return ADAPTER_PACKAGE_NAMES.filter((packageName) =>
    publishSet.includes(packageName),
  );
}

/** Resolves the changed-adapter set from an already-closed channel selection. */
export function resolveChangedAdapters(
  input: ChangedAdaptersInput,
): Result<ChangedAdapterSet, ChangedAdapterError> {
  const selected =
    input.channel === "nightly"
      ? input.affected.affected
      : input.closure.selected;
  return validatePublishSet(input.channel, selected).map((publishSet) => ({
    channel: input.channel,
    publishSet,
    adapters: adaptersInPublishSet(publishSet),
  }));
}

/**
 * Stable changed adapters are the adapter members of the merged plan closure.
 * Every closure member publishes new bytes by construction.
 */
export function resolveStableChangedAdapters(
  closure: PublishClosure,
): Result<ChangedAdapterSet, ChangedAdapterError> {
  return resolveChangedAdapters({ channel: "stable", closure });
}

/**
 * `next` changed adapters are the adapter members of the maintainer-selection
 * closure for that run.
 */
export function resolveNextChangedAdapters(
  closure: PublishClosure,
): Result<ChangedAdapterSet, ChangedAdapterError> {
  return resolveChangedAdapters({ channel: "next", closure });
}

/**
 * Nightly changed adapters are the adapter members of the affected-since-last
 * nightly closure computed by Task 13.
 */
export function resolveNightlyChangedAdapters(
  input: NightlyAffectedInput,
): ResultAsync<ChangedAdapterSet, ChangedAdapterError> {
  return computeNightlyAffectedSet(input)
    .mapErr(
      (error): ChangedAdapterError => ({
        type: "NightlyAffectedSetFailed",
        error,
      }),
    )
    .andThen((affected) =>
      resolveChangedAdapters({ channel: "nightly", affected }),
    );
}

function validatePublishSet(
  channel: ReleaseChannel,
  selected: readonly string[],
): Result<readonly PublicPackageName[], ChangedAdapterError> {
  if (selected.length === 0) return err({ type: "EmptyPublishSet", channel });
  const catalog = new Set<string>(publishablePackageNames());
  const seen = new Set<PublicPackageName>();
  const publishSet: PublicPackageName[] = [];
  for (const packageName of selected) {
    if (!catalog.has(packageName))
      return err({ type: "UnknownPublishPackage", packageName });
    const publicName = packageName as PublicPackageName;
    if (seen.has(publicName))
      return err({ type: "DuplicatePublishPackage", packageName: publicName });
    seen.add(publicName);
    publishSet.push(publicName);
  }
  return ok(orderCatalog(publishSet));
}

function orderCatalog(
  packages: readonly PublicPackageName[],
): readonly PublicPackageName[] {
  const allowed = new Set(packages);
  return publishablePackageNames().filter((packageName) =>
    allowed.has(packageName),
  );
}
