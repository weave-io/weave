/**
 * Shared vocabulary for Weave's black-box scenario tests.
 *
 * Every test under `tests/` describes something a *user* can observe from
 * outside Weave — a `.weave` file they wrote, a `weave ...` command they ran,
 * or the harness configuration they got back. Nothing here reaches into an
 * internal module: the only seams used are the ones a real caller has.
 *
 * See `tests/README.md` for the bucket definitions.
 */

import { expect } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import {
  type MaterializationPlan,
  type MaterializedAgent,
  materializeAgents,
} from "@weaveio/weave-engine";

// ---------------------------------------------------------------------------
// Given — a .weave file the user wrote
// ---------------------------------------------------------------------------

/**
 * Parses `.weave` source the way Weave parses a real config file.
 *
 * A broken scenario fixture fails as "config parses" rather than throwing ten
 * frames deeper, so the failure names the scenario, not the plumbing.
 */
export function givenConfig(source: string): WeaveConfig {
  const result = parseConfig(dedent(source));
  if (result.isErr()) {
    expect(`config failed to parse: ${JSON.stringify(result.error)}`).toBe(
      "config parses",
    );
    throw new Error("unreachable");
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// When — Weave resolves that config into what an adapter receives
// ---------------------------------------------------------------------------

/**
 * Runs the full public composition pipeline: `.weave` source in, the ordered
 * agent descriptors an adapter would be handed out. This is the outermost seam
 * of the engine — the same call `weave validate` and every adapter make.
 */
export async function whenMaterialized(
  source: string,
): Promise<MaterializationPlan> {
  const result = await materializeAgents({ config: givenConfig(source) });
  return result._unsafeUnwrap();
}

// ---------------------------------------------------------------------------
// Then — readable assertions over the result
// ---------------------------------------------------------------------------

/** The agent names, in the order an adapter would materialize them. */
export function agentNames(plan: MaterializationPlan): string[] {
  return plan.agents.map((entry) => entry.agentName);
}

/** Looks up one agent by name, failing readably when the scenario drifted. */
export function agent(
  plan: MaterializationPlan,
  name: string,
): MaterializedAgent {
  const found = plan.agents.find((candidate) => candidate.agentName === name);
  if (!found) {
    expect(agentNames(plan)).toContain(name);
    throw new Error("unreachable");
  }
  return found;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Strips the common leading indentation from a template literal so scenario
 * configs can be written inline at their natural indent and still read as a
 * real `.weave` file.
 */
export function dedent(source: string): string {
  const lines = source.replace(/^\n/, "").trimEnd().split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const shortest = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shortest)).join("\n");
}
