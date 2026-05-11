# 04-tasks-agent-model-resolution.md

## Relevant Files

| File                                                     | Why It Is Relevant                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/model-resolution.ts`                | **New.** Pure `resolveAdapterModelIntent()` helper and its input/output types.                                                    |
| `packages/engine/src/__tests__/model-resolution.test.ts` | **New.** Unit tests covering all 6 resolution priority branches and availability filtering.                                       |
| `packages/engine/src/descriptors.ts`                     | **New.** Pure `generateCategoryShuttles()` function producing `shuttle-{name}` descriptors from `WeaveConfig.categories`.         |
| `packages/engine/src/__tests__/descriptors.test.ts`      | **New.** Unit tests for descriptor generation, inheritance, category overrides, and disabling rules.                              |
| `packages/engine/src/runner.ts`                          | **Modify.** Call `generateCategoryShuttles()` and include generated shuttles in the agent spawn loop.                             |
| `packages/engine/src/__tests__/runner.test.ts`           | **Modify.** Add tests proving the runner spawns generated category shuttles and respects disabling.                               |
| `packages/engine/src/adapter.ts`                         | **Verify only.** Confirm `HarnessAdapter` has no `getSelectedModel()` / `getAvailableModels()` methods (no code change expected). |
| `packages/engine/src/index.ts`                           | **Modify.** Export `resolveAdapterModelIntent`, `generateCategoryShuttles`, and their public types.                               |
| `docs/model-resolution.md`                               | **Modify.** Add a "Category Shuttles and Adapter Translation" section.                                                            |

### Notes

- All new source files must use kebab-case filenames (enforced by Biome: `filenameCases: ["snake_case", "kebab-case"]`).
- Tests live alongside source files in `__tests__/` — follow the existing pattern in `packages/engine/src/__tests__/`.
- Run `bun test packages/engine` to run only the engine test suite during development; `bun test` runs all packages.
- Run `bun run typecheck` from the repo root to typecheck all packages at once.
- The pre-commit hook runs lint-staged → typecheck → validate-config → tests → codesight; all must pass before committing.
- Never use `console.*`; use `logger.child({ module: "..." })` from `./logger.js` for any log output.
- All new functions that can fail must return `Result<T, E>` or `ResultAsync<T, E>` from `neverthrow`. The functions in this spec are pure and infallible (they do not perform I/O), so plain return types are appropriate.
- Import types from `@weave/core`, never from internal package paths directly.

---

## Tasks

### [x] 1.0 Implement the Adapter-Facing Model Resolution Helper

**Purpose:** Create a pure, harness-agnostic `resolveAdapterModelIntent()` function
that adapters can call with explicit harness context. The function encodes the
6-priority resolution chain from the spec and returns a typed result with a
provenance field so adapter tests can verify which priority branch won.

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/engine` — all tests in
  `packages/engine/src/__tests__/model-resolution.test.ts` pass, showing one
  passing test per priority branch (override, UI-selected primary, UI-selected
  all, subagent skips UI model, category preference, agent preference, system
  default, constant fallback) and one test for availability filtering when
  `availableModels` is supplied.
- CLI: `bun run typecheck` exits 0, demonstrating that `resolveAdapterModelIntent`
  and its input/output types are correctly typed and exported from
  `@weave/engine`.

#### 1.0 Tasks

- [x] 1.1 Create `packages/engine/src/model-resolution.ts` and define the
      `ModelResolutionInput` interface with all adapter-supplied and Weave-supplied
      fields:

  ```ts
  import type { AgentConfig } from "@weave/core";

  export interface ModelResolutionInput {
    // Weave-supplied intent
    agentName: string;
    agentMode?: AgentConfig["mode"]; // "primary" | "subagent" | "all" | undefined
    agentModels?: string[]; // ordered agent model preferences
    categoryModels?: string[]; // ordered category model preferences

    // Adapter-supplied harness context (all optional — adapters provide what they have)
    overrideModel?: string; // priority 1: hard per-agent override
    uiSelectedModel?: string; // priority 2: harness UI-selected model
    systemDefault?: string; // priority 5: harness system default
    availableModels?: Set<string>; // when provided, skip unavailable candidates
  }
  ```

- [x] 1.2 In the same file, define the `ResolutionSource` discriminated union and
      `ModelResolutionResult` interface so callers can verify which priority won:

  ```ts
  export type ResolutionSource =
    | "override"
    | "ui-selected"
    | "category-preference"
    | "agent-preference"
    | "system-default"
    | "constant-fallback";

  export interface ModelResolutionResult {
    model: string;
    source: ResolutionSource;
  }
  ```

- [x] 1.3 In the same file, define and export the fallback constant and implement
      `resolveAdapterModelIntent()` with the 6-priority chain. The logic must follow
      these rules exactly:
  1. Return `overrideModel` with source `"override"` if provided.
  2. Return `uiSelectedModel` with source `"ui-selected"` when provided **and**
     `agentMode` is not `"subagent"` (i.e., `undefined`, `"primary"`, or `"all"`
     all inherit the UI-selected model).
  3. Walk `categoryModels` and return the first entry that passes the
     availability check with source `"category-preference"`.
  4. Walk `agentModels` and return the first entry that passes the availability
     check with source `"agent-preference"`.
  5. Return `systemDefault` with source `"system-default"` if provided.
  6. Return `DEFAULT_FALLBACK_MODEL` with source `"constant-fallback"`.

  The availability check helper: if `availableModels` is provided, a model is
  available only if it appears in the set; if `availableModels` is `undefined`
  or empty, every model passes.

  ```ts
  export const DEFAULT_FALLBACK_MODEL = "claude-sonnet-4-5";

  export function resolveAdapterModelIntent(
    input: ModelResolutionInput,
  ): ModelResolutionResult { ... }
  ```

- [x] 1.4 Export all public symbols (`ModelResolutionInput`, `ResolutionSource`,
      `ModelResolutionResult`, `DEFAULT_FALLBACK_MODEL`, `resolveAdapterModelIntent`)
      from `packages/engine/src/index.ts`.

- [x] 1.5 Create `packages/engine/src/__tests__/model-resolution.test.ts`. Write
      tests for **priority 1 (override)** and **priority 2 (UI-selected model)**:

  ```
  describe("resolveAdapterModelIntent", () => {
    describe("priority 1: override", () => {
      it("(a) overrideModel wins over all other inputs")
      it("(b) overrideModel wins even when uiSelectedModel is also provided")
    })
    describe("priority 2: ui-selected model", () => {
      it("(a) uiSelectedModel used when mode is primary")
      it("(b) uiSelectedModel used when mode is all")
      it("(c) uiSelectedModel used when mode is undefined")
      it("(d) uiSelectedModel is SKIPPED when mode is subagent — falls to next priority")
    })
  })
  ```

- [x] 1.6 In the same test file, write tests for **priorities 3–6** (the fallback
      chain) and **availability filtering**:

  ```
  describe("priority 3: category preference", () => {
    it("(a) first categoryModels entry is returned when available")
    it("(b) second categoryModels entry used when first is unavailable")
    it("(c) category preference skipped when mode is subagent and no uiSelectedModel — falls to category then agent")
  })
  describe("priority 4: agent preference", () => {
    it("(a) first agentModels entry returned when no higher priority matches")
    it("(b) second agentModels entry used when first is unavailable")
  })
  describe("priority 5: system default", () => {
    it("(a) systemDefault returned when all preferences are absent")
  })
  describe("priority 6: constant fallback", () => {
    it("(a) DEFAULT_FALLBACK_MODEL returned when nothing else is provided")
    it("(b) returned model equals DEFAULT_FALLBACK_MODEL constant value")
  })
  describe("availability filtering", () => {
    it("(a) empty availableModels set means no model passes — falls to systemDefault")
    it("(b) unavailable category model skipped; available agent model returned")
  })
  ```

- [x] 1.7 Run `bun test packages/engine` and fix any failures. Then run
      `bun run typecheck` and fix any type errors. All existing 194 tests should
      still pass alongside the new model-resolution tests.

---

### [x] 2.0 Implement Category Shuttle Descriptor Generation and Runner Integration

**Purpose:** Create a pure `generateCategoryShuttles()` function that produces
`shuttle-{categoryName}` agent descriptors from `WeaveConfig.categories`, and
update `WeaveRunner` to spawn those generated descriptors alongside the
explicitly declared agents.

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine` — all tests in
  `packages/engine/src/__tests__/descriptors.test.ts` pass, demonstrating:
  (a) a category with `models`, `temperature`, `prompt_append`, and
  `tool_policy` produces a correctly-named `shuttle-{name}` descriptor that
  inherits from the base shuttle and applies all category overrides; (b) a
  missing base `shuttle` agent produces no descriptors; (c) a disabled base
  `shuttle` produces no descriptors; (d) a category whose generated name appears
  in `disabled.agents` is skipped; (e) a config that explicitly declares
  `agent shuttle-{name}` while also having `category {name}` returns `err`
  with a `CategoryShuttleConflictError`.
- Test: `bun test packages/engine` — updated
  `packages/engine/src/__tests__/runner.test.ts` includes tests proving the
  runner spawns generated category shuttles alongside declared agents,
  disabling rules are respected, and the runner throws a descriptive error
  when a conflict is detected.

#### 2.0 Tasks

- [x] 2.1 Create `packages/engine/src/descriptors.ts`. Define the
      `CategoryShuttleConflictError` discriminated-union type and the function
      signature for `generateCategoryShuttles()` with the two early-return guard
      cases (no base shuttle agent, base shuttle disabled). The function is now
      fallible and returns a `Result` from `neverthrow`:

  ```ts
  import { err, ok, type Result } from "neverthrow";
  import type { AgentConfig, WeaveConfig } from "@weave/core";

  export type CategoryShuttleConflictError = {
    type: "CategoryShuttleConflictError";
    /** The conflicting agent name, e.g. "shuttle-frontend". */
    shuttleName: string;
    /** The category whose generated name collided. */
    categoryName: string;
    message: string;
  };

  /**
   * Generate category shuttle agent descriptors from the merged WeaveConfig.
   *
   * Returns `err(CategoryShuttleConflictError)` when an explicitly declared
   * agent name collides with a would-be generated shuttle name (e.g. the config
   * declares `agent shuttle-frontend {}` AND has `category frontend {}`).
   * Callers must handle this error before spawning agents.
   */
  export function generateCategoryShuttles(
    config: WeaveConfig,
  ): Result<Record<string, AgentConfig>, CategoryShuttleConflictError> {
    const base = config.agents["shuttle"];
    if (!base) return ok({});
    if (config.disabled.agents.includes("shuttle")) return ok({});

    // ... rest of implementation in 2.2
    return ok({});
  }
  ```

- [x] 2.2 Implement the descriptor generation loop inside `generateCategoryShuttles()`.
      **Before building any descriptor**, check whether the generated name already
      exists as an explicitly declared agent — if so, return an error immediately.
      Then build the descriptor for non-conflicting, non-disabled categories:

  ```ts
  const result: Record<string, AgentConfig> = {};

  for (const [categoryName, category] of Object.entries(config.categories)) {
    const shuttleName = `shuttle-${categoryName}`;

    // Conflict check: explicitly declaring agent shuttle-{name} while category
    // {name} also exists is always a configuration error.
    if (config.agents[shuttleName] !== undefined) {
      return err({
        type: "CategoryShuttleConflictError",
        shuttleName,
        categoryName,
        message:
          `Agent "${shuttleName}" is explicitly declared and would also be ` +
          `generated from category "${categoryName}". ` +
          `Remove the explicit agent declaration or rename the category.`,
      });
    }

    if (config.disabled.agents.includes(shuttleName)) continue;

    // Build category-specific overrides (only defined fields override base)
    const overrides: Partial<AgentConfig> = {};
    if (category.models !== undefined) overrides.models = category.models;
    if (category.temperature !== undefined)
      overrides.temperature = category.temperature;
    if (category.prompt_append !== undefined)
      overrides.prompt_append = category.prompt_append;
    if (category.tool_policy !== undefined) {
      // Merge tool_policy: category fields override base fields; unset category
      // fields fall back to base fields.
      overrides.tool_policy = { ...base.tool_policy, ...category.tool_policy };
    }

    result[shuttleName] = {
      ...base,
      name: shuttleName,
      mode: "subagent",
      ...overrides,
    };
  }

  return ok(result);
  ```

- [x] 2.3 Export `generateCategoryShuttles` **and** `CategoryShuttleConflictError`
      from `packages/engine/src/index.ts`.

- [x] 2.4 Create `packages/engine/src/__tests__/descriptors.test.ts`. Add a
      `cfg()` helper (identical to the one in `runner.test.ts`). Write tests for
      **correct generation and naming**:

  ```
  describe("generateCategoryShuttles", () => {
    describe("generation", () => {
      it("(a) returns empty object when config has no categories")
      it("(b) returns empty object when base shuttle agent is absent")
      it("(c) produces a shuttle-{name} key for each category")
      it("(d) generated descriptor name field matches the key")
    })
  ```

  Each test should use `parseConfig()` to build a `WeaveConfig` from a DSL
  string (follow the `cfg()` helper pattern from `runner.test.ts`). Example
  DSL for a test:

  ```weave
  agent shuttle { prompt "Base shuttle." models ["claude-sonnet-4-5"] }
  category frontend {
    patterns ["src/components/**"]
    models ["gpt-5"]
  }
  ```

- [x] 2.5 In the same test file, write tests for **inheritance and overrides**:

  ```
  describe("inheritance", () => {
    it("(a) generated descriptor inherits base shuttle prompt")
    it("(b) generated descriptor inherits base shuttle tool_policy when category has none")
    it("(c) generated descriptor has mode subagent regardless of base shuttle mode")
  })
  describe("category overrides", () => {
    it("(a) category models replace the inherited models field")
    it("(b) category temperature overrides base temperature")
    it("(c) category prompt_append is set on the descriptor")
    it("(d) category tool_policy merges over base: category fields win, unset fields keep base values")
    it("(e) fields not set in category (e.g. temperature) keep their base shuttle value")
  })
  ```

- [x] 2.6 In the same test file, write tests for **disabling rules** and the
      new **conflict error**:

  ```
  describe("disabling", () => {
    it("(a) returns ok({}) when base shuttle is in disabled.agents")
    it("(b) skips only the disabled category shuttle; others are still generated")
    it("(c) base shuttle disabled suppresses ALL category shuttles")
  })
  describe("conflict detection", () => {
    it("(a) returns err(CategoryShuttleConflictError) when shuttle-{name} is explicitly declared")
    it("(b) error contains the correct shuttleName and categoryName fields")
    it("(c) error message is human-readable and names both the agent and the category")
    it("(d) returns ok when shuttle-{name} is in disabled.agents but not explicitly declared")
  })
  ```

  For the conflict tests, build a config that has both an explicit agent
  declaration and a matching category — e.g.:

  ```weave
  agent shuttle { prompt "Base." models ["claude-sonnet-4-5"] }
  agent shuttle-frontend { prompt "Explicit." models ["gpt-4o"] }
  category frontend { patterns ["src/**"] models ["gpt-5"] }
  ```

  Call `generateCategoryShuttles(cfg(...))` and assert the result `isErr()`
  with the expected fields.

- [x] 2.7 Update `packages/engine/src/runner.ts` to call `generateCategoryShuttles()`
      and handle the `Result` at the framework boundary. `run()` keeps its
      `Promise<void>` signature; convert the error to a thrown `Error` using
      `.match()` — this is the AGENTS.md-sanctioned pattern for framework-boundary
      conversion:

  ```ts
  import { generateCategoryShuttles } from "./descriptors.js";

  // Inside run(), after adapter.init() and before the spawn loop:
  const shuttlesResult = generateCategoryShuttles(this.config);
  if (shuttlesResult.isErr()) {
    const e = shuttlesResult.error;
    log.error({ conflict: e.shuttleName, category: e.categoryName }, e.message);
    throw new Error(e.message);
  }

  const allAgents: Record<string, AgentConfig> = {
    ...this.config.agents,
    ...shuttlesResult.value,
  };

  for (const [name, agentConfig] of Object.entries(allAgents)) {
    if (disabled.agents.includes(name)) {
      log.debug({ agent: name }, "Skipping disabled agent");
      continue;
    }
    log.info({ agent: name, model: agentConfig.models?.[0] }, "Spawning agent");
    await this.adapter.spawnSubagent(name, agentConfig);
  }
  ```

- [x] 2.8 Add new tests to `packages/engine/src/__tests__/runner.test.ts` in a
      new `describe("category shuttle spawning")` block:

  ```
  describe("category shuttle spawning", () => {
    it("spawns a generated shuttle-{name} agent when a category is configured")
    it("spawns multiple generated shuttles for multiple categories")
    it("does not spawn a category shuttle when the base shuttle is disabled")
    it("does not spawn a specific category shuttle when its name is in disabled.agents")
    it("category shuttle descriptor carries category models")
    it("throws when a category would generate a name that is already explicitly declared")
  })
  ```

  Use `parseConfig()` + DSL strings to build configs with `category` blocks.
  Assert on `adapter.callsTo("spawnSubagent")` names and config fields.
  For the conflict test, use `expect(runner.run()).rejects.toThrow()` and
  assert the error message names both the conflicting agent and the category.

- [x] 2.9 Run `bun test packages/engine` and fix any failures. All previous
      engine tests must still pass.

---

### [ ] 3.0 Finalize Documentation, Verify Adapter Boundary, and Run Full Integration

**Purpose:** Update `docs/model-resolution.md` with category shuttle adapter
guidance, confirm that `HarnessAdapter` carries no UI-query methods, and
verify the complete test suite and typecheck pass clean with the new code in
place.

#### 3.0 Proof Artifact(s)

- CLI: `bun run typecheck` exits 0 — demonstrates the full workspace
  typechecks cleanly; the `HarnessAdapter` interface has no
  `getSelectedModel()` or `getAvailableModels()` method.
- CLI: `bun test` — all tests across all packages pass (194 original + all
  new tests), demonstrating no regressions.
- Diff: `docs/model-resolution.md` — new or updated section "Category Shuttles
  and Adapter Translation" describes how adapters should treat
  `shuttle-{name}` category model preferences when translating to concrete
  harness model fields.

#### 3.0 Tasks

- [ ] 3.1 Open `packages/engine/src/adapter.ts` and verify that `HarnessAdapter`
      has no `getSelectedModel()`, `getAvailableModels()`, or any other method that
      queries harness UI state. This is a read-only verification step — make no
      changes unless you find such a method (in which case, remove it and note it
      in the commit message).

- [ ] 3.2 Open `docs/model-resolution.md` and add a new section after the existing
      "Category Shuttles" section. Name the new section
      **"Category Shuttles and Adapter Translation"**. The section should explain:
  - Each generated `shuttle-{categoryName}` descriptor carries `models` from
    `category.models` as ordered model preferences (intent only).
  - When an adapter translates a `shuttle-{name}` agent, it should treat
    `agentModels` as the category model preference list in
    `resolveAdapterModelIntent()`, meaning category preferences are tried before
    agent-level preferences but after any UI-selected model.
  - Because category shuttles always have `mode: "subagent"`, the adapter's
    call to `resolveAdapterModelIntent()` will skip the UI-selected model and
    resolve directly from category model preferences.
  - Example snippet showing how an adapter would call
    `resolveAdapterModelIntent()` for a generated category shuttle.

- [ ] 3.3 Run `bun run lint` (runs Biome across all packages) and fix any lint
      errors in the new files. Common issues to watch for:
  - `noExplicitAny` — never use `any`; use specific types or `unknown`.
  - `noConsole` — never use `console.*`; use the pino logger.
  - Filename casing — `model-resolution.ts` and `descriptors.ts` are already
    kebab-case, which is correct.

- [ ] 3.4 Run `bun run typecheck` from the repo root and fix any remaining type
      errors across all packages. Pay attention to the `@weave/engine` package
      since that is where all new code lives.

- [ ] 3.5 Run `bun test` from the repo root to execute all tests across all
      packages. Confirm the count of passing tests is 194 plus the number of new
      tests added in tasks 1.5, 1.6, 2.4, 2.5, 2.6, and 2.8. Fix any failures.

- [ ] 3.6 Stage all changes and do a dry-run of the pre-commit checks:

  ```bash
  bunx lint-staged
  bun run typecheck
  bun run validate-config
  bun test --recursive
  ```

  Fix any issues before committing.

- [ ] 3.7 Commit all changes with a Conventional Commits message. Because this
      spans multiple packages and closes two issues, use a multi-scope message:

  ```
  feat(engine): add model resolution helper and category shuttle generation

  - resolveAdapterModelIntent(): pure 6-priority adapter-facing helper
  - generateCategoryShuttles(): produces shuttle-{name} descriptors from categories
  - WeaveRunner now spawns generated category shuttles alongside declared agents
  - docs/model-resolution.md updated with category shuttle adapter guidance

  Closes #7, closes #8
  ```
