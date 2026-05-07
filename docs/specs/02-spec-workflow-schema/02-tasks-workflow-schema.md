# 02-tasks-workflow-schema

## Relevant Files

| File                                               | Why It Is Relevant                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/schema.ts`                      | Add all new workflow/step Zod schemas; replace `z.unknown()` placeholder.                                          |
| `packages/core/src/parser.ts`                      | Enhance `#parseValue()` to handle the `identifier { block }` pattern needed for `completion plan_created { ... }`. |
| `packages/core/src/validate.ts`                    | Wire workflow AST → plain object transform with completion normalisation and name/display_name disambiguation.     |
| `packages/core/src/index.ts`                       | Export new schemas and inferred types from barrel.                                                                 |
| `packages/core/src/__tests__/schema.test.ts`       | New file — dedicated schema-level unit tests.                                                                      |
| `packages/core/src/__tests__/parser.test.ts`       | Add tests for the named block value parser enhancement.                                                            |
| `packages/core/src/__tests__/validate.test.ts`     | Add workflow validation tests (completion mapping, on_reject, required fields).                                    |
| `packages/core/src/__tests__/parse_config.test.ts` | Add end-to-end tests with full AGENTS.md workflow examples.                                                        |
| `docs/specs/02-spec-workflow-schema/`              | Spec lives here; doc deliverable will also land here or in `docs/`.                                                |

### Notes

- Unit tests are co-located in `packages/core/src/__tests__/` following existing convention.
- Use `bun test` as the test runner, `bun run typecheck` for type checking.
- Follow `neverthrow` Result types for any new fallible functions.
- All new types must be derived from Zod schemas via `z.infer<>`.
- The parser enhancement (task 1.0) is a prerequisite discovered during planning — the spec assumed no parser changes, but the `completion method { params }` DSL syntax requires it.

## Tasks

### [x] 1.0 Parser Enhancement: Named Block Value Pattern

Enhance the parser's `#parseValue()` method to handle the `identifier { block }` pattern, producing a `BlockValue` with the identifier injected as a `__name` property. This is required for `completion plan_created { plan_name "..." }` syntax and is a general-purpose enhancement.

**Context:** The current parser handles `key identifier` and `key { block }` but NOT `key identifier { block }`. The DSL examples in AGENTS.md require this pattern for parameterised completion methods.

#### 1.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/parser.test.ts` — new tests for the named block value pattern: `completion plan_created { plan_name "x" }` produces a `BlockValue` with `__name` property, bare `completion user_confirm` still produces `IdentifierValue`, nested named blocks work. All pass via `bun test packages/core/src/__tests__/parser.test.ts`.
- CLI: `bun run typecheck` passes with zero errors.

#### 1.0 Tasks

- [x] 1.1 In `packages/core/src/parser.ts`, update `#parseValue()`: after consuming an `Identifier` token (and handling boolean conversion), peek at the next token. If it is `LBrace`, parse the block via `#parseBlockLiteral()` and return a `BlockValue` whose `properties` array is prepended with a synthetic `{ key: "__name", value: IdentifierValue, pos }` entry followed by the block's own properties.
- [x] 1.2 In `packages/core/src/__tests__/parser.test.ts`, add a new `describe("Parser — named block value")` section with tests: (a) `completion plan_created { plan_name "x" }` inside a step produces a property with key `completion` and a `BlockValue` containing `__name`, `plan_name` properties; (b) `completion user_confirm` (no block) still produces an `IdentifierValue`; (c) the pattern works for non-completion properties too (general purpose).
- [x] 1.3 Run `bun test packages/core/src/__tests__/parser.test.ts` — all existing + new tests pass. Run `bun run typecheck` — zero errors.

---

### [x] 2.0 Define Workflow and Step Zod Schemas

Add all new Zod schemas to `packages/core/src/schema.ts` and replace the `z.unknown()` workflow placeholder with the typed schema.

#### 2.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/schema.test.ts` — dedicated schema-level tests for each new schema (valid inputs accepted, invalid inputs rejected with correct error paths). All pass via `bun test packages/core/src/__tests__/schema.test.ts`.
- CLI: `bun run typecheck` passes with zero errors.

#### 2.0 Tasks

- [x] 2.1 In `packages/core/src/schema.ts`, add `WorkflowStepTypeSchema` as `z.enum(["autonomous", "interactive", "gate"])`.
- [x] 2.2 Add `CompletionMethodSchema` using `z.discriminatedUnion("method", [...])` with five variants: `agent_signal` (no extra fields), `user_confirm` (no extra fields), `plan_created` (requires `plan_name: z.string()`), `plan_complete` (requires `plan_name: z.string()`), `review_verdict` (no extra fields).
- [x] 2.3 Add `ArtifactRefSchema` as `z.object({ name: z.string(), description: z.string() })`.
- [x] 2.4 Add `OnRejectSchema` as `z.enum(["pause", "fail", "retry"])`.
- [x] 2.5 Add `WorkflowStepSchema` as a `z.object({ name: z.string(), display_name: z.string().optional(), type: WorkflowStepTypeSchema, agent: z.string(), prompt: z.string(), completion: CompletionMethodSchema, inputs: z.array(ArtifactRefSchema).optional(), outputs: z.array(ArtifactRefSchema).optional(), on_reject: OnRejectSchema.optional() })` with a `.refine()` that rejects `on_reject` when `type` is not `"gate"`.
- [x] 2.6 Add `WorkflowConfigSchema` as `z.object({ name: z.string().optional(), description: z.string().optional(), version: z.number().int().positive(), steps: z.array(WorkflowStepSchema).min(1) })`.
- [x] 2.7 Replace `workflows: z.record(z.string(), z.unknown()).optional()` in `WeaveConfigSchema` with `workflows: z.record(z.string(), WorkflowConfigSchema).default({})`.
- [x] 2.8 Add inferred type exports: `WorkflowStepType`, `CompletionMethod`, `ArtifactRef`, `OnReject`, `WorkflowStep`, `WorkflowConfig`.
- [x] 2.9 Add JSDoc comments on every new exported schema and type.
- [x] 2.10 Create `packages/core/src/__tests__/schema.test.ts` with tests: (a) valid `WorkflowStepSchema` with all required fields accepted; (b) missing required fields rejected with correct paths; (c) invalid `type` value rejected; (d) each of the five `CompletionMethodSchema` variants accepts valid input; (e) invalid completion method rejected; (f) `on_reject` on non-gate step rejected by refinement; (g) `on_reject` on gate step accepted; (h) valid `WorkflowConfigSchema` accepted; (i) empty `steps` array rejected; (j) missing `version` rejected; (k) non-integer `version` rejected.
- [x] 2.11 Run `bun test packages/core/src/__tests__/schema.test.ts` — all pass. Run `bun run typecheck` — zero errors.

---

### [x] 3.0 Wire Completion Mapping and Workflow Transform in Validator

Update `packages/core/src/validate.ts` to correctly transform workflow step AST nodes into the shape expected by the new schemas. Handle the two completion forms, name/display_name disambiguation, and identifier-to-string coercion for `agent` and `type`.

#### 3.0 Proof Artifact(s)

- Test: new cases in `packages/core/src/__tests__/validate.test.ts` — valid workflow round-trips through `validateSource()`, bare completion and block completion both produce correct `CompletionMethod` shape, `on_reject` gate/non-gate validation, missing required step fields produce clear error paths. All pass via `bun test packages/core/src/__tests__/validate.test.ts`.

#### 3.0 Tasks

- [x] 3.1 In `packages/core/src/validate.ts`, add a `transformStepProperties()` helper function that takes a step's `Property[]` and block name and returns a plain object shaped for `WorkflowStepSchema`. This function must: (a) set `name` from the step block's name (e.g. `step plan { }` → `name: "plan"`); (b) if an inner `name` property exists, map it to `display_name`; (c) for the `completion` property: if the value is an `IdentifierValue`, produce `{ method: identifierValue }`; if the value is a `BlockValue` (with `__name` from the parser), produce `{ method: __nameValue, ...otherBlockProps }`.
- [x] 3.2 Update the `case "workflow"` branch in `astToPlainObject()` to use `transformStepProperties()` for each step instead of the current `{ name: s.name, ...propertiesToObject(s.properties) }`.
- [x] 3.3 In `packages/core/src/__tests__/validate.test.ts`, add a new `describe("validate — workflows")` section with tests: (a) valid workflow with `completion user_confirm` (bare identifier) round-trips correctly; (b) valid workflow with `completion plan_created { plan_name "x" }` (named block) round-trips correctly, producing `{ method: "plan_created", plan_name: "x" }`; (c) workflow step with `on_reject pause` on a gate step accepted; (d) workflow step with `on_reject pause` on an autonomous step rejected; (e) workflow step missing required `agent` field produces clear error path like `workflows.test.steps.0.agent`; (f) workflow with inputs/outputs arrays validates correctly; (g) step `name` property maps to `display_name`, block name maps to `name`.
- [x] 3.4 Run `bun test packages/core/src/__tests__/validate.test.ts` — all existing + new tests pass.

---

### [x] 4.0 End-to-End Pipeline Tests with Full Workflow DSL

Add end-to-end tests that parse the complete workflow examples from AGENTS.md through `parseConfig()` and verify the full typed output.

#### 4.0 Proof Artifact(s)

- Test: new cases in `packages/core/src/__tests__/parse_config.test.ts` — `secure-feature` and `quick-fix` workflows from AGENTS.md parse end-to-end, producing correct typed `WeaveConfig.workflows`. All pass via `bun test packages/core/src/__tests__/parse_config.test.ts`.
- CLI: `bun test packages/core/` — all tests pass (80 existing + all new).
- CLI: `bun run typecheck` — zero errors across the entire workspace.

#### 4.0 Tasks

- [x] 4.1 In `packages/core/src/__tests__/parse_config.test.ts`, add a new `describe("parseConfig — workflows")` section.
- [x] 4.2 Add test: `secure-feature` workflow from AGENTS.md (4 steps: plan, review-plan, implement, security-review) parses through `parseConfig()` and produces `config.workflows["secure-feature"]` with correct `version`, `description`, 4 typed steps with correct `type`, `agent`, `prompt`, `completion` (including parameterised `plan_created`/`plan_complete`), `inputs`, `outputs`, and `on_reject`.
- [x] 4.3 Add test: `quick-fix` workflow from AGENTS.md (2 steps: fix, review) parses end-to-end with correct `agent_signal` and `review_verdict` completion methods and `on_reject pause` on the gate step.
- [x] 4.4 Add test: workflow with invalid step type → `parseConfig()` returns `err` with `ValidationError`. Add test: workflow with malformed completion block (`completion { plan_name "x" }` — block-style with no method identifier) → `parseConfig()` returns `err` with `ValidationError` because `method` is missing from the discriminated union.
- [x] 4.5 Add test: workflow mixed with agents and categories in the same source parses correctly — workflows go to `config.workflows`, agents go to `config.agents`.
- [x] 4.6 Run `bun test packages/core/` — all tests pass. Run `bun run typecheck` — zero errors across workspace.

---

### [x] 5.0 Update Barrel Exports and Downstream Type Consumers

Export all new schemas and types from `packages/core/src/index.ts`. Verify downstream packages compile cleanly with the narrowed `workflows` type.

#### 5.0 Proof Artifact(s)

- CLI: `bun run typecheck` passes with zero errors across the entire workspace.
- CLI: `bun run build` succeeds for all packages.
- CLI: `bun test` passes all tests across all packages.

#### 5.0 Tasks

- [x] 5.1 In `packages/core/src/index.ts`, add type exports: `WorkflowStepType`, `CompletionMethod`, `ArtifactRef`, `OnReject`, `WorkflowStep`, `WorkflowConfig`.
- [x] 5.2 In `packages/core/src/index.ts`, add schema exports: `WorkflowStepTypeSchema`, `CompletionMethodSchema`, `ArtifactRefSchema`, `OnRejectSchema`, `WorkflowStepSchema`, `WorkflowConfigSchema`.
- [x] 5.3 Run `bun run typecheck` for the full workspace. If engine or adapter packages have type errors from the `workflows` type narrowing (`unknown` → `WorkflowConfig`), fix them (expected: none based on codebase review — no downstream code accesses `workflows` yet).
- [x] 5.4 Run `bun run build` — all packages build successfully.
- [x] 5.5 Run `bun test` — all tests pass across all packages.

---

### [x] 6.0 Documentation Update

Update or create documentation reflecting the workflow schema design decisions, field semantics, and completion method model.

#### 6.0 Proof Artifact(s)

- File: new or updated doc in `docs/` describing workflow schema design: field semantics, completion method discriminated union model, `on_reject` gate-only constraint, name/display_name mapping, and the `__name` parser convention for named block values.
- File: doc is linked from `docs/specs/01-spec-core-dsl/01-spec-core-dsl.md` (resolves the open question about workflow validation depth).

#### 6.0 Tasks

- [x] 6.1 Create `docs/workflow-schema.md` documenting: (a) the workflow and step schema fields with descriptions; (b) the five completion methods and their parameters; (c) the `on_reject` gate-only constraint and default; (d) the name/display_name mapping convention for steps; (e) the `__name` named block value parser pattern and why it exists; (f) cross-links to `packages/core/src/schema.ts` and the spec.
- [x] 6.2 In `docs/specs/01-spec-core-dsl/01-spec-core-dsl.md`, update the "Open Questions" section to note that workflow validation depth is now covered by spec 02 and link to `docs/workflow-schema.md`.
- [x] 6.3 In `docs/specs/02-spec-workflow-schema/02-spec-workflow-schema.md`, update the "Non-Goals" section to note that a small parser enhancement was required (named block value pattern) and was delivered as part of this work, contrary to the original assumption.
