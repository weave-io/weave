# Task 04 Proof Artifact — Surface Effective Policy in Run-Agent Effects and Category Shuttles

## Task Summary

Task 4 wires the pure evaluation helpers from Tasks 1–3 into the runner, adds an
observable effects channel (`onEffect`), extends tests for category shuttle policy
inheritance/override, and writes documentation.

Sub-tasks completed:
- **4.1** — Created `packages/engine/src/run-agent-effects.ts` with `RunAgentEffect` discriminated union
- **4.2** — Added optional `onEffect` callback to `WeaveRunnerOptions` (non-breaking)
- **4.3** — Runner evaluates and emits effective policy per agent; raw policy passed to adapter unchanged
- **4.4** — Extended `runner.test.ts` with 18 new tests (32 total, up from 14)
- **4.5** — Exported `RunAgentEffect` and `WeaveRunnerOptions` from `packages/engine/src/index.ts`
- **4.6** — Created `docs/tool-policy-evaluation.md`
- **4.7** — Linked from `docs/adapter-boundary.md` and `docs/product-vision.md`
- **4.8** — Confirmed `adapter.ts` unchanged (non-breaking)
- **4.9** — Full CI passes

---

## What This Task Proves

1. `RunAgentEffect` is a discriminated union with `kind: 'run-agent'`, `agentName`,
   `effectiveToolPolicy`, and `rawToolPolicy`.
2. `WeaveRunnerOptions.onEffect` is optional — existing callers without it continue
   to work unchanged.
3. The runner calls `evaluateEffectiveToolPolicy` per agent and emits `RunAgentEffect`
   via `onEffect` before calling `adapter.spawnSubagent`.
4. Raw `tool_policy` is passed to the adapter unchanged (not replaced by effective policy).
5. Category shuttle agents (`shuttle-{category}`) have their category's `tool_policy`
   evaluated and emitted the same way as regular agents.
6. Agents with no `tool_policy` produce `effectiveToolPolicy` with all capabilities
   defaulting to `"ask"` and `rawToolPolicy: undefined`.
7. No harness-specific tool names appear in any emitted effect or test fixture.
8. `adapter.ts` (`HarnessAdapter` interface) is unchanged — non-breaking confirmed.

---

## Evidence: Full CI Output

```
$ bun run lint && bun run typecheck && bun run build && bun run test

# lint
Checked 78 files in 20ms. No fixes applied.

# typecheck
@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0

# build
@weave/core build: Bundled 88 modules in 27ms — index.js 0.58 MB
@weave/engine build: Bundled 117 modules in 16ms — index.js 0.70 MB
@weave/config build: Bundled 125 modules in 16ms — index.js 0.72 MB
@weave/cli build: Bundled 151 modules in 15ms
@weave/adapter-opencode build: Bundled 1 module in 3ms

# test
@weave/core test:  130 pass, 0 fail
@weave/config test:  43 pass, 0 fail
@weave/engine test:  256 pass, 0 fail
@weave/cli test:  68 pass, 0 fail

Total: 512 pass, 0 fail
```

---

## Code Review

### `adapter.ts` unchanged (non-breaking confirmed)

`packages/engine/src/adapter.ts` was not modified. The `HarnessAdapter` interface
still has:

```ts
spawnSubagent(name: string, config: AgentConfig): Promise<void>;
```

The runner passes `agentConfig` (the raw `AgentConfig` including its `tool_policy`
field) to `adapter.spawnSubagent` unchanged. The engine-computed `effectiveToolPolicy`
is surfaced only via the `onEffect` callback, not injected into `AgentConfig`.

### `onEffect` is optional (non-breaking)

`WeaveRunnerOptions` is defined as:

```ts
export interface WeaveRunnerOptions {
  onEffect?: (effect: RunAgentEffect) => void;
}
```

The `WeaveRunner` constructor signature is:

```ts
constructor(
  config: WeaveConfig,
  adapter: HarnessAdapter,
  options: WeaveRunnerOptions = {},
)
```

The third argument defaults to `{}`, so all existing callers that pass only
`(config, adapter)` continue to work without modification.

### `rawToolPolicy` passed through unchanged

In `runner.ts`, the runner:
1. Calls `evaluateEffectiveToolPolicy(agentConfig.tool_policy)` to compute effective policy.
2. Emits `RunAgentEffect` with `rawToolPolicy: agentConfig.tool_policy` (the original value).
3. Calls `await this.adapter.spawnSubagent(name, agentConfig)` — `agentConfig` is
   the original object, not modified.

---

## Docs Review

### `docs/tool-policy-evaluation.md` created

File exists at `docs/tool-policy-evaluation.md` with sections covering:
- Purpose
- The five abstract capabilities
- `EffectiveToolPolicy` — what it is, why every field is required
- `DEFAULT_PERMISSION` (`"ask"`) — what it means, when it applies
- `evaluateEffectiveToolPolicy` — signature, behavior, examples
- `RunAgentEffect` — what it is, when it's emitted, what `rawToolPolicy` is for
- Adapter contract
- Usage example
- Source file cross-references

### `docs/adapter-boundary.md` links to `docs/tool-policy-evaluation.md`

- Added `[Tool Policy Evaluation](tool-policy-evaluation.md)` to the Related links header.
- Added a new `## Abstract Tool Policy Evaluation` section at the end with a direct
  link to `tool-policy-evaluation.md` and Spec 08.

### `docs/product-vision.md` links to `docs/tool-policy-evaluation.md`

- Added `[Tool Policy Evaluation](tool-policy-evaluation.md)` to the Related links header.
- Added a new `## Abstract Tool Policy Evaluation` section before Legacy Architecture
  Guidance with a direct link to `tool-policy-evaluation.md` and Spec 08.

---

## Sanitization Confirmation

No harness-specific tool names appear in:
- `packages/engine/src/run-agent-effects.ts` — only abstract types from `@weave/core`
  and `EffectiveToolPolicy` from `tool-policy.ts`
- `packages/engine/src/runner.ts` — no harness names; only abstract capability keys
- `packages/engine/src/__tests__/runner.test.ts` — all agent names are synthetic
  (alpha-worker, beta-worker, gamma-worker, etc.); all model names are synthetic
  (model-a, model-b, etc.); the sanitization test explicitly checks that
  `opencode`, `claude-code`, `pi-agent`, `codex`, `bash`, `computer`, `str_replace`
  do not appear in serialized effects

The test `"no harness-specific tool names appear in any emitted effect"` serializes
the full effect to JSON and asserts none of the above patterns are present.

---

## Test Coverage Summary

`runner.test.ts` now has 32 tests (was 14):

| Suite | Tests |
|-------|-------|
| lifecycle | 2 |
| agent spawning | 3 |
| disabled agents | 3 |
| call ordering | 1 |
| category shuttle spawning | 6 |
| **onEffect callback** (new) | **9** |
| **onEffect — category shuttle policy** (new) | **6** |
| **non-breaking: no onEffect option** (new) | **2** |

New tests cover:
- Normal agent: `onEffect` receives `RunAgentEffect` with correct `effectiveToolPolicy` and `rawToolPolicy`
- `effectiveToolPolicy` reflects explicit `tool_policy` values (policy override)
- `rawToolPolicy` matches declared `tool_policy`
- Agent with no `tool_policy` → all capabilities default to `"ask"` (policy inheritance)
- Agent with no `tool_policy` → `rawToolPolicy` is `undefined`
- One effect per agent in multi-agent config
- No effect for disabled agents
- Effect emitted before `spawnSubagent`
- No harness-specific tool names in effects (sanitization)
- Category shuttle: effect emitted with `kind: 'run-agent'`
- Category shuttle with explicit `tool_policy`: `effectiveToolPolicy` reflects category values
- Category shuttle with no `tool_policy`: all capabilities default to `"ask"`
- Category shuttle `rawToolPolicy` matches category's declared `tool_policy`
- Category shuttle with no `tool_policy`: `rawToolPolicy` is `undefined`
- Raw `tool_policy` still passed to adapter unchanged for category shuttle
- Runner works normally when no options object is provided (non-breaking)
- Runner works normally when options object has no `onEffect` (non-breaking)
