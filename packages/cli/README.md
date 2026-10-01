# @weaveio/weave-cli

The Weave CLI provides the `weave` command for configuration setup,
validation, prompt inspection, runtime inspection, evals, and Claude Code
composition. The published CLI bundles Weave's core, config, and engine
layers; install those layers separately only for repository development.

## Install

Install the stable channel globally with Bun:

```bash
bun add --global @weaveio/weave-cli@latest
weave --version
```

Use `@next` instead of `@latest` for pre-releases. For a one-off invocation:

```bash
bunx @weaveio/weave-cli@latest --help
```

## Minimal use

From the project that should use Weave:

```bash
weave init --scope local --yes --harness opencode2   # or opencode, claude-code
weave validate --project
weave prompt list
```

`--harness` adds Weave to that harness: the pinned adapter entry in
`opencode.json(c)` for OpenCode 1 (`plugin`) and OpenCode 2 (`plugins`), or
the composed plugin directories for Claude Code. Without it, `weave init`
writes only `.weave/config.weave`.

To generate Claude Code files:

```bash
weave compose --adapter claude-code --init
```

The CLI configures integrations. It does not launch OpenCode, Claude Code, or
Pi. Start the selected harness with its own command.

Run `weave --help` for the installed command and option list. The complete
reference is [the CLI documentation](https://tryweave.io/docs/reference/cli/).

## Supported host versions

| Host | Support |
| --- | --- |
| Bun | 1.1 or newer. The CLI is Bun-only. |
| Claude Code | File materialization through `weave compose`; no Claude Code version range is enforced by this package. |
| OpenCode | Configuration setup only; install the OpenCode adapter for the runtime plugin. |
| Pi | Configuration setup only; install the Pi adapter for the extension. |

The CLI's `init` installer currently writes the OpenCode integration. Claude
Code uses `compose`, and Pi uses its Pi package installer.

## License

MIT
