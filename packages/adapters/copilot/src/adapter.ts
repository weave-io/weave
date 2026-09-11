/**
 * GitHub Copilot HarnessAdapter implementation.
 *
 * Materializes Weave agent descriptors as a Copilot "Agent Plugin" bundle
 * (Agent Plugins 1.0) under `.weave/plugins/copilot/`. Uses a flush-based
 * pattern: agents are accumulated eagerly during `spawnSubagent` calls, then
 * written all at once via `flush()`.
 */

import { join } from "node:path";
import type {
  AgentDescriptor,
  HarnessAdapter,
  SkillInfo,
} from "@weaveio/weave-engine";
import {
  logger,
  resolveAdapterModelIntent,
  resolveToolDecisions,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { translateAgentToCopilotMarkdown } from "./agent-translation.js";
import { buildCopilotModelInput } from "./model-resolution.js";
import { discoverCopilotSkills } from "./skill-discovery.js";
import {
  COPILOT_TOOL_IDS,
  getCopilotToolClassifications,
} from "./tool-classification.js";

const log = logger.child({ module: "adapter-copilot" });

const PLUGIN_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** A translated agent ready to be flushed to disk. */
interface PendingAgent {
  name: string;
  markdown: string;
  mcpServers: string[];
}

export interface CopilotAdapterOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Absolute path to the user's home directory. */
  homeDir: string;
  /**
   * Output directory for the plugin bundle.
   * Defaults to `<projectRoot>/.weave/plugins/copilot`.
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

export class CopilotAdapter implements HarnessAdapter {
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

  constructor(options: CopilotAdapterOptions) {
    this.projectRoot = options.projectRoot;
    this.homeDir = options.homeDir;
    this.outDir =
      options.outDir ??
      join(options.projectRoot, ".weave", "plugins", "copilot");
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

    log.info("Copilot adapter initialized (plugin mode)");
  }

  async loadAvailableSkills(): Promise<SkillInfo[]> {
    const result = await discoverCopilotSkills(
      this.projectRoot,
      this.homeDir,
      this.readDir,
      this.readFile,
    );

    return result.match(
      (skills) => {
        log.info({ count: skills.length }, "Discovered Copilot skills");
        return skills;
      },
      (error) => {
        log.warn(
          { err: error },
          "Skill discovery failed — returning empty list",
        );
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
      const { markdown, mcpServers } = this.translateDescriptor(descriptor);
      this.pendingAgents.push({ name: descriptor.name, markdown, mcpServers });
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
   * ├── plugin.json
   * ├── com.github.copilot/
   * │   ├── agents/<name>.agent.md
   * │   ├── commands/*.md      (only when a "tapestry" agent is queued)
   * ├── skills/<skill-name>/SKILL.md
   * └── mcp.json               (only when any pending agent has mcpServers)
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

  private translateDescriptor(descriptor: AgentDescriptor): {
    markdown: string;
    mcpServers: string[];
  } {
    const modelInput = buildCopilotModelInput(descriptor);
    const modelResult = resolveAdapterModelIntent(modelInput);
    const resolvedModel = modelResult.model;

    const classifications = getCopilotToolClassifications();
    const decisions = resolveToolDecisions(
      COPILOT_TOOL_IDS,
      classifications,
      descriptor.effectiveToolPolicy,
    );

    const allowedTools = decisions
      .filter((d) => d.kind === "mapped" && d.permission !== "deny")
      .map((d) => d.toolId);

    // TODO: MVP — Weave's AgentDescriptor does not currently carry an
    // explicit MCP server marker/field. Once the DSL/engine gains a way to
    // declare MCP servers per-agent, resolve them here instead of always
    // emitting an empty array.
    const mcpServers: string[] = [];

    const markdown = translateAgentToCopilotMarkdown({
      descriptor,
      resolvedModel,
      allowedTools,
      mcpServers,
    });

    return { markdown, mcpServers };
  }

  private async doFlush(): Promise<void> {
    // plugin.json
    const { version } = await readOwnPackageJson();
    await this.writeFile(
      join(this.outDir, "plugin.json"),
      JSON.stringify(
        {
          $schema: PLUGIN_SCHEMA_URL,
          name: "weave",
          version,
          description:
            "Harness-agnostic prompt and agent-configuration API for GitHub Copilot",
          author: "Weave",
          license: "MIT",
          keywords: ["weave", "agents", "copilot"],
        },
        null,
        2,
      ),
    );

    // com.github.copilot/agents/<name>.agent.md — remove stale files first
    const namespaceDir = join(this.outDir, "com.github.copilot");
    const agentsDir = join(namespaceDir, "agents");
    const agentsDirExists = await this.exists(agentsDir);
    if (!agentsDirExists) {
      await this.mkdir(agentsDir);
    } else {
      const pendingNames = new Set(
        this.pendingAgents.map((a) => `${a.name}.agent.md`),
      );
      const existing = await this.readDir(agentsDir).catch(
        () => [] as string[],
      );
      for (const file of existing) {
        if (file.endsWith(".agent.md") && !pendingNames.has(file)) {
          await this.removeFile(join(agentsDir, file));
          log.info({ file }, "Removed stale Copilot agent file");
        }
      }
    }

    const sortedAgents = [...this.pendingAgents].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const agent of sortedAgents) {
      const filePath = join(agentsDir, `${agent.name}.agent.md`);
      await this.writeFile(filePath, agent.markdown);
      log.info({ agent: agent.name, file: filePath }, "Flushed Copilot agent");
    }

    // commands/*.md — only when a "tapestry" agent was accumulated (mirror
    // claude-code adapter behavior)
    const hasTapestry = this.pendingAgents.some((a) => a.name === "tapestry");
    const commandsDir = join(namespaceDir, "commands");
    if (hasTapestry) {
      const commandsDirExists = await this.exists(commandsDir);
      if (!commandsDirExists) {
        await this.mkdir(commandsDir);
      } else {
        const commandNames = new Set(["start.md", "start-work.md"]);
        const existing = await this.readDir(commandsDir).catch(
          () => [] as string[],
        );
        for (const file of existing) {
          if (file.endsWith(".md") && !commandNames.has(file)) {
            await this.removeFile(join(commandsDir, file));
            log.info({ file }, "Removed stale Copilot command file");
          }
        }
      }
      await this.writeFile(
        join(commandsDir, "start.md"),
        COPILOT_WEAVE_START_COMMAND,
      );
      await this.writeFile(
        join(commandsDir, "start-work.md"),
        COPILOT_START_WORK_COMMAND,
      );
      log.info(
        { outDir: this.outDir },
        "Wrote command files (tapestry agent present)",
      );
    } else {
      const commandsDirExists = await this.exists(commandsDir);
      if (commandsDirExists) {
        const existing = await this.readDir(commandsDir).catch(
          () => [] as string[],
        );
        for (const file of existing) {
          if (file.endsWith(".md")) {
            await this.removeFile(join(commandsDir, file));
            log.info(
              { file },
              "Removed command file (tapestry agent not present)",
            );
          }
        }
      }
    }

    // skills/<skill-name>/SKILL.md — copy portable skills referenced by any
    // queued descriptor.
    await this.flushSkills();

    // mcp.json — only when any pending agent has non-empty mcpServers
    const mcpFilePath = join(this.outDir, "mcp.json");
    const hasMcp = this.pendingAgents.some((a) => a.mcpServers.length > 0);
    if (hasMcp) {
      const servers: Record<string, unknown> = {};
      const sortedMcpAgents = [...this.pendingAgents].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const agent of sortedMcpAgents) {
        for (const server of [...agent.mcpServers].sort()) {
          servers[server] = {};
        }
      }
      await this.writeFile(
        mcpFilePath,
        JSON.stringify({ mcpServers: servers }, null, 2),
      );
      log.info({ outDir: this.outDir }, "Wrote mcp.json");
    } else {
      const mcpFileExists = await this.exists(mcpFilePath);
      if (mcpFileExists) {
        await this.removeFile(mcpFilePath);
        log.info({ outDir: this.outDir }, "Removed stale mcp.json");
      }
    }

    log.info(
      { agents: this.pendingAgents.length, outDir: this.outDir },
      "Plugin flush complete",
    );

    this.pendingAgents.length = 0;
  }

  private async flushSkills(): Promise<void> {
    const skillsDir = join(this.outDir, "skills");

    // Discover portable skills available to this adapter and mirror them
    // under `skills/<skill-name>/SKILL.md`. Since `PendingAgent` does not
    // retain the descriptor's `skills` list, we copy all discovered skills
    // that are portable (have a readable SKILL.md) — matching the "copied
    // from loadAvailableSkills" requirement.
    const skills = await this.loadAvailableSkills();
    const skillNames = new Set(skills.map((s) => s.name));

    const skillsDirExists = await this.exists(skillsDir);
    if (!skillsDirExists && skills.length > 0) {
      await this.mkdir(skillsDir);
    }

    if (skillsDirExists) {
      const existing = await this.readDir(skillsDir).catch(
        () => [] as string[],
      );
      for (const dirName of existing) {
        if (!skillNames.has(dirName)) {
          await this.removeFile(join(skillsDir, dirName, "SKILL.md")).catch(
            () => undefined,
          );
          log.info({ skill: dirName }, "Removed stale Copilot skill");
        }
      }
    }

    const sortedSkills = [...skills].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const skill of sortedSkills) {
      const metadata = skill.metadata as { path?: string } | undefined;
      const sourcePath = metadata?.path;
      if (!sourcePath) continue;

      const content = await this.readFile(sourcePath).catch(() => undefined);
      if (content === undefined) continue;

      const targetDir = join(skillsDir, skill.name);
      const targetDirExists = await this.exists(targetDir);
      if (!targetDirExists) {
        await this.mkdir(targetDir);
      }
      await this.writeFile(join(targetDir, "SKILL.md"), content);
    }
  }
}

// ---------------------------------------------------------------------------
// Command templates (mirrors claude-code's /weave:start commands)
// ---------------------------------------------------------------------------

const COPILOT_EXECUTION_INSTRUCTIONS = `You are being activated by the /weave:start command to execute a Weave plan.

## Your Mission
Read the plan and execute it by delegating each unchecked task to weave:shuttle.
You do NOT implement work directly - you coordinate, delegate, verify, and track progress.

Execution is non-terminal while any \`- [ ]\` task remains.
Do not stop, ask what to do next, or wait for acknowledgment while unchecked tasks remain.

## Startup Procedure

1. **Resolve plan path**: The plan name is \`$ARGUMENTS\`. Read \`.weave/plans/$ARGUMENTS.md\`.
2. **Check for active work state**: Read \`.weave/state.json\` to see if there's a plan already in progress.
3. **If resuming**: Find the first unchecked \`- [ ]\` task and continue from there.
4. **If starting fresh**: Begin from the first unchecked task.

## Execution Loop

For each unchecked \`- [ ]\` task in the plan, read it, delegate it to weave:shuttle, verify the result, mark it complete, and continue immediately to the next unchecked task without waiting for acknowledgment.`;

const COPILOT_WEAVE_START_COMMAND = `---
description: "Execute a Weave plan by delegating tasks to weave:shuttle"
argument-hint: "[plan-name]"
---

${COPILOT_EXECUTION_INSTRUCTIONS}`;

const COPILOT_START_WORK_COMMAND = `---
description: "Execute a Weave plan (legacy alias for weave:start)"
argument-hint: "[plan-name]"
---

${COPILOT_EXECUTION_INSTRUCTIONS}`;

// ---------------------------------------------------------------------------
// Own package.json version reader
// ---------------------------------------------------------------------------

async function readOwnPackageJson(): Promise<{ version: string }> {
  const path = join(import.meta.dir, "..", "package.json");
  const text = await Bun.file(path).text();
  const parsed = JSON.parse(text) as { version?: string };
  return { version: parsed.version ?? "0.0.0" };
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
