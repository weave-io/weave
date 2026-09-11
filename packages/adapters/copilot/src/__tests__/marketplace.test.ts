/**
 * Marketplace manifest and committed Copilot plugin bundle validation.
 *
 * # Purpose
 *
 * `.github/plugin/marketplace.json` (repo root) is the self-hosted GitHub
 * Copilot plugin marketplace manifest for this repository. It registers the
 * marketplace name `weaveio` and a single `weave` plugin entry whose
 * `source` is the same-repo relative path `./plugins/copilot` — a
 * **committed distribution snapshot**, deliberately distinct from the
 * adapter's gitignored default local-generation target
 * (`.weave/plugins/copilot/`). See `docs/copilot-adapter.md` § Self-hosted
 * plugin marketplace and `docs/adapters/copilot.md` § Self-hosted
 * marketplace install for the full rationale.
 *
 * These tests guard against three independent kinds of drift:
 *
 *   1. **Manifest shape** — `.github/plugin/marketplace.json` parses and its
 *      `weave` entry stays in sync with the committed `plugins/copilot/plugin.json`
 *      (same `name`/`version`), uses a same-repo relative `source`, carries
 *      no `ref`/`sha` placeholder, and does not invent owner/repository
 *      values.
 *   2. **Official schema conformance** — `plugins/copilot/plugin.json` is
 *      validated with `ajv` against the *actual* vendored
 *      `plugin-1.0.0.schema.json` (not a hand-mirrored re-implementation),
 *      so a schema update is automatically re-checked against the real
 *      manifest.
 *   3. **Bundle completeness/drift** — the committed `plugins/copilot/`
 *      directory contains one `.agent.md` per agent Weave's current config
 *      materializes (13 agents: 8 builtins + 5 category shuttles), each with
 *      well-formed frontmatter and a non-empty prompt body; the expected
 *      `com.github.copilot/commands/*.md` files exist with their known
 *      content; and regenerating the bundle fresh (via the same
 *      `CopilotAdapter` + `materializeAgents` pipeline
 *      `generate-bundle.ts` uses, written to a temp directory) produces
 *      byte-identical output to what is committed — catching a forgotten
 *      `bun run generate:copilot-plugin-dist` after a `.weave/config.weave`
 *      change.
 *
 * # Test isolation
 *
 * Tests 1–2 read only committed repo files (no mocking, no network, no
 * `copilot` binary). Test 3's drift check performs real filesystem I/O
 * (writes to `Bun`-managed temp directories, not the repo) using the real
 * `loadConfig`/`materializeAgents`/`CopilotAdapter` pipeline — an
 * integration-style guard consistent with
 * `packages/cli/src/evals/__tests__/workflow-sync.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "@weaveio/weave-config";
import { materializeAgents } from "@weaveio/weave-engine";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { CopilotAdapter } from "../adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const MARKETPLACE_PATH = resolve(REPO_ROOT, ".github/plugin/marketplace.json");
const COMMITTED_BUNDLE_DIR = resolve(REPO_ROOT, "plugins/copilot");
const PLUGIN_MANIFEST_PATH = resolve(COMMITTED_BUNDLE_DIR, "plugin.json");
const SCHEMA_PATH = resolve(
  import.meta.dir,
  "../schemas/plugin-1.0.0.schema.json",
);
const AGENTS_DIR = resolve(COMMITTED_BUNDLE_DIR, "com.github.copilot/agents");
const COMMANDS_DIR = resolve(
  COMMITTED_BUNDLE_DIR,
  "com.github.copilot/commands",
);

/** Builtin agents declared in `packages/config/src/builtins.ts`. */
const EXPECTED_BUILTIN_AGENTS = [
  "loom",
  "tapestry",
  "shuttle",
  "pattern",
  "thread",
  "spindle",
  "weft",
  "warp",
] as const;

/** Category shuttles declared in `.weave/config.weave` (repo root). */
const EXPECTED_CATEGORY_SHUTTLES = [
  "shuttle-core",
  "shuttle-engine",
  "shuttle-adapters",
  "shuttle-docs",
  "shuttle-scripts",
] as const;

const EXPECTED_AGENT_NAMES = [
  ...EXPECTED_BUILTIN_AGENTS,
  ...EXPECTED_CATEGORY_SHUTTLES,
].sort();

/** Written only when a "tapestry" agent is queued (see `adapter.ts`). */
const EXPECTED_COMMAND_FILES = ["start.md", "start-work.md"] as const;

// ---------------------------------------------------------------------------
// Marketplace manifest schema (real-world shape of
// `github/copilot-plugins`' `.github/plugin/marketplace.json`, fetched live
// 2026-09-11)
// ---------------------------------------------------------------------------

const MarketplacePersonSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  author: MarketplacePersonSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  source: z.union([
    z.string().startsWith("./"),
    z.object({
      source: z.literal("github"),
      repo: z.string(),
      path: z.string().optional(),
    }),
  ]),
});

const MarketplaceManifestSchema = z.object({
  name: z.string().min(1),
  metadata: z
    .object({
      description: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  owner: MarketplacePersonSchema.optional(),
  plugins: z.array(MarketplacePluginEntrySchema).min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readMarketplace() {
  const text = await Bun.file(MARKETPLACE_PATH).text();
  return MarketplaceManifestSchema.parse(JSON.parse(text));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

/**
 * Parses a `.agent.md` file's YAML-ish frontmatter block (delimited by
 * `---` lines) into a flat key/value map, plus the remaining prompt body.
 * Mirrors the deliberately narrow frontmatter shape `agent-translation.ts`
 * emits (`name`, `description`, `tools:`/`mcp-servers:` lists) — this is not
 * a general YAML parser.
 */
function parseAgentMarkdown(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = text.split("\n");
  expect(lines[0]).toBe("---");
  const closingIndex = lines.indexOf("---", 1);
  expect(closingIndex).toBeGreaterThan(0);

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const match = line.match(/^([a-zA-Z-]+):\s?(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined && match[2] !== "") {
      frontmatter[match[1]] = match[2];
    }
  }
  const body = lines
    .slice(closingIndex + 1)
    .join("\n")
    .trim();
  return { frontmatter, body };
}

/** Recursively lists all file paths under `dir`, relative to `dir`. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const results: string[] = [];
  for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
    results.push(entry);
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// 1. Marketplace manifest shape and drift against the committed plugin.json
// ---------------------------------------------------------------------------

describe("Copilot marketplace manifest (.github/plugin/marketplace.json)", () => {
  it("is valid JSON conforming to the marketplace schema shape", async () => {
    const text = await Bun.file(MARKETPLACE_PATH).text();
    const parsed = MarketplaceManifestSchema.safeParse(JSON.parse(text));
    expect(parsed.success).toBe(true);
  });

  it("registers the marketplace under the required name 'weaveio'", async () => {
    const manifest = await readMarketplace();
    expect(manifest.name).toBe("weaveio");
  });

  it("declares a 'weave' plugin entry sourced from the committed distribution snapshot", async () => {
    const manifest = await readMarketplace();
    const weave = manifest.plugins.find((p) => p.name === "weave");
    expect(weave).toBeDefined();
    expect(typeof weave?.source === "string").toBe(true);
    expect(weave?.source).toBe("./plugins/copilot");
  });

  it("does not pin a ref/sha for the in-repo plugin source", async () => {
    // The manifest lives in the same repo as the plugin it references and
    // evolves with the branch; pinning a ref/sha here would go stale on
    // every commit and has no upstream precedent for same-repo relative
    // sources (see github/copilot-plugins' "spark" entry: "./plugins/spark",
    // no ref field). Cross-repo `{ source: "github", repo, path }` entries
    // are the only shape that could carry a ref, and Weave's manifest uses
    // neither that shape nor an invented `ref`/`sha` field.
    const raw = (await readJson(MARKETPLACE_PATH)) as {
      plugins: Array<Record<string, unknown>>;
    };
    for (const entry of raw.plugins) {
      expect(entry).not.toHaveProperty("ref");
      expect(entry).not.toHaveProperty("sha");
    }
  });

  it("does not invent owner/repository values not backed by git/package metadata", async () => {
    const manifest = await readMarketplace();
    // Derived from `git remote get-url origin` (weave-io/weave) and the
    // `@weaveio/*` npm scope used across every package.json in this repo.
    expect(manifest.owner?.url).toBe("https://github.com/weave-io");
    const weave = manifest.plugins.find((p) => p.name === "weave");
    expect(weave?.repository).toBe("https://github.com/weave-io/weave");
    expect(weave?.homepage).toBe("https://github.com/weave-io/weave");
  });

  it("points at a committed plugin root whose manifest name/version match", async () => {
    const pluginExists = await Bun.file(PLUGIN_MANIFEST_PATH).exists();
    expect(pluginExists).toBe(true);

    const pluginManifest = (await readJson(PLUGIN_MANIFEST_PATH)) as {
      name: string;
      version?: string;
    };
    const manifest = await readMarketplace();
    const weave = manifest.plugins.find((p) => p.name === "weave");

    expect(weave?.name).toBe(pluginManifest.name);
    expect(weave?.version).toBe(pluginManifest.version);
  });
});

// ---------------------------------------------------------------------------
// 2. Official Agent Plugins 1.0.0 schema conformance (real ajv validation,
//    not a hand-mirrored zod re-implementation)
// ---------------------------------------------------------------------------

describe("Committed plugin.json (plugins/copilot/plugin.json) — official schema", () => {
  it("validates against the vendored plugin-1.0.0.schema.json via ajv", async () => {
    const schema = await readJson(SCHEMA_PATH);
    const manifest = await readJson(PLUGIN_MANIFEST_PATH);

    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile(schema as Record<string, unknown>);
    const valid = validate(manifest);

    expect(validate.errors ?? null).toBeNull();
    expect(valid).toBe(true);
  });

  it("has the manifest name 'weave' matching the plugin id qualifier", async () => {
    const manifest = (await readJson(PLUGIN_MANIFEST_PATH)) as {
      name: string;
    };
    expect(manifest.name).toBe("weave");
  });
});

// ---------------------------------------------------------------------------
// 3. Bundle completeness — expected agents and commands, real content checks
// ---------------------------------------------------------------------------

describe("Committed bundle completeness (plugins/copilot/com.github.copilot/)", () => {
  it("contains exactly one .agent.md per expected materialized agent", async () => {
    const files = await listFilesRecursive(AGENTS_DIR);
    const agentFiles = files
      .filter((f) => f.endsWith(".agent.md"))
      .map((f) => f.replace(/\.agent\.md$/, ""))
      .sort();

    expect(agentFiles).toEqual(EXPECTED_AGENT_NAMES);
  });

  for (const agentName of EXPECTED_AGENT_NAMES) {
    it(`'${agentName}.agent.md' has well-formed frontmatter and a non-empty prompt body`, async () => {
      const path = join(AGENTS_DIR, `${agentName}.agent.md`);
      const exists = await Bun.file(path).exists();
      expect(exists).toBe(true);

      const text = await Bun.file(path).text();
      const { frontmatter, body } = parseAgentMarkdown(text);

      // Filename is always the bare agent name (CLI resolves by filename);
      // frontmatter `name:` may be qualified as `weave:<agent-name>` — see
      // docs/copilot-adapter.md § Plugin agent id qualification.
      expect(frontmatter.name).toBe(`weave:${agentName}`);
      expect(frontmatter.description).toBeDefined();
      expect(frontmatter.description?.length ?? 0).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
    });
  }

  it("contains the expected command files with non-empty content", async () => {
    const files = await listFilesRecursive(COMMANDS_DIR);
    expect(files.sort()).toEqual([...EXPECTED_COMMAND_FILES].sort());

    for (const file of EXPECTED_COMMAND_FILES) {
      const text = await Bun.file(join(COMMANDS_DIR, file)).text();
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Regeneration drift check — the committed bundle must equal a fresh
//    regeneration from current `.weave/config.weave` + builtins.
// ---------------------------------------------------------------------------

describe("Committed bundle regeneration drift", () => {
  let freshDir: string;

  beforeAll(async () => {
    freshDir = await mkdtemp(join(tmpdir(), "weave-copilot-dist-drift-"));

    const configResult = await loadConfig(REPO_ROOT);
    if (configResult.isErr()) {
      throw new Error(
        `loadConfig failed: ${JSON.stringify(configResult.error)}`,
      );
    }
    const planResult = await materializeAgents({ config: configResult.value });
    if (planResult.isErr()) {
      throw new Error(
        `materializeAgents failed: ${JSON.stringify(planResult.error)}`,
      );
    }

    const adapter = new CopilotAdapter({
      projectRoot: REPO_ROOT,
      homeDir: freshDir,
      outDir: freshDir,
    });
    await adapter.init();
    for (const { descriptor } of planResult.value.agents) {
      const r = await adapter.spawnSubagent(descriptor);
      if (r.isErr()) {
        throw new Error(`spawnSubagent(${descriptor.name}) failed: ${r.error}`);
      }
    }
    const flushResult = await adapter.flush();
    if (flushResult.isErr()) {
      throw new Error(`flush failed: ${flushResult.error}`);
    }
  });

  afterAll(async () => {
    await rm(freshDir, { recursive: true, force: true });
  });

  it("produces the same set of files as the committed distribution snapshot", async () => {
    const committedFiles = await listFilesRecursive(COMMITTED_BUNDLE_DIR);
    const freshFiles = await listFilesRecursive(freshDir);
    expect(freshFiles).toEqual(committedFiles);
  });

  it("produces byte-identical content to the committed distribution snapshot", async () => {
    const committedFiles = await listFilesRecursive(COMMITTED_BUNDLE_DIR);
    const mismatches: string[] = [];
    for (const relPath of committedFiles) {
      const committedText = await Bun.file(
        join(COMMITTED_BUNDLE_DIR, relPath),
      ).text();
      const freshText = await Bun.file(join(freshDir, relPath)).text();
      if (committedText !== freshText) mismatches.push(relPath);
    }
    expect(mismatches).toEqual([]);
  });
});
