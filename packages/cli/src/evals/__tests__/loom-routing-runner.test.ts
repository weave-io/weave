/**
 * What is left of `loom-routing-runner.ts`'s unit tests.
 *
 * Everything a user can observe — how an answer is read as a route, how that
 * route is scored, what a run publishes, and every filter, dry-run and failure
 * path — moved to
 * [`tests/evals/suite-runners.scenario.test.ts`](../../../../../tests/evals/suite-runners.scenario.test.ts),
 * which drives the real runner through `EvalOrchestrator` and asserts the
 * files the run writes.
 *
 * What stays is about the **repository's own fixture corpus**, not the runner:
 * the twelve boundary-matrix cases under `evals/cases/loom-routing/` are read
 * from disk with the production runner and the production `EVALS_ROOT`, and a
 * fixture whose narrative no longer resolves to its own `target_agent` fails
 * here. A scenario cannot cover that, because a scenario supplies its own
 * corpus.
 *
 * The deleted runner-level tests were also, in part, testing themselves: they
 * drove an `InMemoryLoomRunner` subclass that overrode `run()` with its own
 * implementation. That copy guarded an empty work-item list; the real runner
 * does not, which is why `--model` with no matching fixture publishes an empty
 * green run. The scenario file records that behaviour.
 */

import { describe, expect, it } from "bun:test";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { LoomRoutingRunner } from "../loom-routing-runner.js";
import { StubModelClient } from "../openrouter-client.js";
import type { DimensionScore, NormalizedScoreRecord } from "../types.js";
import { SCORED_AT } from "./support.js";

function makeNormalizedScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1.0,
    rationale: "n/a",
    applicable: false,
  };
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "loom-routing",
    dimensions: {
      routingCorrectness: {
        score: 1.0,
        rationale: "Correct routing to shuttle.",
        applicable: true,
      },
      delegationCorrectness: neutralDim,
      executionCompleteness: neutralDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Good rationale.",
        applicable: true,
      },
    },
    weightedTotal: 1.0,
    passed: true,
    required: true,
    scoredAt: SCORED_AT,
    ...overrides,
  };
}

describe("LoomRoutingRunner — boundary matrix fixtures (real fixtures on disk)", () => {
  // Case ID -> stubbed model response content mapping. Each entry mirrors the
  // narrative in the corresponding real fixture description
  // (evals/cases/loom-routing/<caseId>.json) so the extraction/classification
  // logic under test exercises the same shape the fixture is designed to probe.
  const modelContentByCaseId: Record<string, string> = {
    "loom-route-shuttle-boundary-plan-first":
      "Route to pattern to draft the multi-week microservice migration plan. " +
      "Note that shuttle will eventually implement individual phases once the plan is approved.",
    "loom-route-pattern-boundary-small-fix":
      "Route to shuttle directly to fix the pagination off-by-one bug. " +
      "A full strategic plan from pattern is not warranted here.",
    "loom-route-thread-boundary-prehop-then-implement":
      "1. [Sequential] thread: Locate the logout handler code\n" +
      "2. [Sequential] shuttle: Fix the bug where session cookies are not cleared",
    "loom-route-spindle-boundary-internal-exploration":
      "Delegate to thread to explore our own authentication module and how it validates sessions. " +
      "This is internal codebase investigation, not external research via spindle.",
    "loom-route-weft-boundary-downstream-review":
      "Route to shuttle to implement the new checkout API endpoint. " +
      "Note that after implementation, the change will need a follow-up code review from weft.",
    "loom-route-warp-boundary-downstream-audit":
      "Route to shuttle to implement the file-upload endpoint. " +
      "Once implemented, warp will conduct a security audit of the endpoint before it ships.",
    "loom-route-weft-review-checkout-pr":
      "route to weft for review of the open checkout PR.",
    "loom-route-warp-security-audit-auth-flow":
      "route to warp for a security audit of the authentication flow.",
    "loom-route-thread-explore-auth-flow":
      "route to thread to inspect the authentication token validation call paths.",
    "loom-route-spindle-research-oauth-pkce":
      "route to spindle to research the OAuth2 PKCE flow best practices.",
    "loom-route-shuttle-implement-utility":
      "route to shuttle to add the debounce utility function and wire it into the search input handler.",
    "loom-route-pattern-plan-migration":
      "route to pattern to draft the comprehensive multi-week microservice migration plan.",
  };

  // Expected primary target per case, taken directly from each real fixture's
  // `expected_outcome.target_agent` (evals/cases/loom-routing/<caseId>.json).
  const expectedTargetByCaseId: Record<string, string> = {
    "loom-route-shuttle-boundary-plan-first": "pattern",
    "loom-route-pattern-boundary-small-fix": "shuttle",
    "loom-route-thread-boundary-prehop-then-implement": "shuttle",
    "loom-route-spindle-boundary-internal-exploration": "thread",
    "loom-route-weft-boundary-downstream-review": "shuttle",
    "loom-route-warp-boundary-downstream-audit": "shuttle",
    "loom-route-weft-review-checkout-pr": "weft",
    "loom-route-warp-security-audit-auth-flow": "warp",
    "loom-route-thread-explore-auth-flow": "thread",
    "loom-route-spindle-research-oauth-pkce": "spindle",
    "loom-route-shuttle-implement-utility": "shuttle",
    "loom-route-pattern-plan-migration": "pattern",
  };

  const caseIds = Object.keys(modelContentByCaseId);

  it("covers all 12 Task 6 matrix fixture IDs", () => {
    expect(caseIds).toHaveLength(12);
    expect(Object.keys(expectedTargetByCaseId)).toHaveLength(12);
  });

  for (const caseId of caseIds) {
    it(`loads the real fixture/rubric and resolves the expected primary target for "${caseId}"`, async () => {
      const modelClient = new StubModelClient();
      modelClient.setDefaultResponse({
        model: "anthropic/claude-sonnet-4.5",
        content: modelContentByCaseId[caseId] ?? "",
      });

      const scorer = new StubAgentEvalsScorer();
      scorer.setDefaultRecord(makeNormalizedScoreRecord());

      // No `evalsRoot` override and no in-memory fixture subclass: this uses
      // the production `LoomRoutingRunner` with the default `EVALS_ROOT`,
      // reading the real fixture/rubric files from disk via `case-loader.ts`.
      const runner = new LoomRoutingRunner({
        modelClient,
        scorer,
        loomSystemPrompt: "Test",
      });

      const result = await runner.run({
        caseFilter: caseId,
        rawArtifacts: true,
      });

      expect(result.isOk()).toBe(true);
      const runnerResult = result._unsafeUnwrap();
      expect(runnerResult.caseResults).toHaveLength(1);

      const caseResult = runnerResult.caseResults[0];
      const signals =
        caseResult?.rawArtifact?.runnerDiagnostics?.routingSignals;
      const expectedTarget = expectedTargetByCaseId[caseId];

      expect(signals?.expectedTarget).toBe(expectedTarget);
      expect(signals?.observedPrimaryTarget).toBe(expectedTarget);
      expect([
        "matched-primary-target",
        "acceptable-but-nonprimary-exploratory-route",
      ]).toContain(signals?.classification ?? "");
    });
  }
});
