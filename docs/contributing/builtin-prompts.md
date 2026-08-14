# Builtin Prompt Guidelines

Builtin agents use the same `.weave` DSL, prompt composer, and adapter path as user-defined agents. Their prompts define portable role behavior; they do not encode one harness's tools, UI, filesystem, or process model.

**Related:** [DSL](../reference/dsl.md) · [Prompt Composition](../reference/prompts.md) · [Agent Surfaces](../architecture/agent-surfaces.md) · [Agent Evals](../guides/evals.md)

---

## Contract

A builtin prompt should tell the model:

- what role it owns;
- what work belongs to another role;
- what inputs it expects;
- what a complete result contains;
- when it may act autonomously;
- when it must stop, ask, or return a structured decision;
- how delegation and tools relate to its role.

The DSL carries models, mode, skills, tool policy, triggers, and delegation metadata. Do not repeat those declarations in prose unless the behavioral consequence matters.

## Portability

Write against abstract capabilities and role outcomes.

Prefer:

- “inspect the relevant files”;
- “run the narrow validation command available in this repository”;
- “delegate to an eligible specialist”;
- “return a structured approval or rejection.”

Avoid:

- concrete harness tool names;
- keybindings, menus, callback names, or session APIs;
- OpenCode-, Claude-, Pi-, or provider-specific phrasing;
- assumptions about shell availability or working-directory layout;
- instructions to bypass adapter capability or permission decisions.

Harness-specific operating instructions belong in adapter configuration or the adapter page.

## Role boundaries

### Orchestrators

An orchestrator decomposes work, selects eligible targets, supplies context, and integrates results. It does not redo delegated work by default.

Its prompt should explain when direct execution is appropriate and when delegation reduces risk or improves focus. Eligible targets come from the rendered delegation context, not a hard-coded agent list.

### Domain workers

A worker receives a bounded task, completes it, validates it, and reports evidence. A leaf worker does not delegate unless its descriptor explicitly permits nested delegation.

### Planners

A planner turns a goal and repository evidence into an actionable plan. It does not claim implementation happened. Plans name outcomes, dependencies, risks, and validation without inventing nonexistent APIs.

### Executors

An executor follows the current approved plan and reports state changes. It does not silently revise normative inputs or approve its own artifacts.

### Reviewers and gates

A reviewer returns a clear verdict with bounded findings. It distinguishes blocking defects from suggestions and cites concrete evidence. Security gates fail closed when required evidence is absent.

### Researchers

A researcher separates sourced facts from interpretation, prefers primary sources, and reports uncertainty. It does not modify the repository unless its role and tool policy explicitly allow it.

## Autonomy and approval

Prompts must not grant authority that the engine or adapter has not granted.

- Ordinary chat cannot start durable execution.
- Tool-policy text is not a permit.
- Artifact authors cannot approve their own revisions where policy forbids it.
- A delegated child cannot inherit workflow-completion authority by implication.
- Review or security rejection follows the declared workflow reconciliation path.

Describe these as behavioral boundaries; the engine and adapter enforce them.

## Delegation context

Use Mustache context rather than copying a target table into the prompt:

```md
{{#delegation.targets}}
- **{{name}}** — {{description}}
{{#triggers}}
  - {{.}}
{{/triggers}}
{{/delegation.targets}}
```

`triggers` is an ordered list of plain strings, so render each entry with `{{.}}`. There is no `domain`, `trigger`, or `routing_hint` field, and categories carry no file patterns.

The engine renders only eligible targets after filtering disabled agents, modes, budgets, and caller identity. A primary prompt that references any real `delegation.*` path suppresses automatic fallback placement.

Keep the surrounding prose useful when no delegation target exists.

## Prompt structure

Use the shortest structure that makes the role unambiguous. Typical sections:

1. role and scope;
2. task intake or operating loop;
3. completion/decision format;
4. hard boundaries;
5. delegation context where needed.

Prefer direct verbs and observable outputs. Remove repeated reminders, motivational slogans, and generic coding advice that the agent already has from repository instructions.

## Tool and command language

Prompts describe *intent*, not a concrete invocation:

- read/inspect;
- write/change;
- execute/validate;
- delegate;
- use network research.

The descriptor's `tool_policy` and adapter own concrete mapping. If a role must never perform an action, express the behavioral prohibition and encode the same limit in DSL policy.

## Completion

A useful completion contract names:

- changed or produced artifacts;
- validation performed and results;
- unresolved risks or blockers;
- whether the requested outcome is complete;
- a structured verdict or completion signal when the workflow requires one.

Do not require fabricated certainty. If validation could not run, the agent reports that fact and its impact.

## Change workflow

When editing a builtin prompt:

1. change the builtin DSL or its prompt file—never an adapter copy;
2. inspect the composed prompt through `weave prompt inspect`;
3. update prompt snapshots;
4. add or update a focused eval case when behavior changes;
5. run the relevant core/config/engine and CLI tests;
6. update public docs only if user-visible behavior changed.

Prompt reduction should preserve role boundaries, approval rules, delegation behavior, output contracts, and security constraints. Compare behavior, not token count alone.

## Anti-patterns

- Hard-coded model or provider recommendations in prompt prose.
- Duplicated trigger tables that drift from DSL.
- Lists of concrete tool names shared across adapters.
- “Always delegate” or “never delegate” without role/context nuance.
- Long generic style guides repeated in every builtin.
- One-time benchmark findings embedded as permanent instructions.
- Prompt text that claims a tool call, workflow advance, approval, or test run occurred when it did not.

## Tests

Snapshot tests catch accidental composed-text drift. Evals cover observable role behavior. Neither replaces engine tests for delegation filtering, template rendering, policy, lifecycle authorization, or adapter projection.

See [Testing](testing.md) and [Agent Eval Guide](../guides/evals.md).
