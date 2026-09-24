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

`@weaveio/weave-adapter-opencode2` (`packages/adapters/opencode2/`) is an
independent, currently-private OpenCode V2 adapter package — it shares no
code with `@weaveio/weave-adapter-opencode` and does not replace or sunset
it. See [Spec 34](docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md),
[ADR 0010](docs/adr/0010-opencode2-independent-adapter.md), and
[`docs/opencode2-adapter.md`](docs/opencode2-adapter.md).

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

## Development

```bash
bun install
bun run typecheck
bun test
bun run docs:check-links
bun run docs:dev
```

### Dogfooding a local build

To run your checkout (or a worktree) in a real harness, build the public
packages the same way a release does. Each package's `dist/` is written in
place:

```bash
bun scripts/build-public-packages.ts
```

Run the CLI straight from source, so CLI changes need no rebuild. It prints
version `0.0.1` because the version is only stamped in at build time:

```bash
alias weave-dev="bun $HOME/source/weave/packages/cli/src/main.ts"
weave-dev validate
```

Use `weave-dev` rather than an installed `weave` while dogfooding, so config
checks and migrations use your code too.

#### OpenCode

Point OpenCode at the built plugin file. In `~/.config/opencode/opencode.json`,
**replace** any existing Weave entry (`@weaveio/weave-adapter-opencode@…` or
the legacy `@opencode_weave/weave`):

```json
{
  "plugin": [
    "file:///absolute/path/to/weave/packages/adapters/opencode/dist/plugin.js"
  ]
}
```

OpenCode appends the `plugin` lists from the global config, the project config,
and `OPENCODE_CONFIG_CONTENT`. If a published Weave entry remains in any of them,
both adapters load. Check that a project's own `opencode.json` doesn't list one.

Restart OpenCode after each rebuild, then confirm what loaded:

```bash
opencode debug config | jq '.plugin, (.agent | keys)'
```

The adapter logs to `.weave/weave.log` in the project. To iterate on the
adapter alone, this targeted build takes about a second instead of rebuilding
every package:

```bash
cd packages/adapters/opencode
bun build ./src/index.ts ./src/plugin.ts --outdir ./dist --target bun \
  --external @opencode-ai/plugin --external @opencode-ai/sdk \
  --external mustache --external neverthrow --external zod
```

While this entry is in your global config, every OpenCode session uses your
build. Put the published entry back to return to a release.

#### OpenCode 2

The adapter targets exactly one OpenCode 2 host. Install that version:

```bash
bun add --global --trust @opencode/cli@2.0.16
opencode --version
```

OpenCode 2 reads the plural `plugins` field, which OpenCode 1 ignores, so it
can live in the same `opencode.json`. Point it at the package directory; the
root `server.js`, `rpc.js`, and `tui.js` wrappers load the built `dist/`.
Replace any `@weaveio/weave-adapter-opencode2@…` entry:

```json
{
  "plugins": ["/absolute/path/to/weave/packages/adapters/opencode2"]
}
```

OpenCode 2 runs a background service, so restart it after each rebuild, then
list the agents:

```bash
opencode2 service restart
opencode2 debug agents
```

Weave agents show `[weave-managed]` in their description. OpenCode 2 omits an
agent whose declared models aren't in its catalog. The builtins declare the
bare `claude-sonnet-4-5`, so if Loom is missing, pin it to a model that
`opencode2 models` lists:

```weave
agent loom {
  models ["provider/model"]
}
```

#### Claude Code

The CLI bundles the Claude Code adapter, so running the CLI from source is
the dev build. From your project:

```bash
weave-dev compose --adapter claude-code
claude --plugin-dir .weave/plugins/claude-code
```

After you change Weave code or config, run `compose` again, then
`/reload-plugins` in Claude Code.

Leave out `--init` and the bootstrap plugin it creates. Its session-start hook
runs `bun run weave compose`, which uses whichever `weave` is installed. That
would regenerate the plugin with the published CLI and overwrite your build.

#### Pi

The Pi adapter's source isn't in this repository; it's developed and released
separately (see [`RELEASING.md`](./RELEASING.md)). To dogfood a local Pi
adapter, build it in that repository, then load it for one session:

```bash
WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1 \
  pi --no-extensions -e /absolute/path/to/weave-adapter-pi/dist/extension.js
```

`--no-extensions` stops Pi from also loading an installed
`@weaveio/weave-adapter-pi` (and any other installed extension). The variable
lets a local, top-level extension register `/weave:*` commands without npm
package provenance ([details](./docs/adapters/pi.md)). Use `pi install
/absolute/path/to/weave-adapter-pi` instead to keep it installed across
sessions.

### Documentation

The public docs at [tryweave.io/docs](https://tryweave.io/docs/) are
maintained in [pgermishuys/weave-website](https://github.com/pgermishuys/weave-website);
update them when a change affects user-visible behavior. `packages/docs` is an
unpublished contributor reference (see its
[README](./packages/docs/README.md)), and
[`docs/documentation-policy.md`](./docs/documentation-policy.md) covers
documentation conventions.

## License

MIT
