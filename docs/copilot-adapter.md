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

See [the practical Copilot guide](adapters/copilot.md), [Adapter Boundary](adapter-boundary.md),
and [`docs/artifacts/copilot-adapter-research.md`](artifacts/copilot-adapter-research.md).
