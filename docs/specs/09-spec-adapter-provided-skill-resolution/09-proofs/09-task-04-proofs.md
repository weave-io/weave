# Task 4.0 Proof Artifact — Wire Resolved Skills into Runner and Adapter-Facing Effects

**Spec**: [09-spec-adapter-provided-skill-resolution](../09-spec-adapter-provided-skill-resolution.md)
**Task**: 4.0 Wire resolved skills into runner and adapter-facing effects
**Commit**: `feat(engine): wire skill resolution into runner and effects`
**Date**: 2026-05-15

---

## Sub-task Evidence

### 4.1 — Replace `TODO(#12)` with skill resolution

**File**: `packages/engine/src/runner.ts`

The `TODO(#12)` placeholder in `WeaveRunner.run()` has been replaced with:

```ts
// 2. Resolve skills from adapter-provided SkillInfo values.
const availableSkills = await this.adapter.loadAvailableSkills();
const skillResolutionResult = resolveSkillsForConfig({
  config: this.config,
  availableSkills,
});
```

No directory scanning, skill-file reads, or harness-specific skill lookup exists in `runner.ts`. The engine only calls `this.adapter.loadAvailableSkills()` and passes the result to the pure `resolveSkillsForConfig()` function.

---

### 4.2 — Adapter surface: `loadAvailableSkills()` added, `loadSkill()` deprecated

**File**: `packages/engine/src/adapter.ts`

`loadAvailableSkills(): Promise<SkillInfo[]>` added to `HarnessAdapter`:

```ts
/**
 * Return the list of skills available in this harness instance.
 *
 * The engine calls this once during `WeaveRunner.run()` — after `init()` and
 * before agent materialisation — to obtain the adapter-provided skill context
 * used for skill resolution.
 */
loadAvailableSkills(): Promise<SkillInfo[]>;
```

`loadSkill()` is retained for backward compatibility but marked `@deprecated` with a migration note pointing to `loadAvailableSkills()`.

---

### 4.3 — `RunAgentEffect` includes `resolvedSkills`

**File**: `packages/engine/src/run-agent-effects.ts`

```ts
export type RunAgentEffect = {
  readonly kind: "run-agent";
  readonly agentName: string;
  readonly effectiveToolPolicy: EffectiveToolPolicy;
  readonly rawToolPolicy: ToolPolicy | undefined;
  /**
   * Ordered list of resolved skill names for this agent.
   * Security invariant: only skill names — no adapter-owned paths, content,
   * API keys, tokens, or harness-specific mounting details.
   */
  readonly resolvedSkills: readonly string[];
};
```

---

### 4.4 — Disabled agents do not emit skill-resolution effects

**Test**: `runner.test.ts` → `"skill resolution — disabled agents"` suite

- `"disabled agents do not emit run-agent effects (no resolvedSkills emitted)"` — asserts disabled agents produce no effects.
- `"disabled agents are excluded from skill resolution entirely"` — asserts a disabled agent referencing a non-available skill does not cause a MissingSkill error.

---

### 4.5 — Generated category shuttles receive resolved skill data

**Test**: `runner.test.ts` → `"skill resolution — category shuttles"` suite

- `"generated category shuttle receives resolved skill data in effect"` — asserts `shuttle-alpha-cat` effect contains `resolvedSkills: ["tdd"]`.
- `"multiple category shuttles each receive their own resolved skill data"` — asserts both `shuttle-beta-cat` and `shuttle-gamma-cat` receive `["tdd", "code-review"]`.

---

### 4.6 — `MockAdapter` updated for new skill context flow

**File**: `packages/engine/src/__tests__/mock-adapter.ts`

- `MockAdapterOptions.availableSkills` allows tests to inject skill context without filesystem access.
- `loadAvailableSkills()` returns the in-memory list and records a `"loadAvailableSkills"` call.
- `MockCall` union includes `{ method: "loadAvailableSkills" }`.
- `loadSkill()` is retained but marked `@deprecated`.

---

### 4.7 — No harness-specific skill lookup required by engine code

**Test**: `runner.test.ts` → `"engine does not perform directory scanning, skill-file reads, or harness-specific lookup"`

```ts
it("engine does not perform directory scanning, skill-file reads, or harness-specific lookup", async () => {
  const adapterWithSkills = new MockAdapter({
    availableSkills: [{ name: "tdd", metadata: { path: "/mock/path/tdd.md" } }],
  });
  // ...
  expect(adapterWithSkills.callsTo("loadAvailableSkills")).toHaveLength(1);
  expect(adapterWithSkills.callsTo("loadSkill")).toHaveLength(0);
});
```

The `MockAdapter` uses only in-memory data — no `Bun.file()`, no `process.spawn()`, no filesystem access. The engine resolved the skill purely from adapter-provided context.

---

### 4.8 — Sanitized-effect coverage

**Test**: `runner.test.ts` → `"sanitized-effect coverage"` suite (4 tests)

1. `"serialized run-agent effects do not expose adapter-owned skill paths"` — asserts `/home/user/.weave/skills/tdd.md` and `"Secret skill content here"` are absent from `JSON.stringify(effects)`.
2. `"serialized run-agent effects do not expose API keys or tokens in skill metadata"` — asserts `"sk-secret-api-key-12345"`, `"bearer-token-xyz"`, and `"/project/.env"` are absent.
3. `"no harness-specific tool names appear in any emitted effect (including resolvedSkills)"` — asserts `opencode`, `claude-code`, `pi-agent`, `codex`, `bash`, `computer`, `str_replace` are absent.
4. `"resolvedSkills field contains only skill names — no metadata objects"` — asserts `resolvedSkills` is `["tdd"]` (strings only) and adapter metadata (`/skills/tdd.md`, `opencode://skills/tdd`, `secret`) is absent from serialized effect.

---

## Test Results

### `bun test packages/engine/src/__tests__/runner.test.ts`

```
bun test v1.3.13 (bf2e2cec)

 47 pass
 0 fail
 133 expect() calls
Ran 47 tests across 1 file. [98.00ms]
```

**New tests added**: 15 (up from 32 baseline)

### `bun test packages/engine/src/__tests__/skill-resolution.test.ts` (regression check)

```
bun test v1.3.13 (bf2e2cec)

 51 pass
 0 fail
 159 expect() calls
Ran 51 tests across 1 file. [12.00ms]
```

**No regressions** — all 51 existing tests pass.

### `bun run typecheck`

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

**All packages pass typecheck.**

---

## Acceptance Criteria Verification

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `WeaveRunner.run()` resolves adapter-provided skills before `spawnSubagent` and emits resolved skills for each spawned agent | ✅ `loadAvailableSkills()` called before spawn; `resolvedSkills` in every effect |
| 2 | Generated category shuttles receive resolved skill data | ✅ `shuttle-alpha-cat` effect contains `resolvedSkills: ["tdd"]` |
| 3 | Disabled agents do NOT emit skill-resolution effects or require missing-skill checks | ✅ Disabled agents skipped before effect emission and before resolution |
| 4 | `MockAdapter` compiles through `bun run typecheck` without depending on engine-driven `loadSkill()` | ✅ `MockAdapter` uses `loadAvailableSkills()` as the resolution path |
| 5 | `runner.ts` contains NO directory scanning, skill-file reads, or harness-specific skill lookup | ✅ Only `this.adapter.loadAvailableSkills()` + pure `resolveSkillsForConfig()` |
| 6 | Sanitized-effect coverage: serialized effects do NOT expose adapter-owned skill paths, contents, API keys, tokens, or `.env` values | ✅ 4 sanitized-effect tests pass |
| 7 | `bun test packages/engine/src/__tests__/runner.test.ts` passes all new coverage | ✅ 47/47 pass |
| 8 | `bun test packages/engine/src/__tests__/skill-resolution.test.ts` still passes (no regressions) | ✅ 51/51 pass |
| 9 | `bun run typecheck` passes | ✅ All 5 packages pass |
