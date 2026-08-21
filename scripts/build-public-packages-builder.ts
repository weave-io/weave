import { join, resolve } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  emitPiBuildIdentityArtifacts,
  PI_EXTENSION_IDENTITY_OUTPUT,
  PI_EXTENSION_IDENTITY_SOURCE,
} from "./build-public-packages-pi.js";
import {
  hasPrivateDeclarationReference,
  hasPrivateDependencyReference,
  hasRuntimeRelativeImport,
  type PublicPackageBuildError,
  type PublicPackageFileSystem,
  type PublicPrivatePackageName,
} from "./build-public-packages-shared.js";
import {
  PRIVATE_PACKAGE_NAMES,
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  PUBLIC_RUNTIME_EXTERNALS,
  type PublicBuildEntry,
  type PublicDeclarationBuild,
  type PublicPackageBuild,
  type PublicPackageName,
} from "./release/constants.js";

function siblingEntryExternals(
  entries: readonly { source: string }[],
  currentSource: string,
): readonly string[] {
  return entries
    .filter((entry) => entry.source !== currentSource)
    .map((entry) => resolve(entry.source.replace(/\.tsx?$/, ".js")));
}

function hasPrivateDeclarationPathReference(contents: string): boolean {
  return /(?:from|import\()\s*["'][^"']*(?:packages\/(?:core|config|engine)|\.\.\/(?:core|config|engine))(?:\/|["'])/.test(
    contents,
  );
}

/** Builds public entry points with workspace code inlined and approved runtime imports external. */
export class PublicPackageBuilder {
  constructor(private readonly fileSystem: PublicPackageFileSystem) {}

  buildAll(): ResultAsync<void, PublicPackageBuildError> {
    // Pi must finish declarations before CLI: CLI imports Pi public types.
    const packageBuildOrder: readonly PublicPackageName[] = [
      "@weaveio/weave-adapter-claude-code",
      "@weaveio/weave-adapter-opencode",
      "@weaveio/weave-adapter-pi",
      "@weaveio/weave-cli",
    ];
    let result = this.emitPrivateDeclarations()
      .andThen(() => {
        const build =
          PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-claude-code"];
        return this.rollupDeclarations(
          "@weaveio/weave-adapter-claude-code",
          build.declarations,
        );
      })
      .andThen(() => this.emitPublicDeclarations());
    for (const packageName of packageBuildOrder) {
      result = result.andThen(() => this.build(packageName));
    }
    // The identity module and sidecar are deliberately emitted last. A
    // sidecar from a partial build is never a valid proof of any output.
    return result.andThen(() => this.emitPiBuildIdentityArtifacts());
  }

  build(
    packageName: PublicPackageName,
  ): ResultAsync<void, PublicPackageBuildError> {
    const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
    return this.buildEntries(packageName, build.entries)
      .andThen(() => this.rollupDeclarations(packageName, build.declarations))
      .andThen(() => this.copyBootstrap(build.bootstrap))
      .andThen(() => this.verifyEntries(packageName, build.entries));
  }

  private emitPrivateDeclarations(): ResultAsync<
    void,
    PublicPackageBuildError
  > {
    return this.runTypeScriptProjects([
      "packages/core/tsconfig.build.json",
      "packages/engine/tsconfig.build.json",
      "packages/config/tsconfig.build.json",
      "packages/adapters/claude-code/tsconfig.build.json",
    ]);
  }

  private emitPublicDeclarations(): ResultAsync<void, PublicPackageBuildError> {
    // CLI resolves `@weaveio/weave-adapter-pi` via rolled-up `dist/index.d.ts`,
    // so Pi's tsc + api-extractor rollup must finish before CLI declarations.
    return this.runTypeScriptProjects([
      "packages/adapters/pi/tsconfig.build.json",
    ])
      .andThen(() =>
        this.rollupDeclarations(
          "@weaveio/weave-adapter-pi",
          PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"].declarations,
        ),
      )
      .andThen(() =>
        this.runTypeScriptProjects([
          "packages/adapters/opencode/tsconfig.build.json",
          "packages/cli/tsconfig.build.json",
        ]),
      );
  }

  private runTypeScriptProjects(
    projects: readonly string[],
  ): ResultAsync<void, PublicPackageBuildError> {
    let result = okAsync<void, PublicPackageBuildError>(undefined);
    for (const project of projects) {
      result = result.andThen(() =>
        this.runTool(["bun", "x", "tsc", "-p", project], {
          type: "TypeDeclarations",
          packageName: "@weaveio/weave-cli",
          config: project,
        }),
      );
    }
    return result;
  }

  private rollupDeclarations(
    packageName: PublicPackageName,
    declarations: readonly PublicDeclarationBuild[],
  ): ResultAsync<void, PublicPackageBuildError> {
    let result = okAsync<void, PublicPackageBuildError>(undefined);
    for (const declaration of declarations) {
      result = result
        .andThen(() =>
          this.runTool(
            [
              "bun",
              "x",
              "api-extractor",
              "run",
              "--local",
              "--config",
              declaration.config,
            ],
            {
              type: "TypeDeclarations",
              packageName,
              config: declaration.config,
            },
          ),
        )
        .andThen(() => this.sanitizeDeclaration(declaration));
    }
    return result
      .andThen(() => this.removeStaleDeclarations(packageName, declarations))
      .andThen(() => this.verifyDeclarations(packageName));
  }

  private verifyDeclarations(
    packageName: PublicPackageName,
  ): ResultAsync<void, PublicPackageBuildError> {
    const directory = join(PUBLIC_PACKAGES[packageName].directory, "dist");
    return this.fileSystem.listDeclarationFiles(directory).andThen((files) => {
      let result = okAsync<void, PublicPackageBuildError>(undefined);
      for (const output of files) {
        result = result.andThen(() =>
          this.fileSystem.readText(output).andThen((contents) => {
            const privatePackageName = this.findPrivateDeclarationReference(
              packageName,
              contents,
            );
            if (
              privatePackageName === undefined &&
              !hasPrivateDeclarationPathReference(contents)
            ) {
              return okAsync(undefined);
            }
            return errAsync({
              type: "PrivateDependencyReference" as const,
              packageName,
              output,
              privatePackageName: privatePackageName ?? "@weaveio/weave-core",
            });
          }),
        );
      }
      return result;
    });
  }

  private removeStaleDeclarations(
    packageName: PublicPackageName,
    declarations: readonly PublicDeclarationBuild[],
  ): ResultAsync<void, PublicPackageBuildError> {
    const expected = new Set(declarations.map(({ output }) => output));
    const directory = join(PUBLIC_PACKAGES[packageName].directory, "dist");
    return this.fileSystem.listDeclarationFiles(directory).andThen((files) => {
      let result = okAsync<void, PublicPackageBuildError>(undefined);
      for (const file of files) {
        if (expected.has(file)) continue;
        result = result.andThen(() => this.fileSystem.removeFile(file));
      }
      return result;
    });
  }

  private sanitizeDeclaration(
    declaration: PublicDeclarationBuild,
  ): ResultAsync<void, PublicPackageBuildError> {
    return this.fileSystem.readText(declaration.output).andThen((contents) => {
      const sanitized = contents
        .replaceAll("@weaveio/weave-adapter-opencode", "the OpenCode adapter")
        .replaceAll("@weaveio/weave-adapter-claude-code", "the Claude adapter")
        .replaceAll("@weaveio/weave-adapter-pi", "the Pi adapter")
        .replaceAll("@weaveio/weave-config", "the configuration package")
        .replaceAll("@weaveio/weave-engine", "the engine package")
        .replaceAll("@weaveio/weave-core", "the core package");
      if (sanitized === contents) return okAsync(undefined);
      return this.fileSystem.writeText(declaration.output, sanitized);
    });
  }

  private buildEntries(
    packageName: PublicPackageName,
    entries: readonly PublicBuildEntry[],
  ): ResultAsync<void, PublicPackageBuildError> {
    const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
    const external = [
      ...PUBLIC_RUNTIME_EXTERNALS,
      ...(build.runtimeExternals ?? []),
    ];
    let result = this.getBuildDefines(packageName);
    for (const entry of entries) {
      result = result.andThen((define) =>
        entry.transpileOnly === true
          ? this.transpileEntry(packageName, entry).map(() => define)
          : this.bundleEntry(packageName, entry, entries, external, define),
      );
      if (entry.executable) {
        result = result.andThen((define) =>
          this.fileSystem.makeExecutable(entry.output).map(() => define),
        );
      }
    }
    return result.map(() => undefined);
  }

  private transpileEntry(
    packageName: PublicPackageName,
    entry: PublicBuildEntry,
  ): ResultAsync<void, PublicPackageBuildError> {
    return this.fileSystem.readText(entry.source).andThen((source) => {
      const transpiled = Result.fromThrowable(
        () => new Bun.Transpiler({ loader: "ts" }).transformSync(source),
        () => ({
          type: "BuildDiagnostics" as const,
          packageName,
          diagnostics: "Bun.Transpiler rejected",
        }),
      )();
      if (transpiled.isErr()) return errAsync(transpiled.error);
      return this.fileSystem
        .ensureDirectory(join(entry.output, ".."))
        .andThen(() =>
          this.fileSystem.writeText(entry.output, transpiled.value),
        );
    });
  }

  private bundleEntry(
    packageName: PublicPackageName,
    entry: PublicBuildEntry,
    entries: readonly PublicBuildEntry[],
    external: readonly string[],
    define: Record<string, string>,
  ): ResultAsync<Record<string, string>, PublicPackageBuildError> {
    return ResultAsync.fromPromise(
      Bun.build({
        entrypoints: [entry.source],
        outdir: join(entry.output, ".."),
        target: "bun",
        format: "esm",
        external: [
          ...external,
          ...siblingEntryExternals(entries, entry.source),
        ],
        define,
      }),
      () => ({
        type: "BuildDiagnostics" as const,
        packageName,
        diagnostics: "Bun.build rejected",
      }),
    ).andThen((result) => {
      if (result.success) {
        if (
          entry.source === "packages/adapters/pi/src/extension.ts" &&
          result.outputs.length !== 1
        ) {
          return errAsync({
            type: "BuildIdentity" as const,
            reason: "output-unavailable" as const,
          });
        }
        return okAsync(define);
      }
      return errAsync({
        type: "BuildDiagnostics" as const,
        packageName,
        diagnostics: result.logs.map((log) => log.message).join("\n"),
      });
    });
  }

  private getBuildDefines(
    packageName: PublicPackageName,
  ): ResultAsync<Record<string, string>, PublicPackageBuildError> {
    if (packageName !== "@weaveio/weave-cli") return okAsync({});
    const manifestPath = "packages/cli/package.json";
    return this.fileSystem.readText(manifestPath).andThen((contents) => {
      const manifest = this.parseCliManifest(contents, manifestPath);
      if (manifest.isErr()) return errAsync(manifest.error);
      return okAsync({
        "process.env.WEAVE_CLI_VERSION": JSON.stringify(manifest.value.version),
      });
    });
  }

  private parseCliManifest(
    contents: string,
    path: string,
  ): Result<{ version: string }, PublicPackageBuildError> {
    const parsed = Result.fromThrowable(
      () => JSON.parse(contents) as unknown,
      () => ({ type: "CliManifest" as const, path }),
    )();
    if (parsed.isErr()) return err(parsed.error);
    if (typeof parsed.value !== "object" || parsed.value === null) {
      return err({ type: "CliManifest", path });
    }
    const version = (parsed.value as { version?: unknown }).version;
    if (typeof version !== "string" || version.length === 0) {
      return err({ type: "CliManifest", path });
    }
    return ok({ version });
  }

  private verifyEntries(
    packageName: PublicPackageName,
    entries: readonly { output: string }[],
  ): ResultAsync<void, PublicPackageBuildError> {
    let result = okAsync<void, PublicPackageBuildError>(undefined);
    for (const entry of entries) {
      result = result.andThen(() =>
        this.fileSystem.readText(entry.output).andThen((contents) => {
          if (
            packageName === "@weaveio/weave-adapter-pi" &&
            entry.output === "packages/adapters/pi/dist/extension.js" &&
            hasRuntimeRelativeImport(contents)
          ) {
            return errAsync({
              type: "BuildIdentity" as const,
              reason: "output-unavailable" as const,
            });
          }
          const privatePackageName = this.findPrivateReference(
            packageName,
            contents,
          );
          if (privatePackageName === undefined) return okAsync(undefined);
          return errAsync({
            type: "PrivateDependencyReference" as const,
            packageName,
            output: entry.output,
            privatePackageName,
          });
        }),
      );
    }
    return result;
  }

  private findPrivateReference(
    packageName: PublicPackageName,
    contents: string,
  ): PublicPrivatePackageName | undefined {
    const names: PublicPrivatePackageName[] = [...PRIVATE_PACKAGE_NAMES];
    if (packageName === "@weaveio/weave-cli") {
      names.push(
        "@weaveio/weave-adapter-claude-code",
        "@weaveio/weave-adapter-pi",
      );
    }
    return names.find((name) => hasPrivateDependencyReference(contents, name));
  }

  private findPrivateDeclarationReference(
    packageName: PublicPackageName,
    contents: string,
  ): PublicPrivatePackageName | undefined {
    const names: PublicPrivatePackageName[] = [...PRIVATE_PACKAGE_NAMES];
    if (packageName === "@weaveio/weave-cli") {
      names.push(
        "@weaveio/weave-adapter-claude-code",
        "@weaveio/weave-adapter-pi",
      );
    }
    return names.find((name) => hasPrivateDeclarationReference(contents, name));
  }

  private runTool(
    command: string[],
    error: Extract<PublicPackageBuildError, { type: "TypeDeclarations" }>,
  ): ResultAsync<void, PublicPackageBuildError> {
    const process = Result.fromThrowable(
      () => Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" }),
      () => error,
    )();
    if (process.isErr()) return errAsync(process.error);
    return ResultAsync.fromPromise(
      Promise.all([
        process.value.exited,
        new Response(process.value.stderr).text(),
      ]),
      () => error,
    ).andThen(([exitCode, diagnostics]) => {
      if (exitCode === 0) return okAsync(undefined);
      return errAsync({ ...error, diagnostics });
    });
  }

  private emitPiBuildIdentityArtifacts(): ResultAsync<
    void,
    PublicPackageBuildError
  > {
    const piBuild = PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"];
    return emitPiBuildIdentityArtifacts({
      fileSystem: this.fileSystem,
      bundleIdentityEntry: () =>
        this.bundleEntry(
          "@weaveio/weave-adapter-pi",
          {
            source: PI_EXTENSION_IDENTITY_SOURCE,
            output: PI_EXTENSION_IDENTITY_OUTPUT,
          },
          piBuild.entries,
          [...PUBLIC_RUNTIME_EXTERNALS, ...(piBuild.runtimeExternals ?? [])],
          {},
        ).map(() => undefined),
    });
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
