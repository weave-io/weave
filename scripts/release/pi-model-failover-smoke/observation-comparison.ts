import type {
  FixtureHistoryDescriptor,
  FixtureHistoryFacts,
  FixtureMessageDescriptor,
  FixtureMessageFacts,
  SafeModelIdentity,
} from "./contract.js";
export function sameDescriptor(
  left: FixtureMessageDescriptor,
  right: FixtureMessageDescriptor,
  includeOrdinal = true,
): boolean {
  return (
    (!includeOrdinal || left.ordinal === right.ordinal) &&
    left.roleHash === right.roleHash &&
    left.customTypeHash === right.customTypeHash &&
    left.contentShapeHash === right.contentShapeHash &&
    left.contentFingerprintHash === right.contentFingerprintHash &&
    left.contentBlockCount === right.contentBlockCount &&
    left.toolCallCount === right.toolCallCount &&
    left.toolResultCount === right.toolResultCount &&
    left.correlationHash === right.correlationHash
  );
}

export function sameHistoryDescriptor(
  left: FixtureHistoryDescriptor,
  right: FixtureHistoryDescriptor,
): boolean {
  return (
    sameDescriptor(left, right) &&
    left.entryIndex === right.entryIndex &&
    left.entryTypeHash === right.entryTypeHash
  );
}

/** Provider conversion may normalize metadata, but not context structure. */
export function sameContextDescriptor(
  left: FixtureMessageDescriptor,
  right: FixtureMessageDescriptor,
): boolean {
  return (
    left.roleHash === right.roleHash &&
    left.customTypeHash === right.customTypeHash &&
    left.contentShapeHash === right.contentShapeHash &&
    left.contentBlockCount === right.contentBlockCount &&
    left.toolCallCount === right.toolCallCount &&
    left.toolResultCount === right.toolResultCount &&
    left.correlationHash === right.correlationHash
  );
}

export function sameMessageFacts(
  left: FixtureMessageFacts,
  right: FixtureMessageFacts | undefined,
): boolean {
  return (
    right !== undefined &&
    left.requestNumber === right.requestNumber &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.messageCount === right.messageCount &&
    left.contextHash === right.contextHash &&
    left.descriptorCount === right.descriptorCount &&
    left.userCount === right.userCount &&
    left.assistantCount === right.assistantCount &&
    left.toolResultCount === right.toolResultCount &&
    left.customCount === right.customCount &&
    left.descriptors.length === right.descriptors.length &&
    left.descriptors.every((descriptor, index) =>
      sameDescriptor(
        descriptor,
        right.descriptors[index] as FixtureMessageDescriptor,
      ),
    ) &&
    left.originalUserPresent === right.originalUserPresent &&
    left.taskPresent === right.taskPresent &&
    left.toolCallPresent === right.toolCallPresent &&
    left.toolResultPresent === right.toolResultPresent &&
    left.failedAssistantPresent === right.failedAssistantPresent &&
    left.recoveryMarkerPresent === right.recoveryMarkerPresent &&
    left.syntheticProviderUserMessagePresent ===
      right.syntheticProviderUserMessagePresent
  );
}

export function sameHistoryFacts(
  left: FixtureHistoryFacts,
  right: FixtureHistoryFacts | undefined,
): boolean {
  return (
    right !== undefined &&
    left.entryCount === right.entryCount &&
    left.historyHash === right.historyHash &&
    left.descriptorCount === right.descriptorCount &&
    left.userCount === right.userCount &&
    left.assistantCount === right.assistantCount &&
    left.toolResultCount === right.toolResultCount &&
    left.customCount === right.customCount &&
    left.descriptors.length === right.descriptors.length &&
    left.descriptors.every((descriptor, index) =>
      sameHistoryDescriptor(
        descriptor,
        right.descriptors[index] as FixtureHistoryDescriptor,
      ),
    ) &&
    left.failedAssistantPresent === right.failedAssistantPresent &&
    left.recoveryMarkerPresent === right.recoveryMarkerPresent &&
    left.successfulAssistantPresent === right.successfulAssistantPresent &&
    left.recoveryEntryPresent === right.recoveryEntryPresent &&
    left.markerTokenHash === right.markerTokenHash &&
    left.markerTokenValid === right.markerTokenValid &&
    JSON.stringify(left.markerCorrelation) ===
      JSON.stringify(right.markerCorrelation)
  );
}

export function sameIdentity(
  left: SafeModelIdentity | undefined,
  right: SafeModelIdentity | undefined,
): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

export function sameNumberArray(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
