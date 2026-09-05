/**
 * Public barrel for `@weaveio/weave-adapter-opencode2`.
 *
 * The `Plugin.define` entry point itself is intentionally NOT re-exported
 * here — see `./server.ts` for the `./server` subpath export that the real
 * V2 plugin loader requires (A2 finding: plugin entry must be a directory
 * containing `server.ts` or `index.ts`).
 */

export type {
  OpenCode2AdapterHarnessError,
  OpenCode2AdapterOptions,
} from "./adapter.js";
export { OpenCode2Adapter } from "./adapter.js";
export type { OpenCode2AdapterError } from "./errors.js";
