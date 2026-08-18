# Spec 33 — Pi post-recovery hook contract

Status: **Proposed**

Owner: Pi adapter.
Implementation issue: [#146](https://github.com/weave-io/weave/issues/146).
Plan: `.weave/plans/pi-transparent-runtime-model-fallback.md`.

This document is the normative public contract for Pi's post-recovery
extension hook. It does not authorize adapter production edits. Task 2
implements the hook in pi-mono against this contract. Later adapter tasks
consume it. If upstream review changes a name or shape, update this document
before those tasks consume the hook.

**Related:** [Spec 33](33-spec-pi-adapter.md) ·
[Threat model](33-threat-model.md) ·
[Pi adapter notes](../../adapters/pi.md)

## 1. Purpose

Give a loaded extension one public chance to switch model and request a single
in-session continuation after Pi has exhausted native retry and overflow
compaction recovery, and before Pi emits `agent_settled`.

The hook does not expose retry-ladder control, backoff configuration, or
pre-settlement provider-response interception. It is strictly post-recovery.

## 2. Source seam

Verified against both of these pins. The control flow matches.

| Pin | Identity |
| --- | --- |
| Installed host | `@earendil-works/pi-coding-agent@0.84.2` (`dist/core/agent-session.js`, `dist/core/extensions/types.d.ts`, `docs/extensions.md`) |
| Upstream source | `github.com/earendil-works/pi-mono` @ `59a71b235dadb4ad0d67557a8abb0aaa093e68b4` (`packages/coding-agent` version `0.84.2`, `src/core/agent-session.ts`) |

The named functions below are the insertion seam. A later Task 1 re-read that
finds a material change in this control flow must stop and revise the plan
instead of implementing against a stale contract.

### 2.1 `_runAgentPrompt`

1. Sets `_isAgentRunActive = true`.
2. Calls `agent.prompt(messages)`.
3. Loops `while (await this._handlePostAgentRun()) await this.agent.continue()`.
4. In `finally`, clears the system-prompt override, flushes pending bash
   messages, and always calls `_emitAgentSettled()`.

`_emitAgentSettled` sets `_isAgentRunActive = false`, emits the extension
event `{ type: "agent_settled" }` (no payload), then emits the same event on
the session listener bus.

### 2.2 `_handlePostAgentRun`

Takes `_lastAssistantMessage`, then clears that field. Returns `false` when
the field was empty.

Otherwise, in this order:

1. If `_isRetryableError(msg)` and `_prepareRetry(msg)` succeed, return
   `true`.
2. If `msg.stopReason === "error"` and `_retryAttempt > 0`, emit
   `auto_retry_end` with `success: false` and reset `_retryAttempt` to `0`.
3. If `_checkCompaction(msg)` returns `true`, return `true`.
4. Return `this.agent.hasQueuedMessages()`.

`_isRetryableError` rejects context overflow (compaction owns that path) and
otherwise delegates to `isRetryableAssistantError`. That classifier requires
`stopReason === "error"` and a matching transient `errorMessage`. 401 and 403
are not retryable, so they exhaust in one attempt.

### 2.3 `_prepareRetry`

Uses `settings.retry`. When the budget remains, it increments `_retryAttempt`,
emits `auto_retry_start`, removes the trailing assistant from
`agent.state.messages` when that last message is an assistant, waits the
exponential backoff, and returns `true`. Session history is not rewritten.

When the budget is exhausted it decrements `_retryAttempt` back to the
completed count and returns `false` without slicing. When the sleep is aborted
it emits `auto_retry_end` with `success: false` and returns `false`.

### 2.4 Overflow recovery

`_checkCompaction` treats same-model context overflow and recoverable length
stops as overflow. A completed `stop` over the window compact without retry.

A recoverable overflow or length stop compact-and-retries at most once:

- First attempt sets `_overflowRecoveryAttempted`, slices the trailing
  assistant from `agent.state.messages` (history untouched), and calls
  `_runAutoCompaction("overflow", willRetry)`.
- Second failure emits `compaction_end` with `willRetry: false` and returns
  `false`.

`_overflowRecoveryAttempted` resets on a new user `message_start` and on an
assistant `message_end` whose `stopReason` is neither `"error"` nor
`"length"`.

### 2.5 Non-material source/dist difference

On the failed-overflow path, current pi-mono source also calls
`_emitSessionCompactFailed` and distinguishes truncated-recovery error text
from overflow error text. Installed 0.84.2 emits only `compaction_end` with
the overflow error text. That difference does not change return values,
slicing, or `_emitAgentSettled` ordering, so it does not block this contract.

## 3. Event

Working name: `agent_recovery_exhausted`.

Rename only if upstream review requires it. Keep this document in sync before
adapter tasks consume the name.

### 3.1 When it fires

Fire the extension event at most once per exhausted native post-run cycle,
after `_handlePostAgentRun()` has returned `false` and before
`_emitAgentSettled()`.

Fire only when all of the following hold:

1. The assistant that `_handlePostAgentRun` just processed still exists.
2. That assistant's `stopReason` is `"error"`, or overflow recovery has
   already been attempted and that assistant's `stopReason` is `"length"`.
   The length clause exists so a failed compact-and-retry can still fail over
   to a larger-context model.
3. That assistant's `stopReason` is not `"aborted"`.
4. The per-prompt hook-continuation count is below the cap in §6.
5. The agent abort signal is not already aborted.

Do not fire on a successful `stop`, on `toolUse`, on mid-ladder retry, on
successful overflow compact-and-retry, or when queued follow-up or steering
messages caused `_handlePostAgentRun` to return `true`.

Capture the failed assistant and the completed native retry count **before**
`_handlePostAgentRun` clears `_lastAssistantMessage` and resets
`_retryAttempt`. After that function returns, those fields are gone.

### 3.2 Insertion

The observable loop is:

```text
await agent.prompt(messages)
loop:
  if _handlePostAgentRun() returns true:
    await agent.continue()
    repeat
  if hook fire conditions hold
     and a handler returns { retry: true }
     and the abort signal is not aborted
     and the cap still allows one continuation:
    increment the hook-continuation count
    slice the trailing failed assistant (§5)
    await agent.continue()
    repeat
  break
finally:
  _emitAgentSettled()
```

Native retry, overflow recovery, and queued continuations still run to
completion before the hook can fire. A hook-driven `continue()` starts a new
native recovery cycle. The hook may fire again only after that cycle also
exhausts, and only while the cap remains.

`agent_settled` still fires exactly once per `_runAgentPrompt`, in `finally`.

## 4. Ordering

`agent_end`, `auto_retry_*`, and `compaction_*` are Pi session-bus events.
`session_before_compact`, `session_compact`, `session_compact_failed`,
`agent_recovery_exhausted`, and `agent_settled` are extension events.
`auto_retry_end` and `compaction_end` are not extension events today.

Normative order for an exhausted native recovery:

```text
message_end          (failed assistant; persisted to session history)
agent_end            (willRetry is false once the native budget is spent)
auto_retry_end       (only when _retryAttempt > 0 at exhaustion; success: false)
compaction_end       (only on the failed-overflow path; willRetry: false)
agent_recovery_exhausted
    ├─ { retry: true }  → slice failed assistant → agent.continue()
    │                     (agent_settled is deferred)
    └─ any other result → agent_settled
```

`agent_end` always precedes the hook because it is emitted by `agent.prompt` /
`agent.continue` before `_handlePostAgentRun` runs.

`auto_retry_end` with `success: false`, when it occurs, is emitted inside
`_handlePostAgentRun` before that function returns `false`. It therefore
precedes the hook.

`compaction_end` with `willRetry: false` on the already-attempted overflow
path is also emitted inside `_handlePostAgentRun` and precedes the hook.
Successful overflow compact-and-retry returns `true` and never reaches the
hook.

`agent_settled` always follows the hook for that `_runAgentPrompt`. If the
hook requests a continuation, `agent_settled` waits until the continuation
cycle ends with no further native continue and no further accepted hook
retry.

The hook is an extension-runner event. It is not required on the session
listener bus or the RPC event stream. Weave loads the same extension in
primary and child processes and does not need an RPC copy of this event.

## 5. Payload, result, and failed-assistant removal

### 5.1 Payload

```ts
interface AgentRecoveryExhaustedEvent {
  type: "agent_recovery_exhausted";
  /** Failed assistant that exhausted native recovery. */
  message: AssistantMessage;
  /**
   * Completed native retry attempts for this post-run cycle, captured
   * before `_handlePostAgentRun` resets `_retryAttempt`. `0` when native
   * retry never started (disabled, non-retryable, or 401/403).
   */
  nativeRetryAttempts: number;
  /**
   * True when this cycle already consumed the single overflow
   * compact-and-retry.
   */
  overflowRecoveryAttempted: boolean;
  /** Agent-run abort signal. */
  signal: AbortSignal;
}
```

`message` is the same assistant object the session already persisted on
`message_end`. It may include `errorMessage` and `stopReason`. That is Pi's
existing assistant shape. Weave inspects `errorMessage` only inside a
bounded in-handler classifier and never persists, logs, renders, or sends
the raw text. See [Threat model](33-threat-model.md).

### 5.2 Result

```ts
interface AgentRecoveryExhaustedResult {
  retry?: boolean;
}
```

`{ retry: true }` requests one continuation. Any other value, `void`,
`undefined`, or a thrown handler is a decline.

Handlers run in extension load order. A throw is reported through the
existing extension-error path and counts as no vote. If any handler returns
`{ retry: true }`, Pi requests the continuation. Later handlers still run.
They cannot cancel a prior retry request.

Pi does not require the handler to call `setModel`. A retry with no model
change continues on the current model after the failed assistant is removed.
Weave's coordinator will only request retry after a confirmed switch; that
is an adapter rule, not a Pi rule.

### 5.3 Failed-assistant removal

On an accepted `{ retry: true }`, and only then, Pi removes the failed
assistant from active context with the same primitive `_prepareRetry` and
overflow recovery already use:

- If `agent.state.messages` is non-empty and the last message `role` is
  `"assistant"`, replace the array with `messages.slice(0, -1)`.
- Do not rewrite, delete, or rewrite-in-place session history. The failed
  assistant remains in durable history from the earlier `message_end`.
- Do not walk an arbitrary error chain. Native retry and the first overflow
  attempt have already sliced earlier failed assistants.

Then call `agent.continue()` with no new user message.

If the abort signal is aborted after a handler returns `{ retry: true }` and
before `continue()`, do not slice and do not continue.

## 6. Continuation cap

Frozen Pi-side constant: `MAX_AGENT_RECOVERY_EXHAUSTED_CONTINUATIONS = 8`.

The counter belongs to one `_runAgentPrompt` invocation. Reset it to `0` at
the start of each `_runAgentPrompt`. Increment it only when Pi accepts
`{ retry: true }` and actually calls `agent.continue()`. Declined hooks do
not increment. Native retries and overflow compact-and-retry do not
increment.

When the count is already `8`, skip the hook and settle. Do not fire an
event the handler cannot honor.

The cap is not a user setting. It exists so a buggy extension cannot loop
`{ retry: true }` forever. Weave's candidate cursor is a separate, tighter
adapter bound.

## 7. Abort

| Condition | Behavior |
| --- | --- |
| Last assistant `stopReason === "aborted"` | Do not fire. Settle. |
| `signal.aborted` before emit | Do not fire. Settle. |
| `signal.aborted` during a handler | Ignore `{ retry: true }`. Settle. |
| `signal.aborted` after `{ retry: true }` and before `continue()` | Do not slice. Do not continue. Settle. |
| User abort during a hook-driven `continue()` | Ordinary abort path. Do not re-fire the hook for that aborted assistant. |

`ctx.abort()` during the handler aborts the same agent signal. Existing
extension `emit` await semantics apply. This hook adds no extra timeout.

## 8. `model_select` interaction

The handler switches models with the existing public API:

```ts
const applied = await pi.setModel(model);
```

`ExtensionAPI.setModel` already:

1. Returns `false` when the provider has no configured auth. It does not
   throw and does not emit `model_select`.
2. Otherwise calls `AgentSession.setModel`, which throws if `checkAuth`
   fails, otherwise applies the model, appends the session model-change
   entry, reclamps thinking, and emits `model_select` with
   `source: "set"`.

`_emitModelSelect` is a no-op when the next model equals the current model.

The hook does not add a new `ModelSelectSource`. A hook-driven switch is
observationally identical to any other `pi.setModel` call. Weave's
coordinator treats a `model_select` that does not belong to its in-flight
`setModel` as a manual override. That latch is adapter-owned.

`setThinkingLevel` may emit `thinking_level_select` when the new model
reclamps thinking. That event is independent of the hook result.

## 9. Feature detection

Installed Pi 0.84.2 has no capability flag. `pi.on(event, handler)` already
accepts any string at runtime, so typed registration is not a runtime probe.

Hook-bearing hosts must advertise the hook on `ExtensionAPI`:

```ts
interface ExtensionFeatures {
  readonly agent_recovery_exhausted: true;
}

interface ExtensionAPI {
  readonly features?: ExtensionFeatures;
  on(
    event: "agent_recovery_exhausted",
    handler: ExtensionHandler<
      AgentRecoveryExhaustedEvent,
      AgentRecoveryExhaustedResult
    >,
  ): void;
}
```

On a hook-bearing host, `features` is a frozen object whose own enumerable
data property `agent_recovery_exhausted` is the boolean `true`.

A host supports the hook only when all of the following hold:

1. `features` is a non-null object.
2. `agent_recovery_exhausted` is an own enumerable data property.
3. Its value is exactly `true`.

Absence of `features`, a missing key, a non-`true` value, a throwing
accessor, or a host without the property is unsupported. The adapter wraps
this read in `Result.fromThrowable` and never compares `VERSION`,
`package.json`, or any other version string.

The TypeScript `on("agent_recovery_exhausted", ...)` overload documents the
event. It is not the runtime probe.

On a host without the hook, `_runAgentPrompt` is unchanged: exhausted
recovery falls through to `_emitAgentSettled()`. Behavior is byte-identical
to today.

## 10. Compatibility

| Rule | Contract |
| --- | --- |
| Upstream PR | Implement this contract in a pi-mono fork and open a PR against `earendil-works/pi-mono`. Record the PR URL on issue #146. |
| Pre-release proof | Build that fork at a pinned commit. Use the build only as a live-harness host. |
| No vendoring | Do not copy pi-mono sources into `@weaveio/weave-adapter-pi` or any other Weave package. |
| Floor | `HOST_VERSION_FLOOR` stays `0.81.1`. Absence of the hook is not a health-only condition. |
| Exact-tested version | `EXACT_TESTED_HOST_VERSION` stays on the last officially released, exact-tested host (`0.84.1` today). Move it only after an official Pi release ships this hook and Weave re-proves the affected rows. |
| Hook-less hosts | No `features.agent_recovery_exhausted`, no event, no continuation. Settlement matches current 0.81.1–0.84.x behavior. |

## 11. Non-goals

- Changing Pi retry defaults, max-retry settings, or backoff.
- Changing overflow compact-and-retry from its single attempt.
- Firing before `agent_end`, during the native retry ladder, or during a
  compact-and-retry that still intends to continue.
- Letting an extension suppress or rewrite native retry or compaction.
- Requiring a model switch as a condition of `{ retry: true }`.
- Emitting this event on the RPC stream.
- Version-string feature detection.
