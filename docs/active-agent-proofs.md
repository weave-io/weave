# Active-agent proofs

One-command scripts that prove Weave's adapters actually work when built
from *this checkout* and installed into a real harness environment. Each
script is self-contained: it builds the adapter from source, installs it,
drives the real harness (or the real production materialization pipeline)
with a **non-empty user config**, and asserts a stack of concrete claims
about the observable surface.

Location: [`scripts/proof/`](../scripts/proof/). Shared toolkit:
[`scripts/proof/lib.sh`](../scripts/proof/lib.sh).

## What the proofs prove — honestly

Each proof runs against the same non-empty user config: an override of
Loom's temperature, a `disable` block hiding one builtin agent (`spindle`),
and a custom user agent (`proof-scout`) with an inline prompt. So each
proof exercises real Weave merge semantics end-to-end, not just the
builtin path.

### V1 opencode — full surface via `opencode debug config`

The V1 harness exposes a resolved-config introspection command
(`opencode debug config`). That lets the proof assert on essentially the
full observable surface:

1. `.default_agent == "loom"` — active-agent claim
2. All 7 remaining builtins present (`loom`, `shuttle`, `pattern`,
   `tapestry`, `thread`, `weft`, `warp`), AND `spindle` correctly absent
   (disable semantics honoured end-to-end)
3. `loom.mode == "primary"` — mode surface
4. `loom.permission` is a non-empty object with mapped tool-policy keys —
   tool policy translated through the adapter
5. `loom.prompt` is > 500 chars AND contains both the builtin header
   (`loom — Main Orchestrator`) AND the delegation section — proves
   Mustache templates + engine composition ran through the real harness
6. Both slash commands (`start-work`, `weave:start`) registered
7. User override applied: `loom.temperature == 0.42`
8. Custom user agent `proof-scout` materialized with its inline prompt
   visible in `.agent["proof-scout"].prompt`

**Requirements**: `bun`, `opencode` (v1.15+), `jq` on `PATH`. Hermetic
XDG_*_HOME sandbox so ambient user config can't contaminate the run. No
container. Runtime ~5s.

```bash
./scripts/proof/opencode-v1-active-agent.sh
```

### V2 opencode2 — bounded by V2's introspection gap

V2 has no `debug config` equivalent and its `ctx.agent.list()` returns
only a **summary shape** for **primary-mode** agents. See
[issue #165](https://github.com/weave-io/weave/issues/165) for the tracking
of what's missing. Concrete impact on this proof:

**What is checkable from V2's real CLI today**:

- Plugin setup + cleanup ran (lifecycle)
- `ctx.agent.list()` succeeded and returned a non-empty list
- Both primary-mode Weave builtins (`loom`, `tapestry`) present
- Both are Weave-owned (description starts with the V2 ownership marker)
- Both have a mode string

**What is NOT checkable via the real CLI today** (covered by V2 unit
tests against `MockPluginContext` in
[`packages/adapters/opencode2/src/__tests__/`](../packages/adapters/opencode2/src/__tests__/)):

- Subagent-mode Weave builtins (`shuttle`, `pattern`, `thread`, `spindle`,
  `weft`, `warp`) — not surfaced by `ctx.agent.list()`
- Tool-policy → permission mapping — `.permission` is `null` in the
  `ctx.agent.list()` summary shape
- Prompt composition end-to-end — `.prompt` is `null` in the summary shape

When V2 grows either an `opencode2 debug config` command or a richer
`ctx.agent.list()`, the V2 proof will be tightened to match V1 one-for-one.

**Requirements**: `bun`, `podman`. Pinned V2 SDK + CLI live in the
container. Runtime ~30s.

```bash
./scripts/proof/opencode-v2-active-agent.sh
```

### Claude Code — full surface via on-disk artifacts

Claude Code is **materialization-only**: no runtime plugin, no
introspection command. Plugins are consumed by pointing `claude
--plugin-dir` at a generated directory. So the proof drives the real
production `weave compose --adapter claude-code` pipeline end-to-end,
then asserts on the files the `claude` CLI would consume:

1. `.weave/plugins/claude-code/settings.json` `.agent == "loom"` — active
   agent marker
2. `.claude-plugin/plugin.json` `.name == "weave"` — plugin registration
3. 7 builtin `agents/*.md` files present (loom, shuttle, pattern,
   tapestry, thread, weft, warp), spindle correctly absent (disable
   honoured)
4. `loom.md` YAML frontmatter: `name: loom`, non-empty `description`,
   non-empty `tools` list
5. `loom.md` body contains the builtin prompt header AND the delegation
   section — Mustache + composition ran end-to-end through the real CLI
6. Both slash-command files present: `commands/start.md`,
   `commands/start-work.md`
7. Temperature override: strict claim if the adapter surfaces it in
   frontmatter, lenient fallback if it doesn't (this is a Claude Code
   frontmatter-schema limitation, not a Weave bug)
8. Custom user agent `proof-scout` materialized as `agents/proof-scout.md`
   with its inline prompt visible

**What this does NOT prove**: that the proprietary `claude` CLI actually
reads these files at session start. That would require an Anthropic-licensed
binary and a live LLM call — deliberately out of scope for a
deterministic, offline, free proof. The `settings.json` claim is our
contract with Claude Code; if Anthropic ever changes how it's consumed,
that becomes a paired docs + proof update.

**Requirements**: `bun`, `jq` on `PATH`. No `claude` binary needed.
Runtime ~3s.

```bash
./scripts/proof/claude-code-active-agent.sh
```

## The pattern

Every proof follows the same five-step shape, encoded in
[`scripts/proof/lib.sh`](../scripts/proof/lib.sh):

1. **Preflight** — `proof_require_bins` asserts every required binary is on
   `PATH`, failing fast with a specific message.
2. **Build** — `proof_build_adapter` does a targeted `bun build` of the
   adapter entry points into a known `dist/` directory, bundling
   `@weaveio/*` workspace deps and keeping harness SDKs external. Decoupled
   from the public-package release script.
3. **Stage** — `proof_make_project` creates a hermetic `mktemp -d` project.
   Each proof then overwrites `.weave/config.weave` with a **non-empty user
   config** exercising overrides, disables, and a custom agent, and writes
   any harness-specific install config pointing at the just-built plugin.
4. **Probe** — the harness's own **introspection command**, or (when the
   harness is materialization-only) the real production `weave` CLI. Never
   a session. Never an LLM. Deterministic, fast, offline, free.
5. **Assert** — stack of atomic `jq -e` filters or filesystem checks
   against the probe output. Each claim reports independently on failure
   and dumps a compact preview for diagnosis.

Adding a new-harness proof means writing a small script: preflight, build,
stage, probe, and a numbered stack of assertions. Everything mechanical
lives in the library. See `opencode-v1-active-agent.sh` as the canonical
example — it's the strongest of the three because opencode V1 has the
richest introspection surface.

## What the proofs still do NOT prove

Being honest about the ceiling of this pattern:

1. **Behaviour inside a real session.** No proof starts a session. Event
   hooks, deferred SDK reconciliation, session-scoped tool permissions,
   and command *execution* (as opposed to registration) are not exercised.
2. **Model resolution against a live provider catalog.** V2 unit tests
   cover `resolveModelContext`; the proofs don't verify that the resolved
   `providerID/modelID` triple is actually valid in a live opencode
   session.
3. **Prompt content matches expectations semantically.** We check that
   composition ran (header + delegation section present) but not that the
   prompt is *good*.
4. **Claude Code actually consumes the generated files.** Deliberately out
   of scope (proprietary binary, LLM cost). See the note in the Claude
   Code section.
5. **Regression from upstream harness changes we haven't pinned.** V1
   installs `opencode-ai@^1.15` in CI; if 1.15+ silently changes semantics,
   we'll catch it. V2 pins to `beta-19151` explicitly; a beta bump won't be
   tested until we bump the pin.

For 1–3, the closest closable gap would be a real-session smoke test with
a cheap model and a budget guard. See the discussion in the PR that
introduced these proofs for the design conversation.

## CI

All three proofs run on every PR that touches an adapter, the engine,
config, core, the CLI, or the proof scripts — see
[`.github/workflows/proof-active-agent.yml`](../.github/workflows/proof-active-agent.yml).
Three jobs, three colour: `proof-v1` (plain Ubuntu, installs `opencode-ai`
from npm), `proof-v2` (Podman, mirrors `verify-opencode2.yml`),
`proof-claude-code` (plain Ubuntu, drives real `weave compose`).
