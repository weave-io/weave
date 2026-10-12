# Eval record: Claude-first builtin default models (12 Oct 2026)

> Non-normative artifact. The builtin defaults it supports are in
> [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts), and
> how adapters use them is in [Model Resolution](../model-resolution.md#builtin-default-models).
> It follows the [25 Sep](eval-default-models-2026-09-25.md) and
> [29 Sep](eval-copilot-default-models-2026-09-29.md) records. Tracking issue: #314.

**In one paragraph.** Every builtin agent now names a Claude model first. Weft and Warp move from GPT 6 Sol to Opus 5.5, Spindle from GPT 6 Luna to Sonnet 5.5, and Thread from Haiku 4.5 to Haiku 5.5, released on 7 Oct 2026. Loom, Tapestry and Pattern stay on Opus 5.5, and Shuttle on Sonnet 5.5. Each change ran against the model it replaces with `weave eval compare-models`, on suites of 12 or more text cases, five repeats, builtin prompts only, and the same pinned judge. All four clear the steps of Spec 39's [publication bar](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md#publication-bar) a comparison can check. Haiku 5.5 is the only significant gain: 65/65 against 52/65 on Thread's new suite, at a quarter of the cost. Opus 5.5 scored 60/60 on both reviewer suites. Sonnet 5.5 cleared Spindle's per-case guard only after a one-line prompt fix. The comparisons cost about **$6.90**, judge included, and no attempt errored.

## What changed since the September records

The September picks were measured on suites of 2–4 cases with this repository's own prompt overrides for Shuttle and Weft. Since then:

- every suite has 12 or more text cases (Spec 39 G3), and Thread has its own, `thread-exploration`, with 13 (#317);
- eval runs compose the builtin prompts only, unless asked otherwise (G1, #281);
- `weave eval compare-models` compares two models with Fisher's exact test, Holm adjustment and a per-case guard (G2, #284);
- Haiku 5.5 is in the eval matrix and the catalog fixtures (#315).

## Setup

| | |
| --- | --- |
| Commits | `9c3fbb1` (Weft, Warp, Shuttle), `a71554f` (Spindle; the branch commit of #318, squashed as `93e2290e`), `6fba175` (Thread, and the fixed Shuttle case) |
| Judge | TypeSafe Jev, `typesafe/jev-1.13-20260917`, as in every earlier record |
| Design | `eval run --agent <suite> --model <id> --track text --repeat 5`, one unit per suite and model in its own slot directory, then `eval compare-models <current run> <candidate run> --current <id> --candidate <id>` |
| Config mode | `builtin` for every run |
| Cost | $6.89 summed from the score files' per-attempt usage, judge included; a few cents more on diagnostic re-runs with `--raw-artifacts` |

## Results

Attempts passed, out of cases × 5 repeats. The bracket is the 95% Wilson interval. Cost is the model calls per attempt as OpenRouter reported it; judge calls cost about $0.0001 per attempt for every model.

| Agent | Suite (cases) | Current | Candidate | Fisher, Holm-adjusted | Per-case guard | Cost per attempt |
| --- | --- | --- | --- | --- | --- | --- |
| Weft | weft-review (12) | GPT 6 Sol 58/60 97% [89–99] | **Opus 5.5 60/60** 100% [94–100] | p = 0.496 | passed | $0.0036 → $0.0245 |
| Warp | warp-security (12) | GPT 6 Sol 56/60 93% [84–97] | **Opus 5.5 60/60** 100% [94–100] | p = 0.119 | passed | $0.0049 → $0.0350 |
| Spindle | spindle-tools (12), before #318 | GPT 6 Luna 56/60 93% [84–97] | Sonnet 5.5 56/60 93% [84–97] | p = 1.000 | **failed** on `answers-the-question-asked`, 4/5 → 1/5 | $0.00025 → $0.0108 |
| Spindle | spindle-tools (12), after #318 | GPT 6 Luna 60/60 100% [94–100] | **Sonnet 5.5 59/60** 98% [91–100] | p = 1.000 | passed | $0.00025 → $0.0107 |
| Thread | thread-exploration (13) | Haiku 4.5 52/65 80% [69–88] | **Haiku 5.5 65/65** 100% [94–100] | **p < 0.001, significantly better** | passed | $0.0036 → $0.0008 |
| Shuttle | shuttle-execution (12), re-score | — | Sonnet 5.5 55/60, then 5/5 on the fixed case | — | — | $0.0156 |

Cases that did not pass 5/5:

| Suite | Case | Current | Candidate |
| --- | --- | --- | --- |
| weft-review | `weft-review-clean-approval` | Sol 3/5 | Opus 5.5 5/5 |
| warp-security | `warp-security-cors-origin-pattern` | Sol 1/5 | Opus 5.5 5/5 |
| spindle-tools, before #318 | `spindle-tools-answers-the-question-asked` | Luna 4/5 | Sonnet 5.5 1/5 |
| spindle-tools, after #318 | `spindle-tools-citations-facts-confidence` | Luna 5/5 | Sonnet 5.5 4/5 |
| thread-exploration | `thread-exploration-separates-found-from-inferred` | Haiku 4.5 0/5 | Haiku 5.5 5/5 |
| thread-exploration | `thread-exploration-says-not-found` | Haiku 4.5 2/5 | Haiku 5.5 5/5 |
| thread-exploration | `thread-exploration-does-not-edit-when-asked-to-fix` | Haiku 4.5 3/5 | Haiku 5.5 5/5 |
| thread-exploration | `thread-exploration-exact-paths-and-lines` | Haiku 4.5 3/5 | Haiku 5.5 5/5 |
| thread-exploration | `thread-exploration-finds-usages-through-alias` | Haiku 4.5 4/5 | Haiku 5.5 5/5 |
| shuttle-execution | `shuttle-execution-refuses-secret-request`, before #316 | — | Sonnet 5.5 0/5 |

## Reading it

- **Weft and Warp: Opus 5.5 is not significantly better, but it is never worse.** Both suites are near the top for Sol too, so neither can show a significant gain at this size. Opus passed every attempt, including the two cases Sol fails most: approving a clean change, and judging a CORS origin pattern. Review is where a weak model costs the most, and the 25 Sep five-repeat run pointed the same way (Opus 19/20 and 20/20, Sol 18/20 and 20/20). The cost is about 7× Sol per attempt; a review is one call per change.
- **Spindle needed a prompt fix before Sonnet 5.5 could pass.** The first run failed the per-case guard on a real behaviour, not a case defect. Asked only whether `client.list()` paginates, Sonnet restated the authentication and webhook excerpts in `Source facts` before calling them irrelevant, which the rubric fails. #318 changed one line of `spindle.md`: `Source facts` holds the cited claims that answer the question, and a source that does not bear on it is listed under `Sources` only. After it, Sonnet passed that case 5/5 and the suite 59/60. Luna went from 56/60 to 60/60 on the same change, so the prompt helped both models. Sonnet is not significantly better than Luna, and it costs about 43× more per attempt ($0.011 against $0.00025). It was chosen because the maintainer prefers Claude models first and it clears the bar, not because it scored higher. Luna stays as Spindle's OpenAI fallback. Haiku 5.5 also cleared the bar on the fixed prompt (57/60, 3× Luna's cost) and is the cheaper Claude option if Spindle's cost matters.
- **Thread: the one significant gain.** Haiku 4.5 failed every attempt at separating what it found from what it inferred, and missed "not found" answers and exact line references. Haiku 5.5 passed all 65 attempts at about a quarter of Haiku 4.5's cost per attempt. Thread keeps Haiku 4.5 after 5.5 in its list, for a Copilot host that does not offer 5.5 yet.
- **Shuttle: one case was broken.** `shuttle-execution-refuses-secret-request` asked for an edit as a file's full new contents but showed only one section of the README. Sonnet 5.5 refused to overwrite a file it had not seen, drafted the row, and failed. #316 shows the whole README; Sonnet then passed it 5/5. With that case fixed, Sonnet 5.5's re-score on the shipped prompt is 60/60 by case, which closes the G1 re-score of Shuttle.
- **Loom, Tapestry and Pattern were not re-run.** They keep Opus 5.5, chosen on 25 Sep; their suites are near saturated and cannot show a gain.

## What a comparison does not check

Publication bar steps 5–8 are outside `compare-models`: the trajectory cases on the candidates (real sessions), `weave models check --expect` against the catalog fixtures (run with this change), and a published run on tryweave.io. These runs are local, like every earlier default-model record. The tryweave.io model lists must be re-issued after this change: a list issued before the new `BUILTIN_MODELS_ISSUED` is rejected.

## Bundles

The bundles are local and are not in the repository. They are in the slot directories `eval-bundles/slots/defaults-1012/` (`wf-*`, `wp-*`, `sp-*`, `sh-son55`, and `diag-*` for the `--raw-artifacts` re-runs) and `eval-bundles/slots/defaults-1012b/` (`th-*`, `sh-secret`) of the `fleet/havent-done-release-awhile-latest-models` worktree, and for Spindle after #318 in `eval-bundles/slots/spindle/{luna,son,hai}/` of the `spindle-prompt-on-question` worktree, on the maintainer's machine. Each slot has its `run.log`.
