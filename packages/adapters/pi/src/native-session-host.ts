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
  PiNativeSessionHostPort,
} from "./child-native-sessions.js";
import {
  type PiNativeSessionHeader,
  validatePiNativeSessionHeader,
} from "./native-session-header.js";

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
 * Strictly validates one host header and copies it in the host's own key
 * order, through the single adapter-wide validator every lifecycle path uses
 * ({@link validatePiNativeSessionHeader}).
 *
 * Returns `null` - which the store maps to a typed `header-unusable` failure -
 * for a non-plain object, an exotic prototype, an own symbol key, an accessor
 * or non-enumerable own property, any key outside Pi's supported v3 set, a
 * missing required field, and any value whose type or bounds do not match
 * Pi's v3 contract. Key order is taken from the host object itself so the
 * persisted bytes stay identical to the header Pi generated.
 */
function copyHostHeader(candidate: unknown): PiNativeSessionHeader | null {
  return validatePiNativeSessionHeader(candidate).unwrapOr(null);
}

/** Adapts one live Pi `SessionManager` instance to the store's handle port. */
export function adaptPiSessionManagerHandle(
  manager: PiSessionManagerInstance,
): PiNativeSessionHandle {
  return {
    getSessionId: () => manager.getSessionId(),
    getSessionFile: () => manager.getSessionFile(),
    getSessionDir: () => manager.getSessionDir(),
    getHeader: (): PiNativeSessionHeader | null =>
      copyHostHeader(manager.getHeader()),
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
