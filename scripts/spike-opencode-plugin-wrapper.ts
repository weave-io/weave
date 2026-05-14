// Weave spike plugin wrapper for OpenCode
//
// Wraps the spike-opencode-plugin entry point in the OpenCode plugin format
// (exports { server: Plugin } where Plugin = (input) => Promise<Hooks>).
//
// This file is bundled into .opencode/plugins/weave.js by:
//   bun run spike:opencode
//
// OpenCode auto-discovers .opencode/plugins/*.js on startup.

import loadSpikeOpenCodePlugin from "./spike-opencode-plugin";

export const server = async (_input: unknown) => {
  return await loadSpikeOpenCodePlugin();
};
