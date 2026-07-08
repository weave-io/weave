# Prompt Composition

Weave composes each agent's final prompt in the engine layer before handing the
agent to an adapter. The output of that composition step is an
`AgentDescriptor`: a normalized, harness-agnostic record containing the final
prompt text plus the other adapter-facing fields derived during composition.

**Related:** [ADR 0001: Prompt Composition Templates](adr/0001-prompt-composition-templates.md) · [Adapter Boundary](adapter-boundary.md) · [Config Loading](config-loading.md) · [Tool Policy Evaluation](tool-policy-evaluation.md) · [Agent Guide / neverthrow rules](../AGENTS.md) · [Context Glossary](../CONTEXT.md) · [CLI — `weave prompt self-modify`](cli.md#weave-prompt-self-modify)

---

## Purpose

Prompt composition is engine-owned because it is a pure interpretation of Weave
config, not a harness concern.

The engine is responsible for:

- loading the configured prompt source (Markdown format)
- rendering `prompt` / `prompt_file` and `prompt_append` / `prompt_append_file` as Mustache Prompt Templates
- generating delegation targets from the agent's `triggers` config
- appending `prompt_append` or `prompt_append_file` text after the rendered primary source
- evaluating abstract tool policy into `EffectiveToolPolicy`
- returning a normalized descriptor adapters can consume directly

Adapters are responsible for materializing that descriptor inside a concrete
harness. They do not re-implement prompt composition rules.

This boundary follows [Adapter Boundary](adapter-boundary.md): the engine owns
prompt composition because the rules are reusable, deterministic, and free of
harness-specific assumptions.

### When to read this doc

Read this doc **before** making any change that touches:

- `prompt` or `prompt_file` values in an agent or category block
- `prompt_append` or `prompt_append_file` values in an agent, category, or workflow block
- Mustache template tags in any prompt source
- Delegation section rendering (`{{{delegation.section}}}`, `{{#delegation.targets}}`)

The `weave prompt self-modify` guide enforces this: it lists `docs/prompt-composition.md` as a required pre-read for prompt-related changes. See [CLI — `weave prompt self-modify`](cli.md#weave-prompt-self-modify).

### Builtin prompt files

Builtin prompt files (shipped in `packages/config/prompts/`) are Markdown
documents. They are product-level defaults, not Weave-repo policy carriers, and
they should remain skill-agnostic unless and until skill content becomes part of
the composed prompt contract.
They should:

- state the agent's abstract behavioral boundaries (e.g. read-only, planning-only,
  review-only, no delegation) in human-readable terms; `toolPolicy.effective`
  is available to templates, but prompts should not rely on permission metadata
  alone to explain behavior
- include compact output-shape guidance where handoff format matters (e.g.
  asking for concise top-level `APPROVE` / `BLOCK` review verdict wording)
- use Template Context fields only where they improve prompt clarity; do not add
  artificial tags just to prove templating
- use `{{#delegation.targets}}` loops to render delegation routing guidance
  where it matters; do not hand-copy target lists that could diverge from config

---

## `AgentDescriptor`

`composeAgentDescriptor()` returns this descriptor shape:

```ts
interface AgentDescriptor {
  name: string;
  displayName?: string;
  description?: string;
  category?: AgentDescriptorCategory;
  composedPrompt: string;
  models: string[];
  mode: "primary" | "subagent" | "all";
  temperature?: number;
  effectiveToolPolicy: EffectiveToolPolicy;
  rawToolPolicy: ToolPolicy | undefined;
  delegationTargets: DelegationTarget[];
  skills: string[];
}

interface AgentDescriptorCategory {
  name: string;
  description?: string;
  patterns: string[];
}

interface DelegationTarget {
  name: string;
  description?: string;
  triggers: DelegationTrigger[];
}
```

### Field meanings

| Field | Meaning |
| --- | --- |
| `name` | Stable harness-neutral internal id for the logical agent being composed. |
| `displayName` | Optional presentation metadata from agent `display_name`; not a stable id. |
| `description` | Optional agent description passed through from config. |
| `category` | Optional metadata for generated category shuttles: category name, optional description, and declared patterns only. Omitted for regular agents. |
| `composedPrompt` | Final prompt text after prompt loading, delegation section formatting, and `prompt_append` composition. |
| `models` | Ordered model preference intent from config, defaulting to `[]`; availability and selected-model lookup are adapter-owned. |
| `mode` | Adapter-facing mode hint, defaulting to `"subagent"` when omitted. |
| `temperature` | Optional temperature passed through unchanged. |
| `effectiveToolPolicy` | Fully-resolved abstract tool policy computed by `evaluateEffectiveToolPolicy()`. See [Tool Policy Evaluation](tool-policy-evaluation.md). |
| `rawToolPolicy` | Original declared `tool_policy`, or `undefined` when absent. |
| `delegationTargets` | Filtered list of eligible delegation targets, used both for prompt composition and adapter-side routing if needed. |
| `skills` | Requested skill names passed through unchanged; resolved skill payloads, paths, and contents are adapter-owned and not descriptor fields. |

---

## Composition Pipeline

`composeAgentDescriptor(agentName, agentConfig, config, allAgents)` runs this
pipeline:

1. **Build delegation targets**
   - Delegation targets are computed first from `allAgents`.
   - If `agentConfig.tool_policy?.delegate !== "allow"`, the list is empty.

2. **Load prompt source**
   - If `agentConfig.prompt` is defined, use it directly.
   - Otherwise read `agentConfig.prompt_file` from disk.
   - If neither exists, return `PromptSourceMissingError`.
   - If file reading fails, return `PromptFileReadError`.

3. **Build Template Context**
   - The engine projects config and computed routing data into a bounded Template
     Context.
   - The context includes public agent identity, optional category identity,
     effective tool policy, and generated delegation fields.

4. **Render prompt templates**
   - The primary prompt source is rendered as Mustache.
   - If `prompt_append` is present, it is rendered as Mustache using the same
     Template Context.
   - If `prompt_append_file` is present (and `prompt_append` is absent), the
     file is read from disk and rendered as Mustache using the same Template
     Context. `prompt_append` and `prompt_append_file` are mutually exclusive.

5. **Resolve tool policy**
   - The engine calls `evaluateEffectiveToolPolicy(agentConfig.tool_policy)`.
   - This produces a complete `EffectiveToolPolicy` with all five abstract
     capabilities resolved. See [Tool Policy Evaluation](tool-policy-evaluation.md).

6. **Assemble the descriptor**
   - The engine returns an `AgentDescriptor` containing the composed prompt,
     delegation targets, resolved policy, raw policy, passthrough metadata, and
     declared skills.

The implementation lives in
[`packages/engine/src/compose.ts`](../packages/engine/src/compose.ts).

---

## Delegation Filtering Rules

Delegation targets are included only when delegation is explicitly allowed for
the composing agent.

Current filtering rules:

1. **Exclude self**
   - An agent cannot delegate to itself.

2. **Exclude disabled agents**
   - Any agent listed in `config.disabled.agents` is removed.

3. **Exclude `mode: "primary"` agents**
   - Primary agents are not treated as delegation targets.

4. **Exclude shared/category shuttle targets when composing shuttle agents**
   - If the target name starts with `shuttle-` and the composing agent is either
     `shuttle` or already a `shuttle-*` agent, that target is excluded.
   - This prevents the shared shuttle agent and generated category shuttles from
     advertising one another as delegation targets.

These rules are engine-owned because they define normalized delegation topology,
not harness behavior.

---

## Prompt Templates

Agent `prompt`, `prompt_file`, `prompt_append`, and `prompt_append_file` values are Prompt Templates.
The engine renders them with the canonical `mustache` package behind a Weave
wrapper before adapters receive the `Composed Prompt`.

Supported first-slice Mustache features:

- escaped variables with `{{path}}`
- unescaped variables with `{{{path}}}` for Markdown-rich values
- dotted names such as `{{agent.name}}`
- sections and inverted sections for conditionals and list iteration
- comments
- current item rendering with `{{.}}`

Unsupported features fail composition with typed template errors:

- partials such as `{{> footer}}`
- delimiter changes such as `{{=<% %>=}}`
- lambdas, helpers, function calls, executable behavior, filesystem access, or
  environment access

Use a backslash to render a literal tag opening. For example, `\{{agent.name}}`
renders as `{{agent.name}}` and does not count as a template reference.

Double braces use canonical Mustache HTML escaping. Markdown-rich values should
be rendered with triple braces to avoid unwanted HTML escaping.

---

## Template Context

The Template Context is a bounded public projection, not raw `WeaveConfig` or
`AgentConfig`. Schema-aware strict rendering uses an explicit allowed-path list
so typos fail while allowed optional paths may be absent and falsey.

First-slice context fields:

```ts
interface AgentPromptTemplateContext {
  agent: {
    name: string;
    description?: string;
    mode: "primary" | "subagent" | "all";
    skills: string[];
    isCategory: boolean;
  };
  category?: {
    name: string;
    description?: string;
  };
  toolPolicy: {
    effective: {
      read: "allow" | "deny" | "ask";
      write: "allow" | "deny" | "ask";
      execute: "allow" | "deny" | "ask";
      delegate: "allow" | "deny" | "ask";
      network: "allow" | "deny" | "ask";
    };
  };
  delegation: {
    targets: Array<{
      name: string;
      description?: string;
      domains: string[];
      triggers: Array<{ domain: string; trigger: string; routing_hint?: string }>;
    }>;
  };
}
```

`agent.isCategory` is true only for agents generated from `category` blocks, such
as `shuttle-frontend`. For non-category agents, `category` is omitted and can be
tested with normal Mustache sections:

```md
{{#category}}
This is the {{name}} category shuttle.
{{/category}}
```

Inside list sections, standard Mustache context-stack semantics apply. For
example, inside `{{#delegation.targets}}`, `{{name}}` resolves to the current
target name. Scalar lists such as `agent.skills` can render items with `{{.}}`.

---

## Delegation Targets

When at least one delegation target survives filtering, the engine populates
`delegation.targets` in the Template Context. Prompt templates can iterate over
this list to render routing guidance in any format they choose.

Example using a `{{#delegation.targets}}` loop:

```md
## Delegation

{{#delegation.targets}}
- **{{name}}**{{#description}} — {{description}}{{/description}}
{{/delegation.targets}}
```

If there are no eligible targets, `delegation.targets` is an empty array and
any `{{#delegation.targets}}` section renders nothing.

---

## Composition Order

### Agent prompt composition

Final agent prompt text is assembled in this order:

1. rendered primary prompt source (`prompt` or `prompt_file`)
2. rendered append source (`prompt_append` or `prompt_append_file`), when present

`prompt_append` and `prompt_append_file` are mutually exclusive — only one may
be declared per agent or category block. Both are resolved and rendered using
the same Template Context as the primary source.

There is no automatic fallback delegation block. Delegation guidance must be
explicitly placed in the prompt source using `{{#delegation.targets}}` loops.

### Workflow step prompt composition

`composeWorkflowStepPrompt()` assembles the final prompt for a single workflow
step. It applies the same Mustache rendering pipeline as agent composition, but
uses a bounded `AgentPromptTemplateContext` supplied by the caller rather than
loading agent config from disk.

**Composition order** (step prompt → effective append):

```text
[rendered step.prompt]

[rendered effective append]
```

The two parts are joined with `\n\n`. If there is no effective append, the step
prompt is returned as-is.

**Append precedence rules** (step-local wins):

| Step has append? | Workflow has append? | Effective append | `appendScope` |
| --- | --- | --- | --- |
| yes | any | step's append | `"step"` |
| no | yes | workflow's append | `"workflow"` |
| no | no | — | `"none"` |

Step-local precedence means a step's own `prompt_append` / `prompt_append_file`
completely suppresses the workflow-level append for that step. The workflow-level
append is only applied when the step declares no append of its own.

**Concrete example** — step-local wins:

```weave
workflow secure-feature {
  version 1
  prompt_append "Always write tests."   # workflow-scope append

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Execute the plan."
    prompt_append "Focus on security."  # step-scope append — wins
    completion agent_signal
  }
}
```

For the `implement` step the composed prompt is:

```text
Execute the plan.

Focus on security.
```

The workflow-level `"Always write tests."` is suppressed for this step.

**Concrete example** — workflow fallback:

```weave
workflow secure-feature {
  version 1
  prompt_append "Always write tests."   # workflow-scope append

  step review {
    name "Review"
    type gate
    agent weft
    prompt "Review the changes."
    # no step-scope append — workflow fallback applies
    completion review_verdict
    on_reject pause
  }
}
```

For the `review` step the composed prompt is:

```text
Review the changes.

Always write tests.
```

**`appendScope` field**: `composeWorkflowStepPrompt()` returns a
`WorkflowStepComposedPrompt` with two fields:

```ts
interface WorkflowStepComposedPrompt {
  composedPrompt: string;
  appendScope: "step" | "workflow" | "none";
}
```

`appendScope` tells callers which scope the effective append came from, enabling
tooling to surface diagnostic information without re-inspecting the config.

---

## Same-Scope Collision Surfacing

When multiple configs in the merge stack (e.g. global + project) both define
`prompt_append` or `prompt_append_file` for the same workflow or step, the
config-merge layer silently applies last-defined-wins. `detectAppendCollisions()`
makes that resolution visible so tooling can warn users.

```ts
function detectAppendCollisions(configs: WeaveConfig[]): AppendCollision[]
```

`configs` is an ordered list from lowest to highest priority (e.g.
`[builtins, globalConfig, projectConfig]`). The function is pure and never
throws.

```ts
interface AppendCollision {
  scope: "workflow" | "step";
  workflowName: string;
  stepName?: string;                          // only when scope === "step"
  field: "prompt_append" | "prompt_append_file";
  losingValue: string;                        // overridden value
  winningValue: string;                       // value that won
  loserIndex: number;                         // index in configs array
  winnerIndex: number;                        // index in configs array
}
```

**Example** — two configs both define a workflow-level append:

```ts
const collisions = detectAppendCollisions([globalConfig, projectConfig]);
// → [{
//     scope: "workflow",
//     workflowName: "secure-feature",
//     field: "prompt_append",
//     losingValue: "Always write tests.",   // from globalConfig
//     winningValue: "Focus on security.",   // from projectConfig
//     loserIndex: 0,
//     winnerIndex: 1,
//   }]
```

A collision is reported only when **two or more** configs in the list define the
same field for the same workflow/step. A single config defining an append is not
a collision. The function returns an empty array when there are no collisions.

---

## Trust Boundary for Prompt Appends

Both agent-level and workflow/step-level appends are rendered against the
**bounded `AgentPromptTemplateContext`** — the same context used for primary
prompts. This is a deliberate security boundary.

**What appends can reference** (bounded paths only):

- `{{agent.name}}`, `{{agent.mode}}`, `{{agent.skills}}`, `{{agent.isCategory}}`
- `{{category.name}}`, `{{category.description}}`
- `{{toolPolicy.effective.read}}` (and other capability fields)
- `{{#delegation.targets}}` iteration

**What appends cannot reference** (rejected as `UnknownPath`):

- `{{artifact.contents}}` — artifact data is not in the bounded context
- `{{chat.history}}` — chat history is not in the bounded context
- `{{raw.prompt}}` — raw prompt text is not in the bounded context
- Any path not in the explicit `ALLOWED_TEMPLATE_PATHS` set

**What appends cannot use** (rejected as `UnsupportedFeature`):

- `{{> partial}}` — partials cannot load external content
- `{{= <% %> =}}` — delimiter changes cannot bypass path validation

**What appends cannot traverse** (rejected as `UnsafePath`):

- `{{__proto__}}`, `{{constructor}}`, `{{prototype}}` — prototype traversal

Static append text without Mustache tags is always safe and passes through
unchanged.

This boundary is enforced at render time by the same `renderTemplate()` wrapper
used for primary prompts. There is no separate code path for appends — the same
allowed-path set applies to both.

---

## Template Errors

Template failures are reported as `ComposeError` with a `PromptTemplateError`
variant and a nested reason such as malformed syntax, unsupported tag, unknown
path, unsafe path, function value, section mismatch, or unresolved rendered tag.

Template errors include:

- `agentName`
- `sourceKind`: `prompt`, `prompt_file`, `prompt_append`, or `prompt_append_file`
- `promptFilePath` when `sourceKind` is `prompt_file` or `prompt_append_file`
- line/column where available
- the offending tag/path when available

`prompt_append` and `prompt_append_file` errors report line/column in the
append text. The first slice does not preserve base-vs-category append fragment
provenance.

Because rendering uses schema-aware strict paths:

- `{{agent.name}}` succeeds
- `{{agnt.name}}` fails as an unknown path
- `{{#category}}...{{/category}}` is valid and falsey for non-category agents
- `{{agent.__proto__}}` and `{{constructor.name}}` fail as unsafe paths

Rendered output is also checked for unresolved unescaped Mustache tags. Escaped
literal tags produced from `\{{...}}` are allowed.

---

## Compatibility with Existing Prompts

Existing static prompts remain valid because every prompt source is rendered as a
Prompt Template, but sources without Mustache tags render to the same text.

Workflow step prompts are rendered using the same Mustache renderer and the same
bounded `AgentPromptTemplateContext`. The caller supplies the context; the engine
does not re-derive it from config during step composition. This keeps step
rendering deterministic and testable without disk access.

---

## Skills Extension Point

`skills` is currently a passthrough field on `AgentDescriptor`.

The current composition phase does **not** resolve, load, or filter skills. It
simply copies `agentConfig.skills ?? []` onto the descriptor so downstream code
has a stable place to read declared skill intent.

This is an intentional extension point for issue #12. The planned direction is:

- skill discovery/loading remains adapter-owned
- skill matching/filtering remains engine-owned
- resolved skills will become an additional composition phase before delegation

That future work must continue to respect the ownership rules in
[Adapter Boundary](adapter-boundary.md).

---

## Adapter Consumption

Adapters receive the composed descriptor via
`HarnessAdapter.spawnSubagent(descriptor)`.

They are expected to consume these fields as follows:

- `descriptor.composedPrompt` — final prompt string to write into the harness
- `descriptor.effectiveToolPolicy` — resolved abstract capability policy for
  concrete tool-permission mapping
- `descriptor.rawToolPolicy` — original declared policy if the harness needs the
  raw values
- `descriptor.models` — ordered model intent for adapter-side model selection
- `descriptor.delegationTargets` — normalized routing metadata if the harness
  needs additional delegation setup

`RunAgentEffect` also carries the full `agentDescriptor` immediately before the
adapter spawn call, alongside `effectiveToolPolicy` and `rawToolPolicy`. See
[`packages/engine/src/run-agent-effects.ts`](../packages/engine/src/run-agent-effects.ts).

---

## Error Handling

Prompt composition follows the repository rule that fallible logic returns
`neverthrow` results rather than throwing expected errors. See the
[Agent Guide / neverthrow rules](../AGENTS.md).

`composeAgentDescriptor()` returns:

```ts
ResultAsync<AgentDescriptor, ComposeError>
```

`ComposeError` includes prompt-source, prompt-file, and prompt-template failure
variants:

```ts
type ComposeError =
  | {
      type: "PromptSourceMissingError";
      agentName: string;
      message: string;
    }
  | {
      type: "PromptFileReadError";
      agentName: string;
      promptFilePath: string;
      message: string;
      fileErrorMessage: string;
    }
  | {
      type: "PromptTemplateError";
      agentName: string;
      sourceKind: "prompt" | "prompt_file" | "prompt_append" | "prompt_append_file";
      promptFilePath?: string;
      message: string;
      reason:
        | { kind: "MalformedSyntax"; message: string; line?: number; column?: number }
        | { kind: "UnsupportedTag"; tag: string; message: string }
        | { kind: "UnknownPath"; path: string; message: string }
        | { kind: "UnsafePath"; path: string; message: string }
        | { kind: "FunctionValue"; path: string; message: string }
        | { kind: "SectionMismatch"; message: string }
        | { kind: "UnresolvedTag"; tag: string; message: string };
    }
  | {
      type: "TemplateContextBuildError";
      agentName: string;
      message: string;
    };
```

### `PromptSourceMissingError`

Returned when an agent declares neither inline `prompt` nor `prompt_file`.

### `PromptFileReadError`

Returned when the configured prompt file cannot be read. The error includes the
logical `agentName`, the attempted `promptFilePath`, a human-readable `message`,
and `fileErrorMessage` — a serializable string extracted from the underlying
read failure (`cause instanceof Error ? cause.message : String(cause)`).

### `PromptTemplateError`

Returned when Mustache parsing, strict path validation, unsupported-feature
validation, rendering, or rendered-output checks fail. The error identifies the
logical source (`prompt`, `prompt_file`, `prompt_append`, or `prompt_append_file`)
and maps library or wrapper failures into a typed nested reason.

Because composition returns `ResultAsync`, callers can compose prompt loading
with the rest of the engine pipeline without `try/catch` control flow.

---

## Source Files

| File | Contents |
| --- | --- |
| [`packages/engine/src/compose.ts`](../packages/engine/src/compose.ts) | `AgentDescriptor`, `DelegationTarget`, `ComposeError`, `composeAgentDescriptor()`, `composeWorkflowStepPrompt()`, `detectAppendCollisions()`, `AppendCollision`, `AppendScope`, `WorkflowStepComposedPrompt` |
| `packages/engine/src/template-renderer.ts` | Mustache wrapper, parse/render helpers, reference extraction, unsupported-feature and unresolved-tag checks |
| `packages/engine/src/template-context.ts` | Agent prompt Template Context types, `ALLOWED_TEMPLATE_PATHS`, delegation target projection |
| [`packages/engine/src/run-agent-effects.ts`](../packages/engine/src/run-agent-effects.ts) | `RunAgentEffect` carrying the composed descriptor |
| [`packages/engine/src/tool-policy.ts`](../packages/engine/src/tool-policy.ts) | `evaluateEffectiveToolPolicy()` and `EffectiveToolPolicy` |
