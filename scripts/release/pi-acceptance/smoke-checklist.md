# Stable TUI Smoke Checklist — Pi Adapter

Checklist version: 3

- Spec: [`33-spec-pi-adapter.md`](../../../docs/adapters/pi.md)
- Manifest schema: [`acceptance-manifest.schema.json`](acceptance-manifest.schema.json)
- Manifest instance: [`acceptance-manifest.json`](acceptance-manifest.json)

## Purpose

The Pi adapter contract requires stable publication to be backed by a **digest-bound**
live TUI smoke pass: a manual run against the exact package digest, subject
SHA, run attempt, host version, and checklist version recorded in the
acceptance manifest's `artifactBinding` block. This document is that
checklist. It is **not** automated — every item here is executed by a human
inside a real, interactive Pi TUI session against the exact tested host
version, never a fake host and never a headless harness.

**Historical run (2026-07-25, checklist version 1).** Rows `S001`-`S023`
were executed against the former permission-enabled artifact on Pi `0.81.1`.
That run used an isolated `PI_CODING_AGENT_DIR`; it did not install the
adapter into the user's default `~/.pi` directory. Its results are retained
as historical context only. The permission-specific rows `S010`-`S013` do
not validate the current native-control adapter and were **not** re-run, so
they are `Pending` here and `PI-POL` stays `pending` in the manifest.

**Task 20 native-control run (Pi `0.83.0`, checklist version 3).** Rows
`S040`-`S069` belong to this checklist version. Each passing row was
executed by hand in an isolated Pi `0.83.0` harness and recorded in its own
proof file under
[`docs/specs/33-spec-pi-adapter/33-proofs/`](../../../docs/specs/33-spec-pi-adapter/33-proofs/).
Task 20 ran the acceptance matrix as a set of per-item runs against several
subjects and artifacts, not as one shared digest-bound sweep, so each row
below is bound to the artifact recorded inside its own proof file and to no
other.

## Binding rules

- The checklist version above MUST match `artifactBinding.checklistVersion`
  in `acceptance-manifest.json`.
- The `artifactBinding` block written by
  `scripts/release/generate-acceptance-manifest.ts` is a **generator-local**
  binding: it packs the current committed source tree, so its
  `payloadArtifactId` is `local-dev-pack`, its `runAttempt` is `1`, and its
  `subjectSha` is the repository `HEAD` the generator ran from. That binding
  is not the artifact any live row ran against, and it must never be read as
  a claim that the Task 20 live rows were executed on it. The artifact each
  live row actually ran against is recorded in that row's proof file.
- A pass is only valid for the exact `artifactBinding.packageVersion`,
  `payloadArtifactId`, `sha256`, `subjectSha`, and `runAttempt` recorded
  alongside it. Any rebuild, repack, or new commit invalidates every prior
  result — the whole checklist must be re-run against the new binding.
- Only an autonomous interactive TUI parent session counts. Child processes,
  unit tests, and fake-host consumer tests are evidence for the automated rows
  of the acceptance manifest, never substitutes for this checklist.

## Executed bindings

### Historical checklist version 1 binding (rows S001-S023)

- Package: `@weaveio/weave-adapter-pi@0.0.1`
- Payload artifact: `weaveio-weave-adapter-pi-0.0.1.tgz`
- Payload SHA-256: `b1cb577545af10c1c559bf619dca546132a50d6514357f2b2ab8b027b12badbf`
- Subject SHA: `d8a20d58fe3f11daa63c7d4c8e0895c81a8435a1`
- Run attempt: `16`
- Exact host: `@earendil-works/pi-coding-agent@0.81.1`
- Host binary SHA-256: `271b7a506398e4ece04c664c7723705d4fa874c98e7a62d7b289e1fa582cf3c9`
- Checklist version: `1`
- Interactive model: `anthropic/claude-sonnet-5`

See [`33-task-12-proofs.md`](../../../docs/adapters/pi.md) for
the observed results, defects found during earlier attempts, fixes, and final
verification.

### Task 20 checklist version 3 bindings (rows S040-S069)

- Package: `@weaveio/weave-adapter-pi@0.0.1`, installed with `npm:` provenance
- Exact host: `@earendil-works/pi-coding-agent@0.83.0`, run from an isolated
  harness that left the machine's globally installed Pi untouched
- Checklist version: `3`
- Per-row subject SHA, packed artifact name, artifact SHA-256, installed
  `dist/*.js` digests, run attempt, `childSettlementMissingCount`, and pane
  cleanup are recorded in the proof file named for that row in
  [Task 20 proof records](#task-20-proof-records). The final behavioural
  production subject in that set is `16593bf`; earlier rows were proved on
  earlier subjects and are bound to those subjects, not to `16593bf`.

## Task 20 proof records

Every `Pass` row below cites the exact proof file that recorded it. Proof
files are sanitized: they record digests, counts, and outcomes, never
prompts or transcripts.

| Proof record (`docs/specs/33-spec-pi-adapter/33-proofs/`) | Rows |
| --- | --- |
| `33-task-20-a-compact-live-settlement-proof.md` | S040, S041 |
| `33-task20-b-overlay-live-steer-followup.md` | S043, S044, S046 |
| `33-task20-c-historical-restart-pagination-search-proof.md` | S045 |
| `33-task20-d-picker-navigation-proof.md` | S048, S049 |
| `33-task20-e-double-escape-cancel-proof.md` | S051 |
| `33-task20-f-retry-continue-frozen-block-proof.md` | S052, S053 |
| `33-task20-g-child-response-missing-retryable-proof.md` | S055 |
| `33-task20-h-transition-stay-cancel-switch-proof.md` | S058 |
| `33-task20-i-fork-clone-origin-exclusion-proof.md` | S059 |
| `33-task20-j-no-session-readonly-proof.md` | S056, S057 |
| `33-task20-k-history-doctor-cli-proof.md` | S063, S064, S065, S066 |
| `33-task20-l-resume-exclusion-proof.md` | S061 |
| `33-task20-m-pi-vim-coexistence-proof.md` | S047, S049, S050 |
| `33-task20-n-health-only-readonly-proof.md` | S057, S067 |

Rows `S042`, `S054`, `S060`, `S062`, `S068`, and `S069` have no Task 20 proof
record and stay `Pending`.

## Prerequisites

1. The exact packed tarball identified by `artifactBinding` is installed as
   a Pi extension inside a real, interactive Pi TUI session.
2. The host is the exact tested version recorded in
   `scripts/release/pi-acceptance/acceptance-manifest.json` (`host.exactTestedVersion`),
   not merely "in range".
3. A disposable scratch project is available so trust/untrust behavior can
   be exercised without risking a real project's files.

## Checklist

| ID | Area | Check | Result |
| --- | --- | --- | --- |
| S001 | Install/trust/reload | Install the packed tarball against the exact tested host version inside a real interactive TUI session; the extension loads without crashing. | Pass |
| S002 | Install/trust/reload | Open an untrusted scratch project; confirm the adapter enters health-only mode and performs no materialization and no writes. | Pass |
| S003 | Install/trust/reload | Trust the project, then reload/restart the session; confirm the controller generation advances and no stale prior-generation state leaks into the new one. | Pass |
| S004 | Health | Run `/weave:health`; confirm exactly 19 sanitized capability probes are reported, one per capability ID. | Pass |
| S005 | Materialization | Confirm the Loom primary agent and configured shuttle/category agents materialize from `.weave/config.weave`. | Pass |
| S006 | Skill/model/prompt/temperature | Confirm declared `skills` resolve and are reflected in the composed prompt. | Pass |
| S007 | Skill/model/prompt/temperature | Confirm the ordered `models` list resolves to the first available model, and an unavailable model degrades per spec instead of crashing. | Pass |
| S008 | Skill/model/prompt/temperature | Confirm `prompt_append`/`prompt_append_file` renders after the primary prompt source. | Pass |
| S009 | Skill/model/prompt/temperature | Confirm `temperature` is applied when supported, or reported as a degraded capability when the host cannot honor it. | Pass |
| S010 | Tool policy | Confirm an `allow`-policy registered tool executes without a dialog. | Pending |
| S011 | Tool policy | Confirm a `deny`-policy registered tool is blocked with a safe, non-leaking message. | Pending |
| S012 | Tool policy | Confirm an `ask`-policy registered tool opens exactly one dialog and that `once`/`session`/`durable` approval scopes behave as advertised. | Pending |
| S013 | Tool policy | Confirm an unmanaged/unregistered tool call is left untouched by the permission bridge. | Pending |
| S014 | Authenticated child | Confirm `weave_delegate` spawns an authenticated native-control child and that envelopes are HMAC-signed and sequenced. | Pass |
| S015 | Authenticated child | Confirm a delegated child's approval dialog and cooperative-then-forced cancellation both behave as documented, *and* that host-level abort/interrupt (`app.interrupt`/Esc) on the parent's own `weave_delegate` tool call cancels the exact generated child subtree immediately, rather than only after that child eventually settles on its own (see [`33-ordinary-delegation-cancellation-fix.md`](../../../docs/adapters/pi.md)). | Pass |
| S016 | Workflow/completion | Confirm `/weave:start <plan>` changes the parent badge to Tapestry and posts a visible kickoff user message in the same session without spawning a direct-step child; separately confirm `/weave:run` drives a durable workflow through `weave_complete_step`-signaled completion. | Pass |
| S017 | Plan/artifact | Confirm `/weave:plan` reflects live plan markers/transitions matching `.weave/plans` state. | Pass |
| S018 | Plan/artifact | Confirm `/weave:artifact` approves or rejects an artifact revision with digest verification. | Pass |
| S019 | Resume | Confirm a killed or reloaded session does **not** auto-resume a paused execution. | Pass |
| S020 | Resume | Confirm `/weave:resume` explicitly resumes that same paused execution. | Pass |
| S021 | Diagnostics/usage | Confirm `.weave/runtime/logs/pi-adapter.ndjson` contains no prompts, secrets, or raw filesystem paths, and that usage observations are recorded. | Pass |
| S022 | Cleanup | Confirm session end triggers idempotent secret/child cleanup with no leaked child processes. | Pass |
| S023 | Package removal | Remove the packed package and reload; confirm Weave commands are gone, no child process remains, and durable `.weave/runtime` state stays inert for a later reinstall rather than being mutated or deleted. | Pass |
| S040 | Compact block | The compact child block shows the latest fragment as a bounded 3-line tail while the child runs. | Pass |
| S041 | Compact block | On settlement the compact block shows the final response tail or error, and every prior run's block stays frozen. | Pass |
| S042 | Compact block | The compact block renders at narrow widths, sanitizes terminal control sequences, and isolates render errors. | Pending |
| S043 | Overlay | The live overlay transcript live-tails, disengages on manual scroll, and survives resize and expansion toggles. | Pass |
| S044 | Overlay | Steer a running child with Enter and queue a follow-up with Alt+Enter, without leaking either into the parent session. | Pass |
| S045 | Overlay | Open a historical child after a parent restart, with bounded pagination and in-overlay search. | Pass |
| S046 | Overlay | Settled children are read-only and no focused overlay input reaches the primary editor. | Pass |
| S047 | Overlay | The overlay falls back to the custom-editor path and restores pi-vim's mode on unmount. | Pass |
| S048 | Picker | The picker lists children of every status with title precedence and active-first, newest-settled ordering. | Pass |
| S049 | Keys | Alt+I, Alt+1..9, sibling keys, and empty-Backspace parent-or-close behave as documented. | Pass |
| S050 | Keys | Keybinding conflicts are reported and never overwrite the user's own bindings. | Pass |
| S051 | Keys | A double Escape within 750ms opens the cancel-subtree confirmation defaulting to Keep running, and a single Escape never falls through. | Pass |
| S052 | Threads | Retry a retryable failed thread and a cancelled thread; each run gets a new block with divider metadata. | Pass |
| S053 | Threads | Continue a completed thread with a task, and confirm wrong-state continue/retry fails closed with typed diagnostics. | Pass |
| S054 | Threads | Structured thread errors cover already-running, stale, integrity, and not-retryable, and capacity is held while running and released on settlement. | Pending |
| S055 | Settlement | Empty, whitespace-only, thinking-only, and tool-only completions settle as retryable `ChildResponseMissing` with the transcript preserved. | Pass |
| S056 | Sessions | A `--no-session` parent fails delegation with `PersistentParentSessionRequired` and writes zero session files. | Pass |
| S057 | Sessions | Read-only history, picker, and doctor stay available under a non-persistent parent and in health-only mode. | Pass |
| S058 | Sessions | A session transition prompts with Stay as the default, cancels descendants, and writes settlement to the origin refs before switching. | Pass |
| S059 | Sessions | A new parent session shows no prior-session child data, and forked or cloned refs are excluded on origin mismatch. | Pass |
| S060 | Sessions | Quit and reload perform a bounded cancel then force-stop, leaving no residual child process. | Pending |
| S061 | Privacy | No child session appears in Pi's `/resume` list or default session tree. | Pass |
| S062 | Privacy | Child sessions and their cache use user-only permissions inside the contained root. | Pending |
| S063 | Diagnostics | `/weave:history` returns a bounded first page and `/weave:doctor` a sanitized report with no raw prompt or transcript. | Pass |
| S064 | CLI | `weave adapter pi children list/show` respect the 50/100 bounds and cursor, return stable JSON, and print no paths by default. | Pass |
| S065 | CLI | `weave adapter pi children delete` requires confirmation, appends a tombstone, and the child stays listed as a tombstone. | Pass |
| S066 | CLI | Deleting a parent leaves orphan children readable through history and doctor. | Pass |
| S067 | Mode | A missing required capability enters health-only mode reporting capability, version, contract, probe, mode, and remediation. | Pass |
| S068 | Boundary | Parent projections carry only bounded terminal output and numeric metadata, never child content. | Pending |
| S069 | Settlement | Valid bounded or transferred output never produces the exact structured `ChildSettlementMissing`. | Pending |

## Pass criteria

Stable publication requires every row to be `Pass`, with no row skipped or
marked `N/A`. Rows `S001`-`S023` carry the historical checklist version 1
binding; rows `S040`-`S069` carry their own Task 20 checklist version 3 proof
bindings. The permission rows `S010`-`S013` and the six unproved rows
`S042`, `S054`, `S060`, `S062`, `S068`, and `S069` are still `Pending`, so
stable publication remains blocked until they are executed against a recorded
binding. A single `Fail` blocks stable publication until the underlying defect
is fixed and the affected rows are re-run against a new binding.
