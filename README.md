# Weave

> Harness-agnostic prompt and agent-configuration API

Weave lets you describe agents, prompts, categories, model preferences, skills,
tool policy, and workflows in a `.weave` file. An adapter translates that
intent into one supported coding-agent harness. The harness still owns its
native UI, models, tools, and execution behavior.

Public user documentation: <https://tryweave.io/docs/quickstart/>.

## Public packages and channels

Weave publishes four public packages. Each package uses the same three release
channels: `latest` (stable), `next`, and `nightly`.

| Package | Purpose |
| --- | --- |
| [`@weaveio/weave-cli`](./packages/cli/README.md) | The `weave` command for setup, validation, inspection, evals, and Claude Code composition. |
| [`@weaveio/weave-adapter-opencode`](./packages/adapters/opencode/README.md) | The OpenCode plugin and adapter library. |
| [`@weaveio/weave-adapter-claude-code`](./packages/adapters/claude-code/README.md) | The standalone Claude Code file-materialization adapter. |
| [`@weaveio/weave-adapter-pi`](./packages/adapters/pi/README.md) | The shipped Pi extension and adapter library. |

`@weaveio/weave-core`, `@weaveio/weave-config`, and
`@weaveio/weave-engine` are private workspace layers. Public builds bundle
them; consumers do not install them directly.

## Requirements

- Bun 1.1 or newer for the CLI and local development.
- OpenCode, Claude Code, or Pi for the harness-specific integrations.
- Pi `>=0.81.1` for the Pi adapter. The adapter has no maximum Pi version; the
  current release proof covers Pi 0.84.2.

Node.js is not supported for running the repository or the CLI.

## Install and choose a harness

### CLI and Claude Code

Install the stable CLI globally:

```bash
bun add --global @weaveio/weave-cli@latest
weave --version
```

For a one-off invocation, use:

```bash
bunx @weaveio/weave-cli@latest --help
```

Create a project configuration and compose Claude Code files:

```bash
weave init --scope local --yes
weave compose --adapter claude-code --init
claude --plugin-dir ./weave-bootstrap-plugin --plugin-dir ./.weave/plugins/claude-code
```

Claude Code support is file materialization. The generated files provide
agents, prompts, model aliases, tool lists, category shuttles, and the
`/weave:start` plan-entry command. They do not provide a durable workflow
runtime. See [the Claude Code adapter guide](./docs/adapters/claude-code.md).

### OpenCode

Add the published adapter package to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": [
    "@weaveio/weave-adapter-opencode@<exact-version>"
  ]
}
```

The package name is the canonical OpenCode plugin spec. OpenCode resolves the
package's `server` export; do not point the plugin entry at `dist/index.js` or a
local source file. Use an exact version for reproducible installs. Select `latest`, `next`, or `nightly` instead when you explicitly
want a channel tag. Restart OpenCode after changing the plugin version.

Verify the plugin with:

```bash
opencode debug config
opencode debug info
```

See [the OpenCode adapter guide](./docs/adapters/opencode.md) and the
[standalone package README](./packages/adapters/opencode/README.md).

### Pi

Install the shipped extension from the channel you want:

```bash
pi install npm:@weaveio/weave-adapter-pi@latest
```

Use `@next` or `@nightly` in place of `@latest` to select another channel.
Start Pi in a trusted project containing `.weave/config.weave`. The extension
checks the host, configuration, and required capabilities before it activates.
It exposes health and diagnostics in health-only mode when a required check
fails; it does not guess or start work in that mode.

See [the Pi adapter guide](./docs/adapters/pi.md) and the
[standalone package README](./packages/adapters/pi/README.md).

## CLI at a glance

```text
weave init
weave prompt inspect <agent>
weave prompt list
weave prompt self-modify
weave validate
weave runtime status
weave runtime journal
weave adapter pi …
weave eval run
```

Run `weave --help` for the installed command list. The full reference is
[`docs/reference/cli.md`](./docs/reference/cli.md).

## Repository development

```bash
bun install
bun run typecheck
bun test
bun run docs:check-links
bun run docs:dev
```

See [`packages/docs/README.md`](./packages/docs/README.md) for the public docs
site and [`docs/contributing/documentation.md`](./docs/contributing/documentation.md)
for documentation conventions.

## License

MIT
