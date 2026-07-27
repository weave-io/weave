# Stable TUI Smoke Checklist — Pi Adapter

Checklist version: 1

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

**Historical run (2026-07-25).** All 23 rows passed for the former
permission-enabled artifact. Permission-specific rows do not validate the
current native-control adapter. A replacement digest-bound run is pending.
The historical run used an isolated `PI_CODING_AGENT_DIR`; it did not install
the adapter into the user's default `~/.pi` directory.

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

## Executed binding

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
| S010 | Tool policy | Confirm an `allow`-policy registered tool executes without a dialog. | Pass |
| S011 | Tool policy | Confirm a `deny`-policy registered tool is blocked with a safe, non-leaking message. | Pass |
| S012 | Tool policy | Confirm an `ask`-policy registered tool opens exactly one dialog and that `once`/`session`/`durable` approval scopes behave as advertised. | Pass |
| S013 | Tool policy | Confirm an unmanaged/unregistered tool call is left untouched by the permission bridge. | Pass |
| S014 | Authenticated child | Confirm `weave_delegate` spawns an authenticated `pi --mode rpc --no-session` child and that envelopes are HMAC-signed and sequenced. | Pass |
| S015 | Authenticated child | Confirm a delegated child's approval dialog and cooperative-then-forced cancellation both behave as documented, *and* that host-level abort/interrupt (`app.interrupt`/Esc) on the parent's own `weave_delegate` tool call cancels the exact generated child subtree immediately, rather than only after that child eventually settles on its own (see [`33-ordinary-delegation-cancellation-fix.md`](../../../docs/adapters/pi.md)). | Pass |
| S016 | Workflow/completion | Confirm `/weave:start <plan>` changes the parent badge to Tapestry and posts a visible kickoff user message in the same session without spawning a direct-step child; separately confirm `/weave:run` drives a durable workflow through `weave_complete_step`-signaled completion. | Pass |
| S017 | Plan/artifact | Confirm `/weave:plan` reflects live plan markers/transitions matching `.weave/plans` state. | Pass |
| S018 | Plan/artifact | Confirm `/weave:artifact` approves or rejects an artifact revision with digest verification. | Pass |
| S019 | Resume | Confirm a killed or reloaded session does **not** auto-resume a paused execution. | Pass |
| S020 | Resume | Confirm `/weave:resume` explicitly resumes that same paused execution. | Pass |
| S021 | Diagnostics/usage | Confirm `.weave/runtime/logs/pi-adapter.ndjson` contains no prompts, secrets, or raw filesystem paths, and that usage observations are recorded. | Pass |
| S022 | Cleanup | Confirm session end triggers idempotent secret/child cleanup with no leaked child processes. | Pass |
| S023 | Package removal | Remove the packed package and reload; confirm Weave commands are gone, no child process remains, and durable `.weave/runtime` state stays inert for a later reinstall rather than being mutated or deleted. | Pass |

## Pass criteria

All 23 rows are `Pass` against the same recorded `artifactBinding`, with no
row skipped or marked `N/A`. A single `Fail` blocks stable publication until
the underlying defect is fixed and the entire checklist is re-run against a
new binding.
