#!/usr/bin/env bun
/**
 * Generate a Copilot Agent Plugins 1.0 bundle from the current Weave config.
 *
 * Loads builtin + project config via `@weaveio/weave-config`, materializes
 * all agent descriptors via `@weaveio/weave-engine`, and runs the
 * `CopilotAdapter` against them with real filesystem I/O.
 *
 * Default output: <projectRoot>/.weave/plugins/copilot/
 * Override with: --out-dir <path>
 *
 * Usage:
 *   bun run packages/adapters/copilot/scripts/generate-bundle.ts
 *   bun run packages/adapters/copilot/scripts/generate-bundle.ts --out-dir /tmp/my-bundle
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

import { loadConfig } from "@weaveio/weave-config";
import { logger, materializeAgents } from "@weaveio/weave-engine";

import { CopilotAdapter } from "../src/adapter.js";

const log = logger.child({ module: "generate-bundle" });

function parseArgs(argv: string[]): { outDir?: string } {
  const args: { outDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir" && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main(): Promise<number> {
  const projectRoot = process.cwd();
  const { outDir: outDirOverride } = parseArgs(process.argv.slice(2));
  const outDir =
    outDirOverride !== undefined
      ? resolve(projectRoot, outDirOverride)
      : resolve(projectRoot, ".weave/plugins/copilot");

  log.info({ projectRoot, outDir }, "Starting bundle generation");

  // Step 1: Load merged config (builtins + global + project).
  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) {
    log.error({ errors: configResult.error }, "Failed to load config");
    return 1;
  }
  const config = configResult.value;

  // Step 2: Materialize all agent descriptors.
  const planResult = await materializeAgents({ config });
  if (planResult.isErr()) {
    log.error({ err: planResult.error }, "Materialization failed");
    return 1;
  }
  const plan = planResult.value;
  if (plan.errors.length > 0) {
    log.warn(
      { errors: plan.errors },
      "Per-agent errors during materialization",
    );
  }
  log.info(
    { count: plan.agents.length, agents: plan.agents.map((a) => a.agentName) },
    "Materialized agents",
  );

  // Step 3: Run the adapter.
  const adapter = new CopilotAdapter({
    projectRoot,
    homeDir: homedir(),
    outDir,
  });

  await adapter.init();

  for (const { descriptor } of plan.agents) {
    const r = await adapter.spawnSubagent(descriptor);
    if (r.isErr()) {
      log.error(
        { agent: descriptor.name, err: r.error },
        "spawnSubagent failed",
      );
      return 1;
    }
  }

  const flushResult = await adapter.flush();
  if (flushResult.isErr()) {
    log.error({ err: flushResult.error }, "flush failed");
    return 1;
  }

  log.info(
    { outDir },
    `Bundle written. Install: copilot plugin install ${outDir}`,
  );
  return 0;
}

const code = await main();
process.exit(code);
