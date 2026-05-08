# Task 03 Proofs — Config File Discovery and Parsing

## Task Summary

Implemented `discoverAndParse()` with a `FileReader` injection interface, covering
discovery of `~/.weave/config.weave` (global) and `.weave/config.weave` (project),
graceful handling of missing files, `FileReadError` on I/O failure, `ParseError` on
invalid DSL, and error aggregation across both scopes.

## What This Task Proves

- Both scope paths are checked in the correct order (global first, project second).
- Missing files are silently skipped — not treated as errors.
- `FileReadError` is returned when a file exists but cannot be read.
- `ParseError` is returned with the file path when DSL is invalid.
- Errors from both scopes are aggregated into a single `err` result.
- All 8 tests pass using a mock `FileReader` — no real filesystem access.

## Evidence Summary

`bun test` shows 8/8 pass for `discovery.test.ts`. `bun run typecheck` exits 0.

---

## Artifact: `discovery.test.ts` — all 8 tests pass

**What it proves:** All discovery scenarios — both files, one file, no files, read error, parse error, aggregation — behave correctly.
**Why it matters:** Discovery is the gate between the filesystem and the merge pipeline. Incorrect behaviour here would either silently skip configs or crash on expected missing files.
**Command:**

```bash
bun test packages/config/src/__tests__/discovery.test.ts
```

**Result summary:** 8 pass, 0 fail.

```
packages/config/src/__tests__/discovery.test.ts:
(pass) discoverAndParse > (a) both files exist → returns 2 entries, global first [1.97ms]
(pass) discoverAndParse > (b) only global exists → returns 1 entry with kind global [0.13ms]
(pass) discoverAndParse > (c) only project exists → returns 1 entry with kind project [0.03ms]
(pass) discoverAndParse > (d) neither file exists → returns empty array, not an error [0.08ms]
(pass) discoverAndParse > (e) file exists but read fails → returns err with FileReadError containing the path [0.08ms]
(pass) discoverAndParse > (f) file reads but has invalid DSL → returns err with ParseError containing path and errors [0.10ms]
(pass) discoverAndParse > (g) global parse error does not prevent project discovery — errors aggregated [0.11ms]
(pass) discoverAndParse > (h) both files have invalid DSL → err with 2 errors, both paths present [0.07ms]

 8 pass
 0 fail
 28 expect() calls
Ran 8 tests across 1 file. [82.00ms]
```

---

## Artifact: `bun run typecheck` — zero errors

**What it proves:** `discovery.ts` is correctly typed, including the `FileReader` interface and `ResultAsync` composition.
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

Config file discovery handles all specified scenarios: both configs present, one config
present, neither present, I/O failure, DSL failure, and cross-scope error aggregation.
Tests use a mock `FileReader` — no real filesystem reads occur during the test suite.
