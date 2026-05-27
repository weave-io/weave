# Task 1.0 Proof Artifact — Migration-Aware `weave init` Entry Paths

**Spec:** `docs/specs/21-spec-cli-legacy-config-migration/21-spec-cli-legacy-config-migration.md`
**Task:** 1.0 — Add migration-aware `weave init` command entry paths
**Status:** Complete

---

## Summary

Task 1.0 adds `weave init migrate` as an init submode routed through the existing `runInit()` surface. Ordinary `weave init` now offers migration when the matching legacy JSONC file exists for the chosen scope. Migration always writes to canonical destinations (`~/.weave/config.weave` / `./.weave/config.weave`), ignoring `--install-dir`. After a successful migration write, the flow continues into normal harness selection and configuration.

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

### 2. Ordinary `weave init` migration offer (fixture-path simulation)

When `$PROJECT/.opencode/weave-opencode.jsonc` exists and the user selects local scope, the flow shows:

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

---

## Test Evidence

### Command

```
bun test packages/cli/src/commands/__tests__/init.test.ts
```

### Output

```
bun test v1.3.13 (bf2e2cec)
 32 pass
 0 fail
 86 expect() calls
Ran 32 tests across 1 file. [153.00ms]
```

### Test coverage breakdown

| Test group | Count | Coverage |
|---|---|---|
| `init command` (existing) | 7 | Regression — all existing tests pass |
| `parseArgs — init migrate submode` | 5 | Arg parsing: `migrate` submode, `--scope`, `--yes`, `--help` interaction |
| `runInit — explicit migrate mode` | 9 | No-source error (local/global), local write, global write, backup, no-backup, `--install-dir` ignored, interactive confirm, cancel, non-interactive error, provenance comment |
| `runInit — ordinary init migration offer` | 5 | Offer when local source exists, skip when no source, offer when global source exists, decline → normal init, offer appears after scope resolution |
| `runInit — post-migration continuation` | 3 | Source preserved, exit 0 after write, harness flow continues |

---

## Typecheck

```
$ bun run typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Acceptance Criteria Verification

| Criterion | Status | Evidence |
|---|---|---|
| `weave init migrate` parsed/routed through existing init surface as init submode | ✅ | `parseArgs` tests; `flags.initSubmode === "migrate"` dispatches to `runMigrateMode()` inside `runInit()` |
| Ordinary `weave init --scope local\|global` offers migration when matching legacy JSONC exists | ✅ | `ordinary init migration offer` test group; `detectLegacySource()` called after scope resolution |
| Migration offer appears after scope resolution and before harness selection | ✅ | `migration offer appears after scope resolution` test; code placement in `createPlan()` |
| Canonical destinations enforced (`~/.weave/config.weave`, `./.weave/config.weave`) | ✅ | `--install-dir ignored` test; `buildMigrationPlan()` uses `CANONICAL_WEAVE_DIR` constants |
| `--install-dir` ignored in migrate mode | ✅ | Explicit test: custom `installDir` set, canonical path written, custom path absent |
| After successful migration write, init continues into normal harness flow | ✅ | `post-migration continuation` test group; `runMigrateMode()` calls `installHarnesses()` after write |
| `weave init migrate --help` shows direct migrate mode wording | ✅ | CLI output above; `renderMigrateHelp()` in `cli.ts` |
| `bun test packages/cli/src/commands/__tests__/init.test.ts` passes | ✅ | 32/32 pass |
| Task file statuses updated | ✅ | All 1.x tasks marked `[x]` in task file |
| Proof artifact created | ✅ | This file |

---

## Files Changed

| File | Change |
|---|---|
| `packages/cli/src/args.ts` | Added `initSubmode?: "migrate"` to `ParsedArgs["flags"]`; parse `migrate` as first positional after `init` command |
| `packages/cli/src/cli.ts` | Added `renderMigrateHelp()` function; route `--help` with `initSubmode === "migrate"` to migrate help text |
| `packages/cli/src/commands/init.ts` | Added `runMigrateMode()`, `buildMigrationPlan()`, `detectLegacySource()`, `performMigrationWrite()`, `buildMigratedContent()`, `continueAfterMigration()`, `renderMigratePreflight()`, `renderMigrateSuccess()`; inserted migration offer into `createPlan()` after scope resolution |
| `packages/cli/src/commands/__tests__/init.test.ts` | Added 25 new tests across 4 new describe groups; all 32 tests pass |
| `docs/specs/21-spec-cli-legacy-config-migration/21-tasks-cli-legacy-config-migration.md` | Marked 1.0 and 1.1–1.7 as `[x]` |
| `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-01-proofs.md` | Created (this file) |

---

## Implementation Notes

- `migrate` is parsed as an init submode (positional after `init`), not a top-level command. This keeps routing simple and avoids a parallel command architecture.
- `--install-dir` is silently ignored in migrate mode. The canonical destination is always derived from `buildMigrationPlan()` using `CANONICAL_WEAVE_DIR` constants. This is explicit in the help text and tested.
- The migration offer in ordinary init is inserted between scope selection and the install-dir text prompt. If the user accepts, `continueAfterMigration()` skips the install-dir prompt and goes directly to harness multiselect.
- `buildMigratedContent()` currently produces a provenance comment + starter config. Full JSONC-to-DSL conversion is deferred to Tasks 3 and 4.
- All fallible operations use `neverthrow` `ResultAsync` chains. No `try/catch` in migration code.
