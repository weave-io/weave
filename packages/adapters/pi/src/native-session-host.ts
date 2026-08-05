/**
 * Concrete Pi 0.83 `SessionManager` adapter for Task 4's native session host
 * port. Production wires the public root export; tests inject a scripted host
 * and never construct this adapter.
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

/** Narrow instance surface Task 4 reads and writes through. */
export interface PiSessionManagerInstance {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getHeader(): {
    readonly id: string;
    readonly cwd: string;
    readonly version?: number;
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
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
    return false;
  }
  const candidate = value as { create?: unknown; open?: unknown };
  return (
    typeof candidate.create === "function" && typeof candidate.open === "function"
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
      return {
        id: header.id,
        cwd: header.cwd,
        ...(header.version === undefined ? {} : { version: header.version }),
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
 * `SessionManager.create(cwd, isolatedDir, options)` and
 * `SessionManager.open(path, sessionDir)` are the only entry points used.
 */
export function createPiNativeSessionHost(
  SessionManager: PiSessionManagerStatic,
): PiNativeSessionHostPort {
  return {
    create(cwd, sessionDir, options) {
      return adaptPiSessionManagerHandle(
        SessionManager.create(cwd, sessionDir, options),
      );
    },
    open(path, sessionDir) {
      return adaptPiSessionManagerHandle(
        SessionManager.open(path, sessionDir),
      );
    },
  };
}
