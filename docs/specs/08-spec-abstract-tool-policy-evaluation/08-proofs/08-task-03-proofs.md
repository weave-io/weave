# 08-task-03-proofs.md

## Task Summary

**Task 3.0 — Define the adapter-facing concrete tool classification contract**

Adds three new constructs to `packages/engine/src/tool-policy.ts`:

1. **`ConcreteToolClassification`** — adapter-supplied input type pairing an opaque concrete tool identifier (`string`) with an abstract capability (`keyof ToolPolicy`).
2. **`ToolDecision`** union — `MappedToolDecision | UnmappedToolDecision` — discriminated by `kind: "mapped" | "unmapped"`. Mapped decisions carry `capability` and `permission`; unmapped decisions carry only `toolId` with no permission value.
3. **`resolveToolDecisions`** — pure helper combining adapter-supplied classifications with an `EffectiveToolPolicy` to produce deterministic per-tool decisions.

All three are exported from `packages/engine/src/index.ts`.

---

## What This Task Proves

- Adapters can supply concrete tool identifiers (opaque strings) and abstract capability labels; the engine resolves per-tool permission decisions without knowing any harness-specific tool names.
- Every abstract capability (`read`, `write`, `execute`, `delegate`, `network`) can be mapped to a concrete tool and the matching effective permission is returned.
- Unknown/unclassified tool identifiers produce an **explicit** `UnmappedToolDecision` — the engine never silently allows an unclassified tool.
- The `kind` discriminant cleanly separates mapped from unmapped outcomes; adapters can exhaustively switch on it.
- The classification contract aligns with Spec 07's `tool-policy-mapping` capability vocabulary.

---

## Evidence

### `bun test packages/engine/src/__tests__/tool-policy.test.ts`

```
bun test v1.3.13 (bf2e2cec)

 76 pass
 0 fail
 259 expect() calls
Ran 76 tests across 1 file. [155.00ms]
```

**Breakdown**: 57 tests from Tasks 1 and 2 (unchanged) + 19 new tests from Task 3.

### `bun run typecheck`

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

All workspace packages pass with zero type errors.

---

## Code Review Artifact

**`packages/engine/src/tool-policy.ts` — no harness names, opaque identifiers, Spec 07 link**

- No OpenCode, Claude Code, Pi, bash, edit, glob, or any other harness-specific tool name appears anywhere in `tool-policy.ts`.
- `ConcreteToolClassification.toolId` is typed as `string` — fully opaque to the engine. The engine never inspects, branches on, or hard-codes concrete tool identifiers.
- The section comment explicitly links to Spec 07:
  ```
  // Alignment: this contract maps directly to the `tool-policy-mapping`
  // capability defined in Spec 07 (docs/specs/07-spec-adapter-capability-contract/).
  ```
- The JSDoc on `resolveToolDecisions` also references Spec 07:
  ```
  * Aligned with Spec 07 `tool-policy-mapping` capability
  * (see `docs/specs/07-spec-adapter-capability-contract/`).
  ```
- The module imports only `ToolPermission` and `ToolPolicy` from `@weaveio/weave-core` — no harness packages, no Bun file I/O, no process spawning, no adapter runtime calls.

---

## Sanitized Fixture Confirmation

All test fixtures in `packages/engine/src/__tests__/tool-policy.test.ts` under the `resolveToolDecisions` describe block use **only** the following synthetic identifiers:

| Identifier | Purpose |
|---|---|
| `synthetic.read-tool` | Tool classified under `read` capability |
| `synthetic.write-tool` | Tool classified under `write` capability |
| `synthetic.execute-tool` | Tool classified under `execute` capability |
| `synthetic.delegate-tool` | Tool classified under `delegate` capability |
| `synthetic.network-tool` | Tool classified under `network` capability |
| `synthetic.unknown-tool` | Tool with no classification entry (unmapped) |

No credentials, local paths, harness config, command arguments, API keys, tokens, or secret-bearing output appear in any fixture. A dedicated "fixture guard" test (`fixture guard: no harness-specific tool names appear in test identifiers`) asserts this invariant at runtime.
