# Weave Eval Fixtures

This directory contains the canonical fixture files for `weave eval run`. It is the **allowlist source of truth** for model matrix entries, eval cases, and rubric scoring metadata.

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
│   └── tapestry-execution/             # Tapestry execution/delegation eval cases
│       ├── tapestry-execute-plan-step.json
│       └── tapestry-delegate-to-shuttle.json
└── rubrics/
    ├── loom-routing/                   # Scoring rubrics for loom-routing cases
    │   ├── loom-route-backend-api.json
    │   ├── loom-route-frontend-ui.json
    │   └── loom-route-ambiguous-direct-shuttle.json
    └── tapestry-execution/             # Scoring rubrics for tapestry-execution cases
        ├── tapestry-execute-plan-step.json
        └── tapestry-delegate-to-shuttle.json
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

### Suites

| Suite               | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `loom-routing`      | Verify Loom routes requests to the correct agent/category    |
| `tapestry-execution`| Verify Tapestry executes steps and delegates to sub-agents   |

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

### `transcript_expectations` checks

| `check`              | Required fields       | Description                                      |
| -------------------- | --------------------- | ------------------------------------------------ |
| `content_contains`   | `role`, `contains`    | Substring present in a message from `role`       |
| `tool_called`        | `tool_name`           | Tool appears at least once in transcript records |
| `agent_mentioned`    | `agent_name`          | Agent name appears in at least one assistant msg |
| `no_tool_called`     | `tool_name`           | Negative assertion: tool must NOT appear         |

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
5. Run `bun test ./packages/cli/src/evals/__tests__` to validate all fixtures load cleanly.
6. Run a local dry run to verify the case is picked up: `weave eval run --case <case-id> --dry-run`.
7. Run a live local eval to confirm scoring: `weave eval run --case <case-id>` (requires `OPENROUTER_API_KEY`).

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
