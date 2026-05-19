## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/package.json` | Adds the canonical `mustache` runtime dependency and optional type dependency if needed. |
| `bun.lock` | Records dependency resolution for `mustache` and any type package. |
| `packages/engine/src/template-renderer.ts` | New internal Mustache wrapper for parsing, reference extraction, strict validation, rendering, escaped literals, and typed renderer errors. |
| `packages/engine/src/template-context.ts` | New Template Context builder, allowed-path metadata, delegation target projection, Mermaid generation, and canonical delegation section generation. |
| `packages/engine/src/compose.ts` | Existing prompt composition entry point that must render templates, insert fallback delegation, and map template failures into `ComposeError`. |
| `packages/engine/src/index.ts` | Public engine barrel that should export Template Context and template error types while keeping low-level renderer internals private. |
| `packages/engine/src/__tests__/template-renderer.test.ts` | New focused tests for supported Mustache behavior, unsupported features, strict paths, escaped literals, and unresolved-tag checks. |
| `packages/engine/src/__tests__/template-context.test.ts` | New focused tests for bounded context shape, allowed paths, category handling, and generated delegation guidance. |
| `packages/engine/src/__tests__/compose.test.ts` | Existing compose tests to extend for template rendering, fallback placement, source-only suppression, append rendering, and typed errors. |
| `packages/config/prompts/loom.md` | Built-in delegating prompt expected to place `{{{delegation.section}}}` naturally. |
| `packages/config/prompts/tapestry.md` | Built-in delegating prompt expected to place `{{{delegation.section}}}` naturally. |
| `packages/config/prompts/*.md` | Built-in prompt corpus that must remain substantive, product-level, and leakage-free. |
| `packages/config/src/__tests__/builtin-prompts.test.ts` | Existing source-prompt leakage tests that must allow intentional Mustache placeholders without weakening banned-token checks. |
| `packages/config/src/__tests__/builtin-compose-smoke.test.ts` | Existing cross-package smoke test that must prove rendered built-ins have Mermaid delegation and no unresolved tags. |
| `docs/prompt-composition.md` | Operational contract for prompt templates, Template Context, errors, fallback order, and adapter consumption. |
| `docs/adr/0001-prompt-composition-templates.md` | Rationale record for engine-owned Mustache Prompt Templates. |
| `CONTEXT.md` | Glossary for Prompt Template, Template Context, Delegation Diagram, and Composed Prompt terminology. |
| `docs/specs/11-spec-prompt-composition-templates/11-spec-prompt-composition-templates.md` | Source specification whose requirements and proof artifacts drive this task list. |
| `docs/specs/11-spec-prompt-composition-templates/11-audit-prompt-composition-templates.md` | Planning audit report for SDD2 gate results. |

### Notes

- Unit tests should be placed alongside existing package tests under `packages/engine/src/__tests__/` and `packages/config/src/__tests__/`.
- Use Bun commands from repository docs: `bun run --filter '@weave/engine' test`, `bun run --filter '@weave/engine' typecheck`, `bun test`, `bun run typecheck`, and `bun run lint`.
- Follow repository style: no `console.*`, no explicit `any`, no nested ternaries, kebab-case or snake_case filenames, and `neverthrow` results for expected failures.
- Do not start or depend on any real harness; tests must use pure config/engine fixtures or existing builtin composition smoke patterns.
- Proof artifacts must be sanitized: no real secrets, credentials, private paths beyond repository-relative paths, environment dumps, or harness-specific tokens in built-in prompts.

## Tasks

### [x] 1.0 Establish the safe Mustache renderer wrapper

#### 1.0 Proof Artifact(s)

- Diff: `packages/engine/package.json` and lockfile show the canonical `mustache` dependency added to `@weave/engine` with types only if required.
- Test: `bun test packages/engine/src/__tests__/template-renderer.test.ts` covers supported Mustache subset, reference extraction, escaped literal tags, unsupported tags, malformed templates, unknown/unsafe/function-valued paths, and unresolved-tag detection.
- CLI: `bun run --filter '@weave/engine' test` passes, proving package integration.
- Code review artifact: `packages/engine/src/template-renderer.ts` has no filesystem, environment, process, helper, lambda, or partial-loading behavior and returns `neverthrow` results.

#### 1.0 Tasks

- [x] 1.1 Add `mustache` to `packages/engine/package.json` and update `bun.lock`; add `@types/mustache` only if the package does not provide sufficient TypeScript types.
- [x] 1.2 Create `packages/engine/src/template-renderer.ts` with internal parse/render result types that use `Result` or `ResultAsync` instead of throwing expected errors.
- [x] 1.3 Implement preprocessing and restoration for escaped literal tag openings such as `\{{path}}` and `\{{{path}}}`.
- [x] 1.4 Wrap `Mustache.parse()` so parsed token metadata can identify real variable, section, inverted-section, unescaped, and current-item references.
- [x] 1.5 Reject unsupported token types for partials and delimiter changes with typed unsupported-feature errors.
- [x] 1.6 Validate referenced paths against allowed-path metadata, including section-relative paths, dotted names, optional falsey paths, and `{{.}}` for scalar list items.
- [x] 1.7 Reject unsafe paths and prototype traversal such as `__proto__`, `prototype`, `constructor`, and inherited object members.
- [x] 1.8 Reject function or callable values anywhere reachable from the Template Context before rendering to prevent Mustache lambdas.
- [x] 1.9 Render parsed templates with default Mustache HTML escaping for double braces and support triple braces for trusted Markdown-rich fields.
- [x] 1.10 Add a post-render unresolved-tag check that fails real unescaped `{{...}}` / `{{{...}}}` leftovers while allowing restored escaped literals.
- [x] 1.11 Add `packages/engine/src/__tests__/template-renderer.test.ts` covering supported tags, nested sections, comments, `{{.}}`, escaped literals, unknown paths, unsafe paths, function values, unsupported tags, malformed syntax, and unresolved tags.
- [x] 1.12 Run `bun run --filter '@weave/engine' test` and record the passing renderer proof artifact.

### [x] 2.0 Define the bounded Template Context and delegation guidance generator

#### 2.0 Proof Artifact(s)

- Diff: `packages/engine/src/template-context.ts` contains `AgentPromptTemplateContext`, allowed-path metadata, context builders, and delegation Markdown/Mermaid generation helpers.
- Test: `bun test packages/engine/src/__tests__/template-context.test.ts` proves agent/category/tool-policy/delegation context shape, optional path behavior, and no raw config exposure.
- Test: delegation output cases prove stable Mermaid `flowchart TD`, escaped labels, deduplicated domain edge labels, compact bullets, and omitted `delegation.section`/`delegation.mermaid` when no targets exist.
- Typecheck: `bun run --filter '@weave/engine' typecheck` proves exported context/error types compile without exporting renderer internals.

#### 2.0 Tasks

- [x] 2.1 Create `packages/engine/src/template-context.ts` with `AgentPromptTemplateContext`, delegation context types, and exported template context/error types intended for the public engine barrel.
- [x] 2.2 Define explicit allowed-path metadata for `agent`, optional `category`, `toolPolicy.effective`, `delegation`, nested `delegation.targets`, nested `triggers`, scalar `domains`, and `{{.}}` item contexts.
- [x] 2.3 Implement an agent context builder that projects only `agent.name`, optional `description`, `mode`, `skills`, and `isCategory` from composition inputs.
- [x] 2.4 Implement category context projection for generated category shuttle agents only, including `category.name` and optional `category.description` while omitting `category` for non-category agents.
- [x] 2.5 Project only resolved effective tool policy values under `toolPolicy.effective` and avoid exposing raw tool policy.
- [x] 2.6 Project `delegation.targets` to include `name`, optional `description`, deduplicated `domains`, and trigger `{ domain, trigger }` details.
- [x] 2.7 Generate deterministic Mermaid `flowchart TD` as a current-agent star with stable synthetic node IDs, escaped quoted labels, and deduplicated domain edge labels.
- [x] 2.8 Generate canonical `delegation.section` Markdown containing `## Delegation`, the Mermaid block, and compact bullets with nested trigger lines.
- [x] 2.9 Omit `delegation.section` and `delegation.mermaid` when there are no eligible delegation targets while keeping `delegation.targets` as an empty array.
- [x] 2.10 Add `packages/engine/src/__tests__/template-context.test.ts` covering context shape, no raw config/model/temperature/path exposure, optional category behavior, allowed optional paths, Mermaid escaping, domain labels, bullets, and no-target omission.
- [x] 2.11 Export only the intended Template Context and error types from `packages/engine/src/index.ts`; keep low-level renderer functions internal.
- [x] 2.12 Run `bun run --filter '@weave/engine' typecheck` and record the passing type proof artifact.

### [ ] 3.0 Integrate template rendering into `composeAgentDescriptor()`

#### 3.0 Proof Artifact(s)

- Test: updated `packages/engine/src/__tests__/compose.test.ts` proves inline prompt rendering, prompt-file rendering, rendered `prompt_append`, fallback placement, primary-source-only fallback suppression, append references not suppressing fallback, static prompt compatibility, and typed `PromptTemplateError` results.
- Test: compose error cases prove `agentName`, `sourceKind`, optional `promptFilePath`, line/column where available, and nested reason discriminants.
- CLI: `bun run --filter '@weave/engine' test` passes without real harnesses.
- Code review artifact: `packages/engine/src/compose.ts` keeps `ResultAsync<AgentDescriptor, ComposeError>`, avoids expected-failure `try/catch`, and does not move prompt logic into adapters.

#### 3.0 Tasks

- [ ] 3.1 Extend `ComposeError` in `packages/engine/src/compose.ts` with a single `PromptTemplateError` variant and nested reason discriminants for malformed syntax, unsupported tags, unknown paths, unsafe paths, function values, section mismatch, and unresolved tags.
- [ ] 3.2 Replace old flat delegation-section formatting with Template Context construction from the current agent, effective tool policy, category metadata, and filtered delegation targets.
- [ ] 3.3 Render the primary `prompt` or `prompt_file` source as a Mustache template before any fallback delegation is inserted.
- [ ] 3.4 Render merged `prompt_append` as a Mustache template with the same Template Context and report append errors with `sourceKind: "prompt_append"` line/column in the merged append text.
- [ ] 3.5 Detect fallback suppression only from parsed primary-source real tokens whose path starts with `delegation`, excluding comments, escaped literals, raw text, and all `prompt_append` references.
- [ ] 3.6 Assemble final prompt text in the order rendered primary source, optional fallback `delegation.section`, then rendered `prompt_append`.
- [ ] 3.7 Preserve existing static prompt behavior when sources contain no Mustache tags and no eligible delegation fallback applies.
- [ ] 3.8 Map renderer/context errors into `PromptTemplateError` with `agentName`, `sourceKind`, optional `promptFilePath`, message, path/tag, and line/column where available.
- [ ] 3.9 Keep `composeAgentDescriptor()` returning `ResultAsync<AgentDescriptor, ComposeError>` and avoid expected-failure `try/catch` control flow.
- [ ] 3.10 Extend `packages/engine/src/__tests__/compose.test.ts` for inline template rendering, prompt-file template rendering, rendered append, fallback placement, source-only suppression, append no-suppress behavior, static prompt compatibility, and typed template error metadata.
- [ ] 3.11 Run `bun run --filter '@weave/engine' test` and record the passing compose proof artifact.

### [ ] 4.0 Align builtin prompts and config smoke coverage with rendered templates

#### 4.0 Proof Artifact(s)

- Diff: `packages/config/prompts/loom.md` and `packages/config/prompts/tapestry.md` use `{{{delegation.section}}}` only where natural; non-delegating prompts avoid artificial template tags.
- Test: `bun test packages/config/src/__tests__/builtin-prompts.test.ts` proves source prompts remain substantive, allow intentional Mustache placeholders, and still reject repo/harness leakage.
- Test: `bun test packages/config/src/__tests__/builtin-compose-smoke.test.ts` proves all builtins compose, delegating prompts include Mermaid-based delegation guidance, non-delegating prompts omit delegation, and no unresolved unescaped tags leak.
- Sanitized review artifact: rendered builtin prompts contain no raw config, prompt file paths, model lists, repo-only policy, harness tool names, secrets, or environment/process data.

#### 4.0 Tasks

- [ ] 4.1 Update `packages/config/prompts/loom.md` to place `{{{delegation.section}}}` where routing guidance naturally belongs.
- [ ] 4.2 Update `packages/config/prompts/tapestry.md` to place `{{{delegation.section}}}` where routing guidance naturally belongs.
- [ ] 4.3 Review all `packages/config/prompts/*.md` files and avoid artificial template tags in prompts where Template Context fields do not improve clarity.
- [ ] 4.4 Update `packages/config/src/__tests__/builtin-prompts.test.ts` so source prompt checks allow intentional Mustache placeholders while preserving banned repo/harness leakage tokens.
- [ ] 4.5 Update `packages/config/src/__tests__/builtin-compose-smoke.test.ts` to assert all built-ins compose after rendering and no unresolved unescaped Mustache tags remain.
- [ ] 4.6 Update builtin smoke assertions so delegating built-ins include `## Delegation`, a Mermaid code block, `flowchart TD`, and expected specialist names.
- [ ] 4.7 Keep non-delegating builtin assertions proving no fallback `## Delegation` section is emitted.
- [ ] 4.8 Add or update sanitized review checks so rendered built-in prompts do not expose raw config objects, prompt file paths, model lists, repo-only policy, harness tool names, secrets, environment, or process data.
- [ ] 4.9 Run `bun test packages/config/src/__tests__/builtin-prompts.test.ts` and `bun test packages/config/src/__tests__/builtin-compose-smoke.test.ts`; record both passing proof artifacts.

### [ ] 5.0 Finalize documentation, verification gates, and security audit

#### 5.0 Proof Artifact(s)

- Documentation diff: `docs/prompt-composition.md`, `docs/adr/0001-prompt-composition-templates.md`, and `CONTEXT.md` match implemented behavior, terminology, errors, fallback rules, and non-goals.
- CLI: `bun run typecheck`, `bun test`, and `bun run lint` pass.
- Scope audit artifact: confirms no workflow step templating, no new DSL opt-in fields, no raw config exposure, no partials/helpers/lambdas, and no full delegation graph modeling.
- Security review artifact: Warp review covers unsafe path/prototype traversal, function values, unresolved tags, new dependency risk, and absence of filesystem/env/process/adapter leakage.

#### 5.0 Tasks

- [ ] 5.1 Re-read `docs/prompt-composition.md`, `docs/adr/0001-prompt-composition-templates.md`, and `CONTEXT.md` after implementation and patch any drift from actual behavior.
- [ ] 5.2 Verify the final implementation still excludes workflow step prompt templating, raw config exposure, partials, delimiter changes, helpers, lambdas, new DSL opt-in fields, and full delegation graph modeling.
- [ ] 5.3 Run `bun run lint` and fix style issues without mixing unrelated formatting changes.
- [ ] 5.4 Run `bun run typecheck` and fix TypeScript errors.
- [ ] 5.5 Run `bun test` and fix failing tests.
- [ ] 5.6 Run `bun run build` if typecheck/tests pass, to prove bundled packages and declarations still emit.
- [ ] 5.7 Request Warp security review for template rendering, unsafe path/prototype traversal, function value rejection, unresolved tag checks, and new dependency risk.
- [ ] 5.8 Address any Warp REQUIRED findings and re-run affected tests.
- [ ] 5.9 Update `docs/specs/11-spec-prompt-composition-templates/11-audit-prompt-composition-templates.md` or validation notes with final proof artifact commands and security review status.
