import { resolve } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

export type ProbeError = {
  type: "ProbeError";
  operation: "exists" | "readable" | "which" | "version";
  path: string;
  cause: unknown;
};

export interface DetectionProbes {
  exists(path: string): ResultAsync<boolean, ProbeError>;
  readable(path: string): ResultAsync<boolean, ProbeError>;
  binaryOnPath(binary: string): ResultAsync<string | undefined, ProbeError>;
  readVersion(binary: string): ResultAsync<string | undefined, ProbeError>;
  resolvePath(path: string): string;
  home(): string;
}

function probeError(
  operation: ProbeError["operation"],
  path: string,
): (cause: unknown) => ProbeError {
  return (cause) => ({ type: "ProbeError", operation, path, cause });
}

export class BunDetectionProbes implements DetectionProbes {
  home(): string {
    return Bun.env.HOME ?? "/tmp";
  }

  resolvePath(path: string): string {
    if (path === "~") return this.home();
    if (path.startsWith("~/")) return resolve(this.home(), path.slice(2));
    return resolve(path);
  }

  exists(path: string): ResultAsync<boolean, ProbeError> {
    const target = this.resolvePath(path);
    return ResultAsync.fromPromise(
      Bun.file(target).exists(),
      probeError("exists", target),
    );
  }

  readable(path: string): ResultAsync<boolean, ProbeError> {
    const target = this.resolvePath(path);
    return ResultAsync.fromPromise(
      Bun.file(target)
        .text()
        .then(() => true)
        .catch(() => false),
      probeError("readable", target),
    );
  }

  binaryOnPath(binary: string): ResultAsync<string | undefined, ProbeError> {
    return ResultAsync.fromPromise(
      Bun.$`command -v ${binary}`
        .quiet()
        .text()
        .then((value) => value.trim() || undefined)
        .catch(() => undefined),
      probeError("which", binary),
    );
  }

  readVersion(binary: string): ResultAsync<string | undefined, ProbeError> {
    return ResultAsync.fromPromise(
      Bun.$`${binary} --version`
        .quiet()
        .text()
        .then((value) => value.trim().split("\n")[0] || undefined)
        .catch(() => undefined),
      probeError("version", binary),
    );
  }
}

export class MemoryDetectionProbes implements DetectionProbes {
  readonly writes: string[] = [];

  constructor(
    private readonly options: {
      home?: string;
      files?: Record<string, { readable?: boolean }>;
      binaries?: Record<string, string>;
      versions?: Record<string, string>;
    } = {},
  ) {}

  home(): string {
    return this.options.home ?? "/home/user";
  }

  resolvePath(path: string): string {
    if (path === "~") return this.home();
    if (path.startsWith("~/")) return resolve(this.home(), path.slice(2));
    return resolve(path);
  }

  exists(path: string): ResultAsync<boolean, ProbeError> {
    const target = this.resolvePath(path);
    return okAsync(this.options.files?.[target] !== undefined);
  }

  readable(path: string): ResultAsync<boolean, ProbeError> {
    const target = this.resolvePath(path);
    const file = this.options.files?.[target];
    if (file === undefined) return okAsync(false);
    return okAsync(file.readable ?? true);
  }

  binaryOnPath(binary: string): ResultAsync<string | undefined, ProbeError> {
    return okAsync(this.options.binaries?.[binary]);
  }

  readVersion(binary: string): ResultAsync<string | undefined, ProbeError> {
    return okAsync(this.options.versions?.[binary]);
  }

  createDirectory(path: string): ResultAsync<void, ProbeError> {
    this.writes.push(path);
    return errAsync({
      type: "ProbeError",
      operation: "exists",
      path,
      cause: "detection must not write",
    });
  }
}
