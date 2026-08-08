/**
 * Concrete Pi 0.83 `SessionManager` adapter for Task 4's native session host
 * port. Production wires the public root export; tests inject a scripted host
 * and never construct this adapter.
 */

import { err, type Result } from "neverthrow";

import {
  describePiNativeSessionStorageUnavailable,
  type PiNativeSessionHandle,
  type PiNativeSessionHeader,
  type PiNativeSessionHostPort,
  type PiNativeSessionStorageUnavailable,
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

/** Narrow instance surface Task 4 reads and writes through. */
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

/** True when a value exposes Pi 0.83's static `create` / `open` constructors. */
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

/** Adapts one live Pi `SessionManager` instance to the Task 4 handle port. */
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
      // Every Pi-generated header field is preserved verbatim. Task 20 needs
      // `type`/`timestamp` to persist the host's own header bytes without
      // inventing any of them.
      return {
        id: header.id,
        cwd: header.cwd,
        ...(header.type === undefined ? {} : { type: header.type }),
        ...(header.version === undefined ? {} : { version: header.version }),
        ...(header.timestamp === undefined
          ? {}
          : { timestamp: header.timestamp }),
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

/**
 * Builds the Task 4 host port over Pi's static session constructors.
 *
 * Pi 0.83 addresses sessions only by caller-supplied filesystem path
 * (`SessionManager.create(cwd, isolatedDir, options)` and
 * `SessionManager.open(path, sessionDir)`), so this host cannot prove that
 * the bytes it writes land in the descriptor-verified, Weave-owned session
 * tree. Its storage-authority preflight therefore always fails with
 * `path-only-session-api`, and `create` / `open` refuse before touching
 * `SessionManager` at all. There is no option, environment variable, or flag
 * that relaxes this.
 */
export function createPiNativeSessionHost(
  SessionManager: PiSessionManagerStatic,
): PiNativeSessionHostPort {
  const unavailable: PiNativeSessionStorageUnavailable = {
    type: "SessionStorageUnavailable",
    reason: "path-only-session-api",
  };
  // Held, never invoked: the constructors stay unreachable behind the
  // preflight so no path-addressed session is ever created or opened.
  void SessionManager;
  return {
    requireDescriptorSafeSessionIo(): Result<
      void,
      PiNativeSessionStorageUnavailable
    > {
      return err(unavailable);
    },
    create(): PiNativeSessionHandle {
      // Defense in depth only. The store calls the preflight above first, so
      // this is unreachable on every expected path; a caller that bypasses
      // the preflight must not reach `SessionManager.create`.
      throw new Error(
        describePiNativeSessionStorageUnavailable(unavailable.reason),
      );
    },
    open(): PiNativeSessionHandle {
      throw new Error(
        describePiNativeSessionStorageUnavailable(unavailable.reason),
      );
    },
  };
}
