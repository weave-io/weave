/**
 * Native-session authority for private RPC child launches (Pi adapter
 * contract).
 *
 * A persistent or restored child is started by handing `pi` an adapter-owned
 * `--session-dir` / `--session` path pair that Pi's own `SessionManager`
 * minted. That mint is the only way the adapter can prove a child writes into
 * the validated Weave session tree, so the child transport refuses to
 * interpret any session path, build any argument vector, take any lease, open
 * any control channel, or spawn any process until this authority proves the
 * real Pi session API is present.
 *
 * The authority is deliberately independent of the top-level capability gate:
 * a caller that reaches `PiRpcChild` directly, bypassing readiness, still
 * fails closed here.
 *
 * The production implementation reads no environment variable, configuration
 * key, or flag. It answers `ok` only for a host that exposes the public
 * `SessionManager.create` / `SessionManager.open` constructors. A test-only
 * double, which lives under `__tests__/` and is never exported from the
 * package entry point, may answer `ok` without a host.
 */

import { err, ok, type Result } from "neverthrow";

import type { PiNativeSessionStorageUnavailable } from "./child-native-sessions.js";
import { isPiSessionManagerStatic } from "./native-session-host.js";

/**
 * The one question a child launch asks before it does anything observable:
 * may this process persist session bytes into storage this adapter can prove
 * it owns?
 */
export interface PiChildSessionStorageAuthority {
  /**
   * `ok` only when the installed Pi host exposes the public session
   * create/open constructors the adapter mints child sessions through.
   */
  requireNativeSessionAuthority(): Result<
    void,
    PiNativeSessionStorageUnavailable
  >;
}

/** The single production refusal, shared by every production authority. */
const SESSION_API_UNAVAILABLE: PiNativeSessionStorageUnavailable = {
  type: "SessionStorageUnavailable",
  reason: "pi-session-api-unavailable",
};

/**
 * Bounded, path-free transport reason recorded on the mapped closed transport
 * failure. It names the same reason as the typed
 * {@link PiNativeSessionStorageUnavailable} it maps from, and never carries a
 * filesystem path, a prompt, or transcript bytes.
 */
export const CHILD_SESSION_STORAGE_UNAVAILABLE_REASON =
  "session-storage-unavailable:pi-session-api-unavailable";

/** What the production authority inspects. Never an environment or config. */
export interface PiChildSessionStorageAuthorityInput {
  /** Pi's public `SessionManager` export, as the extension received it. */
  readonly SessionManager?: unknown;
}

/**
 * Builds the production authority over the installed Pi host.
 *
 * It performs one real readiness check — the public `SessionManager`
 * create/open constructors are callable — and never returns an unconditional
 * `ok`. A caller that supplies no host gets a refusal.
 */
export function createPiChildSessionStorageAuthority(
  input: PiChildSessionStorageAuthorityInput = {},
): PiChildSessionStorageAuthority {
  const available = isPiSessionManagerStatic(input.SessionManager);
  return {
    requireNativeSessionAuthority(): Result<
      void,
      PiNativeSessionStorageUnavailable
    > {
      return available ? ok(undefined) : err(SESSION_API_UNAVAILABLE);
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
  return failure.reason === "pi-session-api-unavailable"
    ? CHILD_SESSION_STORAGE_UNAVAILABLE_REASON
    : "session-storage-unavailable:filesystem-unavailable";
}
