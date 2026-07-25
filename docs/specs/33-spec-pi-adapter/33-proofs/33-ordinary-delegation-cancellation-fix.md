# Proof Artifact — Ordinary-delegation cooperative cancellation

- Spec: [`33-spec-pi-adapter.md`](../33-spec-pi-adapter.md) §11.5 (cancellation invariant added by this change), §12.2
- Issue: weave-io/weave#21, Task 12 — discovered during live exact-host (Pi 0.81.1) smoke, checklist item [S015](../33-smoke-checklist.md)
- Status: ✅ Fixed and covered by isolated regression tests — ⏳ live exact-host re-verification of S015 still outstanding (this change does not and cannot fabricate that result; see "What remains" below)

## Bug

Live smoke against exact Pi 0.81.1 showed `app.interrupt`/Esc on a running
`weave_delegate` root tool call did not cancel the delegated child. The
parent turn only unblocked once the child eventually settled on its own.

Root cause: `buildDelegationToolRegistration`'s `execute()` in
`packages/adapters/pi/src/delegation-tool.ts` destructured the host's
five-argument tool ABI (Spec 33 §12.2) as
`(_toolCallId, params, _signal, _onUpdate, ctx)` — the `AbortSignal` the
host passes was received and immediately discarded. Nothing in the file
ever called `PiDelegationController.cancelSubtree(childId)`, so an abort had
no effect on the exact child the tool had just generated and dispatched.

## Fix

`packages/adapters/pi/src/delegation-tool.ts`:

- `execute()` now reads its `signal` argument and wires it to the exact
  generated `childId`:
  - **Already aborted before dispatch** — checked immediately after
    `childId` is generated and before `controller.delegate()` is ever
    called. Fails closed with a `ChildAbortFailed`-coded structured result;
    never spawns a child for an already-cancelled call.
  - **Mid-flight abort** — an `abort` listener (registered with `once: true`
    and re-checked for `signal.aborted` right after registration, closing
    the listener-registration race) calls
    `controller.cancelSubtree(childId)`. A successful cancellation resolves
    nothing on its own; the tool's `Promise.race` keeps waiting for the same
    `controller.delegate(request)` promise to settle with the child's own
    `{outcome: "cancelled"}` (delivered via `PiRpcChild.completeCancellation`,
    §11.5) — the tool never fabricates that settlement itself.
  - **Cancellation failure** — if `cancelSubtree()` itself fails, that
    failure (first entry of its `readonly PiAdapterFailure[]`, or a
    `ChildAbortFailed` fallback for the — otherwise impossible — empty-array
    case) resolves the race immediately instead of leaving the tool hung
    behind a `delegate()` promise that may never settle. This is handled
    with an explicit `neverthrow` `.match()` that handles both branches;
    no cancellation result is left unobserved or caught and logged away.
  - **No leak** — the listener is removed in a `finally` covering every
    return path (before-dispatch failure, race winner either way), so a
    settled tool call is never re-entered by a later abort on the same
    signal.
- `buildRelayedDelegationToolRegistration` (a delegated child's own nested
  `weave_delegate` relay tool) is intentionally **not** changed. Its wire
  protocol has no child-to-parent cancellation primitive —
  `PiChildRuntime.admitVerifiedEnvelope` only ever admits `cancel` envelopes
  travelling parent-to-child — so there is no equivalent signal for a relay
  call to observe. Cancelling a nested delegate-request is only reachable
  from the root, by cancelling the ancestor subtree that contains it.

Spec 33 §11.5 (in `33-spec-pi-adapter.md`) now states this wiring as a
normative invariant, including the relay non-wiring rationale, so it is not
lost as tribal knowledge.

## Regression tests

`packages/adapters/pi/src/__tests__/delegation-tool.test.ts` (new cases,
against a fake controller — no real harness, no real process, per the
module-isolation testing rule):

- `execute: a signal already aborted before the child is ever dispatched fails closed, never touching the controller's delegate()`
- `execute: aborting mid-flight cancels the exact generated child subtree and resolves with the child's own structured cancelled settlement`
- `execute: an abort whose cancelSubtree() itself fails resolves promptly with the mapped failure, instead of hanging behind an unsettled delegate()`
- `execute: falls back to ChildAbortFailed when cancelSubtree() fails with an empty failure list`
- `execute: a signal that never aborts never touches cancelSubtree, and the once-listener never leaks past the settled call`

`packages/adapters/pi/src/__tests__/delegation-controller.test.ts` (new
case, against `FakeChildProcessPort` — proves the invariant the tool's
wiring depends on, at the layer below the tool):

- `cancelSubtree on a child whose task was genuinely dispatched (bootstrap-acked, running) resolves that exact child's own pending delegate() promise as a structured cancelled settlement (Spec 33 §11.5) - the invariant the weave_delegate tool's abort wiring depends on`

## Test run

```
$ bun test packages/adapters/pi/src/__tests__/delegation-tool.test.ts \
           packages/adapters/pi/src/__tests__/delegation-controller.test.ts
 38 pass
 0 fail
 122 expect() calls

$ bun run typecheck   # exit 0 across every workspace package, incl. @weaveio/weave-adapter-pi
```

A full `bun test packages/adapters/pi` run also passes (664 tests), though
the wider suite has pre-existing, unrelated real-timer flakiness under full
parallel load (observed on two of several runs, landing on different,
already-existing tests each time — never on a test this change added or
touched, and never reproducible when the affected file is run alone). This
flakiness predates this change and is out of this fix's scope.

## What remains (live execution — for the parent agent)

This proof establishes the fix and isolated regression coverage. It does
not and cannot substitute for live exact-host verification:

1. Re-run [S015](../33-smoke-checklist.md) against a real interactive Pi
   0.81.1 TUI session with this fix applied: start a `weave_delegate` call,
   press Esc/`app.interrupt` while the child is still running, and confirm
   the parent turn unblocks immediately with a structured cancelled result
   instead of waiting for the child to settle on its own.
2. Flip S015 from `Pending` to `Pass`/`Fail` only once actually run, per the
   checklist's own binding rules — never speculatively.
