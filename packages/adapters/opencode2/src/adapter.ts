/**
 * `OpenCode2Adapter` — the V2 `HarnessAdapter` implementation.
 *
 * Implements Spec 34 (`docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md`).
 * Composes the Phase C modules built for tasks C4–C12 into the single
 * `HarnessAdapter` surface (`packages/engine/src/adapter.ts`) the engine's
 * bootstrap sequence calls:
 *
 * - `init()` — constructs a `BunFilesystemPlanStateProvider` rooted at
 *   `projectRoot`, and registers the built-in `/weave:*` commands
 *   (`registerCommands`, C10), accumulating their `V2Registration` handles.
 * - `spawnSubagent(descriptor)` — chains `resolveModelContext` (C8) →
 *   `translateAgent` (C5) → `reconcileAgent` (C7), storing the resulting
 *   `V2Registration` for later disposal.
 * - `loadAvailableSkills()` — delegates to `loadAvailableSkillsV2` (C9).
 * - `dispose()` — disposes every accumulated `V2Registration` (commands and
 *   agents), collecting (not short-circuiting on) individual failures.
 *
 * Constructed with a `PluginContextFacade` — either the live adapter
 * (`fromLiveContext(ctx)`, from a real `Plugin.define({ setup(ctx) })` or
 * `OpenCode.create` embedded host) or a test double (`MockPluginContext`).
 * `plugin.ts` (C12) owns the embedded-vs-live construction split; this class
 * only depends on the facade.
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see `./errors.ts` header for the independent V2 error union
 * rationale.
 */

import { BunFilesystemPlanStateProvider } from "@weaveio/weave-config";
import type {
  AgentDescriptor,
  HarnessAdapter,
  PlanStateProvider,
  SkillInfo,
} from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { BUILTIN_COMMANDS } from "./command-templates.js";
import {
  type OpenCode2AdapterError,
  registrationDisposeError,
} from "./errors.js";
import { resolveModelContext } from "./model-resolution.js";
import type { PluginContextFacade } from "./plugin-context.js";
import { reconcileAgent } from "./reconcile-agent.js";
import { registerCommands } from "./runtime-command-projection.js";
import type { V2Registration } from "./sdk-types.js";
import { loadAvailableSkillsV2 } from "./skill-discovery.js";
import { translateAgent } from "./translate-agent.js";

const log = logger.child({ module: "adapter-opencode2" });

/**
 * Every variant of `OpenCode2AdapterError` combined with a structural
 * `Error` shape (`name`/`message`).
 *
 * `HarnessAdapter.spawnSubagent()` (`packages/engine/src/adapter.ts`)
 * declares its error channel as `ResultAsync<void, Error>` so the engine can
 * treat every adapter's failures uniformly. `./errors.ts`'s
 * `OpenCode2AdapterError` union is a plain discriminated union (by design —
 * see that module's header) and does not itself satisfy TypeScript's
 * structural `Error` interface. `toHarnessError()` bridges the two: it
 * returns a plain object that is simultaneously assignable to
 * `OpenCode2AdapterError` (every original field, including the `type`
 * discriminant, is preserved) and to `Error` (via added `name`/`message`
 * fields), so callers can still discriminate on `.type` after catching a
 * `HarnessAdapter`-shaped failure.
 */
export type OpenCode2AdapterHarnessError = OpenCode2AdapterError & Error;

/** Human-readable summary of an `OpenCode2AdapterError`, used for `.message`. */
function describeError(error: OpenCode2AdapterError): string {
  switch (error.type) {
    case "PluginContextInitError":
      return `Plugin context initialization failed at stage "${error.stage}"`;
    case "AgentReconciliationError":
      return `Agent reconciliation failed for "${error.agentId}" at stage "${error.stage}"`;
    case "ForeignAgentCollision":
      return `Agent id "${error.agentId}" is already occupied by a non-Weave-owned agent`;
    case "MissingCatalogEntry":
      return `Model "${error.modelId}" declared by agent "${error.agentId}" is not present in the model catalog`;
    case "CatalogUnavailable":
      return `Model catalog unavailable at stage "${error.stage}"`;
    case "SkillListError":
      return "Failed to list V2 skills";
    case "SkillRegistrationError":
      return `Failed to register skill "${error.skillName}"`;
    case "CommandRegistrationError":
      return `Failed to register command "${error.commandName}"`;
    case "SessionOperationError":
      return `Session operation "${error.operation}" failed`;
    case "EventSubscriptionError":
      return "Event subscription failed";
    case "RegistrationDisposeError":
      return `Failed to dispose "${error.domain}" registration`;
    default:
      return "Unknown OpenCode2AdapterError";
  }
}

/**
 * Bridges a plain `OpenCode2AdapterError` into a shape that also satisfies
 * TypeScript's structural `Error` interface, without constructing a real
 * `Error` instance (no `instanceof Error` semantics implied — see module
 * header). Preserves every original field, including `.type`.
 */
function toHarnessError(
  error: OpenCode2AdapterError,
): OpenCode2AdapterHarnessError {
  return {
    ...error,
    name: "OpenCode2AdapterError",
    message: describeError(error),
  } as OpenCode2AdapterHarnessError;
}

/**
 * Constructor options for `OpenCode2Adapter`.
 */
export interface OpenCode2AdapterOptions {
  /**
   * Absolute path to the project root directory.
   *
   * Used to construct the `BunFilesystemPlanStateProvider` so that plan
   * files are resolved relative to the correct project root. Defaults to
   * `Bun.env.PWD ?? "."` when omitted.
   */
  readonly projectRoot?: string;
}

/**
 * OpenCode V2 (`opencode2`) harness adapter.
 *
 * Implements the `HarnessAdapter` interface (`@weaveio/weave-engine`) to
 * materialise Weave agent descriptors, commands, and skills into a running
 * V2 plugin `Context` (or embedded host) via `PluginContextFacade`.
 *
 * A `BunFilesystemPlanStateProvider` is constructed during `init()` and
 * stored as `this.planStateProvider`. Pass it to any `completeStep` call
 * that uses a `plan_created` or `plan_complete` completion method.
 */
export class OpenCode2Adapter implements HarnessAdapter {
  /**
   * Provider for querying plan file state.
   *
   * Constructed during `init()` using `projectRoot`. Pass to `completeStep`
   * calls that use `plan_created` or `plan_complete` completion methods.
   *
   * `undefined` before `init()` is called.
   */
  planStateProvider: PlanStateProvider | undefined = undefined;

  /**
   * Every `V2Registration` accumulated across `init()` (built-in commands)
   * and `spawnSubagent()` (materialized agents), in registration order.
   * `dispose()` iterates this list and disposes each entry.
   */
  private readonly registrations: V2Registration[] = [];

  /** Absolute path to the project root. Defaults to `Bun.env.PWD ?? "."`. */
  private readonly projectRoot: string;

  /** Narrow facade over the V2 plugin context. */
  private readonly facade: PluginContextFacade;

  constructor(
    facade: PluginContextFacade,
    options: OpenCode2AdapterOptions = {},
  ) {
    this.facade = facade;
    this.projectRoot = options.projectRoot ?? Bun.env.PWD ?? ".";
  }

  /**
   * Perform one-time initialisation required before any agent can be
   * materialised. Called exactly once by the bootstrap entry point.
   *
   * Constructs a `BunFilesystemPlanStateProvider` rooted at
   * `this.projectRoot` and stores it as `this.planStateProvider`, then
   * registers the built-in `/weave:*` commands via `registerCommands()`,
   * accumulating the returned `V2Registration[]` into `this.registrations`.
   *
   * Per the `HarnessAdapter` contract, `init()` returns `Promise<void>` and
   * must not throw — command-registration failures are logged and
   * swallowed rather than aborting bootstrap (a partial command set is
   * preferable to a hard bootstrap failure here).
   */
  async init(): Promise<void> {
    this.planStateProvider = new BunFilesystemPlanStateProvider(
      this.projectRoot,
    );

    const result = await registerCommands(this.facade, BUILTIN_COMMANDS);
    result.match(
      (registrations) => {
        this.registrations.push(...registrations);
        log.info(
          { count: registrations.length },
          "Registered built-in /weave:* commands",
        );
      },
      (error) => {
        log.error(
          { err: error },
          "Failed to register one or more built-in /weave:* commands",
        );
      },
    );

    log.info({ projectRoot: this.projectRoot }, "OpenCode2Adapter initialized");
  }

  /**
   * Return the list of skills available in the current V2 plugin context.
   *
   * Delegates to `loadAvailableSkillsV2()` (C9), which reads
   * `facade.skill.list()` and adapts each entry into the engine's
   * `SkillInfo` shape. Never throws — failures are logged internally and
   * degrade to `[]`.
   */
  async loadAvailableSkills(): Promise<SkillInfo[]> {
    return loadAvailableSkillsV2(this.facade);
  }

  /**
   * Materialise a sub-agent from the provided normalized descriptor.
   *
   * ## Flow
   *
   * 1. `resolveModelContext()` (C8) — resolves the agent's model intent
   *    against the live catalog. Returns `err` on missing catalog entries or
   *    catalog-read failures.
   * 2. `translateAgent()` (C5) — pure translation of the descriptor plus
   *    resolved model into a V2 `Agent.Info`-shaped object.
   * 3. `reconcileAgent()` (C7) — upserts the translated agent via
   *    `facade.agent.transform()`, hard-erroring on foreign-agent collision.
   * 4. Stores the resulting `V2Registration` in `this.registrations` for
   *    later disposal.
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   * @returns `ok(undefined)` on success, `err(OpenCode2AdapterError)` on
   *   failure (no exceptions are thrown on expected error paths).
   */
  spawnSubagent(
    descriptor: AgentDescriptor,
  ): ResultAsync<void, OpenCode2AdapterHarnessError> {
    return resolveModelContext(this.facade, descriptor)
      .andThen((resolvedModel) => {
        const agentInfo = translateAgent(descriptor, resolvedModel);
        return reconcileAgent(this.facade, agentInfo);
      })
      .map((registration) => {
        this.registrations.push(registration);
        log.info(
          { agent: descriptor.name },
          "Agent materialized successfully via V2 plugin context",
        );
        return undefined;
      })
      .mapErr((error) => {
        log.error(
          { agent: descriptor.name, err: error },
          "Failed to materialize agent via V2 plugin context",
        );
        return toHarnessError(error);
      });
  }

  /**
   * Dispose every accumulated `V2Registration` (built-in commands and
   * materialized agents), in accumulation order.
   *
   * Not part of the `HarnessAdapter` interface — this is adapter-owned
   * teardown surface for callers (e.g. `plugin.ts`'s `Plugin.Cleanup`
   * callback, or embedded-host shutdown) that need to release every
   * resource this adapter registered.
   *
   * Individual `dispose()` failures are collected rather than
   * short-circuiting: every registration gets a disposal attempt regardless
   * of whether an earlier one failed. Returns `err` with the *first*
   * failure encountered if any occurred, after all disposals have been
   * attempted.
   */
  dispose(): ResultAsync<void, OpenCode2AdapterError> {
    const registrations = this.registrations.splice(
      0,
      this.registrations.length,
    );

    return ResultAsync.fromSafePromise(
      (async () => {
        let firstError: OpenCode2AdapterError | undefined;
        for (const registration of registrations) {
          try {
            await registration.dispose();
          } catch (cause) {
            const error = registrationDisposeError("agent", cause);
            log.error({ err: error }, "Failed to dispose V2 registration");
            firstError ??= error;
          }
        }
        return firstError;
      })(),
    ).andThen((firstError) => {
      if (firstError !== undefined) return errAsync(firstError);
      return okAsync(undefined);
    });
  }
}
