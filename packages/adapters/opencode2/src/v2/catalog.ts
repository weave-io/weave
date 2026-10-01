import {
  type ConfigLoadDiagnostic,
  DEFAULT_MODEL_UPDATES_CHANNEL,
  loadConfigDetailed,
  resolveModelUpdates,
} from "@weaveio/weave-config";
import type { ModelUpdatesSettings } from "@weaveio/weave-core";
import {
  type HarnessMaterializationReport,
  type MaterializationError,
  type MaterializationPlan,
  materializeAgents,
  resolveAvailableSkillsForAgent,
  type SkillInfo,
} from "@weaveio/weave-engine";
import {
  err,
  type Result as NeverthrowResult,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import {
  type V2CatalogModelInfo as ModelInfo,
  type V2NativeSkillInfo as NativeSkillInfo,
  V2Skill as Skill,
} from "../sdk-types.js";
import {
  CatalogSourceCache,
  type CatalogSourceEntry,
  type CatalogSourceIo,
} from "./config-source.js";
import type { OpenCode2Error } from "./errors.js";
import {
  type OpenCode2ModelResolutionError,
  resolveOpenCode2Model,
} from "./model-resolution.js";
import type { OpenCode2ModelUpdates } from "./model-updates.js";
import {
  type OpenCode2AgentProjection,
  translateOpenCode2Agent,
} from "./translate-agent.js";

export type OpenCode2CatalogIssue =
  | { readonly code: "materialization_failed"; readonly agentName?: string }
  | {
      readonly code: "model_unavailable";
      readonly agentName: string;
      readonly details: readonly OpenCode2ModelResolutionError[];
    }
  | {
      readonly code: "variant_unavailable";
      readonly agentName: string;
      readonly variant: string;
    }
  | {
      readonly code: "skill_unavailable";
      readonly agentName: string;
      readonly count: number;
    }
  /**
   * The user opted in to model recommendations (Spec 39) and an applied
   * list is there, but it could not be read or used (invalid, unsigned,
   * expired, …), so every builtin agent runs on its builtin list. A channel
   * with nothing applied yet is not an issue.
   */
  | {
      readonly code: "model_updates_unavailable";
      readonly agentName?: undefined;
    };

export interface OpenCode2CatalogAgent {
  readonly projection: OpenCode2AgentProjection;
  readonly skillIDs: readonly Skill.ID[];
}

export interface OpenCode2CatalogCandidate {
  readonly revision: string;
  readonly agents: ReadonlyMap<string, OpenCode2AgentProjection>;
  readonly runtime: ReadonlyMap<string, OpenCode2CatalogAgent>;
  readonly issues: readonly OpenCode2CatalogIssue[];
  readonly sources: readonly CatalogSourceEntry[];
  /** The `heldAgents` this candidate was built against, sorted. */
  readonly heldAgents: readonly string[];
  /**
   * The model recommendations layer as this candidate loaded it (Spec 39):
   * the merged settings the background refresh uses, and what `status`
   * reports.
   */
  readonly modelUpdates: OpenCode2ModelUpdates;
}

export interface BuildOpenCode2CatalogInput {
  readonly location: string;
  readonly projectConfig: boolean;
  readonly models: readonly ModelInfo[];
  readonly skills: readonly NativeSkillInfo[];
  /**
   * Agent ids the host already holds that Weave did not put there — built-in
   * agents and other plugins'. Weave's agent of the same name is never
   * inserted (`registerOpenCode2Agents` skips it), so no Weave router is
   * offered it (ADR 0013).
   */
  readonly heldAgents?: readonly string[];
  readonly sourceIo?: CatalogSourceIo;
  /**
   * Ed25519 public keys that may sign model recommendations. Defaults to the
   * production keys; tests and local proofs pass a throwaway key.
   */
  readonly modelRecommendationKeys?: readonly string[];
}

function materializationIssue(
  error: MaterializationError,
): OpenCode2CatalogIssue {
  if (error.type === "DescriptorCompositionFailure") {
    return { code: "materialization_failed", agentName: error.agentName };
  }
  return { code: "materialization_failed" };
}

/**
 * The report the engine is given about what the host will hold: every plan
 * agent except those whose name the host already holds. `undefined` when
 * nothing collides, so the first plan's delegation lists already stand.
 */
function hostReport(
  plan: MaterializationPlan,
  heldAgents: ReadonlySet<string>,
): HarnessMaterializationReport | undefined {
  const names = plan.agents.map(({ agentName }) => agentName);
  const taken = names.filter((name) => heldAgents.has(name));
  if (taken.length === 0) return undefined;
  return {
    materialized: names.filter((name) => !heldAgents.has(name)),
    failed: taken.map((agentName) => ({
      agentName,
      reason: "name_taken" as const,
      message: "the OpenCode host already holds an agent with this id",
    })),
  };
}

/**
 * The recommendations layer as the loader saw it. `unavailable` covers both a
 * skipped `applied.json` and one whose existence could not be checked.
 */
function modelUpdatesOf(
  settings: ModelUpdatesSettings | undefined,
  recommendations: ConfigLoadDiagnostic | undefined,
  unavailable: boolean,
): OpenCode2ModelUpdates {
  const channel = settings?.channel ?? DEFAULT_MODEL_UPDATES_CHANNEL;
  const base = {
    ...(settings === undefined ? {} : { settings }),
    mode: settings?.mode ?? "off",
    channel,
    agents: [],
  } as const;
  if (resolveModelUpdates(settings) === undefined)
    return { ...base, state: "off" };
  if (unavailable) return { ...base, state: "unavailable" };
  if (recommendations?.type !== "ModelRecommendationsApplied")
    return { ...base, state: "pending" };
  return {
    ...base,
    state: "applied",
    issued: recommendations.issued,
    agents: recommendations.agents,
  };
}

function candidateRevision(
  sources: readonly CatalogSourceEntry[],
  models: readonly ModelInfo[],
  skills: readonly NativeSkillInfo[],
  heldAgents: readonly string[],
): NeverthrowResult<string, OpenCode2Error> {
  return Result.fromThrowable(
    () => {
      const identity = JSON.stringify({
        sources,
        heldAgents,
        models: models.map((model) => [
          model.providerID,
          model.id,
          model.variants.map((variant) => variant.id),
        ]),
        skills: skills.map((skill) => [skill.id, skill.name]),
      });
      return new Bun.CryptoHasher("sha256").update(identity).digest("hex");
    },
    (): OpenCode2Error => ({
      code: "catalog_unavailable",
      message: "catalog identity could not be computed",
    }),
  )();
}

function buildCandidate(
  input: BuildOpenCode2CatalogInput,
  sources: CatalogSourceCache,
): ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error> {
  // The harness ID selects OpenCode 2's section of any applied model
  // recommendations. `applied.json` is read through `configReader`, so the
  // source manifest records it and a promotion triggers a rebuild.
  return loadConfigDetailed(input.location, sources.configReader, {
    harness: "opencode2",
    ...(input.modelRecommendationKeys === undefined
      ? {}
      : { publicKeys: input.modelRecommendationKeys }),
  })
    .mapErr((errors): OpenCode2Error => {
      // A file that parsed but failed the DSL or its validation is a user
      // error `weave validate` can explain. An unreadable file is not, and a
      // builtin that fails to parse is a Weave bug, not the user's config.
      if (errors.some((error) => error.type === "BuiltinParseError"))
        return {
          code: "catalog_unavailable",
          message: "Weave's builtin configuration could not be loaded",
        };
      if (
        errors.some(
          (error) => error.type === "ParseError" || error.type === "MergeError",
        )
      )
        return {
          code: "config_invalid",
          message: "Weave configuration is invalid",
        };
      return {
        code: "config_unavailable",
        message: "Weave configuration could not be loaded",
      };
    })
    .andThen(({ config, diagnostics }) => {
      // The recommendations file is optional: the loader already left the
      // layer out and said why, so failing to inspect it must not cost the
      // user the catalog. Any other source that cannot be inspected still does.
      const recommendations = diagnostics.find(
        (diagnostic) =>
          diagnostic.type === "ModelRecommendationsSkipped" ||
          diagnostic.type === "ModelRecommendationsPending" ||
          diagnostic.type === "ModelRecommendationsApplied",
      );
      const ioError = sources.ioError();
      const recommendationsUninspectable =
        ioError !== undefined && ioError.path === recommendations?.path;
      // Nothing applied yet (`Pending`) is the normal state before the first
      // promotion, not an issue. A file that is there but unusable is, and so
      // is one whose existence could not be checked: the source reader reports
      // that to the loader as missing.
      const recommendationsUnavailable =
        recommendations?.type === "ModelRecommendationsSkipped" ||
        recommendationsUninspectable;
      const modelUpdates = modelUpdatesOf(
        config.settings.model_updates,
        recommendations,
        recommendationsUnavailable,
      );
      if (ioError !== undefined && !recommendationsUninspectable) {
        return err<OpenCode2CatalogCandidate, OpenCode2Error>({
          code: "config_unavailable",
          message: "a Weave source could not be inspected",
        });
      }
      const heldAgents = new Set(input.heldAgents ?? []);
      return materializeAgents({
        config,
        promptFileReader: sources.promptReader,
      })
        .andThen((first) => {
          // Compose again only when the host already holds one of Weave's
          // names; the prompt reader is cached, so this reads nothing twice.
          const harness = hostReport(first, heldAgents);
          if (harness === undefined) return okAsync(first);
          return materializeAgents({
            config,
            promptFileReader: sources.promptReader,
            harness,
          });
        })
        .andThen((plan) => {
          const sourceLimit = sources.limitError();
          if (sourceLimit !== undefined)
            return err<OpenCode2CatalogCandidate, OpenCode2Error>({
              code: "catalog_unavailable",
              message: sourceLimit,
            });
          // An agent whose prompt could not be composed — including a
          // `prompt_file` that cannot be read — is left out and reported as
          // `materialization_failed`. The rest of the config still loads, so
          // one missing file does not cost the user every agent.
          const projections = new Map<string, OpenCode2AgentProjection>();
          const runtime = new Map<string, OpenCode2CatalogAgent>();
          const issues: OpenCode2CatalogIssue[] =
            plan.errors.map(materializationIssue);
          // An unusable recommendations file is not a config error: the
          // catalog loads on the builtin lists and `status` says so.
          if (recommendationsUnavailable)
            issues.push({ code: "model_updates_unavailable" });
          const availableSkills: SkillInfo[] = input.skills.map((skill) => ({
            name: skill.name,
            metadata: skill,
          }));
          const nativeSkillByName = new Map<string, NativeSkillInfo>(
            input.skills.map((skill) => [skill.name, skill]),
          );

          for (const materialized of plan.agents) {
            const resolvedModel = resolveOpenCode2Model(
              materialized.descriptor.models,
              materialized.descriptor.variant,
              input.models,
            );
            // An unresolvable declared model costs the agent its model, not its
            // existence: the agent is registered without a model ref, which is
            // the same `inherit` shape an agent that declares no model produces,
            // so OpenCode applies its own native model selection. Dropping the
            // agent instead removed every builtin on a host whose catalog does
            // not carry the builtins' declared model, taking `/weave:start`
            // with it and leaving an install that looked inert.
            //
            // The issue is still recorded, so `status` names each agent whose
            // declared model did not resolve. A fallback is not a silent
            // success: the agent runs on a model the user did not name.
            if (resolvedModel.isErr()) {
              issues.push({
                code: "model_unavailable",
                agentName: materialized.agentName,
                details: resolvedModel.error,
              });
            }
            // The agent's own variant is dropped, not the model, when the
            // selected model does not offer it; `status` still names it.
            if (
              resolvedModel.isOk() &&
              resolvedModel.value.droppedVariant !== undefined
            ) {
              issues.push({
                code: "variant_unavailable",
                agentName: materialized.agentName,
                variant: resolvedModel.value.droppedVariant,
              });
            }
            const modelRef = resolvedModel.isOk()
              ? resolvedModel.value.ref
              : undefined;
            const skillResolution = resolveAvailableSkillsForAgent({
              agentName: materialized.agentName,
              agentSkills: materialized.descriptor.skills,
              availableSkills,
              disabledSkills: config.disabled.skills,
            }).match(
              (value) => value,
              (impossible) => impossible,
            );
            if (skillResolution.warnings.length > 0) {
              issues.push({
                code: "skill_unavailable",
                agentName: materialized.agentName,
                count: skillResolution.warnings.length,
              });
            }
            const projection = translateOpenCode2Agent(
              materialized.descriptor,
              modelRef,
            );
            const skillIDs = skillResolution.resolved.flatMap((skill) => {
              const native = nativeSkillByName.get(skill.name);
              return native === undefined ? [] : [Skill.ID.make(native.id)];
            });
            projections.set(materialized.agentName, projection);
            runtime.set(materialized.agentName, { projection, skillIDs });
          }

          const manifest = sources.manifest();
          const sortedHeld = [...heldAgents].sort();
          const revision = candidateRevision(
            manifest,
            input.models,
            input.skills,
            sortedHeld,
          );
          if (revision.isErr()) return err(revision.error);
          return ok({
            revision: revision.value,
            agents: projections,
            runtime,
            issues,
            sources: manifest,
            heldAgents: sortedHeld,
            modelUpdates,
          });
        });
    });
}

/** Build one location candidate. No state is published until this Result succeeds. */
export function buildOpenCode2Catalog(
  input: BuildOpenCode2CatalogInput,
): ResultAsync<OpenCode2CatalogCandidate, OpenCode2Error> {
  const sources = new CatalogSourceCache(
    input.location,
    input.projectConfig,
    input.sourceIo,
  );
  return buildCandidate(input, sources);
}
