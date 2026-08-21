import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  ALL_DEPENDENCY_FIELDS,
  PRIVATE_PACKAGE_NAMES,
  PUBLIC_MANIFEST_FIELDS,
  type PublicPackageName,
  RUNTIME_DEPENDENCY_FIELDS,
} from "./constants.js";
import {
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
  parseJsonValue,
} from "./json.js";
import {
  isPublishablePackage,
  type PublishabilityError,
  resolvePublishablePackage,
} from "./package-policy.js";

interface MutableJsonObject {
  [key: string]: JsonValue;
}

interface DependencyMap {
  [packageName: string]: string;
}

type DependencyField = (typeof ALL_DEPENDENCY_FIELDS)[number];
type RuntimeDependencyField = (typeof RUNTIME_DEPENDENCY_FIELDS)[number];
const isStringValue = isJsonString;

export type PublicManifestError =
  | { type: "InvalidManifest"; path: string; message: string }
  | {
      type: "UnknownPublicPackage";
      path: string;
      packageName: string;
      reason: PublishabilityError["type"];
    }
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
    })).andThen(() => okAsync());
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
      if (exitCode === 0) return okAsync();
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
  manifest: MutableJsonObject;
}

/**
 * Produces package manifests in isolated staging directories. Source manifests
 * are read-only inputs and are never used as packing roots.
 */
export class PublicManifestBuilder {
  constructor(private readonly fileSystem: PublicManifestFileSystem) {}

  build(
    source: JsonValue,
    sourcePath: string,
  ): Result<MutableJsonObject, PublicManifestError> {
    if (!isJsonObject(source)) {
      return err({
        type: "InvalidManifest",
        path: sourcePath,
        message: "Expected object",
      });
    }

    const packageName = source.name;
    if (!isStringValue(packageName)) {
      return err({
        type: "InvalidManifest",
        path: `${sourcePath}.name`,
        message: "Expected string",
      });
    }
    const publishable = resolvePublishablePackage(packageName);
    if (publishable.isErr()) {
      return err({
        type: "UnknownPublicPackage",
        path: `${sourcePath}.name`,
        packageName,
        reason: publishable.error.type,
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
    version?: string,
  ): ResultAsync<StagedPublicManifest, PublicManifestError> {
    return this.fileSystem
      .readText(sourceManifestPath)
      .andThen((contents) =>
        this.stageContents(
          contents,
          sourceManifestPath,
          stagingDirectory,
          version,
        ),
      );
  }

  private stageContents(
    contents: string,
    sourceManifestPath: string,
    stagingDirectory: string,
    version?: string,
  ): ResultAsync<StagedPublicManifest, PublicManifestError> {
    const parsed: Result<JsonValue, PublicManifestError> = parseJsonValue(
      contents,
    ).mapErr(() => ({
      type: "InvalidManifest" as const,
      path: sourceManifestPath,
      message: "Invalid JSON",
    }));
    if (parsed.isErr()) return errAsync(parsed.error);

    const manifest = this.build(parsed.value, sourceManifestPath);
    if (manifest.isErr()) return errAsync(manifest.error);
    if (version !== undefined) manifest.value.version = version;
    const packageName = manifest.value.name;
    if (!isStringValue(packageName) || !isPublishablePackage(packageName)) {
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

  private copyPublicFields(source: JsonObject): MutableJsonObject {
    const staged: MutableJsonObject = {};
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
    Partial<Record<RuntimeDependencyField, DependencyMap>>,
    PublicManifestError
  > {
    const runtimeMaps: Partial<Record<RuntimeDependencyField, DependencyMap>> =
      {};
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
      const externalDependencies: DependencyMap = {};
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

function isDependencyMap(value: JsonValue): value is DependencyMap {
  if (!isJsonObject(value)) return false;
  return Object.values(value).every(isStringValue);
}

function isRuntimeDependencyField(
  field: DependencyField,
): field is RuntimeDependencyField {
  return field !== "devDependencies";
}

function isKnownWorkspaceBuildDependency(packageName: string): boolean {
  if (PRIVATE_PACKAGE_NAMES.some((privateName) => privateName === packageName))
    return true;
  // Bundled into `@weaveio/weave-cli` at build time (Claude compose + Pi adapter
  // commands). Stripped from the published CLI manifest like private layers.
  return (
    packageName === "@weaveio/weave-adapter-claude-code" ||
    packageName === "@weaveio/weave-adapter-pi"
  );
}
