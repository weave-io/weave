/**
 * Native-session authority for private RPC child launches (Pi adapter
 * contract, Spec 33 path-session design §5.6).
 *
 * A persistent or restored child is started against an adapter-minted launch
 * grant that Pi's own `SessionManager` produced inside the validated Weave
 * session root. That mint is the only way the adapter can prove a child
 * writes into storage it owns, so the child transport refuses to interpret a
 * grant, build any argument vector, take any lease, open any control channel,
 * or spawn any process until this authority proves that:
 *
 * 1. the installed Pi host exposes the public `SessionManager` create/open
 *    constructors (`pi-session-api-unavailable` otherwise),
 * 2. the adapter-owned session root resolved (`pi-session-root-unavailable`)
 *    and passed its safety checks (`pi-session-root-unsafe`),
 * 3. a child process launch surface exists (`pi-process-unavailable`).
 *
 * Exactly one authority is created per generation and handed, by name, to
 * every consumer: thread sources, the session store that mints grants, the
 * delegation controller, direct dispatch, and each `PiRpcChild`. Grant
 * redemption compares authority identity, so readiness and launch can no
 * longer disagree: if readiness says ready, the same object that proved it is
 * the object the launch path consumes.
 *
 * The production implementation reads no environment variable, configuration
 * key, or flag of its own. A test-only double lives under `__tests__/` and is
 * never exported from the package entry point.
 */

import { err, ok, okAsync, type Result, type ResultAsync } from "neverthrow";

import {
  type PiNativeSessionRootInput,
  type PiNativeSessionRootViolation,
  type PiNativeSessionStorageUnavailable,
  type PiNativeSessionStorageUnavailableReason,
  resolvePiNativeSessionRoot,
} from "./child-native-sessions.js";
import {
  createPiChildSessionLaunchAuthority,
  type PiChildSessionLaunchAuthority,
} from "./child-session-launch.js";
import { isPiSessionManagerStatic } from "./native-session-host.js";

/**
 * The closed, path-free set of reasons delegation readiness may report
 * (Spec 33 path-session design §5.6).
 */
export type PiChildSessionReadinessReason =
  | "pi-session-api-unavailable"
  | "pi-session-root-unavailable"
  | "pi-session-root-unsafe"
  | "pi-process-unavailable";

/**
 * The one question a child launch asks before it does anything observable:
 * may this process persist session bytes into storage this adapter can prove
 * it owns, and may it launch a child against that storage?
 */
export interface PiChildSessionStorageAuthority {
  /**
   * `ok` only when the installed Pi host exposes the public session
   * create/open constructors and the adapter-owned session root is proven.
   */
  requireNativeSessionAuthority(): Result<
    void,
    PiNativeSessionStorageUnavailable
  >;
  /**
   * `ok` only when session storage *and* the child process launch surface
   * are proven. The returned authority is the single generation-scoped
   * object every grant is minted from and redeemed against.
   */
  requireLaunchAuthority(): Result<
    PiChildSessionLaunchAuthority,
    PiNativeSessionStorageUnavailable
  >;
  /**
   * Path-free readiness verdict for capability probing. `undefined` means
   * ready; otherwise exactly one of the four closed reasons.
   */
  readinessReason(): PiChildSessionReadinessReason | undefined;
}

/** How the adapter-owned session root resolved for this generation. */
export type PiChildSessionRootResolution =
  | { readonly status: "resolved"; readonly root: string }
  | { readonly status: "unavailable" }
  | { readonly status: "unsafe" };

function unavailable(
  reason: PiNativeSessionStorageUnavailableReason,
): PiNativeSessionStorageUnavailable {
  return { type: "SessionStorageUnavailable", reason };
}

/**
 * Bounded, path-free transport reason recorded on the mapped closed transport
 * failure. It names the same reason as the typed
 * {@link PiNativeSessionStorageUnavailable} it maps from, and never carries a
 * filesystem path, a prompt, or transcript bytes.
 */
export const CHILD_SESSION_STORAGE_UNAVAILABLE_REASON =
  "session-storage-unavailable:pi-session-api-unavailable";

/** Which root violations are "unsafe" rather than merely "unavailable". */
const UNSAFE_ROOT_VIOLATIONS: ReadonlySet<PiNativeSessionRootViolation> =
  new Set([
    "non-directory-data-root",
    "foreign-data-root",
    "writable-data-root",
    "unsafe-component",
    "path-escape",
    "symlink-rejected",
  ]);

/**
 * Classifies a session-root failure into the two closed root reasons. A
 * violation that proves the base is hostile or wrongly owned is `unsafe`;
 * anything else (missing home, relative base, unresolvable base, I/O) is
 * `unavailable`.
 */
export function classifyPiChildSessionRootFailure(
  violation: PiNativeSessionRootViolation | undefined,
): PiChildSessionRootResolution {
  return violation !== undefined && UNSAFE_ROOT_VIOLATIONS.has(violation)
    ? { status: "unsafe" }
    : { status: "unavailable" };
}

/** What the production authority inspects. Never an environment or config. */
export interface PiChildSessionStorageAuthorityInput {
  /** Pi's public `SessionManager` export, as the extension received it. */
  readonly SessionManager?: unknown;
  /** How the adapter-owned session root resolved for this generation. */
  readonly sessionRoot?: PiChildSessionRootResolution;
  /** Whether this generation holds a child process launch surface. */
  readonly processAvailable?: boolean;
  /** Generation/startup scope this authority belongs to. */
  readonly scopeId?: string;
}

/**
 * Builds the production authority over the installed Pi host.
 *
 * Every readiness fact is a real check; none defaults to `ok`. A caller that
 * supplies no host, no resolved root, or no process surface gets a refusal
 * naming exactly one closed reason.
 */
export function createPiChildSessionStorageAuthority(
  input: PiChildSessionStorageAuthorityInput = {},
): PiChildSessionStorageAuthority {
  const apiAvailable = isPiSessionManagerStatic(input.SessionManager);
  const rootResolution = input.sessionRoot ?? {
    status: "unavailable" as const,
  };
  const processAvailable = input.processAvailable === true;
  const launchAuthority =
    rootResolution.status === "resolved"
      ? createPiChildSessionLaunchAuthority({
          scopeId: input.scopeId ?? "pi-child-session-authority",
          sessionRoot: rootResolution.root,
        })
      : undefined;

  const storageReason = (): PiChildSessionReadinessReason | undefined => {
    if (!apiAvailable) return "pi-session-api-unavailable";
    if (rootResolution.status === "unsafe") return "pi-session-root-unsafe";
    if (rootResolution.status !== "resolved" || launchAuthority === undefined) {
      return "pi-session-root-unavailable";
    }
    if (launchAuthority.isErr()) return "pi-session-root-unsafe";
    return undefined;
  };
  const readinessReason = (): PiChildSessionReadinessReason | undefined => {
    const storage = storageReason();
    if (storage !== undefined) return storage;
    return processAvailable ? undefined : "pi-process-unavailable";
  };

  return {
    requireNativeSessionAuthority(): Result<
      void,
      PiNativeSessionStorageUnavailable
    > {
      const reason = storageReason();
      return reason === undefined ? ok(undefined) : err(unavailable(reason));
    },
    requireLaunchAuthority(): Result<
      PiChildSessionLaunchAuthority,
      PiNativeSessionStorageUnavailable
    > {
      const reason = readinessReason();
      if (reason !== undefined) return err(unavailable(reason));
      // `readinessReason` already proved the authority minted; this branch is
      // unreachable and stays fail-closed rather than asserting.
      if (launchAuthority === undefined || launchAuthority.isErr()) {
        return err(unavailable("pi-session-root-unavailable"));
      }
      return ok(launchAuthority.value);
    },
    readinessReason,
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
  if (failure.reason === "filesystem-unavailable") {
    return "session-storage-unavailable:filesystem-unavailable";
  }
  return `session-storage-unavailable:${failure.reason}`;
}

/**
 * Resolves the adapter-owned session root for one generation and reduces the
 * outcome to the two closed root states. Never throws, never returns a
 * failure: an unresolvable or unsafe root is itself the answer, and the raw
 * violation (which can name a host path) stays inside this call.
 */
export function resolvePiChildSessionRoot(
  input: PiNativeSessionRootInput,
): ResultAsync<PiChildSessionRootResolution, never> {
  return resolvePiNativeSessionRoot(input)
    .map((root): PiChildSessionRootResolution => ({ status: "resolved", root }))
    .orElse((error) =>
      okAsync(
        classifyPiChildSessionRootFailure(
          error.type === "SessionRootViolation" ? error.reason : undefined,
        ),
      ),
    );
}
