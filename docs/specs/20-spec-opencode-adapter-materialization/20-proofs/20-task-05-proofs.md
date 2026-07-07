# Task 5 Proof Artifact — Document the Adapter Shape and Prove Acceptance

**Task**: 5.0 Document the adapter shape and prove acceptance for the first slice  
**Spec**: 20-spec-opencode-adapter-materialization  
**Date**: 2026-05-26

---

## Summary

Task 5 completes the documentation and acceptance proof for the first-slice
`@weaveio/weave-adapter-opencode` materialization path. All five subtasks are complete:

| Subtask | Description | Status |
|---------|-------------|--------|
| 5.1 | Write `docs/adr/0003-opencode-adapter-materialization-shape.md` | ✅ |
| 5.2 | Update `docs/adapter-readiness-status.md` with first-slice section | ✅ |
| 5.3 | Update `docs/adapter-boundary.md` link references | ✅ |
| 5.4 | Run quality gate and record results | ✅ |
| 5.5 | Finalize sanitized smoke checklist reference | ✅ |

**Task 5 retry 1**: Added `@opencode-ai/plugin` dependency, `src/plugin.ts` plugin
entry point, `src/adapter.ts` (extracted from `index.ts`), and `plugin.test.ts`.
The package now exports a real OpenCode `Plugin` function as its default export.

**Task 5 retry 2**: Fixed `bun run --filter @weaveio/weave-adapter-opencode build` by
updating the adapter's `package.json` build script to build workspace dependencies
(`@weaveio/weave-core`, `@weaveio/weave-engine`, `@weaveio/weave-config`) before the adapter itself. The
`tsc --emitDeclarationOnly` step requires the dependency `dist/` directories to
exist; the `--filter` command only builds the one package, so dependencies must be
built explicitly in the script.

---

## Documents Created / Updated

### 5.1 — `docs/adr/0003-opencode-adapter-materialization-shape.md` (new)

Documents five key design decisions for the first-slice adapter shape:

1. **SDK-first, plugin/runtime-first entry path** — `@weaveio/weave-adapter-opencode`
   is an OpenCode plugin. Users install it via `opencode.json`'s `plugin` array.
   The package exports `WeavePlugin` as its default export — the OpenCode plugin
   entry point. No user-authored wrapper script is required. The plugin loads
   `.weave/config.weave`, materializes all agents, and returns empty `Hooks`.

2. **Injected client, adapter-owned SDK facade** — All SDK calls flow through
   the narrow `OpenCodeClientFacade` interface (`opencode-client.ts`). The
   `SdkOpenCodeClient` is the production implementation; tests use in-memory
   mocks. `sdk-types.ts` is the sole SDK import surface.

3. **Adapter-owned model resolution with engine helper** — `model-resolution.ts`
   gathers `OpenCodeModelContext` from the harness and calls the engine's pure
   `resolveAdapterModelIntent()`. Adds one adapter-local rule: fail-fast for
   explicit subagent model intent that cannot be satisfied.

4. **Harness-owned skill discovery, adapter-forwarded** — `skill-discovery.ts`
   contains no filesystem I/O. The harness injects `SkillInfo[]` via
   `OpenCodeAdapterOptions.availableSkills`; `loadAvailableSkills()` returns it
   unchanged. Missing declared skills are hard errors (no silent skips).

5. **Ownership-safe upsert via `[weave-managed]` tag** — `reconcile-agent.ts`
   implements the `list → classify → create/update` flow. `descriptor.name` is
   the Canonical Agent Name. The `[weave-managed]` tag in `description` is the
   ownership signal. `CollisionError` is returned for same-named foreign agents.
   First-slice is upsert-only (no prune/delete).

### 5.2 — `docs/adapter-readiness-status.md` (updated)

Added:
- Link to ADR 0003 and Spec 20 in the Related section.
- New **OpenCode Adapter — First-Slice Materialization** section with:
  - Capability table (8 rows, all ✅).
  - Explicit non-goals table (prune/delete, workflow-lifecycle, engine API drift,
    skill file loading).
  - Installation and runtime story (`opencode.json` `plugin` array + restart).
  - Clarification that no user-authored wrapper script is required.

### 5.3 — `docs/adapter-boundary.md` (updated)

Added links to ADR 0003 and Spec 20 in the Related section. No ownership rules
changed — the implementation confirmed the existing boundary is correct and
complete for the first slice.

---

## Source Files Created / Updated

### New: `packages/adapters/opencode/src/plugin.ts`

The OpenCode plugin entry point. Exports:
- `WeavePlugin` — the `Plugin` function (default export). Loaded by OpenCode at
  startup when the package is listed in `opencode.json`'s `plugin` array.
- `server` — alias for `WeavePlugin` for `PluginModule` compatibility.

The plugin function:
1. Calls `loadConfig(input.directory)` to load `.weave/config.weave`.
2. Calls `materializeAgents({ config })` to compose all agent descriptors.
3. Constructs `OpenCodeAdapter` with `new SdkOpenCodeClient(input.client)`.
4. Calls `adapter.spawnSubagent(descriptor)` for each descriptor.
5. Returns `{}` (empty `Hooks`) — agent materialization is the sole job.

### New: `packages/adapters/opencode/src/adapter.ts`

`OpenCodeAdapter` class extracted from `index.ts` to avoid a circular import
(`index.ts` → `plugin.ts` → `adapter.ts`). Identical behavior to the previous
`index.ts` implementation.

### Updated: `packages/adapters/opencode/src/index.ts`

Converted to a clean barrel that re-exports from `adapter.ts`, `plugin.ts`, and
all other adapter modules. Also re-exports `Plugin`, `PluginInput`, and
`PluginModule` types from `@opencode-ai/plugin` for consumer convenience.

### Updated: `packages/adapters/opencode/package.json`

Added `@opencode-ai/plugin@~1.15.9` as a production dependency (matching the
`@opencode-ai/sdk@~1.15.9` pin already present).

### New: `packages/adapters/opencode/src/__tests__/plugin.test.ts`

11 tests covering:
- Module shape: `WeavePlugin` is a function, `server` === `WeavePlugin`, default
  export === `WeavePlugin`.
- `PluginModule` compatibility: `{ server: WeavePlugin }` satisfies the shape.
- Config load failure: plugin returns `{}` without throwing when config fails.
- Successful materialization: plugin returns empty `Hooks` object.
- `@opencode-ai/plugin` dependency proof: package is importable.
- Plugin type contract: `WeavePlugin` returns `Promise<Hooks>`.

---

## Quality Gate Results

### Command

```
bun run typecheck && \
bun test packages/adapters/opencode/src/__tests__/adapter.test.ts && \
bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts && \
bun test packages/adapters/opencode/src/__tests__/model-resolution.test.ts && \
bun test packages/adapters/opencode/src/__tests__/skill-discovery.test.ts && \
bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts && \
bun test packages/adapters/opencode/src/__tests__/plugin.test.ts
```

### Results

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0

bun test v1.3.13 (bf2e2cec)
 165 pass
 0 fail
 336 expect() calls
Ran 165 tests across 7 files. [178.00ms]
```

All 5 packages pass typecheck. All 165 tests pass across 7 test files.

### Per-file test breakdown

| Test file | Tests | Status |
|-----------|-------|--------|
| `adapter.test.ts` | 40 | ✅ pass |
| `reconcile-agent.test.ts` | 42 | ✅ pass |
| `model-resolution.test.ts` | 23 | ✅ pass |
| `skill-discovery.test.ts` | 24 | ✅ pass |
| `run-workflow.test.ts` | 8 | ✅ pass |
| `translate-agent.test.ts` | 17 | ✅ pass |
| `plugin.test.ts` | 11 | ✅ pass |
| **Total** | **165** | **✅ all pass** |

---

## Sanitized Manual Smoke Checklist

The sanitized manual smoke checklist is at:

```
docs/specs/20-spec-opencode-adapter-materialization/20-smoke-checklist-task-02.md
```

### Smoke checklist summary

The checklist verifies that a Weave-authored agent appears in OpenCode after
materialization via the real SDK path. Key steps:

1. Create `/tmp/weave-smoke-test` with a minimal `.weave/config.weave` declaring
   `smoke-test-agent`.
2. Add `@weaveio/weave-adapter-opencode` to `opencode.json`'s `plugin` array — **no
   user-authored wrapper script required**.
3. Start OpenCode — the `WeavePlugin` default export is called at startup.
4. Verify `smoke-test-agent` appears in OpenCode with `[weave-managed]` in its
   description.
5. Restart OpenCode — verify idempotency (no duplicate, no error).
6. Create a foreign agent with the same name (no `[weave-managed]` tag) and
   restart — verify `CollisionError` is logged and the foreign agent is not
   overwritten.

**Pass criteria**: plugin loads without uncaught exception; agent appears in
OpenCode; `[weave-managed]` tag present; second run is idempotent; foreign agent
triggers `CollisionError`.

> **Note**: This checklist uses `@weaveio/weave-adapter-opencode` only. The legacy
> `weave` OpenCode plugin must not be active during this test. Use a clean
> project or temporarily disable the legacy plugin in `opencode.json`.

---

## Proof References

| Artifact | Path |
|----------|------|
| ADR 0003 | `docs/adr/0003-opencode-adapter-materialization-shape.md` |
| Adapter Readiness Status | `docs/adapter-readiness-status.md` |
| Adapter Boundary | `docs/adapter-boundary.md` |
| Smoke checklist | `docs/specs/20-spec-opencode-adapter-materialization/20-smoke-checklist-task-02.md` |
| Task 1 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-01-proofs.md` |
| Task 2 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-02-proofs.md` |
| Task 3 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-03-proofs.md` |
| Task 4 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-04-proofs.md` |
| Plugin entry point | `packages/adapters/opencode/src/plugin.ts` |
| Adapter class | `packages/adapters/opencode/src/adapter.ts` |
| Package barrel | `packages/adapters/opencode/src/index.ts` |
| SDK facade | `packages/adapters/opencode/src/opencode-client.ts` |
| Reconciliation | `packages/adapters/opencode/src/reconcile-agent.ts` |
| Model resolution | `packages/adapters/opencode/src/model-resolution.ts` |
| Skill discovery | `packages/adapters/opencode/src/skill-discovery.ts` |
| Plugin tests | `packages/adapters/opencode/src/__tests__/plugin.test.ts` |

---

## Acceptance Criteria Verification

| Criterion | Met? | Evidence |
|-----------|------|----------|
| ADR 0003 documents SDK-first, plugin/runtime-first, injected-client, and ownership-safe decisions | ✅ | `docs/adr/0003-opencode-adapter-materialization-shape.md` — 5 decisions documented with context, decision, consequences, and references |
| `adapter-readiness-status.md` describes first slice, remaining non-goals, and installation/runtime story | ✅ | New "OpenCode Adapter — First-Slice Materialization" section with capability table, non-goals, and `opencode.json` install snippet |
| `adapter-boundary.md` changes stay within current boundary rules and do not invent new engine contracts | ✅ | Only link additions; no ownership rules changed; implementation confirmed existing boundary is correct |
| Proof file exists with reviewer-friendly context, raw evidence, sanitized smoke checklist path/command, and quality gate results | ✅ | This file |
| Quality gate passes: `bun run typecheck && bun test [6 test files]` | ✅ | 165/165 tests pass; all 5 packages typecheck clean |
| `bun run --filter @weaveio/weave-adapter-opencode build` passes from clean state | ✅ | Build script updated to build `@weaveio/weave-core`, `@weaveio/weave-engine`, `@weaveio/weave-config` first; `tsc --emitDeclarationOnly` succeeds with dist files present |
| Package exposes a real OpenCode plugin entry surface (not just an adapter class requiring a user-authored wrapper) | ✅ | `src/plugin.ts` exports `WeavePlugin` as default export; `@opencode-ai/plugin` is a declared dependency; `plugin.test.ts` proves the plugin contract |
| Commit references Task 5 and Spec 20 | ✅ | Conventional Commit with `(adapter-opencode)` scope and task/spec reference in body |
