import { join } from "node:path";

/** Returns the absolute path to the bootstrap plugin directory. */
export function getBootstrapDir(): string {
  return join(import.meta.dir, "bootstrap");
}

/** Relative file paths within the bootstrap plugin. */
export const BOOTSTRAP_FILES = [
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/compose/SKILL.md",
] as const;
