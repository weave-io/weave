/**
 * Production factory for Task 4/5/6 thread sources.
 *
 * Keeps `extension.ts` free of native-session / ref-store / cache construction.
 * Authoritative native session and parent ref failures fail closed; the Task 6
 * metadata cache never blocks — a degraded open still yields usable sources.
 */

import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  BunPiChildMetadataCacheFs,
  openPiChildMetadataCache,
  type PiChildMetadataCacheFsPort,
  type PiChildMetadataCacheOpenOutcome,
  type PiChildMetadataDatabaseOpener,
  resolvePiChildMetadataCacheRoot,
} from "./child-metadata-cache.js";
import {
  type PiNativeSessionFsPort,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
  type PiNativeSessionStoreLaunchMode,
} from "./child-native-sessions.js";
import {
  createNativeChildRefSourceAuthority,
  type PiChildRefAppendPort,
  type PiChildRefEntryReadPort,
  PiChildSessionRefStore,
} from "./child-session-refs.js";
import type { PiChildSessionStorageAuthority } from "./child-session-storage-authority.js";
import type {
  PiThreadCachePort,
  PiThreadRefPort,
  PiThreadSessionPort,
} from "./delegation-controller.js";
import { createBunPiNativeSessionFs } from "./native-session-fs.js";
import {
  createPiNativeSessionHost,
  isPiSessionManagerStatic,
  type PiSessionManagerStatic,
} from "./native-session-host.js";
import type { PiTrustedDataRootPort } from "./trusted-data-root.js";

/** Why production thread-source construction refused to open. */
export type PiThreadSourceFactoryError =
  | {
      readonly type: "SessionRootUnavailable";
      readonly reason: string;
    }
  | {
      readonly type: "NativeHostUnavailable";
      readonly reason: string;
    }
  | {
      readonly type: "ParentSessionUnavailable";
      readonly reason: string;
    };

/** One generation's authoritative + derivative thread sources. */
export interface PiThreadSources {
  readonly refs: PiThreadRefPort;
  readonly sessions: PiThreadSessionPort;
  readonly cache: PiThreadCachePort;
  /** Observability only: cache open mode. Never blocks delegation. */
  readonly cacheMode: "active" | "degraded";
}

/** Inputs the factory needs from the live parent session and workspace. */
export interface PiThreadSourceFactoryInput {
  /** Workspace scope key for the metadata cache (usually `ctx.cwd`). */
  readonly workspaceKey: string;
  /** Live persistent parent session id. */
  readonly parentSessionId: string;
  /** Pi `api.appendEntry` boundary for parent custom-entry refs. */
  readonly append: PiChildRefAppendPort;
  /** Parent session entry reader (`sessionManager.getEntries`). */
  readonly read: PiChildRefEntryReadPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly now?: () => number;
  /**
   * Test seams. Production resolves root/fs/host/cache from the environment
   * and Pi's public `SessionManager`; unit tests inject Task 4 memory host/fs.
   */
  readonly sessionRoot?: string;
  /** Test seam: canonicalizer for the configured XDG data base. */
  readonly trustedRoot?: PiTrustedDataRootPort;
  readonly fs?: PiNativeSessionFsPort;
  readonly host?: PiNativeSessionHostPort;
  readonly cacheRoot?: string;
  readonly cacheFs?: PiChildMetadataCacheFsPort;
  /** Test seam for an in-memory SQLite opener. */
  readonly openDatabase?: PiChildMetadataDatabaseOpener;
  /** Override the Pi static constructors (production default: public root). */
  readonly SessionManager?: PiSessionManagerStatic;
  /**
   * The generation's one native-session authority (Spec 33 §5.6). Mandatory:
   * sources may never build a second authority from an asserted root, because
   * that is exactly how readiness and launch used to disagree. The store,
   * the ref store, and every launch consume this same object.
   */
  readonly storageAuthority: PiChildSessionStorageAuthority;
  /**
   * When `true`, open the metadata cache with the non-creating read-only
   * path. Health-only / path-only startup must set this so a pristine data
   * root never gains directories, DB, WAL, or SHM from source construction.
   */
  readonly readOnly?: boolean;
}

export type PiThreadSourceFactory = (
  input: PiThreadSourceFactoryInput,
) => ResultAsync<PiThreadSources, PiThreadSourceFactoryError>;

const NOOP_CACHE: PiThreadCachePort = {
  upsertRef: () => ok(undefined),
};

/**
 * The session root these sources open over.
 *
 * Production takes the root the generation's authority already *proved* by
 * opening it no-follow, so sources can never be built over a root readiness
 * never checked. Unit embeddings may name a synthetic root explicitly.
 */
function resolveSessionRoot(
  input: PiThreadSourceFactoryInput,
): ResultAsync<string, PiThreadSourceFactoryError> {
  if (input.sessionRoot !== undefined) {
    if (input.sessionRoot.length === 0) {
      return errAsync({
        type: "SessionRootUnavailable",
        reason: "empty-session-root",
      });
    }
    return okAsync(input.sessionRoot);
  }
  return input.storageAuthority.requireSessionRoot().match(
    (root) => okAsync<string, PiThreadSourceFactoryError>(root),
    (failure) =>
      errAsync<string, PiThreadSourceFactoryError>({
        type: "SessionRootUnavailable" as const,
        reason: failure.reason,
      }),
  );
}

function resolveHost(
  input: PiThreadSourceFactoryInput,
): Result<PiNativeSessionHostPort, PiThreadSourceFactoryError> {
  if (input.host !== undefined) return ok(input.host);
  const candidate =
    input.SessionManager ??
    (PiPublicExports as { SessionManager?: unknown }).SessionManager;
  if (!isPiSessionManagerStatic(candidate)) {
    return err({
      type: "NativeHostUnavailable",
      reason: "session-manager-missing",
    });
  }
  return ok(createPiNativeSessionHost(candidate));
}

function cachePortFromOutcome(outcome: PiChildMetadataCacheOpenOutcome): {
  readonly cache: PiThreadCachePort;
  readonly cacheMode: "active" | "degraded";
} {
  if (outcome.mode === "active") {
    return { cache: outcome.cache, cacheMode: "active" };
  }
  // Degraded: discovery may use the bypass elsewhere; thread settlement only
  // needs a non-throwing upsert, so a no-op keeps the run unblocked.
  return { cache: NOOP_CACHE, cacheMode: "degraded" };
}

/**
 * Opens Task 4/5/6 sources for one persistent parent session.
 *
 * Native root / host / parent identity failures are authoritative and fail
 * closed. Cache root or open failures degrade to a no-op cache port.
 */
export function openPiThreadSources(
  input: PiThreadSourceFactoryInput,
): ResultAsync<PiThreadSources, PiThreadSourceFactoryError> {
  if (input.parentSessionId.length === 0) {
    return errAsync({
      type: "ParentSessionUnavailable",
      reason: "empty-parent-session-id",
    });
  }
  if (input.workspaceKey.length === 0) {
    return errAsync({
      type: "ParentSessionUnavailable",
      reason: "empty-workspace-key",
    });
  }

  const host = resolveHost(input);
  if (host.isErr()) return errAsync(host.error);
  const resolvedHost = host.value;

  return resolveSessionRoot(input).andThen((root) =>
    openWithSessionRoot(input, root, resolvedHost),
  );
}

function openWithSessionRoot(
  input: PiThreadSourceFactoryInput,
  root: string,
  host: PiNativeSessionHostPort,
): ResultAsync<PiThreadSources, PiThreadSourceFactoryError> {
  const now = input.now;
  // One authority governs this generation's storage *and* its launches.
  const storageAuthority = input.storageAuthority;
  // The store mints launch grants only when that same authority already
  // proved a root and a launch surface. Without it the store can still read
  // and write sessions, but no child can be launched from them.
  const launch = storageAuthority.requireLaunchAuthority().match(
    (authority): PiNativeSessionStoreLaunchMode => ({
      mode: "authorized",
      authority,
    }),
    (): PiNativeSessionStoreLaunchMode => ({ mode: "read-only" }),
  );
  const sessions = new PiNativeSessionStore({
    root,
    fs: input.fs ?? createBunPiNativeSessionFs(),
    host,
    launch,
    ...(now === undefined ? {} : { now: () => new Date(now()) }),
  });
  const authority = createNativeChildRefSourceAuthority(sessions);
  const refs = new PiChildSessionRefStore({
    parentSessionId: input.parentSessionId,
    append: input.append,
    read: input.read,
    authority,
    storage: storageAuthority,
    ...(now === undefined ? {} : { now }),
  });

  const cacheRootResult = (() => {
    if (input.cacheRoot !== undefined) {
      if (input.cacheRoot.length === 0) {
        return err({
          type: "CacheRootViolation" as const,
          reason: "empty-cache-root" as const,
        });
      }
      return ok(input.cacheRoot);
    }
    return resolvePiChildMetadataCacheRoot({
      env: input.env,
      homeDir: input.homeDir,
    });
  })();

  const metadataSource = {
    workspaceKey: input.workspaceKey,
    parentSessionId: input.parentSessionId,
    readRefs: () =>
      ResultAsync.fromSafePromise(
        refs.readRefs({ limit: 1_000 }).match(
          (scan) => scan.refs,
          () => [],
        ),
      ),
  };

  if (cacheRootResult.isErr()) {
    return okAsync({
      refs,
      sessions,
      cache: NOOP_CACHE,
      cacheMode: "degraded" as const,
    });
  }

  return openPiChildMetadataCache({
    root: cacheRootResult.value,
    fs: input.cacheFs ?? new BunPiChildMetadataCacheFs(),
    authority,
    source: metadataSource,
    ...(input.readOnly === true ? { readOnly: true as const } : {}),
    ...(input.openDatabase === undefined
      ? {}
      : { openDatabase: input.openDatabase }),
    ...(now === undefined ? {} : { now }),
  }).map((outcome) => {
    const { cache, cacheMode } = cachePortFromOutcome(outcome);
    return { refs, sessions, cache, cacheMode };
  });
}

/** Production default: real Bun fs + Pi public `SessionManager`. */
export function createProductionPiThreadSourceFactory(
  options: { readonly SessionManager?: PiSessionManagerStatic } = {},
): PiThreadSourceFactory {
  return (input) =>
    openPiThreadSources({
      ...input,
      ...(options.SessionManager === undefined
        ? {}
        : { SessionManager: options.SessionManager }),
    });
}
