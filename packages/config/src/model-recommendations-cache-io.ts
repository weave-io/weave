/**
 * File and shell access for the model recommendations cache (Spec 39,
 * "Cache").
 *
 * `ModelRecommendations` takes both interfaces as injected dependencies, so
 * its tests run against an in-memory cache. The Bun implementations here are
 * the production defaults:
 *
 * - Files go through `Bun.file()` and `Bun.write()`.
 * - Moves, directories and removal go through Bun Shell (`import { $ } from
 *   "bun"`). Its builtin `mv` is a `rename(2)` within one directory, so a
 *   reader sees the old file or the new one, never a partial write; its
 *   `mkdir` without `-p` fails when the directory exists, which is what makes
 *   `lock/` exclusive. `model-recommendations-cache-io.test.ts` pins both on a
 *   real disk.
 */

import { $ } from "bun";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

/** A cache operation that failed on the filesystem. */
export interface CacheIoError {
  readonly type: "CacheIoError";
  readonly operation:
    | "exists"
    | "read"
    | "write"
    | "stat"
    | "move"
    | "mkdir"
    | "remove";
  readonly path: string;
  readonly message: string;
}

/** Reading and writing cache files. */
export interface ModelRecommendationsFiles {
  /** True when a file is at `path`. */
  exists(path: string): ResultAsync<boolean, CacheIoError>;
  /** The text of the file at `path`. */
  read(path: string): ResultAsync<string, CacheIoError>;
  /**
   * Write `text` to `path`, replacing it. Not atomic: the cache writes a
   * temporary file with this and moves it into place.
   */
  write(path: string, text: string): ResultAsync<void, CacheIoError>;
  /**
   * Last modification of a file or directory, in epoch milliseconds;
   * `undefined` when nothing is there.
   */
  modifiedAt(path: string): ResultAsync<number | undefined, CacheIoError>;
}

/** The shell operations the cache's atomicity and locking rest on. */
export interface ModelRecommendationsShell {
  /** Rename `from` to `to` in the same directory, replacing `to`. */
  move(from: string, to: string): ResultAsync<void, CacheIoError>;
  /**
   * Create one directory, exclusively: `true` when this call created it,
   * `false` when it already existed. Any other failure is an error.
   */
  makeDir(path: string): ResultAsync<boolean, CacheIoError>;
  /** Create a directory and its parents; succeeds when it already exists. */
  makeDirs(path: string): ResultAsync<void, CacheIoError>;
  /** Remove a file or a directory tree; succeeds when nothing is there. */
  remove(path: string): ResultAsync<void, CacheIoError>;
}

function ioError(
  operation: CacheIoError["operation"],
  path: string,
): (cause: unknown) => CacheIoError {
  return (cause) => ({
    type: "CacheIoError",
    operation,
    path,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

/** What the shell commands return that the cache looks at. */
interface ShellOutput {
  readonly exitCode: number;
  readonly stderr: Buffer;
}

/** `ModelRecommendationsFiles` backed by `Bun.file()` and `Bun.write()`. */
export class BunModelRecommendationsFiles implements ModelRecommendationsFiles {
  exists(path: string): ResultAsync<boolean, CacheIoError> {
    return ResultAsync.fromPromise(
      Bun.file(path).exists(),
      ioError("exists", path),
    );
  }

  read(path: string): ResultAsync<string, CacheIoError> {
    return ResultAsync.fromPromise(
      Bun.file(path).text(),
      ioError("read", path),
    );
  }

  write(path: string, text: string): ResultAsync<void, CacheIoError> {
    return ResultAsync.fromPromise(
      Bun.write(path, text),
      ioError("write", path),
    ).map(() => undefined);
  }

  modifiedAt(path: string): ResultAsync<number | undefined, CacheIoError> {
    return ResultAsync.fromPromise(
      Bun.file(path)
        .stat()
        .then(
          (stats): number | undefined => stats.mtimeMs,
          (cause: unknown) => {
            if (isMissing(cause)) return undefined;
            return Promise.reject(cause);
          },
        ),
      ioError("stat", path),
    );
  }
}

/** `ModelRecommendationsShell` backed by Bun Shell builtins. */
export class BunModelRecommendationsShell implements ModelRecommendationsShell {
  constructor(
    private readonly files: ModelRecommendationsFiles = new BunModelRecommendationsFiles(),
  ) {}

  move(from: string, to: string): ResultAsync<void, CacheIoError> {
    return this.run("move", to, () => $`mv ${from} ${to}`.nothrow().quiet());
  }

  makeDir(path: string): ResultAsync<boolean, CacheIoError> {
    return ResultAsync.fromPromise(
      $`mkdir ${path}`.nothrow().quiet(),
      ioError("mkdir", path),
    ).andThen((output) => {
      if (output.exitCode === 0) return okAsync<boolean, CacheIoError>(true);
      // `mkdir` failed: the directory is held when something is there now;
      // otherwise it failed for another reason, such as a missing parent.
      const stderr = output.stderr.toString().trim();
      return this.files.modifiedAt(path).andThen((mtime) => {
        if (mtime !== undefined) return okAsync<boolean, CacheIoError>(false);
        return errAsync<boolean, CacheIoError>(
          ioError("mkdir", path)(stderr || "mkdir failed"),
        );
      });
    });
  }

  makeDirs(path: string): ResultAsync<void, CacheIoError> {
    return this.run("mkdir", path, () => $`mkdir -p ${path}`.nothrow().quiet());
  }

  remove(path: string): ResultAsync<void, CacheIoError> {
    return this.run("remove", path, () => $`rm -rf ${path}`.nothrow().quiet());
  }

  private run(
    operation: CacheIoError["operation"],
    path: string,
    command: () => Promise<ShellOutput>,
  ): ResultAsync<void, CacheIoError> {
    return ResultAsync.fromPromise(command(), ioError(operation, path)).andThen(
      (output) => {
        if (output.exitCode === 0)
          return okAsync<void, CacheIoError>(undefined);
        const stderr = output.stderr.toString().trim();
        return errAsync<void, CacheIoError>(
          ioError(operation, path)(stderr || `exit code ${output.exitCode}`),
        );
      },
    );
  }
}
