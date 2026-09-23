# Judge bake-off, 23 Sep 2026 (Spec 37, task 16.3)

Non-normative artifact. It records how the eval judge is chosen for task 16.4 of [Spec 37](../specs/37-spec-repository-foundation/37-tasks-repository-foundation.md) (group 16): TypeSafe Jev or Claude Sonnet 5, measured against human pass/fail labels on the same agent outputs. No agent response, prompt, transcript or judge rationale is reproduced here; those stay in local files outside the repository (see [Raw output](#raw-output)).

**Status: waiting on maintainer labels.** The outputs are collected and both judges have scored them. The labels, the results and the decision below are placeholders until the maintainer labels the 20 items.

## Why

Today every judge call goes to `anthropic/claude-sonnet-4.5`, hard-coded as `JUDGE_MODEL_ID` in [`packages/cli/src/commands/eval.ts`](../../packages/cli/src/commands/eval.ts). Task 16.4 replaces it with the winner of this bake-off. The labels collected here double as the human calibration set for later judge changes.

## Method

The method, the question design and the decision rule were fixed before either judge scored anything.

### 1. Outputs

A fresh local run with `--raw-artifacts` (never published) on the judge-scored cases, for two models from [`evals/model-matrix.json`](../../evals/model-matrix.json):

| Model | Why |
| --- | --- |
| `deepseek/deepseek-v4-flash-0731` | Cheapest default model; expected to produce failures. |
| `openai/gpt-5.6-sol` | A stronger default model at moderate price; expected to produce passes. |

This is the ad hoc development subset the task allows: task 17.1 had not landed when the runs were made. It has since landed (#222) as `deepseek/deepseek-v4-flash-0731` and `openai/gpt-6-luna`, so the DeepSeek half of the items matches it and the other half does not. The bake-off compares judges, not agent models, so the second model only needs to produce a mix of outputs.

The judge-scored cases are the 11 `task_completion` cases without the `judgment` tag (pattern-planning 2, weft-review 2, warp-security 2, spindle-tools 2, shuttle-execution 2, tapestry-execution 1) and the 10 tapestry-category-routing cases. Each ran once per model (42 runs). DeepSeek returned an empty response on 4 of its 21 first-pass runs; those four were re-run once, and `weft-review-clean-approval` stayed empty on three further attempts. That empty response is kept as item B14, as a known-fail anchor.

### 2. Selection

20 outputs, weighted to weft, warp and pattern, chosen from the eval's own verdicts (not the bake-off judges', which did not exist yet) to mix likely passes and failures and to split the two models evenly. Item ids are blind; the model behind each item is withheld from the labelling sheet and from this file until labelling is done.

| Item | Suite | Case |
| --- | --- | --- |
| B01 | weft-review | weft-review-reject-blocker-citation |
| B02 | pattern-planning | pattern-plan-release-checklist |
| B03 | warp-security | warp-security-block-evidence-findings |
| B04 | tapestry-category-routing | tcr-01-exact-match |
| B05 | weft-review | weft-review-clean-approval |
| B06 | pattern-planning | pattern-plan-settings-refactor |
| B07 | warp-security | warp-security-fast-exit-approve |
| B08 | spindle-tools | spindle-tools-citations-facts-confidence |
| B09 | weft-review | weft-review-reject-blocker-citation |
| B10 | pattern-planning | pattern-plan-release-checklist |
| B11 | warp-security | warp-security-fast-exit-approve |
| B12 | shuttle-execution | shuttle-execution-report-structured-evidence |
| B13 | tapestry-category-routing | tcr-08-misleading-prose |
| B14 | weft-review | weft-review-clean-approval |
| B15 | pattern-planning | pattern-plan-settings-refactor |
| B16 | warp-security | warp-security-block-evidence-findings |
| B17 | spindle-tools | spindle-tools-citations-facts-confidence |
| B18 | tapestry-execution | tapestry-execute-plan-step |
| B19 | shuttle-execution | shuttle-execution-report-tests-and-assumptions |
| B20 | tapestry-category-routing | tcr-05-cross-category |

By suite: weft-review 4, warp-security 4, pattern-planning 4, tapestry-category-routing 3, spindle-tools 2, shuttle-execution 2, tapestry-execution 1.

### 3. What each judge sees

Both judges see the same three texts, built by `buildItem()` in [`scripts/evals/judge-bakeoff.ts`](../../scripts/evals/judge-bakeoff.ts):

- **Rubric**: the case description, the expected outcome (or the expected routing target and accepted alternates), the criteria listed below, and the rubric's reviewer notes.
- **Reference**: the expected outcome with its required signals, or the expected routing target.
- **Response**: the full agent response. A blank response is sent as `(empty response)`.

This differs from production on purpose. In production, the judge of a `task_completion` case sees only a serialised signal summary (`completion signalled; artifacts produced: [...]`), and the rationale dimension sees a structural projection; neither sees the response text. The bake-off asks which judge agrees with a human reading the actual output, so both judges get the output.

### 4. Jev questions

Jev (`typesafe/jev-1.13`, `POST https://openrouter.ai/api/alpha/decisions`) takes the three texts as its `state` and answers typed questions:

| Question | Type | Used for |
| --- | --- | --- |
| One per criterion | `noul` | Diagnostics, and the secondary "all criteria" row. |
| `overall`: "Would a careful reviewer applying the rubric accept the agent response as passing this case?" | `noul` | **The verdict: pass when `overall` ≥ 0.5.** |
| `quality`: how well the response meets the rubric, anchored 0 "fails the case" … 3 "fully meets the case" | `score` | Recorded for 16.4; not used here. |

The criteria are:

- For a `task_completion` case, one yes/no question per required signal (`required_artifacts`), restating in plain words what the deterministic runner checks. `SIGNAL_QUESTIONS` in the harness holds the wording. A case with no required signals (tapestry-execute-plan-step) gets one question: does the response achieve the expected outcome?
- For a category-routing case: does the response make a clear routing decision to the expected target or an accepted alternate, and does it justify the choice consistently with the rubric and reviewer notes?

A state longer than 100,000 characters is refused rather than truncated; Jev's context is 32k tokens. The longest state in this set is well under that (the longest response is about 11,000 characters).

### 5. Sonnet 5

Sonnet 5 (`anthropic/claude-sonnet-5` on OpenRouter) judges through the production `RealLangChainJudge` and its `JUDGE_PROMPT_TEMPLATE` in [`packages/cli/src/evals/langchain-agent-evals.ts`](../../packages/cli/src/evals/langchain-agent-evals.ts), at temperature 0, with only the model id changed. The rubric goes in as `rubricDescription`, the reference as `reference_outputs` and the response as `outputs`. It passes an item when its score reaches the case's existing threshold: `PASS_THRESHOLD` (0.5) for `task_completion` cases and optional category-routing cases, and `QUALITATIVE_PASS_THRESHOLD` (0.7) for required category-routing cases.

### 6. Human labels

The maintainer labels each item pass or fail on a blind sheet: suite, case, the task given to the agent, rubric, reference and the full response, with no model id and neither judge's verdict.

### 7. Decision rule

Agreement is the share of the 20 items on which a judge's verdict matches the human label; a judge error counts as a disagreement. **Adopt Jev if its agreement with the human labels is at least Sonnet 5's; otherwise adopt Sonnet 5.** Cohen's kappa, the confusion counts, the per-suite breakdown and the "all criteria" Jev variant are reported alongside, but do not change the decision.

## Reproducing

```bash
# 1. Build items.json and the blind labels.md from local raw artifacts.
bun scripts/evals/judge-bakeoff.ts collect --selection <selection.json> --out-dir <dir>
# 2. Score with both judges (needs OPENROUTER_API_KEY).
bun scripts/evals/judge-bakeoff.ts score --items <dir>/items.json --out <dir>/verdicts.json
# 3. After labelling, compare.
bun scripts/evals/judge-bakeoff.ts compare --items <dir>/items.json \
  --verdicts <dir>/verdicts.json --labels <dir>/labels.md --out <dir>/comparison.md
```

`selection.json` is a list of `{ "id": "B01", "raw": "<path to raw/case-*.json>" }`. `collect` refuses to overwrite an existing `labels.md` without `--force`.

## Cost

About $0.68 of OpenRouter credit in total: the 42 eval runs (with the current Sonnet 4.5 judge scoring them) and both bake-off judges over 20 items. Jev's share was $0.0012.

## Labels

_Placeholder: filled from `labels.md` once the maintainer has labelled every item._

| Item | Model | Human label | Note |
| --- | --- | --- | --- |
| B01–B20 | _pending_ | _pending_ | |

## Results

_Placeholder: the output of `compare` (agreement, confusion counts, kappa, per suite, per item)._

## Decision

_Placeholder: Jev or Sonnet 5, by the rule above._

## Raw output

The items, the labelling sheet, the raw eval artifacts and both judges' verdicts (including Sonnet 5's free-text rationales) are kept on the maintainer's machine, outside the repository. They contain agent output and must never be committed or published; see [Eval sanitization and publish pipeline](../eval-sanitization-and-publish-pipeline.md).
