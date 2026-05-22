# 14-tasks-preserve-category-metadata.md

## Standards Evidence Table

| Source File | Read | Standards Extracted | Conflicts |
| --- | --- | --- | --- |
| `AGENTS.md` | yes | Use Bun only; use `neverthrow` for expected failures; engine owns normalized descriptors while adapters own harness-specific materialization; update docs for non-trivial architecture changes; mention related issue in PRs. | none |
| `README.md` | yes | Weave is TypeScript-first and harness-agnostic; engine provides pure composition APIs; standard commands include `bun run build`, `bun run typecheck`, and `bun run test`. | none |
| `CONTRIBUTING.md` | not found | No repository-level contribution guide present. | none |
| `.github/pull_request_template.md` | not found | No PR template present. | none |
| `package.json` | yes | Workspace scripts: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`; lint-staged runs Biome checks on TS/JS/JSON files. | none |
| `.github/workflows/ci.yml` | yes | CI installs with `bun install --frozen-lockfile`; then runs lint, typecheck, build, and test. | none |
| `packages/engine/README.md` | yes | Engine consumes validated config plus explicit adapter context; engine must not make harness-specific assumptions; `spawnSubagent()` receives normalized harness-agnostic intent. | none |
| `docs/adapter-boundary.md` | yes | Category shuttle descriptor generation is engine-owned; adapters own harness plugin/config generation and concrete routing; engine must not scan harness resources or query harness UI/runtime state. | none |

## Planning Assumptions

- Use `AgentDescriptor.category` as the public adapter-facing field name because it is concise and matches the existing prompt-template vocabulary.
- Keep prompt-template `CategoryInput` intentionally bounded to template-safe fields, and introduce or reuse a separate descriptor metadata shape when patterns are needed by adapters.
- Preserve category `patterns` as declared strings; do not expand globs or scan files in the engine.

## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/compose.ts` | Defines `AgentDescriptor`, `composeAgentDescriptor()`, and where descriptor category metadata should be attached. |
| `packages/engine/src/template-context.ts` | Defines bounded category prompt context, `agent.isCategory`, and `CategoryInput`. |
| `packages/engine/src/descriptors.ts` | Generates category shuttles and must preserve source category identity/config association. |
| `packages/engine/src/runner.ts` | Materializes generated shuttles, calls `composeAgentDescriptor()`, emits effects, and calls `spawnSubagent()`. |
| `packages/engine/src/run-agent-effects.ts` | Carries `AgentDescriptor` through `RunAgentEffect`; useful for checking effect metadata boundaries. |
| `packages/engine/src/index.ts` | Public engine exports; may need updates if new descriptor metadata types are exported. |
| `packages/engine/src/__tests__/compose.test.ts` | Prompt composition and descriptor tests for category metadata and template context. |
| `packages/engine/src/__tests__/descriptors.test.ts` | Generation tests for source category context, inherited behavior, disabled shuttles, and collisions. |
| `packages/engine/src/__tests__/runner.test.ts` | Runner tests for adapter materialization and `RunAgentEffect` metadata propagation. |
| `packages/engine/src/__tests__/mock-adapter.ts` | Mock adapter records `spawnSubagent()` descriptors for isolated runner tests. |
| `packages/engine/README.md` | Engine documentation for normalized descriptors and adapter-facing intent. |
| `docs/adapter-boundary.md` | Architecture boundary documentation for adapter use of category metadata. |
| `docs/product-vision.md` | Product-level documentation for categories, generated shuttles, and adapter translation. |
| `docs/specs/14-spec-preserve-category-metadata/14-spec-preserve-category-metadata.md` | Source specification and acceptance criteria for validation. |
| `docs/specs/14-spec-preserve-category-metadata/14-audit-preserve-category-metadata.md` | Planning audit report created after this task list. |

### Notes

- Keep tests alongside engine source in `packages/engine/src/__tests__/`.
- Prefer package-level checks while iterating, then run workspace-level CI equivalents before completion.
- Use Bun commands only; do not add Node-specific tooling or runtime APIs.
- Keep metadata normalized and harness-neutral; adapters may interpret patterns, but the engine must not expand them.

## Tasks

### [x] 1.0 Define category metadata on adapter-facing descriptors

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with assertions that a generated `shuttle-frontend` descriptor exposes category name `frontend`, optional description, patterns such as `src/components/**`, and category-derived identity.
- Typecheck: `bun run --filter '@weave/engine' typecheck` passes, demonstrating the public `AgentDescriptor` metadata type compiles for engine and adapter consumers.
- Review: diff for `packages/engine/src/compose.ts` shows descriptor metadata is normalized and contains no harness-specific routing fields, concrete tool names, or adapter-private state.

#### 1.0 Tasks

- [x] 1.1 Add a normalized category metadata type for adapter-facing descriptors in `packages/engine/src/compose.ts` or a nearby engine-owned type module.
- [x] 1.2 Add optional category metadata to `AgentDescriptor` using the planned `category` field name.
- [x] 1.3 Include source category name, optional description, declared patterns, and category-derived identity in the descriptor metadata shape.
- [x] 1.4 Ensure the metadata shape does not include harness-specific routing decisions, expanded file lists, concrete tool names, adapter-private state, or secrets.
- [x] 1.5 Export the metadata type from `packages/engine/src/index.ts` if adapter authors need to reference it directly.
- [x] 1.6 Add or update descriptor-composition tests proving the metadata shape is present for category shuttles and absent or explicitly non-category for regular agents.

### [x] 2.0 Preserve source category context during shuttle generation

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/descriptors.test.ts` passes with assertions that generated shuttles retain source category identity, description, and patterns while preserving base shuttle inheritance and category overrides.
- Test: `bun test packages/engine/src/__tests__/descriptors.test.ts` passes with disabled-shuttle and base-shuttle-disabled cases proving omitted shuttles do not emit stale category metadata.
- Test: `bun test packages/engine/src/__tests__/descriptors.test.ts` passes with collision coverage proving explicit `agent shuttle-{category}` conflicts still return `CategoryShuttleConflictError` with shuttle and category names.

#### 2.0 Tasks

- [x] 2.1 Update `packages/engine/src/descriptors.ts` so category shuttle generation records each generated shuttle's source category context in a typed, testable shape.
- [x] 2.2 Preserve existing base `shuttle` inheritance behavior for prompt, models, mode, skills, and tool policy defaults.
- [x] 2.3 Preserve category overrides for `models`, `temperature`, `prompt_append`, and merged `tool_policy`.
- [x] 2.4 Preserve existing disabled behavior for missing base shuttle, disabled base shuttle, and disabled generated shuttle names.
- [x] 2.5 Preserve existing explicit-agent collision behavior and `CategoryShuttleConflictError` result semantics.
- [x] 2.6 Extend `packages/engine/src/__tests__/descriptors.test.ts` to cover source category name, optional description, and patterns for generated shuttles without weakening existing regression tests.

### [x] 3.0 Wire category context into prompt composition

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with a category shuttle prompt rendering `{{agent.isCategory}}`, `{{category.name}}`, and `{{category.description}}` correctly.
- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes showing regular agents and the base `shuttle` agent are not treated as category-derived.
- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes showing base prompt content and category-specific `prompt_append` both survive composition.

#### 3.0 Tasks

- [x] 3.1 Update the composition path so generated category shuttles pass category context into `composeAgentDescriptor()`.
- [x] 3.2 Keep `CategoryInput` for prompt rendering bounded to safe template fields unless tests and docs justify an explicit addition.
- [x] 3.3 Ensure `agent.isCategory` renders `true` only for generated category shuttles.
- [x] 3.4 Ensure regular agents and the base `shuttle` render without category context or with an explicit non-category state according to existing renderer behavior.
- [x] 3.5 Add prompt-composition tests for `agent.isCategory`, `category.name`, `category.description`, and category `prompt_append` behavior.
- [x] 3.6 Confirm unknown or raw category fields remain unavailable to templates unless intentionally documented.

### [x] 4.0 Expose category metadata through runner effects and adapter materialization

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes with `MockAdapter.spawnSubagent()` assertions that `shuttle-frontend` receives category metadata and declared file patterns.
- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes with `onEffect` assertions that `RunAgentEffect.agentDescriptor` contains the same category metadata as the adapter descriptor.
- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes with assertions that regular agents either omit category metadata or expose an explicit non-category-derived state according to the chosen descriptor shape.

#### 4.0 Tasks

- [x] 4.1 Update `packages/engine/src/runner.ts` to track generated shuttle source category context alongside generated `AgentConfig` values.
- [x] 4.2 Pass the correct category context when composing generated category shuttle descriptors in `WeaveRunner.run()`.
- [x] 4.3 Ensure the descriptor passed to `adapter.spawnSubagent()` includes category metadata for generated category shuttles.
- [x] 4.4 Ensure `RunAgentEffect.agentDescriptor` carries the same category metadata without duplicating effect-specific category fields.
- [x] 4.5 Extend runner tests to assert `MockAdapter.spawnSubagent()` receives category name, optional description, patterns, and category-derived identity.
- [x] 4.6 Extend runner `onEffect` tests to assert effect descriptor metadata matches the spawned descriptor metadata.

### [x] 5.0 Document adapter usage and run quality gates

#### 5.0 Proof Artifact(s)

- Documentation: diff for `docs/adapter-boundary.md`, `docs/product-vision.md`, `packages/engine/README.md`, or a focused docs file explains how adapters should consume category name and patterns while keeping concrete routing adapter-owned.
- CLI: `bun run lint` passes, demonstrating formatting/lint rules are satisfied.
- CLI: `bun run typecheck` passes, demonstrating all workspace types compile.
- CLI: `bun run test` passes, demonstrating the full workspace test suite succeeds after category metadata changes.

#### 5.0 Tasks

- [x] 5.1 Update `docs/adapter-boundary.md` to state that the engine preserves category metadata on generated category shuttle descriptors and adapters own concrete routing/config generation.
- [x] 5.2 Update `packages/engine/README.md` or `docs/product-vision.md` with a concise description of the category metadata descriptor contract.
- [x] 5.3 Document that adapters may use declared `patterns` for harness routing, but the engine must not expand globs, scan files, or inspect harness-owned resources.
- [x] 5.4 Run `bun run lint` and capture the passing command output as the lint proof artifact.
- [x] 5.5 Run `bun run typecheck` and capture the passing command output as the typecheck proof artifact.
- [x] 5.6 Run `bun run test` and capture the passing command output as the regression proof artifact.
- [x] 5.7 Ensure the eventual pull request mentions issue #71.
