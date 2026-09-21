/**
 * What is left of `tapestry-execution-runner.ts`'s unit tests.
 *
 * Everything a user can observe — how a decision about a shuttle's report is
 * read and scored, every filter, dry-run and failure path, and what a run
 * publishes — lives in
 * [`tests/evals/suite-runners.scenario.test.ts`](../../../../../tests/evals/suite-runners.scenario.test.ts),
 * which drives the real runner through `EvalOrchestrator`.
 *
 * What stays is four exported extractors, tested directly because each is a
 * pure function over a model's text.
 *
 * ## A correction worth reading
 *
 * This file used to say that a delegation chain "has no observable form,
 * because in production the judge is an LLM", and kept a whole runner double
 * on that basis. The premise was wrong. The judge is stubbed at the scenario
 * seam, so **what the runner asks the judge to score is observable** — and the
 * runner serialises the chain into that input itself, after rewriting it
 * through `normalizeDelegationChain()`.
 *
 * The double that reasoning protected, `InMemoryTapestryRunner`, reimplemented
 * `run()` in ~140 lines and carried a verbatim copy of the normalizer. Its two
 * tests asserted the copy: disabling normalization in the product left both of
 * them green. They are gone, and
 * `describe("Tapestry expresses a delegation chain on an execution case")` in
 * the scenario file covers the behaviour against the real runner. See
 * `docs/testing-strategy.md`, finding 11.
 */

import { describe, expect, it } from "bun:test";
import {
  buildUserMessage,
  detectCompletionSignal,
  extractDelegationChain,
  extractProducedArtifacts,
} from "../tapestry-execution-runner.js";
import type { EvalCase } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDelegationCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "delegate-to-shuttle",
    description: "Delegate a backend task from tapestry to shuttle",
    suite: "tapestry-execution",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "delegation_chain",
      chain: ["tapestry", "shuttle"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeTaskCompletionCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "complete-coding-task",
    description: "Implement a REST API endpoint",
    suite: "tapestry-execution",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description: "Implement the REST API endpoint",
      required_artifacts: ["api-spec", "implementation"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractDelegationChain — unit tests
// ---------------------------------------------------------------------------

describe("extractDelegationChain", () => {
  it("returns empty array when content has no chain signal", () => {
    const result = extractDelegationChain("This is a general response.");
    expect(result).toEqual([]);
  });

  it("extracts chain from '→' separator", () => {
    const result = extractDelegationChain("tapestry → shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chain from '->' (ASCII arrow) separator", () => {
    const result = extractDelegationChain("tapestry -> shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chain from 'delegates to' phrase", () => {
    const result = extractDelegationChain("tapestry delegates to shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chain from 'delegating to' phrase", () => {
    const result = extractDelegationChain("tapestry delegating to shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("infers the synthetic envelope's implicit tapestry delegator", () => {
    const result = extractDelegationChain(
      "I will delegate to shuttle for the remaining plan task and wait for the result.",
    );
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts dynamic shuttle category names without a baked legacy list", () => {
    const result = extractDelegationChain(
      "Tapestry delegates to shuttle-observability for instrumentation work.",
    );
    expect(result).toEqual(["tapestry", "shuttle-observability"]);
  });

  it("returns empty array for single agent (requires at least 2)", () => {
    const result = extractDelegationChain("Only shuttle is mentioned.");
    expect(result.length).toBeLessThan(2);
  });

  it("is case-insensitive", () => {
    const result = extractDelegationChain("TAPESTRY → SHUTTLE");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("handles longer chains (3 agents)", () => {
    const result = extractDelegationChain("tapestry → pattern → shuttle");
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain("tapestry");
    expect(result).toContain("shuttle");
  });

  it("prefers explicit arrow chain over earlier standalone mentions", () => {
    const content = [
      "@shuttle",
      "Delegation sequence: `tapestry → shuttle`",
      "Awaiting shuttle result.",
    ].join("\n");
    const result = extractDelegationChain(content);
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chains containing current project category shuttles", () => {
    const result = extractDelegationChain("tapestry → shuttle-engine");
    expect(result).toEqual(["tapestry", "shuttle-engine"]);
  });

  it("does not extract chains with unknown agent names", () => {
    const result = extractDelegationChain("tapestry → unknown-agent");
    // unknown-agent is not in the known set; chain length should be < 2 or empty
    expect(result.length).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// detectCompletionSignal — unit tests
// ---------------------------------------------------------------------------

describe("detectCompletionSignal", () => {
  it("returns false when content has no completion signal", () => {
    expect(detectCompletionSignal("Here is my analysis of the task.")).toBe(
      false,
    );
  });

  it("detects 'task complete'", () => {
    expect(
      detectCompletionSignal("The implementation is ready. Task complete."),
    ).toBe(true);
  });

  it("detects 'task completed'", () => {
    expect(detectCompletionSignal("Task completed successfully.")).toBe(true);
  });

  it("detects 'done'", () => {
    expect(detectCompletionSignal("All steps are done.")).toBe(true);
  });

  it("detects 'finished'", () => {
    expect(detectCompletionSignal("The workflow is finished.")).toBe(true);
  });

  it("detects 'completed successfully'", () => {
    expect(detectCompletionSignal("The task was completed successfully.")).toBe(
      true,
    );
  });

  it("detects 'execution complete'", () => {
    expect(
      detectCompletionSignal("Execution complete. All artifacts produced."),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectCompletionSignal("TASK COMPLETE")).toBe(true);
  });

  it("returns false for vague progress phrases that are not explicit completion", () => {
    expect(detectCompletionSignal("Almost done with the work.")).toBe(false);
  });

  it("detects plan-step completion phrasing from the synthetic execution envelope", () => {
    expect(
      detectCompletionSignal(
        "The remaining plan task is complete and the plan step is done.",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractProducedArtifacts — unit tests
// ---------------------------------------------------------------------------

describe("extractProducedArtifacts", () => {
  it("returns empty array when no expected artifacts appear in content", () => {
    const result = extractProducedArtifacts(
      "A general response with no artifact mentions.",
      ["api-spec", "implementation"],
    );
    expect(result).toEqual([]);
  });

  it("returns matching artifacts when they appear in content", () => {
    const result = extractProducedArtifacts(
      "I have produced the api-spec and implementation files.",
      ["api-spec", "implementation"],
    );
    expect(result).toContain("api-spec");
    expect(result).toContain("implementation");
  });

  it("only returns artifacts from the expected set (no phantom artifacts)", () => {
    const result = extractProducedArtifacts(
      "I produced api-spec and a bonus-file.",
      ["api-spec"],
    );
    expect(result).toEqual(["api-spec"]);
    expect(result).not.toContain("bonus-file");
  });

  it("is case-insensitive for artifact matching", () => {
    const result = extractProducedArtifacts("The API-SPEC has been created.", [
      "api-spec",
    ]);
    expect(result).toContain("api-spec");
  });

  it("returns empty array when expectedArtifacts is empty", () => {
    const result = extractProducedArtifacts("lots of content", []);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage — synthetic plan context
// ---------------------------------------------------------------------------

describe("buildUserMessage", () => {
  it("includes synthetic plan context for delegation cases", () => {
    const message = buildUserMessage(makeDelegationCase());
    expect(message).toContain("Synthetic eval plan context");
    expect(message).toContain("Plan file: .weave/plans/eval-tapestry-plan.md");
    expect(message).toContain("- [ ] 1/1");
    expect(message).toContain("tapestry → shuttle");
  });

  it("includes synthetic plan context and textual completion signal for task cases", () => {
    const message = buildUserMessage(makeTaskCompletionCase());
    expect(message).toContain("Synthetic eval plan context");
    expect(message).toContain("Current todo state: one pending task");
    expect(message).toContain('Signal completion with "task complete"');
    expect(message).not.toContain("agent_signal");
  });
});
