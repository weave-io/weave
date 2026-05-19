# 10-spec-builtin-prompt-defaults.md

## Introduction/Overview

This spec defines issue [#51](https://github.com/weave-io/weave/issues/51): replace the shipped placeholder builtin prompt files with real product-level builtin prompt defaults for Weave's eight builtin agents. The goal is to make zero-config Weave installs usable out of the box while aligning builtin prompts, builtin agent declarations, composition behavior, tests, and local dogfood overrides with Weave's current prompt architecture.

The feature covers more than prompt copy. It also defines how builtin `triggers` should support generated `## Delegation` output, how local `.weave` dogfood overrides should shrink to true deltas, and what proof should exist so future maintainers can tell the difference between shipped product defaults and Weave-repo-specific policy.

**Scope assessment:** appropriately sized for Spec-Driven Development. This work is a focused prompt/config/test/docs slice with three demoable vertical units, not a full prompt-system rewrite.

**Clarification status:** sufficient - no questions file required

**Latest-standards research:** no latest-standards external research was needed. This feature concerns internal prompt/config architecture rather than a third-party library, framework, or service.

## Goals

- Ship real Markdown builtin prompt files for `loom`, `tapestry`, `shuttle`, `pattern`, `thread`, `spindle`, `weft`, and `warp` in `packages/config/prompts/`.
- Make shipped builtin prompts product-level, skill-agnostic defaults that work with the current `Composed Prompt` contract.
- Promote useful builtin `triggers` into `packages/config/src/builtins.ts` so zero-config users receive generated delegation guidance.
- Remove duplication that causes prompt/default drift by pruning mirror local prompt files and shrinking `.weave/config.weave` to intentional overrides only.
- Add proof that builtin prompts are non-placeholder, free of obvious Weave-repo-only leakage, and compose correctly through the engine.

## User Stories

- **As a zero-config Weave user**, I want shipped builtin agents to have real default prompts so that Weave is useful before I customize any local config.
- **As a Weave maintainer**, I want builtin defaults to live in one canonical place so that prompt behavior, triggers, and overrides do not drift.
- **As an adapter maintainer**, I want builtin prompts to match the current composed-prompt contract so that adapters consume one predictable prompt shape instead of rebuilding prompt logic.
- **As a repository maintainer**, I want local dogfood overrides to exist only where the Weave repo truly diverges so that product defaults stay clean and repo policy stays explicit.
- **As a future contributor**, I want tests and docs to prove the builtin prompt contract so that placeholder regressions and repo-specific leakage are caught early.

## Demoable Units of Work

### Unit 1: Ship product-level builtin prompt defaults

**Purpose:** Replace placeholder builtin prompt files with real shipped defaults that describe each builtin agent's role, boundaries, and required output shape without embedding Weave-repo-only policy.

**Functional Requirements:**
- The system shall replace placeholder content in `packages/config/prompts/{loom,tapestry,shuttle,pattern,thread,spindle,weft,warp}.md` with real Markdown prompt content.
- The system shall define shipped builtin prompt files as product-level defaults rather than Weave-repo policy carriers.
- The system shall keep shipped builtin prompt files skill-agnostic and usable without any installed skills.
- The system shall restate key abstract behavioral boundaries inside each shipped prompt file where they matter, including examples such as read-only, planning-only, review-only, security-audit-only, or no-delegation behavior.
- The system shall avoid hand-maintained delegation tables inside shipped prompt files because delegation inventory is generated from config.
- The system shall avoid universal harness-specific tool references in shipped builtin prompts, including OpenCode-only names such as `Task`, `TodoWrite`/`todowrite`, or other concrete harness tool names unless a future adapter-driven composition contract injects them.
- The system shall allow shipped Loom behavior to handle small, simple, local work directly while still delegating multi-step, specialist, review, and security-sensitive work.
- The system shall use concise top-level `APPROVE` or `BLOCK` wording for shipped review and audit prompts when a gate-style verdict is needed.

**Proof Artifacts:**
- `File review: packages/config/prompts/*.md contain substantive Markdown prompt text` demonstrates builtin prompt files are no longer placeholders.
- `Test: builtin prompt content checks pass` demonstrates shipped prompt files are present, non-empty, and free of known placeholder text.
- `Test: leakage-guard checks pass` demonstrates shipped prompt files do not contain obvious Weave-repo-only tokens such as `AGENTS.md`, `bun run`, `neverthrow`, or `Zod`, and do not contain universal OpenCode-only tool names such as `Task` or `TodoWrite`/`todowrite`.

### Unit 2: Generate delegation from shipped builtin config

**Purpose:** Make the zero-config builtin agent set produce useful composed prompts by moving delegation inventory into builtin `triggers` and proving the engine renders delegation from config rather than prompt-file duplication.

**Functional Requirements:**
- The system shall declare useful shipped builtin `triggers` in `packages/config/src/builtins.ts` for agents whose responsibilities should appear in generated delegation guidance.
- The system shall keep prompt files focused on policy and behavior while the composer owns delegation inventory.
- The system shall ensure current prompt composition continues to build a `Composed Prompt` from prompt source, generated `## Delegation`, and optional `prompt_append`.
- The system shall prove that shipped builtin prompts compose successfully through the engine without requiring skill injection or adapter-specific prompt rewriting.
- The system shall ensure generated `## Delegation` output appears only for composing agents whose current builtin config allows delegation, while target eligibility follows the existing composer filtering rules.

**Proof Artifacts:**
- `Test: builtin config exposes expected trigger-backed delegation targets` demonstrates delegation inventory comes from shipped config.
- `Test: engine composition smoke for all builtins passes` demonstrates zero-config builtin agents produce non-empty composed prompts.
- `Test: composed Loom or Tapestry prompt contains generated ## Delegation output when triggers exist` demonstrates delegation is rendered by the engine rather than copied into the source file.

### Unit 3: Clean up local dogfood overrides and docs

**Purpose:** Reduce drift between shipped defaults and local Weave-repo behavior by keeping only true local deltas and documenting the builtin prompt contract clearly.

**Functional Requirements:**
- The system shall treat `packages/config` as the canonical source of shipped builtin defaults.
- The system shall remove local `.weave/prompts/*.md` mirror copies that only restate shipped builtin behavior.
- The system shall keep only intentional local prompt overrides for `shuttle` and `weft`.
- The system shall restate critical Weave-repo standards inline inside local Shuttle and Weft overrides instead of depending mainly on `AGENTS.md` being loaded.
- The system shall define local Shuttle completion in outcome terms and require it to discover relevant verification commands from the repository, run the checks appropriate to the change, and report which commands it used.
- The system shall shrink `.weave/config.weave` to delta-only overrides so it no longer repeats shipped builtin descriptions, tool policies, triggers, or default prompt files unless the repo intentionally diverges.
- The system shall update existing docs to reflect the builtin prompt contract, the `Composed Prompt` term, and the canonical-source vs. override-layer model.

**Proof Artifacts:**
- `File review: .weave/prompts/ contains only intentional local overrides` demonstrates mirror builtin prompts were pruned.
- `File review: .weave/config.weave contains delta-only builtin overrides` demonstrates local config no longer duplicates shipped defaults.
- `Doc review: CONTEXT.md, docs/prompt-composition.md, docs/config-loading.md, and docs/system-architecture.md reflect the builtin prompt contract` demonstrates the documentation matches the intended design.
- `CLI: bun run validate-config succeeds` demonstrates the cleaned config still parses and merges correctly.

## Non-Goals (Out of Scope)

1. **Model normalization**: This spec does not standardize or migrate model preferences across builtin and local config.
2. **Skill injection into composed prompts**: This spec does not add skill-content injection or make shipped builtin prompts depend on installed skills.
3. **New prompt DSL or legacy XML revival**: This spec does not introduce new prompt syntax, XML sections, or a new prompt-composition format.
4. **Adapter-specific prompt behavior**: This spec does not move prompt logic into harness adapters or require adapter-specific prompt rewriting.
5. **General cleanup beyond builtin prompt/default drift**: This spec does not redesign unrelated agent behavior, workflow execution, or model policy.
6. **Implementation of the feature during spec creation**: This spec defines the work; it does not perform prompt, config, test, or adapter changes itself.

## Design Considerations

No UI design is involved, but prompt text is still user-facing agent behavior and should read clearly. Shipped builtin prompts should use plain Markdown headings and bullets, avoid legacy XML formatting, and keep structure compact enough for LLM consumption. Where output shape matters, prompts should give concise formatting guidance rather than large templates.

Local Weave-repo overrides for Shuttle and Weft may include extra repo-specific guidance, but that guidance should be short, explicit, and clearly separate from the product-level shipped defaults.

## Repository Standards

- Follow `docs/adapter-boundary.md`: the engine owns prompt composition rules and adapters consume the resulting `Composed Prompt`.
- Follow `docs/prompt-composition.md`, `docs/config-loading.md`, `docs/system-architecture.md`, and `CONTEXT.md` as the current documentation for prompt composition and builtin-default layering.
- Keep shipped builtin defaults in `packages/config`, because builtin agents are declared through `.weave` DSL in `packages/config/src/builtins.ts` and prompt paths resolve through `packages/config/prompts/`.
- Use Bun-only repository tooling and commands, including `bun run validate-config`, `bun run build`, `bun test`, `bun run typecheck`, and `bun run lint` where appropriate.
- Follow repository testing practice: add focused tests near the changed package, prefer stable assertions over brittle full snapshots, and keep schema/behavior/docs updates in sync.
- Keep documentation as a first-class deliverable. Any prompt/default contract change must be reflected in the relevant existing docs in the same work.
- Use `neverthrow`-based return behavior for any new fallible TypeScript logic introduced while implementing this spec.
- Do not use `console.*`; follow the repository logging rules if implementation requires logs.
- Use Conventional Commits later in the SDD workflow if and when a planning or implementation commit is created.

## Technical Considerations

- Current prompt composition already exists in `packages/engine/src/compose.ts` and should remain the contract for this work: prompt source + generated `## Delegation` + optional `prompt_append`.
- Current composition does not inject tool policy into prompt text. Because of that, prompt files themselves must restate important abstract boundaries such as read-only, planning-only, or review-only behavior.
- Current composition passes `skills` through as metadata but does not inject skill content into `composedPrompt`. Shipped builtin prompts should therefore remain skill-agnostic.
- Builtin `triggers` should be added only where they improve generated delegation guidance for zero-config users. They should describe routing intent, not executable control flow.
- Builtin prompt content should be written for the current Weave architecture, even when legacy `opencode-weave` prompt behavior is a useful source of durable intent.
- The implementation should prefer proof-oriented tests over full prompt snapshots. Stable checks include non-placeholder content, banned-token leakage guards, non-empty composed prompts, and presence of generated `## Delegation` output when triggers are configured.
- Local Weave-repo overrides should remain true deltas. If a local prompt or config block simply mirrors the shipped builtin default, it should be removed instead of maintained in parallel.
- Existing docs already define `Composed Prompt`; implementation should keep code, prompts, config, and docs aligned with that glossary term.
- No latest-standards external research was needed for this spec because the work is internal to Weave's prompt/config architecture.

## Security Considerations

- Prompt files, tests, and proof artifacts shall not introduce or commit secrets, credentials, tokens, local machine paths, or other sensitive data.
- Leakage-guard tests shall help prevent Weave-repo-only operational policy from accidentally shipping as a product default.
- Generated delegation guidance shall reflect declared config rather than hidden prompt instructions so maintainers can audit routing behavior in one place.
- Local Shuttle and Weft overrides may reference repository standards, but they shall do so without exposing secret-bearing commands, environment values, or private operational details.
- Proof artifacts used during implementation should avoid copying full prompts into issue comments or commits when shorter assertions or sanitized snippets are sufficient.

## Success Metrics

1. **Real shipped defaults**: all eight builtin prompt files contain substantive Markdown content instead of placeholders.
2. **Clean product boundary**: builtin prompt tests confirm obvious Weave-repo-only tokens are absent from shipped defaults.
3. **Useful zero-config composition**: engine smoke tests show builtin agents compose successfully, and delegation appears where shipped triggers are configured.
4. **Reduced drift**: local `.weave/prompts/` and `.weave/config.weave` contain only intentional Weave-repo deltas rather than mirrored builtin defaults.
5. **Documentation alignment**: relevant docs and `CONTEXT.md` describe the same builtin prompt/default contract that the code and prompts implement.
6. **Validation confidence**: config validation and targeted tests pass after the cleanup.

## Open Questions

No open questions at this time.
