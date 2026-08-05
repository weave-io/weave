import { join } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";

import {
  PRIVATE_PACKAGE_NAMES,
  type PrivatePackageName,
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  PUBLIC_RUNTIME_EXTERNALS,
  type PublicDeclarationBuild,
  type PublicPackageBuild,
  type PublicPackageName,
} from "./release/constants.js";

export type PublicPackageBuildError =
  | {
      type: "BuildDiagnostics";
      packageName: PublicPackageName;
      diagnostics: string;
    }
  | {
      type: "Filesystem";
      path: string;
      operation: "copy" | "delete" | "list" | "mkdir" | "chmod" | "write";
    }
  | {
      type: "TypeDeclarations";
      packageName: PublicPackageName;
      config?: string;
      diagnostics?: string;
    }
  | { type: "CliManifest"; path: string }
  | {
      type: "PrivateDependencyReference";
      packageName: PublicPackageName;
      output: string;
      privatePackageName:
        | PrivatePackageName
        | "@weaveio/weave-adapter-claude-code";
    };

export interface PublicPackageFileSystem {
  copyFile(
    source: string,
    destination: string,
  ): ResultAsync<void, PublicPackageBuildError>;
  ensureDirectory(path: string): ResultAsync<void, PublicPackageBuildError>;
  makeExecutable(path: string): ResultAsync<void, PublicPackageBuildError>;
  listDeclarationFiles(
    directory: string,
  ): ResultAsync<readonly string[], PublicPackageBuildError>;
  readText(path: string): ResultAsync<string, PublicPackageBuildError>;
  removeFile(path: string): ResultAsync<void, PublicPackageBuildError>;
  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, PublicPackageBuildError>;
}

/**
 * Matches only dependency-map entries and module specifiers, not prose mentions.
 * This permits bundled builtin guidance to name a package without adding a runtime
 * dependency to the packed artifact.
 */
export function hasPrivateDependencyReference(
  contents: string,
  packageName: string,
): boolean {
  const escaped = packageName.replaceAll("/", "\\/");
  const dependencyMap = new RegExp(
    `["']${escaped}["']\\s*:\\s*["'](?:workspace:|[~^<>=*]|\\d)`,
  );
  const moduleSpecifier = new RegExp(
    `(?:import|export)\\s+(?:[^"']*?\\s+from\\s+)?["']${escaped}["']|require\\(\\s*["']${escaped}["']\\s*\\)`,
  );
  return dependencyMap.test(contents) || moduleSpecifier.test(contents);
}

/**
 * Matches any private workspace name in a shipped declaration, including prose.
 * Unlike runtime JavaScript, declaration files expose their complete text to
 * consumers and are therefore held to a stricter no-private-name policy.
 */
export function hasPrivateDeclarationReference(
  contents: string,
  packageName: string,
): boolean {
  return contents.includes(packageName);
}

function hasPrivateDeclarationPathReference(contents: string): boolean {
  return /(?:from|import\()\s*["'][^"']*(?:packages\/(?:core|config|engine)|\.\.\/(?:core|config|engine))(?:\/|["'])/.test(
    contents,
  );
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
    return result;
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
        .replaceAll("@weaveio/weave-config", "the configuration package")
        .replaceAll("@weaveio/weave-engine", "the engine package")
        .replaceAll("@weaveio/weave-core", "the core package");
      if (sanitized === contents) return okAsync(undefined);
      return this.fileSystem.writeText(declaration.output, sanitized);
    });
  }

  private buildEntries(
    packageName: PublicPackageName,
    entries: readonly {
      source: string;
      output: string;
      executable?: boolean;
    }[],
  ): ResultAsync<void, PublicPackageBuildError> {
    const build: PublicPackageBuild = PUBLIC_PACKAGE_BUILDS[packageName];
    const external = [
      ...PUBLIC_RUNTIME_EXTERNALS,
      ...(build.runtimeExternals ?? []),
    ];
    let result = this.getBuildDefines(packageName);
    for (const entry of entries) {
      result = result.andThen((define) =>
        ResultAsync.fromPromise(
          Bun.build({
            entrypoints: [entry.source],
            outdir: join(entry.output, ".."),
            target: "bun",
            format: "esm",
            external,
            define,
          }),
          () => ({
            type: "BuildDiagnostics" as const,
            packageName,
            diagnostics: "Bun.build rejected",
          }),
        ).andThen((result) => {
          if (result.success) return okAsync(define);
          return errAsync({
            type: "BuildDiagnostics" as const,
            packageName,
            diagnostics: result.logs.map((log) => log.message).join("\n"),
          });
        }),
      );
      if (entry.executable) {
        result = result.andThen((define) =>
          this.fileSystem.makeExecutable(entry.output).map(() => define),
        );
      }
    }
    return result.map(() => undefined);
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
  ): PrivatePackageName | "@weaveio/weave-adapter-claude-code" | undefined {
    const names: (PrivatePackageName | "@weaveio/weave-adapter-claude-code")[] =
      [...PRIVATE_PACKAGE_NAMES];
    if (packageName === "@weaveio/weave-cli") {
      names.push("@weaveio/weave-adapter-claude-code");
    }
    return names.find((name) => hasPrivateDependencyReference(contents, name));
  }

  private findPrivateDeclarationReference(
    packageName: PublicPackageName,
    contents: string,
  ): PrivatePackageName | "@weaveio/weave-adapter-claude-code" | undefined {
    const names: (PrivatePackageName | "@weaveio/weave-adapter-claude-code")[] =
      [...PRIVATE_PACKAGE_NAMES];
    if (packageName === "@weaveio/weave-cli") {
      names.push("@weaveio/weave-adapter-claude-code");
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

if (import.meta.main) {
  const builder = new PublicPackageBuilder(new BunPublicPackageFileSystem());
  const result = await builder.buildAll();
  if (result.isErr()) {
    logger.error(result.error, "Public package build failed");
    process.exitCode = 1;
  }
}
