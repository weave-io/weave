import { okAsync, type ResultAsync } from "neverthrow";
import type { PiModelInfo } from "./types.js";

export type { PiModelInfo } from "./types.js";

/**
 * Pi-owned deterministic model matching (Spec 33 §6, §9.2).
 *
 * Weave's engine `resolveAdapterModelIntent` (see `@weaveio/weave-engine`)
 * resolves an *ordered preference list* against a flat set of exact-string
 * model identifiers. Pi's authenticated model catalog is richer — each entry
 * has a `provider`, an `id`, and an optional human-readable `name` — and
 * Spec 33 §9.2 requires a specific three-tier exact-match cascade over that
 * shape. That cascade is Pi-specific (adapter-owned): the engine helper does
 * not attempt canonical `provider/id` composition or bare-id/name uniqueness
 * checks, so this module implements the cascade directly rather than forcing
 * it through the generic engine helper.
 *
 * Rules (Spec 33 §9.2, §28):
 * 1. Exact canonical `provider/id` match.
 * 2. Exact bare `id` match, only when the id is unique across the catalog.
 * 3. Exact human-readable `name` match, only when the name is unique.
 * Unavailable entries are skipped; there is no fuzzy matching. If nothing in
 * the ordered model intent resolves, the caller must retain whatever Pi
 * model is currently active and treat that descriptor's model health as
 * degraded — this module reports `{ resolved: false }` for that case and
 * does not choose a fallback itself.
 *
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md
 * @see docs/adapter-boundary.md
 */

/** Which tier of the Spec 33 §9.2 cascade produced a resolution. */
export type PiModelResolutionSource = "canonical" | "bare-id" | "human-name";

/**
 * Outcome of resolving one descriptor's ordered `models` intent against a
 * Pi model catalog. `resolved: false` means every entry was skipped; the
 * caller must keep the current Pi model and mark this descriptor's model
 * health as degraded (Spec 33 §9.2, §28).
 */
export type PiModelResolution =
  | {
      readonly resolved: true;
      readonly model: PiModelInfo;
      readonly intentEntry: string;
      readonly source: PiModelResolutionSource;
    }
  | {
      readonly resolved: false;
    };

/**
 * Pi-owned deterministic model matcher (Spec 33 §6 `PiModelResolver`).
 *
 * Pure and stateless: no I/O, no harness calls. The adapter is responsible
 * for supplying the current authenticated model catalog (`availableModels`)
 * from whatever real Pi discovery mechanism is wired in.
 */
export class PiModelResolver {
  resolve(
    modelIntent: readonly string[],
    availableModels: readonly PiModelInfo[],
  ): PiModelResolution {
    for (const entry of modelIntent) {
      const canonical = availableModels.find(
        (model) => `${model.provider}/${model.id}` === entry,
      );
      if (canonical !== undefined) {
        return {
          resolved: true,
          model: canonical,
          intentEntry: entry,
          source: "canonical",
        };
      }

      const bareIdMatches = availableModels.filter(
        (model) => model.id === entry,
      );
      if (bareIdMatches.length === 1) {
        return {
          resolved: true,
          model: bareIdMatches[0] as PiModelInfo,
          intentEntry: entry,
          source: "bare-id",
        };
      }

      const nameMatches = availableModels.filter(
        (model) => model.name === entry,
      );
      if (nameMatches.length === 1) {
        return {
          resolved: true,
          model: nameMatches[0] as PiModelInfo,
          intentEntry: entry,
          source: "human-name",
        };
      }
    }

    return { resolved: false };
  }
}

/**
 * Adapter-facing seam over Pi's real `ExtensionAPI.setModel(model)`
 * (Spec 33 §9.2). Production wiring wraps the real host call with
 * `ResultAsync.fromThrowable` so a throwing/rejecting host call never
 * escapes as an unhandled exception; tests inject a fully-controlled fake.
 */
export interface PiModelApplyPort {
  applyModel(model: PiModelInfo): ResultAsync<void, Error>;
}

/**
 * The outcome of resolving *and applying* a descriptor's model intent
 * (Spec 33 §9.2, §28): either the resolved model was successfully applied
 * through `pi.setModel`, or the descriptor's model health is degraded and
 * the caller must leave Pi's current model untouched. `reason` distinguishes
 * "nothing in the ordered intent resolved" from "resolution succeeded but
 * the host rejected applying it".
 */
export type PiModelActivationOutcome =
  | {
      readonly status: "applied";
      readonly model: PiModelInfo;
      readonly intentEntry: string;
      readonly source: PiModelResolutionSource;
    }
  | {
      readonly status: "degraded";
      readonly reason: "unresolved" | "apply-failed";
      readonly currentModel: PiModelInfo | undefined;
    };

/**
 * Spec 33 §6/§9.2: resolves a descriptor's ordered model intent against
 * Pi's authenticated catalog, then applies it through the injected
 * `PiModelApplyPort`. Never fuzzy-matches, never falls back to a
 * different model, and never throws — every failure path (unresolved
 * intent, or a host that rejects `setModel`) reports `degraded` and
 * preserves whatever model Pi already had active.
 */
export class PiModelActivator {
  constructor(
    private readonly resolver: PiModelResolver = new PiModelResolver(),
  ) {}

  activate(
    modelIntent: readonly string[],
    availableModels: readonly PiModelInfo[],
    currentModel: PiModelInfo | undefined,
    applier: PiModelApplyPort,
  ): ResultAsync<PiModelActivationOutcome, never> {
    const resolution = this.resolver.resolve(modelIntent, availableModels);
    if (!resolution.resolved) {
      return okAsync({
        status: "degraded",
        reason: "unresolved",
        currentModel,
      });
    }

    return applier
      .applyModel(resolution.model)
      .map(
        (): PiModelActivationOutcome => ({
          status: "applied",
          model: resolution.model,
          intentEntry: resolution.intentEntry,
          source: resolution.source,
        }),
      )
      .orElse(() =>
        okAsync<PiModelActivationOutcome, never>({
          status: "degraded",
          reason: "apply-failed",
          currentModel,
        }),
      );
  }
}
