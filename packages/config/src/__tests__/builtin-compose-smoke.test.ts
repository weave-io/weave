/**
 * Integration smoke test: builtin config → compose pipeline.
 *
 * Composes all 8 builtin agents through the public `@weave/config` API
 * (`getBuiltinConfig` + `resolvePromptPaths`) and the public `@weave/engine`
 * API (`composeAgentDescriptor`). This test crosses the package boundary to
 * prove the full zero-config pipeline works end-to-end without any harness.
 *
 * Isolation: this test deliberately does NOT call `loadConfig()` so that no
 * project `.weave/config.weave` overrides are applied. It composes exactly the
 * shipped builtin agents — nothing more.
 *
 * Key assertions:
 * - All 8 builtins compose to non-empty prompts.
 * - Loom (prose-first template) lists specialist agents under `# Specialist Agents`
 *   without an embedded Mermaid diagram.
 * - Tapestry (delegate allow) produces a `## Delegation` section with a Mermaid
 *   workflow-sequence diagram.
 * - Delegating agents list all specialist agent names in their composed prompt.
 * - Shuttle, Pattern, Thread, Spindle, Weft, Warp (delegate deny) do NOT
 *   produce a `## Delegation` section.
 * - No unresolved unescaped Mustache tags remain in any composed prompt.
 * - No raw config objects, model lists, prompt file paths, harness tool names,
 *   secrets, or environment data appear in any composed prompt.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { WeaveConfig } from "@weave/core";
import type { AgentDescriptor } from "@weave/engine";
import { composeAgentDescriptor } from "@weave/engine";
import { getBuiltinConfig, resolvePromptPaths } from "../index.js";

// ---------------------------------------------------------------------------
// Fixture: compose builtins once for all tests (no project config loaded)
// ---------------------------------------------------------------------------

let config: WeaveConfig;
const descriptors = new Map<string, AgentDescriptor>();

beforeAll(async () => {
  // Step 1: Parse the builtin DSL source — no filesystem discovery, no project
  // overrides. An err here indicates a bug in builtins.ts.
  const builtinResult = getBuiltinConfig();
  if (builtinResult.isErr()) {
    throw new Error(
      `getBuiltinConfig failed: ${JSON.stringify(builtinResult.error, null, 2)}`,
    );
  }

  // Step 2: Resolve prompt_file paths to absolute paths using the builtin
  // root directory (packages/config/), matching what loadConfig() does
  // internally for the builtin layer.
  const builtinRootDir = resolve(import.meta.dir, "../..");
  config = resolvePromptPaths(builtinResult.value, {
    kind: "builtin",
    rootDir: builtinRootDir,
  });

  // Step 3: Compose every builtin agent
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

// Static list used only for dynamic `it()` name generation at describe-time
// (before beforeAll runs). Must stay in sync with the builtin agent set.
const NON_DELEGATING_AGENTS_STATIC = [
  "shuttle",
  "pattern",
  "thread",
  "spindle",
  "weft",
  "warp",
] as const;

describe("builtin compose smoke", () => {
  // Derived from the loaded config at test-run time — avoids hardcoded drift.
  let ALL_BUILTINS: string[];
  let DELEGATING_AGENTS: string[];
  let NON_DELEGATING_AGENTS: string[];

  beforeAll(() => {
    ALL_BUILTINS = Object.keys(config.agents);
    DELEGATING_AGENTS = ALL_BUILTINS.filter(
      (name) => config.agents[name]?.tool_policy?.delegate === "allow",
    );
    NON_DELEGATING_AGENTS = ALL_BUILTINS.filter(
      (name) => !DELEGATING_AGENTS.includes(name),
    );
  });

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

  // ---------------------------------------------------------------------------
  // Delegating agents: ## Delegation, Mermaid, specialist names
  // ---------------------------------------------------------------------------

  it("loom composedPrompt contains # Specialist Agents section", () => {
    const descriptor = getDescriptor("loom");
    expect(descriptor.composedPrompt).toContain("# Specialist Agents");
  });

  it("tapestry composedPrompt contains ## Delegation section", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain("## Delegation");
  });

  it("loom composedPrompt does NOT contain a Mermaid code block (prose-first template)", () => {
    const descriptor = getDescriptor("loom");
    expect(descriptor.composedPrompt).not.toContain("```mermaid");
  });

  it("tapestry composedPrompt contains a Mermaid code block", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain("```mermaid");
  });

  it("loom composedPrompt does NOT contain flowchart TD (prose-first template)", () => {
    const descriptor = getDescriptor("loom");
    expect(descriptor.composedPrompt).not.toContain("flowchart TD");
  });

  it("tapestry composedPrompt contains flowchart TD", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain("flowchart TD");
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

  it("all delegating agents' composedPrompts list specialist agent names", () => {
    for (const name of DELEGATING_AGENTS) {
      const descriptor = getDescriptor(name);
      // Each specialist should appear in the delegation section
      for (const specialist of NON_DELEGATING_AGENTS) {
        expect(descriptor.composedPrompt).toContain(specialist);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Non-delegating agents: no ## Delegation section
  // ---------------------------------------------------------------------------

  for (const name of NON_DELEGATING_AGENTS_STATIC) {
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

  // ---------------------------------------------------------------------------
  // Workflow-sequence Mermaid diagrams
  // ---------------------------------------------------------------------------

  it("loom composedPrompt does NOT contain subgraph blocks (prose-first template, no embedded diagram)", () => {
    const descriptor = getDescriptor("loom");
    expect(descriptor.composedPrompt).not.toContain("subgraph");
  });

  it("tapestry composedPrompt contains subgraph blocks (workflow-sequence diagram)", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain("subgraph");
  });

  it("tapestry diagram contains tapestry-execution subgraph", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain("subgraph tapestry-execution");
  });

  it("gate agents (weft, warp) appear with hexagon {{}} syntax in tapestry diagram", () => {
    const descriptor = getDescriptor("tapestry");
    expect(descriptor.composedPrompt).toContain('{{"weft"}}');
    expect(descriptor.composedPrompt).toContain('{{"warp"}}');
  });

  // ---------------------------------------------------------------------------
  // No unresolved Mustache tags in any composed prompt
  // ---------------------------------------------------------------------------

  it("no unresolved unescaped triple-brace Mustache tags remain in any composed prompt", () => {
    for (const name of ALL_BUILTINS) {
      const descriptor = getDescriptor(name);
      expect(descriptor.composedPrompt).not.toMatch(/\{\{\{[^}]+\}\}\}/);
    }
  });

  it("no unresolved unescaped double-brace Mustache tags remain in any composed prompt", () => {
    // Use the same precise regex as the renderer: only match Mustache-style
    // identifiers (letters, digits, dots, underscores, hyphens with optional
    // section prefix). This avoids false positives from Mermaid hexagon syntax
    // like {{"weft"}} which contains quotes and is not a Mustache tag.
    const mustacheTagPattern = /\{\{[#^/!>&]?[\w.-][\w.-]*\}\}/;
    for (const name of ALL_BUILTINS) {
      const descriptor = getDescriptor(name);
      expect(descriptor.composedPrompt).not.toMatch(mustacheTagPattern);
    }
  });

  // ---------------------------------------------------------------------------
  // Sanitized review: no raw config/model/path/harness/secret exposure
  // ---------------------------------------------------------------------------

  /**
   * Tokens that must NOT appear in any rendered (composed) prompt.
   * These indicate raw config objects, model identifiers, file paths,
   * harness-specific tool names, or secret/environment data leaking through.
   */
  const RENDERED_BANNED_TOKENS = [
    // Raw model identifiers
    "claude-sonnet",
    "gpt-4",
    "anthropic/",
    "openai/",
    // Absolute or repo-relative paths
    "packages/config",
    "packages/engine",
    "prompts/",
    ".weave/",
    // Harness-specific tool names
    "TodoWrite",
    "todowrite",
    // Secret / environment data patterns
    "process.env",
    "API_KEY",
    "SECRET",
    // Weave-repo implementation details
    "neverthrow",
    "AGENTS.md",
    "bun run",
  ] as const;

  for (const token of RENDERED_BANNED_TOKENS) {
    it(`no composed prompt exposes raw token: "${token}"`, () => {
      for (const name of ALL_BUILTINS) {
        const descriptor = getDescriptor(name);
        expect(descriptor.composedPrompt).not.toContain(token);
      }
    });
  }
});
