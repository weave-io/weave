import { strict as assert } from "node:assert";

const cli = await import("@weaveio/weave-cli");
const openCode = await import("@weaveio/weave-adapter-opencode");
const plugin = await import("@weaveio/weave-adapter-opencode/plugin");
const server = await import("@weaveio/weave-adapter-opencode/server");
const claude = await import("@weaveio/weave-adapter-claude-code");

assert.equal(cli.parseArgs instanceof Function, true);
assert.equal(openCode.OpenCodeAdapter instanceof Function, true);
assert.equal(plugin.default instanceof Function, true);
assert.equal(server.default instanceof Function, true);
assert.equal(claude.ClaudeCodeAdapter instanceof Function, true);
