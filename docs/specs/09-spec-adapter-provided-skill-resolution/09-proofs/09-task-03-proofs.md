# Task 03 Proof Artifact — Config-Wide Skill Resolution

**Spec**: [09-spec-adapter-provided-skill-resolution](../09-spec-adapter-provided-skill-resolution.md)
**Task**: 3.0 — Implement config-wide resolution including generated category shuttles
**Date**: 2026-05-15
**Commit**: `feat(engine): implement config-wide skill resolution`

---

## 1. Test Output

```
bun test packages/engine/src/__tests__/skill-resolution.test.ts

bun test v1.3.13 (bf2e2cec)

 51 pass
 0 fail
 159 expect() calls
Ran 51 tests across 1 file. [37.00ms]
```

**Previous count (Tasks 1+2)**: 32 tests  
**New tests added (Task 3)**: 19 tests  
**Total**: 51 tests, 0 failures

---

## 2. Typecheck Output

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

All packages pass `tsc --noEmit`. New exports (`resolveSkillsForConfig`, `SkillResolutionConfigInput`, `ConfigSkillResolutionResult`) are importable across the workspace.

---

## 3. Implementation Evidence

### 3.1 `resolveSkillsForConfig` — function signature

```typescript
export function resolveSkillsForConfig(
  input: SkillResolutionConfigInput,
): Result<ConfigSkillResolutionResult, SkillResolutionError[]>
```

- Accepts `{ config: WeaveConfig, availableSkills: SkillInfo[] }`.
- Reads `config.disabled.skills` and `config.disabled.agents` from the provided config.
- Returns `Result<Record<string, ResolvedSkill[]>, SkillResolutionError[]>`.

### 3.2 `generateCategoryShuttles` reuse

The implementation calls `generateCategoryShuttles(config)` from `packages/engine/src/descriptors.ts` directly:

```typescript
const shuttlesResult = generateCategoryShuttles(config);
if (shuttlesResult.isErr()) {
  const conflict = shuttlesResult.error;
  return err([{ type: "MissingSkill", agentName: conflict.shuttleName, skillName: "__category_shuttle_conflict__" }]);
}
for (const [shuttleName, shuttleConfig] of Object.entries(shuttlesResult.value)) {
  agentEntries.push([shuttleName, shuttleConfig.skills]);
}
```

This ensures generated shuttle behavior (disabled-agent skipping, category overrides, conflict detection) is identical to runner materialization semantics — no parallel implementation.

### 3.3 Declared agents + generated shuttles in batch result

Both declared agents and generated `shuttle-{category}` descriptors are collected into `agentEntries` before resolution. The final `result` record is keyed by stable agent name:

```typescript
// Declared agents
for (const [agentName, agentConfig] of Object.entries(config.agents)) {
  if (disabledAgents.includes(agentName)) continue;
  agentEntries.push([agentName, agentConfig.skills]);
}
// Generated shuttles (already skips disabled ones via generateCategoryShuttles)
for (const [shuttleName, shuttleConfig] of Object.entries(shuttlesResult.value)) {
  agentEntries.push([shuttleName, shuttleConfig.skills]);
}
```

### 3.4 Disabled generated shuttles skipped

`generateCategoryShuttles` already skips agents in `config.disabled.agents` (line 46 of `descriptors.ts`). Declared agents are also filtered before being added to `agentEntries`. Both paths are consistent.

### 3.5 Error accumulation across all agents

```typescript
const allErrors: SkillResolutionError[] = [];
for (const [agentName, agentSkills] of agentEntries) {
  const agentResult = resolveSkillsForAgent({ agentName, agentSkills, availableSkills, disabledSkills });
  if (agentResult.isErr()) {
    allErrors.push(...agentResult.error);
    continue;
  }
  result[agentName] = agentResult.value;
}
if (allErrors.length > 0) return err(allErrors);
```

All `MissingSkill` errors from all agents are accumulated before returning — no early exit on first error.

---

## 4. New Exports from `@weaveio/weave-engine`

| Export | Kind | Description |
|--------|------|-------------|
| `resolveSkillsForConfig` | function | Config-wide batch resolution |
| `SkillResolutionConfigInput` | type | Input for `resolveSkillsForConfig` |
| `ConfigSkillResolutionResult` | type | `Record<string, ResolvedSkill[]>` batch result |

---

## 5. Test Coverage Summary

| Test suite | Tests | Description |
|---|---|---|
| `resolveSkillsForConfig — declared-agent batch output` | 4 | Empty config, all agents included, no-skills agents, SkillInfo ref preserved |
| `resolveSkillsForConfig — generated category shuttle output` | 5 | Shuttle included, inherits skills, multiple categories, no categories, no base shuttle |
| `resolveSkillsForConfig — disabled-skill behavior in batch mode` | 5 | Global disabled skills, disabled+missing, disabled agents excluded, disabled generated shuttle, disabled base shuttle |
| `resolveSkillsForConfig — accumulated missing-skill errors` | 5 | Cross-agent accumulation, single-agent multi-error, declared+generated errors, partial success, error field shape |

---

## 6. Boundary Compliance

- `packages/engine/src/skill-resolution.ts` contains no `Bun.file`, `Bun.spawn`, OpenCode, Claude Code, Pi, or process-spawning references.
- No filesystem scanning or harness-owned directory reads.
- All harness context is adapter-provided via `availableSkills`.
- `generateCategoryShuttles` is reused (not duplicated) to maintain semantic consistency with the runner.
