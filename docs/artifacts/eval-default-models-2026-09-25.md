# Eval record: builtin agent default models (24–25 Sep 2026)

> Non-normative artifact. The builtin defaults it supports are in
> [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts), and
> how adapters use them is in [Model Resolution](../model-resolution.md#builtin-default-models).
> Method and noise bands follow the [pre-WS1 baseline](eval-baseline-2026-09-24.md).

**In one paragraph.** Every builtin agent used to declare `claude-sonnet-4-5`. Each candidate default was run on the suite that measures its agent, against Sonnet 4.5 on the same commit, with the same judge and three repeats. GPT 6 Sol clearly beat Sonnet 4.5 on Weft (9/12 against 6/12) and Warp (11/12 against 6/12). Sonnet 5 clearly beat it on Shuttle (8/9 against 3/9). Opus 5.5 matched Sonnet 4.5 on Loom, Tapestry and Pattern, within one attempt per suite: these suites are close to saturated and cannot show a gain. It was chosen for those agents as the stronger model for open-ended orchestration and planning, which the suites do not measure. GPT 6 Luna tied on Spindle (6/6 each) at a fraction of the cost. Thread has no suite of its own, so Haiku 4.5 for Thread is **unmeasured**. The runs cost **$6.80** and no attempt errored.

## Setup

| | |
| --- | --- |
| Commits | `7fc94811` (first 14 units, run ids `7fc9481-2026-09-24-001`), `8b5cb22f` (Shuttle units, run ids `8b5cb22-2026-09-25-001`); both are `main` at `4c794145` plus the model-matrix entries |
| Judge | TypeSafe Jev, `typesafe/jev-1.13` at `typesafe/jev-1.13-20260917`, the same as the baseline |
| Design | `eval run --agent <suite> --model <id> --repeat 3 --track text`, one unit per suite and model, in slot directories |
| Control | `anthropic/claude-sonnet-4.5`, the previous default of every builtin agent |
| Cost | OpenRouter credits before and after: $5.60 for the first 14 units, $1.20 for the two Shuttle units, judge included |

## Results

Attempts passed, out of cases × 3 repeats. The bracket is the 95% Wilson interval.

| Agent | Suite | Candidate model | Candidate score | Sonnet 4.5 score |
| --- | --- | --- | --- | --- |
| Loom | loom-routing | Opus 5.5 | 44/45 98% [88–100] | 44/45 98% [88–100] |
| Tapestry | tapestry-category-routing | Opus 5.5 | 30/30 100% [89–100] | 27/30 90% [74–97] |
| Tapestry | tapestry-execution | Opus 5.5 | 11/12 92% [65–99] | 12/12 100% [76–100] |
| Pattern | pattern-planning | Opus 5.5 | 10/12 83% [55–95] | 10/12 83% [55–95] |
| Shuttle | shuttle-execution | Sonnet 5 | 8/9 89% [56–98] | 3/9 33% [12–65] |
| Weft | weft-review | GPT 6 Sol | 9/12 75% [47–91] | 6/12 50% [25–75] |
| Warp | warp-security | GPT 6 Sol | 11/12 92% [65–99] | 6/12 50% [25–75] |
| Spindle | spindle-tools | GPT 6 Luna | 6/6 100% [61–100] | 6/6 100% [61–100] |
| Thread | — | Haiku 4.5 | no suite | — |

Cases that did not pass 3/3:

| Suite | Case | Candidate | Sonnet 4.5 |
| --- | --- | --- | --- |
| loom-routing | `loom-route-spindle-boundary-internal-exploration` | 2/3 | 3/3 |
| loom-routing | `loom-route-thread-boundary-prehop-then-implement` | 3/3 | 2/3 |
| tapestry-category-routing | `tcr-02-multiple-files` | 3/3 | 1/3 |
| tapestry-category-routing | `tcr-08-misleading-prose` | 3/3 | 2/3 |
| tapestry-execution | `tapestry-rejects-contradicted-report` | 2/3 | 3/3 |
| pattern-planning | `pattern-plan-release-checklist` | 1/3 | 3/3 |
| pattern-planning | `pattern-plan-settings-refactor` | 3/3 | 2/3 |
| pattern-planning | `pattern-plan-verify-by-per-criterion` | 3/3 | 2/3 |
| shuttle-execution | `shuttle-execution-report-structured-evidence` | 3/3 | 2/3 |
| shuttle-execution | `shuttle-execution-report-tests-and-assumptions` | 2/3 | 0/3 |
| shuttle-execution | `shuttle-execution-reports-unverified` | 3/3 | 1/3 |
| weft-review | `weft-review-clean-approval` | 1/3 | 0/3 |
| weft-review | `weft-review-guarded-false-positive` | 2/3 | 0/3 |
| warp-security | `warp-security-guarded-false-positive` | 3/3 | 0/3 |
| warp-security | `warp-security-traced-injection` | 2/3 | 0/3 |

## Reading it

- **The review agents gain the most.** Sonnet 4.5 failed every attempt on two Weft cases and two Warp cases. GPT 6 Sol passed at least one attempt on each of them and passed all three on one. With three repeats the Warp and Shuttle intervals still overlap a little (Warp 65–99 against 25–75, Shuttle 56–98 against 12–65), so treat these as strong signals, not settled margins. The two pairs of cases that went from 0/3 to 2/3 or 3/3 are the clearest evidence.
- **Opus 5.5 is a judgment call, not a measured win.** On Loom, Tapestry and Pattern, Opus 5.5 and Sonnet 4.5 differ by single attempts in both directions. The routing suites are close to saturated, so they can show a regression but not an improvement. Opus 5.5 costs about a third more than Sonnet 4.5 on OpenRouter ($4/$20 against $3/$15 per million tokens).
- **Weft is still the weakest reviewer suite.** `weft-review-clean-approval` passed 1 of 3 on GPT 6 Sol: the model flags a clean change. That is a prompt or case follow-up, not a reason to keep Sonnet 4.5, which passed 0 of 3.
- **Thread is unmeasured.** No suite scores Thread's own exploration; `loom-routing` only checks that Loom sends work to Thread. A thread-exploration suite is a follow-up.
- **Only the text track ran.** The trajectory cases were not re-run on the candidates.

## Bundles

The bundles are local and are not in the repository. They were copied, without `raw/`, to `~/source/weave-worktrees/eval-default-models-2026-09-25/<unit>/` on the maintainer's machine, one directory per unit (`c-<suite>` for a candidate, `s-<suite>` for Sonnet 4.5), with each unit's `run.log`.
