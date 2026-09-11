# Copilot Adapter

> **Status:** GitHub Copilot support is file materialization. The
> `@weaveio/weave-adapter-copilot` package generates a Copilot "Agent Plugin"
> bundle (Agent Plugins 1.0). It is scaffolded and under active development —
> see [`docs/artifacts/copilot-adapter-research.md`](artifacts/copilot-adapter-research.md)
> for the CLI-verified evidence this adapter is built against.

## Context

Weave normalizes `.weave` intent and the Copilot adapter writes a generated
Copilot Agent Plugin directory (`plugin.json` + `com.github.copilot/agents/*.agent.md`)
under `<projectRoot>/.weave/plugins/copilot/`. This is deliberately not a claim
of OpenCode runtime parity: generated `.agent.md` files cannot provide durable
workflow scheduling, lifecycle observation, idle continuation, compaction
recovery, context monitoring, or analytics. GitHub Copilot CLI 1.0.83 has no
plugin-hook system, no event bus, and no runtime SDK equivalent to OpenCode's
`@opencode-ai/sdk` — its only externally observable behaviors are file-based
agent discovery and non-interactive prompt invocation
(`docs/artifacts/copilot-adapter-research.md`, §§1–8).

## Decision

### What is supported natively

- **Materialization** — `CopilotAdapter.spawnSubagent()` translates each
  `AgentDescriptor` into Copilot's `.agent.md` frontmatter format (`name`,
  `description`, `tools`) and accumulates it; `flush()` writes the full bundle
  (`plugin.json` conforming to the vendored `plugin-1.0.0.schema.json`, plus
  one `com.github.copilot/agents/<name>.agent.md` per agent) to `outDir`.
- **Discovery** — Copilot CLI documents fixed discovery directories for skills
  (`.github/skills/`, `.agents/skills/`, `.claude/skills/`, `~/.copilot/skills/`,
  `~/.agents/skills/`) and custom agents (`~/.copilot/agents/` user-level,
  `.github/agents/` repo-level, org/enterprise `.github-private` repos), with
  precedence user > repository > organization > enterprise on name collision
  (`docs/artifacts/copilot-adapter-research.md`, §8). `discoverCopilotSkills()`
  reads these adapter-owned locations.
- **CLI/Desktop activation** — non-interactive prompt-to-agent invocation is
  proven and deterministic:
  `copilot -p "<prompt>" --agent <agent-name> --allow-all-tools -s`
  (`docs/artifacts/copilot-adapter-research.md`, §4). Loading a disposable
  agent profile from a directory that is not on the CLI's default discovery
  path works via the CLI's documented **trusted-directory** mechanism,
  `--add-dir <path>`, which was exercised live and produced a deterministic
  single-line, exit-0 response. This is the adapter's recommended install
  path — see [the practical Copilot guide](adapters/copilot.md).

### What is prompt-only (behavior, not sandbox)

- **Tool restriction** — the `tools:` frontmatter field (`read`, `edit`,
  `execute`/`shell`, `search`, `agent`, `web`, `todo`, plus MCP
  `server-name/tool-name` references) is accepted by the CLI, but the CLI does
  **not** validate or reject unrecognized tool identifiers at parse time — an
  agent with an invalid tool name loads and runs without error
  (`docs/artifacts/copilot-adapter-research.md`, §6). Weave's effective tool
  policy is therefore encoded as **prompt/frontmatter guidance the model is
  expected to follow**, not an enforced sandbox boundary. There is no CLI-side
  mechanism that blocks a disallowed tool call at the process level; the
  adapter's `getCopilotToolClassifications()` maps Weave's abstract
  `allow`/`deny`/`ask` decisions onto this same non-enforcing frontmatter list.
  Treat `tool_policy` effective decisions in the Copilot adapter as **stated
  intent**, not a security control.

### What is unsupported in v1

The following capabilities have no corresponding CLI surface as of Copilot
CLI 1.0.83 and are **not implemented** by `@weaveio/weave-adapter-copilot`:

- **Workflow persistence** — no CLI concept of a durable, resumable workflow
  instance; each `copilot -p` invocation is a single non-interactive turn.
- **Event logging / debug traces** — no plugin-hook or event-bus system was
  found; `copilot plugin --help` describes install/list/uninstall/update only,
  not runtime event subscription (`docs/artifacts/copilot-adapter-research.md`, §2).
- **Idle continuation** — no session-idle hook exists to resume or nudge a
  stalled session.
- **Recovery / compaction** — no CLI-exposed context-compaction or
  crash-recovery mechanism was found.
- **Context monitoring** — no CLI command surfaces token/context-window usage
  for a running session.
- **Analytics** — no CLI or plugin API exposes usage telemetry to a consumer.

These gaps are structural (the harness itself has no such surface at this CLI
version), not an implementation shortfall the adapter can close by writing
more files. See [Adapter Readiness Status](adapter-readiness-status.md) for
the per-capability `native`/`emulated`/`degraded`/`unsupported` declarations.

## Boundaries

The adapter owns Copilot-specific file locations (`.weave/plugins/copilot/`),
`.agent.md` frontmatter translation, tool-alias mapping, MCP-server
frontmatter shape validation (empty `mcp-servers: {}` silently drops the whole
agent — `docs/artifacts/copilot-adapter-research.md`, §5), and the vendored
`plugin-1.0.0.schema.json`. It does not attempt to emulate durable execution,
event logging, or analytics by inventing a state machine on top of static
files — doing so would misrepresent what the generated bundle can guarantee.
Internal core/config/engine workspace layers remain bundled and are never
consumer npm dependencies.

## Consequences

- Users must restart `copilot` (or re-run `--add-dir`) after generated files
  change; there is no live-reload signal from the CLI.
- Tool policy enforcement is advisory only for this harness; do not present
  Copilot `tool_policy` results as a security boundary in user-facing docs or
  UI.
- Any future claim of workflow persistence, idle continuation, recovery,
  context monitoring, or analytics support for Copilot requires new,
  independently reproduced CLI/runtime evidence recorded in
  `docs/artifacts/`, and an update to this document and to
  [Adapter Readiness Status](adapter-readiness-status.md) — do not infer
  support from model behavior alone (see the research doc's §3 caution about
  slash commands being answered from documentation rather than executed).

### Plugin agent id qualification (`github/app#3685`)

**Upstream bug.** The GitHub Copilot **app** (`github.exe`, the desktop
picker/session UI — distinct from the `copilot` CLI) selects a custom agent
by `AgentInfo.name` and sends that value to `session.create`, but
`session.create` resolves agents by `AgentInfo.id`. For a project-sourced
agent (`.github/agents/*.agent.md`, and the `--add-dir` trusted-directory
path Weave recommends above) `id === name`, so this is invisible. For a
**plugin-contributed** agent — installed with
`copilot plugin install <local-path>`, from a marketplace, or via any other
plugin-install mechanism — the CLI derives a distinct, namespaced `id` of
the shape `<plugin-manifest-name>:<agent-filename-stem>` while `name`
remains the bare filename stem. The app sends the bare `name`, which does
not exist in the CLI's selection vocabulary, so session creation fails
with:

```
session construction failed: Custom agent 'loom' not found
```

This is a regression in app v1.1.16–v1.1.17 introduced by an unrelated fix
(`github/app#3550`, filename fallback for blank-displaying plugin agents)
and was fixed upstream in **app v1.1.18**
([`github/app#3685`](https://github.com/github/app/issues/3685)). Because
users may run an app version predating the fix, or may have a stale
persisted selection from before it, Weave applies the verified upstream
workaround defensively at generation time rather than only documenting it.

**What Weave does.** `CopilotAdapter` pre-qualifies each generated agent's
frontmatter `name:` field as `<qualifier>:<agent-name>` — currently
`weave:loom` rather than `loom` — where `<qualifier>` is
`getPluginAgentIdQualifier()` in
[`adapter.ts`](../packages/adapters/copilot/src/adapter.ts). **This value is
the plugin manifest's own `plugin.json` `name` field (`"weave"`), not
anything derived from the install path, `outDir`, or the install
mechanism.**

An earlier version of this fix assumed the qualifier was the basename of the
installed directory (`~/.copilot/installed-plugins/_direct/SOURCE-ID/`,
which for a local-path install of `.weave/plugins/copilot` is literally
`_direct/copilot`), and named the option/function accordingly
(`directInstallCompat`, `getDirectInstallSourceId`). That assumption was
disproven by live verification against Copilot CLI 1.0.83 on 2026-09-11:
after `copilot plugin install "$(pwd)/.weave/plugins/copilot"`, the CLI
reported `Plugin "weave" installed successfully` (the manifest name, not
the path basename), and probing the CLI's accepted agent vocabulary
(`copilot --agent __nope__ -p x`) listed `weave:loom`, `weave:shuttle`, etc.
— `copilot:loom` was **not** in that list and does not resolve. The
`_direct/<path-basename>` segment is only the CLI's on-disk cache key for
direct installs (to avoid path collisions), has no equivalent for
marketplace installs, and has no bearing on the agent id the CLI actually
accepts. The plugin manifest `name` is therefore the correct, least-brittle
source of truth — it is the exact string Weave already writes to
`plugin.json`, so the two values structurally cannot drift apart — and the
public API was renamed to `getPluginAgentIdQualifier()` /
`qualifyPluginAgentNames` / `pluginAgentIdQualifier` to describe this
accurately and to stop implying the fix is specific to direct installs.

**Why this is safe.** Per the upstream bug report's own verified workaround,
"The CLI derives identity from the filename and ignores `name`, so this does
not disturb CLI resolution." The `.agent.md` **filename** stays bare
(`loom.agent.md`, never `weave:loom.agent.md`) — only the frontmatter
`name:` value inside it changes. This means:

- `--add-dir` / `--agent <name>` CLI invocation is unaffected (CLI resolves
  by filename, not by frontmatter `name:`).
- Once the app is upgraded past v1.1.18 and correctly selects by `id`,
  `name == id` still resolves — the qualifier becomes a no-op, not a new
  failure mode.
- The only observable side effect is cosmetic: the app's agent picker may
  display `weave:loom` instead of `loom` as the agent's label.

**Opting out.** Pass `qualifyPluginAgentNames: false` to `CopilotAdapter`'s
constructor to emit bare `name:` values (pre-workaround behavior) — for
example, once every consumer of a generated bundle is confirmed to be on
app v1.1.18+ and the qualified display name is undesirable.

**Live CLI verification (2026-09-11, Copilot CLI 1.0.83, this fix's
generated bundle):**

```
$ bun run packages/adapters/copilot/scripts/generate-bundle.ts
Bundle written. Install: copilot plugin install <projectRoot>/.weave/plugins/copilot

$ head -3 .weave/plugins/copilot/com.github.copilot/agents/loom.agent.md
---
name: weave:loom
description: Loom (Main Orchestrator)

$ copilot plugin install "$(pwd)/.weave/plugins/copilot"
Plugin "weave" installed successfully.
Warning: Direct plugin installs (repos, URLs, local paths) are deprecated. ...

$ ls ~/.copilot/installed-plugins/_direct/
copilot     # on-disk cache key = install path basename — NOT the agent qualifier

$ copilot --no-auto-update -s --no-ask-user --agent __nope__ -p "x"
No such agent: __nope__, available: weave:loom, weave:shuttle, weave:shuttle-core, ...

$ copilot --no-auto-update -s --no-ask-user --agent weave:loom \
    -p "Reply with only the word OK, no tool calls." --allow-all-tools
OK

$ copilot plugin uninstall weave   # cleanup after verification
Plugin "weave" uninstalled successfully.
```

`weave:loom` is in the CLI's accepted vocabulary and resolves a real prompt;
`copilot:loom` (the disproven directory-basename guess) is absent from that
vocabulary and does not resolve. This confirms the plugin manifest `name`
field is the correct qualifier and validates the fix end-to-end against a
live CLI, independent of the app itself (which was not available to test
directly in this environment).

See [`packages/adapters/copilot/src/__tests__/agent-translation.test.ts`](../packages/adapters/copilot/src/__tests__/agent-translation.test.ts)
and [`packages/adapters/copilot/src/__tests__/adapter.test.ts`](../packages/adapters/copilot/src/__tests__/adapter.test.ts)
for the regression coverage.

See [the practical Copilot guide](adapters/copilot.md), [Adapter Boundary](adapter-boundary.md),
and [`docs/artifacts/copilot-adapter-research.md`](artifacts/copilot-adapter-research.md).

### Self-hosted plugin marketplace

**Decision.** This repository is its own GitHub Copilot plugin marketplace:
[`.github/plugin/marketplace.json`](../.github/plugin/marketplace.json)
(marketplace name `weaveio`) lists one plugin entry (`weave`) whose `source`
is the same-repo relative path `./plugins/copilot`, yielding
`copilot plugin marketplace add weave-io/weave` (one-time) followed by
`copilot plugin install weave@weaveio`. Full command reference and rationale,
including the accurate live-verification status of these two commands (they
are documented CLI semantics, not independently reproduced end-to-end in
this project — unlike the direct local-path install, which was):
[the practical Copilot guide § Self-hosted marketplace install](adapters/copilot.md#self-hosted-marketplace-install).

**Why this location.** `.github/plugin/marketplace.json` is not an
agent-plugins.org-specified path (that spec only defines the plugin manifest,
`plugin.json`, and its directory layout) — it is the Copilot CLI's own
documented and empirically-confirmed marketplace-repo convention. Verified by
fetching `github/copilot-plugins`' actual repository layout: its
`marketplace.json` lives at exactly `.github/plugin/marketplace.json`, and
its `name` field (`"copilot-plugins"`) matches the marketplace name the CLI's
`copilot plugin --help` output lists it under.

**Why the plugin bundle lives at `plugins/copilot/`, not
`.weave/plugins/copilot/`.** `.weave/` is the adapter's ordinary, gitignored,
freely-regenerated local-generation target (see
[Generated layout](adapters/copilot.md#generated-layout)) — appropriate for
any consuming project's day-to-day iteration, but not for a marketplace
`source` that must resolve for anyone who clones this repo without first
running the generator. Rather than force-add a path under an otherwise
fully-gitignored directory (a fragile pattern that is easy to lose track of
and easy to accidentally exclude again), the committed distribution artifact
lives at the ordinary, non-ignored repo-root path `plugins/copilot/` and is
regenerated **intentionally** via `bun run generate:copilot-plugin-dist`
(wraps `packages/adapters/copilot/scripts/generate-bundle.ts --out-dir
plugins/copilot`) — never as a side effect of any other command. Maintainers
must re-run that script and review/commit the diff whenever the underlying
`.weave/config.weave` agent definitions change;
[`marketplace.test.ts`](../packages/adapters/copilot/src/__tests__/marketplace.test.ts)
regenerates the bundle to a temp directory in CI/test runs and diffs it
against the committed `plugins/copilot/` to catch forgotten regenerations.

**Why no ref/sha pinning.** See [the practical Copilot guide's rationale](adapters/copilot.md#self-hosted-marketplace-install)
— the manifest and the plugin it points at live in, and evolve with, the same
branch; there is no upstream precedent for pinning a same-repo relative
`source`, and doing so would go stale on every commit.
