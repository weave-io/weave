/**
 * validate-config — parse and validate a .weave config file
 *
 * Usage:
 *   bun run validate-config                          # validates .weave/config.weave
 *   bun run validate-config path/to/other.weave      # validates a custom path
 *
 * Exit codes:
 *   0 — config is valid
 *   1 — config not found, unreadable, or contains errors
 */

import type { WeaveConfig } from "@weave/core";
import { formatError, parseConfig } from "@weave/core";

const DEFAULT_CONFIG_PATH = ".weave/config.weave";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    console.error(`✗ Config not found: ${configPath}`);
    process.exit(1);
  }

  const source = await file.text();

  parseConfig(source).match(
    (config) => printSummary(config, configPath),
    (errors) => {
      console.error(`\n✗ ${configPath} — ${errors.length} error(s):\n`);
      for (const error of errors) {
        console.error(`  ${formatError(error)}`);
      }
      process.exit(1);
    },
  );
}

export function printSummary(
  config: WeaveConfig,
  configPath = DEFAULT_CONFIG_PATH,
): void {
  const agents = Object.keys(config.agents);
  const categories = Object.keys(config.categories);
  const workflows = Object.entries(config.workflows);
  const disabledAgents = config.disabled.agents;
  const disabledHooks = config.disabled.hooks;
  const disabledSkills = config.disabled.skills;

  console.log(`✓ ${configPath}\n`);
  console.log(`  agents     (${agents.length}): ${agents.join(", ")}`);
  console.log(`  categories (${categories.length}): ${categories.join(", ")}`);

  if (workflows.length > 0) {
    const names = workflows
      .map(([name, wf]) => {
        const n = wf.steps.length;
        return `${name} [${n} ${n === 1 ? "step" : "steps"}]`;
      })
      .join(", ");
    console.log(`  workflows  (${workflows.length}): ${names}`);
  }

  const disabledAll = [...disabledAgents, ...disabledHooks, ...disabledSkills];
  if (disabledAll.length > 0) {
    console.log(
      `  disabled   (${disabledAll.length}): ${disabledAll.join(", ")}`,
    );
  }

  if (config.log_level) {
    console.log(`  log_level: ${config.log_level}`);
  }
}

if (import.meta.main) {
  main();
}
