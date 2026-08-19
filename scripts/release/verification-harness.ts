import { logger } from "@weaveio/weave-engine";
import { okAsync, type Result, type ResultAsync } from "neverthrow";
import type { RegistryError } from "./errors.js";
import {
  type ChannelProofBlocker,
  type ChannelProofPass,
  evaluateChannelProofs,
  runPackagedChannelProofs,
} from "./harness-proof.js";
import type { NpmRegistryClient } from "./npm-registry-client.js";

export {
  adaptersInPublishSet,
  resolveChangedAdapters,
  resolveNextChangedAdapters,
  resolveNightlyChangedAdapters,
  resolveStableChangedAdapters,
} from "./changed-adapters.js";
export {
  evaluateChannelProofs,
  HARNESS_PROOF_STAGES,
  proveChangedAdapters,
  provePublishSetConsumers,
  runCleanConsumer,
  runHarnessProof,
  runPackagedChannelProofs,
  validateProofCredentials,
} from "./harness-proof.js";
export { FIXTURE_SHA } from "./release-fixtures.js";

export interface ScenarioResult {
  name: string;
  outcome: "pass" | "fail";
  detail: string;
}

export class FixtureRegistry implements NpmRegistryClient {
  constructor(
    private readonly versions: Readonly<Record<string, readonly string[]>>,
  ) {}

  publish(): ResultAsync<void, RegistryError> {
    return okAsync(undefined);
  }
  viewVersion(): ResultAsync<string, RegistryError> {
    return okAsync("");
  }
  viewDistTags(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  distTagLs(): ResultAsync<Record<string, string>, RegistryError> {
    return okAsync({});
  }
  verifyPublished(): ResultAsync<void, RegistryError> {
    return okAsync(undefined);
  }
  listVersions(name: string): ResultAsync<readonly string[], RegistryError> {
    return okAsync(this.versions[name] ?? []);
  }
}

/** Runs deterministic, injected scenarios and emits CI-readable structured evidence. */
export async function runScenarios(
  runner: string,
  scenarios: readonly {
    name: string;
    verify: () => Promise<boolean> | boolean;
  }[],
): Promise<void> {
  const log = logger.child({ module: runner });
  const forced = Bun.env.WEAVE_RELEASE_FORCE_SCENARIO_FAILURE;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const verified = await scenario.verify();
    const pass = verified && forced !== scenario.name;
    results.push({
      name: scenario.name,
      outcome: pass ? "pass" : "fail",
      detail: pass
        ? "expected outcome observed"
        : "scenario deviated from expected outcome",
    });
  }
  log.info({ scenarios: results }, "release verification scenario table");
  if (results.some((result) => result.outcome === "fail")) process.exitCode = 1;
}

export const FIXTURE_CLOCK = {
  now: () => new Date("2026-07-19T12:00:00.000Z"),
  sleep: () => okAsync(undefined),
};
export const FIXTURE_VERSIONS = {
  "@weaveio/weave-cli": "0.1.0",
  "@weaveio/weave-adapter-opencode": "0.1.0",
  "@weaveio/weave-adapter-claude-code": "0.1.0",
  "@weaveio/weave-adapter-pi": "0.1.0",
} as const;

/**
 * Channel gate used by later publish jobs: missing, skipped, failed, or
 * digest-mismatched consumer/harness proof blocks the whole run before OIDC.
 */
export function runChannelProofGate(
  input: Parameters<typeof evaluateChannelProofs>[0],
): Result<ChannelProofPass, ChannelProofBlocker> {
  return evaluateChannelProofs(input);
}

export const runPackagedProofChain = runPackagedChannelProofs;
