/**
 * Where each entry of an agent's merged `models` list came from
 * (`weave models status`, Spec 39 "Visibility").
 *
 * The loader merges `builtins → recommendations → global → project` and
 * union-merges arrays override-first, so an agent's list is
 * `[project…, global…, recommended…, builtin…]` with duplicates removed. An
 * entry's source is therefore the first of those layers that lists it.
 */

import type { WeaveConfig } from "@weaveio/weave-core";

/** The layer an entry came from, in merge priority order. */
export type ModelSource = "project" | "global" | "recommended" | "builtin";

/** One entry of an agent's merged `models` list. */
export interface AttributedModel {
  readonly model: string;
  readonly source: ModelSource;
}

/** Each layer's own `models` lists. */
export interface ModelLayers {
  readonly builtin: WeaveConfig;
  readonly recommended?: Readonly<Record<string, readonly string[]>>;
  readonly global?: WeaveConfig;
  readonly project?: WeaveConfig;
}

/**
 * The merged list of every agent in `agents`, each entry with its source.
 * Agents the merged config does not hold are left out.
 */
export function attributeModels(
  merged: WeaveConfig,
  layers: ModelLayers,
  agents: readonly string[],
): Record<string, AttributedModel[]> {
  const result: Record<string, AttributedModel[]> = {};
  for (const agent of agents) {
    const models = merged.agents[agent]?.models;
    if (models === undefined) continue;
    const ordered: [ModelSource, readonly string[]][] = [
      ["project", layers.project?.agents[agent]?.models ?? []],
      ["global", layers.global?.agents[agent]?.models ?? []],
      ["recommended", layers.recommended?.[agent] ?? []],
      ["builtin", layers.builtin.agents[agent]?.models ?? []],
    ];
    result[agent] = models.map((model) => ({
      model,
      source:
        ordered.find(([, list]) => list.includes(model))?.[0] ?? "builtin",
    }));
  }
  return result;
}
