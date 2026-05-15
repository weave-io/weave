# Task 02 Proofs — Single-Agent Skill Resolution

**Spec**: 09 — Adapter-Provided Skill Resolution  
**Task**: 2/5 — Implement single-agent skill resolution  
**Date**: 2026-05-15

---

## Implementation

`resolveSkillsForAgent(input)` was already stubbed in Task 1. Task 2 completes the full function body in `packages/engine/src/skill-resolution.ts`.

### Resolution algorithm (lines 147–181)

```typescript
export function resolveSkillsForAgent(
  input: SkillResolutionInput,
): Result<ResolvedSkill[], SkillResolutionError[]> {
  const { agentName, agentSkills, availableSkills, disabledSkills = [] } = input;

  // Rule 1: undefined or empty → ok([])
  if (agentSkills === undefined || agentSkills.length === 0) return ok([]);

  // Build O(1) lookup map from availableSkills
  const availableByName = new Map<string, SkillInfo>(
    availableSkills.map((s) => [s.name, s]),
  );

  const resolved: ResolvedSkill[] = [];
  const errors: SkillResolutionError[] = [];

  for (const skillName of agentSkills) {
    // Rule 2a: disabled → skip silently
    if (disabledSkills.includes(skillName)) continue;

    const skillInfo = availableByName.get(skillName);
    // Rule 2b: available → include (preserves agentSkills declaration order)
    if (skillInfo !== undefined) {
      resolved.push({ name: skillName, skillInfo });
      continue;
    }
    // Rule 2c: missing non-disabled → record error
    errors.push({ type: "MissingSkill", agentName, skillName });
  }

  if (errors.length > 0) return err(errors);
  return ok(resolved);
}
```

**Key properties**:
- Pure function — no side effects, no I/O, no harness calls
- Declaration order preserved: iterates `agentSkills` (not `availableSkills`)
- Disabled check before availability check — disabled skills never produce errors
- `ok([])` guard at top for undefined/empty `agentSkills`
- `Map` for O(1) name lookup

---

## Test Results

### Command
```
bun test packages/engine/src/__tests__/skill-resolution.test.ts
```

### Output
```
bun test v1.3.13 (bf2e2cec)

 32 pass
 0 fail
 98 expect() calls
Ran 32 tests across 1 file. [141.00ms]
```

### Test coverage by category

| Category | Tests | Status |
|---|---|---|
| SkillInfo — adapter metadata pass-through | 3 | ✅ pass |
| ResolvedSkill — adapter metadata preserved | 2 | ✅ pass |
| resolveSkillsForAgent — type-level result shape | 6 | ✅ pass |
| resolveSkillsForAgent — name is the only matching key | 3 | ✅ pass |
| **resolveSkillsForAgent — available skill resolution** | **3** | **✅ pass** |
| **resolveSkillsForAgent — declaration order preserved** | **3** | **✅ pass** |
| **resolveSkillsForAgent — disabled-skill filtering** | **4** | **✅ pass** |
| **resolveSkillsForAgent — no-skills input** | **3** | **✅ pass** |
| **resolveSkillsForAgent — missing non-disabled skill errors** | **5** | **✅ pass** |

Bold rows = new focused tests added in Task 2.

---

## Typecheck

### Command
```
bun run typecheck
```

### Output
```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

All packages clean. Zero type errors.

---

## Acceptance Criteria Verification

| # | Criterion | Evidence |
|---|---|---|
| 1 | `resolveSkillsForAgent(input)` is a pure function returning `Result<ResolvedSkill[], SkillResolutionError[]>` | Implementation in `skill-resolution.ts:147–181`; no side effects |
| 2 | Matching is by exact `SkillInfo.name` only | `availableByName.get(skillName)` — Map keyed on `name`; metadata never read |
| 3 | Declaration order of non-disabled requested skills preserved | Iterates `agentSkills` array; `resolved.push` in that order |
| 4 | Disabled skills filtered before missing-skill validation | `if (disabledSkills.includes(skillName)) continue` before availability check |
| 5 | Returns `ok([])` for missing/undefined/empty `agentSkills` | Guard at line 157; tests: "no-skills input" group (3 tests) |
| 6 | Returns typed `err` entries with `type`, `agentName`, `skillName` | `errors.push({ type: "MissingSkill", agentName, skillName })` |
| 7 | All required test categories pass | 32/32 pass — see table above |

---

## Files Changed

| File | Change |
|---|---|
| `packages/engine/src/skill-resolution.ts` | Function body already implemented (Task 1 stub was complete) |
| `packages/engine/src/__tests__/skill-resolution.test.ts` | Added 18 new focused tests across 5 new `describe` blocks |
