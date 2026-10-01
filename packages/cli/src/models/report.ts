/**
 * Shared wording for model recommendations in `weave models` and
 * `weave validate` (Spec 39 "Visibility").
 */

import {
  type ConfigLoadDiagnostic,
  describeModelRecommendationsSkipReason,
  resolveModelUpdates,
} from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import type { AgentModels } from "./recommendations-session.js";

/** How to opt in, for messages shown while model updates are off. */
export const OPT_IN_HINT =
  "settings { model_updates { mode notify } } in ~/.weave/config.weave";

/** The recommendations diagnostic, if the loader produced one. */
export function recommendationsDiagnostic(
  diagnostics: readonly ConfigLoadDiagnostic[],
): ConfigLoadDiagnostic | undefined {
  return diagnostics.find(
    (diagnostic) =>
      diagnostic.type === "ModelRecommendationsApplied" ||
      diagnostic.type === "ModelRecommendationsPending" ||
      diagnostic.type === "ModelRecommendationsSkipped",
  );
}

/** What to run to get a first list, by mode. */
export function firstListHint(mode: "notify" | "auto"): string {
  if (mode === "notify")
    return "run weave models update, then weave models apply";
  return "run weave models update";
}

/**
 * The lines `weave validate` adds to its summary. Empty when the config has
 * no `model_updates` block, so output for users who have not opted in is
 * unchanged.
 */
export function validateSummaryLines(
  config: WeaveConfig,
  diagnostics: readonly ConfigLoadDiagnostic[],
): string[] {
  const block = config.settings.model_updates;
  if (block === undefined) return [];
  const settings = resolveModelUpdates(block);
  if (settings === undefined) return ["model_updates: off"];
  const lines = [
    `model_updates: ${settings.mode} (channel ${settings.channel})`,
  ];
  const diagnostic = recommendationsDiagnostic(diagnostics);
  if (diagnostic === undefined) return lines;
  switch (diagnostic.type) {
    case "ModelRecommendationsApplied":
      lines.push(
        `model_recommendations: applied, issued ${diagnostic.issued}, expires ${diagnostic.expires} (${diagnostic.harness}, section ${diagnostic.section})`,
      );
      if (diagnostic.skippedAgents.length > 0)
        lines.push(
          `model_recommendations: skipped agents this version does not define: ${diagnostic.skippedAgents.join(", ")}`,
        );
      return lines;
    case "ModelRecommendationsPending":
      lines.push(
        `model_recommendations: pending, nothing applied yet (${firstListHint(settings.mode)})`,
      );
      return lines;
    case "ModelRecommendationsSkipped":
      lines.push(
        `model_recommendations: skipped, ${describeModelRecommendationsSkipReason(diagnostic.reason)}; agents use their builtin models`,
      );
      return lines;
  }
}

/** One agent whose merged `models` list differs between two states. */
export interface ListChange {
  readonly agent: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

/**
 * Agents whose merged `models` list differs, in name order. Compares the
 * effective lists (see `RecommendationsSession.effectiveModels`), not the
 * recommended ones, so a list that repeats what agents already run is no
 * change.
 */
export function listChanges(
  before: AgentModels,
  after: AgentModels,
): ListChange[] {
  const agents = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: ListChange[] = [];
  for (const agent of [...agents].sort()) {
    const was = before[agent];
    const now = after[agent];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    changes.push({
      agent,
      ...(was === undefined ? {} : { before: was }),
      ...(now === undefined ? {} : { after: now }),
    });
  }
  return changes;
}

/**
 * Render list changes as `was` / `now` lines per agent. `pending` is true for
 * a list that is waiting, not applied, so nothing has changed yet.
 */
export function renderListChanges(
  changes: readonly ListChange[],
  pending = false,
): string[] {
  if (changes.length === 0)
    return [
      pending
        ? "  No agent's models would change."
        : "  No agent's models changed.",
    ];
  const show = (list: readonly string[] | undefined) =>
    list === undefined ? "(no models)" : list.join(", ");
  return changes.flatMap((change) => [
    `  ${change.agent}`,
    `    was  ${show(change.before)}`,
    `    now  ${show(change.after)}`,
  ]);
}
