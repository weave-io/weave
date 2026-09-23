/**
 * Pure scoring for `harness_trajectory` eval cases.
 *
 * Turns a `TrajectoryEvent[]` (the normalized event stream produced by a
 * harness adapter — see `@weaveio/weave-core`'s
 * `docs/specs/33-spec-harness-trajectory-evals`) plus the case's
 * `harness_trajectory` expected outcome into a `NormalizedScoreRecord`
 * compatible with the existing four-dimension scoring model used for
 * text-only cases (see `langchain-agent-evals.ts`).
 *
 * Mapping:
 *   - `routingCorrectness`    — did the observed subagent spawns match the
 *                               expected spawn sequence, in order?
 *   - `delegationCorrectness` — did the harness reach `session-completed`
 *                               without a `session-errored` event, and did
 *                               it produce the expected delegate lineage
 *                               (the same ordered spawn sequence)?
 *   - `executionCompleteness` — were all `expected_tools` observed at least
 *                               once (via `tool-call-before` /
 *                               `tool-call-after` events)?
 *   - `rationaleQuality`      — not applicable for trajectory cases (no
 *                               free-text rationale is produced by a real
 *                               harness run); scored neutrally at `1.0` so
 *                               it never drags down the weighted total.
 *
 * The weighted total and pass/fail arithmetic intentionally mirror
 * `computeWeightedTotal` / `determinePassed` in `langchain-agent-evals.ts`
 * so that trajectory and text-only cases are comparable in reports. Those
 * helpers are not exported from that module, so the arithmetic is
 * reproduced here rather than imported; keep the two in sync if either
 * changes.
 *
 * This module performs no I/O and has no side effects — it is a pure
 * function over its inputs.
 */

import type {
  TrajectoryEvent,
  TrajectoryVerifierResult,
} from "@weaveio/weave-core";
import type {
  DimensionScore,
  EvalRubric,
  ExpectedCommand,
  ExpectedOutcome,
  NormalizedScoreRecord,
  ScoringDimension,
} from "./types.js";

/** The `harness_trajectory` variant of `ExpectedOutcome`. */
export type HarnessTrajectoryOutcome = Extract<
  ExpectedOutcome,
  { kind: "harness_trajectory" }
>;

/**
 * Minimum score for a primary structural dimension to be considered
 * "near-perfect" for pass/fail purposes.
 *
 * Mirrors `PRIMARY_STRUCTURAL_PASS_THRESHOLD` in `langchain-agent-evals.ts`.
 */
const PRIMARY_STRUCTURAL_PASS_THRESHOLD = 0.95;

/**
 * Minimum `weightedTotal` for a case to be considered passing.
 *
 * Mirrors `PASS_THRESHOLD` in `langchain-agent-evals.ts`.
 */
export const TRAJECTORY_PASS_THRESHOLD = 0.5;

/** Input to `scoreTrajectoryResult`. */
export interface ScoreTrajectoryInput {
  /** The eval case ID this record scores. */
  caseId: string;
  /** The model identifier used for the run. */
  modelId: string;
  /** The eval suite this case belongs to. */
  suite: string;
  /** The observed trajectory event stream from the harness run. */
  events: TrajectoryEvent[];
  /** The case's `harness_trajectory` expected outcome. */
  expectedOutcome: HarnessTrajectoryOutcome;
  /** The rubric's scoring metadata (weights + required flag). */
  scoring: EvalRubric["scoring"];
  /** Local-only verifier outcome from the run, when the case has a verifier. */
  verifier?: TrajectoryVerifierResult;
}

/**
 * Extract the ordered sequence of child agent names spawned during the run,
 * in the order the `subagent-spawned` events were observed.
 */
function observedSpawns(events: TrajectoryEvent[]): string[] {
  return events
    .filter((event) => event.kind === "subagent-spawned")
    .map((event) => event.childAgentName);
}

/**
 * Extract the set of distinct tool names invoked during the run, derived
 * from both `tool-call-before` and `tool-call-after` events.
 */
function observedToolNames(events: TrajectoryEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool-call-before" || event.kind === "tool-call-after") {
      names.add(event.toolName);
    }
  }
  return names;
}

function hasSessionCompleted(events: TrajectoryEvent[]): boolean {
  return events.some((event) => event.kind === "session-completed");
}

function hasSessionErrored(events: TrajectoryEvent[]): boolean {
  return events.some((event) => event.kind === "session-errored");
}

function arraysEqualInOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Score `routingCorrectness`: the observed spawn sequence must match the
 * expected spawn sequence exactly, in order.
 */
function buildRoutingCorrectnessDimension(
  events: TrajectoryEvent[],
  expected: HarnessTrajectoryOutcome,
): DimensionScore {
  const observed = observedSpawns(events);
  const matched = arraysEqualInOrder(observed, expected.expected_spawns);

  if (matched) {
    return {
      score: 1,
      rationale: `Observed spawn sequence matched expected: [${expected.expected_spawns.join(", ")}].`,
      applicable: true,
    };
  }

  return {
    score: 0,
    rationale: `Observed spawn sequence [${observed.join(", ") || "(none)"}] did not match expected [${expected.expected_spawns.join(", ")}].`,
    applicable: true,
  };
}

/**
 * Score `delegationCorrectness`: the harness must reach `session-completed`
 * without a `session-errored` event, and produce the expected delegate
 * lineage (the same ordered spawn sequence as `expected_spawns`).
 */
function buildDelegationCorrectnessDimension(
  events: TrajectoryEvent[],
  expected: HarnessTrajectoryOutcome,
): DimensionScore {
  const completed = hasSessionCompleted(events);
  const errored = hasSessionErrored(events);
  const observed = observedSpawns(events);
  const lineageMatched = arraysEqualInOrder(observed, expected.expected_spawns);

  if (completed && !errored && lineageMatched) {
    return {
      score: 1,
      rationale:
        "Harness reached session-completed without error and produced the expected delegate lineage.",
      applicable: true,
    };
  }

  const reasons: string[] = [];
  if (!completed) reasons.push("no session-completed event observed");
  if (errored) reasons.push("a session-errored event was observed");
  if (!lineageMatched) {
    reasons.push(
      `delegate lineage [${observed.join(", ") || "(none)"}] did not match expected [${expected.expected_spawns.join(", ")}]`,
    );
  }

  return {
    score: 0,
    rationale: `Delegation check failed: ${reasons.join("; ")}.`,
    applicable: true,
  };
}

/** Tools that change files; "after the last edit" is measured against them. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
]);

/**
 * Edits under `.weave/` are bookkeeping (Tapestry ticking a plan's
 * checkboxes, learnings notes), not code changes, so they do not move "the
 * last edit" a verification command has to follow.
 */
function isBookkeepingPath(path: string | undefined): boolean {
  return (
    path !== undefined &&
    (path.startsWith(".weave/") || path.includes("/.weave/"))
  );
}

type ToolCallEvent = Extract<
  TrajectoryEvent,
  { kind: "tool-call-before" | "tool-call-after" }
>;

/**
 * The run's code edits. Completed edits (`tool-call-after`) carry the
 * changed path, so bookkeeping edits can be excluded; when a run has none
 * (older Channel-A-only streams), the permission-check `tool-call-before`
 * events are used instead.
 */
function codeEdits(events: TrajectoryEvent[]): ToolCallEvent[] {
  const editsOf = (kind: ToolCallEvent["kind"]): ToolCallEvent[] =>
    events.filter(
      (event): event is ToolCallEvent =>
        event.kind === kind && EDIT_TOOL_NAMES.has(event.toolName),
    );

  const completed = editsOf("tool-call-after");
  const edits = completed.length > 0 ? completed : editsOf("tool-call-before");
  return edits.filter((event) => !isBookkeepingPath(event.detail?.path));
}

/** Timestamp (ms) of the last code edit, if any. */
function lastEditTime(events: TrajectoryEvent[]): number | undefined {
  let last: number | undefined;
  for (const event of codeEdits(events)) {
    const time = Date.parse(event.timestamp);
    last = last === undefined ? time : Math.max(last, time);
  }
  return last;
}

/**
 * The most sub-agent sessions that ran at the same time. A sub-agent runs
 * from its `subagent-spawned` event to the first `session-completed` or
 * `session-errored` event of the same session after it; one that never
 * ended runs to the end of the stream. Sub-agents dispatched in one step overlap; sub-agents
 * dispatched one after another do not, because the parent waits for each
 * task to return before its next step.
 */
function maxConcurrentDelegations(
  events: TrajectoryEvent[],
  counted: ReadonlySet<string> | undefined,
): number {
  const changes: Array<{ time: number; delta: number }> = [];
  for (const spawn of events) {
    if (spawn.kind !== "subagent-spawned") continue;
    if (counted !== undefined && !counted.has(spawn.childAgentName)) continue;
    const start = Date.parse(spawn.timestamp);
    const completion = events.find(
      (event) =>
        (event.kind === "session-completed" ||
          event.kind === "session-errored") &&
        event.sessionId === spawn.sessionId &&
        Date.parse(event.timestamp) >= start,
    );
    changes.push({ time: start, delta: 1 });
    if (completion !== undefined) {
      changes.push({ time: Date.parse(completion.timestamp), delta: -1 });
    }
  }
  // At equal times a completion counts before a start, so a sub-agent that
  // starts the moment another ends is not counted as running beside it.
  changes.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let running = 0;
  let most = 0;
  for (const change of changes) {
    running += change.delta;
    most = Math.max(most, running);
  }
  return most;
}

/**
 * The `min_parallel_delegations` check (Spec 37, 20.1). Only sub-agents
 * named in `expected_spawns` count, so two unrelated sub-agents (say two
 * `explore` sessions) running together cannot satisfy it; with no expected
 * spawns every sub-agent counts.
 */
function describeParallelism(
  events: TrajectoryEvent[],
  minimum: number,
  expectedSpawns: readonly string[],
): { satisfied: boolean; label: string } {
  const counted =
    expectedSpawns.length > 0 ? new Set(expectedSpawns) : undefined;
  const most = maxConcurrentDelegations(events, counted);
  const which =
    counted === undefined ? "sub-agents" : `of [${[...counted].join(", ")}]`;
  return {
    satisfied: most >= minimum,
    label: `at least ${minimum} ${which} running at the same time (at most ${most} did)`,
  };
}

/**
 * The `allowed_delegates` check (Spec 37, 20.1): the session spawned at
 * least one sub-agent, every spawned sub-agent is allowed, and an allowed
 * sub-agent made a code edit. The last part proves the delegation reached
 * an agent that could run (its model resolved), rather than one that failed
 * and left the primary agent to do the work itself.
 */
function describeDelegation(
  events: TrajectoryEvent[],
  allowed: readonly string[],
): { satisfied: boolean; label: string } {
  const allowedSet = new Set(allowed);
  const spawned = observedSpawns(events);
  const disallowed = spawned.filter((name) => !allowedSet.has(name));
  // The editor must be a delegate that was actually spawned, not merely a
  // name on the list.
  const spawnedDelegates = new Set(
    spawned.filter((name) => allowedSet.has(name)),
  );
  const editedByDelegate = codeEdits(events).some((event) =>
    spawnedDelegates.has(event.agentName),
  );
  const satisfied =
    spawned.length > 0 && disallowed.length === 0 && editedByDelegate;
  const label = `delegation only to [${allowed.join(", ")}], with a code edit by one of them (spawned [${spawned.join(", ") || "(none)"}]${editedByDelegate ? "" : ", no delegate edited code"})`;
  return { satisfied, label };
}

/**
 * True when one observed shell call satisfies every condition of `command`
 * (Spec 35): its command contains `contains`, it came after the last edit
 * when required (vacuously true with no edits), and it exited 0 when required.
 */
function isCommandSatisfied(
  events: TrajectoryEvent[],
  command: ExpectedCommand,
  lastEdit: number | undefined,
): boolean {
  return events.some((event) => {
    if (event.kind !== "tool-call-after") return false;
    if (!event.detail?.command?.includes(command.contains)) return false;
    const afterEdit =
      !command.after_last_edit ||
      lastEdit === undefined ||
      Date.parse(event.timestamp) > lastEdit;
    const succeeded = !command.expect_success || event.detail.exitCode === 0;
    return afterEdit && succeeded;
  });
}

function describeCommand(command: ExpectedCommand): string {
  const conditions = [
    command.after_last_edit ? "after the last edit" : undefined,
    command.expect_success ? "exit 0" : undefined,
  ].filter((condition) => condition !== undefined);
  return conditions.length > 0
    ? `command containing "${command.contains}" (${conditions.join(", ")})`
    : `command containing "${command.contains}"`;
}

/**
 * True when the case declares checks that gate the pass: Spec 35
 * verification checks, or an `allowed_delegates` list (Spec 37, 20.1).
 */
function hasVerificationChecks(expected: HarnessTrajectoryOutcome): boolean {
  return (
    (expected.expected_commands?.length ?? 0) > 0 ||
    expected.verifier !== undefined ||
    expected.allowed_delegates !== undefined ||
    expected.min_parallel_delegations !== undefined
  );
}

/**
 * Score `executionCompleteness` as the fraction of satisfied checks: each
 * `expected_tools` entry must have been observed at least once, each
 * `expected_commands` entry must be satisfied by one shell call, a
 * verifier's result must match its expected outcome (Spec 35), and an
 * `allowed_delegates` list and a `min_parallel_delegations` count must be
 * respected (Spec 37, 20.1).
 */
function buildExecutionCompletenessDimension(
  events: TrajectoryEvent[],
  expected: HarnessTrajectoryOutcome,
  verifier: TrajectoryVerifierResult | undefined,
): DimensionScore {
  const observed = observedToolNames(events);
  const lastEdit = lastEditTime(events);

  const checks: Array<{ label: string; satisfied: boolean }> = [
    ...expected.expected_tools.map((tool) => ({
      label: `tool "${tool}"`,
      satisfied: observed.has(tool),
    })),
    ...(expected.expected_commands ?? []).map((command) => ({
      label: describeCommand(command),
      satisfied: isCommandSatisfied(events, command, lastEdit),
    })),
    ...(expected.verifier !== undefined
      ? [
          {
            label: `verifier expected to ${expected.verifier.expect}`,
            satisfied:
              verifier !== undefined &&
              verifier.passed === (expected.verifier.expect === "pass"),
          },
        ]
      : []),
    ...(expected.allowed_delegates !== undefined
      ? [describeDelegation(events, expected.allowed_delegates)]
      : []),
    ...(expected.min_parallel_delegations !== undefined
      ? [
          describeParallelism(
            events,
            expected.min_parallel_delegations,
            expected.expected_spawns,
          ),
        ]
      : []),
  ];

  if (checks.length === 0) {
    return {
      score: 1,
      rationale: "No tools were required for this case.",
      applicable: true,
    };
  }

  const unsatisfied = checks.filter((check) => !check.satisfied);
  if (unsatisfied.length === 0) {
    return {
      score: 1,
      rationale: `All ${checks.length} execution checks satisfied: ${checks.map((check) => check.label).join("; ")}.`,
      applicable: true,
    };
  }

  return {
    score: (checks.length - unsatisfied.length) / checks.length,
    rationale: `Unsatisfied execution check(s): ${unsatisfied.map((check) => check.label).join("; ")}. Observed tools: [${[...observed].join(", ") || "(none)"}].`,
    applicable: true,
  };
}

/**
 * `rationaleQuality` is not applicable to trajectory cases — a real harness
 * session does not produce a free-text rationale to judge. Scored
 * neutrally at `1.0` so it never drags down the weighted total.
 */
function buildRationaleQualityDimension(): DimensionScore {
  return {
    score: 1.0,
    rationale:
      "Not applicable: harness_trajectory cases do not score rationale quality.",
    applicable: false,
  };
}

/**
 * Compute the weighted total score from dimension scores and rubric weights.
 *
 * Mirrors `computeWeightedTotal` in `langchain-agent-evals.ts`: the primary
 * dimension weight (`outcome_weight`) is distributed evenly across
 * applicable primary dimensions (`routingCorrectness`,
 * `delegationCorrectness`, `executionCompleteness`); `rationaleQuality`
 * contributes via `per_expectation_weight` only when applicable. For
 * trajectory cases `rationaleQuality` is always inapplicable, so when
 * `per_expectation_weight === 0` the result reproduces the same arithmetic
 * as the text-only case (an average over the applicable primary
 * dimensions).
 */
function computeWeightedTotal(
  dimensions: Record<ScoringDimension, DimensionScore>,
  outcomeWeight: number,
  perExpectationWeight: number,
): number {
  const primaryDimensions: ScoringDimension[] = [
    "routingCorrectness",
    "delegationCorrectness",
    "executionCompleteness",
  ];

  const applicablePrimary = primaryDimensions.filter(
    (d) => dimensions[d].applicable,
  );

  const rationaleApplicable = dimensions.rationaleQuality.applicable;

  let totalWeight = 0;
  let weightedSum = 0;

  if (applicablePrimary.length > 0) {
    const primaryWeightEach = outcomeWeight / applicablePrimary.length;
    for (const dim of applicablePrimary) {
      weightedSum += dimensions[dim].score * primaryWeightEach;
      totalWeight += primaryWeightEach;
    }
  }

  if (rationaleApplicable) {
    weightedSum += dimensions.rationaleQuality.score * perExpectationWeight;
    totalWeight += perExpectationWeight;
  }

  if (totalWeight === 0) {
    return 0;
  }

  return weightedSum / totalWeight;
}

/**
 * Determine whether a case passes based on the weighted total and rubric.
 *
 * Mirrors `determinePassed` in `langchain-agent-evals.ts`.
 */
function determinePassed(
  dimensions: Record<ScoringDimension, DimensionScore>,
  weightedTotal: number,
  required: boolean,
): boolean {
  const primaryDimensions: ScoringDimension[] = [
    "routingCorrectness",
    "delegationCorrectness",
    "executionCompleteness",
  ];

  const applicablePrimary = primaryDimensions.filter(
    (d) => dimensions[d].applicable,
  );

  const hasPassingPrimary = applicablePrimary.some(
    (d) => dimensions[d].score >= PRIMARY_STRUCTURAL_PASS_THRESHOLD,
  );

  if (hasPassingPrimary) {
    return true;
  }

  if (weightedTotal < TRAJECTORY_PASS_THRESHOLD) {
    return false;
  }

  if (!required) {
    return true;
  }

  if (applicablePrimary.length === 0) {
    return true;
  }

  return false;
}

/**
 * Score a `harness_trajectory` eval case's observed event stream against
 * its expected outcome, producing a `NormalizedScoreRecord` compatible
 * with the existing four-dimension scoring model.
 *
 * Pure function: no I/O, no side effects, deterministic given its inputs.
 */
export function scoreTrajectoryResult(
  input: ScoreTrajectoryInput,
): NormalizedScoreRecord {
  const dimensions: Record<ScoringDimension, DimensionScore> = {
    routingCorrectness: buildRoutingCorrectnessDimension(
      input.events,
      input.expectedOutcome,
    ),
    delegationCorrectness: buildDelegationCorrectnessDimension(
      input.events,
      input.expectedOutcome,
    ),
    executionCompleteness: buildExecutionCompletenessDimension(
      input.events,
      input.expectedOutcome,
      input.verifier,
    ),
    rationaleQuality: buildRationaleQualityDimension(),
  };

  const weightedTotal = computeWeightedTotal(
    dimensions,
    input.scoring.outcome_weight,
    input.scoring.per_expectation_weight,
  );

  // A case that declares verification checks (Spec 35) passes only when
  // those checks do: correct routing alone must not carry it.
  const verificationGatePassed =
    !hasVerificationChecks(input.expectedOutcome) ||
    dimensions.executionCompleteness.score >= PRIMARY_STRUCTURAL_PASS_THRESHOLD;
  const passed =
    verificationGatePassed &&
    determinePassed(dimensions, weightedTotal, input.scoring.required);

  return {
    caseId: input.caseId,
    modelId: input.modelId,
    suite: input.suite,
    dimensions,
    weightedTotal,
    passed,
    required: input.scoring.required,
    scoredAt: new Date().toISOString(),
  };
}
