import { logger } from "@weaveio/weave-engine";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import {
  PRIVATE_PACKAGE_NAMES,
  type PrivatePackageName,
  PUBLIC_PACKAGES,
  type PublicPackageName,
  type ReleaseChannel,
} from "./constants.js";

export const CHANGESET_BUMPS = ["patch", "minor", "major"] as const;
export type ChangesetBump = (typeof CHANGESET_BUMPS)[number];

/** Public artifacts that bundle each private workspace's source. */
export const PRIVATE_SOURCE_IMPACTS = {
  "@weaveio/weave-core": [
    "@weaveio/weave-cli",
    "@weaveio/weave-adapter-opencode",
    "@weaveio/weave-adapter-claude-code",
    "@weaveio/weave-adapter-pi",
  ],
  "@weaveio/weave-engine": [
    "@weaveio/weave-cli",
    "@weaveio/weave-adapter-opencode",
    "@weaveio/weave-adapter-claude-code",
    "@weaveio/weave-adapter-pi",
  ],
  "@weaveio/weave-config": [
    "@weaveio/weave-cli",
    "@weaveio/weave-adapter-opencode",
    "@weaveio/weave-adapter-pi",
  ],
} as const satisfies Record<PrivatePackageName, readonly PublicPackageName[]>;

/** A package is releasable when the canonical catalog publishes or bundles it. */
export function isKnownPackage(packageName: string): boolean {
  return (
    packageName in PUBLIC_PACKAGES ||
    PRIVATE_PACKAGE_NAMES.includes(packageName as PrivatePackageName)
  );
}

/** Nightly-only artifacts cannot ride a stable cut, so they never share a file. */
export function isNightlyOnly(packageName: PublicPackageName): boolean {
  const channels: readonly ReleaseChannel[] =
    PUBLIC_PACKAGES[packageName].channels;
  return !channels.includes("stable");
}

export type ChangesetPolicyError =
  | { type: "Filesystem"; path: string; operation: "list" | "read" }
  | { type: "MalformedFrontmatter"; path: string; reason: string }
  | { type: "UnknownPackage"; path: string; packageName: string }
  | { type: "UnknownBump"; path: string; packageName: string; bump: string }
  | { type: "PrivateTarget"; path: string; packageName: PrivatePackageName }
  | {
      type: "MissingPublicImpact";
      path: string;
      source: PrivatePackageName;
      packageName: PublicPackageName;
    }
  | { type: "MixedChannels"; path: string };

export interface ChangesetFileSystem {
  listMarkdown(
    directory: string,
  ): ResultAsync<readonly string[], ChangesetPolicyError>;
  readText(path: string): ResultAsync<string, ChangesetPolicyError>;
}

export class BunChangesetFileSystem implements ChangesetFileSystem {
  listMarkdown(
    directory: string,
  ): ResultAsync<readonly string[], ChangesetPolicyError> {
    return ResultAsync.fromPromise(
      Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: directory })).then(
        (files) =>
          files
            .filter((file) => file !== "README.md")
            .map((file) => `${directory}/${file}`),
      ),
      () => ({
        type: "Filesystem" as const,
        path: directory,
        operation: "list" as const,
      }),
    );
  }

  readText(path: string): ResultAsync<string, ChangesetPolicyError> {
    return ResultAsync.fromPromise(Bun.file(path).text(), () => ({
      type: "Filesystem" as const,
      path,
      operation: "read" as const,
    }));
  }
}

export interface ParsedChangeset {
  path: string;
  releases: ReadonlyMap<string, ChangesetBump>;
}

export interface ChangesetPartition {
  stableFiles: readonly string[];
  remainOnMainFiles: readonly string[];
}

/** Enumerates the files a stable cut consumes; nightly-only files remain on main. */
export function partitionChangesets(
  changesets: readonly ParsedChangeset[],
): ChangesetPartition {
  const stableFiles: string[] = [];
  const remainOnMainFiles: string[] = [];
  for (const changeset of changesets) {
    const targets = [...changeset.releases.keys()] as PublicPackageName[];
    const isStableOnly = targets.every(
      (target) => !(target in PUBLIC_PACKAGES) || !isNightlyOnly(target),
    );
    if (isStableOnly) stableFiles.push(changeset.path);
    else remainOnMainFiles.push(changeset.path);
  }
  return { stableFiles, remainOnMainFiles };
}

export class ChangesetPolicyValidator {
  constructor(private readonly fileSystem: ChangesetFileSystem) {}

  validateDirectory(
    directory: string,
  ): ResultAsync<ChangesetPartition, readonly ChangesetPolicyError[]> {
    return this.fileSystem
      .listMarkdown(directory)
      .andThen((paths) => {
        let loaded: ResultAsync<
          { changesets: ParsedChangeset[]; errors: ChangesetPolicyError[] },
          ChangesetPolicyError
        > = okAsync({ changesets: [], errors: [] });
        for (const path of paths)
          loaded = loaded.andThen((changesets) =>
            this.fileSystem.readText(path).map((contents) => {
              const parsed = this.parse(path, contents);
              if (parsed.isErr())
                return {
                  ...changesets,
                  errors: [...changesets.errors, parsed.error],
                };
              return {
                ...changesets,
                changesets: [...changesets.changesets, parsed.value],
              };
            }),
          );
        return loaded.andThen((loadedChangesets) => {
          if (loadedChangesets.errors.length > 0)
            return err(loadedChangesets.errors);
          return this.validate(loadedChangesets.changesets);
        });
      })
      .mapErr((error) => (Array.isArray(error) ? error : [error]));
  }

  parse(
    path: string,
    contents: string,
  ): Result<ParsedChangeset, ChangesetPolicyError> {
    return parseFrontmatter(path, contents).map((releases) => ({
      path,
      releases,
    }));
  }

  validate(
    changesets: readonly ParsedChangeset[],
  ): Result<ChangesetPartition, readonly ChangesetPolicyError[]> {
    const errors: ChangesetPolicyError[] = [];
    for (const changeset of changesets) {
      const parsed = this.validateReleases(changeset);
      errors.push(...parsed);
    }
    if (errors.length > 0) return err(errors);
    return ok(partitionChangesets(changesets));
  }

  private validateReleases(changeset: ParsedChangeset): ChangesetPolicyError[] {
    const errors: ChangesetPolicyError[] = [];
    for (const [packageName, bump] of changeset.releases) {
      if (!isKnownPackage(packageName)) {
        errors.push({
          type: "UnknownPackage",
          path: changeset.path,
          packageName,
        });
        continue;
      }
      if (!CHANGESET_BUMPS.includes(bump))
        errors.push({
          type: "UnknownBump",
          path: changeset.path,
          packageName,
          bump,
        });
      if (!PRIVATE_PACKAGE_NAMES.includes(packageName as PrivatePackageName))
        continue;
      const source = packageName as PrivatePackageName;
      errors.push({
        type: "PrivateTarget",
        path: changeset.path,
        packageName: source,
      });
      for (const impact of PRIVATE_SOURCE_IMPACTS[source])
        if (!changeset.releases.has(impact))
          errors.push({
            type: "MissingPublicImpact",
            path: changeset.path,
            source,
            packageName: impact,
          });
    }
    const publicTargets = [...changeset.releases.keys()].filter(
      (target): target is PublicPackageName => target in PUBLIC_PACKAGES,
    );
    const includesNightlyOnly = publicTargets.some(isNightlyOnly);
    const includesStable = publicTargets.some(
      (target) => !isNightlyOnly(target),
    );
    if (includesNightlyOnly && includesStable)
      errors.push({ type: "MixedChannels", path: changeset.path });
    return errors;
  }
}

function parseFrontmatter(
  path: string,
  contents: string,
): Result<ReadonlyMap<string, ChangesetBump>, ChangesetPolicyError> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (match === null)
    return err({
      type: "MalformedFrontmatter",
      path,
      reason: "Expected YAML delimiters",
    });
  const releases = new Map<string, ChangesetBump>();
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^"([^"]+)":\s*(\S+)\s*$/.exec(line);
    if (entry === null)
      return err({
        type: "MalformedFrontmatter",
        path,
        reason: "Expected quoted package and bump",
      });
    const packageName = entry[1] ?? "";
    const bump = entry[2] ?? "";
    if (releases.has(packageName))
      return err({
        type: "MalformedFrontmatter",
        path,
        reason: "Duplicate package target",
      });
    if (!CHANGESET_BUMPS.includes(bump as ChangesetBump))
      return err({ type: "UnknownBump", path, packageName, bump });
    releases.set(packageName, bump as ChangesetBump);
  }
  if (releases.size === 0)
    return err({
      type: "MalformedFrontmatter",
      path,
      reason: "Expected at least one release",
    });
  return ok(releases);
}

if (import.meta.main) {
  const result = await new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateDirectory(".changeset");
  result.match(
    () => logger.info("Changeset policy passed"),
    (errors) => {
      for (const error of errors)
        logger.error(error, "Changeset policy failed");
      process.exitCode = 1;
    },
  );
}
