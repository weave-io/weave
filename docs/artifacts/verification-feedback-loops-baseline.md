# Verification feedback loops: baseline on current prompts

**Plan**: `.weave/plans/verification-feedback-loops.md` (tasks 6 and 18) · **Date**: 2026-09-12 · **Git base**: `92a8a07`

This records how today's prompts score on the new verification cases, before any prompt change. The "after" numbers go in `verification-feedback-loops-results.md`.

## Method

- **Prompts measured.** Evals run from the repository root compose prompts through `loadConfig()`, so Shuttle and Weft are measured with this repository's overrides (`.weave/prompts/shuttle.md`, `.weave/prompts/weft.md`). Pattern, Tapestry, and Warp use the builtin prompts. Each run bundle's `prompt-hashes.json` records the exact hashes.
- **Models.** The eight default models in `evals/model-matrix.json`, one sample per case and model. With N=8 per case, a difference of one or two passes is within noise.
- **Judge.** `anthropic/claude-sonnet-4.5` scores `executionCompleteness` by comparing the signals the runner detects with the case's required signals. Pass/fail follows the existing rule: the primary dimension scores at least 0.95.
- **Errors are not failures.** A provider error (for example OpenRouter returning an empty response) is listed in the "Errors" column and left out of the pass rate.
- **Judgment cases** (tag `judgment`) withhold the verdict from the model: the runner omits the required signal names and the completion cues. See `evals/README.md`.

## Harness fixes made while taking the baseline

Taking the baseline exposed problems in the eval harness itself, several of which would have made the prompt change look better or worse than it is. All were fixed, with regression tests, before the numbers below were recorded.

**Text-only track**

1. **The judge crashed on code in case text.** The LangChain judge template treats `{` and `}` as variables, so any case containing code failed with `Single '}' in template.` Rubric text is now brace-escaped (`escapeTemplateBraces`).
2. **Plans were truncated.** The client default of 2048 output tokens, shared with reasoning tokens, cut plans off mid-task (Opus 5 stopped at `**Acceptance**:\n    -`). The Pattern runner now asks for 8192 (`PATTERN_PLAN_MAX_TOKENS`).
3. **Snippets without imports invited off-topic rejections.** Sonnet 4.5 rejected the first Weft false-positive draft for "missing imports". Added files now appear in full; changed files are labelled as excerpts.
4. **The traced-finding detector was both too strict and too loose.** It missed `` `path` (line N) ``, required *every* finding to be traced (penalising correct single-location findings such as "no auth on this route"), and counted string literals such as `"settings.json"` as code locations. It now reads prose line references, requires at least one traced finding, and ignores bare names with neither a directory nor a line.
5. **The LLM judge fuzzily compared signal names.** For `task_completion` cases the judge compares two lists of signal names. It accepted `review_blockers_cited` in place of a missing `review_blocker_traced` in one run and rejected the same situation in the next. Judgment cases now score `executionCompleteness` deterministically (`buildJudgmentExecutionDimension`); other cases keep the judge.
6. **Tapestry's right answer read as a contradiction.** The runner reported "completion signalled" whenever Tapestry reached a decision, so a correct re-delegation read to the judge as "marked complete", and all eight models failed `tapestry-rejects-contradicted-report`. It now means "marked complete".
7. **Talk about re-delegation counted as re-delegating.** "No re-delegation", "no gap … so re-delegation would add no information", and a `Task 1/1:` heading all matched. The detector now needs a verb form or a bracketed `Task [1/1]:` envelope, and treats "no" as a negation.

**Trajectory track**

8. **Delegation prompts could pass for commands.** The observer recorded the `task` tool's `command` argument (the delegation prompt). Command detail is now limited to `bash`.
9. **Plan bookkeeping counted as the last edit.** Every model ran `bun run check` after its code change, but Tapestry then ticked the plan's checkboxes, so "after the last edit" failed. Edits under `.weave/` no longer count, file paths are recorded for file tools, and `apply_patch` (GPT-5.5's edit tool) now counts as an edit.
10. **Runs idled for up to eight minutes.** An uncleared `max_duration_seconds` timer kept each trajectory process alive after its last session. The timer is now cleared when the run settles.

**Found while taking the after-runs** (applied to baseline and after replies alike)

11. **Warp's bracketed verdict was not read.** The Warp prompt asks for `[BLOCK]` or `[APPROVE]`, but the verdict regex only accepted a bare word, so a reply following the prompt exactly scored "verdict missing". Bracketed and bold verdicts now count; `BLOCKERS: 0/3` still does not.
12. **Warp field lines had to be flush and single-line.** Numbered findings (`1. SEVERITY: Critical`, GPT-5.6 and GPT-6 Astra) lost the severity and format signals, and a source/sink trace written as bullets under a bare `EVIDENCE:` label (Sonnet 4.5) read as untraced. Field lines now accept a list marker, and the trace is read from the whole evidence block up to the next field label.
13. **Shuttle's honest reports read as pass claims.** Three after-run replies that said "Not verified" were scored as claiming a pass: "run `bun test` to confirm the new test passes" (DeepSeek), "requires running `bun test` to confirm … tests pass" (Opus 4.5), and ✓ marks on acceptance criteria (Sonnet 4.5). "0 passed, 0 failed … no tests were executed" (Opus 5) hit the `0 fail` pattern. So did "No unobserved file mutations, commands, test passes, or tool activity are asserted" (GPT-5.6 Sol), whose "No" sat just outside the negation window. A pass claim now ignores purpose and modal context ("to confirm", "should"), a line that opens with "No" up to the next sentence break, a bare ✓, and `0 fail` right after `0 passed`. Invented runner output (`12 pass`, `Tests: 4 passed`) still counts. Separately, the acceptance-section detector now reads a `# Acceptance confirmation` heading at any level and `- **Acceptance** (restated):`.

Signal-scored text cases (every `task_completion` case with required signals, judgment or not) are re-scored deterministically from the stored replies with the final extractors, so baseline and after-numbers use identical scoring. Routing and trajectory cases use the pass/fail recorded in the run bundle.

## Results

The baseline numbers are the "Before" columns in [`verification-feedback-loops-results.md`](verification-feedback-loops-results.md), next to the after-numbers and scored with the same extractors. Baseline runs:

| Suite | Runs |
| --- | --- |
| weft | `92a8a07-2026-09-12-011` |
| warp | `92a8a07-2026-09-12-014` |
| pattern | `92a8a07-2026-09-12-018` |
| tapestry-execution | `92a8a07-2026-09-12-007`, `-010`, `-012` (text); `-016` (trajectory) |
| shuttle | `92a8a07-2026-09-12-008` (text); `-009`, `-015` (trajectory) |
| loom-routing | `92a8a07-2026-09-12-017` |
| tapestry-category-routing | `92a8a07-2026-09-13-002` (old Tapestry prompt hash `a27ff171…`) |

Headline gaps on the old prompts: no Weft reply traced a blocker to both its origin and where it surfaces (0/6), no Pattern plan said how each criterion is verified (0/16 replies across both cases), and Tapestry and the trajectory cases were already at or near ceiling.
