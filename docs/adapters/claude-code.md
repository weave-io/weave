# Claude Code Adapter

> **Status:** Claude Code support is file materialization. It is bundled in
> `@weaveio/weave-cli`; the standalone `@weaveio/weave-adapter-claude-code`
> package is published to `nightly` only.

## Context

Weave normalizes `.weave` intent and the Claude Code adapter writes a generated
Claude Code plugin directory. This is deliberately not a claim of OpenCode
runtime parity: generated files cannot provide durable workflow scheduling,
lifecycle observation, idle continuation, compaction recovery, analytics, or
runtime-backed eval control.

## Decision

Users normally install the stable or nightly CLI and run:

```bash
weave compose --adapter claude-code --init
```

The CLI-bundled adapter generates agents, composed prompts, model aliases, and
tool lists under `.weave/plugins/claude-code/`. A small optional bootstrap
plugin reruns composition at session start. The standalone adapter is reserved
for nightly evaluation and uses the same materialization boundary.

The adapter owns Claude-specific file locations, model aliases, tool names,
and capability gaps. Internal core/config/engine workspace layers remain
bundled and are never consumer npm dependencies.

## Commands

The generated command files provide the plan-entry command only: `/weave:start`, with `/start-work` as a compatibility alias that behaves identically. Generated Claude Code markdown does not add a durable-workflow runtime surface, and it must not be read as one.

## Consequences

- Users must reload plugins or start a new session after generated files change.
- Explicit durable execution remains available only where an adapter has a real
  runtime integration; do not infer it from generated Claude command markdown.
- The public release record uses immutable versioned packs and SHA-256 files.
  `preview` is retired; install `latest`, `next` only for train verification,
  or `nightly` as appropriate. Published versions are never unpublished.

See [the practical Claude guide](claude-code.md),
[Adapter Boundary](../architecture/adapter-boundary.md), and [Release Automation](../contributing/releases.md).
