import { join } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_RUNTIME_EXTERNALS,
  type PublicPackageBuild,
  type PublicPackageName,
} from "./release/constants.js";

export type PublicPackageBuildError =
  | {
      type: "BuildDiagnostics";
      packageName: PublicPackageName;
      diagnostics: string;
    }
  | { type: "Filesystem"; path: string; operation: "copy" | "mkdir" | "chmod" }
  | { type: "TypeDeclarations"; packageName: PublicPackageName };

export interface PublicPackageFileSystem {
  copyFile(
    source: string,
    destination: string,
  ): ResultAsync<void, PublicPackageBuildError>;
  ensureDirectory(path: string): ResultAsync<void, PublicPackageBuildError>;
  makeExecutable(path: string): ResultAsync<void, PublicPackageBuildError>;
}

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
}

/** Builds public entry points with workspace code inlined and approved runtime imports external. */
export class PublicPackageBuilder {
  constructor(private readonly fileSystem: PublicPackageFileSystem) {}

  buildAll(): ResultAsync<void, PublicPackageBuildError> {
    let result = okAsync<void, PublicPackageBuildError>(undefined);
    for (const packageName of Object.keys(
      PUBLIC_PACKAGE_BUILDS,
    ) as PublicPackageName[]) {
      result = result.andThen(() => this.build(packageName));
    }
    return result;
  }

  build(
    packageName: PublicPackageName,
  ): ResultAsync<void, PublicPackageBuildError> {
    const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
    return this.buildEntries(packageName, build.entries).andThen(() =>
      this.copyBootstrap(build.bootstrap),
    );
  }

  private buildEntries(
    packageName: PublicPackageName,
    entries: readonly {
      source: string;
      output: string;
      executable?: boolean;
    }[],
  ): ResultAsync<void, PublicPackageBuildError> {
    let result = okAsync<void, PublicPackageBuildError>(undefined);
    for (const entry of entries) {
      result = result.andThen(() =>
        ResultAsync.fromPromise(
          Bun.build({
            entrypoints: [entry.source],
            outdir: join(entry.output, ".."),
            target: "bun",
            format: "esm",
            external: [...PUBLIC_RUNTIME_EXTERNALS],
          }),
          () => ({
            type: "BuildDiagnostics" as const,
            packageName,
            diagnostics: "Bun.build rejected",
          }),
        ).andThen((result) => {
          if (result.success) return okAsync(undefined);
          return errAsync({
            type: "BuildDiagnostics" as const,
            packageName,
            diagnostics: result.logs.map((log) => log.message).join("\n"),
          });
        }),
      );
      if (entry.executable) {
        result = result.andThen(() =>
          this.fileSystem.makeExecutable(entry.output),
        );
      }
    }
    return result;
  }

  private copyBootstrap(
    files?: readonly string[],
  ): ResultAsync<void, PublicPackageBuildError> {
    if (files === undefined) return okAsync(undefined);
    const sourceRoot = "packages/adapters/claude-code/src/bootstrap";
    const destinations = [
      "packages/adapters/claude-code/dist/bootstrap",
      "packages/cli/dist/bootstrap",
    ];
    let result = okAsync<void, PublicPackageBuildError>(undefined);
    for (const destination of destinations) {
      for (const file of files) {
        const target = join(destination, file);
        result = result
          .andThen(() => this.fileSystem.ensureDirectory(join(target, "..")))
          .andThen(() =>
            this.fileSystem.copyFile(join(sourceRoot, file), target),
          );
      }
    }
    return result;
  }
}

const builder = new PublicPackageBuilder(new BunPublicPackageFileSystem());
const result = await builder.buildAll();
if (result.isErr()) process.exitCode = 1;
