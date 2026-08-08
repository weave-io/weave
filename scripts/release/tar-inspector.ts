import { err, ok, Result } from "neverthrow";
import { PACKAGE_ARCHIVE_LIMITS } from "./constants.js";

export type TarInspectionError =
  | { type: "ArchiveTooLarge"; size: number }
  | { type: "InvalidGzip" }
  | { type: "ArchiveBomb"; compressedBytes: number; unpackedBytes: number }
  | { type: "TooManyEntries"; count: number }
  | { type: "InvalidHeader"; offset: number }
  | { type: "UnsafePath"; path: string }
  | { type: "DuplicateEntry"; path: string }
  | { type: "UnsupportedEntry"; path: string; entryType: string }
  | { type: "InvalidSize"; path: string };

export interface TarEntry {
  path: string;
  mode: number;
  size: number;
  type: string;
  contents: Uint8Array;
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
