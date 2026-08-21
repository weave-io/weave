# `packages/adapters` — Agent Guide

Each adapter translates the engine's normalized plan into one concrete harness: OpenCode, Claude Code, or Pi. Adapters are where harness-specific knowledge is allowed to live.

Read [`docs/architecture/adapter-boundary.md`](../../docs/architecture/adapter-boundary.md) before changing an adapter interface or reaching into the engine. Per-harness detail lives in [`docs/adapters/`](../../docs/adapters/), [`docs/adapters/pi.md`](../../docs/adapters/pi.md), and [`docs/adapters/claude-code.md`](../../docs/adapters/claude-code.md).

## What adapters own

Harness resource discovery, available-model and selected-model lookup, skill file discovery and loading, concrete tool names, permission mapping, lifecycle event mapping, UI surfaces, and emulation of harness feature gaps.

Adapters supply harness context to the engine as explicit arguments. When an adapter wants the engine to do the discovering, the boundary is being crossed the wrong way.

## Capability honesty

An adapter declares only what its harness can actually do. See [`docs/reference/adapter-capabilities.md`](../../docs/reference/adapter-capabilities.md).

## Tests

Never start a real harness, write real files, or spawn real processes. Stub `Bun.file` with string fixtures and `Bun.spawn` with controlled output. See [`docs/contributing/testing.md`](../../docs/contributing/testing.md).
