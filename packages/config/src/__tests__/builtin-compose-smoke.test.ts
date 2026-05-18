/**
 * Integration smoke test: builtin config → compose pipeline.
 *
 * Loads all 8 builtin agents through the public `@weave/config` API
 * (`loadConfig`) and composes each one through the public `@weave/engine` API
 * (`composeAgentDescriptor`). This test crosses the package boundary to prove
 * the full zero-config pipeline works end-to-end without any harness.
 *
 * Key assertions:
 * - All 8 builtins compose to non-empty prompts.
 * - Loom and Tapestry (delegate allow + non-primary targets with triggers)
 *   produce a `## Delegation` section in their composedPrompt.
 * - Shuttle, Pattern, Thread, Spindle, Weft, Warp (delegate deny) do NOT
 *   produce a `## Delegation` section.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weave/core";
import type { AgentDescriptor } from "@weave/engine";
import { composeAgentDescriptor } from "@weave/engine";
import { loadConfig } from "../loader.js";

// ---------------------------------------------------------------------------
// Fixture: load builtins once for all tests
// ---------------------------------------------------------------------------

let config: WeaveConfig;
const descriptors = new Map<string, AgentDescriptor>();

beforeAll(async () => {
  // loadConfig with no arguments uses process.cwd() as project root and the
  // real filesystem. Since there is no .weave/config.weave in the test
  // environment (or if there is, it only adds deltas), the result will always
  // contain all 8 builtins with absolute prompt_file paths resolved to
  // packages/config/prompts/*.md.
  const result = await loadConfig();
  if (result.isErr()) {
    throw new Error(
      `loadConfig failed: ${JSON.stringify(result.error, null, 2)}`,
    );
  }
  config = result.value;

  // Compose every agent in the loaded config
  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const descriptorResult = await composeAgentDescriptor(
      name,
      agentConfig,
      config,
      config.agents,
    );
    if (descriptorResult.isErr()) {
      throw new Error(
        `composeAgentDescriptor failed for "${name}": ${JSON.stringify(descriptorResult.error, null, 2)}`,
      );
    }
    descriptors.set(name, descriptorResult.value);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDescriptor(name: string): AgentDescriptor {
  const d = descriptors.get(name);
  if (d === undefined) throw new Error(`No descriptor for agent "${name}"`);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("builtin compose smoke", () => {
  const ALL_BUILTINS = [
    "loom",
    "tapestry",
    "shuttle",
    "pattern",
    "thread",
    "spindle",
    "weft",
    "warp",
  ] as const;

  const DELEGATING_AGENTS = ["loom", "tapestry"] as const;

  const NON_DELEGATING_AGENTS = [
    "shuttle",
    "pattern",
    "thread",
    "spindle",
    "weft",
    "warp",
  ] as const;

  it("all 8 builtins are present in the loaded config", () => {
    for (const name of ALL_BUILTINS) {
      expect(config.agents[name]).toBeDefined();
    }
  });

  it("all 8 builtins compose to non-empty prompts", () => {
    for (const name of ALL_BUILTINS) {
      const descriptor = getDescriptor(name);
      expect(descriptor.composedPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("loom composedPrompt contains ## Delegation section", () => {
    const descriptor = getDescriptor("loom");
    expect(descriptor.composedPrompt).toContain("## Delegation");
  });

  it("tapestry composedPrompt contains ## Delegation section", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain("## Delegation");
  });

  it("loom delegation targets include specialist agents with triggers", () => {
    const descriptor = getDescriptor("loom");
    expect(descriptor.delegationTargets.length).toBeGreaterThan(0);
    // All targets should have at least one trigger (specialists have triggers)
    for (const target of descriptor.delegationTargets) {
      expect(target.triggers.length).toBeGreaterThan(0);
    }
  });

  it("tapestry delegation targets include specialist agents with triggers", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.delegationTargets.length).toBeGreaterThan(0);
    for (const target of descriptor.delegationTargets) {
      expect(target.triggers.length).toBeGreaterThan(0);
    }
  });

  for (const name of NON_DELEGATING_AGENTS) {
    it(`${name} composedPrompt does NOT contain ## Delegation section`, () => {
      const descriptor = getDescriptor(name);
      expect(descriptor.composedPrompt).not.toContain("## Delegation");
    });
  }

  it("loom and tapestry are excluded from each other's delegation targets (both are primary mode)", () => {
    const loomDescriptor = getDescriptor("loom");
    const tapestryDescriptor = getDescriptor("tapestry");

    const loomTargetNames = loomDescriptor.delegationTargets.map((t) => t.name);
    const tapestryTargetNames = tapestryDescriptor.delegationTargets.map(
      (t) => t.name,
    );

    // primary-mode agents are excluded from delegation targets
    expect(loomTargetNames).not.toContain("tapestry");
    expect(tapestryTargetNames).not.toContain("loom");
  });

  it("non-delegating agents have empty delegationTargets arrays", () => {
    for (const name of NON_DELEGATING_AGENTS) {
      const descriptor = getDescriptor(name);
      expect(descriptor.delegationTargets).toEqual([]);
    }
  });

  it("all delegating agents' composedPrompts list specialist agent names", () => {
    for (const name of DELEGATING_AGENTS) {
      const descriptor = getDescriptor(name);
      // Each specialist should appear in the delegation section
      for (const specialist of NON_DELEGATING_AGENTS) {
        expect(descriptor.composedPrompt).toContain(specialist);
      }
    }
  });
});
