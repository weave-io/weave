import { join, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import {
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  type PublicPackageBuild,
  type PublicPackageName,
} from "./constants.js";
import {
  type PackagePolicyError,
  PackagePolicyValidator,
} from "./package-policy.js";
import {
  BunPublicManifestFileSystem,
  PublicManifestBuilder,
  type PublicManifestError,
} from "./public-manifest.js";

export type PackagerError =
  | { type: "Filesystem"; path: string; operation: "read" | "write" | "list" }
  | { type: "NpmPack"; directory: string; diagnostics: string }
  | { type: "PackOutput"; directory: string }
  | { type: "Manifest"; error: PublicManifestError }
  | { type: "Policy"; error: PackagePolicyError };

export interface PackageCommandRunner {
  run(
    command: readonly string[],
    cwd: string,
  ): ResultAsync<string, PackagerError>;
}

export class BunPackageCommandRunner implements PackageCommandRunner {
  run(
    command: readonly string[],
    cwd: string,
  ): ResultAsync<string, PackagerError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({ cmd: [...command], cwd, stdout: "pipe", stderr: "pipe" }),
      () => ({
        type: "NpmPack" as const,
        directory: cwd,
        diagnostics: "Could not start npm",
      }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
        new Response(spawned.value.stderr).text(),
      ]),
      () => ({
        type: "NpmPack" as const,
        directory: cwd,
        diagnostics: "npm output unavailable",
      }),
    ).andThen(([code, stdout, stderr]) => {
      if (code === 0) return okAsync(stdout);
      return errAsync({
        type: "NpmPack" as const,
        directory: cwd,
        diagnostics: stderr,
      });
    });
  }
}

/** Stages only approved artifacts, then packs and validates the resulting npm bytes. */
export class PublicPackagePackager {
  constructor(
    private readonly commandRunner: PackageCommandRunner,
    private readonly validator: PackagePolicyValidator,
    private readonly manifestBuilder = new PublicManifestBuilder(
      new BunPublicManifestFileSystem(),
    ),
  ) {}

  packAll(root: string): ResultAsync<readonly string[], PackagerError> {
    const destination = join(root, "tarballs");
    let result = okAsync<readonly string[], PackagerError>([]);
    for (const packageName of Object.keys(
      PUBLIC_PACKAGES,
    ) as PublicPackageName[]) {
      result = result.andThen((tarballs) =>
        this.pack(packageName, root, destination).map((tarball) => [
          ...tarballs,
          tarball,
        ]),
      );
    }
    return result;
  }

  pack(
    packageName: PublicPackageName,
    root: string,
    destination: string,
  ): ResultAsync<string, PackagerError> {
    const source = PUBLIC_PACKAGES[packageName].directory;
    const stage = join(root, "staging", packageName.replace("@weaveio/", ""));
    return this.ensureDirectory(destination)
      .andThen(() => this.stageManifest(source, root))
      .andThen(() => this.copyApprovedFiles(packageName, source, stage))
      .andThen(() =>
        this.commandRunner.run(
          [
            "npm",
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            resolve(destination),
          ],
          stage,
        ),
      )
      .andThen((output) => this.readPackOutput(output, destination))
      .andThen((tarball) =>
        this.readBytes(tarball).andThen((bytes) => {
          const validation = this.validator.validate(bytes);
          if (validation.isErr())
            return errAsync({
              type: "Policy" as const,
              error: validation.error,
            });
          return okAsync(tarball);
        }),
      );
  }

  private copyApprovedFiles(
    packageName: PublicPackageName,
    source: string,
    stage: string,
  ): ResultAsync<void, PackagerError> {
    const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
    const files = new Set<string>();
    for (const entry of build.entries)
      files.add(entry.output.slice(source.length + 1));
    for (const declaration of build.declarations)
      files.add(declaration.output.slice(source.length + 1));
    if (build.bootstrap !== undefined)
      for (const file of build.bootstrap) files.add(`dist/bootstrap/${file}`);
    if (packageName !== "@weaveio/weave-cli") files.add("README.md");
    let result = okAsync<void, PackagerError>(undefined);
    for (const file of files) {
      const destination = join(stage, file);
      result = result.andThen(() => this.copy(join(source, file), destination));
      if (file === "dist/main.js")
        result = result.andThen(() => this.makeExecutable(destination));
    }
    return result;
  }

  private stageManifest(
    source: string,
    root: string,
  ): ResultAsync<unknown, PackagerError> {
    return this.manifestBuilder
      .stage(join(source, "package.json"), join(root, "staging"))
      .mapErr((error) => ({ type: "Manifest" as const, error }));
  }

  private copy(
    source: string,
    destination: string,
  ): ResultAsync<void, PackagerError> {
    return ResultAsync.fromPromise(Bun.file(source).arrayBuffer(), () => ({
      type: "Filesystem" as const,
      path: source,
      operation: "read" as const,
    })).andThen((contents) =>
      ResultAsync.fromPromise(Bun.write(destination, contents), () => ({
        type: "Filesystem" as const,
        path: destination,
        operation: "write" as const,
      })).map(() => undefined),
    );
  }

  private ensureDirectory(path: string): ResultAsync<void, PackagerError> {
    return ResultAsync.fromPromise(Bun.write(join(path, ".keep"), ""), () => ({
      type: "Filesystem" as const,
      path,
      operation: "write" as const,
    })).map(() => undefined);
  }

  private makeExecutable(path: string): ResultAsync<void, PackagerError> {
    return ResultAsync.fromPromise(
      Bun.spawn(["chmod", "755", path]).exited,
      () => ({
        type: "Filesystem" as const,
        path,
        operation: "write" as const,
      }),
    ).andThen((code) =>
      code === 0
        ? okAsync(undefined)
        : errAsync({
            type: "Filesystem" as const,
            path,
            operation: "write" as const,
          }),
    );
  }

  private readBytes(path: string): ResultAsync<Uint8Array, PackagerError> {
    return ResultAsync.fromPromise(Bun.file(path).bytes(), () => ({
      type: "Filesystem" as const,
      path,
      operation: "read" as const,
    }));
  }

  private readPackOutput(
    output: string,
    destination: string,
  ): Result<string, PackagerError> {
    const parsed = Result.fromThrowable(
      () => JSON.parse(output) as unknown,
      () => ({ type: "PackOutput" as const, directory: destination }),
    )();
    if (
      parsed.isErr() ||
      !Array.isArray(parsed.value) ||
      typeof parsed.value[0] !== "object" ||
      parsed.value[0] === null
    )
      return err({ type: "PackOutput", directory: destination });
    const filename = (parsed.value[0] as { filename?: unknown }).filename;
    if (typeof filename !== "string")
      return err({ type: "PackOutput", directory: destination });
    return Result.fromThrowable(
      () => join(destination, filename),
      () => ({ type: "PackOutput" as const, directory: destination }),
    )();
  }
}

if (import.meta.main) {
  const root = join(".release", `validate-${crypto.randomUUID()}`);
  const result = await new PublicPackagePackager(
    new BunPackageCommandRunner(),
    new PackagePolicyValidator(),
  ).packAll(root);
  if (result.isErr()) {
    logger.error(result.error, "Public package validation failed");
    process.exitCode = 1;
  }
}
