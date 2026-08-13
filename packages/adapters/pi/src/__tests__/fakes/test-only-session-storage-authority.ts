import type { Result } from "neverthrow";
import {
  mintPiChildSessionLaunchGrant,
  type PiChildSessionLaunchGrant,
  type PiChildSessionLaunchRejection,
} from "../../child-session-launch.js";
import type { PiChildSessionStorageAuthority } from "../../child-session-storage-authority.js";
import { createPiChildSessionStorageAuthority } from "../../child-session-storage-authority.js";

/**
 * Test-only native-session authority.
 *
 * Production binds one generation-scoped authority to the installed Pi host's
 * public `SessionManager`, the resolved Weave session root, and the child
 * process launch surface. Tests that exercise a launch or ref mutation
 * without a real host opt in here, explicitly and by name, through the same
 * production factory with modelled inputs. This module lives under
 * `__tests__/` and is never exported from the package entry point.
 */

/** The session root the default test authority is bound to. */
export const TEST_ONLY_SESSION_ROOT = "/data/weave/adapters/pi/sessions";

const FAKE_SESSION_MANAGER = {
  create: () => {
    throw new Error("test-only session manager is not callable");
  },
  open: () => {
    throw new Error("test-only session manager is not callable");
  },
};

/** Builds a granted authority bound to `root`. */
export function createTestOnlyGrantedSessionStorageAuthority(
  root: string = TEST_ONLY_SESSION_ROOT,
): PiChildSessionStorageAuthority {
  return createPiChildSessionStorageAuthority({
    SessionManager: FAKE_SESSION_MANAGER,
    sessionRoot: { status: "resolved", root },
    processAvailable: true,
    scopeId: "test-only-authority",
  });
}

export const TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY: PiChildSessionStorageAuthority =
  createTestOnlyGrantedSessionStorageAuthority();

/**
 * Mints a launch grant the way the session store does, so a transport test
 * can launch without standing up a real store. Throws only when the test
 * itself supplied an invalid combination, which is a test bug.
 */
export function tryMintTestOnlyLaunchGrant(
  authority: PiChildSessionStorageAuthority,
  details: {
    readonly childId: string;
    readonly sessionId?: string;
    readonly ref?: string;
    readonly sessionDir: string;
    readonly sessionPath: string;
    readonly activeLeafId?: string;
    readonly checkpointCursor?: number;
  },
): Result<PiChildSessionLaunchGrant, PiChildSessionLaunchRejection> {
  const launchAuthority = authority.requireLaunchAuthority();
  if (launchAuthority.isErr()) {
    throw new Error(
      `test-only launch authority unavailable: ${launchAuthority.error.reason}`,
    );
  }
  const directory = details.sessionDir.slice(
    details.sessionDir.lastIndexOf("/") + 1,
  );
  const leaf = details.sessionPath.slice(
    details.sessionPath.lastIndexOf("/") + 1,
  );
  return mintPiChildSessionLaunchGrant(launchAuthority.value, {
    childId: details.childId,
    sessionId: details.sessionId ?? "session-1",
    ref: details.ref ?? `${directory}/${leaf}`,
    sessionDir: details.sessionDir,
    sessionPath: details.sessionPath,
    activeLeafId: details.activeLeafId ?? "leaf-1",
    ...(details.checkpointCursor === undefined
      ? {}
      : { checkpointCursor: details.checkpointCursor }),
  });
}

/** Same mint, for tests that treat a rejection as their own bug. */
export function mintTestOnlyLaunchGrant(
  authority: PiChildSessionStorageAuthority,
  details: Parameters<typeof tryMintTestOnlyLaunchGrant>[1],
): PiChildSessionLaunchGrant {
  const grant = tryMintTestOnlyLaunchGrant(authority, details);
  if (grant.isErr()) {
    throw new Error(`test-only launch grant rejected: ${grant.error}`);
  }
  return grant.value;
}

/**
 * A granted or refused authority that reports every check, so a test can
 * assert the authority is consulted before any mutation or launch.
 */
export function createTestOnlyObservedSessionStorageAuthority(options: {
  readonly granted: boolean;
  readonly onCheck?: () => void;
  readonly root?: string;
}): PiChildSessionStorageAuthority {
  const granted = options.granted
    ? createTestOnlyGrantedSessionStorageAuthority(options.root)
    : createPiChildSessionStorageAuthority();
  return {
    requireNativeSessionAuthority: () => {
      options.onCheck?.();
      return granted.requireNativeSessionAuthority();
    },
    requireLaunchAuthority: () => {
      options.onCheck?.();
      return granted.requireLaunchAuthority();
    },
    readinessReason: () => granted.readinessReason(),
  };
}
