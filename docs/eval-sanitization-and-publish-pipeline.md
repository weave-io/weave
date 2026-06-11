# Eval Sanitization and Publish Pipeline

**Location**: `packages/cli/src/evals/`

This document describes the sanitizer, bundle writer, raw artifact writer, and results repository publisher introduced in Task 7 of the eval framework. These modules enforce the publishable/local-only data boundary for `weave eval` output.

---

## Architecture Overview

```
Runner (loom-routing / tapestry-execution)
    │
    ├── CaseResult.summary  ──────────────────────► sanitizer.ts
    │   (publishable, no raw content)               └── sanitizeCaseResultSummary()
    │                                               └── assertPublishSafe()
    │                                               └── assertJsonPublishSafe()
    │
    ├── CaseResult.rawArtifact ────────────────────► raw-artifacts.ts
    │   (local-only, composedPrompt + transcript)   └── RawArtifactsWriter (enabled only)
    │
    └── RunnerResult ──────────────────────────────► artifact-bundle.ts
        (suiteGreen, caseResults, totals)           └── ArtifactBundleWriter
                                                    └── assembleBundle()
                                                    └── results-repo.ts
                                                         └── ResultsRepoPublisher
```

---

## Modules

### `sanitizer.ts` — Central Allowlist Sanitizer

**Single source of truth for publishable field policy.**

All functions here produce allowlisted projections of internal types:

| Function | Input | Output |
|---|---|---|
| `sanitizeCaseResultSummary()` | `CaseResultSummary` | `SanitizedCaseResultSummary` |
| `sanitizeScoreRecord()` | `NormalizedScoreRecord` | `SanitizedScoreRecord` |
| `sanitizeProvenanceRecord()` | `PromptProvenanceRecord` | `SanitizedProvenanceRecord` |
| `sanitizeProvenanceManifest()` | `PromptProvenanceManifest` | sanitized manifest |
| `dropUnknownFields()` | any object + allowlist | filtered object |
| `assertPublishSafe()` | any object | `Result<undefined, SanitizerError>` |
| `assertJsonPublishSafe()` | JSON string | `Result<undefined, SanitizerError>` |

**Allowlist design** — serialization is allowlist-first: only fields declared in `SanitizedCaseResultSummary`, `SanitizedScoreRecord`, etc. appear in publishable output. Unknown fields are silently dropped. This prevents accidental leakage when new fields are added to runner types.

**`SENSITIVE_FIELD_NAMES`** — a `Set<string>` of field names that must never appear in any publishable object. `assertPublishSafe()` rejects any object whose top-level keys include a member of this set. `assertJsonPublishSafe()` scans the serialized JSON string for these keys as JSON key patterns (`"fieldName"`).

Sensitive fields include: `composedPrompt`, `rawContent`, `rawPrompt`, `prompt`, `rawArtifact`, `rawArtifacts`, `transcript`, `rationale`, `dimensionRationales`, `toolArgs`, `env`, `cause`, `body`, `logTail`, `localDiagnostic`, and others.

The `localDiagnostic` field is specifically added to `SENSITIVE_FIELD_NAMES` because it is a local-only field on `RawErrorSummary` that contains redacted scorer/provider error messages. It is never safe for publishable output.

**`REDACTED` constant** — the sentinel string `[REDACTED]` used in place of any redacted field value, making redactions visible in diffs.

---

### `artifact-bundle.ts` — Deterministic Bundle Writer

**Assembles and writes publishable eval result bundles.**

#### Bundle Directory Layout

```
<bundleRoot>/<gitSha[0..7]>-<YYYY-MM-DD>/
├── bundle-index.json          Top-level bundle manifest
├── run-summary.json           Aggregate pass/fail/counts
├── score-<suite>.json         Per-suite sanitized score records
├── prompt-hashes.json         Stable prompt hash records (no raw text)
└── provenance-manifest.json   Full sanitized provenance manifest (optional)
```

The directory name `<gitSha[0..7]>-<YYYY-MM-DD>` is **deterministic** — the same inputs always produce the same path. This enables content-addressable storage and reproducible diffs.

#### `computeBundleDirName(gitSha, assembledAt)`

Pure helper that derives the deterministic directory name. Falls back to `unknown` as the SHA prefix when `gitSha === "unknown"`.

#### `assembleBundle(options)` — Pure Function

Assembles an `EvalBundle` from runner results and provenance data. Runs all output through the sanitizer before returning. Returns `err(BundleError)` on sanitization failure.

**Multi-model score file aggregation**: When multiple `RunnerResult` values share the same `suite` name (typical in multi-model matrix runs where one `RunnerResult` is produced per model per suite), `assembleBundle` merges them into a **single `BundleScoreFile` per suite** using `aggregateScoreFile()`. This ensures that a full 5-model × 2-suite run produces exactly 2 score files — `score-loom-routing.json` and `score-tapestry-execution.json` — each containing all model rows, rather than being overwritten by each successive model result.

#### `aggregateScoreFile(suiteName, results, gitSha, assembledAt, dryRun)`

Merges all `RunnerResult` values for the same suite into one `BundleScoreFile`. Totals are recomputed from the merged set. `suiteGreen` is `true` iff every required, non-dry-run row passed. When `results` contains exactly one entry, this is equivalent to `assembleScoreFile()`.

#### `assembleScoreFile(runnerResult, gitSha, assembledAt, dryRun)`

Assembles a single `BundleScoreFile` from a single `RunnerResult`. Used internally by `aggregateScoreFile()`. Still exported for tests that work with a single-model result.

#### `ArtifactBundleWriter`

Writes the assembled bundle to disk. Enforces:
1. **Token gate**: `EVAL_RESULTS_REPO_TOKEN` must be set for `mode: "publish"`.
2. **Dry-run bypass**: dry-run bundles are always local-only (`mode: "publish"` is overridden to `"local"` when `dryRun: true`).
3. **Belt-and-suspenders JSON check**: `assertJsonPublishSafe()` is called on every serialized JSON string before writing.

#### `assertBundlePublishEligible(bundle)`

Policy enforcement before external push. Rejects:
- Dry-run bundles (no model output, zero scores).
- Bundles with no score files.

---

### `raw-artifacts.ts` — Local-Only Raw Artifact Writer

**Controlled write path for short-lived debugging artifacts.**

Raw artifacts (`RawCaseResultArtifact`, `RawPromptArtifact`) contain raw transcript content, composed prompt text, and full dimension rationales. They are **never publishable**.

#### `RawArtifactsWriter`

- Constructor requires `rawArtifactsEnabled: true` as explicit opt-in.
- When disabled, all write methods return `err({ type: "RawArtifactsDisabled" })` — never throws.
- Files are written to `<localBundleDir>/raw/` subdirectory (`.gitignore`-able by convention).
- Validates that written JSON contains at least one raw content marker (`"composedPrompt"` or `"rawContent"`) to confirm the artifact is genuinely raw.

#### File Naming

| Artifact | Filename |
|---|---|
| `RawCaseResultArtifact` | `case-<caseId>-<safeModelId>-<YYYY-MM-DD>.json` |
| `RawPromptArtifact` | `prompt-<agentName>-<YYYY-MM-DD>.json` |

Model ID slashes are replaced with underscores to produce valid filenames.

#### Two-Direction Marker Check

- **Raw writer** verifies output **contains** `"composedPrompt"` or `"rawContent"` — confirms the artifact is genuinely raw.
- **Bundle writer** (`assertJsonPublishSafe()`) verifies output **does not contain** these markers — confirms the artifact is publishable.

This mutual exclusion means the raw/published paths cannot be swapped by accident.

---

### `RawErrorSummary.localDiagnostic` — Local-Only Scorer Diagnostic

When a scorer or model client error occurs during a run with `--raw-artifacts`, the `RawCaseResultArtifact.errorSummary` field is populated with a `RawErrorSummary`. In addition to the always-present `errorType` and `classification` fields, the `localDiagnostic` field now carries a bounded, secret-redacted copy of the error message:

```ts
interface RawErrorSummary {
  errorType: string;        // typed error discriminant
  classification: string;   // short sanitized label (e.g. "scoring-adapter-failure")
  dimension?: string;       // for ScorerAdapterError variants
  localDiagnostic?: string; // LOCAL-ONLY: redacted error message, max 500 chars
}
```

**`classification`** is always a fixed sanitized label derived from `errorType` — never contains raw provider/scorer message text. Safe in publishable output? No — the entire `RawErrorSummary` is local-only.

**`localDiagnostic`** is the bounded, secret-redacted error message for local debugging:
- Only populated when `--raw-artifacts` is explicitly used.
- Processed by `redactSecrets()` to remove API keys, bearer tokens, and secret-like strings before storage.
- Bounded to 500 characters (longer messages are truncated with `… [truncated]`).
- Blocked by `SENSITIVE_FIELD_NAMES` — any publishable JSON containing `"localDiagnostic"` is rejected.
- Only written to `raw/` subdirectory files, never to bundle files.

This gives local developers actionable failure information (e.g., `"LangChain AgentEvals judge call failed: timeout after 30s"`) without risking secret leakage in published artifacts.

---

### `results-repo.ts` — External Results Repository Publisher Interface

**Token-gated external bundle publication interface and test doubles.**

#### Policy Functions

| Function | Checks |
|---|---|
| `validatePublishToken(env)` | `EVAL_RESULTS_REPO_TOKEN` is present and non-empty |
| `validateRepoConfig(config)` | `repoUrl` starts with `https://` |
| `enforcePublishPolicy(bundle)` | Not dry-run, has score files, JSON is clean |

All return `ResultAsync<_, ResultsRepoError>` — no exceptions.

#### `ResultsRepoPublisher` Interface

```ts
interface ResultsRepoPublisher {
  publish(request: PublishBundleRequest): ResultAsync<PublishBundleResult, ResultsRepoError>;
}
```

#### Implementations

| Class | Purpose |
|---|---|
| `GitHubContentsPublisher` | Production publisher — GitHub REST Contents API (see `github-contents-publisher.ts`) |
| `NoOpResultsRepoPublisher` | Records calls but makes no real push; enforces full policy |
| `StubResultsRepoPublisher` | Test double with configurable FIFO response queue |

#### `ResultsRepoError` Discriminants

| `type` | When |
|---|---|
| `TokenMissing` | `EVAL_RESULTS_REPO_TOKEN` absent or empty |
| `RepoConfigInvalid` | `repoUrl` not `https://` |
| `DryRunPublishBlocked` | Bundle is a dry-run result |
| `UnsanitizedBundleBlocked` | Bundle JSON contains a sensitive field name |
| `NoScoreFilesToPublish` | Bundle has no score files |
| `PublishFailed` | Upload failure (HTTP error, network error) |

---

### `github-contents-publisher.ts` — GitHub REST Contents API Publisher

**Production implementation of `ResultsRepoPublisher`.**

Publishes sanitized bundle files to `weave-io/weave-agent-evals` using the GitHub REST API `/repos/{owner}/{repo}/contents/{path}` endpoint. The token is passed **only** as an HTTP `Authorization: Bearer <token>` header — never in URLs, command-line arguments, log messages, or serialized output.

#### Remote layout

Files are written to:

```
runs/<sha7>-<YYYY-MM-DD>/<fileName>
```

where `<sha7>-<YYYY-MM-DD>` is the local bundle directory name (already deterministic) and `<fileName>` is each sanitized bundle file.

#### Security invariants

- Token is read from `EVAL_RESULTS_REPO_TOKEN` and placed **only** in the `Authorization` header.
- Token is never logged (structured log entries contain only paths and HTTP status codes).
- Token is never included in any error message returned to callers.
- Token is never serialized to disk or included in any bundle artifact.
- Raw files (`raw/`) are excluded before any upload: `GitHubContentsPublisher` filters out any path containing `raw/` even if explicitly listed in `fileNames`.

#### Dependency injection for tests

Both the `fetch` implementation and the file reader can be injected:

```ts
const publisher = new GitHubContentsPublisher(stubFetchImpl, stubFileReader);
```

This avoids real network and disk calls in tests. See `__tests__/github-contents-publisher.test.ts`.

#### Error handling

All failures return typed `ResultsRepoError` values — no exceptions propagate. HTTP errors include the status code in the message for diagnosis but never include the token value.

---

## Publish Mode Decision Flow

```
WEAVE_EVAL_PUBLISH_MODE env var
    │
    ├── absent / "local" / other ──► mode = "local"
    │
    └── "publish" ──► mode = "publish"
                          │
                          └── writeBundle({ mode: "publish", dryRun: false })
                                  │
                                  ├── dryRun? ──yes──► effectiveMode = "local" ─► write locally, done
                                  │
                                  └── no ──► check EVAL_RESULTS_REPO_TOKEN
                                                │
                                                ├── missing ──► err(PublishTokenMissing)
                                                │
                                                └── present ──► assembleBundle()
                                                                └── sanitize
                                                                └── write local files
                                                                └── GitHubContentsPublisher.publish()
                                                                    └── enforcePublishPolicy()
                                                                    └── filter raw/ files
                                                                    └── PUT /repos/weave-io/weave-agent-evals/...
                                                                         (Authorization: Bearer <token>)
```

---

## Key Invariants

1. **Allowlist-first**: only fields in the `Sanitized*` types appear in publishable output.
2. **Unknown fields dropped**: extra fields on runner types are silently ignored, never leaked.
3. **Double check**: `assertPublishSafe()` (object-level) and `assertJsonPublishSafe()` (string-level) run on every publishable artifact.
4. **Token gate**: no external push occurs without `EVAL_RESULTS_REPO_TOKEN`.
5. **Dry-run local-only**: dry-run bundles are always written locally; publish mode is overridden to `"local"`.
6. **Raw artifact opt-in**: `RawArtifactsWriter` requires `rawArtifactsEnabled: true`; disabled writes return typed errors, not exceptions.
7. **Deterministic paths**: bundle directory names are `<sha7>-<YYYY-MM-DD>`; identical inputs produce identical output. Same layout is used locally and in the results repo under `runs/`.
8. **Multi-model score aggregation**: same-suite runner results from multiple models are merged into one score file per suite — never overwritten.
9. **`localDiagnostic` is local-only**: the `RawErrorSummary.localDiagnostic` field carries redacted scorer/provider error messages for local debugging. It is in `SENSITIVE_FIELD_NAMES` and is rejected by both `assertPublishSafe()` and `assertJsonPublishSafe()`.
10. **Secret redaction**: `localDiagnostic` values are passed through `redactSecrets()` before storage, removing API keys, bearer tokens, and other secret-like strings. The diagnostic is also bounded to 500 characters.
11. **Token never in CLI args**: `GitHubContentsPublisher` uses the GitHub REST Contents API via `fetch()`, not `git clone/push`. The token appears only in the `Authorization` HTTP header — never in process arguments, URLs, or logs.
12. **Raw/ exclusion at publish time**: `GitHubContentsPublisher` re-filters all file names to exclude `raw/` paths even when caller-supplied, providing a belt-and-suspenders guard against accidental raw artifact publication.
