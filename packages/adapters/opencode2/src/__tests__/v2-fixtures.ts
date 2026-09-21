/**
 * Fixtures for the V2 unit tests that remain after the scenario migration.
 *
 * The model, skill and descriptor builders that used to live here went with
 * the tests that used them: every promise they made about translation, agent
 * registration and model resolution is now asserted end to end in
 * `tests/adapters/opencode2.scenario.test.ts`. What is left is the minimum a
 * catalog candidate needs, for the refresh-controller tests that drive the
 * controller with a hand-built candidate.
 */

import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import type { OpenCode2AgentProjection } from "../v2/translate-agent.js";

export function projection(id = "helper"): OpenCode2AgentProjection {
  return {
    id,
    system: "role prompt",
    mode: "subagent",
    permissions: [],
    skillNames: [],
  };
}

export function catalog(
  projections: ReadonlyMap<string, OpenCode2AgentProjection> = new Map([
    ["helper", projection()],
  ]),
): OpenCode2CatalogCandidate {
  return {
    revision: "a".repeat(64),
    agents: projections,
    runtime: new Map(
      [...projections].map(([name, value]) => [
        name,
        { projection: value, skillIDs: [] },
      ]),
    ),
    issues: [],
    sources: [],
  };
}
