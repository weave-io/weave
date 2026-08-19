/**
 * Deterministic GitHub-release notes: wrapper metadata plus a verbatim
 * changelog section.
 *
 * The wrapper is assembled from caller-supplied facts only — package, version,
 * install command, source comparison, tarball digest, and provenance URL — so
 * the same inputs always produce the same bytes. The changelog half is copied
 * from the merged `CHANGELOG.md` as it stands; this module never calls a
 * model and never rewrites prose.
 *
 * Nightly and `next` callers may pass a scratch changelog. The extractor still
 * selects by `## <version>` and copies that section byte-for-byte.
 */
import { err, ok, type Result } from "neverthrow";
import {
  NPM_DIGEST_PREFIX,
  type PublicPackageName,
  RELEASE_REPOSITORY,
} from "./constants.js";
import { resolvePublishablePackage } from "./package-policy.js";

/** Bounds so a notes body is never unbounded input. */
export const RELEASE_NOTES_LIMITS = {
  changelogBytes: 64 * 1024,
  sectionBytes: 32 * 1024,
  urlLength: 2_048,
} as const;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = new RegExp(`^${NPM_DIGEST_PREFIX}[0-9a-f]{64}$`);
const VERSION_HEADING = /^##[ \t]+(.+?)[ \t]*$/;

export type NotesWrapperError =
  | { type: "InvalidReleaseNotesPackage"; packageName: string }
  | { type: "InvalidReleaseNotesVersion"; field: "version" | "previousVersion" }
  | { type: "InvalidReleaseNotesSha"; sha: string }
  | { type: "InvalidReleaseNotesDigest"; digest: string }
  | { type: "ChangelogTooLarge"; bytes: number; limit: number }
  | { type: "ChangelogSectionMissing"; version: string }
  | { type: "DuplicateChangelogSection"; version: string }
  | { type: "ChangelogSectionEmpty"; version: string };

/** Facts the wrapper may mention. Nothing else is invented. */
export interface ReleaseNotesInput {
  packageName: PublicPackageName;
  version: string;
  /** Previous released version, used only for the compare URL. */
  previousVersion?: string;
  releasedSha: string;
  tarballSha256: string;
  /** Full changelog document or an already-sliced `## <version>` section. */
  changelog: string;
}

/**
 * Unscoped catalog name used in tags: `@weaveio/weave-cli` → `weave-cli`.
 */
export function unscopedPackageName(packageName: PublicPackageName): string {
  const parts = packageName.split("/");
  return parts[parts.length - 1] ?? packageName;
}

/** Stable tag and GitHub-release name: `<unscoped-name>@<version>`. */
export function releaseTagName(
  packageName: PublicPackageName,
  version: string,
): string {
  return `${unscopedPackageName(packageName)}@${version}`;
}

/** `bun add` is the install line every public package shares. */
export function releaseInstallCommand(
  packageName: PublicPackageName,
  version: string,
): string {
  return `bun add ${packageName}@${version}`;
}

/** Compare previous tag to this one, or fall back to the released commit. */
export function releaseSourceComparisonUrl(input: {
  packageName: PublicPackageName;
  version: string;
  previousVersion?: string;
  releasedSha: string;
}): string {
  const current = releaseTagName(input.packageName, input.version);
  if (input.previousVersion !== undefined)
    return `https://github.com/${RELEASE_REPOSITORY}/compare/${releaseTagName(input.packageName, input.previousVersion)}...${current}`;
  return `https://github.com/${RELEASE_REPOSITORY}/commit/${input.releasedSha}`;
}

/** npm package page where provenance for this version is published. */
export function releaseProvenanceUrl(
  packageName: PublicPackageName,
  version: string,
): string {
  return `https://www.npmjs.com/package/${packageName}/v/${version}`;
}

/**
 * Copies the `## <version>` section out of a changelog, including the hidden
 * ledger block. Trailing blank lines are dropped so the wrapper stays stable
 * when the document ends the file; interior bytes are untouched.
 */
export function extractChangelogSection(
  changelog: string,
  version: string,
): Result<string, NotesWrapperError> {
  if (changelog.length > RELEASE_NOTES_LIMITS.changelogBytes)
    return err({
      type: "ChangelogTooLarge",
      bytes: changelog.length,
      limit: RELEASE_NOTES_LIMITS.changelogBytes,
    });
  const lines = changelog.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    const match = VERSION_HEADING.exec(lines[index] ?? "");
    if (match === null) continue;
    if (match[1] === version) {
      if (start !== -1)
        return err({ type: "DuplicateChangelogSection", version });
      start = index;
      continue;
    }
    if (start !== -1) return finishSection(lines.slice(start, index), version);
  }
  if (start === -1) return err({ type: "ChangelogSectionMissing", version });
  return finishSection(lines.slice(start), version);
}

/**
 * Composes the GitHub-release body: labeled wrapper fields in a fixed order,
 * then the verbatim canonical section.
 */
export function composeReleaseNotes(
  input: ReleaseNotesInput,
): Result<string, NotesWrapperError> {
  const validated = validateNotesInput(input);
  if (validated.isErr()) return err(validated.error);
  const section = extractChangelogSection(input.changelog, input.version);
  if (section.isErr()) return err(section.error);
  const tag = releaseTagName(input.packageName, input.version);
  const body = [
    `# ${tag}`,
    "",
    `- Package: \`${input.packageName}\``,
    `- Version: \`${input.version}\``,
    `- Install: \`${releaseInstallCommand(input.packageName, input.version)}\``,
    `- Source: ${releaseSourceComparisonUrl(input)}`,
    `- Tarball digest: \`${input.tarballSha256}\``,
    `- Provenance: ${releaseProvenanceUrl(input.packageName, input.version)}`,
    "",
    section.value,
  ].join("\n");
  if (body.length > RELEASE_NOTES_LIMITS.sectionBytes)
    return err({
      type: "ChangelogTooLarge",
      bytes: body.length,
      limit: RELEASE_NOTES_LIMITS.sectionBytes,
    });
  return ok(body);
}

function validateNotesInput(
  input: ReleaseNotesInput,
): Result<void, NotesWrapperError> {
  const resolved = resolvePublishablePackage(input.packageName);
  if (resolved.isErr())
    return err({
      type: "InvalidReleaseNotesPackage",
      packageName: input.packageName,
    });
  if (!SEMVER.test(input.version))
    return err({ type: "InvalidReleaseNotesVersion", field: "version" });
  if (
    input.previousVersion !== undefined &&
    (!SEMVER.test(input.previousVersion) ||
      input.previousVersion === input.version)
  )
    return err({
      type: "InvalidReleaseNotesVersion",
      field: "previousVersion",
    });
  if (!FULL_SHA.test(input.releasedSha))
    return err({ type: "InvalidReleaseNotesSha", sha: input.releasedSha });
  if (!DIGEST.test(input.tarballSha256))
    return err({
      type: "InvalidReleaseNotesDigest",
      digest: input.tarballSha256,
    });
  return ok(undefined);
}

function finishSection(
  lines: readonly string[],
  version: string,
): Result<string, NotesWrapperError> {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  if (end <= 1) return err({ type: "ChangelogSectionEmpty", version });
  return ok(`${lines.slice(0, end).join("\n")}\n`);
}
