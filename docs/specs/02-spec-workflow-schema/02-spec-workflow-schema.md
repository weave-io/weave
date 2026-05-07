# 02-spec-workflow-schema

## Introduction/Overview

The `@weave/core` parser already handles `workflow` and `step` blocks structurally (delivered by issue #3), but the Zod schema layer treats workflows as `z.unknown()` — a deliberate placeholder. This spec replaces that placeholder with a fully typed `WorkflowConfigSchema` that validates step types, completion methods, artifact input/output references, and `on_reject` behaviour. After this work, `parseConfig()` will produce a typed `workflows` field in `WeaveConfig` with the same validation rigour as agents and categories.

## Goals

- **`WorkflowConfigSchema`**: Define a Zod schema that validates workflow blocks including description, version, and an ordered array of steps.
- **`WorkflowStepSchema`**: Define a Zod schema for individual steps with validated `type`, `agent`, `prompt`, `completion`, `inputs`, `outputs`, and `on_reject` fields.
- **Completion method validation**: Model the five completion methods (`agent_signal`, `user_confirm`, `plan_created`, `plan_complete`, `review_verdict`) with their associated parameters as a discriminated structure.
- **End-to-end pipeline**: Wire the new schemas through `validate.ts` so that `parseConfig()` returns typed `WorkflowConfig` records instead of `unknown`.
- **Type-safe exports**: Export all new Zod-inferred types and schemas from the `@weave/core` barrel.

## User Stories

- **As a framework contributor**, I want workflow blocks validated at parse time so that misconfigured steps (e.g. missing `agent`, invalid `type`) are caught before the engine attempts to run them.
- **As an end user**, I want clear error messages when my workflow has an invalid step type or completion method so I can fix my `.weave` config quickly.
- **As an engine developer**, I want a typed `WorkflowConfig` with fully validated steps so I can build the workflow runtime against concrete types instead of `unknown`.
- **As an adapter author**, I want typed `on_reject` behaviour and step types so I can map them to harness-specific execution patterns.

## Demoable Units of Work

### Unit 1: Workflow and Step Zod Schemas

**Purpose:** Define the Zod schemas that model the complete workflow block structure — workflows, steps, completion methods, artifact references, and rejection behaviour. This is the schema layer only; wiring into `validate.ts` comes in Unit 2.

**Functional Requirements:**

- The system shall export a `WorkflowStepTypeSchema` as `z.enum(["autonomous", "interactive", "gate"])`.
- The system shall export a `CompletionMethodSchema` that validates completion configurations. Each completion has a `method` field and optional parameters:
  - `agent_signal` — no additional parameters
  - `user_confirm` — no additional parameters
  - `plan_created` — requires `plan_name: string`
  - `plan_complete` — requires `plan_name: string`
  - `review_verdict` — no additional parameters
- The system shall export an `ArtifactRefSchema` as `z.object({ name: z.string(), description: z.string() })`.
- The system shall export an `OnRejectSchema` as `z.enum(["pause", "fail", "retry"])` to model gate step rejection behaviour.
- The system shall export a `WorkflowStepSchema` that validates individual steps with:
  - `name` (string, required) — the step's identifier, set from the block name
  - `display_name` (string, optional) — human-readable name via the `name` DSL property inside the step block
  - `type` (`WorkflowStepTypeSchema`, required)
  - `agent` (string, required) — name of the agent to execute this step
  - `prompt` (string, required) — instruction for the agent (may contain `{{template}}` placeholders)
  - `completion` (`CompletionMethodSchema`, required) — how the step signals completion
  - `inputs` (array of `ArtifactRefSchema`, optional) — artifacts consumed by this step
  - `outputs` (array of `ArtifactRefSchema`, optional) — artifacts produced by this step
  - `on_reject` (`OnRejectSchema`, optional, default `"pause"`) — behaviour when a gate step is rejected
- The system shall export a `WorkflowConfigSchema` that validates a complete workflow:
  - `name` (string, required) — set from the block name
  - `description` (string, optional)
  - `version` (positive integer, required)
  - `steps` (array of `WorkflowStepSchema`, min 1 — a workflow must have at least one step)
- The system shall apply a Zod refinement on `WorkflowStepSchema`: `on_reject` is only valid when `type` is `"gate"`. If `on_reject` is specified on a non-gate step, validation shall fail with a clear error message.
- The system shall export all inferred TypeScript types via `z.infer<>`: `WorkflowStepType`, `CompletionMethod`, `ArtifactRef`, `OnReject`, `WorkflowStep`, `WorkflowConfig`.

**Proof Artifacts:**

- **Test**: `packages/core/src/__tests__/schema.test.ts` — tests for `WorkflowStepSchema` (valid step, missing required fields, invalid step type, invalid completion method, `on_reject` on non-gate step rejected), `WorkflowConfigSchema` (valid workflow, empty steps rejected, missing version rejected). All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors.

### Unit 2: Validation Pipeline Integration and Completion Mapping

**Purpose:** Wire the new schemas into `validate.ts` so that the full `parseConfig()` pipeline produces typed `WorkflowConfig` records. Handle the AST-to-plain-object mapping for workflow-specific structures (especially the `completion` block, which has a unique DSL shape).

**Functional Requirements:**

- The system shall update `WeaveConfigSchema` to replace `workflows: z.record(z.string(), z.unknown()).optional()` with `workflows: z.record(z.string(), WorkflowConfigSchema).default({})`.
- The system shall update `validate.ts`'s `astToPlainObject` function to correctly transform workflow step AST nodes into the shape expected by `WorkflowStepSchema`. Specifically:
  - The step's block `name` (from the `step foo {` syntax) shall map to the `name` field.
  - The `name` property inside the step block (e.g. `name "Create implementation plan"`) shall map to `display_name`.
  - A bare `completion user_confirm` (identifier value) shall map to `{ method: "user_confirm" }`.
  - A block `completion plan_created { plan_name "{{instance.slug}}" }` shall map to `{ method: "plan_created", plan_name: "{{instance.slug}}" }`.
- The system shall update the barrel export (`index.ts`) to export all new schemas and types: `WorkflowStepTypeSchema`, `CompletionMethodSchema`, `ArtifactRefSchema`, `OnRejectSchema`, `WorkflowStepSchema`, `WorkflowConfigSchema`, and their inferred types.
- The system shall update the `WeaveConfig` inferred type so that `config.workflows` is `Record<string, WorkflowConfig>` instead of `Record<string, unknown>`.
- Existing tests that depend on the `WeaveConfig` type shall continue to pass without modification (the `workflows` field goes from `unknown` to typed, which is a non-breaking narrowing).

**Proof Artifacts:**

- **Test**: `packages/core/src/__tests__/validate.test.ts` — new test cases for: valid workflow with all step types round-trips through `validateSource()`, bare completion identifier parses correctly, block completion with parameters parses correctly, `on_reject` on a gate step accepted, `on_reject` on an autonomous step rejected, workflow with inputs/outputs validates correctly, missing required step fields produce clear errors.
- **Test**: `packages/core/src/__tests__/parse_config.test.ts` — new end-to-end test: a `.weave` source with a complete workflow (including `{{template}}` placeholders in prompts) passes through `parseConfig()` and produces a typed `WeaveConfig` with `workflows` containing fully validated steps.
- **CLI**: `bun run typecheck` passes with zero errors across the entire workspace.
- **CLI**: `bun test` passes all tests in `packages/core/`.

## Non-Goals (Out of Scope)

- **Workflow runtime execution** — How the engine executes workflows, manages step transitions, tracks state, or handles retries is engine-layer logic. This spec only validates the static configuration.
- **Template placeholder resolution** — `{{instance.goal}}`, `{{artifacts.plan_path}}`, and `{{instance.slug}}` are stored as literal strings. Runtime template resolution is an engine concern.
- **Cross-step artifact reference validation** — Validating that a step's `inputs` reference a `name` that appears in a prior step's `outputs` is a semantic check beyond Zod schema validation. This may be a future spec or an engine-time check.
- **Step ordering or dependency graph validation** — Validating that steps form a valid DAG or that dependencies are satisfiable is runtime logic.
- **Continuation, analytics, background settings schemas** — Other `z.unknown()` placeholders in `WeaveConfigSchema` are future specs.
- **Parser changes** — ~~The parser already handles `workflow` and `step` blocks structurally. No parser modifications are needed.~~ **Delivered as part of this spec:** A small parser enhancement was required — the `identifier { block }` pattern (e.g. `completion plan_created { plan_name "..." }`) is not supported by the current `#parseValue()` method. A targeted enhancement adds a named block value pattern that injects the identifier as a `__name` property into the resulting `BlockValue`. No new AST types are needed; this reuses the existing `BlockValue` node. See task 1.0 in the task list.
- **AST type changes** — The existing `WorkflowBlock`, `StepBlock`, and `BlockValue` AST types are sufficient. The `__name` convention uses the existing `Property` and `BlockValue` types with no structural changes.

## Design Considerations

No specific design requirements identified. This is a schema-layer change with no UI or UX surface.

## Repository Standards

- **Bun only** — runtime, test runner. No Node.js APIs.
- **`neverthrow`** — `validate()` already returns `Result<WeaveConfig, ValidationError[]>`. No new `Result` wrappers needed for schemas themselves (Zod's `safeParse` is used internally by `validate.ts`).
- **Zod** — schemas are the source of truth. All types via `z.infer<>`. Use `.refine()` for cross-field constraints. Use `.strict()` where appropriate to catch typos.
- **Barrel exports** — all new public API added to `packages/core/src/index.ts`.
- **JSDoc** — on every exported schema and type.
- **Tests** — `bun test`, co-located in `packages/core/src/__tests__/`.
- **Conventional Commits** — `feat(core): ...` for new schemas, `test(core): ...` for test additions.

## Technical Considerations

- **Completion method modelling**: The DSL has two syntactic forms for completion: a bare identifier (`completion user_confirm`) parsed as an `IdentifierValue`, and a named block (`completion plan_created { plan_name "..." }`) parsed as a key with an identifier value followed by a block. The `validate.ts` transform must normalise both forms into a uniform `{ method: string, ...params }` shape before Zod validation. The `CompletionMethodSchema` should use `z.discriminatedUnion` on the `method` field for precise error messages.
- **`on_reject` default**: The DSL example only shows `on_reject pause` on gate steps. The schema should default `on_reject` to `"pause"` for gate steps and reject it on non-gate steps via a `.refine()`. This matches the legacy system's behaviour where pausing was the default rejection action.
- **Step `name` vs `display_name` mapping**: The DSL has a collision: the parser uses `step plan { ... }` where `plan` becomes the step's block name, but steps also have a `name "..."` property inside the block. The transform in `validate.ts` should map the block name to `name` and the inner `name` property to `display_name` to avoid ambiguity. This is consistent with how agent blocks handle `name` (set from block identifier).
- **`version` as integer**: The schema should validate `version` as `z.number().int().positive()` since workflow versions should be whole numbers.
- **Backward compatibility**: Changing `workflows` from `z.unknown()` to `WorkflowConfigSchema` is a type narrowing. Existing code that passes `workflows` as `unknown` will now get type errors if it tries to access properties — this is intentional and desirable. Engine consumers should be updated to use the new types.
- **Existing `validate.ts` workflow transform**: The current `astToPlainObject` already maps workflow steps to `{ name, ...properties }`. This transform needs refinement to handle the `completion` block normalisation and the `name`/`display_name` disambiguation, but the structural scaffolding is in place.
- **Named block value parser pattern**: The parser's `#parseValue()` method is enhanced so that when an `Identifier` token is followed by `LBrace`, the identifier is consumed and the block is parsed, producing a `BlockValue` with the identifier injected as a synthetic `{ key: "__name", value: IdentifierValue }` property prepended to the block's properties. This is a general-purpose enhancement that enables `key identifier { ... }` syntax throughout the DSL, not just for completion methods.

## Security Considerations

No specific security considerations identified. Workflow schemas validate configuration structure only — no user input, no file I/O, no secrets handling.

## Success Metrics

- **Typed workflows**: `parseConfig()` returns `WeaveConfig` with `workflows: Record<string, WorkflowConfig>` containing fully validated, typed step arrays.
- **Error quality**: Invalid workflow configs produce Zod errors with paths like `workflows.secure-feature.steps.0.type` and human-readable messages.
- **All five completion methods**: `agent_signal`, `user_confirm`, `plan_created`, `plan_complete`, and `review_verdict` are individually testable and produce correct validated output.
- **Gate-only `on_reject`**: The refinement rejects `on_reject` on non-gate steps with a clear error.
- **Zero regressions**: All existing tests pass unchanged. `bun test` and `bun run typecheck` clean across the workspace.
- **DSL round-trip**: The complete workflow example from AGENTS.md parses through `parseConfig()` successfully and produces the expected typed output.

## Open Questions

- **Should `on_reject` support `"retry"` as a value?** The legacy system shows only `pause` in the DSL examples. Adding `"retry"` and `"fail"` proactively gives workflow authors more options, but these may not have engine-level support yet. Recommendation: include all three in the enum now (they're just schema values), and the engine can choose which to implement. The spec includes `"retry"` and `"fail"` alongside `"pause"`.
- **Should `completion` parameters allow template strings?** The DSL example shows `plan_name "{{instance.slug}}"` — a template placeholder inside a completion parameter. The schema stores this as a plain string. Should the schema validate the `{{ }}` syntax, or leave template resolution entirely to the engine? Recommendation: store as plain string, no template validation at the schema level — this is consistent with how `prompt` fields handle templates.
- **Should step `type` have a default?** The spec requires `type` explicitly. An alternative is defaulting to `"autonomous"` for steps without an explicit type. Recommendation: require it explicitly — workflow steps are high-stakes configuration and implicit defaults reduce readability.
