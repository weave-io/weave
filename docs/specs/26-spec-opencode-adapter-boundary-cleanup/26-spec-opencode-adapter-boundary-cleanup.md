# 26-spec-opencode-adapter-boundary-cleanup.md

## Introduction/Overview

The OpenCode adapter slice has two maintainability boundary problems: the main subagent-spawn seam throws instead of returning repository-standard `ResultAsync` values, and CLI redaction logic duplicates the engine's canonical sensitive-key denylist. This spec defines a cleanup that makes adapter failures easier to compose safely and restores a single source of truth for redaction behavior.

## Goals

- Convert the OpenCode subagent spawn seam to repository-standard `ResultAsync` error handling.
- Remove duplicated sensitive-key denylist definitions across engine and CLI code.
- Preserve existing adapter behavior and policy enforcement while simplifying call-site composition.
- Keep error and redaction ownership in canonical layers so future changes do not drift.

## User Stories

- **As a maintainer**, I want adapter materialization failures returned as typed results so that callers can compose them without manual throw-to-result conversion.
- **As a maintainer**, I want one canonical redaction rule source so that security-sensitive key handling cannot drift between engine and CLI surfaces.
- **As a reviewer**, I want adapter and CLI boundary code to follow the same repository error-handling model used elsewhere.

## Demoable Units of Work

### Unit 1: Normalize Adapter Spawn Error Handling

**Purpose:** Make subagent materialization failures composable and consistent with repository standards.

**Functional Requirements:**
- The system shall change the OpenCode adapter subagent spawn flow to return `ResultAsync<void, OpenCodeAdapterError>` or an equivalent repository-standard typed result.
- The system shall preserve existing policy checks, reconcile behavior, translation behavior, and error discrimination.
- The system shall remove call-site wrappers whose only purpose is converting thrown adapter failures into results.
- The user shall be able to follow adapter error flow through linear result composition rather than mixed throwing and result-returning patterns.

**Proof Artifacts:**
- Diff: adapter spawn seam returns typed results and demonstrates removal of throw-based conversions.
- Test: adapter and workflow tests pass and demonstrate materialization failures still surface correctly.
- CLI: `bun run typecheck` succeeds and demonstrates call sites align with the new typed seam.

### Unit 2: Canonicalize Sensitive-Key Redaction Rules

**Purpose:** Ensure engine and CLI surfaces share one source of truth for denying sensitive field names.

**Functional Requirements:**
- The system shall reuse the engine's canonical denied-field helper or exported denylist in CLI runtime journal rendering.
- The system shall remove locally duplicated sensitive-key sets that can drift from engine behavior.
- The system shall preserve current redaction outcomes for already-covered sensitive fields.
- The system shall make adding a new denied field require a change in one canonical location.

**Proof Artifacts:**
- Diff: CLI redaction imports canonical engine helper or constant and demonstrates deletion of local denylist duplication.
- Test: runtime or journal-view tests pass and demonstrate sensitive fields remain redacted.

## Non-Goals (Out of Scope)

1. **New adapter capabilities**: This spec does not add new OpenCode adapter features.
2. **Cross-adapter API redesign**: This spec does not redesign all adapter interfaces unless a direct compatibility adjustment is required for the spawn seam cleanup.
3. **Broad runtime security redesign**: This spec does not change overall sanitization policy beyond canonicalizing the existing denylist source.

## Design Considerations

No specific design requirements identified.

## Repository Standards

- Follow the repository-wide `neverthrow` policy for fallible synchronous and asynchronous code.
- Keep logic in the canonical ownership layer: adapter failures in the adapter layer, sensitive-key policy in the engine sanitization layer.
- Prefer deleting wrapper code rather than preserving unnecessary conversion indirection.
- Keep tests mocked and isolated rather than requiring a live OpenCode process.

## Technical Considerations

- Context assessment found the adapter slice generally healthy, with the main seam issue concentrated in `spawnSubagent` and its callers.
- Context assessment also found a duplicated denylist in CLI runtime rendering that mirrors engine sanitizer behavior and risks future drift.
- No latest-standards research was needed because this is repository-internal boundary cleanup rather than a third-party integration design change.
- If export changes are needed from `@weave/engine`, keep them minimal and clearly documented.

## Security Considerations

- Preserve or strengthen current redaction behavior for sensitive keys in runtime and journal output.
- Proof artifacts shall avoid printing raw sensitive values even in test fixtures or screenshots.
- Ensure typed error normalization does not accidentally strip actionable security or policy-failure context from adapter errors.

## Success Metrics

1. **Error seam consistency**: OpenCode adapter spawn flow uses typed result composition end-to-end.
2. **Canonical redaction**: engine and CLI share one denylist source for sensitive-key filtering.
3. **Regression safety**: adapter and runtime tests pass with no redaction or policy-handling regressions.

## Open Questions

1. Should the canonical redaction helper be exported directly from the engine root barrel or from a narrower runtime module?
2. Are there any non-OpenCode call sites that should adopt the same seam pattern once this cleanup lands?
