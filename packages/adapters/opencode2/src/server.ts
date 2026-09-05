/**
 * `./server` subpath entry point.
 *
 * The real V2 plugin loader requires the plugin entry to be a DIRECTORY
 * containing `server.ts` or `index.ts` (A2 finding) — this module
 * re-exports the `Plugin.define` default from `./plugin.js` so the
 * package's `./server` export (mapped to `dist/server.js`) satisfies that
 * loader contract.
 */

export { OpenCode2Adapter } from "./adapter.js";
export type { OpenCode2AdapterError } from "./errors.js";
export { default } from "./plugin.js";
export { WEAVE_OWNERSHIP_MARKER } from "./translate-agent.js";
