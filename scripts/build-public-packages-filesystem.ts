import { join } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { PI_EXTENSION_IDENTITY_SOURCE } from "./build-public-packages-pi.js";
import type {
  PublicPackageBuildError,
  PublicPackageFileSystem,
} from "./build-public-packages-shared.js";

/** Bun-only filesystem operations required to assemble public package outputs. */
export class BunPublicPackageFileSystem implements PublicPackageFileSystem {
  copyFile(
    source: string,
    destination: string,
  ): ResultAsync<void, PublicPackageBuildError> {
    return ResultAsync.fromPromise(Bun.file(source).arrayBuffer(), () => ({
      type: "Filesystem" as const,
      path: source,
      operation: "copy" as const,
    })).andThen((contents) =>
      ResultAsync.fromPromise(Bun.write(destination, contents), () => ({
        type: "Filesystem" as const,
        path: destination,
        operation: "copy" as const,
      })).map(() => undefined),
    );
  }

  ensureDirectory(path: string): ResultAsync<void, PublicPackageBuildError> {
    return this.run(["mkdir", "-p", path], path, "mkdir");
  }

  makeExecutable(path: string): ResultAsync<void, PublicPackageBuildError> {
    return this.run(["chmod", "755", path], path, "chmod");
  }

  listDeclarationFiles(
    directory: string,
  ): ResultAsync<readonly string[], PublicPackageBuildError> {
    return ResultAsync.fromPromise(
      this.scanDeclarationFiles(directory),
      () => ({
        type: "Filesystem" as const,
        path: directory,
        operation: "list" as const,
      }),
    );
  }

  listPiBuildInputFiles(): ResultAsync<
    readonly string[],
    PublicPackageBuildError
  > {
    return ResultAsync.fromPromise(this.scanPiBuildInputFiles(), () => ({
      type: "Filesystem" as const,
      path: "packages/adapters/pi/src",
      operation: "list" as const,
    }));
  }

  readText(path: string): ResultAsync<string, PublicPackageBuildError> {
    return ResultAsync.fromPromise(Bun.file(path).text(), () => ({
      type: "Filesystem" as const,
      path,
      operation: "copy" as const,
    }));
  }

  removeFile(path: string): ResultAsync<void, PublicPackageBuildError> {
    return ResultAsync.fromPromise(Bun.file(path).delete(), () => ({
      type: "Filesystem" as const,
      path,
      operation: "delete" as const,
    }));
  }

  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, PublicPackageBuildError> {
    return ResultAsync.fromPromise(Bun.write(path, contents), () => ({
      type: "Filesystem" as const,
      path,
      operation: "write" as const,
    })).map(() => undefined);
  }

  private run(
    command: string[],
    path: string,
    operation: "mkdir" | "chmod",
  ): ResultAsync<void, PublicPackageBuildError> {
    return ResultAsync.fromPromise(Bun.spawn(command).exited, () => ({
      type: "Filesystem" as const,
      path,
      operation,
    })).andThen((exitCode) => {
      if (exitCode === 0) return okAsync(undefined);
      return errAsync({ type: "Filesystem" as const, path, operation });
    });
  }

  private async scanDeclarationFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for await (const path of new Bun.Glob("**/*.d.ts").scan({
      cwd: directory,
    })) {
      files.push(join(directory, path));
    }
    return files;
  }

  private async scanPiBuildInputFiles(): Promise<string[]> {
    const files: string[] = [];
    for await (const path of new Bun.Glob(
      "packages/adapters/pi/src/**/*.ts",
    ).scan({ onlyFiles: true })) {
      if (
        path.includes("/__tests__/") ||
        path.includes("/__fixtures__/") ||
        path.endsWith(".test.ts") ||
        path.endsWith(".spec.ts")
      ) {
        continue;
      }
      files.push(path);
    }
    files.push(PI_EXTENSION_IDENTITY_SOURCE);
    return [...new Set(files)].sort();
  }
}
