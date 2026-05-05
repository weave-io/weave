import type { WeaveConfig } from "./config.js";

/**
 * Identity helper that accepts a `WeaveConfig` object and returns it
 * unchanged.
 *
 * The primary purpose of this function is to provide full TypeScript type
 * inference and IDE auto-completion when authoring a `weave.config.ts` file.
 * It has zero runtime overhead.
 *
 * @example
 * ```ts
 * // weave.config.ts
 * import { defineConfig } from "@weave/core";
 *
 * export default defineConfig({
 *   agents: {
 *     coder: {
 *       name: "coder",
 *       model: "claude-sonnet-4-5",
 *       temperature: 0.2,
 *       tools: ["read", "edit", "bash"],
 *       skills: ["tdd"],
 *     },
 *   },
 *   hooks: [{ name: "on-task-start", enabled: true }],
 *   skills: [{ name: "tdd", path: "./skills/tdd", scope: "project" }],
 * });
 * ```
 */
export function defineConfig(config: WeaveConfig): WeaveConfig {
	return config;
}
