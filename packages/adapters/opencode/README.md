# @weaveio/weave-adapter-opencode

The Weave adapter for OpenCode. It loads `.weave/config.weave`, materializes
Weave agents into OpenCode, and exposes the adapter's OpenCode commands and
runtime hooks.

## Install

Add the package name to the `plugin` array in `opencode.json` or
`opencode.jsonc`:

```json
{
  "plugin": [
    "@weaveio/weave-adapter-opencode@<exact-version>"
  ]
}
```

The package name is the canonical OpenCode plugin spec. OpenCode resolves the
package's `server` export to the plugin entry point. Use an exact version for
reproducible installs. Replace it with `latest`, `next`, or `nightly` when you
want npm to resolve a channel tag.

There is no separate `npm install` step for the OpenCode plugin. OpenCode
fetches the package at startup. Restart OpenCode after changing the plugin
version.

## Minimal use

Create and validate a Weave project, then start OpenCode:

```bash
bun add --global @weaveio/weave-cli@latest
weave init --scope local --yes
weave validate --project
opencode
```

The plugin maps normalized agents, prompts, model preferences, skills, and
supported tool policy into OpenCode. It provides `/weave:start` and the
`/start-work` compatibility alias. It does not claim provider acceleration:
`fast true` remains unsupported on OpenCode because the plugin has no
correlated response evidence for the same request.

Verify loading with OpenCode's diagnostics:

```bash
opencode debug config
opencode debug info
```

## Local development

To try a change in OpenCode, run the dev launcher from the project you want to
test in:

```bash
~/source/weave/scripts/dev/opencode              # build, then start the TUI
~/source/weave/scripts/dev/opencode debug config # check which plugin and agents load
~/source/weave/scripts/dev/weave validate        # the CLI, run from source
```

`scripts/dev/opencode` builds `dist/plugin.js` from the checkout it lives in,
then starts OpenCode with that build in place of any Weave plugin in your
global OpenCode config: the published adapter, the legacy
`@opencode_weave/weave`, or an older `file://` build. It does this through a
per-checkout config overlay under `~/.local/state/weave-dev/`, so your real
`~/.config/opencode` is never edited, and auth, sessions, `~/.weave`, and
tools such as `gh` keep working. Pass `--no-build` to reuse the last build;
any other arguments go to `opencode`. Run the script from a worktree to test
that worktree's code.

The launcher can't override a Weave plugin listed in the project's own
`opencode.json`, so it warns about one; remove it while testing. Adapter logs
go to the project's `.weave/weave.log`.

Aliases make this shorter:

```bash
alias opencode-dev=~/source/weave/scripts/dev/opencode
alias weave-dev=~/source/weave/scripts/dev/weave
```

To wire a build into a config by hand instead, use an absolute file URL:

```json
{
  "plugin": [
    "file:///absolute/path/to/packages/adapters/opencode/dist/plugin.js"
  ]
}
```

OpenCode appends `plugin` lists from every config layer, so remove any other
Weave plugin first, or both will load.

## Supported host versions

| Host | Support |
| --- | --- |
| OpenCode | No independent version floor is encoded. The package declares `@opencode-ai/plugin` and `@opencode-ai/sdk` `~1.15.9`; use an OpenCode release compatible with those APIs. |
| Bun | Required for repository development and local builds. |

## Documentation

See the [OpenCode adapter reference](https://tryweave.io/docs/reference/adapters/opencode/)
for behavior, commands, logging, and capability limits.

## License

MIT
