/**
 * Production factory for `weave adapter pi …` command ports.
 *
 * Opens XDG-rooted native session + metadata-cache stores for one workspace
 * scope and wires children/doctor ports. The CLI imports this package surface
 * only; engine dispatch stays opaque.
 */

import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import type { AdapterCommandRegistry } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  createPiAdapterCommandRegistry,
  createPiChildrenCommandPort,
  type PiAdapterChildrenPort,
  type PiAdapterDoctorPort,
} from "./adapter-cli-commands.js";
import {
  createPiDoctorPort,
  createStoreBackedDoctorCheckPorts,
  failedDoctorCheck,
  passedDoctorCheck,
} from "./child-doctor.js";
import {
  BunPiChildMetadataCacheFs,
  openPiChildMetadataCache,
  resolvePiChildMetadataCacheRoot,
} from "./child-metadata-cache.js";
import {
  PiNativeSessionStore,
  resolvePiNativeSessionRoot,
} from "./child-native-sessions.js";
import { createNativeChildRefSourceAuthority } from "./child-session-refs.js";
import { createBunPiNativeSessionFs } from "./native-session-fs.js";
import {
  createPiNativeSessionHost,
  isPiSessionManagerStatic,
  type PiSessionManagerStatic,
} from "./native-session-host.js";

/** Why production CLI port construction refused to open. */
export type PiProductionAdapterCommandError =
  | {
      readonly type: "SessionRootUnavailable";
      readonly reason: string;
    }
  | {
      readonly type: "CacheRootUnavailable";
      readonly reason: string;
    }
  | {
      readonly type: "NativeHostUnavailable";
      readonly reason: string;
    }
  | {
      readonly type: "WorkspaceKeyInvalid";
      readonly reason: string;
    };

/** Opened children + doctor ports for one workspace scope. */
export interface PiProductionAdapterCommandPorts {
  readonly children: PiAdapterChildrenPort;
  readonly doctor: PiAdapterDoctorPort;
  readonly cacheMode: "active" | "degraded";
}

export interface CreateProductionPiAdapterCommandPortsOptions {
  /** Workspace scope key (usually `process.cwd()`). */
  readonly workspaceKey: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  /** Override Pi static constructors (production default: public root). */
  readonly SessionManager?: PiSessionManagerStatic;
}

const CLI_SOURCE_PARENT = "weave-cli";

function unavailableChildrenPort(
  message: string,
): PiAdapterChildrenPort {
  return {
    list: () => okAsync({ children: [] }),
    show: () =>
      errAsync({
        type: "Unavailable" as const,
        message,
      }),
    resolve: () =>
      errAsync({
        type: "Unavailable" as const,
        message,
      }),
    delete: () =>
      errAsync({
        type: "Unavailable" as const,
        message,
      }),
  };
}

function resolveHost(
  options: CreateProductionPiAdapterCommandPortsOptions,
): Result<
  ReturnType<typeof createPiNativeSessionHost>,
  PiProductionAdapterCommandError
> {
  const candidate =
    options.SessionManager ??
    (PiPublicExports as { SessionManager?: unknown }).SessionManager;
  if (!isPiSessionManagerStatic(candidate)) {
    return err({
      type: "NativeHostUnavailable",
      reason: "session-manager-missing",
    });
  }
  return ok(createPiNativeSessionHost(candidate));
}

/**
 * Opens XDG-rooted session/cache stores and builds children + doctor ports for
 * one workspace. Cache open failure degrades discovery; session root and host
 * failures fail closed.
 */
export function openProductionPiAdapterCommandPorts(
  options: CreateProductionPiAdapterCommandPortsOptions,
): ResultAsync<
  PiProductionAdapterCommandPorts,
  PiProductionAdapterCommandError
> {
  if (options.workspaceKey.length === 0) {
    return errAsync({
      type: "WorkspaceKeyInvalid",
      reason: "empty-workspace-key",
    });
  }

  const sessionRoot = resolvePiNativeSessionRoot({
    env: options.env,
    homeDir: options.homeDir,
  });
  if (sessionRoot.isErr()) {
    return errAsync({
      type: "SessionRootUnavailable",
      reason:
        sessionRoot.error.type === "SessionRootViolation"
          ? sessionRoot.error.reason
          : sessionRoot.error.type,
    });
  }

  const cacheRoot = resolvePiChildMetadataCacheRoot({
    env: options.env,
    homeDir: options.homeDir,
  });
  if (cacheRoot.isErr()) {
    return errAsync({
      type: "CacheRootUnavailable",
      reason:
        cacheRoot.error.type === "CacheRootViolation"
          ? cacheRoot.error.reason
          : cacheRoot.error.type,
    });
  }

  const host = resolveHost(options);
  if (host.isErr()) return errAsync(host.error);

  const sessions = new PiNativeSessionStore({
    root: sessionRoot.value,
    fs: createBunPiNativeSessionFs(),
    host: host.value,
  });
  const authority = createNativeChildRefSourceAuthority(sessions);

  return openPiChildMetadataCache({
    root: cacheRoot.value,
    fs: new BunPiChildMetadataCacheFs(),
    authority,
    source: {
      workspaceKey: options.workspaceKey,
      parentSessionId: CLI_SOURCE_PARENT,
      readRefs: () => okAsync([]),
    },
  }).map((outcome) => {
    if (outcome.mode === "active") {
      const discoveryCache = outcome.cache;
      const children = createPiChildrenCommandPort({
        cache: discoveryCache,
        sessions,
      });
      const doctor = createPiDoctorPort({
        ports: createStoreBackedDoctorCheckPorts({
          permissions: () => {
            const root = sessions.sessionRoot();
            if (root.length === 0) {
              return okAsync(
                failedDoctorCheck(
                  "session root unavailable",
                  "ChildSessionRootViolation",
                ),
              );
            }
            return okAsync(passedDoctorCheck("session root resolved"));
          },
          cacheMode: "active",
          listMetadata: () => {
            const listed = discoveryCache.list({
              workspaceKey: options.workspaceKey,
              limit: 50,
              includeTombstoned: true,
            });
            if (listed.isErr()) return errAsync(listed.error);
            return okAsync(
              listed.value.records.map((row) => ({
                childId: row.childId,
                originParentSessionId: row.originParentSessionId,
                stale: row.stale,
                tombstoned: row.tombstoned,
              })),
            );
          },
          listSessionsByRef: (refs) =>
            sessions.listByRef(refs, { limit: 50 }).map((states) =>
              states.map((state) => ({ state: state.state })),
            ),
        }),
      });
      return { children, doctor, cacheMode: "active" as const };
    }

    const children = unavailableChildrenPort(
      `child metadata cache degraded: ${outcome.error.type}`,
    );
    const doctor = createPiDoctorPort({
      ports: createStoreBackedDoctorCheckPorts({
        permissions: () =>
          okAsync(passedDoctorCheck("session root resolved")),
        cacheMode: "degraded",
        listMetadata: () => okAsync([]),
      }),
    });
    return { children, doctor, cacheMode: "degraded" as const };
  });
}

/** Builds the engine registry over production XDG-rooted Pi ports. */
export function createProductionPiAdapterCommandRegistry(
  options: CreateProductionPiAdapterCommandPortsOptions,
): ResultAsync<AdapterCommandRegistry, PiProductionAdapterCommandError> {
  return openProductionPiAdapterCommandPorts(options).map((ports) =>
    createPiAdapterCommandRegistry({
      children: ports.children,
      doctor: ports.doctor,
    }),
  );
}
