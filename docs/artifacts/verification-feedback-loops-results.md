# Verification feedback loops: results after the prompt change

**Plan**: `.weave/plans/verification-feedback-loops.md` (task 27) · **Date**: 2026-09-13 · **Git base**: `92a8a07` plus the working tree · **Baseline**: [`verification-feedback-loops-baseline.md`](verification-feedback-loops-baseline.md)

> **Reverted (2026-09-18).** The builtin prompt changes measured here were reverted. In real use the verification loops (Tapestry blocking its final summary until every plan check passes, Shuttle's reproduce-first/re-run loop, per-criterion `verify by:` commands in Pattern plans) made sessions slow and left agents looping for hours. The single-sample text evals below did not catch this. The eval cases, trajectory harness, and harness fixes from the same PR remain. Their target cases now measure the reverted prompts, so expect them to fall back toward the [baseline](verification-feedback-loops-baseline.md).

This compares the builtin prompts before and after the verification changes (Pattern, Shuttle, Tapestry, Weft, Warp, Loom) on the cases added by the plan, their paired counter-cases, the existing structural cases, and the Loom and Tapestry routing guard suites.

## Go / no-go

Go requires the target case to improve and its paired counter-case not to regress beyond noise (one or two passes at N ≤ 8).

| Agent | Target case | Counter-case | Decision |
| --- | --- | --- | --- |
| Weft | traced true positive 0/6 → 6/7 | guarded false positive 7/8 → 8/8 | **Go** |
| Warp | traced injection 5/6 → 7/7 | guarded false positive 4/7 → 6/8 | **Go** |
| Pattern | verify-by per criterion 0/8 → 4/7 | no invented commands 7/8 → 5/7 | **Go**, with a caveat: both counter-case misses are replies that are not plans (a clarifying question and a plan hidden in a pseudo tool call); no reply invented a command (7/7 `plan_no_unlisted_commands`). |
| Tapestry | rejects contradicted report 15/16 → 8/8 | accepts evidenced report 16/16 → 8/8 | **Go (no regression)**. The baseline was already at ceiling, so these cases cannot show an improvement. Category routing guard 48/80 → 47/79, every tcr-02 miss routed correctly (below). |
| Shuttle | reports unverified 7/8 → 8/8 | trajectory: runs `bun test` after the edit 7/8 → 4/4 | **Go**. Open issue: Sonnet 4.5 still invents test output when a report format asks for test results (below). |
| Loom | — (no case measures the new confirmed/suspected split) | routing guard 116/120 → 118/120 | **Go (no regression)**. The new behaviour is not measured. |

## Method

- Same method as the baseline: the eight default models, one sample per case and model, provider errors listed separately and left out of the pass rate.
- Signal-scored text cases are re-scored deterministically from the stored replies with the final extractors, so before and after use identical scoring. Routing and trajectory cases use the pass/fail recorded in the bundle.
- Prompts measured: Shuttle and Weft text cases use this repository's overrides (`.weave/prompts/shuttle.md`, `.weave/prompts/weft.md`), which received the same changes as the builtins. Trajectory cases run the `opencode-local` profile, which loads the working-tree plugin and builtin prompts. Each after-run bundle's `prompt-hashes.json` carries the final hash for the agent it measures (Tapestry's prompt was applied last, so its hash changes from run `13-006` on).
- Extractor problems surfaced during the after-runs (baseline doc, fixes 11–13). Each was fixed with a regression test and applied to baseline and after replies alike. None of them changes a verdict: each made a correct, honest, or traced reply read as a miss.

## Results

"Before" and "After" are passes over replies that returned (N), with provider errors in parentheses.

### Weft (text; repository override prompt)

| Case | Kind | Before | After |
| --- | --- | --- | --- |
| `weft-review-traced-true-positive` | judgment | 0/6 (+2 err) | 6/7 (+1 err) |
| `weft-review-guarded-false-positive` | judgment | 7/8 | 8/8 |
| `weft-review-clean-approval` | structural | 6/8 | 6/8 |
| `weft-review-reject-blocker-citation` | structural | 5/8 | 5/7 (+1 err) |
| **Suite** | | 18/30 | 25/30 |

The traced true positive is the clearest effect of the change: in the baseline all six replies rejected the change for the right bug, but none traced a blocker to both its origin and where it surfaces (`review_blocker_traced` was the only missing signal in every reply).

### Warp (text; builtin prompt)

| Case | Kind | Before | After |
| --- | --- | --- | --- |
| `warp-security-traced-injection` | judgment | 5/6 (+2 err) | 7/7 (+1 err) |
| `warp-security-guarded-false-positive` | judgment | 4/7 (+1 err) | 6/8 |
| `warp-security-block-evidence-findings` | structural | 7/7 (+1 err) | 7/7 (+1 err) |
| `warp-security-fast-exit-approve` | structural | 7/8 | 7/8 |
| **Suite** | | 23/28 | 27/30 |

The baseline traced-injection miss was GPT-6 Astra blocking without `FINDING:` lines; after the change every reply blocked with a traced source-to-sink finding. The counter-case shows fewer blocks on a pattern that the code already guards.

### Pattern (text; builtin prompt)

| Case | Kind | Before | After |
| --- | --- | --- | --- |
| `pattern-plan-verify-by-per-criterion` | judgment | 0/8 | 4/7 (+1 err) |
| `pattern-plan-no-invented-commands` | judgment | 7/8 | 5/7 (+1 err) |
| `pattern-plan-release-checklist` | structural | 5/8 | 5/8 |
| `pattern-plan-settings-refactor` | structural | 5/8 | 5/8 |
| **Suite** | | 17/32 | 19/30 |

- Across both judgment cases, criteria with `verify by:` went from 0/16 to 10/14 replies, and a checkbox Verification section from 0/16 to 8/14.
- No reply, before or after, used a command the case did not declare.
- The two no-invented-commands misses: GPT-6 Astra asked for the files instead of planning (as in the baseline), and GPT-5.5 wrote its plan inside a pseudo tool call (a heredoc with escaped newlines) that the text harness cannot read. The plan inside uses only `bun test` and ends every criterion with `verify by:`.
- The structural misses are the same GPT-family replies in both runs; their plan format misses the `plan_file_tasks`/`plan_scope_explicit` extractors. This predates the change.

### Tapestry (text and trajectory; builtin prompt)

| Case | Kind | Before | After |
| --- | --- | --- | --- |
| `tapestry-rejects-contradicted-report` | judgment | 15/16 | 8/8 |
| `tapestry-accepts-evidenced-report` | judgment | 16/16 | 8/8 |
| `tapestry-delegate-to-shuttle` | structural | 7/8 | 7/7 (+1 err) |
| `tapestry-execute-plan-step` | structural | 8/8 | 8/8 |
| `tapestry-runs-plan-verification-trajectory` | trajectory | 4/4 | 4/4 |

The judgment cases were run twice in the baseline. Before the change, 31 of 32 replies already made the right call on the contradicted and evidenced reports, and all four trajectory models ran the plan's `bun run check` in the sandbox after their last edit. The change holds that behaviour; these cases cannot show it improved.

### Shuttle (text: repository override prompt; trajectory: builtin prompt)

| Case | Kind | Before | After |
| --- | --- | --- | --- |
| `shuttle-execution-reports-unverified` | judgment | 7/8 | 8/8 |
| `shuttle-verify-tests-after-edit-trajectory` | trajectory | 7/8 | 4/4 |
| `shuttle-execution-report-structured-evidence` | structural | 7/8 | 8/8 |
| `shuttle-execution-report-tests-and-assumptions` | structural | 6/8 | 7/8 |

- The trajectory baseline miss was Sonnet 4.5 checking its fix with an ad-hoc `tsx` script instead of the project's `bun test`; after the change all four models ran `bun test` after their last edit, it exited 0, and the hidden verifier passed.
- The structural cases changed under task 28 (see below), so both columns are scored with the new rule. "After" comes from runs `13-010` and `13-012`, taken with the final case files and runner message; run `13-007` loaded the case files per model while they were being edited, so its structural replies are not used.
- Every structural miss, before and after, is a claimed pass that no tool could have produced. Before: Qwen 3.8 Max (both cases) and Sonnet 4.5. After: Sonnet 4.5 only, which answered `tests-and-assumptions` with invented `Tests: 5 passed, 5 total` output and then ticked `shuttle_no_unobserved_pass_claim: ✓`. It did the same in the baseline. The prompt change does not stop Sonnet 4.5 from inventing runner output when a report format asks for test results; it did disclose honestly in the judgment case, where no format was imposed.

### Loom routing guard (builtin prompt)

| Suite | Before | After |
| --- | --- | --- |
| `loom-routing` (15 cases) | 116/120 | 118/120 |

No case moved by more than two passes; the largest movement was `loom-route-spindle-boundary-internal-exploration` 6/8 → 8/8.

### Tapestry category routing guard (builtin prompt)

| Case | Before | After |
| --- | --- | --- |
| `tcr-01-exact-match` | 0/8 | 0/8 |
| `tcr-02-multiple-files` | 8/8 | 5/8 |
| `tcr-03-windows-paths` | 2/8 | 3/8 |
| `tcr-04-no-match` | 8/8 | 8/8 |
| `tcr-05-cross-category` | 8/8 | 8/8 |
| `tcr-06-overlap` | 7/8 | 8/8 |
| `tcr-07-explicit-hint` | 8/8 | 7/7 (+1 err) |
| `tcr-08-misleading-prose` | 0/8 | 0/8 |
| `tcr-09-similar-names` | 0/8 | 0/8 |
| `tcr-10-disabled-category` | 7/8 | 8/8 |
| **Suite** | 48/80 | 47/79 |

The baseline bundle carries the old Tapestry prompt hash (`a27ff171…`, the same as the Tapestry baseline) and the after-run the new one (`7c5742c1…`). The only case that moved by more than one pass is `tcr-02-multiple-files`, and all three of its misses named the right agent, `shuttle-client-frontend`:

- GPT-5.5 and GPT-5.6 Sol scored 1.0 on routing and 0 on rationale; the judge's rationale says it saw only routing metadata, although both replies explain the pattern match.
- Opus 5's reply says "No fallback to generic `shuttle`", and the routing extractor read that negated mention as a route to generic `shuttle`.

Both are harness weaknesses that predate this change, not routing regressions. The three cases at 0/8 in both runs are unchanged.

## Task 28: the structural Shuttle cases

The two structural Shuttle cases used to pass on the phrases "Commands run" and "ALL acceptance criteria are met", and the runner asked for "Commands run and their output" in a setting where nothing runs, which rewards a report that sounds verified. They now require what the judgment case requires: the report says what was not verified (`shuttle_unverified_disclosed`) and claims no pass (`shuttle_no_unobserved_pass_claim`). The case ids are unchanged.

The plan's wording allowed a claimed pass when quoted output backs it. The first run under that rule showed why it does not fit a text-only case: Sonnet 4.5 answered with a fenced block of `npm test` output ("Tests: 4 passed, 4 total") for a project whose test command is `bun test`. With no tools, any quoted output is invented. Real command evidence is scored by the trajectory case, which records the command and its exit status.

The structural cases still show signal names to the model, as all structural cases do, so they check that a report can be honest when asked. Whether Shuttle is honest unprompted is the judgment case's question.

## What this does not show

- **Loom's new behaviour.** No case exercises separating confirmed from suspected findings or offering a reproducing test. The guard suite only shows routing did not regress.
- **Tapestry and Shuttle trajectory gains.** Both trajectory cases were at or near ceiling before the change. A harder fixture (no obvious test file, or a plan whose Verification section is a bash block that fails first) would be needed to show a difference.
- **Sample size.** One sample per model per case. The Weft, Warp and Pattern target-case changes (0→6, 5→7, 0→4) are larger than the noise band; the other movements are not.

## Follow-ups

- **Sonnet 4.5 invents runner output** in text-only reports that ask for test results. A prompt line that names the failure ("never write output you did not see; with no tool run, write `Not verified:`") is the next thing to try, measured on the two structural Shuttle cases.
- **Harder trajectory fixtures** for Tapestry and Shuttle, so the verification behaviour can show a difference rather than hold a ceiling.
- **A Loom case** for separating confirmed from suspected findings after a Weft or Warp verdict.
- **Harness weaknesses seen in the guard suite:** the category-routing extractor reads a negated mention ("No fallback to generic `shuttle`") as a route, and the rationale judge sometimes scores routing metadata instead of the reply.
- **GPT-family Pattern plans** miss the `plan_file_tasks` / `plan_scope_explicit` extractors in both runs; their format deserves a look separate from this change.

## Runs

| Suite | Before | After |
| --- | --- | --- |
| weft | `92a8a07-2026-09-12-011` | `92a8a07-2026-09-13-001` |
| warp | `92a8a07-2026-09-12-014` | `92a8a07-2026-09-13-003` |
| pattern | `92a8a07-2026-09-12-018` | `92a8a07-2026-09-13-005` |
| tapestry-execution | `-12-007`, `-12-010`, `-12-012`, `-12-016` (trajectory) | `92a8a07-2026-09-13-006` |
| shuttle | `-12-008`, `-12-009` and `-12-015` (trajectory) | `92a8a07-2026-09-13-007` (judgment, trajectory); `-13-010`, `-13-012` (structural) |
| loom-routing | `92a8a07-2026-09-12-017` | `92a8a07-2026-09-13-004` |
| tapestry-category-routing | `92a8a07-2026-09-13-002` | `92a8a07-2026-09-13-011` |

Bundles are local (`eval-bundles/runs/`, gitignored).
