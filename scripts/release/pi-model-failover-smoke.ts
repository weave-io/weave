import { dirname } from "node:path";

import { runBoundedCommand } from "./pi-model-failover-smoke/command-runner.js";
import * as contract from "./pi-model-failover-smoke/contract.js";
import {
  SAFE_SYSTEM_PATH,
  type SmokeFailure,
  safeDiagnostic,
} from "./pi-model-failover-smoke/contract.js";
import * as environment from "./pi-model-failover-smoke/environment.js";
import {
  parseSmokeArgs,
  validateReportTargetPath,
} from "./pi-model-failover-smoke/environment.js";
import * as fixtureFiles from "./pi-model-failover-smoke/fixture-files.js";
import { makeDirectory } from "./pi-model-failover-smoke/fixture-files.js";
import * as fixtureSources from "./pi-model-failover-smoke/fixture-sources.js";
import * as health from "./pi-model-failover-smoke/health-observation.js";
import * as nativeObservation from "./pi-model-failover-smoke/native-observation.js";
import * as provenance from "./pi-model-failover-smoke/provenance.js";
import * as ptyRunner from "./pi-model-failover-smoke/pty-runner.js";
import { runReleaseSmoke } from "./pi-model-failover-smoke/release-orchestrator.js";
import * as reportProjection from "./pi-model-failover-smoke/report-projection.js";
import { serializeSmokeReport } from "./pi-model-failover-smoke/report-projection.js";
import * as reportWriter from "./pi-model-failover-smoke/report-writer.js";
import { writeSmokeReportAtomically } from "./pi-model-failover-smoke/report-writer.js";
import * as scenarioRunner from "./pi-model-failover-smoke/scenario-runner.js";
import * as scenarioSetup from "./pi-model-failover-smoke/scenario-setup.js";
import * as verifiedCleanup from "./pi-model-failover-smoke/verified-cleanup.js";

export type { CleanupSignalSource } from "./pi-model-failover-smoke/command-runner.js";
export {
  createCleanupResourceTracker,
  runBoundedCommand,
  runWithCleanup,
} from "./pi-model-failover-smoke/command-runner.js";
export type {
  CleanupClock,
  CleanupDiagnosticCode,
  CleanupHooks,
  CleanupProcessHandle,
  CleanupProcessObservation,
  CleanupResourceKind,
  CleanupResourceTracker,
  CleanupRootOptions,
  CleanupVerification,
  CommandResult,
  FallbackScenarioFacts,
  FixtureContextFact,
  FixtureControlFacts,
  FixtureDescriptorCounts,
  FixtureHistoryDescriptor,
  FixtureHistoryFacts,
  FixtureLifecycleFacts,
  FixtureMarkerCorrelation,
  FixtureMessageDescriptor,
  FixtureMessageFacts,
  FixtureProviderCapture,
  FixtureShimFacts,
  FixtureSnapshot,
  HealthFacts,
  HostSurfaceGapFact,
  InstalledAdapterProvenance,
  NativeSessionObservation,
  PackedArtifact,
  ReportDiagnosticCode,
  ReportOutcomeCode,
  RollbackScenarioFacts,
  SafeModelIdentity,
  SanitizedFallbackScenarioFacts,
  SanitizedRollbackScenarioFacts,
  SanitizedSmokeReport,
  SmokeCase,
  SmokeCliArgs,
  SmokeFailure,
  SmokeProvenance,
  SmokeReport,
  SpawnedProcessLike,
  SpawnFactory,
  SpawnOptionsLike,
} from "./pi-model-failover-smoke/contract.js";
export {
  ADAPTER_READY_MARKER,
  artifactDigest,
  CHECKLIST_VERSION,
  CHILD_TASK,
  CLEANUP_DIAGNOSTIC_CODES,
  CLEANUP_FORCE_TIMEOUT_MS,
  CLEANUP_GRACE_TIMEOUT_MS,
  CLEANUP_PROBE_TIMEOUT_MS,
  CLEANUP_ROOT_MAX_ATTEMPTS,
  CLEANUP_ROOT_TIMEOUT_MS,
  containsForbiddenContent,
  DEFAULT_COMMAND_TIMEOUT_MS,
  EXACT_PI_VERSION,
  EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT,
  EXPECTED_NATIVE_LINE,
  FALLBACK_SUCCESS,
  FIXTURE_CONTEXT_FACTS,
  fixtureCorrelationHash,
  fixtureCustomTypeHash,
  fixtureDescriptorForFact,
  fixtureEntryTypeHash,
  fixtureHistoryDescriptorForFact,
  fixtureMarkerTokenHash,
  fixtureRoleHash,
  MAX_CAPTURE_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_CONTEXT_DESCRIPTOR_COUNT,
  MAX_DIAGNOSTIC_COUNT,
  MAX_DIAGNOSTIC_LENGTH,
  MAX_HISTORY_DESCRIPTOR_COUNT,
  MAX_REPORT_ARRAY_LENGTH,
  MAX_REPORT_BYTES,
  MAX_REPORT_INTEGER,
  MAX_REPORT_OBJECT_KEYS,
  MAX_REPORT_STRING_LENGTH,
  MAX_REPORT_TIMESTAMP_MS,
  PARENT_TASK,
  PROVIDER_FAILURE_MARKER,
  RECOVERY_MARKER,
  REPORT_DIAGNOSTIC_CODES,
  REPORT_OUTCOME_CODES,
  ROLLBACK_DISABLED_SURFACE,
  ROLLBACK_SHIM_BOUNDARY,
  ROLLBACK_TASK,
  redactDiagnostic,
  SMOKE_CASES,
} from "./pi-model-failover-smoke/contract.js";
export type { IsolatedPathPolicyInput } from "./pi-model-failover-smoke/environment.js";
export {
  buildExpectDriver,
  buildPiCommand,
  buildPiLaunchCommand,
  parseSmokeArgs,
  validateCreatedIsolatedPathPolicy,
  validateEphemeralReportPath,
  validateExpectedPiVersion,
  validateIsolatedPathPolicy,
  validateStrictProvenanceEnvironment,
} from "./pi-model-failover-smoke/environment.js";
export { validateFallbackFacts } from "./pi-model-failover-smoke/fallback-validation.js";
export {
  scenarioLauncherPath,
  validateScenarioLauncher,
} from "./pi-model-failover-smoke/fixture-files.js";
export {
  validateControlObserverSource,
  validateFixtureSourceBoundary,
  validateRollbackShimSource,
} from "./pi-model-failover-smoke/fixture-sources.js";
export {
  parseHealthFacts,
  validateHealthObservation,
} from "./pi-model-failover-smoke/health-observation.js";
export { validateObservedSources } from "./pi-model-failover-smoke/observation-validation.js";
export type {
  PiCliProvenance,
  VerifyInstalledAdapterInput,
} from "./pi-model-failover-smoke/provenance.js";
export {
  inspectPackedArtifact,
  inspectPiCliProvenance,
  validateLoadedAdapterProvenance,
  validatePiVersion,
  verifyArtifactDigest,
  verifyArtifactFileUnchanged,
  verifyInstalledAdapterPackage,
} from "./pi-model-failover-smoke/provenance.js";
export {
  projectSanitizedSmokeReport,
  serializeSmokeReport,
  validateReportSafety,
} from "./pi-model-failover-smoke/report-projection.js";
export { writeSmokeReportAtomically } from "./pi-model-failover-smoke/report-writer.js";
export { validateRollbackFacts } from "./pi-model-failover-smoke/rollback-validation.js";

async function writeStdout(value: string): Promise<void> {
  await Bun.write(Bun.stdout, value);
}

async function writeStderr(value: string): Promise<void> {
  await Bun.write(Bun.stderr, value);
}

function cliError(error: SmokeFailure): string {
  return `${JSON.stringify({
    ok: false,
    error: error.type,
    detail: safeDiagnostic(error.detail ?? ""),
  })}\n`;
}

async function cli(): Promise<number> {
  const parsed = parseSmokeArgs(Bun.argv.slice(2));
  if (parsed.isErr()) {
    await writeStderr(cliError(parsed.error));
    return 2;
  }
  const result = await runReleaseSmoke(parsed.value);
  if (result.isErr()) {
    await writeStderr(cliError(result.error));
    return 1;
  }
  const serialized = serializeSmokeReport(result.value);
  if (serialized.isErr()) {
    await writeStderr(cliError(serialized.error));
    return 1;
  }
  const validatedReportPath = await validateReportTargetPath(
    parsed.value.reportPath,
  );
  if (validatedReportPath.isErr()) {
    await writeStderr(cliError(validatedReportPath.error));
    return 1;
  }
  const reportParent = dirname(validatedReportPath.value);
  const reportParentProbe = await runBoundedCommand(
    ["test", "-d", reportParent],
    {
      cwd: ".",
      env: { PATH: SAFE_SYSTEM_PATH },
      timeoutMs: 2_000,
      allowExitCodes: [1],
    },
  );
  if (reportParentProbe.isErr()) {
    await writeStderr(cliError(reportParentProbe.error));
    return 1;
  }
  if (reportParentProbe.value.code !== 0) {
    const parent = await makeDirectory(
      reportParent,
      ".",
      { PATH: SAFE_SYSTEM_PATH },
      2_000,
    );
    if (parent.isErr()) {
      await writeStderr(cliError(parent.error));
      return 1;
    }
  }
  const written = await writeSmokeReportAtomically(
    parsed.value.reportPath,
    result.value,
  );
  if (written.isErr()) {
    await writeStderr(cliError(written.error));
    return 1;
  }
  await writeStdout(serialized.value);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await cli();
}

export const __testing = {
  PACKAGE_NAME: contract.PACKAGE_NAME,
  PACKAGE_VERSION: contract.PACKAGE_VERSION,
  FIXTURE_PACKAGE_NAME: contract.FIXTURE_PACKAGE_NAME,
  fixtureSource: fixtureSources.fixtureSource,
  controlObserverSource: fixtureSources.controlObserverSource,
  rollbackShimSource: fixtureSources.rollbackShimSource,
  validateRollbackShimSource: fixtureSources.validateRollbackShimSource,
  fixturePackageJson: fixtureFiles.fixturePackageJson,
  settingsJson: fixtureFiles.settingsJson,
  weaveSmokeConfig: fixtureFiles.weaveSmokeConfig,
  visibleEventCount: health.visibleEventCount,
  validateFixtureSourceBoundary: fixtureSources.validateFixtureSourceBoundary,
  validateControlObserverSource: fixtureSources.validateControlObserverSource,
  inspectPackedArtifact: provenance.inspectPackedArtifact,
  inspectPiCliProvenance: provenance.inspectPiCliProvenance,
  validateCreatedIsolatedPathPolicy:
    environment.validateCreatedIsolatedPathPolicy,
  validateIsolatedPathPolicy: environment.validateIsolatedPathPolicy,
  validateLoadedAdapterProvenance: provenance.validateLoadedAdapterProvenance,
  validateStrictProvenanceEnvironment:
    environment.validateStrictProvenanceEnvironment,
  verifyArtifactFileUnchanged: provenance.verifyArtifactFileUnchanged,
  verifyInstalledAdapterPackage: provenance.verifyInstalledAdapterPackage,
  readNativeSessionSnapshots: nativeObservation.readNativeSessionSnapshots,
  mergeNativeSessionObservations:
    nativeObservation.mergeNativeSessionObservations,
  assembleSnapshots: nativeObservation.assembleSnapshots,
  setupScenario: scenarioSetup.setupScenario,
  runPty: ptyRunner.runPty,
  runScenario: scenarioRunner.runScenario,
  cleanupRoot: verifiedCleanup.cleanupRoot,
  projectSanitizedSmokeReport: reportProjection.projectSanitizedSmokeReport,
  serializeSmokeReport: reportProjection.serializeSmokeReport,
  validateReportSafety: reportProjection.validateReportSafety,
  writeSmokeReportAtomically: reportWriter.writeSmokeReportAtomically,
};
