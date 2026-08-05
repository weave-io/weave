/**
 * End-to-end coverage for category shuttle descriptions.
 *
 * Proves that a category `description` reaches the generated shuttle's agent
 * config and descriptor, and that Loom's and Tapestry's real builtin prompts
 * render those category descriptions in their delegation sections instead of
 * the base Shuttle description.
 *
 * Pipeline exercised: builtin DSL → merged user categories → `materializeAgents`
 * → composed prompts. No harness, no filesystem discovery.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import type { MaterializedAgent } from "@weaveio/weave-engine";
import {
  generateCategoryShuttles,
  materializeAgents,
} from "@weaveio/weave-engine";
import {
  getBuiltinConfig,
  mergeConfigsResult,
  resolvePromptPaths,
} from "../index.js";

const BASE_SHUTTLE_DESCRIPTION_MARKER = "General implementation worker";

const MINI_DESCRIPTION = "Small, surgical single-file edits";
const TESTS_DESCRIPTION = "Test authoring, coverage, and flake triage";
const DOCS_DESCRIPTION =
  "Documentation prose and literal {{agent.name}} reference tables";

const USER_SOURCE = `
category mini {
  description "${MINI_DESCRIPTION}"
  patterns ["src/**/*.ts"]
}

category tests {
  description "${TESTS_DESCRIPTION}"
  patterns ["**/*.test.ts"]
}

category docs {
  description "${DOCS_DESCRIPTION}"
  patterns ["docs/**"]
}
`;

let config: WeaveConfig;
let agents: Map<string, MaterializedAgent>;
let baseShuttleDescription: string | undefined;

beforeAll(async () => {
  const builtinResult = getBuiltinConfig();
  if (builtinResult.isErr()) {
    throw new Error(
      `getBuiltinConfig failed: ${JSON.stringify(builtinResult.error, null, 2)}`,
    );
  }

  const builtinRootDir = resolve(import.meta.dir, "../..");
  const builtin = resolvePromptPaths(builtinResult.value, {
    kind: "builtin",
    rootDir: builtinRootDir,
  });

  const userResult = parseConfig(USER_SOURCE);
  if (userResult.isErr()) {
    throw new Error(
      `parseConfig failed: ${JSON.stringify(userResult.error, null, 2)}`,
    );
  }

  const mergeResult = mergeConfigsResult(builtin, userResult.value);
  if (mergeResult.isErr()) {
    throw new Error(
      `mergeConfigsResult failed: ${JSON.stringify(mergeResult.error, null, 2)}`,
    );
  }
  config = mergeResult.value;
  baseShuttleDescription = config.agents.shuttle?.description;

  const planResult = await materializeAgents({ config });
  if (planResult.isErr()) {
    throw new Error(
      `materializeAgents failed: ${JSON.stringify(planResult.error, null, 2)}`,
    );
  }

  expect(planResult.value.errors).toEqual([]);
  agents = new Map(planResult.value.agents.map((a) => [a.agentName, a]));
});

function agent(name: string): MaterializedAgent {
  const found = agents.get(name);
  if (found === undefined) throw new Error(`No materialized agent "${name}"`);
  return found;
}

describe("category shuttle descriptions end-to-end", () => {
  it("the base shuttle keeps its own description", () => {
    expect(agent("shuttle").descriptor.description).toBe(
      baseShuttleDescription,
    );
    expect(baseShuttleDescription).toContain(BASE_SHUTTLE_DESCRIPTION_MARKER);
  });

  it("generated category shuttle descriptors use the category description", () => {
    expect(agent("shuttle-mini").descriptor.description).toBe(MINI_DESCRIPTION);
    expect(agent("shuttle-tests").descriptor.description).toBe(
      TESTS_DESCRIPTION,
    );
  });

  it("a category without a description is rejected before it can reach the engine", () => {
    const undescribed = parseConfig(`category plain {
  patterns ["docs/**"]
}`);
    const errors = undescribed.match(
      () => [],
      (validationErrors) => validationErrors,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ValidationError",
          path: "categories.plain.description",
          message: "category description must be a non-empty string",
        }),
      ]),
    );
  });

  it("no generated category shuttle ever carries the base shuttle description", () => {
    for (const name of ["shuttle-mini", "shuttle-tests", "shuttle-docs"]) {
      expect(agent(name).descriptor.description).not.toBe(
        baseShuttleDescription,
      );
    }
    expect(agent("shuttle-docs").descriptor.description).toBe(DOCS_DESCRIPTION);
  });

  it.each([
    "loom",
    "tapestry",
  ])("%s delegation targets carry the category descriptions", (delegator) => {
    const targets = agent(delegator).descriptor.delegationTargets;

    const mini = targets.find((t) => t.name === "shuttle-mini");
    const tests = targets.find((t) => t.name === "shuttle-tests");

    expect(mini?.description).toBe(MINI_DESCRIPTION);
    expect(tests?.description).toBe(TESTS_DESCRIPTION);
  });

  it.each([
    "loom",
    "tapestry",
  ])("%s composed prompt renders category descriptions for its shuttle targets", (delegator) => {
    const prompt = agent(delegator).descriptor.composedPrompt;

    expect(prompt).toContain(`**shuttle-mini** — ${MINI_DESCRIPTION}`);
    expect(prompt).toContain(`**shuttle-tests** — ${TESTS_DESCRIPTION}`);
    expect(prompt).toContain(`**shuttle-docs** — ${DOCS_DESCRIPTION}`);
    // The bug: category shuttles previously rendered the base description.
    expect(prompt).not.toContain(
      `**shuttle-mini** — ${baseShuttleDescription}`,
    );
    expect(prompt).not.toContain(
      `**shuttle-tests** — ${baseShuttleDescription}`,
    );
  });

  it.each([
    "loom",
    "tapestry",
  ])("%s treats Mustache-shaped category descriptions as opaque text", (delegator) => {
    const descriptor = agent(delegator).descriptor;
    const docs = descriptor.delegationTargets.find(
      (target) => target.name === "shuttle-docs",
    );

    expect(docs?.description).toBe(DOCS_DESCRIPTION);
    expect(descriptor.composedPrompt).toContain(DOCS_DESCRIPTION);
  });
});

// ---------------------------------------------------------------------------
// Triggers are the other half of the routing metadata. Loom's real prompt
// renders one bullet per `routing_hint` beneath each delegation target, so an
// inherited trigger would advertise generic-Shuttle guidance under every
// category shuttle. Generated category shuttles must therefore own no triggers.
// ---------------------------------------------------------------------------

describe("category shuttle triggers end-to-end", () => {
  /** Routing-hint bullets rendered directly beneath a delegation target. */
  function renderedHints(delegator: string, target: string): string[] {
    const lines = agent(delegator).descriptor.composedPrompt.split("\n");
    const start = lines.findIndex((line) =>
      line.startsWith(`- **${target}** —`),
    );
    expect(start).toBeGreaterThanOrEqual(0);

    const hints: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.startsWith("  - ")) break;
      hints.push(line.slice("  - ".length));
    }
    return hints;
  }

  it("generated category shuttle configs have no triggers", () => {
    const generated = generateCategoryShuttles(config)._unsafeUnwrap();

    for (const name of ["shuttle-mini", "shuttle-tests", "shuttle-docs"]) {
      expect(generated[name]?.config.triggers).toEqual([]);
    }
    // The base shuttle it inherits from does declare triggers.
    expect((config.agents.shuttle?.triggers ?? []).length).toBeGreaterThan(0);
  });

  it("loom delegation targets expose no triggers for category shuttles", () => {
    const targets = agent("loom").descriptor.delegationTargets;

    for (const name of ["shuttle-mini", "shuttle-tests", "shuttle-docs"]) {
      const target = targets.find((t) => t.name === name);
      expect(target).toBeDefined();
      expect(target?.triggers).toEqual([]);
    }
  });

  it("loom keeps the generic shuttle's own triggers", () => {
    const generic = agent("loom").descriptor.delegationTargets.find(
      (t) => t.name === "shuttle",
    );

    expect(generic?.triggers.length).toBeGreaterThan(0);
    for (const trigger of generic?.triggers ?? []) {
      expect(trigger.routing_hint?.trim()).toBeTruthy();
    }
  });

  it("loom's prompt renders no routing hints beneath category shuttle entries", () => {
    for (const name of ["shuttle-mini", "shuttle-tests", "shuttle-docs"]) {
      expect(renderedHints("loom", name)).toEqual([]);
    }
  });

  it("loom's prompt renders the generic shuttle's routing hints exactly once each", () => {
    const generic = agent("loom").descriptor.delegationTargets.find(
      (t) => t.name === "shuttle",
    );
    const expected = (generic?.triggers ?? []).map((t) => t.routing_hint ?? "");

    expect(renderedHints("loom", "shuttle")).toEqual(expected);

    const prompt = agent("loom").descriptor.composedPrompt;
    for (const hint of expected) {
      expect(prompt.split(hint).length - 1).toBe(1);
    }
  });
});
