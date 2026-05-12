import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { SupportedHarnessId } from "../detect/index.js";
import type { FileSystem } from "../fs/file-system.js";
import { OpenCodeInstaller } from "./opencode.js";

export type AdapterModule = {
  id: string;
  label: string;
  description: string;
};

export type InstallRequest = {
  harness: SupportedHarnessId;
  configPath: string;
  selectedModules: string[];
  force: boolean;
};

export type InstallResult = {
  harness: SupportedHarnessId;
  changed: boolean;
  messages: string[];
};

export type InstallError =
  | { type: "UnsupportedHarness"; harness: SupportedHarnessId; message: string }
  | { type: "UndetectedHarness"; harness: SupportedHarnessId; message: string }
  | {
      type: "InstallFailed";
      harness: SupportedHarnessId;
      path: string;
      cause: unknown;
    };

export interface HarnessInstaller {
  readonly id: SupportedHarnessId;
  readonly supported: boolean;
  readonly optionalModules: AdapterModule[];
  install(request: InstallRequest): ResultAsync<InstallResult, InstallError>;
}

export function installerRegistry(
  fs: FileSystem,
): Record<SupportedHarnessId, HarnessInstaller> {
  return {
    opencode: new OpenCodeInstaller(fs),
    "claude-code": unsupportedInstaller("claude-code"),
    pi: unsupportedInstaller("pi"),
  };
}

export function unsupportedInstaller(id: SupportedHarnessId): HarnessInstaller {
  return {
    id,
    supported: false,
    optionalModules: [],
    install: () =>
      errAsync({
        type: "UnsupportedHarness",
        harness: id,
        message: `${id} installer support is not available yet.`,
      }),
  };
}

export function skipUnsupported(id: SupportedHarnessId): InstallResult {
  return {
    harness: id,
    changed: false,
    messages: [`Skipped ${id}: installer support is not available yet.`],
  };
}

export function installAllSupported(input: {
  fs: FileSystem;
  harnesses: { id: SupportedHarnessId; configPath: string }[];
  force: boolean;
  selectedModules?: Record<string, string[]>;
}): ResultAsync<InstallResult[], InstallError> {
  const registry = installerRegistry(input.fs);
  let chain = okAsync<InstallResult[], InstallError>([]);

  for (const harness of input.harnesses) {
    const installer = registry[harness.id];
    if (!installer.supported) {
      chain = chain.map((results) => [...results, skipUnsupported(harness.id)]);
      continue;
    }

    chain = chain.andThen((results) =>
      installer
        .install({
          harness: harness.id,
          configPath: harness.configPath,
          selectedModules: input.selectedModules?.[harness.id] ?? [],
          force: input.force,
        })
        .map((result) => [...results, result]),
    );
  }

  return chain;
}
