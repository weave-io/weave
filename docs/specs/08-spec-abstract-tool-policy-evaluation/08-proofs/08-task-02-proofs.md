# Task 02 Proofs — Pure Effective Tool-Policy Evaluation

## Task Summary

Implemented `evaluateEffectiveToolPolicy(policy: ToolPolicy | undefined): EffectiveToolPolicy`
in `packages/engine/src/tool-policy.ts` as a pure, deterministic, non-fallible helper.

- Applies `DEFAULT_PERMISSION` (`'ask'`) to every capability whose field is omitted or whose
  input policy is `undefined`.
- Preserves configured permissions (`allow`, `deny`, `ask`) unchanged for every capability
  when the input policy provides them.
- Exported from `packages/engine/src/index.ts`.
- Table-driven tests cover all five capabilities × all three permission values.

## What This Task Proves

1. **Configured values are preserved** — when a capability is explicitly set in the input
   policy, `evaluateEffectiveToolPolicy` returns that exact value unchanged.
2. **Omitted fields default to `ask`** — any capability absent from the input policy (or when
   the entire policy is `undefined`) resolves to `DEFAULT_PERMISSION` (`'ask'`).
3. **Return is always complete** — the returned `EffectiveToolPolicy` always contains all five
   capabilities (`read`, `write`, `execute`, `delegate`, `network`), regardless of input shape.
4. **Pure function** — `tool-policy.ts` contains no `Bun.file`, no adapter calls, no harness
   names, no process spawning, no network I/O.

## Evidence

### `bun test packages/engine/src/__tests__/tool-policy.test.ts`

```
bun test v1.3.13 (bf2e2cec)

 57 pass
 0 fail
 158 expect() calls
Ran 57 tests across 1 file. [37.00ms]
```

57 tests pass (16 pre-existing + 41 new evaluation tests):
- 2 tests for `undefined` policy → all-ask result
- 5 tests for single-capability partial policies (one per capability)
- 4 tests for full policies (mixed, all-allow, all-deny, all-ask)
- 30 table-driven tests: 5 capabilities × 3 permissions × 2 assertions each
  (configured value preserved + other capabilities default to ask)
- 1 completeness test (always returns exactly five keys)

### `bun run typecheck`

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

All packages pass with zero type errors.

## Code Review Artifact

**`packages/engine/src/tool-policy.ts` purity audit:**

| Check | Result |
|-------|--------|
| `Bun.file` call | ✅ Not present |
| `Bun.spawn` / `Bun.spawnSync` call | ✅ Not present |
| Adapter method calls | ✅ Not present |
| Harness names (opencode, claude-code, pi, bash, edit, glob) | ✅ Not present |
| Network I/O | ✅ Not present |
| `console.*` usage | ✅ Not present |
| Imports beyond `@weave/core` types | ✅ Only `ToolPermission` and `ToolPolicy` from `@weave/core` |
| Return type is `Result<T, E>` | ✅ Plain return — function is deterministic and non-fallible |

The function body uses only the `??` nullish-coalescing operator against the input `policy`
object and the module-level `DEFAULT_PERMISSION` constant. No side effects of any kind.
