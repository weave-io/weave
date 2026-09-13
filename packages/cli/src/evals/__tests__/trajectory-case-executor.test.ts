import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type {
  TrajectoryCase,
  TrajectoryResult,
  TrajectoryRunner,
  TrajectoryVerifierResult,
} from "@weaveio/weave-core";
import { okAsync } from "neverthrow";
import { EVALS_ROOT } from "../case-loader.js";
import {
  hasTrajectoryCases,
  TrajectoryCaseExecutor,
} from "../trajectory-case-executor.js";
import type { EvalCase, EvalRubric } from "../types.js";

class RecordingRunner implements TrajectoryRunner {
  readonly cases: TrajectoryCase[] = [];

  constructor(private readonly verifier?: TrajectoryVerifierResult) {}

  run(testCase: TrajectoryCase): ReturnType<TrajectoryRunner["run"]> {
    this.cases.push(testCase);
    const result: TrajectoryResult = {
      events: [
        {
          kind: "tool-call-before",
          sessionId: "s",
          timestamp: "2026-09-12T00:00:01.000Z",
          toolName: "edit",
          agentName: "shuttle",
        },
        {
          kind: "tool-call-after",
          sessionId: "s",
          timestamp: "2026-09-12T00:00:02.000Z",
          toolName: "bash",
          agentName: "shuttle",
          succeeded: true,
          detail: { command: "bun test", exitCode: 0 },
        },
      ],
      summary: {
        harnessDelegatedCorrectly: true,
        observedSpawns: ["shuttle"],
        observedToolCalls: 1,
        harnessCompletedWithoutError: true,
      },
      rawArtifactRef: { path: "case/stderr.log" },
      ...(this.verifier !== undefined ? { verifier: this.verifier } : {}),
    };
    return okAsync(result);
  }
}

function makeCase(
  outcome: Partial<
    Extract<EvalCase["expected_outcome"], { kind: "harness_trajectory" }>
  > = {},
): EvalCase {
  return {
    id: "shuttle-verify-tests-after-edit-trajectory",
    description: "Fix the slug bug.",
    suite: "shuttle-execution",
    allowed_agents: ["shuttle"],
    allowed_models: ["openai/gpt-4o-mini"],
    expected_outcome: {
      kind: "harness_trajectory",
      expected_spawns: ["shuttle"],
      expected_tools: ["edit"],
      max_duration_seconds: 300,
      sandbox_profile: "opencode-local",
      fixture: "buggy-slugify",
      start_agent: "loom",
      expected_commands: [
        { contains: "bun test", after_last_edit: true, expect_success: true },
      ],
      verifier: {
        fixture: "slugify-edges.verifier",
        command: "bun /verifier/verify.ts",
        expect: "pass",
      },
      ...outcome,
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
  };
}

const RUBRIC: EvalRubric = {
  case_id: "shuttle-verify-tests-after-edit-trajectory",
  suite: "shuttle-execution",
  scoring: { outcome_weight: 1, per_expectation_weight: 0, required: true },
};

function executor(runner?: TrajectoryRunner): TrajectoryCaseExecutor {
  return new TrajectoryCaseExecutor({
    ...(runner !== undefined ? { trajectoryRunner: runner } : {}),
    env: {},
    runnerLabel: "test-trajectory-runner",
  });
}

describe("TrajectoryCaseExecutor", () => {
  it("resolves fixture and verifier paths under evals/fixtures and passes the Spec 35 fields", async () => {
    const runner = new RecordingRunner({ passed: true });
    const result = await executor(runner).execute(
      makeCase(),
      "openai/gpt-4o-mini",
      [RUBRIC],
      false,
      runner,
    );

    expect(result.isOk()).toBe(true);
    expect(runner.cases[0]).toEqual({
      testCaseId: "shuttle-verify-tests-after-edit-trajectory",
      expectedSpawns: ["shuttle"],
      expectedTools: ["edit"],
      maxDurationSeconds: 300,
      sandboxProfile: "opencode-local",
      fixturePath: join(EVALS_ROOT, "fixtures", "buggy-slugify"),
      startAgent: "loom",
      verifier: {
        fixturePath: join(EVALS_ROOT, "fixtures", "slugify-edges.verifier"),
        command: "bun /verifier/verify.ts",
      },
    });
    if (!result.isOk()) return;
    expect(result.value.summary.passed).toBe(true);
    expect(result.value.summary.trajectorySummary?.observedToolCalls).toBe(1);
  });

  it("fails the case when the verifier result does not match", async () => {
    const runner = new RecordingRunner({ passed: false });
    const result = await executor(runner).execute(
      makeCase(),
      "openai/gpt-4o-mini",
      [RUBRIC],
      true,
      runner,
    );

    expect(result.isOk() && result.value.summary.passed).toBe(false);
    if (!result.isOk()) return;
    const raw = JSON.parse(result.value.rawArtifact?.rawContent ?? "{}");
    expect(raw.verifier).toEqual({ passed: false });
    expect(JSON.stringify(result.value.summary)).not.toContain("bun test");
  });

  it("returns FixtureNotFound without running when a fixture directory is missing", async () => {
    const runner = new RecordingRunner();
    const result = await executor(runner).execute(
      makeCase({ fixture: "no-such-fixture", verifier: undefined }),
      "openai/gpt-4o-mini",
      [RUBRIC],
      true,
      runner,
    );

    expect(runner.cases).toEqual([]);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.summary.passed).toBe(false);
    expect(result.value.rawArtifact?.errorSummary?.errorType).toBe(
      "FixtureNotFound",
    );
  });

  it("reports a missing runner or rubric as a zero-score result", async () => {
    const noRunner = await executor().execute(
      makeCase(),
      "m",
      [RUBRIC],
      false,
      undefined,
    );
    expect(noRunner.isOk() && noRunner.value.summary.passed).toBe(false);

    const runner = new RecordingRunner();
    const noRubric = await executor(runner).execute(
      makeCase(),
      "m",
      [],
      false,
      runner,
    );
    expect(noRubric.isOk() && noRubric.value.summary.passed).toBe(false);
    expect(runner.cases).toEqual([]);
  });

  it("resolves the injected runner", async () => {
    const runner = new RecordingRunner();
    const resolved = await executor(runner).resolveRunner([makeCase()]);
    expect(resolved.isOk() && resolved.value).toBe(runner);
  });
});

describe("hasTrajectoryCases", () => {
  it("detects harness_trajectory work items", () => {
    const textCase: EvalCase = {
      ...makeCase(),
      expected_outcome: {
        kind: "task_completion",
        description: "d",
        required_artifacts: [],
      },
    };
    expect(hasTrajectoryCases([{ evalCase: textCase }])).toBe(false);
    expect(
      hasTrajectoryCases([{ evalCase: textCase }, { evalCase: makeCase() }]),
    ).toBe(true);
  });
});
