# Config Loading

`@weave/config` owns the config-discovery, merge, and loading pipeline for Weave. It is the single entry point for reading agent configuration from disk and producing the final merged `WeaveConfig` consumed by the engine.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Model Resolution](model-resolution.md) · [Spec 03 — Config Discovery](specs/03-spec-config-discovery/03-spec-config-discovery.md) · [AGENTS.md](../AGENTS.md) · [Legacy Architecture](legacy-architecture.md) · [`packages/config/src/loader.ts`](../packages/config/src/loader.ts)

---

## Three-Layer Merge

Configuration is assembled from three layers in priority order (lowest → highest):

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 (lowest priority)  —  Built-ins                    │
│    packages/config/src/builtins.ts — BUILTIN_WEAVE_SOURCE   │
│                                                             │
│  Layer 2                    —  Global                       │
│    ~/.weave/config.weave                                    │
│                                                             │
│  Layer 3 (highest priority) —  Project                      │
│    <projectRoot>/.weave/config.weave                        │
└─────────────────────────────────────────────────────────────┘
```

### Merge Rules

| Value type                                   | Behaviour                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scalar** (string, number, boolean, enum)   | Last-defined wins — project overrides global overrides builtin                                                                                                            |
| **Object** (e.g. `agents`, `tool_policy`)    | Recursive deep-merge — only keys present in the override are updated; all other keys are preserved from lower layers                                                      |
| **Array** (e.g. `models`, `disabled.agents`) | Union-merge — override entries come first, then base entries not already present (deduped by `JSON.stringify` equality); order reflects priority (highest-priority first) |

**Example:** a project config with `agent loom { temperature 0.5 }` leaves all other loom fields (models, prompt_file, tool_policy) intact from the builtin layer.

**Immutability:** Inputs are never mutated. Each merge step produces a new object.

See [`packages/config/src/merge.ts`](../packages/config/src/merge.ts) for the implementation.

---

## Builtin Agents

Eight built-in agents are shipped with `@weave/config`:

| Agent      | Mode     | Temperature | Role                |
| ---------- | -------- | ----------- | ------------------- |
| `loom`     | primary  | 0.1         | Main orchestrator   |
| `tapestry` | primary  | 0.1         | Plan execution      |
| `shuttle`  | all      | 0.2         | Domain specialist   |
| `pattern`  | subagent | 0.3         | Strategic planner   |
| `thread`   | subagent | 0.0         | Codebase explorer   |
| `spindle`  | subagent | 0.1         | External researcher |
| `weft`     | subagent | 0.1         | Reviewer            |
| `warp`     | subagent | 0.1         | Security auditor    |

**DSL-first:** Builtins are declared as a `.weave` DSL string in [`packages/config/src/builtins.ts`](../packages/config/src/builtins.ts) — there is no separate code path. They flow through the same `parseConfig` pipeline as user-authored configs. This means:

- Any user can replicate, extend, or replace any builtin by writing equivalent DSL in their config file.
- Bugs in the builtin DSL surface immediately as test failures in `builtins.test.ts`.

Placeholder prompt files ship in [`packages/config/prompts/`](../packages/config/prompts/) and are resolved to absolute paths by `resolvePromptPaths()` before merging. Full prompt content is a future deliverable.

---

## Config Discovery

`discoverAndParse()` in [`packages/config/src/discovery.ts`](../packages/config/src/discovery.ts) checks two locations:

| Scope   | Path                                | Behaviour                                        |
| ------- | ----------------------------------- | ------------------------------------------------ |
| Global  | `~/.weave/config.weave`             | Checked first; missing file is silently skipped  |
| Project | `<projectRoot>/.weave/config.weave` | Checked second; missing file is silently skipped |

**Missing files are non-errors.** Only actual I/O failures or parse failures produce errors.

**Error aggregation:** If both files have errors, all errors are collected and returned together as a `ConfigLoadError[]` — callers receive the complete picture.

### Error types

| Type                | When                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `FileReadError`     | File exists but could not be read from disk                               |
| `ParseError`        | File was read but the DSL could not be parsed or validated                |
| `BuiltinParseError` | The built-in DSL source string itself failed to parse (always a code bug) |

See [`packages/config/src/errors.ts`](../packages/config/src/errors.ts).

---

## Prompt File Resolution

`resolvePromptPaths()` in [`packages/config/src/resolve.ts`](../packages/config/src/resolve.ts) converts relative `prompt_file` values to absolute paths **before** merging.

Each scope has a `rootDir` (see [`packages/config/src/types.ts`](../packages/config/src/types.ts)):

- **builtin** → `packages/config/` (where `prompts/` ships with this package)
- **global** → `~/.weave/`
- **project** → `<projectRoot>/.weave/`

A `prompt_file: "loom.md"` in scope `{ rootDir: "/my/project/.weave" }` resolves to `/my/project/.weave/prompts/loom.md`.

Resolution happens before merging so that when two layers both define the same agent's `prompt_file`, the winning value is already an absolute path pointing to the correct scope's `prompts/` directory.

---

## Public API

```ts
import { loadConfig } from "@weave/config";

const result = await loadConfig("/path/to/project");

result.match(
  (config) => {
    // config.agents["loom"].prompt_file is an absolute path
    // config.agents includes all 8 builtins + user additions
    startRunner(config);
  },
  (errors) => {
    for (const e of errors) {
      if (e.type === "ParseError") console.error(`${e.path}: parse failed`);
      if (e.type === "FileReadError") console.error(`${e.path}: read failed`);
      if (e.type === "BuiltinParseError")
        console.error("BUG: builtin DSL invalid");
    }
    process.exit(1);
  },
);
```

`loadConfig` accepts an optional `projectRoot` (defaults to `process.cwd()`) and an optional `FileReader` for testing with mocked I/O. This config-file I/O is Weave-owned because `.weave/config.weave` and `.weave/prompts/` are part of Weave's DSL/config layer; it is distinct from harness-owned resource discovery such as skills or available models.

All exports are available from the package barrel:

```ts
import {
  loadConfig, // Full pipeline
  getBuiltinConfig, // Builtins only
  discoverAndParse, // Discovery only
  mergeConfigs, // Merge only
  resolvePromptPaths, // Path resolution only
} from "@weave/config";
```

---

## Architectural Decision — Why a Separate `@weave/config` Package

### Context

The original alpha used a flat loader inside the OpenCode plugin. As the harness-agnostic successor matured, config loading became separate from both engine lifecycle and adapter translation: builtins, three-layer merge, and prompt path resolution are reusable inputs to any adapter or CLI.

### Decision

`@weave/config` is a separate workspace package that `@weave/engine`, adapters, and future CLI tools can depend on. Config loading is not a harness concern and does not query harness UI/runtime state.

### Consequences

**Positive:**

- Config logic is independently testable without an engine harness.
- Future adapters (or CLI tools) can call `loadConfig()` without pulling in engine dependencies.
- The builtin DSL-first approach is clean — `@weave/config` ships the DSL source and the `prompts/` files together in the same package.
- The package boundary reinforces the product vision: Weave normalizes intent; adapters materialize it for a harness.

**Negative:**

- Contributors must understand that config loading, engine lifecycle, and adapter translation are separate layers.

**Mitigation:** AGENTS.md and the product-vision docs list `@weave/config` explicitly and point contributors to this ADR.
