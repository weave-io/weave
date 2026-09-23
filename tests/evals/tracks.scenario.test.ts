/**
 * Eval scenarios — running one eval track at a time (Spec 37, task 20.2).
 *
 * Bucket: evals. Weave has two eval tracks: text-only cases (one chat
 * completion) and `harness_trajectory` cases (a real harness session in a
 * Podman sandbox). CI runs them in separate jobs, because only the trajectory
 * job builds the sandbox image. `--track text` must therefore never reach a
 * trajectory case, and `--track trajectory` must reach every trajectory case
 * and nothing else. The promises:
 *
 * - `--track text` runs the text-only cases of a suite and skips its
 *   trajectory cases;
 * - `--track trajectory` runs only trajectory cases, and only in the suites
 *   that can hold them;
 * - on the trajectory track a suite whose trajectory cases allow none of the
 *   selected models is left out rather than failed, while a run that reaches
 *   no case at all still fails;
 * - no `--track` runs both, as a local run always has.
 *
 * Dry runs throughout: a live trajectory case needs Podman and a sandbox
 * image, which a scenario must not start. A dry run still selects suites and
 * cases exactly as a live run does, and reports how many cases each suite
 * would run.
 */

import { describe, expect, it } from "bun:test";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  withEvalFixtures,
} from "../support/evals.js";

/** A trajectory expected outcome that needs no fixture directory. */
const TRAJECTORY_OUTCOME = {
  kind: "harness_trajectory",
  expected_spawns: ["shuttle"],
  expected_tools: ["edit"],
  max_duration_seconds: 120,
  sandbox_profile: "opencode-default",
};

const SHUTTLE_TEXT: FixtureSpec = {
  id: "shuttle-text-report",
  suite: "shuttle-execution",
  description: "Report on the delegated task.",
  allowedAgents: ["shuttle"],
  expectedOutcome: {
    kind: "task_completion",
    description: "A structured report.",
    required_artifacts: [],
  },
};

const SHUTTLE_TRAJECTORY: FixtureSpec = {
  id: "shuttle-edit-trajectory",
  suite: "shuttle-execution",
  description: "Fix the bug.",
  allowedAgents: ["loom", "shuttle"],
  expectedOutcome: TRAJECTORY_OUTCOME,
};

const TAPESTRY_TRAJECTORY: FixtureSpec = {
  id: "tapestry-plan-trajectory",
  suite: "tapestry-execution",
  description: "Execute the plan.",
  allowedAgents: ["tapestry", "shuttle"],
  expectedOutcome: TRAJECTORY_OUTCOME,
};

const PATTERN_TEXT: FixtureSpec = {
  id: "pattern-plan-text",
  suite: "pattern-planning",
  description: "Plan the refactor.",
  allowedAgents: ["pattern"],
  expectedOutcome: {
    kind: "task_completion",
    description: "A plan.",
    required_artifacts: [],
  },
};

/**
 * The loom-routing suite can hold trajectory cases, so the trajectory track
 * always selects it. This one allows a model no scenario runs, so the suite
 * has no work and the loom runner never inspects a sandbox image.
 */
const LOOM_TRAJECTORY_ELSEWHERE: FixtureSpec = {
  id: "loom-route-trajectory",
  suite: "loom-routing",
  description: "Route this task.",
  allowedAgents: ["loom", "shuttle"],
  expectedOutcome: TRAJECTORY_OUTCOME,
  allowedModels: ["openai/gpt-4o-mini"],
};

/** Cases each suite would run, keyed by suite. */
function casesPerSuite(run: {
  rollups: Array<{ suite: string; totalCases: number }>;
}): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rollup of run.rollups) {
    counts[rollup.suite] = (counts[rollup.suite] ?? 0) + rollup.totalCases;
  }
  return counts;
}

describe("the text eval job runs a suite that also holds a trajectory case", () => {
  it("runs the text-only case and never reaches the trajectory case", async () => {
    const run = await withEvalFixtures(
      [SHUTTLE_TEXT, SHUTTLE_TRAJECTORY],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "shuttle-execution",
          track: "text",
          dryRun: true,
        }),
    );

    expect(run.exitCode).toBe(0);
    expect(run.partialFailures).toEqual([]);
    expect(casesPerSuite(run)).toEqual({ "shuttle-execution": 1 });
  });

  it("refuses a case filter that names the trajectory case", async () => {
    const run = await withEvalFixtures(
      [SHUTTLE_TEXT, SHUTTLE_TRAJECTORY],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "shuttle-execution",
          caseFilter: SHUTTLE_TRAJECTORY.id,
          track: "text",
          dryRun: true,
        }),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.partialFailures.map((failure) => failure.type)).toEqual([
      "NoCasesFound",
    ]);
  });
});

describe("the trajectory eval job runs every trajectory case", () => {
  it("runs only trajectory cases, and only in suites that can hold them", async () => {
    const run = await withEvalFixtures(
      [
        SHUTTLE_TEXT,
        SHUTTLE_TRAJECTORY,
        TAPESTRY_TRAJECTORY,
        PATTERN_TEXT,
        LOOM_TRAJECTORY_ELSEWHERE,
      ],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          track: "trajectory",
          model: EVAL_MODEL,
          dryRun: true,
        }),
    );

    expect(run.exitCode).toBe(0);
    expect(run.partialFailures).toEqual([]);
    expect(casesPerSuite(run)).toEqual({
      "shuttle-execution": 1,
      "tapestry-execution": 1,
    });
  });

  it("leaves out a suite whose trajectory cases allow none of the selected models", async () => {
    const pinnedElsewhere: FixtureSpec = {
      ...SHUTTLE_TRAJECTORY,
      allowedModels: ["openai/gpt-4o-mini"],
    };

    const run = await withEvalFixtures(
      [
        SHUTTLE_TEXT,
        pinnedElsewhere,
        TAPESTRY_TRAJECTORY,
        LOOM_TRAJECTORY_ELSEWHERE,
      ],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          track: "trajectory",
          model: EVAL_MODEL,
          dryRun: true,
        }),
    );

    expect(run.exitCode).toBe(0);
    expect(run.partialFailures).toEqual([]);
    expect(casesPerSuite(run)).toEqual({ "tapestry-execution": 1 });
  });

  it("still fails when no trajectory case runs on the selected models", async () => {
    const pinnedElsewhere: FixtureSpec = {
      ...TAPESTRY_TRAJECTORY,
      allowedModels: ["openai/gpt-4o-mini"],
    };
    const shuttlePinnedElsewhere: FixtureSpec = {
      ...SHUTTLE_TRAJECTORY,
      allowedModels: ["openai/gpt-4o-mini"],
    };

    const run = await withEvalFixtures(
      [
        SHUTTLE_TEXT,
        shuttlePinnedElsewhere,
        pinnedElsewhere,
        LOOM_TRAJECTORY_ELSEWHERE,
      ],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          track: "trajectory",
          model: EVAL_MODEL,
          dryRun: true,
        }),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.partialFailures.map((failure) => failure.type)).toEqual([
      "NoCasesFound",
      "NoCasesFound",
      "NoCasesFound",
    ]);
  });

  it("keeps the strict rule when an agent filter names the empty suite", async () => {
    const pinnedElsewhere: FixtureSpec = {
      ...SHUTTLE_TRAJECTORY,
      allowedModels: ["openai/gpt-4o-mini"],
    };

    const run = await withEvalFixtures(
      [SHUTTLE_TEXT, pinnedElsewhere],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          track: "trajectory",
          agent: "shuttle-execution",
          model: EVAL_MODEL,
          dryRun: true,
        }),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.partialFailures.map((failure) => failure.type)).toEqual([
      "NoCasesFound",
    ]);
  });

  it("fails a case filter that names a text-only case", async () => {
    const run = await withEvalFixtures(
      [SHUTTLE_TEXT, SHUTTLE_TRAJECTORY],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "shuttle-execution",
          caseFilter: SHUTTLE_TEXT.id,
          track: "trajectory",
          dryRun: true,
        }),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.partialFailures.map((failure) => failure.type)).toEqual([
      "NoCasesFound",
    ]);
  });
});

describe("an agent filter names a suite the track cannot reach", () => {
  it("fails instead of reporting an empty run as green", async () => {
    const run = await withEvalFixtures([PATTERN_TEXT], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "pattern-planning",
        track: "trajectory",
        dryRun: true,
      }),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.error?.type).toBe("EvalValidation");
    expect(JSON.stringify(run.error)).toContain("selects no suite");
  });
});

describe("a local run names no track", () => {
  it("runs text-only and trajectory cases alike", async () => {
    const run = await withEvalFixtures(
      [SHUTTLE_TEXT, SHUTTLE_TRAJECTORY],
      (evalsRoot) =>
        runEvalSuite({ evalsRoot, agent: "shuttle-execution", dryRun: true }),
    );

    expect(run.exitCode).toBe(0);
    expect(casesPerSuite(run)).toEqual({ "shuttle-execution": 2 });
  });
});
