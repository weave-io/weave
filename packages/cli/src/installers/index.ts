import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { SupportedHarnessId } from "../detect/index.js";
import type { FileSystem } from "../fs/file-system.js";
import { ClaudeCodeInstaller, type ComposeClaudeCode } from "./claude-code.js";
import { OpenCodeInstaller } from "./opencode.js";
import { OpenCode2Installer } from "./opencode2.js";

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
  scope?: "global" | "local";
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

/** Harnesses `weave init` can install Weave into. */
export const INSTALLABLE_HARNESSES: readonly SupportedHarnessId[] = [
  "opencode",
  "opencode2",
  "claude-code",
];

export function isInstallable(id: SupportedHarnessId): boolean {
  return INSTALLABLE_HARNESSES.includes(id);
}

/**
 * Without a compose step (bulk installs, tests), Claude Code reports how to
 * compose instead of failing.
 */
const NO_COMPOSE: ComposeClaudeCode = () =>
  errAsync("run `weave compose --adapter claude-code --init` in the project");

export function installerRegistry(
  fs: FileSystem,
  composeClaudeCode: ComposeClaudeCode = NO_COMPOSE,
): Record<SupportedHarnessId, HarnessInstaller> {
  return {
    opencode: new OpenCodeInstaller(fs),
    opencode2: new OpenCode2Installer(fs),
    "claude-code": new ClaudeCodeInstaller(composeClaudeCode),
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
        message: `Weave for ${id} is not published yet.`,
      }),
  };
}

function skipUnsupported(id: SupportedHarnessId): InstallResult {
  return {
    harness: id,
    changed: false,
    messages: [`Skipped ${id}: Weave for ${id} is not published yet.`],
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
