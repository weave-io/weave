# Weave — Agent Guide

Weave is a harness-agnostic prompt and agent-configuration API: a `.weave` DSL declares agents, categories, workflows, prompts, delegation intent, model preferences, and settings; the engine normalizes that intent; adapters translate it into concrete configuration for OpenCode, Claude Code, Pi, or any future harness.

Think of it as Neovim's API layer. Weave supplies primitives; adapters and users compose them into a harness experience.

## Runtime

Bun only — runtime, package manager, test runner, bundler. Never use the Node.js runtime surface (`fs`, `child_process`, `@types/node`, `ts-node`). `node:path` and `node:os` are the exception; Bun implements them natively.

## Commands

```bash
bun install          # install all workspace deps
bun test             # run every package's tests
bun run typecheck    # tsc --noEmit across packages and scripts
bun run lint         # biome + declaration validation
bun run build        # build public packages and the docs site
bun run clean        # remove all dist/ folders
```

Two more worth knowing: `bun run validate-config` checks the project's `.weave` config, and `bun run docs:check-links` verifies documentation links.

## Layers

| Layer | Package | Responsibility |
| --- | --- | --- |
| Core | `@weaveio/weave-core` | DSL lexer, parser, AST, Zod validation, config types |
| Config | `@weaveio/weave-config` | Builtin DSL defaults, discovery, merge, prompt path resolution |
| Engine | `@weaveio/weave-engine` | Composition APIs, `HarnessAdapter` boundary, shared logger |
| Adapters | `@weaveio/weave-adapter-*` | Harness-specific translation |

Each of `packages/core`, `packages/engine`, and `packages/adapters` has its own `AGENTS.md` with rules that apply only inside it.

## Rules that apply everywhere

- **The boundary is the architecture.** The engine owns normalized intent; adapters own everything harness-specific. Before adding or changing an engine API, check the ownership matrix in [`docs/architecture/adapter-boundary.md`](docs/architecture/adapter-boundary.md).
- **Builtin agents are just DSL.** Loom, Tapestry, Shuttle and friends are declared in the same `.weave` config that users write, with no separate code path. If a builtin needs a behaviour the DSL cannot express, extend the DSL.
- **Failures are values.** Anything that can fail returns `Result` / `ResultAsync` from `neverthrow`, with a discriminated-union error type. Never throw on an expected path; never use `console.*`. See [`docs/contributing/typescript.md`](docs/contributing/typescript.md).
- **Schema change = test change, same commit.** DSL and schema edits need coverage at every layer, and boundary-crossing code is tested against mocks, never a live harness. See [`docs/contributing/testing.md`](docs/contributing/testing.md).
- **Adapters need real-harness proof.** An LLM must be able to verify that every adapter properly loads and works in its real harness; mocks and package imports alone are not enough. Follow [`docs/testing/adapter-verification.md`](docs/testing/adapter-verification.md).
- **Docs ship with the change.** A non-trivial change is not done until `docs/` reflects it. See [`docs/contributing/documentation.md`](docs/contributing/documentation.md).
- **Pull requests name their issue.** Always reference the related issue.

## Where to read next

[`docs/README.md`](docs/README.md) indexes the whole corpus. The usual starting points:

- [`docs/reference/dsl.md`](docs/reference/dsl.md) — the normative `.weave` syntax contract
- [`docs/architecture/product-vision.md`](docs/architecture/product-vision.md) — what the harness-agnostic design is for
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) — how config becomes harness behaviour
- [`docs/reference/prompts.md`](docs/reference/prompts.md) — prompt templates and the delegation section
- [`docs/architecture/adapter-boundary.md`](docs/architecture/adapter-boundary.md) — engine/adapter ownership and prohibited dependencies

Historical harness behavior does not override the product vision or the adapter boundary.
