# Builtin Prompt Defaults SDD Spec

## TL;DR
> **Summary**: Create the SDD specification for issue #51 at `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`, covering replacement of placeholder builtin prompts, canonical builtin triggers, local override pruning, docs, and tests. This plan exists because Pattern is constrained to planning-only output; the spec itself must be written by a work agent.
> **Estimated Effort**: Short

## Context
### Original Request
Create a specification document for Weave issue #51 using the exact SDD structure, save it to `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`, and do not implement prompt or code changes.

### Key Findings
- `docs/specs/10-spec-builtin-prompt-defaults/` exists conceptually for the target spec but currently has no files.
- Recent specs use this SDD structure: `Introduction/Overview`, `Goals`, `User Stories`, `Demoable Units of Work`, `Non-Goals (Out of Scope)`, `Design Considerations`, `Repository Standards`, `Technical Considerations`, `Security Considerations`, `Success Metrics`, and `Open Questions`.
- `packages/config/src/builtins.ts` is the canonical shipped builtin declaration source and currently declares all 8 builtin agents without trigger inventories.
- `packages/config/prompts/{loom,tapestry,shuttle,pattern,thread,spindle,weft,warp}.md` are placeholder shipped prompts today.
- `packages/engine/src/compose.ts` composes prompt source plus generated `## Delegation` plus `prompt_append`; it evaluates tool policy separately and passes skills through without injecting them.
- `.weave/config.weave` and `.weave/prompts/*.md` currently mirror or override many builtin defaults for dogfooding; desired cleanup is delta-only local overrides, keeping true Shuttle and Weft overrides.
- Existing docs already define the `Composed Prompt` glossary term and document Markdown builtin prompt files, composer-owned delegation, skill-agnostic defaults, and canonical builtin defaults in `packages/config`.
- No latest-standards external research is needed because this is internal prompt/config architecture, not a third-party library/API feature.

## Objectives
### Core Objective
Produce an SDD spec for issue #51 that is directly executable by implementation agents and grounded in Weave's current builtin prompt composition contract.

### Deliverables
- [ ] SDD spec file at `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`.
- [ ] Scope assessment recorded in the spec: appropriately sized for SDD with 3 vertical slices.
- [ ] Clarification sufficiency line recorded in the spec: `Clarification status: sufficient - no questions file required`.
- [ ] Latest-standards research line recorded in the spec: no external latest-standards research needed.
- [ ] Demoable Units limited to 2-4 vertical slices with observable proof artifacts.
- [ ] Open questions section kept explicit and minimal.

### Definition of Done
- [ ] `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md` exists and follows the established SDD section order.
- [ ] Spec references issue #51 and all 8 builtin agents.
- [ ] Spec covers builtin prompt replacement, builtin trigger promotion, docs/tests, local prompt pruning, and `.weave/config.weave` delta cleanup.
- [ ] Spec includes acceptance proof for config-level non-placeholder/leakage-guard tests and engine-level composition smoke tests.
- [ ] Spec explicitly keeps model normalization out of scope.

### Guardrails (Must NOT)
- Do not implement prompt content, code, config, or tests while creating the spec.
- Do not introduce legacy XML prompt sections.
- Do not put Weave-repo implementation policy into shipped product-level builtin prompts.
- Do not make shipped builtin prompts depend on skills.
- Do not hand-maintain delegation tables in prompt files.
- Do not create an ADR for this issue.

## TODOs

- [ ] 1. Write the SDD spec scaffold
  **What**: Create `10-spec-builtin-prompt-defaults.md` using the established SDD headings and include the required workflow assessment statements near the top of `Introduction/Overview`.
  **Files**: `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`
  **Acceptance**: The file exists and includes `Introduction/Overview`, `Goals`, `User Stories`, `Demoable Units of Work`, `Non-Goals (Out of Scope)`, `Design Considerations`, `Repository Standards`, `Technical Considerations`, `Security Considerations`, `Success Metrics`, and `Open Questions` in that order.

- [ ] 2. Define the feature scope and non-goals
  **What**: Specify issue #51 as product-level builtin prompt default replacement plus builtin trigger promotion and local dogfood cleanup. Explicitly exclude model normalization, skill prompt injection, ADR creation, adapter-specific prompt behavior, new DSL syntax, and implementation work during spec creation.
  **Files**: `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`
  **Acceptance**: Goals and non-goals are concrete enough that an implementation agent can distinguish shipped defaults from local Weave repo policy.

- [ ] 3. Define 3 demoable vertical slices
  **What**: Use 3 demoable units: shipped builtin prompt defaults, builtin delegation triggers plus composition smoke coverage, and local dogfood cleanup plus docs. Keep proof artifacts observable through file checks, tests, and config validation.
  **Files**: `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`
  **Acceptance**: Demoable Units total 2-4 slices and each slice includes functional requirements plus proof artifacts.

- [ ] 4. Record repository standards and technical constraints
  **What**: Include Bun-only commands (`bun run validate-config`, `bun run build`, `bun test`, `bun run typecheck`, `bun run lint`), `neverthrow`, no `console.*`, docs-first expectations, schema/test sync, and engine/adapter boundary rules only where relevant to implementation of issue #51.
  **Files**: `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`
  **Acceptance**: Repository standards guide implementation without leaking Weave-repo policy into shipped builtin prompts.

- [ ] 5. Capture success metrics and open questions
  **What**: Define measurable success metrics around non-placeholder builtin prompts, no repo-policy leakage, generated delegation usefulness, local override pruning, and passing validation. Keep open questions minimal; likely none unless implementers need exact wording approved for each agent prompt.
  **Files**: `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`
  **Acceptance**: `Open Questions` either says no open questions or lists only implementation-neutral wording questions that do not block issue #51.

## Verification
- [ ] Confirm the written spec is the only changed file for this SDD planning task.
- [ ] Confirm the spec contains `Clarification status: sufficient - no questions file required` exactly.
- [ ] Confirm the spec says no latest-standards external research was needed.
- [ ] Confirm no prompt/code/config implementation changes were made.
- [ ] Confirm the target spec path is `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`.
