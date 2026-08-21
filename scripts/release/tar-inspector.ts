import { err, ok, Result } from "neverthrow";
import {
  PACKAGE_ARCHIVE_LIMITS,
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  type PublicPackageName,
} from "./constants.js";

export type TarInspectionError =
  | { type: "ArchiveTooLarge"; size: number }
  | { type: "InvalidGzip" }
  | { type: "ArchiveBomb"; compressedBytes: number; unpackedBytes: number }
  | { type: "TooManyEntries"; count: number }
  | { type: "InvalidHeader"; offset: number }
  | { type: "UnsafePath"; path: string }
  | { type: "DuplicateEntry"; path: string }
  | { type: "UnsupportedEntry"; path: string; entryType: string }
  | { type: "InvalidSize"; path: string }
  | { type: "MissingFile"; path: string }
  | { type: "UnexpectedFile"; path: string }
  | { type: "StubReadme"; path: string }
  | { type: "StubChangelog"; path: string }
  | { type: "InvalidManifest"; path: string }
  | { type: "UnexpectedPackage"; packageName: string }
  | { type: "StagedManifestMismatch"; path: string }
  | { type: "StagedChangelogMismatch"; path: string };

export interface TarEntry {
  path: string;
  mode: number;
  size: number;
  type: string;
  contents: Uint8Array;
}

export interface TarFileDigest {
  /** Archive path, including the `package/` npm archive prefix. */
  path: string;
  size: number;
  sha256: string;
}

export interface PublicPackageInventory {
  packageName: PublicPackageName;
  entries: readonly TarEntry[];
  files: readonly TarFileDigest[];
  tarballSha256: string;
  stagedManifestDigest: string;
  stagedChangelogDigest: string;
  entryPointDigests: readonly {
    packageName: PublicPackageName;
    entryPoint: string;
    digest: string;
  }[];
  manifest: Readonly<Record<string, unknown>>;
}

/** Parses a gzip tar archive entirely in memory and never writes archive paths. */
export class TarInspector {
  inspect(
    archive: Uint8Array,
  ): Result<readonly TarEntry[], TarInspectionError> {
    if (archive.byteLength > PACKAGE_ARCHIVE_LIMITS.compressedBytes) {
      return err({ type: "ArchiveTooLarge", size: archive.byteLength });
    }
    if (archive.byteLength < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      return err({ type: "InvalidGzip" });
    }
    const advertisedSize = new DataView(
      archive.buffer,
      archive.byteOffset + archive.byteLength - 4,
      4,
    ).getUint32(0, true);
    if (advertisedSize > PACKAGE_ARCHIVE_LIMITS.unpackedBytes) {
      return err({
        type: "ArchiveBomb",
        compressedBytes: archive.byteLength,
        unpackedBytes: advertisedSize,
      });
    }
    const decompressed = Result.fromThrowable(
      () => Bun.gunzipSync(new Uint8Array(archive)),
      () => ({ type: "InvalidGzip" as const }),
    )();
    if (decompressed.isErr()) return err(decompressed.error);
    if (
      decompressed.value.byteLength > PACKAGE_ARCHIVE_LIMITS.unpackedBytes ||
      decompressed.value.byteLength >
        archive.byteLength * PACKAGE_ARCHIVE_LIMITS.compressionRatio
    ) {
      return err({
        type: "ArchiveBomb",
        compressedBytes: archive.byteLength,
        unpackedBytes: decompressed.value.byteLength,
      });
    }
    return this.parse(decompressed.value);
  }

  /**
   * Validates the complete public-package inventory and records every digest
   * needed by the release-plan binding. `inspect()` remains the lower-level
   * archive parser for callers that only need safe tar entries.
   */
  inspectPublicPackage(
    archive: Uint8Array,
    expectedPackageName?: PublicPackageName,
  ): Result<PublicPackageInventory, TarInspectionError> {
    return this.inspect(archive).andThen(
      (entries): Result<PublicPackageInventory, TarInspectionError> => {
        const manifestEntry = entries.find(
          (entry) => entry.path === "package/package.json",
        );
        if (manifestEntry === undefined)
          return err({ type: "MissingFile", path: "package/package.json" });
        const parsed = Result.fromThrowable(
          () =>
            JSON.parse(
              new TextDecoder().decode(manifestEntry.contents),
            ) as unknown,
          () => ({
            type: "InvalidManifest" as const,
            path: manifestEntry.path,
          }),
        )();
        if (parsed.isErr()) return err(parsed.error);
        if (!isRecord(parsed.value) || typeof parsed.value.name !== "string")
          return err({ type: "InvalidManifest", path: manifestEntry.path });
        const packageName = parsed.value.name;
        if (!Object.hasOwn(PUBLIC_PACKAGES, packageName))
          return err({ type: "UnexpectedPackage", packageName });
        if (
          expectedPackageName !== undefined &&
          expectedPackageName !== packageName
        )
          return err({ type: "UnexpectedPackage", packageName });

        const publicPackage = packageName as PublicPackageName;
        const inventory = expectedInventory(publicPackage);
        const actual = new Set(entries.map((entry) => entry.path));
        for (const path of actual)
          if (!inventory.has(path))
            return err({ type: "UnexpectedFile", path });
        for (const path of inventory)
          if (!actual.has(path)) return err({ type: "MissingFile", path });

        const readme = entries.find(
          (entry) => entry.path === "package/README.md",
        );
        if (readme === undefined)
          return err({ type: "MissingFile", path: "package/README.md" });
        if (!isUsefulDocument(readme.contents))
          return err({ type: "StubReadme", path: readme.path });
        const changelog = entries.find(
          (entry) => entry.path === "package/CHANGELOG.md",
        );
        if (changelog === undefined)
          return err({ type: "MissingFile", path: "package/CHANGELOG.md" });
        if (!isUsefulDocument(changelog.contents))
          return err({ type: "StubChangelog", path: changelog.path });

        for (const entry of entries) {
          const expectedMode =
            entry.path === "package/dist/main.js" ? 0o755 : 0o644;
          if (entry.mode !== expectedMode)
            return err({ type: "UnexpectedFile", path: entry.path });
        }
        const files = entries
          .map((entry) => ({
            path: entry.path,
            size: entry.size,
            sha256: sha256Digest(entry.contents),
          }))
          .sort((left, right) => compareText(left.path, right.path));
        const entryPointDigests = PUBLIC_PACKAGE_BUILDS[publicPackage].entries
          .map((entry) => {
            const entryPoint = `package/${entry.output.slice(
              PUBLIC_PACKAGES[publicPackage].directory.length + 1,
            )}`;
            const packed = files.find((file) => file.path === entryPoint);
            return packed === undefined
              ? undefined
              : {
                  packageName: publicPackage,
                  entryPoint: entryPoint.slice("package/".length),
                  digest: packed.sha256,
                };
          })
          .filter(
            (
              entry,
            ): entry is {
              packageName: PublicPackageName;
              entryPoint: string;
              digest: string;
            } => entry !== undefined,
          );
        return ok({
          packageName: publicPackage,
          entries,
          files,
          tarballSha256: sha256Digest(archive),
          stagedManifestDigest: sha256Digest(manifestEntry.contents),
          stagedChangelogDigest: sha256Digest(changelog.contents),
          entryPointDigests,
          manifest: parsed.value,
        });
      },
    );
  }

  /** Compatibility spellings used by release callers and policy tests. */
  inspectPackage(
    archive: Uint8Array,
    expectedPackageName?: PublicPackageName,
  ): Result<PublicPackageInventory, TarInspectionError> {
    return this.inspectPublicPackage(archive, expectedPackageName);
  }

  inspectInventory(
    archive: Uint8Array,
    expectedPackageName?: PublicPackageName,
  ): Result<PublicPackageInventory, TarInspectionError> {
    return this.inspectPublicPackage(archive, expectedPackageName);
  }

  validatePublicPackage(
    archive: Uint8Array,
    expectedPackageName?: PublicPackageName,
  ): Result<PublicPackageInventory, TarInspectionError> {
    return this.inspectPublicPackage(archive, expectedPackageName);
  }

  private parse(
    contents: Uint8Array,
  ): Result<readonly TarEntry[], TarInspectionError> {
    const entries: TarEntry[] = [];
    const names = new Set<string>();
    let offset = 0;
    while (offset + 512 <= contents.byteLength) {
      const header = contents.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) return ok(entries);
      const path = this.string(header, 0, 100);
      const prefix = this.string(header, 345, 155);
      const entryPath = prefix.length === 0 ? path : `${prefix}/${path}`;
      const size = this.octal(header, 124, 12);
      const mode = this.octal(header, 100, 8);
      if (size === undefined || mode === undefined)
        return err({ type: "InvalidHeader", offset });
      if (!isSafePath(entryPath))
        return err({ type: "UnsafePath", path: entryPath });
      if (names.has(entryPath))
        return err({ type: "DuplicateEntry", path: entryPath });
      const type = String.fromCharCode(header[156] ?? 0);
      if (type !== "\0" && type !== "0")
        return err({
          type: "UnsupportedEntry",
          path: entryPath,
          entryType: type,
        });
      const dataStart = offset + 512;
      const next = dataStart + Math.ceil(size / 512) * 512;
      if (next > contents.byteLength)
        return err({ type: "InvalidSize", path: entryPath });
      entries.push({
        path: entryPath,
        mode,
        size,
        type,
        contents: contents.slice(dataStart, dataStart + size),
      });
      names.add(entryPath);
      if (entries.length > PACKAGE_ARCHIVE_LIMITS.entries)
        return err({ type: "TooManyEntries", count: entries.length });
      offset = next;
    }
    return err({ type: "InvalidHeader", offset });
  }

  private string(bytes: Uint8Array, start: number, length: number): string {
    return new TextDecoder()
      .decode(bytes.subarray(start, start + length))
      .replace(/\0.*$/s, "");
  }

  private octal(
    bytes: Uint8Array,
    start: number,
    length: number,
  ): number | undefined {
    const value = this.string(bytes, start, length).trim();
    if (!/^[0-7]*$/.test(value)) return undefined;
    return Number.parseInt(value || "0", 8);
  }
}

export function expectedPublicPackageInventory(
  packageName: PublicPackageName,
): readonly string[] {
  return [...expectedInventory(packageName)].sort(compareText);
}

export function sha256Digest(value: Uint8Array | string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

function expectedInventory(packageName: PublicPackageName): Set<string> {
  const build = PUBLIC_PACKAGE_BUILDS[packageName];
  const directory = PUBLIC_PACKAGES[packageName].directory;
  const files = new Set([
    "package/package.json",
    "package/README.md",
    "package/CHANGELOG.md",
    "package/LICENSE",
  ]);
  for (const entry of build.entries)
    files.add(`package/${entry.output.slice(directory.length + 1)}`);
  for (const declaration of build.declarations)
    files.add(`package/${declaration.output.slice(directory.length + 1)}`);
  if ("bootstrap" in build && build.bootstrap !== undefined)
    for (const file of build.bootstrap)
      files.add(`package/dist/bootstrap/${file}`);
  if ("extraFiles" in build && build.extraFiles !== undefined)
    for (const file of build.extraFiles) files.add(`package/${file}`);
  return files;
}

function isUsefulDocument(contents: Uint8Array): boolean {
  const text = new TextDecoder().decode(contents).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const firstHeading = lines.findIndex((line) => /^\s*#\s+\S/.test(line));
  if (firstHeading === -1) return text.trim().length > 0;
  const body = lines
    .slice(firstHeading + 1)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .trim();
  return body.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isSafePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\"))
    return false;
  if (
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return false;
  return path
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}
