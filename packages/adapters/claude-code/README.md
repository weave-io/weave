# @weaveio/weave-adapter-claude-code

The Weave adapter that materializes normalized configuration as a Claude Code
plugin directory. The stable user-facing path is the adapter bundled in
`@weaveio/weave-cli`; this standalone package is also published on `latest`,
`next`, and `nightly` for integrations that need the adapter library directly.

## Install

For the supported CLI path:

```bash
bun add --global @weaveio/weave-cli@latest
weave compose --adapter claude-code --init
```

For an integration that imports the adapter directly:

```bash
bun add @weaveio/weave-adapter-claude-code@latest
```

Use `@next` or `@nightly` instead of `@latest` to select another channel.
The package does not provide a standalone `claude` executable.

## Minimal use

From a project with a valid `.weave/config.weave`, compose the generated
plugin and load it in Claude Code:

```bash
weave compose --adapter claude-code --init
claude --plugin-dir ./weave-bootstrap-plugin --plugin-dir ./.weave/plugins/claude-code
```

The adapter writes agent markdown, model and tool metadata, and the
`/weave:start` plan-entry command with `/start-work` as a compatibility alias.
It does not provide a durable workflow runtime, idle continuation, or
provider acceleration. Reload Claude Code after generated files change.

## Supported host versions

| Host | Support |
| --- | --- |
| Claude Code | No version range is enforced by this static file-materialization adapter. The host must support plugin directories, agent files, and the generated command files. |
| Bun | Required for repository development and local builds. |

## Documentation

See the [Claude Code adapter reference](https://tryweave.io/docs/reference/adapters/claude-code/)
for generated files, commands, and capability limits.

## License

MIT
