# ADR 0013 — Pi Private Child Sessions

**Status:** Accepted

**Related:** [Pi Adapter](../adapters/pi.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · Issue #21

## Context

Pi child sessions need inspection, steering, follow-up, cancellation, bounded history, and recovery. Treating every child as `pi --mode rpc --no-session` makes the inspector transient and prevents safe inspection after reload. Putting child transcripts in Weave's Runtime Store would also make the harness-neutral engine own Pi session internals, private prompts, tool arguments, images, and UI payloads.

Issue #21 exposed a related but different recovery concern. It added an explicit engine-owned lease takeover for workflow recovery. That does not make private child sessions engine state and must not be reused as a private-session recovery mechanism.

## Decision

1. The Pi adapter owns private child session discovery, process/RPC transport, session I/O, transcript rendering, steering, follow-up, extension UI relay, quotas, trimming, quarantine, orphan pruning, physical clear, and recovery.
2. Persistent private history lives at `$XDG_DATA_HOME/weave/adapters/pi/child-history/<parent-session-id>/`, defaulting to `~/.local/share/weave/adapters/pi/child-history/<parent-session-id>/`. It uses mode `0700` directories, mode `0600` files, descriptor-relative no-follow I/O, and the V1 `index.v1.json` plus per-child session/checkpoint layout defined by Pi adapter contract.
3. Private child history is outside `.weave/runtime/**` and outside the Runtime Store. The engine may receive only the bounded sanitized fields expressly allowed by Pi adapter contract; it must not scan, expose, or recover private child history.
4. The exact private-child defaults, limits, commands, controls, privacy exclusions, and failure codes are normative in Spec 33. The adapter recovers only eligible interrupted ordinary top-level children; workflow resume remains an explicit `/weave:resume` engine operation with its existing lease and generation rules. Inspection does not require human review or approval; only the specified operational cancellation and recovery choices are exposed.
5. Raw private history stays local to the adapter-owned store. It must not enter Runtime Store records, journals, logs, health, failures, telemetry, diagnostics, acceptance proof, smoke artifacts, package exports, or network/remote sync.

## Consequences

- Pi can provide a native-feeling child inspector without expanding the engine API with Pi session concepts.
- Private history survives parent reload when configured, while clear and quota operations remain harness-specific.
- Engine recovery remains authoritative for durable workflows, and private child recovery cannot accidentally acquire or replace a workflow lease.
- The adapter must implement secure filesystem handling and sanitize every cross-boundary export.
- Session discovery, RPC, rendering, steering, follow-up, cancellation, recovery, quotas, trimming, quarantine, orphan pruning, and clear remain adapter concerns.
- The adapter must preserve controller-generation staleness and one-shot settlement while keeping full history inspectable after process disposal.
- The adapter must maintain compatibility and migration behavior for the V1 index and checkpoint format without moving private history into Runtime Store.
- Adapters for other harnesses need not adopt Pi's private-session format; this is a Pi adapter decision, not a core or engine contract.
