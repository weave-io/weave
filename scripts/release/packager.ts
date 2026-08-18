import { basename, join, relative, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  type PublicPackageBuild,
  type PublicPackageName,
  type ReleaseChannel,
} from "./constants.js";
import {
  type PackagePolicyError,
  PackagePolicyValidator,
} from "./package-policy.js";
import {
  BunPublicManifestFileSystem,
  PublicManifestBuilder,
  type PublicManifestError,
} from "./public-manifest.js";
import {
  renderScratchChangelog,
  SCRATCH_CHANGELOG_PURPOSES,
  type ScratchChangelogPurpose,
  type ScratchChangesetIdentity,
  type ScratchHistoryEntry,
} from "./scratch-changelog.js";
import {
  type PublicPackageInventory,
  sha256Digest,
  type TarFileDigest,
  type TarInspectionError,
  TarInspector,
} from "./tar-inspector.js";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type StagingChannel =
  | ReleaseChannel
  | "candidate-readiness"
  | "bootstrap";

export type ScratchOverrideKind =
  | "version"
  | "dependency-range"
  | "changelog"
  | "carrier"
  | "none";

export interface DependencyRangeOverride {
  readonly packageName: PublicPackageName;
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface ScratchStageOptions {
  readonly channel?: StagingChannel;
  readonly purpose?: ScratchChangelogPurpose;
  readonly sourceRoot?: string;
  /** Source identity for scratch metadata; never acts as stable authority. */
  readonly sourceSha?: string;
  /** Stable mode's exact released checkout identity. */
  readonly releasedSha?: string;
  readonly canonicalNotesUrl?: string;
  readonly sourceHistory?: readonly ScratchHistoryEntry[];
  readonly pendingChangesets?: readonly ScratchChangesetIdentity[];
  readonly packages?: readonly PublicPackageName[];
  readonly overrides?: ScratchOverrideCarrier;
  readonly dependencyRangeOverrides?: readonly DependencyRangeOverride[];
  readonly changelogOverrides?: Readonly<
    Partial<Record<PublicPackageName, string>>
  >;
}

export interface ScratchOverrideCarrier {
  readonly versionOverrides?: Readonly<Record<string, string>>;
  readonly dependencyRangeOverrides?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly changelogOverrides?: Readonly<Record<string, string>>;
}

export interface OverrideProvenance {
  readonly kind: ScratchOverrideKind;
  readonly packageName: PublicPackageName;
  readonly sourceDigest: string;
  readonly stagedDigest: string;
  readonly digest: string;
}

export interface PackageStagingRecord {
  readonly packageName: PublicPackageName;
  readonly version: string;
  readonly tarballPath: string;
  readonly tarballSha256: string;
  readonly files: readonly TarFileDigest[];
  readonly stagedManifestDigest: string;
  readonly publicManifestDigest: string;
  readonly stagedChangelogDigest: string;
  readonly entryPointDigests: readonly {
    packageName: PublicPackageName;
    entryPoint: string;
    digest: string;
  }[];
  readonly overrides: readonly OverrideProvenance[];
  readonly inventory: PublicPackageInventory;
}

/** A build-only binding payload. Proof markers are added by later tasks. */
export interface ReleaseStagingBinding {
  readonly schemaVersion: 1;
  readonly builtSha: string;
  readonly tarballs: readonly {
    packageName: PublicPackageName;
    version: string;
    path: string;
    sha256: string;
  }[];
  readonly fileDigests: readonly {
    packageName: PublicPackageName;
    path: string;
    size: number;
    digest: string;
  }[];
  readonly manifestDigests: readonly {
    packageName: PublicPackageName;
    stagedManifestDigest: string;
    publicManifestDigest: string;
  }[];
  readonly changelogDigests: readonly {
    packageName: PublicPackageName;
    version: string;
    documentDigest: string;
  }[];
  readonly overrideDigests: readonly {
    packageName: PublicPackageName;
    kind: ScratchOverrideKind;
    sourceDigest: string;
    stagedDigest: string;
    digest: string;
  }[];
  readonly entryPointDigests: readonly {
    packageName: PublicPackageName;
    entryPoint: string;
    digest: string;
  }[];
  readonly proofMarkers: {
    readonly attestation: { readonly status: "pending" };
    readonly cleanConsumer: { readonly status: "pending" };
    readonly harnessProof: { readonly status: "pending" };
    readonly registryVerification: { readonly status: "pending" };
  };
}

export type PackagerError =
  | { type: "Filesystem"; path: string; operation: "read" | "write" | "list" }
  | { type: "NpmPack"; directory: string; diagnostics: string }
  | { type: "PackOutput"; directory: string }
  | { type: "Manifest"; error: PublicManifestError }
  | { type: "Policy"; error: PackagePolicyError }
  | { type: "Inventory"; error: TarInspectionError }
  | { type: "InvalidChannel"; channel: string }
  | { type: "ChannelMismatch"; expected: string; actual: string }
  | { type: "ReleasedShaMismatch"; expected: string; actual: string }
  | { type: "InvalidReleasedSha"; value: string }
  | { type: "InvalidOverride"; field: string }
  | { type: "StableVersionOverrideRejected"; packageName?: string }
  | { type: "StableDependencyRangeOverrideRejected"; packageName?: string }
  | { type: "StableChangelogOverrideRejected"; packageName?: string }
  | { type: "StableOverrideCarrierRejected"; fields: readonly string[] }
  | { type: "NonStableCannotCoerceStable"; channel: string };

export type ReleaseCheckoutError =
  | PackagerError
  | { type: "DirtyReleaseCheckout"; phase: "before" | "after"; status: string };

export interface ReleaseCheckout {
  status(root: string): ResultAsync<string, PackagerError>;
  /** Optional exact HEAD proof used by stable released-SHA staging. */
  head?(root: string): ResultAsync<string, PackagerError>;
}

export class BunReleaseCheckout implements ReleaseCheckout {
  status(root: string): ResultAsync<string, PackagerError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({
          cmd: ["git", "status", "--porcelain"],
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        }),
      () => ({
        type: "Filesystem" as const,
        path: root,
        operation: "read" as const,
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
      ]),
      () => ({
        type: "Filesystem" as const,
        path: root,
        operation: "read" as const,
      }),
    ).andThen(([code, stdout]) =>
      code === 0
        ? okAsync(stdout)
        : errAsync({
            type: "Filesystem" as const,
            path: root,
            operation: "read" as const,
          }),
    );
  }

  head(root: string): ResultAsync<string, PackagerError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({
          cmd: ["git", "rev-parse", "HEAD"],
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        }),
      () => ({
        type: "Filesystem" as const,
        path: root,
        operation: "read" as const,
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
      ]),
      () => ({
        type: "Filesystem" as const,
        path: root,
        operation: "read" as const,
      }),
    ).andThen(([code, stdout]) =>
      code === 0
        ? okAsync(stdout.trim())
        : errAsync({
            type: "Filesystem" as const,
            path: root,
            operation: "read" as const,
          }),
    );
  }
}

export interface PackageCommandRunner {
  run(
    command: readonly string[],
    cwd: string,
  ): ResultAsync<string, PackagerError>;
}

export class BunPackageCommandRunner implements PackageCommandRunner {
  run(
    command: readonly string[],
    cwd: string,
  ): ResultAsync<string, PackagerError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({ cmd: [...command], cwd, stdout: "pipe", stderr: "pipe" }),
      () => ({
        type: "NpmPack" as const,
        directory: cwd,
        diagnostics: "Could not start bun pm pack",
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
        new Response(spawned.value.stderr).text(),
      ]),
      () => ({
        type: "NpmPack" as const,
        directory: cwd,
        diagnostics: "bun pm pack output unavailable",
      }),
    ).andThen(([code, stdout, stderr]) => {
      if (code === 0) return okAsync(stdout);
      return errAsync({
        type: "NpmPack" as const,
        directory: cwd,
        diagnostics: stderr || stdout,
      });
    });
  }
}

/** Stages only approved artifacts, then packs and validates the resulting npm bytes. */
export class PublicPackagePackager {
  private readonly sourceRoot: string;
  private readonly tarInspector: TarInspector;

  constructor(
    private readonly commandRunner: PackageCommandRunner,
    private readonly validator: PackagePolicyValidator,
    private readonly manifestBuilder = new PublicManifestBuilder(
      new BunPublicManifestFileSystem(),
    ),
    options: {
      readonly sourceRoot?: string;
      readonly tarInspector?: TarInspector;
    } = {},
  ) {
    this.sourceRoot = resolve(options.sourceRoot ?? process.cwd());
    this.tarInspector = options.tarInspector ?? new TarInspector();
  }

  packAll(
    root: string,
    plannedVersions?: Readonly<Record<string, string>>,
    options: ScratchStageOptions = {},
  ): ResultAsync<readonly string[], PackagerError> {
    return this.packAllDetailed(root, plannedVersions, options).map((records) =>
      records.map((record) => record.tarballPath),
    );
  }

  packAllDetailed(
    root: string,
    plannedVersions?: Readonly<Record<string, string>>,
    options: ScratchStageOptions = {},
  ): ResultAsync<readonly PackageStagingRecord[], PackagerError> {
    const channel = options.channel ?? "next";
    const channelResult = validateChannel(channel);
    if (channelResult.isErr()) return errAsync(channelResult.error);
    const selectedPurpose = options.purpose ?? purposeForChannel(channel);
    if (channel !== "stable" && selectedPurpose !== purposeForChannel(channel))
      return errAsync({
        type: "ChannelMismatch",
        expected: purposeForChannel(channel),
        actual: selectedPurpose,
      });
    const carrier = options.overrides
      ? normalizeCarrier(options.overrides)
      : ok<ScratchOverrideCarrier, PackagerError>({});
    if (carrier.isErr()) return errAsync(carrier.error);
    if (channel === "stable") {
      const fields = [
        ...(plannedVersions === undefined ? [] : ["versionOverrides"]),
        ...(options.dependencyRangeOverrides === undefined
          ? []
          : ["dependencyRangeOverrides"]),
        ...(options.changelogOverrides === undefined
          ? []
          : ["changelogOverrides"]),
        ...definedCarrierFields(carrier.value),
      ];
      const stableError = stableOverrideError([...new Set(fields)]);
      if (stableError !== undefined) return errAsync(stableError);
    }
    const carrierVersions = carrier.value.versionOverrides ?? {};
    const effectiveVersions =
      plannedVersions === undefined
        ? carrierVersions
        : { ...carrierVersions, ...plannedVersions };
    const overridePackageNames = new Set([
      ...Object.keys(effectiveVersions),
      ...Object.keys(carrier.value.dependencyRangeOverrides ?? {}),
      ...Object.keys(carrier.value.changelogOverrides ?? {}),
      ...(options.dependencyRangeOverrides ?? []).map(
        (entry) => entry.packageName,
      ),
      ...Object.keys(options.changelogOverrides ?? {}),
    ]);
    for (const name of overridePackageNames)
      if (!Object.hasOwn(PUBLIC_PACKAGES, name))
        return errAsync({ type: "InvalidOverride", field: "packageName" });
    const packageNames =
      options.packages ??
      (overridePackageNames.size === 0
        ? (Object.keys(PUBLIC_PACKAGES) as PublicPackageName[])
        : [...overridePackageNames].map((name) => name as PublicPackageName));
    const uniquePackages = [...new Set(packageNames)];
    let result = okAsync<readonly PackageStagingRecord[], PackagerError>([]);
    for (const packageName of uniquePackages) {
      const version = effectiveVersions[packageName];
      const directDependencyRanges = options.dependencyRangeOverrides?.find(
        (entry) => entry.packageName === packageName,
      )?.dependencies;
      const carrierDependencyRanges =
        carrier.value.dependencyRangeOverrides?.[packageName];
      const dependencyRanges =
        directDependencyRanges === undefined
          ? carrierDependencyRanges
          : { ...carrierDependencyRanges, ...directDependencyRanges };
      const changelogOverride =
        options.changelogOverrides?.[packageName] ??
        carrier.value.changelogOverrides?.[packageName];
      result = result.andThen((records) =>
        this.packDetailed(packageName, root, join(root, "tarballs"), {
          channel,
          version,
          dependencyRanges,
          changelogOverride,
          purpose: selectedPurpose,
          sourceRoot: options.sourceRoot,
          releasedSha: options.releasedSha,
          sourceSha: options.sourceSha,
          canonicalNotesUrl: options.canonicalNotesUrl,
          sourceHistory: options.sourceHistory,
          pendingChangesets: options.pendingChangesets,
        }).map((record) => [...records, record]),
      );
    }
    return result;
  }

  /**
   * Stable staging has no override carrier. It verifies the source checkout is
   * clean and exactly at the released SHA before packing.
   */
  packStableRelease(
    root: string,
    checkout: ReleaseCheckout,
    releasedSha: string,
    options: Pick<ScratchStageOptions, "packages" | "sourceRoot"> = {},
  ): ResultAsync<readonly string[], ReleaseCheckoutError> {
    const sourceRoot = resolve(options.sourceRoot ?? this.sourceRoot);
    const expectedPackages =
      options.packages ?? (Object.keys(PUBLIC_PACKAGES) as PublicPackageName[]);
    return checkout
      .status(sourceRoot)
      .andThen((before) => {
        if (before !== "")
          return errAsync({
            type: "DirtyReleaseCheckout" as const,
            phase: "before" as const,
            status: before,
          });
        return this.verifyReleasedSha(
          sourceRoot,
          checkout,
          releasedSha,
        ).andThen((sourceSha) =>
          this.packAll(root, undefined, {
            channel: "stable",
            packages: expectedPackages,
            sourceRoot,
            releasedSha: sourceSha,
          }).map((tarballs) => ({ sourceSha, tarballs })),
        );
      })
      .andThen(({ sourceSha, tarballs }) =>
        checkout.status(sourceRoot).andThen((after) => {
          if (after !== "")
            return errAsync({
              type: "DirtyReleaseCheckout" as const,
              phase: "after" as const,
              status: after,
            });
          return this.verifyReleasedSha(sourceRoot, checkout, sourceSha).map(
            () => tarballs,
          );
        }),
      );
  }

  /** Stable spelling for callers that provide a released SHA explicitly. */
  packStableAtReleasedSha(
    root: string,
    releasedSha: string,
    checkout = new BunReleaseCheckout(),
    options: Pick<ScratchStageOptions, "packages" | "sourceRoot"> = {},
  ): ResultAsync<readonly string[], ReleaseCheckoutError> {
    return this.packStableRelease(root, checkout, releasedSha, options);
  }

  pack(
    packageName: PublicPackageName,
    root: string,
    destination: string,
    plannedVersion?: string,
    options: Omit<ScratchStageOptions, "packages"> & {
      readonly dependencyRanges?: Readonly<Record<string, string>>;
      readonly changelogOverride?: string;
    } = {},
  ): ResultAsync<string, PackagerError> {
    const dependencyRanges =
      options.dependencyRanges ??
      options.dependencyRangeOverrides?.find(
        (entry) => entry.packageName === packageName,
      )?.dependencies;
    return this.packDetailed(packageName, root, destination, {
      ...options,
      channel: options.channel ?? "next",
      version: plannedVersion,
      dependencyRanges,
      changelogOverride:
        options.changelogOverride ?? options.changelogOverrides?.[packageName],
    }).map((record) => record.tarballPath);
  }

  packDetailed(
    packageName: PublicPackageName,
    root: string,
    destination: string,
    options: {
      readonly channel: StagingChannel;
      readonly version?: string;
      readonly dependencyRanges?: Readonly<Record<string, string>>;
      readonly changelogOverride?: string;
      readonly overrides?: ScratchOverrideCarrier;
      readonly purpose?: ScratchChangelogPurpose;
      readonly sourceRoot?: string;
      readonly sourceSha?: string;
      readonly releasedSha?: string;
      readonly canonicalNotesUrl?: string;
      readonly sourceHistory?: readonly ScratchHistoryEntry[];
      readonly pendingChangesets?: readonly ScratchChangesetIdentity[];
    },
  ): ResultAsync<PackageStagingRecord, PackagerError> {
    const channelResult = validateChannel(options.channel);
    if (channelResult.isErr()) return errAsync(channelResult.error);
    if (!Object.hasOwn(PUBLIC_PACKAGES, packageName))
      return errAsync({ type: "InvalidOverride", field: "packageName" });
    const carrierResult = options.overrides
      ? normalizeCarrier(options.overrides)
      : ok<ScratchOverrideCarrier, PackagerError>({});
    if (carrierResult.isErr()) return errAsync(carrierResult.error);
    const carrier = carrierResult.value;
    const stable = options.channel === "stable";
    const purpose = options.purpose ?? purposeForChannel(options.channel);
    const carrierVersion = carrier.versionOverrides?.[packageName];
    const version = options.version ?? carrierVersion;
    if (
      options.channel === "bootstrap" &&
      version !== undefined &&
      version !== "0.0.0"
    )
      return errAsync({ type: "InvalidOverride", field: "version" });
    const stagedVersion = options.channel === "bootstrap" ? "0.0.0" : version;
    const carrierDependencyRanges =
      carrier.dependencyRangeOverrides?.[packageName];
    const dependencyRanges =
      options.dependencyRanges === undefined
        ? carrierDependencyRanges
        : { ...carrierDependencyRanges, ...options.dependencyRanges };
    const changelogOverride =
      options.changelogOverride ?? carrier.changelogOverrides?.[packageName];
    const overrideFields = [
      ...(version === undefined ? [] : ["versionOverrides"]),
      ...(dependencyRanges === undefined ? [] : ["dependencyRangeOverrides"]),
      ...(changelogOverride === undefined ? [] : ["changelogOverrides"]),
      ...definedCarrierFields(carrier),
    ];
    if (stable) {
      const stableError = stableOverrideError(
        [...new Set(overrideFields)],
        packageName,
      );
      if (stableError !== undefined) return errAsync(stableError);
    }
    if (version !== undefined && !SEMVER.test(version))
      return errAsync({ type: "InvalidOverride", field: "version" });
    if (stable && purpose !== "next")
      return errAsync({
        type: "ChannelMismatch",
        expected: "next",
        actual: purpose,
      });
    if (!stable && options.releasedSha !== undefined)
      return errAsync({
        type: "NonStableCannotCoerceStable",
        channel: options.channel,
      });
    if (stable && options.releasedSha !== undefined) {
      if (!/^[0-9a-f]{40}$/.test(options.releasedSha))
        return errAsync({
          type: "InvalidReleasedSha",
          value: options.releasedSha,
        });
    }
    const sourceRoot = resolve(options.sourceRoot ?? this.sourceRoot);
    const source = resolve(sourceRoot, PUBLIC_PACKAGES[packageName].directory);
    const stage = join(root, "staging", packageName.replace("@weaveio/", ""));
    const sourceManifestPath = join(source, "package.json");
    const sourceChangelogPath = join(source, "CHANGELOG.md");
    if (!stable && purpose !== purposeForChannel(options.channel))
      return errAsync({
        type: "ChannelMismatch",
        expected: purposeForChannel(options.channel),
        actual: purpose,
      });
    return this.ensureDirectory(destination)
      .andThen(() => this.removeDirectory(stage))
      .andThen(() => this.readBytes(sourceManifestPath))
      .andThen((sourceManifestBytes) =>
        this.readBytes(sourceChangelogPath).andThen((sourceChangelogBytes) =>
          this.stageManifest(
            sourceManifestPath,
            root,
            stable ? undefined : stagedVersion,
          ).andThen(() =>
            this.rewriteDependencyRanges(stage, dependencyRanges).andThen(() =>
              this.copyApprovedFiles(
                packageName,
                sourceRoot,
                source,
                stage,
                changelogOverride,
              ).andThen(() =>
                this.ensureScratchChangelog(
                  packageName,
                  stage,
                  options.channel,
                  purpose,
                  stagedVersion ?? manifestVersion(sourceManifestBytes),
                  options.sourceSha,
                  options.canonicalNotesUrl,
                  options.sourceHistory,
                  options.pendingChangesets,
                  changelogOverride !== undefined,
                ).andThen(() =>
                  this.commandRunner
                    .run(
                      [
                        "bun",
                        "pm",
                        "pack",
                        "--ignore-scripts",
                        "--destination",
                        resolve(destination),
                        "--quiet",
                      ],
                      stage,
                    )
                    .andThen((output) => {
                      const packed = this.readPackOutput(output, destination);
                      if (packed.isErr()) return errAsync(packed.error);
                      return this.readBytes(packed.value).andThen((bytes) =>
                        this.inspectAndRecord(
                          packageName,
                          sourceManifestBytes,
                          sourceChangelogBytes,
                          stage,
                          packed.value,
                          bytes,
                          {
                            channel: options.channel,
                            version: stagedVersion,
                            dependencyRanges,
                            changelogOverride,
                          },
                        ),
                      );
                    }),
                ),
              ),
            ),
          ),
        ),
      );
  }

  /** Applies version overrides to already-created staging manifests only. */
  stageWithVersionOverrides(
    scratchDir: string,
    overrides: Readonly<Record<string, string>> | ScratchOverrideCarrier,
    options: { readonly channel?: StagingChannel } = {},
  ): ResultAsync<readonly OverrideProvenance[], PackagerError> {
    return stageWithVersionOverrides(scratchDir, overrides, options);
  }

  /** Applies dependency-range overrides to already-created staging manifests only. */
  stageWithDependencyRangeOverrides(
    scratchDir: string,
    overrides: Readonly<Record<string, Readonly<Record<string, string>>>>,
    options: { readonly channel?: StagingChannel } = {},
  ): ResultAsync<readonly OverrideProvenance[], PackagerError> {
    return stageWithDependencyRangeOverrides(scratchDir, overrides, options);
  }

  /** Replaces one staged changelog and never writes to the source tree. */
  stageWithChangelogOverride(
    scratchDir: string,
    packageName: PublicPackageName,
    content: string,
    options: { readonly channel?: StagingChannel } = {},
  ): ResultAsync<OverrideProvenance, PackagerError> {
    return stageWithChangelogOverride(
      scratchDir,
      packageName,
      content,
      options,
    );
  }

  private inspectAndRecord(
    packageName: PublicPackageName,
    sourceManifestBytes: Uint8Array,
    sourceChangelogBytes: Uint8Array,
    stage: string,
    tarballPath: string,
    bytes: Uint8Array,
    options: {
      readonly channel: StagingChannel;
      readonly version?: string;
      readonly dependencyRanges?: Readonly<Record<string, string>>;
      readonly changelogOverride?: string;
    },
  ): ResultAsync<PackageStagingRecord, PackagerError> {
    const inventory = this.tarInspector.inspectPublicPackage(
      bytes,
      packageName,
    );
    if (inventory.isErr())
      return errAsync({ type: "Inventory", error: inventory.error });
    const policy = this.validator.validate(bytes);
    if (policy.isErr())
      return errAsync({ type: "Policy", error: policy.error });
    const manifestPath = join(stage, "package.json");
    const changelogPath = join(stage, "CHANGELOG.md");
    return ResultAsync.fromThrowable(
      () =>
        Promise.all([
          Bun.file(manifestPath).bytes(),
          Bun.file(changelogPath).bytes(),
        ]),
      () => ({
        type: "Filesystem" as const,
        path: stage,
        operation: "read" as const,
      }),
    )().andThen(([manifestBytes, changelogBytes]) => {
      const manifest = Result.fromThrowable(
        () => JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
        () => ({ type: "PackOutput" as const, directory: stage }),
      )();
      if (manifest.isErr() || !isRecord(manifest.value))
        return errAsync(
          manifest.isErr()
            ? manifest.error
            : { type: "PackOutput" as const, directory: stage },
        );
      const version = manifest.value.version;
      if (typeof version !== "string")
        return errAsync({ type: "PackOutput" as const, directory: stage });
      const packedManifest = inventory.value.entries.find(
        (entry) => entry.path === "package/package.json",
      );
      const packedChangelog = inventory.value.entries.find(
        (entry) => entry.path === "package/CHANGELOG.md",
      );
      if (
        packedManifest === undefined ||
        !bytesEqual(packedManifest.contents, manifestBytes)
      )
        return errAsync({
          type: "Inventory" as const,
          error: {
            type: "StagedManifestMismatch" as const,
            path: "package/package.json",
          },
        });
      if (
        packedChangelog === undefined ||
        !bytesEqual(packedChangelog.contents, changelogBytes)
      )
        return errAsync({
          type: "Inventory" as const,
          error: {
            type: "StagedChangelogMismatch" as const,
            path: "package/CHANGELOG.md",
          },
        });
      if (options.channel === "stable") {
        const sourceManifest = Result.fromThrowable(
          () => JSON.parse(new TextDecoder().decode(sourceManifestBytes)),
          () => ({ type: "PackOutput" as const, directory: stage }),
        )();
        if (sourceManifest.isErr()) return errAsync(sourceManifest.error);
        const projected = this.manifestBuilder.build(
          sourceManifest.value,
          "source/package.json",
        );
        if (projected.isErr())
          return errAsync({
            type: "Manifest" as const,
            error: projected.error,
          });
        if (canonicalJson(projected.value) !== canonicalJson(manifest.value))
          return errAsync({
            type: "Inventory" as const,
            error: {
              type: "StagedManifestMismatch" as const,
              path: "package/package.json",
            },
          });
      }
      const overrides = buildOverrideProvenance(
        packageName,
        sourceManifestBytes,
        sourceChangelogBytes,
        manifestBytes,
        changelogBytes,
        options,
      );
      const publicManifestDigest = sha256Digest(canonicalJson(manifest.value));
      return okAsync({
        packageName,
        version,
        tarballPath,
        tarballSha256: inventory.value.tarballSha256,
        files: inventory.value.files,
        stagedManifestDigest: inventory.value.stagedManifestDigest,
        publicManifestDigest,
        stagedChangelogDigest: inventory.value.stagedChangelogDigest,
        entryPointDigests: inventory.value.entryPointDigests,
        overrides,
        inventory: inventory.value,
      });
    });
  }

  private ensureScratchChangelog(
    packageName: PublicPackageName,
    stage: string,
    channel: StagingChannel,
    purpose: ScratchChangelogPurpose,
    version: string | undefined,
    sourceSha: string | undefined,
    canonicalNotesUrl: string | undefined,
    sourceHistory: readonly ScratchHistoryEntry[] | undefined,
    pendingChangesets: readonly ScratchChangesetIdentity[] | undefined,
    skipBecauseOverridden: boolean,
  ): ResultAsync<void, PackagerError> {
    if (channel === "stable" || skipBecauseOverridden)
      return okAsync(undefined);
    if (purpose === undefined || !SCRATCH_CHANGELOG_PURPOSES.includes(purpose))
      return errAsync({ type: "InvalidChannel", channel });
    if (version === undefined) return okAsync(undefined);
    const rendered = renderScratchChangelog({
      purpose,
      packageName,
      version,
      sourceSha: sourceSha ?? "0".repeat(40),
      canonicalNotesUrl:
        canonicalNotesUrl ?? "https://github.com/weave-io/weave/releases",
      sourceHistory,
      pendingChangesets,
    });
    if (rendered.isErr())
      return errAsync({
        type: "InvalidOverride",
        field: "scratch-changelog",
      });
    return this.write(join(stage, "CHANGELOG.md"), rendered.value);
  }

  private copyApprovedFiles(
    packageName: PublicPackageName,
    sourceRoot: string,
    source: string,
    stage: string,
    changelogOverride?: string,
  ): ResultAsync<void, PackagerError> {
    const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
    const files = new Set<string>();
    const packageDirectory = PUBLIC_PACKAGES[packageName].directory;
    for (const entry of build.entries)
      files.add(entry.output.slice(packageDirectory.length + 1));
    for (const declaration of build.declarations)
      files.add(declaration.output.slice(packageDirectory.length + 1));
    if (build.bootstrap !== undefined)
      for (const file of build.bootstrap) files.add(`dist/bootstrap/${file}`);
    files.add("README.md");
    files.add("CHANGELOG.md");
    files.add("LICENSE");
    let result = okAsync<void, PackagerError>(undefined);
    for (const file of [...files].sort(compareText)) {
      const sourcePath =
        file === "LICENSE" ? join(sourceRoot, "LICENSE") : join(source, file);
      const destination = join(stage, file);
      result = result.andThen(() =>
        changelogOverride !== undefined && file === "CHANGELOG.md"
          ? this.write(destination, changelogOverride)
          : this.copy(sourcePath, destination),
      );
      if (file === "dist/main.js")
        result = result.andThen(() => this.makeExecutable(destination));
    }
    return result;
  }

  private stageManifest(
    sourceManifestPath: string,
    root: string,
    plannedVersion?: string,
  ): ResultAsync<unknown, PackagerError> {
    return this.manifestBuilder
      .stage(sourceManifestPath, join(root, "staging"), plannedVersion)
      .mapErr((error) => ({ type: "Manifest" as const, error }));
  }

  private rewriteDependencyRanges(
    stage: string,
    ranges: Readonly<Record<string, string>> | undefined,
  ): ResultAsync<void, PackagerError> {
    if (ranges === undefined) return okAsync(undefined);
    if (!isStringMap(ranges))
      return errAsync({
        type: "InvalidOverride",
        field: "dependencyRanges",
      });
    for (const [name, range] of Object.entries(ranges))
      if (name.length === 0 || range.length === 0)
        return errAsync({ type: "InvalidOverride", field: "dependencyRanges" });
    const path = join(stage, "package.json");
    return this.readText(path).andThen((contents) => {
      const parsed = Result.fromThrowable(
        () => JSON.parse(contents) as unknown,
        () => ({ type: "InvalidOverride" as const, field: "package.json" }),
      )();
      if (parsed.isErr() || !isRecord(parsed.value))
        return errAsync(
          parsed.isErr()
            ? parsed.error
            : { type: "InvalidOverride" as const, field: "package.json" },
        );
      const manifest = parsed.value;
      const fields = [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ] as const;
      for (const field of fields) {
        const map = manifest[field];
        if (!isRecord(map)) continue;
        for (const [name, range] of Object.entries(ranges))
          if (name in map) map[name] = range;
      }
      return this.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
    });
  }

  private copy(
    source: string,
    destination: string,
  ): ResultAsync<void, PackagerError> {
    return ResultAsync.fromThrowable(
      () => Bun.file(source).arrayBuffer(),
      () => ({
        type: "Filesystem" as const,
        path: source,
        operation: "read" as const,
      }),
    )().andThen((contents) => this.write(destination, contents));
  }

  private write(
    destination: string,
    contents: string | ArrayBuffer | Uint8Array,
  ): ResultAsync<void, PackagerError> {
    return ResultAsync.fromThrowable(
      () => Bun.write(destination, contents),
      () => ({
        type: "Filesystem" as const,
        path: destination,
        operation: "write" as const,
      }),
    )().map(() => undefined);
  }

  private ensureDirectory(path: string): ResultAsync<void, PackagerError> {
    return this.write(join(path, ".keep"), "");
  }

  private removeDirectory(path: string): ResultAsync<void, PackagerError> {
    const spawned = Result.fromThrowable(
      () => Bun.spawn(["rm", "-rf", path]),
      () => ({
        type: "Filesystem" as const,
        path,
        operation: "write" as const,
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(spawned.value.exited, () => ({
      type: "Filesystem" as const,
      path,
      operation: "write" as const,
    })).andThen((code) =>
      code === 0
        ? okAsync(undefined)
        : errAsync({
            type: "Filesystem" as const,
            path,
            operation: "write" as const,
          }),
    );
  }

  private makeExecutable(path: string): ResultAsync<void, PackagerError> {
    return ResultAsync.fromPromise(
      Bun.spawn(["chmod", "755", path]).exited,
      () => ({
        type: "Filesystem" as const,
        path,
        operation: "write" as const,
      }),
    ).andThen((code) =>
      code === 0
        ? okAsync(undefined)
        : errAsync({
            type: "Filesystem" as const,
            path,
            operation: "write" as const,
          }),
    );
  }

  private readBytes(path: string): ResultAsync<Uint8Array, PackagerError> {
    return ResultAsync.fromThrowable(
      () => Bun.file(path).bytes(),
      () => ({
        type: "Filesystem" as const,
        path,
        operation: "read" as const,
      }),
    )();
  }

  private readText(path: string): ResultAsync<string, PackagerError> {
    return ResultAsync.fromThrowable(
      () => Bun.file(path).text(),
      () => ({
        type: "Filesystem" as const,
        path,
        operation: "read" as const,
      }),
    )();
  }

  private verifyReleasedSha(
    sourceRoot: string,
    checkout: ReleaseCheckout,
    releasedSha: string,
  ): ResultAsync<string, ReleaseCheckoutError> {
    if (!/^[0-9a-f]{40}$/.test(releasedSha))
      return errAsync({
        type: "InvalidReleasedSha",
        value: releasedSha,
      });
    const head = checkout.head
      ? checkout.head(sourceRoot)
      : new BunReleaseCheckout().head(sourceRoot);
    return head.andThen((actual) =>
      actual === releasedSha
        ? okAsync(releasedSha)
        : errAsync({
            type: "ReleasedShaMismatch" as const,
            expected: releasedSha,
            actual,
          }),
    );
  }

  private readPackOutput(
    output: string,
    destination: string,
  ): Result<string, PackagerError> {
    const trimmed = output.trim();
    if (trimmed.length > 0) {
      const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
      const candidate = lines.find((line) => line.endsWith(".tgz"));
      if (candidate !== undefined) {
        const path = resolve(candidate);
        return ok(
          path.startsWith(resolve(destination))
            ? path
            : join(destination, candidate),
        );
      }
    }
    const parsed = Result.fromThrowable(
      () => JSON.parse(output) as unknown,
      () => ({ type: "PackOutput" as const, directory: destination }),
    )();
    if (
      parsed.isErr() ||
      !Array.isArray(parsed.value) ||
      typeof parsed.value[0] !== "object" ||
      parsed.value[0] === null
    )
      return err({ type: "PackOutput", directory: destination });
    const filename = (parsed.value[0] as { filename?: unknown }).filename;
    if (typeof filename !== "string")
      return err({ type: "PackOutput", directory: destination });
    return Result.fromThrowable(
      () => join(destination, filename),
      () => ({ type: "PackOutput" as const, directory: destination }),
    )();
  }
}

/** Applies version fields only to manifests below a scratch staging root. */
export function stageWithVersionOverrides(
  scratchDir: string,
  overrides: Readonly<Record<string, string>> | ScratchOverrideCarrier,
  options: { readonly channel?: StagingChannel } = {},
): ResultAsync<readonly OverrideProvenance[], PackagerError> {
  const channel = options.channel ?? "next";
  const channelResult = validateChannel(channel);
  if (channelResult.isErr()) return errAsync(channelResult.error);
  const carrier = normalizeCarrier(overrides);
  if (carrier.isErr()) return errAsync(carrier.error);
  const fields = definedCarrierFields(carrier.value);
  if (channel === "stable") {
    const stableError = stableOverrideError(fields);
    if (stableError !== undefined) return errAsync(stableError);
  }
  const versions = carrier.value.versionOverrides ?? {};
  let result = okAsync<readonly OverrideProvenance[], PackagerError>([]);
  for (const [packageName, version] of orderedEntries(versions)) {
    if (!Object.hasOwn(PUBLIC_PACKAGES, packageName))
      return errAsync({ type: "InvalidOverride", field: "packageName" });
    if (!SEMVER.test(version))
      return errAsync({ type: "InvalidOverride", field: "version" });
    const publicPackageName = packageName as PublicPackageName;
    const resolved = resolveStagedManifest(scratchDir, publicPackageName);
    result = result.andThen((records) =>
      resolved.andThen((manifestPath) =>
        readJsonFile(manifestPath).andThen((manifest) => {
          if (!isRecord(manifest))
            return errAsync({
              type: "InvalidOverride" as const,
              field: "manifest",
            });
          const sourceDigest = sha256Digest(canonicalJson(manifest));
          manifest.version = version;
          const contents = `${JSON.stringify(manifest, null, 2)}\n`;
          return writeFile(manifestPath, contents).map(() => {
            const stagedDigest = sha256Digest(contents);
            return [
              ...records,
              provenance(
                publicPackageName,
                "version",
                sourceDigest,
                stagedDigest,
              ),
            ];
          });
        }),
      ),
    );
  }
  const dependencyOverrides = carrier.value.dependencyRangeOverrides;
  if (dependencyOverrides !== undefined)
    result = result.andThen((records) =>
      stageWithDependencyRangeOverrides(scratchDir, dependencyOverrides, {
        channel,
      }).map((more) => [...records, ...more]),
    );
  const changelogOverrides = carrier.value.changelogOverrides ?? {};
  for (const [packageName, content] of orderedEntries(changelogOverrides)) {
    if (!Object.hasOwn(PUBLIC_PACKAGES, packageName))
      return errAsync({ type: "InvalidOverride", field: "packageName" });
    result = result.andThen((records) =>
      stageWithChangelogOverride(
        scratchDir,
        packageName as PublicPackageName,
        content,
        { channel },
      ).map((more) => [...records, more]),
    );
  }
  return result;
}

/** Applies dependency ranges only to scratch staging manifests. */
export function stageWithDependencyRangeOverrides(
  scratchDir: string,
  overrides: Readonly<Record<string, Readonly<Record<string, string>>>>,
  options: { readonly channel?: StagingChannel } = {},
): ResultAsync<readonly OverrideProvenance[], PackagerError> {
  const channel = options.channel ?? "next";
  const channelResult = validateChannel(channel);
  if (channelResult.isErr()) return errAsync(channelResult.error);
  if (!isDependencyOverrideMap(overrides))
    return errAsync({
      type: "InvalidOverride",
      field: "dependencyRangeOverrides",
    });
  const entries = orderedEntries(overrides);
  if (channel === "stable")
    return errAsync({
      type: "StableDependencyRangeOverrideRejected",
      packageName: entries.length === 1 ? entries[0]?.[0] : undefined,
    });
  let result = okAsync<readonly OverrideProvenance[], PackagerError>([]);
  for (const [packageName, ranges] of entries) {
    if (!Object.hasOwn(PUBLIC_PACKAGES, packageName))
      return errAsync({ type: "InvalidOverride", field: "packageName" });
    if (!isStringMap(ranges))
      return errAsync({
        type: "InvalidOverride",
        field: "dependencyRangeOverrides",
      });
    const publicPackageName = packageName as PublicPackageName;
    result = result.andThen((records) =>
      resolveStagedManifest(scratchDir, publicPackageName).andThen(
        (manifestPath) =>
          readJsonFile(manifestPath).andThen((manifest) => {
            if (!isRecord(manifest))
              return errAsync({
                type: "InvalidOverride" as const,
                field: "manifest",
              });
            const sourceDigest = sha256Digest(canonicalJson(manifest));
            const fields = [
              "dependencies",
              "optionalDependencies",
              "peerDependencies",
            ] as const;
            for (const field of fields) {
              const map = manifest[field];
              if (!isRecord(map)) continue;
              for (const [name, range] of Object.entries(ranges))
                if (typeof range !== "string" || range.length === 0)
                  return errAsync({
                    type: "InvalidOverride" as const,
                    field: "dependencyRangeOverrides",
                  });
                else if (name in map) map[name] = range;
            }
            const contents = `${JSON.stringify(manifest, null, 2)}\n`;
            return writeFile(manifestPath, contents).map(() => [
              ...records,
              provenance(
                publicPackageName,
                "dependency-range",
                sourceDigest,
                sha256Digest(contents),
              ),
            ]);
          }),
      ),
    );
  }
  return result;
}

/** Replaces one staged changelog, preserving every source changelog byte. */
export function stageWithChangelogOverride(
  scratchDir: string,
  packageName: PublicPackageName,
  content: string,
  options: { readonly channel?: StagingChannel } = {},
): ResultAsync<OverrideProvenance, PackagerError> {
  const channel = options.channel ?? "next";
  const channelResult = validateChannel(channel);
  if (channelResult.isErr()) return errAsync(channelResult.error);
  if (channel === "stable")
    return errAsync({
      type: "StableChangelogOverrideRejected",
      packageName,
    });
  if (typeof content !== "string")
    return errAsync({ type: "InvalidOverride", field: "changelog" });
  if (new TextEncoder().encode(content).byteLength === 0)
    return errAsync({ type: "InvalidOverride", field: "changelog" });
  return resolveStagedManifest(scratchDir, packageName).andThen(
    (manifestPath) => {
      const changelogPath = join(manifestPath, "..");
      const sourcePath = join(changelogPath, "CHANGELOG.md");
      return readFile(sourcePath).andThen((source) =>
        writeFile(sourcePath, content).map(() =>
          provenance(
            packageName,
            "changelog",
            sha256Digest(source),
            sha256Digest(content),
          ),
        ),
      );
    },
  );
}

/** Builds a binding-shaped digest record from detailed package output. */
export function buildReleaseStagingBinding(
  builtSha: string,
  records: readonly PackageStagingRecord[],
): Result<ReleaseStagingBinding, PackagerError> {
  if (!/^[0-9a-f]{40}$/.test(builtSha))
    return err({ type: "InvalidReleasedSha", value: builtSha });
  if (records.length === 0)
    return err({ type: "InvalidOverride", field: "records" });
  const ordered = [...records].sort((left, right) =>
    compareText(left.packageName, right.packageName),
  );
  if (
    ordered.some(
      (record, index) =>
        index > 0 && ordered[index - 1]?.packageName === record.packageName,
    )
  )
    return err({ type: "InvalidOverride", field: "records.packageName" });
  const bindingPaths = ordered.map((record) =>
    normalizeBindingPath(record.tarballPath),
  );
  if (new Set(bindingPaths).size !== bindingPaths.length)
    return err({ type: "InvalidOverride", field: "records.tarballPath" });
  return ok({
    schemaVersion: 1,
    builtSha,
    tarballs: ordered.map((record) => ({
      packageName: record.packageName,
      version: record.version,
      path: normalizeBindingPath(record.tarballPath),
      sha256: record.tarballSha256,
    })),
    fileDigests: ordered
      .flatMap((record) =>
        record.files.map((file) => ({
          packageName: record.packageName,
          path: file.path.replace(/^package\//, ""),
          size: file.size,
          digest: file.sha256,
        })),
      )
      .sort((left, right) =>
        compareText(
          `${left.packageName}\u0000${left.path}`,
          `${right.packageName}\u0000${right.path}`,
        ),
      ),
    manifestDigests: ordered.map((record) => ({
      packageName: record.packageName,
      stagedManifestDigest: record.stagedManifestDigest,
      publicManifestDigest: record.publicManifestDigest,
    })),
    changelogDigests: ordered.map((record) => ({
      packageName: record.packageName,
      version: record.version,
      documentDigest: record.stagedChangelogDigest,
    })),
    overrideDigests: ordered
      .flatMap((record) =>
        record.overrides.map((override) => ({
          packageName: override.packageName,
          kind: override.kind,
          sourceDigest: override.sourceDigest,
          stagedDigest: override.stagedDigest,
          digest: override.digest,
        })),
      )
      .sort((left, right) =>
        compareText(
          `${left.packageName}\u0000${left.kind}\u0000${left.digest}`,
          `${right.packageName}\u0000${right.kind}\u0000${right.digest}`,
        ),
      ),
    entryPointDigests: ordered
      .flatMap((record) => record.entryPointDigests)
      .sort((left, right) =>
        compareText(
          `${left.packageName}\u0000${left.entryPoint}`,
          `${right.packageName}\u0000${right.entryPoint}`,
        ),
      ),
    proofMarkers: {
      attestation: { status: "pending" },
      cleanConsumer: { status: "pending" },
      harnessProof: { status: "pending" },
      registryVerification: { status: "pending" },
    },
  });
}

if (import.meta.main) {
  const root = join(".release", `validate-${crypto.randomUUID()}`);
  const plannedVersions = parsePlannedVersions(
    Bun.env.RELEASE_PLANNED_VERSIONS,
  );
  const operation = Bun.env.RELEASE_OPERATION;
  const channel: StagingChannel = operation === "nightly" ? "nightly" : "next";
  const result = await new PublicPackagePackager(
    new BunPackageCommandRunner(),
    new PackagePolicyValidator(),
  ).packAll(root, plannedVersions, { channel });
  if (result.isErr()) {
    logger.error(result.error, "Public package validation failed");
    process.exitCode = 1;
  }
}

export function stablePackageVersions(
  versions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (versions === undefined) return undefined;
  const stable = Object.fromEntries(
    Object.entries(versions).filter(
      ([name]) =>
        name === "@weaveio/weave-cli" ||
        name === "@weaveio/weave-adapter-opencode",
    ),
  );
  return Object.keys(stable).length === 0 ? undefined : stable;
}

function parsePlannedVersions(
  value: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Result.fromThrowable(
    () => JSON.parse(value),
    () => undefined,
  )();
  if (parsed.isErr()) return undefined;
  const versions = z.record(z.string(), z.string()).safeParse(parsed.value);
  return versions.success ? versions.data : undefined;
}

function validateChannel(
  channel: string,
): Result<StagingChannel, PackagerError> {
  if (
    channel === "stable" ||
    channel === "next" ||
    channel === "nightly" ||
    channel === "candidate-readiness" ||
    channel === "bootstrap"
  )
    return ok(channel);
  return err({ type: "InvalidChannel", channel });
}

function purposeForChannel(channel: StagingChannel): ScratchChangelogPurpose {
  switch (channel) {
    case "next":
      return "next";
    case "nightly":
      return "nightly";
    case "candidate-readiness":
      return "candidate-readiness";
    case "bootstrap":
      return "bootstrap";
    case "stable":
      return "next";
  }
}

function definedCarrierFields(
  carrier: ScratchOverrideCarrier,
): readonly string[] {
  return [
    ...(carrier.versionOverrides === undefined ? [] : ["versionOverrides"]),
    ...(carrier.dependencyRangeOverrides === undefined
      ? []
      : ["dependencyRangeOverrides"]),
    ...(carrier.changelogOverrides === undefined ? [] : ["changelogOverrides"]),
  ];
}

function stableOverrideError(
  fields: readonly string[],
  packageName?: string,
): PackagerError | undefined {
  if (fields.length === 0) return undefined;
  if (fields.length > 1)
    return { type: "StableOverrideCarrierRejected", fields };
  switch (fields[0]) {
    case "versionOverrides":
      return { type: "StableVersionOverrideRejected", packageName };
    case "dependencyRangeOverrides":
      return { type: "StableDependencyRangeOverrideRejected", packageName };
    case "changelogOverrides":
      return { type: "StableChangelogOverrideRejected", packageName };
    default:
      return { type: "StableOverrideCarrierRejected", fields };
  }
}

function buildOverrideProvenance(
  packageName: PublicPackageName,
  sourceManifest: Uint8Array,
  sourceChangelog: Uint8Array,
  stagedManifest: Uint8Array,
  stagedChangelog: Uint8Array,
  options: {
    readonly channel: StagingChannel;
    readonly version?: string;
    readonly dependencyRanges?: Readonly<Record<string, string>>;
    readonly changelogOverride?: string;
  },
): readonly OverrideProvenance[] {
  const result: OverrideProvenance[] = [];
  if (options.version !== undefined)
    result.push(
      provenance(
        packageName,
        "version",
        sha256Digest(sourceManifest),
        sha256Digest(stagedManifest),
      ),
    );
  if (options.dependencyRanges !== undefined)
    result.push(
      provenance(
        packageName,
        "dependency-range",
        sha256Digest(sourceManifest),
        sha256Digest(stagedManifest),
      ),
    );
  if (
    options.changelogOverride === undefined &&
    options.channel !== "stable" &&
    sha256Digest(sourceChangelog) !== sha256Digest(stagedChangelog)
  )
    result.push(
      provenance(
        packageName,
        "changelog",
        sha256Digest(sourceChangelog),
        sha256Digest(stagedChangelog),
      ),
    );
  return result;
}

function provenance(
  packageName: PublicPackageName,
  kind: ScratchOverrideKind,
  sourceDigest: string,
  stagedDigest: string,
): OverrideProvenance {
  const digest = sha256Digest(
    canonicalJson({ kind, packageName, sourceDigest, stagedDigest }),
  );
  return { kind, packageName, sourceDigest, stagedDigest, digest };
}

function normalizeCarrier(
  overrides: Readonly<Record<string, string>> | ScratchOverrideCarrier,
): Result<ScratchOverrideCarrier, PackagerError> {
  if (!isRecord(overrides))
    return err({ type: "InvalidOverride", field: "carrier" });
  const known = [
    "versionOverrides",
    "dependencyRangeOverrides",
    "changelogOverrides",
  ];
  const keys = Object.keys(overrides);
  const carrierKeys = keys.filter((key) => known.includes(key));
  if (carrierKeys.length === 0) {
    if (!isStringMap(overrides))
      return err({ type: "InvalidOverride", field: "versionOverrides" });
    return ok({ versionOverrides: overrides });
  }
  if (carrierKeys.length !== keys.length)
    return err({ type: "InvalidOverride", field: "carrier" });
  const carrier = overrides as ScratchOverrideCarrier;
  if (
    carrier.versionOverrides !== undefined &&
    !isStringMap(carrier.versionOverrides)
  )
    return err({ type: "InvalidOverride", field: "versionOverrides" });
  if (
    carrier.dependencyRangeOverrides !== undefined &&
    !isDependencyOverrideMap(carrier.dependencyRangeOverrides)
  )
    return err({
      type: "InvalidOverride",
      field: "dependencyRangeOverrides",
    });
  if (
    carrier.changelogOverrides !== undefined &&
    !isStringMap(carrier.changelogOverrides)
  )
    return err({ type: "InvalidOverride", field: "changelogOverrides" });
  return ok({
    versionOverrides: carrier.versionOverrides,
    dependencyRangeOverrides: carrier.dependencyRangeOverrides,
    changelogOverrides: carrier.changelogOverrides,
  });
}

function resolveStagedManifest(
  scratchDir: string,
  packageName: string,
): ResultAsync<string, PackagerError> {
  if (!Object.hasOwn(PUBLIC_PACKAGES, packageName))
    return errAsync({ type: "InvalidOverride", field: "packageName" });
  const slug = packageName.replace("@weaveio/", "");
  const candidates = [
    join(scratchDir, "staging", slug, "package.json"),
    join(scratchDir, slug, "package.json"),
  ];
  return findExisting(candidates).andThen((path) =>
    path === undefined
      ? errAsync({
          type: "Filesystem" as const,
          path: candidates[0] ?? scratchDir,
          operation: "read" as const,
        })
      : okAsync(path),
  );
}

function findExisting(
  paths: readonly string[],
): ResultAsync<string | undefined, PackagerError> {
  let result = okAsync<string | undefined, PackagerError>(undefined);
  for (const path of paths) {
    result = result.andThen((found) =>
      found !== undefined
        ? okAsync(found)
        : ResultAsync.fromThrowable(
            () => Bun.file(path).exists(),
            () => ({
              type: "Filesystem" as const,
              path,
              operation: "read" as const,
            }),
          )().map((exists) => (exists ? path : undefined)),
    );
  }
  return result;
}

function readJsonFile(path: string): ResultAsync<unknown, PackagerError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).text(),
    () => ({
      type: "Filesystem" as const,
      path,
      operation: "read" as const,
    }),
  )().andThen((contents) => {
    const parsed = Result.fromThrowable(
      () => JSON.parse(contents) as unknown,
      () => ({ type: "InvalidOverride" as const, field: path }),
    )();
    return parsed.isErr() ? errAsync(parsed.error) : okAsync(parsed.value);
  });
}

function readFile(path: string): ResultAsync<Uint8Array, PackagerError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).bytes(),
    () => ({
      type: "Filesystem" as const,
      path,
      operation: "read" as const,
    }),
  )();
}

function writeFile(
  path: string,
  contents: string | Uint8Array,
): ResultAsync<void, PackagerError> {
  return ResultAsync.fromThrowable(
    () => Bun.write(path, contents),
    () => ({
      type: "Filesystem" as const,
      path,
      operation: "write" as const,
    }),
  )().map(() => undefined);
}

function orderedEntries<T>(
  value: Readonly<Record<string, T>>,
): readonly [string, T][] {
  return Object.entries(value).sort(([left], [right]) =>
    compareText(left, right),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortValue(value[key])]),
  );
}

function normalizeBindingPath(path: string): string {
  const cwd = resolve(process.cwd());
  const absolute = resolve(path);
  const relativePath = relative(cwd, absolute);
  if (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !relativePath.startsWith("/")
  )
    return relativePath;
  return basename(absolute);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function isStringMap(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isDependencyOverrideMap(
  value: unknown,
): value is Readonly<Record<string, Readonly<Record<string, string>>>> {
  return (
    isRecord(value) &&
    Object.values(value).every((ranges) => isStringMap(ranges))
  );
}

function manifestVersion(contents: Uint8Array): string | undefined {
  const parsed = Result.fromThrowable(
    () => JSON.parse(new TextDecoder().decode(contents)) as unknown,
    () => undefined,
  )();
  if (parsed.isErr() || !isRecord(parsed.value)) return undefined;
  const version = parsed.value.version;
  return typeof version === "string" ? version : undefined;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
