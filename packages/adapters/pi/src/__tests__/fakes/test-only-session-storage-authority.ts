import { ok } from "neverthrow";
import type { PiChildSessionStorageAuthority } from "../../child-session-storage-authority.js";

/**
 * Test-only native-session authority.
 *
 * Production binds the authority to the installed Pi host's public
 * `SessionManager`. Tests that exercise a launch or ref mutation without a
 * real host opt in here, explicitly and by name. This module lives under
 * `__tests__/` and is never exported from the package entry point.
 */
export const TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY: PiChildSessionStorageAuthority =
  {
    requireNativeSessionAuthority: () => ok(undefined),
  };
