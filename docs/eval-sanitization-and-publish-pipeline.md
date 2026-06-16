# Eval Sanitization and Publish Pipeline

**Location**: `packages/cli/src/evals/`

This document describes the sanitizer, bundle writer, raw artifact writer, and results repository publisher introduced in Task 7 of the eval framework. These modules enforce the publishable/local-only data boundary for `weave eval` output.

Related docs:

- [`docs/agent-evals.md`](./agent-evals.md) — eval architecture, fixture layout, CLI usage, and security checklist
- [`docs/eval-xss-policy.md`](./eval-xss-policy.md) — Markdown and report rendering XSS policy, allowlist rationale, and surface audit

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

### `artifact-bundle.ts` — Immutable Run Artifact Bundle Writer

**Assembles and writes publishable eval result bundles to an immutable, versioned `runs/` layout.**

#### Bundle Directory Layout

```
<bundleRoot>/runs/<runId>/
├── bundle-index.json          Top-level bundle manifest (publicFiles field enumerates only allowlisted public files)
├── run-summary.json           Aggregate pass/fail/counts (internal, not published)
├── score-<suite>.json         Per-suite sanitized score records (internal, not published)
├── prompt-hashes.json         Stable prompt hash records (internal, not published)
├── provenance-manifest.json   Full sanitized provenance manifest (internal, optional)
├── public-report.json         Public dashboard report (PublicReportBundle schema)
└── public-report.md           Human-readable Markdown report (optional, writeMarkdown: true)
```

#### Immutable Run IDs

Each run writes to a unique, immutable directory under `<bundleRoot>/runs/`. The run ID has the form `<gitSha[0..7]>-<YYYY-MM-DD>-<NNN>` where `NNN` is a zero-padded three-digit sequence number auto-incremented by scanning existing `runs/` siblings:

- First run on `abc123d` on `2026-01-15`: `runs/abc123d-2026-01-15-001/`
- Second run same SHA/date: `runs/abc123d-2026-01-15-002/`
- Next day: `runs/abc123d-2026-01-16-001/`

This guarantees no prior run's artifacts are ever overwritten. The `runs/` parent directory serves as the container for all run subdirectories.

**Key API changes** (backward-compatible):

- `computeRunIdPrefix(gitSha, assembledAt)` — derives `<sha7>-<YYYY-MM-DD>` (replaces old `computeBundleDirName`)
- `computeRunId(prefix, sequence)` — appends zero-padded sequence: `<prefix>-<NNN>`
- `resolveNextSequence(runsDir, prefix)` — scans `runs/` for the next available sequence number
- `computeBundleDirName()` — retained as a deprecated alias for `computeRunIdPrefix()` (test compatibility)
- `RUNS_SUBDIR = "runs"` — the constant for the `runs/` parent subdirectory name
- `BundleWriteResult.runId` — the immutable run ID for the written bundle (e.g. `abc123d-2026-01-15-001`)

#### `computeRunIdPrefix(gitSha, assembledAt)` — replaces `computeBundleDirName`

Pure helper that derives the run ID prefix without sequence. Falls back to `unknown` as the SHA prefix when `gitSha === "unknown"`. `computeBundleDirName` is a deprecated alias that returns the same value.

#### `computeRunId(prefix, sequence)`

Appends a zero-padded three-digit sequence number to the prefix to produce a unique run ID.

#### `resolveNextSequence(runsDir, prefix)`

Async helper that scans the `runs/` directory for existing entries matching `<prefix>-NNN` and returns the next unused sequence number (1 when `runsDir` doesn't exist yet).

#### `assembleBundle(options)` — Pure Function

Assembles an `EvalBundle` from runner results and provenance data. Runs all output through the sanitizer before returning. Returns `err(BundleError)` on sanitization failure.

**Multi-model score file aggregation**: When multiple `RunnerResult` values share the same `suite` name (typical in multi-model matrix runs where one `RunnerResult` is produced per model per suite), `assembleBundle` merges them into a **single `BundleScoreFile` per suite** using `aggregateScoreFile()`. This ensures that a full 5-model × 2-suite run produces exactly 2 score files — `score-loom-routing.json` and `score-tapestry-execution.json` — each containing all model rows, rather than being overwritten by each successive model result.

#### `aggregateScoreFile(suiteName, results, gitSha, assembledAt, dryRun)`

Merges all `RunnerResult` values for the same suite into one `BundleScoreFile`. Totals are recomputed from the merged set. `suiteGreen` is `true` iff every required, non-dry-run row passed. When `results` contains exactly one entry, this is equivalent to `assembleScoreFile()`.

#### `assembleScoreFile(runnerResult, gitSha, assembledAt, dryRun)`

Assembles a single `BundleScoreFile` from a single `RunnerResult`. Used internally by `aggregateScoreFile()`. Still exported for tests that work with a single-model result.

#### `ArtifactBundleWriter`

Writes the assembled bundle to an immutable run directory. Enforces:
1. **Token gate**: `EVAL_RESULTS_REPO_TOKEN` must be set for `mode: "publish"`.
2. **Dry-run bypass**: dry-run bundles are always local-only (`mode: "publish"` is overridden to `"local"` when `dryRun: true`).
3. **Belt-and-suspenders JSON check**: `assertJsonPublishSafe()` is called on every serialized JSON string before writing.
4. **Immutable directories**: each call allocates a new `runs/<runId>/` directory via auto-incremented sequence.
5. **Public report**: `public-report.json` is assembled from `PublicReportBundle` and written alongside bundle files. When `writeMarkdown: true`, `public-report.md` is also written.

The `writeBundle()` result includes a `runId` field (e.g. `abc123d-2026-01-15-001`) in addition to `bundleDir` and `filesWritten`.

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
| `RawCaseResultArtifact` | `case-<safeCaseId>-<safeModelId>-<YYYY-MM-DDTHH-MM-SS-mmmZ>.json` |
| `RawPromptArtifact` | `prompt-<safeAgentName>-<YYYY-MM-DDTHH-MM-SS-mmmZ>.json` |

Case IDs, model IDs, and agent names are sanitized before they become filename components. Slashes, backslashes, traversal segments such as `..`, and other unsafe characters are replaced or stripped. The writer also checks the resolved path before write so raw artifacts stay inside `<localBundleDir>/raw/`.

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

#### Remote v1 layout

All remote paths are versioned under a `v1/` segment to allow future layout changes without destroying existing content.

**Immutable run artifacts** are written to:

```
runs/v1/<runId>/<fileName>
```

where `<runId>` is the deterministic `<sha7>-<YYYY-MM-DD>-<NNN>` identifier
and `<fileName>` must be in `RUN_ARTIFACT_ALLOWLIST`.

**Derived index artifacts** are written to:

```
indexes/v1/<fileName>
```

where `<fileName>` must be in `INDEX_ARTIFACT_ALLOWLIST`.

#### Public artifact allowlists

`RUN_ARTIFACT_ALLOWLIST` is the closed set of file names allowed under `runs/v1/<runId>/`:

| File name | Description |
|---|---|
| `bundle-index.json` | Top-level run manifest (enumerates only allowlisted public files in `publicFiles` field) |
| `public-report.json` | Public dashboard report (PublicReportBundle schema) |
| `public-report.md` | Human-readable Markdown report (download-only) |

`isIndexArtifactAllowed(fileName)` is the gating function for index artifacts under `indexes/v1/`.
It accepts:

| Name / Pattern | Example | Description |
|---|---|---|
| `dashboard-manifest.json` | exact | All runs index (mutable — updated after each run) |
| `latest.json` | exact | Most-recent run snapshot (mutable) |
| `last-N-runs.json` | exact | Last N runs index (mutable) |
| `suite-history-<suiteName>.json` | `suite-history-loom-routing.json` | Per-suite pass-rate history (mutable) |
| `model-comparison-<runId>.json` | `model-comparison-abc1234-2026-06-11-001.json` | Per-run model comparison table (mutable) |

Any file name NOT accepted by `isIndexArtifactAllowed()` is filtered out before upload — even if the caller explicitly lists it in `indexFileNames`. Names containing `/`, `\`, or `..` are always rejected regardless of prefix matching.

#### Publish-before-index ordering invariant

`GitHubContentsPublisher` enforces a strict upload ordering:

1. All immutable run artifacts under `runs/v1/<runId>/` are uploaded first.
2. Only after ALL run artifacts are committed are index files uploaded under `indexes/v1/`.

This guarantees that any consumer fetching `indexes/v1/dashboard-manifest.json` will always find complete run artifact directories for every run listed.

#### Website loader restriction

Website consumers MUST fetch specific known paths — they MUST NOT enumerate directories. The exact paths to fetch are declared by the `dashboard-manifest.json` entry point. This prevents run artifact discovery via directory listing and ensures only allowlisted files are served.

#### Re-publish behavior

Re-publishing a run refreshes index files (new `updatedAt`, new entries) while immutable run artifacts are left untouched. The GitHub Contents API returns HTTP 422 when a file already exists and the SHA is mismatched — this surfaces as `PublishFailed` for run artifacts but is non-fatal for index files (indexes are always re-generated from immutable run artifacts).

#### Security invariants

- Token is read from `EVAL_RESULTS_REPO_TOKEN` and placed **only** in the `Authorization` header.
- Token is never logged (structured log entries contain only paths and HTTP status codes).
- Token is never included in any error message returned to callers.
- Token is never serialized to disk or included in any bundle artifact.
- Raw files (`raw/`) are excluded before any upload: `GitHubContentsPublisher` filters out any path containing `raw/` even if explicitly listed in `fileNames`.
- **Error messages are redacted**: HTTP response bodies are never surfaced (only the HTTP status code), and remote path details are omitted from run artifact upload failure messages to avoid leaking run IDs or path structure in error responses.

#### Dependency injection for tests

Both the `fetch` implementation and the file reader can be injected:

```ts
const publisher = new GitHubContentsPublisher(stubFetchImpl, stubFileReader);
```

This avoids real network and disk calls in tests. See `__tests__/github-contents-publisher.test.ts`.

#### Error handling

All failures return typed `ResultsRepoError` values — no exceptions propagate. HTTP errors include the status code in the message for diagnosis but never include the token value or remote file paths. Network errors are bounded to 200 characters of the connection error message.

---

## `schemaVersion` and Freshness Requirements

Every published artifact (both immutable run artifacts and mutable index files) carries a `schemaVersion` integer as the first key in the JSON object. This is a hard contract between the publishing pipeline and website consumers.

### Run artifacts (`runs/v1/<runId>/`)

| Artifact | `schemaVersion` constant | Behavior |
|---|---|---|
| `public-report.json` (`PublicReportBundle`) | `REPORT_BUNDLE_SCHEMA_VERSION` | Immutable; forever-cacheable; consumers MUST reject unrecognised versions |
| `bundle-index.json` | `BUNDLE_SCHEMA_VERSION` (written as `schemaVersion` field) | Immutable; consumers MUST reject unrecognised `schemaVersion` values |

Immutable run artifacts under `runs/v1/<runId>/` are written **once and never overwritten**. Consumers MAY cache them indefinitely because a run ID uniquely identifies a single, immutable bundle.

### Index artifacts (`indexes/v1/`)

| Artifact | `schemaVersion` constant | Freshness field |
|---|---|---|
| `dashboard-manifest.json` (`DashboardManifest`) | `DASHBOARD_MANIFEST_SCHEMA_VERSION` | `updatedAt` |
| `latest.json` | `LATEST_SNAPSHOT_SCHEMA_VERSION` | `updatedAt` |
| `last-N-runs.json` | `LAST_N_RUNS_SCHEMA_VERSION` | `updatedAt` |
| `suite-history-<suite>.json` (`SuiteHistoryManifest`) | `SUITE_HISTORY_SCHEMA_VERSION` | `updatedAt` |
| `model-comparison-<runId>.json` (`ModelComparisonManifest`) | `MODEL_COMPARISON_SCHEMA_VERSION` | `updatedAt` |

Mutable index artifacts MUST be re-fetched on every dashboard load (or after a TTL). Consumers MUST:

1. Reject any index where `schemaVersion` does not match the expected version constant.
2. Compare `updatedAt` against a freshness threshold and re-fetch when stale.

Use the typed validators in `dashboard-indexes.ts` for these checks:
- `validateDashboardManifestCompatibility()` — returns `ok(parsed)` or `err(DashboardIndexError)` with `SchemaVersionMismatch` or `IndexParseError` variant
- `validateSuiteHistoryCompatibility()` — same contract for suite history manifests
- `validateLatestSnapshotCompatibility()` — same contract for `latest.json`

### Website data flow

The `/weave-agent-evals/` dashboard fetches data through a strict, ordered fetch chain:

```
1. GET indexes/v1/dashboard-manifest.json   ← entry point; mutable; short TTL
        │
        ├── schemaVersion check → reject if mismatch
        ├── updatedAt check → re-fetch if stale
        │
        ├── 2. GET indexes/v1/latest.json               ← mutable; short TTL
        ├── 3. GET indexes/v1/last-N-runs.json           ← mutable; short TTL
        ├── 4. GET indexes/v1/suite-history-<suite>.json  ← per suite from manifest
        │
        └── for each run listed in manifest.runs:
              5. GET runs/v1/<runId>/public-report.json  ← IMMUTABLE; forever-cacheable
```

**No directory enumeration**: consumers MUST NOT enumerate `runs/v1/` or `indexes/v1/` directories. Only exact paths declared in the manifest (or in `bundle-index.json`'s `publicFiles` field) are fetched. The `dashboard-manifest.json` entry point is always the starting URL.

**Publish-before-index ordering**: `GitHubContentsPublisher` always uploads all immutable run artifacts before updating any index. When `dashboard-manifest.json` lists a run, that run's `public-report.json` is guaranteed to exist.

**`/evals/` is a legacy surface**: the original `/evals/` dashboard remains online for existing bookmarks and is not redirected. It uses the old family-specific JSONL data format. All new development targets `/weave-agent-evals/` and the `runs/v1/` + `indexes/v1/` layout. Do not add new features to `/evals/` — new eval capabilities belong in `/weave-agent-evals/`.

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
7. **Deterministic paths**: bundle directory names are `<sha7>-<YYYY-MM-DD>-<NNN>`; identical inputs (same SHA + date) produce unique directories via sequence numbers. Same layout is used locally under `runs/<runId>/` and in the results repo under `runs/v1/<runId>/`.
8. **Multi-model score aggregation**: same-suite runner results from multiple models are merged into one score file per suite — never overwritten.
9. **`localDiagnostic` is local-only**: the `RawErrorSummary.localDiagnostic` field carries redacted scorer/provider error messages for local debugging. It is in `SENSITIVE_FIELD_NAMES` and is rejected by both `assertPublishSafe()` and `assertJsonPublishSafe()`.
10. **Secret redaction**: `localDiagnostic` values are passed through `redactSecrets()` before storage, removing API keys, bearer tokens, and other secret-like strings. The diagnostic is also bounded to 500 characters.
11. **Token never in CLI args**: `GitHubContentsPublisher` uses the GitHub REST Contents API via `fetch()`, not `git clone/push`. The token appears only in the `Authorization` HTTP header — never in process arguments, URLs, or logs.
12. **Raw/ exclusion at publish time**: `GitHubContentsPublisher` re-filters all file names to exclude `raw/` paths even when caller-supplied, providing a belt-and-suspenders guard against accidental raw artifact publication.
13. **HTML injection blocked at schema**: `FORBIDDEN_EXPLANATION_PATTERNS` in `report-schema.ts` rejects `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, inline event handlers (`on*=`), `javascript:` URIs, and `data:` URIs in any explanation field. Explanations matching these patterns are dropped at assembly time (graceful degradation).
14. **Markdown is plain-text only**: `public-report.md` is a download-only artifact. It is never injected as HTML via `innerHTML` or any equivalent. See [`docs/eval-xss-policy.md`](./eval-xss-policy.md) for the full policy.
15. **Remote v1 layout is locked**: all remote paths in `weave-io/weave-agent-evals` follow `runs/v1/<runId>/<fileName>` (immutable) and `indexes/v1/<fileName>` (derived). The `REMOTE_LAYOUT_VERSION = "v1"` constant governs both. Changing the layout version migrates all remote paths without touching existing content.
16. **Public artifact allowlist**: only files in `RUN_ARTIFACT_ALLOWLIST` (`bundle-index.json`, `public-report.json`, `public-report.md`) may appear under `runs/v1/<runId>/`. For index files, `isIndexArtifactAllowed()` gates publication — it accepts exact names (`dashboard-manifest.json`, `latest.json`, `last-N-runs.json`) and pattern-validated names (`suite-history-<suite>.json`, `model-comparison-<runId>.json`). File names containing `/`, `\`, or `..` are always rejected. All other names are rejected before upload, even if explicitly listed.
17. **`bundle-index.json` enumerates only allowlisted public files via `publicFiles`**: the top-level run manifest contains a `publicFiles` array listing only `bundle-index.json`, `public-report.json`, and optionally `public-report.md` — whichever were actually written. Internal artifacts (`run-summary.json`, `score-*.json`, `prompt-hashes.json`, `provenance-manifest.json`) MUST NOT appear in `publicFiles`. `bundle-index.json` no longer includes `scoreFiles` (suite name list) or `provenanceRef` fields. Website loaders use `bundle-index.json`'s `publicFiles` to discover run files — they MUST NOT walk directories.
18. **`bundle-index.json` is written last**: `ArtifactBundleWriter` writes `bundle-index.json` after all other run artifacts so that `publicFiles` accurately reflects which public files were actually written (e.g., `public-report.md` only appears when `writeMarkdown: true`).
19. **Publish-before-index ordering**: `GitHubContentsPublisher` always uploads all immutable run artifacts (`runs/v1/<runId>/*`) before uploading any index artifact (`indexes/v1/*`). This invariant guarantees that `dashboard-manifest.json` always points to complete run artifact directories.
20. **Publisher errors are redacted**: HTTP response bodies are never surfaced in error messages (only the HTTP status code). Remote path details are omitted from run artifact upload failure messages to avoid leaking run IDs or path structure. Network error messages are bounded to 200 characters.
21. **No directory walking by consumers**: website loaders fetch specific known paths (`dashboard-manifest.json` → listed run paths, then `bundle-index.json`'s `publicFiles` for each run). Enumeration of `runs/v1/` or `indexes/v1/` directories is not allowed — only exact paths declared in the manifest or `publicFiles` are fetched.

---

## Markdown and Report Rendering XSS Policy

See [`docs/eval-xss-policy.md`](./eval-xss-policy.md) for the complete specification. Summary:

### `public-report.md` (Markdown artifact)

- **Served as download or raw plain text only.** Never injected as HTML into a web page.
- No Markdown-to-HTML rendering occurs browser-side for this artifact.
- The renderer (`report-markdown.ts`) applies `MARKDOWN_INJECTION_PATTERNS` checks on every value before inclusion in the output. HTML injection attempts are replaced with an empty string.
- All user-supplied strings pass through `sanitizeMdValue()` which: (1) rejects any string matching a known HTML injection pattern, and (2) escapes pipe characters to prevent Markdown table layout breakage.

### `public-report.json` (JSON artifact, dashboard-consumed)

- Dashboard UI (`dashboard-ui.js`) consumes `public-report.json` values via `innerHTML` assignment.
- All values rendered via `innerHTML` MUST be escaped by `escapeHtml()` before inclusion.
- `escapeHtml()` neutralizes: `& < > " '` — sufficient to prevent tag injection and attribute breakout.
- Explanation fields that contain HTML injection payloads are dropped at the schema level by `BoundedExplanationSchema` (via `FORBIDDEN_EXPLANATION_PATTERNS`) before they reach any rendering surface.

### Banned rendering paths

The following are categorically banned regardless of context:

- `innerHTML` assignment of Markdown text or any unescaped user data
- Rendering `public-report.md` as HTML without a strict sanitizer
- Passing any `explanation.text` value directly to a rendering context without escaping
- `javascript:` or `data:` URIs in any href or src attribute
- Raw HTML blocks (`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`) in any rendered surface
