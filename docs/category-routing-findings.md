---
updated: 2026-07-14
contexts: [architecture, evals, routing]
---

# Category Routing Phase 1 Findings

This document records the quantitative results from the Phase 1 prompt-enrichment experiment for category routing (eval suite `tapestry-category-routing`), the acceptance gate outcomes, and the current status.

> **Important correction (2026-07-14):** The 80% pass rate reported here cannot support a Phase 2 decision. Two of the six "failures" were scorer defects, not model failures. The scorer must be fixed and the evals must be rerun before any phase decision can be made. See the scorer fix section below.

---

## Summary

Phase 1 tested whether adding a routing table to the Tapestry prompt (listing each category name, description, and glob patterns) was sufficient to make LLM-based category routing reliable.

- Reported accuracy: 80% (24 of 30 cases pass).
- The routing table produced zero improvement over the baseline prompt.
- Two of the six reported failures were scorer defects (tcr-04 and tcr-10), not model failures.
- The routing table has been removed because it added prompt tokens with zero measured benefit.
- **No Phase 2 decision has been made.** Evals must be rerun with the corrected scorer before deciding.

---

## Baseline vs Enriched Results (uncorrected)

| Model | Baseline pass rate | Enriched pass rate | Delta |
| --- | --- | --- | --- |
| claude-sonnet-4-5 | 80% (24/30) | 80% (24/30) | 0 |
| gpt-4o | 80% (24/30) | 80% (24/30) | 0 |
| gemini-2.0-flash | 80% (24/30) | 80% (24/30) | 0 |

All three models produced identical scores in both runs. The six reported failures are the same six cases in every run. Adding the routing table to the prompt did not change any result.

---

## Scorer Defects in tcr-04 and tcr-10

Two of the six failures were caused by a bug in the scorer, not by model behaviour.

**tcr-04 (no-match):** The task references files that match no category pattern. The expected behavior is to route to the base `shuttle`. The scorer classified a generic `shuttle` response as `generic-shuttle-fallback` and applied a partial-credit score (0.4) instead of a full score (1.0). The model was actually correct; the scorer was wrong.

**tcr-10 (disabled-category):** The task targets a category that has been disabled in config. The expected behavior is to route to the base `shuttle`, not the disabled category shuttle. The scorer applied the same incorrect partial-credit logic. Again, a model that responded with `shuttle` was correct and should have scored 1.0.

The scorer has been fixed. The `scoreRoutingCorrectness` function now returns 1.0 when the expected target is `shuttle` and the model routes to generic `shuttle`, regardless of whether a category shuttle was detected in the response. See `packages/cli/src/evals/tapestry-category-routing-runner.ts`.

**Consequence for reported 80% result:** At most 4 of the 6 failures may reflect genuine model failures. The true corrected pass rate cannot be computed without rerunning the evals. The 80% figure cannot support a Phase 2 decision. Evals must be rerun with the fixed scorer.

---

## Routing Table Removed

The routing table enrichment (auto-appending a Markdown table of category patterns to the Tapestry prompt) has been reverted from `packages/engine/src/compose.ts` and `packages/engine/src/template-context.ts`. Reasons:

1. Zero measured benefit across all three models and all thirty eval cases.
2. Token cost grows linearly with category count (see table below).
3. The two structurally sound failure cases (if any remain after scorer fix) require deterministic enforcement, not additional prompt text.

---

## Token Cost

The removed routing table added tokens proportional to the number of categories declared in config.

| Category count | Approximate routing-table tokens |
| --- | --- |
| 3 | ~172 |
| 10 | ~354 |
| 25 | ~751 |

Growth was approximately linear at roughly 30 tokens per category. At 25 categories the overhead was significant and accuracy was capped at 80% (uncorrected), so the cost was not justified.

---

## Acceptance Gate Assessment (uncorrected results)

| Gate | Threshold | Result | Pass |
| --- | --- | --- | --- |
| Overall accuracy | >=95% | 80% | FAIL |
| Wrong-category cases | 0 | up to 6 | FAIL |
| Per-model accuracy | >=85% | ~80% each | FAIL |

These results are based on the uncorrected scorer. After the scorer fix, tcr-04 and tcr-10 may pass, which would improve the reported rate. The gates must be re-evaluated against a fresh run.

---

## Next Steps

1. Rerun the `tapestry-category-routing` eval suite with the fixed scorer.
2. Evaluate corrected pass rates against the three acceptance gates.
3. If gates still fail, evaluate whether a deterministic category matcher (Phase 2) is warranted.
4. Do not approve or reject Phase 2 based on the 80% uncorrected figure.
