# Remaining: Oxlint and Oxfmt migration

## Integrated checkpoint

- Integration branch: `integration/all-active-workstreams`
- Source branch: `chore/oxlint-oxfmt-migration`
- Source checkpoint: `50ecd9e7f33053bf22568795dd02093e37ba212c`
- The source plan `.weave/plans/oxlint-oxfmt-full-green-migration.md` is not present in this integrated branch. This root note is the retained handoff for that workstream.
- Source Tasks 1–25 were complete. Task 26 was in progress. Tasks 27–41 remain.

The integrated branch includes the Task 26 plan/artifact projection changes and the previously uncommitted delegation controller/tool work. The integration now passes workspace typecheck and the full test suite, but the full Oxlint migration is not complete.

## Current blocker

`bun run lint` fails in the integrated branch with 6,617 Oxlint errors and 1,718 warnings across 379 files. Most failures come from Pi model-fallback, child-streaming, and release code integrated after the migration checkpoint. Common rules include:

- `anti-slop/no-runtime-typeof`
- `anti-slop/require-safety-comment-for-type-assertion`
- `anti-slop/no-unknown-parameters`
- `anti-slop/no-conditional-empty-object-spread`
- `anti-slop/no-unsafe-dictionary-type`

The exact final run is saved locally at `/tmp/weave-all-active-lint.log`; it is not a durable repository artifact.

## Current validation

At the integrated branch checkpoint:

- Full repository tests: 11,990 passed, 12 skipped, 0 failed.
- Workspace typecheck: passed.
- Build: passed.
- Biome on the integration repair files: passed.
- Documentation links: passed.
- Action pins: passed.
- CODEOWNERS: passed.
- Changeset policy: passed.
- API report check: passed.
- Full lint: failed as described above.

## Next safe action

1. Continue the migration against the integrated branch, not the obsolete source worktree status.
2. Fix lint findings in bounded groups without weakening rules.
3. Run focused tests and typecheck after each group.
4. Finish the remaining source-plan task sequence or create a replacement plan before broad continuation.
5. Run the final formatting, lint, declarations, config validation, typecheck, tests, build, docs links, action pins, CODEOWNERS, and Changesets gates.

Do not modify or restore `~/.weave/config.weave` or shared Pi settings. Use isolated temporary HOME, config, runtime, data, cache, and temporary directories for config-sensitive tests and proofs.
