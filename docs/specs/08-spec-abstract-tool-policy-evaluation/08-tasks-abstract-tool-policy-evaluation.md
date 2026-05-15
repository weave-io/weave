## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `docs/specs/08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md` | Approved source spec for Abstract Tool Policy Evaluation requirements, non-goals, proof artifacts, and security constraints. |
| `docs/specs/08-spec-abstract-tool-policy-evaluation/08-tasks-abstract-tool-policy-evaluation.md` | SDD task plan mapping the approved spec into parent tasks, sub-tasks, and proof artifacts. |
| `docs/specs/08-spec-abstract-tool-policy-evaluation/08-audit-abstract-tool-policy-evaluation.md` | SDD2 planning audit for gate results, standards evidence, and exception reporting. |
| `docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md` | Existing `tool-policy-mapping` capability vocabulary that the adapter-facing classification contract must align with. |
| `docs/adapter-boundary.md` | Architecture boundary source that must document engine-owned abstract policy evaluation and adapter-owned concrete tool mapping/enforcement. |
| `docs/product-vision.md` | Product-level source for Weave-owned normalized intent and adapter-owned harness translation; should link any new policy-evaluation guide if added. |
| `docs/tool-policy-evaluation.md` | New companion guide for effective tool policy defaults, classification inputs, run-agent effects, and redaction expectations. |
| `packages/core/src/schema.ts` | Existing source-of-truth definitions for `ToolPermissionSchema`, `ToolPolicySchema`, `ToolPermission`, and `ToolPolicy`. |
| `packages/core/src/index.ts` | Public `@weave/core` barrel that must export `ToolPolicy` and `ToolPolicySchema` in addition to existing policy exports. |
| `packages/core/src/__tests__/schema.test.ts` | Core schema/public-export regression tests proving tool-policy schema behavior remains the source of truth. |
| `packages/engine/src/tool-policy.ts` | New pure engine module for effective policy types, defaults, evaluation, adapter-facing classifications, and per-tool decisions. |
| `packages/engine/src/run-agent-effects.ts` | New engine module for sanitized run-agent effect/debug types used by `WeaveRunner` and tests. |
| `packages/engine/src/index.ts` | Public `@weave/engine` barrel that must export tool-policy helpers, types, constants, and run-agent effect types. |
| `packages/engine/src/descriptors.ts` | Existing category shuttle generation and `tool_policy` inheritance/override behavior that must be preserved and tested. |
| `packages/engine/src/runner.ts` | Transitional run-agent materialization path that must emit effective policy effect/debug data while preserving raw adapter pass-through. |
| `packages/engine/src/adapter.ts` | Transitional `HarnessAdapter` boundary; should not receive a breaking concrete-tool enforcement API for this spec. |
| `packages/engine/src/capability-contract.ts` | Existing Spec 07 capability contract containing `tool-policy-mapping`; useful for comments/docs alignment, not concrete tool enforcement. |
| `packages/engine/src/__tests__/tool-policy.test.ts` | New isolated engine tests for effective policy defaults, classification decisions, unmapped outcomes, and sanitized fixtures. |
| `packages/engine/src/__tests__/runner.test.ts` | Existing mock-adapter runner tests to extend for run-agent effects, raw `tool_policy` pass-through, and generated shuttle effective policies. |
| `packages/engine/src/__tests__/descriptors.test.ts` | Existing category shuttle inheritance tests to extend or preserve for base/category `tool_policy` merge semantics. |
| `packages/engine/src/__tests__/mock-adapter.ts` | In-memory `HarnessAdapter` test double used by runner tests; update only if the effect tests need additional observable call data. |
| `package.json` | Root Bun scripts for `lint`, `typecheck`, `build`, and `test` verification. |
| `.github/workflows/ci.yml` | CI gate order and Bun version expectation for final verification. |
| `biome.json` | Formatting/lint rules: no `console`, no explicit `any`, no nested ternary, and kebab/snake-case filenames. |
| `tsconfig.json` | Strict TypeScript and Bun-type workspace settings that new public exports must satisfy. |
| `bunfig.toml` | Bun test preload, timeout, and smol-mode configuration for planned test commands. |

### Notes

- Current core schemas already define the policy vocabulary; implementation should primarily expose existing types/schemas rather than editing schema semantics.
- Pure non-fallible policy helpers may return plain values. If implementation adds runtime validation for untrusted adapter input, model failures with `neverthrow` `Result` and discriminated errors.
- Do not implement harness-specific permission enforcement or hard-code OpenCode, Claude Code, Pi, or future harness tool names in engine code or tests.
- Run-agent effect/debug output must be sanitized and non-breaking: keep `HarnessAdapter.spawnSubagent(name, config)` raw `tool_policy` pass-through available.
- Permission work is security-sensitive; a Warp security audit is required later after implementation changes exist, but this SDD2 planning audit is not that security audit.

## Tasks

### [x] 1.0 Export core tool-policy vocabulary and define the engine effective policy model

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/core/src/__tests__/schema.test.ts packages/engine/src/__tests__/tool-policy.test.ts` demonstrates `@weave/core` remains the source of truth for `ToolPermission`, `ToolPolicy`, `ToolPermissionSchema`, and `ToolPolicySchema`, while the engine effective model contains exactly `read`, `write`, `execute`, `delegate`, and `network`.
- Typecheck: `bun run typecheck` demonstrates public tool-policy exports are usable from downstream workspace packages through `packages/core/src/index.ts` and `packages/engine/src/index.ts`.
- Code review artifact: `packages/engine/src/tool-policy.ts` imports policy vocabulary from `@weave/core` and does not redefine the `allow` / `deny` / `ask` literals.

#### 1.0 Tasks

- [ ] 1.1 Confirm `packages/core/src/schema.ts` already defines `ToolPermissionSchema`, `ToolPolicySchema`, `ToolPermission`, and `ToolPolicy`; do not duplicate these literals or schema definitions in engine code.
- [ ] 1.2 Update `packages/core/src/index.ts` to export `ToolPolicy` and `ToolPolicySchema` alongside the existing `ToolPermission` and `ToolPermissionSchema` exports.
- [ ] 1.3 Create `packages/engine/src/tool-policy.ts` and import `ToolPermission` and `ToolPolicy` from `@weave/core` for all engine policy types.
- [ ] 1.4 Define an ordered abstract capability constant for exactly `read`, `write`, `execute`, `delegate`, and `network`, typed against `keyof ToolPolicy` so capability names stay tied to the core schema.
- [ ] 1.5 Define `EffectiveToolPolicy` so every abstract capability has a required `ToolPermission` value, with no optional capability fields.
- [ ] 1.6 Define a named default permission constant typed as `ToolPermission`, with value `ask`, and document that only an approved future spec may change it.
- [ ] 1.7 Add `packages/engine/src/__tests__/tool-policy.test.ts` coverage proving the capability list and effective model include exactly the five approved abstract capabilities.
- [ ] 1.8 Update `packages/core/src/__tests__/schema.test.ts` with a public-barrel assertion proving `ToolPolicy`, `ToolPolicySchema`, `ToolPermission`, and `ToolPermissionSchema` are importable from `@weave/core`.
- [ ] 1.9 Export the effective policy types/constants from `packages/engine/src/index.ts` without exposing any harness-specific tool names.
- [ ] 1.10 Run `bun test packages/core/src/__tests__/schema.test.ts packages/engine/src/__tests__/tool-policy.test.ts` and `bun run typecheck` as this parent task's proof commands.

### [x] 2.0 Implement pure effective tool-policy evaluation

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/tool-policy.test.ts` demonstrates explicit `allow`, `deny`, and `ask` values are preserved for configured capabilities.
- Test: `bun test packages/engine/src/__tests__/tool-policy.test.ts` demonstrates omitted `read`, `write`, `execute`, `delegate`, or `network` fields default to `ask` and the evaluated policy is always complete.
- Code review artifact: `packages/engine/src/tool-policy.ts` has no harness-owned discovery, concrete tool names, `Bun.file`, process spawning, adapter runtime calls, or harness imports.
- Typecheck: `bun run typecheck` demonstrates the pure evaluation API is exported from `@weave/engine` and usable without breaking existing packages.

#### 2.0 Tasks

- [ ] 2.1 Implement `evaluateEffectiveToolPolicy(policy: ToolPolicy | undefined): EffectiveToolPolicy` in `packages/engine/src/tool-policy.ts` as a pure helper with no adapter, file-system, process, or network dependencies.
- [ ] 2.2 Apply the named default permission to every capability whose field is omitted or whose input policy is `undefined`.
- [ ] 2.3 Preserve configured permissions unchanged for every capability when the input policy provides `allow`, `deny`, or `ask`.
- [ ] 2.4 Add table-driven tests for all five capabilities showing explicit configured values win over the default.
- [ ] 2.5 Add tests for `undefined` policy and partial policies showing the returned object is complete and omitted fields resolve to `ask`.
- [ ] 2.6 Keep the evaluator return type plain because the helper is deterministic and non-fallible; if any runtime parsing/validation helper is added later, return `Result<T, E>` instead of throwing.
- [ ] 2.7 Export `evaluateEffectiveToolPolicy` from `packages/engine/src/index.ts`.
- [ ] 2.8 Review `packages/engine/src/tool-policy.ts` imports and implementation to confirm it does not mention concrete harness tools, scan harness resources, call adapter methods, call `Bun.file`, or spawn processes.
- [ ] 2.9 Run `bun test packages/engine/src/__tests__/tool-policy.test.ts` and `bun run typecheck` as this parent task's proof commands.

### [x] 3.0 Define the adapter-facing concrete tool classification contract

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/tool-policy.test.ts` demonstrates an adapter-supplied concrete tool classified as `read` receives the effective `read` permission.
- Test: `bun test packages/engine/src/__tests__/tool-policy.test.ts` demonstrates an adapter-supplied concrete tool classified as `network` receives the effective `network` permission and all abstract capabilities can be mapped.
- Test: `bun test packages/engine/src/__tests__/tool-policy.test.ts` demonstrates an unknown or unmapped concrete tool produces an explicit unmapped outcome instead of an implicit allow.
- Code review artifact: the classification contract references abstract capabilities and Spec 07 `tool-policy-mapping` readiness vocabulary only; adapters still own concrete harness tool names and enforcement.
- Sanitized fixture: tool-classification tests use synthetic tool identifiers only and do not commit credentials, command arguments, local paths, harness config, or secret-bearing output.

#### 3.0 Tasks

- [ ] 3.1 Define an adapter-facing classification input type in `packages/engine/src/tool-policy.ts` for adapter-supplied concrete tool identifiers plus their abstract capability classification.
- [ ] 3.2 Keep concrete tool identifiers opaque strings supplied by adapters; do not add OpenCode, Claude Code, Pi, or other harness-specific tool names to engine constants, branches, or fixtures.
- [ ] 3.3 Define a per-tool decision union that distinguishes mapped decisions from explicit unmapped outcomes; mapped decisions should include the abstract capability and resulting `ToolPermission`.
- [ ] 3.4 Implement a pure helper that combines adapter-supplied classifications with an `EffectiveToolPolicy` to produce deterministic per-tool decisions.
- [ ] 3.5 Ensure missing, unknown, or unclassified concrete tools produce an explicit unmapped outcome and never receive an implicit `allow` permission.
- [ ] 3.6 Add tests proving tools classified as `read`, `write`, `execute`, `delegate`, and `network` receive the matching effective policy permission.
- [ ] 3.7 Add tests proving a synthetic unknown/unmapped tool id produces the unmapped outcome with no permission value that an adapter could mistake for allow.
- [ ] 3.8 Add comments or docs linking the classification helper to Spec 07's `tool-policy-mapping` capability instead of introducing a new readiness vocabulary.
- [ ] 3.9 Export the classification input, decision types, and helper from `packages/engine/src/index.ts`.
- [ ] 3.10 Review fixtures and snapshots to confirm they use synthetic identifiers such as `synthetic.read-tool` and contain no credentials, command arguments, local paths, harness config, or secret-bearing output.
- [ ] 3.11 Run `bun test packages/engine/src/__tests__/tool-policy.test.ts` and `bun run typecheck` as this parent task's proof commands.

### [x] 4.0 Surface effective policy in run-agent effects and category shuttles

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/runner.test.ts` demonstrates `WeaveRunner` exposes `effectiveToolPolicy` in run-agent debug/effect data while preserving raw `tool_policy` pass-through for the transitional adapter surface.
- Test: `bun test packages/engine/src/__tests__/descriptors.test.ts packages/engine/src/__tests__/runner.test.ts` demonstrates generated `shuttle-{category}` agents inherit base shuttle policy, category fields override base fields before evaluation, and omitted fields default to `ask` after inheritance.
- Sanitized fixture: run-agent effect tests assert debug output contains abstract `effectiveToolPolicy` only and excludes concrete tool names, credentials, local harness state, command arguments, and secret-bearing output.
- Docs: `docs/tool-policy-evaluation.md` plus links from `docs/adapter-boundary.md` and `docs/product-vision.md` document the abstract policy evaluation boundary, adapter-owned concrete tool mapping, category inheritance semantics, and redaction expectations.
- Verification: `bun run lint && bun run typecheck && bun run build && bun run test` demonstrates the completed implementation satisfies repository CI gates without regressions.

#### 4.0 Tasks

- [x] 4.1 Define a sanitized `RunAgentEffect` type in `packages/engine/src/run-agent-effects.ts` that includes agent identity and `effectiveToolPolicy` but no concrete tool names, command arguments, harness config, or credentials.
- [x] 4.2 Add a non-breaking `WeaveRunnerOptions` constructor parameter with an optional `onEffect(effect: RunAgentEffect): void` callback, default it to omitted, and do not change `HarnessAdapter.spawnSubagent(name, config)`.
- [x] 4.3 In `packages/engine/src/runner.ts`, evaluate each non-disabled agent's effective policy after category shuttles have been generated and merged, then emit the run-agent effect/debug data associated with that spawned agent.
- [x] 4.4 Preserve the existing raw `tool_policy` pass-through to `adapter.spawnSubagent(name, agentConfig)` for adapters that still consume the transitional adapter surface.
- [x] 4.5 Extend `packages/engine/src/__tests__/runner.test.ts` to prove normal agents emit an effect containing complete `effectiveToolPolicy` values and still pass raw `tool_policy` to the mock adapter unchanged.
- [x] 4.6 Extend `packages/engine/src/__tests__/runner.test.ts` to prove generated category shuttles inherit base shuttle `tool_policy` when the category has none, then default omitted capabilities to `ask` in the emitted effective policy.
- [x] 4.7 Extend `packages/engine/src/__tests__/runner.test.ts` to prove category `tool_policy` fields override base shuttle fields before effective policy evaluation, while keeping existing `packages/engine/src/__tests__/descriptors.test.ts` merge assertions passing.
- [x] 4.8 Add a sanitization assertion for run-agent effect fixtures proving the effect contains `effectiveToolPolicy` and abstract agent metadata only, with no concrete tool ids or secret-bearing fields.
- [x] 4.9 Update `packages/engine/src/index.ts` to export any new run-agent effect/debug types needed by downstream adapters or tests.
- [x] 4.10 Create `docs/tool-policy-evaluation.md` to explain effective policy defaults, adapter-owned concrete classification/enforcement, run-agent effect redaction, and category inheritance order.
- [x] 4.11 Link `docs/tool-policy-evaluation.md` from `docs/adapter-boundary.md` and `docs/product-vision.md` for discoverability.
- [x] 4.12 Confirm `packages/engine/src/adapter.ts` remains non-breaking; document any unavoidable adapter interface change before making it, but prefer not to change the interface for this spec.
- [x] 4.13 Run targeted tests: `bun test packages/engine/src/__tests__/tool-policy.test.ts packages/engine/src/__tests__/descriptors.test.ts packages/engine/src/__tests__/runner.test.ts`.
- [x] 4.14 Run full verification: `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test`.
- [x] 4.15 Record in the implementation handoff that a separate Warp security audit is required after code changes are complete; do not treat this SDD2 planning audit as the security audit.
