import type { AgentDescriptor } from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
} from "./capability-prober.js";
import { WEAVE_COMMAND_NAMES, type WeaveCommandName } from "./commands.js";
import {
  logMaterializationErrors,
  PiConfigActivator,
} from "./config-activator.js";
import {
  PiExtensionController,
  type PiExtensionControllerDeps,
} from "./controller.js";
import {
  BunHostPackageReader,
  type HostPackageReader,
} from "./host-compatibility.js";
import { readValidatedCommands } from "./host-inventory.js";
import type { PiModelApplyPort } from "./model-resolution.js";
import { safelyListAvailableModels } from "./port-safety.js";
import {
  DEFAULT_PRIMARY_AGENT_NAME,
  type PiPrimaryActivationError,
  PiPrimarySession,
} from "./primary-session.js";
import { PiSafeInitializer } from "./safe-initializer.js";
import { PiSkillCatalog } from "./skill-catalog.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiExtensionApi,
  PiModelInfo,
  PiSessionContext,
  PiSkillInfo,
} from "./types.js";

/** Every dependency this extension needs beyond what Pi hands it directly. Fully injectable for tests. */
export interface PiExtensionDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: PiAdapterLogger;
  readonly configActivator: PiConfigActivator;
}

class CryptoIdGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Production dependency set. No I/O happens here - everything is deferred to `session_start`. */
export function createDefaultPiExtensionDeps(): PiExtensionDeps {
  return {
    hostPackageReader: new BunHostPackageReader(),
    capabilityProber: new DefaultPiCapabilityProber(),
    idGenerator: new CryptoIdGenerator(),
    clock: new SystemClock(),
    logger: logger.child({ module: "adapter-pi" }),
    configActivator: new PiConfigActivator(),
  };
}

/**
 * The materialized descriptor catalog and primary-activation state for one
 * generation (Spec 33 §7.2 steps 5-8, 13-14). Kept out of
 * `PiExtensionController`'s own `PiGeneration` type for this task so the
 * task-6 controller contract stays stable; a future task may fold this in.
 *
 * Primary activation (skills + model, together) is deferred from
 * `session_start` to the *first* `before_agent_start` on purpose: Pi only
 * exposes its loaded skill catalog via `systemPromptOptions.skills` at that
 * point (not at `session_start`), and Spec 33 §8.2/§28 requires activation
 * to be atomic across skills and model together - so neither can be
 * committed before both are knowable.
 */
interface PiActiveSession {
  readonly generationId: string;
  readonly primarySession: PiPrimarySession;
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>;
  readonly disabledSkills: readonly string[];
  pendingPrimaryName: string | undefined;
  primaryActivationAttempted: boolean;
  primaryActivationFailure: PiPrimaryActivationError | undefined;
}

/** Reads `event.systemPrompt` (Spec 33 §8.3) without assuming any other event shape. */
function readSystemPrompt(event: unknown): string {
  if (typeof event === "object" && event !== null && "systemPrompt" in event) {
    const value = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Reads `event.systemPromptOptions.skills` (Pi's real, already-loaded skill
 * catalog for this turn - Spec 33 §9.1) without assuming any other shape.
 * Malformed or missing entries are dropped rather than throwing.
 */
function readBeforeAgentStartSkills(event: unknown): readonly PiSkillInfo[] {
  if (typeof event !== "object" || event === null) return [];
  const options = (event as { systemPromptOptions?: unknown })
    .systemPromptOptions;
  if (typeof options !== "object" || options === null) return [];
  const skills = (options as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter(
    (skill): skill is PiSkillInfo =>
      typeof skill === "object" &&
      skill !== null &&
      typeof (skill as { name?: unknown }).name === "string",
  );
}

/**
 * Wraps Pi's real `ExtensionAPI.setModel(model)` (Spec 33 §9.2) so a
 * throwing or rejecting host call never escapes as an unhandled exception -
 * it is captured and reported as a degraded model activation instead.
 */
function createPiModelApplyPort(pi: PiExtensionApi): PiModelApplyPort {
  return {
    applyModel: (model: PiModelInfo) =>
      ResultAsync.fromThrowable(
        async () => {
          const applied = await pi.setModel(model);
          // `setModel` may resolve to `false` without throwing (the host
          // declined the selection) - that is a failed application, not a
          // success, and must not be silently treated as one.
          if (applied === false) {
            throw new Error("Pi declined the model selection");
          }
        },
        (cause): Error =>
          cause instanceof Error ? cause : new Error(String(cause)),
      )(),
  };
}

function commandDescription(name: WeaveCommandName): string {
  switch (name) {
    case "weave:start":
      return "Start an explicit Weave plan";
    case "weave:run":
      return "Start a configured Weave workflow";
    case "weave:status":
      return "Show the current Weave adapter and execution status";
    case "weave:abort":
      return "Cancel the active Weave execution and its child tree";
    case "weave:advance":
      return "Apply an explicit user confirmation to the current step";
    case "weave:health":
      return "Show Weave adapter capability and readiness diagnostics";
    case "weave:resume":
      return "Explicitly resume a paused or recoverable execution";
    case "weave:plan":
      return "Show the full read-only plan task tree";
    case "weave:artifact":
      return "Approve or reject a pending artifact revision";
  }
}

function renderHealthOnlyBlockedMessage(name: WeaveCommandName): string {
  return `Weave is in health-only mode; ${name} is unavailable until required capabilities recover. Run /weave:health for details.`;
}

function renderHealthMessage(
  controller: PiExtensionController,
  activeSession: PiActiveSession | undefined,
): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return "Weave has not completed activation yet.";
  }
  const { healthReport } = generation.preflight;
  const lines = healthReport.effectiveCapabilities.map(
    (capability) =>
      `${capability.id}: ${capability.effectiveReadiness} (declared ${capability.declaredReadiness})`,
  );
  const mode = generation.healthOnlyMode ? "health-only" : "ready";
  const result = [`Weave adapter mode: ${mode}`, ...lines];

  if (activeSession?.generationId === generation.id) {
    for (const warning of activeSession.primarySession.getCapabilityWarnings()) {
      result.push(
        `warning [${warning.capability}] ${warning.agentName}: ${warning.detail}`,
      );
    }
    if (activeSession.primaryActivationFailure !== undefined) {
      result.push(
        `primary activation failed: ${activeSession.primaryActivationFailure.type}`,
      );
    }
  }
  return result.join("\n");
}

function renderStatusMessage(controller: PiExtensionController): string {
  const generation = controller.getCurrentGeneration();
  if (generation === undefined) {
    return "Weave has not completed activation yet.";
  }
  return [
    `generation: ${generation.id}`,
    `trust: ${generation.preflight.trust}`,
    `mode: ${generation.preflight.mode}`,
    `health-only: ${generation.healthOnlyMode}`,
  ].join("\n");
}

/**
 * The one compiled extension entry (Spec 33 §5/§7.1). The returned factory is
 * synchronous and, per Spec 33 §7.1, only: constructs the controller, registers the
 * nine inert `/weave:*` command shells and the lifecycle delegates, and
 * returns. It never loads project config, opens the Runtime Store, starts a
 * timer, or launches a child process at factory time.
 */
export function createPiExtension(
  overrides: Partial<PiExtensionDeps> = {},
): (pi: PiExtensionApi) => void {
  const deps: PiExtensionDeps = {
    ...createDefaultPiExtensionDeps(),
    ...overrides,
  };
  const controllerDeps: PiExtensionControllerDeps = {
    safeInitializer: new PiSafeInitializer({
      hostPackageReader: deps.hostPackageReader,
      capabilityProber: deps.capabilityProber,
      configActivator: deps.configActivator,
    }),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    logger: deps.logger,
  };
  const controller = new PiExtensionController(controllerDeps);
  let activeSession: PiActiveSession | undefined;

  return function piAdapterExtension(pi: PiExtensionApi): void {
    for (const name of WEAVE_COMMAND_NAMES) {
      pi.registerCommand(name, {
        description: commandDescription(name),
        handler: (_rawArgs: string, ctx: PiSessionContext) => {
          const gate = controller.evaluateCommandGate(name);
          if (gate.isErr()) {
            ctx.ui.notify(gate.error.safeMessage, "error");
            return;
          }
          if (!gate.value.allowed) {
            ctx.ui.notify(renderHealthOnlyBlockedMessage(name), "warning");
            return;
          }
          if (name === "weave:health") {
            ctx.ui.notify(
              renderHealthMessage(controller, activeSession),
              "info",
            );
            return;
          }
          if (name === "weave:status") {
            ctx.ui.notify(renderStatusMessage(controller), "info");
            return;
          }
          if (name === "weave:abort") {
            ctx.ui.notify("No active Weave execution to abort.", "info");
            return;
          }
          ctx.ui.notify(
            `${name} is not yet implemented in this Weave adapter build.`,
            "info",
          );
        },
      });
    }

    pi.on("session_start", async (_event, ctx: PiSessionContext) => {
      const commands = readValidatedCommands(pi);
      if (commands.isErr()) {
        ctx.ui.notify(commands.error.safeMessage, "error");
        return;
      }
      const activation = await controller.activate(ctx, commands.value);
      if (activation.isErr()) {
        ctx.ui.notify(activation.error.safeMessage, "error");
        return;
      }
      const generation = activation.value;
      ctx.ui.setStatus(
        "weave",
        generation.healthOnlyMode
          ? "health-only - run /weave:health for details"
          : "ready",
      );

      // Spec 33 §28: wrong mode/host/version blocks config activation
      // entirely - `PiSafeInitializer.preflight` never calls
      // `PiConfigActivator` in that state, so `configActivation` below is
      // always `undefined` here. This check makes that guarantee explicit
      // at the call site too.
      if (
        !generation.preflight.modeSupported ||
        !generation.preflight.hostSupported
      ) {
        return;
      }

      if (generation.preflight.configActivationFailure !== undefined) {
        const failure = generation.preflight.configActivationFailure;
        deps.logger.warn(
          { code: failure.code, safeMessage: failure.safeMessage },
          "config activation failed",
        );
        return;
      }

      const configActivation = generation.preflight.configActivation;
      if (configActivation === undefined) return;

      logMaterializationErrors(
        configActivation.descriptors.errors,
        deps.logger,
      );

      activeSession = {
        generationId: generation.id,
        primarySession: new PiPrimarySession({
          skillCatalog: new PiSkillCatalog([]),
          logger: deps.logger,
        }),
        descriptors: configActivation.descriptors.byName,
        disabledSkills: configActivation.config.disabled?.skills ?? [],
        pendingPrimaryName: DEFAULT_PRIMARY_AGENT_NAME,
        primaryActivationAttempted: false,
        primaryActivationFailure: undefined,
      };
    });

    pi.on("before_agent_start", async (event, ctx: PiSessionContext) => {
      if (activeSession === undefined) return undefined;
      if (
        activeSession.generationId !== controller.getCurrentGeneration()?.id
      ) {
        return undefined;
      }

      const session = activeSession;
      const systemPrompt = readSystemPrompt(event);

      // Already committed this generation: just append. Re-resolving here
      // would silently override a native mid-session user model change
      // (Spec 33 §9.2 "a native user model change governs the current
      // active period"), so activation only happens once per generation.
      if (session.primarySession.getCurrent() !== undefined) {
        return {
          systemPrompt:
            session.primarySession.appendToSystemPrompt(systemPrompt),
        };
      }

      if (session.primaryActivationAttempted) return undefined;
      session.primaryActivationAttempted = true;

      const pendingName = session.pendingPrimaryName;
      if (pendingName === undefined) return undefined;
      const descriptor = session.descriptors.get(pendingName);
      if (descriptor === undefined) {
        deps.logger.warn(
          { agentName: pendingName },
          "default primary descriptor unavailable; ordinary chat has no active Weave primary",
        );
        return undefined;
      }

      // Pi only exposes its loaded skill catalog here, at the first turn
      // (Spec 33 §9.1) - refresh the catalog immediately before the
      // atomic activation that depends on it.
      session.primarySession.refreshSkills(readBeforeAgentStartSkills(event));

      // Capture a staleness handle *before* the await below: activation
      // (including `pi.setModel`) can take an arbitrary amount of time, and
      // a session replacement (reload/fork/switch/new session_start) can
      // install a fresh generation and a fresh `activeSession` while this
      // call is still in flight.
      const operation = controller.beginOperation();
      if (operation.isErr()) return undefined;
      const handle = operation.value;

      // `ctx.modelRegistry` is host-supplied; a throwing `getAvailable()`
      // must not crash this turn - fall back to an empty catalog, which
      // safely degrades model resolution rather than failing activation.
      const availableModelsResult = safelyListAvailableModels(
        ctx.modelRegistry,
      );
      if (availableModelsResult.isErr()) {
        // `availableModelsResult.error` is always the fixed, closed-set
        // `MODEL_REGISTRY_THREW_REASON` literal - never anything derived
        // from what the host actually threw, since that content cannot be
        // trusted not to contain private paths, environment values, or
        // secrets (Spec 33 closed-failure contract).
        deps.logger.warn(
          {
            agentName: descriptor.name,
            reason: availableModelsResult.error,
          },
          "ctx.modelRegistry.getAvailable() threw; treating as no available models this turn",
        );
      }

      const activationResult = await session.primarySession.activate(
        descriptor,
        {
          availableModels: availableModelsResult.unwrapOr([]),
          currentModel: ctx.model,
          modelApplier: createPiModelApplyPort(pi),
          disabledSkills: session.disabledSkills,
        },
      );

      if (handle.assertStillCurrent().isErr()) {
        // A newer generation replaced this one while we were awaiting
        // skill/model activation. `pi.setModel` may already have been
        // applied against a session that is no longer current and cannot
        // safely be undone - surface that as a visible degradation rather
        // than silently dropping it, but never return this stale call's
        // descriptor prompt as authoritative for the new generation.
        if (activationResult.isOk()) {
          deps.logger.warn(
            { agentName: descriptor.name, generationId: session.generationId },
            "primary activation settled after session replacement; discarding stale authority (a model change may already be applied and cannot be safely restored)",
          );
        }
        return undefined;
      }

      if (activationResult.isErr()) {
        session.primaryActivationFailure = activationResult.error;
        deps.logger.warn(
          { agentName: descriptor.name, error: activationResult.error.type },
          "primary activation failed; prompt not appended this turn",
        );
        return undefined;
      }

      return {
        systemPrompt: session.primarySession.appendToSystemPrompt(systemPrompt),
      };
    });

    pi.on("session_shutdown", () => {
      activeSession = undefined;
      controller.shutdown();
    });
  };
}

export default createPiExtension();
