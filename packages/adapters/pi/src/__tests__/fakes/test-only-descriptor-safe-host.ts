/** Test-only native session host over Pi's public session constructors. */

import type { PiNativeSessionHostPort } from "../../child-native-sessions.js";
import {
  adaptPiSessionManagerHandle,
  type PiSessionManagerStatic,
} from "../../native-session-host.js";

/** Wraps Pi's real `SessionManager` for tests with private temporary roots. */
export function createTestOnlyDescriptorSafeNativeSessionHost(
  SessionManager: PiSessionManagerStatic,
): PiNativeSessionHostPort {
  return {
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
