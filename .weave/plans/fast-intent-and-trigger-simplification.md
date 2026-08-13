# Fast Intent and Trigger Simplification

## TL;DR

Replace structured delegation triggers and category file patterns with portable `string[]` triggers, and add exact `fast true` intent to agents and categories. Carry intent through core and engine without provider terms, implement only provider mappings and evidence claims proven against current official contracts, and report unsupported adapters honestly.

## Context and evidence

- [user] Add exact DSL `fast true` to agents and categories. Absence preserves provider defaults; the DSL must not use `service_class`, `speed`, `variant`, or `priority`.
- [user] Keep `triggers`, but change it from `{ domain, trigger, routing_hint? }[]` to `string[]` and support it on agents and categories.
- [user] Remove category `patterns` completely. Do not rename it, preserve it as inert metadata, or add deterministic file routing.
- [user] Never report fast mode as applied unless adapter/provider evidence supports that claim.
- [repo: packages/core/src/schema.ts — `DelegationTriggerSchema`, `AgentConfigSchema`, `CategoryConfigSchema`] Agent triggers use the structured object schema. Categories require non-empty `patterns` and have no triggers or fast field.
- [repo: packages/core/src/ast.ts — `BooleanValue`; packages/core/src/parser.ts — `#parseNamedBlock()`; packages/core/src/validate.ts — `astValueToPlain()`] The generic language pipeline already represents and converts booleans. The schema is the enforcement point, but lexer, parser, AST, schema, and validator coverage must change with the DSL contract.
- [repo: packages/engine/src/descriptors.ts — `generateCategoryShuttles()`] Generated category shuttles force `triggers: []` and copy category patterns.
- [repo: packages/engine/src/compose.ts — `CategoryMetadata`, `AgentDescriptorCategory`, `AgentDescriptor`, `DelegationTarget`, `buildDelegationTargets()`] The normalized boundary copies category patterns and already carries target triggers. It has no neutral fast intent.
- [repo: packages/engine/src/template-context.ts — `projectDelegationTarget()`; packages/config/prompts/loom.md] Prompt projection derives domains and structured trigger objects, while Loom renders only `routing_hint`. The renderer already supports scalar list items through `{{.}}` in `packages/engine/src/template-renderer.ts`.
- [repo: packages/config/src/merge.ts — `mergeValues()`, `mergeConfigsResult()`] Scalars use higher-priority last-defined-wins behavior. Arrays use ordered union merge. Fast and string trigger precedence need explicit tests.
- [repo: packages/cli/src/migration/legacy-jsonc-converter.ts — `convertLegacyJsonc()`, `convertLegacyCategory()`] The legacy converter warns and skips unsupported agent triggers, requires category patterns, and emits `patterns [...]`.
- [repo: packages/engine/src/capability-contract.ts — `CapabilityIdSchema`; adapter `capability-declarations.ts`] `model-thinking-activation` is the precedent for neutral intent with adapter-specific native, degraded, or unsupported readiness.
- [repo: packages/adapters/pi/src/types.ts; packages/adapters/pi/src/extension.ts] Pi host types use a generic event registration surface. Provider request, header, and response hooks are not yet wired.
- [repo: Pi `docs/extensions.md` sections `before_provider_headers`, `before_provider_request`, `after_provider_response`; Pi `examples/extensions/provider-payload.ts`] The installed host contract permits in-place header edits, replacement of the current provider payload, and observation of response status and normalized headers. Payload handlers run in extension order, so Weave must preserve earlier edits rather than rebuild payloads.
- [repo: packages/adapters/pi/src/child-control-bodies.ts — `BootstrapCommonShape`, `OrdinaryBootstrapBodySchema`, `DirectStepBootstrapBodySchema`, `parseControlBody()`; packages/adapters/pi/src/extension.ts — `PiChildBootstrapCommon`, `buildChildBootstrapBody()`, `applyChildBootstrap()`] Ordinary and direct children use strict, bounded, authenticated bootstrap bodies. Their local trigger validator still expects structured triggers.
- [repo: packages/adapters/pi/src/primary-session.ts — `PiActivePrimary`, `PiPrimarySession.activate()`; packages/adapters/pi/src/direct-dispatch.ts — `PiDirectDispatchInput`; packages/adapters/pi/src/direct-dispatch-transport.ts — `PiDirectStepBootstrap`; packages/adapters/pi/src/workflow-controller.ts] Primary, ordinary-child, and direct-step state paths all need the same effective fast intent.
- [repo: packages/adapters/opencode/src/translate-agent.ts — `translateAgent()`; packages/adapters/opencode/src/adapter.ts — `OpenCodeAdapter`; packages/adapters/opencode/src/sdk-types.ts] OpenCode materializes translated agent configuration but has no repository-proven per-request mutation or response-evidence seam.
- [repo: packages/adapters/claude-code/src/model-resolution.ts — `buildClaudeCodeModelInput()`; packages/adapters/claude-code/src/agent-translation.ts — `translateAgentToMarkdown()`] Claude Code is a static translation surface; its thinking capability already reports unsupported when no invocation seam exists.
- [repo: packages/engine/src/runtime/journal-writer.ts — `RuntimeJournalWriter`; packages/engine/src/runtime/sanitizer.ts; packages/adapters/pi/src/extension.ts — `renderStatusMessage()`] Runtime reporting can store bounded, sanitized evidence. It must not persist raw provider payloads, headers, prompts, completions, credentials, or tokens.
- [repo: docs/architecture/adapter-boundary.md] Core and engine own portable intent. Adapters own provider payloads, headers, activation, runtime probes, and feature-gap handling. Static capability declarations are ceilings, and runtime evidence can only lower readiness.
- [repo: docs/testing/adapter-verification.md] Adapter changes require packed-artifact inspection, exact-byte installation, a fresh harness process, health/readiness proof, real behavior, and leak-free settlement. A missing live proof is a blocker, not support evidence.

## Scope

- In scope:
  - [user] Agent and category DSL/schema changes for `fast true` and `triggers string[]`.
  - [user] Complete removal of category patterns from config, normalized descriptors, prompt context, adapters, fixtures, tests, and documentation.
  - [user] Config merge behavior, legacy conversion, breaking migration notes, capability declarations, Pi primary and child propagation, safe request/header mutation, response evidence, status/runtime reporting, adapter investigation, tests, docs, reviews, and real-harness proof.
  - [repo: packages/core/AGENTS.md] Lexer, parser, AST, schema, validator, and all four language-test layers move together with the DSL contract.
- Out of scope:
  - [user] Deterministic file routing or any replacement for category patterns.
  - [user] Provider-specific terms in the DSL or neutral descriptor model.
  - [user] Claims that fast mode was applied based only on declaration, capability ceiling, attempted mutation, or request mutation.
  - [proposed] Support for providers or models that the first research task cannot place on an official allowlist with request and response contracts.
- Constraints:
  - [repo: AGENTS.md] Use Bun only. Return typed `Result`/`ResultAsync` failures for expected paths. Do not use `console.*`.
  - [repo: docs/architecture/adapter-boundary.md] Keep raw provider payloads, credentials, headers, and harness objects out of core, engine, descriptors, and durable metadata.
  - [repo: packages/adapters/AGENTS.md] Unit tests mock harness boundaries and do not launch real harnesses or write uncontrolled files.
  - [repo: docs/testing/adapter-verification.md] Each adapter implementation needs proof in its real harness. Unproven support remains degraded or unsupported.
  - [repo: packages/config/prompts/loom.md] Run Weft after each non-trivial implementation slice and Warp for input validation, authenticated child bootstrap changes, and provider request/header mutation.
  - [repo: current worktree] The checkout contains unrelated modified and untracked work. Execution must isolate commits and must not reset, overwrite, stage, or amend unrelated changes.

## Decisions needed before execution

- [proposed] Accept only the literal `fast true`; reject `fast false` with a validation error. Omission is the sole way to preserve provider defaults. This keeps the exact opt-in DSL, avoids a false value that has no distinct semantic effect, and prevents inherited `fast true` from appearing cancellable when config merge has no general unset operator.
- [proposed] Make old structured trigger syntax a hard DSL validation break. The legacy JSONC converter should automate lossless conversion by taking each nonblank `routing_hint`, else `trigger`, as one string, preserving source order, deduplicating exact strings, and warning when `domain` or another discarded field cannot be represented. Do not add a runtime compatibility parser.
- [proposed] Treat every existing category `patterns` field as an explicit migration error in `.weave` input. Remove it from builtins, starter config, fixtures, and examples. In the legacy JSONC converter, drop valid pattern arrays with a warning and continue converting a category that has a nonblank description; malformed pattern values still warn but do not create metadata.
- [proposed] Ship effective provider-response reporting in this change for every adapter marked supported. Use an explicit state vocabulary such as `not_requested`, `unsupported`, `requested`, `applied`, and `not_confirmed`; only response evidence defined by Task 1 can move a request to `applied`. Deferring evidence reporting would conflict with the requirement to expose truthful runtime/status evidence while adding request mutation.
- [proposed] Keep current config merge rules: higher-priority `fast true` wins as a scalar; string trigger arrays use the existing ordered union merge. The risk is surprising cross-layer trigger inheritance, so docs and merge tests must state this behavior.

## Open questions and assumptions

- Open question: Which current OpenAI and Anthropic API fields, headers, eligible models, and response fields or headers officially prove fast application? This blocks provider mappings and allowlists and is resolved by Task 1 before API design freezes.
- Open question: Does the installed/current OpenCode plugin or SDK expose both a safe per-request mutation seam and response evidence? If not, OpenCode remains explicitly unsupported for fast activation in this change. Task 1 resolves this without delaying neutral descriptor support.
- Open question: Does current Claude Code expose an official per-invocation request seam and application evidence to extensions or generated agents? If not, Claude Code remains explicitly unsupported. Task 1 resolves this.
- Assumption: Category `fast true` overrides the base Shuttle value when `generateCategoryShuttles()` creates `shuttle-<category>`, while absence inherits the base Shuttle intent through normal descriptor composition. This is reversible in the engine slice and is covered in Task 5.
- Assumption: Fast evidence is scoped to the active agent and provider request, not a permanent model property. This follows the Pi request hooks and prevents one agent's state from leaking into another; Tasks 7–9 must verify it.

## Objectives

- Define one small, breaking, harness-neutral DSL and public type contract.
- Remove all pattern metadata and structured-trigger projections instead of leaving dead compatibility paths.
- Propagate fast intent through primary, ordinary-child, and direct-step execution without weakening authenticated control validation.
- Mutate provider requests only through current official seams, preserve prior extension edits, and use explicit provider/model allowlists.
- Separate declared, requested, and evidence-confirmed states so status never overclaims provider behavior.
- Give each adapter an evidence-backed supported, degraded, or unsupported result and prove supported paths in real harnesses.

## Dependencies and order

1. Task 1 verifies current official provider and harness contracts. No request field, header, model allowlist, evidence rule, or supported capability claim may be frozen before it completes.
2. Task 2 records the approved breaking contract. Tasks 3–6 then change the language, merge/migration, normalized descriptors, prompts, and capability surface in that order.
3. Pi state and authenticated propagation in Tasks 7–8 must exist before Task 9 can apply request controls to the correct active execution.
4. OpenCode and Claude Code implementation or explicit unsupported status in Tasks 10–11 depends on Task 1 and the shared capability contract in Task 6.
5. Task 12 closes release notes and documentation after behavior is settled. Task 13 runs full review and test gates. Task 14 performs exact-artifact real-harness proof last.

## Tasks

- [x] 1. Verify official provider and harness acceleration contracts
  - **What**: Produce a dated, source-linked design note that identifies current OpenAI and Anthropic request controls, headers, eligible models, incompatibilities, and response evidence. Investigate Pi, OpenCode, and Claude Code request/response seams before any adapter mapping is accepted.
  - **Files**: `docs/specs/fast-provider-acceleration-contract.md` (create)
  - **Depends on**: None
  - **Implementation outline**:
    1. Check current official OpenAI and Anthropic API documentation and SDK types for acceleration controls, required headers, model eligibility, error behavior, and response-side confirmation. Record exact versions or retrieval dates and distinguish normative evidence from examples.
    2. Verify Pi's installed and supported provider events against its public docs/types. Verify whether current OpenCode plugin/SDK and Claude Code extension/agent surfaces expose safe request mutation and response evidence.
    3. Define provider/model allowlist entries, collision policy for existing payload/header values, retry semantics, and the minimum response signal that proves `applied`. Mark ambiguous or undocumented cases unsupported.
    4. Define sanitized evidence fields and state transitions without recording raw payloads, full headers, tokens, or provider responses.
  - **Pitfalls / non-goals**:
    - Do not infer eligibility from model-name shape alone.
    - Do not treat a successful HTTP response, request mutation, or a capability declaration as proof that acceleration was applied.
    - Do not use SDK implementation details when the provider contract does not guarantee them.
  - **Acceptance**:
    - [user] The note settles current official OpenAI and Anthropic request fields, headers, model eligibility, and response evidence before mappings freeze.
    - [user] OpenCode and Claude Code each have a proven supported seam or an explicit unsupported/degraded outcome.
    - [repo: docs/architecture/adapter-boundary.md] The proposed neutral contract contains no raw provider payload, header, credential, or harness object.
    - [proposed] Every supported allowlist entry cites official request and response contracts; absence of response proof prevents an `applied` state. This controls false capability claims.

- [x] 2. Freeze the breaking contract and migration semantics
  - **What**: Turn the approved decisions and Task 1 findings into the normative DSL, merge, adapter, evidence, and migration contract before production edits.
  - **Files**: `docs/specs/fast-provider-acceleration-contract.md`, `docs/reference/dsl.md`, `docs/reference/configuration.md`
  - **Depends on**: Task 1 and approval of all items under **Decisions needed before execution**
  - **Implementation outline**:
    1. Specify exact valid agent/category examples, invalid `fast false`, invalid structured triggers, invalid category patterns, absence semantics, category-generated-agent precedence, and trigger merge ordering.
    2. Specify declared/requested/applied/not-confirmed/unsupported state meaning and adapter fallback behavior.
    3. Add a migration table for hand-written `.weave`, legacy JSONC conversion, builtin config, and adapter consumers of exported core/engine types.
  - **Pitfalls / non-goals**:
    - Do not preserve aliases for rejected DSL names.
    - Do not make patterns optional or retain them in descriptors.
  - **Acceptance**:
    - [user] The normative contract uses only `fast true`, absence for provider defaults, string triggers, and no category patterns.
    - [proposed] The contract gives one deterministic outcome for each legacy form before implementation starts. This prevents parser, converter, and docs behavior from diverging.

- [x] 3. Change the core DSL, schema, public types, and language tests
  - **What**: Add fast intent to agents/categories, replace structured triggers with strings, and reject category patterns across the complete language pipeline.
  - **Files**: `packages/core/src/lexer.ts`, `packages/core/src/parser.ts`, `packages/core/src/ast.ts`, `packages/core/src/schema.ts`, `packages/core/src/validate.ts`, `packages/core/src/index.ts`, `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/schema.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/__tests__/parse_config.test.ts`
  - **Depends on**: Task 2
  - **Implementation outline**:
    1. Define the strict schema/type for `fast` and replace or remove `DelegationTriggerSchema`/`DelegationTrigger` so public config types expose `triggers?: string[]` for agents and categories.
    2. Delete `patterns` from `CategoryConfigSchema`; keep description validation and all unrelated category policy fields.
    3. Add lexical, AST/parser, schema, validator, and end-to-end parse cases for agent/category success, omission, empty/invalid triggers, structured legacy objects, `fast false`, wrong scalar types, rejected aliases, and rejected patterns.
    4. Update the public barrel and type-level consumers without compatibility aliases that imply the old object contract remains valid.
  - **Pitfalls / non-goals**:
    - Generic boolean parsing already exists; do not add a special parser path unless tests prove it is necessary.
    - Keep schemas strict so removed fields and aliases fail closed.
  - **Acceptance**:
    - [user] `fast true` parses for agents and categories; omission remains absent; string triggers work on both; category patterns and structured triggers fail.
    - [repo: packages/core/AGENTS.md] Lexer, parser, AST, schema, validator, and their language-layer tests change in the same slice.
    - [proposed] `fast false` and rejected alias names produce bounded validation diagnostics. This prevents inert or misleading configuration.
  - **Review gate**:
    - Run Weft after the slice.
    - Run Warp because strict input validation and exported schemas changed; resolve all blocking findings before Task 4.

- [x] 4. Update config merge, builtins, starter data, and legacy conversion
  - **What**: Apply the new fields through config layering and provide the agreed breaking migration behavior.
  - **Files**: `packages/config/src/merge.ts`, `packages/config/src/builtins.ts`, `packages/config/src/__tests__/merge.test.ts`, `packages/config/src/__tests__/builtins.test.ts`, `packages/config/src/__tests__/builtin-compose-smoke.test.ts`, `packages/config/src/__tests__/builtin-prompts.test.ts`, `packages/cli/src/migration/legacy-jsonc-converter.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`, `packages/cli/src/config/starter-config.ts`, `packages/cli/src/prompts/self-modify.md`, `packages/cli/src/__fixtures__/valid.weave`, `config/` pattern-bearing fixtures discovered during execution
  - **Depends on**: Task 3
  - **Implementation outline**:
    1. Add merge tests for scalar fast precedence, omission, category fast inheritance inputs, and ordered union/deduplication of string triggers across builtin/global/project layers.
    2. Convert builtin structured triggers to concise strings and remove all language that routes by category file patterns. Update starter config and fixtures to valid pattern-free categories.
    3. Update `convertLegacyJsonc()` and `convertLegacyCategory()` to perform the approved structured-trigger conversion, warn on lossy fields, drop patterns with a clear migration diagnostic, and preserve convertible categories.
    4. Add malformed, empty, duplicate, order-preservation, and diagnostic tests. Ensure no converted output emits `patterns`, trigger objects, or rejected fast aliases.
  - **Pitfalls / non-goals**:
    - Do not silently discard lossy legacy fields.
    - Do not create a compatibility-only schema or retain patterns in converted comments/metadata.
  - **Acceptance**:
    - [repo: packages/config/src/merge.ts] Fast follows scalar last-defined-wins behavior; triggers follow documented ordered union merge.
    - [user] Builtins, starter config, and fixtures contain no category patterns or structured triggers.
    - [proposed] Legacy conversion is best-effort and warning-rich but generated DSL always validates against the new schema. This prevents migration output that fails on first use.
  - **Review gate**:
    - Run Weft after the slice.
    - Run Warp for converter input validation and lossy migration diagnostics.

- [x] 5. Simplify normalized descriptors and category generation
  - **What**: Carry neutral fast intent through engine descriptors, propagate category triggers to generated shuttles, and remove patterns from every normalized shape.
  - **Files**: `packages/engine/src/compose.ts`, `packages/engine/src/descriptors.ts`, `packages/engine/src/index.ts`, `packages/engine/src/materialization.ts` if type propagation requires it, `packages/engine/src/__tests__/compose.test.ts`, `packages/engine/src/__tests__/descriptors.test.ts`, `packages/engine/src/__tests__/category-shuttle-routing.test.ts`, `packages/engine/src/__tests__/category-routing-scaling.test.ts`, materialization tests that construct `AgentDescriptor`
  - **Depends on**: Task 4
  - **Implementation outline**:
    1. Add a neutral fast-intent field to `AgentDescriptor`; remove patterns from `CategoryMetadata` and `AgentDescriptorCategory`; change `DelegationTarget.triggers` to strings.
    2. Update `composeAgentDescriptor()` and `buildDelegationTargets()` to copy bounded normalized intent without provider terms.
    3. Change `generateCategoryShuttles()` so category triggers become the generated shuttle triggers and category fast intent follows the approved category/base precedence. Delete pattern copying and pattern-named routing assumptions.
    4. Rename pattern-oriented test descriptions only where needed to state semantic category delegation, then cover agent fast, category fast, omission, trigger order, generic Shuttle fallback, and absence of pattern fields.
  - **Pitfalls / non-goals**:
    - Do not add provider IDs, request fields, service tiers, or response evidence to `AgentDescriptor`.
    - Do not replace deleted patterns with hidden adapter metadata.
  - **Acceptance**:
    - [user] Engine descriptors carry only neutral fast intent and string triggers, and no production descriptor contains category patterns.
    - [repo: packages/engine/src/descriptors.ts] Generated category shuttles use category descriptions/policies plus string triggers; no file matcher is introduced.
    - [proposed] Category fast precedence is explicit and covered for base false-by-absence, base true, category absence, and category true. This prevents accidental loss or leakage during generation.
  - **Review gate**: Run Weft after the slice and resolve blocking findings.

- [x] 6. Simplify prompt context and define the fast capability contract
  - **What**: Render trigger strings directly and add an honest cross-adapter capability entry for provider fast activation/evidence.
  - **Files**: `packages/engine/src/template-context.ts`, `packages/engine/src/capability-contract.ts`, `packages/engine/src/index.ts`, `packages/config/prompts/loom.md`, `packages/engine/src/__tests__/template-context.test.ts`, `packages/engine/src/__tests__/template-renderer.test.ts`, `packages/engine/src/__tests__/capability-contract.test.ts`, `packages/engine/src/__tests__/capability-readiness.test.ts`, `packages/engine/src/__tests__/capability-effective.test.ts`, `packages/engine/src/__tests__/capability-reporting.test.ts`, `packages/config/src/__tests__/builtin-prompts.test.ts`, `packages/adapters/pi/src/capability-declarations.ts`, `packages/adapters/opencode/src/capability-declarations.ts`, `packages/adapters/claude-code/src/capability-declarations.ts`, each adapter's `src/__tests__/capability-declarations.test.ts`
  - **Depends on**: Task 5 and Task 1 support findings
  - **Implementation outline**:
    1. Remove trigger domains and object members from the template allowlist/context. Project ordered strings directly and render each with `{{.}}` in Loom.
    2. Delete `patterns` from `CategoryInput` and all prompt-context fixtures. Keep category selection language based on descriptions and explicit trigger guidance, not file globs.
    3. Add one neutral optional capability ID for provider fast activation and define bounded readiness/runtime status values that separate intent, request mutation, and confirmed application.
    4. Set adapter capability ceilings from Task 1: Pi only as high as its proven seam; OpenCode/Claude Code degraded or unsupported unless proven otherwise. Add readiness-combination and reporting tests.
  - **Pitfalls / non-goals**:
    - Do not expose provider fields or raw response details in template context or capability metadata.
    - Do not mark the capability native merely because hooks exist.
  - **Acceptance**:
    - [user] Loom renders the exact string triggers for agents and categories and makes no pattern-routing claim.
    - [repo: packages/engine/src/capability-contract.ts] Static capability declarations remain ceilings and runtime evidence can lower the effective result.
    - [proposed] A descriptor with no fast intent does not require the optional capability and does not emit applied/requested state. This preserves provider defaults and avoids noisy degradation.
  - **Review gate**: Run Weft after the slice and resolve blocking findings.

- [x] 7. Add fast intent to Pi primary activation state
  - **What**: Make the active primary descriptor's fast intent available to provider hooks with atomic activation/switching and no cross-agent leakage.
  - **Files**: `packages/adapters/pi/src/types.ts`, `packages/adapters/pi/src/primary-session.ts`, `packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/__tests__/primary-session.test.ts`, `packages/adapters/pi/src/__tests__/config-activator.test.ts`, `packages/adapters/pi/src/__tests__/extension.test.ts`
  - **Depends on**: Task 6
  - **Implementation outline**:
    1. Add narrow typed Pi provider-event projections required by Task 1 instead of accepting arbitrary payload/header/response shapes throughout the adapter.
    2. Extend `PiActivePrimary` and `PiPrimarySession.activate()` so descriptor identity, model, skills, prompt, and fast intent commit or roll back together.
    3. Update extension activation, agent switching, session restart/resume, and health-only paths so the provider layer reads only the current committed state.
    4. Test primary fast on/off-by-absence switching, failed activation rollback, concurrent/stale event protection, and no effect before activation or in unsupported state.
  - **Pitfalls / non-goals**:
    - Do not use mutable process-global fast state.
    - Do not let a failed agent switch change request behavior.
  - **Acceptance**:
    - [user] Primary fast intent follows the active agent; absence leaves provider requests unchanged.
    - [repo: packages/adapters/pi/src/primary-session.ts] Fast intent participates in the existing atomic primary activation boundary.
    - [proposed] Provider events use a request-scoped snapshot tied to the active agent/model. This controls state leakage during switching.
  - **Review gate**: Run Weft after the slice and resolve blocking findings.

- [ ] 8. Propagate and validate fast intent through ordinary and direct Pi children
  - **What**: Carry the same neutral intent through strict authenticated child bootstraps and direct-step dispatch without weakening fail-closed controls.
  - **Files**: `packages/adapters/pi/src/child-control-bodies.ts`, `packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/direct-dispatch.ts`, `packages/adapters/pi/src/direct-dispatch-transport.ts`, `packages/adapters/pi/src/workflow-controller.ts`, `packages/adapters/pi/src/__tests__/child-control-bodies.test.ts`, `packages/adapters/pi/src/__tests__/child-mode.test.ts`, `packages/adapters/pi/src/__tests__/direct-dispatch.test.ts`, `packages/adapters/pi/src/__tests__/direct-dispatch-transport.test.ts`, `packages/adapters/pi/src/__tests__/workflow-controller.test.ts`
  - **Depends on**: Task 7
  - **Implementation outline**:
    1. Replace the private structured trigger body schema with bounded strings and add the strict fast-intent field to `BootstrapCommonShape` and corresponding TypeScript inputs.
    2. Update `PiChildBootstrapCommon`, `buildChildBootstrapBody()`, `applyChildBootstrap()`, `PiDirectDispatchInput`, `PiDirectStepBootstrap`, transport construction, and workflow dispatch to carry the selected descriptor's intent.
    3. Authenticate and validate the complete body before applying prompt, model, tool, delegation, or fast state. Keep ordinary/direct discriminants, correlation checks, byte bounds, and acknowledgment ordering intact.
    4. Add malformed type, unknown-key, oversized trigger/body, missing intent, forged correlation, ordinary-child, direct-child, retry, and rollback tests.
  - **Pitfalls / non-goals**:
    - Do not infer fast intent from model IDs in the child.
    - Do not acknowledge bootstrap before fast state is validated and atomically applied.
  - **Acceptance**:
    - [user] Ordinary and direct children receive the descriptor's fast intent and string triggers; omission leaves requests unchanged.
    - [repo: packages/adapters/pi/src/child-control-bodies.ts] Strict bounded schemas reject malformed, oversized, or unknown bootstrap data with typed errors.
    - [repo: packages/adapters/pi/src/extension.ts] Correlation authentication and apply-before-ack ordering remain fail closed.
  - **Review gate**:
    - Run Weft after the slice.
    - Run Warp because authenticated child bootstrap and untrusted input validation changed. Resolve every blocking finding before Task 9.

- [ ] 9. Implement Pi request mutation and truthful response evidence
  - **What**: Apply allowlisted provider controls without clobbering prior extension edits, and expose only response-confirmed application as applied.
  - **Files**: `packages/adapters/pi/src/provider-fast-activation.ts` (create), `packages/adapters/pi/src/types.ts`, `packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/telemetry.ts`, `packages/adapters/pi/src/weave-status-widget.ts`, `packages/adapters/pi/src/__tests__/provider-fast-activation.test.ts` (create), `packages/adapters/pi/src/__tests__/extension.test.ts`, `packages/adapters/pi/src/__tests__/telemetry.test.ts`, `packages/adapters/pi/src/__tests__/weave-status-widget.test.ts`
  - **Depends on**: Tasks 1, 6, 7, and 8
  - **Implementation outline**:
    1. Implement a small pure mapper from the Task 1 allowlist. Validate provider, API family, current model, payload/header shape, and existing values before producing a typed minimal mutation or unsupported result.
    2. Register `before_provider_request` and/or `before_provider_headers` as required by each official mapping. Patch the current payload/header object narrowly, preserving all earlier extension edits and unrelated fields. Define fail-closed collision behavior instead of silently overriding incompatible existing controls.
    3. Correlate each request-scoped attempted mutation with `after_provider_response`. Apply the Task 1 response-evidence rule and expire state across retries, failures, cancellation, session change, and agent switch.
    4. Record only bounded provider family/model category, state, evidence code, and sanitized reason through existing telemetry/journal paths. Update `renderStatusMessage()` and the widget only if their wording can distinguish requested from applied.
    5. Test no-intent pass-through by identity/deep equality, prior payload/header preservation, allowlisted mutations, unlisted providers/models, malformed/frozen inputs, conflicts, retries, concurrent requests, missing headers, failed responses, evidence success/failure, sanitization, and non-throwing hook boundaries.
  - **Pitfalls / non-goals**:
    - Do not reconstruct provider payloads or replace complete header maps.
    - Do not persist raw payloads, full headers, response bodies, tokens, prompts, or completions.
    - Do not report `applied` from intent, mutation, HTTP success alone, or undocumented headers.
  - **Acceptance**:
    - [user] Fast controls are applied only for officially allowlisted provider/model combinations, and absence preserves the exact provider defaults/current payload.
    - [user] Status never says applied without the Task 1 provider response evidence.
    - [repo: Pi `docs/extensions.md` — provider hooks] Weave composes with the payload and headers passed by prior handlers and honors retry/event timing.
    - [repo: packages/engine/src/runtime/sanitizer.ts] Durable evidence is bounded and contains no denied raw provider or secret data.
    - [proposed] Unsupported, conflicting, or malformed cases degrade with typed sanitized reasons and send no guessed mutation. This controls API breakage and accidental provider overrides.
  - **Review gate**:
    - Run Weft after the slice.
    - Run Warp because provider request/header mutation and response input validation changed. Resolve every blocking finding before adapter-wide verification.

- [ ] 10. Resolve OpenCode support through a proven seam or honest unsupported behavior
  - **What**: Carry neutral intent through translation, but mutate requests and report application only if Task 1 proves both a supported OpenCode seam and response evidence.
  - **Files**: `packages/adapters/opencode/src/translate-agent.ts`, `packages/adapters/opencode/src/adapter.ts`, `packages/adapters/opencode/src/sdk-types.ts`, `packages/adapters/opencode/src/plugin.ts` if a proven hook belongs there, `packages/adapters/opencode/src/capability-declarations.ts`, `packages/adapters/opencode/src/__tests__/translate-agent.test.ts`, `packages/adapters/opencode/src/__tests__/adapter.test.ts`, `packages/adapters/opencode/src/__tests__/plugin.test.ts`, `packages/adapters/opencode/src/__tests__/capability-declarations.test.ts`, `packages/adapters/opencode/src/__tests__/category-routing-smoke.test.ts`
  - **Depends on**: Tasks 1 and 6
  - **Implementation outline**:
    1. Update descriptor/trigger/pattern type fallout in translation and materialization.
    2. If Task 1 proves a request/response seam, add the same allowlist, edit-preservation, collision, evidence, and sanitization rules as Pi at the narrowest plugin boundary.
    3. Otherwise preserve neutral intent in the adapter input, omit unsupported provider controls, and report the fast capability as unsupported or degraded with a clear remediation/status reason.
    4. Add tests that reject false applied claims and show normal materialization is unchanged when fast is absent or unsupported.
  - **Pitfalls / non-goals**:
    - Agent config materialization alone is not proof of per-request fast application.
    - Do not reach into undocumented SDK internals.
  - **Acceptance**:
    - [user] OpenCode either has real request plus response proof or reports explicit unsupported/degraded behavior; it never claims application from translated config alone.
    - [repo: packages/adapters/opencode/src/translate-agent.ts] Existing model, temperature, permission, and tool translation remains intact.
    - [proposed] Unsupported fast intent does not prevent unrelated agents from materializing. This keeps an optional capability gap from becoming a startup failure.
  - **Review gate**: Run Weft; also run Warp if this task adds any request/header mutation or parses response evidence.

- [ ] 11. Resolve Claude Code support through a proven seam or honest unsupported behavior
  - **What**: Remove old type fallout and either implement an officially proven invocation/evidence seam or report fast activation as unsupported without encoding false metadata in generated agents.
  - **Files**: `packages/adapters/claude-code/src/model-resolution.ts`, `packages/adapters/claude-code/src/agent-translation.ts`, `packages/adapters/claude-code/src/adapter.ts`, `packages/adapters/claude-code/src/capability-declarations.ts`, `packages/adapters/claude-code/src/__tests__/model-resolution.test.ts`, `packages/adapters/claude-code/src/__tests__/agent-translation.test.ts`, `packages/adapters/claude-code/src/__tests__/adapter.test.ts`, `packages/adapters/claude-code/src/__tests__/integration.test.ts`, `packages/adapters/claude-code/src/__tests__/capability-declarations.test.ts`
  - **Depends on**: Tasks 1 and 6
  - **Implementation outline**:
    1. Update descriptor/trigger/pattern consumers and generated fixtures.
    2. Use an official request and evidence seam only if Task 1 proves one. Otherwise omit any fabricated frontmatter, environment value, or prompt instruction and declare unsupported behavior.
    3. Test no-intent parity, fast-intent unsupported diagnostics, pattern absence, string trigger compatibility, and unchanged model/permission output.
  - **Pitfalls / non-goals**:
    - A prompt instruction or generated Markdown field is not a provider request control unless Claude Code documents it as such.
    - Do not block static agent generation for this optional capability.
  - **Acceptance**:
    - [user] Claude Code support status is explicit and evidence-backed; no generated artifact implies fast application without a proven host seam.
    - [repo: packages/adapters/claude-code/src/capability-declarations.ts] Unsupported invocation controls follow the existing thinking-capability precedent.
  - **Review gate**: Run Weft; also run Warp if this task adds request/header mutation or response parsing.

- [ ] 12. Complete breaking migration docs, adapter docs, examples, and release metadata
  - **What**: Remove every old pattern/structured-trigger claim, document fast support and truthful evidence per adapter, and declare the public breaking release impact.
  - **Files**: `docs/reference/dsl.md`, `docs/reference/configuration.md`, `docs/reference/prompts.md`, `docs/reference/models.md`, `docs/reference/adapter-capabilities.md`, `docs/architecture/adapter-boundary.md`, `docs/architecture/agent-surfaces.md`, `docs/architecture/system-overview.md`, `docs/architecture/product-vision.md`, `docs/contributing/builtin-prompts.md`, `docs/adapters/pi.md`, `docs/adapters/opencode.md`, `docs/adapters/claude-code.md`, `packages/docs/src/content/docs/docs/agents-and-categories.mdx`, `packages/docs/src/content/docs/docs/reference/dsl/index.mdx`, `packages/docs/src/pages/design-system.astro`, `.changeset/fast-intent-and-trigger-simplification.md` (create), other references returned by final `rg`
  - **Depends on**: Tasks 3–11
  - **Implementation outline**:
    1. Document exact syntax, omission semantics, invalid forms, merge behavior, category trigger behavior, and no deterministic file routing.
    2. Add before/after migration examples for structured agent/category triggers and category patterns. Explain automated legacy JSONC conversion and hand-written `.weave` hard errors.
    3. Document each adapter's provider/model allowlist, requested versus applied evidence, unsupported behavior, and troubleshooting without exposing secrets.
    4. Update architecture ownership text and docs-site mirrors. Remove stale pattern/routing-hint claims with a repository-wide search.
    5. Add a Changesets entry with breaking impact for each affected public package according to `.changeset/config.json` and `scripts/release/changeset-policy.ts`.
  - **Pitfalls / non-goals**:
    - Do not advertise planned or unproven provider mappings.
    - Do not leave `patterns` in examples as deprecated syntax.
  - **Acceptance**:
    - [user] Docs give an actionable breaking migration and no longer describe structured triggers, category patterns, or deterministic file routing.
    - [repo: docs/testing/adapter-verification.md] Adapter docs distinguish unit confidence from real-harness proof and name missing proof as a blocker.
    - [proposed] `rg` finds old terms only in explicit migration/history passages and tests that assert rejection. This controls stale-contract drift.
  - **Review gate**: Run Weft after the documentation/release slice and resolve blocking findings.

- [ ] 13. Run focused and full verification plus final Weft/Warp gates
  - **What**: Prove the breaking contract, adapter safety, generated declarations, docs, and clean integration before live harness work.
  - **Depends on**: Task 12
  - **Implementation outline**:
    1. Run focused core/config/engine/CLI/adapter tests after each slice, then all root gates listed below.
    2. Run adversarial tests for unknown DSL keys, structured trigger objects, patterns, false/wrong-type fast values, malformed/oversized bootstrap data, forged correlation, payload/header conflicts, response spoofing, stale/concurrent request evidence, and sanitizer denial.
    3. Run Weft over the complete changeset. Run Warp over all input validation, authenticated child bootstrap, and provider request/header/evidence changes. Resolve findings and rerun affected tests/reviews.
    4. Inspect the public API/declaration and changeset output for removed trigger types/pattern fields and the new neutral fast field.
  - **Pitfalls / non-goals**:
    - Do not waive a Warp blocker because unit tests pass.
    - Do not stage or repair unrelated dirty-worktree files.
  - **Acceptance**:
    - [repo: AGENTS.md] Full tests, typecheck, lint/declaration validation, build, project config validation, and docs links pass.
    - [user] Weft follows all non-trivial changes; Warp approves input validation, authenticated child bootstrap, and request/header mutation surfaces.
    - [proposed] No supported adapter can reach `applied` in tests without injecting the exact response evidence defined in Task 1. This directly guards truthful reporting.

- [ ] 14. Prove each adapter in a fresh real harness with exact artifacts
  - **What**: Build, bind, install, restart, and exercise exact adapter bytes. Prove both normal behavior and fast intent/evidence behavior where support is claimed.
  - **Files**: `docs/specs/fast-provider-acceleration-live-proof.md` (create)
  - **Depends on**: Task 13
  - **Implementation outline**:
    1. Follow `docs/testing/adapter-verification.md`: build public packages, inspect tarballs and digests, install the exact bytes in clean harness environments, restart all harness processes, and record package/entry-point identity.
    2. For Pi, prove `pi list`, single extension registration, `/weave:health`, trusted `/weave:status`, health-only false, primary activation, ordinary delegation, direct-step delegation, and zero residual leases/processes. Run one no-fast request to prove no mutation, one supported fast request with sanitized response evidence, and one unsupported model/provider case that does not claim applied.
    3. For OpenCode, prove packaged plugin loading, single resource registration, config materialization, and one real action. Exercise fast request/evidence only if Task 1 and Task 10 marked it supported; otherwise prove the explicit unsupported/degraded status.
    4. For Claude Code, prove clean installation, resource discovery, and a real generated command/agent with prompt/model/permission mapping. Exercise fast only if supported; otherwise verify no false generated control or applied claim.
    5. Save commands, versions, artifact and entry-point hashes, sanitized status/evidence, outcomes, cleanup checks, and blockers in the proof document.
  - **Pitfalls / non-goals**:
    - A source checkout, package import, mocked hook, or already-running harness is not release proof.
    - Development symlink loading does not satisfy Pi release provenance.
    - Do not capture API keys, raw headers, prompts, completions, or response bodies in proof artifacts.
  - **Acceptance**:
    - [repo: docs/testing/adapter-verification.md] Every claimed adapter behavior is proven from exact packaged bytes in a fresh real harness, or recorded as a release blocker.
    - [user] Pi ordinary and direct child paths preserve fast intent and only show applied with provider response evidence.
    - [user] OpenCode and Claude Code are either proven supported or visibly unsupported/degraded; neither overclaims.
    - [proposed] Cleanup ends with no active Runtime Store lease, child process, temporary registration, or stale fast evidence. This controls cross-run leakage.

## Verification

- `bun test packages/core/src/__tests__` — source: `[repo: packages/core/package.json]`; proves: lexer/parser/schema/validator and parse regression coverage.
- `bun test packages/config/src/__tests__` — source: `[repo: packages/config/package.json]`; proves: merge, builtin, and prompt behavior.
- `bun test packages/engine/src/__tests__` — source: `[repo: packages/engine/package.json]`; proves: normalized descriptors, category generation, prompt context, capabilities, and reporting.
- `bun test packages/cli/src/commands/__tests__/migrate-conversion.test.ts packages/cli/src/commands/__tests__/validate.test.ts` — source: `[repo: packages/cli/package.json]`; proves: breaking migration and CLI diagnostics.
- `bun test packages/adapters/pi/src` — source: `[repo: packages/adapters/pi/package.json]`; proves: Pi activation, authenticated propagation, mutation composition, response evidence, and status behavior under mocked boundaries.
- `bun test packages/adapters/opencode/src/__tests__` — source: `[repo: packages/adapters/opencode/package.json]`; proves: OpenCode translation/materialization and supported-or-unsupported capability behavior.
- `bun test packages/adapters/claude-code/src/__tests__` — source: `[repo: packages/adapters/claude-code/package.json]`; proves: Claude Code translation and supported-or-unsupported capability behavior.
- `bun test` — source: `[repo: package.json]`; proves: all workspace test suites pass.
- `bun run typecheck` — source: `[repo: package.json]`; proves: root, scripts, packages, public type removals, and new intent types compile.
- `bun run lint` — source: `[repo: package.json]`; proves: Biome and declaration validation pass.
- `bun run build` — source: `[repo: package.json]`; proves: public packages and docs site build.
- `bun run validate-config` — source: `[repo: package.json]`; proves: the repository's own `.weave` config conforms to the breaking DSL.
- `bun run docs:check-links` — source: `[repo: package.json]`; proves: documentation links remain valid.
- `bun run changeset:check` — source: `[repo: package.json]`; proves: public package release metadata follows repository policy.
- `rg -n 'routing_hint|patterns\s*\[|domain\s+.*trigger|DelegationTrigger' packages docs config .weave --glob '!**/dist/**'` — source: `[proposed]`; proves: stale structured-trigger and pattern contracts remain only in explicit migration/rejection coverage.
- Exact packed-artifact and live-harness commands recorded in `docs/specs/fast-provider-acceleration-live-proof.md` — source: `[repo: docs/testing/adapter-verification.md]`; proves: package identity, fresh loading, real behavior, evidence truthfulness, and cleanup for Pi, OpenCode, and Claude Code.
