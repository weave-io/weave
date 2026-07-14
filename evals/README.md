# Weave Eval Fixtures

This directory contains the canonical fixture files for `weave eval run`. It is the **allowlist source of truth** for model matrix entries, eval cases, and rubric scoring metadata.

Today that fixture surface covers exactly **eight text-only suite families**: `loom-routing`, `tapestry-execution`, `tapestry-category-routing`, `shuttle-execution`, `spindle-tools`, `pattern-planning`, `weft-review`, and `warp-security`. Runtime-backed eval fixtures are an explicit non-goal of the current contract.

For the full eval guide — architecture, CI model, sanitization rules, raw-artifact policy, and prompt-hash provenance — see [`docs/agent-evals.md`](../docs/agent-evals.md).

> **What can and cannot land here**: fixture files (`model-matrix.json`, case JSONs, rubric JSONs) are the only files that belong in this directory. Raw artifacts, composed prompt text, transcripts, API keys, and `eval-bundles/` output must never be committed here or to any external results repository without passing the sanitizer defined in `packages/cli/src/evals/sanitizer.ts`.

## Directory Layout

```
evals/
├── README.md                           # This file
├── model-matrix.json                   # Canonical model allowlist
├── cases/
│   ├── loom-routing/                   # Loom agent routing eval cases
│   │   ├── loom-route-backend-api.json
│   │   ├── loom-route-frontend-ui.json
│   │   └── loom-route-ambiguous-direct-shuttle.json
│   ├── tapestry-execution/             # Tapestry execution/delegation eval cases
│   │   ├── tapestry-execute-plan-step.json
│   │   └── tapestry-delegate-to-shuttle.json
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
│   │   └── shuttle-execution-report-tests-and-assumptions.json
│   ├── spindle-tools/                  # Spindle research-structure eval cases
│   │   ├── spindle-tools-citations-facts-confidence.json
│   │   └── spindle-tools-source-boundary-network-claims.json
│   ├── pattern-planning/               # Pattern planning structure eval cases
│   │   ├── pattern-plan-settings-refactor.json
│   │   └── pattern-plan-release-checklist.json
│   ├── weft-review/                    # Weft review-structure eval cases
│   │   ├── weft-review-clean-approval.json
│   │   └── weft-review-reject-blocker-citation.json
│   └── warp-security/                  # Warp security-review structure eval cases
│       ├── warp-security-fast-exit-approve.json
│       └── warp-security-block-evidence-findings.json
└── rubrics/
    ├── loom-routing/                   # Scoring rubrics for loom-routing cases
    │   ├── loom-route-backend-api.json
    │   ├── loom-route-frontend-ui.json
    │   └── loom-route-ambiguous-direct-shuttle.json
    ├── tapestry-execution/             # Scoring rubrics for tapestry-execution cases
    │   ├── tapestry-execute-plan-step.json
    │   └── tapestry-delegate-to-shuttle.json
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
    │   └── shuttle-execution-report-tests-and-assumptions.json
    ├── spindle-tools/                  # Scoring rubrics for spindle-tools cases
    │   ├── spindle-tools-citations-facts-confidence.json
    │   └── spindle-tools-source-boundary-network-claims.json
    ├── pattern-planning/               # Scoring rubrics for pattern-planning cases
    │   ├── pattern-plan-settings-refactor.json
    │   └── pattern-plan-release-checklist.json
    ├── weft-review/                    # Scoring rubrics for weft-review cases
    │   ├── weft-review-clean-approval.json
    │   └── weft-review-reject-blocker-citation.json
    └── warp-security/                  # Scoring rubrics for warp-security cases
        ├── warp-security-fast-exit-approve.json
        └── warp-security-block-evidence-findings.json
```

## Model Matrix (`model-matrix.json`)

The model matrix defines the **closed set of models** that evals run against. At minimum, three models must have `default: true` — these are the models used when no `--model` filter is supplied.

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
      "tags": ["fast", "balanced"]           // Optional tags for grouping
    }
  ]
}
```

**Constraint**: At least three entries must have `"default": true`. The loader (`packages/cli/src/evals/model-matrix.ts`) enforces this constraint at load time with a `ModelMatrixConstraintViolation` error.

## Case Fixtures (`cases/<suite>/<case-id>.json`)

Each case fixture describes a single eval scenario. Case files are named after the case `id` field.

All current suites are **text-only**. A fixture may assert only what is visible in assistant or user text. Runtime-backed evals are an explicit non-goal of the current fixture contract.

### Suites

| Suite                       | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `loom-routing`              | Verify Loom routes requests to the correct agent/category    |
| `tapestry-execution`        | Verify Tapestry executes steps and delegates to sub-agents   |
| `tapestry-category-routing` | Verify Tapestry routes to the correct category shuttle agent |
| `shuttle-execution`         | Verify Shuttle mirrors delegated task structure and final evidence reporting from text |
| `spindle-tools`             | Verify Spindle cites sources, separates source facts from interpretation, and reports confidence from text |
| `pattern-planning`          | Verify Pattern emits structurally strong implementation plans |
| `weft-review`               | Verify Weft emits structurally valid approve/reject reviews   |
| `warp-security`             | Verify Warp emits text-only security triage and finding structure |

### Case Schema

```jsonc
{
  "id": "loom-route-backend-api",          // Unique within the suite; used as --case filter
  "description": "...",                    // Human-readable description (required)
  "suite": "loom-routing",                 // Suite this case belongs to (required)
  "allowed_agents": ["loom", "shuttle"],   // Closed set of valid agents (min 1)
  "allowed_models": ["anthropic/..."],     // Closed set of valid model IDs (min 1)
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

### Spindle-tools fixture guidance

`spindle-tools` cases must remain text-observable and research-structure-only.
Encode any synthetic source brief directly in the case description or runner
prompt and score only what the assistant text makes visible, such as:

- inline citations like `[1]` / `[2]`
- explicit separation between `Source facts` and `Interpretation`
- a bounded `Confidence:` line
- a final `Sources:` list

Do not require actual browsing telemetry, network events, search-tool traces,
or hidden source retrieval state. If a case needs to talk about tools or
network access, it may do so only as a plain-text claim visible in the answer.
Unsupported runtime-only assertions (for example `tool_call`, `tool_called`,
`no_tool_called`, or `role: "tool"`) are rejected by the shared text-only
fixture contract before execution.

### Weft-review fixture guidance

`weft-review` cases must remain synthetic and text-observable. Encode the
review target entirely inside the case description or runner prompt so the
suite never depends on a live repo diff. Score only review structure the text
runner can observe, such as:

- explicit `[APPROVE]` / `[REJECT]` verdict tags
- blocker count and presence/absence discipline
- actionable blocker lines with file references
- reviewed-file references in approvals

Avoid assertions that require tool traces, actual patch application, or hidden
repository state beyond the synthetic text provided to the model.

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
or whether a secret is truly live. The suite validates review-output shape, not
runtime security behavior.

### Text-only assertion boundary

All current suites are text-only. They may score only what is visible in the
assistant transcript text. Runtime-only assertions are rejected fail-closed by
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

Dry-run is the recommended contributor preflight path. It validates suite, model, and case allowlists without making model calls or requiring `OPENROUTER_API_KEY`. Valid dry runs exit `0`. Invalid dry runs exit non-zero because input validation still runs in dry-run mode.

### Filter semantics reminder

All filter values use **strict exact-match**. The `--case` value must exactly match the `id` field in the fixture — no glob, no prefix, no substring. Test new case IDs with `--dry-run` before running live.

## Loader API

The fixture loading and validation logic lives in the CLI package:

| Module                                              | Exports                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/cli/src/evals/types.ts`                   | Zod schemas and inferred TypeScript types for all fixture shapes      |
| `packages/cli/src/evals/model-matrix.ts`            | `loadModelMatrix`, `resolveDefaultModels`, `filterMatrix`, `validateModelInMatrix` |
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
