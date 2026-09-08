# @weaveio/weave-adapter-opencode

Native Weave integration for OpenCode 2. This release supports the exact host
version `0.0.0-beta-19086`.

## Install

Use explicit OpenCode 2 installation:

```bash
weave init --harness opencode2 --scope local --yes
```

Or add the package manually to the plural `plugins` field:

```jsonc
{
  "plugins": [
    "@weaveio/weave-adapter-opencode@<exact-version>",
  ],
}
```

Use `--scope global` to edit the XDG global OpenCode config. The CLI preserves
JSONC comments and existing plugin options. It stops on malformed or ambiguous
config files.

## Behavior

The package ships separate server, RPC, and TUI entries. It materializes Weave
agents through native OpenCode transforms and maps:

- composed role prompts to native agent `system`;
- live `provider/model#variant` choices to native model references;
- temperature to the context hook;
- read, write, execute, delegate, and network policy to current native actions;
- configured available skills to native prompt skill mentions;
- eligible specialists to OpenCode's native foreground/background subagents.

The V2 plugin reserves `/weave:start <plan-name>`. It does not register
`/start-work`. Plan selection and the CLI task list are read-only display state,
not durable workflow state.

OpenCode `0.0.0-beta-19086` does not expose native skill permission validation
at prompt admission. Configured available skill IDs attach without that check.
Disable a configured skill when this limit is not acceptable.

## Compatibility

The server/plugin default export uses the OpenCode 2 `Plugin.define` ABI. It is
not a V1 plugin. Legacy V1 SDK library helpers remain in the package root for
source compatibility.

Not delivered: durable workflows, usage rollups, a child dashboard, model
fallback, provider acceleration, or `/weave:goal`.

See the [full adapter guide](https://github.com/weave-io/weave/blob/main/docs/adapters/opencode.md)
and [isolated verification procedure](https://github.com/weave-io/weave/blob/main/docs/testing/opencode2-verification.md).

## License

MIT
