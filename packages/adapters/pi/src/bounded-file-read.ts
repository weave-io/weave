import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";

/**
 * The stat surface required by an identity-bound regular-file read.
 *
 * The production reader supplies Bun's descriptor stat. Tests can supply a
 * hostile or changing implementation without touching the host filesystem.
 */
export interface BoundedFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The small Bun file surface needed by the bounded reader. */
export interface BoundedFile {
  stat(): Promise<BoundedFileStat>;
  slice(
    start: number,
    end: number,
  ): {
    arrayBuffer(): Promise<ArrayBuffer>;
  };
}

/** Closed outcomes for a bounded identity read. */
export type BoundedFileReadError =
  | "file-changed"
  | "file-too-large"
  | "not-regular"
  | "read-failed";

/** A stable descriptor-stat snapshot used for TOCTOU checks. */
export interface BoundedFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Capture only finite, bounded stat fields. */
export function captureBoundedFileIdentity(
  value: unknown,
): Result<BoundedFileIdentity, BoundedFileReadError> {
  if (typeof value !== "object" || value === null) {
    return err("read-failed");
  }
  const stat = value as Partial<BoundedFileStat>;
  if (
    typeof stat.isFile !== "function" ||
    typeof stat.isSymbolicLink !== "function"
  ) {
    return err("read-failed");
  }
  const isFile = stat.isFile();
  const isSymbolicLink = stat.isSymbolicLink();
  if (isFile !== true || isSymbolicLink !== false) {
    return err("not-regular");
  }
  if (
    !safeInteger(stat.dev) ||
    stat.dev < 0 ||
    !safeInteger(stat.ino) ||
    stat.ino < 0 ||
    !safeInteger(stat.mode) ||
    stat.mode < 0 ||
    !safeInteger(stat.nlink) ||
    stat.nlink < 0 ||
    !safeInteger(stat.size) ||
    stat.size < 0 ||
    !finiteNumber(stat.mtimeMs) ||
    stat.mtimeMs < 0
  ) {
    return err("read-failed");
  }
  return ok({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

export function sameBoundedFileIdentity(
  left: BoundedFileIdentity,
  right: BoundedFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function validLimit(maxBytes: number): boolean {
  return (
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 0 &&
    maxBytes < Number.MAX_SAFE_INTEGER
  );
}

/**
 * Read one descriptor-like file with a hard byte ceiling.
 *
 * The initial descriptor stat is checked before `slice().arrayBuffer()` is
 * called. The one extra byte is a growth sentinel. The final stat and exact
 * byte count reject truncation, replacement, and in-place metadata changes.
 */
export function readBoundedFileObject(
  file: BoundedFile,
  maxBytes: number,
): ResultAsync<Uint8Array, BoundedFileReadError> {
  const result = ResultAsync.fromThrowable(
    async (): Promise<Result<Uint8Array, BoundedFileReadError>> => {
      if (!validLimit(maxBytes)) return err("read-failed");

      const before = captureBoundedFileIdentity(await file.stat());
      if (before.isErr()) return err(before.error);
      if (before.value.size > maxBytes) return err("file-too-large");

      const contents = await file.slice(0, maxBytes + 1).arrayBuffer();
      if (!(contents instanceof ArrayBuffer)) return err("read-failed");
      if (contents.byteLength > maxBytes) return err("file-too-large");
      if (contents.byteLength !== before.value.size) {
        return err("file-changed");
      }

      const after = captureBoundedFileIdentity(await file.stat());
      if (after.isErr()) return err(after.error);
      if (!sameBoundedFileIdentity(before.value, after.value)) {
        return err("file-changed");
      }
      return ok(new Uint8Array(contents));
    },
    (): BoundedFileReadError => "read-failed",
  )();
  return result.andThen((settled) =>
    settled.isOk()
      ? okAsync(settled.value)
      : errAsync<Uint8Array, BoundedFileReadError>(settled.error),
  );
}
