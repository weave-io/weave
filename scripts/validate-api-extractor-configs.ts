import { resolve } from "node:path";
import { ExtractorConfig } from "@microsoft/api-extractor";
import { err, ok, Result } from "neverthrow";

const CONFIG_PATHS = [
  "packages/cli/api-extractor.json",
  "packages/adapters/opencode/api-extractor.index.json",
  "packages/adapters/opencode/api-extractor.plugin.json",
  "packages/adapters/claude-code/api-extractor.json",
  "packages/adapters/pi/api-extractor.index.json",
  "packages/adapters/pi/api-extractor.extension.json",
] as const;

type ApiExtractorConfigError = {
  type: "InvalidApiExtractorConfig";
  path: string;
};

export function validateApiExtractorConfig(
  path: string,
): Result<void, ApiExtractorConfigError> {
  const result = Result.fromThrowable(
    () => {
      const configPath = resolve(path);
      const configObject = ExtractorConfig.loadFile(configPath);
      ExtractorConfig.prepare({
        configObject,
        configObjectFullPath: configPath,
        packageJsonFullPath: resolve(path, "..", "package.json"),
        ignoreMissingEntryPoint: true,
      });
    },
    () => ({ type: "InvalidApiExtractorConfig" as const, path }),
  )();
  if (result.isErr()) return err(result.error);
  return ok(undefined);
}

export function validateApiExtractorConfigs(): Result<
  void,
  ApiExtractorConfigError
> {
  for (const path of CONFIG_PATHS) {
    const result = validateApiExtractorConfig(path);
    if (result.isErr()) return err(result.error);
  }
  return ok(undefined);
}

if (import.meta.main) {
  const result = validateApiExtractorConfigs();
  if (result.isErr()) process.exitCode = 1;
}
