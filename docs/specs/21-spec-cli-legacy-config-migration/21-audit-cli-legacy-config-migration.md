# Phase 3 Planning Audit — CLI Legacy Config Migration

## Scope

- Spec: `docs/specs/21-spec-cli-legacy-config-migration/21-spec-cli-legacy-config-migration.md`
- Task plan: `docs/specs/21-spec-cli-legacy-config-migration/21-tasks-cli-legacy-config-migration.md`
- Audit mode: Phase 3 planning-only, exception-focused.

## Gate Overview

| Gate | Type | Result | Evidence |
| --- | --- | --- | --- |
| Requirement-to-test traceability | REQUIRED | PASS | Coverage table maps every functional requirement to at least one subtask and one proof artifact. |
| Proof artifact verifiability | REQUIRED | PASS | All parent tasks include observable CLI, file, doc, or Bun-test artifacts with sanitized fixture paths. |
| Repository standards consistency | REQUIRED | PASS | Plan reflects Bun-only commands, `neverthrow`, no console logging, CLI test location, and docs updates. |
| Open question resolution | REQUIRED | PASS | Both spec open questions are resolved as explicit planning decisions in tasks 1.1, 1.4, 1.5, and 5.3. |
| Regression-risk blind spots | FLAG | PASS WITH NOTE | `--install-dir` tension is explicitly called out and traced so migration cannot silently drift from canonical destinations. |
| Non-goal leakage | FLAG | PASS | Tasks preserve v1 warning-only skips for unsupported legacy sections and avoid source cleanup, comment preservation, silent merges, or speculative path rewriting. |

## Standards Evidence

| Source path | Read status | Extracted standards | Tension |
| --- | --- | --- | --- |
| `AGENTS.md` | yes | Bun-only runtime; `neverthrow` for fallible logic; docs and tests must ship with non-trivial changes. | none |
| `docs/cli.md` | yes | Existing CLI contract includes `weave init`, `--yes`, `--force`, non-TTY behavior, and `--install-dir` starter-config scaffolding. | `--install-dir` exists for ordinary init, but migration spec requires canonical `config.weave` destinations only. |
| `docs/config-loading.md` | yes | Canonical config paths are `~/.weave/config.weave` and `<projectRoot>/.weave/config.weave`; prompt files resolve under `.weave/prompts/`. | migration docs must stay aligned with these canonical targets. |
| Spec 21 | yes | Scope-aware migration sources, validation-before-write, backup safety, best-effort warnings, prompt-path safety, and docs/tests are all required. | none |

## Functional Requirement Coverage

| Spec requirement | Planned subtask(s) | Planned proof artifact(s) |
| --- | --- | --- |
| Explicit migration path through `weave init migrate`. | 1.1, 1.2, 1.7 | 1.0 CLI help artifact; 1.0 init test artifact. |
| Ordinary `weave init` offers migration when matching legacy file exists. | 1.3, 1.4, 1.7 | 1.0 interactive CLI capture; 1.0 init test artifact. |
| Scope-aware legacy source paths for global and local migration. | 1.3, 1.7 | 1.0 interactive CLI capture; 1.0 init test artifact. |
| Migration writes to canonical `~/.weave/config.weave` and `./.weave/config.weave`. | 1.5, 5.1, 5.2, 5.3 | 1.0 init test artifact; 5.0 docs artifacts. |
| Successful migration continues into normal harness flow. | 1.6, 1.7 | 1.0 init test artifact. |
| Interactive preflight summary includes source, destination, destination-exists, backup intent, skipped-warning count. | 2.1, 2.2, 2.8 | 2.0 preflight CLI artifact; 2.0 migrate test artifact. |
| Generated DSL is validated before any file mutation. | 2.3, 2.8 | 2.0 migrate test artifact; 2.0 generated-file artifact. |
| Existing destination is overwritten only after writing `<target>.bak`. | 2.4, 2.7, 2.8 | 2.0 backup file artifact; 2.0 migrate test artifact. |
| Legacy JSONC source remains in place after success. | 2.5, 2.8 | 2.0 backup/source file artifact; 2.0 migrate test artifact. |
| Generated `config.weave` includes provenance comment. | 2.6, 2.8 | 2.0 generated-file artifact; 2.0 migrate test artifact. |
| Arbitrary legacy comments are ignored, not preserved. | 2.6, 2.8 | 2.0 generated-file artifact; 2.0 migrate test artifact. |
| Explicit non-interactive migrate mode works with `--yes`, including overwrite-with-backup. | 2.7, 2.8 | 2.0 migrate test artifact. |
| Conversion is best-effort partial success, not full-or-fail. | 3.1, 3.6 | 3.0 warning-summary CLI artifact; 3.0 conversion test artifact. |
| Destination still writes when supported content converts and some fields are skipped. | 3.1, 3.4, 3.6 | 3.0 warning-summary CLI artifact; 3.0 conversion test artifact. |
| Warning summary enumerates each skipped/unmappable field and reason. | 3.4, 3.6, 4.3, 4.6, 4.8, 4.9 | 3.0 warning-summary CLI artifact; 4.0 warning CLI artifact; conversion tests. |
| Successful migration with warnings exits code `0`. | 3.5, 3.6 | 3.0 warning-summary CLI artifact; 3.0 conversion test artifact. |
| `disabled_agents`, `disabled_hooks`, `disabled_skills` map to `disable ...` declarations. | 3.2, 3.6 | 3.0 supported-fields file artifact; 3.0 conversion test artifact. |
| `log_level` maps to `settings { log_level ... }`. | 3.3, 3.6 | 3.0 supported-fields file artifact; 3.0 conversion test artifact. |
| `workflows`, `continuation`, `analytics`, `background` are warned-and-skipped in v1. | 3.4, 3.6, 5.1 | 3.0 warning-summary CLI artifact; 3.0 conversion test artifact; 5.0 docs artifact. |
| Legacy `agents` entries override builtin agent names. | 4.1, 4.9 | 4.0 file artifact; 4.0 conversion test artifact. |
| Legacy `custom_agents` become new `agent <name>` blocks. | 4.2, 4.9 | 4.0 file artifact; 4.0 conversion test artifact. |
| Builtin-name collision in `custom_agents` warns instead of silently overriding. | 4.3, 4.9 | 4.0 warning CLI artifact; 4.0 conversion test artifact. |
| `model` plus `fallback_models` becomes ordered `models [...]`. | 4.4, 4.9 | 4.0 file artifact; 4.0 conversion test artifact. |
| `categories` become `category <name>` blocks using canonical shuttle semantics. | 4.5, 4.9 | 4.0 file artifact; 4.0 conversion test artifact. |
| Only clearly known legacy tool names map into `tool_policy`; ambiguous names warn-and-skip. | 4.6, 4.9 | 4.0 warning CLI artifact; 4.0 conversion test artifact. |
| `prompt_file` is preserved only when safe for current `.weave/prompts/` convention. | 4.7, 4.9, 5.2 | 4.0 file artifact; 4.0 conversion test artifact; 5.0 config-loading doc artifact. |
| Unsafe prompt-file references warn-and-skip. | 4.8, 4.9 | 4.0 warning CLI artifact; 4.0 conversion test artifact. |

## Open Question Resolution

| Open question | Planning resolution | Blocking? |
| --- | --- | --- |
| How should `packages/cli/src/args.ts` represent init submodes internally? | Represent `migrate` as an init submode handled inside the existing init command path so parsing and tests stay localized to `args.ts`, `cli.ts`, and `init.ts`. | no |
| Where should the ordinary-init migration offer appear in the prompt order? | Offer migration after scope resolution and before harness selection/configuration so source-path selection is known while downstream init prompts remain coherent. | no |
| How does `--install-dir` interact with canonical migration destinations? | Migration planning must document and test canonical destination precedence, with explicit CLI/docs behavior so migrate mode cannot redirect writes away from `~/.weave/config.weave` or `<projectRoot>/.weave/config.weave`. | no |

## Chain-of-Verification

- Read the approved spec and the existing parent task file before editing.
- Rebuilt the task file into the required Phase 3 structure: `## Relevant Files`, `### Notes`, `## Tasks`.
- Preserved the existing five parent tasks and replaced all `TBD` placeholders with concrete subtasks.
- Checked every functional requirement against at least one subtask and at least one proof artifact.
- Verified every parent task includes proof artifacts that are observable through Bun tests, CLI captures, file artifacts, or docs.
- Cross-checked repository standards against `docs/cli.md` and `docs/config-loading.md`, including the canonical-path tension with `--install-dir`.
- Kept the audit planning-only: no source-code or behavior changes were made in this phase.

## Required Failures

None.

## Flag Findings

- `--install-dir` is the only notable standards tension: ordinary `weave init` already documents custom scaffold directories, but the migration spec requires canonical config destinations. The plan now treats this as an explicit documentation and test point rather than an implicit implementation detail.
