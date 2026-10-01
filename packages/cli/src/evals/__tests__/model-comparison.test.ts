/**
 * Unit tests for `model-comparison.ts` (Spec 39 task 0.2): the suite-level
 * test, the per-case guard, the smallest detectable drop, cost, the bar
 * verdict and every refusal, over in-memory `RunSnapshot`s.
 */

import { describe, expect, it } from "bun:test";
import type { AttemptUsage } from "../attempt-usage.js";
import type { ComparedAttempt, RunSnapshot } from "../compare.js";
import {
  compareModels,
  type ModelComparisonOptions,
  smallestDetectableDrop,
} from "../model-comparison.js";

const LUNA = "openai/gpt-6-luna";
const SOL = "openai/gpt-6-sol";
const MODELS: ModelComparisonOptions = { current: LUNA, candidate: SOL };

function attempts(
  modelId: string,
  caseId: string,
  outcomes: string,
  suite = "spindle-tools",
  usage?: AttemptUsage,
): ComparedAttempt[] {
  return [...outcomes].map((o) => ({
    suite,
    caseId,
    modelId,
    passed: o === "P",
    errored: o === "E",
    ...(usage !== undefined ? { usage } : {}),
  }));
}

function snapshot(
  runId: string,
  rows: ComparedAttempt[],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    ref: runId,
    dir: `/runs/${runId}`,
    runId,
    gitSha: "abc1234def",
    dryRun: false,
    repeatCount: 5,
    judge: { id: "typesafe/jev", version: "1.13" },
    configMode: "builtin",
    track: "text",
    promptHashes: new Map([["spindle", "h1"]]),
    attempts: rows,
    ...overrides,
  };
}

function usage(modelUsd: number, judgeUsd: number): AttemptUsage {
  return {
    model: { calls: 1, costUsd: modelUsd, costSource: "provider" },
    judge: { calls: 1, costUsd: judgeUsd, costSource: "provider" },
  };
}

/** `count` cases, each with `outcomes` on `modelId`. */
function suiteOf(
  modelId: string,
  count: number,
  outcomes: string,
  suite = "loom-routing",
  cost?: AttemptUsage,
): ComparedAttempt[] {
  return Array.from({ length: count }, (_, i) =>
    attempts(
      modelId,
      `case-${String(i + 1).padStart(2, "0")}`,
      outcomes,
      suite,
      cost,
    ),
  ).flat();
}

describe("compareModels — the Spindle 29 Sep shape", () => {
  // Luna 15/16 against Sol 11/16: one case 8/8 → 4/8, the other 7/8 → 7/8.
  const run = snapshot(
    "run",
    [
      ...attempts(LUNA, "spindle-citations", "PPPPPPPP"),
      ...attempts(LUNA, "spindle-boundary", "PPPPPPPF"),
      ...attempts(SOL, "spindle-citations", "PPPPFFFF"),
      ...attempts(SOL, "spindle-boundary", "PPPPPPPF"),
    ],
    { repeatCount: 8 },
  );

  it("finds no significant suite-level difference (p ≈ 0.17)", () => {
    const [suite] = compareModels([run], MODELS)._unsafeUnwrap().suites;

    expect(suite?.current.passed).toBe(15);
    expect(suite?.candidate.passed).toBe(11);
    expect(suite?.pValue).toBeCloseTo(0.172, 3);
    expect(suite?.adjustedP).toBeCloseTo(0.172, 3);
    expect(suite?.verdict).toBe("no-significant-difference");
  });

  it("fails the per-case guard on the case that fell from 8/8 to 4/8", () => {
    const [suite] = compareModels([run], MODELS)._unsafeUnwrap().suites;

    expect(suite?.guardFailures).toEqual(["spindle-citations"]);
    expect(
      suite?.cases.find((c) => c.caseId === "spindle-boundary")?.status,
    ).toBe("pass");
  });

  it("fails the bar, naming the guard and the thin suite", () => {
    const [suite] = compareModels([run], MODELS)._unsafeUnwrap().suites;

    expect(suite?.bar.verdict).toBe("fail");
    expect(suite?.bar.reasons.join("\n")).toContain(
      "per-case guard failed on spindle-citations",
    );
    expect(suite?.bar.reasons.join("\n")).toContain(
      "2 cases; the bar needs at least 12 text cases",
    );
  });
});

describe("compareModels — the guard on rates", () => {
  const guardOf = (current: string, candidate: string): string | undefined =>
    compareModels(
      [
        snapshot("run", [
          ...attempts(LUNA, "c", current),
          ...attempts(SOL, "c", candidate),
        ]),
      ],
      MODELS,
    )._unsafeUnwrap().suites[0]?.cases[0]?.status;

  it("fails a case current passes 4 of 5 times and the candidate 2 of 5", () => {
    expect(guardOf("PPPPF", "PPFFF")).toBe("fail");
  });

  it("passes a case the candidate passes 3 of 5 times (60%, not below)", () => {
    expect(guardOf("PPPPP", "PPPFF")).toBe("pass");
  });

  it("does not apply to a case current passes under 80%", () => {
    expect(guardOf("PPPFF", "FFFFF")).toBe("not-applicable");
  });

  it("cannot check a case where every attempt of a model errored", () => {
    expect(guardOf("PPPPP", "EEEEE")).toBe("not-scored");
  });
});

describe("compareModels — Holm's adjustment across suites", () => {
  it("calls a clear drop significantly worse, and a clear gain significantly better", () => {
    const run = snapshot("run", [
      ...suiteOf(LUNA, 4, "PPPPP", "warp-security"),
      ...suiteOf(SOL, 4, "FFFFF", "warp-security"),
      ...suiteOf(LUNA, 4, "FFFFF", "weft-review"),
      ...suiteOf(SOL, 4, "PPPPP", "weft-review"),
    ]);

    const comparison = compareModels([run], MODELS)._unsafeUnwrap();
    const [warp, weft] = comparison.suites;

    expect(comparison.testedSuites).toBe(2);
    expect(warp?.verdict).toBe("significantly-worse");
    expect(weft?.verdict).toBe("significantly-better");
    expect(warp?.adjustedP).toBeGreaterThan(warp?.pValue ?? 1);
  });

  it("states the smallest drop each suite could detect", () => {
    const run = snapshot("run", [
      ...suiteOf(LUNA, 4, "PPPPP"),
      ...suiteOf(SOL, 4, "PPPPP"),
    ]);

    const [suite] = compareModels([run], MODELS)._unsafeUnwrap().suites;

    expect(suite?.verdict).toBe("no-significant-difference");
    expect(suite?.smallestDetectableDrop).toBeCloseTo(0.3, 5);
  });
});

describe("smallestDetectableDrop", () => {
  it("matches the eval readiness record at 5 repeats", () => {
    const points = (cases: number): number =>
      Math.round((smallestDetectableDrop(cases * 5, cases * 5) ?? 0) * 100);
    expect(points(2)).toBe(50);
    expect(points(4)).toBe(30);
    expect(points(12)).toBe(13);
    expect(points(15)).toBe(12);
    expect(points(20)).toBe(10);
  });

  it("is null when nothing is scored on a side", () => {
    expect(smallestDetectableDrop(0, 10)).toBeNull();
  });
});

describe("compareModels — cost per attempt", () => {
  it("states each model's mean cost, model and judge calls apart, and the difference", () => {
    const run = snapshot("run", [
      ...attempts(LUNA, "c", "PPPPP", "spindle-tools", usage(0.01, 0.002)),
      ...attempts(SOL, "c", "PPPPP", "spindle-tools", usage(0.04, 0.003)),
    ]);

    const [suite] = compareModels([run], MODELS)._unsafeUnwrap().suites;

    expect(suite?.cost.current.model.meanUsd).toBeCloseTo(0.01, 10);
    expect(suite?.cost.candidate.judge.meanUsd).toBeCloseTo(0.003, 10);
    expect(suite?.cost.difference.model).toBeCloseTo(0.03, 10);
    expect(suite?.cost.difference.judge).toBeCloseTo(0.001, 10);
  });

  it("fails the bar when the model calls' cost is not recorded", () => {
    const run = snapshot("run", [
      ...attempts(LUNA, "c", "PPPPP"),
      ...attempts(SOL, "c", "PPPPP"),
    ]);

    const [suite] = compareModels([run], MODELS)._unsafeUnwrap().suites;

    expect(suite?.cost.difference.model).toBeNull();
    expect(suite?.bar.reasons.join("\n")).toContain("(step 7)");
  });
});

describe("compareModels — the publication bar", () => {
  const passing = (overrides: Partial<RunSnapshot> = {}): RunSnapshot =>
    snapshot(
      "run",
      [
        ...suiteOf(LUNA, 12, "PPPPP", "loom-routing", usage(0.01, 0.001)),
        ...suiteOf(SOL, 12, "PPPPP", "loom-routing", usage(0.008, 0.001)),
      ],
      overrides,
    );

  it("passes 12 cases at 5 repeats with no drop, the guard holding and cost recorded", () => {
    const [suite] = compareModels([passing()], MODELS)._unsafeUnwrap().suites;

    expect(suite?.bar).toMatchObject({ verdict: "pass", reasons: [] });
  });

  it("still lists the steps it cannot see", () => {
    const [suite] = compareModels([passing()], MODELS)._unsafeUnwrap().suites;
    const unchecked = suite?.bar.notCheckedHere.join("\n") ?? "";

    expect(unchecked).toContain("step 4");
    expect(unchecked).toContain("model calls cost less per attempt");
    expect(unchecked).toContain("step 5");
    expect(unchecked).toContain("step 6");
    expect(unchecked).toContain("step 8");
  });

  it("fails prompts composed with the project config (step 1)", () => {
    const [suite] = compareModels(
      [passing({ configMode: "project" })],
      MODELS,
    )._unsafeUnwrap().suites;

    expect(suite?.bar.reasons.join("\n")).toContain("(step 1");
  });

  it("fails a run not restricted to the text track", () => {
    const [suite] = compareModels(
      [passing({ track: null })],
      MODELS,
    )._unsafeUnwrap().suites;

    expect(suite?.bar.reasons.join("\n")).toContain("--track text");
  });

  it("compares below the bar's repeats with --min-repeats, and fails the bar for it", () => {
    const run = snapshot("run", [
      ...suiteOf(LUNA, 12, "PPP", "loom-routing", usage(0.01, 0.001)),
      ...suiteOf(SOL, 12, "PPP", "loom-routing", usage(0.01, 0.001)),
    ]);

    const comparison = compareModels([run], {
      ...MODELS,
      minRepeats: 3,
    })._unsafeUnwrap();

    expect(comparison.minRepeats).toBe(3);
    expect(comparison.suites[0]?.bar.reasons).toEqual([
      "3 repeats per case; the bar needs at least 5 (step 3)",
    ]);
  });
});

describe("compareModels — two runs, one model each", () => {
  const currentRun = (overrides: Partial<RunSnapshot> = {}): RunSnapshot =>
    snapshot("luna-run", attempts(LUNA, "c", "PPPPP"), overrides);
  const candidateRun = (overrides: Partial<RunSnapshot> = {}): RunSnapshot =>
    snapshot("sol-run", attempts(SOL, "c", "PPPPF"), overrides);

  it("compares runs on one commit, prompts, judge and config", () => {
    const comparison = compareModels(
      [currentRun(), candidateRun()],
      MODELS,
    )._unsafeUnwrap();

    expect(comparison.oneRun).toBe(false);
    expect(comparison.current.run.runId).toBe("luna-run");
    expect(comparison.candidate.run.runId).toBe("sol-run");
  });

  it("finds each model whichever order the runs are given in", () => {
    const comparison = compareModels(
      [candidateRun(), currentRun()],
      MODELS,
    )._unsafeUnwrap();

    expect(comparison.current.run.runId).toBe("luna-run");
  });

  it("refuses runs on different commits", () => {
    const error = compareModels(
      [currentRun(), candidateRun({ gitSha: "fff9999" })],
      MODELS,
    )._unsafeUnwrapErr();
    expect(error.type).toBe("CommitMismatch");
  });

  it("refuses runs whose prompts differ, naming the agents", () => {
    const error = compareModels(
      [
        currentRun(),
        candidateRun({ promptHashes: new Map([["spindle", "h2"]]) }),
      ],
      MODELS,
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: "PromptMismatch",
      agents: ["spindle"],
    });
  });

  it("refuses runs scored by different judges", () => {
    const error = compareModels(
      [currentRun(), candidateRun({ judge: { id: "other", version: null } })],
      MODELS,
    )._unsafeUnwrapErr();
    expect(error.type).toBe("JudgeMismatch");
  });

  it("refuses runs composed from different config modes", () => {
    const error = compareModels(
      [currentRun(), candidateRun({ configMode: "project" })],
      MODELS,
    )._unsafeUnwrapErr();
    expect(error.type).toBe("ConfigModeMismatch");
  });

  it("compares runs with an unrecorded judge, and fails the bar for it", () => {
    const comparison = compareModels(
      [currentRun(), candidateRun({ judge: null })],
      MODELS,
    )._unsafeUnwrap();

    expect(comparison.judge.kind).toBe("unknown");
    expect(comparison.suites[0]?.bar.reasons.join("\n")).toContain(
      "records no judge",
    );
  });

  it("refuses a model found in both runs", () => {
    const error = compareModels(
      [
        snapshot("a", [
          ...attempts(LUNA, "c", "PPPPP"),
          ...attempts(SOL, "c", "PPPPP"),
        ]),
        candidateRun(),
      ],
      MODELS,
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: "ModelInSeveralRuns", modelId: SOL });
  });

  it("refuses a run holding neither model", () => {
    const error = compareModels(
      [
        snapshot("both", [
          ...attempts(LUNA, "c", "PPPPP"),
          ...attempts(SOL, "c", "PPPPP"),
        ]),
        snapshot("other", attempts("x/other", "c", "PPPPP")),
      ],
      MODELS,
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: "UnusedRun", ref: "other" });
  });
});

describe("compareModels — refusals", () => {
  it("refuses fewer repeats than the bar needs, saying how many it found", () => {
    const run = snapshot("run", [
      ...attempts(LUNA, "c", "PPP"),
      ...attempts(SOL, "c", "PPP"),
    ]);
    const error = compareModels([run], MODELS)._unsafeUnwrapErr();

    expect(error).toMatchObject({
      type: "TooFewRepeats",
      repeats: 3,
      minRepeats: 5,
    });
    expect(error.message).toContain("--repeat 5");
  });

  it("refuses a case run a different number of times on each model", () => {
    const run = snapshot("run", [
      ...attempts(LUNA, "c", "PPPPPP"),
      ...attempts(SOL, "c", "PPPPP"),
    ]);
    const error = compareModels([run], MODELS)._unsafeUnwrapErr();

    expect(error).toMatchObject({
      type: "RepeatCountMismatch",
      cases: ["spindle-tools/c: current × 6, candidate × 5"],
    });
  });

  it("refuses cases that ran on only one model", () => {
    const run = snapshot("run", [
      ...attempts(LUNA, "c", "PPPPP"),
      ...attempts(LUNA, "d", "PPPPP"),
      ...attempts(SOL, "c", "PPPPP"),
    ]);
    const error = compareModels([run], MODELS)._unsafeUnwrapErr();

    expect(error).toMatchObject({
      type: "CaseSetMismatch",
      onlyOnCurrent: ["spindle-tools/d"],
    });
  });

  it("refuses a model the run does not hold, listing the ones it does", () => {
    const run = snapshot("run", attempts(LUNA, "c", "PPPPP"));
    const error = compareModels([run], MODELS)._unsafeUnwrapErr();

    expect(error).toMatchObject({ type: "ModelNotFound", role: "candidate" });
    expect(error.message).toContain(LUNA);
  });

  it("refuses the same model as current and candidate", () => {
    const run = snapshot("run", attempts(LUNA, "c", "PPPPP"));
    const error = compareModels([run], {
      current: LUNA,
      candidate: LUNA,
    })._unsafeUnwrapErr();
    expect(error.type).toBe("SameModel");
  });

  it("refuses a dry run and a trajectory-only run", () => {
    const rows = [
      ...attempts(LUNA, "c", "PPPPP"),
      ...attempts(SOL, "c", "PPPPP"),
    ];
    expect(
      compareModels(
        [snapshot("dry", rows, { dryRun: true })],
        MODELS,
      )._unsafeUnwrapErr().type,
    ).toBe("DryRunBundle");
    expect(
      compareModels(
        [snapshot("traj", rows, { track: "trajectory" })],
        MODELS,
      )._unsafeUnwrapErr().type,
    ).toBe("TrajectoryTrackRun");
  });

  it("refuses three runs", () => {
    const run = snapshot("run", attempts(LUNA, "c", "PPPPP"));
    expect(compareModels([run, run, run], MODELS)._unsafeUnwrapErr().type).toBe(
      "RunCount",
    );
  });
});
