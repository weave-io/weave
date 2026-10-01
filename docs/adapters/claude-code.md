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
[model recommendations](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md)
names. `weave compose --adapter claude-code` loads config with
`loadConfigDetailed(..., { harness: "claude-code" })`, so a user who opts in gets
that section (else `default`) ahead of the builtin lists; a skipped file is
logged and composition carries on with the builtins
([Config Loading](../config-loading.md#the-recommendations-layer),
[Model Resolution](../model-resolution.md#published-recommendations)).

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
