# Agent Evals

This guide covers the eval architecture, fixture layout, CLI usage, filter semantics, prompt-hash provenance, artifact schema, sanitization rules, raw-artifact opt-in, and the CI artifact model. It is the contributor reference for everything related to `weave eval run`.

Related docs:

- [CLI](./cli.md) — `weave eval run` command surface, flags, and security warnings
- [Eval Sanitization and Publish Pipeline](./eval-sanitization-and-publish-pipeline.md) — allowlist sanitizer, deterministic bundle writer, raw-artifact writer, token-gated publish policy

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
    │   ├── executeSuites()            Fan out: LoomRoutingRunner + TapestryExecutionRunner
    │   │   └── (per model × per suite)
    │   ├── deriveProvenanceManifest() Hash prompts → PromptProvenanceManifest
    │   ├── ArtifactBundleWriter       Sanitize → write eval-bundles/<sha7>-<date>/
    │   │   └── GitHubContentsPublisher  (publish mode only) → weave-io/weave-agent-evals
    │   └── RawArtifactsWriter?        (--raw-artifacts only) write raw/ subdirectory
    │
    └── EvalRunSummary                 Returned to CLI handler (exit 0/1)
```

All publishable output passes through the central allowlist sanitizer in `packages/cli/src/evals/sanitizer.ts` before being written. Raw artifacts are written to a separate `raw/` subdirectory that is never included in publishable bundles or external publication.

---

## Fixture Layout

```
evals/
├── model-matrix.json              Canonical model allowlist (default 3 models)
├── cases/
│   ├── loom-routing/              Loom agent routing eval cases
│   │   └── <case-id>.json
│   └── tapestry-execution/        Tapestry execution/delegation eval cases
│       └── <case-id>.json
└── rubrics/
    ├── loom-routing/              Scoring rubrics keyed by case ID
    │   └── <case-id>.json
    └── tapestry-execution/
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
├── openrouter-client.ts      OpenRouterClient for model inference
├── langchain-agent-evals.ts  LangChainAgentEvalsScorer (rubric scoring judge)
└── env.ts                    readEvalEnv — OPENROUTER_API_KEY validation
```

And in `packages/cli/src/commands/eval.ts`:

- `readPublishMode(env)` — reads `WEAVE_EVAL_PUBLISH_MODE` and returns `"local"` or `"publish"` (default: `"local"`).
- `WEAVE_EVAL_PUBLISH_MODE_ENV_VAR` — the constant `"WEAVE_EVAL_PUBLISH_MODE"`.

---

## Eval Suites

| Suite | Runner | What it tests |
|---|---|---|
| `loom-routing` | `LoomRoutingRunner` | Loom routes requests to the correct agent or category |
| `tapestry-execution` | `TapestryExecutionRunner` | Tapestry executes steps and delegates to sub-agents |

Both suites share the same case schema, rubric schema, and model matrix. They are run in parallel across all models in the effective model set.

---

## CLI Usage

```bash
# Run all suites against all default models (3 by default)
weave eval run

# Filter to a single agent suite
weave eval run --agent loom
weave eval run --agent tapestry

# Filter to a single model
weave eval run --model anthropic/claude-sonnet-4.5

# Filter to a single case ID
weave eval run --case loom-route-backend-api

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

To enable external publication of results, set:

```bash
WEAVE_EVAL_PUBLISH_MODE=publish
EVAL_RESULTS_REPO_TOKEN=<token-with-write-access-to-weave-io/weave-agent-evals>
```

The default (`WEAVE_EVAL_PUBLISH_MODE` absent or any value other than `"publish"`) is always `"local"` — no external push occurs. This is intentionally fail-safe: an unknown or empty value always falls back to local mode.

CLI flags and env vars are merged: if both are set for the same filter key with different values, the run fails with a `DuplicateConflictingInput` error. Same-value duplicates are collapsed silently.

### Filter semantics

All three filters use **strict exact-match** semantics:

- `--agent` must exactly match either the suite name (`loom-routing`, `tapestry-execution`) or the short agent name (`loom`, `tapestry`).
- `--model` must exactly match a model `id` in `evals/model-matrix.json`. No substring matching. If the value does not match any matrix entry, the run aborts with `EmptyModelSet` and lists the allowed IDs.
- `--case` must exactly match the `id` field in a case fixture file. No glob or prefix matching.

No filter means all values in that dimension are included. Default no-filter runs all three default models against all cases in both suites.

### Required environment variable

```
OPENROUTER_API_KEY=<your-key>
```

This variable must be set before running `weave eval run`. The runner validates it at startup and aborts with `EnvironmentError` if absent or empty. The key value is **never logged, printed, or serialized** — it is passed directly to the OpenRouter HTTP client and treated as a secret throughout.

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

Each run writes a bundle to `eval-bundles/<gitSha7>-<YYYY-MM-DD>/`:

```
eval-bundles/
└── abc1234-2026-06-10/
    ├── bundle-index.json          Top-level manifest (version, gitSha, assembledAt)
    ├── run-summary.json           Aggregate pass/fail counts and per-suite rollups
    ├── score-loom-routing.json    Sanitized score records for loom-routing suite
    ├── score-tapestry-execution.json
    ├── prompt-hashes.json         Prompt hash records (no raw text)
    └── provenance-manifest.json   Full sanitized provenance manifest
```

The directory name `<sha7>-<YYYY-MM-DD>` is **deterministic**: the same git SHA and calendar date always produce the same path. This enables content-addressable storage and reproducible diffs.

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

Raw artifacts are written to `eval-bundles/<sha7>-<date>/raw/`:

| Artifact | Filename |
|---|---|
| Per-case raw result | `case-<caseId>-<safeModelId>-<YYYY-MM-DD>.json` |
| Per-agent prompt | `prompt-<agentName>-<YYYY-MM-DD>.json` |

`RawArtifactsWriter` requires `rawArtifactsEnabled: true` as an explicit constructor opt-in. When disabled, all write methods return `err({ type: "RawArtifactsDisabled" })` — they never throw.

The `raw/` subdirectory should be listed in `.gitignore`. Raw files must never be committed or published.

---

## CI Artifact Model

The eval CI workflow is **manual-only** (`workflow_dispatch`). It cannot be triggered by push, PR, or schedule — it must be dispatched explicitly by a maintainer.

### What CI does

1. Runs `weave eval run` with no filters (all cases, all default models).
2. Writes sanitized `eval-bundles/` artifacts locally within the workflow runner.
3. **Publishes** the sanitized bundle to `weave-io/weave-agent-evals` via the GitHub REST Contents API (`GitHubContentsPublisher`). Files land under `runs/<sha7>-<YYYY-MM-DD>/` in the target repo.
4. Uploads the bundle directory as a GitHub Actions artifact named `eval-bundles-<run-id>` with **30-day retention** (backup for local inspection).

### What CI does NOT do

- Does not accept `--raw-artifacts` (the CI guard in `input-validation.ts` rejects it).
- Does not run automatically on every commit.
- Does not publish raw artifacts — `raw/` subdirectory is never included (filtered by `GitHubContentsPublisher` before any upload).
- Does not expose tokens in shell command arguments, workflow logs, or artifact content.

### Published bundle layout in weave-io/weave-agent-evals

```
runs/
└── <sha7>-<YYYY-MM-DD>/
    ├── bundle-index.json
    ├── run-summary.json
    ├── score-loom-routing.json
    ├── score-tapestry-execution.json
    ├── prompt-hashes.json
    └── provenance-manifest.json
```

The `runs/` prefix keeps all historical run bundles under one directory in the target repository.

### CI environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Required. OpenRouter API key for model inference. Must be a repository secret. Scoped to eval run step only. |
| `EVAL_RESULTS_REPO_TOKEN` | Required. GitHub PAT with write access to `weave-io/weave-agent-evals`. Must be a repository secret. Scoped to eval run step only. |
| `WEAVE_EVAL_PUBLISH_MODE` | Set to `"publish"` in the workflow. Activates `GitHubContentsPublisher`. Local default is `"local"`. |
| `WEAVE_EVAL_AGENT` | Optional. Filter to one agent suite. |
| `WEAVE_EVAL_MODEL` | Optional. Filter to one model. |
| `WEAVE_EVAL_CASE` | Optional. Filter to one case ID. |

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

### Short-retention local artifacts

Artifacts uploaded to GitHub Actions by the CI workflow use **30-day retention**. This is intentional:

- Eval results are also durably stored in `weave-io/weave-agent-evals`.
- Short retention limits storage cost and avoids accumulation of stale artifacts.
- The canonical historical record lives in the results repository, not the artifact.

Do not increase retention without a specific operational reason.

---

## Adding a New Eval Case

1. Choose the suite: `loom-routing` or `tapestry-execution`.
2. Create `evals/cases/<suite>/<case-id>.json` following the case schema in `evals/README.md`.
3. Create the matching `evals/rubrics/<suite>/<case-id>.json` rubric file.
4. Ensure `id` in the case file exactly matches `case_id` in the rubric and the JSON filename (without `.json`).
5. If referencing a new agent name in `allowed_agents`, add it to `KNOWN_AGENTS` in `packages/cli/src/evals/case-loader.ts`.
6. Run `bun test ./packages/cli/src/evals/__tests__` to confirm all fixtures load without errors.
7. Run a local dry run to verify the case is picked up: `weave eval run --case <case-id> --dry-run`.
8. Run a live local eval to confirm scoring: `weave eval run --case <case-id>` (requires `OPENROUTER_API_KEY`).

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

Dry-run output lists filters and confirms no execution will occur. Exit code is always `0` for a dry run.

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
