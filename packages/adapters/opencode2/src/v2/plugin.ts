import { logger } from "@weaveio/weave-engine";
import { WeaveRpc } from "../rpc.js";
import {
  type V2OpenCodeEvent as OpenCodeEvent,
  V2PluginModule as Plugin,
} from "../sdk-types.js";
import { registerOpenCode2Agents } from "./agent-registration.js";
import { buildOpenCode2Catalog } from "./catalog.js";
import { OpenCode2Commands } from "./commands.js";
import { OpenCode2CatalogController } from "./config-refresh.js";
import { probeCatalogSources } from "./config-source.js";
import { fromOpenCode2Promise } from "./errors.js";
import type { OpenCode2Context } from "./host-types.js";
import { parseOpenCode2Options } from "./options.js";
import { OpenCode2PlanSessionState } from "./plan-session-state.js";
import { createOpenCode2RpcHandlers } from "./rpc-handlers.js";
import { OpenCode2SessionHooks } from "./session-hooks.js";

const log = logger.child({ module: "adapter-opencode/v2" });
type Registration = { readonly dispose: () => Promise<void> };

function inventoryEventMatches(
  context: OpenCode2Context,
  event: OpenCodeEvent,
): boolean {
  if (event.type !== "catalog.updated" && event.type !== "skill.updated")
    return false;
  if (event.location?.directory !== context.location.directory) return false;
  return event.location.workspaceID === context.location.workspaceID;
}

function observeInventory(
  context: OpenCode2Context,
  controller: OpenCode2CatalogController,
  signal: AbortSignal,
  afterCatalogUpdate: () => Promise<void>,
) {
  return fromOpenCode2Promise(
    async () => {
      for await (const event of context.event.subscribe({ signal })) {
        if (signal.aborted) return;
        if (!inventoryEventMatches(context, event)) continue;
        const refreshed = await controller.refreshInventory();
        if (refreshed.isErr() && refreshed.error.code !== "disposed") {
          log.warn({ code: refreshed.error.code }, refreshed.error.message);
        }
        if (event.type === "catalog.updated") await afterCatalogUpdate();
      }
    },
    "host_unavailable",
    "OpenCode inventory events could not be observed",
  );
}

export interface OpenCode2PluginDependencies {
  readonly buildCatalog?: typeof buildOpenCode2Catalog;
}

async function disposeRegistrations(
  registrations: readonly Registration[],
): Promise<void> {
  await Promise.allSettled(
    [...registrations].reverse().map((registration) => registration.dispose()),
  );
}

export async function setupOpenCode2(
  context: OpenCode2Context,
  dependencies: OpenCode2PluginDependencies = {},
): Promise<() => Promise<void>> {
  const options = parseOpenCode2Options(context.options);
  if (options.isErr()) {
    log.warn({ code: options.error.code }, options.error.message);
    return async () => undefined;
  }

  const catalogBuilder = dependencies.buildCatalog ?? buildOpenCode2Catalog;
  const build = () =>
    fromOpenCode2Promise(
      () => Promise.all([context.catalog.model.list(), context.skill.list()]),
      "catalog_unavailable",
      "OpenCode model or skill inventory could not be read",
    ).andThen(([models, skills]) =>
      catalogBuilder({
        location: context.location.directory,
        projectConfig: options.value.projectConfig,
        models: models.data,
        skills: skills.data,
      }),
    );

  const controller = new OpenCode2CatalogController(
    options.value.refreshIntervalMs,
    {
      build,
      changed: (current) =>
        probeCatalogSources(current.sources).mapErr(() => ({
          code: "config_unavailable" as const,
          message: "Weave sources could not be checked",
        })),
      reload: async () => {
        await context.agent.reload();
        await context.command.reload();
      },
    },
  );
  const initial = await controller.initialize();
  if (initial.isErr())
    log.warn({ code: initial.error.code }, initial.error.message);

  let afterCatalogUpdate = async (): Promise<void> => undefined;
  const inventoryAbort = new AbortController();
  const inventoryObservation = observeInventory(
    context,
    controller,
    inventoryAbort.signal,
    () => afterCatalogUpdate(),
  );
  void inventoryObservation.then((observed) => {
    if (observed.isErr() && !inventoryAbort.signal.aborted) {
      log.warn({ code: observed.error.code }, observed.error.message);
    }
  });

  const registrations: Registration[] = [];
  const inserted = new Set<string>();
  const readiness = {
    prompt: false,
    context: false,
    rpc: false,
    command: false,
  };
  const agentRegistration = await fromOpenCode2Promise(
    () =>
      context.agent.transform((editor) => {
        const catalog = controller.catalog();
        if (catalog === undefined) return;
        registerOpenCode2Agents(
          editor,
          catalog,
          inserted,
          options.value.defaultAgent,
        );
      }),
    "host_unavailable",
    "Weave agent registration failed",
  );
  if (agentRegistration.isErr()) {
    controller.dispose();
    inventoryAbort.abort();
    await inventoryObservation;
    log.warn(
      { code: agentRegistration.error.code },
      agentRegistration.error.message,
    );
    return async () => undefined;
  }
  registrations.push(agentRegistration.value);

  const sessionHooks = new OpenCode2SessionHooks({
    location: context.location.directory,
    workspaceID: context.location.workspaceID,
    catalog: () => controller.catalog(),
    ownsAgent: (agent) => inserted.has(agent),
    refresh: () => controller.refreshIfDue(),
    session: context.session,
  });
  const promptRegistration = await fromOpenCode2Promise(
    () =>
      context.session.hook("prompt", async (input) => {
        const result = await sessionHooks.applyPrompt(input);
        if (result.isErr())
          log.warn({ code: result.error.code }, result.error.message);
      }),
    "host_unavailable",
    "Weave prompt hook registration failed",
  );
  if (promptRegistration.isOk()) {
    registrations.push(promptRegistration.value);
    readiness.prompt = true;
  } else {
    log.warn(
      { code: promptRegistration.error.code },
      promptRegistration.error.message,
    );
  }

  const contextRegistration = await fromOpenCode2Promise(
    () =>
      context.session.hook("context", async (input) => {
        const result = await sessionHooks.applyContext(input);
        if (result.isErr())
          log.warn({ code: result.error.code }, result.error.message);
      }),
    "host_unavailable",
    "Weave context hook registration failed",
  );
  if (contextRegistration.isOk()) {
    registrations.push(contextRegistration.value);
    readiness.context = true;
  } else {
    log.warn(
      { code: contextRegistration.error.code },
      contextRegistration.error.message,
    );
  }

  const plans = new OpenCode2PlanSessionState(context.storage);
  const rpcRegistration = await fromOpenCode2Promise(
    () =>
      context.rpc.register(
        WeaveRpc,
        createOpenCode2RpcHandlers({
          location: context.location.directory,
          workspaceID: context.location.workspaceID,
          session: context.session,
          catalog: controller,
          plans,
          ownsAgent: (agent) => inserted.has(agent),
          registration: () => ({
            requestIntent: readiness.prompt && readiness.context,
            foregroundPlans: readiness.command,
            planDisplay: readiness.rpc,
          }),
        }),
      ),
    "host_unavailable",
    "Weave RPC registration failed",
  );
  if (rpcRegistration.isErr()) {
    await disposeRegistrations(registrations);
    controller.dispose();
    inventoryAbort.abort();
    await inventoryObservation;
    log.warn(
      { code: rpcRegistration.error.code },
      rpcRegistration.error.message,
    );
    return async () => undefined;
  }
  registrations.push(rpcRegistration.value);
  readiness.rpc = true;

  const commands = new OpenCode2Commands({
    location: context.location.directory,
    workspaceID: context.location.workspaceID,
    context,
    refresh: () => controller.refreshIfDue(),
    ownsAgent: (agent) => inserted.has(agent),
    plans,
    planChanged: (sessionID, scopeToken) =>
      rpcRegistration.value.events.emit("plan.changed", {
        sessionID,
        scopeToken,
      }),
  });
  let commandRegistration: Registration | undefined;
  const initialCommandRegistration = await fromOpenCode2Promise(
    () => context.command.transform((editor) => commands.register(editor)),
    "host_unavailable",
    "Weave command registration failed",
  );
  if (initialCommandRegistration.isOk()) {
    commandRegistration = initialCommandRegistration.value;
    readiness.command = true;
  } else {
    log.warn(
      { code: initialCommandRegistration.error.code },
      initialCommandRegistration.error.message,
    );
  }

  let commandRebased = false;
  afterCatalogUpdate = async () => {
    if (
      commandRebased ||
      commandRegistration === undefined ||
      inventoryAbort.signal.aborted
    )
      return;
    commandRebased = true;
    const disposed = await fromOpenCode2Promise(
      () => commandRegistration?.dispose() ?? Promise.resolve(),
      "host_unavailable",
      "Weave command registration could not be reordered after host configuration",
    );
    if (disposed.isErr()) {
      readiness.command = false;
      log.warn({ code: disposed.error.code }, disposed.error.message);
      return;
    }
    const registered = await fromOpenCode2Promise(
      () => context.command.transform((editor) => commands.register(editor)),
      "host_unavailable",
      "Weave reserved command registration failed",
    );
    if (registered.isErr()) {
      commandRegistration = undefined;
      readiness.command = false;
      log.warn({ code: registered.error.code }, registered.error.message);
      return;
    }
    commandRegistration = registered.value;
    readiness.command = true;
  };

  return async () => {
    controller.dispose();
    inventoryAbort.abort();
    await inventoryObservation;
    if (commandRegistration !== undefined) await commandRegistration.dispose();
    await disposeRegistrations(registrations);
  };
}

export const WeavePlugin = Plugin.define({
  id: "weave",
  setup: setupOpenCode2,
});

export const server = WeavePlugin;
export default WeavePlugin;
