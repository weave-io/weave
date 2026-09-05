# 33-spec-harness-trajectory-evals.md

**Related**: [Specs Index](../README.md) · [ADR 0008: Harness Trajectory Evals via Two-Channel Observation](../../adr/0008-harness-trajectory-evals.md) · [Agent Evals](../../agent-evals.md) · [Adapter Boundary](../../adapter-boundary.md) · [Spec 31: Weave Agent Evals Reporting](../31-spec-weave-agent-evals-reporting/31-spec-weave-agent-evals-reporting.md) · [`packages/cli/src/evals/types.ts`](../../../packages/cli/src/evals/types.ts)

**Non-normative evidence**: A short empirical spike (Podman + OpenCode 1.18.27 + OpenRouter) proved the two-channel observation approach is viable at negligible cost. The spike artifacts are preserved outside the repository at `C:\Users\piete\AppData\Local\Temp\opencode\spike-tier2\`. That location is not part of the repo, is not committed, and is cited here only as evidence that informed this spec. It is not a build dependency and this spec does not require the spike directory to exist for any acceptance criterion below.

---

## Introduction / Overview

The current eval surface described in [`docs/agent-evals.md`](../../agent-evals.md) is text-only: every runner sends one chat completion to OpenRouter and scores assistant text. That surface cannot prove that a real harness actually spawned a subagent, actually called a tool, or actually completed a session without error. [ADR 0008](../../adr/0008-harness-trajectory-evals.md) decided to add a second, parallel eval track, **harness trajectory evals**, that observes a real harness session end to end.

This spec is the formal contract for that track. It defines:

- The normalized `TrajectoryEvent` union that every adapter must be able to produce, regardless of which observation channel it uses internally.
- The two-channel adapter contract (log parsing vs plugin hooks) and the boundary rule that the engine only ever sees the normalized event stream.
- The `expected_outcome.kind: "harness_trajectory"` case schema addition.
- The `TrajectoryRunner` interface that adapters implement to produce a `TrajectoryResult` from a case, a model, and a workspace.
- The `TrajectoryResult` shape, including the local-only raw artifact boundary and the publishable summary fields.
- The suite-registry gating rule that keeps trajectory outcomes opt-in per suite, mirroring the existing `allowedExpectedOutcomeKinds` gate for `tool_call`.
- The publishable field set and its sanitization envelope, aligned with [Spec 31](../31-spec-weave-agent-evals-reporting/31-spec-weave-agent-evals-reporting.md).

Trajectory evals are a parallel track, not a replacement. The eight existing text-only suites keep their current runners, fixtures, and publishable contract unchanged by this spec.

---

## Goals

1. Define the `TrajectoryEvent` discriminated union covering every event kind needed across the eight current suite families, even where only one suite (`loom-routing`) exercises trajectory evals in Phase 1.
2. Define the two-channel adapter contract (Channel A: runtime log parsing, Channel B: harness plugin hooks) as an adapter-internal implementation choice, invisible to the engine.
3. Define the `expected_outcome.kind: "harness_trajectory"` case schema fields: `expected_spawns`, `expected_tools`, `max_duration_seconds`, `sandbox_profile`.
4. Define the `TrajectoryRunner` interface and its `run()` contract, including the typed `TrajectoryRunnerError` union.
5. Define the `TrajectoryResult` shape: the full event stream, the publishable summary, and the local-only raw artifact reference.
6. Define the suite-registry gating rule (`allowedExpectedOutcomeKinds` gains `"harness_trajectory"` as a new possible entry, opt-in per suite).
7. Define the publishable field set verbatim from ADR 0008 and its sanitization envelope, consistent with Spec 31.

---

## Non-Goals

1. This spec does not implement the `TrajectoryRunner` for any specific adapter. Adapter implementation (Podman sandbox, log parser, plugin wiring) is tracked by the rollout plan in ADR 0008 and by future adapter-package work, not by this spec.
2. This spec does not change the eight existing text-only runners, their fixtures, or their publishable contract.
3. This spec does not define semantic correctness verification of produced code (ADR 0008 marks this an explicit non-goal, deferred to a future ADR on case-shipped verifier scripts).
4. This spec does not define sandbox hardening beyond the Podman defaults already described in ADR 0008.
5. This spec does not define cross-harness trajectory comparison or dashboard rendering details beyond the "Runtime-verified" badge concept already named in ADR 0008.

---

## `TrajectoryEvent` Union

The engine defines a normalized event union. Adapters are responsible for producing a stream of these events, regardless of which channel (A, B, or hybrid) they use internally. Weave-core asserts against this normalized shape only; it never inspects harness-native log formats or plugin hook payloads directly.

```ts
type TrajectoryEvent =
  | SessionCreatedEvent
  | SubagentSpawnedEvent
  | ToolCallBeforeEvent
  | ToolCallAfterEvent
  | MessageEmittedEvent
  | SessionCompletedEvent
  | SessionErroredEvent;
```

Every event carries a common envelope: `sessionId: string`, `timestamp: string` (ISO 8601), and `kind` as the discriminant.

| Event kind | Fields (beyond the common envelope) | Suite mapping (justification) |
| --- | --- | --- |
| `session-created` | `agentName: string`, `model: string` | Every suite's trajectory case starts here. This is the anchor event that scopes all subsequent events to one harness session, needed by all eight suites once each adopts trajectory cases. |
| `subagent-spawned` | `parentAgentName: string`, `childAgentName: string` | `loom-routing` (proves Loom actually spawned `shuttle`, not just that its text named `shuttle`) and `tapestry-execution` / `tapestry-category-routing` (proves real fan-out to one or more category shuttles, the exact gap ADR 0008 calls out as "currently indistinguishable in the published data"). |
| `tool-call-before` | `toolName: string`, `agentName: string` | `shuttle-execution` (proves a delegated task actually invoked `edit`/`write`/`bash` before it reports completion) and `pattern-planning` (proves a plan-authoring tool call preceded a reported plan artifact). |
| `tool-call-after` | `toolName: string`, `agentName: string`, `succeeded: boolean` | Same suites as `tool-call-before`; pairs with it to prove the tool call actually completed, not just that it started. Needed for `warp-security` and `weft-review` trajectory cases that must prove a review tool ran to completion before a verdict was emitted. |
| `message-emitted` | `role: "user" \| "assistant" \| "tool"`, `agentName: string` | `spindle-tools` (proves the research agent actually emitted a message turn tied to a real session, distinguishing real assistant output from a scripted fixture) and any suite needing a lightweight turn-count signal without inspecting message content (content itself is never carried on this event; see Sanitization below). |
| `session-completed` | `agentName: string`, `durationMs: number` | All eight suites eventually use this to compute `harnessCompletedWithoutError` and to enforce `max_duration_seconds`. |
| `session-errored` | `agentName: string`, `errorKind: string` | All eight suites eventually use this as the failure counterpart to `session-completed`. `errorKind` is a bounded enum-like string (for example `"timeout"`, `"tool_failure"`, `"harness_crash"`), never a raw error message or stack trace, to keep the event itself publishable-adjacent and consistent with the sanitization envelope below. |

Phase 1 ships only the `loom-routing` trajectory case described in ADR 0008's rollout step 4 (`loom-route-shuttle-implement-utility-trajectory`), which exercises `session-created`, `subagent-spawned`, `tool-call-before`, `tool-call-after`, `session-completed`, and `session-errored`. `message-emitted` is defined now so the union does not need a breaking change when a later suite (`spindle-tools`) adopts trajectory cases; it is justified above but not exercised by the Phase 1 case.

---

## Two-Channel Adapter Contract

The adapter, not the engine, decides how to produce a `TrajectoryEvent` stream. Two channels are defined, per ADR 0008:

- **Channel A (runtime log parsing).** The adapter parses the harness's own structured stderr/stdout stream (for example OpenCode's `--print-logs --log-level DEBUG` key/value output) into `TrajectoryEvent` records. This channel requires no plugin registration inside the harness.
- **Channel B (harness plugin).** The adapter registers a harness-native plugin that subscribes to typed harness hooks (for example `tool.execute.before`, `chat.message`, `event`) and emits `TrajectoryEvent` records directly from those hook callbacks.

An adapter may use either channel, or a hybrid of both, as long as the final event stream handed to the `TrajectoryRunner` conforms to the `TrajectoryEvent` union. This is an adapter-internal decision. Per [`docs/adapter-boundary.md`](../../adapter-boundary.md):

- The engine does not know which channel a given adapter chose.
- The engine does not scan harness-owned log directories or register concrete harness callbacks itself. Both are adapter responsibilities.
- The engine only consumes the normalized `TrajectoryEvent[]` stream returned by the adapter's `TrajectoryRunner` implementation.

This preserves the same engine/adapter split already established for skill resolution (Spec 09), tool policy (Spec 08), and materialization (Spec 15): the engine owns the normalized contract and abstract policy, the adapter owns concrete harness integration.

---

## Case Schema Addition: `expected_outcome.kind: "harness_trajectory"`

A new discriminated union member is added to the existing `ExpectedOutcomeSchema` in `packages/cli/src/evals/types.ts`, alongside the current `agent_routing`, `task_completion`, `delegation_chain`, and `tool_call` members:

```ts
z.object({
  kind: z.literal("harness_trajectory"),

  /** Ordered list of child agent names the harness is expected to spawn. */
  expected_spawns: z.array(z.string()),

  /** Tool names the harness is expected to invoke at least once. */
  expected_tools: z.array(z.string()),

  /** Wall-clock budget for the whole session. The runner fails the case
   *  (session-errored, errorKind "timeout") if this is exceeded. */
  max_duration_seconds: z.number().positive(),

  /** Names the adapter-owned sandbox profile to run the session under.
   *  This is a symbolic reference (for example "opencode-default"), not a
   *  literal Containerfile path. Adapters resolve the profile name to a
   *  concrete sandbox definition; the engine never inspects the sandbox
   *  definition itself. */
  sandbox_profile: z.string(),
})
```

`EXPECTED_OUTCOME_KINDS` in `types.ts` gains `"harness_trajectory"` as a new literal. `ExpectedOutcomeKind` is its inferred union type, so this is additive: existing cases with `agent_routing`, `task_completion`, `delegation_chain`, or `tool_call` are unaffected.

`expected_spawns` may be an empty array for a trajectory case that only asserts tool usage without delegation (for example a `shuttle-execution` trajectory case that never spawns a further child agent). `expected_tools` may likewise be empty for a pure-routing trajectory case that only asserts `subagent-spawned` events. Both fields are required (not optional) so that a case author must make an explicit, visible choice rather than silently omitting an assertion axis.

---

## `TrajectoryRunner` Interface

```ts
interface TrajectoryRunner {
  run(
    testCase: EvalCase,
    model: string,
    workspace: TrajectoryWorkspace,
  ): ResultAsync<TrajectoryResult, TrajectoryRunnerError>;
}
```

- `testCase` is the same `EvalCase` shape used by text-only runners, with `expected_outcome.kind === "harness_trajectory"`.
- `model` is a single model ID from the effective model set, exactly as passed to the existing text-only runners.
- `workspace` is an adapter-provided handle to the ephemeral per-case workspace (mount point, working directory, and any adapter-specific sandbox context). The engine never constructs this value; it is supplied by the adapter's harness-specific setup step, consistent with the adapter owning sandbox definitions.

`TrajectoryRunnerError` is a discriminated union, following the project's `neverthrow` convention (never thrown, always returned):

| Type | When |
| --- | --- |
| `SandboxStartFailed` | The adapter could not start the sandbox for `sandbox_profile`. |
| `TimeoutExceeded` | Wall-clock duration exceeded `max_duration_seconds` before `session-completed` or `session-errored` was observed. |
| `EventStreamMalformed` | The adapter produced a byte stream that could not be parsed into valid `TrajectoryEvent` records. |
| `HarnessCrashed` | The harness process exited unexpectedly before emitting `session-completed` or `session-errored`. |
| `WorkspaceUnavailable` | The `workspace` handle was invalid or became unreachable during the run. |

Each variant carries `testCaseId: string` and `model: string` so callers can correlate a failure back to the originating case without inspecting a raw error message.

---

## `TrajectoryResult` Shape

```ts
interface TrajectoryResult {
  /** Full ordered TrajectoryEvent stream observed for this session. This is
   *  internal data; it is never written directly to a publishable artifact. */
  events: TrajectoryEvent[];

  /** The bounded, allowlisted, sanitization-checked projection that is safe
   *  to write into a publishable CaseResultSummary. See Publishable Field
   *  Set below. */
  summary: TrajectorySummary;

  /** Reference to the raw artifact (for example the sandbox's
   *  trajectory.jsonl and any container logs), written only to the
   *  local-only raw/ subdirectory. This field is a path or identifier, not
   *  the raw content itself, and it must never appear in a publishable
   *  bundle. */
  rawArtifactRef: RawArtifactRef;
}

interface RawArtifactRef {
  /** Path relative to the local-only raw/ subdirectory root, following the
   *  same boundary RawCaseResultArtifact already enforces for text-only
   *  cases (see Spec 31 and eval-sanitization-and-publish-pipeline.md). */
  path: string;
}
```

The `events` field and the `RawArtifactRef.path` target are both local-only. Only `summary` is eligible for inclusion in a publishable `CaseResultSummary`, and only after it passes the sanitization checks described below.

---

## Publishable Field Set

The publishable summary fields are defined verbatim from ADR 0008 and must not be extended without a new ADR:

```ts
interface TrajectorySummary {
  harnessDelegatedCorrectly: boolean;
  observedSpawns: string[];
  observedToolCalls: number;
  harnessCompletedWithoutError: boolean;
}
```

- `harnessDelegatedCorrectly`: computed by comparing `observedSpawns` (derived from `subagent-spawned` events) against `expected_outcome.expected_spawns`. `true` only when every expected spawn was observed, in any order unless a future spec adds ordering assertions.
- `observedSpawns`: an ordered array of child agent names, derived directly from `subagent-spawned` events. Agent names only, never arguments or session content.
- `observedToolCalls`: a count only, derived from `tool-call-after` events. No tool names, no tool arguments, no file contents.
- `harnessCompletedWithoutError`: `true` when a `session-completed` event was observed and no `session-errored` event was observed for the same `sessionId`.

These four fields are the entire publishable surface of a trajectory case. No other trajectory-derived field may appear in a publishable `CaseResultSummary` or `PublicCaseEntry` (Spec 31) without a new ADR extending this set, because the set is intentionally bounded to what ADR 0008 approved.

### Sanitization envelope

Trajectory summaries flow through the same allowlist discipline as Spec 31's `PublicCaseEntry`:

1. `TrajectorySummary` is the only trajectory-derived shape eligible for a public schema. It contains no rationale strings, no transcript content, no tool arguments, and no raw error text, satisfying the `SENSITIVE_FIELD_NAMES` strict-mode rejection rule from Spec 31.
2. `events` (the full `TrajectoryEvent[]` stream) and `rawArtifactRef` are never passed through the sanitizer or the public schemas. They exist only inside the internal `TrajectoryResult` and the local-only `raw/` artifact writer, mirroring how `RawCaseResultArtifact` is handled for text-only cases.
3. `session-errored.errorKind` is a bounded, enum-like string (see the `TrajectoryEvent` table above), never a raw error message. If a future case needs to publish an error category, it must go through `buildExplanation()` with `source: "structured_signal"`, exactly as Spec 31 already requires for other boolean/enum signal fields. Raw `errorKind` strings from adapter internals are not directly publishable without this pass.
4. Publishing a `TrajectorySummary` follows the same versioned, `.strict()`-mode schema discipline as every other public schema in Spec 31: if `PublicCaseEntry` is extended to carry trajectory fields, that extension bumps `SUITE_SUMMARY_SCHEMA_VERSION` and is proven with the same typed-test pattern Spec 31 already requires (valid fixture passes, sensitive-field fixture is rejected, not stripped).

---

## Suite-Registry Gating Rule

Trajectory outcomes are opt-in per suite, mirroring the existing gate for `tool_call` outcomes described in [`docs/agent-evals.md`](../../agent-evals.md#text-only-contract-and-explicit-non-goal).

- The shared suite registry entry (`packages/cli/src/evals/types.ts`) for each suite carries `allowedExpectedOutcomeKinds: readonly ExpectedOutcomeKind[]`.
- `"harness_trajectory"` is a new possible entry in that array. It is **not** added to any suite's registry entry by this spec. This spec only makes the literal a valid schema value; suite-by-suite opt-in is a separate, later change gated by the registry itself.
- A case with `expected_outcome.kind: "harness_trajectory"` in a suite whose registry entry does not list `"harness_trajectory"` in `allowedExpectedOutcomeKinds` is rejected before fixture discovery or execution, using the same fail-closed pattern that currently rejects `tool_call` outcomes and `tool_called`/`no_tool_called`/`content_contains` with `role: "tool"` transcript checks on today's eight text-only suites.
- Per ADR 0008's rollout plan, the first suite expected to opt in is `loom-routing`, adding `"harness_trajectory"` alongside its existing `["agent_routing"]` entry. This spec defines the gate; it does not itself perform that registry edit.
- A suite may mix trajectory cases and text-only cases in the same case directory. They are scored by different runners (`TrajectoryRunner` vs the existing text-only runners) and reported as separate dashboard rows, so a suite's aggregate pass rate never conflates a text-only signal with a runtime-verified signal.

---

## Acceptance Criteria

1. **`TrajectoryEvent` union defined and justified.** All seven event kinds (`session-created`, `subagent-spawned`, `tool-call-before`, `tool-call-after`, `message-emitted`, `session-completed`, `session-errored`) are defined with field lists, and each kind is mapped to at least one of the eight current suite families with an explicit justification, per the table above.
2. **Two-channel contract documented.** Channel A (log parsing) and Channel B (plugin hooks) are both defined as adapter-internal choices. The engine/adapter boundary is stated explicitly: the engine never scans harness-owned directories or registers concrete harness callbacks for trajectory observation.
3. **Case schema fields match acceptance exactly.** `expected_outcome.kind: "harness_trajectory"` carries `expected_spawns`, `expected_tools`, `max_duration_seconds`, and `sandbox_profile`, with types and semantics as specified above.
4. **`TrajectoryRunner` interface defined.** `run(case, model, workspace) -> ResultAsync<TrajectoryResult, TrajectoryRunnerError>` is specified with a typed `TrajectoryRunnerError` discriminated union, following the project's `neverthrow` convention.
5. **`TrajectoryResult` shape defined.** The event stream, the publishable `summary`, and the local-only `rawArtifactRef` are all specified, with the local-only boundary stated explicitly.
6. **Publishable field set matches ADR 0008 verbatim.** `TrajectorySummary` contains exactly `harnessDelegatedCorrectly: boolean`, `observedSpawns: string[]`, `observedToolCalls: number`, `harnessCompletedWithoutError: boolean`, and no other field, matching ADR 0008's Decision section word for word.
7. **Suite-registry gating rule stated explicitly.** Trajectory outcomes are permitted only on suites whose `allowedExpectedOutcomeKinds` registry entry opts in to `"harness_trajectory"`, mirroring the existing `tool_call` gate. This spec does not itself perform any suite opt-in.
8. **Cross-links present.** This document links to ADR 0008, `docs/agent-evals.md`, and `docs/adapter-boundary.md`, and cites the spike location as non-normative evidence only.

---

## Invariants

- **The engine never inspects harness-native log formats or plugin payloads directly.** It only ever consumes the normalized `TrajectoryEvent[]` stream returned by an adapter's `TrajectoryRunner`.
- **Raw trajectory data (the full event stream and the raw artifact) is always local-only.** Only the four-field `TrajectorySummary` may ever reach a publishable artifact, and only after passing the sanitization checks in Spec 31's envelope.
- **Trajectory cases never silently degrade text-only suites.** A suite's `allowedExpectedOutcomeKinds` gate is fail-closed: an unlisted outcome kind is rejected before execution, not silently ignored or coerced.
- **The publishable field set is closed.** No trajectory-derived field beyond the four named in ADR 0008 may enter a public schema without a new ADR.
- **`errorKind` on `session-errored` is always a bounded enum-like string**, never a raw error message, stack trace, or harness log line.

---

## Related Files

| File | Role |
| --- | --- |
| `packages/core/src/trajectory-events.ts` | `TrajectoryEvent` union, `TrajectorySummary`, `RawArtifactRef`, `TrajectoryResult`, `TrajectoryRunnerError`, and the `TrajectoryRunner`/`TrajectoryCase`/`TrajectoryWorkspace` interfaces this spec defines. `TrajectoryCase` is a minimal engine/adapter-owned projection of the `harness_trajectory` case fields (not the full `EvalCase`, to avoid a core→cli dependency inversion) |
| `packages/adapters/opencode/src/trajectory/log-parser.ts` | Channel-A adapter implementation: parses OpenCode's `key=value` DEBUG stderr into `TrajectoryEvent` records |
| `packages/adapters/opencode/src/trajectory/podman-client.ts` | Thin `Bun.spawn` seam (`PodmanClient`) used by the OpenCode `TrajectoryRunner` to invoke `podman run`/`podman kill`; mocked in unit tests |
| `packages/adapters/opencode/src/trajectory/opencode-trajectory-runner.ts` | `OpenCodeTrajectoryRunner`, the adapter's `TrajectoryRunner` implementation: prepares the workspace, runs the sandbox, enforces `max_duration_seconds`, parses events, and scores the publishable summary |
| `packages/cli/src/evals/types.ts` | Home of `EXPECTED_OUTCOME_KINDS`, `ExpectedOutcomeSchema`, and the suite registry's `allowedExpectedOutcomeKinds`; this spec's schema addition lands here |
| `packages/cli/src/evals/report-schema.ts` | Public schema definitions; `PublicCaseEntry.trajectorySummary` and `SuiteSummaryEntry.hasRuntimeVerifiedCases` carry the trajectory extension (`SUITE_SUMMARY_SCHEMA_VERSION` bumped to 2) per Spec 31's versioning rules |
| `packages/cli/src/evals/report-bundle.ts` | `assembleCaseEntry()` forwards `trajectorySummary`; `assembleSuiteSummary()` computes `hasRuntimeVerifiedCases` for the dashboard's "Runtime-verified" badge |
| `packages/cli/src/evals/sanitizer.ts` | Sanitization functions that any future trajectory-summary publishing path must reuse |
| `docs/adr/0008-harness-trajectory-evals.md` | The architectural decision this spec formalizes |
| `docs/agent-evals.md` | Contributor reference for the eval architecture; describes the current eight-suite text-only surface this spec extends with a parallel track |
| `docs/adapter-boundary.md` | Engine/adapter ownership rules this spec's two-channel contract must follow |
