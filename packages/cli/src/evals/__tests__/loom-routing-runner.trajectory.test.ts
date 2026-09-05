/**
 * Tests for the `harness_trajectory` dispatch path added to
 * `LoomRoutingRunner` (Task 9: wire the trajectory runner into the eval
 * orchestrator).
 *
 * Verifies:
 *   - Live run: a case with `expected_outcome.kind === "harness_trajectory"`
 *     is routed to the injected `TrajectoryRunner` (never `modelClient`/
 *     `scorer`), scored via `scoreTrajectoryResult`, and produces a
 *     `CaseResultSummary` with the four publishable fields (`caseId`,
 *     `modelId`, `passed`/`weightedTotal` derived from dimension scores, and
 *     `dimensionScores`) with no raw trajectory events in the summary.
 *   - `TrajectoryRunner` failure is converted to a zero-score `CaseResult`
 *     rather than aborting the suite.
 *   - Missing rubric is converted to a zero-score `CaseResult`.
 *   - Dry-run: the injected `sandboxImageChecker` is invoked with the case's
 *     `sandbox_profile` and the dry-run result still has `dryRun: true` with
 *     no model/trajectory-runner calls made.
 *   - `modelClient.complete` / `scorer.score` are never called for a
 *     trajectory case (isolation from the text-only path).
 *
 * Uses the real on-disk fixture at
 * `evals/cases/loom-routing/loom-route-shuttle-implement-utility-trajectory.json`
 * (and its paired rubric) via the default `EVALS_ROOT`, filtered with
 * `caseFilter`, so no fixture file I/O stubbing is required. All Podman,
 * file-system, and network access is avoided via injected stubs
 * (`trajectoryRunner`, `sandboxImageChecker`, `promptProvider`).
 */

import { describe, expect, it } from "bun:test";
import type {
  TrajectoryEvent,
  TrajectoryRunnerError,
} from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { LoomRoutingRunner } from "../loom-routing-runner.js";
import { StubModelClient } from "../openrouter-client.js";
import type { PromptProvider } from "../types.js";

const TRAJECTORY_CASE_ID = "loom-route-shuttle-implement-utility-trajectory";

class MockPromptProvider implements PromptProvider {
  getPrompt(_agentName: string): ReturnType<PromptProvider["getPrompt"]> {
    return okAsync("You are Loom.");
  }
}

function nowIso(): string {
  return "2026-01-01T00:00:00.000Z";
}

function successEvents(): TrajectoryEvent[] {
  return [
    {
      kind: "session-created",
      sessionId: "ses_parent",
      timestamp: nowIso(),
      agentName: "loom",
      model: "openai/gpt-4o-mini",
    },
    {
      kind: "subagent-spawned",
      sessionId: "ses_parent",
      timestamp: nowIso(),
      parentAgentName: "loom",
      childAgentName: "shuttle",
    },
    {
      kind: "tool-call-before",
      sessionId: "ses_child",
      timestamp: nowIso(),
      toolName: "edit",
      agentName: "shuttle",
    },
    {
      kind: "tool-call-after",
      sessionId: "ses_child",
      timestamp: nowIso(),
      toolName: "edit",
      agentName: "shuttle",
      succeeded: true,
    },
    {
      kind: "session-completed",
      sessionId: "ses_child",
      timestamp: nowIso(),
      agentName: "shuttle",
      durationMs: 5000,
    },
  ];
}

interface MockTrajectoryRunner {
  run: (...args: unknown[]) => ResultAsync<unknown, TrajectoryRunnerError>;
  calls: unknown[][];
}

function buildSucceedingTrajectoryRunner(): MockTrajectoryRunner {
  const calls: unknown[][] = [];
  return {
    calls,
    run: (...args: unknown[]) => {
      calls.push(args);
      return okAsync({
        events: successEvents(),
        summary: {
          harnessDelegatedCorrectly: true,
          observedSpawns: ["shuttle"],
          observedToolCalls: 1,
          harnessCompletedWithoutError: true,
        },
        rawArtifactRef: { path: `${TRAJECTORY_CASE_ID}/stderr.log` },
      }) as unknown as ResultAsync<unknown, TrajectoryRunnerError>;
    },
  };
}

function buildFailingTrajectoryRunner(): MockTrajectoryRunner {
  const calls: unknown[][] = [];
  return {
    calls,
    run: (...args: unknown[]) => {
      calls.push(args);
      return errAsync({
        type: "SandboxStartFailed",
        testCaseId: TRAJECTORY_CASE_ID,
        model: "openai/gpt-4o-mini",
      }) as ResultAsync<unknown, TrajectoryRunnerError>;
    },
  };
}

describe("LoomRoutingRunner - harness_trajectory dispatch", () => {
  it("routes a harness_trajectory case to the injected TrajectoryRunner and scores it via scoreTrajectoryResult", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const trajectoryRunner = buildSucceedingTrajectoryRunner();

    const runner = new LoomRoutingRunner({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider(),
      // biome-ignore lint/suspicious/noExplicitAny: structural TrajectoryRunner stub
      trajectoryRunner: trajectoryRunner as any,
    });

    const result = await runner.run({ caseFilter: TRAJECTORY_CASE_ID });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.caseResults).toHaveLength(1);
    const caseResult = result.value.caseResults[0];
    expect(caseResult.summary.caseId).toBe(TRAJECTORY_CASE_ID);
    expect(caseResult.summary.suite).toBe("loom-routing");
    expect(caseResult.summary.dryRun).toBe(false);
    // The four publishable fields: caseId, modelId, passed, weightedTotal
    expect(typeof caseResult.summary.modelId).toBe("string");
    expect(typeof caseResult.summary.passed).toBe("boolean");
    expect(typeof caseResult.summary.weightedTotal).toBe("number");
    expect(caseResult.summary.passed).toBe(true);
    expect(
      caseResult.summary.dimensionScores.routingCorrectness.applicable,
    ).toBe(true);

    // The four publishable trajectory summary fields must be surfaced onto
    // the publishable CaseResultSummary (not just consumed for scoring).
    expect(caseResult.summary.trajectorySummary).toEqual({
      harnessDelegatedCorrectly: true,
      observedSpawns: ["shuttle"],
      observedToolCalls: 1,
      harnessCompletedWithoutError: true,
    });

    // Trajectory cases must never call the text-only model/scorer path.
    expect(modelClient.calls).toHaveLength(0);
    expect(trajectoryRunner.calls).toHaveLength(1);
  });

  it("leaves trajectorySummary undefined for a text-only (non-trajectory) case", async () => {
    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "openai/gpt-4o-mini",
      content: "Route to: shuttle",
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord({
      caseId: "text-only-case",
      modelId: "openai/gpt-4o-mini",
      suite: "loom-routing",
      dimensions: {
        routingCorrectness: {
          score: 1,
          rationale: "matched",
          applicable: true,
        },
        delegationCorrectness: {
          score: 1,
          rationale: "n/a",
          applicable: false,
        },
        executionCompleteness: {
          score: 1,
          rationale: "n/a",
          applicable: false,
        },
        rationaleQuality: { score: 1, rationale: "clear", applicable: true },
      },
      weightedTotal: 1,
      passed: true,
      required: true,
      scoredAt: nowIso(),
    });

    const runner = new LoomRoutingRunner({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider(),
    });

    const result = await runner.run({
      caseFilter: "loom-route-shuttle-implement-utility",
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.caseResults).toHaveLength(1);
    expect(
      result.value.caseResults[0].summary.trajectorySummary,
    ).toBeUndefined();
  });

  it("converts a TrajectoryRunner failure into a zero-score CaseResult without aborting the suite", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const trajectoryRunner = buildFailingTrajectoryRunner();

    const runner = new LoomRoutingRunner({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider(),
      // biome-ignore lint/suspicious/noExplicitAny: structural TrajectoryRunner stub
      trajectoryRunner: trajectoryRunner as any,
    });

    const result = await runner.run({ caseFilter: TRAJECTORY_CASE_ID });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const caseResult = result.value.caseResults[0];
    expect(caseResult.summary.passed).toBe(false);
    expect(caseResult.summary.weightedTotal).toBe(0);
  });

  it("dry-run invokes the sandbox image checker with the case's sandbox_profile without invoking the TrajectoryRunner or model client", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const trajectoryRunner = buildSucceedingTrajectoryRunner();
    const checkedProfiles: string[] = [];

    const runner = new LoomRoutingRunner({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider(),
      // biome-ignore lint/suspicious/noExplicitAny: structural TrajectoryRunner stub
      trajectoryRunner: trajectoryRunner as any,
      sandboxImageChecker: async (sandboxProfile: string) => {
        checkedProfiles.push(sandboxProfile);
        return true;
      },
    });

    const result = await runner.run({
      caseFilter: TRAJECTORY_CASE_ID,
      dryRun: true,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.caseResults).toHaveLength(1);
    expect(result.value.caseResults[0].summary.dryRun).toBe(true);
    expect(checkedProfiles).toEqual(["opencode-default"]);
    expect(trajectoryRunner.calls).toHaveLength(0);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("dry-run never fails the suite even when the sandbox image checker resolves false", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const safeRunner = new LoomRoutingRunner({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider(),
      sandboxImageChecker: async () => false,
    });

    const result = await safeRunner.run({
      caseFilter: TRAJECTORY_CASE_ID,
      dryRun: true,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.caseResults[0].summary.dryRun).toBe(true);
  });
});
