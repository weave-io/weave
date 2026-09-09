# A6 — Feasibility Go/No-Go Decision

**Decision: GO**

Spec 34 (opencode2 adapter) may proceed to Phase B, subject to the spec
revisions enumerated in "Spec 34 must document" below.

Plan: [`.weave/plans/opencode2-adapter.md`](../../../.weave/plans/opencode2-adapter.md)
Full findings: [`.weave/learnings/opencode2-adapter.md`](../../../.weave/learnings/opencode2-adapter.md)

> This is a promoted, non-normative copy. The source of truth for the live
> harness output is [`.weave/feasibility/opencode2/DECISION.md`](../../../.weave/feasibility/opencode2/DECISION.md).

---

## Criteria and evidence

| # | Criterion | Verdict | Evidence pointer |
| - | --------- | ------- | ----------------- |
| 1 | Plugin loads through the real `opencode2` loader (A2) | ✓ PASS | `results.json` → `plugin.setup.invoked = true`, `plugin.cleanup.invoked = true` |
| 2 | Embedded SDK path works (A3) | ✓ PASS | `results.json` → `embedded.setup.invoked = true`, `embedded.dispose.invoked = true` |
| 3 | Required `ctx` sub-APIs behave as needed, deviations documented (A4) | ✓ PASS | `results.json` → `apiProbe.*` (8 entries, all `observed: true`); deviations recorded in each entry's `notes` field |
| 4 | `AgentEditor` can create a new agent, foreign-agent classification possible without mutation (A5) | ✓ PASS | `results.json` → `agentEditor.create.supported = true` (method: `editor.update(id, cb)` upsert); `agentEditor.foreignAgentClassification.observedWithoutMutation = true` and `.unchangedAfterTransform = true`. Full writeup: `notes/agent-editor-findings.md` |
| 5 | Command registration/execution observable without a paid model call | ✓ PASS | `results.json` → `apiProbe["command.transform"].notes`: "Before=2 commands, after transform=3 commands, probe command found=true" — no LLM call made anywhere in the harness (confirmed in `.weave/learnings/opencode2-adapter.md`, A4 closing note) |
| 6 | Version pins aligned across CLI/plugin/sdk/client | ✓ PASS | `results.json` → `harness.cliVersionPinned = "0.0.0-beta-19151"`, `harness.opencode2Version = "opencode2 v0.0.0-beta-19151"`; `notes/agent-editor-findings.md` §"Pinned versions" confirms `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opencode-ai/client`, `@opencode-ai/cli` all at `0.0.0-beta-19151` |
| 7 | No V1 package or binary installed at any point | ✓ PASS | `results.json` → `harness.v1Absent = true` |

All seven criteria pass. No criterion failed. Decision is **GO**.

---

## Spec 34 must document (normative revisions required before/alongside Phase B)

The following runtime deviations from the assumed/documented V2 behavior must
be codified as normative adapter behavior in Spec 34:

1. **Plugin entry point must be a directory.** `ConfigPluginSource.scan()`
   silently drops any `plugins` entry that resolves to a file — only
   directories containing `server.ts` or `index.ts` are accepted. Weave's
   V2 adapter plugin package must ship a directory entry point (e.g. a
   `./server` subpath export), not a single file. (Source: A2)
2. **Embedded mode must call `awaitActivation()`.** `OpenCode.create({ plugins })`
   does not run `setup()` immediately; plugins activate lazily per-location.
   The adapter's embedded-mode `init()` must call
   `host.plugin.awaitActivation()` before returning if setup effects (e.g.
   agent transforms) must be visible to the caller. (Source: A3)
3. **RPC list results are `{ location, data }` envelopes**, not bare
   arrays/values (`agent.list`, `catalog.model.list`,
   `catalog.model.default`, `skill.list`). The adapter must unwrap `.data`
   before use. (Source: A4)
4. **`event.subscribe` returns an `AsyncIterable`**, not a callback-based
   subscription, and has no `Registration`/unsubscribe function.
   Cancellation is exclusively via an `AbortSignal` passed in the options
   object; aborting ends the `for await` loop cleanly. (Source: A4)
5. **`agent.transform` (and `catalog.transform`) editor callbacks are lazy** —
   they do not run synchronously by the time the `transform()` promise
   resolves (unlike `command.transform`, whose effect is visible
   immediately via `ctx.command.list()`). Reconciliation code must not
   assume the callback has run after `await transform()`; it must confirm
   via the corresponding async RPC read (e.g. `ctx.agent.list()`) after the
   transform settles. (Source: A4)
6. **`editor.update(id, cb)` is the upsert method for both create and
   update.** `AgentEditor` has no `add()`/`create()`/`insert()`/`set()`
   method. When `id` does not already exist, `update()` seeds a fresh draft
   (matching the `@opencode-ai/schema` `Agent.Info.default(id)` shape) and
   commits it as a new agent on transform flush. This is the only supported
   creation path. (Source: A5)
7. **Config-declared agents are NOT visible inside the synchronous
   transform editor.** Agents declared only in static `config.content` /
   `opencode.jsonc` do not appear in `editor.list()`/`editor.get()` inside
   `ctx.agent.transform()` — only builtins and agents registered via some
   plugin's own `agent.transform()` appear there. Config-only agents only
   ever surface via the async RPC `ctx.agent.list()`. Weave's
   `reconcile-agent.ts` (Task C7) must cross-reference `ctx.agent.list()`
   in addition to `editor.list()` to correctly classify config-declared
   foreign agents — `editor.list()` alone is insufficient. (Source: A5)

---

## Evidence artifact index

- `results.json` — machine-readable pass/fail data for A1–A5, validated against `results.schema.json`.
- `results.schema.json` — JSON Schema describing the shape of `results.json`.
- `notes/agent-editor-findings.md` — detailed AgentEditor create/foreign-classification investigation (Task A5, hard blocker).
- [`.weave/learnings/opencode2-adapter.md`](../../../.weave/learnings/opencode2-adapter.md) — per-task learnings (A1–A5) consolidated.

## Promotion

This directory (`docs/artifacts/opencode2-feasibility/`) is the promoted,
non-normative copy of the feasibility evidence, retained for discoverability
from Spec 34. See [`README.md`](README.md) in this directory for
classification details.
