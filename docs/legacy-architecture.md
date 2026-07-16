# OpenCode-Weave: Legacy Architecture Overview

> **Status**: Analysis document — no source code was modified.
> **Source**: `~/projects/opencode-weave` (v0.8.0, `@opencode_weave/weave`)
> **Purpose**: Inform a rewrite into a harness-agnostic multi-agent orchestration framework.
>
> **Important**: This document describes the OpenCode-specific alpha. It is migration context, not current product vision. For the harness-agnostic successor, prefer [Product Vision](product-vision.md), [Adapter Boundary](adapter-boundary.md), and [Model Resolution](model-resolution.md) whenever this document implies that core Weave should own harness UI state, concrete model selection, skill discovery/loading, concrete hook registration, or runtime plugin behavior.

---

## Table of Contents

1. [Core Architecture](#1-core-architecture)
2. [Agent Orchestration Model](#2-agent-orchestration-model)
3. [Prompt Construction (Critical Focus)](#3-prompt-construction-critical-focus)
4. [Prompt Tracing Mode](#4-prompt-tracing-mode)
5. [Configuration Model](#5-configuration-model)
6. [Dependencies and Integrations](#6-dependencies-and-integrations)
7. [Forward-Looking Context (Refactor Guidance)](#7-forward-looking-context-refactor-guidance)
- [Appendix D: Migration Guide -- `review_models`](#appendix-d-migration-guide----review_models)

---

## 1. Core Architecture

### 1.1 System Overview

OpenCode-Weave is a **single-package OpenCode plugin** that provides multi-agent orchestration. It ships as one npm package (`@opencode_weave/weave`) that registers itself with OpenCode's plugin system and exposes 8 specialised AI agents, a hook-driven governance layer, a policy engine, and a plan-based execution pipeline.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          OpenCode (Host Process)                            │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Weave Plugin (single entry point)                  │  │
│  │                                                                       │  │
│  │  ┌───────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────┐  │  │
│  │  │   Config   │  │    Agent     │  │   Hook     │  │   Feature    │  │  │
│  │  │  Pipeline  │  │   System    │  │   System   │  │   Modules    │  │  │
│  │  │            │  │             │  │            │  │              │  │  │
│  │  │ loader     │  │ builtin-    │  │ create-    │  │ skill-loader │  │  │
│  │  │ merge      │  │ agents      │  │ hooks      │  │ work-state   │  │  │
│  │  │ schema     │  │ agent-      │  │ start-work │  │ workflow     │  │  │
│  │  │ handler    │  │ builder     │  │ work-cont  │  │ analytics    │  │  │
│  │  │ continua-  │  │ model-res   │  │ compaction │  │ evals        │  │  │
│  │  │   tion     │  │ prompt-     │  │ context-   │  │ commands     │  │  │
│  │  │            │  │ composers   │  │   window   │  │              │  │  │
│  │  └───────────┘  └──────────────┘  └────────────┘  └──────────────┘  │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │              Runtime / OpenCode Adapter Layer                   │  │  │
│  │  │                                                                 │  │  │
│  │  │  plugin-adapter.ts      →  Lifecycle handler dispatch           │  │  │
│  │  │  apply-effects.ts       →  Effect → OpenCode SDK mutation       │  │  │
│  │  │  event-router.ts        →  OpenCode event → RuntimeEffect[]     │  │  │
│  │  │  protocol.ts            →  XML envelope marshalling             │  │  │
│  │  │  command-envelope.ts    →  Builtin command parsing              │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │                Application / Domain Layer                       │  │  │
│  │  │  policy-engine.ts       →  Chat/Tool/Session policy pipeline    │  │  │
│  │  │  execution-coordinator  →  Lease + ownership tracking           │  │  │
│  │  │  session-runtime        →  Lifecycle policy surface factory     │  │  │
│  │  │  plan-service            →  Plan CRUD + progress tracking       │  │  │
│  │  │  workflow-service        →  Multi-step workflow orchestration    │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Module Boundaries

| Layer                | Directory               | Responsibility                                            |
| -------------------- | ----------------------- | --------------------------------------------------------- |
| **Entry**            | `src/index.ts`          | Plugin bootstrap: config load, tool/manager/hook creation |
| **Plugin Interface** | `src/plugin/`           | Maps OpenCode's 8 lifecycle hooks to internal adapter     |
| **Runtime/Adapter**  | `src/runtime/opencode/` | OpenCode-specific protocol, effects, event routing        |
| **Application**      | `src/application/`      | Policy engine, orchestration, command routing             |
| **Domain**           | `src/domain/`           | Plan service, workflow service, execution leases          |
| **Agents**           | `src/agents/`           | Agent definitions, prompt composers, model resolution     |
| **Config**           | `src/config/`           | JSONC loading, merge, Zod validation, continuation        |
| **Hooks**            | `src/hooks/`            | Lifecycle callbacks (start-work, continuation, guards)    |
| **Features**         | `src/features/`         | Skills, work-state, workflows, analytics, evals, commands |
| **Infrastructure**   | `src/infrastructure/`   | Filesystem repositories, OpenCode session client          |
| **Shared**           | `src/shared/`           | Logging, path helpers, display names, version             |
| **Managers**         | `src/managers/`         | ConfigHandler, BackgroundManager, SkillMcpManager         |

### 1.3 Initialization Flow (Observed)

The plugin entry point (`src/index.ts`) orchestrates initialization in strict order:

```
1. setClient(ctx.client)                    // Wire SDK logger to OpenCode
2. loadWeaveConfig(ctx.directory)           // Load + merge user/project JSONC
3. resolveContinuationConfig()              // Resolve idle/recovery defaults
4. getOrCreateFingerprint()                 // Optional project fingerprint
5. createTools()                            // Discover + resolve skills
6. createManagers()                         // Build agents, config handler
   ├── buildCustomAgentMetadata()           // Prepare Loom delegation table
   ├── createBuiltinAgents()               // 8 agents with prompt composition
   │   ├── resolveAgentModel() per agent
   │   ├── createLoomAgentWithOptions()     // Loom-specific prompt composer
   │   ├── createTapestryAgentWithOptions() // Tapestry-specific prompt composer
   │   └── buildAgent() for remaining 6
   ├── Apply display name overrides
   └── buildCustomAgent() for custom agents
7. createHooks()                            // Conditionally enable hooks
8. createAnalytics()                        // Optional analytics tracking
9. createPluginInterface()                  // Wire to OpenCode lifecycle
   └── createPluginAdapter()               // Central runtime dispatcher
```

### 1.4 Interaction Patterns

**Effect-Driven Architecture**: The runtime converts all incoming OpenCode lifecycle events into `RuntimeEffect[]` arrays. Effects are pure data objects (no side effects in creation) that are applied atomically by `applyRuntimeEffects()`. This separation makes the system testable.

```
OpenCode Event → Plugin Interface Handler → Policy Engine → RuntimeEffect[]
                                                                    │
                                                    applyRuntimeEffects()
                                                         │
                         ┌───────────────────────────────┼──────────────┐
                         │                               │              │
                   switchAgent              appendPromptText     injectPromptAsync
                   restoreAgent             appendCommandOutput  pauseExecution
                                                                 trackAnalytics
```

**7 Effect Types** (observed in `src/runtime/opencode/effects.ts`):

| Effect                | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `switchAgent`         | Changes `output.message.agent` to a display name   |
| `restoreAgent`        | Async SDK call to restore foreground agent         |
| `appendPromptText`    | Appends text to the first text part of the message |
| `injectPromptAsync`   | Async SDK call: `client.session.promptAsync()`     |
| `pauseExecution`      | Pauses active plan or workflow                     |
| `trackAnalytics`      | Records session/token/cost metrics                 |
| `appendCommandOutput` | Pushes text part for command results               |

---

## 2. Agent Orchestration Model

### 2.1 Agent Definitions

Each of the 8 agents is defined in `src/agents/{name}/`:

| Agent        | Mode     | Role                       | Temperature | Tool Restrictions                 |
| ------------ | -------- | -------------------------- | ----------- | --------------------------------- |
| **Loom**     | primary  | Main orchestrator / router | 0.1         | Full                              |
| **Tapestry** | primary  | Plan execution coordinator | 0.1         | Full + `call_weave_agent`, `task` |
| **Shuttle**  | all      | Domain-specific worker     | 0.2         | Full, no `call_weave_agent`       |
| **Pattern**  | subagent | Strategic planner          | 0.3         | Guarded to `.weave/*.md`          |
| **Thread**   | subagent | Codebase explorer          | 0.0         | Read-only (no write/edit/task)    |
| **Spindle**  | subagent | External researcher        | 0.1         | Read-only                         |
| **Weft**     | subagent | Reviewer/auditor           | 0.1         | Read-only                         |
| **Warp**     | subagent | Security auditor           | 0.1         | Read-only                         |

**Agent modes** determine model resolution behavior:

- `primary`: Respects the user's UI-selected model
- `subagent`: Uses its own fallback chain, ignores UI selection
- `all`: Available in both contexts (only Shuttle)

### 2.2 Agent Lifecycle

```
                    ┌─────────────────────────────────────────────┐
                    │             createBuiltinAgents()            │
                    │                                             │
                    │  for each of 8 agents:                      │
                    │    1. resolveAgentModel()                   │
                    │    2. factory(model) → AgentConfig          │
                    │    3. Apply overrides, skills, stripping    │
                    └──────────────────┬──────────────────────────┘
                                       │
                        Record<string, AgentConfig>
                                       │
                    ┌──────────────────▼──────────────────────────┐
                    │           ConfigHandler.handle()             │
                    │                                             │
                    │  Phase 2: remap keys to display names       │
                    │  e.g. "loom" → "Loom (Main Orchestrator)"   │
                    └──────────────────┬──────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────┐
                    │     config.agent = { ...existingAgents,     │
                    │                      ...weaveAgents }       │
                    │          (passed to OpenCode host)          │
                    └─────────────────────────────────────────────┘
```

**At runtime**, agents are immutable `AgentConfig` objects. OpenCode handles the actual model invocation. Weave controls:

- Which agent handles a given turn (`switchAgent` effect)
- What prompt text the agent sees (`appendPromptText`, `injectPromptAsync`)
- Tool permissions (`tools: { write: false, ... }` on the config)

### 2.3 Delegation Mechanisms

**Loom → Subagents**: Loom uses OpenCode's `Task` tool to delegate to any agent by name. Its system prompt contains routing guidance (Delegation Table, Category Routing sections).

**Tapestry → Shuttle**: Tapestry exclusively delegates to Shuttle (or `shuttle-{category}` variants) via the `Task` tool. Its prompt contains a structured delegation template.

**`/start-work` → Tapestry**: The `/start-work` command triggers the `start-work-hook` which produces a `switchAgent: "tapestry"` effect plus context injection with plan state.

**Continuation Loop**: On `session.idle` events, the `workContinuation` hook checks for incomplete plans and injects a continuation prompt + `switchAgent` effect to resume Tapestry.

**Compaction Recovery**: On `session.compacted` events, `compaction-recovery.ts` reconstructs execution state and re-injects plan or workflow context.

### 2.4 Routing Decisions

Routing is determined by:

1. **Prompt-driven routing (Loom)**: Loom's system prompt contains explicit routing rules. The LLM decides which agent to delegate to based on the Delegation Table, Key Triggers, and Category Routing sections. This is **fully prompt-driven** — no code-level routing logic.

2. **Command-driven routing**: `/start-work` always routes to Tapestry. `/run-workflow` routes to the workflow engine. These are detected by `parseBuiltinCommandEnvelope()`.

3. **Category-driven routing (Tapestry)**: When `categories` are configured, Tapestry's prompt includes a `<CategoryRouting>` section instructing it to match file patterns against category definitions and delegate to `shuttle-{category}`.

4. **Continuation routing**: The idle/compaction hooks reconstruct which agent was active and restore routing to that agent.

---

## 3. Prompt Construction (Critical Focus)

### 3.1 Architecture of Prompt Construction

Prompt construction in Weave follows a **section-based composition pattern**. Each agent's prompt is built from discrete, independently testable section-builder functions that are assembled into a final string.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     PROMPT CONSTRUCTION PIPELINE                         │
│                                                                          │
│  ┌─────────────┐   ┌────────────────┐   ┌──────────────────────────┐   │
│  │   default.ts │   │ prompt-         │   │  dynamic-prompt-         │   │
│  │              │   │ composer.ts     │   │  builder.ts              │   │
│  │  Static      │   │                │   │                          │   │
│  │  fallback    │   │  Section        │   │  Shared dynamic          │   │
│  │  config      │◄──│  builders       │◄──│  sections                │   │
│  │  (default    │   │  (agent-        │   │  (delegation table,      │   │
│  │   prompt)    │   │   specific)     │   │   project context,       │   │
│  │              │   │                │   │   tool selection)         │   │
│  └─────────────┘   └───────┬────────┘   └──────────────────────────┘   │
│                             │                                            │
│  ┌──────────────────────────▼────────────────────────────────────────┐  │
│  │                    index.ts (per agent)                           │  │
│  │                                                                    │  │
│  │  createXxxAgentWithOptions(model, disabledAgents, ...)            │  │
│  │    → calls composeLoomPrompt() / composeTapestryPrompt()          │  │
│  │    → merges with DEFAULTS (temperature, description, tools)       │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                               │                                          │
│  ┌───────────────────────────▼───────────────────────────────────────┐  │
│  │                  builtin-agents.ts → createBuiltinAgents()        │  │
│  │                                                                    │  │
│  │  Post-composition steps:                                           │  │
│  │  1. Apply config overrides (prompt_append, skills, temperature)    │  │
│  │  2. Register category shuttle variants                             │  │
│  │  3. Strip disabled agent references                                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Loom Prompt Construction

**Location**: `src/agents/loom/prompt-composer.ts`

**Entry point**: `composeLoomPrompt(options: LoomPromptOptions)`

**Inputs**:

- `disabledAgents?: Set<string>` — agents to exclude from routing sections
- `fingerprint?: ProjectFingerprint` — detected project stack/language/platform
- `customAgents?: AvailableAgent[]` — user-defined agents for delegation table
- `categories?: CategoriesConfig` — category-based shuttle routing config

**Section assembly** (in order):

| #   | Section Builder                                             | XML Tag                 | Purpose                                   | Dynamic?                                                    |
| --- | ----------------------------------------------------------- | ----------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| 1   | `buildRoleSection()`                                        | `<Role>`                | Identity: "Loom — coordinator and router" | Static                                                      |
| 2   | `buildProjectContextSection(fingerprint)`                   | `<ProjectContext>`      | Detected stack, language, platform        | Conditional (only if fingerprint exists)                    |
| 3   | `buildDisciplineSection()`                                  | `<Discipline>`          | Work tracking rules, todowrite protocol   | Static                                                      |
| 4   | `buildSidebarTodosSection()`                                | `<SidebarTodos>`        | Todo sidebar formatting rules             | Static                                                      |
| 5   | `buildDelegationSection(disabled)`                          | `<Delegation>`          | Per-agent delegation guidance             | **Dynamic**: lines conditionally omitted per disabled agent |
| 6   | `buildDelegationNarrationSection(disabled)`                 | `<DelegationNarration>` | Narration rules for delegations           | Semi-dynamic: slow-agent list varies                        |
| 7   | `buildCategoryRoutingSection(categories, disabled)`         | `<CategoryRouting>`     | File-pattern-based shuttle routing        | **Dynamic**: only present if categories configured          |
| 8   | `buildCustomAgentDelegationSection(customAgents, disabled)` | `<CustomDelegation>`    | Custom agent delegation table             | **Dynamic**: only if custom agents registered               |
| 9   | `buildPlanWorkflowSection(disabled)`                        | `<PlanWorkflow>`        | Plan → Review → Execute → Resume flow     | Dynamic: steps vary by available agents                     |
| 10  | `buildReviewWorkflowSection(disabled)`                      | `<ReviewWorkflow>`      | Ad-hoc review guidance                    | Dynamic: only if Weft/Warp enabled                          |
| 11  | `buildStyleSection()`                                       | `<Style>`               | Output formatting directives              | Static                                                      |

**Composition logic**:

```typescript
const sections = [
  buildRoleSection(),
  buildProjectContextSection(fingerprint),
  buildDisciplineSection(),
  buildSidebarTodosSection(),
  buildDelegationSection(disabled),
  buildDelegationNarrationSection(disabled),
  buildCategoryRoutingSection(categories, disabled),
  buildCustomAgentDelegationSection(customAgents, disabled),
  buildPlanWorkflowSection(disabled),
  buildReviewWorkflowSection(disabled),
  buildStyleSection(),
].filter((s) => s.length > 0); // Empty sections are dropped

return sections.join("\n\n");
```

**Key observation**: Section builders return empty strings when their feature is entirely disabled, so the final prompt naturally adapts to the enabled feature set.

### 3.3 Tapestry Prompt Construction

**Location**: `src/agents/tapestry/prompt-composer.ts`

**Entry point**: `composeTapestryPrompt(options: TapestryPromptOptions)`

**Inputs**:

- `disabledAgents?: Set<string>` — affects post-execution review sections
- `continuation?: ResolvedContinuationConfig` — enables continuation hints
- `categories?: CategoriesConfig` — adds category routing section

**Section assembly** (in order):

| #   | Section Builder                                      | XML Tag                 | Purpose                                          | Dynamic?                                                   |
| --- | ---------------------------------------------------- | ----------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 1   | `buildTapestryRoleSection()`                         | `<Role>`                | Identity: "Tapestry — coordination orchestrator" | Static                                                     |
| 2   | `buildTapestryInvariantSection(disabled)`            | `<Invariant>`           | Non-terminal execution contract                  | Semi-dynamic: forbidden terms list varies                  |
| 3   | `buildTapestryDisciplineSection()`                   | `<Discipline>`          | Todo obsession rules                             | Static                                                     |
| 4   | `buildTapestrySidebarTodosSection()`                 | `<SidebarTodos>`        | Detailed sidebar protocol                        | Static                                                     |
| 5   | `buildTapestryDelegationSection(categoryNames)`      | `<Delegation>`          | Task → Shuttle delegation template               | **Dynamic**: category examples in `subagent_type` guidance |
| 6   | `buildTapestryParallelismSection()`                  | `<Parallelism>`         | Dependency analysis, parallel batching           | Static                                                     |
| 7   | `buildTapestryCategoryRoutingSection(categories)`    | `<CategoryRouting>`     | File-pattern routing priority rules              | **Dynamic**: only if categories configured                 |
| 8   | `buildTapestryPlanExecutionSection(disabled)`        | `<PlanExecution>`       | Step-by-step plan execution protocol             | Semi-dynamic: Weft mention conditional                     |
| 9   | `buildTapestryContinuationHintSection(continuation)` | `<Continuation>`        | Recovery/idle resume hint                        | **Conditional**: only if continuation enabled              |
| 10  | `buildTapestryVerificationSection()`                 | `<Verification>`        | Post-task verification protocol + learnings      | Static                                                     |
| 11  | `buildTapestryErrorHandlingSection()`                | `<ErrorHandling>`       | Retry and failure escalation rules               | Static                                                     |
| 12  | `buildTapestryPostExecutionReviewSection(disabled)`  | `<PostExecutionReview>` | Terminal review workflow with Weft/Warp          | **Dynamic**: review delegation varies by availability      |
| 13  | `buildTapestryExecutionSection()`                    | `<Execution>`           | Execution behavior rules                         | Static                                                     |
| 14  | `buildTapestryStyleSection()`                        | `<Style>`               | Terse output directive                           | Static                                                     |

### 3.4 Subagent Prompts

The remaining 6 agents use **static prompts** defined directly in their `default.ts` files:

| Agent   | Prompt Location                 | Prompt Style                                        |
| ------- | ------------------------------- | --------------------------------------------------- |
| Shuttle | `src/agents/shuttle/default.ts` | Inline string with XML sections                     |
| Pattern | `src/agents/pattern/default.ts` | Inline string with XML sections + markdown template |
| Thread  | `src/agents/thread/default.ts`  | Inline string with XML sections                     |
| Spindle | `src/agents/spindle/default.ts` | Inline string with XML sections                     |
| Weft    | `src/agents/weft/default.ts`    | Inline string with XML sections                     |
| Warp    | `src/agents/warp/default.ts`    | Inline string with XML sections (longest: ~5KB)     |

These prompts are **not composed dynamically**. They are plain string literals baked into the agent config objects. The only post-processing is `stripDisabledAgentReferences()` which removes lines mentioning disabled agents.

### 3.5 Dynamic Prompt Builder (Shared Components)

**Location**: `src/agents/dynamic-prompt-builder.ts`

Provides shared section builders used by Loom's prompt:

| Function                                         | Used by                                        | Purpose                                    |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------ |
| `buildProjectContextSection(fingerprint)`        | Loom                                           | Injects detected language, stack, platform |
| `buildDelegationTable(agents)`                   | Loom (custom agents)                           | Generates domain → agent mapping table     |
| `buildToolSelectionTable(agents, tools, skills)` | _(unused in main prompt, available for evals)_ | Cost-ordered agent/tool table              |
| `buildKeyTriggersSection(agents, skills)`        | _(unused in main prompt, available for evals)_ | Quick-check keyword triggers               |
| `buildThreadSection(agents)`                     | _(available)_                                  | Thread use-when/avoid-when guidance        |
| `buildSpindleSection(agents)`                    | _(available)_                                  | Spindle trigger phrases                    |
| `buildWeftSection(agents)`                       | _(available)_                                  | Weft use-when/skip-when                    |
| `buildWarpSection(agents)`                       | _(available)_                                  | Warp use-when/skip-when                    |

### 3.6 Post-Composition Prompt Modifications

After the prompt composer produces the base prompt, several transformations may apply:

1. **Skill injection** (`buildAgent()` / `createBuiltinAgents()`):

   ```
   skills content + "\n\n" + base prompt
   ```

   Skills are prepended, not appended.

2. **`prompt_append`** (config override):

   ```
   base prompt + "\n\n" + prompt_append
   ```

3. **`stripDisabledAgentReferences()`**:
   Removes entire lines containing disabled agent name variants (word-boundary matched).

4. **Runtime injection** (during execution, not at build time):
   - `/start-work` context injection via `appendPromptText` effect
   - Continuation prompts via `injectPromptAsync` effect
   - Compaction recovery prompts via `injectPromptAsync` effect

### 3.7 Prompt Differences: Loom vs Tapestry

| Aspect                  | Loom                                          | Tapestry                                        |
| ----------------------- | --------------------------------------------- | ----------------------------------------------- |
| **Role**                | Router + coordinator                          | Execution engine                                |
| **Delegation scope**    | All 7 other agents                            | Only Shuttle variants                           |
| **Category awareness**  | Lists available categories, delegates broadly | Applies file-pattern routing priority algorithm |
| **Custom agents**       | Has full custom agent delegation table        | No custom agent awareness                       |
| **Project fingerprint** | Receives `<ProjectContext>` section           | Does not receive fingerprint                    |
| **Plan workflow**       | Tells user to run `/start-work`               | Contains full plan execution protocol           |
| **Verification**        | Defers to Weft/Warp                           | Inline verification after every task            |
| **Parallelism**         | Not addressed                                 | Detailed batch parallelism rules                |
| **Invariant**           | None                                          | Strict non-terminal execution contract          |
| **Continuation**        | Not continuation-aware                        | Has `<Continuation>` hint section               |
| **Error handling**      | Not addressed                                 | Full retry/escalation protocol                  |
| **Learnings**           | Not addressed                                 | `.weave/learnings/` tracking                    |

---

## 4. Prompt Tracing Mode

### 4.1 Trace: User Requests a Complex Feature, Then Runs `/start-work`

This trace follows a realistic two-phase flow:

1. User asks Loom to plan an OAuth2 feature
2. User runs `/start-work` to execute the plan

#### Phase 1: User Message → Loom

**Step 1: Plugin initialization (happens once at startup)**

```
Module: src/index.ts → WeavePlugin()
Input: OpenCode PluginInput (ctx.directory, ctx.client, ctx.serverUrl)
```

Triggers the full initialization sequence. For Loom specifically:

**Step 2: Config loading**

```
Module: src/config/loader.ts → loadWeaveConfig()
  → src/infrastructure/fs/config-fs-loader.ts → createConfigFsLoader()
Input: directory = "/workspace/my-project"
Transformation:
  1. Detect ~/.config/opencode/weave-opencode.jsonc (user config)
  2. Detect .opencode/weave-opencode.jsonc (project config)
  3. Parse both as JSONC
  4. mergeConfigs(user, project) — deep merge objects, union arrays
  5. Validate with WeaveConfigSchema (Zod)
Output: WeaveConfig {
  agents: { loom: { temperature: 0.2 } },  // example override
  categories: { frontend: { patterns: ["src/components/**"], model: "gpt-5" } },
  disabled_agents: [],
  disabled_hooks: [],
  continuation: { idle: { enabled: true, work: true } }
}
```

**Step 3: Skill resolution**

```
Module: src/create-tools.ts → createTools()
  → src/features/skill-loader/loader.ts → loadSkills()
Input: serverUrl, directory, disabledSkills
Transformation:
  1. Fetch skills from OpenCode HTTP API
  2. Scan .opencode/skills/ and ~/.config/opencode/skills/
  3. Merge (API > project > user), filter disabled
Output: { skills: [...], resolveSkillsFn: (names, disabled) => string }
```

**Step 4: Loom prompt composition**

```
Module: src/create-managers.ts → createManagers()
  → src/agents/builtin-agents.ts → createBuiltinAgents()
  → src/agents/loom/index.ts → createLoomAgentWithOptions()
  → src/agents/loom/prompt-composer.ts → composeLoomPrompt()

Input: {
  disabledAgents: Set(0),
  fingerprint: { primaryLanguage: "TypeScript", packageManager: "bun",
                 stack: [{ name: "React", confidence: "high" }], os: "darwin" },
  customAgents: [],
  categories: { frontend: { patterns: ["src/components/**"], model: "gpt-5" } }
}

Transformation (section-by-section):
```

**Section 1: Role** (static)

```xml
<Role>
Loom — coordinator and router for Weave.
You are the user's primary interface. You understand intent, make routing decisions...
</Role>
```

**Section 2: ProjectContext** (from fingerprint)

```xml
<ProjectContext>
This is a TypeScript project using bun.
Detected stack: React.
Platform: darwin (arm64).
</ProjectContext>
```

**Section 3: Discipline** (static)

```xml
<Discipline>
WORK TRACKING:
- Multi-step work → todowrite FIRST with atomic breakdown
...
</Discipline>
```

**Section 4: SidebarTodos** (static)

```xml
<SidebarTodos>
The user sees a Todo sidebar (~35 char width)...
</SidebarTodos>
```

**Section 5: Delegation** (dynamic — all agents enabled)

```xml
<Delegation>
- Use thread for fast codebase exploration (read-only, cheap)
- Use spindle for external docs and research (read-only)
- Use pattern for planning, scoping, and work breakdown...
- Use /start-work to hand off to Tapestry for todo-list driven execution...
- Use shuttle for category-specific specialist work...
- Use Weft for reviewing completed work or validating plans before execution
  - MUST use Warp for security audits when changes touch auth, crypto...
- Delegate aggressively to keep your context lean
</Delegation>
```

**Section 6: DelegationNarration** (semi-dynamic)

```xml
<DelegationNarration>
When delegating:
1. Tell the user which agent you're delegating to by name and why
2. Update the sidebar todo BEFORE the Task tool call
3. Summarize what the agent found when it returns
Pattern, Spindle, Weft/Warp can be slow — tell the user when you're waiting.
</DelegationNarration>
```

**Section 7: CategoryRouting** (dynamic — categories configured)

```xml
<CategoryRouting>
Prefer category-specific shuttle agents when file patterns match the task:

- `shuttle-frontend` (patterns: src/components/**)

Use `shuttle-{category}` instead of generic `shuttle` when the task matches...
</CategoryRouting>
```

**Section 8: CustomDelegation** (empty — no custom agents → omitted)

**Section 9: PlanWorkflow** (dynamic — all agents enabled)

```xml
<PlanWorkflow>
Plans are executed by Tapestry, not Loom...

1. PLAN: Delegate to Pattern → produces a plan at `.weave/plans/{name}.md`
2. REVIEW: Delegate to Weft, Warp for security-relevant plans to validate the plan
3. EXECUTE: Tell the user to run `/start-work` — Tapestry handles execution
4. RESUME: `/start-work` also resumes interrupted work
...
</PlanWorkflow>
```

**Section 10: ReviewWorkflow** (dynamic)

```xml
<ReviewWorkflow>
Ad-hoc review (outside of plan execution):
- Delegate to Weft after non-trivial changes (3+ files, or when quality matters)
- Warp is mandatory when changes touch auth, crypto, tokens, secrets...
</ReviewWorkflow>
```

**Section 11: Style** (static)

```xml
<Style>
- Start immediately. No preamble acknowledgments...
- Dense > verbose.
- Match user's communication style.
</Style>
```

**Step 5: Post-composition overrides**

```
Module: src/agents/builtin-agents.ts → createBuiltinAgents()
Input: composed prompt + config override { temperature: 0.2 }
Transformation:
  - Override applied: temperature 0.1 → 0.2
  - No prompt_append in this example
  - No skills to inject
Output: AgentConfig {
  temperature: 0.2,
  description: "Loom (Main Orchestrator)",
  prompt: "<Role>\nLoom — coordinator...\n\n<ProjectContext>...\n\n...<Style>...",
  model: "github-copilot/claude-opus-4.6",
  mode: "primary"
}
```

**Step 6: Config handler remaps key**

```
Module: src/managers/config-handler.ts → ConfigHandler.applyAgentConfig()
Input: agents["loom"] = { ... AgentConfig }
Transformation: Key remapped from "loom" → "Loom (Main Orchestrator)"
Output: config.agent["Loom (Main Orchestrator)"] = AgentConfig
```

**Step 7: User sends "Build an OAuth2 login system"**

```
Module: src/runtime/opencode/plugin-adapter.ts → handleChatMessage()
Input: { sessionID: "sess_abc", parts: [{ type: "text", text: "Build an OAuth2 login system" }] }
Transformation:
  1. Replace $SESSION_ID / $TIMESTAMP placeholders in text parts
  2. Parse envelope → null (not a command)
  3. Run lifecyclePolicy.onChatMessage() → CommandChatPolicy, AutoPauseChatPolicy
  4. No effects generated (not a /start-work, not active plan)
  5. Store in lastUserMessageText map
Output: No mutation to the message — OpenCode sends it to Loom as-is
```

**At this point, OpenCode sends the user's message to Loom with the composed system prompt. Loom's LLM sees:**

```
[System Prompt: ~2500 tokens of composed Loom prompt]
[User: "Build an OAuth2 login system"]
```

Loom's prompt-driven routing makes the LLM decide to delegate to Pattern.

#### Phase 2: `/start-work` Command

**Step 8: User types `/start-work`**

```
Module: OpenCode → command.execute.before hook
  → src/runtime/opencode/plugin-adapter.ts → handleCommandExecuteBefore()
Input: { command: "start-work", sessionID: "sess_abc", arguments: "" }
Transformation:
  1. isBuiltinChatCommand("start-work") → true
  2. trustedMessageState.registerBuiltinCommand("sess_abc", "start-work", "")
  3. routeCommandExecuteBefore() → no output effects (metrics/health only)
Output: No effects for start-work specifically (handled in chat.message)
```

**Step 9: OpenCode renders the command template**

```
Module: src/features/builtin-commands/commands.ts → BUILTIN_COMMANDS["start-work"]
Input: template with $ARGUMENTS, $SESSION_ID, $TIMESTAMP placeholders
Output (rendered by OpenCode, not Weave):
  <command-instruction>
  [start-work template instructions]
  </command-instruction>
  <weave-command-envelope>
  <protocol-version>1</protocol-version>
  <command-name>start-work</command-name>
  <arguments></arguments>
  <session-id>sess_abc</session-id>
  <timestamp>2026-05-05T12:00:00Z</timestamp>
  </weave-command-envelope>
  <session-context>Session ID: sess_abc  Timestamp: 2026-05-05T12:00:00Z</session-context>
  <user-request></user-request>
```

**Step 10: chat.message handler processes the rendered template**

```
Module: src/runtime/opencode/plugin-adapter.ts → handleChatMessage()
Input: { sessionID: "sess_abc", parts: [{ type: "text", text: "[rendered template]" }] }
Transformation:
  1. trustedMessageState.consumeTrustedEnvelope() → ParsedCommandEnvelope {
       kind: "builtin-command", command: "start-work", arguments: "", sessionId: "sess_abc"
     }
  2. lifecyclePolicy.onChatMessage() invoked
```

**Step 11: CommandChatPolicy routes to start-work**

```
Module: src/application/policy/chat-policy.ts → createCommandChatPolicy()
  → src/application/commands/start-work-command.ts → executeStartWorkCommand()
Input: parsedEnvelope with command: "start-work"
Transformation:
  1. Detects parsedEnvelope.kind === "builtin-command" && command === "start-work"
  2. Calls hooks.startWork(promptText, sessionId)
```

**Step 12: Start-work hook resolves the plan**

```
Module: src/hooks/start-work-hook.ts → handleStartWork()
Input: { promptText: "[rendered template]", sessionId: "sess_abc", directory: "/workspace" }
Transformation:
  1. parseBuiltinCommandEnvelope() → { command: "start-work", arguments: "" }
  2. No explicit plan name → check existing state
  3. No existing state → discover plans in .weave/plans/
  4. Found 1 incomplete plan: .weave/plans/oauth2-login.md (0/5 tasks)
  5. validatePlan() → valid
  6. PlanService.createExecution() → creates state.json with start_sha
  7. buildFreshContext() → generates context injection
Output: StartWorkResult {
  switchAgent: "tapestry",
  contextInjection: "## Starting Plan: oauth2-login\n**Plan file**: `.weave/plans/oauth2-login.md`\n**Progress**: 0/5 tasks completed\n**Start SHA**: abc123\n**Working directory**: `/workspace`\n\nRead the plan file now..."
}
```

**Step 13: Effects are generated and applied**

```
Module: Back in chat-policy.ts → commandChatPolicy
Effects generated:
  [
    { type: "switchAgent", agent: "tapestry" },
    { type: "appendPromptText", text: "## Starting Plan: oauth2-login\n..." }
  ]

Module: src/runtime/opencode/apply-effects.ts → applyRuntimeEffects()
  Effect 1: output.message.agent = "Tapestry (Execution Orchestrator)"
  Effect 2: output.parts[0].text += "\n\n---\n## Starting Plan: oauth2-login\n..."
```

**The final message sent to Tapestry's model:**

```
[System Prompt: Tapestry's composed prompt (~3000 tokens)]
  <Role>Tapestry — coordination orchestrator for Weave...</Role>
  <Invariant>Execution is non-terminal while any - [ ] task remains...</Invariant>
  <Discipline>TODO OBSESSION (NON-NEGOTIABLE)...</Discipline>
  <SidebarTodos>...</SidebarTodos>
  <Delegation>For each plan task, delegate to a Shuttle agent via Task tool...</Delegation>
  <Parallelism>Analyse task dependencies before delegating...</Parallelism>
  <CategoryRouting>Category-specific Shuttle agents...</CategoryRouting>
  <PlanExecution>When activated by /start-work with a plan file...</PlanExecution>
  <Continuation>If Weave injects a recovery or continuation prompt...</Continuation>
  <Verification>After Shuttle completes a task — BEFORE marking...</Verification>
  <ErrorHandling>When Shuttle returns an error...</ErrorHandling>
  <PostExecutionReview>When all plan tasks are checked off:...</PostExecutionReview>
  <Execution>Work through task batches top to bottom...</Execution>
  <Style>Terse status updates only...</Style>

[User message (as seen by Tapestry):]
  <command-instruction>...</command-instruction>
  <weave-command-envelope>...</weave-command-envelope>
  <session-context>Session ID: sess_abc  Timestamp: ...</session-context>
  <user-request></user-request>

  ---
  ## Starting Plan: oauth2-login
  **Plan file**: `.weave/plans/oauth2-login.md`
  **Progress**: 0/5 tasks completed
  **Start SHA**: abc123
  **Working directory**: `/workspace`

  Read the plan file now and begin executing from the first unchecked `- [ ]` task.

  **SIDEBAR TODOS — DO THIS FIRST:**
  Before starting any work, use todowrite to populate the sidebar:
  1. Create a summary todo (in_progress): "oauth2-login 0/5"
  2. Create a todo for the first unchecked task (in_progress)
  3. Create todos for the next 2-3 tasks (pending)
```

### 4.2 Trace Summary

| Step | Module                    | Transformation                              |
| ---- | ------------------------- | ------------------------------------------- |
| 1    | `index.ts`                | Plugin bootstrap                            |
| 2    | `config-fs-loader.ts`     | JSONC load + merge + validate               |
| 3    | `skill-loader/loader.ts`  | Skill discovery and resolver creation       |
| 4    | `loom/prompt-composer.ts` | 11 sections assembled into system prompt    |
| 5    | `builtin-agents.ts`       | Config overrides applied post-composition   |
| 6    | `config-handler.ts`       | Key remapped to display name                |
| 7    | `plugin-adapter.ts`       | User message pass-through (no effects)      |
| 8    | `plugin-adapter.ts`       | `/start-work` command detected              |
| 9    | `commands.ts`             | Template rendered with envelope             |
| 10   | `plugin-adapter.ts`       | Envelope parsed as trusted command          |
| 11   | `chat-policy.ts`          | Routed to start-work command handler        |
| 12   | `start-work-hook.ts`      | Plan resolved, state created, context built |
| 13   | `apply-effects.ts`        | switchAgent + appendPromptText applied      |

---

## 5. Configuration Model

### 5.1 Configuration Loading

**Format**: JSONC (JSON with comments and trailing commas)

**Locations** (in merge priority order):

1. `~/.config/opencode/weave-opencode.jsonc` — user-level
2. `.opencode/weave-opencode.jsonc` — project-level (wins for scalars)

**Merge strategy** (`src/config/merge.ts`):

- Nested objects (`agents`, `categories`, `custom_agents`): deep merge, project overrides user
- Arrays (`disabled_hooks`, `disabled_agents`, etc.): set union (deduplicated)
- Scalars (`log_level`, `background`): project value wins

**Validation**: Zod schema (`src/config/schema.ts`) with graceful degradation — invalid sections are dropped with warnings, valid sections preserved.

### 5.2 Configuration Schema (Key Sections)

```
WeaveConfig
├── agents: Record<AgentName, AgentOverrideConfig>     // Override builtin agents
│   ├── model, temperature, prompt_append, skills
│   ├── tools: Record<string, boolean>                 // Tool permissions
│   └── display_name                                    // UI name override
├── custom_agents: Record<string, CustomAgentConfig>   // Define new agents
│   ├── prompt / prompt_file                            // System prompt (inline or file)
│   ├── model, fallback_models, mode                    // Model resolution
│   ├── triggers: DelegationTrigger[]                   // Loom delegation table entries
│   └── skills, tools, temperature, ...
├── categories: Record<string, CategoryConfig>          // Domain routing
│   ├── patterns: string[]                              // Glob patterns for routing
│   ├── model, temperature, prompt_append
│   └── tools: Record<string, boolean>
├── disabled_hooks: string[]
├── disabled_agents: string[]
├── disabled_skills: string[]
├── continuation: { recovery: { compaction }, idle: { work, workflow, todo_prompt } }
├── analytics: { enabled, use_fingerprint }
├── background: { defaultConcurrency, providerConcurrency }
├── workflows: { disabled_workflows, directories }
└── log_level: "DEBUG" | "INFO" | "WARN" | "ERROR"
```

### 5.3 Dynamism

| Aspect            | Static / Dynamic                                                               |
| ----------------- | ------------------------------------------------------------------------------ |
| Agent prompts     | **Build-time static** — composed once at plugin init, immutable during session |
| Agent model       | **Build-time static** — resolved once via fallback chain                       |
| Tool permissions  | **Build-time static** — set on AgentConfig at init                             |
| Hook enablement   | **Build-time static** — evaluated once from `disabled_hooks`                   |
| Routing decisions | **Runtime dynamic** — LLM-driven via prompt instructions                       |
| Context injection | **Runtime dynamic** — effects append text to messages at runtime               |
| Agent switching   | **Runtime dynamic** — effects change the active agent                          |
| Continuation      | **Runtime dynamic** — idle/compaction events trigger prompt injection          |

---

## 6. Dependencies and Integrations

### 6.1 External Dependencies

| Package               | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `@opencode-ai/plugin` | Plugin lifecycle interface (`Plugin` type) |
| `@opencode-ai/sdk`    | `AgentConfig` type, SDK client types       |
| `jsonc-parser`        | Parse JSONC config files                   |
| `zod`                 | Schema validation for config               |
| `picocolors`          | Terminal color output (logging)            |

### 6.2 OpenCode-Specific Coupling Points

| Coupling Area          | Where                                           | Nature                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plugin Interface**   | `src/plugin/plugin-interface.ts`                | 8 lifecycle handlers: `config`, `chat.message`, `chat.params`, `tool.execute.before/after`, `command.execute.before`, `tool.definition`, `experimental.session.compacting` |
| **Agent Config**       | All agent definitions                           | `AgentConfig` type from `@opencode-ai/sdk`: `{ model, prompt, temperature, tools, mode, description }`                                                                     |
| **Session Client**     | `src/infrastructure/opencode/session-client.ts` | `client.session.promptAsync()`, `client.session.list()`                                                                                                                    |
| **Event Types**        | `src/runtime/opencode/event-router.ts`          | `session.created`, `session.deleted`, `session.compacted`, `session.idle`, `message.updated`, `message.part.updated`, `tui.command.execute`                                |
| **Config Hook**        | `src/managers/config-handler.ts`                | Writes to `config.agent`, `config.command`, `config.default_agent`                                                                                                         |
| **Display Names**      | `src/shared/agent-display-names.ts`             | OpenCode uses agent keys as UI labels                                                                                                                                      |
| **Command System**     | `src/features/builtin-commands/commands.ts`     | Commands define `agent`, `template` with OpenCode's `$ARGUMENTS`, `$SESSION_ID`, `$TIMESTAMP`                                                                              |
| **Tool Names**         | `src/tools/permissions.ts`                      | Tool identifiers: `write`, `edit`, `bash`, `task`, `call_weave_agent`, `todowrite`, etc.                                                                                   |
| **Protocol Envelopes** | `src/runtime/opencode/protocol.ts`              | XML tags `<weave-command-envelope>`, `<weave-continuation-envelope>`                                                                                                       |

---

## 7. Forward-Looking Context (Refactor Guidance)

### 7.1 Prompt Construction: Hardcoded vs Abstracted

| Component                                         | Assessment                                                   | Reusability                                        |
| ------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Section builders (`buildRoleSection`, etc.)       | **Well-abstracted** — pure functions, no side effects        | High — can be reused across harnesses              |
| `composeLoomPrompt()` / `composeTapestryPrompt()` | **Well-abstracted** — options-driven composition             | High — core logic is harness-agnostic              |
| Static prompts (shuttle, thread, etc.)            | **Hardcoded** but simple — inline string literals            | Medium — could be extracted to files or templates  |
| `stripDisabledAgentReferences()`                  | **Reusable** — operates on any prompt string                 | High                                               |
| `buildProjectContextSection()`                    | **Reusable** — takes a fingerprint, returns XML              | High                                               |
| Command templates                                 | **Tightly coupled** — use OpenCode `$VARIABLES`              | Low — needs adapter translation                    |
| Continuation prompts                              | **Moderately coupled** — embed XML envelopes                 | Medium — envelope format is OpenCode-specific      |
| Display name remapping                            | **Tightly coupled** — OpenCode uses config keys as UI labels | Low — other harnesses may handle names differently |

### 7.2 Recommended DSL / Engine / Adapter Split

```
┌─────────────────────────────────────────────────────────────────────┐
│                          DSL Layer (@weaveio/weave-core)                     │
│                                                                      │
│  defineConfig({                                                      │
│    agents: {                                                         │
│      loom: {                                                         │
│        role: "coordinator",                                          │
│        sections: [                                                   │
│          { tag: "Role", content: "..." },                            │
│          { tag: "Delegation", dynamic: true,                         │
│            builder: (ctx) => buildDelegation(ctx.enabledAgents) },   │
│        ],                                                            │
│        temperature: 0.1,                                             │
│        toolPolicy: { write: true, edit: true, task: true },         │
│      },                                                              │
│    }                                                                 │
│  })                                                                  │
│                                                                      │
│  What moves here:                                                    │
│  - Agent definitions (name, role, mode, temperature)                 │
│  - Prompt section declarations (static content, dynamic builders)    │
│  - Tool permission policies                                          │
│  - Delegation metadata (triggers, categories, costs)                 │
│  - Model fallback chain declarations                                 │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────┐
│              Weave Config/Engine Layer (@weaveio/weave-config + @weaveio/weave-engine)│
│                                                                      │
│  Normalizes declared intent into adapter-facing descriptors:          │
│                                                                      │
│  1. Load & merge .weave config                                       │
│  2. Preserve model preferences as intent (no harness UI queries)     │
│  3. Compose or describe prompts/delegation sections                  │
│  4. Apply config-level overrides and disabled-agent filtering        │
│  5. Preserve abstract tool/capability policy                         │
│  6. Resolve adapter-provided skills against agent skill references   │
│  7. Produce normalized agent descriptors for adapter translation     │
│                                                                      │
│  What moves here:                                                    │
│  - composeLoomPrompt(), composeTapestryPrompt() section assembly     │
│  - model-resolution.ts                                               │
│  - config merge + validation                                         │
│  - Skill matching/filtering and prompt injection (adapter provides skill content) │
│  - stripDisabledAgentReferences()                                    │
│  - Continuation config resolution                                    │
│  - Fingerprint generation                                            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────┐
│                    Adapter Layer (@weaveio/weave-adapter-*)                   │
│                                                                      │
│  Translates normalized Weave intent to harness-specific format:      │
│                                                                      │
│  @weaveio/weave-adapter-opencode:                                            │
│  - Map normalized Weave agent descriptors → OpenCode AgentConfig     │
│  - Remap keys to display names                                       │
│  - Register OpenCode plugin lifecycle hooks                          │
│  - Render command templates with $VARIABLES                          │
│  - Build XML envelope protocol                                       │
│  - Handle event routing (session.idle, session.compacted, etc.)      │
│  - Apply effects via OpenCode SDK client                             │
│                                                                      │
│  @weaveio/weave-adapter-pi:                                                  │
│  - Map ResolvedAgentConfig → Pi extension format                     │
│  - Register Pi-specific hooks and commands                           │
│                                                                      │
│  What moves here:                                                    │
│  - src/runtime/opencode/* (entire directory)                         │
│  - src/plugin/* (OpenCode-specific plugin interface)                 │
│  - src/infrastructure/opencode/* (session client)                    │
│  - Display name remapping logic                                      │
│  - Effect application (applyRuntimeEffects)                          │
│  - Event router                                                      │
│  - Command templates with harness-specific placeholders              │
│  - Trusted message state tracking                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.3 Specific Coupling to Decouple

**1. Prompt Format** — The XML-tag section format (`<Role>`, `<Delegation>`, etc.) is a good universal convention. Recommend keeping it in the engine layer, not the adapter.

**2. Tool Definitions** — Tool names (`write`, `edit`, `bash`, `task`, `todowrite`) are OpenCode-specific. The DSL should declare capabilities ("can write files", "can delegate tasks") and the adapter should map them to harness tool names.

**3. Agent Interfaces** — The `AgentConfig` type from `@opencode-ai/sdk` should not leak into the DSL or engine. Weave should produce normalized descriptors/prompt intent, and adapters should translate that intent into harness-native config. Do not make core Weave responsible for harness UI state or concrete model fields.

**4. Command System** — The `/start-work` template uses OpenCode-specific `$ARGUMENTS`, `$SESSION_ID` placeholders and XML envelopes. The engine should express "start plan execution" as an abstract command, and each adapter renders it for its harness.

**5. Event System** — Event types (`session.idle`, `session.compacted`, `message.updated`) are OpenCode events. The engine should define abstract lifecycle events (e.g., `onSessionIdle`, `onContextCompacted`) and adapters map harness-specific events to them. _This is already partially done_: `RuntimeLifecyclePolicySurface` in `src/application/policy/runtime-policy.ts` defines an abstract lifecycle interface — the event router in `src/runtime/opencode/event-router.ts` maps OpenCode events to it.

**6. Display Names** — OpenCode uses agent config keys as UI labels, requiring remapping. Other harnesses may handle this differently. Move display name logic to the adapter.

### 7.4 What's Already Harness-Agnostic (Can Lift Directly)

| Component               | Location                                          | Assessment                                                                                                                           |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt composers        | `src/agents/{loom,tapestry}/prompt-composer.ts`   | ✅ Pure functions, no OpenCode imports                                                                                               |
| Static agent prompts    | `src/agents/{name}/default.ts`                    | ✅ Pure data                                                                                                                         |
| Dynamic prompt builder  | `src/agents/dynamic-prompt-builder.ts`            | ✅ Pure functions                                                                                                                    |
| Model-resolution policy | `src/agents/model-resolution.ts`                  | ⚠️ Useful as adapter-facing policy only; UI/default/availability inputs are harness concerns                                         |
| Config schema           | `src/config/schema.ts`                            | ✅ Zod schema, no harness coupling                                                                                                   |
| Config merge            | `src/config/merge.ts`                             | ✅ Pure function                                                                                                                     |
| Continuation config     | `src/config/continuation.ts`                      | ✅ Pure resolution                                                                                                                   |
| Agent metadata          | `src/agents/builtin-agents.ts` (`AGENT_METADATA`) | ✅ Pure data                                                                                                                         |
| Prompt utils            | `src/agents/prompt-utils.ts`                      | ✅ Pure utility                                                                                                                      |
| Agent builder           | `src/agents/agent-builder.ts`                     | ⚠️ Mostly pure, but `AgentConfig` type from SDK                                                                                      |
| Plan service            | `src/domain/plans/`                               | ✅ Pure domain logic                                                                                                                 |
| Workflow service        | `src/domain/workflows/`                           | ✅ Pure domain logic                                                                                                                 |
| Policy engine           | `src/application/policy/policy-engine.ts`         | ✅ Pure policy composition                                                                                                           |
| Execution lease         | `src/domain/session/execution-lease.ts`           | ✅ Pure domain logic                                                                                                                 |
| Skill loader            | `src/features/skill-loader/`                      | ⚠️ Legacy OpenCode-specific discovery; successor should keep discovery in adapters and only lift pure matching/filtering into engine |
| Analytics               | `src/features/analytics/`                         | ✅ Pure metrics                                                                                                                      |

### 7.5 What Must Stay in the Adapter

| Component             | Location                                        | Reason                            |
| --------------------- | ----------------------------------------------- | --------------------------------- |
| Plugin interface      | `src/plugin/plugin-interface.ts`                | OpenCode `Plugin` type            |
| Plugin adapter        | `src/runtime/opencode/plugin-adapter.ts`        | OpenCode lifecycle handlers       |
| Event router          | `src/runtime/opencode/event-router.ts`          | OpenCode event types              |
| Apply effects         | `src/runtime/opencode/apply-effects.ts`         | OpenCode SDK mutations            |
| Protocol              | `src/runtime/opencode/protocol.ts`              | XML envelope format               |
| Session client        | `src/infrastructure/opencode/session-client.ts` | OpenCode SDK calls                |
| Display names         | `src/shared/agent-display-names.ts`             | OpenCode UI convention            |
| Command templates     | `src/features/builtin-commands/commands.ts`     | OpenCode `$VARIABLE` placeholders |
| Trusted message state | `src/runtime/opencode/trusted-message-state.ts` | OpenCode message flow             |

---

## Appendix A: Agent Prompt Size Estimates

| Agent    | Approx. Prompt Size | Sections                                       |
| -------- | ------------------- | ---------------------------------------------- |
| Loom     | ~2,500 tokens       | 11 composable sections                         |
| Tapestry | ~3,000 tokens       | 14 composable sections                         |
| Shuttle  | ~800 tokens         | 5 inline XML sections                          |
| Pattern  | ~1,200 tokens       | 6 inline XML sections + markdown template      |
| Thread   | ~250 tokens         | 3 inline XML sections                          |
| Spindle  | ~200 tokens         | 3 inline XML sections                          |
| Weft     | ~800 tokens         | 5 inline XML sections                          |
| Warp     | ~3,000 tokens       | 7 inline XML sections (spec compliance tables) |

## Appendix B: Runtime Injection Points

Beyond the build-time system prompt, Weave injects text at runtime via effects:

| Injection                      | Trigger                 | Effect Type           | Target Agent  |
| ------------------------------ | ----------------------- | --------------------- | ------------- |
| `/start-work` context          | Command parsed          | `appendPromptText`    | Tapestry      |
| Work continuation              | `session.idle`          | `injectPromptAsync`   | Tapestry      |
| Compaction recovery (plan)     | `session.compacted`     | `injectPromptAsync`   | Tapestry      |
| Compaction recovery (workflow) | `session.compacted`     | `injectPromptAsync`   | Step agent    |
| Workflow step prompt           | Workflow engine advance | `injectPromptAsync`   | Step agent    |
| Workflow continuation          | `session.idle`          | `injectPromptAsync`   | Step agent    |
| Context window warning         | Token threshold         | _(handled via hooks)_ | Current agent |

## Appendix C: Labeling Key

Throughout this document:

- **Observed**: Directly verified in source code
- **Inferred**: Logically deduced from code structure and data flow — marked with ⚠️ where assumptions are made
- **Recommended**: Suggested for the target architecture — clearly separated in Section 7

All prompt section content, effect types, initialization order, and data flow described in Sections 1–6 are **observed** from the source code. The refactor guidance in Section 7 is **recommended**.

---

## Appendix D: Migration Guide -- `review_models`

This section documents the migration path from the legacy `agents.{weft,warp}.review_models` configuration to the vNext `review_models` DSL field.

### D.1 Legacy Behavior (OpenCode-Weave alpha)

In the OpenCode-Weave alpha, `review_models` was configured as a property on the `agents.weft` and `agents.warp` objects inside `weave.config.json`:

```json
{
  "agents": {
    "weft": {
      "review_models": ["openai/gpt-5", "anthropic/claude-opus-4-5"]
    },
    "warp": {
      "review_models": ["openai/gpt-5"]
    }
  }
}
```

Key behaviors in the alpha:

- Review fan-out was triggered unconditionally whenever `review_models` was set, regardless of workflow step type.
- Each model ran as a separately named agent variant using the naming convention `{agent}-review-{provider}-{model}` (e.g. `weft-review-openai-gpt-5`). In vNext the `-review-` segment is dropped: `{agent}-{provider}-{model}` (e.g. `weft-openai-gpt-5`).
- Partial failures (one model failing while others succeeded) produced a warning in the session but did not abort the review. The successful verdicts were collated.
- The collation output was appended to the primary agent's output as a structured section. The primary agent's own verdict was not suppressed.
- `review_models` was only recognized on `weft` and `warp`. Setting it on other agents had no effect.

### D.2 vNext Equivalent

In vNext, `review_models` is a first-class DSL field on any `agent` block:

```weave
agent warp {
  description "Warp (Security Reviewer)"
  prompt_file "warp.md"
  models ["claude-sonnet-4-5"]
  review_models ["openai/gpt-5", "anthropic/claude-opus-4-5"]
}
```

The engine normalizes `review_models` into materialized variant agent descriptors and uses prompt-composed routing to delegate to Loom/Tapestry for execution. Adapters are not involved in review fan-out, collation, or verdict translation. See [Spec 32](specs/32-spec-review-models/32-spec-review-models.md) and the [DSL Reference](dsl-reference.md#review-models) for the full contract.

### D.3 Intentional Divergences

| Behavior | Legacy | vNext |
| --- | --- | --- |
| Scope | Only `weft` and `warp` | Any agent |
| Fan-out trigger | Unconditional | Only on `gate` steps with `completion review_verdict` |
| Partial failure | Warning + continue | Partial failures are recorded as warning entries in `CollatedReview.warnings`; collation succeeds if at least one variant succeeded; all-failed returns a typed error |
| Variant naming | `{agent}-review-{provider}-{model}` | Engine-owned deterministic names via `reviewVariantName` / `generateReviewVariants` using `{agent}-{sanitizedModel}` format; variants are materialized as first-class agent descriptors in the engine registry |
| Builtin defaults | `weft` and `warp` shipped with default `review_models` values | Builtins omit `review_models` by default to avoid unexpected cost -- operators opt in explicitly |
| Config format | JSON property under `agents.{name}` | `.weave` DSL field on the `agent` block |

The most significant behavioral change is the **fan-out trigger scope**: the alpha ran reviews outside of workflow context; vNext restricts fan-out to `gate` workflow steps with `completion review_verdict`. Ad-hoc review outside a workflow is not supported in vNext.

The omission of default `review_models` on builtins is intentional cost protection. Users who relied on automatic multi-model review in the alpha must declare `review_models` explicitly in their project `.weave/config.weave`.

### D.4 Migration Steps

1. Remove `review_models` from any `weave.config.json` or legacy JSON config.
2. Add a `review_models` field to the relevant `agent` block in `.weave/config.weave`.
3. Ensure the agent is used in a `gate` step with `completion review_verdict` in a workflow. Review variant routing only activates in that context. Adapters require no changes — review routing and collation are handled entirely by the engine.

For full field semantics, validation rules, and the routing design, see [Spec 32](specs/32-spec-review-models/32-spec-review-models.md).
