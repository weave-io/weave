import { join, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  artifactDigest,
  boundText,
  CHILD_TASK,
  CHILD_TOOL_CALL_ID,
  type CleanupResourceTracker,
  descriptorCounts,
  FALLBACK_SUCCESS,
  type FixtureContextFact,
  type FixtureHistoryDescriptor,
  type FixtureHistoryFacts,
  type FixtureSnapshot,
  FOLLOW_UP_USER,
  FOLLOW_UP_USER_ID,
  failure,
  fixtureCorrelationHash,
  fixtureCustomTypeHash,
  fixtureEntryTypeHash,
  fixtureMarkerTokenHash,
  fixtureRoleHash,
  hashDescriptorPart,
  isRecord,
  MAX_CAPTURE_BYTES,
  MAX_HISTORY_DESCRIPTOR_COUNT,
  NATIVE_RECOVERY_ENTRY_TYPE,
  NATIVE_RECOVERY_MARKER_TYPE,
  type NativeSessionObservation,
  ORIGINAL_TASK_ID,
  ORIGINAL_USER,
  ORIGINAL_USER_ID,
  PARENT_TASK,
  PARENT_TOOL_CALL_ID,
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
  PI_NATIVE_THREAD_ENTRY_TYPE,
  QUEUED_USER,
  QUEUED_USER_ID,
  RECOVERY_MARKER,
  ROLLBACK_DISABLED_SURFACE,
  ROLLBACK_TASK,
  type SafeModelIdentity,
  type ScenarioPaths,
  type SmokeFailure,
  STEERING_USER,
  STEERING_USER_ID,
  UNRELATED_CUSTOM_TYPE,
  UUID_V4,
} from "./contract.js";
import { sameHistoryFacts, sameIdentity } from "./observation-comparison.js";
import {
  boundedTimestamp,
  descriptorFactsFromDescriptors,
  type RawFixtureCaptures,
} from "./provider-observation.js";

const MAX_NATIVE_SESSION_BYTES = MAX_CAPTURE_BYTES * 32;
const MAX_NATIVE_SESSION_FILES = 8;

async function directoryExists(
  path: string,
  resources?: CleanupResourceTracker,
): Promise<Result<boolean, SmokeFailure>> {
  const result = await runBoundedCommand(["test", "-d", path], {
    cwd: resolve("."),
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 2_000,
    resources,
    processKind: "helper",
    allowExitCodes: [1],
  });
  if (result.isErr())
    return err(
      failure("CaptureMalformed", "native session root could not be inspected"),
    );
  return ok(result.value.code === 0);
}

function parseNativeTimestamp(value: unknown): number | undefined {
  if (boundedTimestamp(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function nativeEntryValue(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return record.type === "message" && isRecord(record.message)
    ? record.message
    : record;
}

function nativeText(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  let text = "";
  for (const item of values.slice(0, 64)) {
    if (typeof item === "string") text += item;
    else if (isRecord(item) && typeof item.text === "string") text += item.text;
  }
  return boundText(text, 4_096);
}

function nativeShape(value: unknown, depth = 0): unknown {
  if (depth > 5) return "depth";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: Math.min(value.length, 256),
      items: value.slice(0, 16).map((item) => nativeShape(item, depth + 1)),
    };
  }
  if (!isRecord(value)) return typeof value;
  return {
    kind: "object",
    keys: Object.keys(value)
      .sort()
      .slice(0, 64)
      .map((key) => [key, nativeShape(value[key], depth + 1)]),
  };
}

function classifyNativeFact(
  entry: Record<string, unknown>,
  role: string,
  toolCallCount: number,
): FixtureContextFact | undefined {
  const contentText = nativeText(entry.content);
  const contentBlocks = Array.isArray(entry.content)
    ? entry.content
    : [entry.content];
  const fixtureToolCall = contentBlocks.some(
    (block) =>
      isRecord(block) &&
      block.type === "toolCall" &&
      (block.id === PARENT_TOOL_CALL_ID || block.id === CHILD_TOOL_CALL_ID),
  );
  if (role === "user") {
    // Custom messages become provider user messages in Pi's conversion.
    if (contentText.includes(UNRELATED_CUSTOM_TYPE)) return "unrelated-custom";
    if (
      contentText.includes(PARENT_TASK) ||
      contentText.includes(ROLLBACK_TASK) ||
      contentText.includes(CHILD_TASK) ||
      entry.id === ORIGINAL_TASK_ID
    )
      return "original-task-user";
    if (contentText.includes(ORIGINAL_USER) || entry.id === ORIGINAL_USER_ID)
      return "original-user";
    if (contentText.includes(STEERING_USER) || entry.id === STEERING_USER_ID)
      return "steering-user";
    if (contentText.includes(FOLLOW_UP_USER) || entry.id === FOLLOW_UP_USER_ID)
      return "follow-up-user";
    if (contentText.includes(QUEUED_USER) || entry.id === QUEUED_USER_ID)
      return "queued-user";
    return undefined;
  }
  if (role === "assistant") {
    if (entry.stopReason === "error") return "failed-assistant";
    if (toolCallCount > 0 && fixtureToolCall) return "tool-call";
    if (contentText.includes(FALLBACK_SUCCESS)) return "successful-assistant";
    return undefined;
  }
  if (
    role === "toolResult" &&
    (entry.toolCallId === PARENT_TOOL_CALL_ID ||
      entry.toolCallId === CHILD_TOOL_CALL_ID)
  )
    return "tool-result";
  if (
    role === "custom" &&
    typeof entry.customType === "string" &&
    entry.customType === UNRELATED_CUSTOM_TYPE
  ) {
    return "unrelated-custom";
  }
  return undefined;
}

function describeNativeEntry(
  record: Record<string, unknown>,
  ordinal: number,
  entryIndex: number,
): FixtureHistoryDescriptor | undefined {
  const recordType = record.type;
  if (
    recordType !== "message" &&
    recordType !== "custom_message" &&
    recordType !== "custom"
  ) {
    return undefined;
  }
  if (
    recordType === "custom" &&
    (record.customType === NATIVE_RECOVERY_ENTRY_TYPE ||
      record.customType === PI_NATIVE_THREAD_ENTRY_TYPE ||
      record.customType === PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE ||
      record.customType === PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE)
  ) {
    // These entries persist recovery, thread identity, or child result
    // bookkeeping. They are not transcript context and must not shift the
    // identity-aware descriptor sequence.
    return undefined;
  }
  const entry = nativeEntryValue(record);
  let role: string;
  if (typeof entry.role === "string") {
    role = entry.role;
  } else {
    role = recordType === "message" ? "unknown" : "custom";
  }
  const content = entry.content;
  let blocks: readonly unknown[];
  if (Array.isArray(content)) {
    blocks = content;
  } else if (content === undefined) {
    blocks = [];
  } else {
    blocks = [content];
  }
  const toolCallCount = blocks.filter(
    (block) => isRecord(block) && block.type === "toolCall",
  ).length;
  const toolResultCount = role === "toolResult" ? 1 : 0;
  const customType =
    typeof entry.customType === "string" ? entry.customType : undefined;
  const markerDetails = isRecord(entry.details) ? entry.details : undefined;
  const markerToken =
    (customType === NATIVE_RECOVERY_MARKER_TYPE ||
      customType === RECOVERY_MARKER) &&
    typeof markerDetails?.token === "string"
      ? markerDetails.token
      : undefined;
  const fact = classifyNativeFact(entry, role, toolCallCount);
  const serialized = Result.fromThrowable(
    () => JSON.stringify(entry),
    () => "",
  )().match(
    (value) => value,
    () => "",
  );
  const shape = Result.fromThrowable(
    () =>
      JSON.stringify({
        content: nativeShape(
          typeof content === "string"
            ? [{ type: "text", text: content }]
            : content,
        ),
        stopReason: entry.stopReason,
        toolCallCount,
        toolResultCount,
      }),
    () => "",
  )().match(
    (value) => value,
    () => "",
  );
  let correlationHash: string | undefined;
  if (markerToken !== undefined) {
    correlationHash = fixtureMarkerTokenHash(markerToken);
  } else if (fact !== undefined) {
    correlationHash = fixtureCorrelationHash(fact);
  }
  const entryType = recordType === "message" ? "message" : recordType;
  return {
    ordinal,
    entryIndex,
    entryTypeHash: fixtureEntryTypeHash(entryType),
    roleHash: fixtureRoleHash(
      role === "user" ||
        role === "assistant" ||
        role === "toolResult" ||
        role === "custom"
        ? role
        : "custom",
    ),
    ...(customType === undefined
      ? {}
      : { customTypeHash: fixtureCustomTypeHash(customType) }),
    contentShapeHash: hashDescriptorPart("fixture-shape", shape),
    contentFingerprintHash: hashDescriptorPart(
      "fixture-fingerprint",
      serialized,
    ),
    contentBlockCount: Math.min(blocks.length, 256),
    toolCallCount: Math.min(toolCallCount, 256),
    toolResultCount,
    ...(correlationHash === undefined ? {} : { correlationHash }),
  };
}

export async function readNativeSessionSnapshots(
  paths: ScenarioPaths,
  resources?: CleanupResourceTracker,
): Promise<Result<readonly NativeSessionObservation[], SmokeFailure>> {
  const roots = [
    { role: "parent" as const, root: join(paths.piHome, "sessions") },
    {
      role: "child" as const,
      root: join(paths.dataHome, "weave", "adapters", "pi", "sessions"),
    },
  ];
  const observations: NativeSessionObservation[] = [];
  for (const { role, root } of roots) {
    const exists = await directoryExists(root, resources);
    if (exists.isErr()) return err(exists.error);
    if (!exists.value) continue;
    const files: string[] = [];
    for await (const file of new Bun.Glob("**/*.jsonl").scan({
      cwd: root,
      absolute: true,
    })) {
      files.push(file);
      if (files.length > MAX_NATIVE_SESSION_FILES) {
        return err(
          failure("CaptureMalformed", "native session file bound exceeded"),
        );
      }
    }
    for (const file of files) {
      const bytes = await ResultAsync.fromThrowable(
        () => Bun.file(file).bytes(),
        () => failure("CaptureMalformed", "native session could not be read"),
      )();
      if (bytes.isErr()) return err(bytes.error);
      if (bytes.value.byteLength > MAX_NATIVE_SESSION_BYTES) {
        return err(
          failure(
            "CaptureMalformed",
            "native session exceeds the bounded read",
          ),
        );
      }
      const body = new TextDecoder().decode(bytes.value);
      const records: Record<string, unknown>[] = [];
      for (const line of body.split(/\r?\n/u)) {
        if (line.trim().length === 0) continue;
        const parsed = Result.fromThrowable(
          () => JSON.parse(line) as unknown,
          () =>
            failure("CaptureMalformed", "native session contains invalid JSON"),
        )();
        if (parsed.isErr() || !isRecord(parsed.value)) {
          return err(
            parsed.isErr()
              ? parsed.error
              : failure(
                  "CaptureMalformed",
                  "native session entry is not an object",
                ),
          );
        }
        records.push(parsed.value);
      }
      const header = records[0];
      if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        header.id.length === 0
      ) {
        return err(
          failure("CaptureMalformed", "native session header is invalid"),
        );
      }
      const entries = records.slice(1);
      if (entries.length > MAX_HISTORY_DESCRIPTOR_COUNT) {
        return err(
          failure("CaptureMalformed", "native history entry bound exceeded"),
        );
      }
      const threadIds = entries.flatMap((entry) => {
        if (entry.customType !== PI_NATIVE_THREAD_ENTRY_TYPE) return [];
        const data = isRecord(entry.data) ? entry.data : undefined;
        return typeof data?.threadId === "string" && data.threadId.length > 0
          ? [data.threadId]
          : [];
      });
      const distinctThreadIds = [...new Set(threadIds)];
      if (distinctThreadIds.length > 1) {
        return err(
          failure(
            "CaptureMalformed",
            "native thread identity sources disagree",
          ),
        );
      }
      const threadId = distinctThreadIds[0];
      const descriptors: FixtureHistoryDescriptor[] = [];
      for (const [entryOffset, entry] of entries.entries()) {
        const descriptor = describeNativeEntry(
          entry,
          descriptors.length,
          entryOffset + 1,
        );
        if (descriptor === undefined) continue;
        descriptors.push(descriptor);
        if (descriptors.length > MAX_HISTORY_DESCRIPTOR_COUNT) {
          return err(
            failure("CaptureMalformed", "native descriptor bound exceeded"),
          );
        }
      }
      const markerEntries = entries
        .map((entry, index) => ({ entry, index: index + 1 }))
        .filter(
          ({ entry }) =>
            entry.type === "custom_message" &&
            (entry.customType === NATIVE_RECOVERY_MARKER_TYPE ||
              entry.customType === RECOVERY_MARKER),
        );
      const markerEntry = markerEntries[0]?.entry;
      const markerDescriptor = descriptors.find(
        (descriptor) =>
          descriptor.customTypeHash ===
            fixtureCustomTypeHash(NATIVE_RECOVERY_MARKER_TYPE) &&
          markerEntries.some(({ index }) => descriptor.entryIndex === index),
      );
      const markerDescriptorPosition =
        markerDescriptor === undefined
          ? -1
          : descriptors.indexOf(markerDescriptor);
      // Pi appends a model_change record when setModel applies the fallback.
      // Adjacency is therefore proven among context-bearing descriptors, not
      // by pretending that metadata records are messages. Any real context
      // entry between the failed assistant and marker would break this exact
      // descriptor predecessor relation.
      const failedAssistantDescriptor =
        markerDescriptorPosition <= 0
          ? undefined
          : descriptors[markerDescriptorPosition - 1];
      const markerValue =
        markerEntry === undefined ? undefined : nativeEntryValue(markerEntry);
      const markerDetails = isRecord(markerValue?.details)
        ? markerValue.details
        : undefined;
      const markerToken =
        typeof markerDetails?.token === "string"
          ? markerDetails.token
          : undefined;
      const interveningNativeEntryCount =
        markerDescriptor === undefined ||
        failedAssistantDescriptor === undefined
          ? undefined
          : markerDescriptor.entryIndex -
            failedAssistantDescriptor.entryIndex -
            1;
      const markerCorrelation =
        markerEntries.length === 1 &&
        markerDescriptorPosition > 0 &&
        markerDescriptor !== undefined &&
        failedAssistantDescriptor?.correlationHash ===
          fixtureCorrelationHash("failed-assistant") &&
        interveningNativeEntryCount !== undefined &&
        interveningNativeEntryCount >= 0 &&
        markerToken !== undefined
          ? {
              failedAssistantOrdinal: failedAssistantDescriptor.ordinal,
              markerOrdinal: markerDescriptor.ordinal,
              failedAssistantEntryIndex: failedAssistantDescriptor.entryIndex,
              markerEntryIndex: markerDescriptor.entryIndex,
              interveningNativeEntryCount,
              failedAssistantFingerprintHash:
                failedAssistantDescriptor.contentFingerprintHash,
              markerTokenHash: fixtureMarkerTokenHash(markerToken),
            }
          : undefined;
      const counts = descriptorCounts(descriptors);
      const facts = descriptorFactsFromDescriptors(descriptors);
      const history: FixtureHistoryFacts = {
        entryCount: entries.length,
        historyHash: artifactDigest(bytes.value),
        descriptors,
        ...counts,
        ...facts,
        successfulAssistantPresent: descriptors.some(
          (descriptor) =>
            descriptor.correlationHash ===
            fixtureCorrelationHash("successful-assistant"),
        ),
        recoveryEntryPresent: entries.some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === NATIVE_RECOVERY_ENTRY_TYPE,
        ),
        ...(markerToken === undefined
          ? {}
          : {
              markerTokenHash: fixtureMarkerTokenHash(markerToken),
              markerTokenValid: UUID_V4.test(markerToken),
            }),
        ...(markerCorrelation === undefined ? {} : { markerCorrelation }),
      };
      const modelChanges = entries.filter(
        (entry) => entry.type === "model_change",
      );
      const modelTransitionTimesMs: number[] = [];
      const modelTransitionIdentities: SafeModelIdentity[] = [];
      for (const modelChange of modelChanges) {
        const timestamp = parseNativeTimestamp(modelChange.timestamp);
        if (timestamp === undefined) {
          return err(
            failure(
              "CaptureMalformed",
              "native model transition timestamp is missing",
            ),
          );
        }
        if (
          typeof modelChange.provider !== "string" ||
          typeof modelChange.modelId !== "string" ||
          modelChange.provider.length > 64 ||
          modelChange.modelId.length > 128
        ) {
          return err(
            failure(
              "CaptureMalformed",
              "native model transition identity is malformed",
            ),
          );
        }
        modelTransitionTimesMs.push(timestamp);
        modelTransitionIdentities.push({
          provider: modelChange.provider,
          id: modelChange.modelId,
        });
      }
      const appliedIdentity = modelTransitionIdentities.at(-1);
      observations.push({
        role,
        sessionIdHash: artifactDigest(new TextEncoder().encode(header.id)),
        ...(threadId === undefined
          ? {}
          : {
              threadIdHash: artifactDigest(new TextEncoder().encode(threadId)),
            }),
        history,
        modelTransitions: modelChanges.length,
        modelTransitionTimesMs,
        modelTransitionIdentities,
        recoveryMarkerCount: markerEntries.length,
        ...(appliedIdentity === undefined ? {} : { appliedIdentity }),
      });
    }
  }
  return ok(observations);
}

/**
 * Compare the facts from two independent native-session reads before keeping
 * either read. This closes the time-of-check/time-of-use gap around durable
 * history and model-transition evidence.
 */
function sameNativeSessionFacts(
  left: NativeSessionObservation,
  right: NativeSessionObservation,
): boolean {
  return (
    left.role === right.role &&
    left.sessionIdHash === right.sessionIdHash &&
    left.threadIdHash === right.threadIdHash &&
    sameHistoryFacts(left.history, right.history) &&
    left.modelTransitions === right.modelTransitions &&
    left.modelTransitionTimesMs.length ===
      right.modelTransitionTimesMs.length &&
    left.modelTransitionTimesMs.every(
      (timestamp, index) => timestamp === right.modelTransitionTimesMs[index],
    ) &&
    left.modelTransitionIdentities.length ===
      right.modelTransitionIdentities.length &&
    left.modelTransitionIdentities.every((identity, index) =>
      sameIdentity(identity, right.modelTransitionIdentities[index]),
    ) &&
    left.recoveryMarkerCount === right.recoveryMarkerCount &&
    sameIdentity(left.appliedIdentity, right.appliedIdentity)
  );
}

/**
 * Bind two separate bounded reads of the native session source. Neither side
 * may be filled from the other or from a child-control identity.
 */
export function mergeNativeSessionObservations(
  before: readonly NativeSessionObservation[],
  after: readonly NativeSessionObservation[],
): Result<readonly NativeSessionObservation[], SmokeFailure> {
  const roles = new Set([
    ...before.map((entry) => entry.role),
    ...after.map((entry) => entry.role),
  ]);
  const merged: NativeSessionObservation[] = [];
  for (const role of roles) {
    const beforeMatches = before.filter((entry) => entry.role === role);
    const afterMatches = after.filter((entry) => entry.role === role);
    if (beforeMatches.length !== 1 || afterMatches.length !== 1) {
      return err(
        failure(
          "CaptureMalformed",
          `native ${role} identity observation is missing or duplicated`,
        ),
      );
    }
    const beforeEntry = beforeMatches[0];
    const afterEntry = afterMatches[0];
    if (!sameNativeSessionFacts(beforeEntry, afterEntry)) {
      return err(
        failure("CaptureMalformed", `native ${role} bounded reads disagree`),
      );
    }
    const beforeThread = beforeEntry.threadIdHash;
    const afterThread = afterEntry.threadIdHash;
    if ((beforeThread === undefined) !== (afterThread === undefined)) {
      return err(
        failure(
          "CaptureMalformed",
          `native ${role} thread identity observation is incomplete`,
        ),
      );
    }
    merged.push({
      ...afterEntry,
      sessionIdBeforeHash: beforeEntry.sessionIdHash,
      sessionIdAfterHash: afterEntry.sessionIdHash,
      ...(beforeThread === undefined || afterThread === undefined
        ? {}
        : { threadIdBeforeHash: beforeThread, threadIdAfterHash: afterThread }),
    });
  }
  return ok(merged);
}

export function assembleSnapshots(
  captures: RawFixtureCaptures,
  nativeSessions: readonly NativeSessionObservation[],
): Result<readonly FixtureSnapshot[], SmokeFailure> {
  const roles = ["parent", "child"] as const;
  const snapshots: FixtureSnapshot[] = [];
  for (const role of roles) {
    const providers = captures.providers.filter(
      (capture) => capture.role === role,
    );
    const controls = captures.controls.filter(
      (capture) => capture.role === role,
    );
    const natives = nativeSessions.filter((session) => session.role === role);
    if (providers.length === 0 && controls.length === 0 && natives.length === 0)
      continue;
    if (
      providers.length !== 1 ||
      controls.length !== 1 ||
      natives.length !== 1
    ) {
      return err(
        failure(
          "CaptureMalformed",
          `${role} observation is missing or duplicated`,
        ),
      );
    }
    const provider = providers[0];
    const control = controls[0];
    const native = natives[0];
    const controlIdentity = control.lifecycle.appliedIdentity;
    const nativeIdentity = native.appliedIdentity;
    if (
      controlIdentity !== undefined &&
      nativeIdentity !== undefined &&
      !sameIdentity(controlIdentity, nativeIdentity)
    ) {
      return err(
        failure("CaptureMalformed", `${role} model identities disagree`),
      );
    }
    const identity = controlIdentity ?? nativeIdentity;
    snapshots.push({
      schemaVersion: 1,
      role,
      processIdHash: control.processIdHash,
      ...(control.processIdBeforeHash === undefined
        ? {}
        : { processIdBeforeHash: control.processIdBeforeHash }),
      ...(control.processIdAfterHash === undefined
        ? {}
        : { processIdAfterHash: control.processIdAfterHash }),
      ...(native.sessionIdHash === undefined
        ? {}
        : { sessionIdHash: native.sessionIdHash }),
      ...(native.sessionIdBeforeHash === undefined
        ? {}
        : { sessionIdBeforeHash: native.sessionIdBeforeHash }),
      ...(native.sessionIdAfterHash === undefined
        ? {}
        : { sessionIdAfterHash: native.sessionIdAfterHash }),
      ...(native.threadIdHash === undefined
        ? {}
        : { threadIdHash: native.threadIdHash }),
      ...(native.threadIdBeforeHash === undefined
        ? {}
        : { threadIdBeforeHash: native.threadIdBeforeHash }),
      ...(native.threadIdAfterHash === undefined
        ? {}
        : { threadIdAfterHash: native.threadIdAfterHash }),
      ...(control.childIdHash === undefined
        ? {}
        : { childIdHash: control.childIdHash }),
      ...(control.childIdBeforeHash === undefined
        ? {}
        : { childIdBeforeHash: control.childIdBeforeHash }),
      ...(control.childIdAfterHash === undefined
        ? {}
        : { childIdAfterHash: control.childIdAfterHash }),
      ...(control.markerTokenHash === undefined
        ? {}
        : { markerTokenHash: control.markerTokenHash }),
      ...(control.failedAssistantFingerprintHash === undefined
        ? {}
        : {
            failedAssistantFingerprintHash:
              control.failedAssistantFingerprintHash,
          }),
      ...(control.failedAssistantShapeHash === undefined
        ? {}
        : { failedAssistantShapeHash: control.failedAssistantShapeHash }),
      requestCount: provider.requestCount,
      requests: provider.requests,
      history: native.history,
      lifecycle:
        identity === undefined
          ? control.lifecycle
          : { ...control.lifecycle, appliedIdentity: identity },
      ...(control.parentToolCallIdHash === undefined
        ? {}
        : { parentToolCallIdHash: control.parentToolCallIdHash }),
      ...(control.parentToolEndCallIdHash === undefined
        ? {}
        : { parentToolEndCallIdHash: control.parentToolEndCallIdHash }),
      ...(control.parentToolStartedAtMs === undefined
        ? {}
        : { parentToolStartedAtMs: control.parentToolStartedAtMs }),
      ...(control.parentToolEndedAtMs === undefined
        ? {}
        : { parentToolEndedAtMs: control.parentToolEndedAtMs }),
      ...(control.parentToolPendingMs === undefined
        ? {}
        : { parentToolPendingMs: control.parentToolPendingMs }),
      ...(control.parentToolStartCount === undefined
        ? {}
        : { parentToolStartCount: control.parentToolStartCount }),
      ...(control.parentToolEndCount === undefined
        ? {}
        : { parentToolEndCount: control.parentToolEndCount }),
      ...(control.parentToolStartTimesMs === undefined
        ? {}
        : { parentToolStartTimesMs: control.parentToolStartTimesMs }),
      ...(control.parentToolEndTimesMs === undefined
        ? {}
        : { parentToolEndTimesMs: control.parentToolEndTimesMs }),
      ...(captures.shims.some(
        (shim) =>
          shim.role === role &&
          shim.disabledSurface === ROLLBACK_DISABLED_SURFACE &&
          shim.disabledBeforeAdapterInitialization,
      )
        ? { optionalSurfaceDisabled: true }
        : {}),
      ...(control.lifecycle.settlementCount === 1
        ? { legacySettlement: true }
        : {}),
    });
  }
  return ok(snapshots);
}
