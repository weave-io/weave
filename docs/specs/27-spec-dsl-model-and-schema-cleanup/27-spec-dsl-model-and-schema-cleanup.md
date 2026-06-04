# 27-spec-dsl-model-and-schema-cleanup.md

## Introduction/Overview

The core/config DSL slice has two maintainability problems: one configuration model promises workflow targeting that the grammar cannot actually express, and prompt-path validation logic is duplicated across multiple schemas. This spec defines a cleanup that aligns the model with the real DSL, removes phantom abstraction, and centralizes repeated schema invariants so future changes do not drift.

## Goals

- Align the `extend_before_plan` data model with the actual capabilities of the `.weave` grammar.
- Remove misleading or dead resolution paths that imply unsupported workflow targeting behavior.
- Centralize repeated schema refinements for prompt-related path safety and mutual exclusivity.
- Keep parser, validator, schema, and end-to-end tests synchronized with the corrected model.

## User Stories

- **As a maintainer**, I want the validated config model to represent what the DSL can truly express so that future features do not build on fake capability.
- **As a reviewer**, I want schema invariants expressed once so that path-safety rules cannot drift between config sections.
- **As a junior developer**, I want parser, validator, and tests to tell one coherent story about what `extend before-plan` means.

## Demoable Units of Work

### Unit 1: Align `extend_before_plan` With Real Grammar

**Purpose:** Remove or complete the unsupported per-workflow targeting abstraction.

**Functional Requirements:**
- The system shall determine whether `extend before-plan` supports only one default bucket or whether the grammar should be expanded to support named workflow targets.
- The system shall implement exactly one coherent model: either simplify the validated config to the current real capability or extend the grammar and parser so named workflow targeting is truly supported.
- The system shall remove fallback behavior that implies unsupported targeting semantics.
- The system shall update parser, validator, schema, and end-to-end tests together so the chosen behavior is demonstrated consistently.

**Proof Artifacts:**
- Test: schema, validate, parser, and parse-config tests pass and demonstrate one coherent `extend before-plan` model.
- Diff: removal of phantom default-key indirection or addition of true grammar support demonstrates the abstraction now matches reality.

### Unit 2: Centralize Prompt Path and Prompt Append Constraints

**Purpose:** Replace repeated prompt refinement blocks with shared schema helpers.

**Functional Requirements:**
- The system shall extract shared helpers for prompt path safety checks and prompt-versus-prompt-append mutual exclusivity rules.
- The system shall reuse the shared helpers across agent, category, workflow step, and workflow config schema definitions.
- The system shall preserve current validation behavior unless an intentional tightening is documented and covered by tests.
- The system shall avoid introducing helpers so generic that the rules become harder to read than the duplicated code they replace.

**Proof Artifacts:**
- Diff: duplicated refinement logic is replaced with shared schema helpers.
- Test: schema and parse-config tests pass and demonstrate unchanged or intentionally documented validation behavior.

### Unit 3: Remove Local Cast Noise and Sync Test Expectations

**Purpose:** Clean up small boundary inconsistencies that obscure the actual contract.

**Functional Requirements:**
- The system shall remove unnecessary discriminated-union casts in validator code where the switch branch already narrows the type.
- The system shall update misleading tests that currently assert model shapes the grammar cannot produce.
- The system shall keep repository guidance intact that schema changes require synchronized test changes across schema, validate, parser, and parse-config layers.

**Proof Artifacts:**
- Diff: unnecessary casts and misleading test fixtures are removed or corrected.
- Test: all affected core/config test layers pass together and demonstrate synchronized expectations.

## Non-Goals (Out of Scope)

1. **New DSL feature expansion beyond this boundary**: This spec does not add unrelated grammar features.
2. **Config merge redesign**: This spec does not revisit broader config loading or merge semantics.
3. **Prompt composition redesign**: This spec does not change template rendering or prompt-composition behavior beyond shared schema constraints.

## Design Considerations

No specific design requirements identified.

## Repository Standards

- Keep parser, schema, validator, and end-to-end tests in sync whenever the DSL model changes.
- Use explicit discriminated unions and `neverthrow` results rather than casts or silent fallback behavior.
- Prefer one canonical helper for repeated invariants instead of copying refinements across schemas.
- Update docs if the visible DSL contract changes or becomes easier to explain after cleanup.

## Technical Considerations

- Context assessment found the production source structurally healthy overall, with the main issues concentrated in the `extend_before_plan` model and duplicated schema refinements.
- No latest-standards research was needed because this work is an internal DSL consistency cleanup, not an external technology decision.
- If grammar expansion is chosen instead of simplification, document the user-facing syntax clearly and add end-to-end tests that prove the new syntax is truly supported.
- If simplification is chosen, delete the unsupported abstraction completely rather than leaving placeholder structures behind.

## Security Considerations

- Preserve prompt path safety validation so cleanup does not weaken protection against unsafe path references.
- Proof artifacts shall avoid embedding sensitive local-path information beyond repository-relative examples already used in tests.

## Success Metrics

1. **Model coherence**: parser, validator, schema, and end-to-end tests all reflect one consistent `extend before-plan` contract.
2. **Invariant centralization**: prompt-related path safety and exclusivity rules are implemented through shared helpers rather than repeated inline refinements.
3. **Review clarity**: no misleading fallback behavior or unnecessary casts remain in the affected boundary code.

## Open Questions

~~1. Is true per-workflow targeting valuable enough to justify grammar expansion, or is simplification the better code-judo move?~~
~~2. Should shared prompt-schema helpers live in `schema.ts` or a nearby focused helper module?~~

## Implementation Notes (Task 4)

**Decision: Simplify `extend_before_plan` to a single global bucket.**

The parser never set the optional `workflow?` field on `ExtendBeforePlanDirective` — the grammar has no syntax for per-workflow targeting. The validator was using a `"__default__"` sentinel key as a workaround. This phantom abstraction was removed:

- `ExtendBeforePlanDirective.workflow?` removed from `ast.ts`
- `WeaveConfig.extend_before_plan` changed from `Record<string, ExtendBeforePlan>` to a flat `ExtendBeforePlan` (`{ steps: string[] }`) in `schema.ts`
- Validator union-merges all `extend before-plan` directives into a single `steps` array
- Default is `{ steps: [] }` (empty steps, not empty object)

**Decision: Shared helpers in `packages/core/src/prompt-schema-helpers.ts`.**

Three helpers extracted:
- `refinePromptExclusive()` — `prompt` and `prompt_file` mutual exclusivity (agent-only)
- `refinePromptAppendExclusive()` — `prompt_append` and `prompt_append_file` mutual exclusivity
- `refinePromptFileSafe(field)` — path traversal protection for any `*_file` field

All four schemas (agent, category, workflow step, workflow config) now use these helpers instead of inline refinements.

**Unnecessary casts removed:** The `node as ExtendBeforePlanDirective` cast in `validate.ts` was removed — the `switch` branch already narrows `node.type` to `"extend_before_plan"`, so TypeScript knows the type without the cast. The `ExtendBeforePlanDirective` import was also removed from `validate.ts` since it's no longer needed.
