import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  boundedCount,
  descriptorCounts,
  type FixtureControlFacts,
  type FixtureDescriptorCounts,
  type FixtureHistoryDescriptor,
  type FixtureLifecycleFacts,
  type FixtureMessageDescriptor,
  type FixtureMessageFacts,
  type FixtureProviderCapture,
  type FixtureShimFacts,
  failure,
  fixtureCorrelationHash,
  fixtureCustomTypeHash,
  fixtureEntryTypeHash,
  fixtureRoleHash,
  isRecord,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_CONTEXT_DESCRIPTOR_COUNT,
  MAX_HISTORY_DESCRIPTOR_COUNT,
  MAX_REPORT_STRING_LENGTH,
  NATIVE_RECOVERY_MARKER_TYPE,
  ROLLBACK_DISABLED_SURFACE,
  ROLLBACK_SHIM_BOUNDARY,
  type SafeModelIdentity,
  SHA256,
  type SmokeFailure,
} from "./contract.js";
export interface RawFixtureCaptures {
  readonly providers: readonly FixtureProviderCapture[];
  readonly controls: readonly FixtureControlFacts[];
  readonly shims: readonly FixtureShimFacts[];
}

export const MESSAGE_DESCRIPTOR_KEYS = new Set([
  "ordinal",
  "roleHash",
  "customTypeHash",
  "contentShapeHash",
  "contentFingerprintHash",
  "contentBlockCount",
  "toolCallCount",
  "toolResultCount",
  "correlationHash",
]);
export const HISTORY_DESCRIPTOR_KEYS = new Set([
  ...MESSAGE_DESCRIPTOR_KEYS,
  "entryIndex",
  "entryTypeHash",
]);
const PROVIDER_CAPTURE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "role",
  "requestCount",
  "requests",
]);
const CONTROL_CAPTURE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "role",
  "markerTokenHash",
  "failedAssistantFingerprintHash",
  "failedAssistantShapeHash",
  "processIdHash",
  "processIdBeforeHash",
  "processIdAfterHash",
  "childIdHash",
  "childIdBeforeHash",
  "childIdAfterHash",
  "lifecycle",
  "parentToolCallIdHash",
  "parentToolEndCallIdHash",
  "parentToolStartedAtMs",
  "parentToolEndedAtMs",
  "parentToolPendingMs",
  "parentToolStartCount",
  "parentToolEndCount",
  "parentToolStartTimesMs",
  "parentToolEndTimesMs",
  "pendingMessageHelperPresent",
  "adapterPackageVersion",
  "adapterExtensionSha256",
  "adapterPackageSourceProven",
  "adapterPackageRootMatched",
  "adapterExtensionHashMatched",
]);
const SHIM_CAPTURE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "role",
  "phase",
  "boundary",
  "disabledSurface",
  "originalSurfacePresent",
  "disabledBeforeAdapterInitialization",
  "requiredDelegationSurfacesIntact",
  "adapterInitialized",
]);
const MESSAGE_FACT_KEYS = new Set([
  "requestNumber",
  "provider",
  "model",
  "messageCount",
  "contextHash",
  "descriptors",
  "descriptorCount",
  "userCount",
  "assistantCount",
  "toolResultCount",
  "customCount",
  "originalUserPresent",
  "taskPresent",
  "toolCallPresent",
  "toolResultPresent",
  "failedAssistantPresent",
  "recoveryMarkerPresent",
  "syntheticProviderUserMessagePresent",
]);

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseDescriptorHash(
  value: unknown,
  field: string,
  label: string,
): Result<string, SmokeFailure> {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return err(failure("CaptureMalformed", `${label} ${field} is invalid`));
  }
  return ok(value);
}

function parseMessageDescriptor(
  value: unknown,
  label: string,
  history: boolean,
): Result<FixtureMessageDescriptor | FixtureHistoryDescriptor, SmokeFailure> {
  if (!isRecord(value))
    return err(failure("CaptureMalformed", `${label} is not an object`));
  const allowed = history ? HISTORY_DESCRIPTOR_KEYS : MESSAGE_DESCRIPTOR_KEYS;
  if (!hasOnlyKeys(value, allowed)) {
    return err(
      failure(
        "CaptureMalformed",
        `${label} contains an unapproved descriptor field`,
      ),
    );
  }
  if (
    !boundedCount(value.ordinal) ||
    value.ordinal >=
      (history ? MAX_HISTORY_DESCRIPTOR_COUNT : MAX_CONTEXT_DESCRIPTOR_COUNT) ||
    !boundedCount(value.contentBlockCount) ||
    !boundedCount(value.toolCallCount) ||
    !boundedCount(value.toolResultCount)
  ) {
    return err(
      failure("CaptureMalformed", `${label} descriptor bounds are invalid`),
    );
  }
  const roleHash = parseDescriptorHash(value.roleHash, "roleHash", label);
  if (roleHash.isErr()) return err(roleHash.error);
  if (
    ![
      fixtureRoleHash("user"),
      fixtureRoleHash("assistant"),
      fixtureRoleHash("toolResult"),
      fixtureRoleHash("custom"),
    ].includes(roleHash.value)
  ) {
    return err(failure("CaptureMalformed", `${label} role hash is unknown`));
  }
  const shapeHash = parseDescriptorHash(
    value.contentShapeHash,
    "contentShapeHash",
    label,
  );
  if (shapeHash.isErr()) return err(shapeHash.error);
  const fingerprintHash = parseDescriptorHash(
    value.contentFingerprintHash,
    "contentFingerprintHash",
    label,
  );
  if (fingerprintHash.isErr()) return err(fingerprintHash.error);
  const customTypeHash = value.customTypeHash;
  if (customTypeHash !== undefined) {
    const parsed = parseDescriptorHash(customTypeHash, "customTypeHash", label);
    if (parsed.isErr()) return err(parsed.error);
    if (roleHash.value !== fixtureRoleHash("custom")) {
      return err(
        failure(
          "CaptureMalformed",
          `${label} custom type has a non-custom role`,
        ),
      );
    }
  }
  const correlationHash = value.correlationHash;
  if (correlationHash !== undefined) {
    const parsed = parseDescriptorHash(
      correlationHash,
      "correlationHash",
      label,
    );
    if (parsed.isErr()) return err(parsed.error);
  }
  const descriptor: FixtureMessageDescriptor = {
    ordinal: value.ordinal,
    roleHash: roleHash.value,
    ...(customTypeHash === undefined
      ? {}
      : { customTypeHash: customTypeHash as string }),
    contentShapeHash: shapeHash.value,
    contentFingerprintHash: fingerprintHash.value,
    contentBlockCount: value.contentBlockCount,
    toolCallCount: value.toolCallCount,
    toolResultCount: value.toolResultCount,
    ...(correlationHash === undefined
      ? {}
      : { correlationHash: correlationHash as string }),
  };
  if (!history) return ok(descriptor);
  if (
    !boundedCount(value.entryIndex) ||
    value.entryIndex > MAX_HISTORY_DESCRIPTOR_COUNT
  ) {
    return err(failure("CaptureMalformed", `${label} entry index is invalid`));
  }
  const entryTypeHash = parseDescriptorHash(
    value.entryTypeHash,
    "entryTypeHash",
    label,
  );
  if (entryTypeHash.isErr()) return err(entryTypeHash.error);
  if (
    ![
      fixtureEntryTypeHash("message"),
      fixtureEntryTypeHash("custom_message"),
      fixtureEntryTypeHash("custom"),
    ].includes(entryTypeHash.value)
  ) {
    return err(
      failure("CaptureMalformed", `${label} entry type hash is unknown`),
    );
  }
  return ok({
    ...descriptor,
    entryIndex: value.entryIndex,
    entryTypeHash: entryTypeHash.value,
  });
}

function parseDescriptorCounts(
  value: Record<string, unknown>,
  descriptors: readonly FixtureMessageDescriptor[],
  label: string,
): Result<FixtureDescriptorCounts, SmokeFailure> {
  const fields = [
    "descriptorCount",
    "userCount",
    "assistantCount",
    "toolResultCount",
    "customCount",
  ] as const;
  if (fields.some((field) => !boundedCount(value[field]))) {
    return err(
      failure("CaptureMalformed", `${label} descriptor counts are invalid`),
    );
  }
  const expected = descriptorCounts(descriptors);
  if (fields.some((field) => value[field] !== expected[field])) {
    return err(
      failure("CaptureMalformed", `${label} descriptor counts disagree`),
    );
  }
  return ok(expected);
}

export function descriptorFactsFromDescriptors(
  descriptors: readonly FixtureMessageDescriptor[],
): Pick<
  FixtureMessageFacts,
  | "originalUserPresent"
  | "taskPresent"
  | "toolCallPresent"
  | "toolResultPresent"
  | "failedAssistantPresent"
  | "recoveryMarkerPresent"
  | "syntheticProviderUserMessagePresent"
> {
  const knownUsers = new Set(
    (
      [
        "original-task-user",
        "original-user",
        "steering-user",
        "follow-up-user",
        "unrelated-custom",
        "queued-user",
      ] as const
    ).map(fixtureCorrelationHash),
  );
  const userRole = fixtureRoleHash("user");
  return {
    originalUserPresent: descriptors.some(
      (descriptor) => descriptor.roleHash === userRole,
    ),
    taskPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
        fixtureCorrelationHash("original-task-user"),
    ),
    toolCallPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash("tool-call"),
    ),
    toolResultPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash === fixtureCorrelationHash("tool-result"),
    ),
    failedAssistantPresent: descriptors.some(
      (descriptor) =>
        descriptor.correlationHash ===
        fixtureCorrelationHash("failed-assistant"),
    ),
    recoveryMarkerPresent: descriptors.some(
      (descriptor) =>
        descriptor.customTypeHash ===
        fixtureCustomTypeHash(NATIVE_RECOVERY_MARKER_TYPE),
    ),
    syntheticProviderUserMessagePresent: descriptors.some(
      (descriptor) =>
        descriptor.roleHash === userRole &&
        (descriptor.correlationHash === undefined ||
          !knownUsers.has(descriptor.correlationHash)),
    ),
  };
}

export function boundedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTimestampArray(
  value: unknown,
  field: string,
  expectedCount: number,
): Result<readonly number[], SmokeFailure> {
  if (
    !Array.isArray(value) ||
    value.length !== expectedCount ||
    value.length > 256
  ) {
    return err(
      failure("CaptureMalformed", `control ${field} count is invalid`),
    );
  }
  if (value.some((candidate) => !boundedTimestamp(candidate))) {
    return err(
      failure("CaptureMalformed", `control ${field} timestamp is invalid`),
    );
  }
  return ok(value as number[]);
}

function parseIdentity(
  value: unknown,
): Result<SafeModelIdentity | undefined, SmokeFailure> {
  if (value === undefined) return ok(undefined);
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    typeof value.id !== "string"
  ) {
    return err(
      failure("CaptureMalformed", "control model identity is malformed"),
    );
  }
  if (value.provider.length > 64 || value.id.length > 128) {
    return err(
      failure("CaptureMalformed", "control model identity is too large"),
    );
  }
  return ok({ provider: value.provider, id: value.id });
}

function parseLifecycle(
  value: unknown,
): Result<FixtureLifecycleFacts, SmokeFailure> {
  if (!isRecord(value))
    return err(failure("CaptureMalformed", "control lifecycle is missing"));
  const fields = [
    "beforeAgentStartCount",
    "messageStartCount",
    "messageEndCount",
    "contextCount",
    "contextRepairCount",
    "modelSelectCount",
    "settlementCount",
    "markerMessageStartCount",
    "recoveryMarkerCount",
  ] as const;
  const counts = fields.map((field) => value[field]);
  if (counts.some((count) => !boundedCount(count))) {
    return err(
      failure("CaptureMalformed", "control lifecycle count is invalid"),
    );
  }
  if (counts[7] !== counts[8]) {
    return err(failure("CaptureMalformed", "control marker counts disagree"));
  }
  if (
    (counts[4] as number) > (counts[3] as number) ||
    (counts[7] as number) > (counts[1] as number)
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "control lifecycle event counts are inconsistent",
      ),
    );
  }
  if (typeof value.recoveryMarkerObserved !== "boolean") {
    return err(
      failure("CaptureMalformed", "control marker observation is invalid"),
    );
  }
  const contextRepairTimes = parseTimestampArray(
    value.contextRepairTimesMs,
    "contextRepairTimesMs",
    counts[4] as number,
  );
  if (contextRepairTimes.isErr()) return err(contextRepairTimes.error);
  const modelSelectTimes = parseTimestampArray(
    value.modelSelectTimesMs,
    "modelSelectTimesMs",
    counts[5] as number,
  );
  if (modelSelectTimes.isErr()) return err(modelSelectTimes.error);
  const settlementTimes = parseTimestampArray(
    value.settlementTimesMs,
    "settlementTimesMs",
    counts[6] as number,
  );
  if (settlementTimes.isErr()) return err(settlementTimes.error);
  const markerTimes = parseTimestampArray(
    value.markerMessageStartTimesMs,
    "markerMessageStartTimesMs",
    counts[7] as number,
  );
  if (markerTimes.isErr()) return err(markerTimes.error);
  const identity = parseIdentity(value.appliedIdentity);
  if (identity.isErr()) return err(identity.error);
  return ok({
    beforeAgentStartCount: counts[0] as number,
    messageStartCount: counts[1] as number,
    messageEndCount: counts[2] as number,
    contextCount: counts[3] as number,
    contextRepairCount: counts[4] as number,
    contextRepairTimesMs: contextRepairTimes.value,
    modelSelectCount: counts[5] as number,
    modelSelectTimesMs: modelSelectTimes.value,
    settlementCount: counts[6] as number,
    settlementTimesMs: settlementTimes.value,
    markerMessageStartCount: counts[7] as number,
    markerMessageStartTimesMs: markerTimes.value,
    recoveryMarkerCount: counts[8] as number,
    recoveryMarkerObserved: value.recoveryMarkerObserved,
    ...(identity.value === undefined
      ? {}
      : { appliedIdentity: identity.value }),
  });
}

function parseProviderCapture(
  value: unknown,
): Result<FixtureProviderCapture, SmokeFailure> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "provider"
  ) {
    return err(
      failure("CaptureMalformed", "provider capture header is invalid"),
    );
  }
  if (value.role !== "parent" && value.role !== "child") {
    return err(failure("CaptureMalformed", "provider capture role is invalid"));
  }
  if (!hasOnlyKeys(value, PROVIDER_CAPTURE_KEYS)) {
    return err(
      failure(
        "CaptureMalformed",
        "provider capture contains an unapproved field",
      ),
    );
  }
  if (
    !boundedCount(value.requestCount) ||
    value.requestCount > 8 ||
    !Array.isArray(value.requests) ||
    value.requests.length > 8 ||
    value.requests.length !== value.requestCount
  ) {
    return err(
      failure("CaptureMalformed", "provider capture request bound is invalid"),
    );
  }
  const requests: FixtureMessageFacts[] = [];
  for (const request of value.requests) {
    if (!isRecord(request))
      return err(
        failure("CaptureMalformed", "provider request is not an object"),
      );
    if (!hasOnlyKeys(request, MESSAGE_FACT_KEYS)) {
      return err(
        failure(
          "CaptureMalformed",
          "provider request contains an unapproved field",
        ),
      );
    }
    const booleanFields = [
      "originalUserPresent",
      "taskPresent",
      "toolCallPresent",
      "toolResultPresent",
      "failedAssistantPresent",
      "recoveryMarkerPresent",
      "syntheticProviderUserMessagePresent",
    ] as const;
    if (
      !boundedCount(request.requestNumber) ||
      request.requestNumber < 1 ||
      typeof request.provider !== "string" ||
      request.provider.length > 64 ||
      typeof request.model !== "string" ||
      request.model.length > 128 ||
      !boundedCount(request.messageCount) ||
      request.messageCount > MAX_CONTEXT_DESCRIPTOR_COUNT ||
      typeof request.contextHash !== "string" ||
      !SHA256.test(request.contextHash) ||
      !Array.isArray(request.descriptors) ||
      request.descriptors.length !== request.messageCount ||
      request.descriptors.length > MAX_CONTEXT_DESCRIPTOR_COUNT ||
      booleanFields.some((field) => typeof request[field] !== "boolean")
    ) {
      return err(
        failure("CaptureMalformed", "provider request facts are invalid"),
      );
    }
    const descriptors: FixtureMessageDescriptor[] = [];
    for (const [index, descriptor] of request.descriptors.entries()) {
      const parsed = parseMessageDescriptor(
        descriptor,
        `provider request ${request.requestNumber} descriptor ${index}`,
        false,
      );
      if (parsed.isErr()) return err(parsed.error);
      if (parsed.value.ordinal !== index) {
        return err(
          failure(
            "CaptureMalformed",
            "provider descriptor ordinal is not ordered",
          ),
        );
      }
      descriptors.push(parsed.value as FixtureMessageDescriptor);
    }
    const counts = parseDescriptorCounts(
      request,
      descriptors,
      `provider request ${request.requestNumber}`,
    );
    if (counts.isErr()) return err(counts.error);
    const derived = descriptorFactsFromDescriptors(descriptors);
    if (booleanFields.some((field) => request[field] !== derived[field])) {
      return err(
        failure(
          "CaptureMalformed",
          `provider request ${request.requestNumber} facts disagree with descriptors`,
        ),
      );
    }
    requests.push({
      requestNumber: request.requestNumber,
      provider: request.provider,
      model: request.model,
      messageCount: request.messageCount,
      contextHash: request.contextHash,
      descriptors,
      ...counts.value,
      ...derived,
    });
  }
  return ok({
    schemaVersion: 1,
    kind: "provider",
    role: value.role,
    requestCount: value.requestCount,
    requests,
  });
}

function parseControlCapture(
  value: unknown,
): Result<FixtureControlFacts, SmokeFailure> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "control"
  ) {
    return err(
      failure("CaptureMalformed", "control capture header is invalid"),
    );
  }
  if (
    !hasOnlyKeys(value, CONTROL_CAPTURE_KEYS) ||
    (value.role !== "parent" && value.role !== "child") ||
    typeof value.processIdHash !== "string" ||
    !SHA256.test(value.processIdHash)
  ) {
    return err(
      failure("CaptureMalformed", "control capture identity is invalid"),
    );
  }
  const identityHash = (
    field:
      | "processIdBeforeHash"
      | "processIdAfterHash"
      | "childIdBeforeHash"
      | "childIdAfterHash",
    required: boolean,
  ): Result<string | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined && !required) return ok(undefined);
    if (typeof candidate !== "string" || !SHA256.test(candidate)) {
      return err(failure("CaptureMalformed", `control ${field} is invalid`));
    }
    return ok(candidate);
  };
  const processBefore = identityHash("processIdBeforeHash", true);
  if (processBefore.isErr()) return err(processBefore.error);
  const processAfter = identityHash("processIdAfterHash", true);
  if (processAfter.isErr()) return err(processAfter.error);
  if (processAfter.value !== value.processIdHash) {
    return err(
      failure("CaptureMalformed", "control process identity sources disagree"),
    );
  }
  const childIdHash = value.childIdHash;
  if (
    childIdHash !== undefined &&
    (typeof childIdHash !== "string" || !SHA256.test(childIdHash))
  ) {
    return err(
      failure("CaptureMalformed", "control child identity is invalid"),
    );
  }
  const childBefore = identityHash("childIdBeforeHash", value.role === "child");
  if (childBefore.isErr()) return err(childBefore.error);
  const childAfter = identityHash("childIdAfterHash", value.role === "child");
  if (childAfter.isErr()) return err(childAfter.error);
  if (
    value.role === "child" &&
    (childIdHash === undefined || childAfter.value !== childIdHash)
  ) {
    return err(
      failure("CaptureMalformed", "child control identity sources disagree"),
    );
  }
  if (
    value.role === "parent" &&
    (childIdHash !== undefined ||
      childBefore.value !== undefined ||
      childAfter.value !== undefined)
  ) {
    return err(
      failure("CaptureMalformed", "parent control contains child identity"),
    );
  }
  const lifecycle = parseLifecycle(value.lifecycle);
  if (lifecycle.isErr()) return err(lifecycle.error);
  const optionalHash = (
    field: "parentToolCallIdHash" | "parentToolEndCallIdHash",
  ) => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return typeof candidate === "string" && SHA256.test(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const callId = optionalHash("parentToolCallIdHash");
  if (callId.isErr()) return err(callId.error);
  const endCallId = optionalHash("parentToolEndCallIdHash");
  if (endCallId.isErr()) return err(endCallId.error);
  const optionalDescriptorHash = (
    field:
      | "markerTokenHash"
      | "failedAssistantFingerprintHash"
      | "failedAssistantShapeHash",
  ): Result<string | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return typeof candidate === "string" && SHA256.test(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const markerTokenHash = optionalDescriptorHash("markerTokenHash");
  if (markerTokenHash.isErr()) return err(markerTokenHash.error);
  const failedAssistantFingerprintHash = optionalDescriptorHash(
    "failedAssistantFingerprintHash",
  );
  if (failedAssistantFingerprintHash.isErr())
    return err(failedAssistantFingerprintHash.error);
  const failedAssistantShapeHash = optionalDescriptorHash(
    "failedAssistantShapeHash",
  );
  if (failedAssistantShapeHash.isErr())
    return err(failedAssistantShapeHash.error);
  const optionalTimestamp = (
    field: "parentToolStartedAtMs" | "parentToolEndedAtMs",
  ): Result<number | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return boundedTimestamp(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const startedAt = optionalTimestamp("parentToolStartedAtMs");
  if (startedAt.isErr()) return err(startedAt.error);
  const endedAt = optionalTimestamp("parentToolEndedAtMs");
  if (endedAt.isErr()) return err(endedAt.error);
  if (
    value.parentToolPendingMs !== undefined &&
    (typeof value.parentToolPendingMs !== "number" ||
      !Number.isSafeInteger(value.parentToolPendingMs) ||
      value.parentToolPendingMs < 0 ||
      value.parentToolPendingMs > MAX_COMMAND_TIMEOUT_MS)
  ) {
    return err(
      failure("CaptureMalformed", "control pending interval is invalid"),
    );
  }
  const optionalToolCount = (
    field: "parentToolStartCount" | "parentToolEndCount",
  ): Result<number | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return boundedCount(candidate)
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const startCount = optionalToolCount("parentToolStartCount");
  if (startCount.isErr()) return err(startCount.error);
  const endCount = optionalToolCount("parentToolEndCount");
  if (endCount.isErr()) return err(endCount.error);
  const optionalToolTimes = (
    field: "parentToolStartTimesMs" | "parentToolEndTimesMs",
    count: number | undefined,
  ): Result<readonly number[] | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined && count === undefined) return ok(undefined);
    if (count === undefined)
      return err(
        failure("CaptureMalformed", `control ${field} count is missing`),
      );
    return parseTimestampArray(candidate, field, count);
  };
  const startTimes = optionalToolTimes(
    "parentToolStartTimesMs",
    startCount.value,
  );
  if (startTimes.isErr()) return err(startTimes.error);
  const endTimes = optionalToolTimes("parentToolEndTimesMs", endCount.value);
  if (endTimes.isErr()) return err(endTimes.error);
  if (
    value.role === "parent" &&
    (startCount.value === undefined) !== (endCount.value === undefined)
  ) {
    return err(
      failure("CaptureMalformed", "parent tool event counts are incomplete"),
    );
  }
  if (
    value.role === "child" &&
    (startCount.value !== undefined ||
      endCount.value !== undefined ||
      startTimes.value !== undefined ||
      endTimes.value !== undefined)
  ) {
    return err(
      failure("CaptureMalformed", "child control contains parent tool events"),
    );
  }
  if (
    value.pendingMessageHelperPresent !== undefined &&
    typeof value.pendingMessageHelperPresent !== "boolean"
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "control pending helper observation is invalid",
      ),
    );
  }
  const adapterPackageVersion = value.adapterPackageVersion;
  if (
    adapterPackageVersion !== undefined &&
    (typeof adapterPackageVersion !== "string" ||
      adapterPackageVersion.length === 0 ||
      adapterPackageVersion.length > MAX_REPORT_STRING_LENGTH)
  )
    return err(
      failure("CaptureMalformed", "adapter package version is invalid"),
    );
  const adapterExtensionSha256 = value.adapterExtensionSha256;
  if (
    adapterExtensionSha256 !== undefined &&
    (typeof adapterExtensionSha256 !== "string" ||
      !SHA256.test(adapterExtensionSha256))
  )
    return err(
      failure("CaptureMalformed", "adapter extension hash is invalid"),
    );
  const adapterBoolean = (
    field:
      | "adapterPackageSourceProven"
      | "adapterPackageRootMatched"
      | "adapterExtensionHashMatched",
  ): Result<boolean | undefined, SmokeFailure> => {
    const candidate = value[field];
    if (candidate === undefined) return ok(undefined);
    return typeof candidate === "boolean"
      ? ok(candidate)
      : err(failure("CaptureMalformed", `control ${field} is invalid`));
  };
  const adapterPackageSourceProven = adapterBoolean(
    "adapterPackageSourceProven",
  );
  if (adapterPackageSourceProven.isErr())
    return err(adapterPackageSourceProven.error);
  const adapterPackageRootMatched = adapterBoolean("adapterPackageRootMatched");
  if (adapterPackageRootMatched.isErr())
    return err(adapterPackageRootMatched.error);
  const adapterExtensionHashMatched = adapterBoolean(
    "adapterExtensionHashMatched",
  );
  if (adapterExtensionHashMatched.isErr())
    return err(adapterExtensionHashMatched.error);
  return ok({
    schemaVersion: 1,
    kind: "control",
    role: value.role,
    ...(markerTokenHash.value === undefined
      ? {}
      : { markerTokenHash: markerTokenHash.value }),
    ...(failedAssistantFingerprintHash.value === undefined
      ? {}
      : {
          failedAssistantFingerprintHash: failedAssistantFingerprintHash.value,
        }),
    ...(failedAssistantShapeHash.value === undefined
      ? {}
      : { failedAssistantShapeHash: failedAssistantShapeHash.value }),
    processIdHash: value.processIdHash,
    ...(processBefore.value === undefined
      ? {}
      : { processIdBeforeHash: processBefore.value }),
    ...(processAfter.value === undefined
      ? {}
      : { processIdAfterHash: processAfter.value }),
    ...(childBefore.value === undefined
      ? {}
      : { childIdBeforeHash: childBefore.value }),
    ...(childAfter.value === undefined
      ? {}
      : { childIdAfterHash: childAfter.value }),
    ...(childIdHash === undefined ? {} : { childIdHash }),
    lifecycle: lifecycle.value,
    ...(callId.value === undefined
      ? {}
      : { parentToolCallIdHash: callId.value }),
    ...(endCallId.value === undefined
      ? {}
      : { parentToolEndCallIdHash: endCallId.value }),
    ...(startedAt.value === undefined
      ? {}
      : { parentToolStartedAtMs: startedAt.value }),
    ...(endedAt.value === undefined
      ? {}
      : { parentToolEndedAtMs: endedAt.value }),
    ...(value.parentToolPendingMs === undefined
      ? {}
      : { parentToolPendingMs: value.parentToolPendingMs }),
    ...(startCount.value === undefined
      ? {}
      : { parentToolStartCount: startCount.value }),
    ...(endCount.value === undefined
      ? {}
      : { parentToolEndCount: endCount.value }),
    ...(startTimes.value === undefined
      ? {}
      : { parentToolStartTimesMs: startTimes.value }),
    ...(endTimes.value === undefined
      ? {}
      : { parentToolEndTimesMs: endTimes.value }),
    ...(value.pendingMessageHelperPresent === undefined
      ? {}
      : { pendingMessageHelperPresent: value.pendingMessageHelperPresent }),
    ...(adapterPackageVersion === undefined ? {} : { adapterPackageVersion }),
    ...(adapterExtensionSha256 === undefined ? {} : { adapterExtensionSha256 }),
    ...(adapterPackageSourceProven.value === undefined
      ? {}
      : { adapterPackageSourceProven: adapterPackageSourceProven.value }),
    ...(adapterPackageRootMatched.value === undefined
      ? {}
      : { adapterPackageRootMatched: adapterPackageRootMatched.value }),
    ...(adapterExtensionHashMatched.value === undefined
      ? {}
      : { adapterExtensionHashMatched: adapterExtensionHashMatched.value }),
  });
}

function parseRollbackShimCapture(
  value: unknown,
): Result<FixtureShimFacts, SmokeFailure> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "rollback-shim" ||
    !hasOnlyKeys(value, SHIM_CAPTURE_KEYS) ||
    (value.role !== "parent" && value.role !== "child") ||
    (value.phase !== "before-adapter" && value.phase !== "after-adapter") ||
    value.boundary !== ROLLBACK_SHIM_BOUNDARY ||
    value.disabledSurface !== ROLLBACK_DISABLED_SURFACE ||
    value.originalSurfacePresent !== true ||
    value.disabledBeforeAdapterInitialization !== true ||
    value.requiredDelegationSurfacesIntact !== true ||
    typeof value.adapterInitialized !== "boolean" ||
    value.adapterInitialized !== (value.phase === "after-adapter")
  )
    return err(failure("CaptureMalformed", "rollback shim capture is invalid"));
  return ok({
    schemaVersion: 1,
    kind: "rollback-shim",
    role: value.role,
    phase: value.phase,
    boundary: ROLLBACK_SHIM_BOUNDARY,
    disabledSurface: ROLLBACK_DISABLED_SURFACE,
    originalSurfacePresent: true,
    disabledBeforeAdapterInitialization: true,
    requiredDelegationSurfacesIntact: true,
    adapterInitialized: value.adapterInitialized,
  });
}

export async function readCaptureSnapshots(
  captureDirectory: string,
): Promise<Result<RawFixtureCaptures, SmokeFailure>> {
  const files: string[] = [];
  for await (const entry of new Bun.Glob("*.json").scan({
    cwd: captureDirectory,
    absolute: true,
  })) {
    files.push(entry);
    if (files.length > 8)
      return err(failure("CaptureMalformed", "capture file bound exceeded"));
  }
  const providers: FixtureProviderCapture[] = [];
  const controls: FixtureControlFacts[] = [];
  const shims: FixtureShimFacts[] = [];
  for (const file of files) {
    const parsed = await ResultAsync.fromThrowable(
      () => Bun.file(file).json() as Promise<unknown>,
      () => failure("CaptureMalformed", "fixture capture could not be read"),
    )();
    if (parsed.isErr()) return err(parsed.error);
    if (!isRecord(parsed.value))
      return err(
        failure("CaptureMalformed", "fixture capture is not an object"),
      );
    if (parsed.value.kind === "provider") {
      const provider = parseProviderCapture(parsed.value);
      if (provider.isErr()) return err(provider.error);
      providers.push(provider.value);
    } else if (parsed.value.kind === "control") {
      const control = parseControlCapture(parsed.value);
      if (control.isErr()) return err(control.error);
      controls.push(control.value);
    } else if (parsed.value.kind === "rollback-shim") {
      const shim = parseRollbackShimCapture(parsed.value);
      if (shim.isErr()) return err(shim.error);
      shims.push(shim.value);
    } else {
      return err(failure("CaptureMalformed", "unknown fixture capture kind"));
    }
  }
  return ok({ providers, controls, shims });
}
