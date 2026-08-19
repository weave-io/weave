# Stable TUI Smoke Checklist — Pi Adapter

Checklist version: 6

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
[`docs/specs/33-spec-pi-adapter/33-proofs/`](../../../docs/specs/33-spec-pi-adapter/33-proofs/),
indexed with current status by
[`33-proofs/README.md`](../../../docs/specs/33-spec-pi-adapter/33-proofs/README.md).
Task 20 ran the acceptance matrix as a set of per-item runs against several
subjects and artifacts, not as one shared digest-bound sweep, so each row
below is bound to the artifact recorded inside its own proof file and to no
other.

## Pi 0.83 fail-closed session contract

Pi `0.83.0` addresses native sessions by caller-supplied filesystem path. The
adapter therefore cannot prove that a session write lands inside host-owned
storage, so the required capability `descriptor-relative-native-session-io`
probes `unavailable` with reason `path-only-session-api`. The production probe
port answers that surface `false` unconditionally: no environment variable,
setting, RPC method presence, or session-restore support can raise it.

Every generation on this host therefore enters health-only mode and **fails
closed for all persistent session mutation and child spawn**. Commits
`c24182f`, `50d59b4`, and `5af9f1b` enforce that boundary before any
controller, session service, filesystem, cache, execution lease, or child
process call. The blocked routes are `weave_delegate` (start, retry, continue,
steer, follow-up), relayed child delegation, direct workflow dispatch,
cancellation, clear, recovery, and `weave adapter pi children delete`.

The descriptor-safe **read-only** surfaces stay available and are still
recorded as passing: status, health, plan, inspect, `/weave:history`,
`/weave:doctor`, and `weave adapter pi children list` / `show`. Those rows
record read availability only. They are never evidence that any mutation or
spawn path works on this host.

### Final-head re-run of the read-only rows

Rows `S057`, `S063`, `S064`, and `S067` were re-run live against the final
fail-closed head `9a8c64683f3e159a587119ee045dc60ae5a62e86` on Pi `0.83.0`.
`33-task21-final-head-fail-closed-proof.md` is their current record. It binds
artifact SHA-256 `2647e8b19cb49b5796edfb188fd1af739827d6e3098b1a9d7ab259ced536e566`
and also records the fail-closed rejection of `weave_delegate`, `/weave:run`,
`/weave:start`, and `children.delete` with no child process, execution lease,
ref, cache mutation, or native child session, plus pristine non-creating
startup, non-creating production CLI reads, bounded and fail-closed
native-session reads, explicit title provenance, and an inert interrupted legacy
ref. It supersedes its own earlier `43ebc13` and `b0997de` bindings and every
intermediate artifact run between them. The Task 20 `(j)`, `(k)`, and
`(n)` records are **historical** for pre-`c24182f` behaviour, including their
formerly passing mutation rows.

### Superseded Task 20 live delegation rows

Rows `S040`, `S041`, `S043`-`S049`, `S051`-`S053`, `S055`, `S056`, `S058`,
`S059`, `S061`, `S065`, and `S066` were proved by Task 20 live runs that
spawned a persistent child or mutated a native session. Those runs predate the
fail-closed contract, so their proof files are retained as **historical**
records of the pre-`c24182f` behaviour only. They are `Pending` below and are
not presented as evidence for the current head. Re-running them requires a
host that proves `descriptor-relative-native-session-io`.

The historical checklist version 1 rows `S014`, `S015`, and `S016` also
exercised delegation and direct workflow dispatch on Pi `0.81.1`. They remain
bound to that historical host and artifact and say nothing about Pi `0.83.0`.

## Task 14 Pi 0.84.1 binding

- Package: `@weaveio/weave-adapter-pi@0.0.1`, installed with strict `npm:` provenance
- Exact source subject: `4082fe81ea11cbf9a7c89dc34a4279064c6462e2`
- Exact host: `@earendil-works/pi-coding-agent@0.84.1`
- Checklist version: `6`
- Artifact: `weaveio-weave-adapter-pi-0.0.1-4082fe8-task14.tgz`
- Artifact SHA-256: `309fa5f876b5d39fd59897935b7b91dcfd6494ec8d9f6e25748f60b980b03ebc`
- `dist/extension.js` SHA-256: `5a205dd8cebc881f81fadd309144096e5049beb94f19d374160c8e7676ac2c6d`
- `dist/index.js` SHA-256: `7a90296d4dc01a2d8655cfaf8407cec9e1d2aefcc891ff0146699f66bed7fada`
- Run attempt: `1`
- `childSettlementMissingCount`: `0`
- No Herdr pane was created for this proof; therefore no created pane remained.
- No process rooted at the isolated harness remained after cleanup.
- Proof: [`33-overlay-ux-live-proof.md`](../../../docs/specs/33-spec-pi-adapter/33-proofs/33-overlay-ux-live-proof.md)

This binding closes the Pi 0.84.1 overlay, Pi-native session, provider-error,
and production deletion rows recorded by the Task 14 proof. Historical Pi 0.83
rows remain historical where the Task 14 proof does not replace them.

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

### Task 21 final-head binding (rows S057, S063, S064, S067)

- Package: `@weaveio/weave-adapter-pi@0.0.1`
- Exact source subject: `9a8c64683f3e159a587119ee045dc60ae5a62e86`
- Exact host: `@earendil-works/pi-coding-agent@0.83.0`; the machine's global Pi
  `0.84.1` stayed untouched
- Checklist version: `3`
- Artifact SHA-256:
  `2647e8b19cb49b5796edfb188fd1af739827d6e3098b1a9d7ab259ced536e566`
- `dist/extension.js` SHA-256:
  `55b297dbd4c1be9025730868d97f34ef1c812dc977acc9999fe5aa541f374f79`
- `dist/index.js` SHA-256:
  `72234af6eec11719e10de4d87bd3cb53c3553d329454dd0c0dbcfd24846604f2`
- `dist/cli.js` SHA-256:
  `1dbb9bf5fe9a27fad82c6096b58f45f5a291367ba7d61c236b29d033690f015e`
- Recorded in `33-task21-final-head-fail-closed-proof.md`

## Task 20 proof records

The table below names the proof file that recorded each row. Proof
files are sanitized: they record digests, counts, and outcomes, never prompts
or transcripts.

Every row in this table that required a persistent child spawn or a native
session mutation is now `Pending`, and its proof file is **historical**: it
documents pre-`c24182f` behaviour and is not evidence for the fail-closed
head. Only `S050`, `S057`, `S063`, `S064`, and `S067` — read-only and
reporting surfaces — still carry a current `Pass`. `S057`, `S063`, `S064`, and
`S067` are recorded by the Task 21 final-head record; the Task 20 `(j)`, `(k)`,
and `(n)` files are historical for every row they carried, including their
formerly passing mutation rows.

| Proof record (`docs/specs/33-spec-pi-adapter/33-proofs/`) | Rows | Status |
| --- | --- | --- |
| `33-task-20-a-compact-live-settlement-proof.md` | S040, S041 | Historical |
| `33-task20-b-overlay-live-steer-followup.md` | S043, S044, S046 | Historical |
| `33-task20-c-historical-restart-pagination-search-proof.md` | S045 | Historical |
| `33-task20-d-picker-navigation-proof.md` | S048, S049 | Historical |
| `33-task20-e-double-escape-cancel-proof.md` | S051 | Historical |
| `33-task20-f-retry-continue-frozen-block-proof.md` | S052, S053 | Historical |
| `33-task20-g-child-response-missing-retryable-proof.md` | S055 | Historical |
| `33-task20-h-transition-stay-cancel-switch-proof.md` | S058 | Historical |
| `33-task20-i-fork-clone-origin-exclusion-proof.md` | S059 | Historical |
| `33-task20-j-no-session-readonly-proof.md` | S056, S057 | Historical |
| `33-task20-k-history-doctor-cli-proof.md` | S063, S064, S065, S066 | Historical |
| `33-task20-l-resume-exclusion-proof.md` | S061 | Historical |
| `33-task20-m-pi-vim-coexistence-proof.md` | S047, S049, S050 | S050 current; S047 and S049 historical |
| `33-task20-n-health-only-readonly-proof.md` | S057, S067 | Historical |
| `33-task21-final-head-fail-closed-proof.md` | S057, S063, S064, S067 | **Current** (final head `9a8c646`) |

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
| S007 | Model fallback release smoke | Run `scripts/release/pi-model-failover-smoke.ts --case all` against the exact packed adapter digest on Pi `0.84.2` with an ephemeral `--report` path. Confirm provider-only context repair, durable failed-attempt history, stable identities, one visible fallback event, the exact card identity and Native Line, one final settlement, bounded cleanup, and optional-surface-disabled rollback with ready health, `health-only: false`, legacy settlement, and no fallback artifacts. | Pass |
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
| S040 | Compact block | The compact child block shows the latest fragment as a bounded 3-line tail while the child runs. | Pending |
| S041 | Compact block | On settlement the compact block shows the final response tail or error, and every prior run's block stays frozen. | Pending |
| S042 | Compact block | The compact block renders at narrow widths, sanitizes terminal control sequences, and isolates render errors. | Pending |
| S043 | Overlay | The live overlay transcript live-tails, disengages on manual scroll, and survives resize and expansion toggles. | Pending |
| S044 | Overlay | Steer a running child with Enter and queue a follow-up with Alt+Enter, without leaking either into the parent session. | Pending |
| S045 | Overlay | Open a historical child after a parent restart, with bounded pagination and in-overlay search. | Pending |
| S046 | Overlay | Settled children are read-only and no focused overlay input reaches the primary editor. | Pending |
| S047 | Overlay | The overlay falls back to the custom-editor path and restores pi-vim's mode on unmount. | Pending |
| S048 | Picker | The picker lists children of every status with title precedence and active-first, newest-settled ordering. | Pending |
| S049 | Keys | Alt+I, Alt+1..9, sibling keys, and empty-Backspace parent-or-close behave as documented. | Pending |
| S050 | Keys | Keybinding conflicts are reported and never overwrite the user's own bindings. | Pass |
| S051 | Keys | `Escape` closes child inspection, never falls through to Pi, and leaves the child running. | Pass |
| S052 | Threads | Retry a retryable failed thread and a cancelled thread; each run gets a new block with divider metadata. | Pending |
| S053 | Threads | Continue a completed thread with a task, and confirm wrong-state continue/retry fails closed with typed diagnostics. | Pending |
| S054 | Threads | Structured thread errors cover already-running, stale, integrity, and not-retryable, and capacity is held while running and released on settlement. | Pending |
| S055 | Settlement | Empty, whitespace-only, thinking-only, and tool-only completions settle as retryable `ChildResponseMissing` with the transcript preserved. | Pending |
| S056 | Sessions | A `--no-session` parent fails delegation with `PersistentParentSessionRequired` and writes zero session files. | Pending |
| S057 | Sessions | Read-only history, picker, and doctor stay available under a non-persistent parent and in health-only mode. | Pass |
| S058 | Sessions | A session transition prompts with Stay as the default, cancels descendants, and writes settlement to the origin refs before switching. | Pending |
| S059 | Sessions | A new parent session shows no prior-session child data, and forked or cloned refs are excluded on origin mismatch. | Pending |
| S060 | Sessions | Quit and reload perform a bounded cancel then force-stop, leaving no residual child process. | Pending |
| S061 | Privacy | No child session appears in Pi's `/resume` list or default session tree. | Pending |
| S062 | Privacy | Child sessions and their cache use user-only permissions inside the contained root. | Pending |
| S063 | Diagnostics | `/weave:history` returns a bounded first page and `/weave:doctor` a sanitized report with no raw prompt or transcript. | Pass |
| S064 | CLI | `weave adapter pi children list/show` respect the 50/100 bounds and cursor, return stable JSON, and print no paths by default. | Pass |
| S065 | CLI | `weave adapter pi children delete` requires confirmation, appends a tombstone, and the child stays listed as a tombstone. | Pass |
| S066 | CLI | Deleting a parent leaves orphan children readable through history and doctor. | Pending |
| S067 | Mode | A missing required capability enters health-only mode reporting capability, version, contract, probe, mode, and remediation. | Pass |
| S068 | Boundary | Parent projections carry only bounded terminal output and numeric metadata, never child content. | Pending |
| S069 | Settlement | Valid bounded or transferred output never produces the exact structured `ChildSettlementMissing`. | Pending |
| S070 | Overlay | All six scroll keys move the mounted overlay viewport live in legacy, Kitty event-aware, and SS3 encodings, with no release repeats. | Pass |
| S071 | Overlay | Scroll keys work with pi-vim installed, and pi-vim keeps its modes after the overlay closes. | Pass |
| S072 | Overlay | `Escape` closes the overlay and the inspected child remains running. | Pass |
| S073 | Cancellation | Empty-draft `q` opens confirmation; explicit cancellation cancels, while dismissal or Keep running leaves the child running. | Pass |
| S074 | Cancellation | Non-empty draft `q` edits the draft without confirmation; a settled child reports no cancellation target. | Pass |
| S075 | Telemetry | The header shows authoritative provider, model, context, and tokens, and `—` for values the host did not report. | Pass |
| S076 | Compact view | `Ctrl+O` toggles compact and full live/historical views while preserving draft, search state, and viewport anchor. | Pass |
| S077 | Key ownership | A host-owned `Ctrl+O` remains host-owned; the toggle is skipped, unadvertised, and reported once. | Pass |

## Pass criteria

Stable publication requires every row to be `Pass`, with no row skipped or
marked `N/A`. Rows `S001`-`S023` carry the historical checklist version 1
binding; the remaining `Pass` rows in `S040`-`S069` carry their own Task 20
checklist version 3 proof bindings and cover read-only surfaces only.

Stable publication is blocked on Pi `0.83.0` for three reasons:

1. The permission rows `S010`-`S013` were never re-run against the
   native-control adapter.
2. The six unproved rows `S042`, `S054`, `S060`, `S062`, `S068`, and `S069`
   have no live run at all.
3. Every persistent mutation and child spawn row is `Pending` because Pi
   `0.83.0` lacks `descriptor-relative-native-session-io`
   (`path-only-session-api`) and the adapter fails closed. These rows cannot
   pass on this host at all; they need a descriptor-safe host.

A single `Fail` blocks stable publication until the underlying defect is fixed
and the affected rows are re-run against a new binding.
