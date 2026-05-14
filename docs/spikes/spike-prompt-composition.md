# Spike: Prompt Composition Findings

**Related:** [Product Vision](../product-vision.md) · [Adapter Boundary](../adapter-boundary.md) · [`composeAgentDescriptor()`](../../packages/engine/src/compose.ts)

## Summary

This spike proved that Weave can take `.weave` agent config, compose a fully assembled prompt in the engine, and hand a normalized `AgentDescriptor` to multiple adapters that then emit working harness-specific agent files. It also clarified that the engine/adapters boundary described in [Adapter Boundary](../adapter-boundary.md) is the right one for prompt composition: the engine should own the final prompt string, while adapters should own only harness formatting and tool translation.

## What was built

The spike introduced an intermediate engine-owned `AgentDescriptor` in [`packages/engine/src/compose.ts`](../../packages/engine/src/compose.ts) with the fields adapters actually needed:

- `name`
- `description`
- `composedPrompt`
- `models`
- `mode`
- `temperature`
- `toolPolicy`
- `delegationTargets[]`

The engine now composes that descriptor through `composeAgentDescriptor()` by:

1. reading `prompt_file` content from disk,
2. deriving delegation targets from sibling agents when `delegate: allow`,
3. appending an engine-generated `## Delegation` section,
4. appending any `prompt_append` text.

`WeaveRunner` was updated to compose one `AgentDescriptor` per agent before calling the adapter, and `HarnessAdapter.spawnSubagent` changed from `(name, AgentConfig)` to `(name, AgentDescriptor)`.

Two spike adapters then proved the descriptor was sufficient:

- `OpenCodeAdapter` now collects descriptors in memory and exposes an OpenCode plugin `config` hook that registers `agent[name]` entries with mapped `mode`, `model`, `description`, `prompt`, and a boolean tools map.
- `PiAdapter` now collects descriptors in memory and exposes a Pi extension factory that returns the primary descriptor's `composedPrompt` from `before_agent_start`, registers a Weave-managed `delegate` tool, maps Weave tool policy to Pi active tools, and delegates subprocess runs with Pi's real CLI flags by writing the composed prompt to a temporary file consumed via `--append-system-prompt`. Because Pi loads the extension through a Node.js-compatible loader (`jiti`), the spike entrypoint and temp-file write path use `node:fs/promises` rather than Bun-only file APIs.

The spike also included `scripts/spike-compose.ts`, a runnable CLI that composes spike agent descriptors for both harnesses from the same input config, then simulates adapter-owned registration without writing files.

For live harness validation, the spike now also includes two harness entry points that run the same parse → resolve → filter → rename → materialize pipeline directly from the project root:

- `scripts/spike-opencode-plugin.ts` returns OpenCode plugin hooks.
- `scripts/spike-pi-extension.ts` executes a Pi extension factory. It reads `.weave/config.weave` via `node:fs/promises/readFile` instead of `Bun.file()` so the bundled extension can run correctly when Pi evaluates it in a Node.js-compatible context.

Those entry points intentionally rename the source `loom` and `thread` agents to `loom-v2` and `thread-v2` before adapter materialization so the spike can coexist with the real built-in Weave agents in a live harness session.

## Key findings

### 1. The end-to-end loop works

The full pipeline worked as intended:

`.weave` DSL → engine composition → adapter translation → working OpenCode plugin config mutations and Pi extension registration.

That is the strongest evidence from the spike: prompt composition is viable as an engine concern and does not require harness-specific structure in the descriptor.

### 2. `AgentDescriptor` with a single composed prompt string was sufficient

Neither adapter required prompt internals beyond a ready-to-write `composedPrompt` string. The adapters only needed normalized metadata plus the final body text, which supports the product direction in [Product Vision](../product-vision.md): Weave should expose composition APIs that return normalized output, not partially assembled harness-specific structures.

### 3. Tool policy translation is adapter-owned

The same abstract `toolPolicy` intent had to be translated differently per harness:

- OpenCode uses a boolean map.
- Pi uses a comma-separated list of tool names.

This confirms that concrete tool naming and permission shape belong to adapters, not the engine.

### 4. Delegation works as composed prompt text

The engine-generated `## Delegation` section was picked up naturally by both harnesses when emitted as part of `composedPrompt`. No adapter needed to understand delegation semantics beyond optionally using `delegationTargets` for its own translation work.

### 5. The boundary is correct: engine composes, adapters format

The spike validated the intended boundary:

- the engine owns full prompt composition and normalized descriptor production,
- adapters own frontmatter/file format generation and harness-specific tool translation.

That keeps prompt logic reusable across harnesses and keeps adapters thin.

## Open questions / gaps discovered

### 1. Delegation section duplication

The engine currently appends a `## Delegation` section, but the base Loom prompt already contains a `## Delegation Table` section. The real implementation must choose one source of truth:

- either the engine replaces or augments a placeholder section in the base prompt,
- or base prompts stop embedding delegation tables and rely on engine composition only.

Without that decision, prompt output risks duplicated or conflicting delegation guidance.

### 2. Delegation target selection is too broad

`AgentDescriptor.delegationTargets` is currently derived from all non-disabled sibling agents whenever `delegate: allow` is set. That is acceptable for a spike, but not for production behavior. Loom should delegate only to the agents relevant to its routing policy (for example Thread, Shuttle, and other intentional targets), not every agent in config.

The real implementation needs trigger-based or policy-based filtering rather than simple inclusion of every eligible sibling.

### 3. Tool policy translation needs a formal mapping table

The spike showed that abstract tool keys such as `read`, `write`, `execute`, `network`, and `delegate` do not map uniformly across harnesses. The real implementation needs an explicit translation table per adapter so the mapping is reviewable, testable, and documented.

### 4. `HarnessAdapter` migration is breaking

Changing `spawnSubagent` from `(name, AgentConfig)` to `(name, AgentDescriptor)` is the correct architectural direction, but it is a breaking interface change. The production implementation needs a deliberate migration plan for any existing adapter code and tests still expecting raw config.

### 5. Skills are not yet part of composition

Skills were deferred in this spike. When skill support lands, `composeAgentDescriptor()` will need a skill injection step before the delegation section is appended, so prompt composition order stays deterministic and adapter-independent.

## Recommendations for the real implementation

1. **Keep `AgentDescriptor` as the adapter-facing engine output.** The spike showed adapters do not need a richer prompt AST; a composed string plus normalized metadata is enough.
2. **Keep prompt composition engine-owned.** Continue treating prompt assembly as a pure engine concern aligned with [Adapter Boundary](../adapter-boundary.md), with adapters limited to formatting and materialization.
3. **Define one delegation composition strategy.** Pick a single source of truth for delegation text: placeholder replacement in base prompts or engine-owned section generation, but not both.
4. **Replace broad delegation discovery with routing-aware filtering.** Build delegation targets from declared triggers or an explicit routing policy instead of all non-disabled sibling agents.
5. **Document adapter translation contracts.** Add a formal per-adapter mapping table for tool policy keys and output shape so future adapters can implement the same boundary consistently.
6. **Plan the `HarnessAdapter` migration explicitly.** Update adapters, mocks, and interface docs together so the descriptor-based contract lands cleanly.
7. **Insert skills into the composition pipeline before delegation.** When skill resolution ships, make it an explicit engine composition phase before delegation text and `prompt_append`.

Taken together, the spike supports moving forward with engine-owned prompt composition as a real architecture direction, with the main remaining work centered on routing precision, adapter translation formalization, and composition-order rules.
