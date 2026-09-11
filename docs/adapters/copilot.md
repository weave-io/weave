# GitHub Copilot Adapter Guide

Practical guide to installing and using `@weaveio/weave-adapter-copilot`. For
the status/context/decision/consequences writeup, see
[Copilot Adapter](../copilot-adapter.md).

## Install path

### Recommended: trusted-directory activation (`--add-dir`)

The proven, deterministic way to load Weave-generated Copilot agents is the
CLI's documented **trusted-directory** mechanism, not `copilot plugin install`.
This was reproduced live in
[`docs/artifacts/copilot-adapter-research.md`](../artifacts/copilot-adapter-research.md)
(§4) and confirmed in this project's live E2E test:

```bash
copilot -p "<prompt>" --agent <agent-name> \
  --add-dir <path-to-weave-generated-dir> \
  --allow-all-tools -s
```

`--add-dir` tells the CLI to trust a directory outside its default discovery
paths for this invocation. It requires no install step, no marketplace
registration, and no mutation of `~/.copilot/installed-plugins`. This is the
adapter's recommended path today because it is the only mechanism that has
been empirically exercised end-to-end.

### Direct install (deprecated, with a targeted compatibility fix)

`copilot plugin install <source>` (or the newer unified `copilot plugins
install|add`) can install a plugin bundle from a marketplace, GitHub repo, or
git URL. Weave's generated `plugin.json` conforms to the vendored
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and could in
principle be installed this way, but:

- No install was performed or verified in the research spike or the live E2E
  task — this path is **unproven** for Weave-generated bundles.
- Installed plugins live under `~/.copilot/installed-plugins`, a location the
  research spike deliberately avoided mutating.

Treat direct install as **deprecated for Weave's purposes** until a follow-up
task reproduces it end-to-end. Prefer `--add-dir` today.

If you do install the generated bundle directly —
`copilot plugin install "$(pwd)/.weave/plugins/copilot"` — be aware of
[`github/app#3685`](https://github.com/github/app/issues/3685): the GitHub
Copilot **app**'s picker can fail to create a session for a
plugin-contributed agent with `Custom agent '<name>' not found`, because the
app selects by the bare agent name while `session.create` requires a
CLI-assigned qualified id. Live-verified against Copilot CLI 1.0.83
(2026-09-11): for Weave's generated bundle that qualified id is
`weave:<agent-name>` (e.g. `weave:loom`) — the plugin's own `plugin.json`
`name` field, **not** the install path's directory basename. This was an
app-side regression fixed upstream in app v1.1.18. `CopilotAdapter`
pre-qualifies every generated agent's frontmatter `name:` field to work
around this defensively (on by default; disable with
`qualifyPluginAgentNames: false`) — see
[Copilot Adapter § Plugin agent id qualification](../copilot-adapter.md#plugin-agent-id-qualification-githubapp3685)
for the full root-cause, live-verification transcript, and safety analysis.
This targeted fix does not change the direct-install deprecation above: the
CLI plugin-install pathway as a whole remains unproven for Weave's other
components (skills, MCP, commands); only the agent-selection id mismatch is
specifically addressed. The fix itself is not specific to direct installs —
`getPluginAgentIdQualifier()` returns the plugin manifest `name`, which
applies to any install mechanism (direct, marketplace, or otherwise).

## Generated layout

`CopilotAdapter.flush()` writes the full bundle under
`<projectRoot>/.weave/plugins/copilot/` (configurable via `outDir`):

```
.weave/plugins/copilot/
├── plugin.json                          # conforms to plugin-1.0.0.schema.json
└── com.github.copilot/
    └── agents/
        ├── loom.agent.md
        ├── shuttle.agent.md
        └── <agent-name>.agent.md        # one file per materialized agent
```

Each `.agent.md` file has YAML frontmatter (`name`, `description`, `tools`)
followed by the composed prompt body. Frontmatter fields are limited to the
subset the adapter has verified against the live CLI
(`docs/artifacts/copilot-adapter-research.md`, §5) — `mcp-servers` is
currently emitted defensively (never as an empty object) because an empty
`mcp-servers: {}` silently drops the entire agent profile with no CLI-side
error. The `.agent.md` **filename** always matches the bare agent name
(`loom.agent.md`); the frontmatter `name:` value inside may be qualified as
`weave:<agent-name>` (the plugin manifest name, not the install path) — see
[Direct install](#direct-install-deprecated-with-a-targeted-compatibility-fix)
below.

## `weave compose --adapter copilot`

This CLI invocation is **aspirational** — the `weave compose` command does not
yet have `--adapter copilot` wiring. `CopilotAdapter` exists as a library
(`@weaveio/weave-adapter-copilot`) and can be constructed and driven directly
via `HarnessAdapter` (`init()` → `spawnSubagent()` per agent → `flush()`), but
CLI-level `--adapter copilot` support is tracked as a follow-up issue and is
not available yet. Do not document or advertise this command as working until
that CLI wiring lands.

## Known deprecations

- **Direct plugin install** (`copilot plugin install`) is deprecated for
  Weave's purposes in favor of `--add-dir` trusted-directory activation (see
  above). This may change once direct install is independently verified.
  A narrow compatibility fix for the agent-selection id mismatch
  ([`github/app#3685`](https://github.com/github/app/issues/3685)) is
  applied regardless (see above) since it is free/harmless for the
  `--add-dir` path and only activates its qualified naming meaningfully when
  a direct install is actually used.

## Related

- [Copilot Adapter](../copilot-adapter.md) — status, context, decision, consequences
- [`docs/artifacts/copilot-adapter-research.md`](../artifacts/copilot-adapter-research.md) — CLI evidence this guide is based on
- [Adapter Boundary](../adapter-boundary.md)
- [Adapter Readiness Status](../adapter-readiness-status.md)
