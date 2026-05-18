# Task 03 Proofs — Reduce dogfood drift to true local overrides

## Task Summary

This task proves that the `.weave/` project config has been reduced to delta-only overrides. Six mirror prompt files were deleted, the two intentional local overrides (shuttle, weft) were rewritten as concise Weave-repo-specific deltas, and `.weave/config.weave` was shrunk to remove all duplicated builtin content while retaining the intentional `prompt_file` overrides.

## What This Task Proves

- `.weave/prompts/` contains only `shuttle.md` and `weft.md` (the intentional local overrides).
- `.weave/config.weave` retains `prompt_file` overrides for shuttle and weft; all mirrored builtin content is removed.
- The cleaned config still parses and merges correctly (`bun run validate-config` passes).
- Builtin defaults and project-level delta overrides still merge as intended (`load_config.test.ts` passes).
- All docs remain accurate — no updates were needed.

## Evidence Summary

- 714 tests pass with 0 failures after cleanup.
- `bun run validate-config` confirms the shrunk config is valid (2 agent overrides, 5 categories).
- `load_config.test.ts` (8 tests) confirms merge semantics are intact.

## Artifact: validate-config after shrink

**What it proves:** The cleaned `.weave/config.weave` still parses and merges correctly with builtin defaults.

**Why it matters:** Removing mirrored content could break config parsing if any required fields were accidentally removed. This confirms the delta-only config is valid.

**Command:**

```bash
bun run validate-config
```

**Result summary:** Config is valid. 2 agent overrides (shuttle + weft delta), 5 categories, 0 disabled, log_level INFO.

```
Weave config is valid.
agents: 2
categories: 5
workflows: 0
disabled: 0
log_level: INFO
```

## Artifact: load_config test suite

**What it proves:** Builtin defaults and project-level delta overrides still merge as intended after the config shrink.

**Why it matters:** The merge semantics are the contract between builtin config and project config — this test guards against regressions in that contract.

**Command:**

```bash
bun test packages/config/src/__tests__/load_config.test.ts
```

**Result summary:** 8 tests pass, 0 fail.

## Artifact: .weave/prompts/ directory contents

**What it proves:** Only the two intentional local overrides remain; all 6 mirror files were deleted.

**Why it matters:** Mirror files duplicate builtin content and create drift — their removal is the core deliverable of this task.

**Command:**

```bash
ls .weave/prompts/
```

**Result summary:** Only `shuttle.md` and `weft.md` remain.

```
shuttle.md
weft.md
```

## Artifact: Full test suite

**What it proves:** No regressions introduced by the cleanup.

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

## Reviewer Conclusion

The `.weave/` project config is now delta-only. Six mirror prompt files were deleted. The two intentional overrides (shuttle, weft) were rewritten as self-contained Weave-repo-specific deltas. `.weave/config.weave` retains only the `prompt_file` overrides for shuttle and weft plus project-specific settings. All docs remain accurate. 714 tests pass.
