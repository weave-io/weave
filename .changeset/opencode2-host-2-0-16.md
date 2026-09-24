---
"@weaveio/weave-adapter-opencode2": minor
---

Target OpenCode `2.0.16` (`@opencode/cli`) instead of the `0.0.0-beta-19151` pin.

OpenCode renamed its packages to the `@opencode/*` scope and, from 2.0.4, removed the `ctx.catalog` plugin domain in favour of `ctx.model` and `ctx.provider`. On 2.0.4+ the previous release activated but silently registered no agents and no `/weave:start` command: `ctx.catalog.model.list()` threw before the catalog was built and the warning only reached the plugin's stdout. The adapter now reads models through `ctx.model.list()`, listens for `model.updated` instead of `catalog.updated`, applies temperature through the session context `options` field, and no longer expects a `workspaceID` on session location refs.

The Podman verify harness is ported to the same host: plugin activation is observed through `plugin.list()` state, the layer-5 fixture no longer inherits a duplicate plugin entry from an ancestor config, the proof model context limit is raised so runs do not trip automatic compaction, the image check accepts the V2 `opencode` binary, and the standalone cleanup marker is reported rather than asserted because the 2.0.x CLI terminates its standalone server before plugin cleanup runs.
