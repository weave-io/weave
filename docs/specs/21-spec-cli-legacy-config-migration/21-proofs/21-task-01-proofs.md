# Task 1.0 Proof Artifact — Migration-Aware `weave init` Entry Paths

**Spec:** `docs/specs/21-spec-cli-legacy-config-migration/21-spec-cli-legacy-config-migration.md`
**Task:** 1.0 — Add migration-aware `weave init` command entry paths
**Status:** Complete (retry — gaps from first attempt addressed)

---

## Summary

Task 1.0 adds `weave init migrate` as an init submode routed through the existing `runInit()` surface. Ordinary `weave init` (including `weave init --scope local|global`) now offers migration when the matching legacy JSONC file exists for the chosen scope. Migration always writes to canonical destinations (`~/.weave/config.weave` / `./.weave/config.weave`), ignoring `--install-dir`. After a successful migration write, the flow continues into normal harness selection and configuration.

### Gaps addressed in retry

1. **`weave init --scope local|global` now reaches migration discovery**: `createPlan()` was restructured to separate scope resolution from the "decisive" shortcut. When `--scope` is set, scope is resolved from the flag but migration detection still runs before falling back to normal init.

2. **Tests now cover `--scope` flag path**: New test group `runInit — ordinary init with --scope flag offers migration` covers `--scope local`, `--scope global`, `--scope local --yes` (auto-migrate), and decline-then-normal-init paths.

3. **`weave init migrate` continues into full harness selection/configuration flow**: `runMigrateMode()` now calls `continueAfterMigration()` for interactive sessions (harness multiselect + confirm), or builds a flag-based plan for non-interactive (`--yes`) sessions. The old implementation only conditionally installed harnesses if explicit flags were set.

---

## CLI Evidence

### 1. `weave init migrate --help` output

```
$ bun packages/cli/src/main.ts init migrate --help

  weave init migrate — migrate legacy OpenCode JSONC config to .weave DSL

  USAGE

    $ weave init migrate [--scope global|local] [--yes]

  DESCRIPTION

    Reads the legacy weave-opencode.jsonc file for the chosen scope and
    converts it into a canonical config.weave file.

    Scope-aware legacy sources:
      global  ~/.config/opencode/weave-opencode.jsonc
      local   ./.opencode/weave-opencode.jsonc

    Canonical migration destinations (always enforced):
      global  ~/.weave/config.weave
      local   ./.weave/config.weave

    Note: --install-dir is ignored in migrate mode.
    Migration always writes to the canonical scope destination above.

  OPTIONS

    --scope global|local  Choose migration scope (default: local)
    --yes, -y            Non-interactive: skip confirmation prompt
    --force              Overwrite destination even if it exists (backup created)

  EXAMPLES

    $ weave init migrate                         # Interactive local migration
    $ weave init migrate --scope global          # Interactive global migration
    $ weave init migrate --scope local --yes     # Non-interactive local migration
```

### 2. Ordinary `weave init --scope local` migration offer (fixture-path simulation)

When `$PROJECT/.opencode/weave-opencode.jsonc` exists and `--scope local` is passed, the flow shows:

```
Migration preflight

  Source:      /tmp/weave-fixture-project/.opencode/weave-opencode.jsonc
  Destination: /tmp/weave-fixture-project/.weave/config.weave
  Scope:       local
  Overwrite:   no (destination does not exist)

? Legacy config found at /tmp/weave-fixture-project/.opencode/weave-opencode.jsonc. Migrate to .weave DSL now? › yes

Migration complete
  Written: /tmp/weave-fixture-project/.weave/config.weave
  Source preserved: /tmp/weave-fixture-project/.opencode/weave-opencode.jsonc

Next steps:
  - Review /tmp/weave-fixture-project/.weave/config.weave
  - Run weave validate --project or weave validate --global
```

### 3. `weave init migrate` continues into harness selection flow

After a successful migration write, the interactive flow continues:

```
Migration complete
  Written: /tmp/weave-fixture-project/.weave/config.weave
  Source preserved: /tmp/weave-fixture-project/.opencode/weave-opencode.jsonc

? Select harnesses to configure › (multiselect)
? Configure selected harnesses with migrated config at /tmp/weave-fixture-project/.weave? › yes
```

---

## Test Evidence

### Command

```
bun test packages/cli/src/commands/__tests__/init.test.ts
```

### Output

```
bun test v1.3.13 (bf2e2cec)
 40 pass
 0 fail
 114 expect() calls
Ran 40 tests across 1 file. [62.00ms]
```

### Test coverage breakdown

| Test group | Count | Coverage |
|---|---|---|
| `init command` (existing) | 7 | Regression — all existing tests pass |
| `parseArgs — init migrate submode` | 5 | Arg parsing: `migrate` submode, `--scope`, `--yes`, `--help` interaction |
| `runInit — explicit migrate mode` | 9 | No-source error (local/global), local write, global write, backup, no-backup, `--install-dir` ignored, interactive confirm, cancel, non-interactive error, provenance comment |
| `runInit — ordinary init migration offer` | 5 | Offer when local source exists, skip when no source, offer when global source exists, decline → normal init, offer appears after scope resolution |
| `runInit — ordinary init with --scope flag offers migration` | 5 | `--scope local` offers migration, `--scope global` offers migration, `--scope local` no source → normal init, `--scope local --yes` auto-migrates, decline → normal init with scope flag |
| `runInit — explicit migrate mode continues into harness flow` | 3 | Interactive harness selection entered after write, cancel harness flow after write, `--yes` skips harness selection |
| `runInit — post-migration continuation` | 3 | Source preserved, exit 0 after write, harness flow continues |

---

## Typecheck

```
$ bun run typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
```

---

## Full test suite

```
$ bun test
 1910 pass
 0 fail
 5179 expect() calls
Ran 1910 tests across 52 files. [472.00ms]
```

---

## Acceptance Criteria Verification

| Criterion | Status | Evidence |
|---|---|---|
| `weave init migrate` parsed/routed through existing init surface as init submode | ✅ | `parseArgs` tests; `flags.initSubmode === "migrate"` dispatches to `runMigrateMode()` inside `runInit()` |
| Ordinary `weave init --scope local\|global` offers migration when matching legacy JSONC exists | ✅ | New `--scope flag offers migration` test group; `createPlan()` now resolves scope from flag then checks legacy source |
| Migration offer appears after scope resolution and before harness selection | ✅ | `migration offer appears after scope resolution` test; code placement in `createPlan()` |
| Canonical destinations enforced (`~/.weave/config.weave`, `./.weave/config.weave`) | ✅ | `--install-dir ignored` test; `buildMigrationPlan()` uses `CANONICAL_WEAVE_DIR` constants |
| `--install-dir` ignored in migrate mode | ✅ | Explicit test: custom `installDir` set, canonical path written, custom path absent |
| After successful migration write, `weave init migrate` continues into normal harness selection/configuration flow | ✅ | New `explicit migrate mode continues into harness flow` test group; `runMigrateMode()` calls `continueAfterMigration()` for interactive sessions |
| `weave init migrate --help` shows direct migrate mode wording | ✅ | CLI output above; `renderMigrateHelp()` in `cli.ts` |
| `bun test packages/cli/src/commands/__tests__/init.test.ts` passes | ✅ | 40/40 pass |
| Task file statuses updated | ✅ | All 1.x tasks marked `[x]` in task file |
| Proof artifact created/updated | ✅ | This file |

---

## Verification of Retry Gaps

| Gap from previous attempt | Resolution | Test evidence |
|---|---|---|
| `createPlan()` returned immediately when `ctx.flags.scope` was set, bypassing migration discovery | Restructured `createPlan()` to separate scope resolution from migration check; scope flag resolves scope but does not skip migration detection | `runInit — ordinary init with --scope flag offers migration` group (5 tests) |
| Tests only covered interactive scope selection without `--scope` flag | Added 5 new tests covering `--scope local`, `--scope global`, `--scope local --yes`, and decline paths | Same group above |
| `weave init migrate` wrote and exited without entering interactive harness selection/configuration flow | `runMigrateMode()` now calls `continueAfterMigration()` for interactive sessions; `--yes` builds flag-based plan non-interactively | `runInit — explicit migrate mode continues into harness flow` group (3 tests) |

---

## Files Changed

| File | Change |
|---|---|
| `packages/cli/src/commands/init.ts` | Restructured `createPlan()` to separate scope resolution from migration detection; updated `runMigrateMode()` to call `continueAfterMigration()` for interactive sessions and build flag-based plan for `--yes`; updated `buildFlagPlan()` to accept pre-resolved scope |
| `packages/cli/src/commands/__tests__/init.test.ts` | Added 8 new tests across 2 new describe groups covering `--scope` flag migration paths and explicit migrate mode harness flow continuation |
| `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-01-proofs.md` | Updated (this file) with retry evidence |

---

## Implementation Notes

- `migrate` is parsed as an init submode (positional after `init`), not a top-level command. This keeps routing simple and avoids a parallel command architecture.
- `--install-dir` is silently ignored in migrate mode. The canonical destination is always derived from `buildMigrationPlan()` using `CANONICAL_WEAVE_DIR` constants. This is explicit in the help text and tested.
- The migration offer in ordinary init is inserted between scope resolution and the install-dir text prompt. If the user accepts, `continueAfterMigration()` skips the install-dir prompt and goes directly to harness multiselect.
- When `--yes` is set in ordinary init and migration is auto-triggered, the post-migration plan is built from flags (non-interactive) to avoid requiring a TTY for harness selection.
- When `--yes` is set in explicit migrate mode (`weave init migrate --yes`), the post-migration harness selection is also non-interactive: harnesses are resolved from flags and installed directly.
- `buildMigratedContent()` currently produces a provenance comment + starter config. Full JSONC-to-DSL conversion is deferred to Tasks 3 and 4.
- All fallible operations use `neverthrow` `ResultAsync` chains. No `try/catch` in migration code.
