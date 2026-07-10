/**
 * `weave compose` — drives a Weave adapter end-to-end.
 *
 * Loads the merged config, materialises all agent descriptors, then
 * pushes them through the selected adapter (currently only "claude-code").
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "@weaveio/weave-config";
import { formatError } from "@weaveio/weave-core";
import { materializeAgents } from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { ClaudeCodeAdapter, getBootstrapDir, BOOTSTRAP_FILES } from "@weaveio/weave-adapter-claude-code";
import { ok, type Result, ResultAsync } from "neverthrow";
import type { ParsedArgs } from "../args.js";
import { type CliError, formatCliError } from "../errors.js";
import type { TerminalIO } from "../io/terminal.js";
import type { ThemeColors } from "../theme/colors.js";

const log = logger.child({ module: "cli-compose" });

const SUPPORTED_ADAPTERS = ["claude-code"] as const;
type SupportedAdapter = (typeof SUPPORTED_ADAPTERS)[number];

export interface ComposeContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
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
): Promise<Result<boolean, CliError>> {
  const srcDir = getBootstrapDir();

  // Check whether destination already exists
  const existsCheck = await Bun.file(join(destDir, BOOTSTRAP_FILES[0])).exists();
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

    const text = await Bun.file(src).text().catch(() => null);
    if (text === null) {
      return ok(false); // best-effort; missing source files are rare
    }
    await Bun.write(dest, text);
  }

  const rel = `./${destDir.replace(process.cwd() + "/", "").replace(process.cwd() + "\\", "")}`;

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
    ? resolve(flags.projectRoot)
    : process.cwd();

  log.info({ projectRoot, adapter: adapterName }, "Starting compose");

  // --init: copy bootstrap plugin files before running compose
  if (flags.init === true) {
    const bootstrapDest = flags.bootstrapDir
      ? resolve(flags.bootstrapDir)
      : resolve(projectRoot, "weave-bootstrap-plugin");

    const initResult = await runBootstrapInit(bootstrapDest, terminal, theme);
    if (initResult.isErr()) {
      terminal.stderr(formatCliError(initResult.error));
      return ok(1);
    }
  }

  // 1. Load config
  const configResult = await loadConfig(projectRoot).mapErr(
    (errors): CliError => ({
      type: "ParseFailure",
      path: projectRoot,
      errors: errors.flatMap((error) => {
        if (error.type === "FileReadError")
          return [`${error.path}: could not read config`];
        if (error.type === "BuiltinParseError")
          return error.errors.map((e) => `builtins:${formatError(e)}`);
        if (error.type === "MergeError")
          return error.errors.map((e) => `merge:${e.type}:${e.error.type}`);
        return error.errors.map((e) => `${error.path}:${formatError(e)}`);
      }),
    }),
  );

  if (configResult.isErr()) {
    terminal.stderr(formatCliError(configResult.error));
    return ok(1);
  }

  const config = configResult.value;
  log.info(
    { agents: Object.keys(config.agents).length },
    "Config loaded",
  );

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
    homeDir: homedir(),
    outDir: flags.outDir ? resolve(flags.outDir) : undefined,
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
    flags.outDir ??
    join(projectRoot, ".weave", "plugins", "claude-code");

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
