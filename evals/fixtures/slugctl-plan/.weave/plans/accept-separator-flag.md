# Accept the documented --separator flag

## TL;DR
`slugctl --separator _ "Hello World"` prints `hello-world`, but the README says it prints `hello_world`. Make the CLI honour `--separator`.

## Context
The README and the usage line in `src/run.ts` document `--separator <sep>`. `parseArgs` in `src/args.ts` only reads `--sep` and silently ignores unknown flags, so `--separator` and its value fall through.

## Scope
- In scope: reading `--separator` in `parseArgs`.
- Out of scope: new flags, changes to `slugify`.

## Tasks

- [ ] 1. Read --separator in parseArgs
  - **What**: Make `parseArgs` read `--separator <sep>`. Keep `--sep` working as an alias.
  - **Files**: `src/args.ts`, `test/args.test.ts`
  - **Depends on**: None
  - **Acceptance**:
    - `parseArgs(["--separator", "_", "Hello"]).separator` is `"_"` — verify by: `bun test`
    - `parseArgs(["--sep", "_", "Hello"]).separator` is still `"_"` — verify by: `bun test`

## Verification
- [ ] `bun test` — all tests pass
