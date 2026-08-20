import { err, ok, type Result } from "neverthrow";
import {
  boundedCount,
  type FixtureControlFacts,
  type FixtureLifecycleFacts,
  type FixtureSnapshot,
  failure,
  MAX_COMMAND_TIMEOUT_MS,
  type NativeSessionObservation,
  type SafeModelIdentity,
  type ScenarioObservation,
  SHA256,
  type SmokeCase,
  type SmokeFailure,
} from "./contract.js";
import {
  validateHealthObservation,
  visibleEventCount,
} from "./health-observation.js";
import {
  sameHistoryFacts,
  sameIdentity,
  sameMessageFacts,
  sameNumberArray,
} from "./observation-comparison.js";
import { boundedTimestamp } from "./provider-observation.js";

/** Pi 0.84.2 writes at most two idempotent initial model records before a fallback. */
export const MAX_NATIVE_INITIAL_MODEL_ENTRIES = 2;
/** Keep the complete native model timeline small while retaining initialization records. */
export const MAX_NATIVE_MODEL_TIMELINE_ENTRIES =
  MAX_NATIVE_INITIAL_MODEL_ENTRIES + 1;

function isSafeModelIdentity(
  identity: SafeModelIdentity | undefined,
): identity is SafeModelIdentity {
  return (
    identity !== undefined &&
    typeof identity.provider === "string" &&
    identity.provider.length > 0 &&
    identity.provider.length <= 64 &&
    typeof identity.id === "string" &&
    identity.id.length > 0 &&
    identity.id.length <= 128
  );
}

function identityFromRequest(
  request: Readonly<{ provider: string; model: string }> | undefined,
): SafeModelIdentity | undefined {
  if (request === undefined) return undefined;
  const identity = { provider: request.provider, id: request.model };
  return isSafeModelIdentity(identity) ? identity : undefined;
}

function rejectModelTimeline(detail: string): Result<void, SmokeFailure> {
  return err(failure("CaptureMalformed", detail));
}

/**
 * Bind native `model_change` records to the authenticated control phase. Pi
 * writes idempotent initialization records, so the native count is not a
 * fallback-attempt count. The first provider request supplies the bounded
 * origin identity; control and native applied identities supply the
 * destination identity.
 */
function validateNativeModelTimeline(input: {
  readonly native: NativeSessionObservation;
  readonly control: FixtureControlFacts;
  readonly snapshot: FixtureSnapshot;
  readonly smokeCase: Exclude<SmokeCase, "all">;
}): Result<void, SmokeFailure> {
  const { native, control, snapshot, smokeCase } = input;
  const timeline = native.modelTransitionIdentities;
  const timestamps = native.modelTransitionTimesMs;
  const transitionCount = native.modelTransitions;
  if (
    !boundedCount(transitionCount) ||
    transitionCount < 1 ||
    transitionCount > MAX_NATIVE_MODEL_TIMELINE_ENTRIES ||
    timeline.length !== transitionCount ||
    timestamps.length !== transitionCount
  ) {
    return rejectModelTimeline("native model timeline is missing or unbounded");
  }
  if (
    timestamps.some((timestamp) => !boundedTimestamp(timestamp)) ||
    timestamps.some(
      (timestamp, index) => index > 0 && timestamp < timestamps[index - 1],
    ) ||
    timeline.some((identity) => !isSafeModelIdentity(identity))
  ) {
    return rejectModelTimeline("native model timeline is malformed");
  }

  const originIdentity = identityFromRequest(snapshot.requests[0]);
  if (!isSafeModelIdentity(originIdentity)) {
    return rejectModelTimeline("native model origin identity is missing");
  }
  const nativeAppliedIdentity = native.appliedIdentity;
  const controlAppliedIdentity = control.lifecycle.appliedIdentity;
  const snapshotAppliedIdentity = snapshot.lifecycle.appliedIdentity;
  const finalNativeIdentity = timeline.at(-1);
  if (
    !isSafeModelIdentity(finalNativeIdentity) ||
    !isSafeModelIdentity(nativeAppliedIdentity) ||
    !sameIdentity(nativeAppliedIdentity, finalNativeIdentity)
  ) {
    return rejectModelTimeline(
      "native model timeline has no stable applied identity",
    );
  }

  if (smokeCase === "rollback") return ok(undefined);

  const modelSelectTimes = control.lifecycle.modelSelectTimesMs;
  if (
    modelSelectTimes.length !== control.lifecycle.modelSelectCount ||
    modelSelectTimes.some((timestamp) => !boundedTimestamp(timestamp))
  ) {
    return rejectModelTimeline("public model selection phase is incomplete");
  }

  // Parent fallback sessions retain only the initial model. Their native
  // history can contain two idempotent origin records, while the control
  // observer has no applied model-selection event.
  if (snapshot.role === "parent") {
    if (
      control.lifecycle.modelSelectCount !== 0 ||
      modelSelectTimes.length !== 0 ||
      timeline.length > MAX_NATIVE_INITIAL_MODEL_ENTRIES ||
      !timeline.every((identity) => sameIdentity(identity, originIdentity)) ||
      !sameIdentity(nativeAppliedIdentity, originIdentity) ||
      (controlAppliedIdentity !== undefined &&
        !sameIdentity(controlAppliedIdentity, originIdentity)) ||
      (snapshotAppliedIdentity !== undefined &&
        !sameIdentity(snapshotAppliedIdentity, originIdentity))
    ) {
      return rejectModelTimeline(
        "native model timeline does not contain only the authenticated origin",
      );
    }
    return ok(undefined);
  }

  if (
    control.lifecycle.modelSelectCount !== 1 ||
    !isSafeModelIdentity(controlAppliedIdentity) ||
    !isSafeModelIdentity(snapshotAppliedIdentity) ||
    !sameIdentity(controlAppliedIdentity, nativeAppliedIdentity) ||
    !sameIdentity(controlAppliedIdentity, snapshotAppliedIdentity)
  ) {
    return rejectModelTimeline(
      "control and native applied identities disagree",
    );
  }
  const destinationIdentity = identityFromRequest(snapshot.requests.at(-1));
  if (
    !isSafeModelIdentity(destinationIdentity) ||
    !sameIdentity(destinationIdentity, controlAppliedIdentity) ||
    sameIdentity(originIdentity, controlAppliedIdentity)
  ) {
    return rejectModelTimeline(
      "native model timeline origin or destination identity is invalid",
    );
  }

  const destinationIndexes = timeline.flatMap((identity, index) =>
    sameIdentity(identity, controlAppliedIdentity) ? [index] : [],
  );
  const originEntries = timeline.slice(0, -1);
  if (
    destinationIndexes.length !== 1 ||
    destinationIndexes[0] !== timeline.length - 1 ||
    originEntries.length < 1 ||
    originEntries.length > MAX_NATIVE_INITIAL_MODEL_ENTRIES ||
    originEntries.some((identity) => !sameIdentity(identity, originIdentity))
  ) {
    return rejectModelTimeline(
      "native model timeline does not contain one ordered fallback destination",
    );
  }

  const publicAppliedAt = modelSelectTimes[0];
  const recoveryAt = control.lifecycle.markerMessageStartTimesMs.at(-1);
  const settlementAt = control.lifecycle.settlementTimesMs.at(-1);
  // Pi appends the native model_change record before it emits model_select.
  // Bind the public control phase to recovery and settlement instead; native
  // and control timestamps are separate observations.
  if (
    publicAppliedAt === undefined ||
    recoveryAt === undefined ||
    settlementAt === undefined ||
    publicAppliedAt > recoveryAt ||
    publicAppliedAt > settlementAt
  ) {
    return rejectModelTimeline(
      "control model selection did not precede recovery and settlement",
    );
  }
  return ok(undefined);
}

function validateObservationBindings(
  observation: ScenarioObservation,
  snapshots: readonly FixtureSnapshot[],
  smokeCase: Exclude<SmokeCase, "all">,
): Result<void, SmokeFailure> {
  for (const role of ["parent", "child"] as const) {
    if (
      observation.providerCaptures.filter((capture) => capture.role === role)
        .length > 1
    ) {
      return err(
        failure("CaptureMalformed", `duplicate provider capture for ${role}`),
      );
    }
    if (
      observation.controls.filter((capture) => capture.role === role).length > 1
    ) {
      return err(
        failure("CaptureMalformed", `duplicate control capture for ${role}`),
      );
    }
    if (
      observation.nativeSessions.filter((session) => session.role === role)
        .length > 1
    ) {
      return err(
        failure("CaptureMalformed", `duplicate native capture for ${role}`),
      );
    }
  }
  for (const snapshot of snapshots) {
    const provider = observation.providerCaptures.find(
      (capture) => capture.role === snapshot.role,
    );
    const control = observation.controls.find(
      (capture) => capture.role === snapshot.role,
    );
    const native = observation.nativeSessions.find(
      (session) => session.role === snapshot.role,
    );
    if (
      provider === undefined ||
      control === undefined ||
      native === undefined
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `missing host observation for ${snapshot.role}`,
        ),
      );
    }
    const controlIdentity = control.lifecycle.appliedIdentity;
    const nativeIdentity = native.appliedIdentity;
    if (
      controlIdentity !== undefined &&
      nativeIdentity !== undefined &&
      !sameIdentity(controlIdentity, nativeIdentity)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} model identities disagree`,
        ),
      );
    }
    const modelTimeline = validateNativeModelTimeline({
      native,
      control,
      snapshot,
      smokeCase,
    });
    if (modelTimeline.isErr()) return err(modelTimeline.error);
    const mismatches = [
      [
        "provider.requestCount",
        provider.requestCount !== snapshot.requestCount,
      ],
      [
        "provider.requests",
        provider.requests.length !== snapshot.requests.length ||
          provider.requests.some(
            (request, index) =>
              !sameMessageFacts(request, snapshot.requests[index]),
          ),
      ],
      [
        "control.processIdHash",
        control.processIdHash !== snapshot.processIdHash,
      ],
      [
        "control.processIdBeforeHash",
        control.processIdBeforeHash !== snapshot.processIdBeforeHash,
      ],
      [
        "control.processIdAfterHash",
        control.processIdAfterHash !== snapshot.processIdAfterHash,
      ],
      ["control.childIdHash", control.childIdHash !== snapshot.childIdHash],
      [
        "control.childIdBeforeHash",
        control.childIdBeforeHash !== snapshot.childIdBeforeHash,
      ],
      [
        "control.childIdAfterHash",
        control.childIdAfterHash !== snapshot.childIdAfterHash,
      ],
      [
        "control.markerTokenHash",
        control.markerTokenHash !== snapshot.markerTokenHash,
      ],
      [
        "control.failedAssistantFingerprintHash",
        control.failedAssistantFingerprintHash !==
          snapshot.failedAssistantFingerprintHash,
      ],
      [
        "control.failedAssistantShapeHash",
        control.failedAssistantShapeHash !== snapshot.failedAssistantShapeHash,
      ],
      ["native.sessionIdHash", native.sessionIdHash !== snapshot.sessionIdHash],
      [
        "native.sessionIdBeforeHash",
        native.sessionIdBeforeHash !== snapshot.sessionIdBeforeHash,
      ],
      [
        "native.sessionIdAfterHash",
        native.sessionIdAfterHash !== snapshot.sessionIdAfterHash,
      ],
      ["native.threadIdHash", native.threadIdHash !== snapshot.threadIdHash],
      [
        "native.threadIdBeforeHash",
        native.threadIdBeforeHash !== snapshot.threadIdBeforeHash,
      ],
      [
        "native.threadIdAfterHash",
        native.threadIdAfterHash !== snapshot.threadIdAfterHash,
      ],
      [
        "native.history",
        snapshot.history !== undefined &&
          !sameHistoryFacts(native.history, snapshot.history),
      ],
      [
        "native.recoveryMarkerCount",
        snapshot.role === "child" &&
          native.recoveryMarkerCount !==
            control.lifecycle.markerMessageStartCount,
      ],
      [
        "lifecycle.beforeAgentStartCount",
        control.lifecycle.beforeAgentStartCount !==
          snapshot.lifecycle.beforeAgentStartCount,
      ],
      [
        "lifecycle.messageStartCount",
        control.lifecycle.messageStartCount !==
          snapshot.lifecycle.messageStartCount,
      ],
      [
        "lifecycle.messageEndCount",
        control.lifecycle.messageEndCount !==
          snapshot.lifecycle.messageEndCount,
      ],
      [
        "lifecycle.contextCount",
        control.lifecycle.contextCount !== snapshot.lifecycle.contextCount,
      ],
      [
        "lifecycle.contextRepairCount",
        control.lifecycle.contextRepairCount !==
          snapshot.lifecycle.contextRepairCount ||
          !sameNumberArray(
            control.lifecycle.contextRepairTimesMs,
            snapshot.lifecycle.contextRepairTimesMs,
          ),
      ],
      [
        "lifecycle.modelSelectCount",
        control.lifecycle.modelSelectCount !==
          snapshot.lifecycle.modelSelectCount ||
          !sameNumberArray(
            control.lifecycle.modelSelectTimesMs,
            snapshot.lifecycle.modelSelectTimesMs,
          ),
      ],
      [
        "lifecycle.settlementCount",
        control.lifecycle.settlementCount !==
          snapshot.lifecycle.settlementCount ||
          !sameNumberArray(
            control.lifecycle.settlementTimesMs,
            snapshot.lifecycle.settlementTimesMs,
          ),
      ],
      [
        "lifecycle.markerMessageStartCount",
        control.lifecycle.markerMessageStartCount !==
          snapshot.lifecycle.markerMessageStartCount ||
          !sameNumberArray(
            control.lifecycle.markerMessageStartTimesMs,
            snapshot.lifecycle.markerMessageStartTimesMs,
          ),
      ],
      [
        "lifecycle.recoveryMarker",
        control.lifecycle.recoveryMarkerCount !==
          snapshot.lifecycle.recoveryMarkerCount ||
          control.lifecycle.recoveryMarkerObserved !==
            snapshot.lifecycle.recoveryMarkerObserved,
      ],
      [
        "parentTool.timestamps",
        control.parentToolStartedAtMs !== snapshot.parentToolStartedAtMs ||
          control.parentToolEndedAtMs !== snapshot.parentToolEndedAtMs ||
          control.parentToolPendingMs !== snapshot.parentToolPendingMs,
      ],
      [
        "parentTool.counts",
        control.parentToolStartCount !== snapshot.parentToolStartCount ||
          control.parentToolEndCount !== snapshot.parentToolEndCount ||
          !sameNumberArray(
            control.parentToolStartTimesMs,
            snapshot.parentToolStartTimesMs,
          ) ||
          !sameNumberArray(
            control.parentToolEndTimesMs,
            snapshot.parentToolEndTimesMs,
          ),
      ],
      [
        "parentTool.identity",
        control.parentToolCallIdHash !== snapshot.parentToolCallIdHash ||
          control.parentToolEndCallIdHash !== snapshot.parentToolEndCallIdHash,
      ],
      [
        "model.identity",
        smokeCase === "rollback" || control.lifecycle.modelSelectCount === 0
          ? snapshot.lifecycle.appliedIdentity !== undefined &&
            !sameIdentity(nativeIdentity, snapshot.lifecycle.appliedIdentity)
          : !sameIdentity(
              controlIdentity ?? nativeIdentity,
              snapshot.lifecycle.appliedIdentity,
            ),
      ],
    ]
      .filter(([, mismatch]) => mismatch)
      .map(([field]) => field);
    if (mismatches.length > 0) {
      return err(
        failure(
          "CaptureMalformed",
          `host observations do not bind to ${snapshot.role}: ${mismatches.join(",")}`,
        ),
      );
    }
  }
  return ok(undefined);
}

function requireStableHash(
  before: string | undefined,
  after: string | undefined,
  label: string,
): Result<true, SmokeFailure> {
  if (
    before === undefined ||
    after === undefined ||
    !SHA256.test(before) ||
    !SHA256.test(after)
  ) {
    return err(failure("CaptureMalformed", `${label} identity is missing`));
  }
  if (before !== after) {
    return err(
      failure(
        "CaptureMalformed",
        `${label} identity changed between observations`,
      ),
    );
  }
  return ok(true);
}

function validateLifecycleEvidence(
  lifecycle: FixtureLifecycleFacts,
  role: FixtureSnapshot["role"],
): Result<void, SmokeFailure> {
  if (
    [
      lifecycle.beforeAgentStartCount,
      lifecycle.messageStartCount,
      lifecycle.messageEndCount,
      lifecycle.contextCount,
      lifecycle.contextRepairCount,
      lifecycle.modelSelectCount,
      lifecycle.settlementCount,
      lifecycle.markerMessageStartCount,
      lifecycle.recoveryMarkerCount,
    ].some((count) => !boundedCount(count)) ||
    lifecycle.contextRepairCount > lifecycle.contextCount ||
    lifecycle.markerMessageStartCount > lifecycle.messageStartCount ||
    lifecycle.markerMessageStartCount !== lifecycle.recoveryMarkerCount ||
    lifecycle.recoveryMarkerObserved !==
      lifecycle.markerMessageStartCount > 0 ||
    lifecycle.contextRepairTimesMs.length !== lifecycle.contextRepairCount ||
    lifecycle.modelSelectTimesMs.length !== lifecycle.modelSelectCount ||
    lifecycle.settlementTimesMs.length !== lifecycle.settlementCount ||
    lifecycle.markerMessageStartTimesMs.length !==
      lifecycle.markerMessageStartCount ||
    lifecycle.contextRepairTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    ) ||
    lifecycle.modelSelectTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    ) ||
    lifecycle.settlementTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    ) ||
    lifecycle.markerMessageStartTimesMs.some(
      (timestamp) => !boundedTimestamp(timestamp),
    )
  ) {
    return err(
      failure(
        "UnexpectedEventCount",
        `${role} lifecycle evidence is inconsistent`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Fail closed when the real smoke did not provide an independent observation
 * source. Identity stability is accepted only when two bounded observations
 * of the same public source compare equal.
 */
export function validateObservedSources(input: {
  readonly observation: ScenarioObservation;
  readonly snapshots: readonly FixtureSnapshot[];
  readonly smokeCase: Exclude<SmokeCase, "all">;
}): Result<void, SmokeFailure> {
  if (input.smokeCase === "rollback") {
    const health = validateHealthObservation(input.observation.health);
    if (health.isErr()) return err(health.error);
    if ((input.observation.shims ?? []).length === 0)
      return err(
        failure(
          "CaptureMalformed",
          "rollback shim boundary observation is missing",
        ),
      );
  } else if (input.observation.health !== undefined) {
    const health = validateHealthObservation(input.observation.health);
    if (health.isErr()) return err(health.error);
  }
  if (
    input.observation.visibleEventCount === undefined ||
    !boundedCount(input.observation.visibleEventCount)
  ) {
    return err(failure("CaptureMalformed", "visible event count is missing"));
  }
  const observedVisibleEventCount = visibleEventCount(input.observation.output);
  if (observedVisibleEventCount !== input.observation.visibleEventCount) {
    return err(
      failure(
        "UnexpectedEventCount",
        "visible event count disagrees with bounded TUI output",
      ),
    );
  }
  const bindings = validateObservationBindings(
    input.observation,
    input.snapshots,
    input.smokeCase,
  );
  if (bindings.isErr()) return err(bindings.error);
  const parent = input.snapshots.find((snapshot) => snapshot.role === "parent");
  const child = input.snapshots.find((snapshot) => snapshot.role === "child");
  if (parent === undefined) {
    return err(failure("CaptureMalformed", "parent observation is missing"));
  }
  if (input.smokeCase === "fallback" && child === undefined) {
    return err(failure("CaptureMalformed", "child observation is missing"));
  }
  for (const snapshot of input.snapshots) {
    const process = requireStableHash(
      snapshot.processIdBeforeHash,
      snapshot.processIdAfterHash,
      `${snapshot.role} process`,
    );
    if (process.isErr()) return err(process.error);
    if (
      snapshot.processIdHash !== snapshot.processIdAfterHash ||
      snapshot.processIdHash === undefined ||
      !SHA256.test(snapshot.processIdHash)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} process identity sources disagree`,
        ),
      );
    }
    const session = requireStableHash(
      snapshot.sessionIdBeforeHash,
      snapshot.sessionIdAfterHash,
      `${snapshot.role} native session`,
    );
    if (session.isErr()) return err(session.error);
    if (
      snapshot.sessionIdHash !== snapshot.sessionIdAfterHash ||
      snapshot.sessionIdHash === undefined ||
      !SHA256.test(snapshot.sessionIdHash)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} native session identity sources disagree`,
        ),
      );
    }
    const lifecycle = validateLifecycleEvidence(
      snapshot.lifecycle,
      snapshot.role,
    );
    if (lifecycle.isErr()) return err(lifecycle.error);
    if (
      snapshot.role === "parent" &&
      (snapshot.childIdHash !== undefined ||
        snapshot.threadIdHash !== undefined)
    ) {
      return err(
        failure(
          "CaptureMalformed",
          "parent observation contains child identity",
        ),
      );
    }
    if (snapshot.processIdHash === snapshot.sessionIdHash) {
      return err(
        failure(
          "CaptureMalformed",
          `${snapshot.role} process identity was aliased to native session identity`,
        ),
      );
    }
    if (snapshot.role === "child") {
      const childIdentity = requireStableHash(
        snapshot.childIdBeforeHash,
        snapshot.childIdAfterHash,
        "child process control",
      );
      if (childIdentity.isErr()) return err(childIdentity.error);
      const thread = requireStableHash(
        snapshot.threadIdBeforeHash,
        snapshot.threadIdAfterHash,
        "child native thread",
      );
      if (thread.isErr()) return err(thread.error);
      if (
        snapshot.childIdHash !== snapshot.childIdAfterHash ||
        snapshot.threadIdHash !== snapshot.threadIdAfterHash ||
        snapshot.childIdHash === undefined ||
        snapshot.threadIdHash === undefined ||
        snapshot.childIdHash === snapshot.threadIdHash
      ) {
        return err(
          failure(
            "CaptureMalformed",
            "thread identity was aliased to child identity",
          ),
        );
      }
      if (
        snapshot.sessionIdHash === snapshot.threadIdHash ||
        snapshot.processIdHash === snapshot.childIdHash ||
        snapshot.processIdHash === snapshot.threadIdHash ||
        snapshot.sessionIdHash === snapshot.childIdHash
      ) {
        return err(
          failure("CaptureMalformed", "child runtime identities were aliased"),
        );
      }
    }
    const native = input.observation.nativeSessions.find(
      (sessionObservation) => sessionObservation.role === snapshot.role,
    );
    if (native === undefined) {
      return err(
        failure(
          "CaptureMalformed",
          `native observation is missing for ${snapshot.role}`,
        ),
      );
    }
    if (
      snapshot.role === "child" &&
      native.recoveryMarkerCount !== snapshot.lifecycle.markerMessageStartCount
    ) {
      return err(
        failure(
          "UnexpectedEventCount",
          "native marker count disagrees with exact message_start evidence",
        ),
      );
    }
  }
  if (
    parent !== undefined &&
    child !== undefined &&
    (parent.processIdHash === child.processIdHash ||
      parent.sessionIdHash === child.sessionIdHash ||
      parent.processIdBeforeHash === child.processIdBeforeHash ||
      parent.sessionIdBeforeHash === child.sessionIdBeforeHash)
  ) {
    return err(
      failure("CaptureMalformed", "parent and child identities were aliased"),
    );
  }
  if (input.smokeCase === "fallback") {
    if (
      parent.parentToolCallIdHash === undefined ||
      parent.parentToolEndCallIdHash === undefined ||
      !SHA256.test(parent.parentToolCallIdHash) ||
      !SHA256.test(parent.parentToolEndCallIdHash) ||
      parent.parentToolCallIdHash !== parent.parentToolEndCallIdHash ||
      parent.parentToolStartCount !== 1 ||
      parent.parentToolEndCount !== 1 ||
      parent.parentToolStartTimesMs?.length !== 1 ||
      parent.parentToolEndTimesMs?.length !== 1 ||
      parent.parentToolStartedAtMs === undefined ||
      parent.parentToolEndedAtMs === undefined ||
      parent.parentToolStartTimesMs[0] !== parent.parentToolStartedAtMs ||
      parent.parentToolEndTimesMs[0] !== parent.parentToolEndedAtMs ||
      parent.parentToolEndedAtMs < parent.parentToolStartedAtMs ||
      parent.parentToolPendingMs === undefined ||
      parent.parentToolPendingMs !==
        parent.parentToolEndedAtMs - parent.parentToolStartedAtMs ||
      parent.parentToolPendingMs > MAX_COMMAND_TIMEOUT_MS
    ) {
      return err(
        failure(
          "CaptureMalformed",
          "parent tool identity or timestamps are missing",
        ),
      );
    }
    if (
      parent.parentToolCallIdHash === parent.processIdHash ||
      parent.parentToolCallIdHash === parent.sessionIdHash ||
      parent.parentToolCallIdHash === child?.childIdHash ||
      parent.parentToolCallIdHash === child?.threadIdHash
    ) {
      return err(
        failure("CaptureMalformed", "parent tool identity was aliased"),
      );
    }
  }
  return ok(undefined);
}
