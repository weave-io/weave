/**
 * Test-only native session host.
 *
 * Production Pi 0.83 addresses sessions only by caller-supplied filesystem
 * path, so {@link createPiNativeSessionHost} always fails its storage-authority
 * preflight and never reaches `SessionManager`. Deep tests that must exercise
 * the real `SessionManager` create/open behaviour against a temporary tree opt
 * in here, explicitly and by name.
 *
 * This module lives under `__tests__/` and is never exported from the package
 * entry point, so no production code path can reach it.
 */

import { ok, type Result } from "neverthrow";

import type {
  PiNativeSessionHostPort,
  PiNativeSessionStorageUnavailable,
} from "../../child-native-sessions.js";
import {
  adaptPiSessionManagerHandle,
  type PiSessionManagerStatic,
} from "../../native-session-host.js";

/**
 * Wraps Pi's real `SessionManager` and asserts descriptor-safe storage. The
 * assertion is a test fixture claim, not a proof: callers must point the store
 * at a private temporary root they own for the duration of the test.
 */
export function createTestOnlyDescriptorSafeNativeSessionHost(
  SessionManager: PiSessionManagerStatic,
): PiNativeSessionHostPort {
  return {
    requireDescriptorSafeSessionIo(): Result<
      void,
      PiNativeSessionStorageUnavailable
    > {
      return ok(undefined);
    },
    create(cwd, sessionDir, options) {
      return adaptPiSessionManagerHandle(
        SessionManager.create(cwd, sessionDir, options),
      );
    },
    open(path, sessionDir) {
      return adaptPiSessionManagerHandle(SessionManager.open(path, sessionDir));
    },
  };
}
