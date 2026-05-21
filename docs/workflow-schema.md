# Workflow Schema

This document describes the typed workflow schema introduced by [spec 02](specs/02-spec-workflow-schema/02-spec-workflow-schema.md). It covers field semantics, the completion method model, validation constraints, the `name`/`display_name` mapping convention, and the `__name` parser pattern that makes parameterised completion syntax possible.

**Related source files:**

- [`packages/core/src/schema.ts`](../packages/core/src/schema.ts) — all Zod schemas and inferred types
- [`packages/core/src/validate.ts`](../packages/core/src/validate.ts) — `transformStepProperties()` and `astToPlainObject()`
- [`packages/core/src/parser.ts`](../packages/core/src/parser.ts) — named block value parser enhancement
- [Spec 02](specs/02-spec-workflow-schema/02-spec-workflow-schema.md) — formal requirements and design rationale

---

## Workflow Config Fields

A workflow is declared with the `workflow <name> { }` top-level block.

| Field         | Type                        | Required | Description                                                     |
| ------------- | --------------------------- | -------- | --------------------------------------------------------------- |
| `name`        | `string`                    | no       | Internal name (set from block identifier, not the `name` field) |
| `description` | `string`                    | no       | Human-readable description of the workflow's purpose            |
| `version`     | `number` (positive integer) | **yes**  | Schema version for future migration; must be ≥ 1                |
| `steps`       | `WorkflowStep[]`            | **yes**  | Ordered list of steps; at least one step is required            |

---

## Step Fields

Each `step <name> { }` block inside a workflow produces a `WorkflowStep`.

| Field          | Type               | Required | Description                                                             |
| -------------- | ------------------ | -------- | ----------------------------------------------------------------------- |
| `name`         | `string`           | **yes**  | The step's block identifier (e.g. `step plan { }` → `"plan"`)           |
| `display_name` | `string`           | no       | Human-readable label — sourced from the inner `name "..."` property     |
| `type`         | `WorkflowStepType` | **yes**  | Execution mode: `autonomous`, `interactive`, or `gate`                  |
| `agent`        | `string`           | **yes**  | Name of the agent that runs this step                                   |
| `prompt`       | `string`           | **yes**  | Instruction sent to the agent; may contain `{{template}}` variables     |
| `completion`   | `CompletionMethod` | **yes**  | How the step signals that it is done (see below)                        |
| `inputs`       | `ArtifactRef[]`    | no       | Named artifacts this step consumes from a previous step                 |
| `outputs`      | `ArtifactRef[]`    | no       | Named artifacts this step produces for downstream steps                 |
| `on_reject`    | `OnReject`         | no       | Behaviour when a gate step rejects (only valid when `type` is `"gate"`) |

### Step Type Enum

| Value         | Meaning                                         |
| ------------- | ----------------------------------------------- |
| `autonomous`  | Agent works alone without user interaction      |
| `interactive` | User can intervene mid-step                     |
| `gate`        | Approve/reject checkpoint; supports `on_reject` |

---

## Completion Methods

The `completion` field uses a **discriminated union** keyed on `method`. There are five variants:

| Method           | Extra fields        | Description                                      |
| ---------------- | ------------------- | ------------------------------------------------ |
| `agent_signal`   | —                   | Agent emits an explicit done signal              |
| `user_confirm`   | —                   | User explicitly approves the step outcome        |
| `plan_created`   | `plan_name: string` | Agent writes a named plan file                   |
| `plan_complete`  | `plan_name: string` | Agent finishes executing a named plan            |
| `review_verdict` | —                   | Gate agent returns an approve or reject decision |

### DSL syntax

A bare identifier completion (no parameters):

```weave
completion user_confirm
```

A parameterised completion (named block value pattern — see below):

```weave
completion plan_created {
  plan_name "{{instance.slug}}"
}
```

The validator in `transformStepProperties()` maps these two forms:

- `IdentifierValue("user_confirm")` → `{ method: "user_confirm" }`
- `BlockValue(__name: "plan_created", plan_name: "...")` → `{ method: "plan_created", plan_name: "..." }`

---

## `on_reject` Constraint

`on_reject` is **only valid on `type: "gate"` steps**. Setting it on an `autonomous` or `interactive` step causes a `ValidationError` (enforced by a Zod `.refine()` on `WorkflowStepSchema`).

| Value   | Behaviour when gate rejects      |
| ------- | -------------------------------- |
| `pause` | Workflow pauses for user input   |
| `fail`  | Workflow terminates with failure |
| `retry` | Step is re-executed              |

---

## `name` vs `display_name` Mapping

The DSL has an intentional collision: every step block has a block-level identifier **and** a `name "..."` property inside. The validator disambiguates them:

| DSL source                            | Mapped field   | Example value   |
| ------------------------------------- | -------------- | --------------- |
| `step plan { }` (block id)            | `name`         | `"plan"`        |
| `name "Create plan"` (inner property) | `display_name` | `"Create plan"` |

This convention is implemented in `transformStepProperties()` in `validate.ts`. The `name` key inside the step block is re-keyed to `display_name` before Zod validation, so `WorkflowStepSchema.name` always holds the programmer-facing identifier and `display_name` holds the human label.

---

## `__name` Named Block Value Parser Pattern

### Why it exists

The DSL syntax `completion plan_created { plan_name "..." }` requires the parser to understand a value form that doesn't fit either of the two existing patterns:

- `key identifier` — produces an `IdentifierValue`
- `key { block }` — produces a `BlockValue`

The new pattern is `key identifier { block }` — an identifier immediately followed by a brace block.

### How it works

When `#parseValue()` in `parser.ts` consumes an `Identifier` token and the next token is `LBrace`, it:

1. Parses the brace block via `#parseBlockLiteral()`.
2. Prepends a synthetic `Property` with key `"__name"` and value `IdentifierValue(identifierText)` to the block's property list.
3. Returns the resulting `BlockValue`.

This means `completion plan_created { plan_name "x" }` produces:

```
BlockValue {
  properties: [
    { key: "__name", value: IdentifierValue("plan_created") },
    { key: "__name", value: StringValue("x") }
  ]
}
```

The `__name` property is a **convention** — it is not a DSL keyword, not a schema field, and not visible to end users. It is stripped by `transformStepProperties()` in the validator, which reads `__name` to set the `method` discriminant.

### General-purpose enhancement

The `identifier { block }` pattern is not specific to `completion`. Any property in any block can use it:

```weave
some_key my_method {
  param1 "value"
}
```

This produces the same `BlockValue` structure with `__name: "my_method"`. Future DSL features that need named parameterised blocks can leverage this pattern without parser changes.

---

## Artifact References

`inputs` and `outputs` are arrays of `ArtifactRef`:

```ts
type ArtifactRef = {
  name: string;
  description: string;
};
```

In the DSL:

```weave
outputs [
  { name "plan_path" description "Path to the generated plan file" }
]
```

Both `name` and `description` are required. Artifact names are used as template variables in downstream step prompts via `{{artifacts.<name>}}`.

---

## Execution Semantics

> **Implementation:** [`packages/engine/src/execution-lifecycle.ts`](../packages/engine/src/execution-lifecycle.ts) · **Boundary:** [`docs/adapter-boundary.md — Workflow Engine`](adapter-boundary.md#workflow-engine)

This section describes how the engine consumes the workflow schema at runtime. The engine drives execution through the Execution Lifecycle Surface — adapters map harness events into lifecycle calls; the engine evaluates policy and returns typed effects.

### Step Ordering

Steps are executed in declaration order. The `steps` array in `WorkflowConfig` is the authoritative sequence:

1. `startExecution` sets `currentStepName` to `steps[0].name` (the first step's block identifier).
2. `completeStep` advances to the next step by index. When the completed step is the last in the array, the engine transitions the instance to `completed`, releases the execution lease, and emits a `complete-execution` effect.
3. There is no branching or conditional routing — step order is fixed by the DSL declaration.

### Input/Output Artifact Passing

Artifacts flow between steps through the Runtime Store:

- **`outputs`** — declared on the producing step. When `completeStep` is called with `outcome: "success"`, the engine validates that every artifact named in `step.outputs` is present in `completionSignal.artifacts`. Validation is all-or-nothing: a missing artifact returns a `validation` error before any state changes. Validated artifacts are persisted via `store.instances.addArtifact()`.
- **`inputs`** — declared on the consuming step. When `dispatchStep` is called, the engine validates that every artifact named in `step.inputs` is already present in the instance's artifact store. A missing input artifact returns a `validation` error before the dispatch effect is emitted.
- Artifact names are used as template variables in downstream step prompts via `{{artifacts.<name>}}`. The engine renders `step.prompt` with the current artifact map before emitting the `RunAgentEffect`.

### Completion Method Evaluation

The `completion` field on each step declares the expected completion contract. When `completeStep` receives a `completionSignal` with a `method` field, the engine validates it against the step's declared `completion.method`:

| Method | Signal requirements | Engine behaviour |
| --- | --- | --- |
| `agent_signal` | `outcome: "success"` | Treat as success; auto-advance to next step |
| `user_confirm` | `outcome: "success"` | Treat as success; auto-advance to next step |
| `review_verdict` | `outcome: "success"`, `approved: boolean` | `approved: true` → advance; `approved: false` → apply `on_reject` policy |
| `plan_created` | `outcome: "success"` | Check `.weave/plans/<plan_name>.md` exists |
| `plan_complete` | `outcome: "success"` | Check plan file has no `- [ ]` checkboxes remaining |

A method mismatch (signal method ≠ declared method) returns a `validation` error before any state changes. When `method` is omitted from the signal, the engine skips method validation (legacy path).

### `on_reject` Handling

`on_reject` is only valid on `type: "gate"` steps. When a `review_verdict` signal arrives with `approved: false`, the engine reads `step.on_reject` and applies the corresponding policy:

| `on_reject` value | Engine action |
| --- | --- |
| `pause` | Transitions instance to `paused` status, releases the execution lease, emits `pause-execution` effect. The instance remains resumable via `resumeExecution`. |
| `fail` | Transitions instance to `failed` status (terminal), releases the execution lease, emits `complete-execution` effect. |
| `retry` | Re-dispatches the same step with a fresh `correlationId`. The instance status remains `running`; the step is not advanced. |

When `on_reject` is absent and a gate rejects, the engine defaults to `pause` behaviour.

### Prompt Template Rendering

`step.prompt` is a Mustache template rendered by the engine before the `RunAgentEffect` is emitted. Available template variables include:

- `{{instance.goal}}` — the human-readable goal for this execution
- `{{instance.slug}}` — the URL-safe slug for this execution
- `{{artifacts.<name>}}` — artifact values produced by previous steps

The rendered prompt is never included in `RunAgentEffect` directly — only `promptMetadata` (byte length) is surfaced in the effect. The raw rendered prompt is passed to the agent through the harness-owned dispatch path.

### Security Invariants

- `StepCompletionSignal` structurally excludes raw prompts, completions, transcripts, credentials, and tokens. Only `outcome`, `method`, `approved`, `message` (safe human-readable), `artifacts`, and `nextStepHint` are accepted.
- `promptMetadata` in `RunAgentEffect` carries only `byteLength` — no raw prompt text appears in emitted effects or the Runtime Store.
- `SafeMetadata` on all lifecycle inputs is validated against a credential denylist before any state changes.

---

## Complete Example

From `AGENTS.md`:

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

This produces:

```ts
{
  "secure-feature": {
    description: "Plan, implement, build, and review a feature with security audit",
    version: 1,
    steps: [
      {
        name: "plan",
        display_name: "Create implementation plan",
        type: "autonomous",
        agent: "pattern",
        prompt: "Create a detailed implementation plan for: {{instance.goal}}",
        completion: { method: "plan_created", plan_name: "{{instance.slug}}" },
        outputs: [{ name: "plan_path", description: "Path to the generated plan file" }]
      },
      {
        name: "review-plan",
        display_name: "Review the plan",
        type: "interactive",
        agent: "shuttle",
        prompt: "Review the plan at {{artifacts.plan_path}} for: {{instance.goal}}",
        completion: { method: "user_confirm" }
      },
      {
        name: "implement",
        display_name: "Execute the plan",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}",
        completion: { method: "plan_complete", plan_name: "{{instance.slug}}" },
        inputs: [{ name: "plan_path", description: "Path to the plan to execute" }]
      },
      {
        name: "security-review",
        display_name: "Security audit",
        type: "gate",
        agent: "warp",
        prompt: "Perform a security audit of all changes for: {{instance.goal}}",
        completion: { method: "review_verdict" },
        on_reject: "pause"
      }
    ]
  }
}
```
