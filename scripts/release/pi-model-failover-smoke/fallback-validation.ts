import { err, ok, type Result } from "neverthrow";
import {
  boundedCount,
  CHILD_TASK,
  containsForbiddenContent,
  descriptorCounts,
  EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT,
  EXPECTED_HISTORY_FACTS,
  EXPECTED_NATIVE_LINE,
  EXPECTED_PROVIDER_FACTS,
  FACT_CUSTOM_TYPES,
  FACT_PROVIDER_ROLES,
  FACT_ROLES,
  type FallbackScenarioFacts,
  type FixtureContextFact,
  type FixtureControlFacts,
  type FixtureHistoryDescriptor,
  type FixtureHistoryFacts,
  type FixtureMessageDescriptor,
  type FixtureMessageFacts,
  type FixtureSnapshot,
  failure,
  fixtureCorrelationHash,
  fixtureCustomTypeHash,
  fixtureEntryTypeHash,
  fixtureRoleHash,
  isRecord,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_CONTEXT_DESCRIPTOR_COUNT,
  MAX_HISTORY_DESCRIPTOR_COUNT,
  MAX_REPORT_TIMESTAMP_MS,
  NATIVE_RECOVERY_MARKER_TYPE,
  PARENT_TASK,
  PROVIDER_FAILURE_MARKER,
  RECOVERY_MARKER,
  ROLLBACK_TASK,
  type ScenarioObservation,
  SHA256,
  type SmokeFailure,
  UNRELATED_CUSTOM_TYPE,
} from "./contract.js";
import { normalizedTuiOutput } from "./health-observation.js";
import {
  sameContextDescriptor,
  sameIdentity,
  sameNumberArray,
} from "./observation-comparison.js";
import { validateObservedSources } from "./observation-validation.js";
import {
  boundedTimestamp,
  descriptorFactsFromDescriptors,
  HISTORY_DESCRIPTOR_KEYS,
  hasOnlyKeys,
  MESSAGE_DESCRIPTOR_KEYS,
} from "./provider-observation.js";
import { verifiedCleanup } from "./verified-cleanup.js";

function isSafeDescriptor(
  value: unknown,
  history: boolean,
): value is FixtureMessageDescriptor | FixtureHistoryDescriptor {
  if (!isRecord(value)) return false;
  const allowed = history ? HISTORY_DESCRIPTOR_KEYS : MESSAGE_DESCRIPTOR_KEYS;
  if (!hasOnlyKeys(value, allowed)) return false;
  if (
    !boundedCount(value.ordinal) ||
    value.ordinal >=
      (history ? MAX_HISTORY_DESCRIPTOR_COUNT : MAX_CONTEXT_DESCRIPTOR_COUNT) ||
    !boundedCount(value.contentBlockCount) ||
    !boundedCount(value.toolCallCount) ||
    !boundedCount(value.toolResultCount) ||
    typeof value.roleHash !== "string" ||
    ![
      fixtureRoleHash("user"),
      fixtureRoleHash("assistant"),
      fixtureRoleHash("toolResult"),
      fixtureRoleHash("custom"),
    ].includes(value.roleHash) ||
    typeof value.contentShapeHash !== "string" ||
    !SHA256.test(value.contentShapeHash) ||
    typeof value.contentFingerprintHash !== "string" ||
    !SHA256.test(value.contentFingerprintHash)
  ) {
    return false;
  }
  if (
    value.customTypeHash !== undefined &&
    (typeof value.customTypeHash !== "string" ||
      !SHA256.test(value.customTypeHash) ||
      value.roleHash !== fixtureRoleHash("custom"))
  ) {
    return false;
  }
  if (
    value.correlationHash !== undefined &&
    (typeof value.correlationHash !== "string" ||
      !SHA256.test(value.correlationHash))
  ) {
    return false;
  }
  if (!history) return true;
  return (
    boundedCount(value.entryIndex) &&
    value.entryIndex <= MAX_HISTORY_DESCRIPTOR_COUNT &&
    typeof value.entryTypeHash === "string" &&
    SHA256.test(value.entryTypeHash) &&
    [
      fixtureEntryTypeHash("message"),
      fixtureEntryTypeHash("custom_message"),
      fixtureEntryTypeHash("custom"),
    ].includes(value.entryTypeHash)
  );
}

function descriptorMatchesFact(
  descriptor: FixtureMessageDescriptor,
  fact: FixtureContextFact,
  history: boolean,
): boolean {
  const customType = history ? FACT_CUSTOM_TYPES[fact] : undefined;
  const expectedRole = history ? FACT_ROLES[fact] : FACT_PROVIDER_ROLES[fact];
  const correlationMatches =
    fact === "recovery-marker"
      ? descriptor.correlationHash !== undefined &&
        SHA256.test(descriptor.correlationHash) &&
        descriptor.correlationHash !== fixtureCorrelationHash("recovery-marker")
      : descriptor.correlationHash === fixtureCorrelationHash(fact);
  return (
    descriptor.roleHash === fixtureRoleHash(expectedRole) &&
    descriptor.customTypeHash ===
      (customType === undefined
        ? undefined
        : fixtureCustomTypeHash(customType)) &&
    correlationMatches
  );
}

function validateDescriptorSequence(
  descriptors: readonly FixtureMessageDescriptor[],
  expectedFacts: readonly FixtureContextFact[],
  label: string,
  history = false,
): Result<void, SmokeFailure> {
  if (descriptors.length !== expectedFacts.length) {
    return err(
      failure(
        "ProviderContextViolation",
        `${label} descriptor count is not exact`,
      ),
    );
  }
  for (const [index, fact] of expectedFacts.entries()) {
    const descriptor = descriptors[index];
    const expectedEntryType =
      fact === "unrelated-custom" || fact === "recovery-marker"
        ? "custom_message"
        : "message";
    if (
      descriptor === undefined ||
      !isSafeDescriptor(descriptor, history) ||
      descriptor.ordinal !== index ||
      !descriptorMatchesFact(descriptor, fact, history) ||
      ("entryTypeHash" in descriptor &&
        descriptor.entryTypeHash !== fixtureEntryTypeHash(expectedEntryType))
    ) {
      return err(
        failure(
          "ProviderContextViolation",
          `${label} descriptor sequence is missing, reordered, duplicated, or ambiguous`,
        ),
      );
    }
  }
  return ok(undefined);
}

function validateExactProviderContext(
  request: FixtureMessageFacts,
): Result<void, SmokeFailure> {
  const counts = descriptorCounts(request.descriptors);
  if (
    request.messageCount !== request.descriptors.length ||
    request.descriptorCount !== counts.descriptorCount ||
    request.userCount !== counts.userCount ||
    request.assistantCount !== counts.assistantCount ||
    request.toolResultCount !== counts.toolResultCount ||
    request.customCount !== counts.customCount
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "fallback provider descriptor counts disagree",
      ),
    );
  }
  const sequence = validateDescriptorSequence(
    request.descriptors,
    EXPECTED_PROVIDER_FACTS,
    "fallback provider",
  );
  if (sequence.isErr()) return err(sequence.error);
  const derived = descriptorFactsFromDescriptors(request.descriptors);
  if (
    request.originalUserPresent !== derived.originalUserPresent ||
    request.taskPresent !== derived.taskPresent ||
    request.toolCallPresent !== derived.toolCallPresent ||
    request.toolResultPresent !== derived.toolResultPresent ||
    request.failedAssistantPresent !== false ||
    request.recoveryMarkerPresent !== false ||
    request.syntheticProviderUserMessagePresent !== false
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback provider facts do not match the exact descriptor set",
      ),
    );
  }
  const userDescriptors = request.descriptors.filter(
    (descriptor) => descriptor.roleHash === fixtureRoleHash("user"),
  );
  const expectedUsers = EXPECTED_PROVIDER_FACTS.filter(
    (fact) => FACT_PROVIDER_ROLES[fact] === "user",
  );
  if (
    userDescriptors.length !== expectedUsers.length ||
    userDescriptors.some(
      (descriptor, index) =>
        descriptor.correlationHash !==
        fixtureCorrelationHash(expectedUsers[index]),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "provider context contains an extra or synthetic user",
      ),
    );
  }
  return ok(undefined);
}

function validateFailedProviderContext(
  request: FixtureMessageFacts,
): Result<void, SmokeFailure> {
  // The provider fails before Pi can append the failed assistant to native
  // history. The failing request therefore has the same three-message
  // provider prefix as the recovery request.
  const expectedFacts = EXPECTED_PROVIDER_FACTS;
  const sequence = validateDescriptorSequence(
    request.descriptors,
    expectedFacts,
    "failed provider",
  );
  if (sequence.isErr()) return err(sequence.error);
  const derived = descriptorFactsFromDescriptors(request.descriptors);
  const counts = descriptorCounts(request.descriptors);
  if (
    request.messageCount !== request.descriptors.length ||
    request.descriptorCount !== counts.descriptorCount ||
    request.userCount !== counts.userCount ||
    request.assistantCount !== counts.assistantCount ||
    request.toolResultCount !== counts.toolResultCount ||
    request.customCount !== counts.customCount ||
    request.originalUserPresent !== derived.originalUserPresent ||
    request.taskPresent !== derived.taskPresent ||
    request.toolCallPresent !== derived.toolCallPresent ||
    request.toolResultPresent !== derived.toolResultPresent ||
    request.failedAssistantPresent !== false ||
    request.recoveryMarkerPresent !== false ||
    request.syntheticProviderUserMessagePresent !== false ||
    derived.failedAssistantPresent !== false ||
    derived.recoveryMarkerPresent !== false
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "failed provider context does not contain the exact real prefix",
      ),
    );
  }
  const expectedUsers = EXPECTED_PROVIDER_FACTS.filter(
    (fact) => FACT_PROVIDER_ROLES[fact] === "user",
  );
  const userDescriptors = request.descriptors.filter(
    (descriptor) => descriptor.roleHash === fixtureRoleHash("user"),
  );
  if (
    userDescriptors.length !== expectedUsers.length ||
    userDescriptors.some(
      (descriptor, index) =>
        descriptor.correlationHash !==
        fixtureCorrelationHash(expectedUsers[index]),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "failed provider context contains an extra or synthetic user",
      ),
    );
  }
  return ok(undefined);
}

function validateProviderContextContinuity(
  failedRequest: FixtureMessageFacts,
  fallbackRequest: FixtureMessageFacts,
): Result<void, SmokeFailure> {
  if (
    failedRequest.descriptors.length !== EXPECTED_PROVIDER_FACTS.length ||
    fallbackRequest.descriptors.length !== EXPECTED_PROVIDER_FACTS.length
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "provider context prefix length is not exact",
      ),
    );
  }
  for (const [index, fact] of EXPECTED_PROVIDER_FACTS.entries()) {
    const failedDescriptor = failedRequest.descriptors[index];
    const fallbackDescriptor = fallbackRequest.descriptors[index];
    if (
      failedDescriptor === undefined ||
      fallbackDescriptor === undefined ||
      failedDescriptor.correlationHash !== fixtureCorrelationHash(fact) ||
      fallbackDescriptor.correlationHash !== fixtureCorrelationHash(fact) ||
      !sameContextDescriptor(failedDescriptor, fallbackDescriptor)
    ) {
      return err(
        failure(
          "ProviderContextViolation",
          "failed and fallback provider contexts do not preserve the same ordered prefix",
        ),
      );
    }
  }
  return ok(undefined);
}

function validateExactDurableHistory(
  history: FixtureHistoryFacts,
  control: FixtureControlFacts | undefined,
): Result<void, SmokeFailure> {
  const counts = descriptorCounts(history.descriptors);
  if (
    !boundedCount(history.entryCount) ||
    history.entryCount < history.descriptors.length ||
    history.descriptorCount !== counts.descriptorCount ||
    history.userCount !== counts.userCount ||
    history.assistantCount !== counts.assistantCount ||
    history.toolResultCount !== counts.toolResultCount ||
    history.customCount !== counts.customCount
  ) {
    return err(
      failure("CaptureMalformed", "durable descriptor counts disagree"),
    );
  }
  const sequence = validateDescriptorSequence(
    history.descriptors,
    EXPECTED_HISTORY_FACTS,
    "durable native history",
    true,
  );
  if (sequence.isErr()) return err(sequence.error);
  const failedIndex = EXPECTED_HISTORY_FACTS.indexOf("failed-assistant");
  const markerIndex = EXPECTED_HISTORY_FACTS.indexOf("recovery-marker");
  const successfulIndex = EXPECTED_HISTORY_FACTS.indexOf(
    "successful-assistant",
  );
  const failed = history.descriptors[failedIndex];
  const marker = history.descriptors[markerIndex];
  const successful = history.descriptors[successfulIndex];
  if (
    failed === undefined ||
    marker === undefined ||
    successful === undefined
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "durable failed, marker, or successful descriptor is missing",
      ),
    );
  }
  if (
    history.failedAssistantPresent !== true ||
    history.recoveryMarkerPresent !== true ||
    history.successfulAssistantPresent !== true ||
    history.recoveryEntryPresent !== true ||
    history.markerTokenValid !== true ||
    history.markerTokenHash === undefined ||
    history.markerCorrelation === undefined
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "durable history facts are incomplete",
      ),
    );
  }
  const entryIndexes = history.descriptors.map(
    (descriptor) => descriptor.entryIndex,
  );
  if (
    entryIndexes.some(
      (entryIndex, index) =>
        entryIndex < 1 ||
        entryIndex > history.entryCount ||
        (index > 0 && entryIndex <= (entryIndexes[index - 1] as number)),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "durable native descriptor indexes are missing, duplicated, or reordered",
      ),
    );
  }
  const correlation = history.markerCorrelation;
  const interveningNativeEntryCount = marker.entryIndex - failed.entryIndex - 1;
  if (
    correlation.failedAssistantOrdinal !== failed.ordinal ||
    correlation.markerOrdinal !== marker.ordinal ||
    correlation.failedAssistantEntryIndex !== failed.entryIndex ||
    correlation.markerEntryIndex !== marker.entryIndex ||
    interveningNativeEntryCount < 0 ||
    correlation.interveningNativeEntryCount !== interveningNativeEntryCount ||
    correlation.failedAssistantFingerprintHash !==
      failed.contentFingerprintHash ||
    correlation.markerTokenHash !== marker.correlationHash ||
    correlation.markerTokenHash !== history.markerTokenHash ||
    control?.markerTokenHash !== history.markerTokenHash ||
    correlation.failedAssistantFingerprintHash ===
      successful.contentFingerprintHash ||
    successful.ordinal <= marker.ordinal ||
    successful.entryIndex <= marker.entryIndex ||
    control === undefined ||
    control.failedAssistantFingerprintHash !== failed.contentFingerprintHash ||
    control.failedAssistantShapeHash !== failed.contentShapeHash
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "marker adjacency or fingerprint correlation is not exact",
      ),
    );
  }
  if (marker.roleHash !== fixtureRoleHash("custom")) {
    return err(
      failure("ProviderContextViolation", "recovery marker role is ambiguous"),
    );
  }
  return ok(undefined);
}

function isBoundedFallbackTimestamp(value: unknown): value is number {
  return boundedTimestamp(value) && value <= MAX_REPORT_TIMESTAMP_MS;
}

/**
 * Validate the fallback's cross-process timeline from role-bound control
 * captures. `validateObservedSources` binds these captures to the snapshots
 * and native identities before this check runs; this function must not infer
 * a phase from an unbound child or parent record.
 *
 * Equal phase timestamps are valid because the observer records only
 * millisecond timestamps and no cross-event sequence. The parent tool still
 * requires a positive interval, so its start and end may not be equal.
 */
function validateParentToolPendingAcrossChildTimeline(
  child: FixtureSnapshot,
  parent: FixtureSnapshot,
  observation: ScenarioObservation,
): Result<void, SmokeFailure> {
  const childControl = observation.controls.find(
    (capture) => capture.role === "child",
  );
  const parentControl = observation.controls.find(
    (capture) => capture.role === "parent",
  );
  const childNative = observation.nativeSessions.find(
    (session) => session.role === "child",
  );
  const childIdentity = childControl?.lifecycle.appliedIdentity;
  if (
    childControl === undefined ||
    parentControl === undefined ||
    childNative === undefined ||
    childIdentity === undefined ||
    childNative.appliedIdentity === undefined ||
    !sameIdentity(childIdentity, childNative.appliedIdentity) ||
    child.role !== "child" ||
    parent.role !== "parent" ||
    parentControl.parentToolCallIdHash === undefined ||
    parentControl.parentToolEndCallIdHash !==
      parentControl.parentToolCallIdHash ||
    parentControl.parentToolCallIdHash === child.childIdHash ||
    parentControl.parentToolCallIdHash === child.threadIdHash
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback timeline identities are missing or mixed",
      ),
    );
  }

  const childLifecycle = childControl.lifecycle;
  const childTimelineArrays = [
    childLifecycle.contextRepairTimesMs,
    childLifecycle.modelSelectTimesMs,
    childLifecycle.markerMessageStartTimesMs,
    childLifecycle.settlementTimesMs,
  ];
  if (
    childTimelineArrays.some((timestamps) => !Array.isArray(timestamps)) ||
    !Array.isArray(parentControl.parentToolStartTimesMs) ||
    !Array.isArray(parentControl.parentToolEndTimesMs) ||
    childLifecycle.contextRepairCount !== 1 ||
    childLifecycle.modelSelectCount !== 1 ||
    childLifecycle.markerMessageStartCount !== 1 ||
    childLifecycle.recoveryMarkerCount !== 1 ||
    !childLifecycle.recoveryMarkerObserved ||
    childLifecycle.settlementCount !== 2 ||
    childLifecycle.contextRepairTimesMs.length !== 1 ||
    childLifecycle.modelSelectTimesMs.length !== 1 ||
    childLifecycle.markerMessageStartTimesMs.length !== 1 ||
    childLifecycle.settlementTimesMs.length !== 2 ||
    parentControl.parentToolStartCount !== 1 ||
    parentControl.parentToolEndCount !== 1 ||
    parentControl.parentToolStartTimesMs.length !== 1 ||
    parentControl.parentToolEndTimesMs.length !== 1
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback phase timeline is missing or duplicated",
      ),
    );
  }

  const startedAt = parentControl.parentToolStartedAtMs;
  const endedAt = parentControl.parentToolEndedAtMs;
  const firstSettlement = childLifecycle.settlementTimesMs[0];
  const modelSelection = childLifecycle.modelSelectTimesMs[0];
  const markerStart = childLifecycle.markerMessageStartTimesMs[0];
  const contextRepair = childLifecycle.contextRepairTimesMs[0];
  const finalSettlement = childLifecycle.settlementTimesMs[1];
  const parentToolStart = parentControl.parentToolStartTimesMs[0];
  const parentToolEnd = parentControl.parentToolEndTimesMs[0];
  const pendingMs = parentControl.parentToolPendingMs;
  if (
    !isBoundedFallbackTimestamp(startedAt) ||
    !isBoundedFallbackTimestamp(endedAt) ||
    !isBoundedFallbackTimestamp(firstSettlement) ||
    !isBoundedFallbackTimestamp(modelSelection) ||
    !isBoundedFallbackTimestamp(markerStart) ||
    !isBoundedFallbackTimestamp(contextRepair) ||
    !isBoundedFallbackTimestamp(finalSettlement) ||
    !isBoundedFallbackTimestamp(parentToolStart) ||
    !isBoundedFallbackTimestamp(parentToolEnd) ||
    !isBoundedFallbackTimestamp(pendingMs)
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "parent tool pending interval or fallback timeline is malformed",
      ),
    );
  }
  if (
    startedAt >= endedAt ||
    parentToolStart !== startedAt ||
    parentToolEnd !== endedAt ||
    pendingMs !== endedAt - startedAt ||
    pendingMs > MAX_COMMAND_TIMEOUT_MS ||
    parentControl.parentToolStartedAtMs !== parent.parentToolStartedAtMs ||
    parentControl.parentToolEndedAtMs !== parent.parentToolEndedAtMs ||
    parentControl.parentToolPendingMs !== parent.parentToolPendingMs ||
    !sameNumberArray(
      childLifecycle.contextRepairTimesMs,
      child.lifecycle.contextRepairTimesMs,
    ) ||
    !sameNumberArray(
      childLifecycle.modelSelectTimesMs,
      child.lifecycle.modelSelectTimesMs,
    ) ||
    !sameNumberArray(
      childLifecycle.markerMessageStartTimesMs,
      child.lifecycle.markerMessageStartTimesMs,
    ) ||
    !sameNumberArray(
      childLifecycle.settlementTimesMs,
      child.lifecycle.settlementTimesMs,
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "parent tool pending interval or fallback timeline is malformed",
      ),
    );
  }

  if (
    startedAt > firstSettlement ||
    firstSettlement > modelSelection ||
    modelSelection > markerStart ||
    markerStart > contextRepair ||
    contextRepair > finalSettlement ||
    finalSettlement > endedAt
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback lifecycle phases are out of order or outside the parent tool interval",
      ),
    );
  }
  return ok(undefined);
}

function validateProviderDurableCommonFacts(
  provider: FixtureMessageFacts,
  history: FixtureHistoryFacts,
): Result<void, SmokeFailure> {
  for (const fact of EXPECTED_PROVIDER_FACTS) {
    const providerDescriptor = provider.descriptors.find(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash(fact),
    );
    const historyDescriptor = history.descriptors.find(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash(fact),
    );
    const sameFact =
      fact === "unrelated-custom"
        ? providerDescriptor !== undefined &&
          historyDescriptor !== undefined &&
          providerDescriptor.roleHash === fixtureRoleHash("user") &&
          providerDescriptor.customTypeHash === undefined &&
          historyDescriptor.roleHash === fixtureRoleHash("custom") &&
          historyDescriptor.customTypeHash ===
            fixtureCustomTypeHash(UNRELATED_CUSTOM_TYPE) &&
          providerDescriptor.contentShapeHash ===
            historyDescriptor.contentShapeHash &&
          providerDescriptor.contentBlockCount ===
            historyDescriptor.contentBlockCount &&
          providerDescriptor.toolCallCount ===
            historyDescriptor.toolCallCount &&
          providerDescriptor.toolResultCount ===
            historyDescriptor.toolResultCount &&
          providerDescriptor.correlationHash ===
            historyDescriptor.correlationHash
        : providerDescriptor !== undefined &&
          historyDescriptor !== undefined &&
          sameContextDescriptor(providerDescriptor, historyDescriptor);
    if (
      providerDescriptor === undefined ||
      historyDescriptor === undefined ||
      !sameFact
    ) {
      return err(
        failure(
          "ProviderContextViolation",
          `provider and durable ${fact} descriptors disagree`,
        ),
      );
    }
  }
  return ok(undefined);
}

export function validateFallbackFacts(input: {
  readonly observation: ScenarioObservation;
  readonly child: FixtureSnapshot;
  readonly parent: FixtureSnapshot;
}): Result<FallbackScenarioFacts, SmokeFailure> {
  const { observation, child, parent } = input;
  const sources = validateObservedSources({
    observation,
    snapshots: [child, parent],
    smokeCase: "fallback",
  });
  if (sources.isErr()) return err(sources.error);
  const childControl = observation.controls.find(
    (capture) => capture.role === "child",
  );
  const childNative = observation.nativeSessions.find(
    (session) => session.role === "child",
  );
  if (
    childControl?.lifecycle.appliedIdentity === undefined ||
    childNative?.appliedIdentity === undefined ||
    !sameIdentity(
      childControl.lifecycle.appliedIdentity,
      childNative.appliedIdentity,
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "model_select and native model identities are incomplete",
      ),
    );
  }
  const requests = child.requests;
  const fallbackRequests = requests.filter(
    (request) => request.model === "second",
  );
  const fallbackRequest = fallbackRequests[0];
  if (fallbackRequest === undefined)
    return err(
      failure(
        "ProviderContextViolation",
        "fallback provider request was not captured",
      ),
    );
  if (
    requests.length !== 3 ||
    requests.some((request, index) => request.requestNumber !== index + 1) ||
    requests[0]?.model !== "first" ||
    requests[1]?.model !== "first" ||
    fallbackRequests.length !== 1 ||
    fallbackRequest.requestNumber !== 3
  ) {
    return err(
      failure("UnexpectedEventCount", "provider request sequence changed"),
    );
  }
  const failedProviderRequest = requests[1];
  if (failedProviderRequest === undefined) {
    return err(
      failure("ProviderContextViolation", "failed provider request is missing"),
    );
  }
  const failedProvider = validateFailedProviderContext(failedProviderRequest);
  if (failedProvider.isErr()) return err(failedProvider.error);
  const exactProvider = validateExactProviderContext(fallbackRequest);
  if (exactProvider.isErr()) return err(exactProvider.error);
  const providerContinuity = validateProviderContextContinuity(
    failedProviderRequest,
    fallbackRequest,
  );
  if (providerContinuity.isErr()) return err(providerContinuity.error);
  const history = child.history;
  if (history === undefined) {
    return err(
      failure("ProviderContextViolation", "native history is missing"),
    );
  }
  const exactHistory = validateExactDurableHistory(history, childControl);
  if (exactHistory.isErr()) return err(exactHistory.error);
  const commonFacts = validateProviderDurableCommonFacts(
    fallbackRequest,
    history,
  );
  if (commonFacts.isErr()) return err(commonFacts.error);
  const failedAssistant =
    history.descriptors[EXPECTED_HISTORY_FACTS.indexOf("failed-assistant")];
  if (
    failedAssistant === undefined ||
    fallbackRequest.descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
          fixtureCorrelationHash("failed-assistant") ||
        descriptor.contentFingerprintHash ===
          failedAssistant.contentFingerprintHash ||
        descriptor.customTypeHash ===
          fixtureCustomTypeHash(NATIVE_RECOVERY_MARKER_TYPE),
    )
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "fallback provider still contains the correlated failed assistant or marker",
      ),
    );
  }
  if (
    child.lifecycle.messageStartCount !== 6 ||
    child.lifecycle.messageEndCount !== 6 ||
    child.lifecycle.contextCount !== 3 ||
    child.lifecycle.contextRepairCount !== 1 ||
    child.lifecycle.markerMessageStartCount !== 1 ||
    child.lifecycle.modelSelectCount !== 1 ||
    child.lifecycle.settlementCount !== 2
  ) {
    return err(
      failure("UnexpectedEventCount", "child lifecycle event count changed"),
    );
  }
  if (child.lifecycle.beforeAgentStartCount !== 1) {
    return err(
      failure(
        "UnexpectedEventCount",
        "recovery unexpectedly ran before_agent_start",
      ),
    );
  }
  if (
    !child.lifecycle.recoveryMarkerObserved ||
    child.lifecycle.markerMessageStartTimesMs.length !== 1 ||
    child.lifecycle.contextRepairTimesMs.length !== 1 ||
    child.lifecycle.modelSelectTimesMs.length !== 1 ||
    child.lifecycle.settlementTimesMs.length !== 2
  ) {
    return err(
      failure(
        "UnexpectedEventCount",
        "exact recovery event timestamps are incomplete",
      ),
    );
  }
  const cleanupResult = verifiedCleanup(observation);
  if (cleanupResult.isErr()) return err(cleanupResult.error);
  if (
    parent.lifecycle.settlementCount !== 1 ||
    parent.lifecycle.settlementTimesMs.length !== 1 ||
    parent.parentToolPendingMs === undefined ||
    !Number.isFinite(parent.parentToolPendingMs) ||
    parent.parentToolPendingMs < 0 ||
    parent.parentToolPendingMs > MAX_COMMAND_TIMEOUT_MS ||
    Object.values(cleanupResult.value).some((value) => value !== true)
  ) {
    return err(
      failure(
        "UnexpectedEventCount",
        "parent tool did not settle exactly once and clean up",
      ),
    );
  }
  const pendingTimeline = validateParentToolPendingAcrossChildTimeline(
    child,
    parent,
    observation,
  );
  if (pendingTimeline.isErr()) return err(pendingTimeline.error);
  const identity = child.lifecycle.appliedIdentity;
  if (identity?.provider !== "smoke" || identity.id !== "second")
    return err(
      failure(
        "ProviderContextViolation",
        "applied model identity is not authenticated",
      ),
    );
  const count = observation.visibleEventCount;
  if (count !== EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT)
    return err(
      failure(
        "UnexpectedEventCount",
        `expected one visible fallback event, got ${count}`,
      ),
    );
  if (
    containsForbiddenContent(observation.output, [
      PROVIDER_FAILURE_MARKER,
      RECOVERY_MARKER,
      PARENT_TASK,
      ROLLBACK_TASK,
      CHILD_TASK,
    ])
  ) {
    return err(
      failure("LeakedContent", "provider or marker content reached the report"),
    );
  }
  const visible = normalizedTuiOutput(observation.output);
  if (!visible.includes(EXPECTED_NATIVE_LINE))
    return err(
      failure(
        "UnexpectedEventCount",
        "card Native Line or applied identity was not visible",
      ),
    );
  const cleanup = cleanupResult.value;
  const processIdentityStable =
    child.processIdBeforeHash === child.processIdAfterHash &&
    parent.processIdBeforeHash === parent.processIdAfterHash;
  const nativeSessionIdentityStable =
    child.sessionIdBeforeHash === child.sessionIdAfterHash;
  const threadIdentityStable =
    child.threadIdBeforeHash === child.threadIdAfterHash;
  const parentToolCallIdentityStable =
    parent.parentToolCallIdHash === parent.parentToolEndCallIdHash;
  if (
    !processIdentityStable ||
    !nativeSessionIdentityStable ||
    !threadIdentityStable ||
    !parentToolCallIdentityStable
  ) {
    return err(
      failure(
        "ProviderContextViolation",
        "stable runtime identity facts are incomplete",
      ),
    );
  }
  return ok({
    processIdentityStable,
    nativeSessionIdentityStable,
    threadIdentityStable,
    parentToolCallIdentityStable,
    providerRequest: fallbackRequest,
    durableHistory: history,
    lifecycle: child.lifecycle,
    visibleEventCount: count,
    cardAppliedIdentity: identity,
    nativeLine: EXPECTED_NATIVE_LINE,
    parentPendingIntervalMs: Math.min(
      parent.parentToolPendingMs,
      MAX_COMMAND_TIMEOUT_MS,
    ),
    parentSettlementCount: 1,
    cleanup,
  });
}
