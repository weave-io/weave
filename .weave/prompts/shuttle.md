# Shuttle — Weave Repo Override

> **Weave-repo delta.** This file extends the shipped builtin Shuttle prompt with
> standards specific to the Weave codebase. It is self-contained — do not rely on
> AGENTS.md being loaded.

---

## Weave Project Standards

You are working inside the **Weave** monorepo. Apply these rules on every task:

### Runtime — Bun only
- Use `Bun.file()` for file I/O, `Bun.spawn()` / `Bun.spawnSync()` for processes.
- `node:path` and `node:os` are allowed (Bun compatibility modules).
- Never use `fs`, `child_process`, `ts-node`, `nodemon`, or `@types/node`.

### Error handling — neverthrow
- All fallible functions return `Result<T, E>` (sync) or `ResultAsync<T, E>` (async).
- Never throw for expected failure paths.
- Use `Result.fromThrowable` / `ResultAsync.fromThrowable` to wrap third-party APIs.
- Error types are discriminated unions — never `unknown` or bare strings.

### Logging
- Use the shared pino instance from `@weave/engine`. Never use `console.*` anywhere in library code.

### Code style
- Early returns: guard at the top, keep the happy path unindented.
- Classes for state: group state and behaviour in a class; no loose functions sharing module-level state.
- No nested ternaries (one level max); use sequential `if` returns or `switch` for multi-branch logic.
- No nested `try/catch`; prefer neverthrow wrappers.

### Types
- Exported TypeScript types must be derived from Zod schemas (`z.infer<typeof Schema>`), not hand-written.
- Reuse types from `@weave/core` before creating new ones.

### Schema changes
- Every schema change in `schema.ts` must be reflected in the corresponding test file in the same commit.

---

## Definition of Done

A task is done when all of the following hold:

1. **Implementation complete** — all acceptance criteria from the task description are met.
2. **Type checking passes** — run `bun run typecheck`; zero errors.
3. **Tests pass** — run `bun test`; all tests green across affected packages.
4. **Build succeeds** — run `bun run build`; no build errors.
5. **Config valid** — if `.weave/config.weave` or `packages/config/src/builtins.ts` was touched, run `bun run validate-config`; exits 0.
6. **Documentation updated** — if behavior changed, relevant `docs/` files are updated.

Run only the checks relevant to what changed. Report which commands you ran and their outcomes.

---

## Validation Commands

| Command | When to run |
| --- | --- |
| `bun run typecheck` | Always |
| `bun test` | Always |
| `bun run build` | When package exports or types changed |
| `bun run validate-config` | When `.weave/config.weave` or `builtins.ts` changed |
| `bun test packages/config/src/__tests__/load_config.test.ts` | When config loading or merge logic changed |
| `bun test packages/core/src/__tests__/schema.test.ts` | When `schema.ts` changed |
