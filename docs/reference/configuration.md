# Config Loading

`@weaveio/weave-config` owns the config-discovery, merge, and loading pipeline for Weave. It is the single entry point for reading agent configuration from disk and producing the final merged `WeaveConfig` consumed by the engine.

**Related:** [Product Vision](../architecture/product-vision.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [DSL Reference](dsl.md#settings-and-disables) · [Pi adapter contract](../adapters/pi.md) · [Spec 33 — Pi private child sessions](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Models](models.md) · [Workflows](workflows.md) · [CLI self-modification](cli.md#weave-prompt-self-modify)

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
| **Workflow** (when `extends` is set)         | Step-aware merge — see [Workflow Extension](#workflow-extension) below                                                                                                    |

**Example:** a project config with `agent loom { temperature 0.5 }` leaves all other loom fields (models, prompt_file, tool_policy) intact from the builtin layer.

**Immutability:** Inputs are never mutated. Each merge a new object.

See [`packages/config/src/merge.ts`](../../packages/config/src/merge.ts) for the implementation.

## Harness adapter settings

`settings.adapters.<harness>` is an opaque, JSON-like block. The DSL and config loader enforce the shared shape, nesting, and canonical-size limits; the named adapter owns the fields inside its block. Each source layer and the merged result are validated, and adapter settings merge with the same object/array/scalar rules above. Config loading does not open a harness session, inspect private history, or own transcripts.

For the Pi-specific `child_inspection` block, link to the canonical [Spec 33 settings contract](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#71-settings) rather than duplicating defaults or bounds. The Pi adapter applies those settings only in its local private-session store; they do not change engine Runtime Store retention or telemetry.

---

## Workflow Extension

When a project or global config declares a workflow with the same name as a builtin (or lower-priority) workflow **and** sets `extends`, the merge engine applies step-aware merge instead of the generic deep-merge.

### DSL syntax

```weave
workflow plan-and-execute {
  extends "plan-and-execute"   # name of the base workflow
  version 1

  # Insert a new step before an existing one.
  step write-spec {
    name "Write spec"
    type autonomous
    agent pattern
    prompt "Write a spec for: {{instance.goal}}"
    completion agent_signal
    insert_before "plan"
  }

  # Replace an existing step with the same name.
  step implement {
    name "Execute the plan (custom)"
    type autonomous
    agent shuttle
    prompt "Custom implementation prompt"
    completion plan_complete { plan_name "{{instance.slug}}" }
  }
}
```

### Step-aware merge algorithm

1. **Resolve base steps** — if `extends` equals the workflow's own name, the base from the lower-priority layer (the "project extends builtin" pattern). Otherwise the `extends` chain is followed through the workflow map.
2. **Same-name replacement** — override `name` matches a base the base place (preserving position).
3. **Anchored insertion** — remaining override `insert_before` or `insert_after` are inserted at the resolved index relative to the post-replacement
4. **Append** — remaining override no anchor and no same-name match are appended to the end.

### Error types

| Error type                | When                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `UnknownExtendsTarget`    | `extends` names a workflow that does not exist in the merged workflow map              |
| `UnknownInsertionAnchor`  | `insert_before` / `insert_after` names a does not exist in the base steps   |
| `BothInsertBeforeAndAfter`| A both `insert_before` and `insert_after` (mutually exclusive)          |
| `ExtendsCycle`            | The `extends` chain contains a cycle (A extends B, B extends A)                       |
| `ConfigValidationError`   | The merged config violates a cross-layer rule, such as an agent delegation cap       |

Workflow errors are wrapped as `WorkflowExtensionError`; all merge errors are wrapped in
`MergeError` and returned from `mergeConfigsResult`. See
[Delegation limits](delegation.md) for the delegation validation rules. The `loadConfig` pipeline surfaces them as `ConfigLoadError` with `type: "MergeError"`.

### `mergeConfigsResult` vs `mergeConfigs`

`mergeConfigsResult` is the preferred API — it returns `Result<WeaveConfig, MergeError[]>` and never throws. `mergeConfigs` is a deprecated wrapper that throws the first `MergeError` for callers that haven't migrated yet.

```ts
import { mergeConfigsResult } from "@weaveio/weave-config";

const result = mergeConfigsResult(builtins, globalConfig, projectConfig);
result.match(
  (config) => startRunner(config),
  (errors) => {
    for (const e of errors) {
      switch (e.type) {
        case "WorkflowExtensionError":
          reportWorkflowError(e.error);
          break;
        case "ConfigValidationError":
          reportConfigValidationErrors(e.errors);
          break;
      }
    }
  },
);
```

---

## Builtin Agents

Eight built-in agents are shipped with `@weaveio/weave-config`:

| Agent      | Mode     | Temperature | Role                |
| ---------- | -------- | ----------- | ------------------- |
| `loom`     | primary  | 0.1         | Main orchestrator   |
| `tapestry` | primary  | 0.1         | Plan execution      |
| `shuttle`  | subagent | 0.2         | Domain specialist   |
| `pattern`  | subagent | 0.3         | Strategic planner   |
| `thread`   | subagent | 0.0         | Codebase explorer   |
| `spindle`  | subagent | 0.1         | External researcher |
| `weft`     | subagent | 0.1         | Reviewer            |
| `warp`     | subagent | 0.1         | Security auditor    |

> **Migration note — `shuttle` mode changed to `subagent`:** In earlier versions of Weave, the builtin `shuttle` agent was declared with `mode all` (usable as both primary and subagent). It is now `mode subagent`. If your project config or adapter code relied on `shuttle` being available as a primary agent, override the mode in your project's `.weave/config.weave`:
> ```weave
> agent shuttle {
>   mode all
> }
> ```
> This change was made to align `shuttle` with its actual usage pattern — it is always invoked as a delegated specialist, never as a user-facing primary agent.

**DSL-first:** Builtins are declared as a `.weave` DSL string in [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts) — there is no separate code path. They flow through the same `parseConfig` pipeline as user-authored configs. This means:

- Any user can replicate, extend, or replace any builtin by writing equivalent DSL in their config file.
- Bugs in the builtin DSL surface immediately as test failures in `builtins.test.ts`.

**`packages/config` is the canonical source for shipped builtin defaults**, including builtin prompt files and shipped `triggers` declarations. Prompt files ship in [`packages/config/prompts/`](../../packages/config/prompts) and are **embedded at build time** using Bun's `with { type: "text" }` import assertion in `builtins.ts`. The embedded content is stored in `BUILTIN_PROMPT_CONTENTS` and inlined into the builtin config by `inlineBuiltinPrompts()` in `loader.ts` before merging. When builtin `triggers` are declared in the DSL source, the engine generates the `## Delegation` section from that config rather than from hand-maintained prompt text.

**Bundle-safe prompt resolution:** Builtin agents use `prompt` (inline content) rather than `prompt_file` (filesystem path) after loading. This is intentional — it makes builtin prompt resolution work correctly when `@weaveio/weave-config` is bundled into an adapter (e.g. `@weaveio/weave-adapter-opencode/dist/plugin.js`). See [Prompt File Resolution](#prompt-file-resolution) for details.

**Project config as delta-only overrides:** A project `.weave/config.weave` should contain only intentional differences from the shipped defaults — for example, model preferences, local `shuttle`/`weft` `prompt_file` overrides, and project-specific categories or workflows. Repeating builtin fields verbatim adds maintenance burden without benefit; the three-layer merge preserves all unoverridden builtin values automatically.

---

## Config Discovery

`discoverAndParse()` in [`packages/config/src/discovery.ts`](../../packages/config/src/discovery.ts) checks two locations:

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

See [`packages/config/src/errors.ts`](../../packages/config/src/errors.ts).

### Migration and canonical destinations

`weave init migrate` writes migrated config **only** to the canonical paths above — never to ad hoc locations. This is a hard constraint: the config loader only discovers `~/.weave/config.weave` and `<projectRoot>/.weave/config.weave`. A migrated file written anywhere else would be silently ignored at runtime.

The `--install-dir` flag accepted by ordinary `weave init` (for starter-config scaffolding) is **ignored** in migrate mode for this reason. See [CLI — `weave init migrate`](cli.md#weave-init-migrate) for the full migration contract.

### Self-modification and canonical paths

`weave prompt self-modify` uses the same canonical paths to tell agents exactly where to write config and prompt files. The guide it prints is scope-aware:

- **global** → `~/.weave/config.weave` and `~/.weave/prompts/`
- **local** → `<projectRoot>/.weave/config.weave` and `<projectRoot>/.weave/prompts/`

Agents following the guide must write to these paths only. Any file written outside these locations will be silently ignored by `discoverAndParse()` at runtime.

See [CLI — `weave prompt self-modify`](cli.md#weave-prompt-self-modify) for the full self-modification contract.

---

## Prompt File Resolution

`resolvePromptPaths()` in [`packages/config/src/resolve.ts`](../../packages/config/src/resolve.ts) converts relative `prompt_file` values to absolute paths **before** merging.

Each scope has a `rootDir` (see [`packages/config/src/types.ts`](../../packages/config/src/types.ts)):

- **builtin** → handled by `inlineBuiltinPrompts()` — see below
- **global** → `~/.weave/`
- **project** → `<projectRoot>/.weave/`

A `prompt_file: "loom.md"` in scope `{ rootDir: "/my/project/.weave" }` resolves to `/my/project/.weave/prompts/loom.md`.

Resolution happens before merging so that when two layers both define the same agent's `prompt_file`, the winning value is already an absolute path pointing to the correct scope's `prompts/` directory.

### Migration and prompt-file translation

When `weave init migrate` converts a legacy config, `prompt_file` values are preserved **only** when the path is a bare filename with no directory separators (e.g. `"loom.md"`). This is because `resolvePromptPaths()` resolves relative `prompt_file` values against the scope's `.weave/prompts/` directory — a bare filename maps cleanly to `<scopeRoot>/.weave/prompts/<filename>`.

Paths with directory components (e.g. `"subdir/loom.md"`, `"/abs/path.md"`, `"../prompts/loom.md"`) cannot be safely translated because the legacy system may have used arbitrary filesystem layouts that do not match the current `.weave/prompts/` convention. These are warned and skipped during migration. Users must manually place the prompt file in the correct `.weave/prompts/` directory and add the `prompt_file` reference after migration.

See [CLI — Prompt file translation](cli.md#prompt-file-translation) for the migration-specific rules.

### Bundle-safe builtin prompt resolution

Builtin agents are handled differently from user-authored agents. Instead of calling `resolvePromptPaths()` for the builtin layer, `loadConfig()` calls `inlineBuiltinPrompts()` which replaces `prompt_file` references with embedded inline `prompt` content from `BUILTIN_PROMPT_CONTENTS`.

**Why?** `resolvePromptPaths()` uses `import.meta.dir` to compute the builtin root directory. When `@weaveio/weave-config` is bundled into an adapter (e.g. `@weaveio/weave-adapter-opencode/dist/plugin.js`), `import.meta.dir` resolves to the adapter's dist directory rather than `packages/config/`. This caused all 8 builtin agents to fail with `DescriptorCompositionFailure` because the resolved path pointed to a non-existent `packages/adapters/opencode/prompts/` directory.

**Fix:** `builtins.ts` imports all 8 prompt files as text using Bun's `with { type: "text" }` import assertion. Bun embeds the file content as a string at build time. `inlineBuiltinPrompts()` then replaces `prompt_file` with the embedded `prompt` content, eliminating the runtime filesystem dependency for builtins entirely.

**Observable effect:** After `loadConfig()`, builtin agents have `prompt` (inline string) rather than `prompt_file` (filesystem path). User-authored agents that declare `prompt_file` still have their paths resolved to absolute paths by `resolvePromptPaths()` as before.

---

## Public API

```ts
import { loadConfig } from "@weaveio/weave-config";

const result = await loadConfig("/path/to/project");

result.match(
  (config) => {
    // config.agents["loom"].prompt is an inline string (builtins use prompt, not prompt_file)
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
} from "@weaveio/weave-config";
```

---

## Architectural Decision — Why a Separate `@weaveio/weave-config` Package

### Context

The original alpha used a flat loader inside the OpenCode plugin. As the harness-agnostic successor matured, config loading became separate from both engine lifecycle and adapter translation: builtins, three-layer merge, and prompt path resolution are reusable inputs to any adapter or CLI.

### Decision

`@weaveio/weave-config` is a separate workspace package that `@weaveio/weave-engine`, adapters, and future CLI tools can depend on. Config loading is not a harness concern and does not query harness UI/runtime state.

### Consequences

**Positive:**

- Config logic is independently testable without an engine harness.
- Future adapters (or CLI tools) can call `loadConfig()` without pulling in engine dependencies.
- The builtin DSL-first approach is clean — `@weaveio/weave-config` ships the DSL source and the `prompts/` files together in the same package.
- The package boundary reinforces the product vision: Weave normalizes intent; adapters materialize it for a harness.

**Negative:**

- Contributors must understand that config loading, engine lifecycle, and adapter translation are separate layers.

**Mitigation:** AGENTS.md and the product-vision docs list `@weaveio/weave-config` explicitly and point contributors to this ADR.
