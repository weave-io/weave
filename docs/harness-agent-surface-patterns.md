# Harness Agent Surface Patterns

This note captures the current working model for how different agent harnesses
expose user-facing agents, sessions, workflows, and delegation. It exists to
preserve the reasoning behind Weave's separation of **logical agent roles** from
**adapter materialization**.

**Related:** [System Architecture](system-architecture.md) · [Adapter Boundary](adapter-boundary.md) · [Claude Code Adapter](claude-code-adapter.md) · [Adapter Readiness Status](adapter-readiness-status.md)

---

## Why This Note Exists

Weave currently models named agents such as Loom and Tapestry as separate
logical roles. That split should not be removed merely because some target
harnesses do not expose multiple user-facing primary agents.

The key design lesson from the harness survey is:

> **Many harnesses support many agent roles, but far fewer support multiple
> visible primary agents in one interactive session.**

In practice, this means adapters must decide whether a Weave `primary` agent is
materialized as:

- one item in a visible primary-agent roster
- one selectable main-session persona
- one session type among several session types
- one composite main prompt with internal modes
- or one task/PR-scoped workflow entrypoint

---

## Bottom Line

### OpenCode

OpenCode is the clearest known example of **multiple user-facing primary
agents** inside one interactive environment. Its surface supports a roster of
primary agents and explicit primary/default-agent selection.

### Claude Code

Claude Code appears to support **one active main session agent at a time**, plus
subagents, background sessions, and agent teams. It can run a named agent as
the main session persona, but that is still a single active main thread per
session rather than OpenCode-style simultaneous primaries.

### Codex

Codex appears to support **one main agent/thread**, plus subagent workflows and
custom agent definitions. The public shape is a main coordinator spawning
specialized workers, not a set of visible switchable primaries.

### Kiro

Kiro appears to be **one main agentic surface** with multiple sessions, session
types, and first-class workflow artifacts such as Specs, Hooks, Steering, and
Skills/Powers. It looks more like a workflow-centric single-primary harness than
an agent-roster harness.

### Hermes

"Hermes" is currently ambiguous and should not be treated as one adapter target
without clarification:

- **HermesIDE** looks like a multi-session coding workshop where each session
  has its own agent/model/mode/permissions/history.
- **Nous Hermes Agent** looks like a persistent autonomous agent with memory,
  skills, scheduling, MCP, and subagent behavior.

These are materially different shapes.

---

## Harness Patterns

The surveyed harnesses cluster into a few recurring patterns.

### 1. Multiple visible primaries

The harness can expose more than one directly user-facing primary agent within
the same interactive environment.

- **Best current example:** OpenCode

### 2. One active main session plus subagents

The harness exposes one main conversation/agent at a time, with additional
specialized agents running underneath or alongside it.

- **Examples:** Claude Code, Codex

### 3. One primary per session, many sessions

The harness favors multiple independent sessions rather than multiple primaries
inside one session.

- **Examples:** Claude Code background sessions / agent teams, HermesIDE,
  Windsurf concurrent conversations

### 4. One agent plus modes/workflow artifacts

The harness exposes one main assistant, but differentiates behavior through
modes, specs, hooks, commands, or workflow artifacts.

- **Examples:** Kiro, Aider, Gemini CLI, Windsurf/Cascade

### 5. Task-scoped cloud/workflow agents

The harness centers the user experience around one task/branch/PR execution
unit rather than around persistent local primaries.

- **Example:** GitHub Copilot coding agent

---

## Per-Harness Working Notes

### OpenCode

- Supports primary agents and subagents as first-class concepts.
- Multiple user-facing primaries are part of the interactive UX.
- Weave can materialize Loom and Tapestry more directly here than elsewhere.

### Claude Code

- Best understood as **one active main session** plus subagents and extra
  sessions.
- Supports named agents and background sessions.
- Supports agent teams, but those are multiple independent sessions, not one UI
  with many active primaries.

**Recommended Weave mapping:**

- Loom → default main-session persona
- Tapestry → separate execution-oriented main-session persona
- specialists → Claude subagents

This suggests a workflow where planning/routing happens in a Loom-shaped
session, then substantial plan execution happens in a Tapestry-shaped session.

### Codex

- Best understood as **one main coordinator** plus explicit subagent workflows.
- Custom agents exist, but the public model emphasizes spawned subagents rather
  than many co-equal visible primaries.

**Recommended Weave mapping:**

- one visible main Weave coordinator prompt
- internal modes: direct, plan, execute
- spawned specialists for exploration/review/audit/implementation slices

This suggests a composite main prompt rather than two visible primary agents.

### Kiro

- The important unit is the session and its type, not a roster of named
  primaries.
- Specs are durable workflow artifacts with requirements/design/tasks phases.
- Hooks, Steering, and Skills/Powers give Kiro multiple ways to inject reusable
  behavior.

**Recommended Weave mapping:**

- Loom → main Kiro chat/session behavior
- Tapestry → Specs + task execution + Hooks

Kiro looks like a strong target for workflow/spec materialization, not for
multiple-primary-agent materialization.

### HermesIDE

- Appears to be strongly session-centric.
- Each session has its own agent/model/mode/permissions/cwd/history.
- Git worktrees are first-class.

**Recommended Weave mapping:**

- Loom and Tapestry become separate sessions/worktrees when needed
- adapter should think in terms of session templates rather than one session with
  multiple primaries

### Nous Hermes Agent

- Appears to be a persistent autonomous agent rather than an IDE-native coding
  harness.
- Memory, skills, scheduling, MCP, and subagents are central.

**Recommended Weave mapping:**

- Loom → persistent orchestrator identity
- Tapestry → skill bundles, scheduled workflows, or memory-backed execution
  routines

### Windsurf / Cascade

- Looks like one assistant per conversation with Chat/Code mode differences.
- Supports multiple simultaneous conversations.
- Includes planning/checkpoint/workflow behavior internally.

**Recommended Weave mapping:**

- Loom → Cascade conversation
- Tapestry → workflow/checkpoint/planning layer inside or across conversations

### GitHub Copilot coding agent

- The natural unit is a task/branch/PR-scoped cloud execution session.
- Specialized custom agents may exist, but the UX is not centered on a local
  primary-agent roster.

**Recommended Weave mapping:**

- Loom → intake/planning for the task
- Tapestry → task execution and PR lifecycle

### Gemini CLI / Aider / similar CLI harnesses

- Commonly center one main CLI agent with commands or modes.
- Aider is a useful analogy because its architect/editor split resembles a
  constrained version of Loom/Tapestry.

**Recommended Weave mapping:**

- one primary entrypoint
- explicit modes or internal state machine
- helper roles as implementation details rather than visible primaries

---

## Implications for Weave

### 1. Keep logical roles separate in core

Weave should continue to model Loom, Tapestry, Shuttle, Weft, Warp, and custom
agents as separate logical roles even when a harness cannot expose them all as
top-level visible primaries.

### 2. Treat `mode: primary` as adapter-facing intent, not a UI guarantee

`primary` should mean something like:

> this agent is eligible to be a user-facing main entrypoint if the harness can
> support that shape.

It should **not** mean:

> every adapter must expose several switchable primary agents.

### 3. Adapters should materialize capabilities, not mimic OpenCode blindly

The adapter's job is to translate Weave's abstract roles into the target
harness's actual user experience shape. Different harnesses will require
different materializations.

### 4. The safest downgrade path is usually one of these

When a harness does not support multiple visible primaries, prefer one of:

- **selected main persona** — one agent is active as the main session at a time
- **session split** — Loom-like and Tapestry-like work happen in different
  sessions
- **composite main prompt** — one main agent with explicit internal modes:
  direct, plan, execute
- **workflow-artifact mapping** — Tapestry becomes a spec/task/checkpoint layer

---

## Recommended Adapter Capability Vocabulary

This survey suggests that adapter design should talk in capabilities such as:

- `supportsMultiplePrimaryAgents`
- `supportsMainAgentSelection`
- `supportsSubagents`
- `supportsBackgroundSessions`
- `supportsMultipleIndependentSessions`
- `supportsWorkflowArtifacts`
- `supportsHooks`
- `supportsTaskScopedExecution`

These capabilities describe the shape of the harness more precisely than a
binary "supports primaries" question.

---

## Recommended Materialization Defaults

| Harness shape | Suggested Weave materialization |
| --- | --- |
| Multiple visible primaries | Materialize Loom and Tapestry as separate visible primaries |
| One active main persona | Allow one selected main-session agent at a time |
| One main agent + subagents | Use one composite coordinator prompt with internal modes |
| Session-centric harness | Split Loom-like and Tapestry-like work across sessions |
| Workflow-centric harness | Map Tapestry into specs/tasks/checkpoints/hooks |
| Task/PR-centric harness | Map Tapestry into the task execution lifecycle |

---

## Decision Guidance

When evaluating a new adapter, ask these questions in order:

1. Can the harness expose more than one visible primary agent?
2. If not, can it select one named main-session persona at a time?
3. If not, does it support subagents or helper workers?
4. If not, does it support multiple independent sessions?
5. Does it have workflow artifacts such as specs, tasks, hooks, checkpoints, or
   branch/PR execution units?

The answers determine whether Loom and Tapestry should be materialized as:

- separate primaries
- separate session personas
- one composite main prompt
- or one workflow-oriented execution surface

---

## Current Design Recommendation

Until a target harness proves otherwise:

- keep **Loom** and **Tapestry** separate in Weave core
- let **OpenCode** expose them as visible primaries
- let **Claude Code** favor separate main-session personas or sessions
- let **Codex** favor one composite coordinator prompt
- let **Kiro** favor session/spec workflow mapping
- require clarification before designing a generic **Hermes** adapter

This preserves Weave's expressive model without forcing all harnesses to mimic
OpenCode's UX.
