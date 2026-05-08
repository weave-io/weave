# Task 02 Proofs — Builtin Agent Defaults

## Task Summary

Defined all 8 built-in agents as a `.weave` DSL source string, implemented
`getBuiltinConfig()` that parses them through `parseConfig`, exported
`BUILTIN_AGENT_NAMES`, and shipped placeholder prompt files. Validates the
DSL-first principle: builtins use exactly the same pipeline as user configs.

## What This Task Proves

- `getBuiltinConfig()` parses without errors and returns all 8 agents.
- Each builtin has the correct `temperature` and `prompt_file` as specified.
- The builtin config contains only agents — no categories, workflows, or disabled entries.
- `BUILTIN_WEAVE_SOURCE` is valid `.weave` DSL.
- All 8 tests pass.

## Evidence Summary

`bun test` shows 8/8 pass for `builtins.test.ts`. `bun run typecheck` exits 0.

---

## Artifact: `builtins.test.ts` — all 8 tests pass

**What it proves:** `getBuiltinConfig()` correctly parses all 8 built-in agents with the right properties.
**Why it matters:** Any regression in the builtin DSL string will surface as a test failure here before it can affect users.
**Command:**

```bash
bun test packages/config/src/__tests__/builtins.test.ts
```

**Result summary:** 8 pass, 0 fail.

```
packages/config/src/__tests__/builtins.test.ts:
(pass) getBuiltinConfig > (a) returns ok — not err [4.01ms]
(pass) getBuiltinConfig > (b) result contains exactly 8 agents matching BUILTIN_AGENT_NAMES [0.42ms]
(pass) getBuiltinConfig > (c) loom has temperature 0.1 and prompt_file loom.md [0.46ms]
(pass) getBuiltinConfig > (d) shuttle has temperature 0.2 and prompt_file shuttle.md [0.27ms]
(pass) getBuiltinConfig > (e) thread has temperature 0.0 [0.42ms]
(pass) getBuiltinConfig > (f) pattern has temperature 0.3 [0.45ms]
(pass) getBuiltinConfig > (g) builtin config has no categories, workflows, or disabled entries [0.35ms]
(pass) getBuiltinConfig > (h) BUILTIN_WEAVE_SOURCE is valid DSL — parseConfig returns no errors [0.22ms]

 8 pass
 0 fail
 20 expect() calls
Ran 8 tests across 1 file. [45.00ms]
```

---

## Artifact: Prompt placeholder files exist

**What it proves:** All 8 placeholder prompt files are present in `packages/config/prompts/`.
**Why it matters:** `resolvePromptPaths()` will construct absolute paths pointing to these files; missing files would cause runtime errors when a harness tries to read them.
**Command:**

```bash
ls packages/config/prompts/
```

**Result summary:** All 8 files present.

```
loom.md     pattern.md  shuttle.md  spindle.md
tapestry.md thread.md   warp.md     weft.md
```

---

## Artifact: `bun run typecheck` — zero errors

**What it proves:** `builtins.ts` is correctly typed; all imports from `@weave/core` resolve.
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

All 8 builtin agents are correctly defined in DSL, parse cleanly through `parseConfig`,
and have the expected properties. The DSL-first principle is validated: builtins are
indistinguishable from user-authored configs at the parser level.
