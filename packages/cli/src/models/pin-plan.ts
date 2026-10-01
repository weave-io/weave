/**
 * Which `models` lines `weave models pin` writes (Spec 39 item 5).
 *
 * For each agent in the applied list, the pinned line is the agent's own
 * global entries followed by the recommended ones, without duplicates.
 *
 * Provider-qualified recommended entries (any entry with a `/`, such as
 * `openrouter/anthropic/claude-opus-5.5`) are left out unless the user asks
 * for them. The global config is read by every harness, and OpenCode V1
 * writes the first qualified entry without checking that the provider is
 * connected (docs/model-resolution.md, "Why there is no github-copilot/
 * prefix"), so a pinned qualified entry can break every V1 run. OpenCode 2
 * checks each entry against its live catalog, so the recommendations layer
 * itself can carry them safely. An agent whose recommended entries are all
 * qualified keeps its existing lines unchanged.
 */

/** True for a provider-qualified model entry (`provider/model`). */
export function isQualifiedModel(model: string): boolean {
  return model.includes("/");
}

/** Qualified recommended entries for one agent. */
export interface QualifiedEntries {
  readonly agent: string;
  readonly models: readonly string[];
}

/** What `pin` writes and what it says about qualified entries. */
export interface PinPlan {
  /** The `models` list to write, per agent. */
  readonly lists: Record<string, string[]>;
  /** How many agents' lists differ from their own global entries. */
  readonly changed: number;
  /**
   * Recommended entries that are provider-qualified and not already the
   * user's own: left out by default, kept with `--include-qualified`.
   */
  readonly qualified: readonly QualifiedEntries[];
  /**
   * Agents left as they are because leaving the qualified entries out left
   * nothing recommended to pin.
   */
  readonly unchanged: readonly string[];
}

/**
 * Plan the pinned lists from the applied recommendations, given each agent's
 * own global `models` entries.
 */
export function planPins(
  recommended: Readonly<Record<string, readonly string[]>>,
  own: Readonly<Record<string, readonly string[]>>,
  includeQualified: boolean,
): PinPlan {
  const lists: Record<string, string[]> = {};
  const qualified: QualifiedEntries[] = [];
  const unchanged: string[] = [];
  let changed = 0;
  for (const [agent, models] of Object.entries(recommended)) {
    const mine = own[agent] ?? [];
    const extra = models.filter(
      (model) => isQualifiedModel(model) && !mine.includes(model),
    );
    if (extra.length > 0) qualified.push({ agent, models: extra });
    const kept = includeQualified
      ? models
      : models.filter((model) => !isQualifiedModel(model));
    if (kept.length === 0 && extra.length > 0) {
      unchanged.push(agent);
      continue;
    }
    const list = [...new Set([...mine, ...kept])];
    lists[agent] = list;
    if (!sameList(list, mine)) changed++;
  }
  return { lists, changed, qualified, unchanged };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((model, i) => model === b[i]);
}
