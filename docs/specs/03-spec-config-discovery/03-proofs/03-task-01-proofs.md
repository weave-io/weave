# Task 01 Proofs — `@weave/config` Package Scaffold and Error Types

## Task Summary

Created the `@weave/config` workspace package with all boilerplate, defined the
`ConfigLoadError` discriminated union and `ConfigScope` type, and integrated
the package into the root workspace. This is the prerequisite for all other
tasks in Spec 03.

## What This Task Proves

- `packages/config/` exists with a complete `package.json`, tsconfigs, and source stubs.
- `bun install` resolves and links the new workspace package without errors.
- `bun run typecheck` reports zero errors across the entire workspace, including the
  new `@weave/config` path mappings.
- The bundler step of `bun run build` succeeds for `@weave/config`.

## Evidence Summary

`bun install` links the package. `bun run typecheck` passes with zero errors across all
four packages. The `bun build` bundler step succeeds; the `tsc --emitDeclarationOnly`
step fails with the same pre-existing error that affects `@weave/engine` and `@weave/core`
(missing `composite: true` in the referenced `packages/core` project — not introduced
by this change).

---

## Artifact: Package file structure

**What it proves:** `packages/config/` exists with all required files.
**Why it matters:** Correct file layout is required for workspace resolution and TypeScript path mappings.
**Command:**
```bash
find packages/config -type f | sort
```
**Result summary:** All scaffold files present.
```
packages/config/package.json
packages/config/prompts/loom.md
packages/config/prompts/pattern.md
packages/config/prompts/shuttle.md
packages/config/prompts/spindle.md
packages/config/prompts/tapestry.md
packages/config/prompts/thread.md
packages/config/prompts/warp.md
packages/config/prompts/weft.md
packages/config/src/__tests__/builtins.test.ts
packages/config/src/__tests__/discovery.test.ts
packages/config/src/__tests__/load_config.test.ts
packages/config/src/__tests__/merge.test.ts
packages/config/src/__tests__/resolve.test.ts
packages/config/src/builtins.ts
packages/config/src/discovery.ts
packages/config/src/errors.ts
packages/config/src/index.ts
packages/config/src/loader.ts
packages/config/src/logger.ts
packages/config/src/merge.ts
packages/config/src/resolve.ts
packages/config/src/types.ts
packages/config/tsconfig.build.json
packages/config/tsconfig.json
```

---

## Artifact: `bun install` — workspace package resolved

**What it proves:** The new `@weave/config` package is recognized as a workspace member and all dependencies resolve.
**Why it matters:** If `bun install` fails, no code in `@weave/config` can be imported by other packages.
**Command:**
```bash
bun install
```
**Result summary:** All 58 installs resolve, no changes needed; husky hook runs successfully.
```
bun install v1.3.13 (bf2e2cec)

$ husky

Checked 58 installs across 64 packages (no changes) [93.00ms]
```

---

## Artifact: `bun run typecheck` — zero errors across entire workspace

**What it proves:** `@weave/config` path mappings are correct, all source files type-check, and no cross-package type errors were introduced.
**Why it matters:** Type errors here would indicate broken imports, incorrect type exports, or misconfigured `tsconfig.json`.
**Command:**
```bash
bun run typecheck
```
**Result summary:** All four packages (`@weave/core`, `@weave/engine`, `@weave/config`, `@weave/adapter-opencode`) exit with code 0.
```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Artifact: `bun run build` — bundler step succeeds

**What it proves:** The package can be bundled for runtime; the public API is importable.
**Why it matters:** The bundled `dist/index.js` is what downstream packages consume at runtime.
**Command:**
```bash
cd packages/config && bun run build
```
**Result summary:** `bun build` succeeds and produces `dist/index.js` (0.72 MB). The subsequent `tsc --emitDeclarationOnly` step fails with the same pre-existing `TS6306`/`TS6310` error that affects `@weave/engine` and `@weave/core` — caused by `packages/core/tsconfig.build.json` not having `composite: true` recognized via `extends`. This is not introduced by this task.
```
$ bun build ./src/index.ts --outdir ./dist --target bun && tsc -p tsconfig.build.json --emitDeclarationOnly
Bundled 124 modules in 20ms

  index.js  0.72 MB  (entry point)

tsconfig.build.json(9,5): error TS6306: Referenced project '…/packages/core' must have setting "composite": true.
tsconfig.build.json(9,5): error TS6310: Referenced project '…/packages/core' may not disable emit.
```

---

## Reviewer Conclusion

The `@weave/config` workspace package is fully scaffolded and integrated. `bun install`
and `bun run typecheck` both pass cleanly. The bundler step produces a valid `dist/index.js`.
The `tsc --emitDeclarationOnly` failure is a pre-existing workspace-wide issue unrelated
to this task, present identically in `@weave/engine`.
