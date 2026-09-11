# Copilot CLI + Agent Plugins 1.0 — Research Spike Evidence

Date: 2026-09-11
Environment: `GitHub Copilot CLI 1.0.83` installed at `~/.bun/bin/copilot` (from `@github/copilot@1.0.83`, a Bun-managed global npm-style package). No `copilot` binary was on `PATH` by default; `PATH="$HOME/.bun/bin:$PATH"` was required for all commands below.

Related: prior distilled research already exists in the memory vault at `Weave/Copilot Desktop harness.md` (empirically proven facts about Agent Plugins 1.0, materialization strategy, and open questions). This document supplements it with raw CLI/help output and doc-page evidence gathered in this task, and does **not** duplicate the prior file's content wholesale.

**Security note**: `~/.copilot/config.json` contains a live GitHub OAuth token under `authTokens`. That file's contents are intentionally **not quoted anywhere in this document**. No secrets were written to any tracked file.

---

## 1. `copilot --version` / `copilot --help`

```
$ copilot --version
GitHub Copilot CLI 1.0.83.
Run 'copilot update' to check for updates.
```

`copilot --help` output (abridged to the parts relevant to this spike; full output observed in session):

```
Usage: copilot [options] [command]

GitHub Copilot CLI - An AI-powered coding assistant.
...
  --agent <agent>                       Specify a custom agent to use
  --allow-all-tools                     Allow all tools to run automatically
                                        without confirmation; required for
                                        non-interactive mode (env:
                                        COPILOT_ALLOW_ALL)
  --available-tools[=tools...]          Only these tools will be available to
                                        the model
  --model <model>                       Set the AI model to use (use 'auto' to
                                        let Copilot pick automatically)
  -p, --prompt <text>                   Execute a prompt in non-interactive mode
                                        (exits after completion)
  -s, --silent                          Output only the agent response (no
                                        stats), useful for scripting with -p
  --output-format <format>              Output format: 'text' (default) or
                                        'json' (JSONL, one JSON object per line)
...
Commands:
  app                                   Open the GitHub Copilot app
  completion <shell>                    Generate a shell completion script
  help [topic]                          Display help information
  init                                  Initialize Copilot instructions
  login [options]                       Authenticate with Copilot
  mcp                                   Manage MCP servers
  plugin                                Manage plugins
  plugins                               Inspect configured plugins across kinds
  skill                                 Manage skills
  update [channel]                      Download the latest version
  version                               Display version information
```

**Proven**: `--agent`, `--model`, `-p`/`--prompt`, `-s`/`--silent`, `--allow-all-tools`, `--output-format json` all exist as documented top-level flags.

---

## 2. `copilot plugin --help` and subcommands

```
$ copilot plugin --help
Usage: copilot plugin [options] [command]

Manage plugins and plugin marketplaces.

Plugins extend Copilot CLI with additional skills, agents, hooks, MCP servers,
and LSP servers. They can be installed from plugin marketplaces, GitHub
repositories, repository subdirectories, or direct git URLs.

Two marketplaces are included by default:
  copilot-plugins   github/copilot-plugins
  awesome-copilot   github/awesome-copilot

Commands:
  install [options] <source>  Install a plugin
  list [options]               List installed and --plugin-dir plugins
  marketplace                  Manage plugin marketplaces
  uninstall [options] <name>   Uninstall a plugin
  update [options] [name]      Update a plugin
```

```
$ copilot plugin install --help
Usage: copilot plugin install [options] <source>

The source argument is parsed in the following order:
  plugin@marketplace   Install from a registered marketplace
  owner/repo           Install from a GitHub repository
  owner/repo:path      Install from a subdirectory within a repo
  https://...          Install from a git URL

Examples:
  $ copilot plugin install spark@copilot-plugins
  $ copilot plugin install owner/repo
  $ copilot plugin install owner/repo:plugins/my-plugin
  $ copilot plugin install https://github.com/owner/my-plugin.git
```

```
$ copilot plugin list --help
Usage: copilot plugin list [options]

Shows all plugins currently installed, their versions, and status.
Plugins mounted via the global --plugin-dir option are also listed,
under a separate "External Plugins (via --plugin-dir)" section.
```

```
$ copilot plugin uninstall --help
Usage: copilot plugin uninstall [options] <name>

Removes a previously installed plugin and its associated skills.

Arguments:
  name        Plugin name (plugin-name or plugin-name@marketplace-name)
```

```
$ copilot plugin marketplace --help
Usage: copilot plugin marketplace [options] [command]

Marketplaces are GitHub repositories containing a `marketplace.json` file that
indexes available plugins.

Commands:
  add [options] <source>   Add a marketplace
  browse [options] <name>  Browse plugins in a marketplace
  list [options]           List registered marketplaces
  remove [options] <name>  Remove a marketplace
  update [options] [name]  Update marketplace plugin catalogs
```

There is also a newer, higher-level `copilot plugins` (plural) command that unifies plugins/MCP/skills inspection:

```
$ copilot plugins --help
Usage: copilot plugins [options] [command]

Inspect plugins, MCP servers, skills, instructions, and language servers
from a single command, grouped by kind and configuration scope.

Commands:
  disable [options] <name>      Disable a configured tool
  enable [options] <name>       Enable a configured tool
  install|add [options] <spec>  Install a new tool
  list [options]                List configured plugins across kinds
  marketplace|marketplaces      Manage plugin marketplaces
  remove|rm [options] <name>    Remove an installed tool
  update [options] [name]      Update a plugin
```

**Confirmed**: `copilot plugin list` on this machine, before and after the spike, reports:

```
No plugins installed.

Use 'copilot plugin install <source>' to install a plugin.
```

No `plugin install` or `plugin marketplace add` was executed at any point during this spike — evidence gathering for agent behavior used `--agent <name> --add-dir <dir>` against a disposable `.github/agents/*.agent.md` file in `/tmp/opencode/copilot-test`, which is the CLI's documented **trusted-directory** mechanism, not the plugin-install mechanism. This avoided touching `~/.copilot/installed-plugins` entirely. `/tmp/opencode/copilot-test` was `rm -rf`'d at the end of the spike.

---

## 3. `copilot agent --help` — no such top-level command

There is **no** `copilot agent` subcommand. Agent management in the CLI is exposed only as:
- the `--agent <agent>` global flag (non-interactive and interactive),
- the interactive-only `/agent [name]` slash command.

```
$ copilot agent --help
error: unknown command 'agent'
```
(reproduced by the absence of `agent` from the `Commands:` list in `copilot --help`; there is no `mcp`-style `copilot agent` subcommand tree).

### `/agent` non-interactive behavior — **unproven as a scriptable listing command**

Attempting `copilot -i "/agent list" --allow-all-tools` in non-interactive mode does **not** execute the slash command. Instead the model answers *about* the command from its own documentation knowledge:

```
$ copilot -i "/agent list" --allow-all-tools
● Checking my documentation
  └ # GitHub Copilot CLI Documentation

`/agent` is an interactive-mode command ("Browse and select agents: `/agent [name]`") used to
view or switch the active agent. Since I'm running non-interactively, I can't launch that
picker UI, but here's what it does: running `/agent` lists available agents (built-in and
custom) so you can pick one; `/agent <name>` switches directly to that named agent for the
session.
```

The same pattern was observed for `/settings` and `/env` when invoked via `-i` — non-interactive mode treats these as documentation questions, not executed commands. **Unproven — fallback**: there is no deterministic non-interactive way to enumerate available agents via a slash command. The reliable fallback is the `--agent <bogus-name>` error message (see below), which *does* deterministically enumerate currently-loaded custom agents.

### Non-interactive agent listing — proven fallback via intentional error

```
$ copilot -p "ok" --agent nonexistent-agent --add-dir <trusted-dir> --allow-all-tools -s
No such agent: nonexistent-agent, available: research-agent
```

When no custom agents are configured (default state on this machine), the same technique yields:
```
No such agent: general, available:
```
(empty list — confirms only user/repo/org/enterprise-defined custom agents appear here, not the built-in agents `explore`/`task`/`general-purpose`/`code-review`, which apparently are not addressable via `--agent` at all in this CLI version — **unproven** whether built-ins are ever selectable via `--agent`; the built-in-agent docs describe them as invoked automatically by the main model's delegation judgment, not by user-specified `--agent`).

**Recommended adapter-facing check**: `copilot -p "" --agent __weave_probe__ --allow-all-tools -s` (or equivalent) parses the `available:` suffix of the resulting stderr/stdout line as a comma-separated list of currently-loaded custom agent names. This is a deliberate error-path parse, not a documented API — mark as **fragile, version-pinned**.

---

## 4. Non-interactive prompt-to-agent invocation — **proven**

Documented in GitHub Docs (`https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents`, fetched during this spike):

> Specifying the custom agent you want to use with the command-line option. For example:
> `copilot --agent=refactor-agent --prompt "Refactor this code block"`

This was empirically reproduced with a disposable test agent (not installed as a plugin — loaded via `--add-dir` trusted-directory):

```
$ cat .github/agents/research-agent.agent.md
---
name: research-agent
description: Disposable research test agent
tools: ["read", "write", "shell"]
---
You are a disposable test agent. Reply with the word: agent-ok

$ copilot -p "reply with the single word: agent-ok" --agent research-agent \
    --add-dir /tmp/opencode/copilot-test --allow-all-tools -s
agent-ok
```

Exit code `0`. Output is deterministic (single line, no banner) because of `-s`/`--silent` combined with `-p`/`--prompt`. `--output-format json` is also available for structured/JSONL capture (not exercised live in this spike but documented in `--help`).

**Confirmed deterministic invocation recipe for the Weave adapter**:
```
copilot -p "<prompt>" --agent <agent-name> --allow-all-tools -s
```
Add `--add-dir <path>` when the agent profile lives outside the default discovery directories (see §8) and hasn't been installed as a plugin. Add `--session-id <uuid>` for a fresh, non-resumed session when repeated determinism matters (observed: omitting `--session-id`/`--resume` can pick up an existing cached session tied to the CLI's implicit session-continuity heuristics).

---

## 5. `.agent.md` frontmatter fields — confirmed

Source: GitHub Docs, *About custom agents (Copilot CLI)* (`.../concepts/agents/copilot-cli/about-custom-agents`) and *Custom agents configuration reference* (`.../reference/custom-agents-configuration`, cloud-agent-flavored but frontmatter-field-compatible), both fetched live during this spike via their embedded Next.js `__NEXT_DATA__.props.pageProps.articleContext.renderedPage` JSON (the static HTML shell alone contains only nav, not article text — rendering is client-side).

CLI-specific doc (`about-custom-agents`) confirms the minimal fields:
- `name` (optional; display name — filename is the identifier if omitted)
- `description` (recommended)
- prompt body below frontmatter (required, Markdown)
- `tools` (optional; default = all tools)

The cloud-agent reference (applies to the same `.agent.md` frontmatter format, cross-referenced from the CLI docs) additionally documents:
- `target` (`vscode` or `github-copilot`; unset = both)
- `model` (string; inherits default if unset)
- `disable-model-invocation` (boolean)
- `mcp-servers` (object; YAML representation of MCP server JSON config)
- `metadata` (object of name/value string pairs)

Empirically reproduced fields on the live CLI (1.0.83), via disposable `.agent.md` files:
- `name` — proven (used to select via `--agent`)
- `description` — proven (accepted without error)
- `tools` — proven (accepted as a YAML/JSON array of strings)
- `mcp-servers` — **partially proven**: setting `mcp-servers: {}` (empty object) in frontmatter caused the **entire agent profile to be silently dropped** — `copilot plugin list`/`--agent` no longer recognized it at all (verified: a sibling `research-agent.agent.md` in the same directory continued to work correctly). This is a real, observed failure mode: malformed or edge-case `mcp-servers` frontmatter does not error, it silently unregisters the whole agent. **Unproven**: the exact syntactic boundary of "malformed" — only the empty-object case was tested. Adapter implication: any Weave-generated `mcp-servers` block must be validated against a nonempty, correctly-shaped schema before being written, since there is no CLI-side error surface to catch generation bugs.

Unknown/unrecognized frontmatter fields are documented as being silently ignored ("All unrecognized tool names are ignored, which allows product-specific tools to be specified in an agent profile without causing problems" — this applies to the `tools` list specifically per docs, and by extension to the profile's tolerance of extra fields in general per the "Note" about `argument-hint`/`handoffs` VS Code-only fields being ignored for compatibility).

---

## 6. Tool identifiers accepted in `tools:` frontmatter — enumerated with source

Source: GitHub Docs *Custom agents configuration reference* (`.../reference/custom-agents-configuration`), "Tool aliases" table (fetched via `__NEXT_DATA__` JSON, not searchable in raw static HTML):

| Primary alias | Compatible aliases | Purpose |
|---|---|---|
| `execute` | `shell`, `Bash`, `powershell` | Execute a command in the appropriate shell |
| `read` | `Read`, `NotebookRead`, `view` | Read file contents |
| `edit` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | Edit files (exact arguments vary) |
| `search` | `Grep`, `Glob`, `search` | Search for files or text in files |
| `agent` | `custom-agent`, `Task` | Invoke another custom agent as a subtask |
| `web` | `WebSearch`, `WebFetch` | Fetch URL content / web search |
| `todo` | `TodoWrite` | Structured task-list management |

All aliases are documented as **case-insensitive**. MCP-server tools can additionally be referenced as `server-name/tool-name` or `server-name/*` for all tools from that server; out-of-box servers named in docs are `github` and `playwright`.

**Empirical corroboration on live CLI**: a disposable agent with `tools: ["not-a-real-tool"]` in frontmatter loaded and ran **without any visible error** (`ok` was printed as the model's reply) — consistent with the documented "unrecognized tool names are ignored" behavior. This means the CLI does **not** reject invalid tool identifiers at parse time; a Weave adapter cannot rely on CLI-side validation and must validate its own generated `tools:` arrays against the alias table above before writing `.agent.md` files.

**Unproven**: whether the CLI (as opposed to the cloud agent, which is the doc's primary subject) supports the exact same alias set 1:1, since the authoritative page is filed under the general "Custom agents configuration reference" without an explicit CLI/cloud-agent split for this specific table. Fallback: treat the alias table above as authoritative for the CLI too (same `.agent.md` format is shared, per `about-custom-agents`'s cross-reference), but revalidate against a future CLI version bump.

---

## 7. Model identifiers — CLI self-report vs. documented catalog

`--model` does not have a `--help`-listed enumeration flag, and passing an invalid value gives no candidate list:

```
$ copilot -p "ok" --model does-not-exist --allow-all-tools -s
Error: Model "does-not-exist" from --model flag is not available.
```

The default model actually in use was captured from the CLI's own log output (`~/.copilot/logs/process-*.log`):
```
[INFO] [rust:model_bindings::api_resolver] Using default model: claude-sonnet-5
```
and confirmed interactively: `I'm powered by Claude Sonnet 5 (model ID: claude-sonnet-5).`

**Unproven as a deterministic API**: asking the model itself to enumerate the full catalog (`copilot -p "List every AI model id..." -s`) returned a plausible-looking but **self-reported, non-verifiable** list including entries like `gpt-5.6-sol`, `kimi-k2.7-code`, `grok-4.6`, etc. This is model knowledge, not a CLI introspection API, and must not be trusted as ground truth.

**Fallback — cross-checked against GitHub Docs** (`.../reference/ai-models/supported-models`, fetched live), "Supported AI models in Copilot" table, filtered to the **Copilot CLI** column of "Supported AI models per client":

Anthropic: `Claude Haiku 4.5`, `Claude Opus 4.7`, `Claude Opus 4.8`, `Claude Opus 4.8 (fast mode) (preview)`, `Claude Opus 5`, `Claude Fable 5`, `Claude Fable 5.1`, `Claude Sonnet 4.6`, `Claude Sonnet 5`
Google: `Gemini 3.5 Flash`, `Gemini 3.6 Flash`, `Gemini 3.7 Flash`, `Gemini 3.8 Flash`
Microsoft: `MAI-Code-1.1-Flash`
OpenAI: `GPT-5 mini`, `GPT-5.3-Codex`, `GPT-5.4`, `GPT-5.4 mini`, `GPT-5.4 nano`, `GPT-5.5`, `GPT-5.6 Luna`, `GPT-5.6 Sol`, `GPT-5.6 Terra`, `GPT-6 Astra`
xAI: `Grok 4.5`, `Grok 4.6`
Moonshot AI: `Kimi K2.7 Code`, `Kimi K3`

These are **display names**, not confirmed lowercase-hyphenated CLI model-id strings (the `--model` flag's actual accepted string format — e.g. `claude-sonnet-5` was confirmed via the CLI log; other exact ID strings are **unproven**, only the display names are doc-confirmed). Notably the doc-confirmed display-name list and the model's self-reported ID list are consistent in substance (same model families/versions), which is reassuring but not a substitute for a real enumeration endpoint.

**Recommendation for the adapter**: do not hardcode a model allowlist from this spike. Use `claude-sonnet-5` (confirmed exact ID string) as the only ID-format-confirmed example, and treat `--model` value validation as adapter-side best-effort (pass through user's DSL `models` list verbatim; let the CLI's own `Error: Model "..." from --model flag is not available.` be the runtime validation surface).

---

## 8. Skill/command discovery directories under the user home

Checked for **existence and structure only** (contents never inspected/printed):

| Path | Status on this machine |
|---|---|
| `~/.copilot/` | **Exists** — contains `config.json`, `installed-plugins/` (empty dir), `installed-plugins.lock` (empty file), `logs/`, `servers/`, `session-state/`, `session-store.db*`, `ide/`, `sidebar-sessions-state/`, `command-history-state.json`, `open-sessions-state.json` |
| `~/.copilot/agents/` | Missing (not yet created — user-level custom agents dir, per docs) |
| `~/.copilot/skills/` | Missing (not yet created — user-level skills dir, per `copilot skill --help`) |
| `~/.config/github-copilot/` | Missing |
| `~/.agents/` | Missing |
| `~/.agents/skills/` | Missing |

Documented discovery locations (from `copilot skill --help` live output):
```
Skills are discovered from several sources:
  Project   .github/skills/, .agents/skills/, or .claude/skills/
  Personal  ~/.copilot/skills/ or ~/.agents/skills/
  Plugin    Installed plugins that bundle skills
  Custom    Directories added with `copilot skill add <directory>`
```
Documented custom-agent discovery locations (from `.../invoke-custom-agents` doc):
```
User-level:        ~/.copilot/agents/
Repository-level:  .github/agents/ (local + remote repo)
Organization-level: /agents/ in org .github or .github-private repo
Enterprise-level:   /agents/ in enterprise-designated .github-private repo
```
Precedence on name collision: user > repository > organization > enterprise (first match wins).

None of these personal directories existed before or after the spike; no writes were made to them.

---

## 9. Vendored schema

Fetched live:
```
$ curl -sS -o plugin-1.0.0.schema.json -w "HTTP:%{http_code}\n" \
    https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
HTTP:200
```
`$id` in the fetched document: `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` — matches the expected upstream identifier exactly. Copied verbatim (no edits) to:
```
packages/adapters/copilot/src/schemas/plugin-1.0.0.schema.json
```
Schema requires `$schema` (const, must equal the schema's own `$id` value less the trailing path difference — actually equal to the full schema URL) and `name` (pattern: 1–64 lowercase ASCII letters/digits/hyphens/periods, no `--` or `..`, must start/end with alphanumeric); `additionalProperties: false` at the top level; optional `version`, `description`, `author` (nested object, closed), `homepage`, `repository`, `license`, `keywords` (string array), and `extensions` (object keyed by reverse-domain namespace, each value an open object — this is the documented extension point for Copilot-specific `com.github.copilot` namespacing per the prior memory-vault research).

---

## 10. Summary of open questions — resolved / still open

| # | Question | Status |
|---|---|---|
| 1 | Exact non-interactive prompt-to-agent invocation | **Proven**: `copilot -p "<prompt>" --agent <name> --allow-all-tools -s`, doc-confirmed and CLI-reproduced, deterministic single-line stdout, exit 0 |
| 2 | `/agent` non-interactive listing | **Unproven as scriptable**; slash commands are answered from docs, not executed, in `-p`/`-i` non-interactive mode. **Fallback**: parse the `available:` suffix from the `No such agent: <bogus>, available: <comma-list>` error line |
| 3 | Confirmed `.agent.md` frontmatter fields | **Proven**: `name`, `description`, `tools`, `mcp-servers` all documented and (except `mcp-servers`'s happy path) empirically exercised; `mcp-servers: {}` silently drops the whole agent — noted as a real gotcha |
| 4 | Exact `tools:` allowlist | **Proven from docs** (alias table in §6); CLI does not validate values at parse time (invalid tool names silently ignored, not rejected) — **unproven** whether the CLI's actual runtime allowlist is identical to the cloud-agent doc table, since the source page doesn't explicitly split CLI vs. cloud agent for this table |
| 5 | Model ID allowlist | **Unproven as a hard list**: no CLI enumeration command exists; only one ID-format string is CLI-log-confirmed (`claude-sonnet-5`); doc-confirmed display names exist (§7) but their exact `--model`-flag ID strings are not independently confirmed beyond the one example |
| 6 | Skill/agent discovery directories | **Proven** from `copilot skill --help` and GitHub Docs; none exist yet on this machine; zero writes made |
| 7 | Marketplace subcommand help | **Proven**: `copilot plugin marketplace --help` documented above; direct installs work but are used only for evidence in the general architecture (not exercised live in this spike — no installs were performed) |

## Sources consulted (fetched live during this spike)

- `copilot --help`, `copilot plugin --help` (+ subcommands), `copilot plugins --help`, `copilot skill --help`, `copilot help commands`, `copilot help environment`, `copilot help providers`, `copilot help config`, `copilot mcp --help` — direct CLI invocation, GitHub Copilot CLI 1.0.83
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents
- https://docs.github.com/en/copilot/reference/custom-agents-configuration
- https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents
- https://docs.github.com/en/copilot/reference/ai-models/supported-models
- https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- Memory vault: `Weave/Copilot Desktop harness.md` (prior prototype-derived research, cross-referenced, not duplicated)
