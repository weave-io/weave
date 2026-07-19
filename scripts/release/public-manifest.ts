import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  ALL_DEPENDENCY_FIELDS,
  PRIVATE_PACKAGE_NAMES,
  PUBLIC_MANIFEST_FIELDS,
  PUBLIC_PACKAGES,
  type PublicPackageName,
  RUNTIME_DEPENDENCY_FIELDS,
} from "./constants.js";

type JsonObject = Record<string, unknown>;
type DependencyField = (typeof ALL_DEPENDENCY_FIELDS)[number];
type RuntimeDependencyField = (typeof RUNTIME_DEPENDENCY_FIELDS)[number];

export type PublicManifestError =
  | { type: "InvalidManifest"; path: string; message: string }
  | { type: "UnknownPublicPackage"; path: string; packageName: string }
  | {
      type: "ForbiddenDependency";
      path: string;
      dependencyField: DependencyField;
      packageName: string;
    }
  | { type: "Filesystem"; path: string; operation: "read" | "write" | "mkdir" };

export interface PublicManifestFileSystem {
  readText(path: string): ResultAsync<string, PublicManifestError>;
  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, PublicManifestError>;
  ensureDirectory(path: string): ResultAsync<void, PublicManifestError>;
}

/** Bun-only filesystem implementation used by the guarded release orchestrator. */
export class BunPublicManifestFileSystem implements PublicManifestFileSystem {
  readText(path: string): ResultAsync<string, PublicManifestError> {
    return ResultAsync.fromPromise(Bun.file(path).text(), () => ({
      type: "Filesystem" as const,
      path,
      operation: "read" as const,
    }));
  }

  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, PublicManifestError> {
    return ResultAsync.fromPromise(Bun.write(path, contents), () => ({
      type: "Filesystem" as const,
      path,
      operation: "write" as const,
    })).map(() => undefined);
  }

  ensureDirectory(path: string): ResultAsync<void, PublicManifestError> {
    return ResultAsync.fromPromise(
      Bun.spawn(["mkdir", "-p", path]).exited,
      () => ({
        type: "Filesystem" as const,
        path,
        operation: "mkdir" as const,
      }),
    ).andThen((exitCode) => {
      if (exitCode === 0) return okAsync(undefined);
      return errAsync({
        type: "Filesystem" as const,
        path,
        operation: "mkdir" as const,
      });
    });
  }
}

export interface StagedPublicManifest {
  packageName: PublicPackageName;
  directory: string;
  manifestPath: string;
  manifest: JsonObject;
}

/**
 * Produces package manifests in isolated staging directories. Source manifests
 * are read-only inputs and are never used as packing roots.
 */
export class PublicManifestBuilder {
  constructor(private readonly fileSystem: PublicManifestFileSystem) {}

  build(
    source: unknown,
    sourcePath: string,
  ): Result<JsonObject, PublicManifestError> {
    if (!isJsonObject(source)) {
      return err({
        type: "InvalidManifest",
        path: sourcePath,
        message: "Expected object",
      });
    }

    const packageName = source.name;
    if (typeof packageName !== "string") {
      return err({
        type: "InvalidManifest",
        path: `${sourcePath}.name`,
        message: "Expected string",
      });
    }
    if (!isPublicPackageName(packageName)) {
      return err({
        type: "UnknownPublicPackage",
        path: `${sourcePath}.name`,
        packageName,
      });
    }

    const dependencies = this.validateDependencyMaps(source, sourcePath);
    if (dependencies.isErr()) return err(dependencies.error);

    const staged = this.copyPublicFields(source);
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      const map = dependencies.value[field];
      if (map !== undefined && Object.keys(map).length > 0) staged[field] = map;
    }
    return ok(staged);
  }

  stage(
    sourceManifestPath: string,
    stagingDirectory: string,
  ): ResultAsync<StagedPublicManifest, PublicManifestError> {
    return this.fileSystem
      .readText(sourceManifestPath)
      .andThen((contents) =>
        this.stageContents(contents, sourceManifestPath, stagingDirectory),
      );
  }

  private stageContents(
    contents: string,
    sourceManifestPath: string,
    stagingDirectory: string,
  ): ResultAsync<StagedPublicManifest, PublicManifestError> {
    const parsed: Result<unknown, PublicManifestError> = Result.fromThrowable(
      () => JSON.parse(contents) as unknown,
      () => ({
        type: "InvalidManifest" as const,
        path: sourceManifestPath,
        message: "Invalid JSON",
      }),
    )();
    if (parsed.isErr()) return errAsync(parsed.error);

    const manifest = this.build(parsed.value, sourceManifestPath);
    if (manifest.isErr()) return errAsync(manifest.error);
    const packageName = manifest.value.name;
    if (typeof packageName !== "string" || !isPublicPackageName(packageName)) {
      return errAsync({
        type: "InvalidManifest",
        path: `${sourceManifestPath}.name`,
        message: "Invalid public package name",
      });
    }

    const directory = `${stagingDirectory}/${packageName.replace("@weaveio/", "")}`;
    const manifestPath = `${directory}/package.json`;
    return this.fileSystem.ensureDirectory(directory).andThen(() =>
      this.fileSystem
        .writeText(manifestPath, `${JSON.stringify(manifest.value, null, 2)}\n`)
        .map(() => ({
          packageName,
          directory,
          manifestPath,
          manifest: manifest.value,
        })),
    );
  }

  private copyPublicFields(source: JsonObject): JsonObject {
    const staged: JsonObject = {};
    for (const field of PUBLIC_MANIFEST_FIELDS) {
      const value = source[field];
      if (value !== undefined) staged[field] = value;
    }
    return staged;
  }

  private validateDependencyMaps(
    source: JsonObject,
    sourcePath: string,
  ): Result<
    Partial<Record<RuntimeDependencyField, Record<string, string>>>,
    PublicManifestError
  > {
    const runtimeMaps: Partial<
      Record<RuntimeDependencyField, Record<string, string>>
    > = {};
    for (const field of ALL_DEPENDENCY_FIELDS) {
      const value = source[field];
      if (value === undefined) continue;
      if (!isDependencyMap(value)) {
        return err({
          type: "InvalidManifest",
          path: `${sourcePath}.${field}`,
          message: "Expected dependency map",
        });
      }
      const externalDependencies: Record<string, string> = {};
      for (const packageName of Object.keys(value)) {
        if (this.isForbiddenDependency(packageName)) {
          return err({
            type: "ForbiddenDependency",
            path: `${sourcePath}.${field}.${packageName}`,
            dependencyField: field,
            packageName,
          });
        }
        if (!isKnownWorkspaceBuildDependency(packageName)) {
          externalDependencies[packageName] = value[packageName];
        }
      }
      if (isRuntimeDependencyField(field))
        runtimeMaps[field] = externalDependencies;
    }
    return ok(runtimeMaps);
  }

  private isForbiddenDependency(packageName: string): boolean {
    if (isKnownWorkspaceBuildDependency(packageName)) return false;
    return packageName.startsWith("@weaveio/");
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDependencyMap(value: unknown): value is Record<string, string> {
  if (!isJsonObject(value)) return false;
  return Object.values(value).every((version) => typeof version === "string");
}

function isRuntimeDependencyField(
  field: DependencyField,
): field is RuntimeDependencyField {
  return field !== "devDependencies";
}

function isPublicPackageName(
  packageName: string,
): packageName is PublicPackageName {
  return packageName in PUBLIC_PACKAGES;
}

function isKnownWorkspaceBuildDependency(packageName: string): boolean {
  if (
    PRIVATE_PACKAGE_NAMES.includes(
      packageName as (typeof PRIVATE_PACKAGE_NAMES)[number],
    )
  ) {
    return true;
  }
  return packageName === "@weaveio/weave-adapter-claude-code";
}
