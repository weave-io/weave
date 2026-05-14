# OpenCode Spike — Architecture Mapping

How the working OpenCode spike maps to the [System Architecture](../system-architecture.md). Each layer shows the concrete files, functions, and data shapes involved.

**Related:** [System Architecture](../system-architecture.md) · [Adapter Boundary](../adapter-boundary.md) · [Config Loading](../config-loading.md)

---

## End-to-End Flow

This diagram traces a single request path: from `.weave` source text all the way to a running OpenCode agent.

```mermaid
flowchart TD
  subgraph Sources["① Config Sources"]
    direction TB
    Builtins["builtins.ts\n─────────────────\nBUILTIN_WEAVE_SOURCE\n8 agents as .weave DSL"]
    Global["~/.weave/config.weave\n─────────────────\nUser-level overrides"]
    Project[".weave/config.weave\n─────────────────\nProject-level overrides"]
  end

  subgraph Core["⓪ Core Parsing  —  @weave/core"]
    direction LR
    Tokenize["tokenize(source)\n→ Token[]"]
    Parse["parse(tokens)\n→ AstNode[]"]
    Validate["validate(ast)\n→ WeaveConfig"]
    Tokenize --> Parse --> Validate
  end

  subgraph LoadNorm["② Load + Normalize  —  @weave/config"]
    direction TB
    Loader["loader.ts: loadConfig()\n─────────────────\nOrchestrates full pipeline"]
    Resolve["resolve.ts: resolvePromptPaths()\n─────────────────\nprompt_file → absolute path\nper scope rootDir"]
    Merge["merge.ts: mergeConfigs()\n─────────────────\nbuiltins < global < project\nscalars override, arrays union"]
    Loader --> Resolve --> Merge
  end

  subgraph Engine["③ Engine Composition  —  @weave/engine"]
    direction TB
    Runner["runner.ts: WeaveRunner.run()\n─────────────────\n1. adapter.init()\n2. generateCategoryShuttles()\n3. for each agent: compose → spawn"]
    Descriptors["descriptors.ts\n─────────────────\ngenerateCategoryShuttles()\ncategory → shuttle-{name}"]
    Compose["compose.ts: composeAgentDescriptor()\n─────────────────\n1. Load prompt source\n2. Build delegation targets\n3. Append delegation section\n→ AgentDescriptor"]
    Runner --> Descriptors
    Runner --> Compose
  end

  subgraph Adapter["④ OpenCode Adapter  —  @weave/adapter-opencode"]
    direction TB
    Spawn["spawnSubagent(name, descriptor)\n─────────────────\nCollects in Map\n(deferred materialization)"]
    ToPlugin["toPlugin()\n─────────────────\nMaterializes all agents\n→ OpenCodePluginHooks"]
    Translate["toOpenCodeAgentConfig()\n─────────────────\nmode: all → primary\ntoolPolicy → boolean tools\nmodels[0] → model"]
    Spawn --> ToPlugin --> Translate
  end

  subgraph Harness["⑤ OpenCode Harness"]
    direction TB
    PluginFile[".opencode/plugins/weave.js\n─────────────────\nBundled entry point\nexport server()"]
    ConfigHook["OpenCode calls config hook\n─────────────────\ncfg.agent['loom-v2'] = ...\ncfg.agent['thread-v2'] = ..."]
    Running["Running Agents\n─────────────────\nloom-v2: orchestrator\nthread-v2: explorer"]
    PluginFile --> ConfigHook --> Running
  end

  Sources --> Core
  Core --> LoadNorm
  LoadNorm -->|"WeaveConfig\n(merged, paths resolved)"| Engine
  Engine -->|"AgentDescriptor\n(composedPrompt, models,\ntoolPolicy, delegationTargets)"| Adapter
  Adapter -->|"OpenCodePluginHooks"| Harness
```

---

## Data Shapes at Each Boundary

```mermaid
flowchart LR
  subgraph Shapes[" "]
    direction TB

    S1["**.weave source text**\nRaw DSL string"]
    S2["**Token[]**\nPositioned tokens\nwith line/col"]
    S3["**AstNode[]**\nTyped syntax tree\nAgentBlock, CategoryBlock, etc."]
    S4["**WeaveConfig**\nZod-validated config\nagents, categories, workflows,\ndisabled, settings"]
    S5["**AgentDescriptor**\nname, composedPrompt,\nmodels[], mode,\ntoolPolicy, delegationTargets[]"]
    S6["**OpenCodeAgentConfig**\nprompt, model, mode,\ntemperature, tools"]
    S7["**OpenCodePluginHooks**\nconfig(cfg) → mutates\ncfg.agent entries"]

    S1 -->|"tokenize()"| S2
    S2 -->|"parse()"| S3
    S3 -->|"validate()"| S4
    S4 -->|"composeAgentDescriptor()"| S5
    S5 -->|"toOpenCodeAgentConfig()"| S6
    S6 -->|"toPlugin()"| S7
  end
```

---

## Layer Detail: What Each Component Owns

### ⓪ Core Parsing (`@weave/core`)

The foundation. Every config source — builtins, global, project — passes through this pipeline.

```
parseConfig(source: string): Result<WeaveConfig, ConfigError[]>
```

| Stage | File | Input → Output |
|-------|------|----------------|
| Tokenize | `lexer.ts` | `string` → `Token[]` |
| Parse | `parser.ts` | `Token[]` → `AstNode[]` |
| Validate | `validate.ts` | `AstNode[]` → `WeaveConfig` (via Zod) |

Short-circuits on first failure. All errors carry line/column positions.

---

### ① Config Sources

Three layers, all parsed through the same core pipeline:

| Source | File | Scope |
|--------|------|-------|
| Built-in agents | `config/builtins.ts` | Lowest priority — defaults for 8 agents |
| Global config | `~/.weave/config.weave` | User-level — shared across projects |
| Project config | `.weave/config.weave` | Highest priority — project-specific |

Built-ins are declared as a `.weave` DSL string — same syntax users write. No separate code path.

---

### ② Load + Normalize (`@weave/config`)

Orchestrated by `loadConfig()`:

```
getBuiltinConfig()          → WeaveConfig (8 agents)
discoverAndParse()          → DiscoveredConfig[] (0-2 entries)
resolvePromptPaths(each)    → prompt_file → absolute path
mergeConfigs(all layers)    → single WeaveConfig
```

**Merge rules:**
- Scalars: last-defined wins
- Objects: recursive deep-merge
- Arrays: union-merge (override entries first, then base)

---

### ③ Engine Composition (`@weave/engine`)

`WeaveRunner.run()` orchestrates:

1. **Init** — `adapter.init()`
2. **Generate shuttles** — `generateCategoryShuttles(config)` → `shuttle-{name}` agents from categories
3. **Compose each agent** — `composeAgentDescriptor()` produces:

```typescript
interface AgentDescriptor {
  name: string
  composedPrompt: string        // prompt + delegation section + append
  models: string[]              // ordered preference
  mode: "primary" | "subagent" | "all"
  temperature?: number
  toolPolicy: ToolPolicy
  delegationTargets: DelegationTarget[]
}
```

4. **Materialize** — `adapter.spawnSubagent(name, descriptor)` for each

---

### ④ OpenCode Adapter

**Deferred materialization pattern:**

```
spawnSubagent()  →  collects in Map (no harness calls yet)
toPlugin()       →  materializes all at once as OpenCodePluginHooks
```

**Translation rules:**

| Weave | OpenCode |
|-------|----------|
| `mode: "all"` | `"primary"` (no `all` in OpenCode) |
| `toolPolicy.read: "allow"` | `tools.read = true` |
| `toolPolicy.read: "deny"` | `tools.read = false` |
| `toolPolicy.delegate: "allow"` | _(ignored — OpenCode has native delegation)_ |
| `models[0]` | `model` (single string) |

---

### ⑤ Harness Entry (Spike-Specific)

```
spike-opencode-plugin.ts
  → loads project config (not full loadConfig — spike shortcut)
  → filters to loom + thread, renames to loom-v2 + thread-v2
  → WeaveRunner(config, adapter).run()
  → adapter.toPlugin()

spike-opencode-plugin-wrapper.ts
  → exports server() for OpenCode plugin discovery

bun run spike:opencode
  → bundles to .opencode/plugins/weave.js
  → OpenCode auto-discovers on startup
  → calls server() → config hook → agents materialized
```

---

## Spike vs. Full Architecture

What the spike implements vs. what the architecture envisions:

| Architecture Component | Spike Status | Notes |
|----------------------|--------------|-------|
| Core DSL pipeline | ✅ Complete | Full lexer → parser → validator |
| Config discovery + merge | ✅ Complete | All three layers, full merge semantics |
| Prompt path resolution | ✅ Complete | Scope-aware absolute paths |
| Agent descriptor composition | ✅ Complete | Prompt + delegation + append |
| Category shuttle generation | ✅ Complete | Categories → shuttle-{name} agents |
| Model resolution | ⚠️ Partial | Pure helper exists, adapter integration pending |
| Skill resolution | ❌ Not started | Spec exists, no implementation |
| Workflow execution | ❌ Not started | Schema validates, no orchestration |
| Lifecycle policies | ❌ Not started | No abstract policy surface yet |
| OpenCode adapter | ⚠️ Spike | Agents work; hooks/skills deferred |
| Pi adapter | ⚠️ Spike | More complete than OpenCode; still spike-level |
| Claude Code adapter | ❌ Not started | Package exists but empty |
| Adapter ↔ Engine context flow | ⚠️ Partial | Adapter doesn't yet supply harness context back to engine |

The spike proves the **core data flow**: DSL → config → engine → adapter → harness. The remaining work is filling in the deferred composition features (skills, workflows, lifecycle) and maturing the bidirectional adapter ↔ engine context exchange.
