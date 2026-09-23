# Spec 37 — Repository Foundation

**Status:** In progress — G1 and G3 have largely landed (#186, #194); see [37 tasks](37-tasks-repository-foundation.md) for what remains. Since 23 Sep 2026 the eval goals G9–G11 come first, up to the [finish line](#finish-line-for-the-eval-work-23-sep-2026) · **Workstream:** WS0 of the [September 2026 session audit](../../artifacts/session-audit-2026-09.md)

**Related:** [37 tasks](37-tasks-repository-foundation.md) · [Agent Evals](../../agent-evals.md) · [Eval Sanitization and Publish Pipeline](../../eval-sanitization-and-publish-pipeline.md) · [Spec 33 — Harness Trajectory Evals](../33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md) · [Spec 35 — Verification Trajectory Evals](../35-spec-verification-trajectory-evals/35-spec-verification-trajectory-evals.md) · [Documentation Policy](../../documentation-policy.md)

## Why

The session audit found that Weave loses the most time to failed delegations, serial plan execution, and missing environment awareness (WS1–WS3). Before changing agent behaviour, the repository needs a foundation that can prove whether a change helped:

- Every test must run in CI. Today 245 passing tests run only in the local pre-commit hook, not in CI (see Findings).
- Adding a model to the evals must be cheap. Today it touches about 50 files.
- The website must present eval results reliably. A `schemaVersion` bump on 5 Sep silently dropped models from tryweave.io/evals.
- Evals and tests must be easy to understand and diagnose, for maintainers and for agents.
- Real-session behaviour must be measurable, so WS1–WS4 have baselines and targets.
- The evals must be able to show whether a prompt or agent change helped. Today one flipped case moves a model's suite score by 50%, and a scoring hole can publish an empty run as green (see [Eval findings (23 Sep 2026)](#eval-findings-23-sep-2026)).

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

## Eval findings (23 Sep 2026)

Added after the maintainer decided the agent evals must be fixed before any agent or prompt work.

| Area | Finding | Evidence |
| --- | --- | --- |
| Coverage | The last published run is 5 Sep (commit `80ffde6`): 296 results, 37 cases × 8 models. 12 of the current 49 cases have never been in a published run. | `weave-io/weave-agent-evals` |
| Noise | Most suites had 2 cases per model in that run, and each case runs once (temperature 0.2), so one flipped case moves a model's suite score by 50%. Only Pattern and Loom have repeatability diagnostics, and those compare separate runs after the fact. | `repeatability-diagnostics.json`, `packages/cli/src/evals/runner.ts` ~1514 |
| Tooling | `eval run` accepts only `--agent`, `--case`, `--model`, `--raw-artifacts` and `--dry-run`. There is no way to repeat a case or compare two runs. | `packages/cli/src/commands/eval.ts` |
| Scoring | A `--model` typo publishes an empty green run on `loom-routing` and `tapestry-execution` (#205). _Fixed by 16.1: every suite now fails closed._ | `tests/evals/suite-runners.scenario.test.ts` ("a maintainer narrows the run to one case or one model") |
| Scoring | The `tapestry-category-routing` qualitative gate averages in two inapplicable dimensions scored 1.0, so only a judge verdict below 0.1 can fail it. The placeholder `shuttle-{category}` still earns 0.4 through the generic-fallback detector. | `tapestry-category-routing-runner.ts` |
| Judge | The LLM judge is hard-coded to `anthropic/claude-sonnet-4.5`, which is also a scored matrix model. Neither the provenance manifest nor the report schema records which judge scored a run. The judge scores the 11 untagged `task_completion` cases (pattern, weft, warp, spindle, shuttle, tapestry) and feeds the 10 category-routing cases. | `packages/cli/src/commands/eval.ts:415` |
| Judge | A candidate replacement, TypeSafe Jev (`typesafe/jev-1.13` on OpenRouter), is a decisions model: it is called through `POST /api/alpha/decisions` rather than chat completions, returns probabilities and confidence without a free-text rationale, has a 32k context, and costs about $0.000015 per call. It is about a week old and the endpoint is alpha. A smoke test separated an evidenced from an unevidenced verification report correctly. It cannot go through openevals' `createLLMAsJudge`, but `LangChainJudge` is an interface a Jev judge can implement. | `packages/cli/src/evals/langchain-agent-evals.ts:167` |
| Runtime | 46 of 49 cases are text-only; 3 are `harness_trajectory` cases, and the trajectory CI job was skipped on the 5 Sep dispatch. The session audit's problems (delegation failures, serial execution, environment awareness) are runtime behaviour. | `.github/workflows/agent-evals.yml`, [session audit](../../artifacts/session-audit-2026-09.md) |
| Cost | A full run takes about 65 minutes over 8 models and is manual dispatch only. | `gh run list --workflow agent-evals.yml` |

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
| G8 | Published scores describe current prompts. | After G3, G4 and G9–G11 land, a full default-matrix eval run on current `main`, with each case repeated, is published as the baseline and the website shows it, including the commit the run used. |
| G9 | Eval scores are truthful. | No suite reports green with zero cases, and a run with zero cases is never published or indexed. A failing judge verdict can fail a category-routing case, and the `shuttle-{category}` placeholder scores 0. The judge is never an evaluated model. It is Jev, accepted by agreement with maintainer hand labels (`docs/artifacts/judge-bakeoff-<date>.md`), and its id and version are recorded in provenance and in the report. |
| G10 | Eval runs are repeatable, comparable and cheap to iterate on. | A development subset of one or two inexpensive models runs without editing the matrix. `eval run --repeat N` reports a pass rate per case and model. `eval compare <baseline> <candidate>` states per suite whether a difference is outside the noise, and refuses to compare runs scored by different judges. Per-case flip rates are recorded, and each suite has at least the case count they call for. |
| G11 | Evals cover runtime behaviour. | `harness_trajectory` cases cover delegation accuracy, parallel execution and environment awareness, each tied to a session-audit metric, and the trajectory job runs on every manual dispatch instead of being skipped. |

## Finish line for the eval work (23 Sep 2026)

The maintainer's decision: the evals need to run reliably and predictably, be easy to understand and exercise realistic scenarios. Once they do, the eval work stops. Good enough beats perfect; no further improvement loops.

The eval work is done when:

1. One command runs a realistic eval set predictably: `weave eval run --models dev --repeat 3` completes without infrastructure errors, at a known time and cost.
2. Every failure can be explained with single-case diagnosis (17.2, #224).
3. `eval compare` tells a real change from noise (18.2, #226).
4. The cases include realistic runtime scenarios: one trajectory case each for delegation accuracy, parallel execution and environment awareness (20.1).
5. A one-page overview explains how evals work and how to run them (6.1).
6. A baseline on `main` is recorded as a docs artifact.

After that, WS1 starts. Evals change only when a WS change needs it.

This narrows some goals. The baseline (G8) stays a local artifact and is not published to the website. The runner audit (G5), suite growth (G10) and the website contract (G4) are deferred. G2 and G7 are deferred too. The [tasks file](37-tasks-repository-foundation.md) lists what remains and what is deferred.

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
- Report schema changes from G10 (repeats) and G9 (judge id and version) land before G4 publishes the versioned contract, so the contract is written once.
- Baselines are only compared with runs scored by the same judge id and version.
- The judge is never an evaluated model. Any chat model used as judge could not join the matrix without grading itself, so the judge is Jev, a decisions model that can never be evaluated (decided 23 Sep 2026). If Jev fails its acceptance check (16.3), the fallback is a chat model deliberately kept out of the matrix, recorded as a known limitation.
- Every user-visible change (G4, G8) includes a tryweave.io update ([website repo](https://github.com/pgermishuys/weave-website)).
