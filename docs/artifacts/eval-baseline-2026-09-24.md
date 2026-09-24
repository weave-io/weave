# Eval baseline, 24 Sep 2026 (Spec 37, tasks 7.2–7.4)

Non-normative artifact. It records the pre-WS1 eval baseline on `main` for [Spec 37](../specs/37-spec-repository-foundation/37-tasks-repository-foundation.md) group 7, including the per-case flip rates that task 19.1 asked for. Later runs are compared against it with `eval compare` (see [How to compare against this baseline](#how-to-compare-against-this-baseline)). Nothing here was published to `weave-io/weave-agent-evals` and the GitHub workflow was not dispatched. No prompt, agent answer, transcript or judge rationale is reproduced; only case ids, counts, rates, scores and timings.

**In one paragraph.** Every phase completed with **zero errored attempts and zero infrastructure failures**. The finish-line command's workload, `eval run --models dev --repeat 3` over the text track (276 attempts), passed 85% [80–89%] and cost **$0.18**; run back to back it takes about **1 h 40 min**. 16 of the 92 case × model pairs (17%) flipped verdict across the three repeats. All five dev-runnable trajectory cases passed on DeepSeek V4 Flash (5 min, $0.04). The full default matrix, once over the text track (368 attempts), passed 89% and cost **$6.92**. The weakest suites are `pattern-planning` and `weft-review`. In each, one case fails on every model with the same deterministic score, which looks like a case or scoring defect rather than model behaviour (see [Suspected defects](#suspected-defects-listed-not-fixed)).

## Setup

| | |
| --- | --- |
| Commit | `d4d1bf171983ec5f1235b4c37009b3ec51a4b080` (`main` after #241, which replaced the delisted Qwen id; run ids `d4d1bf1-2026-09-24-001`) |
| Judge | TypeSafe Jev, `typesafe/jev-1.13` at `typesafe/jev-1.13-20260917` (recorded in every bundle). Runs from before #235 used another judge and are not comparable. |
| Dev subset | `deepseek/deepseek-v4-flash-0731`, `openai/gpt-6-luna` |
| Default matrix | `anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4.5`, `openai/gpt-5.5`, `anthropic/claude-opus-5`, `openai/gpt-5.6-sol`, `qwen/qwen3.8-max-0902`, `deepseek/deepseek-v4-flash-0731`, `openai/gpt-6-astra` |
| Cases | 46 text cases in 8 suites (loom-routing 15, tapestry-category-routing 10, pattern-planning 4, tapestry-execution 4, warp-security 4, weft-review 4, shuttle-execution 3, spindle-tools 2); 6 trajectory cases, 5 of which the dev subset may run |
| Prompts | Text cases compose prompts from the working directory's config, so this repository's `.weave/` overrides (the Weft and Shuttle prompt files, and the categories) are part of what was measured |
| Date | 24 Sep 2026, 18:17–19:21 UTC |
| Cost source | OpenRouter `GET /api/v1/credits`, read before and after each phase. Model calls and judge calls share the key, so the costs below include the judge. |

### How the runs were split

The runs used a shared machine with 7 GB of RAM, where a single tool call is limited to 10 minutes. A single `eval run --models dev --repeat 3` runs its cases one after another and would take well over that. So each phase ran as several `eval run` processes in parallel, each process in its own slot directory with the repository's `.weave/` linked in, because run ids come from scanning `eval-bundles/runs/`. Each process is one **unit**, and each unit writes its own bundle. The units add up exactly to the single command's cases, models and repeats. Two consequences follow:

- The **wall-clock** times below are for the parallel units. The **sequential** figure (the sum of the unit times) is the estimate for the single command run as written.
- `eval compare` compares bundles with the same design, so a later run is compared **unit by unit** (same `--agent`, `--model`/`--models`, `--repeat`), not as one bundle. See [How to compare](#how-to-compare-against-this-baseline).

## Commands

All run from the repository root (or a slot directory inside it), with `LOG_LEVEL=warn`.

```bash
# Phase 1 — dev subset, text track, three repeats (10 units)
bun packages/cli/src/main.ts eval run --agent <suite> --models dev --repeat 3 --track text
#   for pattern-planning, shuttle-execution, spindle-tools, tapestry-execution, warp-security, weft-review
bun packages/cli/src/main.ts eval run --agent <suite> --model <dev-model> --repeat 3 --track text
#   for loom-routing and tapestry-category-routing, once per dev model

# Phase 2 — dev subset, trajectory track, once (one unit: the single command)
TMPDIR=~/.cache/weave-trajectory-tmp \
  bun packages/cli/src/main.ts eval run --models dev --track trajectory --repeat 1

# Phase 3 — full default matrix, text track, once (64 units: 8 suites × 8 models)
bun packages/cli/src/main.ts eval run --agent <suite> --model <default-model> --track text --repeat 1
```

## Time, cost and errors

| Phase | Attempts | Errored | Wall clock (parallel) | Sequential (sum of units) | Cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. Dev subset, text, `--repeat 3` | 276 | 0 | 23 min (10 units) | 1 h 42 min | $0.18 |
| 2. Dev subset, trajectory, `--repeat 1` | 5 | 0 | 5 min 5 s (1 unit) | 5 min 5 s | $0.04 |
| 3. Default matrix, text, `--repeat 1` | 368 | 0 | 23 min (64 units, 16 at a time) | 1 h 55 min | $6.92 |
| **Total** | | **0** | **≈ 55 min** | | **$7.14** |

The totals include a $0.004 timing probe, three trajectory sessions that were re-run because their first launch lacked `--agent` (see [Trajectory outcomes](#phase-2-trajectory-outcomes)), and two single-case diagnosis runs. The whole session stayed well inside its $25 budget. Phase 3 by model pair, as measured: GPT 6 Astra + Claude Opus 5 $3.28, Claude Opus 4.5 + GPT-5.5 $2.11, Claude Sonnet 4.5 + GPT-5.6 Sol $0.98, Qwen3.8 Max + DeepSeek V4 Flash $0.55.

Slowest units: the judge-scored suites with long answers on the dev subset (pattern-planning 23 min, warp-security 23 min, weft-review 17 min and shuttle-execution 15 min, each for 18–24 attempts). In phase 3, `weft-review` on DeepSeek V4 Flash took 12.5 min for 4 cases, which is provider latency. On the dev subset a loom-routing or category-routing attempt takes about 4–7 s, and a judged attempt 40–60 s.

## Phase 1: dev subset pass rates (`--repeat 3`)

Pass rate = passed / (passed + failed). No attempt errored, so no attempt is left out. The bracket is the 95% Wilson interval: the noise band a later run at the same design has to leave before `eval compare` can call a change.

| Suite | DeepSeek V4 Flash | GPT 6 Luna | Both (pooled) |
| --- | --- | --- | --- |
| loom-routing | 45/45 100% [92–100] | 34/45 76% [61–86] | 79/90 88% [79–93] |
| tapestry-category-routing | 28/30 93% [79–98] | 30/30 100% [89–100] | 58/60 97% [89–99] |
| tapestry-execution | 11/12 92% [65–99] | 12/12 100% [76–100] | 23/24 96% [80–99] |
| warp-security | 11/12 92% [65–99] | 12/12 100% [76–100] | 23/24 96% [80–99] |
| spindle-tools | 5/6 83% [44–97] | 5/6 83% [44–97] | 10/12 83% [55–95] |
| weft-review | 9/12 75% [47–91] | 11/12 92% [65–99] | 20/24 83% [64–93] |
| shuttle-execution | 6/9 67% [35–88] | 6/9 67% [35–88] | 12/18 67% [44–84] |
| pattern-planning | 7/12 58% [32–81] | 3/12 25% [9–53] | 10/24 42% [24–61] |
| **All suites** | 122/138 88% [82–93] | 113/138 82% [75–87] | 235/276 85% [80–89] |

The intervals are wide. With 4 cases × 3 repeats (12 attempts) per model, only a swing of roughly 40 points or more is detectable on the small suites. That is the input task 19.2 (deferred) needs to set case counts.

### Per-case flip rates

A case **flips** on a model when its three verdicts are not all the same. **16 of 92 case × model pairs flipped (17%)**: 9 of 46 on DeepSeek V4 Flash and 7 of 46 on GPT 6 Luna. Every other pair was 3/3 or 0/3.

| Suite | Case | Model | Passed |
| --- | --- | --- | --- |
| loom-routing | `loom-route-backend-api` | GPT 6 Luna | 2/3 |
| loom-routing | `loom-route-frontend-ui` | GPT 6 Luna | 1/3 |
| loom-routing | `loom-route-shuttle-implement-utility` | GPT 6 Luna | 1/3 |
| loom-routing | `loom-route-thread-boundary-prehop-then-implement` | GPT 6 Luna | 2/3 |
| loom-routing | `loom-route-warp-boundary-downstream-audit` | GPT 6 Luna | 1/3 |
| pattern-planning | `pattern-plan-release-checklist` | DeepSeek V4 Flash | 1/3 |
| shuttle-execution | `shuttle-execution-report-structured-evidence` | DeepSeek V4 Flash | 2/3 |
| shuttle-execution | `shuttle-execution-report-tests-and-assumptions` | DeepSeek V4 Flash | 2/3 |
| shuttle-execution | `shuttle-execution-reports-unverified` | DeepSeek V4 Flash | 2/3 |
| spindle-tools | `spindle-tools-citations-facts-confidence` | DeepSeek V4 Flash | 2/3 |
| spindle-tools | `spindle-tools-citations-facts-confidence` | GPT 6 Luna | 2/3 |
| tapestry-category-routing | `tcr-04-no-match` | DeepSeek V4 Flash | 2/3 |
| tapestry-category-routing | `tcr-07-explicit-hint` | DeepSeek V4 Flash | 2/3 |
| tapestry-execution | `tapestry-rejects-contradicted-report` | DeepSeek V4 Flash | 2/3 |
| warp-security | `warp-security-guarded-false-positive` | DeepSeek V4 Flash | 2/3 |
| weft-review | `weft-review-traced-true-positive` | GPT 6 Luna | 2/3 |

Pairs that failed on all three repeats (consistent, not noisy): `pattern-plan-verify-by-per-criterion` on both models, `pattern-plan-release-checklist` and `pattern-plan-settings-refactor` on Luna, `shuttle-execution-reports-unverified` on Luna, `loom-route-weft-boundary-downstream-review` on Luna, and `weft-review-traced-true-positive` on DeepSeek.

## Phase 2: trajectory outcomes

The dev subset may run 5 of the 6 trajectory cases, all on DeepSeek V4 Flash. GPT 6 Luna is in none of their `allowed_models`, and `loom-route-shuttle-implement-utility-trajectory` runs only on `openai/gpt-4o-mini`. Each case ran once, so **their noise is not measured**. The trajectory cases on the other default models they allow (Sonnet 4.5, Opus 5, GPT-5.5) were not part of this baseline's plan and were not run.

| Case | Suite | Verdict | Observed spawns | Tool calls |
| --- | --- | --- | --- | ---: |
| `loom-delegates-backend-fix-to-category-trajectory` | loom-routing | PASS | `shuttle-backend` | 16 |
| `loom-runs-the-failing-check-itself-trajectory` | loom-routing | PASS (see defect 3) | none | 11 |
| `tapestry-dispatches-independent-tasks-in-parallel-trajectory` | tapestry-execution | PASS | `shuttle`, `shuttle` | 30 |
| `tapestry-runs-plan-verification-trajectory` | tapestry-execution | PASS | `shuttle` | 19 |
| `shuttle-verify-tests-after-edit-trajectory` | shuttle-execution | PASS | `shuttle` | 12 |

Every session completed without a harness error. Three of the cases (`loom-delegates-backend-fix-to-category-trajectory`, `loom-runs-the-failing-check-itself-trajectory` and `shuttle-verify-tests-after-edit-trajectory`) were also run once more as single-case units (`--agent <suite> --case <id>`), and each gave the same verdict. Their very first launch named `--case` without `--agent`. That runs the case filter against every suite, so the other suites failed with "not in the fixture allowlist" and the run exited 1. Those bundles were discarded and the units re-run with `--agent`. The runner behaved as specified, so this is not an eval defect, but always pair `--case` with `--agent`.

## Phase 3: full default matrix (`--repeat 1`)

One attempt per case × model, so each cell is a single sample with no noise estimate. Read it as a snapshot, not a ranking.

| Suite | Opus 4.5 | Opus 5 | Sonnet 4.5 | DeepSeek V4 Flash | GPT-5.5 | GPT-5.6 Sol | GPT 6 Astra | Qwen3.8 Max | All |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| loom-routing | 13/15 | 14/15 | 15/15 | 15/15 | 15/15 | 15/15 | 15/15 | 15/15 | 117/120 (98%) |
| tapestry-category-routing | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 80/80 (100%) |
| tapestry-execution | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 3/4 | 3/4 | 4/4 | 30/32 (94%) |
| spindle-tools | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 | 2/2 | 2/2 | 15/16 (94%) |
| warp-security | 3/4 | 4/4 | 2/4 | 4/4 | 4/4 | 3/4 | 3/4 | 4/4 | 27/32 (84%) |
| shuttle-execution | 1/3 | 2/3 | 2/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 | 19/24 (79%) |
| weft-review | 3/4 | 3/4 | 1/4 | 3/4 | 3/4 | 3/4 | 2/4 | 3/4 | 21/32 (66%) |
| pattern-planning | 2/4 | 3/4 | 3/4 | 3/4 | 1/4 | 3/4 | 2/4 | 3/4 | 20/32 (63%) |
| **All suites** | 38/46 (83%) | 42/46 (91%) | 39/46 (85%) | 43/46 (93%) | 42/46 (91%) | 41/46 (89%) | 40/46 (87%) | 44/46 (96%) | 329/368 (89%) |

Cases that failed on three or more models: `pattern-plan-verify-by-per-criterion` (8 of 8), `weft-review-traced-true-positive` (8 of 8) and `warp-security-traced-injection` (3 of 8: Sonnet 4.5, GPT-5.6 Sol, GPT 6 Astra). Every other failure was on one or two models.

## What the baseline says

- **The finish-line command works.** `eval run --models dev --repeat 3` on the text track produced no errored attempt and no infrastructure failure. It costs about $0.18 and takes about 1 h 40 min run as one process, or about 25 min split by suite. The trajectory track on the dev subset adds 5 min and $0.04.
- **Weakest suites:** `pattern-planning` (42% dev, 63% full matrix) and `weft-review` (83% dev, 66% full matrix), then `shuttle-execution` (67% dev, 79% full). In the first two, part of the weakness is one case that no model passes (below).
- **Strong or saturated suites:** `tapestry-category-routing` (97% dev, 100% full), `loom-routing` on every model except GPT 6 Luna (98% full), `tapestry-execution` and `warp-security` (96% dev). A saturated suite cannot show an improvement, only a regression.
- **Noisiest cases:** the GPT 6 Luna loom-routing cases (5 of 15 flip, and `loom-route-weft-boundary-downstream-review` fails 0/3) and DeepSeek V4 Flash's shuttle-execution reports (all 3 cases at 2/3). `spindle-tools-citations-facts-confidence` flips on both dev models.
- **The dev subset is harder than the full matrix on Pattern.** GPT 6 Luna passes 3 of 12 Pattern attempts, and its loom-routing flips account for most of the dev-subset noise. DeepSeek V4 Flash is in both runs: 88% over 138 attempts in phase 1 and 43/46 (93%) in phase 3, which agree.

### Suspected defects (listed, not fixed)

1. **`weft-review-traced-true-positive` fails on every model with an identical score.** All 8 default models score executionCompleteness exactly 0.80 (4 of the 5 required signals), with judge rationale 0.96–0.99. The missing signal is always `review_blocker_traced`. A local diagnosis on GPT 6 Luna shows why: `isTracedFinding` (`packages/cli/src/evals/judgment-cases.ts`) needs **two file locations on one BLOCKER line**. The models name the call site's file and the fallible function by name (`saveSettings`), not by its file. The case text asks for "the discarding call site and the fallible function it calls", which such a blocker meets, and as a `judgment` case the signal name is withheld from the model. This looks like a detector stricter than the case, not model behaviour. It is also the deterministic backstop the [overview](../evals-overview.md#the-judge-jev) names for Jev's blind spot on BLOCKER lines without files, so fixing it needs care.
2. **`pattern-plan-verify-by-per-criterion` cannot pass against the current Pattern prompt.** 7 of 8 default models score executionCompleteness exactly 0.60, missing `plan_criteria_have_verify_by` and `plan_verification_checkboxes`. The composed Pattern prompt does not ask for a "verify by" clause per criterion. It also says to use `- [ ]` **only** for top-level plan tasks and describes `## Verification` as commands. The case requires the opposite. The case was added in #170 alongside a planned Pattern prompt change that is not in the composed prompt. So this is a case–prompt mismatch, either a WS1 prompt gap or a case to re-align, and it is not a difference between models.
3. **A passing trajectory case is labelled failed.** `loom-runs-the-failing-check-itself-trajectory` is recorded `passed: true` (executionCompleteness 1.0 gates the pass) but `scoreBucket: "fail"`, weighted total 0.33, and the explanation "required harness-trajectory case failed". The routing and delegation dimensions score 0 because, by design, Loom does not delegate here. The stdout report prints `PASS` next to "Weighted total 0.33 (pass mark 0.50)". The verdict is right, but the bucket and explanation contradict it, and so would any dashboard that reads them.
4. **To diagnose (behaviour or extraction?):** `loom-route-weft-boundary-downstream-review` fails 0/3 on GPT 6 Luna and passes on every other model. #240 fixed one route-extraction false negative, so a single-case diagnosis should confirm this is Luna's routing before a prompt change targets it.

## How to compare against this baseline

The bundles are local and are not in the repository. They were copied, without `raw/`, to `~/source/weave-worktrees/eval-baseline-2026-09-24/` on the maintainer's machine, laid out as `<phase>/<unit>/d4d1bf1-2026-09-24-001/` (phases `p1`, `p2`, `p3`), with each unit's `run.log`, the unit timings (`timings.log`) and the credit readings (`credits.log`). `eval compare` reads only these bundles, so it needs them and makes no model call.

To test a change against phase 1, re-run the **same unit** on the candidate commit with the same filters and `--repeat 3`, then compare the two bundle directories:

```bash
# Candidate for one unit, e.g. weft-review on the dev subset
bun packages/cli/src/main.ts eval run --agent weft-review --models dev --repeat 3 --track text
#    → Eval run <sha>-<date>-NNN

bun packages/cli/src/main.ts eval compare \
  ~/source/weave-worktrees/eval-baseline-2026-09-24/p1/weft-review/d4d1bf1-2026-09-24-001 \
  eval-bundles/runs/<candidate-run-id>
```

- loom-routing and tapestry-category-routing were baselined **per dev model** (`--model <id>`), so their candidates must be too. A candidate made with `--models dev` over those suites is refused with `ModelSetMismatch`.
- A single-bundle candidate from the full `--models dev --repeat 3` command does not match any one unit. Split the candidate the same way, or record a new single-bundle baseline when the command can run in one process.
- Phase 3 used `--repeat 1`, and one attempt a side can never show a change. Use it as a per-model snapshot, not as a comparison base.
- `eval compare` refuses a run scored by a different judge. A judge change means a new baseline ([Changing the judge](../agent-evals.md#the-judge)).

To reproduce the whole baseline, check out `d4d1bf17`, check the OpenRouter credits, and run the commands in [Commands](#commands). For trajectory runs, use Podman and the `weave-sandbox-opencode-default` image, which was built on 12 Sep 2026 and used as is. Expect about $7 and, with suites run in parallel, about an hour.
