/**
 * Integration test for ClaudeCodeAdapter.
 *
 * Exercises the full pipeline: create adapter → spawn multiple agents → flush
 * → verify output files. Uses injectable mock I/O — no real file system access.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ClaudeCodeAdapter } from "../adapter.js";
import type { AgentDescriptor } from "@weaveio/weave-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OUT_DIR = "C:\\Users\\piete\\AppData\\Local\\Temp\\opencode\\weave-cc-integration";

/** Parses YAML frontmatter from a markdown string (between the first two ---). */
function parseFrontmatter(markdown: string): Record<string, unknown> {
  const parts = markdown.split("---");
  // parts[0] is empty string before first ---, parts[1] is frontmatter body
  if (parts.length < 3) return {};
  const body = parts[1]!;
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    // Array item inside a list block
    if (line.startsWith("  - ")) {
      if (currentArray !== null) {
        currentArray.push(line.slice(4).trim());
      }
      continue;
    }

    // If we were building an array, commit it before processing new key
    if (currentArray !== null && currentKey !== null) {
      result[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (value === "") {
      // Next lines are an array
      currentKey = key;
      currentArray = [];
    } else {
      result[key] = value;
    }
  }

  // Flush trailing array
  if (currentArray !== null && currentKey !== null) {
    result[currentKey] = currentArray;
  }

  return result;
}

function makeWrittenFiles(): Record<string, string> {
  return {};
}

function makeAdapter(written: Record<string, string>) {
  return new ClaudeCodeAdapter({
    projectRoot: "/project",
    homeDir: "/home/user",
    outDir: OUT_DIR,
    exists: async () => true,
    readDir: async () => [],
    readFile: async () => "",
    writeFile: async (path, content) => {
      written[path] = content;
    },
    mkdir: async () => {},
  });
}

// ---------------------------------------------------------------------------
// Fixture descriptors
// ---------------------------------------------------------------------------

const loomDescriptor: AgentDescriptor = {
  name: "loom",
  description: "Loom (Main Orchestrator)",
  composedPrompt: "You are Loom, the primary orchestrator.",
  models: ["claude-sonnet-4-5"],
  mode: "primary",
  effectiveToolPolicy: {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "allow",
    network: "allow",
  },
  rawToolPolicy: undefined,
  delegationTargets: [],
  skills: [],
};

const shuttleDescriptor: AgentDescriptor = {
  name: "shuttle",
  description: "Shuttle (Domain Specialist)",
  composedPrompt: "You are Shuttle, a domain specialist.",
  models: ["claude-sonnet-4-5"],
  mode: "subagent",
  effectiveToolPolicy: {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "deny",
    network: "ask",
  },
  rawToolPolicy: undefined,
  delegationTargets: [],
  skills: [],
};

const shuttleCoreDescriptor: AgentDescriptor = {
  name: "shuttle-core",
  description: "Shuttle for the Core package — handles parser and schema work.",
  composedPrompt: "You are the Core package specialist.",
  models: ["claude-sonnet-4-5"],
  mode: "subagent",
  effectiveToolPolicy: {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "deny",
    network: "deny",
  },
  rawToolPolicy: undefined,
  delegationTargets: [],
  skills: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter — integration (full pipeline)", () => {
  let written: Record<string, string>;
  let adapter: ClaudeCodeAdapter;

  beforeEach(async () => {
    written = makeWrittenFiles();
    adapter = makeAdapter(written);
    await adapter.init();
    await adapter.spawnSubagent(loomDescriptor);
    await adapter.spawnSubagent(shuttleDescriptor);
    await adapter.spawnSubagent(shuttleCoreDescriptor);
    await adapter.flush();
  });

  // -------------------------------------------------------------------------
  // plugin.json
  // -------------------------------------------------------------------------

  it("writes .claude-plugin/plugin.json with correct metadata", () => {
    const key = Object.keys(written).find((k) => k.endsWith("plugin.json"));
    expect(key).toBeDefined();
    const parsed = JSON.parse(written[key!]!);
    expect(parsed).toMatchObject({ name: "weave", version: "1.0.0" });
  });

  // -------------------------------------------------------------------------
  // loom.md
  // -------------------------------------------------------------------------

  it("writes agents/loom.md with correct name and model in frontmatter", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("loom.md"),
    );
    expect(key).toBeDefined();
    const fm = parseFrontmatter(written[key!]!);
    expect(fm["name"]).toBe("loom");
    expect(typeof fm["model"]).toBe("string");
    expect((fm["model"] as string).length).toBeGreaterThan(0);
  });

  it("loom.md frontmatter includes Agent (delegate) in tools", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("loom.md"),
    );
    expect(key).toBeDefined();
    const fm = parseFrontmatter(written[key!]!);
    const tools = fm["tools"] as string[];
    expect(Array.isArray(tools)).toBe(true);
    // "Task" is the Claude Code tool that maps to delegate capability
    expect(tools).toContain("Task");
  });

  it("loom.md contains the composed prompt body", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("loom.md"),
    );
    expect(key).toBeDefined();
    expect(written[key!]).toContain("You are Loom");
  });

  // -------------------------------------------------------------------------
  // shuttle.md
  // -------------------------------------------------------------------------

  it("writes agents/shuttle.md with delegate-denied (Task absent from tools)", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("shuttle.md"),
    );
    expect(key).toBeDefined();
    const content = written[key!]!;
    // Task is absent because delegate is denied
    expect(content).not.toContain("- Task");
    // Read should be present
    expect(content).toContain("- Read");
  });

  it("shuttle.md frontmatter has name: shuttle", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("shuttle.md"),
    );
    expect(key).toBeDefined();
    const fm = parseFrontmatter(written[key!]!);
    expect(fm["name"]).toBe("shuttle");
  });

  // -------------------------------------------------------------------------
  // shuttle-core.md
  // -------------------------------------------------------------------------

  it("writes agents/shuttle-core.md with description containing 'Core'", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("shuttle-core.md"),
    );
    expect(key).toBeDefined();
    const fm = parseFrontmatter(written[key!]!);
    expect(typeof fm["description"]).toBe("string");
    expect((fm["description"] as string).toLowerCase()).toContain("core");
  });

  it("shuttle-core.md delegate denied — Task absent from tools", () => {
    const key = Object.keys(written).find(
      (k) => k.includes("agents") && k.endsWith("shuttle-core.md"),
    );
    expect(key).toBeDefined();
    expect(written[key!]).not.toContain("- Task");
  });

  // -------------------------------------------------------------------------
  // settings.json
  // -------------------------------------------------------------------------

  it("writes settings.json with agent: loom when loom is present", () => {
    const key = Object.keys(written).find((k) => k.endsWith("settings.json"));
    expect(key).toBeDefined();
    const parsed = JSON.parse(written[key!]!);
    expect(parsed).toMatchObject({ agent: "loom" });
  });

  // -------------------------------------------------------------------------
  // All three agent files present
  // -------------------------------------------------------------------------

  it("writes exactly three agent markdown files", () => {
    const agentFiles = Object.keys(written).filter(
      (k) => k.includes("agents") && k.endsWith(".md"),
    );
    expect(agentFiles).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Negative case: no loom agent → settings.json must NOT be written
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter — negative case (no loom agent)", () => {
  it("does NOT write settings.json when loom is absent", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written);

    await adapter.init();
    await adapter.spawnSubagent(shuttleDescriptor);
    await adapter.spawnSubagent(shuttleCoreDescriptor);
    await adapter.flush();

    const settingsKey = Object.keys(written).find((k) => k.endsWith("settings.json"));
    expect(settingsKey).toBeUndefined();
  });

  it("still writes plugin.json and agent files when loom is absent", async () => {
    const written: Record<string, string> = {};
    const adapter = makeAdapter(written);

    await adapter.init();
    await adapter.spawnSubagent(shuttleDescriptor);
    await adapter.flush();

    const pluginKey = Object.keys(written).find((k) => k.endsWith("plugin.json"));
    expect(pluginKey).toBeDefined();

    const agentFiles = Object.keys(written).filter(
      (k) => k.includes("agents") && k.endsWith(".md"),
    );
    expect(agentFiles).toHaveLength(1);
  });
});
