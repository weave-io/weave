# Spec 37 Tasks — Repository Foundation

Task tracking for [Spec 37](37-spec-repository-foundation.md). Non-normative: tick boxes as work lands; don't rewrite history.

## Start here (for a new session)

1. Read [Spec 37](37-spec-repository-foundation.md) (goals G1–G8) and skim the [session audit](../../artifacts/session-audit-2026-09.md) for context.
2. Pick the first unchecked task group below. Groups are ordered; tasks inside a group can usually be done together.
3. Keep one pull request per task group. Reference the group's tracking issue in the PR (AGENTS.md requires a related issue); if none exists, create it first.
4. Tick the boxes in this file in the same PR that does the work, and add the PR number next to the group heading.
5. Keep sessions short: stop after a group lands and start the next group in a fresh session from this file.

**Order and dependencies:** 1 → 2 → 3 are independent quick wins and can run in parallel sessions. 4 depends on nothing. 5 depends on 4 (the schema must be published before the website consumes it). 6 depends on 3 and 5. 7 can happen any time.

## 1. Every test runs (G1) — PR: #186

- [x] 1.1 Add `"test": "bun test ./src"` to `packages/adapters/opencode2/package.json` and `packages/adapters/claude-code/package.json`. Confirm 149 and 76 tests run under `bun run test`.
- [x] 1.2 Change `packages/cli`'s `test` script to `bun test ./src` so new test directories can't be missed. Confirm `src/prompts/__tests__/self-modify.test.ts` (20 tests) now runs and the total rises by 20.
- [x] 1.3 Add a guard test (e.g. `scripts/ci/verify-test-scripts.ts`, wired like `verify:codeowners`): for every workspace package, fail if it contains `*.test.ts` files and its `test` script is missing or is a no-op. Allowlist `@weaveio/weave-adapter-pi` with a comment explaining its source lives outside this repo. _Landed as `scripts/ci/verify-test-coverage.ts` (`bun run verify:test-coverage`); it also checks each package's `bunfig.toml` preload, and its `EXEMPT` list covers Pi and the docs site._
- [ ] 1.4 Make local and CI runs agree: either CI runs the same `bun test --recursive` as `.husky/pre-commit`, or the hook runs `bun run test`. Pick one entry point and use it in both places. _Partly done: #186 made both paths run the same tests, but the hook still calls `bun test --recursive` while CI calls `bun run test`._
- [x] 1.5 Record the new totals in the PR description (before: core 451, engine 1752, config 423, copilot 119, opencode 416, cli 2643). _#186: 5,809 → 6,117._

## 2. Quiet, diagnosable test output (G2) — PR: _

- [ ] 2.1 Make tests default to `LOG_LEVEL=silent` (e.g. `[test] preload` in `bunfig.toml`, or env in each package's test script) while `LOG_LEVEL=debug bun run test` still shows logs. Don't change the runtime default. _Partly done: #186 applied the preload on the CI path, so passing runs are quiet. `scripts/test-setup.ts` assigns `LOG_LEVEL = "silent"` unconditionally, so `LOG_LEVEL=debug` does not yet bring logs back._
- [ ] 2.2 Check that no test asserts on log output in a way that breaks; adjust with an injected logger if one does.
- [ ] 2.3 Add `docs/testing/README.md`: how to run everything, one package, one file, one test (`bun test <file> -t <name>`), how to turn logs on, and where the proof scripts (`scripts/proof/*`) and trajectory evals fit. Link it from `docs/README.md`.

## 3. Session audit script (G7) — PR: _

- [ ] 3.1 Add `scripts/audit/opencode-sessions.ts` (Bun, `bun:sqlite`, `readonly: true`). Flags: `--db` (default `~/.local/share/opencode/opencode.db`), `--since`, `--until`, `--project <dir>`, `--format md|json`. Exclude sessions whose directory starts with `/tmp/`.
- [ ] 3.2 Implement the metrics in [Metric definitions](#metric-definitions-for-the-session-audit-script) below, keeping each as a small named function so it can be unit-tested against a fixture database.
- [ ] 3.3 Add a fixture test that builds a tiny in-memory SQLite database with the OpenCode schema (`session`, `message`, `part`) and asserts each metric.
- [ ] 3.4 Run it for 4–18 Sep 2026 and check that it reproduces the baseline in the [session audit](../../artifacts/session-audit-2026-09.md) within rounding. Note any definitional differences in the script's header comment.
- [ ] 3.5 Document usage in `docs/testing/README.md` (from 2.3) or a short `scripts/audit/README.md`.

## 4. One-edit model addition (G3) — PR: #194

- [x] 4.1 Change case semantics: a missing `allowed_models` means "every default model in the matrix". Keep `allowed_models` only for cases that deliberately restrict (e.g. the `openai/gpt-4o-mini` trajectory case and the two 4-model cases). Update the case schema, `case-loader.ts`, and the schema/validate/end-to-end tests in the same commit. _An explicit list that restates the defaults is now rejected at load time._
- [x] 4.2 Remove the repeated 8-model `allowed_models` arrays from the 46 case files that list the full default set.
- [x] 4.3 Derive `ALLOWED_MODELS` in `.github/workflows/agent-evals.yml` from `evals/model-matrix.json` at run time (e.g. `jq -r '.models[].id'`), keeping the validate-before-secrets ordering described in `docs/agent-evals.md`. Update `workflow-sync.test.ts` to assert the derivation rather than a copied list. _`ALLOWED_TRAJECTORY_MODELS` is derived from the trajectory cases the same way._
- [ ] 4.4 Make `model-matrix.test.ts` assert invariants (unique ids, provider matches the id prefix, at least one default) instead of a hard-coded list. _Still open: the test asserts "exactly the canonical default seven-model matrix"._
- [ ] 4.5 Proof: add one current model chosen by the maintainer (e.g. Sonnet 5 or Fable 5.1 via OpenRouter) with a diff to `evals/model-matrix.json` only. Run one cheap case against it locally. _Partly done: #194 proved the one-file claim with a throwaway `acme/test-model-9` and reverted it. No current model has been added or run._
- [ ] 4.6 Document "Add a model" as a short numbered section at the top of `evals/README.md`. _Partly done: #194 added "Adding a model" to [`docs/agent-evals.md`](../../agent-evals.md); `evals/README.md` does not have it yet._

## 8–15. Outside-in test taxonomy (WS0b) — PRs: #185, #186, #187, #189, #190, #191, #192, #193

Added to #183 on 20 Sep 2026 after a second audit of the suite, and complete. The taxonomy, inventory and the corrections to three findings are in [`docs/testing-strategy.md`](../../testing-strategy.md); the scenario contract is [`tests/README.md`](../../../tests/README.md). Migrating the remaining unit tests into scenarios continues area by area (#195 onwards) and is tracked there, not here.

## 5. Website contract (G4) — PR (weave): _ · PR (website): _

- [ ] 5.1 In this repo, generate JSON Schema from the Zod schemas in `packages/cli/src/evals/report-schema.ts` (public report, suite summary, report bundle, dashboard indexes) and write it with each published bundle (e.g. `schemas/v<N>/*.json` in weave-agent-evals). Add a test that the generated schema matches the committed copy.
- [ ] 5.2 Commit a small, sanitized fixture bundle (one run, two models, two suites) under `packages/cli/src/evals/__fixtures__/` that the report tests validate.
- [ ] 5.3 In `weave-website`: replace the hand-copied types and the four hard-coded `schemaVersion` checks in `src/lib/evals-data.ts` with validation against the published schema, keyed by `schemaVersion`.
- [ ] 5.4 In `weave-website`: when a report or summary has an unknown `schemaVersion`, show the last readable run and a visible "newer results available; site update needed" note, rather than dropping rows.
- [ ] 5.5 In `weave-website`: add a test that loads the same fixture bundle (copied, or fetched in CI) and asserts every model and suite renders.
- [ ] 5.6 Show each run's commit and date on the evals page so stale results are obvious.

## 6. Understandable and diagnosable evals (G5, G6) — PR: _

- [ ] 6.1 Write `docs/evals-overview.md` (one page): the suites, where cases, rubrics and fixtures live, which runner handles which suite, how scoring works, how a run becomes a published bundle and a website page, and the three commands most people need. Link it from `docs/README.md`, `evals/README.md`, and the top of `docs/agent-evals.md`.
- [ ] 6.2 Verify that a single case can be run locally for one model without publishing, and that failure output shows the verdict, the failed rubric criteria, and the path to the raw transcript. Fix the output where it doesn't; document the command in 6.1.
- [ ] 6.3 Audit the nine runners in `packages/cli/src/evals/*-runner.ts`: list the steps each performs and which are shared. Record the result as `docs/artifacts/eval-runner-audit.md` with a recommendation (consolidate or not) for a future spec. No refactor in this group.
- [ ] 6.4 Prune `docs/agent-evals.md` of anything now covered by 6.1 or stale since #182 (the verification feedback loops), keeping it as the detailed reference.

## 7. Fresh baseline (G8) — PR: _

- [ ] 7.1 After groups 4 and 5 land, dispatch a full default-matrix eval run on current `main` (check OpenRouter credits first).
- [ ] 7.2 Confirm the website shows every model from that run with its commit and date.
- [ ] 7.3 Record the per-suite scores as the pre-WS1 baseline in a new artifact, `docs/artifacts/eval-baseline-<date>.md`.

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
