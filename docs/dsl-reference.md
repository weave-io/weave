# Weave DSL Reference

The `.weave` configuration language is a block-structured, declarative DSL for declaring agents, categories, workflows, prompts, delegation intent, model preferences, and settings. It is not TypeScript, JSON, or YAML.

**Related:** [Config Loading](config-loading.md) · [Prompt Composition](prompt-composition.md) · [Workflow Schema](workflow-schema.md) · [Adapter Boundary](adapter-boundary.md) · [CLI — `weave prompt self-modify`](cli.md#weave-prompt-self-modify)

> **Status**: This reference reflects the stable, finalized DSL contract. Workflow execution lifecycle details (step completion semantics, artifact integrity) are specified in [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) and [Spec 24 — Execution Lifecycle Decomposition](specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md), both of which are complete. See [Workflow Schema](workflow-schema.md) for the full typed schema and execution semantics.

---

## Configuration Locations

| Scope | Path | Purpose |
| --- | --- | --- |
| **Global** | `~/.weave/config.weave` | User-level defaults, shared across projects |
| **Project** | `.weave/config.weave` | Project-level config, overrides global |

**Merge strategy**: Project values override global for scalars; objects deep-merge; arrays union-merge.

**Directory layout**:

```text
~/.weave/                    # Global config root
├── config.weave             # Global agent/category/workflow definitions
└── prompts/                 # Global prompt files
    └── my-agent.md

.weave/                      # Project config root
├── config.weave             # Project agent/category/workflow definitions
├── prompts/                 # Project prompt files
│   ├── loom.md
│   ├── shuttle.md
│   └── custom-agent.md
├── plans/                   # Plan files (created by Pattern agent)
└── workflows/               # Additional workflow files (optional)
```

---

## Syntax Conventions

| Feature | Syntax |
| --- | --- |
| Comments | `# line comment` |
| Strings | `"double-quoted"` |
| Multi-line strings | `""" ... """` |
| Arrays | `["item1", "item2"]` |
| Booleans | bare `true` / `false` |
| Enums | bare identifiers (`allow`, `deny`, `primary`, …) |
| Numbers | bare numeric literals (`0.1`, `1`) |
| Named blocks | `keyword name { ... }` |
| Scalar key-value | `key value` (no colon, no semicolon) |

---

## Agents

Agents are the primary declaration unit. Each agent block declares a named agent with its prompt source, model preferences, mode hint, tool policy, and optional delegation triggers.

```weave
agent loom {
  description "Loom (Main Orchestrator)"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5", "gpt-4o"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network ask
  }

  triggers [
    { domain "Orchestration" trigger "Complex multi-step tasks" }
    { domain "Architecture" trigger "System design and planning" }
  ]

  skills ["tdd", "code-review"]
}

# Minimal agent with inline prompt
agent my-helper {
  prompt "You are a helpful assistant that answers questions concisely."
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.3
}
```

### Agent Fields

| Field | Type | Description |
| --- | --- | --- |
| `description` | string | Human-readable label shown in harness UI |
| `prompt` | string | Inline prompt text. Mutually exclusive with `prompt_file`. |
| `prompt_file` | string | Path to a `.md` file, resolved relative to the config scope's `prompts/` directory. Mutually exclusive with `prompt`. |
| `prompt_append` | string | Inline text appended after the primary prompt source. Rendered as a Mustache template. Mutually exclusive with `prompt_append_file`. |
| `prompt_append_file` | string | Path to a `.md` file appended after the primary prompt source. Mutually exclusive with `prompt_append`. |
| `models` | string[] | Ordered model preference list. Adapters translate to concrete harness model fields. |
| `mode` | `primary` \| `subagent` \| `all` | Adapter-facing context hint. `primary` = main/user-facing; `subagent` = delegated specialist; `all` = usable in both. |
| `temperature` | number | Sampling temperature hint passed to adapters. |
| `tool_policy` | block | Abstract capability map. See [Tool Policy](#tool-policy). |
| `triggers` | array | Delegation metadata for router agents. Each entry: `{ domain "…" trigger "…" }`. |
| `skills` | string[] | Skill names to load for this agent. |

### Tool Policy

The `tool_policy` block declares abstract capabilities. Adapters map these to harness-specific tool names and permission models.

```weave
tool_policy {
  read    allow
  write   allow
  execute allow
  delegate deny
  network ask
}
```

| Capability | Values | Meaning |
| --- | --- | --- |
| `read` | `allow` \| `deny` \| `ask` | File/resource read access |
| `write` | `allow` \| `deny` \| `ask` | File/resource write access |
| `execute` | `allow` \| `deny` \| `ask` | Process/command execution |
| `delegate` | `allow` \| `deny` \| `ask` | Spawning subagents |
| `network` | `allow` \| `deny` \| `ask` | Network/HTTP access |

See [Tool Policy Evaluation](tool-policy-evaluation.md) for the full evaluation semantics and adapter mapping rules.

---

## Categories

Categories define domain routing — glob patterns that direct work to specialised shuttle agents. Each category automatically generates a `shuttle-{name}` agent descriptor that inherits from the base `shuttle` agent with category-specific overrides.

```weave
category backend {
  description "Backend APIs, services, persistence"
  models ["anthropic/claude-sonnet-4-5"]
  patterns ["src/api/**", "src/server/**", "src/db/**", "**/*.go"]
  prompt_append "Focus on API contracts, data integrity, and backwards compatibility."
  temperature 0.2

  tool_policy {
    read allow
    write allow
    delegate deny
  }
}

category frontend {
  description "Frontend UI, styling, accessibility"
  models ["openai/gpt-5"]
  patterns ["src/components/**", "src/pages/**", "**/*.tsx", "**/*.css"]
  prompt_append "Preserve accessibility, responsive behavior, and design-system consistency."
}
```

### Category Fields

| Field | Type | Description |
| --- | --- | --- |
| `description` | string | Human-readable label |
| `models` | string[] | Model preference list for this category's shuttle agent |
| `patterns` | string[] | Glob patterns that route files to this category |
| `prompt_append` | string | Text appended to the base shuttle prompt for this category |
| `prompt_append_file` | string | File path appended to the base shuttle prompt |
| `temperature` | number | Temperature hint for this category's shuttle agent |
| `tool_policy` | block | Tool policy overrides for this category's shuttle agent |

Generated shuttle agent names follow the pattern `shuttle-{category-name}` (e.g. `shuttle-backend`, `shuttle-frontend`). Adapters decide how those descriptors are materialised in a concrete harness.

---

## Workflows

> **Usage model**: Workflows are **explicit, user-invoked** constructs. They are not the default path for ordinary Weave usage. Ordinary usage is Loom-led: Loom handles conversational triage, delegates bounded tasks to Shuttle, and asks Pattern to create a plan when needed. A workflow begins only when a user explicitly invokes one (e.g. via `/weave:start` or an equivalent adapter command). See [Spec 29 — Default Usage Is Not Workflow-Driven](specs/29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md).

Workflows define multi-step execution pipelines with agents, completion conditions, and artifact passing.

```weave
workflow secure-feature {
  description "Plan, implement, build, and review a feature with security audit"
  version 1

  step plan {
    name "Create implementation plan"
    type autonomous
    agent pattern
    prompt "Create a detailed implementation plan for: {{instance.goal}}"

    completion plan_created {
      plan_name "{{instance.slug}}"
    }

    outputs [
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }

  step review-plan {
    name "Review the plan"
    type interactive
    agent shuttle
    prompt "Review the plan at {{artifacts.plan_path}} for: {{instance.goal}}"
    completion user_confirm
  }

  step implement {
    name "Execute the plan"
    type autonomous
    agent shuttle
    prompt "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}"

    completion plan_complete {
      plan_name "{{instance.slug}}"
    }

    inputs [
      { name "plan_path" description "Path to the plan to execute" }
    ]
  }

  step security-review {
    name "Security audit"
    type gate
    agent warp
    prompt "Perform a security audit of all changes for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}
```

### Workflow Fields

| Field | Type | Description |
| --- | --- | --- |
| `description` | string | Human-readable workflow label |
| `version` | number | Schema version for migration compatibility |
| `step` | named block | One or more step declarations (see below) |

### Step Fields

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Display name for the step |
| `type` | `autonomous` \| `interactive` \| `gate` | Step execution mode |
| `agent` | identifier | Agent to execute this step |
| `prompt` | string | Prompt template for this step. Supports `{{instance.*}}` and `{{artifacts.*}}` placeholders. |
| `completion` | identifier or block | Completion method. See [Completion Methods](#completion-methods). |
| `on_reject` | `pause` | Action when a gate step rejects (currently only `pause`) |
| `inputs` | array | Artifact inputs consumed by this step: `{ name "…" description "…" }` |
| `outputs` | array | Artifact outputs produced by this step: `{ name "…" description "…" }` |

### Step Types

| Type | Meaning |
| --- | --- |
| `autonomous` | Agent works alone without user intervention |
| `interactive` | User can intervene during execution |
| `gate` | Approve/reject checkpoint; execution pauses for a verdict |

### Completion Methods

| Method | Syntax | Meaning |
| --- | --- | --- |
| `agent_signal` | bare | Agent emits a completion signal |
| `user_confirm` | bare | User explicitly confirms completion |
| `plan_created` | block with `plan_name` | A plan file was created at the given path |
| `plan_complete` | block with `plan_name` | A plan file was fully executed |
| `review_verdict` | bare | A gate agent emits approve or reject |

See [Workflow Schema](workflow-schema.md) for the full typed schema, validation constraints, and artifact integrity rules.

### `extend before-plan` Directive

The `extend before-plan` directive inserts steps into the `before-plan` slot of any workflow that publishes `extension_points { before-plan }`. It is a **composition** directive — separate from the `extension_points { before-plan }` **publication** syntax inside a workflow block.

```weave
extend before-plan ["write-spec", "review-spec"]
```

**v1 contract**: there is exactly one global `before-plan` bucket — no per-workflow targeting. The config layer applies the step list to every workflow that publishes `extension_points { before-plan }`. Multiple `extend before-plan` directives in the same config are union-merged into a single ordered step list.

| Constraint | Detail |
| --- | --- |
| Step names | Must be non-empty strings matching declared step block identifiers |
| At least one step | An empty step list is rejected at validation time |
| Global scope | Applied to all workflows that publish `before-plan`; no per-workflow targeting in v1 |
| Union-merge | Multiple directives accumulate steps in declaration order |

See [Workflow Schema — `before-plan` Extension Surface](workflow-schema.md#before-plan-extension-surface) for the full contract.

---

## Settings and Disables

```weave
disable agents ["warp", "spindle"]
disable hooks ["on-session-idle"]
disable skills ["tdd"]

settings {
  log_level INFO
}

continuation {
  recovery {
    compaction true
  }
  idle {
    enabled true
    work true
    workflow true
  }
}

analytics {
  enabled true
  use_fingerprint false
}
```

### `disable` Directives

| Form | Effect |
| --- | --- |
| `disable agents ["name", …]` | Exclude named agents from materialisation |
| `disable hooks ["name", …]` | Disable named lifecycle hooks |
| `disable skills ["name", …]` | Disable named skills globally |

### `settings` Block

| Field | Values | Description |
| --- | --- | --- |
| `log_level` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` | Runtime log level |

### `continuation` Block

Controls session recovery and idle behaviour.

| Field | Type | Description |
| --- | --- | --- |
| `recovery.compaction` | boolean | Enable context compaction on recovery |
| `idle.enabled` | boolean | Enable idle detection |
| `idle.work` | boolean | Resume work on idle |
| `idle.workflow` | boolean | Resume workflow on idle |

### `analytics` Block

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Enable analytics collection |
| `use_fingerprint` | boolean | Include device fingerprint in analytics |

---

## Prompt Templates

Every `prompt`, `prompt_file`, `prompt_append`, and `prompt_append_file` value is a **Prompt Template** rendered by the engine with Mustache before adapters receive the final composed prompt.

```md
You are {{agent.name}}.

{{#delegation.targets}}
- **{{name}}**{{#description}} — {{description}}{{/description}}
{{/delegation.targets}}
```

### Template Context Fields

| Path | Type | Description |
| --- | --- | --- |
| `{{agent.name}}` | string | Logical agent name |
| `{{agent.description}}` | string? | Agent description |
| `{{agent.mode}}` | `primary`\|`subagent`\|`all` | Adapter-facing mode hint |
| `{{agent.skills}}` | string[] | Declared skill names |
| `{{agent.isCategory}}` | boolean | `true` for category shuttle agents |
| `{{category.name}}` | string? | Category name (category shuttles only) |
| `{{category.description}}` | string? | Category description (category shuttles only) |
| `{{toolPolicy.effective.read}}` | `allow`\|`deny`\|`ask` | Resolved read permission |
| `{{toolPolicy.effective.write}}` | `allow`\|`deny`\|`ask` | Resolved write permission |
| `{{toolPolicy.effective.execute}}` | `allow`\|`deny`\|`ask` | Resolved execute permission |
| `{{toolPolicy.effective.delegate}}` | `allow`\|`deny`\|`ask` | Resolved delegate permission |
| `{{toolPolicy.effective.network}}` | `allow`\|`deny`\|`ask` | Resolved network permission |
| `{{{delegation.section}}}` | string? | Full `## Delegation` Markdown block with Mermaid diagram and bullets |
| `{{{delegation.mermaid}}}` | string? | Mermaid diagram block only |
| `{{#delegation.targets}}` | array | Iterate over eligible delegation targets |
| `{{name}}` | string | Target agent name (inside `delegation.targets`) |
| `{{description}}` | string? | Target description (inside `delegation.targets`) |
| `{{domains}}` | string[] | Deduplicated trigger domains (inside `delegation.targets`) |
| `{{#triggers}}` | array | Iterate over triggers (inside `delegation.targets`) |

### Unsupported Features

Partials (`{{> footer}}`), delimiter changes, helpers, and lambdas are rejected at composition time with a typed `PromptTemplateError`.

See [Prompt Composition](prompt-composition.md) for the full specification and [ADR 0001](adr/0001-prompt-composition-templates.md) for the design rationale.

---

## Design Principles

- **Readable** — Non-programmers should be able to read and roughly understand a config
- **Declarative** — Describes what, not how; no control flow, no functions, no imports
- **Block-structured** — `keyword name { ... }` for named blocks; flat `key value` for scalars
- **Minimal punctuation** — No semicolons, no trailing commas, no colons for key-value pairs
- **Comments** — `#` line comments only
- **Strings** — Double-quoted; multi-line strings use triple-quote `""" ... """`
- **Arrays** — `["item1", "item2"]` — JSON-style for familiarity
- **Booleans** — bare `true` / `false`
- **Enums** — bare identifiers for fixed value sets (e.g. `allow`, `deny`, `ask`, `primary`, `subagent`)
- **Numbers** — bare numeric literals

---

## Implementation

The DSL is implemented in `@weaveio/weave-core`:

| Module | Responsibility |
| --- | --- |
| [`packages/core/src/lexer.ts`](../packages/core/src/lexer.ts) | Tokenizer |
| [`packages/core/src/parser.ts`](../packages/core/src/parser.ts) | Token stream → AST |
| [`packages/core/src/ast.ts`](../packages/core/src/ast.ts) | AST node types |
| [`packages/core/src/schema.ts`](../packages/core/src/schema.ts) | Zod schemas for validated config |
| [`packages/core/src/validate.ts`](../packages/core/src/validate.ts) | AST → validated `WeaveConfig` |
| [`packages/config/src/builtins.ts`](../packages/config/src/builtins.ts) | Builtin agents declared as `.weave` DSL |
| [`packages/config/src/discovery.ts`](../packages/config/src/discovery.ts) | Config file discovery and parsing |
| [`packages/config/src/merge.ts`](../packages/config/src/merge.ts) | Deep merge semantics |
