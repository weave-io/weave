/**
 * Pi-native session readiness seam.
 *
 * Activation readiness for delegation is a *proved* fact, never an inference
 * from static command/usage surfaces. Before this generation may activate a
 * primary, materialize descriptors, mutate a session, take an execution lease,
 * build a child transport, or spawn a process, this seam proves three concrete
 * things against the real host:
 *
 * 1. the Pi `SessionManager` create/open constructors this adapter's native
 *    session store actually calls exist on the host,
 * 2. the canonical private session root resolves, initializes, and holds the
 *    Weave-owned 0700 no-follow permissions the store requires, and
 * 3. the process launch surface this adapter would spawn a child through is
 *    real and usable.
 *
 * Any failure yields exactly one closed, path-free reason drawn from
 * {@link PI_DELEGATION_READINESS_UNAVAILABLE_REASONS}. Raw host details, cause
 * values, method names, and filesystem paths never leave this module: they are
 * discarded at the point of failure rather than reformatted.
 *
 * This module performs I/O, so it is deliberately separate from
 * `safe-initializer.ts` (which stays free of filesystem/process/timer calls)
 * and is injected into preflight as a port.
 */

import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { PiDelegationReadinessUnavailableReason } from "./capability-prober.js";
import {
  type PiNativeSessionError,
  type PiNativeSessionFsPort,
  resolvePiNativeSessionRoot,
} from "./child-native-sessions.js";
import type { PiChildProcessPort } from "./child-process-port.js";
import { createBunPiNativeSessionFs } from "./native-session-fs.js";
import { isPiSessionManagerStatic } from "./native-session-host.js";
import type { PiTrustedDataRootPort } from "./trusted-data-root.js";

/**
 * Whether the Pi-native session/process surfaces this generation needs are
 * proved. A negative outcome carries exactly one closed public reason.
 */
export type PiNativeSessionReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason: PiDelegationReadinessUnavailableReason;
    };

/**
 * The injected readiness port preflight consults. Never returns `Err`: an
 * unprovable surface is a readiness *fact* (`ready: false`), not an internal
 * failure, so preflight always produces an inspectable health report.
 */
export interface PiNativeSessionReadinessProbe {
  probe(): ResultAsync<PiNativeSessionReadiness, never>;
}

const READY: PiNativeSessionReadiness = Object.freeze({ ready: true as const });

function unready(
  reason: PiDelegationReadinessUnavailableReason,
): PiNativeSessionReadiness {
  return Object.freeze({ ready: false as const, reason });
}

/**
 * Root violations that mean the canonical private root exists but is not safe
 * to own sessions in (wrong owner, permissive mode, symlinked, escaping, or
 * not a directory) versus violations that mean it cannot be located at all.
 */
const UNSAFE_ROOT_VIOLATIONS: ReadonlySet<string> = new Set([
  "non-directory-data-root",
  "foreign-data-root",
  "writable-data-root",
  "unsafe-component",
  "path-escape",
  "symlink-rejected",
]);

/**
 * Maps a native session root failure onto one closed readiness reason. The
 * incoming error's own reason string is used only to choose between
 * `unavailable` and `unsafe`; it is never propagated.
 */
export function mapSessionRootErrorToReadinessReason(
  error: PiNativeSessionError,
): PiDelegationReadinessUnavailableReason {
  if (error.type === "SessionRootViolation") {
    return UNSAFE_ROOT_VIOLATIONS.has(error.reason)
      ? "pi-session-root-unsafe"
      : "pi-session-root-unavailable";
  }
  if (error.type === "SessionPermissionError") return "pi-session-root-unsafe";
  return "pi-session-root-unavailable";
}

/**
 * Filesystem failures that prove the root is present but unsafe, as opposed to
 * absent/unreachable.
 */
const UNSAFE_FS_FAILURES: ReadonlySet<string> = new Set([
  "permissive-mode",
  "symlink-rejected",
  "wrong-kind",
  "unsafe-path",
  "identity-changed",
]);

/** Maps a root open/initialize filesystem failure onto one closed reason. */
export function mapRootOpenFailureToReadinessReason(
  type: string,
): PiDelegationReadinessUnavailableReason {
  return UNSAFE_FS_FAILURES.has(type)
    ? "pi-session-root-unsafe"
    : "pi-session-root-unavailable";
}

/** Session flags the base child command must never already carry. */
const FORBIDDEN_COMMAND_FLAGS = [
  "--no-session",
  "--session",
  "--session-dir",
  "--continue",
  "--resume",
  "--fork",
] as const;

/**
 * Proves the process launch surface without launching anything: the injected
 * port exposes a callable `spawn`, and the base command names a real
 * executable carrying no session flag (session selection belongs to the child
 * transport alone).
 */
export function isProcessLaunchSurfaceUsable(
  processPort: unknown,
  command: readonly string[] | undefined,
): boolean {
  if (typeof processPort !== "object" || processPort === null) return false;
  if (typeof (processPort as { spawn?: unknown }).spawn !== "function") {
    return false;
  }
  if (command === undefined || command.length === 0) return false;
  for (const argument of command) {
    if (typeof argument !== "string" || argument.length === 0) return false;
    if (
      FORBIDDEN_COMMAND_FLAGS.some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      )
    ) {
      return false;
    }
  }
  return true;
}

export interface CreatePiNativeSessionReadinessProbeOptions {
  /** The process port a child would actually be spawned through. */
  readonly processPort: PiChildProcessPort;
  /** The exact base command a child would be launched with. */
  readonly childCommand: readonly string[];
  /** Pi's session constructors. Production default: the public root export. */
  readonly SessionManager?: unknown;
  /** No-follow directory port. Production default: the real Bun/libc port. */
  readonly fs?: PiNativeSessionFsPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly trustedRoot?: PiTrustedDataRootPort;
  /**
   * Test seam: proves an absolute executable exists. Production reads the real
   * filesystem. A bare command name is never resolved through `PATH` here.
   */
  readonly executableExists?: (path: string) => Promise<boolean>;
}

function defaultExecutableExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/**
 * Builds the production readiness probe. Every proof is read-only except the
 * one-time initialization of Weave's own canonical session root, which the
 * store would otherwise create lazily at the first delegation.
 */
export function createPiNativeSessionReadinessProbe(
  options: CreatePiNativeSessionReadinessProbeOptions,
): PiNativeSessionReadinessProbe {
  return Object.freeze({
    probe(): ResultAsync<PiNativeSessionReadiness, never> {
      const candidate =
        options.SessionManager ??
        (PiPublicExports as { SessionManager?: unknown }).SessionManager;
      if (!isPiSessionManagerStatic(candidate)) {
        return okAsync(unready("pi-session-api-unavailable"));
      }
      if (
        !isProcessLaunchSurfaceUsable(options.processPort, options.childCommand)
      ) {
        return okAsync(unready("pi-process-unavailable"));
      }
      const fs = options.fs ?? createBunPiNativeSessionFs();
      const executableExists =
        options.executableExists ?? defaultExecutableExists;
      const executable = options.childCommand[0] ?? "";

      const rootAndProcessProof = resolvePiNativeSessionRoot({
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        ...(options.trustedRoot === undefined
          ? {}
          : { trustedRoot: options.trustedRoot }),
      })
        .mapErr(mapSessionRootErrorToReadinessReason)
        .andThen((root) =>
          fs
            .openDirectory(root, true)
            .mapErr((error) => mapRootOpenFailureToReadinessReason(error.type))
            .map((directory) => {
              directory.close();
              return undefined;
            }),
        )
        .andThen(() =>
          // An absolute executable is exact host identity and must really
          // exist; a bare name is never probed through `PATH`.
          executable.startsWith("/")
            ? probeExecutable(executableExists, executable)
            : okAsync<undefined, PiDelegationReadinessUnavailableReason>(
                undefined,
              ),
        );

      // Readiness is a fact, not a failure: every closed reason is projected
      // into the `ready: false` outcome rather than an `Err`.
      return ResultAsync.fromSafePromise(
        rootAndProcessProof.match(
          () => READY,
          (reason) => unready(reason),
        ),
      );
    },
  });
}

/**
 * Wraps the existence probe so a rejected or throwing filesystem check becomes
 * the closed process reason instead of an unhandled rejection. The thrown value
 * is discarded, never inspected or reformatted.
 */
function probeExecutable(
  exists: (path: string) => Promise<boolean>,
  executable: string,
): ResultAsync<undefined, PiDelegationReadinessUnavailableReason> {
  return ResultAsync.fromPromise(
    exists(executable),
    (): PiDelegationReadinessUnavailableReason => "pi-process-unavailable",
  ).andThen((present) =>
    present
      ? okAsync<undefined, PiDelegationReadinessUnavailableReason>(undefined)
      : errAsync<undefined, PiDelegationReadinessUnavailableReason>(
          "pi-process-unavailable",
        ),
  );
}

/** A readiness probe that always reports one closed reason. Fail-closed default. */
export function createBlockedPiNativeSessionReadinessProbe(
  reason: PiDelegationReadinessUnavailableReason = "pi-session-api-unavailable",
): PiNativeSessionReadinessProbe {
  return Object.freeze({
    probe: (): ResultAsync<PiNativeSessionReadiness, never> =>
      okAsync(unready(reason)),
  });
}

/**
 * A readiness probe that reports proved readiness. Only test doubles and
 * already-proved call sites use it; production always derives readiness from
 * {@link createPiNativeSessionReadinessProbe}.
 */
export function createReadyPiNativeSessionReadinessProbe(): PiNativeSessionReadinessProbe {
  return Object.freeze({
    probe: (): ResultAsync<PiNativeSessionReadiness, never> => okAsync(READY),
  });
}
