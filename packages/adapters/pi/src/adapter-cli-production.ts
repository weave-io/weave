/**
 * Production factory for `weave adapter pi …` command ports.
 *
 * Opens XDG-rooted native session + metadata-cache stores for one workspace
 * scope and wires children/doctor ports. The CLI imports this package surface
 * only; engine dispatch stays opaque.
 *
 * Health-only / read CLI routes use {@link createProductionPorts} in
 * `accessMode: "read"`, which never creates cache directories, databases,
 * schema rows, refs, or lock artifacts. The one mutating route
 * (`children.delete`) is gated by
 * {@link evaluateProductionChildrenDeleteGate} **before** any call to
 * {@link createProductionPorts}.
 */

import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import type { AdapterCommandRegistry } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
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
  type PiNativeSessionHostPort,
  PiNativeSessionStore,
  resolvePiNativeSessionRoot,
} from "./child-native-sessions.js";
import { createNativeChildRefSourceAuthority } from "./child-session-refs.js";
import {
  makeRequiredCapabilityUnavailableFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { createBunPiNativeSessionFs } from "./native-session-fs.js";
import {
  createPiNativeSessionHost,
  isPiSessionManagerStatic,
  type PiSessionManagerStatic,
} from "./native-session-host.js";
import {
  createBlockedSessionMutationGate,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
} from "./required-capability-gate.js";

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

/**
 * How production ports touch the metadata cache.
 *
 * - `read` (CLI list/show/doctor): probe + read-only SQLite; never create.
 * - `write`: create/migrate path (tests and hypothetical descriptor-safe hosts).
 */
export type PiProductionAdapterAccessMode = "read" | "write";

export interface CreateProductionPiAdapterCommandPortsOptions {
  /** Workspace scope key (usually `process.cwd()`). */
  readonly workspaceKey: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  /** Override Pi static constructors (production default: public root). */
  readonly SessionManager?: PiSessionManagerStatic;
  /**
   * Cache access mode. CLI read routes must pass `"read"` so a pristine data
   * root stays absent. Defaults to `"read"`.
   */
  readonly accessMode?: PiProductionAdapterAccessMode;
}

const CLI_SOURCE_PARENT = "weave-cli";

function unavailableChildrenPort(message: string): PiAdapterChildrenPort {
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
  options: Pick<
    CreateProductionPiAdapterCommandPortsOptions,
    "SessionManager"
  > = {},
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
 * Capability gate for health-only `children delete`.
 *
 * Runs against the production path-only host preflight and returns
 * `RequiredCapabilityUnavailable` with
 * `descriptor-relative-native-session-io` / `path-only-session-api` on Pi
 * 0.83. Callers must invoke this **before** {@link createProductionPorts}
 * so delete never opens a cache, ref store, or session root.
 */
export function evaluateProductionChildrenDeleteGate(
  options: Pick<
    CreateProductionPiAdapterCommandPortsOptions,
    "SessionManager"
  > = {},
): Result<void, PiAdapterFailure> {
  const host = resolveHost(options);
  if (host.isErr()) {
    return err(
      makeRequiredCapabilityUnavailableFailure(
        SESSION_MUTATION_REQUIRED_CAPABILITY,
        host.error.reason,
      ),
    );
  }
  const preflight = host.value.requireDescriptorSafeSessionIo();
  if (preflight.isErr()) {
    return err(
      makeRequiredCapabilityUnavailableFailure(
        SESSION_MUTATION_REQUIRED_CAPABILITY,
        preflight.error.reason,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Opens XDG-rooted session/cache stores and builds children + doctor ports for
 * one workspace. Cache open failure degrades discovery; session root and host
 * failures fail closed.
 *
 * Prefer {@link createProductionPorts} at the CLI boundary so tests can assert
 * call order against a single factory name.
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

  // Session root failures outrank cache root failures: the session store is
  // authoritative, the cache is derivative.
  return resolvePiNativeSessionRoot({
    env: options.env,
    homeDir: options.homeDir,
  })
    .mapErr(
      (error): PiProductionAdapterCommandError => ({
        type: "SessionRootUnavailable",
        reason:
          error.type === "SessionRootViolation" ? error.reason : error.type,
      }),
    )
    .andThen((root) => {
      const cacheRoot = resolvePiChildMetadataCacheRoot({
        env: options.env,
        homeDir: options.homeDir,
      });
      if (cacheRoot.isErr()) {
        return errAsync<
          PiProductionAdapterCommandPorts,
          PiProductionAdapterCommandError
        >({
          type: "CacheRootUnavailable",
          reason:
            cacheRoot.error.type === "CacheRootViolation"
              ? cacheRoot.error.reason
              : cacheRoot.error.type,
        });
      }
      const host = resolveHost(options);
      if (host.isErr()) {
        return errAsync<
          PiProductionAdapterCommandPorts,
          PiProductionAdapterCommandError
        >(host.error);
      }
      return openWithSessionRoot(options, root, cacheRoot.value, host.value);
    });
}

/**
 * CLI-facing production port factory. Same behaviour as
 * {@link openProductionPiAdapterCommandPorts}; the distinct name exists so
 * delete-order tests can prove the capability gate runs first.
 */
export function createProductionPorts(
  options: CreateProductionPiAdapterCommandPortsOptions,
): ResultAsync<
  PiProductionAdapterCommandPorts,
  PiProductionAdapterCommandError
> {
  return openProductionPiAdapterCommandPorts(options);
}

function openWithSessionRoot(
  options: CreateProductionPiAdapterCommandPortsOptions,
  sessionRoot: string,
  cacheRoot: string,
  host: PiNativeSessionHostPort,
): ResultAsync<
  PiProductionAdapterCommandPorts,
  PiProductionAdapterCommandError
> {
  const sessions = new PiNativeSessionStore({
    root: sessionRoot,
    fs: createBunPiNativeSessionFs(),
    host,
  });
  const authority = createNativeChildRefSourceAuthority(sessions);
  const accessMode = options.accessMode ?? "read";
  const readOnly = accessMode === "read";

  return openPiChildMetadataCache({
    root: cacheRoot,
    fs: new BunPiChildMetadataCacheFs(),
    authority,
    source: {
      workspaceKey: options.workspaceKey,
      parentSessionId: CLI_SOURCE_PARENT,
      readRefs: () => okAsync([]),
    },
    ...(readOnly ? { readOnly: true as const } : {}),
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
            sessions
              .listByRef(refs, { limit: 50 })
              .map((states) => states.map((state) => ({ state: state.state }))),
        }),
      });
      return { children, doctor, cacheMode: "active" as const };
    }

    const children = unavailableChildrenPort(
      `child metadata cache degraded: ${outcome.error.type}`,
    );
    const doctor = createPiDoctorPort({
      ports: createStoreBackedDoctorCheckPorts({
        permissions: () => okAsync(passedDoctorCheck("session root resolved")),
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
  const accessMode = options.accessMode ?? "read";
  // Delete is gated before this factory on the CLI path. When a registry is
  // still built (tests, hypothetical write mode), wire a blocked gate so the
  // mutating handler cannot reach the children port without an explicit open
  // gate from a descriptor-safe host.
  const sessionMutationGate =
    accessMode === "read"
      ? createBlockedSessionMutationGate("path-only-session-api")
      : undefined;
  return createProductionPorts(options).map((ports) =>
    createPiAdapterCommandRegistry({
      children: ports.children,
      doctor: ports.doctor,
      ...(sessionMutationGate === undefined ? {} : { sessionMutationGate }),
    }),
  );
}

/** Why the CLI refused to open production ports for an adapter action. */
export type PiProductionAdapterCliOpenError =
  | PiProductionAdapterCommandError
  | {
      readonly type: "RequiredCapabilityUnavailable";
      readonly capabilityId: string;
      readonly reason: string;
    };

export interface ResolveProductionAdapterCliRegistryInput
  extends CreateProductionPiAdapterCommandPortsOptions {
  /** Parsed adapter action (`children.list`, `children.delete`, …). */
  readonly action: string;
}

/**
 * CLI dispatch seam: gate mutating delete **before** {@link createProductionPorts},
 * then open read-only ports for list/show/doctor.
 */
export function resolveProductionAdapterCliRegistry(
  input: ResolveProductionAdapterCliRegistryInput,
): ResultAsync<AdapterCommandRegistry, PiProductionAdapterCliOpenError> {
  if (input.action === "children.delete") {
    const gated = evaluateProductionChildrenDeleteGate({
      ...(input.SessionManager === undefined
        ? {}
        : { SessionManager: input.SessionManager }),
    });
    if (gated.isErr()) {
      const correlation = gated.error.correlation;
      const reason =
        correlation !== undefined && typeof correlation.reason === "string"
          ? correlation.reason
          : "capability-unavailable";
      return errAsync({
        type: "RequiredCapabilityUnavailable",
        capabilityId: SESSION_MUTATION_REQUIRED_CAPABILITY,
        reason,
      });
    }
  }
  const { action: _action, ...portOptions } = input;
  return createProductionPiAdapterCommandRegistry({
    ...portOptions,
    accessMode: "read",
  });
}
