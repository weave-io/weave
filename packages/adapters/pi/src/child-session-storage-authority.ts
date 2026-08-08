/**
 * Storage authority for private RPC child launches (Pi adapter contract).
 *
 * A persistent or restored child is started by handing `pi` a caller-supplied
 * `--session-dir` / `--session` filesystem path. Pi 0.83 exposes no
 * descriptor-relative session API, so the adapter cannot prove that the bytes
 * such a child writes land in the descriptor-verified, Weave-owned session
 * tree. The child transport therefore refuses to interpret any session path,
 * build any argument vector, take any lease, open any control channel, or
 * spawn any process until an injected authority proves descriptor-safe
 * session I/O.
 *
 * This authority is deliberately independent of the top-level capability gate
 * added in phase A and of the native-session host preflight: a caller that
 * reaches `PiRpcChild` directly, bypassing both, still fails closed here.
 *
 * The production implementation always refuses. There is no option,
 * environment variable, configuration key, or flag that enables it. Only a
 * test-only double, which lives under `__tests__/` and is never exported from
 * the package entry point, may report descriptor-safe storage.
 */

import { err, type Result } from "neverthrow";

import type { PiNativeSessionStorageUnavailable } from "./child-native-sessions.js";

/**
 * The one question a child launch asks before it does anything observable:
 * may this process persist session bytes into storage this adapter can prove
 * it owns?
 */
export interface PiChildSessionStorageAuthority {
  /**
   * `ok` only when session I/O is descriptor-safe. The production
   * implementation always fails with `path-only-session-api`.
   */
  requireDescriptorSafeSessionIo(): Result<
    void,
    PiNativeSessionStorageUnavailable
  >;
}

/** The single production refusal, shared by every production authority. */
const PATH_ONLY_UNAVAILABLE: PiNativeSessionStorageUnavailable = {
  type: "SessionStorageUnavailable",
  reason: "path-only-session-api",
};

/**
 * Bounded, path-free transport reason recorded on the mapped closed transport
 * failure. It names the same reason as the typed
 * {@link PiNativeSessionStorageUnavailable} it maps from, and never carries a
 * filesystem path, a prompt, or transcript bytes.
 */
export const CHILD_SESSION_STORAGE_UNAVAILABLE_REASON =
  "session-storage-unavailable:path-only-session-api";

/**
 * Builds the production authority. It takes no arguments, reads no
 * environment, and consults no configuration: it always refuses, because the
 * exact tested host (Pi 0.83.0) addresses sessions only by caller-supplied
 * filesystem path.
 */
export function createPiChildSessionStorageAuthority(): PiChildSessionStorageAuthority {
  return {
    requireDescriptorSafeSessionIo(): Result<
      void,
      PiNativeSessionStorageUnavailable
    > {
      return err(PATH_ONLY_UNAVAILABLE);
    },
  };
}

/**
 * Maps the typed storage refusal onto the bounded transport reason string
 * carried by the closed child transport failure. Total over the closed reason
 * set, so a future reason cannot silently degrade into an unbounded string.
 */
export function describeChildSessionStorageUnavailable(
  failure: PiNativeSessionStorageUnavailable,
): string {
  return failure.reason === "path-only-session-api"
    ? CHILD_SESSION_STORAGE_UNAVAILABLE_REASON
    : "session-storage-unavailable:filesystem-unavailable";
}
