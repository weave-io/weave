# Config Loading

## Safe merge inputs

`mergeConfigsResult` validates bounded copies of every input layer and the merged
result, including zero- and one-layer calls. It accepts at most 128 layers.
Invalid inputs return `ConfigValidationError` with a layer index (zero-based) or
`merged` and bounded validation details. CLI compose, prompt, and validate commands
display both this error and the existing workflow-extension errors.

Validation does not insert defaults into override layers. The normalized empty
`extend_before_plan.steps` default remains valid when a parsed config is checked
again. Scalar priority, override-first array unions, workflow step insertion,
and OpenCode variants are unchanged. String triggers use exact, override-first
union order. `fast true` survives an omitted higher-priority value. Categories
use descriptions and string triggers instead of patterns. The legacy `mergeConfigs` wrapper
still throws its first error for callers that require that contract.

`@weaveio/weave-config` owns the config-discovery, merge, and loading pipeline for Weave. It is the single entry point for reading agent configuration from disk and producing the final merged `WeaveConfig` consumed by the engine.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Model Resolution](model-resolution.md) · [Spec 17 — Workflow Extension DSL](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) · [AGENTS.md](../AGENTS.md) · [Legacy Architecture](legacy-architecture.md) · [`packages/config/src/loader.ts`](../packages/config/src/loader.ts) · [CLI — `weave prompt self-modify`](./cli.md#weave-prompt-self-modify)

---

## OpenCode 2 exact-byte attempts

The native OpenCode 2 adapter injects one `CatalogSourceCache` into config and
prompt loading for each refresh attempt. The cache reads each source at most
once, decodes UTF-8 strictly, hashes the exact bytes used by composition, and
records missing sources so later file creation changes the revision. Each
source and each complete attempt have byte and source-count limits.

The adapter publishes only a complete valid catalog. A malformed edit does not
partially replace native agents; the last valid candidate stays active. Setting
`projectConfig: false` masks only the current Location's project config path.
It does not disable global config or read files from another Location.
An existence-check failure is an I/O error, not proof that a source was
deleted. The adapter rejects that refresh and keeps the last valid candidate.

Plan display uses a separate `PlanTaskSnapshotReader` boundary. The config
package reads only `.weave/plans/<safe-name>.md`, rejects traversal and symbolic
links, limits file size and task count, and returns immutable display data. The
engine does not discover plan files and the OpenCode TUI does not read them
locally.

---

## Three-Layer Merge

Configuration is assembled from three layers in priority order (lowest → highest). A user who opts in to [published model recommendations](#published-model-recommendations) gets a fourth, between the builtins and the global layer.

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

**Immutability:** Inputs are never mutated. Each merge step produces a new object.

See [`packages/config/src/merge.ts`](../packages/config/src/merge.ts) for the implementation.

---

## Published Model Recommendations

[Spec 39](specs/39-spec-model-recommendations/39-spec-model-recommendations.md) adds an opt-in fourth layer, between the builtins and the global config, that carries only builtin agents' `models` lists from a list the maintainers sign and publish on tryweave.io. Spec 39's "The published file" is the normative format.

The format and its checks:

- [`model-recommendations.ts`](../packages/config/src/model-recommendations.ts) — the `ModelRecommendationsFileSchema` (list) and `ModelRecommendationsEnvelopeSchema` (`{ payload, sig }`), the limits (64 KiB, 1–32 agents and 1–8 entries per section, 90-day validity), the typed `ModelRecommendationsError` union, `selectRecommendationsSection(file, harness)` (a harness's own section, else `default`, and nothing for a caller with no harness ID), and `MODEL_RECOMMENDATIONS_CLIENT_VERSION`, the version a list's `min_config_version` is compared with.
- [`model-recommendations-verifier.ts`](../packages/config/src/model-recommendations-verifier.ts) — `ModelRecommendationsVerifier`, which checks size, envelope shape, the Ed25519 signature (WebCrypto, over the payload's exact UTF-8 bytes), the schema and freshness, in that order, with the keys and clock injected; and `signModelRecommendations`, used by `scripts/models/sign.ts` and by tests with throwaway keys.
- [`model-recommendations-keys.ts`](../packages/config/src/model-recommendations-keys.ts) — the public keys a list may be signed with. A key is rotated by shipping it here in a release before the site signs with it.
- `BUILTIN_MODELS_ISSUED` in [`builtins.ts`](../packages/config/src/builtins.ts) — when the builtin `models` lists were last set. A list issued earlier is rejected, so an old list never overrides newer builtins. `builtins.test.ts` pins the builtin lists to this value; bump both together.

[`weave models check`](cli.md#weave-models-check) uses the same schema and verifier, so the site and the client agree on what is valid.

### The recommendations layer

[`loadConfigDetailed`](../packages/config/src/loader.ts) adds the layer. In order:

1. It merges builtins, global and project as before, and reads the merged `settings.model_updates` ([`resolveModelUpdates`](../packages/config/src/model-recommendations-cache.ts)). An absent block or `mode off` stops here: the cache is not read and the result is exactly the three-layer config. An unset `channel` means `stable`; project overrides global as for any setting.
2. A caller that passes no `harness` also stops here. OpenCode V1 and Copilot CLI pass none, so they never get the layer.
3. Otherwise it reads `<global>/cache/model-recommendations/<channel>/applied.json` through the injected `FileReader` (`<global>` honours `WEAVE_GLOBAL_CONFIG_DIR`; [`modelRecommendationsCachePaths`](../packages/config/src/model-recommendations-cache.ts) is the one place the cache layout is spelled). Reading through the loader's reader is what lets OpenCode 2's catalog source cache record the file and notice a promotion, with no adapter plumbing.
4. The file is the served envelope. It is verified again on every load: signature, schema, channel, expiry, `issued` no more than 24 hours ahead, `issued` not before `BUILTIN_MODELS_ISSUED`, and `min_config_version` against `MODEL_RECOMMENDATIONS_CLIENT_VERSION`. Rollback is not checked here: the loader has no older list to compare with; the fetcher checks it before it promotes a list.
5. [`ModelRecommendationsLayerReader`](../packages/config/src/model-recommendations-layer.ts) takes the harness's section (else `default`) and keeps only agents the builtin config defines. Each becomes `agents.<name>.models` in a layer that sets nothing else. Other names are skipped and listed in the diagnostic.
6. The layers merge as `builtins → recommendations → global → project`. Arrays union-merge override-first, so every builtin agent's list becomes `[project…, global…, recommended…, builtin…]` with duplicates removed. A user's own entries still come first, the builtin entries stay as the fallback tail, and `disable agents` still wins because the layer never touches `disabled`.

A missing, unreadable, unsigned, tampered, invalid, expired, too-new or wrong-channel file is not a config error. The layer is skipped, the config loads as if `mode` were `off`, and a `ModelRecommendationsSkipped` diagnostic says why. This follows the [partial-config policy](adapters/opencode2-core.md#partial-and-broken-configs): an optional input must not cost the user their agents.

### `loadConfigDetailed` and diagnostics

```ts
import {
  describeModelRecommendationsSkipReason,
  loadConfigDetailed,
} from "@weaveio/weave-config";

const result = await loadConfigDetailed(projectRoot, reader, {
  harness: "opencode2", // "opencode2" | "claude-code" | "pi"; omit for no layer
});
result.map(({ config, diagnostics }) => {
  for (const d of diagnostics) {
    if (d.type === "ModelRecommendationsSkipped")
      log.warn({ reason: describeModelRecommendationsSkipReason(d.reason) }, "skipped");
  }
});
```

Options: `harness`, `now` (the clock for expiry and skew), `clientVersion` (defaults to `MODEL_RECOMMENDATIONS_CLIENT_VERSION`) and `publicKeys` (tests and local proofs). `loadConfig(projectRoot, reader)` keeps its signature: it is `loadConfigDetailed` with no harness, returning only `config`, so it never reads the cache.

`diagnostics` is a list of [`ConfigLoadDiagnostic`](../packages/config/src/diagnostics.ts):

| `type` | When | Fields |
| --- | --- | --- |
| `ModelRecommendationsApplied` | A verified list was merged | `channel`, `harness`, `section` (the harness or `default`), `path`, `issued`, `expires`, `evidence`, `agents` (builtins it set), `skippedAgents` (names this version does not define) |
| `ModelRecommendationsSkipped` | The user opted in but the layer was left out | `channel`, `harness`, `path`, `reason` |

`reason` is a `ModelRecommendationsSkipReason`: `Missing` (nothing applied yet), `Unreadable`, `LayerInvalid` (a Weave bug), or any `ModelRecommendationsError` from the verifier, such as `EnvelopeInvalid`, `SignatureInvalid`, `SchemaInvalid`, `ChannelMismatch`, `ClientTooOld`, `Expired`, `IssuedInFuture` or `OlderThanBuiltins`. `describeModelRecommendationsSkipReason` gives a one-line user-facing reason.

Callers: OpenCode 2's catalog build passes `harness: "opencode2"` and reports a skipped layer as the `model_updates_unavailable` status issue ([OpenCode 2 core](adapters/opencode2-core.md)); `weave compose --adapter claude-code` passes `harness: "claude-code"` and logs a skipped layer. Fetching and the `weave models` commands that write the cache are Spec 39 items 4 and 5.

---

## Workflow Extension

When a project or global config declares a workflow with the same name as a builtin (or lower-priority) workflow **and** sets `extends`, the merge engine applies step-aware merge instead of the generic deep-merge.

### DSL syntax

```weave
workflow plan-and-execute {
  extends "plan-and-execute"   # name of the base workflow
  version 1

  # Insert a new step before an existing one
  step spec {
    name "Write spec"
    type autonomous
    agent pattern
    prompt "Write a spec for: {{instance.goal}}"
    completion agent_signal
    insert_before "plan"
  }

  # Replace an existing step by same name
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

1. **Resolve base steps** — if `extends` equals the workflow's own name, the base steps come from the lower-priority layer (the "project extends builtin" pattern). Otherwise the `extends` chain is followed through the workflow map.
2. **Same-name replacement** — override steps whose `name` matches a base step replace the base step in place (preserving position).
3. **Anchored insertion** — remaining override steps with `insert_before` or `insert_after` are inserted at the resolved index relative to the post-replacement step list.
4. **Append** — remaining override steps with no anchor and no same-name match are appended to the end.

### Error types

| Error type                | When                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `UnknownExtendsTarget`    | `extends` names a workflow that does not exist in the merged workflow map              |
| `UnknownInsertionAnchor`  | `insert_before` / `insert_after` names a step that does not exist in the base steps   |
| `BothInsertBeforeAndAfter`| A step declares both `insert_before` and `insert_after` (mutually exclusive)          |
| `ExtendsCycle`            | The `extends` chain contains a cycle (A extends B, B extends A)                       |

These are wrapped in `MergeError` and returned from `mergeConfigsResult`. The `loadConfig` pipeline surfaces them as `ConfigLoadError` with `type: "MergeError"`.

### `mergeConfigsResult` vs `mergeConfigs`

`mergeConfigsResult` is the preferred API — it returns `Result<WeaveConfig, MergeError[]>` and never throws. `mergeConfigs` is a deprecated wrapper that throws the first `MergeError` for callers that haven't migrated yet.

```ts
import { mergeConfigsResult } from "@weaveio/weave-config";

const result = mergeConfigsResult(builtins, globalConfig, projectConfig);
result.match(
  (config) => startRunner(config),
  (errors) => {
    for (const e of errors) {
      if (e.type === "WorkflowExtensionError") {
        console.error(`Workflow merge error: ${e.error.type}`);
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

**DSL-first:** Builtins are declared as a `.weave` DSL string in [`packages/config/src/builtins.ts`](../packages/config/src/builtins.ts) — there is no separate code path. They flow through the same `parseConfig` pipeline as user-authored configs. This means:

- Any user can replicate, extend, or replace any builtin by writing equivalent DSL in their config file.
- Bugs in the builtin DSL surface immediately as test failures in `builtins.test.ts`.

Prompt files ship in [`packages/config/prompts/`](../packages/config/prompts/) and are **embedded at build time** using Bun's `with { type: "text" }` import assertion in `builtins.ts`. The embedded content is stored in `BUILTIN_PROMPT_CONTENTS` and inlined into the builtin config by `inlineBuiltinPrompts()` in `loader.ts` before merging.

**Bundle-safe prompt resolution:** Builtin agents use `prompt` (inline content) rather than `prompt_file` (filesystem path) after loading. This is intentional — it makes builtin prompt resolution work correctly when `@weaveio/weave-config` is bundled into an adapter (e.g. `@weaveio/weave-adapter-opencode/dist/plugin.js`). See [Prompt File Resolution](#prompt-file-resolution) for details.

---

## Config Discovery

`discoverAndParse()` in [`packages/config/src/discovery.ts`](../packages/config/src/discovery.ts) checks two locations:

| Scope   | Path                                | Behaviour                                        |
| ------- | ----------------------------------- | ------------------------------------------------ |
| Global  | `~/.weave/config.weave`             | Checked first; missing file is silently skipped  |
| Project | `<projectRoot>/.weave/config.weave` | Checked second; missing file is silently skipped |

**Missing files are non-errors.** Only actual I/O failures or parse failures produce errors.

**Error aggregation:** If both files have errors, all errors are collected and returned together as a `ConfigLoadError[]` — callers receive the complete picture.

### Redirecting the global scope — `WEAVE_GLOBAL_CONFIG_DIR`

`globalConfigDir()` resolves where the global layer lives. By default that is
`~/.weave`, but setting `WEAVE_GLOBAL_CONFIG_DIR` to a non-empty path redirects
it:

| `WEAVE_GLOBAL_CONFIG_DIR` | Global scope root |
| ------------------------- | ----------------- |
| unset, or whitespace only | `~/.weave`        |
| `/some/dir`               | `/some/dir`       |

Because a missing file is a non-error, pointing it at a directory with no
`config.weave` **disables the global layer**, leaving builtins plus project
config.

This exists for processes that must not inherit the invoking user's personal
configuration:

- **The test suite.** [`scripts/test-setup.ts`](../scripts/test-setup.ts) points
  it at [`scripts/fixtures/empty-global-config/`](../scripts/fixtures/empty-global-config/),
  so no test reads the developer's real `~/.weave/config.weave`. Bun reads only
  the `bunfig.toml` in the current working directory, so every package carries
  its own that preloads this file — otherwise tests run from a package
  directory silently skip it. `bun run verify:test-coverage` enforces that. Before this,
  every test that loaded the effective config depended on the machine it ran
  on — 23 of them failed outright on a developer box whose global config was
  merely out of date, while passing in CI, which has no global config.
- **CI jobs, containers and sandboxed harness runs**, where the home directory
  may be shared, surprising, or not the user's own.
- **Host applications** that start a harness for the user and keep a Weave
  config of their own, such as Weave Fleet starting OpenCode. The host sets the
  variable to a folder it owns when it launches the harness: that folder's
  `config.weave` becomes the global layer, its `prompts/` serves
  `prompt_file` and `prompt_append_file`, and the project's `.weave/` layer
  still merges on top.

A test that *needs* global-scope config points the variable at its own fixture
directory rather than writing to the developer's home.

### Error types

| Type                | When                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `FileReadError`     | File exists but could not be read from disk                               |
| `ParseError`        | File was read but the DSL could not be parsed or validated                |
| `BuiltinParseError` | The built-in DSL source string itself failed to parse (always a code bug) |

See [`packages/config/src/errors.ts`](../packages/config/src/errors.ts).

### Migration and canonical destinations

`weave init migrate` writes migrated config **only** to the canonical paths above — never to ad hoc locations. This is a hard constraint: the config loader only discovers `~/.weave/config.weave` and `<projectRoot>/.weave/config.weave`. A migrated file written anywhere else would be silently ignored at runtime.

The `--install-dir` flag accepted by ordinary `weave init` (for starter-config scaffolding) is **ignored** in migrate mode for this reason. See [CLI — `weave init migrate`](./cli.md#weave-init-migrate) for the full migration contract.

### Self-modification and canonical paths

`weave prompt self-modify` uses the same canonical paths to tell agents exactly where to write config and prompt files. The guide it prints is scope-aware:

- **global** → `~/.weave/config.weave` and `~/.weave/prompts/`
- **local** → `<projectRoot>/.weave/config.weave` and `<projectRoot>/.weave/prompts/`

Agents following the guide must write to these paths only. Any file written outside these locations will be silently ignored by `discoverAndParse()` at runtime.

See [CLI — `weave prompt self-modify`](./cli.md#weave-prompt-self-modify) for the full self-modification contract.

---

## Prompt File Resolution

`resolvePromptPaths()` in [`packages/config/src/resolve.ts`](../packages/config/src/resolve.ts) converts relative `prompt_file` values to absolute paths **before** merging.

Each scope has a `rootDir` (see [`packages/config/src/types.ts`](../packages/config/src/types.ts)):

- **builtin** → handled by `inlineBuiltinPrompts()` — see below
- **global** → `~/.weave/`
- **project** → `<projectRoot>/.weave/`

A `prompt_file: "loom.md"` in scope `{ rootDir: "/my/project/.weave" }` resolves to `/my/project/.weave/prompts/loom.md`.

Resolution happens before merging so that when two layers both define the same agent's `prompt_file`, the winning value is already an absolute path pointing to the correct scope's `prompts/` directory.

`mergeConfigsResult()` permits these resolved absolute paths, but it still
checks prompt-source exclusivity before it removes path fields for schema-only
validation. A layer that contains both `prompt` and `prompt_file`, or both
append fields, is invalid even when its file path is already absolute.

### Migration and prompt-file translation

Legacy Weave resolved a custom agent's `prompt_file` relative to the legacy config directory, while `resolvePromptPaths()` resolves it against the scope's `.weave/prompts/` directory. So `weave init migrate` does not copy the reference as-is: it reads the legacy file and writes it to `<scopeRoot>/.weave/prompts/<agent>.md`, then emits `prompt_file "<agent>.md"`.

Absolute paths, paths containing `..`, and unreadable files are warned and skipped. A custom agent left without any prompt source is skipped with a warning rather than emitted, because an agent without a prompt fails composition and adapters drop it. `weave validate` reports any such agent.

See [CLI — Prompt file translation](./cli.md#prompt-file-translation) for the migration-specific rules.

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
  loadConfigDetailed, // Full pipeline, with a harness and diagnostics
  getBuiltinConfig, // Builtins only
  discoverAndParse, // Discovery only
  globalConfigDir, // Resolved global scope root
  GLOBAL_CONFIG_DIR_ENV, // "WEAVE_GLOBAL_CONFIG_DIR"
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
