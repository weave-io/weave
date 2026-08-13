import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import { loadConfig } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  MaterializationError,
  MaterializationPlan,
} from "@weaveio/weave-engine";
import { materializeAgents } from "@weaveio/weave-engine";
import { errAsync, ResultAsync } from "neverthrow";
import {
  resolvePiChildInspectionSettings,
  type PiChildInspectionSettingsResolution,
} from "./child-inspection-settings.js";
import {
  resolvePiChildLifecycleSettings,
  type PiChildLifecycleSettings,
} from "./child-lifecycle-settings.js";
import {
  makeActivationFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { safelyAwaitPortResult } from "./port-safety.js";
import type { PiAdapterLogger, PiTrustState } from "./types.js";

/**
 * Adapter-local default `FileReader`, backed by `Bun.file()`.
 *
 * `@weaveio/weave-config` does not export its own `bunFileReader` singleton
 * (only the `FileReader` type), so the adapter defines its own rather than
 * widening that package's public surface for this one caller.
 */
export const defaultPiFileReader: FileReader = {
  exists: (path) => Bun.file(path).exists(),
  read: (path) =>
    ResultAsync.fromPromise(
      Bun.file(path).text(),
      (cause): ConfigLoadError => ({ type: "FileReadError", path, cause }),
    ),
};

/**
 * Wraps a `FileReader` so every read/exists check under
 * `${projectRoot}/.weave/` is blocked, while everything else (notably the
 * global `~/.weave/config.weave` scope) still delegates to `inner`.
 *
 * This is how `PiConfigActivator` honors Pi adapter contract ("an untrusted
 * project MUST withhold ... project config") without requiring
 * `@weaveio/weave-config` to know anything about Pi's trust model: the
 * adapter alone decides which paths are permitted input to the otherwise
 * unmodified, pure `loadConfig()` helper.
 */
export function createTrustWithheldFileReader(
  inner: FileReader,
  projectRoot: string,
): FileReader {
  const blockedPrefix = `${projectRoot}/.weave/`;
  const isBlocked = (path: string): boolean => path.startsWith(blockedPrefix);

  return {
    exists: async (path) => {
      if (isBlocked(path)) return false;
      return inner.exists(path);
    },
    read: (path) => {
      if (isBlocked(path)) {
        return errAsync<string, ConfigLoadError>({
          type: "FileReadError",
          path,
          cause: new Error("project-trust-withheld"),
        });
      }
      return inner.read(path);
    },
  };
}

/** Adapter-facing seam over `@weaveio/weave-config`'s `loadConfig`, injectable for tests. */
export interface PiConfigLoaderPort {
  load(
    projectRoot: string,
    fileReader: FileReader,
  ): ResultAsync<WeaveConfig, ConfigLoadError[]>;
}

export const defaultPiConfigLoaderPort: PiConfigLoaderPort = {
  load: (projectRoot, fileReader) => loadConfig(projectRoot, fileReader),
};

/** Adapter-facing seam over `@weaveio/weave-engine`'s `materializeAgents`, injectable for tests. */
export interface PiMaterializerPort {
  materialize(config: WeaveConfig): ResultAsync<MaterializationPlan, never>;
}

export const defaultPiMaterializerPort: PiMaterializerPort = {
  materialize: (config) => materializeAgents({ config }),
};

export interface PiConfigActivatorDeps {
  readonly fileReader?: FileReader;
  readonly configLoader?: PiConfigLoaderPort;
  readonly materializer?: PiMaterializerPort;
}

export interface PiConfigActivationInput {
  readonly projectRoot: string;
  readonly trust: PiTrustState;
}

/**
 * The adapter's consumed view of a `MaterializationPlan` (Pi adapter contract):
 * every successful descriptor indexed by its stable `name`, in the plan's
 * deterministic order, alongside every reported error. A descriptor that
 * failed composition is simply absent here under its name — it is never
 * replaced or renamed.
 */
export interface PiDescriptorCatalog {
  readonly byName: ReadonlyMap<string, AgentDescriptor>;
  readonly order: readonly string[];
  readonly errors: readonly MaterializationError[];
}

export interface PiConfigActivationResult {
  readonly config: WeaveConfig;
  readonly plan: MaterializationPlan;
  readonly descriptors: PiDescriptorCatalog;
  readonly trust: PiTrustState;
  /** Pi validates this local block without rejecting unrelated adapter blocks. */
  readonly childInspectionSettings: PiChildInspectionSettingsResolution;
  readonly childLifecycleSettings: PiChildLifecycleSettings;
}

/**
 * Consumes a `MaterializationPlan` into the adapter's descriptor catalog.
 * Preserves `plan.agents`' deterministic order (explicit, then category
 * shuttles, then review variants) and carries `plan.errors` through
 * unchanged for reporting.
 */
export function buildDescriptorCatalog(
  plan: MaterializationPlan,
): PiDescriptorCatalog {
  const byName = new Map<string, AgentDescriptor>();
  const order: string[] = [];
  for (const agent of plan.agents) {
    byName.set(agent.agentName, agent.descriptor);
    order.push(agent.agentName);
  }
  return { byName, order, errors: plan.errors };
}

/**
 * Reports every `MaterializationPlan.errors` item (Pi adapter contract). Each
 * error type is logged with its own precise fields; nothing here retries or
 * substitutes a failed descriptor's identity.
 */
export function logMaterializationErrors(
  errors: readonly MaterializationError[],
  logger: PiAdapterLogger,
): void {
  for (const error of errors) {
    if (error.type === "CategoryShuttleConflict") {
      logger.warn(
        {
          shuttleName: error.conflict.shuttleName,
          categoryName: error.conflict.categoryName,
        },
        "category shuttle conflict - descriptor omitted from materialization plan",
      );
      continue;
    }
    if (error.type === "ReviewVariantConflict") {
      logger.warn(
        {
          variantName: error.conflict.variantName,
          agentName: error.conflict.agentName,
          reviewModel: error.conflict.reviewModel,
        },
        "review variant conflict - descriptor omitted from materialization plan",
      );
      continue;
    }
    logger.warn(
      { agentName: error.agentName },
      "descriptor composition failed - descriptor omitted from materialization plan",
    );
  }
}

/**
 * Pi adapter contract `PiConfigActivator`: loads the permitted Weave config for the
 * current trust state and materializes it into a descriptor catalog.
 *
 * Read-only and side-effect free beyond the injected `FileReader` — no
 * Runtime Store, no timers, no process launches (Pi adapter contract).
 */
export class PiConfigActivator {
  constructor(private readonly deps: PiConfigActivatorDeps = {}) {}

  activate(
    input: PiConfigActivationInput,
  ): ResultAsync<PiConfigActivationResult, PiAdapterFailure> {
    const fileReader = this.deps.fileReader ?? defaultPiFileReader;
    const configLoader = this.deps.configLoader ?? defaultPiConfigLoaderPort;
    const materializer = this.deps.materializer ?? defaultPiMaterializerPort;

    const effectiveReader =
      input.trust === "withheld"
        ? createTrustWithheldFileReader(fileReader, input.projectRoot)
        : fileReader;

    // Both `configLoader` and `materializer` are injected ports - even
    // though they are *typed* as `ResultAsync`, a misbehaving concrete
    // implementation (test double, or a real dependency with its own bug)
    // could still throw synchronously or reject its promise despite `E`
    // being declared `never`. `safelyAwaitPortResult` fails closed instead
    // of letting that become an unhandled rejection (neverthrow-wrap-
    // exceptions).
    // The reason strings passed to `makeActivationFailedFailure` below are
    // fixed, closed-set literals - never anything derived from `cause`.
    // Pi adapter closed-failure contract bans private paths, environment
    // values, and secrets from public failures, and an injected port's
    // thrown/rejected content cannot be trusted not to contain any of
    // those.
    return safelyAwaitPortResult(
      () => configLoader.load(input.projectRoot, effectiveReader),
      (): PiAdapterFailure => makeActivationFailedFailure("config-load-threw"),
    )
      .mapErr(
        (errors): PiAdapterFailure =>
          Array.isArray(errors)
            ? makeActivationFailedFailure(`config-load-failed:${errors.length}`)
            : errors,
      )
      .andThen((config) =>
        safelyAwaitPortResult(
          () => materializer.materialize(config),
          (): PiAdapterFailure =>
            makeActivationFailedFailure("materialize-threw"),
        ).andThen((plan) => {
          const childLifecycle = resolvePiChildLifecycleSettings(config);
          if (childLifecycle.isErr()) {
            return errAsync(
              makeActivationFailedFailure(
                `child-lifecycle-settings-invalid:${childLifecycle.error.length}`,
              ),
            );
          }
          return ResultAsync.fromSafePromise(
            Promise.resolve({
              config,
              plan,
              descriptors: buildDescriptorCatalog(plan),
              trust: input.trust,
              childInspectionSettings:
                resolvePiChildInspectionSettings(config).match(
                  (resolution) => resolution,
                  (issues) => ({ status: "invalid" as const, issues }),
                ),
              childLifecycleSettings: childLifecycle.value,
            }),
          );
        }),
      );
  }
}
