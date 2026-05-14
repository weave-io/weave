# 03-tasks-config-discovery

## Relevant Files

| File                                                | Why It Is Relevant                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/config/package.json`                      | **New.** Package manifest for `@weave/config`.                                      |
| `packages/config/tsconfig.json`                     | **New.** Dev tsconfig extending root.                                               |
| `packages/config/tsconfig.build.json`               | **New.** Build tsconfig with declaration emit, references `@weave/core`.            |
| `packages/config/src/index.ts`                      | **New.** Barrel exports for the package's public API.                               |
| `packages/config/src/errors.ts`                     | **New.** `ConfigLoadError` discriminated union type.                                |
| `packages/config/src/types.ts`                      | **New.** `ConfigScope` type and scope constants.                                    |
| `packages/config/src/logger.ts`                     | **New.** Package-local pino child logger.                                           |
| `packages/config/src/builtins.ts`                   | **New.** Builtin agent `.weave` DSL strings and `getBuiltinConfig()`.               |
| `packages/config/src/discovery.ts`                  | **New.** Config file discovery and scope-aware parsing.                             |
| `packages/config/src/merge.ts`                      | **New.** `mergeConfigs()` — variadic deep-merge engine.                             |
| `packages/config/src/resolve.ts`                    | **New.** `resolvePromptPaths()` — scope-aware prompt_file resolution.               |
| `packages/config/src/loader.ts`                     | **New.** `loadConfig()` — orchestrates the full pipeline.                           |
| `packages/config/prompts/loom.md`                   | **New.** Placeholder prompt file for Loom builtin agent.                            |
| `packages/config/prompts/tapestry.md`               | **New.** Placeholder prompt file for Tapestry builtin agent.                        |
| `packages/config/prompts/shuttle.md`                | **New.** Placeholder prompt file for Shuttle builtin agent.                         |
| `packages/config/prompts/pattern.md`                | **New.** Placeholder prompt file for Pattern builtin agent.                         |
| `packages/config/prompts/thread.md`                 | **New.** Placeholder prompt file for Thread builtin agent.                          |
| `packages/config/prompts/spindle.md`                | **New.** Placeholder prompt file for Spindle builtin agent.                         |
| `packages/config/prompts/weft.md`                   | **New.** Placeholder prompt file for Weft builtin agent.                            |
| `packages/config/prompts/warp.md`                   | **New.** Placeholder prompt file for Warp builtin agent.                            |
| `packages/config/src/__tests__/builtins.test.ts`    | **New.** Tests for `getBuiltinConfig()`.                                            |
| `packages/config/src/__tests__/discovery.test.ts`   | **New.** Tests for config file discovery with mocked I/O.                           |
| `packages/config/src/__tests__/merge.test.ts`       | **New.** Tests for `mergeConfigs()` merge semantics.                                |
| `packages/config/src/__tests__/resolve.test.ts`     | **New.** Tests for `resolvePromptPaths()`.                                          |
| `packages/config/src/__tests__/load_config.test.ts` | **New.** End-to-end tests for `loadConfig()` with mocked I/O.                       |
| `package.json`                                      | **Modify.** Add `"packages/config"` to `workspaces` array.                          |
| `tsconfig.json`                                     | **Modify.** Add `@weave/config` path mappings.                                      |
| `tsconfig.build.json`                               | **Modify.** Add `@weave/config` reference.                                          |
| `docs/config-loading.md`                            | **New.** Architecture doc for config discovery, merge semantics, builtin overrides. |

### Notes

- All new files are in `packages/config/`. No modifications to `@weave/core` or `@weave/engine` source files.
- Tests use `bun:test` and mocked file I/O — no real filesystem reads.
- Filenames follow `snake_case` / `kebab-case` per `biome.json` `useFilenamingConvention` rule.
- The test preload at `scripts/test-setup.ts` sets `LOG_LEVEL=silent`, so pino output won't pollute test results.
- The `packages/config/prompts/` directory contains placeholder `.md` files — full prompt content is out of scope.

## Tasks

### [x] 1.0 Package Scaffold and Error Types

Create the `@weave/config` workspace package with all boilerplate, define the `ConfigLoadError` discriminated union and `ConfigScope` type, and integrate into the root workspace. This is the prerequisite for all other tasks.

#### 1.0 Proof Artifact(s)

- File structure: `packages/config/` exists with `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, `src/errors.ts`, `src/types.ts`, `src/logger.ts`
- CLI: `bun install` succeeds with the new workspace package resolved
- CLI: `bun run typecheck` passes with zero errors across the entire workspace (including `@weave/config` path mappings)
- CLI: `bun run build` succeeds for `@weave/config`

#### 1.0 Tasks

- [x] 1.1 Create `packages/config/package.json` named `@weave/config` following the conventions of `@weave/core` and `@weave/engine`: `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`, `module: "./dist/index.js"`, `exports` map, `scripts` with `build` (`bun build ./src/index.ts --outdir ./dist --target bun && tsc -p tsconfig.build.json --emitDeclarationOnly`), `test` (`bun test ./src/__tests__`), `typecheck` (`tsc --noEmit -p tsconfig.json`), `clean` (`rm -rf dist`). Dependencies: `@weave/core: "workspace:*"`, `neverthrow`, `pino`. No devDependencies beyond `typescript`.
- [x] 1.2 Create `packages/config/tsconfig.json` extending `../../tsconfig.json` with `include: ["src/**/*"]`, `exclude: ["node_modules", "dist"]` (matching `@weave/core` pattern).
- [x] 1.3 Create `packages/config/tsconfig.build.json` extending `../../tsconfig.build.json` with `rootDir: "./src"`, `outDir: "./dist"`, `types: ["bun-types"]`, and `references: [{ "path": "../../packages/core" }]` (matching `@weave/engine` pattern since we depend on `@weave/core`).
- [x] 1.4 Update root `package.json`: add `"packages/config"` to the `workspaces` array.
- [x] 1.5 Update root `tsconfig.json`: add `"@weave/config": ["./packages/config/src/index.ts"]` and `"@weave/config/*": ["./packages/config/src/*"]` to `paths`.
- [x] 1.6 Update root `tsconfig.build.json`: add `{ "path": "./packages/config" }` to `references`.
- [x] 1.7 Create `packages/config/src/errors.ts` defining the `ConfigLoadError` discriminated union with three variants: `{ type: "FileReadError"; path: string; cause: unknown }`, `{ type: "ParseError"; path: string; errors: ConfigError[] }` (importing `ConfigError` from `@weave/core`), and `{ type: "BuiltinParseError"; errors: ConfigError[] }`. Add JSDoc on the type and each variant.
- [x] 1.8 Create `packages/config/src/types.ts` defining `ConfigScope` as `{ kind: "builtin" | "global" | "project"; rootDir: string }`. Add JSDoc.
- [x] 1.9 Create `packages/config/src/logger.ts` with a package-local pino logger: `import pino from "pino"; export const logger = pino({ name: "weave:config", level: process.env.LOG_LEVEL ?? "info" });`. Add JSDoc.
- [x] 1.10 Create `packages/config/src/index.ts` as a barrel that re-exports `ConfigLoadError` from `./errors.js` and `ConfigScope` from `./types.js`. (Additional exports will be added in later tasks.)
- [x] 1.11 Run `bun install` to link the new workspace package. Verify it resolves without errors.
- [x] 1.12 Run `bun run typecheck` — zero errors across the entire workspace. Run `bun run build` — `@weave/config` builds successfully.

---

### [x] 2.0 Builtin Agent Defaults

Define all 8 builtin agents as `.weave` DSL source strings, parse them through `parseConfig`, export `getBuiltinConfig()`, and ship placeholder prompt files. Validates the DSL-first principle — builtins use the same pipeline as user configs.

#### 2.0 Proof Artifact(s)

- Test: `packages/config/src/__tests__/builtins.test.ts` — `getBuiltinConfig()` returns `ok` with all 8 agents; each agent has correct `mode`, `temperature`, `prompt_file`; the builtin `.weave` source parses successfully through `parseConfig`. All pass via `bun test packages/config/src/__tests__/builtins.test.ts`
- CLI: `bun run typecheck` passes with zero errors

#### 2.0 Tasks

- [x] 2.1 Create 8 placeholder prompt files in `packages/config/prompts/`: `loom.md`, `tapestry.md`, `shuttle.md`, `pattern.md`, `thread.md`, `spindle.md`, `weft.md`, `warp.md`. Each contains a single line: `# <AgentName>` followed by a blank line and `Placeholder — full prompt content is a future deliverable.`
- [x] 2.2 Create `packages/config/src/builtins.ts`. Define a `BUILTIN_WEAVE_SOURCE` constant containing a single `.weave` DSL string that declares all 8 agents. Use the agent properties from the legacy architecture doc and AGENTS.md examples:
  - `loom`: description `"Loom (Main Orchestrator)"`, prompt_file `"loom.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `primary`, temperature `0.1`, tool_policy `{ read allow, write allow, execute allow, delegate allow, network ask }`
  - `tapestry`: description `"Tapestry (Plan Execution)"`, prompt_file `"tapestry.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `primary`, temperature `0.1`, tool_policy `{ read allow, write allow, execute allow, network deny, delegate allow }`
  - `shuttle`: description `"Shuttle (Domain Specialist)"`, prompt_file `"shuttle.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `all`, temperature `0.2`, tool_policy `{ read allow, write allow, execute allow, network deny, delegate deny }`
  - `pattern`: description `"Pattern (Strategic Planner)"`, prompt_file `"pattern.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `subagent`, temperature `0.3`, tool_policy `{ read allow, write allow, execute deny, network deny, delegate deny }`
  - `thread`: description `"Thread (Codebase Explorer)"`, prompt_file `"thread.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `subagent`, temperature `0.0`, tool_policy `{ read allow, write deny, execute deny, network deny, delegate deny }`
  - `spindle`: description `"Spindle (External Researcher)"`, prompt_file `"spindle.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `subagent`, temperature `0.1`, tool_policy `{ read allow, write deny, execute deny, network allow, delegate deny }`
  - `weft`: description `"Weft (Reviewer)"`, prompt_file `"weft.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `subagent`, temperature `0.1`, tool_policy `{ read allow, write deny, execute deny, network deny, delegate deny }`
  - `warp`: description `"Warp (Security Auditor)"`, prompt_file `"warp.md"`, models `["github-copilot/claude-sonnet-4.5"]`, mode `subagent`, temperature `0.1`, tool_policy `{ read allow, write deny, execute deny, network deny, delegate deny }`
- [x] 2.3 In `builtins.ts`, implement and export `getBuiltinConfig(): Result<WeaveConfig, ConfigError[]>` that calls `parseConfig(BUILTIN_WEAVE_SOURCE)` and returns the result directly. Import `parseConfig`, `WeaveConfig`, `ConfigError` from `@weave/core` and `Result` from `neverthrow`. Add JSDoc.
- [x] 2.4 Export `BUILTIN_AGENT_NAMES` as a `readonly string[]` constant listing all 8 agent names: `["loom", "tapestry", "shuttle", "pattern", "thread", "spindle", "weft", "warp"]`.
- [x] 2.5 Update `packages/config/src/index.ts` to re-export `getBuiltinConfig` and `BUILTIN_AGENT_NAMES` from `./builtins.js`.
- [x] 2.6 Create `packages/config/src/__tests__/builtins.test.ts` with tests:
  - (a) `getBuiltinConfig()` returns `ok` (not `err`)
  - (b) Result contains exactly 8 agents with names matching `BUILTIN_AGENT_NAMES`
  - (c) `agents.loom` has `mode: undefined` (optional field, parser doesn't set it) — verify `temperature: 0.1`, `prompt_file: "loom.md"`
  - (d) `agents.shuttle` has `temperature: 0.2`, `prompt_file: "shuttle.md"`
  - (e) `agents.thread` has `temperature: 0.0`
  - (f) `agents.pattern` has `temperature: 0.3`
  - (g) No categories, workflows, or disabled entries in the builtin config
  - (h) The `BUILTIN_WEAVE_SOURCE` constant is valid DSL (parseConfig does not return errors)
- [x] 2.7 Run `bun test packages/config/src/__tests__/builtins.test.ts` — all pass. Run `bun run typecheck` — zero errors.

---

### [x] 3.0 Config File Discovery and Parsing

Implement discovery of `~/.weave/config.weave` (global) and `.weave/config.weave` (project), read each file via `Bun.file()`, parse with `parseConfig`, and return scoped results with proper error handling. Missing files are non-errors.

#### 3.0 Proof Artifact(s)

- Test: `packages/config/src/__tests__/discovery.test.ts` — tests file discovery for both scopes; graceful handling of missing files (returns `undefined`/empty, not error); `FileReadError` on I/O failure; `ParseError` on invalid DSL; both scopes discovered when both exist. All use mocked file I/O. All pass via `bun test packages/config/src/__tests__/discovery.test.ts`
- CLI: `bun run typecheck` passes with zero errors

#### 3.0 Tasks

- [x] 3.1 Create `packages/config/src/discovery.ts`. Define a `DiscoveredConfig` type: `{ config: WeaveConfig; scope: ConfigScope }`. Define a `discoverAndParse(projectRoot?: string): ResultAsync<DiscoveredConfig[], ConfigLoadError[]>` function that:
  - Resolves the global path as `${homedir}/.weave/config.weave` (using `Bun.env.HOME` or `import { homedir } from "os"` — verify Bun compatibility)
  - Resolves the project path as `${projectRoot ?? process.cwd()}/.weave/config.weave`
  - For each path, checks existence via `Bun.file(path).exists()`
  - If the file exists, reads it via `Bun.file(path).text()` wrapped in `ResultAsync.fromPromise()` with a `FileReadError` mapper
  - Parses the content with `parseConfig()` — if it returns `err`, wraps in `ParseError` with the file path
  - Returns an array of `DiscoveredConfig` entries (0, 1, or 2 entries depending on what exists)
  - Uses structured pino logging: `log.debug({ path, scope }, "Checking config file")` and `log.debug({ path, scope }, "Config file found")`
- [x] 3.2 Add JSDoc on `discoverAndParse` and `DiscoveredConfig`. Import logger from `./logger.js`.
- [x] 3.3 Update `packages/config/src/index.ts` to re-export `discoverAndParse` and `DiscoveredConfig` from `./discovery.js`.
- [x] 3.4 Create `packages/config/src/__tests__/discovery.test.ts`. Since `discoverAndParse` uses `Bun.file()` directly, tests need to mock at the module boundary. Use one of these strategies:
  - Extract a `FileReader` interface (e.g., `{ exists(path: string): Promise<boolean>; read(path: string): ResultAsync<string, ConfigLoadError> }`) and inject it into `discoverAndParse` as an optional parameter (defaulting to a real Bun implementation). Tests pass a mock `FileReader`.
  - Or use `bun:test` `mock.module` to stub `Bun.file`.
    The injectable approach is preferred per AGENTS.md ("Inject all dependencies through constructors / parameters"). Update `discoverAndParse` signature to accept an optional `fileReader` parameter.
- [x] 3.5 Implement tests in `discovery.test.ts`:
  - (a) Both files exist → returns 2 `DiscoveredConfig` entries (global first, project second) with correct scopes
  - (b) Only global exists → returns 1 entry with `kind: "global"`
  - (c) Only project exists → returns 1 entry with `kind: "project"`
  - (d) Neither file exists → returns empty array (not an error)
  - (e) File exists but read fails → returns `err` with `FileReadError` containing the path
  - (f) File exists and reads but has invalid DSL → returns `err` with `ParseError` containing the path and the `ConfigError[]`
  - (g) Global parse error does not prevent project discovery (errors aggregated)
  - (h) Both files exist but both have invalid DSL → returns `err` with aggregated errors from both paths (both file paths present in error list)
- [x] 3.6 Run `bun test packages/config/src/__tests__/discovery.test.ts` — all pass. Run `bun run typecheck` — zero errors.

---

### [x] 4.0 Deep-Merge Engine

Implement `mergeConfigs(...configs: WeaveConfig[]): WeaveConfig` — a pure, variadic merge function using left-fold semantics. Scalars: last-defined wins. Objects: recursive deep-merge. Arrays: union-merge (higher-priority first, dedup). Immutable — no input mutation.

#### 4.0 Proof Artifact(s)

- Test: `packages/config/src/__tests__/merge.test.ts` — scalar override across 3 layers; agent deep-merge (builtin loom + project `temperature` override → all other fields preserved); agent addition from different scopes; array union-merge with priority ordering; `disabled.agents` union-merge; empty config merges; immutability check (inputs not mutated). All pass via `bun test packages/config/src/__tests__/merge.test.ts`
- CLI: `bun run typecheck` passes with zero errors

#### 4.0 Tasks

- [x] 4.1 Create `packages/config/src/merge.ts`. Implement a private `deepMerge2(base: WeaveConfig, override: WeaveConfig): WeaveConfig` function that merges two configs. Internally, implement a recursive `mergeValues(base: unknown, override: unknown): unknown` helper that:
  - If `override` is `undefined`, returns `base`
  - If both are arrays, performs union-merge: `override` entries first, then `base` entries not already present (string dedup via `===`; object dedup via `JSON.stringify` equality)
  - If both are non-null objects (and not arrays), recursively merges each key
  - Otherwise, returns `override` (scalar override)
- [x] 4.2 Export `mergeConfigs(...configs: WeaveConfig[]): WeaveConfig` that performs `configs.reduce((acc, next) => deepMerge2(acc, next))`. Handle edge cases: 0 configs → return `WeaveConfigSchema` default; 1 config → return it as-is. Add JSDoc documenting the left-fold semantics and merge rules.
- [x] 4.3 Ensure immutability: `mergeValues` must never mutate its inputs. Use object spread `{ ...base }` for intermediate objects. Verify arrays are new instances (not the same reference).
- [x] 4.4 Update `packages/config/src/index.ts` to re-export `mergeConfigs` from `./merge.js`.
- [x] 4.5 Create `packages/config/src/__tests__/merge.test.ts` with a `cfg(source)` helper (matching `@weave/engine` runner test pattern) and tests:
  - (a) **Scalar override**: `mergeConfigs(cfg('log_level INFO'), cfg('log_level DEBUG'))` → `log_level` is `"DEBUG"`
  - (b) **Three-layer scalar**: `mergeConfigs(cfgA, cfgB, cfgC)` where only `cfgC` sets `log_level` → `cfgC`'s value wins
  - (c) **Agent deep-merge (partial override)**: builtin loom (temperature 0.1, prompt_file "loom.md", models ["github-copilot/claude-sonnet-4.5"]) + project loom (temperature 0.5 only) → merged loom has `temperature: 0.5`, `prompt_file: "loom.md"`, `models: ["github-copilot/claude-sonnet-4.5"]`
  - (d) **Agent addition**: builtin defines loom, project defines `my-helper` → merged config has both agents
  - (e) **Array union-merge (models)**: global loom models `["gpt-4o"]`, project loom models `["github-copilot/claude-sonnet-4.5"]` → merged `["github-copilot/claude-sonnet-4.5", "gpt-4o"]` (project first)
  - (f) **Array union-merge (disabled.agents)**: global disables `["warp"]`, project disables `["spindle"]` → merged `["spindle", "warp"]` (project first, deduped)
  - (g) **Array union-merge dedup**: both layers have `"github-copilot/claude-sonnet-4.5"` in models → appears once
  - (h) **Empty config merge**: `mergeConfigs(emptyConfig, emptyConfig)` → valid empty config
  - (i) **Single config**: `mergeConfigs(cfg)` → returns equivalent config
  - (j) **Zero configs**: `mergeConfigs()` → returns default empty `WeaveConfig`
  - (k) **Immutability**: deep-freeze inputs before merge, verify no mutation (or clone inputs, merge, verify originals unchanged)
  - (l) **tool_policy deep-merge**: builtin loom has `read: allow, write: allow`, project adds `network: ask` → merged has all three
- [x] 4.6 Run `bun test packages/config/src/__tests__/merge.test.ts` — all pass. Run `bun run typecheck` — zero errors.

---

### [x] 5.0 Prompt File Resolution, Public API, and Documentation

Implement `resolvePromptPaths()` for all three scopes, wire the full `loadConfig()` pipeline (builtins → discover → parse → resolve → merge → return), export the barrel, and create the architecture doc for `@weave/config`.

#### 5.0 Proof Artifact(s)

- Test: `packages/config/src/__tests__/resolve.test.ts` — prompt file resolution for builtin, global, and project scopes; agents without `prompt_file` are no-ops; correct absolute path construction. All pass via `bun test packages/config/src/__tests__/resolve.test.ts`
- Test: `packages/config/src/__tests__/load_config.test.ts` — end-to-end with mocked I/O: no user configs → 8 builtin agents returned; project override of one field → partial override correct; global adds custom agent → builtins + custom present; both configs → 3-layer merge; parse error propagated with file path; I/O error propagated. All pass via `bun test packages/config/src/__tests__/load_config.test.ts`
- CLI: `bun run typecheck` passes with zero errors across entire workspace
- CLI: `bun test` passes all tests in `packages/config/`
- CLI: Pre-commit hook passes (`bun test --recursive`, `bun run typecheck`, biome check)
- File: `docs/config-loading.md` exists with architecture overview, merge semantics, and cross-links

#### 5.0 Tasks

- [x] 5.1 Create `packages/config/src/resolve.ts`. Implement and export `resolvePromptPaths(config: WeaveConfig, scope: ConfigScope): WeaveConfig` that:
  - Iterates over `config.agents` entries
  - For each agent with a defined `prompt_file`, joins `scope.rootDir + "/prompts/" + prompt_file` using `path.resolve` (or `Bun`-compatible path join) to produce an absolute path
  - Returns a new `WeaveConfig` with the resolved paths (does not mutate input)
  - Agents without `prompt_file` are left unchanged
  - Categories are left unchanged (they have `prompt_append`, not `prompt_file`)
- [x] 5.2 Add JSDoc on `resolvePromptPaths` documenting scope-aware resolution. Import `path` from `"node:path"` (Bun supports this).
- [x] 5.3 Create `packages/config/src/__tests__/resolve.test.ts` with tests:
  - (a) **Builtin scope**: agent with `prompt_file: "loom.md"` + scope `{ kind: "builtin", rootDir: "/pkg/config" }` → resolved to `"/pkg/config/prompts/loom.md"`
  - (b) **Global scope**: agent with `prompt_file: "custom.md"` + scope `{ kind: "global", rootDir: "/home/user/.weave" }` → resolved to `"/home/user/.weave/prompts/custom.md"`
  - (c) **Project scope**: agent with `prompt_file: "shuttle.md"` + scope `{ kind: "project", rootDir: "/proj/.weave" }` → resolved to `"/proj/.weave/prompts/shuttle.md"`
  - (d) **No prompt_file**: agent without `prompt_file` → unchanged
  - (e) **Mixed agents**: one agent with `prompt_file`, another without → only the first is resolved
  - (f) **Immutability**: original config not mutated
- [x] 5.4 Create `packages/config/src/loader.ts`. Implement and export `loadConfig(projectRoot?: string): ResultAsync<WeaveConfig, ConfigLoadError[]>` that orchestrates:
  1. Call `getBuiltinConfig()` — if `err`, wrap in `BuiltinParseError` and return
  2. Call `discoverAndParse(projectRoot)` — if `err`, return the errors
  3. Resolve prompt paths for each layer:
     - Builtins: scope `{ kind: "builtin", rootDir: <path to packages/config directory> }` — use `import.meta.dir` or `path.resolve(__dirname, "..")` to find the package root where `prompts/` lives
     - Each discovered config: scope from its `DiscoveredConfig.scope`
  4. Merge all layers: `mergeConfigs(resolvedBuiltins, ...resolvedDiscovered)` (builtins first, then global, then project — discovery returns them in this order)
  5. Return `ok(mergedConfig)`
  - Use structured pino logging: `log.info("Config loaded successfully")`, `log.debug({ agentCount }, "Merged config")`
- [x] 5.5 Add JSDoc on `loadConfig` documenting the pipeline steps and default `projectRoot` behavior.
- [x] 5.6 Update `packages/config/src/index.ts` to re-export: `loadConfig` from `./loader.js`, `resolvePromptPaths` from `./resolve.js`, `discoverAndParse` and `DiscoveredConfig` from `./discovery.js`, `mergeConfigs` from `./merge.js`, `getBuiltinConfig` and `BUILTIN_AGENT_NAMES` from `./builtins.js`, `ConfigLoadError` from `./errors.js`, `ConfigScope` from `./types.js`.
- [x] 5.7 Create `packages/config/src/__tests__/load_config.test.ts` with mocked `FileReader` (same injection approach as discovery tests) and tests:
  - (a) **Zero-config**: no user config files exist → returns `ok` with all 8 builtin agents, each with absolute `prompt_file` paths
  - (b) **Project override**: project config has `agent loom { temperature 0.5 }` → merged loom has `temperature: 0.5`, other fields from builtin, `prompt_file` is absolute path to project scope's `prompts/loom.md` (project wins over builtin)
  - (c) **Global custom agent**: global config has `agent my-helper { prompt "Hi" models ["gpt-4o"] }` → merged config has all 8 builtins + `my-helper`
  - (d) **Both configs**: global sets `log_level INFO`, project sets `log_level DEBUG` and overrides loom temperature → merged has `log_level: "DEBUG"`, loom with project temperature, builtins for everything else
  - (e) **Parse error**: project config has invalid DSL → returns `err` with `ParseError` containing the file path
  - (f) **I/O error**: file exists but read throws → returns `err` with `FileReadError` containing the path
  - (g) **Prompt paths are absolute**: all `prompt_file` values in the returned config are absolute paths (start with `/`)
- [x] 5.8 Run `bun test packages/config/src/__tests__/resolve.test.ts` and `bun test packages/config/src/__tests__/load_config.test.ts` — all pass.
- [x] 5.9 Run full suite: `bun test --recursive` — all tests pass. Run `bun run typecheck` — zero errors. Run `biome check packages/config/` — no lint errors.
- [x] 5.10 Create `docs/config-loading.md` with:
  - **Overview**: `@weave/config` owns the config-loading pipeline; links to [spec](03-spec-config-discovery.md)
  - **Three-Layer Merge**: diagram showing `builtins → global → project`, merge rules (scalar override, object deep-merge, array union-merge)
  - **Builtin Agents**: list of 8 agents with default properties; link to `packages/config/src/builtins.ts`; explanation that builtins use the same `.weave` DSL pipeline
  - **Config Discovery**: file paths, missing file behavior, error types
  - **Prompt File Resolution**: scope-aware path resolution, timing (before merge)
  - **Public API**: `loadConfig()` usage example
  - **Architectural Decision**: why `@weave/config` is a separate package (not `@weave/engine`'s `loader.ts`); context, decision, consequences (ADR format)
  - Cross-links to AGENTS.md, legacy-architecture.md, and the spec
- [x] 5.11 Verify pre-commit hook passes: run the full hook sequence manually (`bun run typecheck`, `bun test --recursive`, `biome check packages/config/`). Fix any issues.
