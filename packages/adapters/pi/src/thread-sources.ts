/**
 * Production factory for Task 4/5/6 thread sources.
 *
 * Keeps `extension.ts` free of native-session / ref-store / cache construction.
 * Authoritative native session and parent ref failures fail closed; the Task 6
 * metadata cache never blocks — a degraded open still yields usable sources.
 */

import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  BunPiChildMetadataCacheFs,
  type PiChildMetadataCacheFsPort,
  type PiChildMetadataCacheOpenOutcome,
  type PiChildMetadataDatabaseOpener,
  openPiChildMetadataCache,
  resolvePiChildMetadataCacheRoot,
} from "./child-metadata-cache.js";
import {
  type PiNativeSessionFsPort,
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
  resolvePiNativeSessionRoot,
} from "./child-native-sessions.js";
import {
  type PiChildRefAppendPort,
  type PiChildRefEntryReadPort,
  createNativeChildRefSourceAuthority,
  PiChildSessionRefStore,
} from "./child-session-refs.js";
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
  readonly fs?: PiNativeSessionFsPort;
  readonly host?: PiNativeSessionHostPort;
  readonly cacheRoot?: string;
  readonly cacheFs?: PiChildMetadataCacheFsPort;
  /** Test seam for an in-memory SQLite opener. */
  readonly openDatabase?: PiChildMetadataDatabaseOpener;
  /** Override the Pi static constructors (production default: public root). */
  readonly SessionManager?: PiSessionManagerStatic;
}

export type PiThreadSourceFactory = (
  input: PiThreadSourceFactoryInput,
) => ResultAsync<PiThreadSources, PiThreadSourceFactoryError>;

const NOOP_CACHE: PiThreadCachePort = {
  upsertRef: () => ok(undefined),
};

function resolveSessionRoot(
  input: PiThreadSourceFactoryInput,
): Result<string, PiThreadSourceFactoryError> {
  if (input.sessionRoot !== undefined) {
    if (input.sessionRoot.length === 0) {
      return err({
        type: "SessionRootUnavailable",
        reason: "empty-session-root",
      });
    }
    return ok(input.sessionRoot);
  }
  return resolvePiNativeSessionRoot({
    env: input.env,
    homeDir: input.homeDir,
  }).mapErr((error) => ({
    type: "SessionRootUnavailable" as const,
    reason: error.type === "SessionRootViolation" ? error.reason : error.type,
  }));
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

  const root = resolveSessionRoot(input);
  if (root.isErr()) return errAsync(root.error);
  const host = resolveHost(input);
  if (host.isErr()) return errAsync(host.error);

  const now = input.now;
  const sessions = new PiNativeSessionStore({
    root: root.value,
    fs: input.fs ?? createBunPiNativeSessionFs(),
    host: host.value,
    ...(now === undefined ? {} : { now: () => new Date(now()) }),
  });
  const authority = createNativeChildRefSourceAuthority(sessions);
  const refs = new PiChildSessionRefStore({
    parentSessionId: input.parentSessionId,
    append: input.append,
    read: input.read,
    authority,
    ...(now === undefined ? {} : { now }),
  });

  const cacheRootResult =
    input.cacheRoot !== undefined
      ? input.cacheRoot.length === 0
        ? err({
            type: "CacheRootViolation" as const,
            reason: "empty-cache-root" as const,
          })
        : ok(input.cacheRoot)
      : resolvePiChildMetadataCacheRoot({
          env: input.env,
          homeDir: input.homeDir,
        });

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
  options: {
    readonly SessionManager?: PiSessionManagerStatic;
  } = {},
): PiThreadSourceFactory {
  return (input) =>
    openPiThreadSources({
      ...input,
      ...(options.SessionManager === undefined
        ? {}
        : { SessionManager: options.SessionManager }),
    });
}
