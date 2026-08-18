import { basename, join, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";

import {
  createExtensionBuildManifest,
  EXTENSION_BUILD_MANIFEST_FILENAME,
  renderExtensionBuildManifest,
  sha256Hex,
} from "../packages/adapters/pi/src/extension-build-identity.js";
import {
  PRIVATE_PACKAGE_NAMES,
  type PrivatePackageName,
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_PACKAGES,
  PUBLIC_RUNTIME_EXTERNALS,
  type PublicBuildEntry,
  type PublicDeclarationBuild,
  type PublicPackageBuild,
  type PublicPackageName,
} from "./release/constants.js";

const PI_EXTENSION_IDENTITY_SOURCE =
  "packages/adapters/pi/src/extension-build-identity.ts";
const PI_EXTENSION_IDENTITY_OUTPUT =
  "packages/adapters/pi/dist/extension-build-identity.js";
export const PI_EXTENSION_IDENTITY_MANIFEST = join(
  "packages/adapters/pi/dist",
  EXTENSION_BUILD_MANIFEST_FILENAME,
);
const PI_BUILD = PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"];
const PI_BUILD_OUTPUT_PATHS = [
  ...PI_BUILD.entries.map((entry) => entry.output),
  ...PI_BUILD.declarations.map((declaration) => declaration.output),
] as const;

export function piOutputName(path: string): string {
  const name = basename(path);
  if (name.endsWith(".d.ts")) return `${name.slice(0, -5)}-declarations`;
  if (name.endsWith(".js")) return name.slice(0, -3);
  return name;
}

/** Logical output names and relative paths hashed into the sidecar. */
export function piIdentityOutputFiles(): readonly {
  readonly name: string;
  readonly relativePath: string;
}[] {
  return PI_BUILD_OUTPUT_PATHS.map((relativePath) => ({
    name: piOutputName(relativePath),
    relativePath,
  }));
}

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
      type: "BuildIdentity";
      reason:
        | "git-subject-unavailable"
        | "git-state-unavailable"
        | "manifest-invalid"
        | "input-unavailable"
        | "output-unavailable";
    }
  | {
      type: "PrivateDependencyReference";
      packageName: PublicPackageName;
      output: string;
      privatePackageName:
        | PrivatePackageName
        | "@weaveio/weave-adapter-claude-code"
        | "@weaveio/weave-adapter-pi";
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
  /** Optional source-tree listing seam used by the post-build identity record. */
  listPiBuildInputFiles?(): ResultAsync<
    readonly string[],
    PublicPackageBuildError
  >;
  readText(path: string): ResultAsync<string, PublicPackageBuildError>;
  removeFile(path: string): ResultAsync<void, PublicPackageBuildError>;
  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, PublicPackageBuildError>;
}

/**
 * Render and write the sidecar only after every hashed output exists.
 * The sidecar itself is never one of those outputs.
 */
export function writePiExtensionBuildIdentityManifest(input: {
  readonly fileSystem: PublicPackageFileSystem;
  readonly subject: string;
  readonly dirty: boolean;
  readonly inputDigests: readonly string[];
  readonly outputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly buildCompletedAt?: string;
}): ResultAsync<void, PublicPackageBuildError> {
  const manifest = createExtensionBuildManifest({
    subject: input.subject,
    dirty: input.dirty,
    buildInputs: input.inputDigests,
    outputs: input.outputs,
    buildCompletedAt: input.buildCompletedAt,
  });
  if (manifest.isErr()) {
    return errAsync({
      type: "BuildIdentity",
      reason: "manifest-invalid",
    });
  }
  const rendered = renderExtensionBuildManifest(manifest.value);
  if (rendered.isErr()) {
    return errAsync({
      type: "BuildIdentity",
      reason: "manifest-invalid",
    });
  }
  return input.fileSystem
    .ensureDirectory(join(PI_EXTENSION_IDENTITY_MANIFEST, ".."))
    .andThen(() =>
      input.fileSystem.writeText(
        PI_EXTENSION_IDENTITY_MANIFEST,
        rendered.value,
      ),
    );
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

/** Keep sibling public entries as runtime imports so they are not inlined. */
function siblingEntryExternals(
  entries: readonly { source: string }[],
  currentSource: string,
): readonly string[] {
  return entries
    .filter((entry) => entry.source !== currentSource)
    .map((entry) => resolve(entry.source.replace(/\.tsx?$/, ".js")));
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
      if (result.success) return okAsync(define);
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
  ):
    | PrivatePackageName
    | "@weaveio/weave-adapter-claude-code"
    | "@weaveio/weave-adapter-pi"
    | undefined {
    const names: (
      | PrivatePackageName
      | "@weaveio/weave-adapter-claude-code"
      | "@weaveio/weave-adapter-pi"
    )[] = [...PRIVATE_PACKAGE_NAMES];
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
  ):
    | PrivatePackageName
    | "@weaveio/weave-adapter-claude-code"
    | "@weaveio/weave-adapter-pi"
    | undefined {
    const names: (
      | PrivatePackageName
      | "@weaveio/weave-adapter-claude-code"
      | "@weaveio/weave-adapter-pi"
    )[] = [...PRIVATE_PACKAGE_NAMES];
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
    return this.transpileEntry("@weaveio/weave-adapter-pi", {
      source: PI_EXTENSION_IDENTITY_SOURCE,
      output: PI_EXTENSION_IDENTITY_OUTPUT,
    })
      .andThen(() => this.readGitBuildIdentity())
      .andThen((git) =>
        this.readPiBuildInputs().map((buildInputs) => ({ git, buildInputs })),
      )
      .andThen(({ git, buildInputs }) =>
        this.hashPiBuildInputs(buildInputs).map((inputDigests) => ({
          git,
          inputDigests,
        })),
      )
      .andThen(({ git, inputDigests }) =>
        this.hashPiBuildOutputs().map((outputs) => ({
          git,
          inputDigests,
          outputs,
        })),
      )
      .andThen(({ git, inputDigests, outputs }) =>
        writePiExtensionBuildIdentityManifest({
          fileSystem: this.fileSystem,
          subject: git.subject,
          dirty: git.dirty,
          inputDigests,
          outputs,
        }),
      );
  }

  private readGitBuildIdentity(): ResultAsync<
    { readonly subject: string; readonly dirty: boolean },
    PublicPackageBuildError
  > {
    return this.runGit(
      ["rev-parse", "HEAD"],
      "git-subject-unavailable",
    ).andThen((subject) =>
      this.runGit(
        ["status", "--porcelain", "--untracked-files=all"],
        "git-state-unavailable",
      ).andThen((status) => {
        const normalizedSubject = subject.trim();
        if (!/^[0-9a-f]{40}$/u.test(normalizedSubject)) {
          return errAsync({
            type: "BuildIdentity" as const,
            reason: "git-subject-unavailable" as const,
          });
        }
        return okAsync({
          subject: normalizedSubject,
          dirty: status.trim().length > 0,
        });
      }),
    );
  }

  private runGit(
    command: readonly string[],
    reason: "git-subject-unavailable" | "git-state-unavailable",
  ): ResultAsync<string, PublicPackageBuildError> {
    const spawned = Result.fromThrowable(
      () =>
        Bun.spawn({ cmd: ["git", ...command], stdout: "pipe", stderr: "pipe" }),
      (): PublicPackageBuildError => ({ type: "BuildIdentity", reason }),
    )();
    if (spawned.isErr()) return errAsync(spawned.error);
    return ResultAsync.fromPromise(
      Promise.all([
        spawned.value.exited,
        new Response(spawned.value.stdout).text(),
      ]),
      (): PublicPackageBuildError => ({ type: "BuildIdentity", reason }),
    ).andThen(([exitCode, stdout]) =>
      exitCode === 0
        ? okAsync(stdout)
        : errAsync({ type: "BuildIdentity" as const, reason }),
    );
  }

  private readPiBuildInputs(): ResultAsync<
    readonly string[],
    PublicPackageBuildError
  > {
    const fallback = [
      ...PI_BUILD.entries.map((entry) => entry.source),
      PI_EXTENSION_IDENTITY_SOURCE,
    ];
    const listed = this.fileSystem.listPiBuildInputFiles?.();
    return (listed ?? okAsync([...new Set(fallback)].sort())).andThen(
      (files) => {
        const normalized = [...new Set(files)].sort();
        return normalized.length === 0
          ? errAsync({
              type: "BuildIdentity" as const,
              reason: "input-unavailable" as const,
            })
          : okAsync(normalized);
      },
    );
  }

  private hashPiBuildInputs(
    files: readonly string[],
  ): ResultAsync<readonly string[], PublicPackageBuildError> {
    let result = okAsync<string[], PublicPackageBuildError>([]);
    for (const file of files) {
      result = result.andThen((digests) =>
        this.hashTextForIdentity(file, "input-unavailable").map((digest) => [
          ...digests,
          digest,
        ]),
      );
    }
    return result.map((digests) => [...digests].sort());
  }

  private hashPiBuildOutputs(): ResultAsync<
    readonly { readonly name: string; readonly sha256: string }[],
    PublicPackageBuildError
  > {
    let result = okAsync<
      { readonly name: string; readonly sha256: string }[],
      PublicPackageBuildError
    >([]);
    for (const path of PI_BUILD_OUTPUT_PATHS) {
      result = result.andThen((outputs) =>
        this.hashTextForIdentity(path, "output-unavailable").map((sha256) => [
          ...outputs,
          { name: piOutputName(path), sha256 },
        ]),
      );
    }
    return result.map((outputs) =>
      [...outputs].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  private hashTextForIdentity(
    path: string,
    reason: "input-unavailable" | "output-unavailable",
  ): ResultAsync<string, PublicPackageBuildError> {
    return this.fileSystem.readText(path).andThen((contents) => {
      const digest = sha256Hex(new TextEncoder().encode(contents));
      return digest.isOk()
        ? okAsync(digest.value)
        : errAsync({ type: "BuildIdentity" as const, reason });
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
