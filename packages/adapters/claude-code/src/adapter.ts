/**
 * Claude Code HarnessAdapter implementation.
 *
 * Materializes Weave agent descriptors as a Claude Code plugin directory
 * under `.weave/plugins/claude-code/`. Uses a flush-based pattern: agents
 * are accumulated eagerly during `spawnSubagent` calls, then written all
 * at once via `flush()`.
 */

import { join } from "node:path";
import { okAsync, errAsync, ResultAsync } from "neverthrow";
import type { HarnessAdapter, AgentDescriptor, SkillInfo } from "@weaveio/weave-engine";
import { resolveToolDecisions, resolveAdapterModelIntent } from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { translateAgentToMarkdown } from "./agent-translation.js";
import {
  getClaudeCodeToolClassifications,
  CLAUDE_CODE_TOOL_IDS,
} from "./tool-classification.js";
import { buildClaudeCodeModelInput } from "./model-resolution.js";
import { discoverClaudeCodeSkills } from "./skill-discovery.js";

const log = logger.child({ module: "adapter-claude-code" });

/** A translated agent ready to be flushed to disk. */
interface PendingAgent {
  name: string;
  markdown: string;
}

export interface ClaudeCodeAdapterOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Absolute path to the user's home directory. */
  homeDir: string;
  /**
   * Output directory for the plugin bundle.
   * Defaults to `<projectRoot>/.weave/plugins/claude-code`.
   */
  outDir?: string;
  /** Injectable directory reader for testability. */
  readDir?: (path: string) => Promise<string[]>;
  /** Injectable file reader for testability. */
  readFile?: (path: string) => Promise<string>;
  /** Injectable file writer for testability. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Injectable file remover for testability. */
  removeFile?: (path: string) => Promise<void>;
  /** Injectable directory existence checker. */
  exists?: (path: string) => Promise<boolean>;
  /** Injectable directory creator. */
  mkdir?: (path: string) => Promise<void>;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  private readonly projectRoot: string;
  private readonly homeDir: string;
  private readonly outDir: string;
  private readonly readDir: (path: string) => Promise<string[]>;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly removeFile: (path: string) => Promise<void>;
  private readonly exists: (path: string) => Promise<boolean>;
  private readonly mkdir: (path: string) => Promise<void>;

  private readonly pendingAgents: PendingAgent[] = [];

  constructor(options: ClaudeCodeAdapterOptions) {
    this.projectRoot = options.projectRoot;
    this.homeDir = options.homeDir;
    this.outDir =
      options.outDir ?? join(options.projectRoot, ".weave", "plugins", "claude-code");
    this.readDir = options.readDir ?? defaultReadDir;
    this.readFile = options.readFile ?? defaultReadFile;
    this.writeFile = options.writeFile ?? defaultWriteFile;
    this.removeFile = options.removeFile ?? defaultRemoveFile;
    this.exists = options.exists ?? defaultExists;
    this.mkdir = options.mkdir ?? defaultMkdir;
  }

  async init(): Promise<void> {
    const outDirExists = await this.exists(this.outDir);
    if (!outDirExists) {
      await this.mkdir(this.outDir);
      log.info({ outDir: this.outDir }, "Created plugin output directory");
    } else {
      log.info({ outDir: this.outDir }, "Plugin output directory exists");
    }

    log.info("Claude Code adapter initialized (plugin mode)");
  }

  async loadAvailableSkills(): Promise<SkillInfo[]> {
    const result = await discoverClaudeCodeSkills(
      this.projectRoot,
      this.homeDir,
      this.readDir,
      this.readFile,
    );

    return result.match(
      (skills) => {
        log.info({ count: skills.length }, "Discovered Claude Code skills");
        return skills;
      },
      (error) => {
        log.warn({ err: error }, "Skill discovery failed — returning empty list");
        return [];
      },
    );
  }

  /**
   * Translates the descriptor eagerly (to surface errors early) and
   * accumulates the result. No files are written until `flush()` is called.
   */
  spawnSubagent(descriptor: AgentDescriptor): ResultAsync<void, Error> {
    try {
      const markdown = this.translateDescriptor(descriptor);
      this.pendingAgents.push({ name: descriptor.name, markdown });
      log.info({ agent: descriptor.name }, "Queued agent for flush");
      return okAsync(undefined);
    } catch (e) {
      return errAsync(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Writes all accumulated agents plus plugin metadata to `outDir`.
   *
   * Layout:
   * ```
   * <outDir>/
   * ├── .claude-plugin/plugin.json
   * ├── agents/<name>.md
   * └── settings.json   (only when a "loom" agent was accumulated)
   * ```
   */
  flush(): ResultAsync<void, Error> {
    return ResultAsync.fromPromise(this.doFlush(), (e) =>
      e instanceof Error ? e : new Error(String(e)),
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private translateDescriptor(descriptor: AgentDescriptor): string {
    const modelInput = buildClaudeCodeModelInput(descriptor);
    const modelResult = resolveAdapterModelIntent(modelInput);
    const resolvedModel = modelResult.model;

    const classifications = getClaudeCodeToolClassifications();
    const decisions = resolveToolDecisions(
      CLAUDE_CODE_TOOL_IDS,
      classifications,
      descriptor.effectiveToolPolicy,
    );

    const allowedTools = decisions
      .filter((d) => d.kind === "mapped" && d.permission !== "deny")
      .map((d) => d.toolId);

    return translateAgentToMarkdown({ descriptor, resolvedModel, allowedTools });
  }

  private async doFlush(): Promise<void> {
    // .claude-plugin/plugin.json
    const pluginDir = join(this.outDir, ".claude-plugin");
    const pluginDirExists = await this.exists(pluginDir);
    if (!pluginDirExists) {
      await this.mkdir(pluginDir);
    }
    await this.writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "weave", version: "1.0.0" }, null, 2),
    );

    // agents/<name>.md — remove stale files before writing new ones
    const agentsDir = join(this.outDir, "agents");
    const agentsDirExists = await this.exists(agentsDir);
    if (!agentsDirExists) {
      await this.mkdir(agentsDir);
    } else {
      // Clean up any .md files not in the current pending set so renamed/deleted
      // agents don't leave ghost files behind.
      const pendingNames = new Set(this.pendingAgents.map((a) => `${a.name}.md`));
      const existing = await this.readDir(agentsDir).catch(() => [] as string[]);
      for (const file of existing) {
        if (file.endsWith(".md") && !pendingNames.has(file)) {
          await this.removeFile(join(agentsDir, file));
          log.info({ file }, "Removed stale Claude Code agent file");
        }
      }
    }
    for (const agent of this.pendingAgents) {
      const filePath = join(agentsDir, `${agent.name}.md`);
      await this.writeFile(filePath, agent.markdown);
      log.info({ agent: agent.name, file: filePath }, "Flushed Claude Code agent");
    }

    // settings.json — only when a "loom" agent was accumulated
    const hasLoom = this.pendingAgents.some((a) => a.name === "loom");
    if (hasLoom) {
      await this.writeFile(
        join(this.outDir, "settings.json"),
        JSON.stringify({ agent: "loom" }, null, 2),
      );
      log.info({ outDir: this.outDir }, "Wrote settings.json (loom agent present)");
    }

    log.info(
      { agents: this.pendingAgents.length, outDir: this.outDir },
      "Plugin flush complete",
    );

    this.pendingAgents.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Default I/O implementations using Bun APIs
// ---------------------------------------------------------------------------

async function defaultReadDir(path: string): Promise<string[]> {
  // Uses Bun's Node.js compatibility layer — Bun does not expose a native
  // readdir equivalent outside of node:fs/promises, which Bun implements
  // as a built-in compat module (same as node:path / node:os).
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

async function defaultReadFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function defaultWriteFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

async function defaultRemoveFile(path: string): Promise<void> {
  // Uses Bun's Node.js compatibility layer — same rationale as defaultReadDir.
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
}

async function defaultExists(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return file.exists();
}

async function defaultMkdir(path: string): Promise<void> {
  // Uses Bun's Node.js compatibility layer — same rationale as defaultReadDir.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}
