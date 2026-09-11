/**
 * Integration test for CopilotAdapter.
 *
 * Exercises the full pipeline: create adapter → spawn multiple agents → flush
 * → verify output files against the vendored Agent Plugins 1.0.0 schema and
 * structural constraints on `.agent.md` frontmatter. Uses injectable mock
 * I/O — no real file system access, no network, no `copilot` binary.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { z } from "zod";
import { CopilotAdapter } from "../adapter.js";

// ---------------------------------------------------------------------------
// Hand-mirrored zod schema for plugin-1.0.0.schema.json
//
// Mirrors packages/adapters/copilot/src/schemas/plugin-1.0.0.schema.json
// exactly (required fields, additionalProperties: false, name pattern, the
// $schema const). Kept in the test file rather than importing an extra JSON
// Schema validator dependency, per task instructions.
// ---------------------------------------------------------------------------

const PluginAuthorSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

const PluginManifestSchema = z
  .object({
    $schema: z.literal(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.union([PluginAuthorSchema, z.string()]).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Frontmatter allowlist parser
//
// The Copilot `.agent.md` frontmatter format is tightly constrained (see
// agent-translation.ts): `name`, `description`, `tools:` list, and
// `mcp-servers:` list. A minimal line-based parser is sufficient — no YAML
// dependency exists in this package's deps (checked package.json).
// ---------------------------------------------------------------------------

const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "tools",
  "mcp-servers",
]);

function parseFrontmatter(markdown: string): {
  keys: Record<string, unknown>;
  allKeysSeen: string[];
} {
  const parts = markdown.split("---");
  if (parts.length < 3) return { keys: {}, allKeysSeen: [] };
  const body = parts[1]!;

  const result: Record<string, unknown> = {};
  const allKeysSeen: string[] = [];
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  const commitArray = () => {
    if (currentArray !== null && currentKey !== null) {
      result[currentKey] = currentArray;
    }
    currentArray = null;
    currentKey = null;
  };

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith("  - ")) {
      if (currentArray !== null) {
        currentArray.push(line.slice(4).trim());
      }
      continue;
    }

    commitArray();

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    allKeysSeen.push(key);

    if (value === "") {
      currentKey = key;
      currentArray = [];
    } else {
      result[key] = value;
    }
  }

  commitArray();

  return { keys: result, allKeysSeen };
}

function extractBody(markdown: string): string {
  const parts = markdown.split("---");
  if (parts.length < 3) return markdown;
  return parts.slice(2).join("---").replace(/^\n+/, "");
}

// ---------------------------------------------------------------------------
// Mock I/O — records every written path/content, no real file system access.
// ---------------------------------------------------------------------------

const OUT_DIR = "/tmp/opencode/weave-copilot-integration";

function makeAdapter(written: Record<string, string>, removed: string[]) {
  return new CopilotAdapter({
    projectRoot: "/project",
    homeDir: "/home/user",
    outDir: OUT_DIR,
    exists: async () => true,
    readDir: async () => [],
    readFile: async () => "",
    writeFile: async (path, content) => {
      written[path] = content;
    },
    removeFile: async (path) => {
      removed.push(path);
    },
    mkdir: async () => {},
  });
}

// ---------------------------------------------------------------------------
// Fixture descriptors: primary (loom-shaped), subagent, category shuttle
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

const ALL_DESCRIPTORS = [
  loomDescriptor,
  shuttleDescriptor,
  shuttleCoreDescriptor,
];

async function runPipeline(): Promise<{
  written: Record<string, string>;
  removed: string[];
}> {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  const adapter = makeAdapter(written, removed);

  await adapter.init();
  for (const descriptor of ALL_DESCRIPTORS) {
    await adapter.spawnSubagent(descriptor);
  }
  const flushResult = await adapter.flush();
  expect(flushResult.isOk()).toBe(true);

  return { written, removed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CopilotAdapter — integration (full pipeline)", () => {
  let written: Record<string, string>;

  beforeEach(async () => {
    ({ written } = await runPipeline());
  });

  // -------------------------------------------------------------------------
  // 1. plugin.json validated against vendored schema (hand-mirrored in zod)
  // -------------------------------------------------------------------------

  describe("plugin.json schema validation", () => {
    it("validates against the Agent Plugins 1.0.0 schema", () => {
      const key = Object.keys(written).find((k) => k.endsWith("plugin.json"));
      expect(key).toBeDefined();
      const parsed = JSON.parse(written[key!]!);
      const result = PluginManifestSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });

    it("has required fields $schema and name", () => {
      const key = Object.keys(written).find((k) => k.endsWith("plugin.json"));
      const parsed = JSON.parse(written[key!]!);
      expect(parsed.$schema).toBe(
        "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      );
      expect(parsed.name).toBe("weave");
    });

    it("rejects a manifest with unexpected additional properties (schema sanity check)", () => {
      const key = Object.keys(written).find((k) => k.endsWith("plugin.json"));
      const parsed = JSON.parse(written[key!]!);
      const mutated = { ...parsed, unexpectedField: "should not be allowed" };
      const result = PluginManifestSchema.safeParse(mutated);
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. .agent.md frontmatter allowlist + structural assertions
  // -------------------------------------------------------------------------

  describe(".agent.md frontmatter structural validation", () => {
    const expectedNames = ["loom", "shuttle", "shuttle-core"];

    for (const name of expectedNames) {
      it(`${name}.agent.md — only allowlisted keys, name matches filename, no model/trust/approved`, () => {
        const key = Object.keys(written).find(
          (k) =>
            k.includes("com.github.copilot") &&
            k.includes("agents") &&
            k.endsWith(`${name}.agent.md`),
        );
        expect(key).toBeDefined();

        const { keys, allKeysSeen } = parseFrontmatter(written[key!]!);

        // Only keys from the allowlist appear
        for (const seenKey of allKeysSeen) {
          expect(ALLOWED_FRONTMATTER_KEYS.has(seenKey)).toBe(true);
        }

        // name === filename without .agent.md
        expect(keys.name).toBe(name);

        // No model / trust / approved keys
        expect(keys.model).toBeUndefined();
        expect(keys.trust).toBeUndefined();
        expect(keys.approved).toBeUndefined();
        expect(allKeysSeen).not.toContain("model");
        expect(allKeysSeen).not.toContain("trust");
        expect(allKeysSeen).not.toContain("approved");
      });
    }

    it("loom.agent.md body contains the composed prompt", () => {
      const key = Object.keys(written).find(
        (k) =>
          k.includes("com.github.copilot") &&
          k.includes("agents") &&
          k.endsWith("loom.agent.md"),
      );
      expect(key).toBeDefined();
      expect(extractBody(written[key!]!)).toContain("You are Loom");
    });

    it("shuttle.agent.md tools exclude delegate-mapped tool (delegate denied)", () => {
      const key = Object.keys(written).find(
        (k) =>
          k.includes("com.github.copilot") &&
          k.includes("agents") &&
          k.endsWith("shuttle.agent.md"),
      );
      expect(key).toBeDefined();
      const { keys } = parseFrontmatter(written[key!]!);
      const tools = (keys.tools as string[] | undefined) ?? [];
      // Delegate is denied for the shuttle fixture; read is allowed.
      expect(tools).toContain("read");
      expect(tools).not.toContain("delegate");
    });

    /**
     * Regression case (skipped): if `agent-translation.ts` is mutated to
     * emit a `model:` key in the frontmatter (e.g. by uncommenting a stray
     * `frontmatterLines.push(\`model: \${input.resolvedModel}\`);`), this
     * test — if enabled — would fail because the allowlist check above
     * rejects any key outside { name, description, tools, mcp-servers }.
     * Verified manually by adding that line locally and re-running this
     * suite: the "no model/trust/approved" assertions above fail as
     * expected. Left as `it.skip` because it requires source mutation to
     * demonstrate, which must not be committed as active production code.
     */
    it.skip("regression: fails if frontmatter emits a model key (requires manual source mutation to demonstrate)", () => {
      // Manual verification steps:
      // 1. In agent-translation.ts, add:
      //      frontmatterLines.push(`model: some-model`);
      //    right after the `name:` line.
      // 2. Re-run this test file.
      // 3. Observe that the "only allowlisted keys" assertions in the
      //    describe block above now fail, because `allKeysSeen` contains
      //    "model", which is not in ALLOWED_FRONTMATTER_KEYS.
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. com.github.copilot/agents/ contains exactly the expected filenames
  // -------------------------------------------------------------------------

  describe("agents directory contents", () => {
    it("contains exactly the expected agent filenames, no ghosts", () => {
      const agentFiles = Object.keys(written)
        .filter(
          (k) =>
            k.includes("com.github.copilot") &&
            k.includes("agents") &&
            k.endsWith(".agent.md"),
        )
        .map((k) => k.slice(k.lastIndexOf("/") + 1));

      expect(agentFiles.sort()).toEqual(
        ["loom.agent.md", "shuttle-core.agent.md", "shuttle.agent.md"].sort(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. mcp.json presence rules
  // -------------------------------------------------------------------------

  describe("mcp.json presence", () => {
    it("is NOT written when no descriptor requests MCP servers (current MVP behavior)", () => {
      const mcpKey = Object.keys(written).find((k) => k.endsWith("mcp.json"));
      expect(mcpKey).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency: running flush() twice on the same input produces
// byte-identical output.
// ---------------------------------------------------------------------------

describe("CopilotAdapter — idempotency", () => {
  it("flush() run twice on the same input yields byte-identical output", async () => {
    const firstRun = await runPipeline();
    const secondRun = await runPipeline();

    expect(Object.keys(secondRun.written).sort()).toEqual(
      Object.keys(firstRun.written).sort(),
    );
    for (const key of Object.keys(firstRun.written)) {
      expect(secondRun.written[key]).toBe(firstRun.written[key]);
    }
  });

  it("calling flush() twice within a single adapter instance produces identical agent files on the second call", async () => {
    const written: Record<string, string> = {};
    const removed: string[] = [];
    const adapter = makeAdapter(written, removed);

    await adapter.init();
    for (const descriptor of ALL_DESCRIPTORS) {
      await adapter.spawnSubagent(descriptor);
    }
    await adapter.flush();

    const firstSnapshot = { ...written };

    // pendingAgents is cleared after flush(); re-spawn the same descriptors
    // and flush again to exercise a real second-flush idempotency check.
    for (const descriptor of ALL_DESCRIPTORS) {
      await adapter.spawnSubagent(descriptor);
    }
    await adapter.flush();

    for (const key of Object.keys(firstSnapshot)) {
      expect(written[key]).toBe(firstSnapshot[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5b. Positive MCP branch
//
// AgentDescriptor has no field to request MCP servers today (Task 7 MVP —
// see adapter.ts TODO above `mcpServers: []`). The adapter's public surface
// (CopilotAdapterOptions, spawnSubagent(descriptor)) cannot express "this
// descriptor wants MCP servers" without modifying adapter.ts. Per the task's
// guidance, branch (b) is taken: this positive case is skipped with a clear
// comment referencing the MVP TODO, rather than reaching into adapter
// internals via a subclass that would misrepresent the adapter's real
// public contract.
// ---------------------------------------------------------------------------

describe("CopilotAdapter — mcp.json positive branch", () => {
  it.skip(
    "writes a valid mcp.json when at least one descriptor requests MCP servers " +
      "(blocked: AgentDescriptor has no MCP-server field yet — see adapter.ts TODO " +
      "at translateDescriptor(); revisit once the DSL/engine can declare per-agent MCP servers)",
    () => {
      // Intentionally left unimplemented — see describe-block comment above.
    },
  );
});
