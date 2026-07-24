import { logger } from "@weaveio/weave-engine";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
} from "./capability-prober.js";
import { WEAVE_COMMAND_NAMES, type WeaveCommandName } from "./commands.js";
import {
  PiExtensionController,
  type PiExtensionControllerDeps,
} from "./controller.js";
import {
  BunHostPackageReader,
  type HostPackageReader,
} from "./host-compatibility.js";
import { readValidatedCommands } from "./host-inventory.js";
import { PiSafeInitializer } from "./safe-initializer.js";
import type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiExtensionApi,
  PiSessionContext,
} from "./types.js";

/** Every dependency this extension needs beyond what Pi hands it directly. Fully injectable for tests. */
export interface PiExtensionDeps {
  readonly hostPackageReader: HostPackageReader;
  readonly capabilityProber: PiCapabilityProbeSource;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly logger: PiAdapterLogger;
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

function renderHealthMessage(controller: PiExtensionController): string {
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
  return [`Weave adapter mode: ${mode}`, ...lines].join("\n");
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
 * nine inert `/weave:*` command shells and the `session_start`/
 * `session_shutdown` lifecycle delegates, and returns. It never loads
 * project config, opens the Runtime Store, materializes descriptors, starts
 * a timer, or launches a child process.
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
    }),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    logger: deps.logger,
  };
  const controller = new PiExtensionController(controllerDeps);

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
            ctx.ui.notify(renderHealthMessage(controller), "info");
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
      activation.match(
        (generation) => {
          if (generation.healthOnlyMode) {
            ctx.ui.setStatus(
              "weave",
              "health-only - run /weave:health for details",
            );
            return;
          }
          ctx.ui.setStatus("weave", "ready");
        },
        (failure) => {
          ctx.ui.notify(failure.safeMessage, "error");
        },
      );
    });

    pi.on("session_shutdown", () => {
      controller.shutdown();
    });
  };
}

export default createPiExtension();
