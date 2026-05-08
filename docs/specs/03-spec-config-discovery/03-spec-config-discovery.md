# 03-spec-config-discovery

## Introduction/Overview

The Weave framework currently parses a single `.weave` source string into a validated `WeaveConfig` (via `@weave/core`'s `parseConfig`), but has no facility for discovering config files on disk, merging multiple scopes, providing builtin agent defaults, or resolving `prompt_file` paths to their actual filesystem locations. This spec introduces `@weave/config` — a new workspace package that owns the complete config-loading pipeline: provide builtin agent defaults as a base layer, discover global and project config files, parse each with `parseConfig`, deep-merge all three layers using documented merge semantics (builtins → global → project), resolve `prompt_file` paths relative to each scope's `prompts/` directory, and return the final merged `WeaveConfig` via `ResultAsync`.

A core design principle of Weave is **DSL-first agents**: builtin agents (Loom, Tapestry, Shuttle, Pattern, Thread, Spindle, Weft, Warp) are defined using the same `.weave` DSL that end users use for custom agents. There is no separate code path for builtins — they are well-known named entries defined as `.weave` source strings within `@weave/config`. Users can override any builtin agent by redeclaring it in their global or project config; only the fields they explicitly set are overridden, and everything else falls back to the builtin default.

## Goals

- **Builtin agent defaults**: Ship hardcoded `.weave` DSL definitions for all 8 builtin agents (Loom, Tapestry, Shuttle, Pattern, Thread, Spindle, Weft, Warp) as the base layer of the config pipeline. Users can override any builtin by redeclaring it — only explicitly-set fields override; everything else falls back to the builtin default.
- **Config file discovery**: Locate `~/.weave/config.weave` (global scope) and `.weave/config.weave` (project scope) on disk, gracefully handling missing files.
- **Scope-aware parsing**: Read each discovered config file and parse it with `parseConfig` from `@weave/core`, collecting errors per scope.
- **Three-layer deterministic merge**: Deep-merge configs in priority order (builtins → global → project) using the documented strategy — scalars: project overrides global overrides builtin; objects: deep-merge; arrays: union-merge — producing a single `WeaveConfig`.
- **Prompt file path resolution**: Resolve every `prompt_file` value to an absolute path relative to its originating scope's `prompts/` directory (e.g., `"loom.md"` in project config → `.weave/prompts/loom.md`). Builtin `prompt_file` values are resolved relative to the package's own bundled prompts directory.
- **Typed error pipeline**: Return `ResultAsync<WeaveConfig, ConfigLoadError[]>` so consumers get explicit, structured errors for file I/O failures and parse failures.

## User Stories

- **As the engine runner (`WeaveRunner`)**, I want to call a single function that returns a fully-merged, path-resolved `WeaveConfig` so that I don't need to know about file locations, builtin defaults, or merge rules.
- **As a framework user**, I want all 8 builtin agents to be available out of the box — without writing any config — so that Weave works immediately after installation.
- **As a framework user**, I want to override a builtin agent by redeclaring it in my config (e.g., `agent loom { temperature 0.5 }`) so that only the fields I specify change, and everything else keeps its builtin default.
- **As a framework user**, I want to define global defaults in `~/.weave/config.weave` and override them per-project in `.weave/config.weave` so that I can share base config across projects while customising each one.
- **As a framework user**, I want my `prompt_file` references to resolve relative to the correct scope's `prompts/` directory so that `"loom.md"` in my project config points to `.weave/prompts/loom.md` and the same reference in global config points to `~/.weave/prompts/loom.md`.
- **As a framework contributor**, I want config-loading errors to clearly identify which file failed and why (I/O error vs parse error) so that I can diagnose problems quickly.
- **As a framework contributor**, I want builtin agent definitions to use the same `.weave` DSL as user configs so that there is no separate code path — builtins are just well-known named entries that go through `parseConfig`.

## Demoable Units of Work

### Unit 1: Package Scaffold, Config Discovery, and Parsing

**Purpose:** Create the `@weave/config` workspace package following existing repository conventions, implement config file discovery for both scopes, and read + parse each discovered file using `parseConfig`.

**Functional Requirements:**

- The system shall create `packages/config` as a workspace package named `@weave/config` with:
  - `package.json` following the conventions of `@weave/core` and `@weave/engine` (Bun build target, `tsc --emitDeclarationOnly`, barrel export from `./dist/index.js`)
  - `tsconfig.json` and `tsconfig.build.json` extending root configs (matching the pattern of existing packages)
  - Dependency on `@weave/core` (workspace), `neverthrow`, and `pino`
  - The root `package.json` `workspaces` array updated to include `"packages/config"`
  - The root `tsconfig.json` `paths` updated with `@weave/config` mappings
  - The root `tsconfig.build.json` `references` updated with a `@weave/config` reference
- The system shall export a function (or class method) that discovers config files at exactly two well-known paths:
  - **Global**: `~/.weave/config.weave` (where `~` is the user's home directory, resolved via `Bun.env.HOME` or equivalent)
  - **Project**: `.weave/config.weave` (relative to the current working directory, or an explicit project root parameter)
- The system shall treat a missing config file as a non-error condition — if neither file exists, the function shall return a default empty `WeaveConfig` (matching `WeaveConfigSchema`'s defaults).
- The system shall read each discovered file using `Bun.file()` and parse its contents with `parseConfig` from `@weave/core`.
- If a file exists but cannot be read (permission error, I/O failure), the system shall return an error of type `ConfigLoadError` with variant `FileReadError` containing the file path and underlying cause.
- If `parseConfig` returns `err`, the system shall return an error of type `ConfigLoadError` with variant `ParseError` containing the file path and the `ConfigError[]` from `@weave/core`.
- All functions shall use `neverthrow` `Result` / `ResultAsync` return types. No thrown exceptions for expected failure paths.

**Proof Artifacts:**

- **File structure**: `packages/config/` exists with `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, and the root workspace files are updated.
- **Test**: `packages/config/src/__tests__/discovery.test.ts` — tests discovering files from both scopes, graceful handling of missing files, I/O error handling, and parse error propagation. All tests use mocked file I/O (no real filesystem). All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors across the entire workspace.

### Unit 2: Builtin Agent Defaults

**Purpose:** Define the 8 builtin agents as `.weave` DSL source strings within the package, parse them with `parseConfig`, and export the resulting base `WeaveConfig`. This ensures builtins use the same code path as user-defined agents — no special-case logic.

**Functional Requirements:**

- The system shall define `.weave` DSL source strings for all 8 builtin agents within `@weave/config`:
  - **Loom** — primary orchestrator/router (mode: `primary`, temperature: `0.1`, prompt_file: `"loom.md"`)
  - **Tapestry** — plan execution coordinator (mode: `primary`, temperature: `0.1`, prompt_file: `"tapestry.md"`)
  - **Shuttle** — domain-specific worker (mode: `all`, temperature: `0.2`, prompt_file: `"shuttle.md"`)
  - **Pattern** — strategic planner (mode: `subagent`, temperature: `0.3`, prompt_file: `"pattern.md"`)
  - **Thread** — codebase explorer (mode: `subagent`, temperature: `0.0`, prompt_file: `"thread.md"`)
  - **Spindle** — external researcher (mode: `subagent`, temperature: `0.1`, prompt_file: `"spindle.md"`)
  - **Weft** — reviewer/auditor (mode: `subagent`, temperature: `0.1`, prompt_file: `"weft.md"`)
  - **Warp** — security auditor (mode: `subagent`, temperature: `0.1`, prompt_file: `"warp.md"`)
- Each builtin agent definition shall be a valid `.weave` source string (or a single combined string) that is parsed through `parseConfig` from `@weave/core` at load time — the same pipeline used for user config files.
- The system shall export a function `getBuiltinConfig(): Result<WeaveConfig, ConfigError[]>` that returns the parsed builtin defaults. This function is pure and deterministic — the `.weave` source strings are hardcoded constants.
- The builtin config shall only define agents (no categories, workflows, disabled lists, or settings). Users own those concerns entirely.
- The builtin definitions shall include `description`, `prompt_file`, `models`, `mode`, `temperature`, and `tool_policy` for each agent, matching the documented defaults from the legacy architecture.
- The `prompt_file` values in builtin agent definitions shall use relative paths (e.g., `"loom.md"`) which will be resolved by the prompt path resolution step to the package's bundled prompts directory.

**Proof Artifacts:**

- **Test**: `packages/config/src/__tests__/builtins.test.ts` — tests:
  - `getBuiltinConfig()` returns `ok` with all 8 agents present
  - Each agent has the expected `mode`, `temperature`, and `prompt_file`
  - The builtin `.weave` source parses successfully through `parseConfig`
  - All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors.

### Unit 3: Deep-Merge Engine

**Purpose:** Implement the documented merge strategy that combines multiple `WeaveConfig` objects (builtins, global, project) into one, applying scalar override, object deep-merge, and array union-merge rules.

**Functional Requirements:**

- The system shall export a `mergeConfigs(...configs: WeaveConfig[]): WeaveConfig` function (pure, synchronous, no side effects) that merges any number of validated configs in priority order (last wins).
- The standard invocation merges three layers: `mergeConfigs(builtins, global, project)` — project overrides global overrides builtins.
- **Scalar fields** (e.g., `log_level`, `temperature`, `description`, `prompt`, `prompt_file`, `prompt_append`, `mode`): higher-priority value wins when defined; lower-priority value used as fallback when higher-priority value is `undefined`.
- **Object fields** (e.g., `agents`, `categories`, `workflows`, `disabled`, `tool_policy`): deep-merge recursively. If multiple layers define the same keyed entry (e.g., `agents.loom`), their properties are recursively merged (with higher-priority scalars overriding lower-priority scalars within that entry).
- **Array fields** (e.g., `models`, `skills`, `disabled.agents`, `disabled.hooks`, `disabled.skills`, `patterns`): union-merge — higher-priority entries appear first, followed by lower-priority entries not already present. Deduplication for string arrays uses string equality.
- The merge function shall not mutate any input config.
- The merge function shall handle the case where one or more inputs have empty/default field values (e.g., empty `agents` record, empty `disabled.agents` array).
- A user who writes `agent loom { temperature 0.5 }` in their project config and nothing else shall get a merged `agents.loom` that has `temperature: 0.5` from the project config and all other fields (`description`, `prompt_file`, `models`, `mode`, `tool_policy`) from the builtin default.

**Proof Artifacts:**

- **Test**: `packages/config/src/__tests__/merge.test.ts` — tests:
  - Scalar override (project `log_level` wins over global wins over builtins)
  - Three-layer agent deep-merge (builtin loom + global loom override + project loom override → all properties correctly merged)
  - Partial override: project declares only `agent loom { temperature 0.5 }` → merged loom has `temperature: 0.5` and all other fields from builtin
  - Agent addition (agent in global only, different agent in project only, builtins → all present)
  - Array union-merge for string arrays (`models`, `skills`, `disabled.agents`)
  - Array union-merge preserves priority ordering (project-first, then global, then builtin)
  - Empty config merge (builtins only, global only, project only, various combos)
  - Immutability (inputs not mutated)
  - All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors.

### Unit 4: Prompt File Resolution and Public API

**Purpose:** Resolve `prompt_file` paths relative to each scope's `prompts/` directory, and wire the full pipeline — builtins, discovery, parsing, resolution, merge — into a single public entry point that returns `ResultAsync<WeaveConfig, ConfigLoadError[]>`.

**Functional Requirements:**

- The system shall export a `resolvePromptPaths(config: WeaveConfig, scope: ConfigScope): WeaveConfig` function that transforms every `prompt_file` value in the config into an absolute path resolved relative to the scope's `prompts/` directory:
  - **Builtin scope**: Resolved to the package's bundled prompts directory (a known path within `@weave/config` or a configurable base directory)
  - **Global scope**: `~/.weave/prompts/<prompt_file>`
  - **Project scope**: `.weave/prompts/<prompt_file>` (relative to project root)
- Prompt file resolution shall occur **before** merging — each scope's `prompt_file` values are resolved against that scope's `prompts/` directory. After merging, all `prompt_file` paths in the final config are absolute and unambiguous.
- The system shall define a `ConfigScope` type (or equivalent) that carries the scope identifier and root directory for path resolution.
- The system shall export a `loadConfig(projectRoot?: string): ResultAsync<WeaveConfig, ConfigLoadError[]>` function as the primary public API. This function orchestrates the full pipeline:
  1. Load builtin agent defaults via `getBuiltinConfig()`
  2. Discover global and project config files on disk
  3. Read and parse each discovered file with `parseConfig`
  4. Resolve `prompt_file` paths for each scope (builtins, global, project)
  5. Deep-merge all three layers: `mergeConfigs(builtins, global, project)`
  6. Return the merged `WeaveConfig`
- When no user config files exist, `loadConfig()` shall return the builtin defaults (with resolved prompt paths) — Weave works out of the box.
- The `projectRoot` parameter shall default to the current working directory when not provided.
- The system shall export the `ConfigLoadError` type, `ConfigScope` type, `loadConfig` function, `mergeConfigs` function, and `getBuiltinConfig` function from the package barrel (`index.ts`).
- The system shall use structured pino logging (via a local pino child logger) for discovery and merge operations (debug-level for file discovery and builtin loading, info-level for successful load).

**Proof Artifacts:**

- **Test**: `packages/config/src/__tests__/resolve.test.ts` — tests prompt file path resolution for builtin, global, and project scopes, agents with no `prompt_file` (no-op), and correct absolute path construction for each scope. All pass via `bun test`.
- **Test**: `packages/config/src/__tests__/load-config.test.ts` — end-to-end integration tests with mocked file I/O:
  - No user configs → returns builtin defaults with all 8 agents
  - Project-only config overriding one builtin agent field → field overridden, rest from builtin
  - Global-only config adding a custom agent → builtins + custom agent present
  - Both global and project configs → three-layer merge correct
  - Parse error from one scope → error propagated with file path
  - I/O error → error propagated
  - All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors across the entire workspace.
- **CLI**: `bun test` passes all tests in `packages/config/`.

## Non-Goals (Out of Scope)

- **Builtin agent prompt file content** — This spec defines builtin agent _configurations_ (mode, temperature, tool_policy, prompt_file reference). The actual prompt `.md` files for builtin agents (e.g., `loom.md`, `shuttle.md`) are not authored in this spec. Placeholder prompt files may be created, but the full prompt content is a future deliverable.
- **Prompt file content loading** — This spec resolves `prompt_file` paths to absolute filesystem locations. Actually reading prompt file contents and injecting them into agent prompts is an engine responsibility (prompt composition).
- **Adding or removing builtin agents** — The set of 8 builtin agents is fixed in this spec. A mechanism for plugins or adapters to register additional builtins is future work.
- **Disabling builtin agents** — The `disable agents ["warp"]` DSL directive is parsed and stored in `WeaveConfig.disabled.agents`. However, filtering disabled agents out of the returned config is the engine's responsibility (`WeaveRunner`), not the config loader's. The merged config includes all agents; the engine decides which to skip.
- **Config file watching / hot-reload** — This spec loads config once. Watching for changes and reloading is a future feature.
- **Config file writing / generation** — This spec reads and merges configs. Creating, scaffolding, or migrating `.weave` files is out of scope.
- **CLI integration** — No CLI commands are added in this spec. The public API is a programmatic function.
- **Validation beyond `parseConfig`** — Cross-scope validation (e.g., "project disables an agent that only global defines") is not in scope. Each scope is independently validated by `parseConfig`.
- **Continuation, analytics, or background config sections** — These settings blocks are parsed by `@weave/core` as generic `SettingAssignment` nodes. Deep-merge handles them generically (as objects/scalars). No special-case logic is added.
- **Environment variable overrides** — Config values are not overridable via env vars in this spec.
- **`prompt_file` existence validation** — The system resolves paths but does not verify that the referenced `.md` files exist on disk. That is deferred to the prompt composition layer.

## Design Considerations

No specific UI/UX design requirements identified. This is a programmatic library package with no user-facing interface.

## Repository Standards

The implementation shall follow established repository patterns:

- **Package scaffold**: Match `@weave/core` and `@weave/engine` exactly — same `package.json` structure (`main`, `types`, `module`, `exports`, `scripts`), same `tsconfig.json`/`tsconfig.build.json` pattern, same `bun build` + `tsc --emitDeclarationOnly` approach.
- **Bun only**: Use `Bun.file()` for file reads, `bun:test` for tests, `bun build` for bundling. No Node.js `fs` APIs.
- **`neverthrow` everywhere**: All fallible functions return `Result<T, E>` or `ResultAsync<T, E>`. Use `ResultAsync.fromThrowable` or `ResultAsync.fromPromise` to wrap `Bun.file().text()` calls.
- **Discriminated union errors**: `ConfigLoadError` must be a discriminated union with explicit variants, not `unknown` or bare strings.
- **Structured pino logging**: Use `logger.child({ module: "config" })`. Structured fields, not interpolated strings.
- **JSDoc on exports**: Every exported function, type, and constant.
- **Barrel exports**: All public API re-exported from `packages/config/src/index.ts`.
- **Test isolation**: All tests use mocked file I/O — no real filesystem reads. Follow the `MockAdapter` pattern from `@weave/engine`.
- **Biome linting**: Code must pass `biome lint` and `biome check`.

## Technical Considerations

- **Package dependency graph**: `@weave/config` depends on `@weave/core` (for `parseConfig`, `WeaveConfig`, `ConfigError`) and `pino` (for logging). It does **not** depend on `@weave/engine` — to avoid circular dependencies, it should either import `pino` directly and create its own logger, or the logger creation pattern should be extracted. The simplest approach: `@weave/config` creates its own pino child logger internally, consistent with how `@weave/engine` does it.
- **Builtin definitions as `.weave` strings**: Builtin agents are defined as hardcoded `.weave` DSL source strings (or a single combined string) within the package. They are parsed through `parseConfig` at load time — no special TypeScript object construction. This enforces the DSL-first principle: if it can't be expressed in the DSL, it can't be a builtin.
- **Builtin prompt file location**: Builtin `prompt_file` values (e.g., `"loom.md"`) need a base directory for resolution. Options: (a) ship placeholder `.md` files in `packages/config/prompts/` and resolve relative to the package directory, or (b) resolve to a well-known runtime path. This spec uses option (a) — the package ships a `prompts/` directory with placeholder files, and resolution uses the package's directory as the base.
- **Three-layer merge**: The merge function accepts a variadic list of configs and folds them left-to-right. `mergeConfigs(builtins, global, project)` first merges builtins with global, then merges that result with project. This is equivalent to a left-fold: `configs.reduce((acc, next) => merge2(acc, next))`.
- **`Bun.file()` wrapping**: `Bun.file(path).text()` returns a `Promise<string>` that rejects on I/O errors. Wrap with `ResultAsync.fromPromise()` to convert to `ResultAsync<string, FileReadError>`.
- **File existence check**: Use `Bun.file(path).exists()` (returns `Promise<boolean>`) to check whether a config file is present before attempting to read it. A missing file is not an error.
- **Home directory resolution**: Use `Bun.env.HOME` (or `os.homedir()` equivalent via Bun) to resolve `~`. The global config path is `${home}/.weave/config.weave`.
- **Merge implementation**: A recursive `deepMerge` utility that inspects value types at each key:
  - `Array.isArray(val)` → union-merge (higher-priority first, then lower-priority entries not already present)
  - `typeof val === "object" && val !== null && !Array.isArray(val)` → recurse
  - Otherwise → higher-priority value wins (scalar override)
- **Immutability**: The merge function must not mutate inputs. Use object spread or `structuredClone` for intermediate values.
- **`prompt_file` resolution timing**: Resolve before merge, not after. Each scope's `prompt_file` is resolved against its own `prompts/` directory. After merge, the winning `prompt_file` value is already an absolute path regardless of which scope it came from.
- **`prompt_file` in categories**: `CategoryConfigSchema` has `prompt_append` (string) but no `prompt_file`. Only `AgentConfigSchema` has `prompt_file`. Resolution only needs to walk `config.agents`.
- **Error aggregation**: If both global and project configs have parse errors, the function should aggregate all errors and return them together, not short-circuit on the first failure.
- **Builtin parse failure**: If `parseConfig` fails on the hardcoded builtin `.weave` strings, this is a programming error (the builtins are invalid DSL). The function should return an error with a `BuiltinParseError` variant that makes this clear — it indicates a bug in the package, not a user config problem.

## Security Considerations

- **Path traversal**: `prompt_file` is already validated by `@weave/core`'s `AgentConfigSchema` to reject `..` segments and absolute paths. The resolution step in this package joins a trusted base directory with the validated relative path. No additional traversal risk is introduced.
- **Home directory access**: Reading `~/.weave/config.weave` accesses the user's home directory. This is expected behaviour for a user-level config file. No escalation beyond the user's own filesystem permissions.
- **No secrets in config**: The `.weave` DSL does not support secret/credential fields. This package does not introduce any new sensitive data handling.

## Success Metrics

- **Zero-config works**: `loadConfig()` with no user config files returns a valid `WeaveConfig` containing all 8 builtin agents with correct defaults.
- **Partial override works**: A user writing `agent loom { temperature 0.5 }` in their project config gets a merged `agents.loom` with `temperature: 0.5` and all other fields from the builtin default.
- **Full pipeline works end-to-end**: `loadConfig()` loads builtins, discovers files, parses, resolves prompt paths, merges all three layers, and returns a typed `WeaveConfig` wrapped in `ResultAsync`.
- **Merge correctness**: Given builtins, global, and project configs with overlapping agents, categories, and disabled lists, the merge output matches the documented semantics (scalar override, object deep-merge, array union-merge) across all three layers.
- **Prompt paths are absolute**: After `loadConfig()`, every `prompt_file` in the returned config is an absolute path pointing to the correct scope's `prompts/` directory (builtin, global, or project).
- **Graceful degradation**: Missing user config files produce the builtin defaults, not an error.
- **Error clarity**: Every `ConfigLoadError` identifies the failing file path and whether the failure was I/O, parse, or builtin parse.
- **Type-check clean**: `bun run typecheck` passes with zero errors across the entire workspace after the package is added.
- **Test coverage**: Builtins, discovery, merge, resolution, and end-to-end pipeline each have dedicated test files with mocked I/O.

## Open Questions

- **Array union-merge for object arrays**: For string arrays (`models`, `skills`, `disabled.agents`), deduplication uses string equality. For object arrays (`triggers` — `{ domain, trigger }`), deduplication semantics are less obvious. **Recommendation**: Deduplicate `triggers` by structural equality of `domain + trigger` pair. If this proves insufficient, a follow-up spec can introduce key-based dedup.
- **`models` ordering in union-merge**: `models` is an ordered preference list where "first available wins." Union-merge should preserve higher-priority entries first, then append lower-priority entries not already present (project → global → builtin), maintaining priority ordering. **Recommendation**: Adopt this priority-first ordering as the standard for all array union-merges.
- **Architectural note — `@weave/config` vs `@weave/engine` loader**: AGENTS.md currently describes `loader.ts` as part of `@weave/engine`. This spec creates a separate `@weave/config` package instead, providing better separation of concerns (config loading is independent of the runner and adapter lifecycle). AGENTS.md should be updated to reflect this architectural decision once the spec is implemented.
- **Logger dependency**: The simplest approach is for `@weave/config` to depend on `pino` directly and create its own logger instance, avoiding a dependency on `@weave/engine`. An alternative is to accept a logger via dependency injection. **Recommendation**: Direct `pino` dependency with a local logger, matching the self-contained pattern. If a shared logger becomes important later, it can be extracted into a `@weave/logger` package.
- **Builtin agent `models` defaults**: The legacy architecture shows each agent uses model resolution with fallbacks, but the exact default `models` list for each builtin is not fully specified in the current AGENTS.md. **Recommendation**: Use a sensible default like `["claude-sonnet-4-5"]` as a placeholder for all builtins, with the expectation that users override via global/project config. The exact defaults can be refined in a follow-up.
- **Builtin prompt file shipping strategy**: Placeholder `.md` files in `packages/config/prompts/` are sufficient for this spec. Full prompt content authoring is a separate deliverable. **Recommendation**: Ship empty or minimal placeholder prompts so the pipeline is testable end-to-end.
- **Category `prompt_append` resolution**: Categories have `prompt_append` (an inline string), not `prompt_file`. No path resolution is needed for categories. Confirming this is correct and that no future `prompt_file` support for categories is planned in this spec.
