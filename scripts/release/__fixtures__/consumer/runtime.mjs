import { strict as assert } from "node:assert";

const cli = await import("@weaveio/weave-cli");
const openCode = await import("@weaveio/weave-adapter-opencode");
const plugin = await import("@weaveio/weave-adapter-opencode/plugin");
const server = await import("@weaveio/weave-adapter-opencode/server");
const claude = await import("@weaveio/weave-adapter-claude-code");

assert.equal(typeof cli.parseArgs, "function");
assert.equal(typeof openCode.OpenCodeAdapter, "function");
assert.equal(typeof plugin.default, "function");
assert.equal(typeof server.default, "function");
assert.equal(typeof claude.ClaudeCodeAdapter, "function");
