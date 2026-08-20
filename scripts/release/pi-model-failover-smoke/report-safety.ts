import { err, ok, Result } from "neverthrow";
import {
  CHECKLIST_VERSION,
  CHILD_TASK,
  containsForbiddenContent,
  EXACT_PI_VERSION,
  EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT,
  EXPECTED_NATIVE_LINE,
  FALLBACK_SUCCESS,
  FOLLOW_UP_USER,
  failure,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_CONTEXT_DESCRIPTOR_COUNT,
  MAX_DIAGNOSTIC_COUNT,
  MAX_HISTORY_DESCRIPTOR_COUNT,
  MAX_REPORT_ARRAY_LENGTH,
  MAX_REPORT_INTEGER,
  MAX_REPORT_OBJECT_KEYS,
  MAX_REPORT_STRING_LENGTH,
  MAX_REPORT_TIMESTAMP_MS,
  NATIVE_RECOVERY_ENTRY_TYPE,
  NATIVE_RECOVERY_MARKER_TYPE,
  ORIGINAL_USER,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PARENT_TASK,
  PROVIDER_FAILURE_MARKER,
  QUEUED_USER,
  RECOVERY_MARKER,
  REPORT_DIAGNOSTIC_CODES,
  ROLLBACK_TASK,
  SHA256,
  type SmokeFailure,
  STEERING_USER,
  UNRELATED_CUSTOM_TYPE,
  UUID_V4,
  UUID_V4_OCCURRENCE,
} from "./contract.js";
export const DEFAULT_REPORT_FORBIDDEN_CONTENT = [
  PROVIDER_FAILURE_MARKER,
  RECOVERY_MARKER,
  PARENT_TASK,
  ROLLBACK_TASK,
  CHILD_TASK,
  FALLBACK_SUCCESS,
  ORIGINAL_USER,
  STEERING_USER,
  FOLLOW_UP_USER,
  QUEUED_USER,
  UNRELATED_CUSTOM_TYPE,
  NATIVE_RECOVERY_MARKER_TYPE,
  NATIVE_RECOVERY_ENTRY_TYPE,
  "provider unavailable",
  "pi-model-fallback-fixture-key",
] as const;

const REPORT_SAFE_KEYS = new Set([
  "schemaVersion",
  "checklistVersion",
  "artifact",
  "packageName",
  "packageVersion",
  "sha256",
  "provenance",
  "artifactUnchanged",
  "installedPackageVersion",
  "installedExtensionSha256",
  "loadedAdapterPackageVersion",
  "loadedAdapterExtensionSha256",
  "packageSourceProven",
  "packageRootMatched",
  "loadedExtensionHashMatched",
  "piPackageVersion",
  "pi",
  "expectedVersion",
  "observedVersion",
  "fallback",
  "rollback",
  "diagnostics",
  "outcome",
  "processIdentityStable",
  "nativeSessionIdentityStable",
  "threadIdentityStable",
  "parentToolCallIdentityStable",
  "providerRequest",
  "durableHistory",
  "lifecycle",
  "visibleEventCount",
  "cardAppliedIdentity",
  "nativeLine",
  "parentPendingIntervalMs",
  "parentSettlementCount",
  "cleanup",
  "noChildProcess",
  "noNativeChild",
  "noActiveLease",
  "noTemporaryPane",
  "noFixtureProcess",
  "noPiProcess",
  "noHelperProcess",
  "temporaryRootRemoved",
  "timersDisposed",
  "resourcesDisposed",
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
  "ordinal",
  "roleHash",
  "customTypeHash",
  "contentShapeHash",
  "contentFingerprintHash",
  "contentBlockCount",
  "toolCallCount",
  "toolResultCount",
  "correlationHash",
  "entryCount",
  "historyHash",
  "successfulAssistantPresent",
  "recoveryEntryPresent",
  "markerTokenHash",
  "markerTokenValid",
  "markerCorrelation",
  "failedAssistantOrdinal",
  "markerOrdinal",
  "failedAssistantEntryIndex",
  "markerEntryIndex",
  "interveningNativeEntryCount",
  "failedAssistantFingerprintHash",
  "entryIndex",
  "entryTypeHash",
  "beforeAgentStartCount",
  "messageStartCount",
  "messageEndCount",
  "contextCount",
  "contextRepairCount",
  "contextRepairTimesMs",
  "modelSelectCount",
  "modelSelectTimesMs",
  "settlementCount",
  "settlementTimesMs",
  "markerMessageStartCount",
  "markerMessageStartTimesMs",
  "recoveryMarkerCount",
  "recoveryMarkerObserved",
  "appliedIdentity",
  "id",
  "optionalSurfaceDisabled",
  "healthReady",
  "healthOnly",
  "legacySettlementCount",
  "fallbackAttempted",
]);

const REPORT_FORBIDDEN_KEY_PATTERN =
  /(?:api[-_ ]?key|assistant|body|command|content|control|credential|details|error|home|message|output|path|payload|password|request|secret|text|token|tool|type|user)/iu;
const REPORT_FORBIDDEN_TEXT_PATTERNS = [
  /PI_MODEL_FAILOVER_SMOKE/iu,
  /pi-model-fallback-fixture-key/iu,
  /(?:api[-_ ]?key|secret|token|password|credential|authorization|bearer)/iu,
  /(?:^|[\\/])(?:private[\\/])?(?:tmp|Users|home|var|Volumes)(?:[\\/]|$)/u,
  /^[A-Za-z]:[\\/]/u,
  /\.(?:tgz|tar\.gz)$/iu,
  /(?:provider|raw[-_ ]?provider)[-_ ]?(?:request|body|error|response|output)/iu,
  /(?:assistant|user|tool)[-_ ]?(?:text|content|message|output|request|body)/iu,
  /"(?:messages?|content|body|tool(?:Call|Result)?|assistant|user|error(?:Message)?)"\s*:/iu,
  /(?:control|child[-_ ]control)[-_ ]?(?:payload|body|envelope)/iu,
  /(?:rm|kill|chmod|mv)[ ]+-[A-Za-z]/iu,
  /(?:unauthorized|forbidden|rate[- ]limit|service unavailable|connection refused|provider unavailable)/iu,
];

export function reportMalformed(
  detail = "report schema is invalid",
): SmokeFailure {
  return failure("ReportMalformed", detail);
}

export function reportTooLarge(
  detail = "report exceeds a fixed bound",
): SmokeFailure {
  return failure("ReportTooLarge", detail);
}

type ReportDataEntry = readonly [PropertyKey, unknown];

/**
 * Read only data descriptors. This is intentionally separate from JSON.stringify:
 * JSON serialization invokes getters, proxies, and toJSON hooks before it can
 * reject them. The report boundary must not execute untrusted report data.
 */
export function safeReportDataEntries(
  value: object,
): Result<readonly ReportDataEntry[], SmokeFailure> {
  try {
    const descriptorMap = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptorMap);
    const keyLimit = Array.isArray(value)
      ? MAX_REPORT_ARRAY_LENGTH + 1
      : MAX_REPORT_OBJECT_KEYS;
    if (keys.length > keyLimit)
      return err(reportTooLarge("report object has too many keys"));
    const entries: ReportDataEntry[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(descriptorMap, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "object" ||
        descriptor.value === null
      ) {
        return err(reportMalformed());
      }
      const source = descriptor.value as PropertyDescriptor;
      if (
        source.get !== undefined ||
        source.set !== undefined ||
        !("value" in source)
      ) {
        return err(reportMalformed("report contains an accessor"));
      }
      if (!source.enumerable && key !== "length")
        return err(reportMalformed("report contains a non-enumerable key"));
      entries.push([key, source.value]);
    }
    return ok(entries);
  } catch {
    return err(reportMalformed("report descriptor inspection failed"));
  }
}

export function inspectReportGraph(
  report: unknown,
): Result<void, SmokeFailure> {
  const active = new WeakSet<object>();
  let nodeCount = 0;
  const visit = (value: unknown, depth: number): Result<void, SmokeFailure> => {
    if (typeof value === "string") {
      if (value.length > MAX_REPORT_STRING_LENGTH)
        return err(reportTooLarge("report contains an overlong string"));
      return ok(undefined);
    }
    if (value === null || typeof value === "boolean") return ok(undefined);
    if (typeof value === "number") {
      return Number.isFinite(value)
        ? ok(undefined)
        : err(reportMalformed("report contains a non-finite number"));
    }
    if (typeof value !== "object")
      return err(reportMalformed("report contains an unsupported value"));
    if (depth > 12) return err(reportTooLarge("report nesting is too deep"));
    if (active.has(value)) return err(reportMalformed("report is cyclic"));
    nodeCount += 1;
    if (nodeCount > 2_048)
      return err(reportTooLarge("report contains too many values"));
    let prototype: object | null;
    let array = false;
    try {
      prototype = Object.getPrototypeOf(value);
      array = Array.isArray(value);
    } catch {
      return err(reportMalformed("report object inspection failed"));
    }
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype)
    ) {
      return err(reportMalformed("report contains an unsupported object"));
    }
    const entries = safeReportDataEntries(value);
    if (entries.isErr()) return err(entries.error);
    active.add(value);
    if (array) {
      const lengthEntry = entries.value.find(([key]) => key === "length");
      if (lengthEntry === undefined || typeof lengthEntry[1] !== "number") {
        active.delete(value);
        return err(reportMalformed("report array length is invalid"));
      }
      const length = lengthEntry[1];
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_REPORT_ARRAY_LENGTH
      ) {
        active.delete(value);
        return err(reportTooLarge("report array is outside its bound"));
      }
      const indexes = new Set<number>();
      for (const [key, child] of entries.value) {
        if (key === "length") continue;
        if (typeof key !== "string") {
          active.delete(value);
          return err(reportMalformed("report contains a symbol key"));
        }
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key ||
          indexes.has(index)
        ) {
          active.delete(value);
          return err(reportMalformed("report array contains an extra key"));
        }
        indexes.add(index);
        const childResult = visit(child, depth + 1);
        if (childResult.isErr()) {
          active.delete(value);
          return err(childResult.error);
        }
      }
      if (indexes.size !== length) {
        active.delete(value);
        return err(reportMalformed("report array contains a hole"));
      }
      active.delete(value);
      return ok(undefined);
    }
    if (entries.value.length > MAX_REPORT_OBJECT_KEYS) {
      active.delete(value);
      return err(reportTooLarge("report object is outside its bound"));
    }
    for (const [key, child] of entries.value) {
      if (typeof key !== "string") {
        active.delete(value);
        return err(reportMalformed("report contains a symbol key"));
      }
      const childResult = visit(child, depth + 1);
      if (childResult.isErr()) {
        active.delete(value);
        return err(childResult.error);
      }
    }
    active.delete(value);
    return ok(undefined);
  };
  const inspected = visit(report, 0);
  if (inspected.isErr()) return err(inspected.error);
  const cloned = Result.fromThrowable(
    () => structuredClone(report),
    () => reportMalformed("report contains a proxy or unclonable value"),
  )();
  return cloned.isErr() ? err(cloned.error) : ok(undefined);
}

function reportStringHasForbiddenContent(
  value: string,
  forbidden: readonly string[],
): boolean {
  if (containsForbiddenContent(value, forbidden)) return true;
  if (UUID_V4.test(value) || UUID_V4_OCCURRENCE.test(value)) return true;
  return REPORT_FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export function scanReportForForbiddenContent(
  report: unknown,
  forbidden: readonly string[],
): Result<void, SmokeFailure> {
  const active = new WeakSet<object>();
  const scan = (value: unknown): Result<void, SmokeFailure> => {
    if (typeof value === "string") {
      const isDiagnostic = (
        REPORT_DIAGNOSTIC_CODES as readonly string[]
      ).includes(value);
      if (
        containsForbiddenContent(value, forbidden) ||
        (!isDiagnostic && reportStringHasForbiddenContent(value, forbidden))
      )
        return err(
          failure("LeakedContent", "report contains forbidden content"),
        );
      return ok(undefined);
    }
    if (value === null || typeof value !== "object") return ok(undefined);
    if (active.has(value)) return err(reportMalformed("report is cyclic"));
    active.add(value);
    const entries = safeReportDataEntries(value);
    if (entries.isErr()) {
      active.delete(value);
      return err(entries.error);
    }
    for (const [key, child] of entries.value) {
      if (
        typeof key === "string" &&
        (containsForbiddenContent(key, forbidden) ||
          (!REPORT_SAFE_KEYS.has(key) &&
            REPORT_FORBIDDEN_KEY_PATTERN.test(key)))
      ) {
        active.delete(value);
        return err(
          failure("LeakedContent", "report contains forbidden fields"),
        );
      }
      const childResult = scan(child);
      if (childResult.isErr()) {
        active.delete(value);
        return err(childResult.error);
      }
    }
    active.delete(value);
    return ok(undefined);
  };
  return scan(report);
}

function strictReportRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Result<Record<string, unknown>, SmokeFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return err(reportMalformed());
  const entries = safeReportDataEntries(value);
  if (entries.isErr()) return err(entries.error);
  const allowed = new Set([...required, ...optional]);
  const present = new Set<string>();
  for (const [key] of entries.value) {
    if (typeof key !== "string" || !allowed.has(key))
      return err(reportMalformed("report contains an extra key"));
    present.add(key);
  }
  for (const key of required) {
    if (!present.has(key)) return err(reportMalformed("report key is missing"));
  }
  return ok(value as Record<string, unknown>);
}

function reportValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
  } catch {
    return undefined;
  }
}

function reportExact(
  value: unknown,
  expected: string | number | boolean,
): Result<void, SmokeFailure> {
  return value === expected ? ok(undefined) : err(reportMalformed());
}

function reportBoolean(value: unknown): Result<boolean, SmokeFailure> {
  return typeof value === "boolean"
    ? ok(value)
    : err(reportMalformed("report boolean is invalid"));
}

function reportCount(
  value: unknown,
  maximum = MAX_REPORT_INTEGER,
): Result<number, SmokeFailure> {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? ok(value)
    : err(reportMalformed("report count is not a bounded safe integer"));
}

function reportHash(value: unknown): Result<string, SmokeFailure> {
  return typeof value === "string" && SHA256.test(value)
    ? ok(value)
    : err(reportMalformed("report hash is invalid"));
}

const CANONICAL_REPORT_IDENTITY = /^[a-z0-9](?:[a-z0-9._:/-]{0,63})$/u;
const NON_IDENTITY_REPORT_WORD =
  /(?:^|[._:/-])(?:assistant|body|credential|error|forbidden|password|rate|request|secret|timeout|token|tool|unauthorized|unavailable|user)(?:$|[._:/-])/u;
function reportIdentity(value: unknown): Result<string, SmokeFailure> {
  return typeof value === "string" &&
    value.length <= MAX_REPORT_STRING_LENGTH &&
    CANONICAL_REPORT_IDENTITY.test(value) &&
    !NON_IDENTITY_REPORT_WORD.test(value)
    ? ok(value)
    : err(reportMalformed("provider or model identity is invalid"));
}

function reportArray(value: unknown): Result<readonly unknown[], SmokeFailure> {
  if (!Array.isArray(value) || value.length > MAX_REPORT_ARRAY_LENGTH)
    return err(reportMalformed("report array is invalid"));
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor))
      return err(reportMalformed("report array is sparse"));
    values.push(descriptor.value);
  }
  return ok(values);
}

function validateReportIdentity(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, ["provider", "id"]);
  if (record.isErr()) return err(record.error);
  const provider = reportIdentity(reportValue(record.value, "provider"));
  if (provider.isErr()) return err(provider.error);
  const id = reportIdentity(reportValue(record.value, "id"));
  return id.isErr() ? err(id.error) : ok(undefined);
}

function validateReportDescriptor(
  value: unknown,
  history: boolean,
): Result<void, SmokeFailure> {
  const required = [
    "ordinal",
    "roleHash",
    "contentShapeHash",
    "contentFingerprintHash",
    "contentBlockCount",
    "toolCallCount",
    "toolResultCount",
  ];
  const optional = ["customTypeHash", "correlationHash"];
  if (history) required.push("entryIndex", "entryTypeHash");
  const record = strictReportRecord(value, required, optional);
  if (record.isErr()) return err(record.error);
  for (const key of [
    "ordinal",
    "contentBlockCount",
    "toolCallCount",
    "toolResultCount",
    ...(history ? ["entryIndex"] : []),
  ]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  for (const key of [
    "roleHash",
    "contentShapeHash",
    "contentFingerprintHash",
    ...(history ? ["entryTypeHash"] : []),
  ]) {
    const hash = reportHash(reportValue(record.value, key));
    if (hash.isErr()) return err(hash.error);
  }
  for (const key of ["customTypeHash", "correlationHash"]) {
    if (reportValue(record.value, key) !== undefined) {
      const hash = reportHash(reportValue(record.value, key));
      if (hash.isErr()) return err(hash.error);
    }
  }
  return ok(undefined);
}

function validateReportDescriptorArray(
  value: unknown,
  history: boolean,
): Result<void, SmokeFailure> {
  const descriptors = reportArray(value);
  if (descriptors.isErr()) return err(descriptors.error);
  const maximum = history
    ? MAX_HISTORY_DESCRIPTOR_COUNT
    : MAX_CONTEXT_DESCRIPTOR_COUNT;
  if (descriptors.value.length > maximum)
    return err(reportTooLarge("report descriptor count is outside its bound"));
  for (const descriptor of descriptors.value) {
    const result = validateReportDescriptor(descriptor, history);
    if (result.isErr()) return err(result.error);
  }
  return ok(undefined);
}

function validateReportDescriptorCounts(
  record: Record<string, unknown>,
): Result<void, SmokeFailure> {
  for (const key of [
    "descriptorCount",
    "userCount",
    "assistantCount",
    "toolResultCount",
    "customCount",
  ]) {
    const count = reportCount(reportValue(record, key));
    if (count.isErr()) return err(count.error);
  }
  return ok(undefined);
}

function validateReportMessageFacts(
  value: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
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
  if (record.isErr()) return err(record.error);
  for (const key of ["requestNumber", "messageCount"]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  for (const key of ["provider", "model"]) {
    const identity = reportIdentity(reportValue(record.value, key));
    if (identity.isErr()) return err(identity.error);
  }
  const contextHash = reportHash(reportValue(record.value, "contextHash"));
  if (contextHash.isErr()) return err(contextHash.error);
  const descriptors = validateReportDescriptorArray(
    reportValue(record.value, "descriptors"),
    false,
  );
  if (descriptors.isErr()) return err(descriptors.error);
  const counts = validateReportDescriptorCounts(record.value);
  if (counts.isErr()) return err(counts.error);
  for (const key of [
    "originalUserPresent",
    "taskPresent",
    "toolCallPresent",
    "toolResultPresent",
    "failedAssistantPresent",
    "recoveryMarkerPresent",
    "syntheticProviderUserMessagePresent",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
  }
  return ok(undefined);
}

function validateReportMarkerCorrelation(
  value: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "failedAssistantOrdinal",
    "markerOrdinal",
    "failedAssistantEntryIndex",
    "markerEntryIndex",
    "interveningNativeEntryCount",
    "failedAssistantFingerprintHash",
    "markerTokenHash",
  ]);
  if (record.isErr()) return err(record.error);
  for (const key of [
    "failedAssistantOrdinal",
    "markerOrdinal",
    "failedAssistantEntryIndex",
    "markerEntryIndex",
    "interveningNativeEntryCount",
  ]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  for (const key of ["failedAssistantFingerprintHash", "markerTokenHash"]) {
    const hash = reportHash(reportValue(record.value, key));
    if (hash.isErr()) return err(hash.error);
  }
  return ok(undefined);
}

function validateReportHistoryFacts(
  value: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "entryCount",
      "historyHash",
      "descriptors",
      "descriptorCount",
      "userCount",
      "assistantCount",
      "toolResultCount",
      "customCount",
      "failedAssistantPresent",
      "recoveryMarkerPresent",
      "successfulAssistantPresent",
      "recoveryEntryPresent",
    ],
    ["markerTokenHash", "markerTokenValid", "markerCorrelation"],
  );
  if (record.isErr()) return err(record.error);
  const entryCount = reportCount(reportValue(record.value, "entryCount"));
  if (entryCount.isErr()) return err(entryCount.error);
  if (entryCount.value > MAX_HISTORY_DESCRIPTOR_COUNT)
    return err(reportTooLarge("report native history exceeds its bound"));
  const historyHash = reportHash(reportValue(record.value, "historyHash"));
  if (historyHash.isErr()) return err(historyHash.error);
  const descriptors = validateReportDescriptorArray(
    reportValue(record.value, "descriptors"),
    true,
  );
  if (descriptors.isErr()) return err(descriptors.error);
  const counts = validateReportDescriptorCounts(record.value);
  if (counts.isErr()) return err(counts.error);
  for (const key of [
    "failedAssistantPresent",
    "recoveryMarkerPresent",
    "successfulAssistantPresent",
    "recoveryEntryPresent",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
  }
  if (reportValue(record.value, "markerTokenHash") !== undefined) {
    const hash = reportHash(reportValue(record.value, "markerTokenHash"));
    if (hash.isErr()) return err(hash.error);
  }
  if (reportValue(record.value, "markerTokenValid") !== undefined) {
    const boolean = reportBoolean(
      reportValue(record.value, "markerTokenValid"),
    );
    if (boolean.isErr()) return err(boolean.error);
  }
  if (reportValue(record.value, "markerCorrelation") !== undefined) {
    const correlation = validateReportMarkerCorrelation(
      reportValue(record.value, "markerCorrelation"),
    );
    if (correlation.isErr()) return err(correlation.error);
  }
  return ok(undefined);
}

function validateReportLifecycle(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "beforeAgentStartCount",
      "messageStartCount",
      "messageEndCount",
      "contextCount",
      "contextRepairCount",
      "contextRepairTimesMs",
      "modelSelectCount",
      "modelSelectTimesMs",
      "settlementCount",
      "settlementTimesMs",
      "markerMessageStartCount",
      "markerMessageStartTimesMs",
      "recoveryMarkerCount",
      "recoveryMarkerObserved",
    ],
    ["appliedIdentity"],
  );
  if (record.isErr()) return err(record.error);
  for (const key of [
    "beforeAgentStartCount",
    "messageStartCount",
    "messageEndCount",
    "contextCount",
    "contextRepairCount",
    "modelSelectCount",
    "settlementCount",
    "markerMessageStartCount",
    "recoveryMarkerCount",
  ]) {
    const count = reportCount(reportValue(record.value, key));
    if (count.isErr()) return err(count.error);
  }
  const arrays: readonly (readonly [string, string])[] = [
    ["contextRepairTimesMs", "contextRepairCount"],
    ["modelSelectTimesMs", "modelSelectCount"],
    ["settlementTimesMs", "settlementCount"],
    ["markerMessageStartTimesMs", "markerMessageStartCount"],
  ];
  for (const [arrayKey, countKey] of arrays) {
    const values = reportArray(reportValue(record.value, arrayKey));
    if (values.isErr()) return err(values.error);
    const count = reportCount(reportValue(record.value, countKey));
    if (count.isErr()) return err(count.error);
    if (values.value.length !== count.value)
      return err(reportMalformed("lifecycle count does not match timestamps"));
    for (const timestamp of values.value) {
      const validTimestamp = reportCount(timestamp, MAX_REPORT_TIMESTAMP_MS);
      if (validTimestamp.isErr()) return err(validTimestamp.error);
    }
  }
  const markerCount = reportCount(
    reportValue(record.value, "markerMessageStartCount"),
  );
  const recoveryCount = reportCount(
    reportValue(record.value, "recoveryMarkerCount"),
  );
  if (markerCount.isErr() || recoveryCount.isErr())
    return err(reportMalformed());
  if (markerCount.value !== recoveryCount.value)
    return err(reportMalformed("marker lifecycle counts disagree"));
  const observed = reportBoolean(
    reportValue(record.value, "recoveryMarkerObserved"),
  );
  if (observed.isErr()) return err(observed.error);
  if (reportValue(record.value, "appliedIdentity") !== undefined) {
    const identity = validateReportIdentity(
      reportValue(record.value, "appliedIdentity"),
    );
    if (identity.isErr()) return err(identity.error);
  }
  return ok(undefined);
}

function validateReportCleanup(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "noChildProcess",
    "noNativeChild",
    "noActiveLease",
    "noTemporaryPane",
    "noFixtureProcess",
    "noPiProcess",
    "noHelperProcess",
    "temporaryRootRemoved",
    "timersDisposed",
    "resourcesDisposed",
  ]);
  if (record.isErr()) return err(record.error);
  for (const key of [
    "noChildProcess",
    "noNativeChild",
    "noActiveLease",
    "noTemporaryPane",
    "noFixtureProcess",
    "noPiProcess",
    "noHelperProcess",
    "temporaryRootRemoved",
    "timersDisposed",
    "resourcesDisposed",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
    if (!boolean.value) return err(reportMalformed("cleanup proof is false"));
  }
  return ok(undefined);
}

function validateReportFallback(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "processIdentityStable",
      "nativeSessionIdentityStable",
      "threadIdentityStable",
      "parentToolCallIdentityStable",
      "providerRequest",
      "durableHistory",
      "lifecycle",
      "visibleEventCount",
      "cardAppliedIdentity",
      "nativeLine",
      "parentPendingIntervalMs",
      "parentSettlementCount",
      "cleanup",
    ],
    ["outcome"],
  );
  if (record.isErr()) return err(record.error);
  for (const key of [
    "processIdentityStable",
    "nativeSessionIdentityStable",
    "threadIdentityStable",
    "parentToolCallIdentityStable",
  ]) {
    const boolean = reportBoolean(reportValue(record.value, key));
    if (boolean.isErr()) return err(boolean.error);
    if (!boolean.value)
      return err(reportMalformed("fallback identity proof is false"));
  }
  const provider = validateReportMessageFacts(
    reportValue(record.value, "providerRequest"),
  );
  if (provider.isErr()) return err(provider.error);
  const history = validateReportHistoryFacts(
    reportValue(record.value, "durableHistory"),
  );
  if (history.isErr()) return err(history.error);
  const lifecycle = validateReportLifecycle(
    reportValue(record.value, "lifecycle"),
  );
  if (lifecycle.isErr()) return err(lifecycle.error);
  const visible = reportCount(reportValue(record.value, "visibleEventCount"));
  if (visible.isErr()) return err(visible.error);
  if (visible.value !== EXPECTED_FALLBACK_VISIBLE_EVENT_COUNT)
    return err(reportMalformed("fallback event count is not exact"));
  const identity = validateReportIdentity(
    reportValue(record.value, "cardAppliedIdentity"),
  );
  if (identity.isErr()) return err(identity.error);
  if (
    reportValue(record.value, "nativeLine") !== EXPECTED_NATIVE_LINE &&
    reportValue(record.value, "nativeLine") !== "model-fallback"
  )
    return err(reportMalformed("Native Line outcome is not closed"));
  if (reportValue(record.value, "outcome") !== undefined) {
    const outcome = reportExact(
      reportValue(record.value, "outcome"),
      "fallback-confirmed",
    );
    if (outcome.isErr()) return err(outcome.error);
  }
  const pending = reportCount(
    reportValue(record.value, "parentPendingIntervalMs"),
    MAX_COMMAND_TIMEOUT_MS,
  );
  if (pending.isErr()) return err(pending.error);
  const settlement = reportExact(
    reportValue(record.value, "parentSettlementCount"),
    1,
  );
  if (settlement.isErr()) return err(settlement.error);
  return validateReportCleanup(reportValue(record.value, "cleanup"));
}

function validateReportRollback(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    value,
    [
      "optionalSurfaceDisabled",
      "healthReady",
      "healthOnly",
      "legacySettlementCount",
      "fallbackAttempted",
      "cleanup",
    ],
    ["outcome"],
  );
  if (record.isErr()) return err(record.error);
  for (const [key, expected] of [
    ["optionalSurfaceDisabled", true],
    ["healthReady", true],
    ["healthOnly", false],
    ["fallbackAttempted", false],
  ] as const) {
    const result = reportExact(reportValue(record.value, key), expected);
    if (result.isErr()) return err(result.error);
  }
  const settlement = reportExact(
    reportValue(record.value, "legacySettlementCount"),
    1,
  );
  if (settlement.isErr()) return err(settlement.error);
  if (reportValue(record.value, "outcome") !== undefined) {
    const outcome = reportExact(
      reportValue(record.value, "outcome"),
      "legacy-settlement",
    );
    if (outcome.isErr()) return err(outcome.error);
  }
  return validateReportCleanup(reportValue(record.value, "cleanup"));
}

function validateReportProvenance(value: unknown): Result<void, SmokeFailure> {
  const record = strictReportRecord(value, [
    "artifactUnchanged",
    "installedPackageVersion",
    "installedExtensionSha256",
    "loadedAdapterPackageVersion",
    "loadedAdapterExtensionSha256",
    "packageSourceProven",
    "packageRootMatched",
    "loadedExtensionHashMatched",
    "piPackageVersion",
  ]);
  if (record.isErr()) return err(record.error);
  if (reportExact(reportValue(record.value, "artifactUnchanged"), true).isErr())
    return err(reportMalformed("artifact was changed during the smoke"));
  for (const key of [
    "packageSourceProven",
    "packageRootMatched",
    "loadedExtensionHashMatched",
  ]) {
    if (reportExact(reportValue(record.value, key), true).isErr())
      return err(reportMalformed("loaded package provenance is not proven"));
  }
  const installedHash = reportHash(
    reportValue(record.value, "installedExtensionSha256"),
  );
  if (installedHash.isErr()) return err(installedHash.error);
  const loadedHash = reportHash(
    reportValue(record.value, "loadedAdapterExtensionSha256"),
  );
  if (loadedHash.isErr()) return err(loadedHash.error);
  if (installedHash.value !== loadedHash.value)
    return err(reportMalformed("installed and loaded adapter hashes disagree"));
  for (const key of [
    "installedPackageVersion",
    "loadedAdapterPackageVersion",
  ]) {
    if (reportExact(reportValue(record.value, key), PACKAGE_VERSION).isErr())
      return err(reportMalformed("installed adapter version is not exact"));
  }
  if (
    reportExact(
      reportValue(record.value, "piPackageVersion"),
      EXACT_PI_VERSION,
    ).isErr()
  )
    return err(reportMalformed("Pi package version is not exact"));
  return ok(undefined);
}

export function validateReportShape(
  report: unknown,
): Result<void, SmokeFailure> {
  const record = strictReportRecord(
    report,
    ["schemaVersion", "checklistVersion", "artifact", "pi", "diagnostics"],
    ["fallback", "rollback", "provenance"],
  );
  if (record.isErr()) return err(record.error);
  if (reportExact(reportValue(record.value, "schemaVersion"), 1).isErr())
    return err(reportMalformed());
  if (
    reportExact(
      reportValue(record.value, "checklistVersion"),
      CHECKLIST_VERSION,
    ).isErr()
  )
    return err(reportMalformed());
  const artifact = strictReportRecord(reportValue(record.value, "artifact"), [
    "packageName",
    "packageVersion",
    "sha256",
  ]);
  if (artifact.isErr()) return err(artifact.error);
  if (
    reportExact(
      reportValue(artifact.value, "packageName"),
      PACKAGE_NAME,
    ).isErr() ||
    reportExact(
      reportValue(artifact.value, "packageVersion"),
      PACKAGE_VERSION,
    ).isErr()
  )
    return err(reportMalformed("adapter version is not exact"));
  const digest = reportHash(reportValue(artifact.value, "sha256"));
  if (digest.isErr()) return err(digest.error);
  const pi = strictReportRecord(reportValue(record.value, "pi"), [
    "expectedVersion",
    "observedVersion",
  ]);
  if (pi.isErr()) return err(pi.error);
  if (
    reportExact(
      reportValue(pi.value, "expectedVersion"),
      EXACT_PI_VERSION,
    ).isErr() ||
    reportExact(
      reportValue(pi.value, "observedVersion"),
      EXACT_PI_VERSION,
    ).isErr()
  )
    return err(reportMalformed("Pi version is not exact"));
  const diagnostics = reportArray(reportValue(record.value, "diagnostics"));
  if (diagnostics.isErr()) return err(diagnostics.error);
  if (
    diagnostics.value.length === 0 ||
    diagnostics.value.length > MAX_DIAGNOSTIC_COUNT
  )
    return err(reportMalformed("diagnostic count is outside its bound"));
  const seenDiagnostics = new Set<string>();
  for (const diagnostic of diagnostics.value) {
    if (
      typeof diagnostic !== "string" ||
      !(REPORT_DIAGNOSTIC_CODES as readonly string[]).includes(diagnostic) ||
      seenDiagnostics.has(diagnostic)
    )
      return err(reportMalformed("diagnostic code is not allowlisted"));
    seenDiagnostics.add(diagnostic);
  }
  const provenance = reportValue(record.value, "provenance");
  if (provenance !== undefined) {
    const result = validateReportProvenance(provenance);
    if (result.isErr()) return err(result.error);
  }
  const fallback = reportValue(record.value, "fallback");
  const rollback = reportValue(record.value, "rollback");
  if (fallback === undefined && rollback === undefined)
    return err(reportMalformed("report contains no scenario outcome"));
  if (fallback !== undefined) {
    const result = validateReportFallback(fallback);
    if (result.isErr()) return err(result.error);
  }
  if (rollback !== undefined) {
    const result = validateReportRollback(rollback);
    if (result.isErr()) return err(result.error);
  }
  return ok(undefined);
}
