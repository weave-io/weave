# Weave Eval Fixtures

> **New to the evals?** Start with the one-page [Evals Overview](../docs/evals-overview.md): what the evals are for, how a case becomes a score, the judge, and the commands most people need.

This directory contains the canonical fixture files for `weave eval run`. It is the **allowlist source of truth** for model matrix entries, eval cases, and rubric scoring metadata.

Today that fixture surface covers exactly **eight text-only suite families**: `loom-routing`, `tapestry-execution`, `tapestry-category-routing`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, and `warp-security`. Three of them (`loom-routing`, `tapestry-execution`, `shuttle-execution`) also hold `harness_trajectory` cases, which run a real harness session in a sandbox; their fixture projects live under `fixtures/`.

For the full eval guide — architecture, CI model, sanitization rules, raw-artifact policy, and prompt-hash provenance — see [`docs/agent-evals.md`](../docs/agent-evals.md).

> **What can and cannot land here**: fixture files (`model-matrix.json`, case JSONs, rubric JSONs, and synthetic projects under `fixtures/`) are the only files that belong in this directory. Raw artifacts, composed prompt text, transcripts, API keys, and `eval-bundles/` output must never be committed here or to any external results repository without passing the sanitizer defined in `packages/cli/src/evals/sanitizer.ts`.

## Directory Layout

```
evals/
├── README.md                           # This file
├── model-matrix.json                   # Canonical model allowlist
├── cases/
│   ├── loom-routing/                   # Loom agent routing eval cases
│   │   ├── loom-route-backend-api.json
│   │   ├── loom-route-frontend-ui.json
│   │   ├── loom-route-ambiguous-direct-shuttle.json
│   │   ├── loom-delegates-backend-fix-to-category-trajectory.json   # harness_trajectory
│   │   └── loom-runs-the-failing-check-itself-trajectory.json   # harness_trajectory
│   ├── tapestry-execution/             # Tapestry execution/delegation eval cases
│   │   ├── tapestry-execute-plan-step.json
│   │   ├── tapestry-delegate-to-shuttle.json
│   │   ├── tapestry-rejects-contradicted-report.json   # judgment
│   │   ├── tapestry-accepts-evidenced-report.json      # judgment
│   │   ├── tapestry-runs-plan-verification-trajectory.json   # harness_trajectory
│   │   └── tapestry-dispatches-independent-tasks-in-parallel-trajectory.json   # harness_trajectory
│       ├── tapestry-category-routing/      # Tapestry category-routing eval cases
│   │   ├── tcr-01-exact-match.json
│   │   ├── tcr-02-multiple-files.json
│   │   ├── tcr-03-windows-paths.json
│   │   ├── tcr-04-no-match.json
│   │   ├── tcr-05-cross-category.json
│   │   ├── tcr-06-overlap.json
│   │   ├── tcr-07-explicit-hint.json
│   │   ├── tcr-08-misleading-prose.json
│   │   ├── tcr-09-similar-names.json
│   │   └── tcr-10-disabled-category.json
│   ├── shuttle-execution/              # Shuttle delegated-task execution reporting eval cases
│   │   ├── shuttle-execution-report-structured-evidence.json
│   │   ├── shuttle-execution-report-tests-and-assumptions.json
│   │   ├── shuttle-execution-reports-unverified.json   # judgment
│   │   ├── shuttle-execution-reports-preexisting-failure.json   # own-envelope
│   │   ├── shuttle-execution-owns-failure-it-caused.json   # own-envelope
│   │   ├── shuttle-execution-stale-check-after-last-edit.json   # own-envelope
│   │   ├── shuttle-execution-stays-in-scope.json   # own-envelope
│   │   ├── shuttle-execution-blocks-on-missing-value.json   # own-envelope
│   │   ├── shuttle-execution-criterion-without-command.json   # own-envelope
│   │   ├── shuttle-execution-symptom-still-present.json   # own-envelope
│   │   ├── shuttle-execution-refuses-secret-request.json   # own-envelope
│   │   ├── shuttle-execution-applies-learnings.json   # own-envelope
│   │   └── shuttle-verify-tests-after-edit-trajectory.json   # harness_trajectory
│   ├── spindle-tools/                  # Spindle research eval cases
│   │   ├── spindle-tools-citations-facts-confidence.json
│   │   ├── spindle-tools-source-boundary-network-claims.json
│   │   ├── spindle-tools-says-not-found.json   # research behaviour
│   │   ├── spindle-tools-reconciles-conflicting-sources.json   # research behaviour
│   │   ├── spindle-tools-official-docs-over-blog.json   # research behaviour
│   │   ├── spindle-tools-version-mismatch.json   # research behaviour
│   │   ├── spindle-tools-flags-outdated-source.json   # research behaviour
│   │   ├── spindle-tools-no-unverified-live-facts.json   # research behaviour
│   │   ├── spindle-tools-summary-keeps-caveat.json   # research behaviour
│   │   ├── spindle-tools-answers-the-question-asked.json   # research behaviour
│   │   ├── spindle-tools-calibrates-low-confidence.json   # research behaviour
│   │   └── spindle-tools-local-code-out-of-scope.json   # research behaviour
│   ├── pattern-planning/               # Pattern planning structure eval cases
│   │   ├── pattern-plan-settings-refactor.json
│   │   ├── pattern-plan-release-checklist.json
│   │   ├── pattern-plan-verify-by-per-criterion.json   # judgment
│   │   └── pattern-plan-no-invented-commands.json      # judgment
│   ├── weft-review/                    # Weft review-structure eval cases
│   │   ├── weft-review-clean-approval.json
│   │   ├── weft-review-reject-blocker-citation.json
│   │   ├── weft-review-traced-true-positive.json       # judgment
│   │   ├── weft-review-guarded-false-positive.json     # judgment
│   │   ├── weft-review-approves-complete-feature.json   # judgment
│   │   ├── weft-review-style-nits-not-blockers.json   # judgment
│   │   ├── weft-review-preexisting-bug-out-of-scope.json   # judgment
│   │   ├── weft-review-test-never-exercises-filter.json   # judged review
│   │   ├── weft-review-swallows-parse-error.json   # judged review
│   │   ├── weft-review-contradicts-stated-intent.json   # judged review
│   │   ├── weft-review-large-diff-buried-change.json   # judged review
│   │   └── weft-review-traced-unit-mismatch.json   # judged review
│   └── warp-security/                  # Warp security-review structure eval cases
│       ├── warp-security-fast-exit-approve.json
│       ├── warp-security-block-evidence-findings.json
│       ├── warp-security-traced-injection.json         # judgment
│       ├── warp-security-guarded-false-positive.json   # judgment
│       ├── warp-security-guarded-parameterised-sql.json  # judgment
│       ├── warp-security-cors-exact-allowlist.json     # judgment
│       ├── warp-security-path-prefix-bypass.json       # judge-scored
│       ├── warp-security-copy-target-authz.json        # judge-scored
│       ├── warp-security-ssrf-redirect-bypass.json     # judge-scored
│       ├── warp-security-cors-origin-pattern.json      # judge-scored
│       ├── warp-security-prototype-pollution-merge.json  # judge-scored
│       └── warp-security-unawaited-signature-check.json  # judge-scored
└── rubrics/
    ├── loom-routing/                   # Scoring rubrics for loom-routing cases
    │   ├── loom-route-backend-api.json
    │   ├── loom-route-frontend-ui.json
    │   ├── loom-route-ambiguous-direct-shuttle.json
    │   ├── loom-delegates-backend-fix-to-category-trajectory.json
    │   └── loom-runs-the-failing-check-itself-trajectory.json
    ├── tapestry-execution/             # Scoring rubrics for tapestry-execution cases
    │   ├── tapestry-execute-plan-step.json
    │   ├── tapestry-delegate-to-shuttle.json
    │   ├── tapestry-rejects-contradicted-report.json
    │   ├── tapestry-accepts-evidenced-report.json
    │   ├── tapestry-runs-plan-verification-trajectory.json
    │   └── tapestry-dispatches-independent-tasks-in-parallel-trajectory.json
    ├── tapestry-category-routing/      # Scoring rubrics for tapestry-category-routing cases
    │   ├── tcr-01-exact-match.json
    │   ├── tcr-02-multiple-files.json
    │   ├── tcr-03-windows-paths.json
    │   ├── tcr-04-no-match.json
    │   ├── tcr-05-cross-category.json
    │   ├── tcr-06-overlap.json
    │   ├── tcr-07-explicit-hint.json
    │   ├── tcr-08-misleading-prose.json
    │   ├── tcr-09-similar-names.json
    │   └── tcr-10-disabled-category.json
    ├── shuttle-execution/              # Scoring rubrics for shuttle-execution cases
    │   ├── shuttle-execution-report-structured-evidence.json
    │   ├── shuttle-execution-report-tests-and-assumptions.json
    │   ├── shuttle-execution-reports-unverified.json
    │   ├── shuttle-execution-reports-preexisting-failure.json
    │   ├── shuttle-execution-owns-failure-it-caused.json
    │   ├── shuttle-execution-stale-check-after-last-edit.json
    │   ├── shuttle-execution-stays-in-scope.json
    │   ├── shuttle-execution-blocks-on-missing-value.json
    │   ├── shuttle-execution-criterion-without-command.json
    │   ├── shuttle-execution-symptom-still-present.json
    │   ├── shuttle-execution-refuses-secret-request.json
    │   ├── shuttle-execution-applies-learnings.json
    │   └── shuttle-verify-tests-after-edit-trajectory.json
    ├── spindle-tools/                  # Scoring rubrics for spindle-tools cases
    │   ├── spindle-tools-citations-facts-confidence.json
    │   ├── spindle-tools-source-boundary-network-claims.json
    │   ├── spindle-tools-says-not-found.json
    │   ├── spindle-tools-reconciles-conflicting-sources.json
    │   ├── spindle-tools-official-docs-over-blog.json
    │   ├── spindle-tools-version-mismatch.json
    │   ├── spindle-tools-flags-outdated-source.json
    │   ├── spindle-tools-no-unverified-live-facts.json
    │   ├── spindle-tools-summary-keeps-caveat.json
    │   ├── spindle-tools-answers-the-question-asked.json
    │   ├── spindle-tools-calibrates-low-confidence.json
    │   └── spindle-tools-local-code-out-of-scope.json
    ├── pattern-planning/               # Scoring rubrics for pattern-planning cases
    │   ├── pattern-plan-settings-refactor.json
    │   ├── pattern-plan-release-checklist.json
    │   ├── pattern-plan-verify-by-per-criterion.json
    │   └── pattern-plan-no-invented-commands.json
    ├── weft-review/                    # Scoring rubrics for weft-review cases
    │   ├── weft-review-clean-approval.json
    │   ├── weft-review-reject-blocker-citation.json
    │   ├── weft-review-traced-true-positive.json
    │   ├── weft-review-guarded-false-positive.json
    │   ├── weft-review-approves-complete-feature.json
    │   ├── weft-review-style-nits-not-blockers.json
    │   ├── weft-review-preexisting-bug-out-of-scope.json
    │   ├── weft-review-test-never-exercises-filter.json
    │   ├── weft-review-swallows-parse-error.json
    │   ├── weft-review-contradicts-stated-intent.json
    │   ├── weft-review-large-diff-buried-change.json
    │   └── weft-review-traced-unit-mismatch.json
    └── warp-security/                  # Scoring rubrics for warp-security cases
        ├── warp-security-fast-exit-approve.json
        ├── warp-security-block-evidence-findings.json
        ├── warp-security-traced-injection.json
        ├── warp-security-guarded-false-positive.json
        ├── warp-security-guarded-parameterised-sql.json
        ├── warp-security-cors-exact-allowlist.json
        ├── warp-security-path-prefix-bypass.json
        ├── warp-security-copy-target-authz.json
        ├── warp-security-ssrf-redirect-bypass.json
        ├── warp-security-cors-origin-pattern.json
        ├── warp-security-prototype-pollution-merge.json
        └── warp-security-unawaited-signature-check.json
```

Trajectory fixtures (Spec 35) live next to the cases and rubrics:

```
evals/fixtures/
├── buggy-slugify/              # Bun project with a slug bug its tests miss
├── orders-api/                 # Bun project with backend and frontend categories (delegation accuracy)
├── plan-bash-verification/     # same project plus a plan whose Verification is a bash block
├── plan-independent-tasks/     # plan with two independent tasks (parallel execution)
├── red-ci/                     # project whose CI (bun test) is red, no log given (environment awareness)
├── red-ci.verifier/            # hidden verifier for red-ci
└── slugify-edges.verifier/     # hidden verifier, mounted only in the second container
```

## Model Matrix (`model-matrix.json`)

The model matrix defines the **closed set of models** that evals run against. At minimum, three models must have `default: true` — these are the models used when neither `--model` nor `--models dev` is supplied.

### Schema

```jsonc
{
  "version": 1,            // Positive integer; bump when schema evolves
  "models": [
    {
      "id": "anthropic/claude-sonnet-4.5",   // Fully-qualified identifier (required)
      "display_name": "Claude Sonnet 4.5",   // Human-readable name for reports (required)
      "provider": "anthropic",               // Provider/owner (required)
      "default": true,                       // Included in default run (required)
      "dev": false,                          // In the cheap dev subset (optional, default false)
      "tags": ["fast", "balanced"]           // Optional tags for grouping
    }
  ]
}
```

**Constraints**: At least three entries must have `"default": true`, and at most two may have `"dev": true`. The loader (`packages/cli/src/evals/model-matrix.ts`) enforces both at load time with a `ModelMatrixConstraintViolation` error.

### The development subset

Entries marked `"dev": true` form the cheap development subset, run with
`weave eval run --models dev` instead of the full default matrix. Use it while
iterating on a prompt, a case or a rubric; use a plain `weave eval run` (the
full default matrix) for a baseline. `dev` is independent of `default`.

A case that omits `allowed_models` runs on the default models **and** the dev
subset, so the subset reaches every ordinary case with no fixture edit. To
change the subset, set or clear `dev` on a matrix entry — nothing else lists
the dev models. The current subset and why it was chosen are recorded in
[`docs/agent-evals.md`](../docs/agent-evals.md#the-development-subset---models-dev).

## Case Fixtures (`cases/<suite>/<case-id>.json`)

Each case fixture describes a single eval scenario. Case files are named after the case `id` field.

Every text-only case may assert only what is visible in assistant or user text. `harness_trajectory` cases, allowed only in `loom-routing`, `tapestry-execution` and `shuttle-execution`, are the exception: they observe a real harness session instead. See [Harness trajectory evals](../docs/agent-evals.md#harness-trajectory-evals).

### Suites

| Suite                       | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `loom-routing`              | Verify Loom routes requests to the correct agent/category    |
| `tapestry-execution`        | Verify Tapestry executes steps and delegates to sub-agents   |
| `tapestry-category-routing` | Verify Tapestry routes to the correct category shuttle agent |
| `shuttle-execution`         | Verify Shuttle mirrors delegated task structure and final evidence reporting from text |
| `spindle-tools`             | Verify Spindle cites sources, separates source facts from interpretation, reports confidence, and handles its sources honestly (not found, conflicting, dated, out of scope), from text |
| `pattern-planning`          | Verify Pattern emits structurally strong implementation plans |
| `weft-review`               | Verify Weft emits structurally valid approve/reject reviews, and rejects for the right reason |
| `warp-security`             | Verify Warp emits text-only security triage and finding structure |

### Case Schema

```jsonc
{
  "id": "loom-route-backend-api",          // Unique within the suite; used as --case filter
  "description": "...",                    // Human-readable description (required)
  "suite": "loom-routing",                 // Suite this case belongs to (required)
  "allowed_agents": ["loom", "shuttle"],   // Closed set of valid agents (min 1)
  "allowed_models": ["anthropic/..."],     // Optional; omit for the default + dev models. Exceptions only
  "expected_outcome": { ... },             // Discriminated union (see below)
  "accepted_alternates": [],               // Optional substitute agent/model IDs
  "transcript_expectations": [],           // Optional ordered transcript assertions
  "tags": []                               // Optional grouping tags
}
```

### `expected_outcome` kinds

| `kind`             | Required fields                               | Description                          |
| ------------------ | --------------------------------------------- | ------------------------------------ |
| `agent_routing`    | `target_agent`, `via`                         | Verify routing to the target agent   |
| `task_completion`  | `description`, `required_artifacts`           | Verify a task completed successfully |
| `delegation_chain` | `chain` (≥2 agents)                           | Verify an ordered delegation chain   |
| `tool_call`        | `tool_name`, `payload_contains` (optional)    | Verify a tool was invoked            |

`tool_call` exists in the shared schema for forward compatibility, but it is **forbidden** in the eight currently registered text-only suite families. The suite registry in `packages/cli/src/evals/types.ts` rejects it before dry-run or live execution.

### Pattern-planning fixture guidance

`pattern-planning` cases must stay structural. Score only plan signals the text
runner can deterministically extract from assistant output, such as:

- explicit scope
- file-backed tasks
- sequencing/order
- acceptance-criteria coverage

Avoid semantic “good plan” assertions that require subjective interpretation.
The runner seeds `required_artifacts` with observable markers so the existing
scorer path can grade representative planning cases without wish-casting.

### Shuttle-execution fixture guidance

`shuttle-execution` cases must stay bounded and text-observable. Encode the
delegated task intake directly in the runner prompt/case description so the
suite can score only final-report structure that appears in assistant text,
such as:

- reflecting the assigned task envelope (`Task [N/M]`, `What`, `Files`, `Acceptance`)
- acknowledging listed files in a `Files changed` section
- reporting commands/tests and their outputs as text evidence
- explicitly confirming whether all acceptance criteria are met

Do not require real file mutation, tool-call telemetry, shell history, or
hidden workspace state. The suite validates Shuttle's completion reporting
discipline, not actual repository changes.

#### Own-envelope cases (`own-envelope` tag)

Most of the suite's text cases test what Shuttle does with a situation, not
the shape of its report. A case tagged `own-envelope` carries the whole
delegated task in its description: the `Task [N/M]` envelope, the files it
has read, and the session so far (the edits made, the commands run and the
output observed, in order). The runner sends that description as written,
followed only by "Report back to the coordinator on this delegated task.",
with no section script and no signal names
(`buildUserMessage` in
[`shuttle-execution-runner.ts`](../packages/cli/src/evals/shuttle-execution-runner.ts)).

These cases are judged: `required_artifacts` is empty, so the judge asks
whether the report achieves the case's `expected_outcome.description`, and
reads the rubric's notes for what fails. The runner's deterministic honesty
signals assume nothing was observed, so they cannot score a case whose
session shows real output: quoting `14 pass, 1 fail` from the session is
honest there. Those signals are still recorded as diagnostics.

When writing one:

- describe what happened as observed facts (commands and their output), and
  never state the expected decision;
- end the session explicitly ("you cannot run any more commands", or
  `execute permission: deny`), so the case tests the report and not a promise
  to run something later;
- make the tempting wrong answer plausible (a guessable URL, a lint pass to
  claim, an adjacent bug to fix), so the case can tell models apart;
- list in the rubric notes what fails, and what is acceptable that a strict
  reader might mark down (quoting observed counts, suggesting a follow-up).

The first nine cover: an unrelated failure it did not cause
(`reports-preexisting-failure`), a failure its own change caused
(`owns-failure-it-caused`), a check run before the last edit
(`stale-check-after-last-edit`), an adjacent bug outside the listed files
(`stays-in-scope`), a value the source document does not give
(`blocks-on-missing-value`), an acceptance check with no command
(`criterion-without-command`), passing tests while the reported symptom
remains (`symptom-still-present`, from the [September 2026 session
audit](../docs/artifacts/session-audit-2026-09.md)), a request to paste a
secret (`refuses-secret-request`), and the task's learnings and acceptance
criteria (`applies-learnings`).

### Spindle-tools fixture guidance

`spindle-tools` cases must remain text-observable.
Encode any synthetic source brief directly in the case description or runner
prompt and score only what the assistant text makes visible, such as:

- inline citations like `[1]` / `[2]`
- explicit separation between `Source facts` and `Interpretation`
- a bounded `Confidence:` line
- a final `Sources:` list

Every case requires all four report-format signals, and the judge scores it.
A research behaviour case (the ten added for Spec 39 gap G3) also tests one
behaviour that the answer text shows, such as saying "not found" or flagging a
dated source. Write those cases like this:

- Start the description with `Research question` and give numbered sources
  (`[1] Kind, title, date: 'quoted text'`). Use invented product names so the
  model cannot answer from memory.
- Put the behaviour in `expected_outcome.description` and the rubric notes,
  never in the description: the runner shows the model the description only.
- Name the one required behaviour in the expected outcome and say what is
  optional. Rubric notes start with what still fails a fully formatted report
  ("Fail the answer if ...") and say which near-misses pass.
- Check the case with a judge sanity run: a bad answer with every section must
  fail, and a correct one must pass.

`packages/cli/src/evals/__tests__/spindle-tools-corpus.test.ts` guards these
rules.

Do not require actual browsing telemetry, network events, search-tool traces,
or hidden source retrieval state. If a case needs to talk about tools or
network access, it may do so only as a plain-text claim visible in the answer.
Unsupported runtime-only assertions (for example `tool_call`, `tool_called`,
`no_tool_called`, or `role: "tool"`) are rejected by the shared text-only
fixture contract before execution.

### Weft-review fixture guidance

`weft-review` cases must remain synthetic and text-observable. Encode the
review target entirely inside the case description or runner prompt so the
suite never depends on a live repo diff. Score review structure the text
runner can observe, or, in a judged review case (below), whether the review
names the defect the case describes. Observable structure includes:

- explicit `[APPROVE]` / `[REJECT]` verdict tags
- blocker count and presence/absence discipline
- actionable blocker lines with file references
- reviewed-file references in approvals

Avoid assertions that require tool traces, actual patch application, or hidden
repository state beyond the synthetic text provided to the model.

#### Weft judged review cases

A `[REJECT]` signal cannot tell a rejection for the right reason from one for
the wrong reason. A judged review case therefore has empty
`required_artifacts`: the runner's user message says "Required structural
signals: none", so it reveals no verdict, and the judge asks whether the
review reaches the case's `expected_outcome.description`. Approvals stay
`judgment` cases, scored on `[APPROVE]` with zero `BLOCKER:` lines, because
for an approval the verdict is the whole answer.

When writing one:

- show the whole change: the task and its acceptance, every changed file
  (line-numbered, or a unified diff with `+`/`-`/space markers) and the
  unchanged context the defect depends on, and a passing CI line so missing
  evidence is not a reason to reject;
- make the defect visible only by reading the code (a CLI default that
  defeats `??`, a seconds setting passed as milliseconds), never by a
  sentence that names it;
- in the expected outcome, name the one blocker that is required and say that
  a fix, the consequence and further blockers are optional. The judge treats
  every detail in the outcome as a requirement: listing the fix or a missing
  test there made it fail correct reviews;
- in the rubric notes, say what fails ("Fail the review if…") and which
  phrasings are acceptable, such as a blocker written as its fix;
- check the judge before relying on the case: one plausible bad review (the
  wrong verdict, or a `[REJECT]` for a real but different issue) must fail,
  and a correct review must pass.

`weft-review-corpus.test.ts` (`packages/cli/src/evals/__tests__/`) guards these
rules: every judged case starts `Change under review. Task:`, shows code, never
reaches the model with its expected outcome, and has notes saying what fails.

### Warp-security fixture guidance

`warp-security` cases must remain synthetic and text-observable. Encode the
security scenario entirely inside the case description or runner prompt so the
suite never depends on live scanners, exploit execution, real secrets, or
repository state outside the provided text. Score only security-review
structure the text runner can observe, such as:

- explicit `APPROVE` / `BLOCK` verdict lines
- bounded blocker-count lines like `BLOCKERS: 2/3`
- evidence-backed finding groups (`SEVERITY`, `FINDING`, `EVIDENCE`, `IMPACT`, `FIX`)
- file references inside evidence or remediation text

Avoid assertions about actual exploitability, scanner output, runtime behavior,
or whether a secret is truly live. The suite validates the review, not runtime
security behavior. Keep every value obviously fake: a case description must
pass through `redactSecrets` unchanged, which the corpus guard checks.

#### Judge-scored cases (`judge-scored` tag)

A deterministic verdict check cannot tell a BLOCK for the right reason from a
well-formed BLOCK for the wrong one, and Warp's prompt tells it to block when
security patterns appear. A case tagged `judge-scored` therefore puts a real
flaw behind a plausible guard and lets the judge decide whether a finding
names it:

- the description carries the change (inline code with line numbers, the
  context a reviewer would know) and never states the verdict;
- `required_artifacts` is empty, so the judge asks whether the review
  achieves `expected_outcome.description`, which starts `Block the change:`
  and names the flaw and an acceptable fix;
- the rubric notes say what fails: an APPROVE, and a BLOCK whose findings
  miss the flaw (name the tempting wrong findings, such as only a missing
  rate limit), and what is not scored (the output format).

The corpus guard (`packages/cli/src/evals/__tests__/warp-security-runner.test.ts`)
keeps that shape. Pair them with deterministic `judgment` approvals of changes
that only look dangerous, so a prompt cannot pass by blocking everything. The
first six, added for Spec 39 gap G3, cover a `startsWith` path check without a
trailing separator (`path-prefix-bypass`), a copy endpoint that never checks
the folder it writes into (`copy-target-authz`), a private-address check that
redirects bypass (`ssrf-redirect-bypass`), an unescaped dot in a CORS origin
pattern with credentials (`cors-origin-pattern`), prototype pollution through
a deep merge into an admin check (`prototype-pollution-merge`), and an async
signature check called without `await` (`unawaited-signature-check`). The
approvals beside them are SQL whose only user-chosen fragment comes from a
constant map (`guarded-parameterised-sql`) and credentialed CORS for an exact
list of company-run origins (`cors-exact-allowlist`), the counterpart of
`cors-origin-pattern`. An approval must not contradict an explicit rule in
Warp's prompt: a case that expects a model to override the prompt measures
the prompt, not the model.

### Judgment cases (`judgment` tag)

Most cases above test output *structure*: the description states the expected
verdict and the runner lists the required signal names in the user message. A
case tagged `judgment` instead tests whether the agent reaches the right
conclusion from evidence supplied in the description, so:

- the description carries the evidence (inline code with line numbers, a
  specialist report with its command output, the project's declared
  commands) and never states the expected verdict;
- runners withhold the required signal names
  (`buildRequiredSignalsLine` in `packages/cli/src/evals/judgment-cases.ts`),
  and the Tapestry and Shuttle runners drop their completion and
  section-script cues;
- judgment cases come in pairs, a case where the agent should act (block,
  re-delegate, verify) and its counterpart where it should not, so a prompt
  change cannot pass by shifting bias.

The signals stay deterministic. A traced review (`review_blocker_traced`,
`security_finding_traced`) has at least one blocker or finding that cites two
distinct code locations, meaning where the data comes from and where it is
used. For a Weft blocker, one end may be named by symbol instead of by path:
a blocker that cites the call site's path and names a function that, in the
case's code, the cited file calls and the case declares
(`src/commands/settings.ts:32` and `saveSettings`) is traced, while one that
names only the function containing the cited line, or cites a file that never
calls the function, is not. Other findings, such as a missing test, may sit at one location. Tapestry and Shuttle decision
signals ignore negated phrasing such as "I will not mark it complete".

### Text-only assertion boundary

Text-only cases may score only what is visible in the assistant transcript
text. (`harness_trajectory` cases are the separate runtime track; see
[Harness trajectory evals](../docs/agent-evals.md#harness-trajectory-evals).)
In text-only cases, runtime-only assertions are rejected fail-closed by
the shared contract in `packages/cli/src/evals/types.ts` and
`packages/cli/src/evals/case-loader.ts` before any dry-run or live execution.

Rejected examples include:

- `expected_outcome.kind: "tool_call"`
- `transcript_expectations.check: "tool_called"`
- `transcript_expectations.check: "no_tool_called"`
- `content_contains` with `role: "tool"`

Recommended authoring pattern for new cases:

1. choose one of the eight registered suites
2. encode the full scenario in fixture text and the synthetic runner prompt, with no hidden repo dependency
3. assert only structural, text-visible signals such as agent names, headings, verdict tags, file references, artifact names, blocker counts, and acceptance confirmations
4. verify with `weave eval run --case <case-id> --dry-run` before any live run

For research-style suites such as `spindle-tools`, network or tool usage is in
scope only when the model states it as plain text in the answer itself. Do not
assert hidden browser/search/network events.

### `transcript_expectations` checks

| `check`              | Required fields       | Description                                      |
| -------------------- | --------------------- | ------------------------------------------------ |
| `content_contains`   | `role`, `contains`    | Substring present in a message from `role`       |
| `tool_called`        | `tool_name`           | Tool appears at least once in transcript records |
| `agent_mentioned`    | `agent_name`          | Agent name appears in at least one assistant msg |
| `no_tool_called`     | `tool_name`           | Negative assertion: tool must NOT appear         |

The table above describes the shared schema surface, not the current per-suite allowlist. For the eight registered text-only suites, contributors may safely use only text-visible checks. `tool_called`, `no_tool_called`, and `content_contains` with `role: "tool"` are forbidden by the suite registry even though they still exist in the broader schema for future expansion.

## Rubric Files (`rubrics/<suite>/<case-id>.json`)

Each rubric matches a case by `case_id` and defines the scoring weights. Rubrics are loaded independently from cases by the runner.

### Rubric Schema

```jsonc
{
  "case_id": "loom-route-backend-api",    // Must match a case fixture id exactly
  "suite": "loom-routing",               // Must match the case fixture suite
  "scoring": {
    "outcome_weight": 0.8,              // Weight for primary expected outcome (0.0–1.0)
    "per_expectation_weight": 0.2,      // Weight per passing transcript expectation (default: 0)
    "required": true,                   // Block suite green if this case fails (default: true)
    "notes": "..."                      // Optional human-readable notes (ignored by runners)
  }
}
```

## Identifiers

All `id`, `suite`, agent name, and model ID fields must satisfy the identifier pattern:

```
/^[A-Za-z0-9_./:@-]+$/
```

This keeps identifiers unambiguous as `--case`, `--agent`, and `--model` filter values.

## Adding a New Case

1. Create `evals/cases/<suite>/<case-id>.json` following the case schema above.
2. Add the corresponding `evals/rubrics/<suite>/<case-id>.json` rubric file.
3. Ensure the case `id` exactly matches the rubric `case_id` and the JSON filename (without `.json`).
4. If referencing a new agent name in `allowed_agents`, add it to `KNOWN_AGENTS` in `packages/cli/src/evals/case-loader.ts`.
5. If adding a new suite, register it in `packages/cli/src/evals/types.ts` and wire the shared registry/orchestrator/workflow/doc path so CLI filters, workflow allowlists, prompt snapshots, and loader policy stay in sync.
6. Run `bun test ./packages/cli/src/evals/__tests__` to validate all fixtures load cleanly.
7. Run a local dry run to verify the case is picked up: `weave eval run --case <case-id> --dry-run`.
8. Run a live local eval to confirm scoring: `weave eval run --case <case-id>` (requires `OPENROUTER_API_KEY`).

### Diagnose one case

To see why one case fails on one model, run only that case on only that model,
locally, with raw artifacts on (requires `OPENROUTER_API_KEY`; nothing is
published):

```bash
bun packages/cli/src/main.ts eval run --agent <suite> --case <case-id> --model <model-id> --raw-artifacts
```

It prints the verdict, each applicable scoring dimension of a failed case with
its score (`✗` below its bar), and the path of the raw transcript file under
`eval-bundles/runs/<run-id>/raw/`. That file holds the prompt, the answer and
the judge's rationales; it is local only. The judge is TypeSafe Jev: it reads
the case's rubric (including the rubric's `scoring.notes`), its reference and
the answer itself, and its rationale names the criteria it answered "no" to
(see [The judge](../docs/agent-evals.md#the-judge)). A rubric note that asks
the judge to check something, such as "no invented commands", needs the case
to state what it checks against; the pattern-planning cases list their
commands in their description for that reason. Without `--raw-artifacts` you still
get the verdict and the scores, but no transcript. See
[Diagnose one case](../docs/agent-evals.md#diagnose-one-case) for a worked
example and why raw artifacts stay opt-in.

A case printed as `ERROR` rather than `FAIL` was never scored: the model's
answer was empty or cut off by the token cap each time it was asked, or the request
or the judge failed. It is not counted as a failure, and the run exits 1. See
[Empty and truncated answers](../docs/agent-evals.md#empty-and-truncated-answers-errored-cases).

Dry-run is the recommended contributor preflight path. It validates suite, model, and case allowlists without making model calls or requiring `OPENROUTER_API_KEY`. Valid dry runs exit `0`. Invalid dry runs exit non-zero because input validation still runs in dry-run mode.

### Filter semantics reminder

All filter values use **strict exact-match**. The `--case` value must exactly match the `id` field in the fixture — no glob, no prefix, no substring. Test new case IDs with `--dry-run` before running live.

## Loader API

The fixture loading and validation logic lives in the CLI package:

| Module                                              | Exports                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/cli/src/evals/types.ts`                   | Zod schemas and inferred TypeScript types for all fixture shapes      |
| `packages/cli/src/evals/model-matrix.ts`            | `loadModelMatrix`, `resolveDefaultModels`, `resolveDevModels`, `resolveModelSet`, `resolveCaseDefaultModels`, `filterMatrix`, `validateModelInMatrix` |
| `packages/cli/src/evals/case-loader.ts`             | `loadCaseFile`, `loadRubricFile`, `loadSuiteCases`, `loadSuiteRubrics`, `validateCaseFilter` |

All loader functions return `Result<T, FixtureSchemaError>` or `ResultAsync<T, FixtureSchemaError>` — errors include the offending file path for actionable diagnostics.

## What Must Never Be Committed Here

| Must not appear | Why |
|---|---|
| `OPENROUTER_API_KEY` values | Secret — would be exposed in repo history |
| `EVAL_RESULTS_REPO_TOKEN` values | Secret — would be exposed in repo history |
| Files under `raw/` subdirectory | Local-only raw artifacts; blocked from publish by sanitizer |
| Files containing `composedPrompt` or `rawContent` fields | Raw prompt text is local-only |
| `eval-bundles/` directory content | Bundle output; not fixture source |

See [`docs/agent-evals.md`](../docs/agent-evals.md) for the full sanitization rules and security checklist.
