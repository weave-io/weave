/**
 * `weave compose` — drives a Weave adapter end-to-end.
 *
 * Loads the merged config, materialises all agent descriptors, then
 * pushes them through the selected adapter (currently only "claude-code").
 */

import { join, relative } from "node:path";
import {
  BOOTSTRAP_FILES,
  ClaudeCodeAdapter,
  getBootstrapDir,
} from "@weaveio/weave-adapter-claude-code";
import { loadConfig } from "@weaveio/weave-config";
import { formatError } from "@weaveio/weave-core";
import { logger, materializeAgents } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { type CliError, formatCliError } from "../errors.js";
import {
  BunFileSystem,
  type FileSystem,
  toConfigFileReader,
} from "../fs/file-system.js";
import type { TerminalIO } from "../io/terminal.js";
import type { ThemeColors } from "../theme/colors.js";

const log = logger.child({ module: "cli-compose" });

const SUPPORTED_ADAPTERS = ["claude-code"] as const;
type SupportedAdapter = (typeof SUPPORTED_ADAPTERS)[number];

export interface ComposeContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  /**
   * Filesystem used for config discovery, the bootstrap copy and every file
   * the adapter writes. Defaults to the real one. Black-box CLI tests inject a
   * `MemoryFileSystem` so `weave compose` can be driven without touching disk.
   */
  fs?: FileSystem;
}

function isSupportedAdapter(value: string): value is SupportedAdapter {
  return (SUPPORTED_ADAPTERS as readonly string[]).includes(value);
}

/**
 * Copies the adapter bootstrap plugin files into the project.
 * Returns `true` if files were written, `false` if the dir already existed (skipped).
 */
async function runBootstrapInit(
  destDir: string,
  terminal: TerminalIO,
  theme: ThemeColors,
  fs: FileSystem,
): Promise<Result<boolean, CliError>> {
  const srcDir = getBootstrapDir();

  // Check whether destination already exists
  const existsResult = await fs.exists(join(destDir, BOOTSTRAP_FILES[0]));
  const existsCheck = existsResult.isOk() && existsResult.value;
  if (existsCheck) {
    terminal.stdout(
      `  ${theme.boldYellow("Bootstrap already exists:")} ${theme.dim(destDir)} — skipping init.\n`,
    );
    return ok(false);
  }

  // Copy each bootstrap file
  for (const relPath of BOOTSTRAP_FILES) {
    const src = join(srcDir, relPath);
    const dest = join(destDir, relPath);

    const read = await fs.readText(src);
    if (read.isErr()) {
      return err({
        type: "FileReadError",
        path: src,
        cause: read.error,
        message: `Could not read bootstrap source file: ${src}`,
      });
    }
    const written = await fs.writeText(dest, read.value);
    if (written.isErr()) {
      return err({
        type: "FileWriteError",
        path: dest,
        cause: written.error,
        message: `Could not write bootstrap file: ${dest}`,
      });
    }
  }

  const rel = `./${relative(fs.cwd(), destDir)}`;

  terminal.stdout(
    [
      "",
      `  ${theme.boldCyan("✓")} Bootstrap plugin created at: ${theme.cyan(rel)}`,
      "",
      `  To use with Claude Code, launch:`,
      `    ${theme.dim("claude --plugin-dir")} ${theme.cyan(rel)} ${theme.dim("--plugin-dir")} ${theme.cyan(".weave/plugins/claude-code")}`,
      "",
      `  On the first session, run ${theme.cyan("/reload-plugins")} to load the generated agents.`,
      `  Add ${theme.dim(".weave/plugins/")} to your ${theme.dim(".gitignore")}.`,
      "",
    ].join("\n"),
  );

  return ok(true);
}

export async function runCompose(
  ctx: ComposeContext,
): Promise<Result<number, CliError>> {
  const { terminal, theme, flags } = ctx;
  const fs = ctx.fs ?? new BunFileSystem();

  // --adapter is required
  const adapterName = flags.adapter;
  if (!adapterName) {
    terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message:
          "--adapter is required. Supported adapters: " +
          SUPPORTED_ADAPTERS.join(", "),
      }),
    );
    return ok(1);
  }

  if (!isSupportedAdapter(adapterName)) {
    terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: `Unknown adapter "${adapterName}". Supported adapters: ${SUPPORTED_ADAPTERS.join(", ")}`,
      }),
    );
    return ok(1);
  }

  const projectRoot = flags.projectRoot
    ? fs.resolvePath(flags.projectRoot)
    : fs.cwd();

  log.info({ projectRoot, adapter: adapterName }, "Starting compose");

  // --init: copy bootstrap plugin files before running compose
  if (flags.init === true) {
    const bootstrapDest = flags.bootstrapDir
      ? fs.resolvePath(flags.bootstrapDir)
      : fs.resolvePath(join(projectRoot, "weave-bootstrap-plugin"));

    const initResult = await runBootstrapInit(
      bootstrapDest,
      terminal,
      theme,
      fs,
    );
    if (initResult.isErr()) {
      terminal.stderr(formatCliError(initResult.error));
      return ok(1);
    }
  }

  // 1. Load config
  const configResult = await loadConfig(
    projectRoot,
    toConfigFileReader(fs),
  ).mapErr(
    (errors): CliError => ({
      type: "ParseFailure",
      path: projectRoot,
      errors: errors.flatMap((error) => {
        if (error.type === "FileReadError")
          return [`${error.path}: could not read config`];
        if (error.type === "BuiltinParseError")
          return error.errors.map((e) => `builtins:${formatError(e)}`);
        if (error.type === "MergeError")
          return error.errors.flatMap((e) =>
            e.type === "ConfigValidationError"
              ? e.errors.map(
                  (issue) => `merge:${e.layer}:${formatError(issue)}`,
                )
              : [`merge:${e.type}:${e.error.type}`],
          );
        return error.errors.map((e) => `${error.path}:${formatError(e)}`);
      }),
    }),
  );

  if (configResult.isErr()) {
    terminal.stderr(formatCliError(configResult.error));
    return ok(1);
  }

  const config = configResult.value;
  log.info({ agents: Object.keys(config.agents).length }, "Config loaded");

  // 2. Materialise agents
  const plan = await materializeAgents({ config });
  if (plan.isErr()) {
    // materializeAgents returns ResultAsync<_, never> — this branch is unreachable
    // but TypeScript doesn't know that; satisfy the exhaustive check.
    terminal.stderr("Unexpected materialization failure");
    return ok(1);
  }

  const { agents, errors: matErrors } = plan.value;

  if (matErrors.length > 0) {
    for (const e of matErrors) {
      if (e.type === "CategoryShuttleConflict") {
        terminal.stderr(`Warning: ${e.conflict.message}`);
      } else if (e.type === "ReviewVariantConflict") {
        terminal.stderr(`Warning: ${e.conflict.message}`);
      } else {
        terminal.stderr(
          `Warning: Failed to compose agent "${e.agentName}": ${e.cause.type}`,
        );
      }
    }
  }

  log.info({ count: agents.length }, "Agents materialised");

  // 3. Instantiate adapter
  const adapter = new ClaudeCodeAdapter({
    projectRoot,
    homeDir: fs.home(),
    outDir: flags.outDir ? fs.resolvePath(flags.outDir) : undefined,
    exists: async (path) => {
      const result = await fs.exists(path);
      return result.isOk() && result.value;
    },
    readFile: async (path) => {
      const result = await fs.readText(path);
      if (result.isErr()) throw new Error(`Could not read ${path}`);
      return result.value;
    },
    writeFile: async (path, content) => {
      const result = await fs.writeText(path, content);
      if (result.isErr()) throw new Error(`Could not write ${path}`);
    },
    mkdir: async (path) => {
      await fs.mkdir(path);
    },
  });

  // 4. init()
  await adapter.init();
  log.info("Adapter initialised");

  // 5. spawnSubagent for each materialised agent
  const spawnErrors: string[] = [];
  for (const { agentName, descriptor } of agents) {
    const spawnResult = await adapter.spawnSubagent(descriptor);
    if (spawnResult.isErr()) {
      spawnErrors.push(
        `Failed to queue agent "${agentName}": ${spawnResult.error.message}`,
      );
    }
  }

  if (spawnErrors.length > 0) {
    for (const msg of spawnErrors) {
      terminal.stderr(`Warning: ${msg}`);
    }
  }

  // 6. flush()
  const flushResult = await adapter.flush();
  if (flushResult.isErr()) {
    terminal.stderr(
      formatCliError({
        type: "InvalidArgs",
        message: `Adapter flush failed: ${flushResult.error.message}`,
      }),
    );
    return ok(1);
  }

  // 7. Report success
  const outDir =
    flags.outDir ?? join(projectRoot, ".weave", "plugins", "claude-code");

  const successLines = [
    "",
    `  ${theme.bold("weave compose")} ${theme.dim("—")} ${theme.boldCyan("claude-code")}`,
    "",
    `  ${theme.dim("Agents materialised:")} ${theme.cyan(String(agents.length))}`,
    `  ${theme.dim("Output directory:   ")} ${theme.cyan(outDir)}`,
    "",
    matErrors.length > 0
      ? `  ${theme.boldYellow("Warnings:")} ${matErrors.length} agent(s) skipped — see above.`
      : `  ${theme.dim("Status:")} ${theme.boldCyan("OK")}`,
    "",
  ];

  terminal.stdout(successLines.join("\n"));
  return ok(0);
}
