# Stable TUI Smoke Checklist — Pi Adapter

Checklist version: 1

- Spec: [`docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md`](33-spec-pi-adapter.md) §25
- Manifest schema: [`acceptance-manifest.schema.json`](acceptance-manifest.schema.json)
- Manifest instance: [`acceptance-manifest.json`](acceptance-manifest.json)

## Purpose

Spec 33 §25 requires stable publication to be backed by a **digest-bound**
live TUI smoke pass: a manual run against the exact package digest, subject
SHA, run attempt, host version, and checklist version recorded in the
acceptance manifest's `artifactBinding` block. This document is that
checklist. It is **not** automated — every item here is executed by a human
inside a real, interactive Pi TUI session against the exact tested host
version, never a fake host and never a headless harness.

**This checklist has not been executed.** Every row below is `Pending`.
Flipping a row to `Pass`/`Fail` is a live-execution action for whoever runs
the smoke pass (see `docs/specs/33-spec-pi-adapter/33-proofs/` for the
recorded outcome once that happens). Do not mark any row `Pass` without
having actually run it against the bound artifact.

## Binding rules

- The checklist version above MUST match `artifactBinding.checklistVersion`
  in `acceptance-manifest.json`.
- A pass is only valid for the exact `artifactBinding.packageVersion`,
  `payloadArtifactId`, `sha256`, `subjectSha`, and `runAttempt` recorded
  alongside it. Any rebuild, repack, or new commit invalidates every prior
  result — the whole checklist must be re-run against the new binding.
- Only an interactive TUI parent session counts. `pi --mode rpc --no-session`
  child processes, unit tests, and fake-host consumer tests are evidence for
  the automated rows of the acceptance manifest, never for this checklist.

## Prerequisites

1. The exact packed tarball identified by `artifactBinding` is installed as
   a Pi extension inside a real, interactive Pi TUI session.
2. The host is the exact tested version recorded in
   `docs/specs/33-spec-pi-adapter/acceptance-manifest.json` (`host.exactTestedVersion`),
   not merely "in range".
3. A disposable scratch project is available so trust/untrust behavior can
   be exercised without risking a real project's files.

## Checklist

| ID | Area | Check | Result |
| --- | --- | --- | --- |
| S001 | Install/trust/reload | Install the packed tarball against the exact tested host version inside a real interactive TUI session; the extension loads without crashing. | Pending |
| S002 | Install/trust/reload | Open an untrusted scratch project; confirm the adapter enters health-only mode and performs no materialization and no writes. | Pending |
| S003 | Install/trust/reload | Trust the project, then reload/restart the session; confirm the controller generation advances and no stale prior-generation state leaks into the new one. | Pending |
| S004 | Health | Run `/weave:health`; confirm exactly 19 sanitized capability probes are reported, one per capability ID. | Pending |
| S005 | Materialization | Confirm the Loom primary agent and configured shuttle/category agents materialize from `.weave/config.weave`. | Pending |
| S006 | Skill/model/prompt/temperature | Confirm declared `skills` resolve and are reflected in the composed prompt. | Pending |
| S007 | Skill/model/prompt/temperature | Confirm the ordered `models` list resolves to the first available model, and an unavailable model degrades per spec instead of crashing. | Pending |
| S008 | Skill/model/prompt/temperature | Confirm `prompt_append`/`prompt_append_file` renders after the primary prompt source. | Pending |
| S009 | Skill/model/prompt/temperature | Confirm `temperature` is applied when supported, or reported as a degraded capability when the host cannot honor it. | Pending |
| S010 | Tool policy | Confirm an `allow`-policy registered tool executes without a dialog. | Pending |
| S011 | Tool policy | Confirm a `deny`-policy registered tool is blocked with a safe, non-leaking message. | Pending |
| S012 | Tool policy | Confirm an `ask`-policy registered tool opens exactly one dialog and that `once`/`session`/`durable` approval scopes behave as advertised. | Pending |
| S013 | Tool policy | Confirm an unmanaged/unregistered tool call is left untouched by the permission bridge. | Pending |
| S014 | Authenticated child | Confirm `weave_delegate` spawns an authenticated `pi --mode rpc --no-session` child and that envelopes are HMAC-signed and sequenced. | Pending |
| S015 | Authenticated child | Confirm a delegated child's approval dialog and cooperative-then-forced cancellation both behave as documented. | Pending |
| S016 | Workflow/completion | Confirm `/weave:start` and `/weave:run` drive a full workflow through to a `weave_complete_step`-signaled completion. | Pending |
| S017 | Plan/artifact | Confirm `/weave:plan` reflects live plan markers/transitions matching `.weave/plans` state. | Pending |
| S018 | Plan/artifact | Confirm `/weave:artifact` approves or rejects an artifact revision with digest verification. | Pending |
| S019 | Resume | Confirm a killed or reloaded session does **not** auto-resume a paused execution. | Pending |
| S020 | Resume | Confirm `/weave:resume` explicitly resumes that same paused execution. | Pending |
| S021 | Diagnostics/usage | Confirm `.weave/runtime/logs/pi-adapter.ndjson` contains no prompts, secrets, or raw filesystem paths, and that usage observations are recorded. | Pending |
| S022 | Cleanup | Confirm session end triggers idempotent secret/child cleanup with no leaked child processes. | Pending |
| S023 | Package removal | Remove the packed package and reload; confirm Weave commands are gone, no child process remains, and durable `.weave/runtime` state stays inert for a later reinstall rather than being mutated or deleted. | Pending |

## Pass criteria

All 23 rows are `Pass` against the same recorded `artifactBinding`, with no
row skipped or marked `N/A`. A single `Fail` blocks stable publication until
the underlying defect is fixed and the entire checklist is re-run against a
new binding.
