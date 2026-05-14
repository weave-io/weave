# Weave Framework — Phased Execution Roadmap

## TL;DR
> **Summary**: Phased build-out of Weave from current core/config foundation through engine completion, CLI, OpenCode adapter, and beyond. First milestone: working `weave init` + `weave validate` CLI with OpenCode adapter.
> **Estimated Effort**: XL

## Context
### Original Request
Build a phased execution plan for the Weave framework that respects dependency order, references GitHub issues, and targets a working CLI + OpenCode adapter as the first milestone.

### Key Findings
- **@weave/core**: Complete — lexer, parser, AST, Zod schemas, validator, `parseConfig` pipeline (187 tests passing)
- **@weave/config**: Complete — builtins, discovery, merge, prompt resolution. 7 test failures from Windows `node:path` `resolve()` producing backslash paths vs. hardcoded forward-slash expectations
- **@weave/engine**: Scaffold — `WeaveRunner` does init + spawn loop; `HarnessAdapter` interface has `init`, `spawnSubagent`, `registerHook`, `loadSkill`; skill/hook loading deferred (TODO comments)
- **@weave/adapter-opencode**: Empty scaffold (barrel `index.ts` only)
- **CLI package**: Does not exist yet
- Issues already batched: batch-2 (#7,8,9,12), batch-3 (#6,10,11), batch-4 (#14,15), batch-5 (#16-19)

## Objectives
### Core Objective
Deliver a working `weave init` + `weave validate` CLI backed by the OpenCode adapter, then progressively add engine features and additional adapters.

### Deliverables
- [ ] All existing tests green (path separator fix)
- [ ] Engine: prompt composition, category descriptors, policy engine, skill loader
- [ ] CLI: `weave init`, `weave validate`, harness detection
- [ ] OpenCode adapter: full 6-phase config generation
- [ ] Additional adapters: Claude Code, Pi (partial)

### Definition of Done
- [ ] `bun test` — 0 failures across all packages
- [ ] `weave init` scaffolds a working `.weave/config.weave` + prompts directory
- [ ] `weave validate` parses and reports errors for any `.weave` file
- [ ] OpenCode adapter generates working agent configs from `.weave` input

### Guardrails (Must NOT)
- Do not build workflow engine before core engine features are solid
- Do not start Pi/Claude Code adapters before OpenCode adapter is validated
- Do not build LSP/tree-sitter/VSCode tooling until CLI and at least one adapter are stable

---

## Phases

### Phase 0 — Housekeeping & Green CI
**Goal**: Fix all failing tests, establish a clean baseline.

- [ ] 1. **Fix Windows path separator failures in @weave/config resolve tests**
  **What**: The 7 failing tests in `resolve.test.ts` hardcode forward-slash paths (`/proj/.weave/prompts/shuttle.md`) but `node:path.resolve()` on Windows produces backslashes. Fix tests to use `path.join`/`path.resolve` for expected values, or normalize comparisons.
  **Files**: `packages/config/src/__tests__/resolve.test.ts`
  **Acceptance**: `bun test` — 194/194 pass, 0 fail

- [ ] 2. **Audit and fix any other platform-specific assumptions**
  **What**: Grep for hardcoded `/` path separators in test expectations across all packages. Fix any found.
  **Files**: `packages/config/src/__tests__/*.test.ts`, `packages/core/src/__tests__/*.test.ts`
  **Acceptance**: Full test suite green on both Windows and Unix

**Testing**: Run `bun test` — all 194 tests pass.
**Issues**: None (housekeeping)

---

### Phase 1 — Engine Core (Batch 2)
**Goal**: Build the engine features that adapters depend on: category descriptors, model intent translation, policy engine, skill loader.

**Issues**: [#7](https://github.com/weave-io/weave/issues/7), [#8](https://github.com/weave-io/weave/issues/8), [#9](https://github.com/weave-io/weave/issues/9), [#12](https://github.com/weave-io/weave/issues/12)

- [ ] 3. **Category descriptor generation (#8)**
  **What**: Build a `buildCategoryDescriptors` function that takes `WeaveConfig.categories` and the base `shuttle` agent config, and produces `shuttle-{name}` agent descriptors with category-specific overrides (models, prompt_append, tool_policy, temperature).
  **Files**: `packages/engine/src/descriptors.ts`, `packages/engine/src/__tests__/descriptors.test.ts`
  **Acceptance**: Given categories `backend` and `frontend`, produces `shuttle-backend` and `shuttle-frontend` agents with correct merged config

- [ ] 4. **Model intent translation (#7)**
  **What**: Define a `ModelIntent` type and `resolveModelIntent` function that takes an agent's `models[]` preference list and produces a normalized intent object adapters can consume. Core does not resolve to concrete models — it preserves the ordered preference list with metadata.
  **Files**: `packages/engine/src/models.ts`, `packages/engine/src/__tests__/models.test.ts`
  **Acceptance**: Translates `["claude-sonnet-4-5", "gpt-4o"]` into a structured intent with provider hints

- [ ] 5. **Policy engine (#9)**
  **What**: Build a `PolicyEngine` class that evaluates `tool_policy` maps. Given an agent's policy and a requested tool action, returns `allow`/`deny`/`ask`. Supports inheritance (agent policy overrides category policy overrides global defaults).
  **Files**: `packages/engine/src/policy.ts`, `packages/engine/src/__tests__/policy.test.ts`
  **Acceptance**: Policy lookup with inheritance chain works; deny overrides allow at any level

- [ ] 6. **Skill loader (#12)**
  **What**: Build a `SkillLoader` class that discovers skill files from global (`~/.weave/skills/`) and project (`.weave/skills/`) directories, respects `disabled.skills`, and returns `SkillConfig[]` for the adapter.
  **Files**: `packages/engine/src/skills.ts`, `packages/engine/src/__tests__/skills.test.ts`
  **Acceptance**: Discovers skills from both scopes; disabled skills excluded; mock file system in tests

- [ ] 7. **Wire engine features into WeaveRunner**
  **What**: Update `WeaveRunner.run()` to call category descriptor generation, skill loading, and policy engine setup before spawning agents. Update `HarnessAdapter` interface if needed.
  **Files**: `packages/engine/src/runner.ts`, `packages/engine/src/adapter.ts`, `packages/engine/src/__tests__/runner.test.ts`
  **Acceptance**: Runner test with MockAdapter exercises full lifecycle including category shuttles

**Testing**: Each module has isolated unit tests with mocked dependencies. Runner integration test uses MockAdapter.
**Acceptance Criteria**: `bun test` passes; engine exports all new types; no real file I/O in tests.

---

### Phase 2 — CLI Foundation
**Goal**: Bootstrap the CLI package and deliver `weave init` + `weave validate` — the first user-facing commands.

**Issues**: [#26](https://github.com/weave-io/weave/issues/26), [#29](https://github.com/weave-io/weave/issues/29), [#30](https://github.com/weave-io/weave/issues/30), [#32](https://github.com/weave-io/weave/issues/32), [#33](https://github.com/weave-io/weave/issues/33), [#34](https://github.com/weave-io/weave/issues/34)

- [ ] 8. **Bootstrap `packages/cli` (#29)**
  **What**: Create the CLI package with `package.json`, `tsconfig.json`, `src/index.ts` entry point. Use a lightweight CLI framework (e.g. `@commander-js/extra-typings` or `citty`). Register as `weave` bin in workspace root.
  **Files**: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`, `packages/cli/src/cli.ts`
  **Acceptance**: `bun run packages/cli/src/index.ts --help` prints usage

- [ ] 9. **Harness detection (#33)**
  **What**: Build a `detectHarness` function that checks for installed harnesses (OpenCode, Claude Code, Pi) by looking for config directories, binaries, or marker files. Returns detected harness names.
  **Files**: `packages/cli/src/detect.ts`, `packages/cli/src/__tests__/detect.test.ts`
  **Acceptance**: Detects OpenCode when `.opencode/` or `opencode` binary exists; returns empty array when nothing found

- [ ] 10. **`weave validate` command (#32)**
  **What**: Command that takes a path (default `.weave/config.weave`), runs `parseConfig` from `@weave/core`, and reports errors with line/column numbers and formatted messages. Exit code 0 on success, 1 on failure.
  **Files**: `packages/cli/src/commands/validate.ts`, `packages/cli/src/__tests__/validate.test.ts`
  **Acceptance**: Valid config → exit 0 + "Config valid" message. Invalid config → exit 1 + formatted errors with line numbers.

- [ ] 11. **Interactive prompt system (#34)**
  **What**: Build a thin wrapper around an interactive prompt library (e.g. `@clack/prompts`) for use in `weave init`. Supports select, confirm, text input.
  **Files**: `packages/cli/src/prompts.ts`
  **Acceptance**: Exports `select`, `confirm`, `text` functions that work in terminal

- [ ] 12. **`weave init` command — scaffold config (#30)**
  **What**: Interactive command that creates `~/.weave/config.weave` (global) or `.weave/config.weave` (project) with sensible defaults. Asks: scope (global/project), which agents to enable, preferred models. Writes config file + creates `prompts/` directory.
  **Files**: `packages/cli/src/commands/init.ts`, `packages/cli/src/__tests__/init.test.ts`
  **Acceptance**: Running `weave init` in a fresh directory creates `.weave/config.weave` with valid DSL that passes `weave validate`

- [ ] 13. **`weave init` — harness installation (#31)**
  **What**: After scaffolding config, detect installed harnesses and offer to configure adapter integration. For OpenCode: generate `.opencode/agents/` directory with agent TOML files (placeholder until adapter is built).
  **Files**: `packages/cli/src/commands/init.ts` (extend), `packages/cli/src/harness-setup.ts`
  **Acceptance**: After init with OpenCode detected, harness-specific config directory is created

**Testing**: CLI commands tested with mocked file system and mocked prompts (no real I/O). `validate` tested with fixture `.weave` files.
**Acceptance Criteria**: `weave init` + `weave validate` work end-to-end in a real terminal.

---

### Phase 3 — Prompt Composition & Engine Completion (Batch 3 partial)
**Goal**: Build the prompt composition pipeline and dynamic delegation — the engine features needed before adapters can generate real agent prompts.

**Issues**: [#6](https://github.com/weave-io/weave/issues/6), [#14](https://github.com/weave-io/weave/issues/14)

- [ ] 14. **Prompt composition pipeline (#6)**
  **What**: Build a `PromptComposer` class that assembles final agent prompts from: base prompt (inline or file), category `prompt_append`, skill instructions, delegation tables, and workflow context. Produces a single string per agent.
  **Files**: `packages/engine/src/prompt.ts`, `packages/engine/src/__tests__/prompt.test.ts`
  **Acceptance**: Composes prompt from file + category append + delegation table; output is deterministic and testable

- [ ] 15. **Dynamic delegation prompt (#14)**
  **What**: Build delegation table generation for Loom/Tapestry. Given all active agents and their triggers, produce a formatted delegation instruction block that tells the router agent which specialist to delegate to.
  **Files**: `packages/engine/src/delegation.ts`, `packages/engine/src/__tests__/delegation.test.ts`
  **Acceptance**: Given 3 agents with triggers, produces a readable delegation table with domain/trigger/agent-name columns

**Testing**: Pure function tests — no I/O. Prompt composer tested with string fixtures.
**Acceptance Criteria**: `PromptComposer` produces correct output for all agent types (primary, shuttle, category-shuttle).

---

### Phase 4 — OpenCode Adapter (Batch 4 + 5)
**Goal**: Build the OpenCode `HarnessAdapter` implementation — the first real adapter.

**Issues**: [#15](https://github.com/weave-io/weave/issues/15), [#16](https://github.com/weave-io/weave/issues/16), [#17](https://github.com/weave-io/weave/issues/17), [#18](https://github.com/weave-io/weave/issues/18)

- [ ] 16. **OpenCode HarnessAdapter implementation (#15)**
  **What**: Implement `HarnessAdapter` for OpenCode. `init()` validates OpenCode is available; `spawnSubagent()` writes agent TOML files to `.opencode/agents/`; `registerHook()` and `loadSkill()` write to appropriate OpenCode directories.
  **Files**: `packages/adapters/opencode/src/adapter.ts`, `packages/adapters/opencode/src/__tests__/adapter.test.ts`
  **Acceptance**: MockAdapter pattern — test that correct files would be written for a given config

- [ ] 17. **OpenCode 6-phase config generation (#16)**
  **What**: Translate `WeaveConfig` into OpenCode's full configuration: agent TOML files, model mappings, tool permissions, prompt files. The "6 phases" are: agents, models, tools, prompts, hooks, skills.
  **Files**: `packages/adapters/opencode/src/config-gen.ts`, `packages/adapters/opencode/src/__tests__/config-gen.test.ts`
  **Acceptance**: Given a WeaveConfig with 3 agents, generates correct TOML for each

- [ ] 18. **OpenCode hooks (#17)**
  **What**: Map Weave lifecycle hooks to OpenCode's hook system. Register hooks that fire on session start, idle, completion, etc.
  **Files**: `packages/adapters/opencode/src/hooks.ts`, `packages/adapters/opencode/src/__tests__/hooks.test.ts`
  **Acceptance**: Hook registration produces correct OpenCode hook config

- [ ] 19. **OpenCode skill MCP integration (#18)**
  **What**: Map Weave skills to OpenCode's MCP (Model Context Protocol) skill system. Generate MCP tool definitions from skill configs.
  **Files**: `packages/adapters/opencode/src/skills.ts`, `packages/adapters/opencode/src/__tests__/skills.test.ts`
  **Acceptance**: Skill configs produce valid MCP tool definitions

**Testing**: All adapter tests use mocked file system — no real OpenCode process. Test against fixture configs.
**Acceptance Criteria**: `WeaveRunner` + `OpenCodeAdapter` + real config → correct file output (verified via mock FS assertions).

---

### Phase 5 — Workflow Engine & Plan Execution (Batch 3 remainder)
**Goal**: Build the workflow engine for multi-step pipelines and plan execution tracking.

**Issues**: [#10](https://github.com/weave-io/weave/issues/10), [#11](https://github.com/weave-io/weave/issues/11)

- [ ] 20. **Workflow engine (#10)**
  **What**: Build a `WorkflowEngine` class that executes workflow steps in sequence, manages step transitions, handles completion conditions (`agent_signal`, `user_confirm`, `review_verdict`), and supports gate steps with `on_reject` behavior.
  **Files**: `packages/engine/src/workflow.ts`, `packages/engine/src/__tests__/workflow.test.ts`
  **Acceptance**: Execute a 3-step workflow with mock agents; verify step ordering, artifact passing, and gate rejection

- [ ] 21. **Plan execution tracking (#11)**
  **What**: Build plan execution tracking that monitors `.weave/plans/*.md` checkbox completion, reports progress, and signals `plan_complete` to the workflow engine.
  **Files**: `packages/engine/src/plans.ts`, `packages/engine/src/__tests__/plans.test.ts`
  **Acceptance**: Parse a plan file, count checked/unchecked boxes, report percentage; detect completion

**Testing**: Workflow engine tested with mock agents and mock completion signals. Plan tracker tested with fixture markdown files.
**Acceptance Criteria**: A `secure-feature` workflow can execute end-to-end with mock agents.

---

### Phase 6 — Additional Adapters
**Goal**: Build Claude Code and Pi adapters with at least partial feature support.

**Issues**: [#19](https://github.com/weave-io/weave/issues/19), [#20](https://github.com/weave-io/weave/issues/20), [#21](https://github.com/weave-io/weave/issues/21), [#22](https://github.com/weave-io/weave/issues/22)

- [ ] 22. **Claude Code adapter (#19, #20)**
  **What**: Implement `HarnessAdapter` for Claude Code. Map agents to Claude Code's CLAUDE.md-based configuration. Document supported/unsupported features.
  **Files**: `packages/adapters/claude-code/src/adapter.ts`, `packages/adapters/claude-code/src/__tests__/adapter.test.ts`
  **Acceptance**: Generates valid Claude Code config from WeaveConfig

- [ ] 23. **Pi adapter (#21, #22)**
  **What**: Implement `HarnessAdapter` for Pi. Pi may lack native sub-agent support — adapter must emulate or document gaps.
  **Files**: `packages/adapters/pi/src/adapter.ts`, `packages/adapters/pi/src/__tests__/adapter.test.ts`
  **Acceptance**: Generates valid Pi config; unsupported features documented in adapter README

**Testing**: Mock-based adapter tests, same pattern as OpenCode.
**Acceptance Criteria**: Both adapters pass their test suites; capability matrices documented.

---

### Phase 7 — Analytics, Evals & Tooling
**Goal**: Observability, quality measurement, and developer tooling.

**Issues**: [#27](https://github.com/weave-io/weave/issues/27), [#28](https://github.com/weave-io/weave/issues/28), [#23](https://github.com/weave-io/weave/issues/23), [#24](https://github.com/weave-io/weave/issues/24), [#25](https://github.com/weave-io/weave/issues/25)

- [ ] 24. **Analytics (#27)**
  **What**: Build opt-in analytics collection respecting `analytics.enabled` and `analytics.use_fingerprint` settings.
  **Files**: `packages/engine/src/analytics.ts`
  **Acceptance**: Events collected when enabled; nothing sent when disabled

- [ ] 25. **Evals framework (#28)**
  **What**: Build evaluation harness for measuring agent quality — prompt effectiveness, delegation accuracy, workflow completion rates.
  **Files**: `packages/engine/src/evals/`
  **Acceptance**: Can run a basic eval suite against mock agents

- [ ] 26. **LSP for .weave files (#23)**
  **What**: Language Server Protocol implementation providing diagnostics, completion, and hover for `.weave` files.
  **Files**: `packages/lsp/src/`
  **Acceptance**: Reports parse errors as diagnostics; completes agent/category/workflow keywords

- [ ] 27. **Tree-sitter grammar (#24)**
  **What**: Tree-sitter grammar for `.weave` DSL syntax highlighting.
  **Files**: `packages/tree-sitter-weave/`
  **Acceptance**: Correctly highlights all DSL constructs

- [ ] 28. **VSCode extension (#25)**
  **What**: VSCode extension bundling LSP client + tree-sitter highlighting.
  **Files**: `packages/vscode-weave/`
  **Acceptance**: Syntax highlighting + error diagnostics in VSCode

**Testing**: LSP tested with mock documents. Tree-sitter tested with corpus files.
**Acceptance Criteria**: `.weave` files get syntax highlighting and inline error reporting in VSCode.

---

## Dependency Graph

```
Phase 0 (housekeeping)
  └─► Phase 1 (engine core: descriptors, models, policy, skills)
        ├─► Phase 2 (CLI: init, validate)
        └─► Phase 3 (prompt composition, delegation)
              └─► Phase 4 (OpenCode adapter)
                    ├─► Phase 5 (workflow engine)
                    └─► Phase 6 (Claude Code, Pi adapters)
                          └─► Phase 7 (analytics, evals, tooling)
```

**First milestone** (Phases 0–2): `weave init` + `weave validate` working in terminal.
**Second milestone** (Phases 3–4): OpenCode adapter generates real agent configs from `.weave` input.

## Verification
- [ ] All tests pass (`bun test` — 0 failures)
- [ ] No regressions after each phase
- [ ] `weave init` produces valid config (verified by `weave validate`)
- [ ] OpenCode adapter generates correct TOML from fixture configs
- [ ] Each phase's issues are closeable with passing tests and updated docs
