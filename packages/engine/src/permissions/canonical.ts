import { err, ok, Result } from "neverthrow";
import { snapshotArrayOnce } from "./array-snapshot.js";
import type {
  GrantablePermissionRequest,
  JsonValue,
  PermissionCapability,
  PermissionDisplay,
  PermissionError,
  PermissionRequest,
} from "./types.js";

const encoder = new TextEncoder();
export const MAX_DEPTH = 64;
export const MAX_CANONICAL_BYTES = 1_048_576;
/** Fail-fast cap on array elements before any length-driven allocation. */
export const MAX_ARRAY_ELEMENTS = MAX_CANONICAL_BYTES;
const CONSTRAINT_BYTES = 16_384;
const isIndexKey = (key: string): boolean => {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && String(index) === key;
};
const capabilities: readonly PermissionCapability[] = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
];
const requestKeys = [
  "unresolved",
  "capability",
  "operation",
  "target",
  "constraints",
  "display",
] as const;
const unsafe = (path: string, message: string): PermissionError => ({
  type: "unsafe_input",
  path,
  message,
});
const invalid = (message: string): PermissionError => ({
  type: "invalid_output",
  message,
});
const opaqueObjectPath = (path: string): string => `${path}.object`;
const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const loneSurrogate = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

/** Read only data descriptors. This function never invokes a property getter. */
const own = (
  value: object,
  path: string,
  allowed: readonly string[],
): Result<Record<string, PropertyDescriptor>, PermissionError> => {
  const allowedSet = new Set(allowed);
  const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key))
      return err(unsafe(path, "unexpected property"));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      (key !== "length" && !descriptor.enumerable)
    )
      return err(unsafe(path, "accessor or non-enumerable property"));
    descriptors[key] = descriptor;
  }
  return ok(descriptors);
};

function copy(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
): Result<JsonValue, PermissionError> {
  if (depth > MAX_DEPTH)
    return err(unsafe(path, `maximum depth is ${MAX_DEPTH}`));
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    return err(unsafe(path, "unsupported value"));
  if (typeof value === "string")
    return loneSurrogate(value)
      ? err(unsafe(path, "lone surrogate"))
      : ok(value);
  if (typeof value === "number")
    return Number.isFinite(value)
      ? ok(Object.is(value, -0) ? 0 : value)
      : err(unsafe(path, "non-finite number"));
  if (value === null || typeof value !== "object")
    return ok(value as JsonValue);
  if (seen.has(value)) return err(unsafe(path, "cyclic value"));

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (prototype !== Object.prototype && prototype !== null && !array)
    return err(unsafe(path, "unsupported object prototype"));

  let keys: string[];
  let descriptors: Record<string, PropertyDescriptor>;
  if (array) {
    // Capture own keys and the length data descriptor exactly once. Never
    // allocate or iterate from a hostile sparse `length` before bounds checks,
    // and never reread live keys/length from a mutable proxy.
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_ARRAY_ELEMENTS + 1)
      return err(unsafe(path, `array exceeds ${MAX_ARRAY_ELEMENTS} elements`));

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    )
      return err(unsafe(path, "invalid array length"));
    const length = lengthDescriptor.value as number;
    if (length > MAX_ARRAY_ELEMENTS)
      return err(unsafe(path, `array length exceeds ${MAX_ARRAY_ELEMENTS}`));
    // Dense arrays expose exactly `length` index keys plus `length` itself.
    if (ownKeys.length !== length + 1) return err(unsafe(path, "sparse array"));

    const captured: Record<string, PropertyDescriptor> = Object.create(null);
    captured.length = lengthDescriptor;
    const indexKeys: string[] = [];
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !isIndexKey(key))
        return err(unsafe(path, "unexpected property"));
      const index = Number(key);
      if (index < 0 || index >= length)
        return err(unsafe(path, "sparse array"));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      )
        return err(unsafe(path, "accessor or non-enumerable property"));
      if (captured[key]) return err(unsafe(path, "sparse array"));
      captured[key] = descriptor;
      indexKeys.push(key);
    }
    if (indexKeys.length !== length) return err(unsafe(path, "sparse array"));
    // After bounds + key-set checks, build dense keys without Array.from(length).
    keys = new Array<string>(length);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!captured[key]) return err(unsafe(path, "sparse array"));
      keys[index] = key;
    }
    descriptors = captured;
  } else {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string"))
      return err(unsafe(path, "unexpected property"));
    keys = ownKeys.filter((key): key is string => typeof key === "string");
    keys.sort(compareCodeUnits);
    const objectDescriptors = own(value, path, keys);
    if (objectDescriptors.isErr()) return err(objectDescriptors.error);
    descriptors = objectDescriptors.value;
  }

  seen.add(value);
  const result: JsonValue[] | Record<string, JsonValue> = array
    ? []
    : Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const child = copy(
      descriptors[key].value,
      array ? `${path}[${index}]` : opaqueObjectPath(path),
      seen,
      depth + 1,
    );
    if (child.isErr()) {
      seen.delete(value);
      return err(child.error);
    }
    if (array) (result as JsonValue[]).push(child.value);
    else (result as Record<string, JsonValue>)[key] = child.value;
  }
  seen.delete(value);
  return ok(Object.freeze(result) as JsonValue);
}

/** Clone untrusted JSON without invoking accessors or retaining its prototype. */
export function cloneAndFreezeJson(
  value: unknown,
): Result<JsonValue, PermissionError> {
  return Result.fromThrowable(
    () => copy(value, "$", new Set(), 0),
    () => unsafe("$", "unsafe JSON input"),
  )().andThen((result) => result);
}
export const cloneAndFreeze = cloneAndFreezeJson;
export const cloneFreeze = cloneAndFreezeJson;

export function utf8Bytes(
  value: string,
  max: number,
): Result<Uint8Array, PermissionError> {
  if (typeof value !== "string") return err(invalid("value must be a string"));
  const bytes = encoder.encode(value);
  return bytes.byteLength > max
    ? err(invalid(`value exceeds ${max} UTF-8 bytes`))
    : ok(bytes);
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value === 0 ? 0 : value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serialize((value as { readonly [key: string]: JsonValue })[key])}`,
    )
    .join(",")}}`;
}

export function canonicalizeJson(
  value: unknown,
): Result<string, PermissionError> {
  return Result.fromThrowable(
    () => {
      const safe = cloneAndFreezeJson(value);
      if (safe.isErr()) return err(safe.error);
      const text = serialize(safe.value);
      return encoder.encode(text).byteLength > MAX_CANONICAL_BYTES
        ? err(
            unsafe("$", `canonical input exceeds ${MAX_CANONICAL_BYTES} bytes`),
          )
        : ok(text);
    },
    () => unsafe("$", "unsafe JSON input"),
  )().andThen((result) => result);
}
export const canonicalPermissionJson = (
  value: unknown,
): Result<string, PermissionError> => canonicalizeJson(value);

export function permissionDigest(
  value: unknown,
): Result<string, PermissionError> {
  return canonicalPermissionJson(value).andThen((json) =>
    Result.fromThrowable(
      () =>
        new Bun.CryptoHasher("sha256")
          .update(encoder.encode(json))
          .digest("hex"),
      () => invalid("SHA-256 digest failed"),
    )(),
  );
}

const stringField = (
  value: unknown,
  max: number,
  path: string,
): Result<string, PermissionError> =>
  typeof value === "string" && value.length > 0 && !loneSurrogate(value)
    ? utf8Bytes(value, max).map(() => value)
    : err(invalid(`${path} must be a valid non-empty string`));

function exact(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Result<Record<string, PropertyDescriptor>, PermissionError> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return err(invalid(`${path} must be an object`));
  return own(value, path, allowed);
}

const defaultIgnorable = /^\p{Default_Ignorable_Code_Point}$/u;
const unsafeDisplayCodePoint = (character: string, code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  defaultIgnorable.test(character) ||
  code === 0x115f ||
  code === 0x1160 ||
  code === 0x3164 ||
  code === 0xffa0 ||
  code === 0x2800;

const safeDisplayText = (
  value: unknown,
  max: number,
  field: string,
): Result<string, PermissionError> => {
  if (
    typeof value !== "string" ||
    (value.length === 0 && field === "summary") ||
    loneSurrogate(value)
  )
    return err(invalid(`invalid permission display ${field}`));
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || unsafeDisplayCodePoint(character, code))
      return err(invalid(`invalid permission display ${field}`));
  }
  return utf8Bytes(value, max).map(() => value);
};

/** Validate and copy user-facing permission text without invoking accessors. */
export function sanitizePermissionDisplay(
  value: unknown,
): Result<PermissionDisplay, PermissionError> {
  return Result.fromThrowable(
    () => {
      const fields = exact(value, "display", ["summary", "details"]);
      if (fields.isErr()) return err(invalid("invalid permission display"));
      const summary = safeDisplayText(
        fields.value.summary?.value,
        256,
        "summary",
      );
      if (summary.isErr()) return err(summary.error);
      const details = fields.value.details
        ? safeDisplayText(fields.value.details.value, 2048, "details")
        : ok("");
      if (details.isErr()) return err(details.error);
      return ok(
        Object.freeze({
          summary: summary.value,
          ...(details.value.length === 0 ? {} : { details: details.value }),
        }),
      );
    },
    () => invalid("invalid permission display"),
  )().andThen((result) => result);
}

function normalizeCapturedRequests(
  input: readonly unknown[],
): Result<readonly PermissionRequest[], PermissionError> {
  if (input.length === 0)
    return err({
      type: "empty_output",
      message: "at least one permission request is required",
    });
  const output: PermissionRequest[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    const rd = exact(raw, `requests[${i}]`, requestKeys);
    if (rd.isErr()) return err(rd.error);
    const display = sanitizePermissionDisplay(rd.value.display?.value);
    if (display.isErr()) return err(display.error);
    if (rd.value.unresolved?.value === true) {
      if (
        ["capability", "operation", "target", "constraints"].some(
          (k) => rd.value[k],
        )
      )
        return err(invalid("unresolved request has grantable fields"));
      output.push(Object.freeze({ unresolved: true, display: display.value }));
      continue;
    }
    if (
      rd.value.unresolved?.value !== false ||
      !capabilities.includes(rd.value.capability?.value as PermissionCapability)
    )
      return err(invalid("invalid capability or unresolved flag"));
    const target = exact(rd.value.target?.value, "target", [
      "kind",
      "identifier",
    ]);
    if (target.isErr()) return err(target.error);
    const operation = stringField(rd.value.operation?.value, 128, "operation");
    const kind = stringField(target.value.kind?.value, 64, "kind");
    const identifier = stringField(
      target.value.identifier?.value,
      2048,
      "identifier",
    );
    if (operation.isErr()) return err(operation.error);
    if (kind.isErr()) return err(kind.error);
    if (identifier.isErr()) return err(identifier.error);
    let constraints: JsonValue | undefined;
    if (rd.value.constraints) {
      const cloned = cloneAndFreezeJson(rd.value.constraints.value);
      if (cloned.isErr()) return err(invalid("invalid permission constraints"));
      const canonical = canonicalPermissionJson(cloned.value);
      if (canonical.isErr())
        return err(invalid("invalid permission constraints"));
      if (encoder.encode(canonical.value).byteLength > CONSTRAINT_BYTES)
        return err(invalid("constraints exceed 16384 UTF-8 bytes"));
      constraints = cloned.value;
    }
    output.push(
      Object.freeze({
        unresolved: false,
        capability: rd.value.capability.value as PermissionCapability,
        operation: operation.value,
        target: Object.freeze({
          kind: kind.value,
          identifier: identifier.value,
        }),
        display: display.value,
        ...(constraints === undefined ? {} : { constraints }),
      }),
    );
  }
  return ok(Object.freeze(output));
}

/**
 * Normalize resolver output after a one-shot descriptor array snapshot.
 * Live length/index re-reads are forbidden: only frozen captured elements are
 * validated, so a changing proxy cannot turn deny requests into empty/allow.
 */
export function normalizePermissionRequests(
  input: readonly PermissionRequest[],
): Result<readonly PermissionRequest[], PermissionError> {
  const snapshotted = snapshotArrayOnce(input).mapErr(() =>
    invalid("invalid permission resolver output"),
  );
  if (snapshotted.isErr()) return err(snapshotted.error);
  // Enforce non-empty against the captured snapshot only.
  if (snapshotted.value.length < 1)
    return err({
      type: "empty_output",
      message: "at least one permission request is required",
    });
  const normalized = Result.fromThrowable(
    () => normalizeCapturedRequests(snapshotted.value),
    () => invalid("invalid permission resolver output"),
  )().andThen((result) => result);
  return normalized.mapErr((error) => {
    if (error.type === "empty_output" || error.type === "invalid_output")
      return error;
    return invalid("invalid permission resolver output");
  });
}
export const validateRequests = normalizePermissionRequests;
export const validateRequest = (
  request: PermissionRequest,
): Result<PermissionRequest, PermissionError> =>
  normalizePermissionRequests([request]).andThen((items) => {
    if (items[0]) return ok(items[0]);
    return err({ type: "empty_output" as const, message: "request missing" });
  });

const authorizationFields = (request: GrantablePermissionRequest) => ({
  unresolved: false as const,
  capability: request.capability,
  operation: request.operation,
  target: request.target,
  ...(request.constraints === undefined
    ? {}
    : { constraints: request.constraints }),
});

export const requestKey = (
  request: PermissionRequest,
): Result<string, PermissionError> =>
  validateRequest(request).andThen((normalized) => {
    if (normalized.unresolved)
      return err(invalid("unresolved request has no grant key"));
    return permissionDigest(authorizationFields(normalized));
  });

export const requestBindingKey = (
  request: PermissionRequest,
): Result<string, PermissionError> =>
  validateRequest(request).andThen((normalized) =>
    permissionDigest(
      normalized.unresolved
        ? { unresolved: true, display: normalized.display }
        : authorizationFields(normalized),
    ),
  );
