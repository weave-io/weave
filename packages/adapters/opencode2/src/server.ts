/**
 * `./server` subpath entry point.
 *
 * The real V2 plugin loader requires the plugin entry to be a DIRECTORY
 * containing `server.ts` or `index.ts` (A2 finding) — this module
 * re-exports the `Plugin.define` default from `./v2/plugin.js` so the
 * package's `./server` export (mapped to `dist/server.js`) satisfies that
 * loader contract.
 */

export { OpenCode2Adapter } from "./adapter.js";
export type { OpenCode2AdapterError } from "./errors.js";
export { WEAVE_OWNERSHIP_MARKER } from "./translate-agent.js";
export { default, server, WeavePlugin } from "./v2/plugin.js";
