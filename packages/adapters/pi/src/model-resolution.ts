import {
  parseModelIntentEntry,
  type ThinkingLevelDecl,
} from "@weaveio/weave-engine";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { PiModelInfo as PiCatalogModelInfo } from "./types.js";

/**
 * Authenticated Pi catalog model plus the optional host context-window fact
 * consumed by runtime failover. The field is optional because older Pi model
 * catalogs do not expose it.
 */
export type PiModelInfo = PiCatalogModelInfo & {
  readonly contextWindow?: number;
};

/** Explicit name for model objects passed to failover contracts. */
export type PiModelInfoWithContextWindow = PiModelInfo;

/**
 * Pi-owned deterministic model matching (Pi adapter contract).
 *
 * Weave's engine `resolveAdapterModelIntent` (see `@weaveio/weave-engine`)
 * resolves an *ordered preference list* against a flat set of exact-string
 * model identifiers. Pi's authenticated model catalog is richer — each entry
 * has a `provider`, an `id`, and an optional human-readable `name` — and
 * The Pi adapter contract requires a specific three-tier exact-match cascade over that
 * shape. That cascade is Pi-specific (adapter-owned): the engine helper does
 * not attempt canonical `provider/id` composition or bare-id/name uniqueness
 * checks, so this module implements the cascade directly rather than forcing
 * it through the generic engine helper.
 *
 * Rules (Pi adapter contract):
 * 1. Exact canonical `provider/id` match.
 * 2. Exact bare `id` match, only when the id is unique across the catalog.
 * 3. Exact human-readable `name` match, only when the name is unique.
 * Unavailable entries are skipped; there is no fuzzy matching. If nothing in
 * the ordered model intent resolves, the caller must retain whatever Pi
 * model is currently active and treat that descriptor's model health as
 * degraded — this module reports `{ resolved: false }` for that case and
 * does not choose a fallback itself.
 *
 * @see docs/adapters/pi.md
 * @see docs/architecture/adapter-boundary.md
 */

/** Which tier of the Pi adapter contract cascade produced a resolution. */
export type PiModelResolutionSource = "canonical" | "bare-id" | "human-name";

/**
 * Outcome of resolving one descriptor's ordered `models` intent against a
 * Pi model catalog. `resolved: false` means every entry was skipped; the
 * caller must keep the current Pi model and mark this descriptor's model
 * health as degraded (Pi adapter contract).
 */
export type PiModelResolution =
  | {
      readonly resolved: true;
      readonly model: PiModelInfo;
      readonly intentEntry: string;
      readonly source: PiModelResolutionSource;
      readonly thinkingLevel?: ThinkingLevelDecl;
    }
  | {
      readonly resolved: false;
    };

/** A successful resolution suitable for the runtime failover candidate list. */
export type PiOrderedModelResolution = Extract<
  PiModelResolution,
  { readonly resolved: true }
>;

/** Candidate-list bound shared by ordered runtime model selection. */
export const MAX_PI_ORDERED_MODEL_CANDIDATES = 64;

function thinkingFields(level: ThinkingLevelDecl | undefined): {
  readonly thinkingLevel?: ThinkingLevelDecl;
} {
  if (level === undefined) return {};
  return { thinkingLevel: level };
}

export type PiModelIdentityResolutionError =
  | { readonly type: "ModelIdentityUnavailable" }
  | { readonly type: "ModelIdentityAmbiguous" };

/**
 * Pi-owned deterministic model matcher (Pi adapter contract `PiModelResolver`).
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
      const parsed = parseModelIntentEntry(entry);
      const baseModel = parsed.isOk() ? parsed.value.baseModel : entry;
      const thinkingLevel = parsed.isOk()
        ? parsed.value.thinkingLevel
        : undefined;
      const canonical = availableModels.find(
        (model) => `${model.provider}/${model.id}` === baseModel,
      );
      if (canonical !== undefined) {
        return {
          resolved: true,
          model: canonical,
          intentEntry: entry,
          source: "canonical",
          ...thinkingFields(thinkingLevel),
        };
      }

      const bareIdMatches = availableModels.filter(
        (model) => model.id === baseModel,
      );
      if (bareIdMatches.length === 1) {
        return {
          resolved: true,
          model: bareIdMatches[0] as PiModelInfo,
          intentEntry: entry,
          source: "bare-id",
          ...thinkingFields(thinkingLevel),
        };
      }

      const nameMatches = availableModels.filter(
        (model) => model.name === baseModel,
      );
      if (nameMatches.length === 1) {
        return {
          resolved: true,
          model: nameMatches[0] as PiModelInfo,
          intentEntry: entry,
          source: "human-name",
          ...thinkingFields(thinkingLevel),
        };
      }
    }

    return { resolved: false };
  }

  /**
   * Resolve every ordered model preference into a distinct failover list.
   *
   * Each entry is resolved independently through the unchanged canonical →
   * unique bare-id → unique human-name cascade. The first entry that resolves
   * to a canonical provider/id wins that identity; later aliases for the same
   * identity are skipped. This preserves both preference order and the
   * thinking suffix attached to the winning entry.
   */
  resolveOrderedDistinct(
    modelIntent: readonly string[],
    availableModels: readonly PiModelInfo[],
  ): readonly PiOrderedModelResolution[] {
    const seenCanonicalIdentities = new Set<string>();
    const resolved: PiOrderedModelResolution[] = [];

    for (const entry of modelIntent) {
      const candidate = this.resolve([entry], availableModels);
      if (!candidate.resolved) continue;
      const identity = `${candidate.model.provider}/${candidate.model.id}`;
      if (seenCanonicalIdentities.has(identity)) continue;
      seenCanonicalIdentities.add(identity);
      resolved.push(candidate);
      if (resolved.length >= MAX_PI_ORDERED_MODEL_CANDIDATES) break;
    }

    return resolved;
  }

  /**
   * Rehydrates a compact authenticated model identity from a child control
   * body into the one full model object owned by this Pi process. The host's
   * `setModel()` requires that catalog object, not the compact transport
   * shape. Missing and duplicate canonical identities fail closed.
   */
  resolveIdentity(
    identity: Pick<PiModelInfo, "provider" | "id">,
    availableModels: readonly PiModelInfo[],
  ): Result<PiModelInfo, PiModelIdentityResolutionError> {
    const matches = availableModels.filter(
      (model) =>
        model.provider === identity.provider && model.id === identity.id,
    );
    if (matches.length === 0) return err({ type: "ModelIdentityUnavailable" });
    if (matches.length > 1) return err({ type: "ModelIdentityAmbiguous" });
    return ok(matches[0] as PiModelInfo);
  }
}

/** Resolve an ordered, canonical-distinct model list without applying a model. */
export function resolvePiOrderedDistinctModels(
  modelIntent: readonly string[],
  availableModels: readonly PiModelInfo[],
): readonly PiOrderedModelResolution[] {
  return new PiModelResolver().resolveOrderedDistinct(
    modelIntent,
    availableModels,
  );
}

/** Compatibility spelling for the fallback coordinator. */
export const resolveOrderedDistinctPiModels = resolvePiOrderedDistinctModels;

/**
 * Adapter-facing seam over Pi's real `ExtensionAPI.setModel(model)`
 * (Pi adapter contract). Production wiring wraps the real host call with
 * `ResultAsync.fromThrowable` so a throwing/rejecting host call never
 * escapes as an unhandled exception; tests inject a fully-controlled fake.
 */
export interface PiModelApplyPort {
  applyModel(model: PiModelInfo): ResultAsync<void, Error>;
}

/** Adapter seam over Pi's context-level thinking setting. */
export interface PiThinkingApplyPort {
  applyThinkingLevel(level: ThinkingLevelDecl): ResultAsync<void, Error>;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Keep the thinking port as a ResultAsync seam even when an injected port
 * implementation violates that contract by throwing or returning a rejected
 * promise. A thinking failure is deliberately handled after model activation,
 * so it can never downgrade a model that already applied successfully.
 */
function safelyApplyThinkingLevel(
  applier: PiThinkingApplyPort,
  level: ThinkingLevelDecl,
): ResultAsync<void, Error> {
  return ResultAsync.fromThrowable(async () => {
    const applied = await applier.applyThinkingLevel(level);
    if (applied.isErr()) throw applied.error;
  }, toError)();
}

/**
 * The outcome of resolving *and applying* a descriptor's model intent
 * (Pi adapter contract): either the resolved model was successfully applied
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
      readonly thinkingLevel?: ThinkingLevelDecl;
      /**
       * `true` when the requested level applied, `false` when it was
       * unavailable or failed, and omitted when no level was requested.
       */
      readonly thinkingApplied?: boolean;
    }
  | {
      readonly status: "degraded";
      readonly reason: "unresolved" | "apply-failed";
      readonly currentModel: PiModelInfo | undefined;
    };

/**
 * Pi adapter contract: resolves a descriptor's ordered model intent against
 * Pi's authenticated catalog, then applies it through the injected
 * `PiModelApplyPort`. Never fuzzy-matches, never falls back to a
 * different model, and never throws — every model failure path (unresolved
 * intent, or a host that rejects `setModel`) reports `degraded` and
 * preserves whatever model Pi already had active. A requested thinking level
 * is attempted only after model success; its failure remains an applied model
 * outcome with `thinkingApplied: false`.
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
    thinkingApplier?: PiThinkingApplyPort,
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
      .andThen(() => {
        if (resolution.thinkingLevel === undefined) {
          return okAsync<PiModelActivationOutcome, Error>({
            status: "applied",
            model: resolution.model,
            intentEntry: resolution.intentEntry,
            source: resolution.source,
          });
        }
        if (thinkingApplier === undefined) {
          return okAsync<PiModelActivationOutcome, Error>({
            status: "applied",
            model: resolution.model,
            intentEntry: resolution.intentEntry,
            source: resolution.source,
            thinkingLevel: resolution.thinkingLevel,
            thinkingApplied: false,
          });
        }
        return safelyApplyThinkingLevel(
          thinkingApplier,
          resolution.thinkingLevel,
        )
          .map(
            (): PiModelActivationOutcome => ({
              status: "applied",
              model: resolution.model,
              intentEntry: resolution.intentEntry,
              source: resolution.source,
              thinkingLevel: resolution.thinkingLevel,
              thinkingApplied: true,
            }),
          )
          .orElse(() =>
            okAsync<PiModelActivationOutcome, never>({
              status: "applied",
              model: resolution.model,
              intentEntry: resolution.intentEntry,
              source: resolution.source,
              thinkingLevel: resolution.thinkingLevel,
              thinkingApplied: false,
            }),
          );
      })
      .orElse(() =>
        okAsync<PiModelActivationOutcome, never>({
          status: "degraded",
          reason: "apply-failed",
          currentModel,
        }),
      );
  }
}
