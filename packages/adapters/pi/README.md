# @weaveio/weave-adapter-pi

The shipped Weave extension and adapter for interactive Pi sessions. It
activates normalized Weave configuration, selects primary agents, renders
Weave commands and UI surfaces, runs authenticated private children, and
projects durable workflow operations into Pi.

## Install

Install the channel you want with Pi's package installer:

```bash
pi install npm:@weaveio/weave-adapter-pi@latest
```

Use `@next` or `@nightly` instead of `@latest` to select another channel.
Start Pi in a trusted project with a valid `.weave/config.weave`.

The adapter is a Pi extension, not a standalone print, JSON, RPC, or SDK
runtime. It requires Pi's Bun-based launcher. If a compiled launcher loads
extensions through a Node-like runtime, run the installed Pi CLI with Bun so
Bun built-ins such as `bun:ffi` and `bun:sqlite` are available.

## Minimal use

Install the CLI if it is not already available:

```bash
bun add --global @weaveio/weave-cli@latest
```

Then create the project configuration and start Pi:

```bash
weave init --scope local --yes
pi install npm:@weaveio/weave-adapter-pi@latest
pi
```

After activation, use `/weave:health` to inspect readiness and `/weave:start`
to submit a plan. Other available surfaces include `/weave:run`,
`/weave:resume`, `/weave:status`, `/weave:plan`, `/weave:inspect`, and the
bounded `weave_delegate` tool. `Alt+A` cycles healthy primary agents.

If a required host or configuration check fails, the extension remains in
health-only mode. It exposes safe diagnostics but does not materialize agents,
start workflows, or delegate work until the problem is fixed and Pi restarts.

## Supported host versions

| Host | Support |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `>=0.81.1`; there is no maximum version. |
| `@earendil-works/pi-ai` | Required peer dependency; use the version supplied by the Pi host. |
| `@earendil-works/pi-tui` | Required peer dependency; use the version supplied by the Pi host. |
| Bun | Required by the Pi host and this extension's runtime surface. |

The current release proof covers Pi 0.84.2. A host version alone does not
prove every optional capability; the extension probes the public host surfaces
at activation.

The extension does not enforce Weave `tool_policy` through a global
interceptor. Pi and each concrete tool owner retain authorization.

## Documentation

See the [Pi adapter reference](https://tryweave.io/docs/reference/adapters/pi/)
for commands, health-only behavior, child inspection, model handling, and
provider acceleration limits.

## License

MIT
