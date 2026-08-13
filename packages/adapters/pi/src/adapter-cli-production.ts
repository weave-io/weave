/**
 * Production factory for `weave adapter pi …` command ports.
 *
 * Opens XDG-rooted native session + metadata-cache stores for one workspace
 * scope and wires children/doctor ports. The CLI imports this package surface
 * only; engine dispatch stays opaque.
 *
 * Read CLI routes use {@link createProductionPorts} in `accessMode: "read"`,
 * which never creates cache directories, databases, schema rows, refs, or
 * lock artifacts.
 */

import * as PiPublicExports from "@earendil-works/pi-coding-agent";
import type { AdapterCommandRegistry } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
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
import { BunEnvPort, buildDefaultPiChildCommand } from "./child-env.js";
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
import { BunPiChildProcessPort } from "./child-process-port.js";
import { createNativeChildRefSourceAuthority } from "./child-session-refs.js";
import { createBunPiNativeSessionFs } from "./native-session-fs.js";
import {
  createPiNativeSessionHost,
  isPiSessionManagerStatic,
  type PiSessionManagerStatic,
} from "./native-session-host.js";
import {
  createPiNativeSessionReadinessProbe,
  type PiNativeSessionReadiness,
  type PiNativeSessionReadinessProbe,
} from "./native-session-readiness.js";
import {
  createSessionMutationGate,
  type PiSessionMutationGate,
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
  /**
   * Required-capability gate for the one mutating CLI route
   * (`children.delete`), backed by the same proved Pi-native session/root/
   * process readiness activation uses. Read routes never consult it.
   */
  readonly sessionMutationGate: PiSessionMutationGate;
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
  /**
   * Proves Pi-native session/root/process readiness for the mutating route.
   * Production defaults to the real probe; tests inject a controlled one.
   */
  readonly readinessProbe?: PiNativeSessionReadinessProbe;
}

/**
 * Builds the mutation gate for a set of production ports.
 *
 * A read-only port set can never satisfy the gate: it opened no writable
 * cache, so `children.delete` is refused before it can touch a session. A
 * write-mode port set is gated on the proved readiness outcome, and an
 * unproved outcome reports its own closed, path-free reason.
 */
function mutationGateFor(
  accessMode: PiProductionAdapterAccessMode,
  readiness: PiNativeSessionReadiness | undefined,
): PiSessionMutationGate {
  if (accessMode === "read") {
    return createSessionMutationGate(() => [
      {
        capabilityId: SESSION_MUTATION_REQUIRED_CAPABILITY,
        reason: "read-only-cli-access",
      },
    ]);
  }
  if (readiness === undefined || !readiness.ready) {
    return createSessionMutationGate(() => [
      {
        capabilityId: SESSION_MUTATION_REQUIRED_CAPABILITY,
        reason:
          readiness?.ready === false ? readiness.reason : "readiness-unproven",
      },
    ]);
  }
  return createSessionMutationGate(() => []);
}

/**
 * Whether a built gate would admit a mutation. Read without a capability
 * catalog, so the answer depends only on the gate's own closed reasons.
 */
function isMutationGateOpen(gate: PiSessionMutationGate): boolean {
  return gate.evaluate().isOk();
}

/**
 * Runs the readiness probe only for the mutating access mode, so a read route
 * never initializes a root. A probe that throws despite its `never` error type
 * fails closed; the thrown value is discarded.
 */
function readReadinessFor(
  accessMode: PiProductionAdapterAccessMode,
  options: CreateProductionPiAdapterCommandPortsOptions,
): ResultAsync<PiNativeSessionReadiness | undefined, never> {
  if (accessMode === "read") return okAsync(undefined);
  const probe =
    options.readinessProbe ??
    createPiNativeSessionReadinessProbe({
      processPort: new BunPiChildProcessPort(),
      childCommand: buildDefaultPiChildCommand(new BunEnvPort()),
      ...(options.SessionManager === undefined
        ? {}
        : { SessionManager: options.SessionManager }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    });
  return ResultAsync.fromSafePromise(
    Promise.resolve()
      .then(() => probe.probe())
      .then((result) =>
        result.match(
          (readiness): PiNativeSessionReadiness | undefined => readiness,
          (): PiNativeSessionReadiness | undefined => ({
            ready: false,
            reason: "pi-session-api-unavailable",
          }),
        ),
      )
      .catch((): PiNativeSessionReadiness | undefined => ({
        ready: false,
        reason: "pi-session-api-unavailable",
      })),
  );
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
    result: () =>
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

  return readReadinessFor(accessMode, options).andThen((readiness) => {
    const sessionMutationGate = mutationGateFor(accessMode, readiness);
    // A write route whose native readiness is unproven must produce *zero*
    // writable effects: the metadata cache is opened (and would be
    // created/migrated) only after the gate proves the route may mutate. The
    // read route keeps its own read-only open below.
    if (!readOnly && !isMutationGateOpen(sessionMutationGate)) {
      return okAsync<
        PiProductionAdapterCommandPorts,
        PiProductionAdapterCommandError
      >({
        children: unavailableChildrenPort(
          `child mutation unavailable: ${readiness?.ready === false ? readiness.reason : "readiness-unproven"}`,
        ),
        doctor: createPiDoctorPort({
          ports: createStoreBackedDoctorCheckPorts({
            permissions: () =>
              okAsync(passedDoctorCheck("session root resolved")),
            cacheMode: "degraded",
            listMetadata: () => okAsync([]),
          }),
        }),
        cacheMode: "degraded" as const,
        sessionMutationGate,
      });
    }
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
                .map((states) =>
                  states.map((state) => ({ state: state.state })),
                ),
          }),
        });
        return {
          children,
          doctor,
          cacheMode: "active" as const,
          sessionMutationGate,
        };
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
      return {
        children,
        doctor,
        cacheMode: "degraded" as const,
        sessionMutationGate,
      };
    });
  });
}

/** Builds the engine registry over production XDG-rooted Pi ports. */
export function createProductionPiAdapterCommandRegistry(
  options: CreateProductionPiAdapterCommandPortsOptions,
): ResultAsync<AdapterCommandRegistry, PiProductionAdapterCommandError> {
  return createProductionPorts(options).map((ports) =>
    createPiAdapterCommandRegistry({
      children: ports.children,
      doctor: ports.doctor,
      // The one mutating route is gated on proved native readiness. Without
      // this the `children.delete` handler fails closed as unwired, which is
      // why production deletion never dispatched.
      sessionMutationGate: ports.sessionMutationGate,
    }),
  );
}

/** Adapter CLI actions that mutate a persistent native session. */
const MUTATING_ADAPTER_ACTIONS: ReadonlySet<string> = new Set([
  "children.delete",
]);

/**
 * The access mode an adapter action may use. Only the mutating route earns
 * write access; every other route stays read-only so a pristine data root gains
 * no directories, database, schema rows, refs, or lock artifacts. The action
 * decides this, never the caller.
 */
export function accessModeForAdapterAction(
  action: string,
): PiProductionAdapterAccessMode {
  return MUTATING_ADAPTER_ACTIONS.has(action) ? "write" : "read";
}

/** Why the CLI refused to open production ports for an adapter action. */
export type PiProductionAdapterCliOpenError = PiProductionAdapterCommandError;

export interface ResolveProductionAdapterCliRegistryInput
  extends CreateProductionPiAdapterCommandPortsOptions {
  /** Parsed adapter action (`children.list`, `children.delete`, …). */
  readonly action: string;
}

/** CLI dispatch seam for production adapter commands. */
export function resolveProductionAdapterCliRegistry(
  input: ResolveProductionAdapterCliRegistryInput,
): ResultAsync<AdapterCommandRegistry, PiProductionAdapterCliOpenError> {
  const { action, accessMode: _requested, ...portOptions } = input;
  // The action alone decides access. A caller cannot widen a read route, and
  // cannot narrow `children.delete` into a mode that could never complete it.
  return createProductionPiAdapterCommandRegistry({
    ...portOptions,
    accessMode: accessModeForAdapterAction(action),
  });
}
