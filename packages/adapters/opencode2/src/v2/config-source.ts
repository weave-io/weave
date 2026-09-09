import { posix } from "node:path";
import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import type {
  PromptFileReader,
  PromptFileReadFailure,
} from "@weaveio/weave-engine";
import { err, ok, type Result, ResultAsync } from "neverthrow";

export const MAX_CATALOG_SOURCE_COUNT = 64;
export const MAX_CATALOG_SOURCE_BYTES = 4 * 1024 * 1024;

export interface CatalogSourceEntry {
  readonly path: string;
  readonly exists: boolean;
  readonly bytes?: number;
  readonly sha256?: string;
}

export type CatalogSourceIoError = {
  readonly path: string;
  readonly message: string;
};
type SourceText = {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
};

export interface CatalogSourceIo {
  exists(path: string): Promise<boolean>;
  readBytes(path: string): ResultAsync<Uint8Array, CatalogSourceIoError>;
}

export class BunCatalogSourceIo implements CatalogSourceIo {
  exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  }

  readBytes(path: string): ResultAsync<Uint8Array, CatalogSourceIoError> {
    return ResultAsync.fromThrowable(
      async () => {
        const file = Bun.file(path);
        if (file.size > MAX_CATALOG_SOURCE_BYTES)
          throw new Error("source exceeds byte limit");
        return new Uint8Array(await file.arrayBuffer());
      },
      (): CatalogSourceIoError => ({
        path,
        message: "source could not be read",
      }),
    )();
  }
}

/** Compare a prior exact-byte manifest without re-running composition. */
export function probeCatalogSources(
  sources: readonly CatalogSourceEntry[],
  io: CatalogSourceIo = new BunCatalogSourceIo(),
): ResultAsync<boolean, CatalogSourceIoError> {
  const compare = async (): Promise<Result<boolean, CatalogSourceIoError>> => {
    if (sources.length > MAX_CATALOG_SOURCE_COUNT) {
      return err({
        path: "<catalog>",
        message: "catalog source count exceeds limit",
      });
    }
    let totalBytes = 0;
    for (const source of sources) {
      const exists = await ResultAsync.fromThrowable(
        () => io.exists(source.path),
        (): CatalogSourceIoError => ({
          path: source.path,
          message: "source existence could not be checked",
        }),
      )();
      if (exists.isErr()) return err(exists.error);
      if (exists.value !== source.exists) return ok(true);
      if (!exists.value) continue;

      const bytes = await io.readBytes(source.path);
      if (bytes.isErr()) return err(bytes.error);
      totalBytes += bytes.value.byteLength;
      if (
        bytes.value.byteLength > MAX_CATALOG_SOURCE_BYTES ||
        totalBytes > MAX_CATALOG_SOURCE_BYTES
      ) {
        return err({
          path: source.path,
          message: "catalog source bytes exceed limit",
        });
      }
      const hash = new Bun.CryptoHasher("sha256")
        .update(bytes.value)
        .digest("hex");
      if (bytes.value.byteLength !== source.bytes || hash !== source.sha256)
        return ok(true);
    }
    return ok(false);
  };
  return ResultAsync.fromSafePromise(compare()).andThen((result) => result);
}

function readExactText(
  path: string,
  io: CatalogSourceIo,
): ResultAsync<SourceText, CatalogSourceIoError> {
  return io.readBytes(path).andThen((bytes) =>
    ResultAsync.fromThrowable(
      async () => {
        if (bytes.byteLength > MAX_CATALOG_SOURCE_BYTES)
          throw new Error("source exceeds byte limit");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const sha256 = new Bun.CryptoHasher("sha256")
          .update(bytes)
          .digest("hex");
        return { text, bytes: bytes.byteLength, sha256 };
      },
      (): CatalogSourceIoError => ({
        path,
        message: "source could not be read as UTF-8",
      }),
    )(),
  );
}

/** One exact-byte cache for config and prompt reads in a catalog attempt. */
export class CatalogSourceCache {
  readonly configReader: FileReader;
  readonly promptReader: PromptFileReader;
  private readonly records = new Map<string, CatalogSourceEntry>();
  private readonly reads = new Map<
    string,
    ResultAsync<SourceText, CatalogSourceIoError>
  >();
  private totalBytes = 0;
  private limitMessage: string | undefined;
  private sourceError: CatalogSourceIoError | undefined;
  private readonly projectConfigPath: string;

  constructor(
    location: string,
    private readonly projectConfig: boolean,
    private readonly io: CatalogSourceIo = new BunCatalogSourceIo(),
  ) {
    this.projectConfigPath = posix.join(location, ".weave", "config.weave");
    this.configReader = {
      exists: (path) => this.exists(path),
      read: (path) =>
        this.read(path).mapErr(
          (cause): ConfigLoadError => ({
            type: "FileReadError",
            path,
            cause,
          }),
        ),
    };
    this.promptReader = {
      read: (path) =>
        this.read(path).mapErr(
          (): PromptFileReadFailure => ({
            message: "prompt source could not be read",
          }),
        ),
    };
  }

  manifest(): readonly CatalogSourceEntry[] {
    return [...this.records.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  limitError(): string | undefined {
    return this.limitMessage;
  }

  ioError(): CatalogSourceIoError | undefined {
    return this.sourceError;
  }

  private async exists(path: string): Promise<boolean> {
    if (!this.projectConfig && path === this.projectConfigPath) {
      this.record(path, { path, exists: false });
      return false;
    }
    const exists = await ResultAsync.fromThrowable(
      () => this.io.exists(path),
      (): CatalogSourceIoError => ({
        path,
        message: "source existence could not be checked",
      }),
    )();
    if (exists.isErr()) {
      this.sourceError ??= exists.error;
      this.record(path, { path, exists: false });
      return false;
    }
    this.record(path, { path, exists: exists.value });
    return exists.value;
  }

  private read(path: string): ResultAsync<string, CatalogSourceIoError> {
    const cached = this.reads.get(path);
    if (cached !== undefined) return cached.map((value) => value.text);
    const pending = readExactText(path, this.io).map((value) => {
      this.totalBytes += value.bytes;
      if (this.totalBytes > MAX_CATALOG_SOURCE_BYTES)
        this.limitMessage = "catalog source bytes exceed the supported limit";
      this.record(path, {
        path,
        exists: true,
        bytes: value.bytes,
        sha256: value.sha256,
      });
      return value;
    });
    this.reads.set(path, pending);
    return pending.map((value) => value.text);
  }

  private record(path: string, entry: CatalogSourceEntry): void {
    if (
      !this.records.has(path) &&
      this.records.size >= MAX_CATALOG_SOURCE_COUNT
    ) {
      this.limitMessage = "catalog source count exceeds the supported limit";
      return;
    }
    this.records.set(path, entry);
  }
}
