import { loadConfig } from "@weaveio/weave-config";
import {
  type MaterializationError,
  materializeAgents,
  resolveAvailableSkillsForAgent,
  type SkillInfo,
} from "@weaveio/weave-engine";
import {
  err,
  type Result as NeverthrowResult,
  ok,
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
      readonly code: "skill_unavailable";
      readonly agentName: string;
      readonly count: number;
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
}

export interface BuildOpenCode2CatalogInput {
  readonly location: string;
  readonly projectConfig: boolean;
  readonly models: readonly ModelInfo[];
  readonly skills: readonly NativeSkillInfo[];
  readonly sourceIo?: CatalogSourceIo;
}

function materializationIssue(
  error: MaterializationError,
): OpenCode2CatalogIssue {
  if (error.type === "DescriptorCompositionFailure") {
    return { code: "materialization_failed", agentName: error.agentName };
  }
  return { code: "materialization_failed" };
}

function candidateRevision(
  sources: readonly CatalogSourceEntry[],
  models: readonly ModelInfo[],
  skills: readonly NativeSkillInfo[],
): NeverthrowResult<string, OpenCode2Error> {
  return Result.fromThrowable(
    () => {
      const identity = JSON.stringify({
        sources,
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
  return loadConfig(input.location, sources.configReader)
    .mapErr(
      (): OpenCode2Error => ({
        code: "config_unavailable",
        message: "Weave configuration could not be loaded",
      }),
    )
    .andThen((config) => {
      if (sources.ioError() !== undefined) {
        return err<OpenCode2CatalogCandidate, OpenCode2Error>({
          code: "config_unavailable",
          message: "a Weave source could not be inspected",
        });
      }
      return materializeAgents({
        config,
        promptFileReader: sources.promptReader,
      }).andThen((plan) => {
        const sourceLimit = sources.limitError();
        if (sourceLimit !== undefined)
          return err<OpenCode2CatalogCandidate, OpenCode2Error>({
            code: "catalog_unavailable",
            message: sourceLimit,
          });
        const fatalPromptRead = plan.errors.some(
          (error) =>
            error.type === "DescriptorCompositionFailure" &&
            error.cause.type === "PromptFileReadError",
        );
        if (fatalPromptRead)
          return err<OpenCode2CatalogCandidate, OpenCode2Error>({
            code: "config_unavailable",
            message: "a configured prompt source could not be read",
          });

        const projections = new Map<string, OpenCode2AgentProjection>();
        const runtime = new Map<string, OpenCode2CatalogAgent>();
        const issues: OpenCode2CatalogIssue[] =
          plan.errors.map(materializationIssue);
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
          if (resolvedModel.isErr()) {
            issues.push({
              code: "model_unavailable",
              agentName: materialized.agentName,
              details: resolvedModel.error,
            });
            continue;
          }
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
            resolvedModel.value.ref,
          );
          const skillIDs = skillResolution.resolved.flatMap((skill) => {
            const native = nativeSkillByName.get(skill.name);
            return native === undefined ? [] : [Skill.ID.make(native.id)];
          });
          projections.set(materialized.agentName, projection);
          runtime.set(materialized.agentName, { projection, skillIDs });
        }

        const manifest = sources.manifest();
        const revision = candidateRevision(
          manifest,
          input.models,
          input.skills,
        );
        if (revision.isErr()) return err(revision.error);
        return ok({
          revision: revision.value,
          agents: projections,
          runtime,
          issues,
          sources: manifest,
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
