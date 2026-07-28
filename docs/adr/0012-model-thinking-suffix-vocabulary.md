# ADR 0012 — Model Thinking Suffix Vocabulary

**Status:** Accepted

**Related:** [Models](../reference/models.md) · [DSL Reference](../reference/dsl.md#model-thinking-level-suffixes) · [Adapter Boundary](../architecture/adapter-boundary.md#models)

## Context

Weave model preferences are ordered strings. Users need to express a thinking
level for one preferred model without changing the existing `models` array
shape or making the engine depend on a harness package. The nearest target
with the richest vocabulary is Pi, whose thinking controls distinguish seven
levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Model identifiers are otherwise opaque to Weave. A delimiter must therefore
be unambiguous, and a typo must fail at config load rather than become a later
and misleading model-availability failure. A future model identifier may also
need a literal `#`.

The legacy JSONC migration format was checked for a source field that could
supply this intent. It has no `thinking` or `reasoning_effort` equivalent, so
migration cannot currently produce a suffix without inventing semantics.

## Decision

### 1. Own a seven-level vocabulary in core

Core defines the closed, harness-neutral vocabulary:

```text
off | minimal | low | medium | high | xhigh | max
```

The vocabulary is deliberately Pi-shaped rather than reduced to a smaller
`low | medium | high` abstraction. A smaller set would make Pi's `xhigh` and
`max` requests impossible to express and would lose information before an
adapter sees it. Adapters with fewer controls may clamp, emulate, degrade, or
report unsupported readiness according to their capability contract; core does
not import or duplicate a harness type.

### 2. Reserve the last unescaped `#` as the delimiter

An entry uses `model#level`. The parser selects the **last unescaped `#`**.
The sequence `\#` represents a literal hash in the base model. If an
unescaped delimiter is present, the following text MUST be exactly one of the
seven levels. Unknown or empty suffixes are hard validation errors; they are
never silently treated as model-id content.

This preserves an escape hatch without sacrificing typo detection. It also
matches the existing DSL string-escape behavior: the lexer preserves the
model-specific `\#` marker for value-level parsing, while no new lexer or AST
syntax is introduced.

## Consequences

- `models` and `review_models` remain ordered `string[]` fields, preserving the
  stable descriptor contract and existing adapter call sites.
- Core validates agent, category, and review-model entries at config-load time.
- The engine parses before availability matching, returns a base model plus
  optional `thinkingLevel`, and remains free of harness I/O.
- Adapters own concrete activation and can state capability gaps explicitly.
- A model entry with a literal hash must use `\#`; unescaped hashes are reserved
  for suffix syntax.
- `gpt-4o#high` and `gpt-4o` remain distinct raw strings under existing
  union-merge semantics. The merge does not replace an entry by parsed base
  model.
- Review variant names exclude the suffix. Same-base review entries at
  different levels therefore collide and fail closed through the existing
  review-variant conflict path.
- The legacy converter remains unchanged and emits no suffix because no legacy
  equivalent exists. A future legacy mapping requires a separate decision.

## Rejected alternatives

### A smaller abstract vocabulary

Rejected because it cannot represent Pi's richer seven-level control without
lossy compression. Coarser adapters can handle a richer intent vocabulary
through their declared readiness behavior more safely than core can invent
unreachable values for a richer adapter.

### Treat unknown suffixes as literal model IDs

Rejected because a typo such as `#hgih` would be hidden until a downstream
availability check and produce a confusing model-not-found result. Literal
hashes have the explicit `\#` escape.

### Change descriptor entries to `{ model, thinkingLevel }` objects

Rejected because it would break the stable `AgentDescriptor.models: string[]`
contract and every adapter that consumes ordered raw model intent. Parsing is
kept at validation/resolution boundaries instead.

### Put thinking activation in the engine

Rejected because the engine cannot know whether a harness exposes a thinking
setting or how to call it. Concrete activation and feature-gap handling belong
to adapters under the [Adapter Boundary](../architecture/adapter-boundary.md).
