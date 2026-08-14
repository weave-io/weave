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
 * 2. the adapter-owned session root was *proven* by really opening it with
 *    `openat(O_NOFOLLOW)` through the production filesystem port - not merely
 *    resolved as a string - so an absent, uncreatable, symlinked, wrongly
 *    typed, permissively moded, swapped, or unreadable root reports
 *    `pi-session-root-unavailable` or `pi-session-root-unsafe`,
 * 3. a child process launch surface exists (`pi-process-unavailable`).
 *
 * Every fact is derived here from a real object or a real syscall. The
 * authority accepts no asserted boolean and no asserted path: the root
 * arrives as an opaque proof this module alone mints, and the process surface
 * arrives as the launch port itself, whose `spawn` this module checks.
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
  PI_NATIVE_SESSION_LAYOUT,
  type PiNativeSessionError,
  type PiNativeSessionFsError,
  type PiNativeSessionFsPort,
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
   * The proven adapter-owned session root, for the seams that must construct
   * storage over it (the session store, the CLI ports). `err` whenever the
   * root was not proven, so no seam can build storage over an asserted path.
   */
  requireSessionRoot(): Result<string, PiNativeSessionStorageUnavailable>;
  /**
   * Path-free readiness verdict for capability probing. `undefined` means
   * ready; otherwise exactly one of the four closed reasons.
   */
  readinessReason(): PiChildSessionReadinessReason | undefined;
}

/**
 * Opaque proof of how the adapter-owned session root really behaved this
 * generation.
 *
 * Only {@link provePiChildSessionRoot} constructs one, and only after a real
 * no-follow `openat` of the root through the injected filesystem port. The
 * root path itself lives in a module-private table, so a caller cannot read
 * it off the proof, and a structurally similar `{ status: "resolved" }`
 * object asserted by a caller carries no proof at all and is refused.
 */
export interface PiChildSessionRootProof {
  /** Structural marker only; the proven root is private to this module. */
  readonly status: "resolved" | "unavailable" | "unsafe";
}

/** Proofs this module minted. Membership is the only evidence of validity. */
const ROOT_PROOFS = new WeakMap<PiChildSessionRootProof, string | undefined>();

function mintRootProof(
  status: PiChildSessionRootProof["status"],
  root?: string,
): PiChildSessionRootProof {
  const proof: PiChildSessionRootProof = Object.freeze({ status });
  ROOT_PROOFS.set(proof, root);
  return proof;
}

/**
 * Reads a minted proof. An unrecognized object - including a caller-built
 * `{ status: "resolved" }` - reads as `unavailable`, never as resolved.
 */
function readRootProof(proof: PiChildSessionRootProof | undefined): {
  readonly status: PiChildSessionRootProof["status"];
  readonly root?: string;
} {
  if (proof === undefined || !ROOT_PROOFS.has(proof)) {
    return { status: "unavailable" };
  }
  const root = ROOT_PROOFS.get(proof);
  if (proof.status !== "resolved" || root === undefined) {
    return { status: proof.status === "unsafe" ? "unsafe" : "unavailable" };
  }
  return { status: "resolved", root };
}

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
 * Classifies a session-root failure into the two closed root states. A
 * violation that proves the base is hostile or wrongly owned is `unsafe`;
 * anything else (missing home, relative base, unresolvable base, I/O) is
 * `unavailable`.
 */
function classifyRootViolation(
  violation: PiNativeSessionRootViolation | undefined,
): "unsafe" | "unavailable" {
  return violation !== undefined && UNSAFE_ROOT_VIOLATIONS.has(violation)
    ? "unsafe"
    : "unavailable";
}

/**
 * Which filesystem refusals prove the root is hostile rather than merely
 * absent or unreachable. A symlinked, wrongly-typed, group/world-readable,
 * foreign-owned, or swapped root - at the root itself or at any adapter-owned
 * ancestor the no-follow chain proves - is unsafe; a missing or unwritable one
 * is unavailable.
 */
function classifyRootFsError(
  error: PiNativeSessionFsError,
): "unsafe" | "unavailable" {
  switch (error.type) {
    case "symlink-rejected":
    case "unsafe-path":
    case "permissive-mode":
    case "foreign-owner":
    case "wrong-kind":
    case "identity-changed":
      return "unsafe";
    default:
      return "unavailable";
  }
}

/** What the production authority inspects. Never an environment or config. */
export interface PiChildSessionStorageAuthorityInput {
  /** Pi's public `SessionManager` export, as the extension received it. */
  readonly SessionManager?: unknown;
  /**
   * The proof {@link provePiChildSessionRoot} produced for this generation.
   * Absent or unrecognized means "not proven", which is a refusal.
   */
  readonly sessionRoot?: PiChildSessionRootProof;
  /**
   * The child process launch surface this generation holds, as the extension
   * received it. The authority checks for a callable `spawn` itself rather
   * than trusting a caller-asserted boolean.
   */
  readonly processLaunch?: unknown;
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
  const rootResolution = readRootProof(input.sessionRoot);
  const spawn = (input.processLaunch as { spawn?: unknown } | undefined)?.spawn;
  const processAvailable = typeof spawn === "function";
  const launchAuthority =
    rootResolution.status === "resolved" && rootResolution.root !== undefined
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
    requireSessionRoot(): Result<string, PiNativeSessionStorageUnavailable> {
      const reason = storageReason();
      if (reason !== undefined) return err(unavailable(reason));
      const root = rootResolution.root;
      if (root === undefined) {
        return err(unavailable("pi-session-root-unavailable"));
      }
      return ok(root);
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
 * Proves the adapter-owned session root for one generation.
 *
 * Resolution alone was never a proof: it only canonicalized the XDG base and
 * appended fixed segments, so a root that did not exist, could not be
 * created, was a symlink or a file, was group/world-accessible, or was swapped
 * underneath us all reported "resolved", and readiness could promise a spawn
 * authority no launch could obtain.
 *
 * This performs the real check the launch path performs: it opens the root
 * itself through the injected no-follow filesystem port, creating it when
 * absent, and immediately closes the descriptor. The outcome is reduced to
 * the two closed states and returned as an opaque proof. Never throws and
 * never fails: an unusable root is itself the answer, and the raw violation
 * (which can name a host path) never leaves this call.
 */
export function provePiChildSessionRoot(
  input: PiNativeSessionRootInput & {
    readonly fs: PiNativeSessionFsPort;
    /**
     * An adapter-owned root supplied directly instead of derived from the
     * environment. It changes *derivation* only: the root is still proven by
     * the same real no-follow open below, so no caller can assert that a root
     * is usable. Production never passes it; unit embeddings that model a
     * synthetic tree do.
     */
    readonly root?: string;
  },
): ResultAsync<PiChildSessionRootProof, never> {
  const resolved =
    input.root === undefined
      ? resolvePiNativeSessionRoot(input)
      : okAsync<string, PiNativeSessionError>(input.root);
  return resolved
    .orElse((error) =>
      okAsync(
        mintRootProof(
          classifyRootViolation(
            error.type === "SessionRootViolation" ? error.reason : undefined,
          ),
        ),
      ),
    )
    .andThen((resolved) => {
      if (typeof resolved !== "string") return okAsync(resolved);
      return input.fs
        .openDirectory(resolved, true)
        .andThen((directory) =>
          // One descriptor-relative probe of the ledger the store itself
          // uses. It costs nothing when absent, and it forces the port's
          // held-descriptor identity, symlink, kind, and mode checks to run
          // now rather than at the first launch.
          directory
            .statFile(PI_NATIVE_SESSION_LAYOUT.tombstoneFile)
            .map(() => {
              directory.close();
              return mintRootProof("resolved", resolved);
            })
            .mapErr((error) => {
              directory.close();
              return error;
            }),
        )
        .orElse((error) => okAsync(mintRootProof(classifyRootFsError(error))));
    });
}
