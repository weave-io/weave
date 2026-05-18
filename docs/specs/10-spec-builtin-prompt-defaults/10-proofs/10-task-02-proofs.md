# Task 02 Proofs — Builtin delegation triggers and end-to-end composition smoke

## Task Summary

This task proves that builtin delegation triggers are now declared in canonical config (`builtins.ts`), that the composition pipeline generates `## Delegation` sections for delegating agents (Loom, Tapestry) and suppresses them for non-delegating agents, and that all 8 builtins compose to non-empty prompts through the public config + engine APIs.

## What This Task Proves

- Specialist agents (shuttle, pattern, thread, spindle, weft, warp) have `triggers` in canonical builtin config.
- Orchestrator agents (loom, tapestry) have no triggers — they are not delegation targets.
- Loom and Tapestry composedPrompts contain a generated `## Delegation` section.
- Non-delegating builtins (shuttle, pattern, thread, spindle, weft, warp) do NOT contain `## Delegation`.
- All 8 builtins compose to non-empty prompts through the public config + engine APIs.

## Evidence Summary

- 714 tests pass across the full suite with 0 failures.
- `builtins.test.ts` extended with 3 new trigger assertions (11 total).
- New `builtin-compose-smoke.test.ts` (15 tests) crosses `@weave/config` + `@weave/engine` boundary and asserts delegation section presence/absence per agent.

## Artifact: Full test suite

**What it proves:** No regressions introduced; all new trigger and composition assertions pass.

**Why it matters:** The smoke test is the integration proof that the full pipeline — config loading → trigger parsing → composition → delegation section generation — works end-to-end.

**Command:**

```bash
bun test
```

**Result summary:** 714 pass, 0 fail across all packages.

```
bun test v1.3.13 (bf2e2cec)

 714 pass
 0 fail
Ran 714 tests across 33 files.
```

## Artifact: Builtin trigger assertions

**What it proves:** Specialist agents have triggers in canonical builtin config; orchestrators do not.

**Why it matters:** Triggers are the delegation inventory — without them, the composer cannot generate `## Delegation` sections for Loom and Tapestry.

**Command:**

```bash
bun test packages/config/src/__tests__/builtins.test.ts
```

**Result summary:** 11 tests pass. New assertions confirm shuttle/pattern/thread/spindle/weft/warp each have ≥1 trigger, loom/tapestry have no triggers, and all trigger strings are non-empty.

## Artifact: Compose smoke test — delegation section presence/absence

**What it proves:** Loom and Tapestry generate `## Delegation` sections; non-delegating builtins do not.

**Why it matters:** This is the end-to-end proof that the composer correctly gates delegation section generation based on tool_policy and trigger availability.

**Command:**

```bash
bun test packages/config/src/__tests__/builtin-compose-smoke.test.ts
```

**Result summary:** 15 tests pass. Loom and Tapestry composedPrompts contain `## Delegation`. Shuttle, Pattern, Thread, Spindle, Weft, Warp composedPrompts do not contain `## Delegation`. All 8 builtins compose to non-empty prompts.

## Artifact: Typecheck

**What it proves:** No TypeScript errors introduced by adding `@weave/engine` as a workspace dependency to `@weave/config`.

**Command:**

```bash
bun run typecheck
```

**Result summary:** All 5 packages exit 0.

## Reviewer Conclusion

Builtin delegation triggers are now in canonical config. The composition pipeline correctly generates delegation sections for Loom and Tapestry (the delegating orchestrators) and suppresses them for the 6 non-delegating specialists. All 8 builtins compose to non-empty prompts, proven by a 15-test integration smoke test crossing the config/engine package boundary.
