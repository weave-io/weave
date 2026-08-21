# Remaining: Oxlint and Oxfmt migration

## Checkpoint

- Branch: `chore/oxlint-oxfmt-migration`
- Plan: `.weave/plans/oxlint-oxfmt-full-green-migration.md`
- Tasks 1–25 are complete.
- Task 26 is in progress.
- Checkpoint commit: `50ecd9e7f33053bf22568795dd02093e37ba212c`

The checkpoint commit contains only these six Task 26 files:

- `packages/adapters/pi/src/active-plan-ui-state.ts`
- `packages/adapters/pi/src/artifact-provider.ts`
- `packages/adapters/pi/src/dispatch-snapshot.ts`
- `packages/adapters/pi/src/foreground-plan-display.ts`
- `packages/adapters/pi/src/plan-task-list.ts`
- `packages/adapters/pi/src/runtime-store-port.ts`

## Work still in progress

The following Task 26 files have uncommitted work and must remain unstaged until their type errors and focused tests are resolved:

- `packages/adapters/pi/src/delegation-controller.ts`
- `packages/adapters/pi/src/delegation-tool.ts`

Current Pi typecheck blockers are readonly assignments to `model` and `reasoning` in `delegation-controller.ts` near lines 2570–2571.

Task 26 also still includes these production files, which need a final strict-lint audit or implementation pass:

- `packages/adapters/pi/src/plan-catalog.ts`
- `packages/adapters/pi/src/plan-provider.ts`
- `packages/adapters/pi/src/plan-render.ts`
- `packages/adapters/pi/src/workflow-commands.ts`
- `packages/adapters/pi/src/workflow-controller.ts`

Tasks 27–41 remain after Task 26. Follow their order and acceptance criteria in the plan.

## Validation completed for the checkpoint

- Six-file Oxlint with warnings denied: passed.
- Biome 2.4.14 check on the six files: passed.
- Focused artifact, plan, display, runtime-store, and dispatch tests: 145 passed, 0 failed.
- `git diff --check`: passed.
- Pre-commit repository hook: 11,132 passed, 11 skipped, 0 failed.
- Pi package typecheck: blocked only by the two unstaged Task 26 WIP assignments listed above.

## Next safe action

1. Fix the two readonly assignment errors without weakening the dispatch model contract.
2. Run focused delegation controller/tool tests and Pi typecheck.
3. Finish the remaining Task 26 files and run the full Task 26 acceptance suite.
4. Continue Tasks 27–41 in plan order.
5. Run the final Oxlint/Oxfmt migration gate, including formatting, lint, declarations, config validation, typecheck, tests, build, docs links, action pins, CODEOWNERS, and changeset checks.

Do not modify or restore `~/.weave/config.weave` or shared Pi settings. Any config-sensitive proof must use isolated temporary HOME, config, runtime, data, cache, and temporary directories.
