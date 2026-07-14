# Agent Evals

This guide covers the eval architecture, fixture layout, CLI usage, filter semantics, prompt-hash provenance, artifact schema, sanitization rules, raw-artifact opt-in, and the CI artifact model. It is the contributor reference for everything related to `weave eval run`.

Related docs:

- [CLI](./cli.md) — `weave eval run` command surface, flags, and security warnings
- [Eval Sanitization and Publish Pipeline](./eval-sanitization-and-publish-pipeline.md) — allowlist sanitizer, deterministic bundle writer, raw-artifact writer, token-gated publish policy
- [Eval XSS Policy](./eval-xss-policy.md) — Markdown and report rendering XSS policy, allowlist rationale, and surface audit

---

## Architecture Overview

```
weave eval run
    │
    ├── parseEvalRunRequest()          Validate CLI flags + WEAVE_EVAL_* env vars
    │                                 Reject --raw-artifacts when CI=true
    │
    ├── readPublishMode()              Read WEAVE_EVAL_PUBLISH_MODE ("local" | "publish")
    │                                 Default: "local" (fail-safe)
    │
    ├── readEvalEnv()                  Require OPENROUTER_API_KEY (fail fast)
    │
    ├── loadModelMatrix()              Load evals/model-matrix.json
    │   └── resolveDefaultModels()     Apply --model filter or use default 3
    │
    ├── EvalOrchestrator.run()
    │   ├── executeSuites()            Fan out: suite runners from the shared registry
    │   │   └── (per model × per suite)
    │   ├── deriveProvenanceManifest() Hash prompts → PromptProvenanceManifest
    │   ├── ArtifactBundleWriter       Sanitize → write eval-bundles/runs/<sha7>-<date>-<NNN>/
    │   │   └── GitHubContentsPublisher  (publish mode only) → weave-io/weave-agent-evals
    │   └── RawArtifactsWriter?        (--raw-artifacts only) write raw/ subdirectory
    │
    └── EvalRunSummary                 Returned to CLI handler (reporting status)
```

All publishable output passes through the central allowlist sanitizer in `packages/cli/src/evals/sanitizer.ts` before being written. Raw artifacts are written to a separate `raw/` subdirectory that is never included in publishable bundles or external publication.

---

## Fixture Layout

The fixture tree is intentionally flat and registry-shaped. The shared eval suite registry defines the current eight-suite text-only surface, and each registered suite gets exactly one case directory and one rubric directory. Contributors should treat those suite IDs as the canonical names used by CLI filters, workflow inputs, prompt snapshot coverage, sync tests, and publishable reporting.

```
evals/
├── model-matrix.json              Canonical model allowlist (default 3 models)
├── cases/
│   ├── loom-routing/              Loom agent routing eval cases
│   │   └── <case-id>.json
│   ├── tapestry-execution/        Tapestry execution/delegation eval cases
│   │   └── <case-id>.json
│   ├── tapestry-category-routing/ Tapestry category-routing eval cases
│   │   └── <case-id>.json
│   ├── shuttle-execution/         Shuttle delegated-task reporting eval cases
│   │   └── <case-id>.json
│   ├── spindle-tools/             Spindle research-structure eval cases
│   │   └── <case-id>.json
│   ├── pattern-planning/          Pattern planning structure eval cases
│   │   └── <case-id>.json
│   ├── weft-review/               Weft review-structure eval cases
│   │   └── <case-id>.json
│   └── warp-security/             Warp security-review structure eval cases
│       └── <case-id>.json
└── rubrics/
    ├── loom-routing/              Scoring rubrics keyed by case ID
    │   └── <case-id>.json
    ├── tapestry-execution/
    │   └── <case-id>.json
    ├── tapestry-category-routing/
    │   └── <case-id>.json
    ├── shuttle-execution/
    │   └── <case-id>.json
    ├── spindle-tools/
    │   └── <case-id>.json
    ├── pattern-planning/
    │   └── <case-id>.json
    ├── weft-review/
    │   └── <case-id>.json
    └── warp-security/
        └── <case-id>.json
```

Case and rubric files are co-named: `evals/cases/loom-routing/foo.json` must have a corresponding `evals/rubrics/loom-routing/foo.json` with `"case_id": "foo"`.

### Source layout (CLI package)

```
packages/cli/src/evals/
├── types.ts                  Zod schemas and inferred types for all fixture shapes
├── case-loader.ts            loadCaseFile, loadRubricFile, loadSuiteCases
├── model-matrix.ts           loadModelMatrix, resolveDefaultModels, filterMatrix
├── input-validation.ts       parseEvalRunRequest — CLI flags + env normalization
├── prompt-snapshots.ts       Compose agent prompts, produce PromptSnapshot records
├── provenance.ts             Derive PromptProvenanceRecord and manifest
├── sanitizer.ts              Central allowlist sanitizer (source of truth)
├── artifact-bundle.ts        ArtifactBundleWriter — deterministic bundle write
├── raw-artifacts.ts          RawArtifactsWriter — local-only raw artifact write
├── results-repo.ts           ResultsRepoPublisher interface + NoOp/Stub impls
├── github-contents-publisher.ts  GitHubContentsPublisher — production GitHub REST publisher
├── runner.ts                 EvalOrchestrator — top-level orchestration
├── loom-routing-runner.ts    LoomRoutingRunner
├── tapestry-execution-runner.ts  TapestryExecutionRunner
├── tapestry-category-routing-runner.ts  TapestryCategoryRoutingRunner
├── shuttle-execution-runner.ts   ShuttleExecutionRunner
├── spindle-tools-runner.ts       SpindleToolsRunner
├── pattern-planning-runner.ts    PatternPlanningRunner
├── weft-review-runner.ts         WeftReviewRunner
├── warp-security-runner.ts       WarpSecurityRunner
├── openrouter-client.ts      OpenRouterClient for model inference
├── langchain-agent-evals.ts  LangChainAgentEvalsScorer (rubric scoring judge)
├── dashboard-indexes.ts      DashboardIndexWriter — derived mutable dashboard indexes
└── env.ts                    readEvalEnv — OPENROUTER_API_KEY validation
```

And in `packages/cli/src/commands/eval.ts`:

- `readPublishMode(env)` — reads `WEAVE_EVAL_PUBLISH_MODE` and returns `"local"` or `"publish"` (default: `"local"`).
- `WEAVE_EVAL_PUBLISH_MODE_ENV_VAR` — the constant `"WEAVE_EVAL_PUBLISH_MODE"`.

---

## Eval Suites

Weave currently supports an **eight-suite text-only eval surface**. Every registered suite is synthetic and text-observable by design.

| Suite | Runner | What it tests |
|---|---|---|
| `loom-routing` | `LoomRoutingRunner` | Loom emits text-observable routing signals for the primary route, with evidence/review follow-ups treated separately from the primary implementation agent |
| `tapestry-execution` | `TapestryExecutionRunner` | Tapestry emits text-observable completion and delegation-chain signals for plan execution |
| `tapestry-category-routing` | `TapestryCategoryRoutingRunner` | Tapestry emits text-observable category routing signals when delegating to category shuttles |
| `shuttle-execution` | `ShuttleExecutionRunner` | Shuttle emits bounded delegated-task completion reports with task intake reflection, file awareness, acceptance confirmation, and final evidence reporting from assistant text |
| `spindle-tools` | `SpindleToolsRunner` | Spindle emits source-cited research structure with explicit `Source facts`, `Interpretation`, `Sources`, and bounded confidence from assistant text |
| `pattern-planning` | `PatternPlanningRunner` | Pattern emits structurally explicit plans with observable scope, file-task, sequencing, and acceptance signals |
| `weft-review` | `WeftReviewRunner` | Weft emits structurally explicit review verdicts, blocker counts, and actionable file-cited approval or rejection signals |
| `warp-security` | `WarpSecurityRunner` | Warp emits structurally explicit security triage, capped blocker counts, and evidence-backed findings from assistant text |

All suites share the same case schema, rubric schema, and model matrix. The shared suite registry is the source of truth for suite IDs, short `--agent` aliases, prompt snapshot coverage, and registry-driven sync tests. Suites are run in parallel across all models in the effective model set.

The current eval runners are **text-only prompt evals**: they call OpenRouter chat completions and extract signals from assistant text. They do not execute harness tools, inspect side effects, or capture real tool-call telemetry. Fixture authors should therefore assert observable text signals such as agent mentions, routed agents, delegation chains, completion phrases, and produced artifact names. Do not use a text-only fixture to require unobservable runtime behavior. Reserve those checks for a future harness-backed trajectory runner.

### 2026-07-01 Loom routing stabilization, primary vs exploratory route rules

The Loom suite now makes the routing contract more explicit so regressions are explainable without prompt rewrites.

- The scorer still evaluates only text-visible routing signals.
- Dynamic category shuttles such as `shuttle-backend` and `shuttle-frontend` are canonicalized to the current text-only target `shuttle` for Loom scoring.
- `thread` is treated separately when the surrounding text clearly marks it as exploratory work, for example `Explore`, `Investigate`, `Survey`, or similar evidence-gathering phrasing.
- In the ambiguous direct-shuttle case, an answer can mention exploratory `thread` work first and still count as an acceptable routing answer when the primary implementation handoff is explicitly `shuttle`.
- A pure `thread` route with no explicit implementation handoff remains a real miss, not a fairness win.

When contributors run `weave eval run --agent loom --case <case-id> --raw-artifacts`, the local raw artifact now includes `runnerDiagnostics.routingSignals` for Loom cases. Use that field to separate four failure reads:

1. `matched-primary-target`: the runner saw the expected primary implementation route.
2. `acceptable-but-nonprimary-exploratory-route`: the answer mentioned exploratory routing, usually `thread`, but still made `shuttle` the primary implementation handoff.
3. `wrong-primary-target`: the runner extracted a different primary implementation route.
4. `extraction-miss`: the runner could not extract any routing target at all.

This keeps the ambiguous case stable. It no longer swings on under-specified wording alone, and it distinguishes optional exploration from the implementation route that Loom is supposed to choose.

The eight current families are: `loom-routing`, `tapestry-execution`, `tapestry-category-routing`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, and `warp-security`.

### 2026-06-30 provisional baseline for phase-1 fairness work

This section is a historical baseline from Milestone 1. It describes the pre-cleanup state that informed later fairness work, not the current fixture contract.

This milestone baseline is intentionally low confidence. We currently have:

- one local dry-run on the current worktree (`bun packages/cli/src/main.ts eval run --dry-run`), which confirmed that the shipped suites/cases still validate and would execute
- one published live dashboard run today, `60c3ebd-2026-06-30-001`, from commit `60c3ebda45d49d2b413ef658d2d7cbacf57708c7`

That means the classification below is a **provisional evidence baseline**, not a stable benchmark. It is good enough to sequence phase 1, but not good enough to generalize about long-term prompt quality or model quality.

#### Evidence used for this baseline

1. Local dry-run on the current checkout, `bun packages/cli/src/main.ts eval run --dry-run`
2. Published dashboard manifest, `weave-io/weave-agent-evals/indexes/v1/dashboard-manifest.json` (`totalRuns: 1`)
3. Published live report bundle, `weave-io/weave-agent-evals/runs/v1/60c3ebd-2026-06-30-001/public-report.json`
4. Shipped fixtures in:
   - `evals/cases/loom-routing/*.json`
   - `evals/cases/tapestry-execution/*.json`
   - `evals/cases/warp-security/*.json`
   - `evals/cases/weft-review/*.json`
   - `evals/cases/pattern-planning/*.json`
5. Matching rubrics in:
   - `evals/rubrics/loom-routing/*.json`
   - `evals/rubrics/tapestry-execution/*.json`
   - `evals/rubrics/warp-security/*.json`
   - `evals/rubrics/weft-review/*.json`
   - `evals/rubrics/pattern-planning/*.json`
6. Current runner behavior in:
   - `packages/cli/src/evals/loom-routing-runner.ts`
   - `packages/cli/src/evals/tapestry-execution-runner.ts`
   - `packages/cli/src/evals/pattern-planning-runner.ts`
   - `packages/cli/src/evals/weft-review-runner.ts`
   - `packages/cli/src/evals/warp-security-runner.ts`

#### Suite-level triage

| Suite | Live run snapshot | Primary phase-1 label | Why |
|---|---:|---|---|
| `loom-routing` | 8/9 passed | runner issue | The only hard fail is `loom-route-ambiguous-direct-shuttle`, and the runner still carried legacy category-shuttle and evidence-gathering routing heuristics that could distort extraction. |
| `tapestry-execution` | 6/6 passed, all partial | case/rubric issue | Current cases pass, but the shipped rubric notes still described old tool-call style evidence that text-only evals do not actually score. |
| `warp-security` | 5/6 passed | prompt mismatch | The case/rubric contract already matches the runner's text-only structure fairly closely. The remaining miss is inconsistent output shape on `APPROVE` fast-exit formatting. |
| `weft-review` | 4/6 passed | prompt mismatch | `weft-review-reject-blocker-citation` fails when the answer does not reliably emit the strict review shape the runner scores, especially explicit blocker lines with file-cited action. |
| `pattern-planning` | 4/6 passed | case/rubric issue | The fixtures still lean on exact marker strings like `#scope` / `#files` / `#sequence` / `#acceptance`, while the documented contract says planning cases should stay structural rather than exact-tag dependent. |

#### Case-by-case classification

| Agent | Suite | Case | Live evidence | Label | Why this is the current best fit |
|---|---|---|---|---|---|
| Loom | `loom-routing` | `loom-route-backend-api` | pass/partial across all 3 models | drift cleanup | The case still allowed legacy category-shuttle aliases even though the current rubric already centered generic `shuttle`. This looked like stale fixture language, not an active scoring blocker. |
| Loom | `loom-routing` | `loom-route-frontend-ui` | pass/partial across all 3 models | drift cleanup | Same pattern as backend, the case still carried legacy category-shuttle aliases while the VNext text-only contract scored generic `shuttle`. |
| Loom | `loom-routing` | `loom-route-ambiguous-direct-shuttle` | 1 fail, 2 partial | runner issue | This is the only Loom case with a true failure in the live run, and the runner still contains legacy route-name and evidence-gathering heuristics that can change which route is extracted first. |
| Tapestry | `tapestry-execution` | `tapestry-delegate-to-shuttle` | partial across all 3 models | case/rubric issue | The case still listed legacy category-shuttle alternates, and the rubric note still talked about delegate tool calls even though the current suite is text-only. |
| Tapestry | `tapestry-execution` | `tapestry-execute-plan-step` | partial across all 3 models | case/rubric issue | The rubric note still treated a tool-call style completion signal as primary even though that was no longer the real contract. The live partials were better explained by stale rubric language than by a runner bug. |
| Warp | `warp-security` | `warp-security-block-evidence-findings` | partial/pass across all 3 models | prompt mismatch | The runner, case, and rubric already agree on BLOCK plus evidence-backed findings. The remaining misses are about the model not always emitting the exact strong structure, not about unsupported assertions. |
| Warp | `warp-security` | `warp-security-fast-exit-approve` | 1 fail, 1 partial, 1 pass | prompt mismatch | The failing pattern is inconsistent fast-exit formatting (`APPROVE`, `BLOCKERS: 0/3`, no findings), which matches a prompt-output shape problem more than fixture drift. |
| Weft | `weft-review` | `weft-review-clean-approval` | pass across all 3 models | drift cleanup | This case is already behaving like a healthy text-only structural check. It still belongs in the phase-1 baseline, but it does not point to a runner or rubric bug today. |
| Weft | `weft-review` | `weft-review-reject-blocker-citation` | 1 partial, 2 fails | prompt mismatch | The runner wants explicit `[REJECT]` plus actionable `BLOCKER:` lines with file references. The case and rubric are already aligned with that structure, so the miss is primarily output-shape mismatch. |
| Pattern | `pattern-planning` | `pattern-plan-settings-refactor` | 2 pass, 1 fail | case/rubric issue | The case still requires exact marker text such as `#scope`, `#files`, `#sequence`, `#acceptance`, plus an `agent_mentioned: pattern` check. That is stricter and more style-specific than the documented structural contract. |
| Pattern | `pattern-planning` | `pattern-plan-release-checklist` | 2 partial, 1 fail | case/rubric issue | This case also leans on exact marker strings instead of purely structural planning signals, so it is better classified as fixture-contract cleanup first. |

#### What phase 1 should assume from this baseline

- Start with **runner fairness** for Loom first.
- Treat **Tapestry** as mostly a case/rubric contract cleanup problem before touching prompts.
- Treat **Warp** and **Weft** as likely prompt-shape problems unless new local live evidence shows runner or fixture drift.
- Treat **Pattern** as fixture-contract cleanup first, because the current cases are more style-coupled than the documented structural contract.
- Reconfirm all of the above after the next live/local checkpoint, because one dashboard run is not enough to claim stability.

### 2026-06-30 phase 1B fixture-alignment cleanup

Phase 1B keeps the scoring contract explicit: this work is **fixture/rubric fairness**, not prompt tuning.

- Loom routing cases now describe direct text-visible routing only. They no longer encode legacy category-shuttle alternates, and the ambiguous fallback case no longer requires an evidence-gathering pre-hop.
- Tapestry execution cases and rubric notes now describe only text-visible delegation or completion. They do not talk about hidden runtime progress or tool-call-only evidence.
- Pattern planning cases now rely on structural artifacts only. Exact transcript checks for `#scope`, `#files`, `#sequence`, `#acceptance`, or self-identification as `pattern` are intentionally out of contract.
- Warp and Weft rubric notes now say out loud that they score only observable assistant-text review structure. They do not reward taste, tone, or hidden repository context.

### 2026-06-30 phase 1 checkpoint rerun and fairness gate

This checkpoint reran the narrowed local evidence after the runner and fixture fairness work landed.

#### Commands used

1. Dry-run preflight: `bun packages/cli/src/main.ts eval run --dry-run`
2. Narrow live suite reruns:
   - `bun packages/cli/src/main.ts eval run --agent loom`
   - `bun packages/cli/src/main.ts eval run --agent tapestry`
   - `bun packages/cli/src/main.ts eval run --agent warp`
   - `bun packages/cli/src/main.ts eval run --agent weft`
   - `bun packages/cli/src/main.ts eval run --agent pattern`
3. Single-case raw-artifact spot checks:
   - `bun packages/cli/src/main.ts eval run --agent loom --case loom-route-ambiguous-direct-shuttle --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent tapestry --case tapestry-execute-plan-step --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent warp --case warp-security-fast-exit-approve --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent weft --case weft-review-reject-blocker-citation --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent pattern --case pattern-plan-settings-refactor --raw-artifacts`

#### Local checkpoint summary

| Agent | Evidence | Result | Gate read |
| --- | --- | --- | --- |
| Loom | suite rerun `06e5f44-2026-06-30-002`, raw case rerun `06e5f44-2026-06-30-007` | suite `5/9` passed, narrowed case `2/3` passed | Remaining miss is no longer a fairness problem. The failing raw output delegated to `thread` first instead of routing directly to `shuttle`, which is a prompt-orchestration choice. |
| Tapestry | suite rerun `06e5f44-2026-06-30-003`, raw case rerun `06e5f44-2026-06-30-008` | suite `6/6` passed, narrowed case `3/3` passed | No remaining fairness blocker in this suite. The contract is coherent enough to leave phase 1. |
| Warp | suite rerun `06e5f44-2026-06-30-004`, raw case rerun `06e5f44-2026-06-30-009` | suite `5/6` passed, narrowed case `2/3` passed | Remaining miss is structural. The failing output used bracketed verdict style (`[APPROVE]`) while the case expects the plain fast-exit verdict line (`APPROVE`). |
| Weft | suite rerun `06e5f44-2026-06-30-005`, raw case rerun `06e5f44-2026-06-30-010` | suite `4/6` passed, narrowed case `1/3` passed | Remaining misses are structural. The builtin review format prefers a numbered “Blocking Issues” block, while the case expects strict `BLOCKER:` lines with the exact rejection shape. |
| Pattern | suite rerun `06e5f44-2026-06-30-006`, raw case rerun `06e5f44-2026-06-30-011` | suite `4/6` passed, narrowed case `2/3` passed | Remaining miss is structural. The failing output acknowledged the task but did not emit the requested inline plan artifacts at all. |

#### Decision record

**Decision**: yes, phase 2 prompt work is justified.

The checkpoint evidence is now good enough to say the remaining misses are **mostly prompt-output structure and prompt-behavior misses, not eval unfairness**:

- Loom still misses when it chooses an exploratory `thread` pre-hop instead of the now-correct direct text routing contract.
- Tapestry is green after the fairness/alignment work, which is the clearest sign that the runner and fixtures are no longer the main problem there.
- Warp still misses on fast-exit formatting shape, not on impossible assertions.
- Weft still misses on verdict and blocker formatting shape, not on hidden runtime expectations.
- Pattern still misses when it declines to emit the requested plan structure, not because the case requires unsupported tags or tool telemetry.

This remains a **directional local checkpoint**, not a long-term benchmark. We still have only one published dashboard run, so the conclusion is limited to the current local fast loop: phase 1 fairness work is sufficient, and the next justified step is prompt-focused phase 2 work for Loom, Warp, Weft, and Pattern.

### 2026-07-01 regression freeze for Pattern and Loom

Before changing `pattern-planning` cases, rubrics, runners, or prompts, freeze the comparison baseline around the two known published runs:

- baseline run: `60c3ebd-2026-06-30-001`
- latest regression run: `40c1cee-2026-07-01-001`

This is the required evidence pack for the stabilization work. Do not start prompt tuning from memory, one screenshot, or one model-specific anecdote.

#### Known published comparison

| Scope | `60c3ebd-2026-06-30-001` | `40c1cee-2026-07-01-001` | Delta | Read |
| --- | ---: | ---: | ---: | --- |
| Overall | `31/45` | `30/45` | `-1` | Small global movement, so this does **not** look like a total eval outage. |
| `pattern-planning` | `4/6` | `1/6` | `-3` | Sharp regression, strong enough to block prompt work until the suite is revalidated. |
| `loom-routing` | `8/9` | `5/9` | `-3` | Same pattern as Pattern, large suite-local regression rather than harmless noise. |
| `shuttle-execution` | improved | improved | n/a | Improvement elsewhere is part of the evidence that the failure is not system-wide. |
| `spindle-tools` | improved | improved | n/a | Same read, the regression is concentrated in Pattern and Loom. |

#### Observed model inconsistency to preserve

Treat these as the comparison facts that must be checked first in local reruns:

- the regressions are **not** assumed to be uniform across the default model matrix
- Sonnet is the main regression suspect called out by the current stabilization plan
- GPT-5.5 is the main counterexample suspect, meaning some apparent wins may be model-specific rather than stable suite improvements
- because of that split, a single-model improvement does **not** justify prompt edits

If a rerun improves only one model while another default model still regresses, the correct read is still "blocked, gather more evidence."

#### Stabilization hypotheses to test before any edits

1. **Pattern runner detection drift**: the model emitted a structurally valid plan, but `pattern-planning` artifact extraction missed it.
2. **Pattern fixture phrasing drift**: the cases or rubrics over-prefer one formatting style and convert harmless variation into a failure.
3. **Loom route extraction drift**: the runner extracted a non-primary route first, especially in the ambiguous direct-shuttle case.
4. **Loom case semantics drift**: the case wording invites exploratory `thread` behavior that the text-only contract should treat separately from the primary route.
5. **Real prompt or model regression**: the assistant truly omitted required planning or routing structure.
6. **Cross-model instability**: one model got better while another got worse, so the change is not yet trustworthy enough for prompt work.

Keep this list explicit in notes and rerun summaries. The whole point of the stabilization pass is to decide which of these hypotheses survives contact with repeatable evidence.

#### Required local reproduction workflow

Run these commands in order before touching Pattern or Loom fixtures, rubrics, runners, or prompts.

1. Dry-run preflight:

   - `bun packages/cli/src/main.ts eval run --dry-run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --dry-run --agent loom`

2. Full targeted suite reruns across the default model set:

   - `bun packages/cli/src/main.ts eval run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --agent loom`

3. Per-model isolation reruns for Pattern:

   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-opus-4.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5`

4. Per-model isolation reruns for Loom:

   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-opus-4.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5`

5. Raw-artifact spot checks for the shipped Pattern cases:

   - `bun packages/cli/src/main.ts eval run --agent pattern --case pattern-plan-settings-refactor --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent pattern --case pattern-plan-release-checklist --raw-artifacts`

6. Raw-artifact spot checks for the shipped Loom cases:

   - `bun packages/cli/src/main.ts eval run --agent loom --case loom-route-backend-api --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent loom --case loom-route-frontend-ui --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent loom --case loom-route-ambiguous-direct-shuttle --raw-artifacts`

#### What to record from that workflow

For each suite, collect all of the following before making changes:

- suite-level pass count for the default matrix
- per-model pass counts for Opus, Sonnet, and GPT-5.5
- failing or partial case IDs
- raw-output evidence showing whether the model omitted required structure or the runner failed to detect it
- whether the miss repeats across reruns or appears one-run noisy

#### What counts as regression confirmation

Treat the regression as confirmed when all three are true:

1. the dry-run passes, so fixture loading and filter validation are not the immediate problem
2. a targeted rerun still lands materially below the `60c3ebd-2026-06-30-001` baseline for the same suite, or reproduces the same failing case pattern seen in `40c1cee-2026-07-01-001`
3. the per-model and raw-artifact evidence still leaves either a repeatable extraction problem or a repeatable model-output miss

If you cannot satisfy all three, do not claim a stable regression yet.

#### Why prompt work is still blocked

Prompt work stays blocked until this evidence pack exists because the current comparison still leaves open three competing explanations: runner extraction drift, fixture-contract drift, and real prompt or model regression. The Pattern and Loom deltas are large enough to matter, but the model inconsistency is also large enough that a prompt edit could easily optimize one model while making the default matrix less stable overall.

Only after the commands above are rerun and the hypotheses are narrowed should case, rubric, runner, or prompt changes begin.

### 2026-06-30 phase 2 checkpoint rerun and prompt-quality gate

This checkpoint reran the highest-ROI prompt suites after Milestones 6-8 and compared them to the phase-1 checkpoint. The goal was simple: separate real structural gains from one-off formatting wins.

#### Commands used

1. Dry-run preflight: `bun packages/cli/src/main.ts eval run --dry-run`
2. Targeted phase-2 suite reruns:
   - `bun packages/cli/src/main.ts eval run --agent weft`
   - `bun packages/cli/src/main.ts eval run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --agent shuttle`
   - `bun packages/cli/src/main.ts eval run --agent spindle`
3. Cross-suite smoke on one shared model:
   - `bun packages/cli/src/main.ts eval run --model anthropic/claude-sonnet-4.5`

#### Comparison against the phase-1 checkpoint

| Suite | Phase-1 checkpoint | Phase-2 targeted rerun | Cross-suite smoke | Read |
| --- | --- | --- | --- | --- |
| `weft-review` | `4/6` passed, run `06e5f44-2026-06-30-005` | `5/6` passed, run `06e5f44-2026-06-30-012` | `0/2` passed on Sonnet, run `06e5f44-2026-06-30-017` | There is a real but narrow gain: `weft-review-reject-blocker-citation` improved from `1/3` models passing to `2/3`. That is still fragile. The Sonnet smoke run failed both Weft cases, so the improvement is not stable across models. |
| `pattern-planning` | `4/6` passed, run `06e5f44-2026-06-30-006` | `2/6` passed, run `06e5f44-2026-06-30-016` | `2/2` passed on Sonnet, run `06e5f44-2026-06-30-017` | This is the clearest overfit signal in the checkpoint. Sonnet got cleaner structure, but Opus and GPT-5.5 regressed hard enough to push the full suite backward. That is a model-specific formatting win, not a robust prompt improvement. |
| `shuttle-execution` | no phase-1 checkpoint rerun, this suite was out of Milestone 5 scope | `4/6` passed, run `06e5f44-2026-06-30-014` | `2/2` passed on Sonnet, run `06e5f44-2026-06-30-017` | The prompt now elicits the desired report shape more reliably, especially on `shuttle-execution-report-tests-and-assumptions`. Still, there is no true phase-1 checkpoint baseline for this suite, so this is promising directional evidence, not proof that more prompt work will pay off. |
| `spindle-tools` | no phase-1 checkpoint rerun, this suite was out of Milestone 5 scope | `4/6` passed, run `06e5f44-2026-06-30-015` | `0/2` passed on Sonnet, run `06e5f44-2026-06-30-017` | No stable gain is visible. Both Spindle cases stayed below green in the three-model rerun and both failed again in the Sonnet smoke. This still looks like prompt-output instability, not a clean structural improvement. |

#### Guard-suite read from the cross-suite smoke

- `tapestry-execution` stayed green at `2/2` on Sonnet in run `06e5f44-2026-06-30-017`.
- `warp-security` stayed green at `2/2` on Sonnet in run `06e5f44-2026-06-30-017`.
- `loom-routing` fell to `1/3` on Sonnet in the same smoke run, but Loom was not part of the phase-2 prompt batch. Treat that as directional noise for now, not as evidence that the phase-2 prompt edits helped or hurt Loom.

#### Decision record

**Decision**: stop further prompt work for now.

The phase-2 rerun does not show the kind of broad, repeatable gain that would justify another prompt-tuning round:

- Weft improved, but only narrowly, and the improvement disappeared in the shared Sonnet smoke.
- Pattern regressed overall, which is strong evidence of model-specific overfitting.
- Shuttle looks better, but it lacks a phase-1 checkpoint baseline, so we cannot honestly call it a phase-2 win yet.
- Spindle still fails in the same general place, with no cross-model strengthening signal.

The honest read is that phase 2 found a few useful structure nudges, but not a stable multi-model quality lift. The next step should be to stop prompt tuning and return to evidence collection or eval cleanup if more work is needed, rather than chase more formatting-sensitive prompt edits.

### 2026-06-30 final decision gate, rubric and recommendation

This is the final gate for Milestone 10. The rule is simple:

- Continue prompt work only when fairness and rubric alignment are stable, and the remaining misses are mostly honest answers that fail on consistent output structure.
- Return to eval cleanup when failures still point to runner ambiguity, rubric wording drift, stale fixture assumptions, missing baseline evidence, or model-to-model instability large enough that prompt edits would mostly chase one-model wins.

#### Explicit answers

1. **What was rerun after phase 1?**
   - Dry-run preflight: `bun packages/cli/src/main.ts eval run --dry-run`
   - Narrow live suite reruns: `--agent loom`, `--agent tapestry`, `--agent warp`, `--agent weft`, `--agent pattern`
   - Single-case raw-artifact spot checks: `loom-route-ambiguous-direct-shuttle`, `tapestry-execute-plan-step`, `warp-security-fast-exit-approve`, `weft-review-reject-blocker-citation`, `pattern-plan-settings-refactor`

2. **What was rerun after phase 2?**
   - Dry-run preflight: `bun packages/cli/src/main.ts eval run --dry-run`
   - Targeted prompt-suite reruns: `--agent weft`, `--agent pattern`, `--agent shuttle`, `--agent spindle`
   - Cross-suite one-model smoke: `bun packages/cli/src/main.ts eval run --model anthropic/claude-sonnet-4.5`

3. **What evidence justifies more prompt work versus more eval cleanup?**
   - Evidence would justify **more prompt work** only when a suite stays aligned after reruns and the misses remain mostly the same structural shape across models.
   - The current evidence instead justifies **more eval cleanup or more evidence collection before more prompt edits**:
     - `weft-review` improved only narrowly, `4/6` to `5/6`, and then failed `0/2` in the Sonnet smoke.
     - `pattern-planning` regressed overall, `4/6` to `2/6`, even though Sonnet alone looked better. That is overfit, not stable improvement.
     - `shuttle-execution` looked promising at `4/6`, but it had no true phase-1 checkpoint baseline, so it is not honest evidence for another prompt round yet.
     - `spindle-tools` stayed unstable, `4/6` in the targeted rerun and `0/2` in the Sonnet smoke.
     - Guard suites matter too: `tapestry-execution` and `warp-security` stayed green in the smoke, while `loom-routing` dropped to `1/3` on Sonnet. That keeps the overall picture too noisy to claim prompt stability.

#### Final recommendation

**Recommendation: stop further prompt work for now and return to eval cleanup / evidence gathering.**

The deciding factor is not that prompt edits never helped. They did help in a few narrow places. The problem is that the gains were not stable enough across reruns or across models to justify another prompt-only loop. The strongest signals after phase 2 are still checkpoint honesty problems: missing baseline parity for some suites, model-specific drift, and regressions large enough that another prompt pass would likely optimize for one model while making the multi-model picture worse.

In short, the final rubric lands on the eval-cleanup side, not the prompt-work side.

### Text-only contract and explicit non-goal

Current evals are for **assistant-text structure only**. They are not runtime-backed harness evals. That means:

- supported assertions must be visible in plain user or assistant text
- hidden tool telemetry, shell history, filesystem mutation, browser events, and network traces are out of scope
- runtime-backed trajectory evals are an explicit non-goal of the current fixture contract and must not be encoded into present-day cases

The CLI now enforces that contract **before any dry-run or live model execution**. Each suite is registered in a shared metadata registry (`packages/cli/src/evals/types.ts`) that defines:

- the canonical suite ID
- the accepted short `--agent` filter
- the allowed `expected_outcome.kind` values for that suite
- the allowed `transcript_expectations` checks and roles for text-only evals

Fail-closed consequences:

- unknown suite IDs are rejected before fixture discovery/execution
- `tool_call` expected outcomes are rejected for current text-only suites
- `tool_called`, `no_tool_called`, and `content_contains` with `role: "tool"` are rejected for current text-only suites
- workflow-dispatch agent allowlists and CLI agent filters are expected to mirror the same registry

Forbidden assertion shapes in the current eight-suite surface are therefore:

- `expected_outcome.kind: "tool_call"`
- `transcript_expectations.check: "tool_called"`
- `transcript_expectations.check: "no_tool_called"`
- `transcript_expectations.check: "content_contains"` with `role: "tool"`

### Recommended authoring pattern for new cases

When adding a new case, start from the text the runner can actually score:

1. pick one of the eight registered suites
2. encode the whole scenario in the case description and suite prompt shape, with no hidden repo or runtime dependency
3. choose only suite-allowed `expected_outcome.kind` values
4. use `transcript_expectations` only for text-visible checks on `user` or `assistant` roles
5. prefer structural markers over semantic judgment, for example headings, verdict lines, agent names, file references, artifact names, blocker counts, and acceptance confirmations
6. verify the case with `weave eval run --case <case-id> --dry-run` before any live run

If the dry run fails, treat that as a contract problem, not as a harmless preview warning. Dry-run is intentionally fail-closed for invalid suite filters, model filters, case IDs, and text-only assertion violations.

Tapestry eval prompts include a minimal synthetic plan context (`Plan file`, remaining `- [ ]` task, and todo state) so the prompt, runner input, and fixture expectations all describe plan execution rather than a free-floating chat request.

Shuttle execution prompts likewise inject a synthetic delegated task envelope (`Task [N/M]`, `What`, `Files`, `Acceptance`, context, and learnings) and score only what the final report says about completion. Cases pass only when the assistant mirrors that structure and reports bounded evidence such as files changed, commands/tests run, assumptions, and explicit acceptance confirmation.

The default Shuttle prompt is aligned to that contract too. It now tells Shuttle to restate the task in a compact `Task intake` section, then report `Files changed`, `Commands run and their output`, `Test results`, `Issues encountered or assumptions made`, and `Acceptance confirmation`. The honesty boundary is explicit: Shuttle must not claim hidden file-mutation proof, tool telemetry, browser activity, network activity, or other runtime evidence it did not directly observe.

Pattern planning eval prompts likewise constrain the model toward structural planning output. The shared contract is now the same in the builtin prompt and the eval runner: plans should make scope explicit with a `## Scope` section, make order explicit with dependency or ordering language such as `## Dependencies and Order` or `**Depends on**`, cite exact file paths in task-level `**Files**` fields, and include per-task acceptance criteria under `**Acceptance**`. The runner still accepts legacy `#scope` / `#files` / `#sequence` / `#acceptance` tags when they appear, but those tags are compatibility signals, not the primary contract. The runner projects only those deterministic structural signals into `required_artifacts` and completion signals before invoking the existing scorer path. This keeps planning assertions structural rather than semantic freeform wish-casting.

#### 2026-07-01 Pattern stabilization, structural alignment rules

The Pattern suite now draws a harder line between formatting variation and missing plan structure.

- Accepted as equivalent structure:
  - `## Scope` or `### Scope`
  - `## Dependencies and Order`, `## Order of Operations`, or task-level `**Depends on**`
  - task-level `**Files**`, `Files:`, or equivalent file fields with exact paths
  - task-level `**Acceptance**`, `Acceptance Criteria:`, `Success Criteria:`, or `Completion Criteria:`
- Not accepted as equivalent structure:
  - a top-level `## Files` section with no task-level file ownership
  - a final testing or verification note with no task-level acceptance coverage
  - vague prose that mentions files or order without observable task structure

When contributors run `--raw-artifacts` for Pattern cases, the local raw artifact now includes deterministic `runnerDiagnostics` for the planning extractor. Use that to separate two different failures:

1. **Runner failed to detect a valid plan**: raw output visibly contains task-level scope, files, order, and acceptance structure, but `runnerDiagnostics.missingRequiredArtifacts` still reports one or more missing artifacts.
2. **Model omitted required planning structure**: the raw output itself lacks one or more required task-level structures, and `runnerDiagnostics.missingRequiredArtifacts` matches that omission.

For the two shipped Pattern cases, the intended read is:

- `pattern-plan-settings-refactor`: task-level implementation planning, exact file ownership, explicit order, and per-task acceptance or success criteria
- `pattern-plan-release-checklist`: release-readiness sequencing with exact file ownership per task, not just a free-floating checklist or final verification block

This keeps the suite focused on observable planning shape while making local reruns explainable when regressions recur.

#### 2026-07-01 repeatability diagnostics for Pattern and Loom reruns

Pattern and Loom now write one extra local-only artifact on every non-dry run: `repeatability-diagnostics.json` in the run directory root next to `run-summary.json` and `public-report.json`.

- It is **developer diagnostics only**. It is not part of the published dashboard surface.
- It compares the current run only against earlier local runs with the **exact same filter tuple**: `agentFilter`, `modelFilter`, `caseFilter`, and effective suite list.
- That means `--agent loom --model anthropic/claude-sonnet-4.5 --case loom-route-backend-api` compares only to earlier reruns with those same three filters, not to a broader `--agent loom` suite run.
- The artifact shows drift at two levels:
  - per suite × per model pass-rate drift
  - per suite × per case × per model pass/fail drift

Use it to answer the question this milestone cares about: is a Sonnet regression or GPT-5.5 gain repeating across reruns, or did it happen once?

Key fields to read:

- `comparisonKey`: proves which reruns are actually comparable
- `comparableRunIds`: the exact prior runs included in the comparison set
- `driftSummary.models[*].classification`
  - `single-run`: only one comparable run exists, not enough evidence yet
  - `consistent`: same suite-level result for that model across comparable reruns
  - `drifted`: suite-level result changed across comparable reruns
- `driftSummary.caseModels[*].classification`
  - `single-run`: only one comparable run exists
  - `consistent-pass`: that case kept passing for that model
  - `consistent-fail`: that case kept failing for that model
  - `mixed`: that case flipped across comparable reruns

This is the shortest useful read:

- if Sonnet shows `drifted` or many `mixed` case-model entries, treat the regression as unstable and keep gathering evidence
- if GPT-5.5 shows `consistent` with mostly `consistent-pass` on the same cases across reruns, the gain is likely real instead of one-run noise
- if both models are still `single-run`, do not claim anything about stability yet

#### 2026-07-01 post-stabilization prompt authorization gate

The earlier 2026-06-30 phase-1 decision that prompt work looked justified is now historical context only. After the Pattern and Loom regression freeze, this is the controlling go/no-go gate for any new prompt edits.

Prompt work may begin only when **all** of the following are true:

1. **Stable local rerun pattern exists**
   - For `--agent pattern` and `--agent loom`, at least two comparable non-dry local reruns exist for the full-suite filter tuple.
   - For the currently suspect per-model reruns, at least two comparable non-dry local reruns exist per model.
   - `repeatability-diagnostics.json` shows no `single-run` status for the decision-making suite/model entries.
   - The relevant entries are mostly `consistent`, `consistent-pass`, or `consistent-fail`, not `drifted` or `mixed`.

2. **No unresolved Pattern fixture or runner ambiguity remains**
   - Raw artifacts and `runnerDiagnostics.missingRequiredArtifacts` agree on why each remaining Pattern failure happened.
   - If raw output visibly contains task-level scope, files, order, and acceptance structure, that extraction miss must be fixed before prompt work.
   - If case wording or rubric wording still leaves a reasonable formatting variant in doubt, that fixture ambiguity must be fixed before prompt work.

3. **No unresolved Loom fixture or runner ambiguity remains**
   - Raw artifacts and `runnerDiagnostics.routingSignals` agree on the failure class for each remaining Loom miss.
   - Any `extraction-miss`, `wrong-primary-target` caused by extraction order, or ambiguous exploratory-vs-primary read must be cleaned up before prompt work.
   - Prompt work is allowed only after the remaining misses are clearly real primary-route misses, not routing-classification uncertainty.

4. **At least one repeated cross-model checkpoint exists**
   - Run at least one full repeated checkpoint that includes Pattern and Loom across the default model matrix after the stabilization changes.
   - The checkpoint must be repeatable, meaning the same suite/model pattern appears in a later comparable rerun instead of only once.
   - A one-model win is not enough. The evidence must show how Opus, Sonnet, and GPT-5.5 behave together.

5. **The evidence pack is written down explicitly**
   - Record suite-level pass counts for the default matrix.
   - Record per-model pass counts for Opus, Sonnet, and GPT-5.5.
   - Record the failing or partial case IDs.
   - Record which raw artifacts prove model omission versus extractor miss.
   - Record the comparable local run IDs used by `repeatability-diagnostics.json`.

#### Go criteria: prompt work is authorized

Tapestry or Shuttle may authorize prompt edits only when the evidence says all of the following at the same time:

- Pattern reruns are repeatable enough that remaining failures classify as model output misses, not extractor or fixture uncertainty.
- Loom reruns are repeatable enough that remaining failures classify as real routing misses, not extraction-order or exploratory-route ambiguity.
- The same failure shape repeats across at least one repeated cross-model checkpoint.
- No required decision entry is still `single-run`.
- The planned prompt change is aimed at a repeated structural miss, not at a one-off model-specific formatting anecdote.

If those conditions hold, the next step may be prompt work.

#### No-go criteria: return to eval cleanup instead

Tapestry or Shuttle must stop prompt work and return to eval cleanup when **any** of the following is true:

- Pattern or Loom still has unresolved fixture wording ambiguity.
- Pattern or Loom still has unresolved runner extraction ambiguity.
- The latest evidence depends on only one comparable rerun for a relevant suite/model path.
- `repeatability-diagnostics.json` still shows `drifted` suite-model results or many `mixed` case-model results for the path driving the decision.
- The only visible improvement is model-specific, for example Sonnet improves while Opus or GPT-5.5 still regress.
- The cross-model checkpoint does not repeat cleanly in a later comparable rerun.
- The raw artifact cannot yet distinguish model omission from extractor miss.

When any no-go condition is hit, the correct next step is another round of eval cleanup or evidence gathering, not speculative prompt tuning.

#### Repeatable local workflow for Pattern and Loom

Run these as a matched rerun batch when comparing Pattern and Loom across the current model matrix.

1. Dry-run preflight once:

   - `bun packages/cli/src/main.ts eval run --dry-run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --dry-run --agent loom`

2. Full suite reruns, repeat at least twice per suite:

   - `bun packages/cli/src/main.ts eval run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --agent loom`
   - `bun packages/cli/src/main.ts eval run --agent loom`

3. Per-model reruns, repeat at least twice for each suspect model:

   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5`

4. Case-level spot checks with raw artifacts when a rerun still looks unstable:

   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5 --case pattern-plan-settings-refactor --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5 --case pattern-plan-release-checklist --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5 --case loom-route-ambiguous-direct-shuttle --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5 --case loom-route-backend-api --raw-artifacts`

#### How to read the rerun bundle quickly

For each run directory under `eval-bundles/runs/<runId>/`:

1. read `run-summary.json` for the suite-level pass count
2. read `repeatability-diagnostics.json` for whether the result is repeating or drifting
3. if the case-model classification is `mixed`, open the matching raw artifact and runner diagnostics to decide whether the flip came from output variance or extraction variance

That keeps the workflow local and repeatable without changing prompts or redesigning the published dashboard.

### 2026-07-01 post-stabilization local baseline for Pattern and Loom

This is the current handoff checkpoint after the Pattern and Loom stabilization work. It compares the new local reruns against both published reference runs and records the controlling read for any future prompt-specific follow-up.

#### Commands used

1. Dry-run preflight:
   - `bun packages/cli/src/main.ts eval run --dry-run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --dry-run --agent loom`
2. Full-suite reruns, repeated twice:
   - `bun packages/cli/src/main.ts eval run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --agent pattern`
   - `bun packages/cli/src/main.ts eval run --agent loom`
   - `bun packages/cli/src/main.ts eval run --agent loom`
3. Suspect per-model reruns, repeated twice:
   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5`
4. Raw-artifact spot checks:
   - `bun packages/cli/src/main.ts eval run --agent pattern --model anthropic/claude-sonnet-4.5 --case pattern-plan-settings-refactor --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent pattern --model openai/gpt-5.5 --case pattern-plan-release-checklist --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent loom --model anthropic/claude-sonnet-4.5 --case loom-route-ambiguous-direct-shuttle --raw-artifacts`
   - `bun packages/cli/src/main.ts eval run --agent loom --model openai/gpt-5.5 --case loom-route-backend-api --raw-artifacts`

#### Suite-level comparison against both published runs

| Suite | `60c3ebd-2026-06-30-001` | `40c1cee-2026-07-01-001` | Local repeated baseline | Read |
| --- | ---: | ---: | ---: | --- |
| `pattern-planning` | `4/6` | `1/6` | `3/6` in `07aad50-2026-07-01-001` and `07aad50-2026-07-01-002` | Improved from the regression run, still below the original published baseline. |
| `loom-routing` | `8/9` | `5/9` | `6/9` in `07aad50-2026-07-01-003` and `07aad50-2026-07-01-004` | Improved from the regression run, still below the original published baseline. |

#### Per-model evidence pack

| Suite | Model | `60c3ebd-2026-06-30-001` | `40c1cee-2026-07-01-001` | Local full-suite reruns | Local per-model reruns | Current read |
| --- | --- | ---: | ---: | --- | --- | --- |
| `pattern-planning` | Opus | `2/2` | `0/2` | `1/2`, consistent across `07aad50-...-001` and `...-002` | not isolated in this batch | Partial recovery, still below the older baseline. |
| `pattern-planning` | Sonnet | `2/2` | `1/2` | `2/2`, consistent across `07aad50-...-001` and `...-002` | `2/2` in `07aad50-...-005` and `...-006`, both consistent | Real improvement signal on Sonnet. |
| `pattern-planning` | GPT-5.5 | `0/2` | `0/2` | `0/2`, consistent across `07aad50-...-001` and `...-002` | `1/2` then `0/2` in `07aad50-...-007` and `...-008`, classified `drifted` | Still noisy and still blocked. |
| `loom-routing` | Opus | `2/3` | `1/3` | `2/3`, consistent across `07aad50-...-003` and `...-004` | not isolated in this batch | Recovered to the older baseline. |
| `loom-routing` | Sonnet | `3/3` | `1/3` | `1/3`, consistent at suite level across `07aad50-...-003` and `...-004` | `2/3` in `07aad50-...-009` and `...-010`, but case results are still `mixed` | Still noisy, the full-suite and isolated reads do not agree. |
| `loom-routing` | GPT-5.5 | `3/3` | `3/3` | `3/3`, consistent across `07aad50-...-003` and `...-004` | `3/3` in `07aad50-...-011` and `...-012`, both consistent | Stable green counterexample, not enough on its own to authorize prompt work. |

#### Current failing and unstable case IDs

- `pattern-planning`, full-suite local baseline:
  - Opus: `pattern-plan-release-checklist` failed in both repeated suite runs.
  - Sonnet: no failing cases in either repeated suite run.
  - GPT-5.5: `pattern-plan-release-checklist` and `pattern-plan-settings-refactor` failed in both repeated suite runs.
- `pattern-planning`, GPT-5.5 isolated reruns:
  - `pattern-plan-settings-refactor` stayed `consistent-fail`.
  - `pattern-plan-release-checklist` flipped from pass to fail and was classified `mixed`.
- `loom-routing`, full-suite local baseline:
  - Opus: `loom-route-ambiguous-direct-shuttle` failed in both repeated suite runs.
  - Sonnet: suite-level result stayed `1/3`, but the failing case set moved between `loom-route-ambiguous-direct-shuttle`, `loom-route-backend-api`, and `loom-route-frontend-ui`.
  - GPT-5.5: no failing cases in either repeated suite run.
- `loom-routing`, Sonnet isolated reruns:
  - `loom-route-backend-api` stayed `consistent-pass`.
  - `loom-route-ambiguous-direct-shuttle` and `loom-route-frontend-ui` were both classified `mixed`.

#### Raw-artifact read, model omission versus extractor miss

- `07aad50-2026-07-01-013`, `pattern-plan-settings-refactor`, Sonnet:
  - `runnerDiagnostics.detectedArtifacts` contains all four required planning artifacts.
  - `missingRequiredArtifacts` is empty.
  - Read: extractor looks healthy on the passing Sonnet path.
- `07aad50-2026-07-01-014`, `pattern-plan-release-checklist`, GPT-5.5:
  - the answer stopped at a clarifying question and never emitted a plan.
  - `missingRequiredArtifacts` lists all four required planning artifacts.
  - Read: this is a real model-output miss, not a Pattern extractor miss.
- `07aad50-2026-07-01-015`, `loom-route-ambiguous-direct-shuttle`, Sonnet:
  - `routingSignals.extractedAgents` contains only `thread`.
  - `routingSignals.classification` is `wrong-primary-target`.
  - Read: this miss is explainable as a real routing miss in that run, not an extraction-order bug.
- `07aad50-2026-07-01-016`, `loom-route-backend-api`, GPT-5.5:
  - `routingSignals.observedPrimaryTarget` is `shuttle`.
  - `routingSignals.classification` is `matched-primary-target`.
  - Read: Loom extraction still recognizes a clean direct handoff when the model gives one.

#### Repeatability read

- Full-suite comparable run IDs:
  - Pattern: `07aad50-2026-07-01-001`, `07aad50-2026-07-01-002`
  - Loom: `07aad50-2026-07-01-003`, `07aad50-2026-07-01-004`
- Per-model comparable run IDs:
  - Pattern Sonnet: `07aad50-2026-07-01-005`, `07aad50-2026-07-01-006`
  - Pattern GPT-5.5: `07aad50-2026-07-01-007`, `07aad50-2026-07-01-008`
  - Loom Sonnet: `07aad50-2026-07-01-009`, `07aad50-2026-07-01-010`
  - Loom GPT-5.5: `07aad50-2026-07-01-011`, `07aad50-2026-07-01-012`
- Pattern now has a repeatable full-suite `3/6` result, but GPT-5.5 still shows a `drifted` suite-model classification and a `mixed` release-checklist path.
- Loom now has a repeatable full-suite `6/9` result, but Sonnet still shows `mixed` case-model entries and its isolated `2/3` reruns do not match the full-suite `1/3` read.
- GPT-5.5 remains the stable positive counterexample for Loom, and Sonnet remains the stable positive counterexample for Pattern. Those one-model wins are useful diagnostics, but they do not satisfy the cross-model authorization gate by themselves.

#### Decision record

**Stabilized read: improved, still noisy.**

**Recommendation: more evidence/alignment needed.**

Why this is still the right call:

1. Pattern improved from the `1/6` published regression to a repeatable local `3/6`, but it still has not regained the older `4/6` published baseline and GPT-5.5 remains unstable.
2. Loom improved from the `5/9` published regression to a repeatable local `6/9`, but it still has not regained the older `8/9` published baseline and Sonnet still flips at the case level.
3. The raw artifacts are now good enough to separate clear model omissions from clear routing misses in the sampled cases, but the post-stabilization prompt authorization gate is still not met because relevant decision paths remain `drifted` or `mixed`, and the best-looking gains are still model-specific.

Until those noisy paths settle, treat this milestone as a documented baseline handoff, not as prompt authorization.

Weft review eval prompts are synthetic by design. The case description and runner prompt fully describe the review target so the suite never needs a live patch or hidden repository state. The runner scores only text-observable review structure: `[APPROVE]` or `[REJECT]`, a `Reviewed files:` line, blocker count, approval and rejection discipline, and actionable file references.

The builtin Weft prompt is intentionally aligned to that visible contract without lowering review standards. It now tells Weft to open with exactly one bracketed verdict tag, always name the reviewed files, and express merge-blocking findings as one actionable `BLOCKER:` line per issue with backticked file references. The honesty contract still applies: Weft must not invent runtime evidence, passing tests, or line numbers that were not actually provided in the review context.

Warp security eval prompts are synthetic by design too. The suite scores only text-observable security review structure: `APPROVE` or `BLOCK`, bounded blocker counts, and evidence-backed finding groups with file references. It does not attempt runtime exploit execution, live secret scanning, or exploit validation.

Spindle tools eval prompts are synthetic too. The suite scores only text-observable research structure: inline citations, a distinct `Source facts` section, a distinct `Interpretation` section, a bounded `Confidence:` line, and a final `Sources:` list. It does not attempt to prove that a browser, search tool, or network event actually occurred; those runtime-only assertions are rejected by the shared text-only fixture contract unless they are surfaced as ordinary plain-text claims in the answer.

The default Spindle prompt now reinforces the same visible structure. It asks for a short direct answer, a `Source facts` section containing only cited source-grounded claims, a separate `Interpretation` section, a `Sources` list with exact page or section references, and a final bounded confidence line. It also makes the runtime honesty rule explicit: Spindle may use network access when it is actually available, but it must never imply that live browsing or other tool activity definitely happened unless that happened in the current runtime.

---

## CLI Usage

```bash
# Run all suites against all default models (3 by default)
weave eval run

# Filter to a single agent suite
weave eval run --agent loom
weave eval run --agent tapestry
weave eval run --agent shuttle
weave eval run --agent spindle
weave eval run --agent pattern
weave eval run --agent weft
weave eval run --agent warp

# Filter to a single model
weave eval run --model anthropic/claude-sonnet-4.5

# Filter to a single case ID
weave eval run --case loom-route-backend-api
weave eval run --case shuttle-execution-report-structured-evidence
weave eval run --case spindle-tools-citations-facts-confidence
weave eval run --case weft-review-clean-approval
weave eval run --case warp-security-block-evidence-findings

# Combine filters (AND semantics — all three must match)
weave eval run --agent loom --model anthropic/claude-sonnet-4.5 --case loom-route-backend-api

# Dry run: print what would execute without making any model calls
weave eval run --dry-run

# Emit raw artifacts locally (NEVER in CI)
weave eval run --raw-artifacts
```

Filters can also be supplied via environment variables in CI workflows:

```bash
WEAVE_EVAL_AGENT=loom
WEAVE_EVAL_MODEL=anthropic/claude-sonnet-4.5
WEAVE_EVAL_CASE=loom-route-backend-api
```

`--dry-run` now exercises the same suite fixture/rubric loading path as a live run, so shipped case/rubric drift fails closed before any model call would happen. It still does **not** require `OPENROUTER_API_KEY` because dry-run skips model execution.

To enable external publication of results, set:

```bash
WEAVE_EVAL_PUBLISH_MODE=publish
EVAL_RESULTS_REPO_TOKEN=<token-with-write-access-to-weave-io/weave-agent-evals>
```

The default (`WEAVE_EVAL_PUBLISH_MODE` absent or any value other than `"publish"`) is always `"local"` — no external push occurs. This is intentionally fail-safe: an unknown or empty value always falls back to local mode.

CLI flags and env vars are merged: if both are set for the same filter key with different values, the run fails with a `DuplicateConflictingInput` error. Same-value duplicates are collapsed silently.

### Filter semantics

All three filters use **strict exact-match** semantics:

- `--agent` must exactly match either the suite name (`loom-routing`, `tapestry-execution`, `tapestry-category-routing`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, `warp-security`) or the short agent name (`loom`, `tapestry`, `shuttle`, `spindle`, `pattern`, `weft`, `warp`).
- `--model` must exactly match a model `id` in `evals/model-matrix.json`. No substring matching. If the value does not match any matrix entry, the run aborts with `EmptyModelSet` and lists the allowed IDs.
- `--case` must exactly match the `id` field in a case fixture file. No glob or prefix matching.

No filter means all values in that dimension are included. Default no-filter runs all three default models against all cases in all registered suites.

### Required environment variable for live runs

```
OPENROUTER_API_KEY=<your-key>
```

This variable must be set before any non-dry-run `weave eval run`. Dry runs skip model execution and do not require the key. Live runs validate the key at startup and abort with `EnvironmentError` if absent or empty. The key value is **never logged, printed, or serialized** — it is passed directly to the OpenRouter HTTP client and treated as a secret throughout.

---

## Prompt-Hash Provenance

Every eval run captures a **prompt provenance manifest** — a publishable JSON record that proves which prompt was composed for each agent without storing raw prompt text.

### Provenance record fields

| Field | Type | Description |
|---|---|---|
| `hash` | `string` | SHA-256 hex digest of the composed prompt (UTF-8) |
| `summary` | `string` | Sanitized human-readable description of prompt provenance |
| `byteLength` | `number` | Byte length of the composed prompt (UTF-8) |
| `charLength` | `number` | Character length of the composed prompt |
| `sources` | `SourceDescriptor[]` | Per-layer source descriptors: `builtin`, `file`, `inline`, or `generated` |
| `gitSha` | `string` | Git commit SHA at capture time |
| `capturedAt` | `string` | ISO 8601 timestamp |

The `hash` is deterministic: the same composed prompt always yields the same hash. Hash changes in CI signal prompt drift without exposing raw prompt content.

### What the manifest does NOT contain

- Raw prompt text
- Prompt template source
- Inline prompt strings
- Any `composedPrompt` field

---

## Artifact Bundle Schema

Each run writes an immutable bundle to a unique, sequenced directory under `eval-bundles/runs/`. The run ID has the form `<sha7>-<YYYY-MM-DD>-<NNN>` where `NNN` is a zero-padded three-digit sequence number that auto-increments by scanning existing `runs/` siblings. This guarantees no prior run's artifacts are ever overwritten even when the same commit is evaluated twice on the same calendar day.

In **`"publish"` mode** the sequence allocator is also **remote-aware**: before choosing the next `NNN`, `ArtifactBundleWriter` reads `indexes/v1/dashboard-manifest.json` from `weave-io/weave-agent-evals` (via `GitHubContentsPublisher.readRemoteRunIds`) to find the highest sequence already published for the same `<sha7>-<YYYY-MM-DD>` prefix. The next sequence is then `max(local_max, remote_max) + 1`. This prevents a CI rerun on the same commit+date from attempting to re-publish an already-taken run ID (e.g. `-001`) and instead allocates `-002`, `-003`, and so on.

If the remote manifest is absent (404), unavailable (network error), or unparseable (malformed JSON), the allocator falls back to local-only sequencing safely — it never hard-fails on a remote read error.

```
eval-bundles/
├── dashboard-manifest.json          Derived — all runs, newest-first (schemaVersion + updatedAt)
├── latest.json                      Derived — most-recent run aggregate (schemaVersion + updatedAt)
├── last-N-runs.json                 Derived — last 10 runs, newest-first (schemaVersion + updatedAt)
├── suite-history-loom-routing.json      Derived — pass-rate time series, oldest-first
├── suite-history-tapestry-execution.json
├── suite-history-shuttle-execution.json
├── suite-history-spindle-tools.json
├── suite-history-pattern-planning.json
├── suite-history-weft-review.json
├── suite-history-warp-security.json
├── scenario-history-loom-routing.json   Derived — per-case model-status history
├── scenario-history-tapestry-execution.json
├── scenario-history-shuttle-execution.json
├── scenario-history-spindle-tools.json
├── scenario-history-pattern-planning.json
├── scenario-history-weft-review.json
├── scenario-history-warp-security.json
└── runs/
    └── abc1234-2026-06-10-001/      Immutable run directory (NEVER overwritten)
        ├── bundle-index.json          Top-level manifest (publicFiles lists only allowlisted files)
        ├── run-summary.json           Aggregate pass/fail counts and per-suite rollups (internal)
        ├── score-loom-routing.json    Sanitized score records for loom-routing suite (internal)
        ├── score-tapestry-execution.json
        ├── score-shuttle-execution.json
        ├── score-spindle-tools.json
        ├── score-pattern-planning.json
        ├── score-weft-review.json
        ├── score-warp-security.json
        ├── prompt-hashes.json         Prompt hash records (no raw text) (internal)
        ├── provenance-manifest.json   Full sanitized provenance manifest (internal)
        ├── public-report.json         Public dashboard report (PublicReportBundle schema)
        └── public-report.md           Human-readable Markdown report (download-only)
```

**Immutable run directories**: a second run on the same SHA and same date produces `abc1234-2026-06-10-002/`, and so on — every run is always isolated. Run artifacts under `runs/<runId>/` are the canonical source of truth; indexes are fully derived from them.

**`schemaVersion` is mandatory**: every published artifact (both run artifacts and index files) carries a `schemaVersion` integer as the first key. Downstream consumers MUST reject any file whose `schemaVersion` they do not recognise. `schemaVersion` increments are backward-incompatible.

### `public-report.json` — primary dashboard artifact

`public-report.json` is the `PublicReportBundle`-schema artifact consumed by the `/weave-agent-evals/` dashboard. It contains:

- `schemaVersion` — mandatory version field; consumers must reject unrecognised versions
- Per-suite `cases` arrays with `PublicCaseEntry` records
- Score buckets (`"pass"` / `"partial"` / `"fail"` / `"skip"`) — human-interpretable, not raw floats
- Optional bounded `explanation` fields (max 300 chars, allowlisted source kind, no forbidden patterns)
- Aggregate `totalCases`, `passedCases`, `failedCases` counts
- `assembledAt` ISO 8601 timestamp and `gitSha`

**Explanation fields**: all `explanation.text` values derive exclusively from allowlisted structured sources (`rubric_template`, `score_bucket_label`, `structured_signal`, `operator_note`). Raw model output, rationale strings, chain-of-thought traces, prompt text, and LLM freeform summaries are categorically forbidden and are rejected by `BoundedExplanationSchema`. Explanations that fail validation are silently dropped — the case entry is still published with its score bucket and pass/fail boolean.

The local run directory contains all bundle files. However, only the files in `RUN_ARTIFACT_ALLOWLIST` are published to the external results repository:

| File | Local | Published to `runs/v1/<runId>/` |
|---|---|---|
| `bundle-index.json` | ✓ | ✓ |
| `public-report.json` | ✓ | ✓ |
| `public-report.md` | ✓ (optional) | ✓ (when present) |
| `run-summary.json` | ✓ | ✗ (internal) |
| `score-*.json` | ✓ | ✗ (internal) |
| `prompt-hashes.json` | ✓ | ✗ (internal) |
| `provenance-manifest.json` | ✓ | ✗ (internal) |

### Dashboard indexes (derived, mutable)

After each bundle write, `DashboardIndexWriter` (`dashboard-indexes.ts`) scans all existing `runs/<runId>/public-report.json` artifacts and regenerates derived index files at the bundle root. The complete local layout (run artifacts + derived indexes) is shown in the tree above.

When published to the external results repository, only the files in `INDEX_ARTIFACT_ALLOWLIST` are uploaded to `indexes/v1/`. The current allowlist includes `dashboard-manifest.json`, `latest.json`, `last-N-runs.json`, `suite-history-<suite>.json`, `model-comparison-<runId>.json`, and `scenario-history-<suite>.json`.

**Immutable vs. mutable artifacts:**

| Artifact | Mutability | Cacheability |
|---|---|---|
| `runs/<runId>/public-report.json` | Immutable (never overwritten) | Forever-cacheable |
| `dashboard-manifest.json` | Mutable (updated after each run) | Short TTL; check `updatedAt` |
| `latest.json` | Mutable | Short TTL; check `updatedAt` |
| `last-N-runs.json` | Mutable | Short TTL; check `updatedAt` |
| `suite-history-*.json` | Mutable | Short TTL; check `updatedAt` |
| `model-comparison-*.json` | Mutable | Short TTL; check `updatedAt` |
| `scenario-history-*.json` | Mutable | Short TTL; check `updatedAt` |

**Ordering guarantees:**
- `dashboard-manifest.json` runs: newest-first by `assembledAt`.
- `suite-history-*.json` history: oldest-first by `assembledAt`.
- `model-comparison-*.json` models: alphabetical by `modelId`.
- `last-N-runs.json` runs: newest-first, capped at 10 (configurable).
- `scenario-history-*.json` scenarios: per-case `lastRuns` oldest-first, capped at 10 per case.

**Stale / schema-version detection:**

Mutable index files carry `schemaVersion` and `updatedAt`. Website consumers MUST:
1. Reject any index where `schemaVersion` does not match the expected version.
2. Compare `updatedAt` against a freshness threshold and re-fetch when stale.

Use `validateDashboardManifestCompatibility()`, `validateSuiteHistoryCompatibility()`, `validateLatestSnapshotCompatibility()`, and `validateScenarioHistoryCompatibility()` from `dashboard-indexes.ts` to perform these checks. Each function returns `ok(parsed)` or `err(DashboardIndexError)` with a typed `SchemaVersionMismatch` or `IndexParseError` variant.

**Index generation is always derived:** `DashboardIndexWriter.rebuildFromRuns()` reads all existing `runs/<runId>/public-report.json` artifacts and regenerates every index file from scratch. Indexes are never the canonical source — they can always be fully reproduced from immutable run artifacts.

### `scenario-history-<suite>.json` — per-case scenario history index

Published as `indexes/v1/scenario-history-<suite>.json`. Provides a per-case view of recent run outcomes derived from `public-report.json` data. One file per suite.

**Shape** (`ScenarioHistoryIndex` in `report-schema.ts`):

```json
{
  "schemaVersion": 1,
  "suite": "loom-routing",
  "updatedAt": "2026-01-20T10:00:00.000Z",
  "scenarios": [
    {
      "caseId": "loom-route-backend-api",
      "title": "loom-route-backend-api",
      "description": "Routing matched the expected agent.",
      "lastRuns": [
        {
          "runId": "abc1234-2026-01-15-001",
          "assembledAt": "2026-01-15T12:00:00.000Z",
          "status": "pass",
          "passed": true,
          "totalModels": 3,
          "passedModels": 3,
          "failedModels": 0,
          "skippedModels": 0
        }
      ]
    }
  ]
}
```

**Aggregation rules** (applied per caseId per run across all model runs):

| Status | Condition |
|---|---|
| `"pass"` | All considered model entries passed AND at least one was considered |
| `"fail"` | At least one considered model entry exists AND none passed |
| `"partial"` | At least one considered entry passed AND at least one failed |
| `"skip"` | No considered entries (all are `dryRun=true` or `scoreBucket="skip"`) |

"Considered" means `!dryRun && scoreBucket !== "skip"`.

**`lastRuns` ordering and cap**: per-case run entries are in **oldest-first** chronological order (ascending `assembledAt`). Website consumers wanting newest-first should reverse the array. The array is capped at `SCENARIO_HISTORY_MAX_RUNS` (10): when more than 10 runs exist for a case, the oldest are evicted.

**`title` and `description`**: `title` defaults to `caseId` (the `PublicCaseEntry` schema does not carry a dedicated title field). `description` is the first non-empty `explanation.text` found across all model runs for the case (bounded by `EXPLANATION_MAX_CHARS`, sourced from allowlisted explanation sources only). It is omitted when no allowlisted explanation is available.

**Backfill**: the index is fully derived from existing immutable `public-report.json` artifacts. Running `DashboardIndexWriter.rebuildFromRuns()` on any directory containing existing run directories will regenerate all scenario-history indexes from scratch. There is no separate backfill command — a full rebuild is sufficient.

### Fields present in publishable artifacts

Only fields in the `Sanitized*` types from `sanitizer.ts` appear in any publishable file. Unknown fields on internal runner types are silently dropped by the allowlist projection. This means adding a new field to a runner type cannot accidentally leak sensitive data — the sanitizer must be explicitly updated to publish it.

### Fields that are NEVER published

The following field names are blocked from all publishable output by `SENSITIVE_FIELD_NAMES` in `sanitizer.ts`:

`composedPrompt`, `rawContent`, `rawPrompt`, `prompt`, `rawArtifact`, `rawArtifacts`, `transcript`, `rationale`, `dimensionRationales`, `toolArgs`, `env`, `cause`, `body`, `logTail`, and others.

`assertPublishSafe()` rejects any object whose keys include a member of this set. `assertJsonPublishSafe()` scans the serialized JSON string for these keys as JSON key patterns. Both checks run on every file before write.

---

## Sanitization Rules

Sanitization follows allowlist-first semantics defined in `packages/cli/src/evals/sanitizer.ts`.

| Rule | What it means |
|---|---|
| **Allowlist-first** | Only declared fields in `Sanitized*` types are written to publishable output |
| **Unknown fields dropped** | Fields not in the allowlist are silently omitted — no exceptions |
| **Sensitive field names blocked** | `assertPublishSafe()` + `assertJsonPublishSafe()` reject any object/string containing a field from `SENSITIVE_FIELD_NAMES` |
| **Double-check** | Object-level check and JSON-string-level check both run before every file write |
| **REDACTED sentinel** | When a field is redacted, the value is replaced with `"[REDACTED]"` — never omitted silently |
| **Rationale stripped** | Dimension rationales are local-only; only `score` and `applicable` appear in published score records |

The two-direction marker check enforces mutual exclusion between raw and published artifacts:

- **Raw writer** verifies output **contains** `"composedPrompt"` or `"rawContent"` — confirms the artifact is genuinely raw.
- **Bundle writer** verifies output **does not contain** these markers — confirms the artifact is publishable.

Swapping the two write paths by accident is caught at write time.

---

## Raw Artifact Opt-In

> **Warning**: `--raw-artifacts` must never be used in CI. The flag is rejected with a hard error when `CI=true` in the environment.

Raw artifacts contain raw transcript content, composed prompt text, and full dimension rationales. They are for local debugging only and are **never publishable**.

```bash
# Local only — rejected in CI
weave eval run --raw-artifacts
```

Raw artifacts are written to `eval-bundles/runs/<runId>/raw/`:

| Artifact | Filename |
|---|---|
| Per-case raw result | `case-<safeCaseId>-<safeModelId>-<YYYY-MM-DDTHH-MM-SS-mmmZ>.json` |
| Per-agent prompt | `prompt-<safeAgentName>-<YYYY-MM-DDTHH-MM-SS-mmmZ>.json` |

Raw filename components are sanitized before write. Slashes, backslashes, traversal segments such as `..`, and other unsafe characters are replaced or stripped so the final path stays under the local `raw/` directory.

`RawArtifactsWriter` requires `rawArtifactsEnabled: true` as an explicit constructor opt-in. When disabled, all write methods return `err({ type: "RawArtifactsDisabled" })` — they never throw.

The `raw/` subdirectory should be listed in `.gitignore`. Raw files must never be committed or published.

---

## CI Artifact Model

The eval CI workflow is **manual-only** (`workflow_dispatch`). It cannot be triggered by push, PR, or schedule — it must be dispatched explicitly by a maintainer.

### What CI does

1. Runs `weave eval run` with no filters (all cases, all default models).
2. Writes sanitized `eval-bundles/` artifacts locally within the workflow runner.
3. **Publishes** the sanitized bundle to `weave-io/weave-agent-evals` via the GitHub REST Contents API (`GitHubContentsPublisher`). Immutable run artifacts land under `runs/v1/<sha7>-<YYYY-MM-DD>-<NNN>/` and derived index files are updated under `indexes/v1/` in the target repo.
4. Uploads the bundle directory as a GitHub Actions artifact named `eval-bundles-<run-id>` with **30-day retention** (backup for local inspection).

Eval threshold misses are reported in `run-summary.json` and the per-suite score files, but they do not fail the CLI process. The CI job fails only for hard orchestration problems such as invalid inputs, missing secrets, model matrix/load failures, bundle write failures, publication failures, or suite-level partial failures that prevent complete results from being produced.

### What CI does NOT do

- Does not accept `--raw-artifacts` (the CI guard in `input-validation.ts` rejects it).
- Does not run automatically on every commit.
- Does not publish raw artifacts — `raw/` subdirectory is never included (filtered by `GitHubContentsPublisher` before any upload).
- Does not expose tokens in shell command arguments, workflow logs, or artifact content.

### Published bundle layout in weave-io/weave-agent-evals

All paths in the results repository are versioned under a `v1/` segment to allow future breaking changes without destroying existing content.

```
indexes/v1/                                   Derived mutable index artifacts
├── dashboard-manifest.json                   All runs index (mutable — updated after each run)
├── latest.json                               Most-recent run snapshot (mutable)
├── last-N-runs.json                          Last N runs index (mutable)
├── suite-history-<suite>.json                Per-suite pass-rate history (mutable)
├── model-comparison-<runId>.json             Per-run model comparison table (mutable)
└── scenario-history-<suite>.json             Per-suite per-case run history (mutable)

runs/v1/                                      Immutable run artifact directories
└── <sha7>-<YYYY-MM-DD>-<NNN>/               Immutable run directory
    ├── bundle-index.json                     Top-level run manifest (publicFiles lists allowlisted files only)
    ├── public-report.json                    Dashboard-facing bundle report (schemaVersion mandatory)
    └── public-report.md                      Human-readable Markdown report (download-only)
```

**Immutable run artifacts** under `runs/v1/<runId>/` are written ONCE and NEVER overwritten. The `bundle-index.json` `publicFiles` field enumerates only allowlisted public file names — it MUST NOT list raw artifacts or internal bundle files such as `run-summary.json`, `score-*.json`, `prompt-hashes.json`, or `provenance-manifest.json`.

**Derived index artifacts** under `indexes/v1/` are mutable — they are regenerated after each successful run publication.

**Public artifact allowlists** (enforced by `GitHubContentsPublisher`):

| Run artifact allowlist (`runs/v1/<runId>/`) | Description |
|---|---|
| `bundle-index.json` | Top-level run manifest (publicFiles field; no internal files) |
| `public-report.json` | Public dashboard report (schemaVersion mandatory) |
| `public-report.md` | Markdown report (download-only, never rendered as HTML) |

| Index artifact allowlist (`indexes/v1/`) | Description |
|---|---|
| `dashboard-manifest.json` | All-runs manifest (mutable) |
| `latest.json` | Most-recent run snapshot (mutable) |
| `last-N-runs.json` | Last N runs (mutable) |
| `suite-history-<suite>.json` | Per-suite pass-rate history (mutable) |
| `model-comparison-<runId>.json` | Per-run model comparison (mutable) |
| `scenario-history-<suite>.json` | Per-suite per-case run history (mutable) |

Any file outside these allowlists is rejected before upload — even if the caller explicitly requests it. File names containing `/`, `\`, or `..` are always rejected.

**Publish-before-index ordering**: `GitHubContentsPublisher` always uploads all run artifacts before uploading any index artifact. This guarantees that when `indexes/v1/dashboard-manifest.json` is updated to reference a new run, that run's artifacts are already committed and reachable.

**Website loaders MUST NOT enumerate directories**: consumers fetch specific known paths (starting from `indexes/v1/dashboard-manifest.json`). Directory walking is not permitted — only exact paths declared in the manifest are fetched.

### CI environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Required. OpenRouter API key for model inference. Must be a repository secret. Scoped to eval run step only. |
| `EVAL_RESULTS_REPO_TOKEN` | Required. GitHub PAT with write access to `weave-io/weave-agent-evals`. Must be a repository secret. Scoped to eval run step only. |
| `WEAVE_EVAL_PUBLISH_MODE` | Set to `"publish"` in the workflow. Activates `GitHubContentsPublisher`. Local default is `"local"`. |
| `WEAVE_EVAL_AGENT` | Optional. Filter to one agent suite. |
| `WEAVE_EVAL_MODEL` | Optional. Filter to one model. |
| `WEAVE_EVAL_CASE` | Optional. Filter to one case ID. |

Blank eval filter env vars are treated as unset. This matches GitHub Actions workflow dispatch, where leaving an optional input blank still exports an empty string into the eval job environment. Empty means no filter, not an invalid filter.

The workflow runs a `weave eval run --dry-run` preflight with the same blank filter env vars before the publish step. This catches CI env contract regressions without making model calls or writing artifacts.

`GITHUB_RUN_ID`, when present, is projected into run metadata only if it is digits-only. Values with hyphens, letters, or other characters are treated as absent so arbitrary environment content cannot leak into artifacts.

> **Security warning**: `OPENROUTER_API_KEY` and `EVAL_RESULTS_REPO_TOKEN` are secrets. They must be stored as encrypted GitHub Actions repository secrets. They must never appear in workflow logs, artifact content, or commit history. Both are scoped to the eval run step **only** — no other step can access them.

### Token scoping

`EVAL_RESULTS_REPO_TOKEN` is passed to the CLI via the env block of the eval run step **only**. The CLI's `GitHubContentsPublisher` reads this token and passes it exclusively as an HTTP `Authorization: Bearer <token>` header to the GitHub Contents API. The token:

- Is never interpolated into shell command arguments.
- Is never included in any log message (structured logs record only paths and status codes).
- Is never included in any error message returned to callers.
- Is never serialized to disk or included in any bundle artifact.
- Is never present in the `actions/upload-artifact` step (which uses no stored secrets).

The publish pipeline enforces all sanitization policy before any upload:

1. `assertPublishSafe()` on every assembled object.
2. `assertJsonPublishSafe()` on every serialized JSON string.
3. `enforcePublishPolicy()` — dry-run blocking, score file presence, sanitization belt check.
4. Raw file exclusion — `GitHubContentsPublisher` filters out any path containing `raw/`.
5. **Allowlist enforcement** — only `RUN_ARTIFACT_ALLOWLIST` files are uploaded to `runs/v1/<runId>/`; only `INDEX_ARTIFACT_ALLOWLIST` files are uploaded to `indexes/v1/`.
6. **Error redaction** — HTTP response bodies are never surfaced; remote path details are omitted from run artifact failure messages.

### Short-retention local artifacts

Artifacts uploaded to GitHub Actions by the CI workflow use **30-day retention**. This is intentional:

- Eval results are also durably stored in `weave-io/weave-agent-evals`.
- Short retention limits storage cost and avoids accumulation of stale artifacts.
- The canonical historical record lives in the results repository, not the artifact.

Do not increase retention without a specific operational reason.

---

## Adding a New Eval Case

1. Choose the suite: `loom-routing`, `tapestry-execution`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, or `warp-security`.
2. Create `evals/cases/<suite>/<case-id>.json` following the case schema in `evals/README.md`.
3. Create the matching `evals/rubrics/<suite>/<case-id>.json` rubric file.
4. Ensure `id` in the case file exactly matches `case_id` in the rubric and the JSON filename (without `.json`).
5. If referencing a new agent name in `allowed_agents`, add it to `KNOWN_AGENTS` in `packages/cli/src/evals/case-loader.ts`.
6. Keep the case text-only: do not use `expected_outcome.kind: "tool_call"`, `tool_called`, `no_tool_called`, or `content_contains` with `role: "tool"`.
7. Run `bun test ./packages/cli/src/evals/__tests__` to confirm all fixtures load without errors.
8. Run a local dry run to verify the case is picked up: `weave eval run --case <case-id> --dry-run`.
9. Run a live local eval to confirm scoring: `weave eval run --case <case-id>` (requires `OPENROUTER_API_KEY`).

### Case schema quick reference

```jsonc
{
  "id": "loom-route-backend-api",          // Unique within suite; used as --case filter value
  "description": "...",                    // Required human-readable description
  "suite": "loom-routing",                 // Suite this case belongs to
  "allowed_agents": ["loom", "shuttle"],   // Closed set of valid agent names (min 1)
  "allowed_models": ["anthropic/..."],     // Closed set of valid model IDs (min 1)
  "expected_outcome": { "kind": "agent_routing", ... },
  "accepted_alternates": [],               // Optional substitute agent/model IDs
  "transcript_expectations": [],           // Optional ordered transcript assertions
  "tags": []                               // Optional grouping tags
}
```

### Rubric schema quick reference

```jsonc
{
  "case_id": "loom-route-backend-api",    // Must exactly match the case id field
  "suite": "loom-routing",               // Must match the case suite field
  "scoring": {
    "outcome_weight": 0.8,              // Weight for primary expected outcome (0.0–1.0)
    "per_expectation_weight": 0.2,      // Weight per passing transcript expectation
    "required": true,                   // Block suite green if this case fails
    "notes": "..."                      // Optional notes (ignored by runners)
  }
}
```

See `evals/README.md` for the full schema reference including `expected_outcome` kinds and `transcript_expectations` check types.

---

## Running a Filtered Local Dry Run

To inspect what would execute without making any model calls or writing any artifacts:

```bash
# All cases, all models — print the full run plan
weave eval run --dry-run

# Narrow to a single agent
weave eval run --agent loom --dry-run

# Narrow to a single model
weave eval run --model anthropic/claude-sonnet-4.5 --dry-run

# Narrow to a single case
weave eval run --case loom-route-backend-api --dry-run

# Fully targeted: one agent, one model, one case
weave eval run --agent loom --model anthropic/claude-sonnet-4.5 --case loom-route-backend-api --dry-run
```

Dry-run output lists filters and confirms no execution will occur. A valid dry run exits `0`. An invalid dry run exits non-zero, typically `1`, because the CLI still validates suite filters, model IDs, case IDs, text-only contract limits, and real suite fixture/rubric loading before it skips model execution.

Dry-run is the recommended contributor preflight path because it exercises the same filter validation and suite fixture/rubric loading contract as a live run without requiring secrets, making model calls, or writing artifacts.

---

## Security Checklist

Before committing eval-related changes, verify:

- [ ] No `OPENROUTER_API_KEY` value appears in any fixture, artifact, or test file.
- [ ] No `EVAL_RESULTS_REPO_TOKEN` value appears anywhere (token is only in the `Authorization` HTTP header inside `GitHubContentsPublisher`).
- [ ] Raw artifacts (`raw/` subdirectory, files containing `composedPrompt` or `rawContent`) are not committed.
- [ ] `--raw-artifacts` is not used in any CI workflow step.
- [ ] New fixture fields that might contain sensitive data are listed in `SENSITIVE_FIELD_NAMES` in `sanitizer.ts`.
- [ ] Any new publishable field has a corresponding entry in the relevant `Sanitized*` type.
- [ ] `WEAVE_EVAL_PUBLISH_MODE=publish` is only set in the eval run step env block (not at job or workflow level).
- [ ] `EVAL_RESULTS_REPO_TOKEN` is only passed in the eval run step env block (not available in upload-artifact or any other step).
- [ ] `GitHubContentsPublisher` tests use injected `fetchImpl` and `fileReader` — no real network or disk calls.
- [ ] Any change to `GitHubContentsPublisher` that affects token handling must include a test asserting the token does not appear in any error message or request field other than the `Authorization` header.
- [ ] `public-report.md` is NOT injected as HTML into any web page via `innerHTML` or equivalent.
- [ ] All strings rendered via `innerHTML` in `dashboard-ui.js` are wrapped in `escapeHtml()`.
- [ ] New `explanation.text` values derive from allowlisted structured sources only (score bucket labels, rubric templates, structured signals) — never from raw model output, rationale strings, transcript content, or LLM freeform summaries.
- [ ] Any new explanation-rendering surface applies `MARKDOWN_INJECTION_PATTERNS` checks (Markdown renderer) or `escapeHtml()` (HTML renderer) before emitting the value.
- [ ] Changes to `FORBIDDEN_EXPLANATION_PATTERNS` include test coverage in `report-schema.test.ts` and `report-markdown.test.ts`.
- [ ] Any new public run artifact file name is added to `RUN_ARTIFACT_ALLOWLIST` in `github-contents-publisher.ts`.
- [ ] Any new public index file name pattern is added to `isIndexArtifactAllowed()` in `github-contents-publisher.ts` (either as an exact entry in `INDEX_ARTIFACT_EXACT_ALLOWLIST` or as a new pattern constant).
- [ ] `bundle-index.json` does not enumerate internal-only files (`run-summary.json`, `score-*.json`, `provenance-manifest.json`, `prompt-hashes.json`) — only `RUN_ARTIFACT_ALLOWLIST` members.
- [ ] Publisher error messages do not include remote file paths, run IDs, or any information that could leak path structure or secrets.
- [ ] Website loaders fetch exact known paths (starting from `indexes/v1/dashboard-manifest.json`) — no directory enumeration.

---

## Report Rendering and XSS Policy

See [`docs/eval-xss-policy.md`](./eval-xss-policy.md) for the complete specification. Key points:

### `public-report.md` is download-only

`public-report.md` is produced as a plain-text Markdown artifact. It is served as a download or displayed as raw text — never injected as HTML into a web page. If it reaches a Markdown-to-HTML renderer, that renderer must apply a strict sanitizer (e.g., DOMPurify with an allowlist). `innerHTML` assignment of Markdown text is categorically banned.

### Explanation text is blocked at the schema level

`BoundedExplanationSchema` rejects explanation text containing any `FORBIDDEN_EXPLANATION_PATTERNS` match, including:

- HTML injection patterns: `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, inline `on*=` event handlers, `javascript:` URIs, `data:` URIs
- Raw rationale markers: `rationale:`, `score: N`, `justification:`
- Chain-of-thought markers: `<thinking>`, `<cot>`, `<reasoning>`
- Transcript role markers: `\nUser:`, `\nAssistant:`, `Human:`
- Secret patterns: `sk-...`, `Bearer ...`, `ghp_...`

Explanations that fail validation are silently dropped — the case entry is still published with its score bucket and pass/fail boolean.

### Markdown renderer applies belt-and-suspenders HTML checks

`report-markdown.ts` applies `MARKDOWN_INJECTION_PATTERNS` via `sanitizeMdValue()` on every user-supplied string before it enters the rendered Markdown output. Any string matching an injection pattern is replaced with an empty string. This is independent of — and secondary to — the schema-level check.

### Dashboard UI requires `escapeHtml()` on all `innerHTML` values

All strings rendered via `innerHTML` in `dashboard-ui.js` must be wrapped in `escapeHtml()`. This is already the case for all existing rendering paths. New rendering paths added to `dashboard-ui.js` must follow the same pattern.
