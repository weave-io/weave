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

/**
 * Installer interface for a supported harness.
 *
 * @deprecated `supported: boolean` is a legacy binary installer-support signal.
 * Future adapter work should implement `AdapterCapabilityContract` from
 * `@weaveio/weave-engine` instead, which provides richer `native`/`emulated`/
 * `degraded`/`unsupported` readiness levels evaluated by
 * `evaluateCoreReadinessProfile`. The boolean can be derived from
 * `ProfileEvaluationResult.ready` when capability readiness is available.
 *
 * See: docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md
 * See: docs/product-vision.md#adapter-capability-contract
 */
export interface HarnessInstaller {
  readonly id: SupportedHarnessId;
  /**
   * @deprecated Legacy binary installer-support signal. Use
   * `AdapterCapabilityContract` + `evaluateCoreReadinessProfile` from
   * `@weaveio/weave-engine` for richer readiness reporting.
   */
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

function unsupportedInstaller(id: SupportedHarnessId): HarnessInstaller {
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

function skipUnsupported(id: SupportedHarnessId): InstallResult {
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
