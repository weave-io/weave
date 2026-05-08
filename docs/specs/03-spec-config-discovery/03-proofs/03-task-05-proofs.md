# Task 05 Proofs — Prompt Resolution, Public API, and Documentation

## Task Summary

Implemented `resolvePromptPaths()` for all three scopes, wired the full `loadConfig()`
pipeline (builtins → discover → parse → resolve → merge → return), completed the
barrel exports, and created `docs/config-loading.md`.

## What This Task Proves

- `resolvePromptPaths()` correctly constructs absolute paths for all three scopes.
- Agents without `prompt_file` are unchanged; immutability is preserved.
- `loadConfig()` end-to-end: zero-config returns 8 builtins with absolute paths; project
  overrides work correctly; global custom agents merge with builtins; three-layer merge
  is correct; parse errors and I/O errors propagate with correct file paths.
- All `prompt_file` values in the final merged config are absolute paths.
- Full test suite (193 tests) passes.
- Typecheck passes with zero errors.
- Biome reports no lint errors.
- `docs/config-loading.md` exists with all required sections.

## Evidence Summary

`resolve.test.ts` (6/6 pass) and `load_config.test.ts` (8/8 pass) exercise the full
pipeline. Full suite: 193 pass, 0 fail. Typecheck: clean. Biome: clean.

---

## Artifact: `resolve.test.ts` — 6 tests pass

**What it proves:** Prompt paths are resolved correctly for builtin, global, and project scopes; agents without `prompt_file` are unchanged; input is not mutated.
**Command:**

```bash
bun test packages/config/src/__tests__/resolve.test.ts
```

**Result summary:** 6 pass, 0 fail.

```
packages/config/src/__tests__/resolve.test.ts:
(pass) resolvePromptPaths > (a) builtin scope: resolves prompt_file relative to rootDir/prompts/ [3.47ms]
(pass) resolvePromptPaths > (b) global scope: resolves prompt_file to ~/.weave/prompts/<file> [0.21ms]
(pass) resolvePromptPaths > (c) project scope: resolves prompt_file to <projectRoot>/.weave/prompts/<file> [0.13ms]
(pass) resolvePromptPaths > (d) agent without prompt_file is left unchanged [0.28ms]
(pass) resolvePromptPaths > (e) mixed agents: only agent with prompt_file is resolved [0.20ms]
(pass) resolvePromptPaths > (f) immutability: original config not mutated [0.18ms]

 6 pass
 0 fail
 9 expect() calls
```

---

## Artifact: `load_config.test.ts` — 8 tests pass

**What it proves:** The full `loadConfig()` pipeline is correct end-to-end: zero-config, project override, global custom agent, three-layer merge, parse error propagation, I/O error propagation, and absolute prompt paths.
**Command:**

```bash
bun test packages/config/src/__tests__/load_config.test.ts
```

**Result summary:** 8 pass, 0 fail.

```
packages/config/src/__tests__/load_config.test.ts:
(pass) loadConfig > (a) zero-config: no user files → returns ok with all 8 builtin agents [5.02ms]
(pass) loadConfig > (a) zero-config: prompt_file paths are absolute [0.55ms]
(pass) loadConfig > (b) project override: temperature overrides builtin, other fields preserved [0.70ms]
(pass) loadConfig > (c) global custom agent: merged config contains all 8 builtins + custom agent [0.37ms]
(pass) loadConfig > (d) both configs: three-layer merge — project log_level and loom temperature win [0.51ms]
(pass) loadConfig > (e) parse error: project config has invalid DSL → returns err with ParseError [0.50ms]
(pass) loadConfig > (f) I/O error: file read throws → returns err with FileReadError [0.29ms]
(pass) loadConfig > (g) all prompt_file values in returned config are absolute paths [0.24ms]

 8 pass
 0 fail
 46 expect() calls
```

---

## Artifact: Full test suite — 193 pass, 0 fail

**What it proves:** No regressions were introduced across the entire workspace.
**Why it matters:** The `@weave/config` package imports from `@weave/core` — any type or behaviour breakage would surface here.
**Command:**

```bash
bun test --recursive
```

**Result summary:** 193 pass, 0 fail across 14 files.

```
 193 pass
 0 fail
 563 expect() calls
Ran 193 tests across 14 files. [90.00ms]
```

---

## Artifact: `bun run typecheck` — zero errors

**What it proves:** All new modules are correctly typed; the full barrel exports are valid.
**Command:**

```bash
bun run typecheck
```

**Result summary:** All 4 packages exit 0.

```
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Artifact: Biome check — no errors

**What it proves:** All new files conform to the project's lint rules (no console.\*, no explicit any, useLiteralKeys, organizeImports, useNodejsImportProtocol).
**Command:**

```bash
npx @biomejs/biome check packages/config/
```

**Result summary:** No errors. No fixes applied.

```
Checked 18 files in 7ms. No fixes applied.
```

---

## Artifact: `docs/config-loading.md` exists with all required sections

**What it proves:** Living documentation is up to date with the implementation.
**Command:**

```bash
grep "^## " docs/config-loading.md
```

**Result summary:** All required sections present.

```
## Three-Layer Merge
## Builtin Agents
## Config Discovery
## Prompt File Resolution
## Public API
## Architectural Decision — Why a Separate `@weave/config` Package
```

---

## Reviewer Conclusion

All 42 tests in `@weave/config` pass. The full 193-test workspace suite is green.
Typecheck and Biome are both clean. `docs/config-loading.md` covers the three-layer
merge model, builtin agents, discovery, prompt resolution, public API, and an ADR
explaining why `@weave/config` is a separate package.
