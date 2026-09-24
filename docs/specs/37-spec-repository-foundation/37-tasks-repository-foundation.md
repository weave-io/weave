# Spec 37 Tasks — Repository Foundation

Task tracking for [Spec 37](37-spec-repository-foundation.md). Non-normative: tick boxes as work lands; don't rewrite history.

## Start here (for a new session)

1. Read [Spec 37](37-spec-repository-foundation.md) (goals G1–G11) and skim the [session audit](../../artifacts/session-audit-2026-09.md) for context.
2. Pick the next unchecked task group using **Order and dependencies** below. Groups appear in the file in their working order, not their number order; tasks inside a group can usually be done together.
3. Keep one pull request per task group. Reference the group's tracking issue in the PR (AGENTS.md requires a related issue); if none exists, create it first.
4. Tick the boxes in this file in the same PR that does the work, and add the PR number next to the group heading.
5. Keep sessions short: stop after a group lands and start the next group in a fresh session from this file.

**Order and dependencies:** The agent evals are fixed before any prompt or agent work, and only up to the [finish line](37-spec-repository-foundation.md#finish-line-for-the-eval-work-23-sep-2026). What remains runs in this order:

1. 16.5 and 20.2 (in progress).
2. 16.3 → 16.4, the judge: Jev's acceptance check, then `JevJudge`. Waits on the maintainer's hand labels.
3. 20.1: one trajectory case per behaviour. Extend the case schema only if it is unavoidable.
4. 6.1, the overview.
5. 7.1–7.4, the baseline. It includes the per-case flip rates of 19.1.
6. 7.5, one weave-website docs PR for the user-visible CLI changes: `--models dev`, `--repeat`, `eval compare` and single-case diagnosis.

Then WS1 starts. **Deferred** as outside the eval finish line: groups 2, 3 and 5 (with #201; the baseline stays a local artifact for now), 4.4–4.6, 6.3 (no runner refactor), 6.4 and 19.2 (grow a suite only where the baseline shows it cannot detect a change). The tasks stay here so they can be picked up later. 6.2 has moved to 17.2. _(Earlier orders: before 23 Sep 2026, 1 → 2 → 3 in parallel, 4, then 5 after 4, 6 after 3 and 5, and 7 at any time. On 23 Sep 2026, before the finish line was set, 16 → 17 → 18 → 19 → 20 → 5 → 7, with 2, 3, 4.4–4.6 and 6 in parallel.)_

## 1. Every test runs (G1) — PR: #186

- [x] 1.1 Add `"test": "bun test ./src"` to `packages/adapters/opencode2/package.json` and `packages/adapters/claude-code/package.json`. Confirm 149 and 76 tests run under `bun run test`.
- [x] 1.2 Change `packages/cli`'s `test` script to `bun test ./src` so new test directories can't be missed. Confirm `src/prompts/__tests__/self-modify.test.ts` (20 tests) now runs and the total rises by 20.
- [x] 1.3 Add a guard test (e.g. `scripts/ci/verify-test-scripts.ts`, wired like `verify:codeowners`): for every workspace package, fail if it contains `*.test.ts` files and its `test` script is missing or is a no-op. Allowlist `@weaveio/weave-adapter-pi` with a comment explaining its source lives outside this repo. _Landed as `scripts/ci/verify-test-coverage.ts` (`bun run verify:test-coverage`); it also checks each package's `bunfig.toml` preload, and its `EXEMPT` list covers Pi and the docs site._
- [ ] 1.4 Make local and CI runs agree: either CI runs the same `bun test --recursive` as `.husky/pre-commit`, or the hook runs `bun run test`. Pick one entry point and use it in both places. _Partly done: #186 made both paths run the same tests, but the hook still calls `bun test --recursive` while CI calls `bun run test`._
- [x] 1.5 Record the new totals in the PR description (before: core 451, engine 1752, config 423, copilot 119, opencode 416, cli 2643). _#186: 5,809 → 6,117._

## 2. Quiet, diagnosable test output (G2) — PR: _

_Deferred on 23 Sep 2026: outside the eval finish line._

- [ ] 2.1 Make tests default to `LOG_LEVEL=silent` (e.g. `[test] preload` in `bunfig.toml`, or env in each package's test script) while `LOG_LEVEL=debug bun run test` still shows logs. Don't change the runtime default. _Partly done: #186 applied the preload on the CI path, so passing runs are quiet. `scripts/test-setup.ts` assigns `LOG_LEVEL = "silent"` unconditionally, so `LOG_LEVEL=debug` does not yet bring logs back._
- [ ] 2.2 Check that no test asserts on log output in a way that breaks; adjust with an injected logger if one does.
- [ ] 2.3 Add `docs/testing/README.md`: how to run everything, one package, one file, one test (`bun test <file> -t <name>`), how to turn logs on, and where the proof scripts (`scripts/proof/*`) and trajectory evals fit. Link it from `docs/README.md`.

## 3. Session audit script (G7) — PR: _

_Deferred on 23 Sep 2026: outside the eval finish line._

- [ ] 3.1 Add `scripts/audit/opencode-sessions.ts` (Bun, `bun:sqlite`, `readonly: true`). Flags: `--db` (default `~/.local/share/opencode/opencode.db`), `--since`, `--until`, `--project <dir>`, `--format md|json`. Exclude sessions whose directory starts with `/tmp/`.
- [ ] 3.2 Implement the metrics in [Metric definitions](#metric-definitions-for-the-session-audit-script) below, keeping each as a small named function so it can be unit-tested against a fixture database.
- [ ] 3.3 Add a fixture test that builds a tiny in-memory SQLite database with the OpenCode schema (`session`, `message`, `part`) and asserts each metric.
- [ ] 3.4 Run it for 4–18 Sep 2026 and check that it reproduces the baseline in the [session audit](../../artifacts/session-audit-2026-09.md) within rounding. Note any definitional differences in the script's header comment.
- [ ] 3.5 Document usage in `docs/testing/README.md` (from 2.3) or a short `scripts/audit/README.md`.

## 4. One-edit model addition (G3) — PR: #194

- [x] 4.1 Change case semantics: a missing `allowed_models` means "every default model in the matrix". Keep `allowed_models` only for cases that deliberately restrict (e.g. the `openai/gpt-4o-mini` trajectory case and the two 4-model cases). Update the case schema, `case-loader.ts`, and the schema/validate/end-to-end tests in the same commit. _An explicit list that restates the defaults is now rejected at load time._
- [x] 4.2 Remove the repeated 8-model `allowed_models` arrays from the 46 case files that list the full default set.
- [x] 4.3 Derive `ALLOWED_MODELS` in `.github/workflows/agent-evals.yml` from `evals/model-matrix.json` at run time (e.g. `jq -r '.models[].id'`), keeping the validate-before-secrets ordering described in `docs/agent-evals.md`. Update `workflow-sync.test.ts` to assert the derivation rather than a copied list. _`ALLOWED_TRAJECTORY_MODELS` is derived from the trajectory cases the same way._
- [ ] 4.4 _Deferred on 23 Sep 2026: outside the eval finish line._ Make `model-matrix.test.ts` assert invariants (unique ids, provider matches the id prefix, at least one default) instead of a hard-coded list. _Still open: the test asserts "exactly the canonical default seven-model matrix"._
- [ ] 4.5 _Deferred on 23 Sep 2026: outside the eval finish line._ Proof: add one current model chosen by the maintainer (e.g. Sonnet 5 or Fable 5.1 via OpenRouter) with a diff to `evals/model-matrix.json` only. Run one cheap case against it locally. _Partly done: #194 proved the one-file claim with a throwaway `acme/test-model-9` and reverted it. No current model has been added or run._
- [ ] 4.6 _Deferred on 23 Sep 2026: outside the eval finish line._ Document "Add a model" as a short numbered section at the top of `evals/README.md`. _Partly done: #194 added "Adding a model" to [`docs/agent-evals.md`](../../agent-evals.md); `evals/README.md` does not have it yet._

## 8–15. Outside-in test taxonomy (WS0b) — PRs: #185, #186, #187, #189, #190, #191, #192, #193

Added to #183 on 20 Sep 2026 after a second audit of the suite, and complete. The taxonomy, inventory and the corrections to three findings are in [`docs/testing-strategy.md`](../../testing-strategy.md); the scenario contract is [`tests/README.md`](../../../tests/README.md). Migrating the remaining unit tests into scenarios continues area by area (#195 onwards) and is tracked there, not here.

## 16. Truthful scores (G9) — PR: #221 (16.1), #220 (16.2), #228 (16.5)

- [x] 16.1 Fix #205 once, at the orchestrator rather than per runner: `EvalOrchestrator` (`packages/cli/src/evals/runner.ts`) reports a suite that ran zero cases as a failure, never green, and `ArtifactBundleWriter` (`artifact-bundle.ts`) refuses to publish or index a run whose `totalCases` is 0. Flip the scenarios in `tests/evals/suite-runners.scenario.test.ts` that pin today's behaviour (`EMPTY_RUN_ON_MODEL_FILTER`, currently `loom-routing` and `tapestry-execution`) so they assert the new one. _#221: `EvalOrchestrator` fails a suite that ran no cases with `NoCasesFound` (the six per-runner work-item guards are gone), `writeBundle()` refuses `totalCases: 0` with `EmptyRun`, and `weave eval run` prints partial failures on stderr._
- [x] 16.2 Category-routing gate: in `tapestry-category-routing-runner.ts`, stop inapplicable dimensions (scored 1.0) diluting the qualitative gate, so a failing judge verdict can fail the case; today only a verdict below 0.1 can. The placeholder `shuttle-{category}` scores 0, not the 0.4 the generic-fallback detector gives it. Add a scenario for each. _#220: the gate and `weightedTotal` count only applicable qualitative dimensions; `BARE_SHUTTLE_RE` rejects any trailing hyphen. Published scores for this suite drop; see `docs/agent-evals.md`._
- [ ] 16.3 Jev acceptance check. _Rewritten on 23 Sep 2026: the judge is Jev by design, not the winner of a head-to-head, because a chat-model judge could not join the matrix without grading itself (see the spec's Constraints)._ Make a fresh run on the cheap development subset (17.1) with `--raw-artifacts` on the judge-scored suites: the 11 untagged `task_completion` cases (pattern, weft, warp, spindle, shuttle, tapestry) and the 10 category-routing cases. Select 20 outputs, weighted to weft, warp and pattern (harness: draft #223). The maintainer hand-labels each pass or fail. Score the same outputs with TypeSafe Jev (`typesafe/jev-1.13`, OpenRouter decisions endpoint). Jev is accepted if it agrees with the maintainer on at least 16 of 20 items (80%) and wrongly passes at most 2 items the maintainer failed. Sonnet 5's verdicts stay in the comparison as a reference only. Record the outputs, labels, verdicts, agreement and the result in `docs/artifacts/judge-bakeoff-<date>.md`. The labels double as the human calibration set for later judge changes.
- [ ] 16.4 Implement `JevJudge` behind `LangChainJudge` (`langchain-agent-evals.ts`), replacing the hard-coded `JUDGE_MODEL_ID` in `packages/cli/src/commands/eval.ts`. It calls `POST https://openrouter.ai/api/alpha/decisions`, converts each judge-scored case's rubric into Jev questions (`noul` yes/no checks and anchored `score` questions), and derives the rationale from which questions failed, since Jev returns no free text. Pin the judge's version. Record the judge id and version in the provenance manifest and the public report. _18.2 already refuses different judges: it reads `judge: { id, version }` from `bundle-index.json`, else `public-report.json`, else `provenance-manifest.json`, and flags a run without one as "unknown judge". Write it in one of those places._ Only if Jev fails 16.3: use a chat model deliberately kept out of the matrix instead, and record that as a known limitation in `docs/agent-evals.md`. Schema, validate and end-to-end tests change in the same commit as any report schema change.
- [x] 16.5 Empty or truncated answers from reasoning models are infrastructure errors, not model failures. _#228: confirmed live that `deepseek/deepseek-v4-flash-0731` could spend the whole 2048-token cap reasoning and return `finish_reason: "length"` with a single space (1,221–7,508 reasoning tokens across six calls of one Weft case). The client now asks for 16384 tokens, returns a typed `EmptyResponse` / `TruncatedResponse` for an answer with no usable content, and the orchestrator asks up to three times. Every runner error path now marks the case `errored` (`case-outcomes.ts`): counted apart from failures and pass rates, never green, a `CasesErrored` partial failure (exit 1), and an all-errored run is never published (`NoScoredCases`). It reuses the `errored` flag 18.1 added, adds `errorClassification` and an optional `erroredCases`, and `failedCases` no longer counts errored cases; see "Empty and truncated answers" in `docs/agent-evals.md`._

## 17. Cheap runs (G6, G10) — PR: #222 (17.1), #224 (17.2)

- [x] 17.1 Add a development subset of one or two inexpensive models, selectable without editing the matrix (for example a `dev` marker in `evals/model-matrix.json` and a `--models dev` selector), kept separate from the full default matrix. A plain `eval run` still runs the full default matrix. _#222: `dev: true` on matrix entries (at most 2), `--models dev` / `WEAVE_EVAL_MODELS` / the `models` dispatch input. Subset: `deepseek/deepseek-v4-flash-0731` and `openai/gpt-6-luna`; see `docs/agent-evals.md`._
- [x] 17.2 Single-case diagnosis (moved from 6.2): running one case for one model without publishing prints the verdict, the rubric criteria that failed, and the path to the raw transcript. Fix the output where it doesn't; document the command in `docs/agent-evals.md` and in 6.1's overview when that lands. _#224: a live `eval run` printed nothing about its cases; it now prints a run report (`run-report.ts`): the verdict per case × model, each applicable dimension of a failed case with its score and bar, and the raw transcript path. Raw artifacts stay opt-in (`--raw-artifacts`). Recipe: "Diagnose one case" in `docs/agent-evals.md` and `evals/README.md`; 6.1's overview does not exist yet and should link it._

## 18. Repeatable and comparable runs (G10) — PR: #225 (18.1), #226 (18.2)

This changes the report schema, so it lands before group 5 and the versioned contract is written once.

- [x] 18.1 Add `--repeat N` to `eval run`. Each case runs N times per model, and the report gives a pass rate per case and model (and per suite) instead of a single pass or fail. `N = 1` keeps today's behaviour. _#225: `--repeat N` (1–20, or `WEAVE_EVAL_REPEAT`) runs the models × suites pass N times; every attempt is published as its own entry with `attempt`, and each suite summary gets a `repeats` block with a pass rate per model and per case × model (`pass-rates.ts`). Errored attempts are left out of the rate and counted as `errored`. `N = 1` writes no new field. No `schemaVersion` changed: the new fields are optional. The workflow has no `repeat` input yet; 7.1 needs one. See "Repeat cases" in `docs/agent-evals.md`._
- [x] 18.2 Add `eval compare <baseline> <candidate>`: per suite and model, show both pass rates and state whether the difference is outside the noise measured by the repeats. Build on the existing repeatability diagnostics (`repeatability-diagnostics.json`, written by `runner.ts` for Pattern and Loom only) and generalise them to every suite. Refuse to compare runs with different judges (16.4) or different case sets, and say why. _#226: `compare.ts` reads two local bundles (run ID or directory) and runs a two-sided Fisher's exact test per suite × model on scored attempts, Holm-adjusted across the rows that could reach p < 0.05; rows that cannot say "too few scored attempts". It refuses different models, case × model pairs, repeat counts, recorded judges and dry runs. A run with no recorded judge is flagged "unknown judge" and compared. The diagnostics already covered every suite; they stay as a descriptive log, and `eval compare` makes the decision. Recipe and limits: "Measure a change" and "Compare two runs" in `docs/agent-evals.md`._

## 19. Noise and suite growth (G10) — PR: _

- [ ] 19.1 _Folded into group 7 (7.2) on 23 Sep 2026; tick it there._ Run the current cases with repeats (18.1) on the development subset (17.1). Record the per-case flip rate (how often a case's verdict differs between repeats) in `docs/artifacts/eval-noise-<date>.md`.
- [ ] 19.2 _Deferred on 23 Sep 2026: outside the eval finish line. Grow a suite only where the baseline (7.4) shows it cannot detect a change._ From those flip rates, derive a target case count per suite that lets a real change be told apart from noise, and record the reasoning in the same artifact. Grow the thin suites to their targets: spindle (2 cases), pattern, weft, warp and shuttle (4 each), tapestry-execution (5).

## 20. Runtime behaviour coverage (G11) — PR: #227 (20.2), #230 (20.1 delegation accuracy), #231 (20.1 parallel execution), #232 (20.1 environment awareness)

- [x] 20.1 Add `harness_trajectory` cases for the three runtime problems in the session audit, each tied to a metric in [Metric definitions](#metric-definitions-for-the-session-audit-script): delegation accuracy (Delegations, Configuration delegation failures, Category-shuttle success), parallel execution (Parallel dispatch, Plan-task delegation by Loom) and environment awareness (Environment reminders). Each case states which metric it stands in for. _One case per behaviour, each passed its one live run on DeepSeek V4 Flash (23 Sep 2026). Delegation accuracy: #230, `loom-delegates-backend-fix-to-category-trajectory`, new `allowed_delegates` check. Parallel execution: #231, `tapestry-dispatches-independent-tasks-in-parallel-trajectory`, new `min_parallel_delegations` check (Plan-task delegation by Loom is not covered; it needs the /start-work handoff). Environment awareness: #232, `loom-runs-the-failing-check-itself-trajectory`, existing Spec 35 fields only; Loom fixed it itself without delegating. Both schema extensions are in Spec 35 under "Runtime behaviour checks"; the cases are in "Runtime behaviour cases" in `docs/agent-evals.md`._
- [x] 20.2 Make the `trajectory-evals` job in `.github/workflows/agent-evals.yml` run on manual dispatch instead of being skipped by its changed-paths gate (it was skipped on the 5 Sep dispatch). Update `workflow-sync.test.ts` in the same commit. _#227: the changed-paths gate is gone; the job runs on every dispatch unless the new `trajectory` boolean input (on by default) is unticked or the validated filters leave it no work. It no longer runs one fixed case on `openai/gpt-4o-mini`: it runs `weave eval run --track trajectory` with the dispatch's agent, model, model-set, case and repeat filters. The new `--track text|trajectory` (`eval-track.ts`) splits the tracks, because the text job would otherwise have run the Spec 35 trajectory cases on the default matrix with no sandbox image. A `repeat` dispatch input (1–20, validated before any secret) reaches both jobs as `WEAVE_EVAL_REPEAT`, for 7.1. See "CI dispatch" and "Run one track" in `docs/agent-evals.md`._

## 5. Website contract (G4) — PR (weave): _ · PR (website): _

_Deferred on 23 Sep 2026: outside the eval finish line._ #201 is deferred with it; the baseline stays a local artifact for now.

When picked up, it comes after group 20 (see [Order and dependencies](#start-here-for-a-new-session)), so the schema it publishes already includes repeats (18) and the judge (16.4).

- [ ] 5.1 In this repo, generate JSON Schema from the Zod schemas in `packages/cli/src/evals/report-schema.ts` (public report, suite summary, report bundle, dashboard indexes) and write it with each published bundle (e.g. `schemas/v<N>/*.json` in weave-agent-evals). Add a test that the generated schema matches the committed copy.
- [ ] 5.2 Commit a small, sanitized fixture bundle (one run, two models, two suites) under `packages/cli/src/evals/__fixtures__/` that the report tests validate.
- [ ] 5.3 In `weave-website`: replace the hand-copied types and the four hard-coded `schemaVersion` checks in `src/lib/evals-data.ts` with validation against the published schema, keyed by `schemaVersion`.
- [ ] 5.4 In `weave-website`: when a report or summary has an unknown `schemaVersion`, show the last readable run and a visible "newer results available; site update needed" note, rather than dropping rows.
- [ ] 5.5 In `weave-website`: add a test that loads the same fixture bundle (copied, or fetched in CI) and asserts every model and suite renders.
- [ ] 5.6 Show each run's commit and date on the evals page so stale results are obvious.
- [ ] 5.7 Resolve #201: decide which files a published bundle contains, make the publisher upload only those (today it uploads every file the run wrote, including `score-<suite>.json` with unbounded explanations), and make the published JSON Schema cover every published file.

## 6. Understandable and diagnosable evals (G5, G6) — PR: _

- [ ] 6.1 Write `docs/evals-overview.md` (one page): the suites, where cases, rubrics and fixtures live, which runner handles which suite, how scoring works, how a run becomes a published bundle and a website page, and the three commands most people need. Link it from `docs/README.md`, `evals/README.md`, and the top of `docs/agent-evals.md`.
- [x] 6.2 _Moved to 17.2 on 23 Sep 2026; done in #224._ Verify that a single case can be run locally for one model without publishing, and that failure output shows the verdict, the failed rubric criteria, and the path to the raw transcript. Fix the output where it doesn't; document the command in 6.1.
- [ ] 6.3 _Deferred on 23 Sep 2026: outside the eval finish line; no runner refactor._ Audit the nine runners in `packages/cli/src/evals/*-runner.ts`: list the steps each performs and which are shared. Record the result as `docs/artifacts/eval-runner-audit.md` with a recommendation (consolidate or not) for a future spec. No refactor in this group.
- [ ] 6.4 _Deferred on 23 Sep 2026: outside the eval finish line._ Prune `docs/agent-evals.md` of anything now covered by 6.1 or stale since #182 (the verification feedback loops), keeping it as the detailed reference.

## 7. Fresh baseline (G8) — PR: _

Comes last among the eval work, after 16.3–16.5, 20 and 6.1. Rewritten on 23 Sep 2026 for the [finish line](37-spec-repository-foundation.md#finish-line-for-the-eval-work-23-sep-2026); 19.1 is folded in as 7.2.

- [ ] 7.1 Replace the delisted qwen model (`qwen/qwen3.8-max`) in `evals/model-matrix.json` with a listed one (OpenRouter lists `qwen/qwen3.8-max-0902`, checked 23 Sep 2026; since 16.5 every case on a delisted model is reported errored, `model-http-failure`, and the run exits 1), so the full matrix runs without infrastructure errors.
- [ ] 7.2 Run the development subset with repeats on current `main`: `weave eval run --models dev --repeat 3`. It must complete without infrastructure errors. Record its time and cost, and the per-case flip rate (how often a case's verdict differs between repeats; was 19.1). Check OpenRouter credits first.
- [ ] 7.3 Run the full default matrix once on current `main`, with the trajectory job (20.2). Record its time and cost.
- [ ] 7.4 Record the pre-WS1 baseline in `docs/artifacts/eval-baseline-<date>.md`: per-suite pass rates, their noise bands, the per-case flip rates, the judge id and version, and the time and cost of each run. Later runs are compared against it with `eval compare` (18.2). Publishing it to the website is not required.
- [ ] 7.5 Open one weave-website docs PR for the user-visible CLI changes: `--models dev`, `--repeat`, `eval compare` and single-case diagnosis.
- [ ] 7.6 _Deferred on 23 Sep 2026: outside the eval finish line (with group 5)._ Confirm the website shows every model from the baseline run with its commit and date.

## Metric definitions for the session audit script

All metrics are computed over top-level sessions (`parent_id IS NULL`) and their child sessions, excluding directories under `/tmp/`. `message.data` and `part.data` are JSON. Tool calls are parts with `type = 'tool'`; `state.status` is `completed`, `error` or `running`.

| Metric | Definition |
| --- | --- |
| Delegations | Tool parts with `tool = 'task'`; the target is `state.input.subagent_type`. |
| Configuration delegation failures | `task` parts with `state.status = 'error'` and `state.error` matching `Model not found`, `Unknown agent type`, or with no `subagent_type`. |
| Category-shuttle success | `task` parts whose target starts with `shuttle-`: completed ÷ total. |
| Built-in agent delegations | `task` parts targeting `explore` or `general`. |
| Transient failures | `task` errors matching `Connection reset` or `Subagent failed`. |
| Parallel dispatch | Group an assistant message's parts into steps (between `step-start` and `step-finish`). A parallel step has two or more `task` parts. Report parallel steps ÷ steps with at least one `task`, per agent (`message.data.agent`). |
| Plan-task delegation by Loom | In sessions containing a user text part with `activated by the /start-work command`, count assistant messages with `agent = 'loom'` that contain a `task` part. |
| "Stuck" turns | User text parts (not `synthetic`) matching `/got stuck|getting stuck|are you there|^hello\?/i`. |
| Environment reminders | User text parts matching `/you (also )?have access|\/usr\/bin\/gh|use the `?gh`? cli|source ~\/\.bashrc|you can do the verification yourself|no you run it/i`. |
| `webfetch` 404s | `webfetch` parts with `state.status = 'error'` and `state.error` containing `404`. |
| Shuttle duration | `task` parts targeting `shuttle*`: `state.time.end - state.time.start`, reported as p50 and p90 in minutes. |
| Offer endings | Loom assistant messages with `finish = 'stop'` whose last text part ends with `?` or with an offer phrase (`want me to`, `shall I`, `should I`, `would you like`, `say the word`, `let me know if`). |
| Question-tool failures | `question` parts by Loom with `state.status = 'error'` ÷ all Loom `question` parts. |
| User aborts | Assistant messages with `data.error.name = 'MessageAbortedError'`, by agent. |

## Relevant files

| File | Why it is relevant |
| --- | --- |
| `package.json` | Root `test` script (`bun run --filter '*' test`). |
| `packages/*/package.json`, `packages/adapters/*/package.json` | Per-package `test` scripts (group 1). |
| `bunfig.toml` | Test preload for a silent log level (group 2). |
| `packages/engine/src/logger.ts` | Reads `LOG_LEVEL`. |
| `evals/model-matrix.json` | The single source of models (group 4). |
| `evals/cases/**` | Case files with `allowed_models` (group 4). |
| `packages/cli/src/evals/case-loader.ts` | Case loading and validation (group 4). |
| `packages/cli/src/evals/__tests__/workflow-sync.test.ts`, `model-matrix.test.ts` | Tests to change from copied lists to derived rules (group 4). |
| `.github/workflows/agent-evals.yml` | `ALLOWED_MODELS` allowlist (group 4). |
| `packages/cli/src/evals/report-schema.ts` | Zod report schemas to publish as JSON Schema (group 5). |
| `~/source/weave-website/src/lib/evals-data.ts` | Website eval loader (group 5). |
| `docs/agent-evals.md`, `evals/README.md` | Eval documentation (groups 4, 6). |
| `scripts/audit/` | New session audit script (group 3). |
| `packages/cli/src/evals/runner.ts` | `EvalOrchestrator` and repeatability diagnostics (groups 16, 18). |
| `packages/cli/src/evals/artifact-bundle.ts` | Bundle writer and publisher hand-off (groups 16.1, 5.7). |
| `packages/cli/src/evals/tapestry-category-routing-runner.ts` | Category-routing gate and generic-fallback detector (group 16.2). |
| `packages/cli/src/evals/langchain-agent-evals.ts`, `packages/cli/src/commands/eval.ts` | `LangChainJudge` interface and the hard-coded judge model (group 16.4). |
| `tests/evals/suite-runners.scenario.test.ts` | Scenarios for the empty-run guard of #205: every suite fails closed (group 16.1). |
| `packages/cli/src/evals/model-matrix.ts`, `tests/evals/model-sets.scenario.test.ts` | The `dev` model subset and `--models` selector, and its scenarios (group 17.1). |
| `packages/cli/src/evals/run-report.ts`, `tests/evals/diagnosis.scenario.test.ts` | The report a live run prints, and the single-case diagnosis scenarios (group 17.2). |
| `packages/cli/src/evals/case-outcomes.ts`, `packages/cli/src/evals/openrouter-client.ts`, `tests/evals/errored-cases.scenario.test.ts` | Passed / failed / errored counting, the completion-token cap, the empty/truncated answer errors and their retry, and the errored-case scenarios (group 16.5). |
