/**
 * Task 4's own concrete no-follow filesystem port for native child sessions.
 *
 * The native session store is defined against the structural
 * {@link PiNativeSessionFsPort} so tests can supply an in-memory fake. This
 * module supplies the one production implementation: real `openat(O_NOFOLLOW)`
 * directory handles with 0700 directories and 0600 files.
 *
 * TEMPORARY DEPENDENCY (Task 16): the libc containment chain currently lives
 * in the legacy JSONL history layer (`child-history-fs.ts`). Rather than fork
 * that syscall code, this module wraps it behind a Task-4-owned surface and
 * narrows its failure set to {@link PiNativeSessionFsError}. The legacy layer's
 * only extra failure, `empty-session-id`, cannot arise here because no session
 * identity is ever passed to it. Task 16 removes the JSONL store outright; at
 * that point the containment chain moves into this module and the import
 * below disappears. Nothing else in the native session path imports the
 * legacy layer, so that move is a single-file change.
 */

import type { ResultAsync } from "neverthrow";
import type {
  PiNativeSessionDirectory,
  PiNativeSessionFsError,
  PiNativeSessionFsPort,
} from "./child-native-sessions.js";
import {
  BunPiChildHistoryFs,
  type PiChildHistoryDirectory,
  type PiChildHistoryFsError,
  type PiChildHistoryFsPort,
} from "./child-history-fs.js";

/**
 * Narrows one legacy filesystem failure to the native session failure set.
 * `empty-session-id` is unreachable through this port - it is only ever
 * produced by the legacy layer's session-identity helpers, which this port
 * never calls - so it is mapped to the closed `io` failure rather than
 * widening the native error union with a legacy-only discriminant.
 */
function narrowFsError(error: PiChildHistoryFsError): PiNativeSessionFsError {
  if (error.type === "empty-session-id") return { type: "io" };
  return error;
}

function adaptDirectory(
  directory: PiChildHistoryDirectory,
): PiNativeSessionDirectory {
  return {
    path: directory.path,
    readFile: (name) => directory.readFile(name).mapErr(narrowFsError),
    appendFile: (name, bytes, mode) =>
      directory.appendFile(name, bytes, mode).mapErr(narrowFsError),
    deleteFile: (name) => directory.deleteFile(name).mapErr(narrowFsError),
    close: () => directory.close(),
  };
}

/**
 * Wraps any structural legacy filesystem port as a native session port. Kept
 * separate from {@link createBunPiNativeSessionFs} so tests can drive the same
 * production adapter with the legacy in-memory fake.
 */
export function adaptPiNativeSessionFs(
  port: PiChildHistoryFsPort,
): PiNativeSessionFsPort {
  return {
    openDirectory: (
      path: string,
      create: boolean,
    ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError> =>
      port.openDirectory(path, create).map(adaptDirectory).mapErr(narrowFsError),
  };
}

/** The production no-follow filesystem port for native child sessions. */
export function createBunPiNativeSessionFs(): PiNativeSessionFsPort {
  return adaptPiNativeSessionFs(new BunPiChildHistoryFs());
}
