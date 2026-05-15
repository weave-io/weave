# Task 05 Proof Artifact — Update Documentation and Boundary References

## Summary

Task 5.0 updates `docs/adapter-boundary.md`, `docs/product-vision.md`, and `packages/engine/README.md` to:

1. Replace dead Spec 05 skill-loader links with live Spec 09 links.
2. Add a dedicated **Adapter-Provided Skill Resolution** section to each doc.
3. Document the final transitional adapter-surface decision (`loadAvailableSkills()`).

---

## 5.1 — `docs/adapter-boundary.md` changes

**Dead link corrected:**

```diff
-**Related:** ... · [Spec 05 — Skill Resolution](specs/05-spec-skill-loader/05-spec-skill-loader.md) · ...
+**Related:** ... · [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) · ...
```

**New section added** (`## Adapter-Provided Skill Resolution`) documenting:
- `loadAvailableSkills(): Promise<SkillInfo[]>` as the transitional adapter surface (Spec 09 decision).
- `resolveSkillsForAgent()` and `resolveSkillsForConfig()` as pure engine helpers.
- `RunAgentEffect.resolvedSkills` invariant (no paths/content/tokens in emitted effects).
- `loadSkill()` deprecated, superseded by `loadAvailableSkills()`.

**Transitional Interfaces section updated** to explicitly note `loadSkill()` is deprecated and superseded.

---

## 5.2 — `docs/product-vision.md` changes

**Dead link corrected:**

```diff
-**Related:** ... · [Spec 05 — Skill Resolution](specs/05-spec-skill-loader/05-spec-skill-loader.md) · ...
+**Related:** ... · [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md) · ...
```

**New section added** (`## Adapter-Provided Skill Resolution`) documenting:
- Adapter surface: `HarnessAdapter.loadAvailableSkills(): Promise<SkillInfo[]>`.
- Engine APIs: `resolveSkillsForAgent()` and `resolveSkillsForConfig()` with return types.
- Invariants: no harness directory scanning, no adapter metadata in emitted effects, disabled-skill filtering before missing-skill validation.
- Cross-links to Spec 09 and Adapter Boundary.

---

## 5.3 — `packages/engine/README.md` changes

**Dead link corrected in Overview:**

```diff
-- **Skill resolution API** — planned by [Spec 05](...); adapters provide available skills, engine matches/filter them
+- **Skill resolution API** — implemented by [Spec 09](...); adapters provide available skills via `loadAvailableSkills()`, engine matches/filters them via `resolveSkillsForAgent()` and `resolveSkillsForConfig()`
```

**New section added** (`## Skill Resolution API`) with:
- Description of `resolveSkillsForAgent()` and `resolveSkillsForConfig()`.
- Adapter-provided context flow code example.
- `WeaveRunner` integration description.
- Invariants (no directory scanning, no metadata in effects, disabled-skill filtering).

**Transitional Adapter Interface section updated:**
- `loadAvailableSkills()` documented as the current adapter surface (Spec 09).
- `loadSkill()` explicitly marked deprecated and superseded.
- `registerHook()` future direction unchanged.

---

## 5.4 — Final Transitional Adapter-Surface Decision

**Decision:** `HarnessAdapter` exposes `loadAvailableSkills(): Promise<SkillInfo[]>`.

**Rationale:**
- Smallest explicit adapter-provided context flow (matches planning assumption in spec notes).
- Called by `WeaveRunner.run()` before agent materialization loop.
- Returns a flat `SkillInfo[]` list; engine calls `resolveSkillsForConfig()` and attaches `resolvedSkills` to each `RunAgentEffect`.
- Supersedes the deprecated `loadSkill(name: string)` method which required engine-driven per-skill lookup.
- `loadSkill()` remains on the interface (marked `@deprecated`) for backward compatibility; will be removed in a future spec.

---

## 5.5 — Lint Output

```
$ bun run lint
$ biome lint packages/
...
Checked 80 files in 27ms. No fixes applied.
Found 35 warnings.
Found 8 infos.
```

**Result: PASS** — no errors. All 35 warnings are pre-existing `noNonNullAssertion` style warnings in `packages/engine/src/__tests__/skill-resolution.test.ts` from prior tasks; none are introduced by Task 5 changes (which are documentation-only).

---

## Typecheck Output

```
$ bun run typecheck
@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

**Result: PASS** — all packages typecheck cleanly.

---

## 5.6 — Warp Security Review (Pending)

**⚠️ Warp security review for issue #12 implementation changes is required before the Spec 09 implementation is considered complete.**

Tapestry will handle this separately. The review should confirm:

- No secrets, local skill contents, or harness-owned skill paths are exposed in debug/effect data (`RunAgentEffect.resolvedSkills`).
- `sanitizeEffect()` (or equivalent) strips adapter-owned metadata before effects are emitted.
- The `loadAvailableSkills()` adapter surface does not inadvertently expose harness credentials or environment variables through `SkillInfo` pass-through metadata.

---

## Files Changed

| File | Change |
| ---- | ------ |
| `docs/adapter-boundary.md` | Fixed dead Spec 05 link → Spec 09; added `## Adapter-Provided Skill Resolution` section; updated Transitional Interfaces section |
| `docs/product-vision.md` | Fixed dead Spec 05 link → Spec 09; added `## Adapter-Provided Skill Resolution` section |
| `packages/engine/README.md` | Fixed dead Spec 05 link → Spec 09 in Overview; added `## Skill Resolution API` section; updated Transitional Adapter Interface section |
| `docs/specs/09-spec-adapter-provided-skill-resolution/09-proofs/09-task-05-proofs.md` | Created (this file) |
