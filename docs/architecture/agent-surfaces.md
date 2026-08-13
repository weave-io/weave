# Agent Surface Patterns

Weave defines logical agents independently of any harness UI. An adapter chooses the closest honest projection the harness can support; it does not force every harness to imitate OpenCode.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Capabilities](../reference/adapter-capabilities.md) · [Adapter Development](../guides/adapter-development.md)

---

## Logical roles are stable

A normalized descriptor preserves:

- logical name and description;
- `primary`, `subagent`, or `all` mode intent;
- composed prompt;
- ordered model intent;
- declared and resolved skills;
- category and routing metadata;
- abstract tool policy;
- delegation targets and limits.

These fields describe behavior, not a UI. A harness may render them as visible profiles, private workers, generated files, commands, modes, or task templates.

## Common harness patterns

### Multiple visible profiles

The harness exposes several selectable agents in one workspace. The adapter may materialize each primary-capable descriptor as a visible profile and subagents as delegated workers.

### One primary with private workers

The harness has one user-facing conversation and a task/subagent API. The adapter activates one primary descriptor in the main session and projects subagents through private child work.

### Session-scoped identity

A session starts with one agent identity and changing identity requires a new session or explicit switch. The adapter may bind one descriptor per session and expose a safe selector for starting or switching sessions.

### Modes and commands

The harness has one assistant surface but supports modes, commands, instruction overlays, or prompt templates. The adapter maps descriptors into explicit modes or commands and reports any loss of independent identity or tool policy as degraded readiness.

### Task-scoped workers

The harness runs remote or local tasks rather than interactive agent profiles. The adapter may materialize descriptors as task templates and map structured settlement back into lifecycle completion.

## Projection rules

### Preserve behavior before presentation

Prefer a projection that preserves prompt, model intent, skills, policy ownership, routing, and delegation semantics even if the visual shape differs.

Do not create fake UI affordances merely to resemble another harness.

### Treat `mode` as intent

- `primary` means the descriptor may own the user-facing context.
- `subagent` means it is intended for delegated work.
- `all` permits both.

`mode` does not promise tabs, menus, hotkeys, or simultaneous profiles. The adapter's capability report states what is actually available.

### Keep generated shuttles ordinary

Category shuttles are normalized descriptors. The adapter receives category metadata — name, description, and the category's ordered trigger strings — and presents it through its own routing surface. Categories carry no file patterns, so no adapter performs deterministic file routing. The adapter does not regenerate or special-case the DSL definition.

### Make downgrades explicit

If a harness cannot support one surface directly, choose a documented downgrade:

| Missing surface | Honest projection |
| --- | --- |
| Multiple primary profiles | One active primary plus explicit switch/session selection |
| Native subagents | Adapter-managed private workers, if safely emulatable |
| Agent-specific tool policy | Native harness/tool-owner authorization with declared limitation |
| Runtime callbacks | File materialization only; no lifecycle readiness claim |
| Provider acceleration seam | Carry `fast true` as inert intent, declare the capability `unsupported`, and mutate no provider request |
| Persistent workflow state | Explicit commands backed by the Runtime Store, or unsupported |
| Agent UI | Commands or generated task templates |

A downgrade never raises readiness above what runtime probes establish.

## Product role mapping

Builtin roles remain logical:

- **Loom** — user-facing orchestration and routing;
- **Shuttle** and category shuttles — delegated domain work;
- **Tapestry** — plan-driven execution;
- **Pattern** — planning;
- **Weft** — review;
- **Warp** — security review;
- **Spindle** — external research.

An adapter may expose these as profiles, commands, modes, private workers, or task templates. The role contract stays in DSL and composed prompts.

## Capability questions

Before choosing a projection, answer:

1. Can the harness show more than one primary identity?
2. Can the user switch identity without losing session state?
3. Can it start isolated child work?
4. Can child work settle with structured output?
5. Can the adapter register explicit commands?
6. Can it observe lifecycle events without intercepting unrelated behavior?
7. Who owns concrete tool authorization?
8. Can it preserve private child context and cancellation boundaries?
9. Can it surface health and degradation honestly?

These answers feed the [Adapter Capability](../reference/adapter-capabilities.md) contract. They do not change core agent semantics.

## Anti-patterns

- Making a core field mirror one harness's menu or SDK object.
- Treating `primary` as a promise of a visible tab.
- Calling a command template a native subagent.
- Claiming policy enforcement when the harness owns the decision.
- Starting workflows from ordinary chat because the harness lacks commands.
- Rebuilding prompts or category inheritance in each adapter.
- Keeping a vendor comparison table in architecture docs; concrete behavior belongs on that adapter's page and in runtime probes.

## Decision rule

Choose the smallest projection that preserves normalized behavior and can be tested in isolation. When the harness cannot provide an essential behavior, declare the gap instead of weakening the engine contract or hiding the loss from users.
