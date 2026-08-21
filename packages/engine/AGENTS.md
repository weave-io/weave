# `packages/engine` — Agent Guide

The engine composes normalized intent — prompts, descriptors, skill and model resolution, policy decisions, execution lifecycle — and hands it to adapters. It never touches a harness directly.

Before adding or changing an engine API, read [`docs/architecture/adapter-boundary.md`](../../docs/architecture/adapter-boundary.md) and check the ownership matrix.

## What the engine may own

`.weave` config loading, normalized descriptors, prompt composition, skill matching and filtering, model intent helpers, and abstract policy decisions.

## What the engine may not do

Scan harness-owned directories, query harness UI or runtime APIs, or register concrete harness callbacks. Engine APIs accept explicit harness context from the adapter and return normalized results.

## Tests

Every module here needs an isolated test file with all boundaries mocked. Reuse `src/__tests__/mock-adapter.ts`; prefer pure-function tests over orchestration tests where the API allows it. See [`docs/contributing/testing.md`](../../docs/contributing/testing.md).
