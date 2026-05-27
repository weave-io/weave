# @weave/adapter-opencode

OpenCode adapter for Weave.

## Plugin entrypoint

When loading this adapter as an OpenCode plugin, use the plugin bundle entrypoint:

```json
{
  "plugin": [
    "@weave/adapter-opencode/plugin"
  ]
}
```

For a direct file URL during local development, point OpenCode at `dist/plugin.js`, not `dist/index.js`:

```json
{
  "plugin": [
    "file:///abs/path/to/packages/adapters/opencode/dist/plugin.js"
  ]
}
```

Rebuild the package before using a `dist/` file path so the plugin bundle matches the current source:

```bash
bun run --filter @weave/adapter-opencode build
```

Do **not** use the bare package entry (`@weave/adapter-opencode`) or `dist/index.js` as a plugin target. The bare entry is the programmatic barrel and exports non-plugin values in addition to the plugin function, which is incompatible with OpenCode's legacy plugin loader.

## Isolated OpenCode validation

OpenCode merges global config, project config, explicit config, and plugin directories. `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` add config; they do not replace every other source by themselves.

To validate this adapter in isolation:

```bash
TMP_HOME="$(mktemp -d)"
TMP_XDG="$(mktemp -d)"

HOME="$TMP_HOME" \
XDG_CONFIG_HOME="$TMP_XDG" \
OPENCODE_DISABLE_PROJECT_CONFIG=1 \
OPENCODE_CONFIG_CONTENT='{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///abs/path/to/packages/adapters/opencode/dist/plugin.js"
  ]
}' \
opencode debug config
```

Use the same environment with `opencode debug info` to verify that the plugin executes, not just that it appears in merged config.

## Expected behavior

- `opencode debug config` should show the Weave-materialized `agent` map injected by the plugin's `config` hook.
- `opencode debug info` should show the plugin loading and executing.
- The resulting OpenCode `agent` entries should reflect the resolved Weave DSL for the loaded `.weave/config.weave` plus builtin Weave agent defaults.
