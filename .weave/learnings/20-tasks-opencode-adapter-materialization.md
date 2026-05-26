# Learnings: 20-tasks-opencode-adapter-materialization

## Task 1: Establish the injected OpenCode client path and adapter-owned SDK facade
- **Discrepancy**: The Spec 20 task/spec/audit files existed only as untracked files in the main checkout, so a fresh git worktree created from `main` did not contain the plan materials required to execute the task.
- **Resolution**: Copied the `docs/specs/20-spec-opencode-adapter-materialization/` directory into the dedicated worktree before implementation and continued execution there.
- **Suggestion**: Commit or otherwise persist spec/task/audit inputs before starting implementation in a new worktree so the execution workspace contains the authoritative plan files.

## Task 2: Replace in-memory translation with real SDK-backed materialization
- **Discrepancy**: Task 2's acceptance required the `list existing → reconcile decision → create/update call` flow to be implemented in adapter-owned code, which effectively required introducing `reconcile-agent.ts` before Task 3 formally asked for that module.
- **Resolution**: Implemented the first reconciliation slice in Task 2 so `spawnSubagent()` could use a real SDK-backed materialization path, while leaving Task 3 to harden the canonical-identity and ownership-check behavior with focused tests.
- **Suggestion**: Move the first creation of `reconcile-agent.ts` into Task 2 explicitly, or narrow Task 2 so it does not depend on a module the plan introduces in Task 3.

## Task 2: Replace in-memory translation with real SDK-backed materialization
- **Reconciliation module placement**: The `list → reconcile → create/update` flow was placed in a dedicated `reconcile-agent.ts` module rather than inline in `spawnSubagent()`. This keeps `index.ts` as a thin orchestrator and makes the reconciliation logic independently testable.
- **Ownership marker approach**: Using a human-readable `[weave-managed]` tag embedded in the agent `description` field is a lightweight, harness-visible ownership signal that requires no separate metadata store. It is idempotent and survives round-trips through the OpenCode config.
- **`translatedAgents` retention**: The map was retained (not removed) because it provides test-visible state that is cheaper to assert than mocking the full SDK call chain. Its JSDoc was updated to clarify it is a secondary artifact, not the source of truth.
- **Translation-only mode**: When no client is injected, `spawnSubagent()` logs a warning and returns after populating `translatedAgents`. This preserves backward compatibility for callers that construct the adapter without a client (e.g. config-write-only scenarios).
- **Error propagation**: Reconciliation errors (including `CollisionError`) are surfaced as thrown `Error` instances from `spawnSubagent()` rather than returned as `Result` values. This matches the `HarnessAdapter` interface contract (`Promise<void>`) and lets callers use standard `try/catch` or `await` error handling.

## Task 3: Implement safe reconciliation using canonical agent identity and ownership checks
- **Discrepancy**: `reconcile-agent.ts` was already fully implemented in Task 2 as a prerequisite for the SDK-backed materialization path. Task 3 therefore consisted entirely of adding the focused `reconcile-agent.test.ts` test suite rather than implementing new production code.
- **Resolution**: Wrote 42 tests covering create, update, collision, `listAgents` failure, and upsert-only constraint cases. All acceptance criteria were met through test coverage alone; no production code changes were required.
- **Suggestion**: When a plan introduces a module in a later task but an earlier task depends on it, either move the module introduction earlier in the plan or explicitly note in the later task that implementation may already be complete and only test coverage is needed.
- **Learnings file hygiene**: The learnings file must be staged and committed as part of the task commit. Leaving it modified but uncommitted causes the worktree to appear dirty after the task is marked complete. Always include the learnings file in the final `git add` before committing.

## Task 4: Add model and skill validation to the materialization pipeline
- **`translateAgent()` signature change**: Adding `resolvedModel?: string` as a second parameter to `translateAgent()` is the cleanest way to decouple model resolution from translation. The function no longer reads `descriptor.models[0]` — callers must resolve the model first and pass it in. This keeps translation pure and model resolution adapter-owned.
- **Fail-fast scope**: The fail-fast rule for unsupported explicit model intent applies only to `subagent` mode agents with non-empty `models` declarations. Primary and `all` mode agents fall through to the engine's standard resolution chain. This matches the spec requirement without over-constraining non-subagent agents.
- **Learnings file hygiene**: Must be staged and committed as part of the task commit. Leaving it modified but uncommitted causes the worktree to appear dirty after the task is marked complete.

## Task 4 retry: Correct the skill-discovery boundary violation
- **Boundary violation**: The original Task 4 implementation scanned the filesystem for skill files in `.weave/skills/` and `.agents/skills/` directories. This violated the adapter/harness boundary: skill discovery is harness-owned, not adapter-owned.
- **Correct architecture**: The harness SDK/runtime tells the adapter which skills are available. The adapter receives a `SkillInfo[]` list via `OpenCodeAdapterOptions.availableSkills` and forwards it to the engine via `loadAvailableSkills()`. No filesystem scanning.
- **`skill-discovery.ts` scope after correction**: The module provides only `buildSkillInfoList()` (wraps harness-provided names as `SkillInfo[]`) and `validateDeclaredSkills()` (validates declared names against the harness-provided list). No `discoverSkills()` function.
- **Hard-error semantics preserved**: When no skills are injected, `loadAvailableSkills()` returns `[]`. The engine's `resolveSkillsForAgent()` then emits `MissingSkill` errors for declared skills — correct hard-error behavior, no silent skips.
- **Test strategy**: Filesystem-scanning tests were replaced with harness-injection tests. Tests prove the adapter returns injected skills, returns empty list when nothing is injected, and does not scan the filesystem for non-existent project roots.

## Task 5: Document the adapter shape and prove acceptance for the first slice
- **ADR format**: The ADR for the OpenCode adapter materialization shape (ADR 0003) documents five design decisions: SDK-first/plugin-first entry path, injected client facade, adapter-owned model resolution with engine helper, harness-owned skill discovery, and ownership-safe upsert via `[weave-managed]` tag. Each decision includes context, decision, consequences, and references.
- **adapter-readiness-status.md update**: Added a dedicated "OpenCode Adapter — First-Slice Materialization" section with a capability table, explicit non-goals, and the installation/runtime story (`opencode.json` `plugin` array). This makes the first-slice status immediately visible to reviewers without requiring them to read the full spec.
- **adapter-boundary.md**: No ownership rules changed. The implementation confirmed the existing boundary is correct and complete for the first slice. Only link additions were needed (ADR 0003 and Spec 20 in the Related section).
- **Learnings file hygiene**: Must be staged and committed as part of the task commit. Leaving it modified but uncommitted causes the worktree to appear dirty after the task is marked complete.
- **Proof file structure**: The Task 5 proof file follows the same structure as Tasks 1-4: summary table, documents created/updated, quality gate results with exact command and output, sanitized smoke checklist reference, proof references table, and acceptance criteria verification table.

## Task 5 retry: Fix the plugin/runtime deviation
- **Root cause**: The original Task 5 docs claimed `@weave/adapter-opencode` was directly installable as an OpenCode plugin, but the package lacked `@opencode-ai/plugin` as a dependency and had no default `Plugin` export. The smoke checklist relied on a user-authored wrapper script.
- **Fix**: Added `@opencode-ai/plugin@~1.15.9` as a production dependency. Created `src/plugin.ts` with the `WeavePlugin` function (default export + `server` alias). Extracted `OpenCodeAdapter` into `src/adapter.ts` to avoid a circular import (`index.ts` → `plugin.ts` → `adapter.ts`). Updated `index.ts` to be a clean barrel.
- **Plugin entry pattern**: The `WeavePlugin` function follows the `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>` contract from `@opencode-ai/plugin`. It loads config, materializes agents, and returns `{}`. No user-authored wrapper is needed.
- **Circular import avoidance**: When a barrel (`index.ts`) re-exports from a module (`plugin.ts`) that needs to import the adapter class, extract the class into its own file (`adapter.ts`) so the import chain is acyclic: `index.ts` → `plugin.ts` → `adapter.ts`.
- **Test isolation for global config**: Tests that call `loadConfig()` in a dev environment may pick up the developer's global `~/.weave/config.weave`. Use a `FileReader` that returns `exists: false` for paths outside the test project root to prevent global config interference.
- **`materializeAgents` return type**: `materializeAgents` returns `ResultAsync<MaterializationPlan, never>`. The `never` error type means `_unsafeUnwrap()` is safe — the promise always resolves to `ok()`.
- **Docs must match implementation**: Never claim a package has a plugin entry surface unless the package actually exports the `Plugin` function and declares `@opencode-ai/plugin` as a dependency. Docs that overstate capabilities are worse than no docs.

## Task 5 retry 2: Fix the package build
- **Root cause**: `bun run --filter @weave/adapter-opencode build` failed because the `tsc --emitDeclarationOnly` step requires the `dist/` directories of workspace dependencies (`@weave/core`, `@weave/engine`, `@weave/config`) to exist. The `--filter` flag only builds the one package; it does not build its workspace dependencies first.
- **Fix**: Updated the adapter's `package.json` build script to build workspace dependencies before the adapter itself: `bun run --filter @weave/core build && bun run --filter @weave/engine --filter @weave/config build && bun build ... && tsc ...`.
- **Why not `paths` in `tsconfig.build.json`**: Adding `paths` pointing to source files outside `rootDir` causes `TS6059: File is not under rootDir` errors. The `rootDir` constraint is enforced during declaration emit. The correct fix is to ensure dist files exist before the tsc step runs.
- **Pattern**: Any adapter package that depends on workspace packages and uses `tsc --emitDeclarationOnly` must either (a) build dependencies first in its own build script, or (b) rely on the root build script to build in dependency order. The `--filter` shortcut only works when dependencies are already built.
