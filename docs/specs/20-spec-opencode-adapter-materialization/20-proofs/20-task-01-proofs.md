# Task 1 Proof Artifact — Injected OpenCode Client Path and Adapter-Owned SDK Facade

**Spec**: 20-spec-opencode-adapter-materialization  
**Task**: 1.0 — Establish the injected OpenCode client path and adapter-owned SDK facade  
**Date**: 2026-05-26  
**Branch**: spec-20-opencode-materialization  

---

## Summary

Task 1.0 establishes the dependency-injection entry path for the OpenCode adapter and creates the narrow adapter-local facade that isolates all SDK agent operations. No global SDK state is created or mutated by the adapter. The injected client is the sole path for SDK-backed operations in subsequent tasks.

### What was done

1. **`opencode-client.ts` (new)** — Defines `OpenCodeClientFacade` interface with three methods: `listAgents()`, `createAgent()`, `updateAgent()`. All return `ResultAsync` with typed errors. Provides `SdkOpenCodeClient` as the SDK-backed implementation wrapping `OpencodeClient`. SDK calls are isolated here; no other adapter module calls the SDK directly.

2. **`index.ts` (updated)** — Added `client?: OpenCodeClientFacade` to `OpenCodeAdapterOptions`. The adapter stores it as `private readonly openCodeClient`. No global state. Exports `OpenCodeClientFacade`, `OpenCodeClientError`, and `SdkOpenCodeClient` for callers. The `init()` log now includes `hasClient` to aid debugging.

3. **`sdk-types.ts` (unchanged)** — Already exports all types needed by the facade (`OpenCodeAgent`, `OpenCodeAgentConfig`, `OpencodeClient`). No additions required; the boundary is intact.

4. **`adapter.test.ts` (new)** — 18 tests covering construction (with/without client), `init()` behavior, client isolation (two adapters are independent), `spawnSubagent()` translation, `loadAvailableSkills()` stub, and the `MockOpenCodeClient` facade contract.

---

## Acceptance Criteria Evidence

### AC1: `index.ts` shows injected client/facade constructor options with no hidden global SDK state

**Diff summary** — `OpenCodeAdapterOptions` now includes:
```ts
readonly client?: OpenCodeClientFacade;
```
Stored as:
```ts
private readonly openCodeClient: OpenCodeClientFacade | undefined;
```
No module-level SDK client variable exists. The adapter is stateless with respect to the SDK until a caller injects a client.

### AC2: `opencode-client.ts` defines the narrow adapter-local list/create/update facade

File created at `packages/adapters/opencode/src/opencode-client.ts`.

Interface:
```ts
export interface OpenCodeClientFacade {
  listAgents(): ResultAsync<OpenCodeAgent[], OpenCodeClientError>;
  createAgent(name: string, config: OpenCodeAgentConfig): ResultAsync<void, OpenCodeClientError>;
  updateAgent(name: string, config: OpenCodeAgentConfig): ResultAsync<void, OpenCodeClientError>;
}
```

`SdkOpenCodeClient` implements this by wrapping `client.app.agents()` (list) and `client.config.update()` (create/update). All SDK calls are wrapped in `ResultAsync.fromPromise` with typed error variants.

### AC3: `sdk-types.ts` remains the only direct SDK import surface

`opencode-client.ts` imports only from `./sdk-types.js` — not from `@opencode-ai/sdk` directly. `index.ts` imports from `./opencode-client.js` and `./sdk-types.js`. No other adapter module imports from `@opencode-ai/sdk`.

Verified by grep:
```
$ grep -r "from \"@opencode-ai/sdk\"" packages/adapters/opencode/src/
packages/adapters/opencode/src/sdk-types.ts:} from "@opencode-ai/sdk";
packages/adapters/opencode/src/sdk-types.ts:} from "@opencode-ai/sdk";
```
Only `sdk-types.ts` imports from the SDK.

### AC4: `bun test packages/adapters/opencode/src/__tests__/adapter.test.ts` passes

```
bun test v1.3.13 (bf2e2cec)

 18 pass
 0 fail
 40 expect() calls
Ran 18 tests across 1 file. [60.00ms]
```

Full adapter suite (both test files):
```
 26 pass
 0 fail
 74 expect() calls
Ran 26 tests across 2 files. [53.00ms]
```

### AC5: Typecheck passes

```
$ bun run typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

---

## Raw Evidence

### Test run (targeted)

```
$ cd /Users/jose/projects/weave.worktrees/spec-20-opencode-materialization
$ bun test packages/adapters/opencode/src/__tests__/adapter.test.ts

bun test v1.3.13 (bf2e2cec)

 18 pass
 0 fail
 40 expect() calls
Ran 18 tests across 1 file. [60.00ms]
```

### SDK import surface check

```
$ grep -r "from \"@opencode-ai/sdk\"" packages/adapters/opencode/src/
packages/adapters/opencode/src/sdk-types.ts:} from "@opencode-ai/sdk";
packages/adapters/opencode/src/sdk-types.ts:} from "@opencode-ai/sdk";
```

### Files changed

| File | Change |
|------|--------|
| `packages/adapters/opencode/src/opencode-client.ts` | **Created** — `OpenCodeClientFacade` interface, `OpenCodeClientError` union, `SdkOpenCodeClient` implementation |
| `packages/adapters/opencode/src/index.ts` | **Updated** — added `client?` option to `OpenCodeAdapterOptions`, stored as `private readonly openCodeClient`, exported facade types |
| `packages/adapters/opencode/src/sdk-types.ts` | **Unchanged** — already exports all types needed by the facade |
| `packages/adapters/opencode/src/__tests__/adapter.test.ts` | **Created** — 18 tests with `MockOpenCodeClient` |
| `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-01-proofs.md` | **Created** — this file |

---

## Design Decisions

- **`createAgent` and `updateAgent` are semantically distinct but SDK-identical**: Both call `client.config.update()` with a patch. The distinction is enforced at the reconciliation layer (task 3), not the facade. This keeps the facade minimal and the reconciliation logic testable in isolation.
- **`listAgents` uses `client.app.agents()`**: This is the only SDK endpoint that returns the live agent list. The `Config` type's `agent` map is write-only from the adapter's perspective.
- **`ResultAsync.fromPromise` wraps all SDK calls**: Consistent with the repo's `neverthrow` policy. Error variants are typed discriminated unions, not bare strings.
- **`spawnSubagent()` remains translation-only in task 1**: SDK-backed materialization is task 2. The `openCodeClient` field is stored but not yet called in `spawnSubagent()`. This is intentional and tested explicitly.
