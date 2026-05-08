# Task 04 Proofs — Deep-Merge Engine

## Task Summary

Implemented `mergeConfigs(...configs: WeaveConfig[]): WeaveConfig` — a pure,
variadic left-fold merge function. Scalars: last-defined wins. Objects: recursive
deep-merge. Arrays: union-merge with priority ordering and dedup. Inputs are never
mutated.

## What This Task Proves

- Scalars obey last-defined-wins across any number of layers.
- Agent deep-merge preserves unset fields from lower-priority layers.
- Agents from different layers are all present in the merged output.
- Array union-merge puts override entries first and deduplicates correctly.
- `disabled.agents` union-merges across scopes.
- Edge cases (0 configs, 1 config, empty configs) all produce valid output.
- Inputs are not mutated after a merge.
- `tool_policy` deep-merges individual keys correctly.
- All 12 tests pass.

## Evidence Summary

`bun test` shows 12/12 pass for `merge.test.ts`. `bun run typecheck` exits 0.

---

## Artifact: `merge.test.ts` — all 12 tests pass

**What it proves:** All merge semantics — scalar override, deep-merge, array union-merge, dedup, immutability, edge cases — are correct.
**Why it matters:** Incorrect merge semantics would silently produce wrong config (e.g. project fields lost, wrong model priority order, or inputs mutated between runs).
**Command:**
```bash
bun test packages/config/src/__tests__/merge.test.ts
```
**Result summary:** 12 pass, 0 fail.
```
packages/config/src/__tests__/merge.test.ts:
(pass) mergeConfigs > (a) scalar override: last-defined log_level wins [1.57ms]
(pass) mergeConfigs > (b) three-layer scalar: only third layer sets log_level → third value wins [0.14ms]
(pass) mergeConfigs > (c) agent deep-merge: partial override preserves unset fields [1.68ms]
(pass) mergeConfigs > (d) agent addition: agents from different scopes both present in merged config
(pass) mergeConfigs > (e) array union-merge (models): override entries first, then base [0.36ms]
(pass) mergeConfigs > (f) array union-merge (disabled.agents): union across scopes, override first [0.38ms]
(pass) mergeConfigs > (g) array union-merge dedup: duplicate model appears exactly once [0.09ms]
(pass) mergeConfigs > (h) empty config merges: valid empty config returned [0.01ms]
(pass) mergeConfigs > (i) single config: returns equivalent config [0.10ms]
(pass) mergeConfigs > (j) zero configs: returns default empty WeaveConfig [0.05ms]
(pass) mergeConfigs > (k) immutability: inputs are not mutated after merge [0.09ms]
(pass) mergeConfigs > (l) tool_policy deep-merge: base policy + extra key from override, all keys present [0.41ms]

 12 pass
 0 fail
 22 expect() calls
Ran 12 tests across 1 file. [40.00ms]
```

---

## Artifact: `bun run typecheck` — zero errors

**What it proves:** `merge.ts` is correctly typed with no `any` escapes.
**Command:**
```bash
bun run typecheck
```
**Result summary:** All packages exit 0.
```
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Reviewer Conclusion

The deep-merge engine correctly implements all specified semantics: scalar override,
object deep-merge, array union-merge with priority ordering and dedup, immutability,
and all edge cases. The implementation is a pure function with no side effects.
