/**
 * Unforgeable launch grants for Pi-native child sessions (Spec 33
 * path-session design §5.3 / R5).
 *
 * A child process may only be started against a session file the adapter
 * itself minted through Pi's own `SessionManager` inside the validated Weave
 * session root. Before this module existed, the RPC transport accepted a
 * caller-constructed `{ sessionDir, sessionPath }` pair and re-validated it
 * structurally, which meant any public caller could ask Weave to launch `pi`
 * against an arbitrary absolute path that merely *looked* like an immediate
 * child of some directory it also supplied.
 *
 * A grant closes that hole. Grant payloads live in a module-private
 * `WeakMap`, keyed by an opaque token object this module alone constructs, so
 * a value that was not minted here carries no payload and can never be
 * redeemed. Minting requires a launch authority (itself only constructible
 * here, and only over a validated absolute session root), and every minted
 * grant is bound to:
 *
 * - the validated session root of that authority,
 * - the validated immediate-child session directory,
 * - the exact validated session file inside it,
 * - the session identity (Weave child id, Pi session id, root-relative ref,
 *   active leaf id).
 *
 * Redemption additionally requires the redeeming caller to present the *same*
 * authority object the grant was minted from and the child id the grant names,
 * so a grant minted for one generation or one child cannot launch another.
 *
 * Nothing here is exported from the package entry point: grants are an
 * adapter-internal seam, and rejection reasons are bounded, path-free strings.
 */

import { err, ok, type Result } from "neverthrow";

/** Bounds on the identity strings a grant may carry. */
const MAX_GRANT_ID_BYTES = 256;
/** Bound on one path component the adapter accepts inside the session root. */
const MAX_PATH_COMPONENT_LENGTH = 128;
/** Bound on a whole validated absolute path. */
const MAX_PATH_LENGTH = 4_096;
/** Upper bound on a replay checkpoint cursor. */
const MAX_CHECKPOINT_CURSOR = Number.MAX_SAFE_INTEGER;
/** Every component the adapter creates or accepts under the session root. */
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;

const grantIdEncoder = new TextEncoder();

/**
 * Opaque, adapter-minted proof that one specific child may be launched
 * against one specific validated native session. Callers cannot read or
 * reconstruct its contents; only {@link redeemPiChildSessionLaunchGrant} can.
 */
export interface PiChildSessionLaunchGrant {
  /** Structural marker only. The real payload is private to this module. */
  readonly kind: "pi-child-session-launch-grant";
}

/**
 * Opaque proof that a validated Weave session root exists for one generation.
 * Only {@link createPiChildSessionLaunchAuthority} constructs one, so a
 * structurally similar object minted elsewhere is rejected.
 */
export interface PiChildSessionLaunchAuthority {
  /** Generation/startup scope this authority belongs to. Informational. */
  readonly scopeId: string;
  /** Validated absolute session root every grant must live under. */
  readonly sessionRoot: string;
}

/** Everything a validated launch needs, recovered only by redemption. */
export interface PiChildSessionLaunchDetails {
  readonly childId: string;
  readonly sessionId: string;
  /** Root-relative `<component>/<basename>` reference. */
  readonly ref: string;
  readonly sessionDir: string;
  readonly sessionPath: string;
  readonly activeLeafId: string;
  readonly checkpointCursor?: number;
}

/** Bounded, path-free rejection reasons. Never carries a validated path. */
export type PiChildSessionLaunchRejection =
  | "authority-unrecognized"
  | "authority-mismatch"
  | "grant-unrecognized"
  | "child-mismatch"
  | "invalid-session-root"
  | "invalid-identity"
  | "invalid-session-path"
  | "session-path-not-in-root"
  | "invalid-ref"
  | "invalid-checkpoint-cursor";

/** Authorities this module minted. Membership is the only proof of validity. */
const LAUNCH_AUTHORITIES = new WeakSet<PiChildSessionLaunchAuthority>();

/** Grant payloads, keyed by the opaque token handed to the caller. */
const GRANT_PAYLOADS = new WeakMap<
  PiChildSessionLaunchGrant,
  {
    readonly authority: PiChildSessionLaunchAuthority;
    readonly details: PiChildSessionLaunchDetails;
  }
>();

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    grantIdEncoder.encode(value).byteLength <= MAX_GRANT_ID_BYTES
  );
}

function isSafeComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PATH_COMPONENT_LENGTH &&
    SAFE_PATH_COMPONENT.test(value)
  );
}

/**
 * Accepts only a canonical absolute path: no NUL, no backslash, no empty,
 * `.` or `..` component, no trailing separator, and bounded length.
 */
function isCanonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  const components = value.split("/").slice(1);
  return components.every(
    (component) =>
      component.length > 0 && component !== "." && component !== "..",
  );
}

function splitLastComponent(path: string): {
  readonly parent: string;
  readonly base: string;
} {
  const separator = path.lastIndexOf("/");
  return {
    parent: separator <= 0 ? "/" : path.slice(0, separator),
    base: path.slice(separator + 1),
  };
}

/**
 * Builds the one launch authority a generation may mint grants from.
 *
 * The session root is validated here so a grant can never be bound to a
 * relative, traversing, or otherwise non-canonical root.
 */
export function createPiChildSessionLaunchAuthority(input: {
  readonly scopeId: string;
  readonly sessionRoot: string;
}): Result<PiChildSessionLaunchAuthority, PiChildSessionLaunchRejection> {
  if (
    !isCanonicalAbsolutePath(input.sessionRoot) ||
    input.sessionRoot === "/"
  ) {
    return err("invalid-session-root");
  }
  if (!isBoundedId(input.scopeId)) return err("invalid-identity");
  const authority: PiChildSessionLaunchAuthority = Object.freeze({
    scopeId: input.scopeId,
    sessionRoot: input.sessionRoot,
  });
  LAUNCH_AUTHORITIES.add(authority);
  return ok(authority);
}

/** True only for an authority this module minted. */
export function isPiChildSessionLaunchAuthority(
  value: unknown,
): value is PiChildSessionLaunchAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    LAUNCH_AUTHORITIES.has(value as PiChildSessionLaunchAuthority)
  );
}

/**
 * Mints one launch grant after proving the session file is the exact
 * immediate child of an immediate-child directory of the authority's
 * validated root, and that the ref, ids, and cursor are bounded.
 */
export function mintPiChildSessionLaunchGrant(
  authority: PiChildSessionLaunchAuthority,
  details: PiChildSessionLaunchDetails,
): Result<PiChildSessionLaunchGrant, PiChildSessionLaunchRejection> {
  if (!isPiChildSessionLaunchAuthority(authority)) {
    return err("authority-unrecognized");
  }
  if (
    !isBoundedId(details.childId) ||
    !isBoundedId(details.sessionId) ||
    !isBoundedId(details.activeLeafId)
  ) {
    return err("invalid-identity");
  }
  if (
    !isCanonicalAbsolutePath(details.sessionDir) ||
    !isCanonicalAbsolutePath(details.sessionPath)
  ) {
    return err("invalid-session-path");
  }
  const leaf = splitLastComponent(details.sessionPath);
  if (leaf.parent !== details.sessionDir) return err("invalid-session-path");
  if (!isSafeComponent(leaf.base) || !leaf.base.endsWith(".jsonl")) {
    return err("invalid-session-path");
  }
  const directory = splitLastComponent(details.sessionDir);
  // Containment is canonical immediate-child equality against the validated
  // root, never a prefix test: `<root>-sibling/...` and `<root>/a/b/leaf`
  // both fail here.
  if (directory.parent !== authority.sessionRoot) {
    return err("session-path-not-in-root");
  }
  if (!isSafeComponent(directory.base)) return err("session-path-not-in-root");
  if (details.ref !== `${directory.base}/${leaf.base}`)
    return err("invalid-ref");
  if (details.checkpointCursor !== undefined) {
    const cursor = details.checkpointCursor;
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > MAX_CHECKPOINT_CURSOR
    ) {
      return err("invalid-checkpoint-cursor");
    }
  }
  const grant: PiChildSessionLaunchGrant = Object.freeze({
    kind: "pi-child-session-launch-grant" as const,
  });
  GRANT_PAYLOADS.set(grant, {
    authority,
    details: Object.freeze({
      childId: details.childId,
      sessionId: details.sessionId,
      ref: details.ref,
      sessionDir: details.sessionDir,
      sessionPath: details.sessionPath,
      activeLeafId: details.activeLeafId,
      ...(details.checkpointCursor === undefined
        ? {}
        : { checkpointCursor: details.checkpointCursor }),
    }),
  });
  return ok(grant);
}

/**
 * Recovers the validated launch details from a grant.
 *
 * Fails closed for a forged token, a grant minted by a different authority
 * (a different generation, or a caller-built look-alike), or a grant that
 * names a different child than the one attempting to launch.
 */
export function redeemPiChildSessionLaunchGrant(
  grant: unknown,
  expected: {
    readonly childId: string;
    readonly authority: unknown;
  },
): Result<PiChildSessionLaunchDetails, PiChildSessionLaunchRejection> {
  if (typeof grant !== "object" || grant === null) {
    return err("grant-unrecognized");
  }
  const payload = GRANT_PAYLOADS.get(grant as PiChildSessionLaunchGrant);
  if (payload === undefined) return err("grant-unrecognized");
  if (!isPiChildSessionLaunchAuthority(expected.authority)) {
    return err("authority-unrecognized");
  }
  if (payload.authority !== expected.authority)
    return err("authority-mismatch");
  if (payload.details.childId !== expected.childId)
    return err("child-mismatch");
  return ok(payload.details);
}

/** Bounded, path-free description used on closed transport failures. */
export function describePiChildSessionLaunchRejection(
  rejection: PiChildSessionLaunchRejection,
): string {
  return `invalid session launch grant: ${rejection}`;
}
