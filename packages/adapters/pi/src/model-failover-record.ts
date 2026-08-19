import { err, type Result as NeverthrowResult, ok, Result } from "neverthrow";
import type { PiModelIdentityBody } from "./child-control-bodies.js";
import { parseControlBody } from "./child-control-bodies.js";
import {
  isPiModelFailoverMarker,
  PI_FAILOVER_FAILURE_CLASSES,
  PI_MODEL_FAILOVER_MARKER_TYPE,
  type PiFailoverFailureClass,
  readPiOwnEnumerableData,
} from "./model-failover-contract.js";
import { canonicalizeToBytes, type JsonValue } from "./strict-json.js";

/** The native Pi custom-entry type for a confirmed model switch. */
export const PI_MODEL_FAILOVER_ENTRY_TYPE = "weave.model-failover" as const;
/** Schema version of {@link PiModelFailoverRecord}. */
export const MODEL_FAILOVER_RECORD_SCHEMA_VERSION = 1 as const;
/** Maximum canonical JSON size of one durable fallback record. */
export const MAX_MODEL_FAILOVER_RECORD_BYTES = 4 * 1_024;
/** Maximum code points and UTF-8 bytes of one identity field. */
export const MAX_MODEL_FAILOVER_FIELD_LENGTH = 256;

export interface PiModelFailoverIdentity {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

/** The only facts a visible model-fallback entry may carry. */
export interface PiModelFailoverRecord {
  readonly schemaVersion: typeof MODEL_FAILOVER_RECORD_SCHEMA_VERSION;
  readonly transitionId: string;
  readonly failureClass: PiFailoverFailureClass;
  readonly from: PiModelFailoverIdentity;
  readonly to: PiModelFailoverIdentity;
}

export type PiModelFailoverRecordError = {
  readonly type: "PiModelFailoverRecordInvalid";
  readonly reason:
    | "not-record"
    | "extra-field"
    | "accessor"
    | "prototype"
    | "missing-field"
    | "invalid-field"
    | "unsupported-transition-phase"
    | "oversized";
};

export type PiModelFailoverAppendError =
  | PiModelFailoverRecordError
  | {
      readonly type: "PiModelFailoverAppendFailed";
      readonly reason:
        | "context-not-repaired"
        | "history-unreadable"
        | "append-failed";
    };

export interface PiModelFailoverAppendPort {
  readonly appendEntry: (type: string, data: unknown) => void;
  readonly getEntries?: () => readonly unknown[];
}

export interface PiModelFailoverAppendResult {
  readonly status: "appended" | "duplicate";
  readonly record: PiModelFailoverRecord;
}

const localTransitionIds = new WeakMap<object, Set<string>>();

function invalid(
  reason: PiModelFailoverRecordError["reason"],
): NeverthrowResult<never, PiModelFailoverRecordError> {
  return err({ type: "PiModelFailoverRecordInvalid", reason });
}

function isObject(value: unknown): value is object {
  // Arrays are rejected by the strict prototype/own-key checks below. Avoid
  // Array.isArray here: it can throw for a revoked proxy, which must fail
  // closed as data rather than escape the parser.
  return typeof value === "object" && value !== null;
}

function ownKeys(
  value: object,
): Result<readonly string[], PiModelFailoverRecordError> {
  return Result.fromThrowable(
    () => Reflect.ownKeys(value),
    (): PiModelFailoverRecordError => ({
      type: "PiModelFailoverRecordInvalid",
      reason: "accessor",
    }),
  )().andThen((keys) =>
    keys.every((key): key is string => typeof key === "string")
      ? ok(keys as readonly string[])
      : invalid("extra-field"),
  );
}

function plainRecord(
  value: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, PiModelFailoverRecordError> {
  if (!isObject(value)) return invalid("not-record");
  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(value),
    (): PiModelFailoverRecordError => ({
      type: "PiModelFailoverRecordInvalid",
      reason: "accessor",
    }),
  )();
  if (prototype.isErr()) return err(prototype.error);
  if (prototype.value !== Object.prototype && prototype.value !== null) {
    return invalid("prototype");
  }
  return ownKeys(value).andThen((keys) => {
    const allowedSet = new Set(allowed);
    if (keys.some((key) => !allowedSet.has(key))) return invalid("extra-field");
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const read = readPiOwnEnumerableData(value, key);
      if (read.state === "accessor" || read.state === "unreadable") {
        return invalid("accessor");
      }
      if (read.state !== "data") return invalid("missing-field");
      Object.defineProperty(copy, key, {
        value: read.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return ok(copy);
  });
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.trim().length === 0) return undefined;
  if (Array.from(value).length > MAX_MODEL_FAILOVER_FIELD_LENGTH)
    return undefined;
  if (
    new TextEncoder().encode(value).byteLength > MAX_MODEL_FAILOVER_FIELD_LENGTH
  ) {
    return undefined;
  }
  return value;
}

function parseIdentity(
  value: unknown,
): Result<PiModelFailoverIdentity, PiModelFailoverRecordError> {
  return plainRecord(value, ["provider", "id", "name"]).andThen((record) => {
    const provider = boundedString(record.provider);
    const id = boundedString(record.id);
    if (provider === undefined || id === undefined)
      return invalid("invalid-field");
    const hasName = Object.hasOwn(record, "name");
    if (!hasName) return ok({ provider, id });
    const name = boundedString(record.name);
    if (name === undefined) return invalid("invalid-field");
    return ok({ provider, id, name });
  });
}

function canonicalRecord(
  record: PiModelFailoverRecord,
): Result<PiModelFailoverRecord, PiModelFailoverRecordError> {
  const canonical = canonicalizeToBytes(record as unknown as JsonValue);
  if (canonical.isErr()) return invalid("invalid-field");
  if (canonical.value.byteLength > MAX_MODEL_FAILOVER_RECORD_BYTES) {
    return invalid("oversized");
  }
  return ok(record);
}

/** Parse the strict data payload of a `weave.model-failover` entry. */
export function parsePiModelFailoverRecord(
  value: unknown,
): Result<PiModelFailoverRecord, PiModelFailoverRecordError> {
  return plainRecord(value, [
    "schemaVersion",
    "transitionId",
    "failureClass",
    "from",
    "to",
  ]).andThen((record) => {
    if (record.schemaVersion !== MODEL_FAILOVER_RECORD_SCHEMA_VERSION) {
      return invalid("invalid-field");
    }
    const transitionId = boundedString(record.transitionId);
    const failureClass = boundedString(record.failureClass);
    if (transitionId === undefined || failureClass === undefined) {
      return invalid("invalid-field");
    }
    if (
      !PI_FAILOVER_FAILURE_CLASSES.includes(
        failureClass as PiFailoverFailureClass,
      )
    )
      return invalid("invalid-field");
    return parseIdentity(record.from).andThen((from) =>
      parseIdentity(record.to).andThen((to) =>
        canonicalRecord({
          schemaVersion: MODEL_FAILOVER_RECORD_SCHEMA_VERSION,
          transitionId,
          failureClass: failureClass as PiFailoverFailureClass,
          from,
          to,
        }),
      ),
    );
  });
}

/**
 * Convert an authenticated recovery-confirmed transition into the durable
 * record. Applied-only transitions intentionally produce no record.
 */
export function modelFailoverRecordFromTransition(
  transition: unknown,
): Result<PiModelFailoverRecord | undefined, PiModelFailoverRecordError> {
  const parsed = parseControlBody("model-transition", transition);
  if (!parsed.ok) return invalid("invalid-field");
  if (parsed.value.phase !== "recovery-confirmed") {
    return ok(undefined);
  }
  const value = parsed.value;
  return parsePiModelFailoverRecord({
    schemaVersion: value.schemaVersion,
    transitionId: value.transitionId,
    failureClass: value.failureClass,
    from: value.from,
    to: value.to,
  });
}

/** Compatibility spellings used by lifecycle callers. */
export const piModelFailoverRecordFromTransition =
  modelFailoverRecordFromTransition;
export const createPiModelFailoverRecord = modelFailoverRecordFromTransition;

/**
 * Parse one full native session entry. A non-matching entry is not an error:
 * unrelated custom messages stay visible to their own renderers.
 */
export function parsePiModelFailoverNativeEntry(
  value: unknown,
): Result<PiModelFailoverRecord | undefined, PiModelFailoverRecordError> {
  if (!isObject(value)) return ok(undefined);
  const type = readPiOwnEnumerableData(value, "type");
  if (type.state === "accessor" || type.state === "unreadable") {
    return invalid("accessor");
  }
  if (type.state !== "data") return ok(undefined);
  if (type.value !== "custom") return ok(undefined);
  const customType = readPiOwnEnumerableData(value, "customType");
  // `customType` is optional on unrelated native custom entries. Only an
  // accessor here is a strict-entry failure: invoking it would let an
  // untrusted host object choose the record the renderer sees.
  if (customType.state === "accessor" || customType.state === "unreadable") {
    return invalid("accessor");
  }
  if (customType.state !== "data") return ok(undefined);
  if (customType.value !== PI_MODEL_FAILOVER_ENTRY_TYPE) return ok(undefined);
  return plainRecord(value, ["type", "id", "customType", "data"]).andThen(
    (entry) => {
      if (
        entry.type !== "custom" ||
        entry.customType !== PI_MODEL_FAILOVER_ENTRY_TYPE
      ) {
        return invalid("invalid-field");
      }
      if (entry.id === undefined) return invalid("missing-field");
      if (boundedString(entry.id) === undefined)
        return invalid("invalid-field");
      if (entry.data === undefined) return invalid("missing-field");
      return parsePiModelFailoverRecord(entry.data);
    },
  );
}

/** Compatibility spelling for native history readers. */
export const parseModelFailoverNativeEntry = parsePiModelFailoverNativeEntry;

/** True only for the exact hidden recovery custom entry/message type. */
export function isPiModelFailoverHiddenCustomType(value: unknown): boolean {
  if (!isObject(value)) return false;
  const type = readPiOwnEnumerableData(value, "type");
  if (type.state === "data") {
    if (type.value !== "custom") return false;
  } else if (type.state !== "missing") {
    return false;
  } else {
    // Pi's message carrier uses `role`; its native session entry uses `type`.
    const role = readPiOwnEnumerableData(value, "role");
    if (role.state !== "data" || role.value !== "custom") return false;
  }
  const customType = readPiOwnEnumerableData(value, "customType");
  return (
    customType.state === "data" &&
    customType.value === PI_MODEL_FAILOVER_MARKER_TYPE
  );
}

/**
 * Detect the hidden marker in either a native custom entry or a child event's
 * message carrier. This is intentionally exact; ordinary custom entries are
 * never filtered by role or by a broad `weave.*` prefix.
 */
export function isPiModelFailoverHiddenMarker(value: unknown): boolean {
  if (isPiModelFailoverHiddenCustomType(value)) return true;
  if (!isObject(value)) return false;
  const originalType = readPiOwnEnumerableData(value, "originalType");
  if (
    originalType.state === "data" &&
    originalType.value === PI_MODEL_FAILOVER_MARKER_TYPE
  )
    return true;
  const message = readPiOwnEnumerableData(value, "message");
  if (message.state !== "data") return false;
  return isPiModelFailoverHiddenCustomType(message.value);
}

/** A marker validator exposed for callers that already have a Pi message. */
export const isPiModelFallbackMarker = isPiModelFailoverMarker;

function transitionIdSet(port: PiModelFailoverAppendPort): Set<string> {
  if (typeof port !== "object" || port === null) return new Set();
  const existing = localTransitionIds.get(port);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  localTransitionIds.set(port, created);
  return created;
}

/**
 * Append only after the caller has proved the exact provider-context repair.
 * Native history is read for restart-safe deduplication; the local WeakMap is
 * only a same-process fast path when the host does not expose a read method.
 */
export function appendPiModelFailoverRecord(
  port: PiModelFailoverAppendPort,
  value: unknown,
  contextRepaired = false,
): Result<PiModelFailoverAppendResult, PiModelFailoverAppendError> {
  if (contextRepaired !== true) {
    return err({
      type: "PiModelFailoverAppendFailed",
      reason: "context-not-repaired",
    });
  }
  const parsed = parsePiModelFailoverRecord(value);
  if (parsed.isErr()) return err(parsed.error);
  const record = parsed.value;
  const seen = transitionIdSet(port);
  if (seen.has(record.transitionId)) return ok({ status: "duplicate", record });

  if (port.getEntries !== undefined) {
    const entries = Result.fromThrowable(
      () => port.getEntries?.(),
      (): PiModelFailoverAppendError => ({
        type: "PiModelFailoverAppendFailed",
        reason: "history-unreadable",
      }),
    )();
    if (entries.isErr() || entries.value === undefined) {
      return err(
        entries.isErr()
          ? entries.error
          : {
              type: "PiModelFailoverAppendFailed",
              reason: "history-unreadable",
            },
      );
    }
    const history = Result.fromThrowable(
      () => Array.from(entries.value as Iterable<unknown>),
      (): PiModelFailoverAppendError => ({
        type: "PiModelFailoverAppendFailed",
        reason: "history-unreadable",
      }),
    )();
    if (history.isErr()) return err(history.error);
    for (const entry of history.value) {
      const existing = parsePiModelFailoverNativeEntry(entry);
      if (existing.isErr()) return err(existing.error);
      if (existing.value?.transitionId === record.transitionId) {
        seen.add(record.transitionId);
        return ok({ status: "duplicate", record });
      }
    }
  }

  const appended = Result.fromThrowable(
    () => port.appendEntry(PI_MODEL_FAILOVER_ENTRY_TYPE, record),
    (): PiModelFailoverAppendError => ({
      type: "PiModelFailoverAppendFailed",
      reason: "append-failed",
    }),
  )();
  if (appended.isErr()) return err(appended.error);
  seen.add(record.transitionId);
  return ok({ status: "appended", record });
}

/** Explicit name for the context-repaired append boundary. */
export function appendModelFailoverRecordAfterContextRepair(
  port: PiModelFailoverAppendPort,
  value: unknown,
): Result<PiModelFailoverAppendResult, PiModelFailoverAppendError> {
  return appendPiModelFailoverRecord(port, value, true);
}

/** Compatibility alias for callers that name the confirmed phase. */
export const appendConfirmedPiModelFailoverRecord =
  appendModelFailoverRecordAfterContextRepair;

/** Copies an already validated identity without retaining host object fields. */
export function copyPiModelFailoverIdentity(
  identity: PiModelIdentityBody,
): PiModelFailoverIdentity {
  return identity.name === undefined
    ? { provider: identity.provider, id: identity.id }
    : { provider: identity.provider, id: identity.id, name: identity.name };
}
