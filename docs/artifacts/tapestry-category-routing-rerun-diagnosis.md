# `tapestry-category-routing` 0% Rerun Diagnosis

Non-normative artifact. Evidence-only; no raw prompt/transcript text, provider
responses, or secrets are reproduced here (see redaction note at the end).

**Revision note:** this revision corrects two errors from the prior draft:
(1) it had wrongly attributed the `tcr-04`/`tcr-10` scoring behavior to commit
`268b2bfe` (an unrelated Loom/Tapestry prompt-composition fix); (2) it had
wrongly concluded the missing case-level `explanation` was an intentional,
universal redaction, when it is in fact isolated to this one suite. Both
corrections are evidenced below.

## 1. Published run identity and full run history

Fetched via `gh api repos/weave-io/weave-agent-evals/contents/<path>` (external
results repo, **not** `weave-io/weave`).

| Field | Value |
| --- | --- |
| `runId` | `0eea530-2026-09-01-001` |
| `gitSha` | `0eea530efb38f39c709db977ea43d9d03f9f3f1b` |
| `assembledAt` | `2026-09-01T20:13:56.305Z` |
| `dryRun` | `false` |
| `dashboard-manifest.json` `totalRuns` | `1` |

`dashboard-manifest.json`, `suite-history-tapestry-category-routing.json`, and
`scenario-history-tapestry-category-routing.json` each list **only the single
latest run** — these index files are overwritten/rolled forward on every
publish, they are not a full run history. `totalRuns: 1` therefore does **not**
mean only one run has ever been published.

**Full run history exists and was inspected.** `gh api --paginate
repos/weave-io/weave-agent-evals/commits` (213 commits fetched) shows every
`chore: publish eval bundle runs/v1/<runId>/*` commit back to the suite's
introduction. Runs containing a `tapestry-category-routing` suite, oldest to
newest:

| `runId` | `gitSha` | commit date | `tapestry-category-routing` totalCases/passed/failed |
| --- | --- | --- | --- |
| `07481c0-2026-07-14-001` | `07481c040c8999b4ecaca72be83332a1ee19f7c2` | 2026-07-14 | 30 / **0** / 30 |
| `e2f642e-2026-08-31-001` | `e2f642ee21d667291ac01d07fca996001cb12fcf` | 2026-08-31 | 30 / **0** / 30 |
| `4a40e83-2026-09-01-001` | `4a40e838cdc7d90038fb0895f4eca213b901f2aa` | 2026-09-01 05:47Z | 50 / **0** / 50 |
| `0eea530-2026-09-01-001` | `0eea530efb38f39c709db977ea43d9d03f9f3f1b` | 2026-09-01 20:13Z | 70 / **0** / 70 |

(`07481c0-2026-07-14-001` is the very first published run containing this
suite — fetched and confirmed via `runs/v1/07481c0-2026-07-14-001/public-report.json`.
Older runs `0a4e4e6-2026-07-08`, `40c1cee-2026-07-01`, `60c3ebd-2026-06-30`,
`8ad7fc0-2026-06-29`/`-06-19`, `639422f-2026-06-19`, `fb05098-2026-06-18`,
`8f957c9-2026-06-17` predate this suite and were not fetched in full — they
are not "relevant" per the task scope since `tapestry-category-routing` did
not exist yet.)

**Finding: the suite has scored 0% in every single run since its introduction
on 2026-07-14, across four separate published runs and roughly seven weeks of
commits, including growth from 3 to 7 models.** This is a chronic,
100%-reproducible condition, not a regression introduced by any specific
recent commit.

## 2. Is there a "generic-Shuttle fix" commit, and does the published SHA contain it?

The task's premise that a single "generic-Shuttle fix" commit exists was
**not substantiated** on closer inspection. Two distinct things were
conflated in the prior draft; both are checked separately below.

### 2a. `268b2bfe` — NOT the relevant fix

`268b2bfe` ("fix: category shuttle descriptions and exclusion in delegation
routing (#160)", 2026-09-01) changes `packages/engine/src/*` prompt/delegation
composition (`buildDelegationTargets`, `shouldExcludeSharedShuttleTarget`). It
has **no relationship** to the eval scorer. `git merge-base --is-ancestor
268b2bfe 0eea530efb38f39c709db977ea43d9d03f9f3f1b` returns exit `0` (it is an
ancestor), but this is irrelevant to the eval result: the suite scored 0% in
runs `07481c0` and `e2f642e`, both published **before** `268b2bfe` existed,
and continued scoring 0% in `4a40e83`/`0eea530`, both **after**. Presence or
absence of `268b2bfe` has no observed effect on this suite's pass rate.

### 2b. The actual `expectedTarget === "shuttle"` scorer special-case

`packages/cli/src/evals/tapestry-category-routing-runner.ts`,
`scoreRoutingCorrectness()`, `generic-shuttle-fallback` branch:

```ts
if (analysis.expectedTarget === GENERIC_SHUTTLE) {
  return { score: 1.0, rationale: "Correct generic shuttle fallback: ...", applicable: true };
}
```

This is the exact logic that makes `tcr-04-no-match` and `tcr-10-disabled-category`
(both fixtures set `expected_outcome.target_agent = "shuttle"`) score 1.0 when
the model correctly falls back to generic `shuttle`, instead of the 0.4
partial-credit score given to a real category mismatch.

Checked with `git blame -L 500,540 <sha> -- packages/cli/src/evals/tapestry-category-routing-runner.ts`
at the published SHA: **every line of this branch blames to commit
`07481c04`** ("test: add tapestry category routing evals (#114)",
2026-07-14T19:25:12+02:00). Checked further back with `git show e75bb4f7:...`
(the commit immediately preceding `07481c04`, same date): the identical
`expectedTarget === GENERIC_SHUTTLE` branch is **already present** there too.

**Conclusion: this scorer behavior has existed since the suite's original
introduction to the repository (2026-07-14) and was never absent from any
commit reachable by any published run, including `07481c0-2026-07-14-001`
itself — the very first run.** `docs/category-routing-findings.md` (also
dated 2026-07-14) independently corroborates this: it documents that an
*earlier, unpublished* version of the scorer gave `tcr-04`/`tcr-10` only
partial credit (0.4), that this was diagnosed as a scorer defect, and that
"the scorer has been fixed" — describing exactly the code in section 2b —
before the first eval bundle for this suite was ever published. There is no
separate "generic-Shuttle fix" commit distinct from the code that shipped
with the suite's initial `#114` PR; the fix was already baked into every
published run.

**This rules out "the fix is missing from the published SHA" as an
explanation for 0%.** The routing-correctness special case for `tcr-04`/
`tcr-10` was present and correctly implemented in all four historical runs
that all still scored 0/N on this suite.

## 3. Fixture/rubric vs. deterministic scorer alignment (all 10 cases)

Fetched `evals/cases/tapestry-category-routing/tcr-{01..10}-*.json` and
`evals/rubrics/tapestry-category-routing/tcr-{01..10}-*.json` at the published
SHA and cross-checked against the scorer's assumptions:

| caseId | `expected_outcome.kind` | `target_agent` | `accepted_alternates` | rubric `case_id` matches file/case id | rubric `required` |
| --- | --- | --- | --- | --- | --- |
| tcr-01-exact-match | agent_routing | shuttle-client-frontend | (none) | yes | true |
| tcr-02-multiple-files | agent_routing | shuttle-client-frontend | (none) | yes | true |
| tcr-03-windows-paths | agent_routing | shuttle-client-frontend | (none) | yes | true |
| tcr-04-no-match | agent_routing | shuttle | loom | yes | true |
| tcr-05-cross-category | agent_routing | shuttle | shuttle-client-frontend, shuttle-backend-api, loom | yes | false |
| tcr-06-overlap | agent_routing | shuttle-client-frontend | shuttle | yes | false |
| tcr-07-explicit-hint | agent_routing | shuttle-client-frontend | shuttle | yes | false |
| tcr-08-misleading-prose | agent_routing | shuttle-client-frontend | shuttle | yes | true |
| tcr-09-similar-names | agent_routing | shuttle-client-frontend | (none) | yes | true |
| tcr-10-disabled-category | agent_routing | shuttle | loom | yes | true |

Findings:
- All 10 `expected_outcome.kind` values are `"agent_routing"`, consistent with
  the scorer's `routingApplicable = outcomeKind === "agent_routing"` check
  (`langchain-agent-evals.ts`) — the deterministic routing dimension is
  applicable, and `delegationCorrectness`/`executionCompleteness` are
  correctly marked not-applicable for every case in this suite (their
  respective `outcomeKind` guards, `"delegation_chain"`/`"task_completion"`,
  never match).
- Every rubric's `case_id` field matches its filename and the corresponding
  case fixture's `id` — no `RubricNotFound`/`RubricCaseMismatch` condition is
  visible from a **static** fixture-naming check.
- No spelling or casing defects found in any `target_agent`/`accepted_alternates`
  string against the `shuttle`/`shuttle-{category}` vocabulary the scorer
  expects.

**Classification: fixture/deterministic-scorer alignment — ALIGNED**, to the
extent verifiable statically (fixture shape, naming, rubric/case pairing, and
the `expectedTarget === "shuttle"` special case reviewed in section 2b). **What
remains unverified without live execution:** whether the *live* judge call for
the `rationaleQuality` dimension (the one dimension always applicable, for
every one of these 10 cases, per `langchain-agent-evals.ts`) succeeds or
errors. That call is not exercised by fixture inspection or `--dry-run`.

## 4. Tracing the missing case-level `explanation` field precisely

The plan's premise ("typed scorer failure emits no `publicExplanation`") and
the schema's actual behavior are two different claims. Both were checked
against the real type and the real published data; here is the exact
distinction, not asserted by design.

### 4a. The schema

`packages/cli/src/evals/types.ts`, `CaseResultSummary.publicExplanation` is an
**optional** field:

> "Optional bounded public explanation for why this case received its score
> bucket. ... When present: bounded ... source-attributed .... When absent:
> the score bucket and passed/failed boolean are self-explanatory."

So the schema documentation frames absence as tolerable, but it does not by
itself explain *why* it is absent for one specific suite and not others.

### 4b. What the runner actually does (two code paths, only one sets it)

`tapestry-category-routing-runner.ts` has exactly two places that construct a
`CaseResultSummary`:

- **Success path** (`executeSingleCase`, the `.match()` success branch,
  ~line 1551): calls `buildPublicExplanation(...)` from
  `langchain-agent-evals.ts` and assigns the result to `summary.publicExplanation`.
- **Error path** (`buildErrorResult`, ~line 845): constructs the summary
  **without ever setting `publicExplanation`** — the field is simply omitted.
  This function is invoked (line ~1598) whenever the per-case `ResultAsync`
  chain resolves to an error: `NetworkError`, `HttpError`, `ParseError`,
  `EmptyResponse`, `RubricNotFound`, `RubricCaseMismatch`, or
  `ScorerAdapterError` (the last of these wraps any error thrown/returned by
  the injected `LangChainAgentEvalsScorer.score()` call, i.e. a live judge
  failure).

### 4c. Cross-referencing against the actual published data

Checked case-by-case presence of `explanation` in `public-report.json` for
**every suite in the 0eea530 run**, and separately for the very first run
(`07481c0-2026-07-14-001`):

| Suite | 0eea530 run: cases / with `explanation` | 07481c0 run: cases / with `explanation` |
| --- | --- | --- |
| loom-routing | 21 / 21 | 9 / 9 |
| tapestry-execution | 14 / 14 | 6 / 6 |
| shuttle-execution | 14 / 14 | 6 / 6 |
| spindle-tools | 14 / 14 | 6 / 6 |
| pattern-planning | 14 / 13 | 6 / 6 |
| weft-review | 14 / 14 | 6 / 6 |
| warp-security | 14 / 13 | 6 / 6 |
| **tapestry-category-routing** | **70 / 0** | **30 / 0** |

Every other suite has `explanation` populated for effectively all of its
cases (the two isolated single-case gaps — one `pattern-planning` case and
one `warp-security` case in the 0eea530 run, both `deepseek/deepseek-v4-flash-0731`
— are themselves individual failed cases missing `explanation`, i.e. the same
error-path signature, just on 2 cases instead of all of them). By contrast,
**`tapestry-category-routing` has never had `explanation` populated for a
single case, in any of the 4 runs checked, across ~150 total case×model
executions.**

**This is a structural, non-speculative correlation, not a guess:** 100% of
`tapestry-category-routing` case results are missing `publicExplanation` in
every run since the suite's introduction, and 100% of `tapestry-category-routing`
case results are also failing (`passed: false`) in every run since the suite's
introduction. Per the runner's own control flow (4b), the *only* path that
omits `publicExplanation` is `buildErrorResult` — the per-case error branch.
The most likely reading of the evidence is that **every one of these case
executions is falling through the error branch**, not the success-with-a-real-fail-score
branch — meaning routing/delegation/execution/rationale dimensions may never
even be computed for these cases; they are zeroed out by `buildErrorResult`
regardless of what the deterministic `scoreRoutingCorrectness()` would have
produced.

**What is NOT established:** which specific error type (`ScorerAdapterError`
from a live judge call, `RubricNotFound`, `RubricCaseMismatch`, or a model/HTTP
error) is actually being thrown, because `buildErrorResult`'s public
`CaseResultSummary` deliberately does not surface `errorType`/`classification`
— that detail lives only in `RawErrorSummary.localDiagnostic`, which is
written exclusively to local `--raw-artifacts` output and is never published.
Section 5 fixture/dependency review found no static defect (missing field,
typo, wrong `kind`) that would cause `RubricNotFound`/`RubricCaseMismatch` for
this suite, which makes a live judge-call failure (`ScorerAdapterError`) the
most evidence-consistent hypothesis — but this is a hypothesis ranked by
static code correlation, not a confirmed root cause. Confirming it requires a
credentialed rerun with `--raw-artifacts` to read the redacted local
`errorType`/`classification`/`localDiagnostic` values, which this session
could not perform (see section 6).

**Classification: blank case-level explanation — traced to a specific code
path (`buildErrorResult` in `tapestry-category-routing-runner.ts`), correlated
with 100% suite failure across all 4 historical runs. This is DEFECTIVE
behavior from the suite's perspective (every case result is uninformative
about why it failed), not an intentional universal redaction — every other
suite in the same reports has explanations for its failing cases.**

## 5. Runner / judge / dependency provenance at `0eea530e`

- `packages/cli/src/evals/tapestry-category-routing-runner.ts` — present,
  implements category-aware scoring that does **not** canonicalize
  `shuttle-{category}` to `shuttle` (`CATEGORY_SHUTTLE_RE`), with the
  `generic-shuttle-fallback` classification and the `expectedTarget ===
  "shuttle"` → 1.0 special case reviewed in section 2b. This is the runner
  that scored all 4 historical runs, unchanged in the relevant scoring logic.
- `packages/cli/src/evals/langchain-agent-evals.ts` — present, isolates the
  `@langchain/*`/`agentevals`/`openevals` dependency to this one file via the
  `LangChainJudge` interface; production path uses `RealLangChainJudge`.
  `LangChainAgentEvalsScorer.score()` performs rubric lookup
  (`rubrics.find(r => r.case_id === run.caseId)`) then, for
  `tapestry-category-routing` cases specifically, calls the live judge only
  for the `rationaleQuality` dimension (routing is computed locally;
  delegation/execution are not applicable for `kind: "agent_routing"`).
- `packages/cli/src/commands/eval.ts` — hardcodes
  `JUDGE_MODEL_ID = "anthropic/claude-sonnet-4.5"` and constructs
  `new ChatOpenAI({ model: JUDGE_MODEL_ID, ... })` targeting OpenRouter. This
  is a **valid** model slug (no trailing slash), distinct from the
  `claude-sonnet-4-5/` malformed ID that caused this task's category shuttle
  to fail to start in this session — the two are unrelated systems (OpenCode
  adapter model config vs. CLI eval judge model). This judge model ID has not
  changed across the runs inspected.
- `.github/workflows/agent-evals.yml` — `workflow_dispatch`-only, injects
  `OPENROUTER_API_KEY` and `EVAL_RESULTS_REPO_TOKEN` as step-scoped `env:`
  vars pulled from `secrets.*`; no plaintext secrets in the workflow file.
- `evals/model-matrix.json` — all 7 model IDs (`anthropic/claude-opus-4.5`,
  `anthropic/claude-sonnet-4.5`, `openai/gpt-5.5`, `anthropic/claude-opus-5`,
  `openai/gpt-5.6-sol`, `qwen/qwen3.8-max`,
  `deepseek/deepseek-v4-flash-0731`) are well-formed OpenRouter-style slugs
  matching the model IDs in the published `model-comparison` artifact.
- `package.json` / `packages/cli/package.json` / `bun.lock` — root pins
  `@langchain/core@^1.1.48`, `@langchain/openai@^1.4.7`, `agentevals@^0.0.7`,
  `openevals@^0.2.0`. `bun.lock` resolves the top-level `openevals` to
  `0.2.0` (the version actually imported by `langchain-agent-evals.ts`) and a
  separate nested `agentevals/openevals@0.1.5` for `agentevals`'s own
  internal use. `agentevals` is not imported directly by the runner or judge
  adapter, so the nested version does not affect judge invocation.

**Classification: source/dependency provenance — ALIGNED at the static-review
level.** No malformed model ID, missing scorer special-case, or dependency
version mismatch was found in the code path that produced any of the 4
published runs. This does **not** rule out a *runtime* judge/network/HTTP
failure specific to this suite's live judge calls — see section 4c/6.

## 6. Local reproduction of `tcr-04-no-match` and `tcr-10-disabled-category`

Commands run (from `C:\source\weave-vnext`):

```
$env:OPENROUTER_API_KEY -> not set in this session

bun packages/cli/src/main.ts eval run --agent tapestry-category-routing --case tcr-04-no-match --raw-artifacts
# → Error: OPENROUTER_API_KEY is required to run evals but was not set. Set it in your shell environment before running weave eval run.

bun packages/cli/src/main.ts eval run --agent tapestry-category-routing --case tcr-04-no-match --dry-run --raw-artifacts
# → Eval dry run — no execution will occur
#   Agent filter:  tapestry-category-routing
#   Case filter:   tcr-04-no-match
#   Raw artifacts: enabled (local-only)

bun packages/cli/src/main.ts eval run --agent tapestry-category-routing --case tcr-10-disabled-category --dry-run --raw-artifacts
# → Eval dry run — no execution will occur
#   Agent filter:  tapestry-category-routing
#   Case filter:   tcr-10-disabled-category
#   Raw artifacts: enabled (local-only)

bun packages/cli/src/main.ts eval run --agent tapestry-category-routing --case tcr-10-disabled-category --raw-artifacts
# → Error: OPENROUTER_API_KEY is required to run evals but was not set. Set it in your shell environment before running weave eval run.
```

**What `--dry-run` actually proves, and what it does not:**
- It proves both case IDs resolve cleanly through `case-loader.js`'s
  `loadSuiteCases`/`loadSuiteRubrics`/`validateCaseFilter` — no "unknown case"
  or fixture-loading error. This corroborates the static fixture-naming check
  in section 3 (rubric/case pairing is intact on `main`).
  Per the CLI's own output ("no execution will occur"), `--dry-run` does
  **not** call the model client, does **not** call the scorer/judge, and does
  **not** exercise `scoreRoutingCorrectness()`, `LangChainAgentEvalsScorer.score()`,
  or either `CaseResultSummary` construction path. **It is not evidence of
  fixture/scorer *behavioral* alignment — only of fixture *load-time*
  alignment.** The scorer/judge alignment claim in sections 3 and 5 is
  explicitly scoped to what was checked (fixture shape, rubric pairing,
  applicability flags, model IDs, dependency versions) and explicitly
  excludes live scoring behavior.
- The live-call guard for a missing `OPENROUTER_API_KEY` is a single, typed,
  redacted error message. It does not leak partial diagnostics, raw request
  data, or any provider/scorer text.

**Exact limitation:** `OPENROUTER_API_KEY` is **not available** in this
environment/session. Live model calls, live judge (`ChatOpenAI` via
OpenRouter) invocation, and `--raw-artifacts` local diagnostic capture for
`tcr-04-no-match`/`tcr-10-disabled-category` could not be executed. This means
the specific runtime cause of the persistent 100% failure on
`tapestry-category-routing` — in particular, which typed error
(`ScorerAdapterError`, `RubricNotFound`, `RubricCaseMismatch`, or a model/HTTP
error) is actually produced for every case in this suite — **cannot be
determined from this session**. It requires a credentialed rerun with
`--raw-artifacts` to inspect the typed `errorType`/`classification` and
redacted `localDiagnostic` fields that `buildErrorResult` writes to the local
raw-artifact output (never published).

## 7. Summary classification

| Layer | Classification | Evidence | Scope of "aligned" |
| --- | --- | --- | --- |
| Fixture/scorer (deterministic routing dimension) | Aligned | All 10 fixtures/rubrics correctly paired and shaped; `expectedTarget === "shuttle"` special case present since suite inception (07481c04, 2026-07-14), confirmed via `git blame` | Static shape/naming/logic review only; `--dry-run` confirms load-time wiring, not runtime behavior |
| Scorer/judge (live `rationaleQuality` call) | **Unverified / suspected defective** | `buildErrorResult` (no-`publicExplanation` path) structurally correlates 1:1 with 100% suite failure across all 4 historical runs, while every other suite's failing cases retain `explanation` | Cannot confirm the exact error type without a credentialed rerun with `--raw-artifacts`; code review found no static defect in judge wiring itself |
| Immutable artifact/index | Aligned | `dashboard-manifest` (latest-only), `suite-history`, `scenario-history`, `model-comparison`, `public-report.json`, `bundle-index.json` agree exactly on run identity and pass/fail counts, in all 4 runs checked | Full paginated commit history was inspected to confirm `dashboard-manifest`'s `totalRuns: 1` reflects "latest only," not "only run ever" |
| Source/dependency provenance | Aligned | No missing scorer fix (the relevant fix predates every published run); `268b2bfe` is unrelated; judge model ID, workflow secret handling, model matrix, and lockfile are internally consistent in the SHA that produced each run | Static review of source and lockfiles only |

**Net conclusion:** the 0% pass rate on `tapestry-category-routing` is a
**chronic condition present in every run since the suite's introduction on
2026-07-14** (4 runs, ~150 case×model executions), not a one-off regression
and not caused by the absence of any specific commit (the deterministic
`tcr-04`/`tcr-10` scorer fix has been present since the very first run).
The missing case-level `explanation` is not an intentional universal
redaction — it is isolated to this one suite and structurally consistent with
every case falling through the runner's error-result path
(`buildErrorResult`), which never sets `publicExplanation`. The specific
triggering error (most plausibly a live LangChain-judge failure on the
`rationaleQuality` dimension, since no static fixture/rubric/dependency defect
was found) remains **undiagnosed** pending a credentialed rerun with
`OPENROUTER_API_KEY` and `--raw-artifacts`, since this session had no access
to that secret.
