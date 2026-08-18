# Weave DSL Reference

The `.weave` configuration language is a block-structured, declarative DSL for declaring agents, categories, workflows, prompts, delegation intent, model preferences, and settings. It is not TypeScript, JSON, or YAML.

**Related:** [Config Loading](configuration.md) · [Prompt Composition](prompts.md) · [Workflow Schema](workflows.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [Pi adapter contract](../adapters/pi.md) · [Spec 33 — Pi private child sessions](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [ADR 0013](../adr/0013-pi-private-child-sessions.md) · [CLI — `weave prompt self-modify`](cli.md#weave-prompt-self-modify)

> **Status**: This reference describes the current DSL. See [Execution Lifecycle](execution-lifecycle.md) for runtime semantics and [Workflows](workflows.md) for the typed workflow contract.

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
├── plans/                   # Plan files (created by Pattern agent): .weave/plans/
└── workflows/               # Additional workflow files (optional)
```

Plan files are always stored under `.weave/plans/`. Plan-related learnings and execution artifacts should also stay under `.weave/`, not in top-level `plans/`, `learnings/`, or state directories.

---

## Syntax Conventions

| Feature | Syntax |
| --- | --- |
| Comments | `# line comment` |
| Strings | `"double-quoted"` |
| Multi-line strings | `""" ... """` — see [Multiline strings](#multiline-strings) |
| Arrays | `["item1", "item2"]` |
| Booleans | bare `true` / `false` |
| Enums | bare identifiers (`allow`, `deny`, `primary`, …) |
| Numbers | bare numeric literals (`0.1`, `1`) |
| Named blocks | `keyword name { ... }` |
| Scalar key-value | `key value` (no colon, no semicolon) |

### Multiline strings

A triple-quoted string (`""" ... """`) holds inline text that spans lines. It is the only multiline form: the DSL has no heredoc, backtick string, indented block, or line-continuation syntax, and triple-quoted content supports no escapes and no interpolation.

The form is lexical, so any string value may use it. It exists for inline prompt text, and every scope the schema gives an inline prompt string accepts it:

| Scope | Fields |
| --- | --- |
| `agent` | `prompt`, `prompt_append` |
| `category` | `prompt_append` |
| `workflow` | `prompt_append` |
| workflow `step` | `prompt`, `prompt_append` |

```weave
agent my-helper {
  description "Answers questions about the current repository"
  prompt """
  You are a careful assistant.

  Rules:
    - Quote code like "this", and even ""this"".
    - Backslashes stay literal: C:\path\to\file
    - # does not start a comment here.
    - { } [ ] , agent workflow are ordinary text.
  """
  mode subagent
}
```

That `prompt` value is:

```text
You are a careful assistant.

Rules:
  - Quote code like "this", and even ""this"".
  - Backslashes stay literal: C:\path\to\file
  - # does not start a comment here.
  - { } [ ] , agent workflow are ordinary text.
```

The rules below are normative. The lexer implements them in `packages/core/src/lexer.ts`.

**Delimiters.** The string opens at `"""` and closes at the **first** later `"""`.

**One optional line break after the opening delimiter.** A single line break immediately after the opening `"""` is dropped, whether it is `LF` or `CRLF`. A second break is content, so it becomes a leading blank line and is then removed by blank-line trimming.

**Universal newline normalization.** Every `CRLF` and every remaining lone `CR` in the content becomes `LF` before dedent. A multiline value never contains a carriage return, whatever the file's line endings are.

**Raw content — no escape processing.** Unlike single-line double-quoted strings, triple-quoted content processes no escape sequences. A backslash is a literal backslash: `\"`, `\\`, `\n`, `\t`, and `\#` reach the value as their exact source characters. Write a quote by typing a quote; write a newline by pressing Enter; write a backslash by typing one.

**Comment-like and block-like text is literal.** `#` starts no comment, and `{`, `}`, `[`, `]`, `,`, and DSL keywords such as `agent` and `workflow` are ordinary text. A content line reading `agent x {` or `}` changes nothing about the enclosing block.

**The first `"""` closes, even after a backslash.** A backslash does not escape the delimiter. `"""ends with a backslash \"""` is a complete string whose value ends with one literal backslash.

**Unrepresentable content.** Two shapes cannot be written inline:

- content containing a literal `"""`, because the string closes there;
- content whose final character is `"` directly abutting the closing delimiter, because the run of quotes closes early. `prompt """say "hi""""` closes after `say "hi` and leaves a stray `"`, which then fails as an unterminated single-line string.

Use `prompt_file` or `prompt_append_file` for such content. A single `"` and a `""` pair inside content are fine; only the three-quote run is special.

**Dedent removes a minimum character count, not a prefix.** The lexer counts the leading whitespace characters of every line that contains non-whitespace, takes the smallest count, and removes that many characters from the start of every line. Whitespace is counted **per character**: a tab counts as one character, exactly like a space, and no tab-to-column arithmetic happens. So a line indented with one tab next to a line indented with four spaces yields a minimum of one character: the tab line loses its tab, and the space line keeps three spaces. Indent multiline content with one style to get predictable results. Trailing whitespace inside a line is preserved.

**Blank-line handling.** Leading and trailing blank lines (empty or whitespace-only) are removed. Interior blank lines are preserved as empty lines, which is what makes paragraph breaks inside a prompt work. Content with no non-blank line yields an empty string.

**Same-line form.** `"""content"""` with no line breaks yields `content` through the same dedent and trim pass, so `prompt """one line"""` is exactly `one line`.

**End of input before the closing delimiter.** An unclosed multiline string is a typed `UnterminatedString { line, column }` positioned at the **opening** delimiter, not at end of file. It is collected with every other lex diagnostic under the bounded-diagnostics policy (`packages/core/src/config-error-policy.ts`); the lexer returns a `Result` and never throws. A config left mid-edit therefore fails to load with a diagnostic that points at the prompt that was opened.

#### Migration and compatibility

- **LF configs are unchanged.** Every LF-only source that parsed before produces byte-identical values now. Nothing to migrate.
- **CRLF and lone-CR configs are normalized.** These sources previously kept their carriage returns, so a two-line prompt became `"line one\r\nline two\r"`, and the stray `\r` characters also skewed dedent and blank-line trimming. Content is now universal-newline normalized, so those files produce the same values as their LF equivalents. This is a bug fix, and it changes composed prompt text for configs stored with Windows line endings. If a prompt carried a workaround for the old behavior, remove it.

---

## Agents

Agents are the primary declaration unit. Each agent block declares a named agent with its prompt source, model preferences, mode hint, tool policy, optional delegation triggers, and optional provider acceleration intent.

```weave
agent loom {
  description "Main orchestrator: classifies open-ended requests, routes bounded work straight to specialists, and hands plan-sized work to pattern; may read, write, execute, and delegate; select for open-ended user requests that need coordination across several agents"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5", "gpt-4o"]
  mode primary
  temperature 0.1
  fast true

  tool_policy {
    read allow
    write allow
    execute allow
    delegate allow
    network ask
  }

  triggers [
    "Use for work spanning multiple files or components"
    "Use when design decisions must precede implementation"
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
| `description` | string | Routing metadata, not branding. Shown to delegating orchestrators (Loom, Tapestry) in their delegation tables and rendered by `{{description}}` inside `delegation.targets`, so it should state what work the agent handles, its key constraints, and when to select it. Harnesses may also show it in their UI. |
| `prompt` | string | Inline prompt text. Mutually exclusive with `prompt_file`. |
| `prompt_file` | string | Path to a `.md` file, resolved relative to the config scope's `prompts/` directory. Mutually exclusive with `prompt`. |
| `prompt_append` | string | Inline text appended after the primary prompt source. Rendered as a Mustache template. Mutually exclusive with `prompt_append_file`. |
| `prompt_append_file` | string | Path to a `.md` file appended after the primary prompt source. Mutually exclusive with `prompt_append`. |
| `models` | string[] | Ordered model preference list. Adapters translate to concrete harness model fields. |
| `mode` | `primary` \| `subagent` \| `all` | Adapter-facing context hint. `primary` = main/user-facing; `subagent` = delegated specialist; `all` = usable in both. |
| `temperature` | number | Sampling temperature hint passed to adapters. |
| `fast` | literal `true` | Optional neutral request for provider acceleration. Only `fast true` is valid. Omit it to preserve provider defaults. See [Fast intent](#fast-intent). |
| `tool_policy` | block | Abstract capability map. See [Tool Policy](#tool-policy). |
| `triggers` | string[] | Optional ordered routing guidance shown to delegating agents. Each entry is a nonblank string. |
| `skills` | string[] | Skill names to load for this agent. |
| `review_models` | string[] | Optional. One or more model identifiers materialized as independent reviewer variants when config is loaded/composed. Loom/Tapestry prompts route review requests to the base agent plus each generated variant. See [Review Models](#review-models). |
| `delegation` | block | Optional per-agent narrowing of `max_children` and `max_concurrency`. Values may not exceed project settings. |

### Fast intent

`fast true` asks an adapter to request provider acceleration when its current provider, endpoint, model, transport, and harness seam support the request. It does not select a provider or model and does not prove that the provider applied acceleration.

```weave
agent shuttle {
  fast true
  triggers ["Implement bounded changes with an established local pattern"]
}
```

Omit `fast` to preserve provider defaults. These forms are invalid:

```weave
agent invalid-false {
  fast false
}

agent invalid-aliases {
  service_class "fast"
  speed "fast"
  variant "fast"
  priority true
}
```

There is no `false` form, unset operator, or alias. A higher-priority config layer can add `fast true`, but omission cannot cancel a lower-priority declaration. Adapters report acceleration separately as `declared`, `requested`, `applied`, `not-confirmed`, or `unsupported`; only exact provider response evidence permits `applied`. See the [provider acceleration contract](../specs/fast-provider-acceleration-contract.md#truthful-states-and-transitions).

The declaration itself stays neutral: it names no provider, endpoint, model, transport, or credential, and no core, config, or engine schema learns any of those. Whether it becomes a real provider control is an adapter-local decision. OpenCode and Claude Code send no control at all. Pi maps it for one provider, its wrapped OpenAI Codex subscription transport, and leaves every other request byte-identical. See [Adapter Capabilities](adapter-capabilities.md#current-provider-fast-support).

### Delegation triggers

Triggers are portable text, not a structured routing language:

```weave
agent loom {
  triggers ["Coordinate work that spans multiple components"]
}
```

Structured entries from the former contract are invalid:

```weave
agent invalid-trigger {
  triggers [
    { domain "Review" trigger "Review code" routing_hint "Use for pull request review" }
  ]
}

category invalid-category-trigger {
  description "Review work"
  triggers [{ domain "Review" trigger "Review code" }]
}
```

Weave preserves trigger order. Across config layers, arrays use ordered union merge: higher-priority entries come first, followed by lower-priority entries not already present by exact string equality. Weave does not interpret domains, file paths, or other structure from the text.

### Model thinking-level suffixes

Each `models` or `review_models` entry may carry an optional per-entry thinking-level suffix. Category `models` entries use the same syntax:

```weave
agent shuttle {
  models ["openai-codex/gpt-5.6-sol#high", "claude-sonnet-4-5#low", "claude-haiku-3-5"]
  review_models ["openai/gpt-5#medium"]
}

category backend {
  description "Backend APIs and services"
  triggers ["Use for backend APIs and persistence"]
  models ["anthropic/claude-sonnet-4-5#minimal"]
}
```

The closed vocabulary is exactly seven levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The suffix is parsed as follows:

- Weave uses the **last unescaped `#`** as the delimiter. The text after it must be exactly one of the seven levels.
- `\#` is a literal hash in the model identifier, not a delimiter. For example, `"weird\#model"` resolves to base model `weird#model` with no thinking level.
- An unescaped `#` with an unknown or empty suffix is a hard config-validation error. Weave never silently treats an invalid suffix as part of the model identifier.
- The lexer/parser already treats the value as a quoted string; this convention adds no new DSL block or token.

The descriptor contract remains compatible: `AgentDescriptor.models` is still `string[]` and carries each raw entry, including its suffix. Core validates the entry; engine and adapters split it only while resolving the model. See [Models](models.md) and [Adapter Boundary](../architecture/adapter-boundary.md).

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

See [Tool Policy Evaluation](tool-policy.md) for the full evaluation semantics and adapter mapping rules.

---

## Review Models

`review_models` is an optional field on any `agent` block. It nominates one or more alternative models as independent reviewer variants. Each nominated model is materialized as a first-class agent descriptor (named `{agent}-{base-model}`, with non-identifier characters replaced by `-`) whenever config is loaded or composed — not deferred to any particular workflow step. Orchestrator prompts (Loom/Tapestry) route review requests to the base agent plus each generated variant through normal prompt-composed delegation.

```weave
agent warp {
  description "Warp (Security Reviewer)"
  prompt_file "warp.md"
  models ["claude-sonnet-4-5"]
  mode subagent

  review_models ["openai/gpt-4o", "anthropic/claude-opus-4-5"]
}
```

**Key behaviors:**

- One read-only review variant descriptor is generated per entry, named from `{agent}-{base-model}` with non-identifier characters replaced by `-` (e.g. `warp-openai-gpt-4o`, `warp-anthropic-claude-opus-4-5`). A `#<level>` suffix is excluded from the name, while the full raw entry remains the variant's single `models` value.
- Two entries with the same base model but different thinking levels intentionally produce the same variant name and fail closed through the existing review-variant name-collision error; thinking level is not a separate reviewer identity.
- Variant routing is available whenever Loom/Tapestry prompts are composed with review variants in delegation targets. The orchestrator materializes generated agent descriptors and instructs Loom/Tapestry to delegate to the base reviewer plus each generated variant via normal subagent delegation; routing is driven by prompt composition, not workflow gate activation.
- Partial failures (some variants fail) are logged as warnings; the completes from the successful variants.
- All variants failing causes the fail and transition to the `on_reject` action.
- Builtin agents omit `review_models` by default; users opt in explicitly to avoid unexpected cost.

See [review-model contract: Review Models](models.md) for the full behavioral contract.

---

## Categories

Categories define named specialist domains. Each category automatically generates a `shuttle-{name}` agent descriptor that inherits from the base `shuttle` agent with category-specific overrides. Routing uses the category description and optional trigger strings. Categories do not match files.

```weave
category backend {
  description "Backend APIs, services, persistence"
  models ["anthropic/claude-sonnet-4-5"]
  triggers ["Use for API contracts, services, and persistence"]
  fast true
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
  triggers ["Use for UI, styling, and accessibility"]
  prompt_append "Preserve accessibility, responsive behavior, and design-system consistency."
}
```

### Category Fields

| Field | Type | Description |
| --- | --- | --- |
| `description` | string | **Required and non-blank.** Routing metadata for the generated `shuttle-{category}` agent. It appears wherever that agent is shown, including the delegation tables of Loom and Tapestry, so describe the category's domain and when to select it. |
| `models` | string[] | Model preference list for this category's shuttle agent |
| `triggers` | string[] | Optional ordered routing guidance copied to the generated category agent |
| `fast` | literal `true` | Optional neutral provider acceleration intent for the generated category agent |
| `prompt_append` | string | Text appended to the base shuttle prompt for this category |
| `prompt_append_file` | string | File path appended to the base shuttle prompt |
| `temperature` | number | Temperature hint for this category's shuttle agent |
| `tool_policy` | block | Tool policy overrides for this category's shuttle agent |

Generated shuttle agent names follow the pattern `shuttle-{category-name}` (e.g. `shuttle-backend`, `shuttle-frontend`). Adapters decide how those descriptors are materialised in a concrete harness.

Requiring `description` is a breaking config change. Every existing `category` block must add a non-blank routing description. `weave init migrate` skips legacy categories without descriptions and reports a warning rather than writing invalid DSL.

A generated category shuttle uses the category's merged trigger list. It never inherits the base `shuttle` triggers. If the category omits triggers, its generated agent has no triggers. Declare triggers on the base `shuttle` for generic fallback work.

An explicit category `fast true` takes precedence over the base `shuttle` value. If the category omits `fast`, its generated agent inherits the base `shuttle` intent. Omission cannot cancel an inherited `fast true`.

The following former category syntax is invalid. Delete it; there is no replacement file-routing field:

```weave
category invalid-patterns {
  description "Backend files"
  patterns ["src/server/**"]
}
```

`patterns` is not optional metadata. Strict validation rejects it.

---

## Workflows

> **Usage model**: Workflows are **explicit, user-invoked** constructs. They are not the default path for ordinary Weave usage. Ordinary usage is Loom-led: Loom handles conversational triage, delegates bounded tasks to Shuttle, and asks Pattern to create a plan when needed. A workflow begins only when a user explicitly invokes one (e.g. via `/weave:start` or an equivalent adapter command). See [product model — Default Usage Is Not Workflow-Driven](../architecture/product-vision.md).

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
| `step` | named block | One or more (see below) |

### Step Fields

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Display name for the step |
| `type` | `autonomous` \| `interactive` \| `gate` | Step execution mode |
| `agent` | identifier | Agent to execute this step |
| `prompt` | string | Prompt template for this step. Supports `{{instance.*}}` and `{{artifacts.*}}` placeholders. |
| `completion` | identifier or block | Completion method. See [Completion Methods](#completion-methods). |
| `on_reject` | `pause` | Action when a gate (currently only `pause`) |
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

See [Workflow Schema](workflows.md) for the full typed schema, validation constraints, and artifact integrity rules.

### `extend before-plan` Directive

The `extend before-plan` directive inserts the `before-plan` slot of any workflow that publishes `extension_points { before-plan }`. It is a **composition** directive — separate from the `extension_points { before-plan }` **publication** syntax inside a workflow block.

```weave
extend before-plan ["write-spec", "review-spec"]
```

**v1 contract**: there is exactly one global `before-plan` bucket — no per-workflow targeting. The config layer applies the step list to every workflow that publishes `extension_points { before-plan }`. Multiple `extend before-plan` directives in the same config are union-merged into a single ordered

| Constraint | Detail |
| --- | --- |
| Step names | Must be non-empty strings matching declared identifiers |
| At least one step | An empty step list is rejected at validation time |
| Global scope | Applied to all workflows that publish `before-plan`; no per-workflow targeting in v1 |
| Union-merge | Multiple directives accumulate declaration order |

See [Workflow Schema — `before-plan` Extension Surface](workflows.md#before-plan-extension-surface) for the full contract.

---

## Settings and Disables

```weave
disable agents ["warp", "spindle"]
disable hooks ["on-session-idle"]
disable skills ["tdd"]

settings {
  log_level INFO
  enforce_permissions true

  adapters {
    # Harness names and values are opaque to core.
    pi {
      child_inspection { recovery_enabled true }
      child_lifecycle {
        handshake_timeout_ms 30000
        reply_timeout_ms 60000
        settlement_inactivity_timeout_ms 3600000
        absolute_runtime_budget_ms 21600000
      }
    }
  }

  delegation {
    max_children 32
    max_concurrency 3
    max_depth 3
    max_processes 9
  }

  runtime {
    journal {
      strict false
      retention_days 30
      max_entries 10000
    }
    usage {
      detail_retention_days 30
      max_observations 100000
    }
    log {
      max_segment_bytes 5242880
      max_segments 3
    }
  }
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
| `enforce_permissions` | boolean | Enforce adapter tool policies through the Weave permission system. Default `true`; adapters that support opt-out preserve native/tool-owner behavior when `false`. |
| `adapters.<harness>` | JSON-like value | Opaque adapter settings: strings, finite numbers, booleans, `null`, arrays, and objects. Each harness block allows nesting depth 4 and at most 64 KiB of canonical UTF-8 JSON. Source layers are validated before merge and the effective merged config is validated again; objects deep-merge, arrays union-merge, and scalars (including `null`) override. Duplicate keys and non-JSON identifiers are rejected. Core does not interpret harness names or adapter fields; each adapter owns its block's schema and behavior. See the [Pi private-child contract](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#71-settings). |
| `delegation.max_children` | integer `1..256` | Hard cap on active direct children running in parallel per parent; settled or disposed children release capacity. Default `32`. |
| `delegation.max_concurrency` | integer `1..min(max_children, 64)` | Maximum concurrent children per parent before additional requests queue. Default `8`. |
| `delegation.max_depth` | integer `1..32` | Maximum delegation depth below root. Default `8`. |
| `delegation.max_processes` | integer `1..128` | Maximum live delegated work units across the adapter. Default `32`. |
| `runtime.journal.strict` | boolean | Make a correlated transaction fail when its journal write fails. Default `false`. |
| `runtime.journal.retention_days` | integer `1..3650` | Maximum age of detailed journal entries. Default `30`. |
| `runtime.journal.max_entries` | integer `1..10000000` | Maximum retained detailed journal entries. Default `10000`. |
| `runtime.usage.detail_retention_days` | integer `1..3650` | Maximum age of detailed usage observations. Default `30`. |
| `runtime.usage.max_observations` | integer `1..10000000` | Maximum retained detailed usage observations. Default `100000`. |
| `runtime.log.max_segment_bytes` | integer `65536..1073741824` | Rotating runtime log segment size. Default `5242880`. |
| `runtime.log.max_segments` | integer `1..100` | Number of runtime log segments to keep. Default `3`. |

Adapter blocks are optional. An unknown or invalid field is an adapter validation error, not a core DSL error; the adapter must fail closed without invalidating unrelated adapter blocks. For Pi, `settings.adapters.pi.child_inspection` is defined by [Spec 33 §7.1](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#71-settings), including its defaults, bounds, and invalid-settings recovery choice. Pi also accepts a strict `child_lifecycle` block with positive integer millisecond fields: `handshake_timeout_ms` (default 30,000; maximum 300,000), `reply_timeout_ms` (default 60,000; maximum 900,000), `settlement_inactivity_timeout_ms` (default 3,600,000; maximum 86,400,000), and `absolute_runtime_budget_ms` (default 21,600,000; maximum 604,800,000).

An agent `delegation` block may set only `max_children` and `max_concurrency`; each value may narrow but never raise the merged project setting. `max_children` limits active parallel direct children, not the lifetime number of children ever executed. Settled or disposed children release that capacity. If the project omits `max_concurrency`, effective project concurrency is clamped to `max_children`; likewise, if an agent narrows `max_children` without setting concurrency, its effective concurrency is clamped to that child cap. Omitted project fields remain absent through per-scope parsing so higher layers do not overwrite lower-layer values with defaults; unresolved values receive defaults only during engine resolution. See [Delegation Limits](delegation.md), [ADR 0008](../adr/0008-portable-delegation-budgets.md), and [Pi adapter contract](../adapters/pi.md).

Runtime retention values are finite; zero and unbounded modes are invalid. See [ADR 0011](../adr/0011-effective-adapter-readiness-and-runtime-observability.md).

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
| `{{#delegation.targets}}` | array | Iterate over eligible delegation targets |
| `{{name}}` | string | Target agent name (inside `delegation.targets`) |
| `{{description}}` | string? | Target description (inside `delegation.targets`) |
| `{{#triggers}}` | string[] | Iterate over ordered trigger strings (inside `delegation.targets`); use `{{.}}` for each value |

### Unsupported Features

Partials (`{{> footer}}`), delimiter changes, helpers, and lambdas are rejected at composition time with a typed `PromptTemplateError`.

See [Prompt Composition](prompts.md) for the full specification and [ADR 0001](../adr/0001-prompt-composition-templates.md) for the design rationale.

---

## Design Principles

- **Readable** — Non-programmers should be able to read and roughly understand a config
- **Declarative** — Describes what, not how; no control flow, no functions, no imports
- **Block-structured** — `keyword name { ... }` for named blocks; flat `key value` for scalars
- **Minimal punctuation** — No semicolons, no trailing commas, no colons for key-value pairs
- **Comments** — `#` line comments only
- **Strings** — Double-quoted; multi-line strings use triple-quote `""" ... """` (see [Multiline strings](#multiline-strings))
- **Arrays** — `["item1", "item2"]` — JSON-style for familiarity
- **Booleans** — bare `true` / `false`
- **Enums** — bare identifiers for fixed value sets (e.g. `allow`, `deny`, `ask`, `primary`, `subagent`)
- **Numbers** — bare numeric literals

---

## Implementation

The DSL is implemented in `@weaveio/weave-core`:

| Module | Responsibility |
| --- | --- |
| [`packages/core/src/lexer.ts`](../../packages/core/src/lexer.ts) | Tokenizer |
| [`packages/core/src/parser.ts`](../../packages/core/src/parser.ts) | Token stream → AST |
| [`packages/core/src/ast.ts`](../../packages/core/src/ast.ts) | AST node types |
| [`packages/core/src/schema.ts`](../../packages/core/src/schema.ts) | Zod schemas for validated config |
| [`packages/core/src/validate.ts`](../../packages/core/src/validate.ts) | AST → validated `WeaveConfig` |
| [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts) | Builtin agents declared as `.weave` DSL |
| [`packages/config/src/discovery.ts`](../../packages/config/src/discovery.ts) | Config file discovery and parsing |
| [`packages/config/src/merge.ts`](../../packages/config/src/merge.ts) | Deep merge semantics |
