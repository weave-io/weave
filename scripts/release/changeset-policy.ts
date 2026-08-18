/**
 * Changeset policy for the trunk-based release pipeline.
 *
 * A changeset file has one of two shapes.
 *
 * A **public-impact changeset** names only public packages in its frontmatter
 * and leads its body with a user-impact summary line:
 *
 * ```md
 * ---
 * "@weaveio/weave-cli": minor
 * ---
 *
 * Reject an unknown adapter name instead of writing a partial plugin.
 *
 * Breaking: `weave compose --target` is now `weave compose --adapter`.
 *
 * Bundled-source: @weaveio/weave-engine
 * ```
 *
 * An **empty changeset** declares no release and states why the change needs
 * no version bump:
 *
 * ```md
 * ---
 * ---
 *
 * Reason: contributor documentation only; no published artifact changes.
 * ```
 *
 * The rules:
 *
 * - Frontmatter names only the four public packages. A private workspace is
 *   context through `Bundled-source:`, never a bump target.
 * - Pre-1.0 mapping: a breaking change or a feature declares `minor`, a fix
 *   declares `patch`. `major` is rejected.
 * - A breaking change declares an explicit `Breaking:` line. Prose that
 *   mentions breakage without that marker is rejected.
 * - A `Bundled-source:` declaration names every public artifact that bundles
 *   the private workspace, per `PRIVATE_SOURCE_IMPACTS`.
 * - Every public-impact change carries a changeset, or a reasoned empty
 *   changeset. `requireChangesetCoverage` decides that from the changed paths.
 *
 * Downstream release stages identify a changeset by `{ id, sourceDigest }`:
 * the filename stem plus the SHA-256 of the exact file bytes.
 */
import { logger } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  PRIVATE_PACKAGE_NAMES,
  type PrivatePackageName,
  PUBLIC_PACKAGES,
  type PublicPackageName,
} from "./constants.js";

/** Bump words a changeset file may spell. `major` parses, then fails policy. */
export const CHANGESET_BUMPS = ["patch", "minor", "major"] as const;
export type ChangesetBump = (typeof CHANGESET_BUMPS)[number];

/** The only bumps a pre-1.0 changeset may declare. */
export const PRE_RELEASE_BUMPS = ["patch", "minor"] as const;
export type PreReleaseBump = (typeof PRE_RELEASE_BUMPS)[number];

/** What a change does to the public surface, before it becomes a bump. */
export const CHANGE_KINDS = ["breaking", "feature", "fix"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Pre-1.0 mapping: breaking and feature raise minor, a fix raises patch. */
export function bumpForChangeKind(kind: ChangeKind): PreReleaseBump {
  return kind === "fix" ? "patch" : "minor";
}

/** Body lines that carry contract meaning instead of prose. */
export const CHANGESET_MARKERS = [
  "Breaking",
  "Bundled-source",
  "Reason",
] as const;
export type ChangesetMarker = (typeof CHANGESET_MARKERS)[number];

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

/** Where each bundled private workspace's source lives. */
export const PRIVATE_SOURCE_DIRECTORIES = {
  "@weaveio/weave-core": "packages/core",
  "@weaveio/weave-config": "packages/config",
  "@weaveio/weave-engine": "packages/engine",
} as const satisfies Record<PrivatePackageName, string>;

export type ChangesetPolicyError =
  | { type: "Filesystem"; path: string; operation: "list" | "read" }
  | { type: "MalformedFrontmatter"; path: string; reason: string }
  | { type: "UnknownPackage"; path: string; packageName: string }
  | { type: "UnknownBump"; path: string; packageName: string; bump: string }
  | { type: "PrivateTarget"; path: string; packageName: PrivatePackageName }
  | { type: "MajorBumpRejected"; path: string; packageName: PublicPackageName }
  | {
      type: "BreakingBumpMismatch";
      path: string;
      packageName: PublicPackageName;
      bump: ChangesetBump;
    }
  | { type: "MissingSummary"; path: string }
  | { type: "UnmarkedBreakingChange"; path: string }
  | { type: "MissingEmptyReason"; path: string }
  | { type: "UnexpectedMarker"; path: string; marker: ChangesetMarker }
  | { type: "UnknownBundledSource"; path: string; source: string }
  | {
      type: "MissingPublicImpact";
      path: string;
      source: PrivatePackageName;
      packageName: PublicPackageName;
    }
  | { type: "MissingChangeset"; packages: readonly PublicPackageName[] }
  | {
      type: "UncoveredImpact";
      packageName: PublicPackageName;
      source: PrivatePackageName | null;
    };

/** Stable release-wide identity of one changeset file. */
export interface ChangesetIdentity {
  /** The filename stem, stable while the file lives on `main`. */
  id: string;
  /** Lowercase SHA-256 hex over the exact file bytes. */
  sourceDigest: string;
}

export interface PublicImpactChangeset {
  kind: "public-impact";
  identity: ChangesetIdentity;
  path: string;
  summary: string;
  releases: ReadonlyMap<PublicPackageName, PreReleaseBump>;
  breaking: string | null;
  bundledSources: readonly PrivatePackageName[];
}

export interface EmptyChangeset {
  kind: "empty";
  identity: ChangesetIdentity;
  path: string;
  reason: string;
}

export type ValidatedChangeset = PublicImpactChangeset | EmptyChangeset;

/** Every public artifact a set of changed paths can alter. */
export interface PublicImpact {
  packages: readonly PublicPackageName[];
  bundledSources: readonly PrivatePackageName[];
}

export type ChangedPathImpact =
  | { kind: "public"; packageName: PublicPackageName }
  | { kind: "bundled"; source: PrivatePackageName }
  | { kind: "none" };

/**
 * Legacy frontmatter-only view, consumed by the stable-train and nightly
 * planners that the release-pipeline replacement removes.
 *
 * @deprecated Use {@link ValidatedChangeset}.
 */
export interface ParsedChangeset {
  path: string;
  releases: ReadonlyMap<string, ChangesetBump>;
}

/**
 * Legacy stable/nightly file split. The trunk-based pipeline consumes a single
 * pending set, so nothing produces this shape any more.
 *
 * @deprecated Removed with the old stable-train modules.
 */
export interface ChangesetPartition {
  stableFiles: readonly string[];
  remainOnMainFiles: readonly string[];
}

export interface ChangesetFileSystem {
  listMarkdown(
    directory: string,
  ): ResultAsync<readonly string[], ChangesetPolicyError>;
  readBytes(path: string): ResultAsync<Uint8Array, ChangesetPolicyError>;
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

  readBytes(path: string): ResultAsync<Uint8Array, ChangesetPolicyError> {
    return ResultAsync.fromPromise(Bun.file(path).bytes(), () => ({
      type: "Filesystem" as const,
      path,
      operation: "read" as const,
    }));
  }

  /** @deprecated Text view for the legacy planners; digests need the bytes. */
  readText(path: string): ResultAsync<string, ChangesetPolicyError> {
    return this.readBytes(path).map((bytes) => decodeSource(bytes));
  }
}

/** Derives the identity every downstream release stage stores and compares. */
export function deriveChangesetIdentity(
  path: string,
  source: Uint8Array,
): ChangesetIdentity {
  const fileName = path.split("/").pop() ?? path;
  const id = fileName.endsWith(".md")
    ? fileName.slice(0, -".md".length)
    : fileName;
  return {
    id,
    sourceDigest: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
  };
}

/** Maps one changed repository path to the artifacts it can alter. */
export function classifyChangedPath(path: string): ChangedPathImpact {
  const normalized = path.replace(/^\.\//, "");
  if (isNonArtifactPath(normalized)) return { kind: "none" };
  for (const [packageName, metadata] of Object.entries(PUBLIC_PACKAGES))
    if (normalized.startsWith(`${metadata.directory}/`))
      return { kind: "public", packageName: packageName as PublicPackageName };
  for (const [source, directory] of Object.entries(PRIVATE_SOURCE_DIRECTORIES))
    if (normalized.startsWith(`${directory}/`))
      return { kind: "bundled", source: source as PrivatePackageName };
  return { kind: "none" };
}

/** Expands changed paths into every public artifact they can alter. */
export function collectPublicImpact(
  changedPaths: readonly string[],
): PublicImpact {
  const packages = new Set<PublicPackageName>();
  const bundledSources = new Set<PrivatePackageName>();
  for (const path of changedPaths) {
    const impact = classifyChangedPath(path);
    if (impact.kind === "public") packages.add(impact.packageName);
    if (impact.kind !== "bundled") continue;
    bundledSources.add(impact.source);
    for (const affected of PRIVATE_SOURCE_IMPACTS[impact.source])
      packages.add(affected);
  }
  return { packages: [...packages], bundledSources: [...bundledSources] };
}

/**
 * Decides whether a change carries the changeset the release pipeline needs.
 *
 * Callers pass the paths the change touches and the changesets it adds. A
 * change with no public impact needs nothing; every other change needs either a
 * public-impact changeset that names each affected artifact, or a reasoned
 * empty changeset.
 */
export function requireChangesetCoverage(input: {
  changedPaths: readonly string[];
  changesets: readonly ValidatedChangeset[];
}): Result<PublicImpact, readonly ChangesetPolicyError[]> {
  const impact = collectPublicImpact(input.changedPaths);
  if (impact.packages.length === 0) return ok(impact);
  if (input.changesets.length === 0)
    return err([{ type: "MissingChangeset", packages: impact.packages }]);
  const releasing = input.changesets.filter(
    (changeset): changeset is PublicImpactChangeset =>
      changeset.kind === "public-impact",
  );
  if (releasing.length === 0) return ok(impact);
  const released = new Set(
    releasing.flatMap((changeset) => [...changeset.releases.keys()]),
  );
  const errors: ChangesetPolicyError[] = [];
  for (const path of input.changedPaths) {
    const classified = classifyChangedPath(path);
    if (classified.kind === "none") continue;
    if (classified.kind === "public") {
      if (!released.has(classified.packageName))
        errors.push({
          type: "UncoveredImpact",
          packageName: classified.packageName,
          source: null,
        });
      continue;
    }
    for (const packageName of PRIVATE_SOURCE_IMPACTS[classified.source])
      if (!released.has(packageName))
        errors.push({
          type: "UncoveredImpact",
          packageName,
          source: classified.source,
        });
  }
  if (errors.length > 0) return err(dedupeErrors(errors));
  return ok(impact);
}

export class ChangesetPolicyValidator {
  constructor(private readonly fileSystem: ChangesetFileSystem) {}

  validateDirectory(
    directory: string,
  ): ResultAsync<
    readonly ValidatedChangeset[],
    readonly ChangesetPolicyError[]
  > {
    return this.fileSystem
      .listMarkdown(directory)
      .mapErr((error): readonly ChangesetPolicyError[] => [error])
      .andThen((paths) => this.loadAll([...paths].sort()));
  }

  validateFile(
    path: string,
    source: Uint8Array,
  ): Result<ValidatedChangeset, readonly ChangesetPolicyError[]> {
    const identity = deriveChangesetIdentity(path, source);
    return parseDocument(path, decodeSource(source))
      .mapErr((error): readonly ChangesetPolicyError[] => [error])
      .andThen((document) => validateDocument(path, identity, document));
  }

  /**
   * Legacy frontmatter-only parse for the old planners.
   *
   * @deprecated Use {@link ChangesetPolicyValidator.validateFile}.
   */
  parse(
    path: string,
    contents: string,
  ): Result<ParsedChangeset, ChangesetPolicyError> {
    return parseDocument(path, contents).map((document) => ({
      path,
      releases: document.releases,
    }));
  }

  private loadAll(
    paths: readonly string[],
  ): ResultAsync<
    readonly ValidatedChangeset[],
    readonly ChangesetPolicyError[]
  > {
    let loaded: ResultAsync<LoadState, readonly ChangesetPolicyError[]> =
      okAsync({ changesets: [], errors: [] });
    for (const path of paths)
      loaded = loaded.andThen((state) =>
        this.fileSystem
          .readBytes(path)
          .mapErr((error): readonly ChangesetPolicyError[] => [error])
          .map((source) =>
            mergeLoadState(state, this.validateFile(path, source)),
          ),
      );
    return loaded.andThen((state) =>
      state.errors.length > 0
        ? errAsync(state.errors)
        : okAsync(state.changesets),
    );
  }
}

interface LoadState {
  changesets: readonly ValidatedChangeset[];
  errors: readonly ChangesetPolicyError[];
}

interface ChangesetDocument {
  releases: ReadonlyMap<string, ChangesetBump>;
  body: readonly string[];
}

interface ChangesetBody {
  summary: string | null;
  breaking: string | null;
  reason: string | null;
  bundledSources: readonly string[];
  mentionsBreaking: boolean;
}

function mergeLoadState(
  state: LoadState,
  validated: Result<ValidatedChangeset, readonly ChangesetPolicyError[]>,
): LoadState {
  if (validated.isErr())
    return { ...state, errors: [...state.errors, ...validated.error] };
  return { ...state, changesets: [...state.changesets, validated.value] };
}

function decodeSource(source: Uint8Array): string {
  return new TextDecoder().decode(source).replace(/^\uFEFF/, "");
}

function isNonArtifactPath(path: string): boolean {
  if (/(^|\/)(__tests__|__fixtures__|__mocks__)\//.test(path)) return true;
  if (/\.(test|spec|bench)\.[cm]?tsx?$/.test(path)) return true;
  const fileName = path.split("/").pop() ?? "";
  return fileName === "AGENTS.md" || fileName === "CHANGELOG.md";
}

function dedupeErrors(
  errors: readonly ChangesetPolicyError[],
): readonly ChangesetPolicyError[] {
  const seen = new Map<string, ChangesetPolicyError>();
  for (const error of errors) seen.set(JSON.stringify(error), error);
  return [...seen.values()];
}

function parseDocument(
  path: string,
  contents: string,
): Result<ChangesetDocument, ChangesetPolicyError> {
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---")
    return err({
      type: "MalformedFrontmatter",
      path,
      reason: "Expected an opening --- delimiter",
    });
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end === -1)
    return err({
      type: "MalformedFrontmatter",
      path,
      reason: "Expected a closing --- delimiter",
    });
  const releases = new Map<string, ChangesetBump>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const entry = /^"([^"]+)":[ \t]*(\S+)[ \t]*$/.exec(line);
    if (entry === null)
      return err({
        type: "MalformedFrontmatter",
        path,
        reason: "Expected a quoted package name and a bump",
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
  return ok({ releases, body: lines.slice(end + 1) });
}

function readBody(lines: readonly string[]): ChangesetBody {
  const bundledSources: string[] = [];
  let summary: string | null = null;
  let breaking: string | null = null;
  let reason: string | null = null;
  let mentionsBreaking = false;
  let sawProse = false;
  for (const line of lines) {
    const marker = readMarker(line);
    if (marker?.marker === "Breaking") breaking ??= marker.value;
    if (marker?.marker === "Bundled-source") bundledSources.push(marker.value);
    if (marker?.marker === "Reason") reason ??= marker.value;
    if (marker !== null) continue;
    if (/breaking/i.test(line)) mentionsBreaking = true;
    if (line.trim() === "" || sawProse) continue;
    sawProse = true;
    if (!/^[-*#>]/.test(line.trim())) summary = line.trim();
  }
  return { summary, breaking, reason, bundledSources, mentionsBreaking };
}

function readMarker(
  line: string,
): { marker: ChangesetMarker; value: string } | null {
  for (const marker of CHANGESET_MARKERS) {
    const match = new RegExp(`^${marker}:[ \\t]+(\\S.*)$`).exec(line);
    if (match !== null) return { marker, value: (match[1] ?? "").trim() };
  }
  return null;
}

function validateDocument(
  path: string,
  identity: ChangesetIdentity,
  document: ChangesetDocument,
): Result<ValidatedChangeset, readonly ChangesetPolicyError[]> {
  const body = readBody(document.body);
  if (document.releases.size === 0) return validateEmpty(path, identity, body);
  const errors: ChangesetPolicyError[] = [];
  const releases = new Map<PublicPackageName, PreReleaseBump>();
  for (const [packageName, bump] of document.releases) {
    if (PRIVATE_PACKAGE_NAMES.includes(packageName as PrivatePackageName)) {
      errors.push({
        type: "PrivateTarget",
        path,
        packageName: packageName as PrivatePackageName,
      });
      continue;
    }
    if (!(packageName in PUBLIC_PACKAGES)) {
      errors.push({ type: "UnknownPackage", path, packageName });
      continue;
    }
    const target = packageName as PublicPackageName;
    if (bump === "major") {
      errors.push({ type: "MajorBumpRejected", path, packageName: target });
      continue;
    }
    if (body.breaking !== null && bump !== "minor")
      errors.push({
        type: "BreakingBumpMismatch",
        path,
        packageName: target,
        bump,
      });
    releases.set(target, bump);
  }
  if (body.reason !== null)
    errors.push({ type: "UnexpectedMarker", path, marker: "Reason" });
  if (body.summary === null) errors.push({ type: "MissingSummary", path });
  if (body.breaking === null && body.mentionsBreaking)
    errors.push({ type: "UnmarkedBreakingChange", path });
  const bundledSources: PrivatePackageName[] = [];
  for (const source of body.bundledSources) {
    if (!PRIVATE_PACKAGE_NAMES.includes(source as PrivatePackageName)) {
      errors.push({ type: "UnknownBundledSource", path, source });
      continue;
    }
    const known = source as PrivatePackageName;
    bundledSources.push(known);
    for (const packageName of PRIVATE_SOURCE_IMPACTS[known])
      if (!releases.has(packageName))
        errors.push({
          type: "MissingPublicImpact",
          path,
          source: known,
          packageName,
        });
  }
  if (errors.length > 0) return err(errors);
  return ok({
    kind: "public-impact",
    identity,
    path,
    summary: body.summary ?? "",
    releases,
    breaking: body.breaking,
    bundledSources,
  });
}

function validateEmpty(
  path: string,
  identity: ChangesetIdentity,
  body: ChangesetBody,
): Result<ValidatedChangeset, readonly ChangesetPolicyError[]> {
  const errors: ChangesetPolicyError[] = [];
  if (body.reason === null) errors.push({ type: "MissingEmptyReason", path });
  if (body.breaking !== null)
    errors.push({ type: "UnexpectedMarker", path, marker: "Breaking" });
  if (body.bundledSources.length > 0)
    errors.push({ type: "UnexpectedMarker", path, marker: "Bundled-source" });
  if (errors.length > 0) return err(errors);
  return ok({ kind: "empty", identity, path, reason: body.reason ?? "" });
}

if (import.meta.main) {
  const result = await new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateDirectory(".changeset");
  result.match(
    (changesets) =>
      logger.info({ changesets: changesets.length }, "Changeset policy passed"),
    (errors) => {
      for (const error of errors)
        logger.error(error, "Changeset policy failed");
      process.exitCode = 1;
    },
  );
}
