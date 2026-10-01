# Claude Code Adapter

> **Status:** Claude Code support is file materialization. It is bundled in
> `@weaveio/weave-cli`; the standalone `@weaveio/weave-adapter-claude-code`
> package is also published on `latest` (stable), `next`, and `nightly` for
> integrations that need the adapter library directly.

## Context

Weave normalizes `.weave` intent and the Claude Code adapter writes a generated
Claude Code plugin directory. This is deliberately not a claim of OpenCode
runtime parity: generated files cannot provide durable workflow scheduling,
lifecycle observation, idle continuation, compaction recovery, analytics, or
runtime-backed eval control.

## Decision

Users normally install the CLI from `latest` (stable), `next`, or
`nightly`, then run:

```bash
weave compose --adapter claude-code --init
```

The CLI-bundled adapter generates agents, composed prompts, model aliases, and
tool lists under `.weave/plugins/claude-code/`. A small optional bootstrap
plugin reruns composition at session start. The standalone adapter uses the
same materialization boundary and is available on the same release channels
for integrations that need the library directly.

The adapter owns Claude-specific file locations, model aliases, tool names,
and capability gaps. It enforces no Claude Code version range: the host must
support the plugin directory, agent files, and generated command files.
Internal core/config/engine workspace layers remain bundled and are never
consumer npm dependencies.

## Models

Each agent's `models` list is tried in order, and the first entry Claude Code
can run is written to the agent's `model:` frontmatter as a tier. The allowlist
is `CLAUDE_CODE_AVAILABLE_MODELS` in
[`model-resolution.ts`](../../packages/adapters/claude-code/src/model-resolution.ts);
`MODEL_ALIAS_MAP` in
[`agent-translation.ts`](../../packages/adapters/claude-code/src/agent-translation.ts)
maps a dashed Anthropic ID such as `claude-opus-5-5` to its tier.

The tier names `opus`, `sonnet` and `haiku` are entries in their own right.
Claude Code maps each tier to its current model, so the adapter treats them as
always available and writes them through unchanged:

```weave
agent shuttle {
  models ["sonnet"]
}
```

They are what the `claude-code` section of the opt-in
[model recommendations](#model-recommendations) names.

## Model recommendations

A user who adds `settings { model_updates { mode auto } }` (or `notify`) opts
in to the signed model lists Weave publishes
([Spec 39](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md)).
On Claude Code a list fetched in one session applies at the next.

**Which entries.** `weave compose --adapter claude-code` loads config with
`loadConfigDetailed(..., { harness: "claude-code" })`, so the applied list's
`claude-code` section (else its `default` section) is merged ahead of the
builtin lists and behind the user's own `models`
([Config Loading](../config-loading.md#the-recommendations-layer),
[Model Resolution](../model-resolution.md#published-recommendations)). A
`claude-code` section names tiers, `opus`, `sonnet` or `haiku`, which Claude
Code maps to its current models itself, so a new Anthropic model reaches the
agents through Claude Code without a new list.

**When a list is fetched.** The bootstrap plugin's `SessionStart` hook
([`hooks.json`](../../packages/adapters/claude-code/src/bootstrap/hooks/hooks.json))
runs `weave compose --adapter claude-code`. Compose first writes the bundle
from whatever list is already applied, prints its summary, and only then calls
`ModelRecommendations.refresh()` once
([`compose-refresh.ts`](../../packages/cli/src/models/compose-refresh.ts)).
A manual `weave compose --adapter claude-code` does the same. With no
`model_updates` block or `mode off`, `refresh()` is not called and nothing is
read, written or fetched. The refresh keeps its own throttle: at most one
request a day, or an hour after a failed check; every other session start costs
one read of `state.json`. In `auto` mode a verified, newer list is promoted to
`applied.json`, which the next session's compose merges; in `notify` mode it
waits in `latest.json`.

**Why the hook waits for it, briefly.** The hook is a short-lived process and
Claude Code waits for it before the session starts. Compose awaits the refresh
with a tight bound rather than leaving it running or handing it to a detached
child:

- The request, body included, gets `COMPOSE_REFRESH_TIMEOUT_MS` (1.5 s)
  instead of the usual 5 s, and compose stops waiting after
  `COMPOSE_REFRESH_BUDGET_MS` (2 s), far inside the hook's 30 s timeout. The
  bound applies only when a check is due.
- The request is aborted at its own timeout, so nothing keeps the process
  alive past its normal exit, and the cache lock is released by the process
  that took it. A detached child would outlive the hook, could hold the lock
  after the session started, and would need to locate the `weave` executable
  again.
- A failed, slow or broken refresh never changes the exit code, which stays
  compose's own. On a slow link the check times out and is retried an hour
  later.

**What the user sees.** Stdout of a `SessionStart` hook is added to the
session's context, so it carries only compose's summary. For a user who opted
in, the summary says which lists the agents were composed from:
`Model lists: recommended (stable, issued …)`, `builtin (no stable
recommendations applied yet)`, or `builtin (stable recommendations skipped, see
above)`. Everything else goes to stderr, where compose reports its other config
problems: a `Warning:` line when an applied list cannot be used (unreadable,
unsigned, expired, …, and composition carries on with the builtin lists), a
note when a refresh applied a newer list or failed, and the structured logs.

## Commands

The generated command files provide the plan-entry command only: `/weave:start`, with `/start-work` as a compatibility alias that behaves identically. Generated Claude Code markdown does not add a durable-workflow runtime surface, and it must not be read as one.

## Provider acceleration is unsupported

Claude Code has a native fast mode through `/fast`, Option/Alt+O, and the Agent SDK's `settings.fastMode`. None of those belongs to this adapter's static file-materialization surface: subagent frontmatter has no fast-mode field, and hooks cover tool, session, and subagent events rather than provider request mutation and provider response evidence.

A descriptor's `fast true` therefore changes no generated file. The adapter encodes no frontmatter field, environment value, prompt instruction, or provider control, and generated agent or command markdown must not claim that acceleration was requested or applied. `provider-fast-activation` declares `unsupported` with runtime status `unsupported` and the bounded reason `harness-seam-unavailable`.

This is an optional-capability gap. Agent and command materialization continues unchanged. Raising Claude Code above `unsupported` requires a runtime Agent SDK integration with per-attempt response proof, or a new official materialization field with equivalent proof, verified in a real harness under [Adapter Readiness Status](../adapter-readiness-status.md).

## Consequences

- Users must reload plugins or start a new session after generated files change.
- Explicit durable execution remains available only where an adapter has a real
  runtime integration; do not infer it from generated Claude command markdown.
- The public release record uses immutable versioned packs and SHA-256 files.
  `preview` is retired; install `latest` for stable use, or choose `next` or
  `nightly` when you need those release channels. Published versions are never
  unpublished.

See [the practical Claude guide](claude-code.md) and [Adapter Boundary](../adapter-boundary.md).
