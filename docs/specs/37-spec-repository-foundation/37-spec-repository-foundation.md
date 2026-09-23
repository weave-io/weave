# Spec 37 — Repository Foundation

**Status:** In progress — G1 and G3 have largely landed (#186, #194); see [37 tasks](37-tasks-repository-foundation.md) for what remains · **Workstream:** WS0 of the [September 2026 session audit](../../artifacts/session-audit-2026-09.md)

**Related:** [37 tasks](37-tasks-repository-foundation.md) · [Agent Evals](../../agent-evals.md) · [Eval Sanitization and Publish Pipeline](../../eval-sanitization-and-publish-pipeline.md) · [Spec 33 — Harness Trajectory Evals](../33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md) · [Spec 35 — Verification Trajectory Evals](../35-spec-verification-trajectory-evals/35-spec-verification-trajectory-evals.md) · [Documentation Policy](../../documentation-policy.md)

## Why

The session audit found that Weave loses the most time to failed delegations, serial plan execution, and missing environment awareness (WS1–WS3). Before changing agent behaviour, the repository needs a foundation that can prove whether a change helped:

- Every test must run in CI. Today 245 passing tests run only in the local pre-commit hook, not in CI (see Findings).
- Adding a model to the evals must be cheap. Today it touches about 50 files.
- The website must present eval results reliably. A `schemaVersion` bump on 5 Sep silently dropped models from tryweave.io/evals.
- Evals and tests must be easy to understand and diagnose, for maintainers and for agents.
- Real-session behaviour must be measurable, so WS1–WS4 have baselines and targets.

## Findings (19 Sep 2026)

| Area | Finding | Evidence |
| --- | --- | --- |
| Tests | `@weaveio/weave-adapter-opencode2` (149 tests, 32 files) and `@weaveio/weave-adapter-claude-code` (76 tests, 7 files) have no `test` script, so `bun run test` and CI skip them. Both pass when run directly. | `packages/adapters/{opencode2,claude-code}/package.json` |
| Tests | `packages/cli`'s `test` script lists test directories explicitly; `src/prompts/__tests__/self-modify.test.ts` (20 tests) is outside the list, so `bun run test` and CI skip it. | `packages/cli/package.json` |
| Tests | Local and CI test runs disagree. The pre-commit hook runs `bun test --recursive` from the root and finds all 189 files (6,099 tests), so these 245 tests do run locally on every commit. CI's `bun run test` runs per-package scripts and misses them, so a change that only breaks them passes CI. | `.husky/pre-commit`, `.github/workflows/ci.yml` |
| Tests | `@weaveio/weave-adapter-pi`'s `test` script is a no-op (`bun -e 'process.exit(0)'`); its source is not in this repository. | `packages/adapters/pi/package.json` |
| Tests | Tests log at `info` to stdout (pino default), so passing runs print JSON log lines and real failures are harder to spot. | `packages/engine/src/logger.ts` reads `LOG_LEVEL` |
| Tests | The suite is fast: about 5 s for everything that currently runs. | `bun run test` |
| Models | Adding a model means editing `evals/model-matrix.json`, the `allowed_models` array in 46 of 49 case files (each repeats the full 8-model list), `ALLOWED_MODELS` in `.github/workflows/agent-evals.yml`, and the assertion in `model-matrix.test.ts`. `workflow-sync.test.ts` enforces that they match, so the duplication is intentional but manual. | `evals/cases/**`, workflow line ~150 |
| Models | Default models include older entries (e.g. `anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4.5`), and current models such as Sonnet 5 and Fable 5.1 are absent. | `evals/model-matrix.json` |
| Evals | The eval subsystem is about 26k lines in `packages/cli/src/evals/`, with one bespoke runner per suite (700–2,200 lines each). `docs/agent-evals.md` is 1,501 lines. There is no one-page map of how a case becomes a published score. | `wc -l` |
| Evals | The last eval run was 5 Sep, before the prompt changes in #170, #179 and #182, so published scores don't describe current prompts. Runs are manual `workflow_dispatch` only. | `gh run list --workflow agent-evals.yml` |
| Website | `weave-website/src/lib/evals-data.ts` hand-copies the report types and hard-codes `schemaVersion` checks in four places. When the summary schema moved to v2, rows failed validation and were dropped silently. The fix was a one-line patch in the website. | `evals-data.ts:341,385,415,449` |
| Sessions | Real-session metrics exist only as one-off scripts from the audit. | [Session audit](../../artifacts/session-audit-2026-09.md) |

## Goals and outcomes

| # | Goal | Outcome that shows it is met |
| --- | --- | --- |
| G1 | Every test in the repository runs in CI. | `bun run test` runs all 39 adapter test files and the orphaned CLI test; a guard test fails if a workspace package contains `*.test.ts` files that its `test` script doesn't run. |
| G2 | Test output is quiet and diagnosable. | A passing `bun run test` prints no log lines; `LOG_LEVEL=debug bun run test` restores them; the testing guide says how to run one package, one file, one test. |
| G3 | Adding a model is one edit. | Adding a model to `evals/model-matrix.json` is the only required change: cases inherit the matrix, CI's allowlist is derived from the matrix, and `workflow-sync.test.ts` still passes. Proven by adding one current model with a one-file diff (plus docs). |
| G4 | The website presents results through a versioned contract. | The eval report JSON Schema is generated from `report-schema.ts` and published with each bundle. The website validates against it, shows every model in a report it can read, and says so visibly when it meets a newer schema version instead of dropping rows. A shared fixture report is tested in both repositories. |
| G5 | Evals are easy to understand. | A single-page map, `docs/evals-overview.md`, covers suite → case → rubric → runner → report → publish → website, with the commands to run one case. `docs/agent-evals.md` links to it. An audit of the nine runners records what they share, as input for a later consolidation. |
| G6 | An eval failure can be diagnosed from one command. | `bun packages/cli/src/main.ts eval run --agent <suite> --case <id> --model <id>` (or a documented equivalent) prints the verdict, the rubric criteria that failed, and where the raw transcript was written, without publishing. |
| G7 | Real sessions are measurable. | `bun scripts/audit/opencode-sessions.ts --since <date> [--project <path>]` reproduces the September baseline within rounding and prints the scorecard as Markdown and JSON. |
| G8 | Published scores describe current prompts. | After G3/G4 land, a full default-matrix eval run on current `main` is published and the website shows it, including the commit the run used. |

## Non-goals

- Consolidating the nine eval runners into one; G5 only produces the audit that decides whether to.
- Behaviour changes to agents or prompts (WS1–WS4).
- Scheduled or per-PR full eval runs (cost). Manual dispatch stays.
- Pi adapter tests; its source lives outside this repository. G1 records it as a known gap.
- Releasing. Changes land on `main`; releasing is the maintainer's decision (0.2.1).

## Constraints

- Bun only; `neverthrow` for fallible code; no `console.*` (see [AGENTS.md](../../../AGENTS.md)).
- The session audit script reads a harness database, which is harness-owned, so it lives under `scripts/`, not in the engine ([Adapter Boundary](../../adapter-boundary.md)). It opens the database read-only and never writes it.
- Eval case schema changes (G3) follow the schema-change rule: schema, validate and end-to-end tests in the same commit.
- Cross-repository changes (G4) land in `weave-io/weave` first, publishing the schema; `weave-website` then consumes it. Neither side may break the currently deployed page.
- Every user-visible change (G4, G8) includes a tryweave.io update ([website repo](https://github.com/pgermishuys/weave-website)).
