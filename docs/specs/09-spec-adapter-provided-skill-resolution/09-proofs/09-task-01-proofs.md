# Task 01 Proof Artifact — Define Public Skill Resolution Types and Exports

**Spec**: 09 — Adapter-Provided Skill Resolution  
**Task**: 1.0 — Define public skill resolution types and exports  
**Date**: 2026-05-15  
**Status**: ✅ Complete

---

## Acceptance Criteria Evidence

### AC1 — `skill-resolution.ts` exists with all required exports

**File**: `packages/engine/src/skill-resolution.ts`

Exported symbols:
- `SkillInfo` (interface) — adapter-supplied descriptor; `name` is the only engine-required field
- `ResolvedSkill` (interface) — skill selected for a specific agent after filtering
- `SkillResolutionInput` (interface) — explicit input for single-agent resolution
- `SkillResolutionError` (discriminated union type) — `type: "MissingSkill"` with `agentName` and `skillName`
- `resolveSkillsForAgent` (function) — pure single-agent resolution helper returning `Result<ResolvedSkill[], SkillResolutionError[]>`

### AC2 — `SkillInfo.name` is the only engine-owned matching key

From `packages/engine/src/skill-resolution.ts`:

```ts
export interface SkillInfo {
  /** Stable matching key — the only field the engine uses for resolution. */
  name: string;
  /**
   * Adapter-owned pass-through metadata.
   * The engine preserves this value in `ResolvedSkill` but never reads,
   * validates, or logs its contents.
   */
  metadata?: unknown;
}
```

The `resolveSkillsForAgent` implementation matches exclusively on `SkillInfo.name`:

```ts
const availableByName = new Map<string, SkillInfo>(
  availableSkills.map((s) => [s.name, s]),
);
```

No other field is read by the engine.

### AC3 — Type-focused tests prove adapter metadata is preserved without engine inspection

**Test file**: `packages/engine/src/__tests__/skill-resolution.test.ts`

Key test cases:
- `(b) SkillInfo preserves arbitrary adapter metadata without engine inspection` — stores harness-specific paths, mount points, API keys in `metadata`; engine only reads `name`
- `(b) adapter metadata is accessible from ResolvedSkill without engine inspection` — verifies `resolved[0].skillInfo.metadata` is the exact same reference as the input
- `(a) matching is by exact name — metadata fields are never used for matching` — skill with rich metadata (alias, tags, path) is matched only by `name`

### AC4 — All public types and functions exported from `packages/engine/src/index.ts`

```ts
export type {
  ResolvedSkill,
  SkillInfo,
  SkillResolutionError,
  SkillResolutionInput,
} from "./skill-resolution.js";
export { resolveSkillsForAgent } from "./skill-resolution.js";
```

### AC5 — `bun run typecheck` passes with no errors

```
$ bun run typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

### AC6 — No harness-specific references in `skill-resolution.ts`

Code review confirms `packages/engine/src/skill-resolution.ts` contains:
- ❌ No `OpenCode` references
- ❌ No `Claude Code` references  
- ❌ No `Pi` references
- ❌ No `Bun.file` calls
- ❌ No `Bun.spawn` / `Bun.spawnSync` calls
- ❌ No `process.spawn` or child process calls
- ✅ Only `neverthrow` (`ok`, `err`, `Result`) and pure TypeScript types

---

## Test Run Output

```
bun test v1.3.13 (bf2e2cec)

 14 pass
 0 fail
 41 expect() calls
Ran 14 tests across 1 file. [132.00ms]
```

### Test cases covered

| Test | Description |
|------|-------------|
| `SkillInfo — adapter metadata pass-through (a)` | SkillInfo with only name is valid |
| `SkillInfo — adapter metadata pass-through (b)` | SkillInfo preserves arbitrary adapter metadata without engine inspection |
| `SkillInfo — adapter metadata pass-through (c)` | SkillInfo metadata can be any shape |
| `ResolvedSkill — adapter metadata preserved (a)` | ResolvedSkill carries the original SkillInfo reference |
| `ResolvedSkill — adapter metadata preserved (b)` | adapter metadata is accessible from ResolvedSkill without engine inspection |
| `resolveSkillsForAgent — type-level result shape (a)` | returns ok([]) when agentSkills is undefined |
| `resolveSkillsForAgent — type-level result shape (b)` | returns ok([]) when agentSkills is empty |
| `resolveSkillsForAgent — type-level result shape (c)` | returns ok with resolved skill when name matches |
| `resolveSkillsForAgent — type-level result shape (d)` | returns err with MissingSkill when skill is not available |
| `resolveSkillsForAgent — type-level result shape (e)` | disabled skill is filtered without error |
| `resolveSkillsForAgent — type-level result shape (f)` | SkillResolutionError contains only type, agentName, skillName |
| `resolveSkillsForAgent — name is the only matching key (a)` | matching is by exact name — metadata fields are never used |
| `resolveSkillsForAgent — name is the only matching key (b)` | two skills with different names are matched independently |
| `resolveSkillsForAgent — name is the only matching key (c)` | name match is case-sensitive |

---

## Typecheck Output

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

---

## Files Changed

| File | Change |
|------|--------|
| `packages/engine/src/skill-resolution.ts` | Created — `SkillInfo`, `ResolvedSkill`, `SkillResolutionInput`, `SkillResolutionError`, `resolveSkillsForAgent` |
| `packages/engine/src/__tests__/skill-resolution.test.ts` | Created — 14 type-focused tests |
| `packages/engine/src/index.ts` | Updated — added skill-resolution type and function exports |
| `docs/specs/09-spec-adapter-provided-skill-resolution/09-proofs/09-task-01-proofs.md` | Created — this proof artifact |
