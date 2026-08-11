/**
 * Concrete Pi `SessionManager` adapter for the native session host port.
 * Production wires the public root export; tests inject a scripted host and
 * never construct this adapter.
 *
 * Create/open call Pi's static constructors. Expected failures are captured at
 * the store seam with `Result.fromThrowable` (this port's return type is fixed
 * by {@link PiNativeSessionHostPort}).
 */

import { Result } from "neverthrow";
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
 * Adapts one live Pi `SessionManager` instance to the store handle port.
 * Header fields keep Pi's v3 key order so exclusive persistence can
 * `JSON.stringify` the exact generated identity line.
 */
export function adaptPiSessionManagerHandle(
  manager: PiSessionManagerInstance,
): PiNativeSessionHandle {
  return {
    getSessionId: () => manager.getSessionId(),
    getSessionFile: () => manager.getSessionFile(),
    getSessionDir: () => manager.getSessionDir(),
    getHeader: (): PiNativeSessionHeader | null => {
      const header = manager.getHeader();
      if (header === null) return null;
      // Pi v3 order: type, version, id, timestamp, cwd, parentSession.
      // Preserve every host-generated field verbatim; never invent values.
      return {
        ...(header.type === undefined ? {} : { type: header.type }),
        ...(header.version === undefined ? {} : { version: header.version }),
        id: header.id,
        ...(header.timestamp === undefined
          ? {}
          : { timestamp: header.timestamp }),
        cwd: header.cwd,
        ...(header.parentSession === undefined
          ? {}
          : { parentSession: header.parentSession }),
      };
    },
    getEntries: () => manager.getEntries(),
    isPersisted: () => manager.isPersisted(),
    getLeafId: () => manager.getLeafId(),
    appendCustomEntry: (customType, data) =>
      manager.appendCustomEntry(customType, data),
  };
}

function callSessionManagerCreate(
  SessionManager: PiSessionManagerStatic,
  cwd: string,
  sessionDir: string,
  options: { readonly parentSession?: string; readonly id?: string },
): Result<PiSessionManagerInstance, unknown> {
  return Result.fromThrowable(
    () => SessionManager.create(cwd, sessionDir, options),
    (cause) => cause,
  )();
}

function callSessionManagerOpen(
  SessionManager: PiSessionManagerStatic,
  path: string,
  sessionDir: string,
): Result<PiSessionManagerInstance, unknown> {
  return Result.fromThrowable(
    () => SessionManager.open(path, sessionDir),
    (cause) => cause,
  )();
}

/**
 * Builds the native session host over Pi's public session constructors.
 * Does not refuse path-addressed hosts and does not throw for policy; the
 * store wraps create/open and maps throws to `SessionCreateFailed`.
 */
export function createPiNativeSessionHost(
  SessionManager: PiSessionManagerStatic,
): PiNativeSessionHostPort {
  return {
    create(cwd, sessionDir, options): PiNativeSessionHandle {
      const created = callSessionManagerCreate(
        SessionManager,
        cwd,
        sessionDir,
        options,
      );
      if (created.isErr()) {
        // Port return type cannot be Result; rethrow for the store's
        // Result.fromThrowable boundary (never a policy/unreachable throw).
        throw created.error;
      }
      return adaptPiSessionManagerHandle(created.value);
    },
    open(path, sessionDir): PiNativeSessionHandle {
      const opened = callSessionManagerOpen(SessionManager, path, sessionDir);
      if (opened.isErr()) {
        throw opened.error;
      }
      return adaptPiSessionManagerHandle(opened.value);
    },
  };
}
