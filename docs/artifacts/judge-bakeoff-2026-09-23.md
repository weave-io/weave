# Jev judge acceptance check, 23 Sep 2026 (Spec 37, task 16.3)

Non-normative artifact. It records whether TypeSafe Jev is accepted as the eval judge for task 16.4 of [Spec 37](../specs/37-spec-repository-foundation/37-tasks-repository-foundation.md) (group 16), measured against pass/fail labels on 20 real agent outputs and 10 constructed negatives. Claude Sonnet 5 scores the same outputs as a reference, not as a contender. No agent response, prompt, transcript or judge rationale is reproduced here; those stay in local files outside the repository (see [Raw output](#raw-output)).

**Outcome: Jev REJECTED.** Jev agreed with the labels on 26 of 30 items (87%, above the 24 required) but correctly failed only 8 of the 12 fail-labelled items (10 required). Sonnet 5, the reference, scored exactly the same. Task 16.4 therefore takes the fallback: a chat-model judge deliberately kept out of the eval matrix, recorded as a known limitation. See [Outcome](#outcome).

## Why

Today every judge call goes to `anthropic/claude-sonnet-4.5`, hard-coded as `JUDGE_MODEL_ID` in [`packages/cli/src/commands/eval.ts`](../../packages/cli/src/commands/eval.ts). Task 16.4 replaces it with Jev if Jev passes this check, and otherwise with a chat model kept out of the matrix. The labels collected here double as the human calibration set for later judge changes.

## Method

The method and the question design were fixed before either judge scored anything, and the negatives were scored with the same questions and thresholds. The acceptance rule changed twice on 23 Sep 2026, both times before any comparison was run: from a head-to-head to an acceptance check (after scoring, before labelling), then to the 30-item rule once the labels showed too few fails (see [7. Acceptance rule](#7-acceptance-rule)).

### 1. Outputs

A fresh local run with `--raw-artifacts` (never published) on the judge-scored cases, for two models from [`evals/model-matrix.json`](../../evals/model-matrix.json):

| Model | Why |
| --- | --- |
| `deepseek/deepseek-v4-flash-0731` | Cheapest default model; expected to produce failures. |
| `openai/gpt-5.6-sol` | A stronger default model at moderate price; expected to produce passes. |

This is the ad hoc development subset the task allows: task 17.1 had not landed when the runs were made. It has since landed (#222) as `deepseek/deepseek-v4-flash-0731` and `openai/gpt-6-luna`, so the DeepSeek half of the items matches it and the other half does not. The bake-off compares judges, not agent models, so the second model only needs to produce a mix of outputs.

The judge-scored cases are the 11 `task_completion` cases without the `judgment` tag (pattern-planning 2, weft-review 2, warp-security 2, spindle-tools 2, shuttle-execution 2, tapestry-execution 1) and the 10 tapestry-category-routing cases. Each ran once per model (42 runs). DeepSeek returned an empty response on 4 of its 21 first-pass runs; those four were re-run once, and `weft-review-clean-approval` stayed empty on three further attempts. That empty response is kept as item B14, as a known-fail anchor. (Since #228 the eval marks such empty answers as errored, not failed; for judging, B14 remains a response every judge should fail.)

### 2. Selection

20 outputs, weighted to weft, warp and pattern, chosen from the eval's own verdicts (not the bake-off judges', which did not exist yet) to mix likely passes and failures and to use both models (11 DeepSeek V4 Flash, 9 GPT-5.6 Sol). Item ids are blind; the model behind each item was withheld from the labelling sheet. The model column below was added after labelling.

| Item | Suite | Case | Model |
| --- | --- | --- | --- |
| B01 | weft-review | weft-review-reject-blocker-citation | DeepSeek V4 Flash |
| B02 | pattern-planning | pattern-plan-release-checklist | GPT-5.6 Sol |
| B03 | warp-security | warp-security-block-evidence-findings | DeepSeek V4 Flash |
| B04 | tapestry-category-routing | tcr-01-exact-match | GPT-5.6 Sol |
| B05 | weft-review | weft-review-clean-approval | GPT-5.6 Sol |
| B06 | pattern-planning | pattern-plan-settings-refactor | DeepSeek V4 Flash |
| B07 | warp-security | warp-security-fast-exit-approve | GPT-5.6 Sol |
| B08 | spindle-tools | spindle-tools-citations-facts-confidence | DeepSeek V4 Flash |
| B09 | weft-review | weft-review-reject-blocker-citation | GPT-5.6 Sol |
| B10 | pattern-planning | pattern-plan-release-checklist | DeepSeek V4 Flash |
| B11 | warp-security | warp-security-fast-exit-approve | DeepSeek V4 Flash |
| B12 | shuttle-execution | shuttle-execution-report-structured-evidence | DeepSeek V4 Flash |
| B13 | tapestry-category-routing | tcr-08-misleading-prose | DeepSeek V4 Flash |
| B14 | weft-review | weft-review-clean-approval | DeepSeek V4 Flash |
| B15 | pattern-planning | pattern-plan-settings-refactor | GPT-5.6 Sol |
| B16 | warp-security | warp-security-block-evidence-findings | GPT-5.6 Sol |
| B17 | spindle-tools | spindle-tools-citations-facts-confidence | GPT-5.6 Sol |
| B18 | tapestry-execution | tapestry-execute-plan-step | DeepSeek V4 Flash |
| B19 | shuttle-execution | shuttle-execution-report-tests-and-assumptions | GPT-5.6 Sol |
| B20 | tapestry-category-routing | tcr-05-cross-category | DeepSeek V4 Flash |

By suite: weft-review 4, warp-security 4, pattern-planning 4, tapestry-category-routing 3, spindle-tools 2, shuttle-execution 2, tapestry-execution 1.

### 2a. Constructed negatives

The labels marked 18 of the 20 real items pass (B10 and B14 fail). With so few fails, the first rule (16 of 20 agreement, at most 2 false passes) could not tell a judge from one that passes everything: that judge would agree on 18 of 20. So, before any comparison was run, 10 negatives were constructed. Each copies a real item's task, rubric, reference, criteria and Sonnet 5 threshold, and changes only the response to plant one defect that the rubric should fail. All ten are labelled fail. `derivedFrom` and `defect` in `negatives.json` record the source and the defect.

| Item | Derived from | Suite | Case | Planted defect |
| --- | --- | --- | --- | --- |
| N01 | B01 | weft-review | weft-review-reject-blocker-citation | Approves despite two real defects, downgrading both file-cited blockers to notes. |
| N02 | B09 | weft-review | weft-review-reject-blocker-citation | Rejects, but no BLOCKER line names a file. |
| N03 | B05 | weft-review | weft-review-clean-approval | Rejects a clean change on a speculative blocker. |
| N04 | B03 | warp-security | warp-security-block-evidence-findings | Approves while tracing two real secret leaks, waving both off. |
| N05 | B07 | warp-security | warp-security-fast-exit-approve | Blocks a docs-only change on a finding the summary rules out. |
| N06 | B02 | pattern-planning | pattern-plan-release-checklist | Replaces real verification commands with an invented command as the sole check. |
| N07 | B06 | pattern-planning | pattern-plan-settings-refactor | Drops every per-task acceptance block while still claiming acceptance coverage. |
| N08 | B19 | shuttle-execution | shuttle-execution-report-tests-and-assumptions | Claims tests, typecheck and build pass when nothing ran. |
| N09 | B17 | spindle-tools | spindle-tools-citations-facts-confidence | Strips the inline citations, sources list and confidence line. |
| N10 | B13 | tapestry-category-routing | tcr-08-misleading-prose | Follows misleading prose to a category the config does not declare. |

With the negatives there are 30 items, 12 of them labelled fail. By suite: weft-review 7, warp-security 6, pattern-planning 6, tapestry-category-routing 4, spindle-tools 3, shuttle-execution 3, tapestry-execution 1.

### 3. What each judge sees

Both judges see the same three texts, built by `buildItem()` in [`scripts/evals/judge-bakeoff.ts`](../../scripts/evals/judge-bakeoff.ts):

- **Rubric**: the case description, the expected outcome (or the expected routing target and accepted alternates), the criteria listed below, and the rubric's reviewer notes.
- **Reference**: the expected outcome with its required signals, or the expected routing target.
- **Response**: the full agent response. A blank response is sent as `(empty response)`.

This differs from production on purpose. In production, the judge of a `task_completion` case sees only a serialised signal summary (`completion signalled; artifacts produced: [...]`), and the rationale dimension sees a structural projection; neither sees the response text. The check asks whether a judge agrees with a reader of the actual output, so both judges get the output.

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

### 5. Sonnet 5 (reference only)

Sonnet 5 (`anthropic/claude-sonnet-5` on OpenRouter) judges through the production `RealLangChainJudge` and its `JUDGE_PROMPT_TEMPLATE` in [`packages/cli/src/evals/langchain-agent-evals.ts`](../../packages/cli/src/evals/langchain-agent-evals.ts), at temperature 0, with only the model id changed. The rubric goes in as `rubricDescription`, the reference as `reference_outputs` and the response as `outputs`. It passes an item when its score reaches the case's existing threshold: `PASS_THRESHOLD` (0.5) for `task_completion` cases and optional category-routing cases, and `QUALITATIVE_PASS_THRESHOLD` (0.7) for required category-routing cases.

### 6. Labels and who gave them

Each item was labelled pass or fail on a blind sheet: suite, case, the task given to the agent, rubric, reference and the full response, with no model id and neither judge's verdict.

- **B02–B20**: labelled by a blind Claude subagent that the maintainer delegated labelling to. It saw only the sheet.
- **B01**: the maintainer's own label (pass); the subagent independently judged it pass too.
- **N01–N10**: fail by construction.

**Caveat:** the stand-in labeller is Claude, the same model family as the Sonnet 5 reference. That may make the labels agree with Sonnet 5 more readily than a human's would. It does not favour Jev, which is the judge under test.

### 7. Acceptance rule

Implemented as `JEV_ACCEPTANCE_RULE` in the harness, which also refuses to accept a partial corpus (fewer than 30 items or 12 fail labels). Fixed on 23 Sep 2026, after the labels were in but before any comparison was run:

**Jev is accepted if its agreement with the labels is at least 80% over all 30 items (24 of 30) and it correctly fails at least 10 of the 12 fail-labelled items (at most 2 false passes).** A judge error counts as a disagreement, and on a fail-labelled item as a fail not caught, but never as a false pass.

Sonnet 5's verdicts are reported alongside as a reference only; they do not affect the outcome. Cohen's kappa, the confusion counts, the per-suite breakdown and the "all criteria" Jev variant are also for information only.

If Jev is rejected, the fallback is a chat-model judge deliberately kept out of the eval matrix, recorded as a known limitation.

Why an acceptance check and not a head-to-head: a chat-model judge could never later be added to the eval matrix without grading its own output, whereas Jev can never be an evaluated model.

Withdrawn rules, in order: (1) adopt Jev if its agreement is at least Sonnet 5's, otherwise Sonnet 5; (2) accept Jev if it agrees on at least 16 of the 20 real items and wrongly passes at most 2. Rule 2 became vacuous once 18 of the 20 labels came back pass.

## Reproducing

```bash
# 1. Build items.json and the blind labels.md from local raw artifacts.
bun scripts/evals/judge-bakeoff.ts collect --selection <selection.json> --out-dir <dir>
# 2. Score with both judges (needs OPENROUTER_API_KEY). Items already in
#    verdicts.json are kept, not re-scored, so adding negatives later leaves
#    the first verdicts as they were.
bun scripts/evals/judge-bakeoff.ts score --items <dir>/items.json \
  --negatives <dir>/negatives.json --out <dir>/verdicts.json
# 3. After labelling, compare.
bun scripts/evals/judge-bakeoff.ts compare --items <dir>/items.json \
  --negatives <dir>/negatives.json --verdicts <dir>/verdicts.json \
  --labels <dir>/labels.md --out <dir>/comparison.md
```

`selection.json` is a list of `{ "id": "B01", "raw": "<path to raw/case-*.json>" }`. `collect` refuses to overwrite an existing `labels.md` without `--force`.

## Cost

About $0.78 of OpenRouter credit in total: about $0.72 for the 42 eval runs (with the current Sonnet 4.5 judge scoring them) and both judges over the 20 real items, and about $0.05 for both judges over the 10 negatives. Jev's share was $0.0018.

## Labels

| Item | Label | Labeller |
| --- | --- | --- |
| B01 | pass | maintainer |
| B02–B09 | pass | Claude subagent |
| B10 | fail | Claude subagent: a meta-plan with self-referential acceptance and no real release verification |
| B11–B13 | pass | Claude subagent |
| B14 | fail | Claude subagent: empty response |
| B15–B20 | pass | Claude subagent |
| N01–N10 | fail | constructed |

## Results

Output of `compare` (verdicts scored before the comparison; B01–B20 on the first scoring pass, N01–N10 afterwards with the same questions and thresholds).

### Jev acceptance

**Jev: REJECTED.**

| Condition | Required | Jev | Result |
| --- | --- | --- | --- |
| Corpus | at least 30 items, 12 labelled fail | 30 items, 12 labelled fail | met |
| Agrees with the labels | at least 24/30 | 26/30 | met |
| Fails caught (Jev fail, human fail) | at least 10/12 | 8/12 | not met |
| False passes (Jev pass, human fail) | — | 4 | — |
| False fails (Jev fail, human pass) | — | 0 | — |
| Judge errors (count as disagreements) | — | 0 | — |

Sonnet 5, for reference only: 26/30 agree, 8/12 fails caught, 4 false passes, 0 false fails.

### Agreement with the labels

| Judge | Agreement | Cohen's κ | Both pass | Both fail | Judge pass, label fail | Judge fail, label pass | Judge errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Jev (overall noul) | 26/30 (87%) | 0.71 | 18 | 8 | 4 | 0 | 0 |
| Jev (all criteria, informational) | 25/30 (83%) | 0.64 | 17 | 8 | 4 | 1 | 0 |
| Sonnet 5 (reference) | 26/30 (87%) | 0.71 | 18 | 8 | 4 | 0 | 0 |

### Per suite

| Suite | Items | Jev agrees | Sonnet 5 agrees (reference) |
| --- | --- | --- | --- |
| pattern-planning | 6 | 3 | 3 |
| shuttle-execution | 3 | 3 | 3 |
| spindle-tools | 3 | 3 | 3 |
| tapestry-category-routing | 4 | 4 | 4 |
| tapestry-execution | 1 | 1 | 1 |
| warp-security | 6 | 6 | 6 |
| weft-review | 7 | 6 | 6 |

### Per item

| Item | Source | Suite | Case | Label | Jev (overall noul) | Sonnet 5 (score vs threshold, reference) |
| --- | --- | --- | --- | --- | --- | --- |
| B01 | real | weft-review | weft-review-reject-blocker-citation | pass | pass (0.94) | pass (1.00 vs 0.5) |
| B02 | real | pattern-planning | pattern-plan-release-checklist | pass | pass (0.90) | pass (1.00 vs 0.5) |
| B03 | real | warp-security | warp-security-block-evidence-findings | pass | pass (0.90) | pass (1.00 vs 0.5) |
| B04 | real | tapestry-category-routing | tcr-01-exact-match | pass | pass (0.97) | pass (1.00 vs 0.7) |
| B05 | real | weft-review | weft-review-clean-approval | pass | pass (0.96) | pass (1.00 vs 0.5) |
| B06 | real | pattern-planning | pattern-plan-settings-refactor | pass | pass (0.94) | pass (1.00 vs 0.5) |
| B07 | real | warp-security | warp-security-fast-exit-approve | pass | pass (0.72) | pass (1.00 vs 0.5) |
| B08 | real | spindle-tools | spindle-tools-citations-facts-confidence | pass | pass (0.93) | pass (1.00 vs 0.5) |
| B09 | real | weft-review | weft-review-reject-blocker-citation | pass | pass (0.95) | pass (1.00 vs 0.5) |
| B10 | real | pattern-planning | pattern-plan-release-checklist | fail | pass (0.65) | pass (1.00 vs 0.5) |
| B11 | real | warp-security | warp-security-fast-exit-approve | pass | pass (0.92) | pass (1.00 vs 0.5) |
| B12 | real | shuttle-execution | shuttle-execution-report-structured-evidence | pass | pass (0.58) | pass (0.97 vs 0.5) |
| B13 | real | tapestry-category-routing | tcr-08-misleading-prose | pass | pass (0.95) | pass (1.00 vs 0.7) |
| B14 | real | weft-review | weft-review-clean-approval | fail | fail (0.01) | fail (0.00 vs 0.5) |
| B15 | real | pattern-planning | pattern-plan-settings-refactor | pass | pass (0.92) | pass (1.00 vs 0.5) |
| B16 | real | warp-security | warp-security-block-evidence-findings | pass | pass (0.89) | pass (1.00 vs 0.5) |
| B17 | real | spindle-tools | spindle-tools-citations-facts-confidence | pass | pass (0.83) | pass (1.00 vs 0.5) |
| B18 | real | tapestry-execution | tapestry-execute-plan-step | pass | pass (0.76) | pass (1.00 vs 0.5) |
| B19 | real | shuttle-execution | shuttle-execution-report-tests-and-assumptions | pass | pass (0.72) | pass (0.97 vs 0.5) |
| B20 | real | tapestry-category-routing | tcr-05-cross-category | pass | pass (0.94) | pass (1.00 vs 0.5) |
| N01 | negative of B01 | weft-review | weft-review-reject-blocker-citation | fail | fail (0.03) | fail (0.00 vs 0.5) |
| N02 | negative of B09 | weft-review | weft-review-reject-blocker-citation | fail | pass (0.85) | pass (0.75 vs 0.5) |
| N03 | negative of B05 | weft-review | weft-review-clean-approval | fail | fail (0.03) | fail (0.20 vs 0.5) |
| N04 | negative of B03 | warp-security | warp-security-block-evidence-findings | fail | fail (0.02) | fail (0.15 vs 0.5) |
| N05 | negative of B07 | warp-security | warp-security-fast-exit-approve | fail | fail (0.02) | fail (0.25 vs 0.5) |
| N06 | negative of B02 | pattern-planning | pattern-plan-release-checklist | fail | pass (0.89) | pass (1.00 vs 0.5) |
| N07 | negative of B06 | pattern-planning | pattern-plan-settings-refactor | fail | pass (0.64) | pass (0.72 vs 0.5) |
| N08 | negative of B19 | shuttle-execution | shuttle-execution-report-tests-and-assumptions | fail | fail (0.02) | fail (0.20 vs 0.5) |
| N09 | negative of B17 | spindle-tools | spindle-tools-citations-facts-confidence | fail | fail (0.12) | fail (0.25 vs 0.5) |
| N10 | negative of B13 | tapestry-category-routing | tcr-08-misleading-prose | fail | fail (0.01) | fail (0.00 vs 0.7) |

## Outcome

**Jev is REJECTED** under the rule fixed before comparing. It clears the agreement bar (26/30 against 24 required) but catches only 8 of the 12 fails (10 required).

- **Where both judges miss:** the four false passes are the same for Jev and Sonnet 5. Three are pattern-planning (B10, a real fail; N06, an invented verification command; N07, dropped per-task acceptance), so pattern-planning agreement is 3 of 6 for both. The fourth is weft-review N02, a rejection whose blockers name no file. Both judges caught every warp-security, shuttle, spindle and category-routing fail.
- **No judge errors, no false fails:** neither judge failed an item the labels passed. B12, B18 and B19 passed with Jev's `overall` between 0.58 and 0.76, closer to the threshold than most passes.

**Decision for 16.4:** Jev is rejected under the original rubrics, so the recorded decision is the fallback: a chat-model judge deliberately kept out of the eval matrix. Task 16.4 must record that as a known limitation in `docs/agent-evals.md`; this PR does not change that file. Sonnet 5, the chat-model reference here, has the same four blind spots, so the fallback does not by itself close them.

**Planned follow-up (not done in this PR):** Jev and Sonnet 5 missed the same four items, so the misses trace to rubrics that do not state those checks; 16.4 makes them explicit and re-runs this identical check once before choosing the judge. The checks in question are the pattern-planning ones (no invented verification commands, acceptance criteria per task) and weft-review's file-located blockers. Until that re-run is recorded here, the outcome above stands.

## Raw output

The items, the negatives, the labelling sheet, the raw eval artifacts and both judges' verdicts (including Sonnet 5's free-text rationales) are kept on the maintainer's machine, outside the repository. They contain agent output and must never be committed or published; see [Eval sanitization and publish pipeline](../eval-sanitization-and-publish-pipeline.md).
