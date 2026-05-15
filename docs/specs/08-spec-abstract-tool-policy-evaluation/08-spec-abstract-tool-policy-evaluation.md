# 08-spec-abstract-tool-policy-evaluation.md

## Introduction/Overview

Implement **Abstract Tool Policy Evaluation** in `@weave/engine` so Weave can turn an agent's normalized `tool_policy` into explicit, harness-neutral permission decisions before an adapter maps those decisions to concrete harness tools. The primary goal is to keep policy semantics in the engine while preserving adapter ownership of concrete tool names, permission mechanisms, and harness-specific enforcement.

This spec is based on GitHub issue [#57](https://github.com/weave-io/weave/issues/57) and depends on the adapter-boundary work in issue #9 and the adapter capability contract from issue #49 / [Spec 07](../07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md).

## Goals

- Provide a pure engine API that evaluates an agent's effective `tool_policy` for each abstract capability: `read`, `write`, `execute`, `delegate`, and `network`.
- Define deterministic default behavior for missing tool-policy fields so adapters never need to guess whether an absent capability is allowed, denied, or requires approval.
- Preserve adapter ownership of concrete tool classification by accepting adapter-supplied tool-to-capability mappings as explicit input.
- Include the evaluated effective tool policy in run-agent debug/effect data without exposing harness-specific secrets or changing the transitional adapter interface unnecessarily.
- Add tests proving `allow`, `deny`, `ask`, defaults, category shuttle inheritance, and adapter-facing classification behavior.

## User Stories

- **As an engine developer**, I want tool policy decisions to be evaluated by a pure engine helper so that permission semantics are consistent across all harness adapters.
- **As an adapter maintainer**, I want to supply concrete tool classifications and receive abstract policy decisions so that my adapter can enforce Weave intent using harness-specific mechanisms.
- **As a workflow/debugging user**, I want run-agent debug data to show the effective policy that was applied so that unexpected tool availability can be investigated without reading merged config internals.
- **As a category author**, I want generated `shuttle-{category}` agents to inherit and override `tool_policy` consistently so that specialist agents follow predictable permission boundaries.

## Demoable Units of Work

### Unit 1: Public Tool Policy Types and Effective Policy Model

**Purpose:** Establish the shared vocabulary and public exports needed by engine helpers, adapters, and tests without duplicating `@weave/core` schema concepts.

**Functional Requirements:**
- The system shall export `ToolPermission`, `ToolPolicy`, `ToolPermissionSchema`, and `ToolPolicySchema` from `@weave/core` so downstream packages can import the existing source-of-truth types.
- The system shall define an engine-owned `EffectiveToolPolicy` model that contains exactly one permission for each abstract capability: `read`, `write`, `execute`, `delegate`, and `network`.
- The system shall define a named default permission for any missing capability field; the default shall be `ask` unless a future approved spec explicitly changes the default.
- The system shall avoid redefining `allow | deny | ask` literals outside `@weave/core`.

**Proof Artifacts:**
- `Test: packages/core/src/__tests__/schema.test.ts passes` demonstrates the core tool policy schema remains the source of truth.
- `Test: packages/engine/src/__tests__/tool-policy.test.ts passes` demonstrates an effective policy always includes all five abstract capabilities.
- `Typecheck: bun run typecheck` demonstrates public tool-policy exports are usable across workspace packages.

### Unit 2: Effective Tool Policy Evaluation API

**Purpose:** Provide a deterministic engine helper that converts optional agent policy into explicit abstract permission decisions.

**Functional Requirements:**
- The system shall provide a pure engine function for evaluating an agent's effective tool policy from a `ToolPolicy | undefined` input.
- The system shall return the configured permission for any capability present in the input policy.
- The system shall return the default `ask` permission for any capability omitted from the input policy.
- The system shall not perform harness I/O, scan harness configuration, inspect concrete tool names, or call adapter runtime APIs while evaluating policy.
- The system shall expose the policy evaluation API from `@weave/engine` through `packages/engine/src/index.ts`.

**Proof Artifacts:**
- `Test: explicit allow/deny/ask values are preserved` demonstrates each configured permission is evaluated unchanged.
- `Test: missing fields default to ask` demonstrates adapters receive a complete policy without guessing.
- `Code review artifact: packages/engine/src/tool-policy.ts has no Bun.file, process spawning, harness imports, or adapter runtime calls` demonstrates boundary compliance.

### Unit 3: Adapter-Facing Concrete Tool Classification Contract

**Purpose:** Let adapters map concrete harness tools to Weave abstract capabilities while keeping concrete tool identifiers out of the engine's policy semantics.

**Functional Requirements:**
- The system shall define an adapter-facing classification input shape in which adapters provide concrete tool identifiers and their corresponding abstract capability.
- The system shall define a pure engine helper that combines adapter-supplied classifications with an `EffectiveToolPolicy` to produce per-tool permission decisions.
- The system shall preserve unmapped or unknown tool classifications as explicit outcomes rather than silently allowing them.
- The system shall not require the engine to know OpenCode, Claude Code, Pi, or any future harness tool names.
- The system shall align the classification contract with [Spec 07](../07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md)'s `tool-policy-mapping` capability rather than creating a separate readiness vocabulary.

**Proof Artifacts:**
- `Test: concrete tool mapped to read receives read policy` demonstrates adapter-supplied classifications drive per-tool decisions.
- `Test: concrete tool mapped to network receives network policy` demonstrates all abstract capabilities can be applied to concrete tool names.
- `Test: unknown concrete tool reports an explicit unmapped outcome` demonstrates unsafe silent allowance is avoided.
- `Code review artifact: adapter-facing contract references abstract capabilities only` demonstrates concrete names remain adapter-owned.

### Unit 4: Debuggable Run-Agent Policy Effects and Category Inheritance

**Purpose:** Make applied policy observable during agent materialization and prove generated category shuttles receive the correct effective policy.

**Functional Requirements:**
- The system shall include the evaluated `EffectiveToolPolicy` in run-agent debug/effect data associated with each spawned agent.
- The system shall keep raw `tool_policy` pass-through behavior available for adapters that still consume the transitional `HarnessAdapter.spawnSubagent(name, config)` surface.
- The system shall not require a breaking change to the transitional `HarnessAdapter` interface unless implementation discovers no non-breaking path.
- The system shall preserve existing category shuttle merge semantics: base shuttle `tool_policy` is inherited, category `tool_policy` fields override matching base fields, and unset category fields keep base values.
- The system shall evaluate generated category shuttle policy after inheritance and override merging, not before.

**Proof Artifacts:**
- `Test: WeaveRunner exposes effective tool policy in run-agent debug/effect data` demonstrates debuggability for materialized agents.
- `Test: generated category shuttle inherits base policy and defaults omitted fields to ask` demonstrates inherited policies become complete effective policies.
- `Test: generated category shuttle category fields override base fields before evaluation` demonstrates category-specific permissions win.
- `Sanitized fixture: run-agent effect includes effectiveToolPolicy only` demonstrates debug output avoids concrete tool names, credentials, and harness secrets.

## Non-Goals (Out of Scope)

1. **Harness-specific permission enforcement**: This spec does not implement OpenCode, Claude Code, Pi, or any other adapter's concrete permission mechanism.
2. **New DSL syntax**: This spec does not add new `.weave` keywords or change the existing `tool_policy { read|write|execute|delegate|network allow|deny|ask }` syntax.
3. **Full security sandboxing**: This spec provides policy evaluation inputs for adapters; it does not guarantee OS-level isolation, process sandboxing, or network egress control.
4. **Replacing the transitional `HarnessAdapter` interface**: This spec may add debug/effect structures, but broad adapter lifecycle redesign remains separate work.
5. **Complete CLI doctor/status integration**: This spec aligns with the `tool-policy-mapping` capability from Spec 07, but full CLI rendering can be implemented in downstream tasks if needed.

## Design Considerations

No specific UI design requirements identified. Any human-readable debug or CLI output derived from the effective policy should use clear labels for the five abstract capabilities and avoid exposing concrete tool identifiers unless the adapter has sanitized them for display.

## Repository Standards

- Follow the engine/adapter boundary in [`docs/adapter-boundary.md`](../../adapter-boundary.md): the engine owns abstract policy decisions, while adapters own concrete tool names and harness-specific permission application.
- Follow the product vision in [`docs/product-vision.md`](../../product-vision.md): Weave exposes normalized primitives and adapters translate those primitives into concrete harness behavior.
- Reuse `ToolPolicy` and `ToolPermission` from `@weave/core`; do not duplicate schema literals or hand-written equivalents in the engine.
- Keep engine helpers pure and adapter-facing, following the style of `packages/engine/src/model-resolution.ts`: explicit input object in, normalized result out, no harness discovery.
- Use Bun-only tooling: `bun test`, `bun run typecheck`, and workspace package commands as needed.
- Use `neverthrow` for functions that can fail. Pure non-fallible evaluation helpers may return plain values; fallible classification or validation helpers should return `Result<T, E>` with explicit discriminated error types.
- Add isolated tests with mocks and fixtures rather than starting real harnesses or reading real harness state.
- Export public APIs through package barrels, especially `packages/core/src/index.ts` and `packages/engine/src/index.ts`.
- Update documentation for any non-trivial architecture behavior introduced during implementation, especially adapter-boundary or capability-contract terminology.
- Use Conventional Commits when the later SDD task workflow creates the planning commit.

## Technical Considerations

- The likely implementation home is a new engine module such as `packages/engine/src/tool-policy.ts`, exported from `packages/engine/src/index.ts`.
- `packages/core/src/schema.ts` already defines and exports `ToolPermissionSchema`, `ToolPolicySchema`, `ToolPermission`, and `ToolPolicy` internally, but `packages/core/src/index.ts` must export them for downstream public use.
- `packages/engine/src/descriptors.ts` already shallow-merges category `tool_policy` over base shuttle `tool_policy`; implementation should preserve and test this behavior before evaluating the effective policy.
- The default permission for omitted fields should be `ask` because it preserves safety without blocking all unspecified behavior. `deny` would be stricter but could unexpectedly break existing configs; `allow` would be unsafe for omitted permission fields.
- Unknown or unmapped concrete tools should not be silently allowed. The classification helper should make unmapped status observable so adapters can deny, ask, or report readiness gaps according to their harness behavior.
- Run-agent debug/effect data should include enough structure to explain the effective policy, but it should not force a breaking adapter interface change unless necessary.
- Latest-standards research summary: Neverthrow documentation for current TypeScript error-handling guidance was consulted via Context7 (`/supermacro/neverthrow`, living GitHub wiki/docs). Relevant guidance: avoid throwing for expected failures; encode fallible paths with `Result` or `ResultAsync`; use `ResultAsync.fromPromise`/`fromThrowable` when wrapping Promise or throwing APIs. This supports plain return values for pure non-fallible policy evaluation and `Result<T, E>` for any validation/classification path that can fail.

## Security Considerations

- Tool policy evaluation is security-sensitive because incorrect `allow`, `deny`, or `ask` decisions could grant broader harness tool access than intended.
- The default for missing capability fields shall be `ask` to avoid silent permission escalation while preserving user-mediated execution.
- Adapter-supplied concrete tool classifications must not be trusted to include credentials, secrets, command arguments, local file contents, or `.env` values in debug artifacts.
- Run-agent debug/effect output should include abstract policy decisions and sanitized identifiers only; proof artifacts must not commit API keys, tokens, credentials, local harness secrets, or secret-bearing tool output.
- Because this work touches tool permissions and input classification, the implementation plan and completed code changes should receive a Warp security audit before execution is considered complete.

## Success Metrics

1. **Policy completeness**: Every evaluated policy contains exactly `read`, `write`, `execute`, `delegate`, and `network` decisions.
2. **Default correctness**: Tests prove omitted capability fields evaluate to `ask` and never to implicit `allow`.
3. **Boundary compliance**: Engine policy helpers operate only on explicit inputs and do not reference concrete harness tool names or runtime APIs.
4. **Adapter usability**: Tests demonstrate adapter-supplied concrete tool classifications can be mapped to per-tool permission decisions for all abstract capabilities.
5. **Debuggability**: Run-agent effect/debug data exposes the effective policy for each materialized agent without leaking sensitive harness information.

## Open Questions

No open questions at this time.
