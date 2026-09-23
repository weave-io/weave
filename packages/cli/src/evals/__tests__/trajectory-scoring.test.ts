import { describe, expect, it } from "bun:test";
import type { TrajectoryEvent } from "@weaveio/weave-core";
import {
  type HarnessTrajectoryOutcome,
  type ScoreTrajectoryInput,
  scoreTrajectoryResult,
} from "../trajectory-scoring.js";
import type { EvalRubric } from "../types.js";

function event(partial: TrajectoryEvent): TrajectoryEvent {
  return partial;
}

function makeExpectedOutcome(
  overrides: Partial<HarnessTrajectoryOutcome> = {},
): HarnessTrajectoryOutcome {
  return {
    kind: "harness_trajectory",
    expected_spawns: ["shuttle"],
    expected_tools: ["read"],
    max_duration_seconds: 60,
    sandbox_profile: "opencode-default",
    ...overrides,
  };
}

function makeScoring(
  overrides: Partial<EvalRubric["scoring"]> = {},
): EvalRubric["scoring"] {
  return {
    outcome_weight: 1,
    per_expectation_weight: 0,
    required: true,
    ...overrides,
  };
}

const BASE_ENVELOPE = {
  sessionId: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
};

function happyPathEvents(): TrajectoryEvent[] {
  return [
    event({
      ...BASE_ENVELOPE,
      kind: "session-created",
      agentName: "loom",
      model: "anthropic/claude-sonnet-4-5",
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "subagent-spawned",
      parentAgentName: "loom",
      childAgentName: "shuttle",
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "tool-call-before",
      toolName: "read",
      agentName: "shuttle",
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "tool-call-after",
      toolName: "read",
      agentName: "shuttle",
      succeeded: true,
    }),
    event({
      ...BASE_ENVELOPE,
      kind: "session-completed",
      agentName: "loom",
      durationMs: 1000,
    }),
  ];
}

function buildInput(
  overrides: Partial<ScoreTrajectoryInput> = {},
): ScoreTrajectoryInput {
  return {
    caseId: "trajectory-case-1",
    modelId: "anthropic/claude-sonnet-4-5",
    suite: "shuttle-execution",
    events: happyPathEvents(),
    expectedOutcome: makeExpectedOutcome(),
    scoring: makeScoring(),
    ...overrides,
  };
}

describe("scoreTrajectoryResult", () => {
  it("scores all four dimensions and passes when all expectations are met", () => {
    const record = scoreTrajectoryResult(buildInput());

    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.dimensions.routingCorrectness.applicable).toBe(true);
    expect(record.dimensions.delegationCorrectness.score).toBe(1);
    expect(record.dimensions.delegationCorrectness.applicable).toBe(true);
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    expect(record.dimensions.executionCompleteness.applicable).toBe(true);
    expect(record.dimensions.rationaleQuality.applicable).toBe(false);
    expect(record.dimensions.rationaleQuality.score).toBe(1.0);
    expect(record.weightedTotal).toBe(1);
    expect(record.passed).toBe(true);
  });

  it("fails routingCorrectness when an expected spawn is missing", () => {
    const events = happyPathEvents().filter(
      (e) => e.kind !== "subagent-spawned",
    );
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.routingCorrectness.score).toBe(0);
    expect(record.dimensions.routingCorrectness.applicable).toBe(true);
    // delegation also fails: lineage no longer matches expected_spawns
    expect(record.dimensions.delegationCorrectness.score).toBe(0);
    // execution is still met (tool observed) -> a single near-perfect
    // primary dimension is enough to pass, matching text-only semantics.
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    expect(record.passed).toBe(true);
    expect(record.weightedTotal).toBeCloseTo(1 / 3, 10);
  });

  it("fails executionCompleteness when an expected tool call is missing", () => {
    const events = happyPathEvents().filter(
      (e) => e.kind !== "tool-call-before" && e.kind !== "tool-call-after",
    );
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.dimensions.executionCompleteness.applicable).toBe(true);
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    // routing (and delegation) still near-perfect -> case still passes.
    expect(record.passed).toBe(true);
    expect(record.weightedTotal).toBeCloseTo(2 / 3, 10);
  });

  it("fails delegationCorrectness when the harness errored", () => {
    const events: TrajectoryEvent[] = [
      ...happyPathEvents().filter((e) => e.kind !== "session-completed"),
      event({
        ...BASE_ENVELOPE,
        kind: "session-errored",
        agentName: "loom",
        errorKind: "timeout",
      }),
    ];
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.delegationCorrectness.score).toBe(0);
    expect(record.dimensions.delegationCorrectness.applicable).toBe(true);
    // routing and execution are unaffected by the error
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    // a single near-perfect primary dimension is enough to pass.
    expect(record.passed).toBe(true);
    expect(record.weightedTotal).toBeCloseTo(2 / 3, 10);
  });

  it("fails the case overall when every primary dimension fails", () => {
    const events: TrajectoryEvent[] = [
      event({
        ...BASE_ENVELOPE,
        kind: "session-errored",
        agentName: "loom",
        errorKind: "timeout",
      }),
    ];
    const record = scoreTrajectoryResult(buildInput({ events }));

    expect(record.dimensions.routingCorrectness.score).toBe(0);
    expect(record.dimensions.delegationCorrectness.score).toBe(0);
    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.passed).toBe(false);
    expect(record.weightedTotal).toBe(0);
  });

  it("marks rationaleQuality as not applicable in every trajectory case", () => {
    const cases: ScoreTrajectoryInput[] = [
      buildInput(),
      buildInput({ events: [] }),
      buildInput({
        expectedOutcome: makeExpectedOutcome({ expected_spawns: [] }),
      }),
    ];

    for (const input of cases) {
      const record = scoreTrajectoryResult(input);
      expect(record.dimensions.rationaleQuality.applicable).toBe(false);
      expect(record.dimensions.rationaleQuality.score).toBe(1.0);
    }
  });

  it("reproduces text-only weightedTotal arithmetic when per_expectation_weight is 0", () => {
    // With per_expectation_weight === 0 and rationaleQuality inapplicable,
    // weightedTotal collapses to the mean of the applicable primary
    // dimension scores — identical to the text-only case's
    // computeWeightedTotal arithmetic (outcome_weight distributed evenly
    // across applicable primary dimensions, rationale excluded).
    const scoring = makeScoring({
      outcome_weight: 0.9,
      per_expectation_weight: 0,
    });
    const record = scoreTrajectoryResult(buildInput({ scoring }));

    // All three primary dimensions score 1 -> mean is 1, independent of
    // the outcome_weight magnitude (normalised by totalWeight).
    expect(record.weightedTotal).toBe(1);

    const eventsMissingTool = happyPathEvents().filter(
      (e) => e.kind !== "tool-call-before" && e.kind !== "tool-call-after",
    );
    const partial = scoreTrajectoryResult(
      buildInput({ events: eventsMissingTool, scoring }),
    );
    // routing=1, delegation=1, execution=0 -> mean = 2/3
    expect(partial.weightedTotal).toBeCloseTo(2 / 3, 10);
  });

  it("is a pure function: repeated calls with the same input produce the same result", () => {
    const input = buildInput();
    const first = scoreTrajectoryResult(input);
    const second = scoreTrajectoryResult(input);

    expect(first.dimensions).toEqual(second.dimensions);
    expect(first.weightedTotal).toEqual(second.weightedTotal);
    expect(first.passed).toEqual(second.passed);
  });
});

// ---------------------------------------------------------------------------
// Spec 35: expected commands and verifier
// ---------------------------------------------------------------------------

describe("scoreTrajectoryResult — verification checks", () => {
  function at(second: number): string {
    return `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
  }

  function edit(second: number): TrajectoryEvent {
    return event({
      sessionId: "session-2",
      timestamp: at(second),
      kind: "tool-call-before",
      toolName: "edit",
      agentName: "shuttle",
    });
  }

  function shell(
    second: number,
    command: string,
    exitCode: number,
  ): TrajectoryEvent {
    return event({
      sessionId: "session-2",
      timestamp: at(second),
      kind: "tool-call-after",
      toolName: "bash",
      agentName: "shuttle",
      succeeded: exitCode === 0,
      detail: { command, exitCode },
    });
  }

  const RUN_TESTS_AFTER_EDIT = makeExpectedOutcome({
    expected_tools: [],
    expected_commands: [
      { contains: "bun test", after_last_edit: true, expect_success: true },
    ],
  });

  it("is satisfied by a passing run of the command after the last edit", () => {
    const record = scoreTrajectoryResult(
      buildInput({
        events: [...happyPathEvents(), edit(10), shell(20, "bun test", 0)],
        expectedOutcome: RUN_TESTS_AFTER_EDIT,
      }),
    );
    expect(record.dimensions.executionCompleteness.score).toBe(1);
    expect(record.passed).toBe(true);
  });

  it("fails when the only matching run came before the last edit", () => {
    const record = scoreTrajectoryResult(
      buildInput({
        events: [...happyPathEvents(), shell(5, "bun test", 0), edit(10)],
        expectedOutcome: RUN_TESTS_AFTER_EDIT,
      }),
    );
    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.dimensions.executionCompleteness.rationale).toContain(
      "after the last edit",
    );
    // Routing alone matched, but verification checks gate the pass.
    expect(record.dimensions.routingCorrectness.score).toBe(1);
    expect(record.passed).toBe(false);
  });

  it("fails when the run after the last edit exited non-zero", () => {
    const record = scoreTrajectoryResult(
      buildInput({
        events: [...happyPathEvents(), edit(10), shell(20, "bun test", 1)],
        expectedOutcome: RUN_TESTS_AFTER_EDIT,
      }),
    );
    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.passed).toBe(false);
  });

  it("ignores bookkeeping edits under .weave/ when measuring the last edit", () => {
    const planTick: TrajectoryEvent = event({
      sessionId: "session-2",
      timestamp: at(30),
      kind: "tool-call-after",
      toolName: "edit",
      agentName: "tapestry",
      succeeded: true,
      detail: { path: "/workspace/.weave/plans/fix-slug-edges.md" },
    });
    const codeEdit: TrajectoryEvent = event({
      sessionId: "session-2",
      timestamp: at(10),
      kind: "tool-call-after",
      toolName: "apply_patch",
      agentName: "shuttle",
      succeeded: true,
      detail: { path: "src/slugify.ts" },
    });
    const record = scoreTrajectoryResult(
      buildInput({
        events: [
          ...happyPathEvents(),
          codeEdit,
          shell(20, "bun test", 0),
          planTick,
        ],
        expectedOutcome: RUN_TESTS_AFTER_EDIT,
      }),
    );
    expect(record.dimensions.executionCompleteness.score).toBe(1);

    const codeAfterCheck = scoreTrajectoryResult(
      buildInput({
        events: [
          ...happyPathEvents(),
          shell(20, "bun test", 0),
          { ...codeEdit, timestamp: at(40) },
        ],
        expectedOutcome: RUN_TESTS_AFTER_EDIT,
      }),
    );
    expect(codeAfterCheck.dimensions.executionCompleteness.score).toBe(0);
  });

  it("treats after_last_edit as satisfied when nothing was edited", () => {
    const record = scoreTrajectoryResult(
      buildInput({
        events: [...happyPathEvents(), shell(20, "bun run check", 0)],
        expectedOutcome: makeExpectedOutcome({
          expected_tools: [],
          expected_commands: [
            {
              contains: "bun run check",
              after_last_edit: true,
              expect_success: false,
            },
          ],
        }),
      }),
    );
    expect(record.dimensions.executionCompleteness.score).toBe(1);
  });

  it("requires the verifier result to match the expected outcome", () => {
    const expectedOutcome = makeExpectedOutcome({
      verifier: {
        fixture: "slugify-edges.verifier",
        command: "bun /verifier/verify.ts",
        expect: "pass",
      },
    });

    const passed = scoreTrajectoryResult(
      buildInput({ expectedOutcome, verifier: { passed: true } }),
    );
    expect(passed.dimensions.executionCompleteness.score).toBe(1);
    expect(passed.passed).toBe(true);

    const failed = scoreTrajectoryResult(
      buildInput({ expectedOutcome, verifier: { passed: false } }),
    );
    expect(failed.dimensions.executionCompleteness.score).toBe(0.5);
    expect(failed.passed).toBe(false);

    const missing = scoreTrajectoryResult(buildInput({ expectedOutcome }));
    expect(missing.passed).toBe(false);
  });

  describe("allowed_delegates (Spec 37, 20.1)", () => {
    const DELEGATE_TO_BACKEND = makeExpectedOutcome({
      expected_spawns: ["shuttle-backend"],
      expected_tools: [],
      allowed_delegates: ["shuttle-backend"],
    });

    function spawn(second: number, child: string): TrajectoryEvent {
      return event({
        sessionId: `session-${child}`,
        timestamp: at(second),
        kind: "subagent-spawned",
        parentAgentName: "loom",
        childAgentName: child,
      });
    }

    function codeEditBy(second: number, agentName: string): TrajectoryEvent {
      return event({
        sessionId: `session-${agentName}`,
        timestamp: at(second),
        kind: "tool-call-after",
        toolName: "edit",
        agentName,
        succeeded: true,
        detail: { path: "src/api/orders.ts" },
      });
    }

    const LOOM_STARTS = event({
      ...BASE_ENVELOPE,
      kind: "session-created",
      agentName: "loom",
      model: "deepseek/deepseek-v4-flash-0731",
    });

    it("passes when an allowed delegate is spawned and edits the code", () => {
      const record = scoreTrajectoryResult(
        buildInput({
          events: [
            LOOM_STARTS,
            spawn(1, "shuttle-backend"),
            codeEditBy(5, "shuttle-backend"),
          ],
          expectedOutcome: DELEGATE_TO_BACKEND,
        }),
      );
      expect(record.dimensions.executionCompleteness.score).toBe(1);
      expect(record.passed).toBe(true);
    });

    it("fails a delegation to a harness built-in agent, even beside a good one", () => {
      const record = scoreTrajectoryResult(
        buildInput({
          events: [
            LOOM_STARTS,
            spawn(1, "explore"),
            spawn(3, "shuttle-backend"),
            codeEditBy(5, "shuttle-backend"),
          ],
          expectedOutcome: DELEGATE_TO_BACKEND,
        }),
      );
      expect(record.dimensions.executionCompleteness.score).toBe(0);
      expect(record.dimensions.executionCompleteness.rationale).toContain(
        "spawned [explore, shuttle-backend]",
      );
      expect(record.passed).toBe(false);
    });

    it("fails when the primary agent does the work itself", () => {
      const record = scoreTrajectoryResult(
        buildInput({
          events: [LOOM_STARTS, codeEditBy(5, "loom")],
          expectedOutcome: DELEGATE_TO_BACKEND,
        }),
      );
      expect(record.dimensions.executionCompleteness.score).toBe(0);
      expect(record.passed).toBe(false);
    });

    it("fails when the delegate never edits, as after a model that cannot resolve", () => {
      const record = scoreTrajectoryResult(
        buildInput({
          events: [
            LOOM_STARTS,
            spawn(1, "shuttle-backend"),
            codeEditBy(5, "loom"),
          ],
          expectedOutcome: DELEGATE_TO_BACKEND,
        }),
      );
      expect(record.dimensions.executionCompleteness.rationale).toContain(
        "no delegate edited code",
      );
      // Routing matched, but the delegation check gates the pass.
      expect(record.dimensions.routingCorrectness.score).toBe(1);
      expect(record.passed).toBe(false);
    });

    it("requires the editing delegate to be one that was spawned", () => {
      const record = scoreTrajectoryResult(
        buildInput({
          events: [
            LOOM_STARTS,
            spawn(1, "shuttle-backend"),
            codeEditBy(5, "shuttle-frontend"),
          ],
          expectedOutcome: makeExpectedOutcome({
            expected_spawns: ["shuttle-backend"],
            expected_tools: [],
            allowed_delegates: ["shuttle-backend", "shuttle-frontend"],
          }),
        }),
      );
      expect(record.dimensions.executionCompleteness.rationale).toContain(
        "no delegate edited code",
      );
      expect(record.passed).toBe(false);
    });

    it("does not count a bookkeeping edit under .weave/ as the delegate's work", () => {
      const planNote: TrajectoryEvent = {
        ...codeEditBy(5, "shuttle-backend"),
        detail: { path: ".weave/learnings/notes.md" },
      } as TrajectoryEvent;
      const record = scoreTrajectoryResult(
        buildInput({
          events: [LOOM_STARTS, spawn(1, "shuttle-backend"), planNote],
          expectedOutcome: DELEGATE_TO_BACKEND,
        }),
      );
      expect(record.passed).toBe(false);
    });
  });

  describe("min_parallel_delegations (Spec 37, 20.1)", () => {
    const TWO_AT_ONCE = makeExpectedOutcome({
      expected_spawns: ["shuttle", "shuttle"],
      expected_tools: [],
      min_parallel_delegations: 2,
    });

    function child(
      id: string,
      startSecond: number,
      endSecond: number | undefined,
    ): TrajectoryEvent[] {
      const spawned = event({
        sessionId: id,
        timestamp: at(startSecond),
        kind: "subagent-spawned",
        parentAgentName: "tapestry",
        childAgentName: "shuttle",
      });
      if (endSecond === undefined) return [spawned];
      return [
        spawned,
        event({
          sessionId: id,
          timestamp: at(endSecond),
          kind: "session-completed",
          agentName: "shuttle",
          durationMs: (endSecond - startSecond) * 1000,
        }),
      ];
    }

    function score(events: TrajectoryEvent[]) {
      return scoreTrajectoryResult(
        buildInput({ events, expectedOutcome: TWO_AT_ONCE }),
      );
    }

    it("passes when two sub-agents run at the same time", () => {
      const record = score([...child("a", 1, 20), ...child("b", 2, 15)]);
      expect(record.dimensions.executionCompleteness.score).toBe(1);
      expect(record.passed).toBe(true);
    });

    it("fails when the sub-agents run one after another", () => {
      const record = score([...child("a", 1, 10), ...child("b", 12, 20)]);
      expect(record.dimensions.executionCompleteness.score).toBe(0);
      expect(record.dimensions.executionCompleteness.rationale).toContain(
        "at most 1 did",
      );
      // Routing matched two shuttles, but parallelism gates the pass.
      expect(record.dimensions.routingCorrectness.score).toBe(1);
      expect(record.passed).toBe(false);
    });

    it("does not count a sub-agent that starts the moment another ends", () => {
      const record = score([...child("a", 1, 10), ...child("b", 10, 20)]);
      expect(record.passed).toBe(false);
    });

    it("counts a sub-agent that never completed as still running", () => {
      const record = score([...child("a", 1, undefined), ...child("b", 5, 9)]);
      expect(record.passed).toBe(true);
    });

    it("ends a sub-agent at its error, so a later dispatch does not overlap it", () => {
      const errored = event({
        sessionId: "a",
        timestamp: at(8),
        kind: "session-errored",
        agentName: "shuttle",
        errorKind: "ProviderModelNotFoundError",
      });
      const record = score([
        ...child("a", 1, undefined),
        errored,
        ...child("b", 12, 20),
      ]);
      expect(record.passed).toBe(false);
    });

    it("counts only the expected delegates, not other sub-agents beside them", () => {
      const explore = (id: string, start: number, end: number) =>
        child(id, start, end).map((e) =>
          e.kind === "subagent-spawned"
            ? { ...e, childAgentName: "explore" }
            : e,
        );
      const record = score([
        ...explore("x", 1, 20),
        ...explore("y", 2, 15),
        ...child("a", 21, 30),
        ...child("b", 31, 40),
      ]);
      expect(record.dimensions.executionCompleteness.rationale).toContain(
        "of [shuttle]",
      );
      expect(record.passed).toBe(false);
    });

    it("fails a run with a single sub-agent", () => {
      const record = score(child("a", 1, 10));
      expect(record.dimensions.executionCompleteness.rationale).toContain(
        "at most 1 did",
      );
      expect(record.passed).toBe(false);
    });
  });

  it("scores a case with none of the new fields exactly as before", () => {
    const record = scoreTrajectoryResult(
      buildInput({ events: happyPathEvents().slice(0, 2) }),
    );
    // No read call observed; routing still matches, so the Spec 33 rule
    // (any passing primary dimension) keeps passing it.
    expect(record.dimensions.executionCompleteness.score).toBe(0);
    expect(record.passed).toBe(true);
  });
});
