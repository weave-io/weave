import type { JsonValue, WorkflowStep } from "@weaveio/weave-core";

/** Merge string lists with higher-priority entries first and no duplicates. */
export function unionMergeStrings(
  base: readonly string[],
  override: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...override, ...base]) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function sameWorkflowCompletion(
  left: WorkflowStep["completion"],
  right: WorkflowStep["completion"],
): boolean {
  if (left.method === "plan_created") {
    return (
      right.method === "plan_created" && left.plan_name === right.plan_name
    );
  }
  if (left.method === "plan_complete") {
    return (
      right.method === "plan_complete" && left.plan_name === right.plan_name
    );
  }
  return left.method === right.method;
}

function sameWorkflowArtifacts(
  left: WorkflowStep["inputs"],
  right: WorkflowStep["inputs"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftArtifact = left[index];
    const rightArtifact = right[index];
    if (
      leftArtifact === undefined ||
      rightArtifact === undefined ||
      leftArtifact.name !== rightArtifact.name ||
      leftArtifact.description !== rightArtifact.description
    ) {
      return false;
    }
  }
  return true;
}

function sameWorkflowHandlers(
  left: WorkflowStep["reconciliation_handlers"],
  right: WorkflowStep["reconciliation_handlers"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.reason !== right[index]?.reason) return false;
  }
  return true;
}

function sameWorkflowStep(left: WorkflowStep, right: WorkflowStep): boolean {
  return (
    left.name === right.name &&
    left.display_name === right.display_name &&
    left.role === right.role &&
    left.type === right.type &&
    left.agent === right.agent &&
    left.prompt === right.prompt &&
    left.prompt_append === right.prompt_append &&
    left.prompt_append_file === right.prompt_append_file &&
    sameWorkflowCompletion(left.completion, right.completion) &&
    sameWorkflowArtifacts(left.inputs, right.inputs) &&
    sameWorkflowArtifacts(left.outputs, right.outputs) &&
    left.on_reject === right.on_reject &&
    sameWorkflowHandlers(
      left.reconciliation_handlers,
      right.reconciliation_handlers,
    ) &&
    left.insert_before === right.insert_before &&
    left.insert_after === right.insert_after
  );
}

/** Merge workflow steps with structural equality and override-first order. */
export function unionMergeWorkflowSteps(
  base: readonly WorkflowStep[],
  override: readonly WorkflowStep[],
): WorkflowStep[] {
  const result: WorkflowStep[] = [];
  for (const item of [...override, ...base]) {
    if (result.some((existing) => sameWorkflowStep(existing, item))) continue;
    result.push(item);
  }
  return result;
}

/** Merge an optional string list while preserving omission semantics. */
export function mergeOptionalStringArray(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): string[] | undefined {
  if (override === undefined) return base === undefined ? undefined : [...base];
  if (base === undefined) return [...override];
  return unionMergeStrings(base, override);
}

type JsonRecord = { [key: string]: JsonValue };

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return Object(value) === value && !Array.isArray(value);
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => {
      const rightItem = right[index];
      return rightItem !== undefined && sameJsonValue(item, rightItem);
    });
  }
  if (Array.isArray(right)) return false;

  const leftRecord = isJsonRecord(left) ? left : undefined;
  const rightRecord = isJsonRecord(right) ? right : undefined;
  if (leftRecord !== undefined) {
    if (rightRecord === undefined) return false;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index];
      const rightKey = rightKeys[index];
      if (key === undefined || key !== rightKey) return false;
      if (!sameJsonValue(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return rightRecord === undefined && left === right;
}

function unionMergeJsonValues(
  base: readonly JsonValue[],
  override: readonly JsonValue[],
): JsonValue[] {
  const result: JsonValue[] = [];
  for (const item of [...override, ...base]) {
    if (result.some((existing) => sameJsonValue(existing, item))) continue;
    result.push(item);
  }
  return result;
}

function defineJsonRecordEntry(
  target: JsonRecord,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function mergeJsonRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const merged: JsonRecord = Object.setPrototypeOf({}, null);
  for (const key of Object.keys(base)) {
    defineJsonRecordEntry(merged, key, base[key]);
  }
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;
    const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
    defineJsonRecordEntry(
      merged,
      key,
      baseValue === undefined
        ? overrideValue
        : mergeJsonValue(baseValue, overrideValue),
    );
  }
  return merged;
}

function mergeJsonValue(base: JsonValue, override: JsonValue): JsonValue {
  if (Array.isArray(base) && Array.isArray(override)) {
    return unionMergeJsonValues(base, override);
  }

  const baseRecord = isJsonRecord(base) ? base : undefined;
  const overrideRecord = isJsonRecord(override) ? override : undefined;
  if (baseRecord !== undefined && overrideRecord !== undefined) {
    return mergeJsonRecords(baseRecord, overrideRecord);
  }

  return override;
}

/** Merge opaque adapter JSON without exposing a generic object merger. */
export function mergeAdapterSettings(
  base: { [key: string]: JsonValue } | undefined,
  override: { [key: string]: JsonValue } | undefined,
): { [key: string]: JsonValue } | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  return mergeJsonRecords(base, override);
}
