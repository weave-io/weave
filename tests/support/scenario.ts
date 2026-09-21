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
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

export type { MaterializationPlan, MaterializedAgent };

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
 * The `.md` files sitting in the user's `prompts/` directory, keyed by the path
 * they wrote in `prompt_file` / `prompt_append_file`. A path the map does not
 * hold reads as a missing file, which is what a typo in a config produces.
 */
export type PromptFiles = Record<string, string>;

/** What the user's config directory holds besides `config.weave`. */
export interface ScenarioOptions {
  promptFiles?: PromptFiles;
}

/**
 * The prompt-file reader an adapter supplies to `materializeAgents`, backed by
 * an in-memory directory instead of a disk, plus the log of what it was asked
 * to read. Scenarios assert on `reads` where re-reading the same file would
 * cost a user real I/O.
 */
export interface PromptLibrary {
  /** Every path the engine asked for, in order, including repeats. */
  reads: string[];
  read(path: string): ResultAsync<string, { message: string }>;
}

/** Backs `prompt_file` and `prompt_append_file` with files held in memory. */
export function promptLibrary(files: PromptFiles = {}): PromptLibrary {
  const reads: string[] = [];
  return {
    reads,
    read(path: string) {
      reads.push(path);
      const content = files[path];
      if (content === undefined) {
        return errAsync({
          message: `ENOENT: no such file or directory, open '${path}'`,
        });
      }
      return okAsync(dedent(content));
    },
  };
}

/**
 * Runs the full public composition pipeline: `.weave` source in, the ordered
 * agent descriptors an adapter would be handed out. This is the outermost seam
 * of the engine — the same call `weave validate` and every adapter make.
 */
export async function whenMaterialized(
  source: string,
  options: ScenarioOptions = {},
): Promise<MaterializationPlan> {
  return (
    await whenMaterializedWith(source, promptLibrary(options.promptFiles))
  ).plan;
}

/**
 * Resolves one parsed config twice, the way a caller does when it materializes
 * again after handing the first set of descriptors to a harness. Both passes
 * share the config object, so anything the first pass leaves behind in it
 * shows up in the second.
 */
export async function whenMaterializedTwice(
  source: string,
  options: ScenarioOptions = {},
): Promise<[MaterializationPlan, MaterializationPlan]> {
  const config = givenConfig(source);
  const resolve = async () =>
    (
      await materializeAgents({
        config,
        promptFileReader: promptLibrary(options.promptFiles),
      })
    )._unsafeUnwrap();
  const first = await resolve();
  return [first, await resolve()];
}

/**
 * As `whenMaterialized`, but hands back the prompt library too, so a scenario
 * can also say what the engine asked the user's disk for.
 */
export async function whenMaterializedWith(
  source: string,
  prompts: PromptLibrary,
): Promise<{ plan: MaterializationPlan; prompts: PromptLibrary }> {
  const result = await materializeAgents({
    config: givenConfig(source),
    promptFileReader: prompts,
  });
  return { plan: result._unsafeUnwrap(), prompts };
}

// ---------------------------------------------------------------------------
// Then — readable assertions over the result
// ---------------------------------------------------------------------------

/** The agent names, in the order an adapter would materialize them. */
export function agentNames(plan: MaterializationPlan): string[] {
  return plan.agents.map((entry) => entry.agentName);
}

/** The kinds of failure the plan reported, in the order Weave collected them. */
export function errorTypes(plan: MaterializationPlan): string[] {
  return plan.errors.map((error) => error.type);
}

/**
 * Why each agent failed to resolve, as `"<agent>: <reason>"` — the two things
 * a user needs to fix it, and the two a CLI message is built from.
 */
export function failures(plan: MaterializationPlan): string[] {
  return plan.errors.flatMap((error) =>
    error.type === "DescriptorCompositionFailure"
      ? [`${error.agentName}: ${error.cause.type}`]
      : [],
  );
}

/**
 * Why Weave refused each prompt it could not render — the distinction a user
 * reads in the message: an unknown path, an unsafe one, an unsupported tag.
 */
export function refusals(plan: MaterializationPlan): string[] {
  return plan.errors.flatMap((error) =>
    error.type === "DescriptorCompositionFailure" &&
    error.cause.type === "PromptTemplateError"
      ? [error.cause.reason.kind]
      : [],
  );
}

/** The prompt one agent's model would be given, composed and rendered. */
export function promptFor(plan: MaterializationPlan, name: string): string {
  return agent(plan, name).descriptor.composedPrompt;
}

/** The agents one agent may delegate to, in the order its prompt lists them. */
export function delegatesTo(plan: MaterializationPlan, name: string): string[] {
  return agent(plan, name).descriptor.delegationTargets.map(
    (target) => target.name,
  );
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
