## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/core/src/schema.ts` | Add `AgentRoutingConfigSchema` and `AgentRoutingConfig` type; add optional `routing` field to `AgentConfigSchema`. |
| `packages/core/src/config.ts` | Inferred `AgentConfig` type gains `routing?: AgentRoutingConfig` automatically; verify no hand-written type needs updating. |
| `packages/core/src/__tests__/schema.test.ts` | Add schema-level tests: valid `routing` block accepted; unknown key rejected; `delegation_exclude` entries validated. |
| `packages/core/src/__tests__/validate.test.ts` | Add validate-layer tests: `routing.delegation_exclude` survives AST → WeaveConfig transform correctly. |
| `packages/core/src/__tests__/parse_config.test.ts` | Add E2E tests: full `.weave` source with `routing { delegation_exclude [...] }` parses to expected `WeaveConfig`. |
| `packages/engine/src/compose.ts` | Add guard 5 in `buildDelegationTargets()` to filter excluded targets; add debug log for unknown exclusion entries. |
| `packages/engine/src/__tests__/compose.test.ts` | Add tests: excluded target absent from `delegationTargets`; non-excluding router still sees the target; unknown entry emits debug log only; disabled+excluded overlap is a no-op. |
| `packages/core/src/parser.ts` | Verify the parser already handles nested `routing { }` blocks with array values; add parser test if a gap is found. |
| `packages/core/src/__tests__/parser.test.ts` | Add parser-level test for `routing { delegation_exclude [...] }` if the parser requires any change. |
| `docs/specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md` | Source specification for this task list. |

### Notes

- Tests must use `bun:test` and in-memory fixtures. Do not start a real harness, write real files, or spawn real processes.
- Use `bun run typecheck` to verify the schema change compiles across all packages before marking tasks complete.
- Use `bun test packages/core/src` and `bun test packages/engine/src` for focused test runs.
- Follow the engine/adapter boundary: exclusion logic lives entirely in `buildDelegationTargets()`; adapters receive pre-filtered `delegationTargets` and must not re-implement exclusion.
- The `routing` block uses `.strict()` — this is intentional and must not be changed to `.passthrough()` or `.strip()`.
- The debug log must use the shared pino logger from `@weave/engine`. Never use `console.*`.
- Schema change = test change at all four levels (schema, validate, parse_config, and parser if needed). See `AGENTS.md` testing table.

## Tasks

### [ ] 1.0 Add `AgentRoutingConfigSchema` to core schema

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/core/src/__tests__/schema.test.ts` passes with new `routing` field assertions demonstrating valid `delegation_exclude` arrays are accepted and unknown keys inside `routing { }` are rejected.
- Typecheck: `bun run typecheck` passes demonstrating `AgentRoutingConfig` and the updated `AgentConfig` type compile across all packages.
- Code review artifact: `AgentRoutingConfigSchema` uses `.strict()` and the JSDoc notes the block is open for future routing fields.

#### 1.0 Tasks

- [ ] 1.1 Add `AgentRoutingConfigSchema` to `packages/core/src/schema.ts` as a named export with `.strict()` and JSDoc describing the open extension intent.
- [ ] 1.2 Add `delegation_exclude: z.array(z.string()).optional()` as the only field in `AgentRoutingConfigSchema`.
- [ ] 1.3 Add `routing: AgentRoutingConfigSchema.optional()` to `AgentConfigSchema`.
- [ ] 1.4 Export `AgentRoutingConfig` as an inferred type from `packages/core/src/schema.ts`.
- [ ] 1.5 Verify `AgentConfig` (inferred from `AgentConfigSchema`) now includes `routing?: AgentRoutingConfig` without any hand-written type duplication.
- [ ] 1.6 Add schema-level tests in `packages/core/src/__tests__/schema.test.ts`:
  - Valid: agent with `routing: { delegation_exclude: ["warp"] }` passes `AgentConfigSchema.safeParse`.
  - Valid: agent with `routing: {}` (empty block) passes.
  - Valid: agent without `routing` field passes (field is optional).
  - Invalid: agent with `routing: { delegation_exclud: ["warp"] }` (typo) fails with a message referencing the unknown key.
  - Invalid: agent with `routing: { delegation_exclude: [123] }` (non-string entry) fails.
- [ ] 1.7 Run `bun run typecheck` and confirm it passes.

### [ ] 2.0 Add validate and parse_config coverage for `routing`

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/core/src/__tests__/validate.test.ts` passes with `routing.delegation_exclude` assertions demonstrating the field survives the AST → WeaveConfig transform.
- Test: `bun test packages/core/src/__tests__/parse_config.test.ts` passes with E2E assertions demonstrating a full `.weave` source string with `routing { delegation_exclude ["warp"] }` produces the expected `WeaveConfig`.

#### 2.0 Tasks

- [ ] 2.1 Add a validate-layer test in `packages/core/src/__tests__/validate.test.ts` that constructs an AST node with a `routing` block containing `delegation_exclude` and asserts the validated `AgentConfig` carries the correct value.
- [ ] 2.2 Add an E2E test in `packages/core/src/__tests__/parse_config.test.ts` using a `.weave` source string with `routing { delegation_exclude ["warp", "spindle"] }` and assert the parsed config has `agents.loom.routing.delegation_exclude` equal to `["warp", "spindle"]`.
- [ ] 2.3 Add an E2E test for an agent without a `routing` block and assert `agents.myagent.routing` is `undefined`.
- [ ] 2.4 Add an E2E test for `routing { }` (empty block) and assert `agents.myagent.routing.delegation_exclude` is `undefined`.
- [ ] 2.5 Run `bun test packages/core/src` and confirm all tests pass.

### [ ] 3.0 Add parser coverage for `routing { }` block (if needed)

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/core/src/__tests__/parser.test.ts` passes with `routing` block assertions demonstrating the parser correctly tokenizes and produces AST nodes for `routing { delegation_exclude [...] }`.

#### 3.0 Tasks

- [ ] 3.1 Inspect `packages/core/src/parser.ts` to confirm whether nested blocks with array values are already handled generically.
- [ ] 3.2 If the parser already handles `routing { }` without changes, add a parser test that asserts the AST shape for `routing { delegation_exclude ["warp"] }` and mark this task complete.
- [ ] 3.3 If the parser requires changes to handle `routing { }`, implement the minimal change, add tests, and document the change in a comment referencing Spec 18.
- [ ] 3.4 Run `bun test packages/core/src/__tests__/parser.test.ts` and confirm it passes.

### [ ] 4.0 Implement exclusion filtering in `buildDelegationTargets()`

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/compose.test.ts` passes with exclusion assertions demonstrating:
  - An excluded target is absent from `delegationTargets` for the excluding agent.
  - The same target is present in `delegationTargets` for a non-excluding agent.
  - An exclusion entry naming an unknown agent emits a debug log and does not cause an error.
  - An exclusion entry naming a disabled agent is a no-op (disabled guard fires first).
- CLI: `bun test packages/engine/src` passes demonstrating no regressions in existing engine tests.

#### 4.0 Tasks

- [ ] 4.1 In `packages/engine/src/compose.ts`, build a `Set<string>` from `agentConfig.routing?.delegation_exclude ?? []` at the start of `buildDelegationTargets()`.
- [ ] 4.2 Before the main target loop, iterate the `excluded` set and emit a debug log (using the shared pino logger) for any entry not present in `allAgents`.
- [ ] 4.3 Add guard 5 inside the main target loop: `if (excluded.has(targetName)) continue;`.
- [ ] 4.4 Verify the `Set` construction and unknown-entry log happen once per call, not inside the inner loop.
- [ ] 4.5 Add `compose.test.ts` test: agent with `routing.delegation_exclude: ["warp"]` produces `delegationTargets` that does not include `warp`.
- [ ] 4.6 Add `compose.test.ts` test: a second agent without `routing.delegation_exclude` in the same config still sees `warp` in its `delegationTargets`.
- [ ] 4.7 Add `compose.test.ts` test: `delegation_exclude` entry naming an agent not in `allAgents` does not throw and does not appear in `delegationTargets`.
- [ ] 4.8 Add `compose.test.ts` test: `delegation_exclude` entry naming a disabled agent produces the same result as if the entry were absent (target already excluded by disabled guard).
- [ ] 4.9 Add `compose.test.ts` test: `routing` field absent on `agentConfig` behaves identically to `routing: { delegation_exclude: [] }`.
- [ ] 4.10 Run `bun test packages/engine/src` and confirm all tests pass.

### [ ] 5.0 Verify end-to-end and run quality gates

#### 5.0 Proof Artifact(s)

- CLI: `bun run typecheck` passes across all packages.
- CLI: `bun test` passes across all packages.
- Documentation: `docs/specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md` is linked from at least one existing doc (e.g. `docs/adapter-boundary.md` or `AGENTS.md` DSL section).

#### 5.0 Tasks

- [ ] 5.1 Run `bun run typecheck` and confirm zero errors.
- [ ] 5.2 Run `bun test` and confirm all tests pass.
- [ ] 5.3 Add a cross-reference to Spec 18 in `docs/adapter-boundary.md` under the delegation section, noting that `routing.delegation_exclude` is engine-owned and adapters receive pre-filtered `delegationTargets`.
- [ ] 5.4 Confirm the worked example in `18-spec-delegation-exclusion.md` is accurate against the implemented behavior.
- [ ] 5.5 Create a PR referencing the relevant GitHub issue and this spec.
