/**
 * Per-case Tapestry prompt composition for the `tapestry-category-routing`
 * eval suite.
 *
 * A category routes work only because it is declared in `.weave`: the engine
 * materializes it as `shuttle-{category}` and renders it into Tapestry's
 * `delegation.targets`. A case that names its categories only in the task text
 * asks Tapestry to route to an agent its own prompt never lists, which measures
 * something no user sees (#253). So each case declares its categories
 * (`EvalCase.categories`) and this composer builds the config a user with
 * exactly those categories would have:
 *
 *   1. The builtin config, loaded through `loadConfig()` with a file reader
 *      that finds no files — no global or project `.weave` is read, so the
 *      developer's own categories never leak into a case.
 *   2. A case layer — the declared categories, and `disable agents` for the
 *      generated shuttle of each `disabled` one — validated by
 *      `WeaveConfigSchema` and merged with `mergeConfigsResult()`, as a
 *      project `.weave` layer would be.
 *   3. `materializeAgents()`, the engine path adapters use, which generates
 *      the category shuttles and composes Tapestry with them in its list.
 *
 * Nothing here concatenates delegation text into a prompt: what Tapestry sees
 * is what the engine renders from `tapestry.md`.
 */

import {
  type FileReader,
  loadConfig,
  mergeConfigsResult,
} from "@weaveio/weave-config";
import { type WeaveConfig, WeaveConfigSchema } from "@weaveio/weave-core";
import { materializeAgents } from "@weaveio/weave-engine";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import type { EvalCase, EvalCaseCategory, ProvenanceError } from "./types.js";

/** The agent whose prompt this composer produces. */
export const TAPESTRY_AGENT_NAME = "tapestry";

/**
 * A reader that finds no config files, so `loadConfig()` returns the builtin
 * layer alone. The root it is given is never read.
 */
const NO_CONFIG_FILES: FileReader = {
  exists: () => Promise.resolve(false),
  read: (path) =>
    errAsync({
      type: "FileReadError",
      path,
      cause: "no config files are read when composing a case",
    }),
};

/** Placeholder project root; `NO_CONFIG_FILES` never touches it. */
const UNREAD_PROJECT_ROOT = "/weave-eval-case";

/**
 * Composes Tapestry's system prompt for one `tapestry-category-routing` case.
 */
export class TapestryCasePromptComposer {
  /**
   * Compose Tapestry's prompt under a config holding exactly
   * `evalCase.categories` (none when the case declares none).
   */
  compose(evalCase: EvalCase): ResultAsync<string, ProvenanceError> {
    return this.loadBuiltins()
      .andThen((builtins) => this.withCaseCategories(builtins, evalCase))
      .andThen((config) => this.composeTapestry(config));
  }

  private loadBuiltins(): ResultAsync<WeaveConfig, ProvenanceError> {
    return loadConfig(UNREAD_PROJECT_ROOT, NO_CONFIG_FILES).mapErr(
      (errors): ProvenanceError => ({
        type: "ConfigLoadError",
        message: `Failed to load the builtin Weave config: ${errors.map((e) => e.type).join(", ")}`,
      }),
    );
  }

  private withCaseCategories(
    builtins: WeaveConfig,
    evalCase: EvalCase,
  ): ResultAsync<WeaveConfig, ProvenanceError> {
    const declared = evalCase.categories ?? [];
    const layer = WeaveConfigSchema.safeParse({
      categories: Object.fromEntries(
        declared.map((category) => [category.name, toCategoryConfig(category)]),
      ),
      disabled: {
        agents: declared
          .filter((category) => category.disabled)
          .map((category) => `shuttle-${category.name}`),
      },
    });
    if (!layer.success) {
      return errAsync({
        type: "ConfigLoadError",
        message: `Case "${evalCase.id}" declares categories the Weave config schema rejects: ${layer.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      });
    }

    // Merged as a project `.weave` layer is merged onto the builtins.
    const merged = mergeConfigsResult(builtins, layer.data);
    if (merged.isErr()) {
      return errAsync({
        type: "ConfigLoadError",
        message: `Case "${evalCase.id}" categories could not be merged onto the builtin config: ${merged.error.map((e) => e.type).join(", ")}`,
      });
    }
    return ResultAsync.fromSafePromise(Promise.resolve(merged.value));
  }

  private composeTapestry(
    config: WeaveConfig,
  ): ResultAsync<string, ProvenanceError> {
    return materializeAgents({ config }).andThen((plan) => {
      if (plan.errors.length > 0) {
        return err<string, ProvenanceError>({
          type: "PromptCompositionError",
          agentName: TAPESTRY_AGENT_NAME,
          message: `Materialization failed: ${plan.errors.map((e) => e.type).join(", ")}`,
        });
      }
      const tapestry = plan.agents.find(
        (agent) => agent.agentName === TAPESTRY_AGENT_NAME,
      );
      if (tapestry === undefined) {
        return err<string, ProvenanceError>({
          type: "PromptCompositionError",
          agentName: TAPESTRY_AGENT_NAME,
          message: `Agent "${TAPESTRY_AGENT_NAME}" was not materialized.`,
        });
      }
      return ok<string, ProvenanceError>(tapestry.descriptor.composedPrompt);
    });
  }
}

/** The `category {}` block a case category stands for. */
function toCategoryConfig(category: EvalCaseCategory): Record<string, unknown> {
  if (category.triggers === undefined) {
    return { description: category.description };
  }
  return { description: category.description, triggers: category.triggers };
}
