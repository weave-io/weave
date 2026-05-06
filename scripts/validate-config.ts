/**
 * validate-config — parse and validate .weave/config.weave
 *
 * Reads the project config, runs it through the full parseConfig() pipeline,
 * and prints a summary on success or formatted errors on failure.
 *
 * Exit codes:
 *   0 — config is valid
 *   1 — config not found, unreadable, or contains errors
 */

import type { WeaveConfig } from "@weave/core";
import { formatError, parseConfig } from "@weave/core";

const CONFIG_PATH = ".weave/config.weave";

async function main(): Promise<void> {
  const file = Bun.file(CONFIG_PATH);

  if (!(await file.exists())) {
    console.error(`✗ Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const source = await file.text();

  parseConfig(source).match(
    (config) => printSummary(config),
    (errors) => {
      console.error(`\n✗ ${CONFIG_PATH} — ${errors.length} error(s):\n`);
      for (const error of errors) {
        console.error(`  ${formatError(error)}`);
      }
      process.exit(1);
    },
  );
}

function printSummary(config: WeaveConfig): void {
  const agents = Object.keys(config.agents);
  const categories = Object.keys(config.categories);
  const disabledAgents = config.disabled.agents;
  const disabledHooks = config.disabled.hooks;
  const disabledSkills = config.disabled.skills;

  console.log(`✓ ${CONFIG_PATH}\n`);
  console.log(`  agents     (${agents.length}): ${agents.join(", ")}`);
  console.log(`  categories (${categories.length}): ${categories.join(", ")}`);

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

main();
