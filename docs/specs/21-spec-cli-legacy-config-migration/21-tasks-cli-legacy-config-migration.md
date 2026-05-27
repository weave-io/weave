## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `docs/specs/21-spec-cli-legacy-config-migration/21-spec-cli-legacy-config-migration.md` | Source spec for the migration feature; every parent task and proof artifact traces back here. |
| `packages/cli/src/args.ts` | Current CLI argument parser; needs init-submode support for `weave init migrate` without breaking existing commands. |
| `packages/cli/src/cli.ts` | Top-level CLI routing and command dispatch surface that must recognize explicit migrate mode. |
| `packages/cli/src/commands/init.ts` | Existing `runInit()` flow where migration discovery, preflight, write behavior, and post-migration harness continuation must fit. |
| `packages/cli/src/commands/__tests__/init.test.ts` | Existing init-flow coverage location for migration offer timing, scope behavior, and post-migration continuation tests. |
| `packages/cli/src/commands/__tests__/migrate.test.ts` | New targeted CLI migration tests for preflight, backup behavior, validation-before-write, and `--yes` flows. |
| `packages/cli/src/commands/__tests__/migrate-conversion.test.ts` | New conversion-focused tests for supported field mapping, warnings, and best-effort write behavior. |
| `packages/config/src/loader.ts` | Canonical parse/load entry point whose validation pipeline migration output must reuse before any file write occurs. |
| `packages/config/src/discovery.ts` | Canonical global/project target paths and scope semantics used by config loading and referenced by the spec. |
| `docs/cli.md` | Existing CLI contract that must document migrate mode, safety behavior, scope-aware sources, canonical destinations, and `--yes` scripting behavior. |
| `docs/config-loading.md` | Canonical config destination and prompt-path guidance that migration docs must stay aligned with, especially around `.weave/config.weave` and `.weave/prompts/`. |

### Notes

- Use Bun-only commands and test runners in all planned proof artifacts.
- Keep fallible internal migration planning and conversion logic on `neverthrow` result types wherever repository rules allow.
- Keep CLI migration tests under `packages/cli/src/**/__tests__` with fixture paths and mocked filesystem/home-directory behavior rather than real user paths.
- Preserve current canonical config destinations from `docs/config-loading.md`; migration must not drift into ad hoc targets even though ordinary `weave init` already supports `--install-dir` for starter scaffolding.
- Update docs in the same change set as the implementation because this is a non-trivial CLI feature with user-facing behavior changes.

## Tasks

### [x] 1.0 Add migration-aware `weave init` command entry paths

#### 1.0 Proof Artifact(s)

- CLI: sanitized interactive capture using fixture paths (`HOME=/tmp/weave-fixture-home`, project `/tmp/weave-fixture-project`) shows ordinary `weave init --scope local` offers migration when `/tmp/weave-fixture-project/.opencode/weave-opencode.jsonc` exists.
- CLI: `bun packages/cli/src/main.ts init migrate --help` output shows a direct migrate mode with explicit scope behavior and canonical destination wording.
- Test: `bun test packages/cli/src/commands/__tests__/init.test.ts` passes coverage for explicit `weave init migrate`, legacy-source discovery in local/global scope, canonical destination selection, and continuation into the normal harness flow after a successful migration write.

#### 1.0 Tasks

- [x] 1.1 Extend `packages/cli/src/args.ts` so `weave init migrate` is represented as an init submode that remains easy to route and test without changing unrelated top-level commands.
- [x] 1.2 Update `packages/cli/src/cli.ts` and init routing so explicit `weave init migrate` reaches the existing init command surface instead of creating a parallel command architecture.
- [x] 1.3 Add scope-aware legacy-source detection for `~/.config/opencode/weave-opencode.jsonc` and `./.opencode/weave-opencode.jsonc` based on the chosen init scope.
- [x] 1.4 Insert the ordinary-init migration offer after scope resolution but before harness selection/configuration so the prompt order stays coherent with the current flow.
- [x] 1.5 Enforce canonical migration destinations of `~/.weave/config.weave` and `./.weave/config.weave`, and explicitly plan how migrate mode handles any `--install-dir` input so the CLI contract cannot drift from canonical config-loading paths.
- [x] 1.6 Continue into the normal harness selection and configuration flow after a successful migration write instead of treating migration as a terminal command.
- [x] 1.7 Add init-flow tests covering explicit migrate mode, ordinary-init migration discovery, both scopes, canonical destination selection, and post-migration continuation behavior.

### [x] 2.0 Implement safe migration planning, preflight, and write behavior

#### 2.0 Proof Artifact(s)

- CLI: sanitized preflight capture shows source path, destination path, destination-exists status, backup intent, and skipped-field warning count before an interactive write.
- File artifact: generated `/tmp/weave-fixture-project/.weave/config.weave` contains a provenance comment naming the legacy OpenCode JSONC source and passes the normal Weave parse/validation pipeline.
- File artifact: overwrite fixture leaves `/tmp/weave-fixture-project/.weave/config.weave.bak` with the previous config and leaves `/tmp/weave-fixture-project/.opencode/weave-opencode.jsonc` in place after success.
- Test: `bun test packages/cli/src/commands/__tests__/migrate.test.ts` passes validation-before-write abort coverage with zero destination/backup mutation and explicit `weave init migrate --scope local --yes` overwrite-with-backup coverage.

#### 2.0 Tasks

- [x] 2.1 Add a migration-plan stage that computes source path, destination path, destination-exists status, backup intent, and skipped-warning count before any write prompt or file mutation.
- [x] 2.2 Render an interactive preflight summary that clearly distinguishes source versus destination and shows whether an overwrite backup will be created.
- [x] 2.3 Validate generated `.weave` output through the normal parse/validation pipeline before writing either the destination file or any `.bak` file.
- [x] 2.4 When the destination already exists, write exactly one backup file at `<target>.bak` before overwriting the destination.
- [x] 2.5 Preserve the legacy JSONC source file after successful migration and avoid any rename/delete cleanup step.
- [x] 2.6 Prepend a short provenance comment to generated `config.weave` and intentionally ignore arbitrary legacy JSONC comments rather than attempting comment preservation.
- [x] 2.7 Allow explicit non-interactive migrate mode to proceed with `--yes`, including overwrite-with-backup behavior when the destination already exists.
- [x] 2.8 Add write-path tests covering interactive preflight behavior, validation-before-write aborts, overwrite backup creation, provenance comments, source preservation, and non-interactive `--yes` success paths.

### [x] 3.0 Convert top-level legacy settings with warning-visible best effort

#### 3.0 Proof Artifact(s)

- File artifact: a sanitized supported-fields fixture generates DSL containing `disable agents`, `disable hooks`, `disable skills`, and `settings { log_level ... }` declarations at the canonical scope destination.
- CLI: warning summary capture enumerates skipped `workflows`, `continuation`, `analytics`, and `background` sections with reasons while the successful migration exits with code `0`.
- Test: `bun test packages/cli/src/commands/__tests__/migrate-conversion.test.ts` passes warning-free conversion coverage for supported top-level fields and best-effort write coverage with explicit warnings for unsupported sections.

#### 3.0 Tasks

- [x] 3.1 Model migration conversion as best-effort partial success so supported content can be written even when warnings are emitted for skipped legacy fields.
- [x] 3.2 Map legacy `disabled_agents`, `disabled_hooks`, and `disabled_skills` into current `disable agents`, `disable hooks`, and `disable skills` declarations.
- [x] 3.3 Map legacy `log_level` into `settings { log_level ... }` using current DSL semantics.
- [x] 3.4 Warn and skip legacy `workflows`, `continuation`, `analytics`, and `background` sections in migration v1 with explicit per-field reasons.
- [x] 3.5 Ensure warning-bearing successful migrations still exit with code `0` after the destination file is written.
- [x] 3.6 Add conversion tests for supported top-level fields, unsupported-section warnings, and warning-free successful conversion fixtures.

### [ ] 4.0 Convert legacy agent, category, model, tool, and prompt intent

#### 4.0 Proof Artifact(s)

- File artifact: sanitized agent/category fixture generates current DSL with builtin agent overrides, new `agent <name>` blocks for non-colliding custom agents, `category <name>` blocks, and ordered `models [...]` arrays with the primary model first.
- CLI: warning capture shows a builtin-name collision from `custom_agents`, an ambiguous legacy tool name, and an unsafe `prompt_file` reference are each skipped with explicit reasons and no source-content dump.
- Test: `bun test packages/cli/src/commands/__tests__/migrate-conversion.test.ts` passes coverage for builtin override handling, custom-agent collision warnings, category conversion without flattened shuttle agents, ordered model fallback conversion, known tool-policy mapping, and safe/unsafe prompt-file translation.

#### 4.0 Tasks

- [ ] 4.1 Treat legacy `agents` entries as overrides of existing builtin agent names in the current unified agent namespace.
- [ ] 4.2 Convert legacy `custom_agents` entries into new `agent <name>` blocks when the name does not collide with a builtin.
- [ ] 4.3 Warn and skip a legacy `custom_agents` entry when its name collides with a builtin agent rather than silently overriding the builtin.
- [ ] 4.4 Convert legacy `model` plus optional `fallback_models` into ordered `models [...]` arrays with the primary model first.
- [ ] 4.5 Convert legacy `categories` into current `category <name>` blocks and rely on current generated `shuttle-<category>` semantics instead of flattening category behavior into standalone agents.
- [ ] 4.6 Map only clearly known legacy tool names into current abstract `tool_policy` capability buckets and warn on ambiguous or unmappable tool names.
- [ ] 4.7 Preserve `prompt_file` only when the path can be translated safely into the current scope-specific `.weave/prompts/` convention.
- [ ] 4.8 Warn and skip any prompt-file reference that cannot be translated safely into the current prompt-path convention instead of guessing a rewrite.
- [ ] 4.9 Add conversion tests for builtin overrides, custom-agent creation, builtin collision warnings, category blocks, ordered model conversion, tool-policy warnings, and safe/unsafe prompt-file handling.

### [ ] 5.0 Document migration usage and prove end-to-end acceptance

#### 5.0 Proof Artifact(s)

- Documentation: `docs/cli.md` documents `weave init migrate`, scope-aware legacy source paths, canonical migration destinations, preflight/backup/source-preservation behavior, `--yes` scripting behavior, warning semantics, and any `--install-dir` migrate-mode restriction or ignore behavior.
- Documentation: `docs/config-loading.md` documents that migration writes only to canonical `~/.weave/config.weave` and `<projectRoot>/.weave/config.weave` targets, and explains prompt-file translation expectations relative to `.weave/prompts/`.
- Quality gate: `bun run lint && bun run typecheck && bun test packages/cli/src/commands/__tests__/init.test.ts packages/cli/src/commands/__tests__/migrate.test.ts packages/cli/src/commands/__tests__/migrate-conversion.test.ts && bun run build` passes.
- CLI: sanitized end-to-end smoke notes include reproducible local and global migration commands using fixture `HOME`/`XDG_CONFIG_HOME` values and no real user paths, tokens, private prompts, or private harness config content.

#### 5.0 Tasks

- [ ] 5.1 Update `docs/cli.md` with migrate-mode entry paths, safety behavior, warning semantics, and canonical scope-aware source/destination paths.
- [ ] 5.2 Update `docs/config-loading.md` so canonical config destinations and `.weave/prompts/` path semantics are cross-linked from the migration documentation.
- [ ] 5.3 Document the migration-specific `--install-dir` tension and the chosen CLI behavior so starter-config scaffolding rules do not leak into canonical migration destinations.
- [ ] 5.4 Add or update fixture-driven smoke notes that demonstrate local and global migration with sanitized paths and no secret-bearing content.
- [ ] 5.5 Run the targeted Bun tests plus `bun run lint`, `bun run typecheck`, and `bun run build`, and record the exact commands as planned proof artifacts for end-to-end acceptance.
