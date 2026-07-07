# 10-audit-builtin-prompt-defaults.md

## Executive Summary

- Overall Status: PASS
- Required Gate Failures: 0
- Flagged Risks: 0

## Scope

- Audit target: `docs/specs/10-spec-builtin-prompt-defaults/10-tasks-builtin-prompt-defaults.md`
- Source spec: `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md`
- Audit focus: parent tasks, sub-tasks, proof artifacts, standards coverage, and handoff readiness for `/SDD-3-manage-tasks`

## Gateboard

| Gate | Status | Why it failed (<=10 words) | Exact fix target |
| --- | --- | --- | --- |
| Requirement-to-test traceability | PASS | none | none |
| Proof artifact verifiability | PASS | none | none |
| Repository standards consistency | PASS | none | none |
| Open question resolution | PASS | none | none |
| Regression-risk blind spots | PASS | none | none |
| Non-goal leakage | PASS | none | none |

## Requirement Traceability Snapshot

| Spec Unit / Requirement Theme | Task Coverage | Planned Proof Artifact |
| --- | --- | --- |
| Unit 1: replace placeholder builtin prompts with real Markdown defaults | `1.1`, `1.5` | Diff for `packages/config/prompts/*.md`; builtin prompt tests |
| Unit 1: keep shipped prompts product-level and skill-agnostic | `1.3`, `1.5` | leakage-guard tests against repo-only and harness-only tokens |
| Unit 1: restate abstract behavioral boundaries and Loom direct-small-work rule | `1.2`, `1.4` | prompt file review plus shipped prompt content tests |
| Unit 1: gate-style verdict wording for review/audit prompts | `1.1` | file review of `packages/config/prompts/weft.md` and `warp.md` |
| Unit 2: ship builtin `triggers` in canonical builtin config | `2.1`, `2.3` | builtins diff and builtin trigger tests |
| Unit 2: composer owns delegation inventory | `2.2`, `2.4`, `2.5` | compose smoke shows generated `## Delegation` from config |
| Unit 2: only delegating builtins emit delegation sections | `2.5` | negative compose smoke for `shuttle`, `pattern`, `thread`, `spindle`, `weft`, `warp` |
| Unit 3: prune mirrored local prompts, keep only Shuttle/Weft overrides | `3.1`, `3.2` | `.weave/prompts/` diff showing only `shuttle.md` and `weft.md` remain |
| Unit 3: keep Shuttle outcome-based and repo-discovered validation | `3.2`, `3.3` | local Shuttle prompt diff |
| Unit 3: shrink `.weave/config.weave` to delta-only while retaining intentional prompt-file overrides | `3.4` | `.weave/config.weave` diff plus `bun run validate-config` |
| Unit 3: keep docs and tests aligned with canonical/default contract | `3.5` | doc review and `load_config.test.ts` |

## Standards Evidence Table (Required)

| Source File | Read | Standards Extracted | Conflicts |
| --- | --- | --- | --- |
| `AGENTS.md` | yes | Bun-only runtime; `neverthrow` for fallible paths; docs are first-class deliverables | none |
| `README.md` | yes | `@weaveio/weave-config` owns builtins/discovery/merge/prompt resolution; `bun run validate-config`; workspace package boundaries | none |
| `CONTRIBUTING.md` | not found | none | none |
| `.github/pull_request_template.md` | not found | none | none |
| `package.json` | yes | `bun run test`, `bun run typecheck`, `bun run lint`, and `bun run build` are repo quality gates | none |
| `.github/workflows/ci.yml` | yes | CI runs lint, typecheck, build, and test with Bun | none |
| `docs/prompt-composition.md` | yes | Builtin prompts are Markdown, skill-agnostic, and must not hand-maintain delegation tables | none |
| `docs/config-loading.md` | yes | `packages/config` is canonical for shipped defaults; project config should be delta-only | none |

## Chain-of-Verification

1. **Initial assessment:** compared each spec unit and functional requirement theme against task sections `1.0`-`3.0`, their proof artifacts, and the relevant files table.
2. **Self-questioning:** verified every REQUIRED gate had explicit evidence instead of assumed pass/fail labels.
3. **Fact-checking:** confirmed standards evidence comes from actual repository sources (`AGENTS.md`, `README.md`, `package.json`, CI, prompt/config docs), not from the spec or task list alone.
4. **Inconsistency resolution:** added explicit negative delegation proof for non-delegating builtins and retained intentional `.weave/config.weave` `prompt_file` overrides for local `shuttle` and `weft` so the task list matches the source spec.
5. **Final synthesis:** all REQUIRED gates now pass with explicit evidence and no unresolved planning blockers remain.

## Exceptions

- `CONTRIBUTING.md` was not found.
- `.github/pull_request_template.md` was not found.
- Fallback standards evidence was taken from `AGENTS.md`, `README.md`, `package.json`, CI workflow, and current prompt/config docs.

## User-Approved Remediation Plan

- Completed

## Re-Audit Delta (Runs 2+ only)

- Requirement-to-test traceability: stayed PASS after adding explicit negative delegation coverage in `## Tasks > 2.0`.
- Proof artifact verifiability: stayed PASS after adding the retained-Shuttle/Weft-override diff artifact in `## Tasks > 3.0`.
- Repository standards consistency: stayed PASS; standards evidence is now paired with chain-of-verification and documented fallback handling for missing repo guideline files.
- Still-failing REQUIRED gates: none.
