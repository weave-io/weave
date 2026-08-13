/**
 * Concrete Pi `SessionManager` adapter for the native session host port.
 *
 * Pi addresses sessions by filesystem path
 * (`SessionManager.create(cwd, sessionDir, options)` and
 * `SessionManager.open(path, sessionDir)`). Containment is therefore proven by
 * the adapter, not by the host: the store opens an adapter-owned `0700` child
 * directory under the fixed Weave session root, hands that exact directory to
 * Pi, and accepts a returned leaf only when it is a canonical immediate child
 * of it. This module owns no policy; it only narrows Pi's public surface to
 * the port the store validates against.
 */

import type {
  PiNativeSessionHandle,
  PiNativeSessionHeader,
  PiNativeSessionHostPort,
} from "./child-native-sessions.js";

/** Narrow static constructors from Pi's public `SessionManager`. */
export interface PiSessionManagerStatic {
  create(
    cwd: string,
    sessionDir?: string,
    options?: { readonly id?: string; readonly parentSession?: string },
  ): PiSessionManagerInstance;
  open(
    path: string,
    sessionDir?: string,
    cwdOverride?: string,
  ): PiSessionManagerInstance;
}

/** Narrow instance surface the store reads and writes through. */
export interface PiSessionManagerInstance {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getHeader(): {
    readonly id: string;
    readonly cwd: string;
    readonly type?: string;
    readonly version?: number;
    readonly timestamp?: string;
    readonly parentSession?: string;
  } | null;
  getEntries(): readonly unknown[];
  isPersisted(): boolean;
  getLeafId(): string | null;
  appendCustomEntry(customType: string, data?: unknown): string;
}

/** True when a value exposes Pi's static `create` / `open` constructors. */
export function isPiSessionManagerStatic(
  value: unknown,
): value is PiSessionManagerStatic {
  if (
    typeof value !== "function" &&
    (typeof value !== "object" || value === null)
  ) {
    return false;
  }
  const candidate = value as { create?: unknown; open?: unknown };
  return (
    typeof candidate.create === "function" &&
    typeof candidate.open === "function"
  );
}

/**
 * Every field of Pi's supported v3 session header.
 *
 * The deferred-header bridge persists the exact bytes Pi generated, so the
 * adapter must not reorder, invent, drop, or rename a field. A header that
 * does not match this supported shape *exactly* is refused rather than
 * repaired: silently deleting an unknown key would persist a header whose
 * bytes differ from the one Pi generated, and would hide a host whose format
 * this adapter has never validated.
 */
const REQUIRED_HEADER_FIELDS = [
  "type",
  "version",
  "id",
  "timestamp",
  "cwd",
] as const;
/** The only field Pi may omit: a root session has no parent link. */
const OPTIONAL_HEADER_FIELDS = ["parentSession"] as const;
const SUPPORTED_HEADER_FIELDS: ReadonlySet<string> = new Set([
  ...REQUIRED_HEADER_FIELDS,
  ...OPTIONAL_HEADER_FIELDS,
]);
/** Bound on one header string value, so a hostile host cannot flood memory. */
const MAX_HEADER_STRING_LENGTH = 4_096;

function isBoundedHeaderString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HEADER_STRING_LENGTH &&
    !value.includes("\0")
  );
}

/**
 * Returns the own data-property value of `field`, or `undefined` when the
 * field is absent, inherited, an accessor, or explicitly `undefined`.
 */
function ownDataValue(
  header: object,
  field: string,
): { readonly present: boolean; readonly value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(header, field);
  if (descriptor === undefined) return { present: false };
  if (!("value" in descriptor)) return { present: false };
  if (descriptor.value === undefined) return { present: false };
  return { present: true, value: descriptor.value };
}

/**
 * Strictly validates one host header and copies it in the host's own key
 * order.
 *
 * Rejected (`null`, which the store maps to a typed `header-unusable`
 * failure): a non-plain object, any own key outside the supported set, any
 * own symbol key, any accessor or inherited field, a missing required field,
 * and any value whose type or bounds do not match Pi's v3 contract. Key order
 * is taken from the host object itself so the persisted bytes stay identical
 * to the header Pi generated.
 */
function copyHostHeader(
  header: NonNullable<ReturnType<PiSessionManagerInstance["getHeader"]>>,
): PiNativeSessionHeader | null {
  if (typeof header !== "object" || header === null) return null;
  if (Object.getOwnPropertySymbols(header).length > 0) return null;
  const keys = Object.keys(header);
  if (keys.length !== new Set(keys).size) return null;
  for (const key of keys) {
    if (!SUPPORTED_HEADER_FIELDS.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(header, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
  }
  for (const field of REQUIRED_HEADER_FIELDS) {
    if (!ownDataValue(header, field).present) return null;
  }

  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const owned = ownDataValue(header, key);
    if (!owned.present) return null;
    copied[key] = owned.value;
  }
  if (copied.type !== "session") return null;
  if (copied.version !== 3) return null;
  if (
    !isBoundedHeaderString(copied.id) ||
    !isBoundedHeaderString(copied.timestamp) ||
    !isBoundedHeaderString(copied.cwd)
  ) {
    return null;
  }
  if (
    Object.hasOwn(copied, "parentSession") &&
    !isBoundedHeaderString(copied.parentSession)
  ) {
    return null;
  }
  return copied as unknown as PiNativeSessionHeader;
}

/** Adapts one live Pi `SessionManager` instance to the store's handle port. */
export function adaptPiSessionManagerHandle(
  manager: PiSessionManagerInstance,
): PiNativeSessionHandle {
  return {
    getSessionId: () => manager.getSessionId(),
    getSessionFile: () => manager.getSessionFile(),
    getSessionDir: () => manager.getSessionDir(),
    getHeader: (): PiNativeSessionHeader | null => {
      const header = manager.getHeader();
      return header === null ? null : copyHostHeader(header);
    },
    getEntries: () => manager.getEntries(),
    isPersisted: () => manager.isPersisted(),
    getLeafId: () => manager.getLeafId(),
    appendCustomEntry: (customType, data) =>
      manager.appendCustomEntry(customType, data),
  };
}

/**
 * Builds the host port over Pi's static session constructors.
 *
 * Both constructors receive the adapter-owned child directory, so Pi's
 * generated leaf and the directory later passed to the RPC child as
 * `--session-dir` are the same validated directory. A constructor that throws
 * is caught by the store, which owns every typed failure.
 */
export function createPiNativeSessionHost(
  SessionManager: PiSessionManagerStatic,
): PiNativeSessionHostPort {
  return {
    create(cwd, sessionDir, options): PiNativeSessionHandle {
      return adaptPiSessionManagerHandle(
        SessionManager.create(cwd, sessionDir, options),
      );
    },
    open(path, sessionDir): PiNativeSessionHandle {
      return adaptPiSessionManagerHandle(SessionManager.open(path, sessionDir));
    },
  };
}
