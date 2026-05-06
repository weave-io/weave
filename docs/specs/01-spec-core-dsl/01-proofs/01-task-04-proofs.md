# Task 04 Proofs — Schema Validation: AST to Validated `WeaveConfig`

## Task Summary

Task 4.0 implements `schema.ts` (Zod schemas and inferred types) and `validate.ts` (the `validate()` function that walks an `AstNode[]`, converts it to a plain object, and runs it through Zod). This is the third and final stage of the pipeline before the `WeaveConfig` is returned to callers.

Key design decisions implemented here:

- All TypeScript config types are `z.infer<>` derivations — no hand-written interfaces.
- `AgentConfigSchema` has two `.refine()` checks: `prompt`/`prompt_file` mutual exclusivity, and `prompt_file` path safety (no `..`, no absolute paths).
- `CategoryConfigSchema` enforces `patterns` has at least one entry.
- `DisabledConfigSchema` defaults all three arrays to `[]`.
- `WeaveConfigSchema` defaults `agents`, `categories`, and `disabled` so an empty source produces a valid config.

## What This Task Proves

- `ToolPermissionSchema`, `DelegationTriggerSchema`, `AgentConfigSchema`, `CategoryConfigSchema`, `DisabledConfigSchema`, and `WeaveConfigSchema` all compile and validate correctly.
- Valid agents and categories pass validation and produce correctly typed output.
- `prompt` + `prompt_file` together → `ValidationError` with "mutually exclusive" message.
- `prompt_file` with `..` or absolute path → `ValidationError` with "relative path" message.
- Invalid `tool_policy` value, out-of-range `temperature`, invalid `mode`, and empty `patterns` all produce `ValidationError` with the correct path.
- Multiple agents where one is invalid produce an error path that includes the agent name (e.g. `agents.bad-agent.temperature`).
- An empty `AstNode[]` produces a valid `WeaveConfig` with empty defaults.
- `disable` directives and `log_level` settings round-trip correctly.
- All 15 validation tests pass; workspace typechecks clean.

## Evidence Summary

Two artifacts: validation test suite output (15/15 pass) and workspace typecheck confirmation.

---

## Artifact: Validation Test Suite — 15/15 Pass

**What it proves:** All schema fields, cross-field refinements, path-safety checks, and error path construction work correctly for every case specified in task 4.3.
**Why it matters:** The validator is the spec's trust boundary — it turns an untyped AST into a typed, guaranteed-valid `WeaveConfig`. Every gap here would allow malformed config to reach runtime.

**Command:**

```bash
bun test packages/core/src/__tests__/validate.test.ts
```

**Result summary:** 15 tests pass covering valid agents, valid categories, mutual exclusivity refinement, path-safety refinement, four constraint error cases, partial-error path reporting, empty-source defaults, disable directives, and log_level validation.

```
bun test v1.3.13 (bf2e2cec)

packages/core/src/__tests__/validate.test.ts:
(pass) validate — valid agent > valid agent with all fields [2.35ms]
(pass) validate — valid agent > agent with prompt_file (safe path)
(pass) validate — valid category > category with patterns and tool_policy [0.42ms]
(pass) validate — mutual exclusivity errors > both prompt and prompt_file set → err [0.34ms]
(pass) validate — prompt_file path safety > prompt_file with '..' → err [0.11ms]
(pass) validate — prompt_file path safety > prompt_file with absolute path → err [0.07ms]
(pass) validate — schema constraint errors > invalid tool_policy value → err [0.18ms]
(pass) validate — schema constraint errors > temperature above 2.0 → err [0.12ms]
(pass) validate — schema constraint errors > invalid mode → err [0.07ms]
(pass) validate — schema constraint errors > empty patterns array on category → err [0.08ms]
(pass) validate — multiple agents, partial errors > one valid and one invalid agent → err with path [0.14ms]
(pass) validate — empty source > empty AST → ok with defaults [0.04ms]
(pass) validate — disable directives > disable agents is reflected in config.disabled [0.29ms]
(pass) validate — log_level setting > valid log_level is included in config [0.04ms]
(pass) validate — log_level setting > invalid log_level → err [0.06ms]

 15 pass
 0 fail
 36 expect() calls
Ran 15 tests across 1 file. [34.00ms]
```

---

## Artifact: Workspace Typecheck — Zero Errors

**What it proves:** The Zod-inferred types (`AgentConfig`, `WeaveConfig`, etc.) are structurally compatible with all consumers — including `runner.ts` and `adapter.ts` in the engine package.
**Why it matters:** The inferred types replace all hand-written config interfaces; if any consumer expected a different shape, it would fail typecheck here.

**Command:**

```bash
bun run typecheck
```

**Result summary:** All three workspace packages typecheck with exit code 0.

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Reviewer Conclusion

Task 4.0 is complete. `schema.ts` defines all Zod schemas with correct refinements and default values. `validate.ts` correctly walks the AST, builds a plain object, and runs it through Zod with proper error mapping. All 15 validation tests pass and the workspace typechecks cleanly.
