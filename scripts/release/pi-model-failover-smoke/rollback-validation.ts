import { err, ok, type Result } from "neverthrow";
import {
  type FixtureSnapshot,
  failure,
  fixtureCorrelationHash,
  NATIVE_RECOVERY_ENTRY_TYPE,
  NATIVE_RECOVERY_MARKER_TYPE,
  ROLLBACK_DISABLED_SURFACE,
  ROLLBACK_SHIM_BOUNDARY,
  type RollbackScenarioFacts,
  RUNTIME_MODEL_FALLBACK_PROBE_REASONS,
  type SafeModelIdentity,
  type ScenarioObservation,
  type SmokeFailure,
} from "./contract.js";
import {
  normalizedTuiOutput,
  validateHealthObservation,
} from "./health-observation.js";
import { sameIdentity } from "./observation-comparison.js";
import { validateObservedSources } from "./observation-validation.js";
import { verifiedCleanup } from "./verified-cleanup.js";
export function validateRollbackFacts(input: {
  readonly observation: ScenarioObservation;
  readonly parent: FixtureSnapshot;
}): Result<RollbackScenarioFacts, SmokeFailure> {
  const sources = validateObservedSources({
    observation: input.observation,
    snapshots: [input.parent],
    smokeCase: "rollback",
  });
  if (sources.isErr()) return err(sources.error);
  const health = validateHealthObservation(input.observation.health);
  if (health.isErr()) return err(health.error);
  const cleanupResult = verifiedCleanup(input.observation);
  if (cleanupResult.isErr()) return err(cleanupResult.error);

  const shims = input.observation.shims ?? [];
  const parentShims = shims.filter((shim) => shim.role === "parent");
  if (
    shims.length !== 2 ||
    parentShims.length !== 2 ||
    shims.some((shim) => shim.role === "child")
  )
    return err(
      failure(
        "FixtureBoundaryViolation",
        "rollback did not observe exactly one isolated parent shim boundary",
      ),
    );
  const before = parentShims.find((shim) => shim.phase === "before-adapter");
  const after = parentShims.find((shim) => shim.phase === "after-adapter");
  if (
    before === undefined ||
    after === undefined ||
    before.disabledSurface !== ROLLBACK_DISABLED_SURFACE ||
    after.disabledSurface !== ROLLBACK_DISABLED_SURFACE ||
    before.boundary !== ROLLBACK_SHIM_BOUNDARY ||
    after.boundary !== ROLLBACK_SHIM_BOUNDARY ||
    before.originalSurfacePresent !== true ||
    after.originalSurfacePresent !== true ||
    before.disabledBeforeAdapterInitialization !== true ||
    after.disabledBeforeAdapterInitialization !== true ||
    before.requiredDelegationSurfacesIntact !== true ||
    after.requiredDelegationSurfacesIntact !== true ||
    before.adapterInitialized !== false ||
    after.adapterInitialized !== true
  )
    return err(
      failure(
        "FixtureBoundaryViolation",
        "rollback shim did not hide exactly one optional surface before adapter initialization",
      ),
    );

  const gaps = health.value.hostSurfaceGaps ?? [];
  const runtimeGap = health.value.runtimeModelFallback;
  const runtimeProbe = runtimeGap?.probe.replace(/^unavailable:/u, "");
  if (
    health.value.ready !== true ||
    health.value.healthOnly !== false ||
    gaps.length !== 1 ||
    runtimeGap === undefined ||
    runtimeGap.capability !== "runtime-model-fallback" ||
    runtimeGap.mode !== "feature-unavailable" ||
    !runtimeGap.probe.startsWith("unavailable:") ||
    runtimeProbe === undefined ||
    !RUNTIME_MODEL_FALLBACK_PROBE_REASONS.has(runtimeProbe)
  )
    return err(
      failure(
        "ProviderContextViolation",
        "rollback health did not report one bounded optional runtime-model-fallback gap",
      ),
    );

  const childCapturePresent = [
    ...input.observation.providerCaptures,
    ...input.observation.controls,
    ...input.observation.nativeSessions,
  ].some((capture) => capture.role === "child");
  if (childCapturePresent)
    return err(
      failure(
        "UnexpectedEventCount",
        "rollback unexpectedly created a delegated child run",
      ),
    );
  const request = input.parent.requests[0];
  const history = input.parent.history;
  const native = input.observation.nativeSessions.find(
    (session) => session.role === "parent",
  );
  const control = input.observation.controls.find(
    (capture) => capture.role === "parent",
  );
  const initialModel: SafeModelIdentity = { provider: "smoke", id: "first" };
  const nativeTransitionsAreInitial =
    native !== undefined &&
    native.modelTransitions > 0 &&
    native.modelTransitionIdentities.length === native.modelTransitions &&
    native.modelTransitionIdentities.every((identity) =>
      sameIdentity(identity, initialModel),
    );
  const failedAssistant = history?.descriptors.find(
    (descriptor) =>
      descriptor.correlationHash === fixtureCorrelationHash("failed-assistant"),
  );
  if (
    request === undefined ||
    request.requestNumber !== 1 ||
    request.provider !== "smoke" ||
    request.model !== "first" ||
    request.taskPresent !== true ||
    request.originalUserPresent !== true ||
    request.failedAssistantPresent !== false ||
    request.recoveryMarkerPresent !== false ||
    request.syntheticProviderUserMessagePresent !== false ||
    input.parent.requestCount !== 1 ||
    input.parent.requests.length !== 1 ||
    history === undefined ||
    history.failedAssistantPresent !== true ||
    history.recoveryMarkerPresent !== false ||
    history.successfulAssistantPresent !== false ||
    history.recoveryEntryPresent !== false ||
    history.markerTokenHash !== undefined ||
    history.markerTokenValid !== undefined ||
    history.markerCorrelation !== undefined ||
    failedAssistant === undefined ||
    input.parent.failedAssistantFingerprintHash !==
      failedAssistant.contentFingerprintHash ||
    input.parent.failedAssistantShapeHash !==
      failedAssistant.contentShapeHash ||
    native === undefined ||
    !nativeTransitionsAreInitial ||
    native.recoveryMarkerCount !== 0 ||
    !sameIdentity(native.appliedIdentity, initialModel) ||
    control === undefined ||
    control.lifecycle.modelSelectCount !== 0 ||
    control.lifecycle.appliedIdentity !== undefined ||
    (input.parent.lifecycle.appliedIdentity !== undefined &&
      !sameIdentity(input.parent.lifecycle.appliedIdentity, initialModel))
  )
    return err(
      failure(
        "ProviderContextViolation",
        "rollback did not retain the real failed low-level run without fallback artifacts",
      ),
    );

  const lifecycle = input.parent.lifecycle;
  if (
    input.parent.optionalSurfaceDisabled !== true ||
    input.parent.legacySettlement !== true ||
    lifecycle.beforeAgentStartCount !== 1 ||
    // Pi 0.84.2 emits two ordinary message lifecycle pairs and one context
    // observation for the single provider request. These are host facts, not
    // fallback dispatch; the provider request and settlement counts below are
    // the low-level-run proof.
    lifecycle.messageStartCount !== 2 ||
    lifecycle.messageEndCount !== 2 ||
    lifecycle.contextCount !== 1 ||
    lifecycle.contextRepairCount !== 0 ||
    lifecycle.modelSelectCount !== 0 ||
    lifecycle.settlementCount !== 1 ||
    lifecycle.markerMessageStartCount !== 0 ||
    lifecycle.recoveryMarkerCount !== 0 ||
    lifecycle.recoveryMarkerObserved !== false ||
    (lifecycle.appliedIdentity !== undefined &&
      !sameIdentity(lifecycle.appliedIdentity, initialModel)) ||
    lifecycle.settlementTimesMs.length !== 1 ||
    Object.values(cleanupResult.value).some((value) => value !== true)
  )
    return err(
      failure(
        "UnexpectedEventCount",
        "rollback did not use one legacy low-level settlement and normal cleanup",
      ),
    );

  const visible = normalizedTuiOutput(input.observation.output);
  const visibleFallbackClaim =
    /model fallback\s*[·•]\s*smoke\/[a-z0-9._-]+/iu.test(visible);
  if (
    input.observation.visibleEventCount !== 0 ||
    visibleFallbackClaim ||
    visible.includes(NATIVE_RECOVERY_ENTRY_TYPE) ||
    visible.includes(NATIVE_RECOVERY_MARKER_TYPE)
  )
    return err(
      failure(
        "UnexpectedEventCount",
        "rollback exposed a model-transition or fallback artifact",
      ),
    );

  return ok({
    optionalSurfaceDisabled: true,
    healthReady: true,
    healthOnly: false,
    legacySettlementCount: 1,
    fallbackAttempted: false,
    cleanup: cleanupResult.value,
  });
}
