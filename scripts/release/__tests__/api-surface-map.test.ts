import { describe, expect, it } from "bun:test";
import {
  API_SURFACE_MAP,
  type ApiSurfaceMap,
  type PublicPackageExport,
  validateApiSurfaceMap,
  validateRepositoryApiSurfaceMap,
} from "../api-surface-map.js";

const ROOT = process.cwd();
const CONFIG_PATHS = [
  ...API_SURFACE_MAP.public.map((entry) => entry.configPath),
  ...API_SURFACE_MAP.auxiliary.map((entry) => entry.configPath),
];
const REPORT_PATHS = API_SURFACE_MAP.public.map((entry) => entry.reportPath);
const PUBLIC_EXPORTS: readonly PublicPackageExport[] =
  API_SURFACE_MAP.public.flatMap((entry) =>
    entry.exportPaths.map((exportPath) => ({
      packageName: entry.packageName,
      exportPath,
      declarationPath: entry.declarationPath,
      targetPaths: [entry.declarationPath],
    })),
  );

function validate(
  map: ApiSurfaceMap = API_SURFACE_MAP,
  options: {
    configPaths?: readonly string[];
    reportPaths?: readonly string[];
    publicExports?: readonly PublicPackageExport[];
  } = {},
) {
  return validateApiSurfaceMap({
    map,
    configPaths: options.configPaths ?? CONFIG_PATHS,
    reportPaths: options.reportPaths ?? REPORT_PATHS,
    publicExports: options.publicExports ?? PUBLIC_EXPORTS,
  });
}

describe("API surface map", () => {
  it("validates every checked-in config and public export", async () => {
    expect((await validateRepositoryApiSurfaceMap(ROOT)).isOk()).toBe(true);
  });

  it("rejects a public export with no authoritative config", () => {
    const first = API_SURFACE_MAP.public[0];
    expect(first).toBeDefined();
    const map = {
      ...API_SURFACE_MAP,
      public: API_SURFACE_MAP.public.filter((entry) => entry !== first),
    } as ApiSurfaceMap;
    const result = validate(map, {
      configPaths: CONFIG_PATHS.filter((path) => path !== first?.configPath),
      reportPaths: REPORT_PATHS.filter((path) => path !== first?.reportPath),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("PublicExportMappingMissing");
  });

  it("rejects a missing committed report", () => {
    const result = validate(API_SURFACE_MAP, {
      reportPaths: REPORT_PATHS.slice(1),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("CommittedApiReportMissing");
  });

  it("rejects two configs claiming one export", () => {
    const first = API_SURFACE_MAP.public[0];
    expect(first).toBeDefined();
    const duplicate = {
      ...first,
      configPath: "packages/fixture/api-extractor.duplicate.json",
      reportPath: "packages/fixture/etc/duplicate.api.md",
    };
    const map = {
      ...API_SURFACE_MAP,
      public: [...API_SURFACE_MAP.public, duplicate],
    } as ApiSurfaceMap;
    const result = validate(map, {
      configPaths: [...CONFIG_PATHS, duplicate.configPath],
      reportPaths: [...REPORT_PATHS, duplicate.reportPath],
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("PublicExportMappingDuplicate");
  });

  it("rejects an unclassified extra extractor config", () => {
    const extra = "packages/fixture/api-extractor.extra.json";
    const result = validate(API_SURFACE_MAP, {
      configPaths: [...CONFIG_PATHS, extra],
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.type).toBe("ConfigClassificationMissing");
  });

  it("rejects an auxiliary entry that becomes runtime-exported", () => {
    const publicExports: readonly PublicPackageExport[] = [
      ...PUBLIC_EXPORTS,
      {
        packageName: "@weaveio/weave-adapter-pi",
        exportPath: "./extension-impl",
        targetPaths: ["packages/adapters/pi/dist/extension-impl.js"],
      },
    ];
    const result = validate(API_SURFACE_MAP, { publicExports });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("AuxiliaryExported");
  });
});
