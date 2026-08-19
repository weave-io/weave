/**
 * The checked-in contract between package exports, API Extractor configs, and
 * API report files.
 *
 * API Extractor config files are not public API by themselves. A config is
 * public only when this map assigns it to one exported declaration surface.
 * Internal declaration checks use the auxiliary allowlist and must carry an
 * owner, a reason, and the entry module they are allowed to inspect.
 */
import { dirname, join, relative, resolve } from "node:path";
import { ExtractorConfig } from "@microsoft/api-extractor";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { CONFIG_PATHS } from "../validate-api-extractor-configs.js";
import { PUBLIC_PACKAGES } from "./constants.js";

const log = logger.child({ module: "api-surface-map" });

export const API_SURFACE_MAP_VERSION = 1 as const;
export const API_EXTRACTOR_CONFIG_GLOB = "packages/**/api-extractor*.json";
export const API_REPORT_GLOB = "packages/**/etc/*.api.md";

export interface PublicApiSurface {
  readonly packageName: string;
  /** All package export keys that resolve to this one declaration surface. */
  readonly exportPaths: readonly string[];
  /** The declaration target in the package's `exports` map. */
  readonly declarationPath: string;
  readonly configPath: string;
  readonly reportPath: string;
}

export interface AuxiliaryApiConfig {
  readonly packageName: string;
  readonly configPath: string;
  readonly owner: string;
  readonly rationale: string;
  /** The internal declaration entry used by the auxiliary config. */
  readonly entryDeclarationPath: string;
  /** The runtime module that must remain outside the package exports map. */
  readonly entryModulePath: string;
}

export interface ApiSurfaceMap {
  readonly version: 1;
  readonly public: readonly PublicApiSurface[];
  readonly auxiliary: readonly AuxiliaryApiConfig[];
}

/**
 * The one checked-in classification. Keep this list explicit: a new config or
 * public export must update the map in the same change.
 */
export const API_SURFACE_MAP = {
  version: API_SURFACE_MAP_VERSION,
  public: [
    {
      packageName: "@weaveio/weave-cli",
      exportPaths: ["."],
      declarationPath: "packages/cli/dist/index.d.ts",
      configPath: "packages/cli/api-extractor.json",
      reportPath: "packages/cli/etc/weave-cli.api.md",
    },
    {
      packageName: "@weaveio/weave-adapter-opencode",
      exportPaths: ["."],
      declarationPath: "packages/adapters/opencode/dist/index.d.ts",
      configPath: "packages/adapters/opencode/api-extractor.index.json",
      reportPath:
        "packages/adapters/opencode/etc/weave-adapter-opencode-index.api.md",
    },
    {
      packageName: "@weaveio/weave-adapter-opencode",
      exportPaths: ["./plugin", "./server"],
      declarationPath: "packages/adapters/opencode/dist/plugin.d.ts",
      configPath: "packages/adapters/opencode/api-extractor.plugin.json",
      reportPath:
        "packages/adapters/opencode/etc/weave-adapter-opencode-plugin.api.md",
    },
    {
      packageName: "@weaveio/weave-adapter-claude-code",
      exportPaths: ["."],
      declarationPath: "packages/adapters/claude-code/dist/index.d.ts",
      configPath: "packages/adapters/claude-code/api-extractor.json",
      reportPath:
        "packages/adapters/claude-code/etc/weave-adapter-claude-code.api.md",
    },
    {
      packageName: "@weaveio/weave-adapter-pi",
      exportPaths: ["."],
      declarationPath: "packages/adapters/pi/dist/index.d.ts",
      configPath: "packages/adapters/pi/api-extractor.index.json",
      reportPath: "packages/adapters/pi/etc/weave-adapter-pi-index.api.md",
    },
    {
      packageName: "@weaveio/weave-adapter-pi",
      exportPaths: ["./cli"],
      declarationPath: "packages/adapters/pi/dist/cli.d.ts",
      configPath: "packages/adapters/pi/api-extractor.cli.json",
      reportPath: "packages/adapters/pi/etc/weave-adapter-pi-cli.api.md",
    },
    {
      packageName: "@weaveio/weave-adapter-pi",
      exportPaths: ["./extension"],
      declarationPath: "packages/adapters/pi/dist/extension.d.ts",
      configPath: "packages/adapters/pi/api-extractor.extension.json",
      reportPath: "packages/adapters/pi/etc/weave-adapter-pi-extension.api.md",
    },
  ],
  auxiliary: [
    {
      packageName: "@weaveio/weave-adapter-pi",
      configPath: "packages/adapters/pi/api-extractor.extension-impl.json",
      owner: "Pi adapter maintainers",
      rationale:
        "Checks the private extension implementation declaration needed by the packaged loader. The implementation is loaded by the exported thin loader at runtime but is not itself a package export, so it has no public API report.",
      entryDeclarationPath:
        "packages/adapters/pi/dist-types/extension-impl.d.ts",
      entryModulePath: "packages/adapters/pi/dist/extension-impl.js",
    },
  ],
} as const satisfies ApiSurfaceMap;

const PublicSurfaceSchema = z
  .object({
    packageName: z.string().min(1),
    exportPaths: z.array(z.string().min(1)).min(1),
    declarationPath: z.string().min(1),
    configPath: z.string().min(1),
    reportPath: z
      .string()
      .min(1)
      .regex(/\.api\.md$/),
  })
  .strict();

const AuxiliarySchema = z
  .object({
    packageName: z.string().min(1),
    configPath: z.string().min(1),
    owner: z.string().min(1),
    rationale: z.string().min(1),
    entryDeclarationPath: z.string().min(1),
    entryModulePath: z.string().min(1),
  })
  .strict();

const ApiSurfaceMapSchema = z
  .object({
    version: z.literal(API_SURFACE_MAP_VERSION),
    public: z.array(PublicSurfaceSchema),
    auxiliary: z.array(AuxiliarySchema),
  })
  .strict();

export interface PublicPackageExport {
  readonly packageName: string;
  readonly exportPath: string;
  readonly targetPaths: readonly string[];
  readonly declarationPath?: string;
}

export interface PublicPackageManifestInput {
  readonly packageName: string;
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

export interface ApiSurfaceMapValidationInput {
  readonly root?: string;
  readonly map?: ApiSurfaceMap;
  readonly configPaths?: readonly string[];
  readonly publicExports?: readonly PublicPackageExport[];
  readonly reportPaths?: readonly string[];
  readonly requireReports?: boolean;
}

export type ApiSurfaceMapError =
  | { readonly type: "InvalidSurfaceMap"; readonly issues: readonly string[] }
  | {
      readonly type: "ConfigClassificationMissing";
      readonly configPath: string;
    }
  | {
      readonly type: "ConfigClassifiedMoreThanOnce";
      readonly configPath: string;
    }
  | {
      readonly type: "MappedConfigMissing";
      readonly configPath: string;
    }
  | {
      readonly type: "PublicExportMappingMissing";
      readonly packageName: string;
      readonly exportPath: string;
    }
  | {
      readonly type: "PublicExportMappingDuplicate";
      readonly packageName: string;
      readonly exportPath: string;
      readonly configPaths: readonly string[];
    }
  | {
      readonly type: "MappedExportUnknown";
      readonly packageName: string;
      readonly exportPath: string;
    }
  | {
      readonly type: "PublicDeclarationMismatch";
      readonly packageName: string;
      readonly exportPath: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly type: "CommittedApiReportMissing";
      readonly configPath: string;
      readonly reportPath: string;
    }
  | {
      readonly type: "PublicConfigReportDisabled";
      readonly configPath: string;
    }
  | {
      readonly type: "PublicConfigReportPathMismatch";
      readonly configPath: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly type: "PublicConfigRollupMismatch";
      readonly configPath: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly type: "AuxiliaryExported";
      readonly configPath: string;
      readonly packageName: string;
      readonly exportPath: string;
      readonly targetPath: string;
    }
  | {
      readonly type: "AuxiliaryDeclarationRoleInvalid";
      readonly configPath: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly type: "InvalidExtractorConfig";
      readonly configPath: string;
    }
  | {
      readonly type: "PackageManifestReadFailed";
      readonly path: string;
    }
  | {
      readonly type: "InvalidPackageExports";
      readonly packageName: string;
      readonly reason: string;
    }
  | {
      readonly type: "ConfigDiscoveryFailed";
      readonly root: string;
    };

interface ConfigMetadata {
  readonly mainEntryPointPath: string;
  readonly publicTrimmedPath: string;
  readonly reportEnabled: boolean;
  readonly reportPath: string | undefined;
}

/** Enumerates all export keys and their runtime/type targets for one package. */
export function enumeratePackageExports(
  input: PublicPackageManifestInput,
): Result<readonly PublicPackageExport[], ApiSurfaceMapError> {
  const exportsField = input.manifest.exports;
  if (exportsField === undefined)
    return err({
      type: "InvalidPackageExports",
      packageName: input.packageName,
      reason: "package manifest has no exports map",
    });

  const entries = exportEntries(exportsField);
  const result: PublicPackageExport[] = [];
  for (const [exportPath, value] of entries) {
    const targets = collectExportTargets(value)
      .map((target) => normalizePackageTarget(input.directory, target))
      .filter((target): target is string => target !== undefined);
    const typeTarget = collectTypeTargets(value)
      .map((target) => normalizePackageTarget(input.directory, target))
      .find((target): target is string => target !== undefined);
    if (targets.length === 0) continue;
    const base = {
      packageName: input.packageName,
      exportPath,
      targetPaths: [...new Set(targets)].sort(),
    };
    result.push(
      typeTarget === undefined
        ? base
        : { ...base, declarationPath: typeTarget },
    );
  }
  return ok(result);
}

/** Returns only exports that carry a TypeScript declaration target. */
export function enumeratePublicTypeExports(
  manifests: readonly PublicPackageManifestInput[],
): Result<readonly PublicPackageExport[], ApiSurfaceMapError> {
  const exports: PublicPackageExport[] = [];
  for (const manifest of manifests) {
    const result = enumeratePackageExports(manifest);
    if (result.isErr()) return err(result.error);
    exports.push(
      ...result.value.filter(
        (entry): entry is PublicPackageExport & { declarationPath: string } =>
          entry.declarationPath !== undefined,
      ),
    );
  }
  return ok(exports);
}

/** Discovers all extractor configs, including configs not yet classified. */
export function discoverApiExtractorConfigPaths(
  root: string,
): Result<readonly string[], ApiSurfaceMapError> {
  const result = Result.fromThrowable(
    () =>
      [
        ...new Bun.Glob(API_EXTRACTOR_CONFIG_GLOB).scanSync({
          cwd: root,
          onlyFiles: true,
        }),
      ]
        .map((path) => posixPath(path))
        .sort(),
    () => ({ type: "ConfigDiscoveryFailed" as const, root }),
  )();
  if (result.isErr()) return err(result.error);
  if (result.value.length === 0)
    return err({ type: "ConfigDiscoveryFailed", root });
  return ok(result.value);
}

/** Discovers committed report files for the repository-level validator. */
export function discoverApiReportPaths(
  root: string,
): Result<readonly string[], ApiSurfaceMapError> {
  const result = Result.fromThrowable(
    () =>
      [
        ...new Bun.Glob(API_REPORT_GLOB).scanSync({
          cwd: root,
          onlyFiles: true,
        }),
      ]
        .map((path) => posixPath(path))
        .sort(),
    () => ({ type: "ConfigDiscoveryFailed" as const, root }),
  )();
  if (result.isErr()) return err(result.error);
  return ok(result.value);
}

/**
 * Validates a supplied map and fixture inventory without reading the network
 * or invoking a harness. Tests use this seam to exercise every failure mode.
 */
export function validateApiSurfaceMap(
  input: ApiSurfaceMapValidationInput = {},
): Result<void, ApiSurfaceMapError> {
  const map = input.map ?? API_SURFACE_MAP;
  const parsed = ApiSurfaceMapSchema.safeParse(map);
  if (!parsed.success)
    return err({
      type: "InvalidSurfaceMap",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    });

  const configPaths = (input.configPaths ?? CONFIG_PATHS).map(posixPath);
  const publicEntries = parsed.data.public;
  const auxiliaryEntries = parsed.data.auxiliary;
  const classified = [...publicEntries, ...auxiliaryEntries].map((entry) =>
    posixPath(entry.configPath),
  );

  for (const configPath of configPaths) {
    const count = classified.filter((path) => path === configPath).length;
    if (count === 0)
      return err({ type: "ConfigClassificationMissing", configPath });
    if (count > 1)
      return err({
        type: "ConfigClassifiedMoreThanOnce",
        configPath,
      });
  }
  for (const configPath of new Set(classified))
    if (!configPaths.includes(configPath))
      return err({ type: "MappedConfigMissing", configPath });

  const publicExports =
    input.publicExports ?? mapToPublicExports(publicEntries);
  const publicExportKeys = new Set(
    publicExports.map((entry) =>
      exportKey(entry.packageName, entry.exportPath),
    ),
  );
  const mapExportKeys = new Map<string, string[]>();
  for (const entry of publicEntries) {
    for (const exportPath of entry.exportPaths) {
      const key = exportKey(entry.packageName, exportPath);
      const owners = mapExportKeys.get(key) ?? [];
      if (owners.length > 0)
        return err({
          type: "PublicExportMappingDuplicate",
          packageName: entry.packageName,
          exportPath,
          configPaths: [...owners, entry.configPath],
        });
      owners.push(entry.configPath);
      mapExportKeys.set(key, owners);
      if (!publicExportKeys.has(key))
        return err({
          type: "MappedExportUnknown",
          packageName: entry.packageName,
          exportPath,
        });
    }
  }

  for (const surface of publicExports) {
    if (surface.declarationPath === undefined) continue;
    const owners = publicEntries.filter(
      (entry) =>
        entry.packageName === surface.packageName &&
        entry.exportPaths.includes(surface.exportPath),
    );
    if (owners.length === 0)
      return err({
        type: "PublicExportMappingMissing",
        packageName: surface.packageName,
        exportPath: surface.exportPath,
      });
    if (owners.length > 1)
      return err({
        type: "PublicExportMappingDuplicate",
        packageName: surface.packageName,
        exportPath: surface.exportPath,
        configPaths: owners.map((entry) => entry.configPath),
      });
    const owner = owners[0];
    if (owner === undefined) continue;
    if (posixPath(owner.declarationPath) !== posixPath(surface.declarationPath))
      return err({
        type: "PublicDeclarationMismatch",
        packageName: surface.packageName,
        exportPath: surface.exportPath,
        expected: surface.declarationPath,
        actual: owner.declarationPath,
      });
  }

  const configSet = new Set(configPaths);
  for (const entry of publicEntries) {
    if (!configSet.has(posixPath(entry.configPath)))
      return err({ type: "MappedConfigMissing", configPath: entry.configPath });
    if (input.requireReports !== false) {
      const reports = new Set((input.reportPaths ?? []).map(posixPath));
      if (!reports.has(posixPath(entry.reportPath)))
        return err({
          type: "CommittedApiReportMissing",
          configPath: entry.configPath,
          reportPath: entry.reportPath,
        });
    }
  }

  const allExports = input.publicExports ?? publicExports;
  for (const auxiliary of auxiliaryEntries) {
    const targets = allExports.filter(
      (entry) => entry.packageName === auxiliary.packageName,
    );
    for (const target of targets) {
      const auxiliaryPaths = new Set([
        posixPath(auxiliary.entryModulePath),
        posixPath(auxiliary.entryDeclarationPath),
      ]);
      const reached = target.targetPaths.find((path) =>
        auxiliaryPaths.has(posixPath(path)),
      );
      if (reached !== undefined)
        return err({
          type: "AuxiliaryExported",
          configPath: auxiliary.configPath,
          packageName: auxiliary.packageName,
          exportPath: target.exportPath,
          targetPath: reached,
        });
    }
  }

  if (input.root !== undefined) {
    for (const entry of publicEntries) {
      const metadata = readConfigMetadata(input.root, entry.configPath);
      if (metadata.isErr()) return err(metadata.error);
      if (!metadata.value.reportEnabled)
        return err({
          type: "PublicConfigReportDisabled",
          configPath: entry.configPath,
        });
      if (metadata.value.reportPath !== posixPath(entry.reportPath))
        return err({
          type: "PublicConfigReportPathMismatch",
          configPath: entry.configPath,
          expected: entry.reportPath,
          actual: metadata.value.reportPath ?? "",
        });
      if (metadata.value.publicTrimmedPath !== posixPath(entry.declarationPath))
        return err({
          type: "PublicConfigRollupMismatch",
          configPath: entry.configPath,
          expected: entry.declarationPath,
          actual: metadata.value.publicTrimmedPath,
        });
    }
    for (const auxiliary of auxiliaryEntries) {
      const expectedRollup = posixPath(
        auxiliary.entryDeclarationPath.replace("/dist-types/", "/dist/"),
      );
      if (
        !isDeclarationPath(auxiliary.entryDeclarationPath) ||
        !auxiliary.entryModulePath.endsWith(".js")
      )
        return err({
          type: "AuxiliaryDeclarationRoleInvalid",
          configPath: auxiliary.configPath,
          expected: "an internal .d.ts entry with a .js runtime module",
          actual: `${auxiliary.entryDeclarationPath} / ${auxiliary.entryModulePath}`,
        });
      const metadata = readConfigMetadata(input.root, auxiliary.configPath);
      if (metadata.isErr()) return err(metadata.error);
      if (
        metadata.value.mainEntryPointPath !==
          posixPath(auxiliary.entryDeclarationPath) ||
        metadata.value.publicTrimmedPath !== expectedRollup
      )
        return err({
          type: "AuxiliaryDeclarationRoleInvalid",
          configPath: auxiliary.configPath,
          expected: `${auxiliary.entryDeclarationPath} -> ${expectedRollup}`,
          actual: `${metadata.value.mainEntryPointPath} -> ${metadata.value.publicTrimmedPath}`,
        });
    }
  }

  return ok(undefined);
}

/** Loads the real package export maps and validates the checked-in contract. */
export function validateRepositoryApiSurfaceMap(
  root: string,
  options: {
    readonly map?: ApiSurfaceMap;
    readonly requireReports?: boolean;
  } = {},
): ResultAsync<void, ApiSurfaceMapError> {
  const configs = discoverApiExtractorConfigPaths(root);
  if (configs.isErr()) return errAsync(configs.error);
  const reports = discoverApiReportPaths(root);
  if (reports.isErr()) return errAsync(reports.error);
  return loadPublicPackageExports(root).andThen((publicExports) =>
    liftResult(
      validateApiSurfaceMap({
        root,
        map: options.map ?? API_SURFACE_MAP,
        configPaths: configs.value,
        publicExports,
        reportPaths: reports.value,
        requireReports: options.requireReports ?? true,
      }),
    ),
  );
}

function loadPublicPackageExports(
  root: string,
): ResultAsync<readonly PublicPackageExport[], ApiSurfaceMapError> {
  let result: ResultAsync<PublicPackageExport[], ApiSurfaceMapError> = okAsync(
    [],
  );
  for (const [packageName, packageInfo] of Object.entries(PUBLIC_PACKAGES)) {
    const path = join(root, packageInfo.directory, "package.json");
    result = result.andThen((entries) =>
      ResultAsync.fromPromise(Bun.file(path).json(), () => ({
        type: "PackageManifestReadFailed" as const,
        path: posixPath(relative(root, path)),
      })).andThen((manifest) => {
        if (
          manifest === null ||
          typeof manifest !== "object" ||
          Array.isArray(manifest)
        )
          return errAsync({
            type: "InvalidPackageExports" as const,
            packageName,
            reason: "package manifest is not an object",
          });
        return liftResult(
          enumeratePackageExports({
            packageName,
            directory: packageInfo.directory,
            manifest: manifest as Record<string, unknown>,
          }).map((found) => [...entries, ...found]),
        );
      }),
    );
  }
  return result;
}

function readConfigMetadata(
  root: string,
  configPath: string,
): Result<ConfigMetadata, ApiSurfaceMapError> {
  const absolute = resolve(root, configPath);
  const parsed = Result.fromThrowable(
    () => ExtractorConfig.loadFile(absolute),
    () => ({ type: "InvalidExtractorConfig" as const, configPath }),
  )();
  if (parsed.isErr()) return err(parsed.error);
  const config = parsed.value as unknown as Record<string, unknown>;
  const packageFolder = dirname(absolute);
  const mainEntryPointFilePath = stringAt(config, "mainEntryPointFilePath");
  const dtsRollup = objectAt(config, "dtsRollup");
  const publicTrimmedFilePath = stringAt(dtsRollup, "publicTrimmedFilePath");
  const apiReport = objectAt(config, "apiReport");
  const reportEnabled = apiReport?.enabled === true;
  const reportFolder = stringAt(apiReport, "reportFolder");
  const reportFileName = stringAt(apiReport, "reportFileName");
  const mainEntryPointPath = expandConfigPath(
    root,
    packageFolder,
    mainEntryPointFilePath,
  );
  const publicTrimmedPath = expandConfigPath(
    root,
    packageFolder,
    publicTrimmedFilePath,
  );
  let reportPath: string | undefined;
  if (reportFolder !== undefined && reportFileName !== undefined) {
    const folder = expandConfigPath(root, packageFolder, reportFolder);
    const name = reportFileName.endsWith(".api.md")
      ? reportFileName
      : `${reportFileName}.api.md`;
    reportPath = posixPath(relative(root, join(folder, name)));
  }
  return ok({
    mainEntryPointPath,
    publicTrimmedPath,
    reportEnabled,
    reportPath,
  });
}

function liftResult<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.isOk() ? okAsync(result.value) : errAsync(result.error);
}

function mapToPublicExports(
  entries: readonly PublicApiSurface[],
): readonly PublicPackageExport[] {
  return entries.flatMap((entry) =>
    entry.exportPaths.map((exportPath) => ({
      packageName: entry.packageName,
      exportPath,
      targetPaths: [entry.declarationPath],
      declarationPath: entry.declarationPath,
    })),
  );
}

function exportEntries(value: unknown): readonly [string, unknown][] {
  if (typeof value === "string" || Array.isArray(value)) return [[".", value]];
  if (value === null || typeof value !== "object") return [];
  const entries = Object.entries(value);
  if (entries.some(([key]) => key.startsWith("."))) return entries;
  return [[".", value]];
}

function collectExportTargets(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectExportTargets);
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectExportTargets);
}

function collectTypeTargets(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectTypeTargets);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = typeof record.types === "string" ? [record.types] : [];
  return [
    ...direct,
    ...Object.entries(record)
      .filter(([key]) => key !== "types")
      .flatMap(([, child]) => collectTypeTargets(child)),
  ];
}

function normalizePackageTarget(
  packageDirectory: string,
  target: string,
): string | undefined {
  if (!target.startsWith(".")) return undefined;
  return posixPath(join(packageDirectory, target));
}

function expandConfigPath(
  root: string,
  packageFolder: string,
  value: string | undefined,
): string {
  if (value === undefined) return "";
  const expanded = value
    .replaceAll("<projectFolder>", packageFolder)
    .replaceAll("<lookup>", packageFolder);
  return posixPath(relative(root, resolve(packageFolder, expanded)));
}

function stringAt(
  object: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function objectAt(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = object[key];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function exportKey(packageName: string, exportPath: string): string {
  return `${packageName}:${exportPath}`;
}

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isDeclarationPath(path: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/.test(path);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const result = await validateRepositoryApiSurfaceMap(root);
  if (result.isErr()) {
    log.error({ error: result.error }, "API surface map is invalid");
    process.exitCode = 1;
  } else {
    log.info(
      {
        configs: CONFIG_PATHS.length,
        publicSurfaces: API_SURFACE_MAP.public.length,
        auxiliary: API_SURFACE_MAP.auxiliary.length,
      },
      "API surface map is valid",
    );
  }
}
