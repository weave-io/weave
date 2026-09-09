/**
 * Catalog-backed model context for the V2 adapter.
 *
 * Builds the harness context (`availableModels`, `systemDefault`) from
 * `PluginContextFacade.catalog` accessors and feeds it, together with the
 * agent descriptor's declared model preferences, to the engine's pure
 * `resolveAdapterModelIntent()` helper (imported unchanged from
 * `@weaveio/weave-engine`). This module owns the fail-fast policy: a
 * subagent that declares an explicit model absent from the catalog is a
 * hard error (`MissingCatalogEntry`), never a silent fallback.
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see Spec 33 and `./errors.ts` header for the independent V2
 * error union rationale.
 */

import type { AgentConfig } from "@weaveio/weave-core";
import { resolveAdapterModelIntent } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  catalogUnavailable,
  missingCatalogEntry,
  type OpenCode2AdapterError,
} from "./errors.js";
import type { PluginContextFacade } from "./plugin-context.js";

/** An already-resolved model triple ready for `translateAgent()`. */
export interface ResolvedModelContext {
  providerID: string;
  modelID: string;
  variant?: string;
}

/**
 * Minimal shape this module depends on from `@weaveio/weave-engine`'s
 * `AgentDescriptor` (`packages/engine/src/compose.ts`). Declared as a local
 * structural type so this module's contract stays explicit and reviewable.
 */
export interface ModelResolutionDescriptor {
  name: string;
  mode: AgentConfig["mode"];
  models: string[];
}

/**
 * Resolve `descriptor`'s model intent against the live catalog exposed by
 * `facade.catalog`.
 *
 * Flow:
 * 1. Fetch `provider.list()` / `model.list()` to build a `providerID:modelID`
 *    availability set, and `model.default()` for the system default.
 * 2. Feed `descriptor.models` (already-merged agent + category preferences)
 *    into the engine's pure `resolveAdapterModelIntent()`, constrained by
 *    the availability set.
 * 3. Fail-fast: if `descriptor.mode === "subagent"` declared at least one
 *    explicit model preference and none of them are in the catalog, return
 *    `err(MissingCatalogEntry)` rather than silently falling through to the
 *    system default.
 * 4. Otherwise, resolve the matching `V2CatalogModelInfo` to read its
 *    `providerID`/`modelID` pair back out.
 */
export function resolveModelContext(
  facade: PluginContextFacade,
  descriptor: ModelResolutionDescriptor,
): ResultAsync<ResolvedModelContext, OpenCode2AdapterError> {
  return fetchCatalog(facade).andThen(({ availableModels, systemDefault }) => {
    const intent = resolveAdapterModelIntent({
      agentName: descriptor.name,
      agentMode: descriptor.mode,
      agentModels: descriptor.models,
      systemDefault: systemDefault?.modelID,
      availableModels: new Set(availableModels.keys()),
    });

    if (descriptor.mode === "subagent" && descriptor.models.length > 0) {
      const hasAvailable = descriptor.models.some((model) =>
        availableModels.has(model),
      );
      if (!hasAvailable) {
        return errAsync(
          missingCatalogEntry(descriptor.name, descriptor.models[0] as string),
        );
      }
    }

    const matched = availableModels.get(intent.model);
    if (matched !== undefined) {
      return okAsync({
        providerID: matched.providerID,
        modelID: matched.modelID,
      });
    }

    if (systemDefault !== undefined) {
      return okAsync({
        providerID: systemDefault.providerID,
        modelID: systemDefault.modelID,
      });
    }

    return errAsync(missingCatalogEntry(descriptor.name, intent.model));
  });
}

interface CatalogSnapshot {
  availableModels: Map<string, { providerID: string; modelID: string }>;
  systemDefault: { providerID: string; modelID: string } | undefined;
}

function fetchCatalog(
  facade: PluginContextFacade,
): ResultAsync<CatalogSnapshot, OpenCode2AdapterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const models = await facade.catalog.model.list();
      const defaultModel = await facade.catalog.model.default();
      return { models, defaultModel };
    })(),
    (cause) => catalogUnavailable("model.list", cause),
  ).map(({ models, defaultModel }) => {
    const availableModels = new Map<
      string,
      { providerID: string; modelID: string }
    >();
    for (const model of models) {
      availableModels.set(model.modelID, {
        providerID: model.providerID,
        modelID: model.modelID,
      });
    }

    const systemDefault =
      defaultModel !== null
        ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID }
        : undefined;

    return { availableModels, systemDefault };
  });
}
