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

The fixture tree is intentionally flat and registry-shaped. Each of the seven supported suite families gets exactly one case directory and one rubric directory, and contributors should treat those suite IDs as the canonical names used by CLI filters, workflow inputs, and publishable reporting.

```
evals/
├── model-matrix.json              Canonical model allowlist (default 3 models)
├── cases/
│   ├── loom-routing/              Loom agent routing eval cases
│   │   └── <case-id>.json
│   ├── tapestry-execution/        Tapestry execution/delegation eval cases
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

Weave currently supports **seven text-only suite families**. Every registered suite is synthetic and text-observable by design.

| Suite | Runner | What it tests |
|---|---|---|
| `loom-routing` | `LoomRoutingRunner` | Loom emits text-observable routing signals for the primary route, with evidence/review follow-ups treated separately from the primary implementation agent |
| `tapestry-execution` | `TapestryExecutionRunner` | Tapestry emits text-observable completion and delegation-chain signals for plan execution |
| `shuttle-execution` | `ShuttleExecutionRunner` | Shuttle emits bounded delegated-task completion reports with task intake reflection, file awareness, acceptance confirmation, and final evidence reporting from assistant text |
| `spindle-tools` | `SpindleToolsRunner` | Spindle emits source-cited research structure with explicit `Source facts`, `Interpretation`, `Sources`, and bounded confidence from assistant text |
| `pattern-planning` | `PatternPlanningRunner` | Pattern emits structurally explicit plans with observable scope, file-task, sequencing, and acceptance signals |
| `weft-review` | `WeftReviewRunner` | Weft emits structurally explicit review verdicts, blocker counts, and actionable file-cited approval or rejection signals |
| `warp-security` | `WarpSecurityRunner` | Warp emits structurally explicit security triage, capped blocker counts, and evidence-backed findings from assistant text |

All suites share the same case schema, rubric schema, and model matrix. They are run in parallel across all models in the effective model set.

The current eval runners are **text-only prompt evals**: they call OpenRouter chat completions and extract signals from assistant text. They do not execute harness tools or capture real tool-call events. Fixture authors should therefore assert observable text signals such as agent mentions, routed agents, delegation chains, completion phrases, and produced artifact names. Do not use a text-only fixture to require an unobservable real tool invocation or the absence of a tool invocation; reserve those checks for a future harness-backed trajectory runner.

The seven current families are: `loom-routing`, `tapestry-execution`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, and `warp-security`.

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

Forbidden assertion shapes in the current seven-suite surface are therefore:

- `expected_outcome.kind: "tool_call"`
- `transcript_expectations.check: "tool_called"`
- `transcript_expectations.check: "no_tool_called"`
- `transcript_expectations.check: "content_contains"` with `role: "tool"`

### Recommended authoring pattern for new cases

When adding a new case, start from the text the runner can actually score:

1. pick one of the seven registered suites
2. encode the whole scenario in the case description and suite prompt shape, with no hidden repo or runtime dependency
3. choose only suite-allowed `expected_outcome.kind` values
4. use `transcript_expectations` only for text-visible checks on `user` or `assistant` roles
5. prefer structural markers over semantic judgment, for example headings, verdict lines, agent names, file references, artifact names, blocker counts, and acceptance confirmations
6. verify the case with `weave eval run --case <case-id> --dry-run` before any live run

If the dry run fails, treat that as a contract problem, not as a harmless preview warning. Dry-run is intentionally fail-closed for invalid suite filters, model filters, case IDs, and text-only assertion violations.

Tapestry eval prompts include a minimal synthetic plan context (`Plan file`, remaining `- [ ]` task, and todo state) so the prompt, runner input, and fixture expectations all describe plan execution rather than a free-floating chat request.

Shuttle execution prompts likewise inject a synthetic delegated task envelope (`Task [N/M]`, `What`, `Files`, `Acceptance`, context, and learnings) and score only what the final report says about completion. Cases pass only when the assistant mirrors that structure and reports bounded evidence such as files changed, commands/tests run, assumptions, and explicit acceptance confirmation.

Pattern planning eval prompts likewise constrain the model toward structural planning output. The runner extracts deterministic signals only — explicit scope, file-backed tasks, sequencing, and acceptance coverage — and projects those into `required_artifacts`/completion signals before invoking the existing scorer path. This keeps planning assertions structural rather than semantic freeform wish-casting.

Weft review eval prompts are synthetic by design. The case description and runner prompt fully describe the review target so the suite never needs a live patch or hidden repository state. The runner scores only text-observable review structure: `[APPROVE]` or `[REJECT]`, blocker count, approval and rejection discipline, and actionable file references.

Warp security eval prompts are synthetic by design too. The suite scores only text-observable security review structure: `APPROVE` or `BLOCK`, bounded blocker counts, and evidence-backed finding groups with file references. It does not attempt runtime exploit execution, live secret scanning, or exploit validation.

Spindle tools eval prompts are synthetic too. The suite scores only text-observable research structure: inline citations, a distinct `Source facts` section, a distinct `Interpretation` section, a bounded `Confidence:` line, and a final `Sources:` list. It does not attempt to prove that a browser, search tool, or network event actually occurred; those runtime-only assertions are rejected by the shared text-only fixture contract unless they are surfaced as ordinary plain-text claims in the answer.

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

`--dry-run` validates the same suite, model, and case allowlists as a live run, but it does **not** require `OPENROUTER_API_KEY` because no model call is made.

To enable external publication of results, set:

```bash
WEAVE_EVAL_PUBLISH_MODE=publish
EVAL_RESULTS_REPO_TOKEN=<token-with-write-access-to-weave-io/weave-agent-evals>
```

The default (`WEAVE_EVAL_PUBLISH_MODE` absent or any value other than `"publish"`) is always `"local"` — no external push occurs. This is intentionally fail-safe: an unknown or empty value always falls back to local mode.

CLI flags and env vars are merged: if both are set for the same filter key with different values, the run fails with a `DuplicateConflictingInput` error. Same-value duplicates are collapsed silently.

### Filter semantics

All three filters use **strict exact-match** semantics:

- `--agent` must exactly match either the suite name (`loom-routing`, `tapestry-execution`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, `warp-security`) or the short agent name (`loom`, `tapestry`, `shuttle`, `spindle`, `pattern`, `weft`, `warp`).
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

Dry-run output lists filters and confirms no execution will occur. A valid dry run exits `0`. An invalid dry run exits non-zero, typically `1`, because the CLI still validates suite filters, model filters, case IDs, and text-only contract limits before it skips model execution.

Dry-run is the recommended contributor preflight path because it exercises the same filter validation and fixture-discovery contract without requiring secrets or making model calls.

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
