/**
 * The shuttle and tapestry execution runners route `harness_trajectory`
 * cases (Spec 35) to the trajectory runner, never to the text-only model
 * client or scorer. Uses the real fixture set under `evals/`.
 */
import { describe, expect, it } from "bun:test";
import type {
  TrajectoryCase,
  TrajectoryResult,
  TrajectoryRunner,
} from "@weaveio/weave-core";
import { okAsync } from "neverthrow";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import { ShuttleExecutionRunner } from "../shuttle-execution-runner.js";
import { TapestryExecutionRunner } from "../tapestry-execution-runner.js";

class PassingTrajectoryRunner implements TrajectoryRunner {
  readonly cases: TrajectoryCase[] = [];

  run(testCase: TrajectoryCase): ReturnType<TrajectoryRunner["run"]> {
    this.cases.push(testCase);
    const result: TrajectoryResult = {
      events: [
        {
          kind: "subagent-spawned",
          sessionId: "child",
          timestamp: "2026-09-12T00:00:00.000Z",
          parentAgentName: testCase.startAgent ?? "loom",
          childAgentName: "shuttle",
        },
        {
          kind: "tool-call-before",
          sessionId: "child",
          timestamp: "2026-09-12T00:00:01.000Z",
          toolName: "edit",
          agentName: "shuttle",
        },
        {
          kind: "tool-call-after",
          sessionId: "child",
          timestamp: "2026-09-12T00:00:02.000Z",
          toolName: "bash",
          agentName: "shuttle",
          succeeded: true,
          detail: { command: "bun test && bun run check", exitCode: 0 },
        },
        {
          kind: "session-completed",
          sessionId: "root",
          timestamp: "2026-09-12T00:00:03.000Z",
          agentName: testCase.startAgent ?? "loom",
          durationMs: 3000,
        },
      ],
      summary: {
        harnessDelegatedCorrectly: true,
        observedSpawns: ["shuttle"],
        observedToolCalls: 1,
        harnessCompletedWithoutError: true,
      },
      rawArtifactRef: { path: `${testCase.testCaseId}/stderr.log` },
      verifier: { passed: true },
    };
    return okAsync(result);
  }
}

const MODEL = "anthropic/claude-sonnet-4.5";

describe("trajectory dispatch in execution runners", () => {
  it("shuttle-execution runs its trajectory case through the trajectory runner", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const trajectoryRunner = new PassingTrajectoryRunner();
    const runner = new ShuttleExecutionRunner({
      modelClient,
      scorer,
      shuttleSystemPrompt: "test",
      trajectoryRunner,
      env: {},
    });

    const result = await runner.run({
      caseFilter: "shuttle-verify-tests-after-edit-trajectory",
      modelFilter: MODEL,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(modelClient.calls).toEqual([]);
    expect(scorer.calls).toEqual([]);
    expect(trajectoryRunner.cases[0]).toMatchObject({
      testCaseId: "shuttle-verify-tests-after-edit-trajectory",
      sandboxProfile: "opencode-local",
      startAgent: "loom",
    });
    expect(result.value.caseResults[0]?.summary.passed).toBe(true);
  });

  // The orchestrator fans a `--case` run out across the whole model matrix;
  // a model the case does not allow is skipped, not a suite failure.
  it("shuttle-execution skips a case filter whose case does not allow the model", async () => {
    const trajectoryRunner = new PassingTrajectoryRunner();
    const runner = new ShuttleExecutionRunner({
      modelClient: new StubModelClient(),
      scorer: new StubAgentEvalsScorer(),
      shuttleSystemPrompt: "test",
      trajectoryRunner,
      env: {},
    });

    const result = await runner.run({
      caseFilter: "shuttle-verify-tests-after-edit-trajectory",
      modelFilter: "qwen/qwen3.8-max",
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.totalCases).toBe(0);
    expect(trajectoryRunner.cases).toEqual([]);
  });

  it("tapestry-execution runs its trajectory case starting on tapestry", async () => {
    const modelClient = new StubModelClient();
    const trajectoryRunner = new PassingTrajectoryRunner();
    const runner = new TapestryExecutionRunner({
      modelClient,
      scorer: new StubAgentEvalsScorer(),
      tapestrySystemPrompt: "test",
      trajectoryRunner,
      env: {},
    });

    const result = await runner.run({
      caseFilter: "tapestry-runs-plan-verification-trajectory",
      modelFilter: MODEL,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(modelClient.calls).toEqual([]);
    expect(trajectoryRunner.cases[0]?.startAgent).toBe("tapestry");
    expect(trajectoryRunner.cases[0]?.fixturePath).toContain(
      "evals/fixtures/plan-bash-verification",
    );
    expect(result.value.caseResults[0]?.summary.passed).toBe(true);
  });
});

describe("tapestry judgment cases report completion literally", () => {
  // The judge reads `completionSignalled` as "marked the task complete". A
  // correct re-delegation must not be reported as completion, or the judge
  // treats the right answer as a contradiction (seen in the first baseline).
  it("does not signal completion when Tapestry re-delegates", async () => {
    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: MODEL,
      content:
        "The report says all tests pass but shows 1 fail. I will not mark task 1/1 complete. Re-delegating to shuttle with the failure.",
    });
    const scorer = new StubAgentEvalsScorer();
    const runner = new TapestryExecutionRunner({
      modelClient,
      scorer,
      tapestrySystemPrompt: "test",
    });

    await runner.run({
      caseFilter: "tapestry-rejects-contradicted-report",
      modelFilter: MODEL,
    });

    const run = scorer.calls[0]?.run;
    expect(run?.completionSignalled).toBe(false);
    expect(run?.producedArtifacts).toEqual([
      "tapestry_task_not_completed",
      "tapestry_task_redelegated",
      "tapestry_failure_cited",
    ]);
  });
});
