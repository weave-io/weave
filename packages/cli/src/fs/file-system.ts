import { dirname, resolve } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

export type FileSystemError = {
  type: "FileSystemError";
  operation: "exists" | "read" | "write" | "mkdir" | "copy";
  path: string;
  cause: unknown;
};

export interface FileSystem {
  exists(path: string): ResultAsync<boolean, FileSystemError>;
  readText(path: string): ResultAsync<string, FileSystemError>;
  writeText(path: string, content: string): ResultAsync<void, FileSystemError>;
  mkdir(path: string): ResultAsync<void, FileSystemError>;
  copyFile(from: string, to: string): ResultAsync<void, FileSystemError>;
  cwd(): string;
  home(): string;
  resolvePath(path: string): string;
}

function toError(
  operation: FileSystemError["operation"],
  path: string,
): (cause: unknown) => FileSystemError {
  return (cause) => ({ type: "FileSystemError", operation, path, cause });
}

export class BunFileSystem implements FileSystem {
  cwd(): string {
    return process.cwd();
  }

  home(): string {
    return process.env.HOME ?? "";
  }

  resolvePath(path: string): string {
    return resolve(path);
  }

  exists(path: string): ResultAsync<boolean, FileSystemError> {
    return ResultAsync.fromPromise(
      Bun.file(path).exists(),
      toError("exists", path),
    );
  }

  readText(path: string): ResultAsync<string, FileSystemError> {
    return ResultAsync.fromPromise(
      Bun.file(path).text(),
      toError("read", path),
    );
  }

  writeText(path: string, content: string): ResultAsync<void, FileSystemError> {
    return this.mkdir(dirname(path)).andThen(() =>
      ResultAsync.fromPromise(
        Bun.write(path, content).then(() => undefined),
        toError("write", path),
      ),
    );
  }

  mkdir(path: string): ResultAsync<void, FileSystemError> {
    return ResultAsync.fromPromise(
      Bun.$`mkdir -p ${path}`.quiet().then(() => undefined),
      toError("mkdir", path),
    );
  }

  copyFile(from: string, to: string): ResultAsync<void, FileSystemError> {
    return this.readText(from).andThen((content) =>
      this.writeText(to, content),
    );
  }
}

export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  constructor(
    initialFiles: Record<string, string> = {},
    private readonly currentDirectory = "/project",
    private readonly homeDirectory = "/home/user",
  ) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(resolve(path), content);
      this.dirs.add(dirname(resolve(path)));
    }
  }

  cwd(): string {
    return this.currentDirectory;
  }

  home(): string {
    return this.homeDirectory;
  }

  resolvePath(path: string): string {
    if (path.startsWith("~")) return resolve(this.homeDirectory, path.slice(2));
    return resolve(this.currentDirectory, path);
  }

  exists(path: string): ResultAsync<boolean, FileSystemError> {
    const resolved = this.resolvePath(path);
    return okAsync(this.files.has(resolved) || this.dirs.has(resolved));
  }

  readText(path: string): ResultAsync<string, FileSystemError> {
    const resolved = this.resolvePath(path);
    const content = this.files.get(resolved);
    if (content === undefined) {
      return errAsync({
        type: "FileSystemError",
        operation: "read",
        path: resolved,
        cause: "missing file",
      });
    }
    return okAsync(content);
  }

  writeText(path: string, content: string): ResultAsync<void, FileSystemError> {
    const resolved = this.resolvePath(path);
    this.dirs.add(dirname(resolved));
    this.files.set(resolved, content);
    return okAsync(undefined);
  }

  mkdir(path: string): ResultAsync<void, FileSystemError> {
    this.dirs.add(this.resolvePath(path));
    return okAsync(undefined);
  }

  copyFile(from: string, to: string): ResultAsync<void, FileSystemError> {
    return this.readText(from).andThen((content) =>
      this.writeText(to, content),
    );
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }
}
