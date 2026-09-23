import { describe, expect, it } from "bun:test";
import {
  caseTrack,
  selectCasesForTrack,
  suiteSupportsTrack,
} from "../eval-track.js";
import { EVAL_SUITE_REGISTRY, type EvalCase } from "../types.js";

function evalCase(
  id: string,
  expectedOutcome: EvalCase["expected_outcome"],
): EvalCase {
  return {
    id,
    description: "A task.",
    suite: "shuttle-execution",
    allowed_agents: ["shuttle"],
    allowed_models: ["openai/gpt-4o-mini"],
    expected_outcome: expectedOutcome,
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
  } as EvalCase;
}

const TEXT_CASE = evalCase("text", {
  kind: "task_completion",
  description: "Done.",
  required_artifacts: [],
});

const TRAJECTORY_CASE = evalCase("trajectory", {
  kind: "harness_trajectory",
  expected_spawns: ["shuttle"],
  expected_tools: ["edit"],
  max_duration_seconds: 120,
  sandbox_profile: "opencode-default",
});

describe("caseTrack", () => {
  it("puts harness_trajectory cases on the trajectory track and the rest on text", () => {
    expect(caseTrack(TRAJECTORY_CASE)).toBe("trajectory");
    expect(caseTrack(TEXT_CASE)).toBe("text");
  });
});

describe("selectCasesForTrack", () => {
  const cases = [TEXT_CASE, TRAJECTORY_CASE];

  it("keeps every case when no track is named", () => {
    expect(selectCasesForTrack(cases, undefined)).toEqual(cases);
  });

  it("keeps only the cases of the named track", () => {
    expect(selectCasesForTrack(cases, "text")).toEqual([TEXT_CASE]);
    expect(selectCasesForTrack(cases, "trajectory")).toEqual([TRAJECTORY_CASE]);
  });
});

describe("suiteSupportsTrack", () => {
  it("keeps every suite on the text track and without a track", () => {
    for (const suite of EVAL_SUITE_REGISTRY) {
      expect(suiteSupportsTrack(suite, "text")).toBe(true);
      expect(suiteSupportsTrack(suite, undefined)).toBe(true);
    }
  });

  it("keeps only suites that allow harness_trajectory on the trajectory track", () => {
    const trajectorySuites = EVAL_SUITE_REGISTRY.filter((suite) =>
      suiteSupportsTrack(suite, "trajectory"),
    ).map((suite) => suite.suiteId);
    expect(trajectorySuites.sort()).toEqual([
      "loom-routing",
      "shuttle-execution",
      "tapestry-execution",
    ]);
  });
});
