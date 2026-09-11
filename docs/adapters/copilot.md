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

## Self-hosted marketplace install

This repository publishes itself as a self-hosted GitHub Copilot plugin
marketplace via [`.github/plugin/marketplace.json`](../../.github/plugin/marketplace.json)
— the path and format the `copilot` CLI documents for marketplace repos
(`copilot plugin marketplace --help`: "Marketplaces are GitHub repositories
containing a `marketplace.json` file that indexes available plugins"), and
the exact path used by GitHub's own default marketplace,
[`github/copilot-plugins`](https://github.com/github/copilot-plugins/blob/main/.github/plugin/marketplace.json).
The manifest's top-level `name` is `weaveio` and it lists one plugin entry,
`weave`, whose `source` is the same-repo relative path `./plugins/copilot`
— a **committed distribution snapshot** of the generated Agent Plugins
bundle, deliberately kept separate from the adapter's gitignored default
local-generation target (`.weave/plugins/copilot/`, described below under
[Generated layout](#generated-layout)) so cloning this repo does not require
running the generator first. It is regenerated intentionally with
`bun run generate:copilot-plugin-dist` and reviewed/committed by hand — see
[`docs/copilot-adapter.md` § Self-hosted plugin marketplace](../copilot-adapter.md#self-hosted-plugin-marketplace)
for the full rationale and drift-detection test.

**Status: documented CLI semantics, not independently reproduced for the
remote `add`/`install` path.** Everything below about `marketplace add
<owner>/<repo>` and `plugin install <name>@<marketplace>` is derived from
the `copilot plugin --help` / `copilot plugin marketplace --help` output
captured in
[`docs/artifacts/copilot-adapter-research.md`](../artifacts/copilot-adapter-research.md)
and from GitHub's own `copilot-plugins` marketplace repo layout (fetched
live to confirm the manifest path and schema shape). No task in this
project has actually run `copilot plugin marketplace add weave-io/weave`
or `copilot plugin install weave@weaveio` against a real Copilot CLI and
observed the result — unlike the direct local-path install, which **was**
live-verified (see [Direct install](#direct-install-deprecated-with-a-targeted-compatibility-fix)
above, 2026-09-11 transcript). Treat the commands below as the
correctly-shaped, spec-following commands for this repository's manifest,
not as a proven end-to-end remote-resolution result.

**One-time marketplace registration** (per machine/user, not per session):

```bash
copilot plugin marketplace add weave-io/weave
```

Per the CLI's documented `owner/repo` install-source shorthand
(`copilot plugin install --help`) and the convention its two built-in
marketplaces follow (`copilot-plugins` ← `github/copilot-plugins`,
`awesome-copilot` ← `github/awesome-copilot`), this should resolve
`.github/plugin/marketplace.json` at `weave-io/weave`'s default branch and
register it under the name declared in that manifest (`weaveio`).
`weave-io/weave` is this repository's actual `owner/repo`, from `git remote
get-url origin` — not invented.

Once registered, install the plugin:

```bash
copilot plugin install weave@weaveio
```

This is the `plugin@marketplace` install-source form documented in
`copilot plugin install --help`. It should resolve to `weave`'s `source`
entry in the marketplace manifest (`./plugins/copilot`) and install it the
same way the live-verified direct local-path install did. The same caveats
from [Direct install](#direct-install-deprecated-with-a-targeted-compatibility-fix)
apply (unproven end-to-end beyond agent materialization; the
`github/app#3685` agent-id qualification workaround; `--add-dir` remains
the recommended path today). To remove the marketplace registration:
`copilot plugin marketplace remove weaveio`.

**Why no ref/sha pinning.** The marketplace manifest lives in the same
branch/repo as the plugin bundle it points at and is expected to evolve
together with it on every commit. Upstream same-repo relative `source`
entries (e.g. `github/copilot-plugins`' own `"spark"` entry:
`"source": "./plugins/spark"`) carry no ref/sha field, and there is no
placeholder value to invent here — the CLI resolves the relative path
against whatever ref the marketplace was added at (the default branch,
unless a future `owner/repo#ref` install source is used). Pinning a ref in
an in-repo manifest that is expected to change on every commit would go
stale immediately and was deliberately avoided.

## Generated layout

`CopilotAdapter.flush()` writes the full bundle under
`<projectRoot>/.weave/plugins/copilot/` by default (configurable via
`outDir`) — this is the adapter's ordinary, gitignored, freely-regenerated
local output for any consuming project. This repository additionally
commits a **separate, intentionally-regenerated snapshot** at
`plugins/copilot/` (repo root, outside `.weave/`) for marketplace
distribution — see [Self-hosted marketplace install](#self-hosted-marketplace-install)
above. The two directories have the identical internal layout described
below; only the repo-root location and gitignore/commit status differ.

```
.weave/plugins/copilot/                  # local/default (gitignored)
plugins/copilot/                         # committed distribution snapshot
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
- [`.github/plugin/marketplace.json`](../../.github/plugin/marketplace.json) — this repo's self-hosted marketplace manifest
- [Adapter Boundary](../adapter-boundary.md)
- [Adapter Readiness Status](../adapter-readiness-status.md)
