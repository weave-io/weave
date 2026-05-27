# 21-spec-cli-legacy-config-migration.md

## Introduction/Overview

This feature adds a legacy-config migration path to the Weave CLI so users can move from legacy OpenCode JSONC config into the current `.weave` DSL without manual rewriting. The primary goal is to let `weave init` discover or directly run a safe, scope-aware migration from legacy `weave-opencode.jsonc` files into canonical `config.weave` files while preserving current CLI safety and repository conventions.

## Goals

- Add a clear CLI migration flow for legacy OpenCode Weave config in both global and local scopes.
- Convert the supported subset of legacy JSONC into valid current `.weave` DSL before any file is written.
- Preserve user safety through overwrite backups, preflight summaries, warning reporting, and no destructive source-file cleanup.
- Keep migration aligned with current Weave config semantics instead of recreating legacy-only behavior that no longer exists.
- Leave the feature documented and testable through CLI output, generated files, and warning scenarios.

## User Stories

- **As a legacy Weave user**, I want the CLI to migrate my old OpenCode config into current `.weave` config so that I can adopt the new project without hand-translating JSONC.
- **As a user running `weave init`**, I want migration to be discoverable from the normal init flow so that I notice upgrade help when legacy config already exists.
- **As a user who already knows what I need**, I want an explicit `weave init migrate` path so that I can run migration directly in interactive or scripted flows.
- **As a cautious maintainer**, I want the CLI to back up overwritten config, validate generated DSL first, and list skipped fields so that migration does not silently corrupt my setup.

## Demoable Units of Work

### Unit 1: CLI entry paths for legacy migration

**Purpose:** Expose migration through the current init command in a way that is discoverable for interactive users and explicit for direct invocation.

**Functional Requirements:**
- The system shall support an explicit migration entry path through `weave init migrate`.
- The system shall allow ordinary `weave init` to offer migration when the matching legacy source file for the chosen scope exists.
- The system shall keep migration scope-aware, with global migration reading `~/.config/opencode/weave-opencode.jsonc` and local migration reading `.opencode/weave-opencode.jsonc`.
- The system shall write migrated config to the canonical current scope targets `~/.weave/config.weave` and `./.weave/config.weave`.
- The system shall continue into the normal harness selection and configuration flow after a successful migration write.

**Proof Artifacts:**
- CLI: interactive `weave init` output demonstrates migration is offered when legacy config is present.
- CLI: `weave init migrate --help` or equivalent command-path output demonstrates direct migrate mode exists.
- Test: argument-parsing and init-flow tests demonstrate scope-aware migration entry behavior for both ordinary init and explicit migrate mode.

### Unit 2: Safe migration planning and file write behavior

**Purpose:** Ensure migration is understandable before write time and safe when replacing existing Weave config.

**Functional Requirements:**
- The system shall show an interactive preflight summary before writing that includes source path, destination path, whether the destination exists, whether a backup will be created, and the count of skipped-field warnings.
- The system shall validate the generated `.weave` DSL through the normal parse and validation pipeline before mutating any files.
- The system shall overwrite an existing destination by first writing a single `.bak` backup at `<target>.bak`.
- The system shall keep the legacy JSONC source file in place after successful migration.
- The system shall prepend a short provenance comment to generated `config.weave` indicating that the file was migrated from the legacy OpenCode JSONC source.
- The system shall ignore arbitrary source-file comments from legacy JSONC rather than attempting to preserve them in the generated DSL.
- The system shall allow non-interactive migrate mode to proceed when the caller explicitly chooses migrate and supplies `--yes`, including overwrite-with-backup behavior when the destination already exists.

**Proof Artifacts:**
- CLI: preflight terminal capture demonstrates the summary shown before an interactive migration write.
- File artifact: generated `config.weave` demonstrates provenance header and valid DSL output.
- File artifact: `config.weave.bak` demonstrates overwrite backup behavior.
- Test: migration validation test demonstrates invalid generated DSL aborts before any target or backup file mutation.

### Unit 3: Best-effort config conversion with explicit warnings

**Purpose:** Convert the supported legacy config surface into current Weave semantics while making every loss of fidelity visible.

**Functional Requirements:**
- The system shall migrate supported legacy config into current `.weave` DSL using best-effort partial conversion rather than full-or-fail migration.
- The system shall write the destination file when supported content converts successfully even if some legacy fields are skipped.
- The system shall print a strong warning summary enumerating each skipped or unmappable field and the reason it was skipped.
- The system shall exit with code `0` when migration writes the destination successfully but emits warnings.
- The system shall map legacy `disabled_agents`, `disabled_hooks`, and `disabled_skills` into current `disable agents`, `disable hooks`, and `disable skills` declarations.
- The system shall map legacy `log_level` into current `settings { log_level ... }`.
- The system shall warn and skip legacy `workflows`, `continuation`, `analytics`, and `background` sections in migration v1.

**Proof Artifacts:**
- CLI: warning summary output demonstrates skipped legacy sections are reported explicitly.
- Test: migration fixture with unsupported sections demonstrates the file is still written and warning output lists the skipped fields.
- Test: migration fixture with only supported sections demonstrates warning-free successful conversion.

### Unit 4: Semantic mapping for agents, categories, models, and prompt references

**Purpose:** Preserve the supported legacy intent while converting into current Weave-native structures and naming rules.

**Functional Requirements:**
- The system shall treat legacy `agents` entries as overrides of existing builtin agent names in the current unified agent namespace.
- The system shall convert legacy `custom_agents` entries into new `agent <name>` blocks.
- The system shall warn when a legacy `custom_agents` name collides with a builtin agent name instead of silently overriding that builtin.
- The system shall convert legacy `model` plus optional `fallback_models` into a current ordered `models [...]` list with the primary model first.
- The system shall convert legacy `categories` into current `category <name>` blocks and rely on current generated `shuttle-<category>` semantics as the canonical result.
- The system shall map only clearly known legacy tool names into current abstract `tool_policy` capability buckets and shall warn and skip ambiguous tool names.
- The system shall preserve `prompt_file` only when the path can be carried into the current `.weave/prompts/` convention safely for the chosen scope.
- The system shall warn and skip prompt-file references that cannot be translated safely into the current scope-specific prompt path convention.

**Proof Artifacts:**
- Test: agent-namespace migration fixture demonstrates builtin override handling, custom-agent creation, and collision warnings.
- Test: category migration fixture demonstrates generated DSL contains `category` blocks rather than flattened agents.
- Test: model and tool-policy fixture demonstrates ordered `models [...]` output and warning behavior for ambiguous legacy tool names.
- Test: prompt-file fixture demonstrates safe preservation when path translation is valid and warning behavior when it is not.

## Non-Goals (Out of Scope)

1. **Full legacy behavior recreation**: This feature does not recreate legacy-only semantics for `workflows`, `continuation`, `analytics`, or `background`.
2. **Silent merge with existing config**: This feature does not auto-merge legacy JSONC into an existing `config.weave`; replacement happens through overwrite-with-backup semantics.
3. **Legacy source cleanup**: This feature does not rename or delete the original legacy JSONC file after migration.
4. **Comment preservation**: This feature does not preserve arbitrary user comments from legacy JSONC in generated `.weave` output.
5. **Speculative path rewriting**: This feature does not guess unclear `prompt_file` layouts or invent DSL representations for unmappable legacy fields.

## Design Considerations

No specific visual design requirements identified. User-facing CLI copy should emphasize safety and clarity: migration prompts, summaries, and warnings should use plain language, clearly distinguish source versus destination, and make skipped-field behavior obvious before and after write time.

## Repository Standards

- Follow the existing CLI command model in `packages/cli/src/args.ts`, `packages/cli/src/cli.ts`, and `packages/cli/src/commands/init.ts`.
- Preserve the current canonical config filenames and scope paths documented in `docs/cli.md` and `docs/config-loading.md`.
- Use Bun-only runtime behavior and avoid Node runtime APIs outside Bun-supported compatibility modules such as `node:path`.
- Return fallible internal logic through `neverthrow` `Result` or `ResultAsync` types wherever repository rules allow.
- Reuse current CLI safety conventions, including `.bak` overwrite behavior, clean exit codes, and non-TTY-safe flows.
- Keep tests isolated with fixtures and mocks rather than relying on real user home directories or live harness processes.
- Update documentation in the same change set as behavior changes, including CLI docs and any migration guidance needed in architecture or migration docs.
- Follow the repository requirement that non-trivial changes also update relevant docs under `docs/`.

## Technical Considerations

- No latest-standards research was needed for this spec because the feature is primarily a repository-specific migration and CLI UX change rather than an area where external platform standards materially change the design.
- Current CLI parsing only recognizes a single top-level command and stores extra positionals in `rest`; migration work will need to extend init-mode parsing without breaking existing `init`, `validate`, `run`, and `runtime` behavior.
- Current `runInit()` flow builds a plan, scaffolds `config.weave`, and then installs harnesses. Migration should fit into that structure instead of creating a parallel command architecture.
- Current config discovery and validation treat `~/.weave/config.weave` and `<projectRoot>/.weave/config.weave` as canonical targets; the migration spec intentionally aligns to those paths instead of introducing new destination filenames.
- Generated DSL should be validated through the same parse/validate pipeline used by the existing config loader so migration success means “would load successfully” rather than merely “string was produced.”
- Best-effort conversion should target current Weave semantics, not legacy structural fidelity. This especially matters for categories, unified agent naming, abstract `tool_policy`, and ordered `models` arrays.
- Unsupported legacy sections should remain warning-only skips in v1 so the feature ships as a practical migrator without inventing new DSL surface area.
- Prompt-file translation must respect current scope-specific `prompts/` resolution rules and avoid guessing path rewrites that could create broken references.

## Security Considerations

- Migration output, tests, and proof artifacts shall avoid committing real home-directory paths, tokens, secrets, private prompts, or private harness config content.
- Warning and summary output shall avoid dumping full secret-bearing file contents from either the source JSONC or generated DSL.
- Source and backup file handling shall avoid destructive cleanup so users retain a manual rollback path.
- Proof artifacts shall use fixture paths or redacted paths instead of real user-specific filesystem locations where possible.
- If harness configuration continues after migration, the feature shall preserve the existing explicit-install behavior and shall not broaden writes into third-party config without the current confirmation model.

## Success Metrics

1. **Migration completeness for supported fields**: representative global and local legacy fixtures convert into valid `config.weave` files that pass the normal validation pipeline.
2. **Safety behavior coverage**: overwrite-with-backup, validation-before-write, source preservation, and skipped-field warnings are all covered by automated tests and observable CLI output.
3. **Usable upgrade path**: users can reach migration through both ordinary `weave init` discovery and explicit `weave init migrate`, with clear proof artifacts for interactive and non-interactive flows.

## Open Questions

1. How should `packages/cli/src/args.ts` represent init submodes internally so `weave init migrate` remains easy to test without complicating other commands?
2. In ordinary `weave init`, at what exact point in the existing prompt order should the migration offer appear so scope selection, install directory prompts, and harness selection remain coherent?
