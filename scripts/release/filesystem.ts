import { ResultAsync } from "neverthrow";
import type { FileSystemError } from "./errors.js";

export interface FileSystem {
  exists(path: string): ResultAsync<boolean, FileSystemError>;
  readBytes(path: string): ResultAsync<Uint8Array, FileSystemError>;
  readText(path: string): ResultAsync<string, FileSystemError>;
  writeText(path: string, contents: string): ResultAsync<void, FileSystemError>;
  delete(path: string): ResultAsync<void, FileSystemError>;
}

export class BunFileSystem implements FileSystem {
  exists(path: string): ResultAsync<boolean, FileSystemError> {
    return ResultAsync.fromPromise(Bun.file(path).exists(), (cause) => ({
      type: "FileSystemError",
      path,
      message: String(cause),
    }));
  }
  readBytes(path: string): ResultAsync<Uint8Array, FileSystemError> {
    return ResultAsync.fromPromise(Bun.file(path).bytes(), (cause) => ({
      type: "FileSystemError",
      path,
      message: String(cause),
    }));
  }
  readText(path: string): ResultAsync<string, FileSystemError> {
    return ResultAsync.fromPromise(Bun.file(path).text(), (cause) => ({
      type: "FileSystemError",
      path,
      message: String(cause),
    }));
  }
  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, FileSystemError> {
    return ResultAsync.fromPromise(
      Bun.write(path, contents).then(() => {}),
      (cause) => ({ type: "FileSystemError", path, message: String(cause) }),
    );
  }
  delete(path: string): ResultAsync<void, FileSystemError> {
    return ResultAsync.fromPromise(Bun.file(path).delete(), (cause) => ({
      type: "FileSystemError",
      path,
      message: String(cause),
    }));
  }
}
