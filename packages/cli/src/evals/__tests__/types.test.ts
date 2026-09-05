/**
 * Unit-level tests for the Zod schemas in `types.ts`.
 *
 * Focused on `ExpectedOutcomeSchema` and the `EVAL_SUITE_REGISTRY` gating
 * metadata, in particular the `harness_trajectory` variant added by
 * docs/specs/33-spec-harness-trajectory-evals.
 */

import { describe, expect, it } from "bun:test";
import {
  EVAL_SUITE_REGISTRY,
  EXPECTED_OUTCOME_KINDS,
  ExpectedOutcomeSchema,
  getEvalSuiteMetadata,
  MAX_TRAJECTORY_DURATION_SECONDS,
} from "../types.js";

describe("EXPECTED_OUTCOME_KINDS", () => {
  it("includes harness_trajectory alongside the existing kinds", () => {
    expect(EXPECTED_OUTCOME_KINDS).toContain("harness_trajectory");
    expect(EXPECTED_OUTCOME_KINDS).toContain("agent_routing");
    expect(EXPECTED_OUTCOME_KINDS).toContain("task_completion");
    expect(EXPECTED_OUTCOME_KINDS).toContain("delegation_chain");
    expect(EXPECTED_OUTCOME_KINDS).toContain("tool_call");
  });
});

describe("ExpectedOutcomeSchema — harness_trajectory variant", () => {
  it("accepts a valid harness_trajectory outcome", () => {
    const parsed = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: ["shuttle"],
      expected_tools: ["edit", "bash"],
      max_duration_seconds: 300,
      sandbox_profile: "opencode-default",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts empty expected_spawns and expected_tools arrays", () => {
    const parsed = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: [],
      expected_tools: [],
      max_duration_seconds: 60,
      sandbox_profile: "opencode-default",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects max_duration_seconds above the bounded cap", () => {
    const parsed = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: [],
      expected_tools: [],
      max_duration_seconds: MAX_TRAJECTORY_DURATION_SECONDS + 1,
      sandbox_profile: "opencode-default",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a zero or negative max_duration_seconds", () => {
    const parsedZero = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: [],
      expected_tools: [],
      max_duration_seconds: 0,
      sandbox_profile: "opencode-default",
    });
    expect(parsedZero.success).toBe(false);

    const parsedNegative = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: [],
      expected_tools: [],
      max_duration_seconds: -1,
      sandbox_profile: "opencode-default",
    });
    expect(parsedNegative.success).toBe(false);
  });

  it("rejects a missing sandbox_profile", () => {
    const parsed = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: [],
      expected_tools: [],
      max_duration_seconds: 60,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing expected_spawns or expected_tools", () => {
    const missingSpawns = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_tools: [],
      max_duration_seconds: 60,
      sandbox_profile: "opencode-default",
    });
    expect(missingSpawns.success).toBe(false);

    const missingTools = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: [],
      max_duration_seconds: 60,
      sandbox_profile: "opencode-default",
    });
    expect(missingTools.success).toBe(false);
  });

  it("rejects an invalid identifier in expected_spawns", () => {
    const parsed = ExpectedOutcomeSchema.safeParse({
      kind: "harness_trajectory",
      expected_spawns: ["invalid spawn name"],
      expected_tools: [],
      max_duration_seconds: 60,
      sandbox_profile: "opencode-default",
    });
    expect(parsed.success).toBe(false);
  });

  it("still validates existing outcome kinds unchanged", () => {
    const agentRouting = ExpectedOutcomeSchema.safeParse({
      kind: "agent_routing",
      target_agent: "shuttle",
      via: [],
    });
    expect(agentRouting.success).toBe(true);

    const taskCompletion = ExpectedOutcomeSchema.safeParse({
      kind: "task_completion",
      description: "done",
    });
    expect(taskCompletion.success).toBe(true);

    const delegationChain = ExpectedOutcomeSchema.safeParse({
      kind: "delegation_chain",
      chain: ["tapestry", "shuttle"],
    });
    expect(delegationChain.success).toBe(true);

    const toolCall = ExpectedOutcomeSchema.safeParse({
      kind: "tool_call",
      tool_name: "delegate",
    });
    expect(toolCall.success).toBe(true);
  });
});

describe("EVAL_SUITE_REGISTRY — harness_trajectory gating", () => {
  it("only loom-routing opts into harness_trajectory", () => {
    for (const suite of EVAL_SUITE_REGISTRY) {
      const opted =
        suite.allowedExpectedOutcomeKinds.includes("harness_trajectory");
      if (suite.suiteId === "loom-routing") {
        expect(opted).toBe(true);
      } else {
        expect(opted).toBe(false);
      }
    }
  });

  it("loom-routing still allows its existing agent_routing kind", () => {
    const loomRouting = getEvalSuiteMetadata("loom-routing");
    expect(loomRouting).toBeDefined();
    expect(loomRouting?.allowedExpectedOutcomeKinds).toContain("agent_routing");
  });
});
