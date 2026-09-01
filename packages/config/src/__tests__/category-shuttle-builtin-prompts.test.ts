/**
 * Regression test: shipped builtin Loom and Tapestry prompts correctly render
 * category shuttle names and descriptions when categories are configured.
 *
 * Uses the real shipped loading pipeline (`loadConfig`) with a mock file reader
 * that provides a project config declaring two categories. Composing Loom and
 * Tapestry descriptors through the normal path must produce composed prompts
 * that contain concrete category shuttle names and descriptions.
 *
 * This test will fail if:
 * - `loadConfig` stops inlining builtin prompt content
 * - `loom.md` or `tapestry.md` stop rendering category shuttles
 * - `generateCategoryShuttles` or `composeAgentDescriptor` regress
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  composeAgentDescriptor,
  generateCategoryShuttles,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import type { FileReader } from "../discovery.js";
import { loadConfig } from "../loader.js";

// ---------------------------------------------------------------------------
// Project config fixture: two categories
// ---------------------------------------------------------------------------

const PROJECT_CONFIG_WITH_CATEGORIES = `
  category frontend {
    description "Frontend UI layer"
    patterns ["src/frontend/**", "**/*.tsx"]
    models ["gpt-4o"]
  }

  category backend {
    description "Backend API layer"
    patterns ["src/backend/**", "**/*.go"]
    models ["claude-sonnet-4-5"]
  }
`;

// ---------------------------------------------------------------------------
// Mock file reader: only the project config file exists; global is absent
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/test/project";
const PROJECT_CONFIG_PATH = `${PROJECT_ROOT}/.weave/config.weave`;

function makeFileReader(projectConfig: string): FileReader {
  return {
    exists: async (path: string) => path === PROJECT_CONFIG_PATH,
    read: (path: string) => {
      if (path === PROJECT_CONFIG_PATH) return okAsync(projectConfig);
      return errAsync({
        type: "FileReadError" as const,
        path,
        cause: new Error("not found"),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: load merged config and compose a descriptor for the given agent
// ---------------------------------------------------------------------------

async function composedDescriptor(agentName: string, projectConfig: string) {
  const origHome = process.env.HOME;
  process.env.HOME = "/nonexistent-home-for-test";
  let merged: WeaveConfig;
  try {
    const loadResult = await loadConfig(
      PROJECT_ROOT,
      makeFileReader(projectConfig),
    );
    if (loadResult.isErr()) {
      throw new Error(`loadConfig failed: ${JSON.stringify(loadResult.error)}`);
    }
    merged = loadResult.value;
  } finally {
    process.env.HOME = origHome;
  }

  // Generate category shuttle descriptors
  const shuttleMapResult = generateCategoryShuttles(merged);
  if (shuttleMapResult.isErr()) {
    throw new Error(
      `generateCategoryShuttles failed: ${shuttleMapResult.error.message}`,
    );
  }
  const shuttleMap = shuttleMapResult.value;

  // Build full agent map: declared agents + category shuttles
  const allAgents: Record<string, import("@weaveio/weave-core").AgentConfig> = {
    ...merged.agents,
    ...Object.fromEntries(
      Object.entries(shuttleMap).map(([k, v]) => [k, v.config]),
    ),
  };

  const agentConfig = allAgents[agentName];
  if (agentConfig === undefined) {
    throw new Error(`Agent "${agentName}" not found in merged config`);
  }

  const generated = shuttleMap[agentName];
  const categoryMeta = generated?.categoryMeta;

  const result = await composeAgentDescriptor(
    agentName,
    agentConfig,
    merged,
    allAgents,
    categoryMeta,
    undefined,
    shuttleMap,
  );
  if (result.isErr()) {
    throw new Error(
      `composeAgentDescriptor failed: ${JSON.stringify(result.error)}`,
    );
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shipped builtin Loom and Tapestry prompts with project categories", () => {
  it("shipped Loom prompt renders category shuttle names and descriptions", async () => {
    const desc = await composedDescriptor(
      "loom",
      PROJECT_CONFIG_WITH_CATEGORIES,
    );

    // Delegation targets must include the category shuttles
    const targetNames = desc.delegationTargets.map((t) => t.name);
    expect(targetNames).toContain("shuttle-frontend");
    expect(targetNames).toContain("shuttle-backend");

    // Category descriptions must flow into delegation target metadata
    const frontend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-frontend",
    );
    const backend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-backend",
    );
    expect(frontend?.description).toBe("Frontend UI layer");
    expect(backend?.description).toBe("Backend API layer");

    // CRITICAL: composed prompt must contain concrete names and descriptions.
    // This assertion fails if loom.md stops rendering category shuttles.
    expect(desc.composedPrompt).toContain("shuttle-frontend");
    expect(desc.composedPrompt).toContain("shuttle-backend");
    expect(desc.composedPrompt).toContain("Frontend UI layer");
    expect(desc.composedPrompt).toContain("Backend API layer");

    // Verify the shipped prompt contains the category shuttle guidance section
    expect(desc.composedPrompt).toContain("## Category Shuttles");
    expect(desc.composedPrompt).toContain(
      "Prefer a category shuttle over the generic shuttle",
    );
  });

  it("shipped Tapestry prompt renders category shuttle names and descriptions", async () => {
    const desc = await composedDescriptor(
      "tapestry",
      PROJECT_CONFIG_WITH_CATEGORIES,
    );

    // Delegation targets must include the category shuttles
    const targetNames = desc.delegationTargets.map((t) => t.name);
    expect(targetNames).toContain("shuttle-frontend");
    expect(targetNames).toContain("shuttle-backend");

    // Category descriptions must flow into delegation target metadata
    const frontend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-frontend",
    );
    const backend = desc.delegationTargets.find(
      (t) => t.name === "shuttle-backend",
    );
    expect(frontend?.description).toBe("Frontend UI layer");
    expect(backend?.description).toBe("Backend API layer");

    // CRITICAL: composed prompt must contain concrete names and descriptions.
    // This assertion fails if tapestry.md stops rendering category shuttles.
    expect(desc.composedPrompt).toContain("shuttle-frontend");
    expect(desc.composedPrompt).toContain("shuttle-backend");
    expect(desc.composedPrompt).toContain("Frontend UI layer");
    expect(desc.composedPrompt).toContain("Backend API layer");

    // Verify the shipped prompt contains routing guidance for category shuttles
    expect(desc.composedPrompt).toContain(
      "Route implementation tasks to `shuttle-{category}` agents",
    );
  });
});
