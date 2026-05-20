# Task 6 Proof Artifact — Read-Only Runtime Inspection CLI Commands

## Task Summary

Task 6 adds two read-only runtime inspection commands to the Weave CLI:

- `weave runtime status` — shows DB path, active lease summary, and recent/resumable workflow instance summaries
- `weave runtime journal --limit <n>` — shows recent fixed-envelope journal entries in deterministic text (default limit: 50)

Both commands open the default Runtime Store path (`.weave/runtime/weave.db`) in read-only inspection mode. If the store does not exist, they report a friendly message and exit 0 without creating any files.

Output never includes raw prompts, completions, transcripts, credentials, cookies, authorization headers, tokens, or raw provider payloads.

## What This Proves

1. CLI argument parsing/routing for `weave runtime status` and `weave runtime journal --limit <n>` with default limit 50
2. Read-only runtime command module that opens the default Runtime Store path without creating or mutating state for inspection-only flows unless the store already exists
3. `runtime status` renders: DB path, active lease summary, recent/resumable workflow instance summaries
4. `runtime journal --limit <n>` renders recent fixed-envelope entries in deterministic text suitable for TOON-style LLM consumption
5. CLI output never includes raw prompts, completions, transcripts, credentials, cookies, authorization headers, tokens, or raw provider payloads
6. Missing-runtime behavior: reports "no Runtime Store found" without creating `.weave/runtime/weave.db`
7. CLI command tests for: status output, journal limit behavior, missing runtime, sanitized deterministic output, routing/help, and read-only behavior

## Evidence: Test Run

```
bun test packages/cli/src/commands/__tests__/runtime.test.ts

bun test v1.3.13 (bf2e2cec)

 26 pass
 0 fail
 70 expect() calls
Ran 26 tests across 1 file. [48.00ms]
```

### Test Coverage

- `runtime — missing store` (2 tests): reports "No runtime store found" for both status and journal; does not create DB
- `runtime status` (6 tests): renders status with DB path; shows no active lease when empty; shows active lease when one exists; shows workflow instances; shows resumable instances; does not mutate the store
- `runtime journal` (6 tests): renders journal header; shows no entries when empty; renders entries with timestamp/severity/source/eventType; respects --limit flag; defaults to limit 50; sanitizes output; does not mutate the store; deterministic output
- `runtime — arg parsing` (5 tests): parses `runtime status`; parses `runtime journal`; parses `runtime journal --limit 10`; defaults limit to 50; returns error for missing --limit value
- `runtime — CLI router integration` (4 tests): routes `runtime status` through CLI router; routes `runtime journal` through CLI router; shows usage when `runtime` called without subcommand; help output includes `runtime status` and `runtime journal`

## Evidence: CLI Build

```
bun run --filter '@weave/cli' build

@weave/cli build: Bundled 422 modules in 15ms
@weave/cli build:
@weave/cli build:   index.js  1.34 MB  (entry point)
@weave/cli build:   main.js   1.34 MB  (entry point)
@weave/cli build:
@weave/cli build: Exited with code 0
```

## Evidence: Help Output Includes runtime status and runtime journal

```
$ weave --help

  COMMANDS

    init                    Create Weave config and install into harnesses
    validate               Validate .weave configuration files
    runtime status         Show runtime store status
    runtime journal        Show recent journal entries (--limit <n>)
```

## Evidence: Missing-Runtime Behavior

```
$ weave runtime status
No runtime store found at /Users/jose/projects/weave/.weave/runtime/weave.db

$ weave runtime journal --limit 5
No runtime store found at /Users/jose/projects/weave/.weave/runtime/weave.db
```

Exit code: 0 in both cases. No `.weave/runtime/weave.db` file was created.

## Evidence: Usage When No Subcommand

```
$ weave runtime
Usage: weave runtime <subcommand>

  weave runtime status              Show runtime store status
  weave runtime journal [--limit <n>]  Show recent journal entries
```

Exit code: 1.

## Evidence: Full Suite Pass Count

```
bun test

 1295 pass
 0 fail
 3412 expect() calls
Ran 1295 tests across 40 files. [537.00ms]
```

## Files Changed

| File | Change |
|------|--------|
| `packages/cli/src/commands/runtime.ts` | New — read-only runtime inspection command module |
| `packages/cli/src/commands/__tests__/runtime.test.ts` | New — 26 tests for runtime commands |
| `packages/cli/src/args.ts` | Added `runtime` command, `--limit` flag, `runtimeSubcommand` flag |
| `packages/cli/src/cli.ts` | Added `runtime` case to router |
| `packages/cli/src/theme/render.ts` | Added `runtime status` and `runtime journal` to help output |
| `packages/engine/src/index.ts` | Exported `createSqliteRuntimeStore`, `SqliteRuntimeStore`, `SqliteRuntimeStoreOptions` |

## Security Notes

- Output sanitization: the `formatJournalEntry` function defensively filters any data keys matching the engine's denylist (token, apiKey, password, secret, authorization, cookie, bearer, prompt, completion, transcript, etc.) before rendering
- The `RuntimeCommandContext.dbExists` check prevents DB creation: if the file does not exist, the store factory is never called
- The store is opened read-only in practice: `runRuntimeStatus` and `runRuntimeJournal` only call `findActive()`, `list()`, `query()`, and `close()` — no write operations
- Tests verify read-only behavior by asserting the store state is unchanged after command execution
