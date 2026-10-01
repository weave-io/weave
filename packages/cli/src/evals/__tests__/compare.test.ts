/**
 * Unit tests for `compare.ts`: the branches the end-to-end scenarios in
 * `tests/evals/compare.scenario.test.ts` do not reach — Holm's adjustment
 * across several rows, rows left out of the family, and bundle files that
 * are malformed or try to escape the run directory.
 */

import { describe, expect, it } from "bun:test";
import { MemoryFileSystem } from "../../fs/file-system.js";
import {
  type ComparedAttempt,
  compareRuns,
  RunBundleReader,
  type RunSnapshot,
} from "../compare.js";

function attempts(
  modelId: string,
  caseId: string,
  outcomes: string,
  suite = "loom-routing",
): ComparedAttempt[] {
  return [...outcomes].map((o) => ({
    suite,
    caseId,
    modelId,
    passed: o === "P",
    errored: o === "E",
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
    gitSha: "abc1234",
    dryRun: false,
    repeatCount: 8,
    judge: null,
    configMode: "builtin",
    track: null,
    promptHashes: new Map(),
    attempts: rows,
    ...overrides,
  };
}

describe("compareRuns — Holm's adjustment across suite × model rows", () => {
  it("adjusts each tested row for the others, so two marginal rows are not called changes", () => {
    // Models a and b: 2/8 → 7/8 each (p ≈ 0.041 alone; Holm: 0.081 both).
    const baseline = snapshot("base", [
      ...attempts("m/a", "c1", "PPFFFFFF"),
      ...attempts("m/b", "c1", "PPFFFFFF"),
    ]);
    const candidate = snapshot("cand", [
      ...attempts("m/a", "c1", "PPPPPPPF"),
      ...attempts("m/b", "c1", "PPPPPPPF"),
    ]);

    const comparison = compareRuns(baseline, candidate)._unsafeUnwrap();

    expect(comparison.testedRows).toBe(2);
    for (const row of comparison.rows) {
      expect(row.pValue).toBeLessThan(0.05);
      expect(row.adjustedP).toBeCloseTo(2 * row.pValue, 10);
      expect(row.verdict).toBe("no-detectable-change");
    }
  });

  it("still reports a strong change next to a weak one", () => {
    // Model a: 0/8 → 8/8 (p ≈ 0.0002). Model b: 4/8 → 5/8.
    const baseline = snapshot("base", [
      ...attempts("m/a", "c1", "FFFFFFFF"),
      ...attempts("m/b", "c1", "PPPPFFFF"),
    ]);
    const candidate = snapshot("cand", [
      ...attempts("m/a", "c1", "PPPPPPPP"),
      ...attempts("m/b", "c1", "PPPPPFFF"),
    ]);

    const [a, b] = compareRuns(baseline, candidate)._unsafeUnwrap().rows;

    expect(a?.verdict).toBe("improved");
    expect(b?.verdict).toBe("no-detectable-change");
  });

  it("leaves rows that cannot reach significance out of the family", () => {
    const baseline = snapshot(
      "base",
      [...attempts("m/a", "c1", "FFFFFFFF"), ...attempts("m/b", "c1", "F")],
      { repeatCount: 8 },
    );
    const candidate = snapshot(
      "cand",
      [...attempts("m/a", "c1", "PPPPPPPP"), ...attempts("m/b", "c1", "P")],
      { repeatCount: 8 },
    );

    const comparison = compareRuns(baseline, candidate)._unsafeUnwrap();

    expect(comparison.testedRows).toBe(1);
    expect(comparison.rows[1]?.verdict).toBe("too-few-attempts");
    expect(comparison.rows[1]?.adjustedP).toBeNull();
  });
});

describe("compareRuns — refusals", () => {
  it("refuses runs whose case × model pairs differ although cases and models match", () => {
    const baseline = snapshot("base", [
      ...attempts("m/a", "c1", "PP"),
      ...attempts("m/b", "c2", "PP"),
    ]);
    const candidate = snapshot("cand", [
      ...attempts("m/a", "c2", "PP"),
      ...attempts("m/b", "c1", "PP"),
    ]);

    const error = compareRuns(baseline, candidate)._unsafeUnwrapErr();

    expect(error.type).toBe("CaseSetMismatch");
    expect(error.message).toContain("not the same case × model pairs");
  });

  it("refuses when both runs record judges that differ only in version", () => {
    const rows = attempts("m/a", "c1", "PP");
    const error = compareRuns(
      snapshot("base", rows, { judge: { id: "j", version: "1" } }),
      snapshot("cand", rows, { judge: { id: "j", version: "2" } }),
    )._unsafeUnwrapErr();

    expect(error.type).toBe("JudgeMismatch");
  });

  it("refuses runs whose prompts came from different config modes", () => {
    const rows = attempts("m/a", "c1", "PP");
    const error = compareRuns(
      snapshot("base", rows, { configMode: "project" }),
      snapshot("cand", rows, { configMode: "builtin" }),
    )._unsafeUnwrapErr();

    expect(error).toMatchObject({
      type: "ConfigModeMismatch",
      baseline: "project",
      candidate: "builtin",
    });
    expect(error.message).toContain("--config project");
  });

  it("compares runs made in the same config mode", () => {
    const rows = attempts("m/a", "c1", "PP");

    const result = compareRuns(
      snapshot("base", rows, { configMode: "project" }),
      snapshot("cand", rows, { configMode: "project" }),
    );

    expect(result.isOk()).toBe(true);
  });

  it("compares trajectory-track runs whatever their config modes, as the sandboxed harness loads its own config", () => {
    const rows = attempts("m/a", "c1", "PP");

    const comparison = compareRuns(
      snapshot("base", rows, { configMode: "project", track: "trajectory" }),
      snapshot("cand", rows, { configMode: "builtin", track: "trajectory" }),
    )._unsafeUnwrap();

    expect(comparison.configMode).toEqual({ kind: "not-applicable" });
  });

  it("compares tapestry-category-routing runs whatever their config modes, as it composes each case from the builtins", () => {
    const rows = attempts("m/a", "c1", "PP", "tapestry-category-routing");

    const comparison = compareRuns(
      snapshot("base", rows, { configMode: "project" }),
      snapshot("cand", rows, { configMode: "builtin" }),
    )._unsafeUnwrap();

    expect(comparison.configMode).toEqual({ kind: "not-applicable" });
  });

  it("still refuses when one compared suite composes from the config mode", () => {
    const rows = [
      ...attempts("m/a", "c1", "PP", "tapestry-category-routing"),
      ...attempts("m/a", "c2", "PP", "shuttle-execution"),
    ];

    const error = compareRuns(
      snapshot("base", rows, { configMode: "project" }),
      snapshot("cand", rows, { configMode: "builtin" }),
    )._unsafeUnwrapErr();

    expect(error.type).toBe("ConfigModeMismatch");
  });

  it("lists at most five differences and counts the rest", () => {
    const many = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"].flatMap((c) =>
      attempts("m/a", c, "P"),
    );
    const error = compareRuns(
      snapshot("base", many),
      snapshot("cand", attempts("m/a", "other", "P")),
    )._unsafeUnwrapErr();

    expect(error.message).toContain("and 2 more");
  });
});

describe("RunBundleReader — malformed bundles", () => {
  const index = (suites: string[]) =>
    JSON.stringify({
      runId: "r1",
      gitSha: "abc1234",
      dryRun: false,
      runSummary: { suites },
    });

  it("refuses a suite name that would read outside the run directory", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": index([
        "../../secrets",
      ]),
    });

    const error = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrapErr();

    expect(error.type).toBe("BundleInvalid");
  });

  it("says which file is not valid JSON", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": index([
        "loom-routing",
      ]),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": "{not json",
    });

    const error = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrapErr();

    expect(error.type).toBe("BundleUnreadable");
    expect(error.message).toContain("score-loom-routing.json");
  });

  it("says which score file is missing", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": index([
        "loom-routing",
      ]),
    });

    const error = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrapErr();

    expect(error.type).toBe("BundleUnreadable");
    expect(error.message).toContain("score-loom-routing.json");
  });

  it("reads a judge recorded in the provenance manifest", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": index([
        "loom-routing",
      ]),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": JSON.stringify({
        suite: "loom-routing",
        results: [{ caseId: "c1", modelId: "m/a", passed: true }],
      }),
      "/project/eval-bundles/runs/r1/provenance-manifest.json": JSON.stringify({
        judge: { id: "typesafe/jev-1.13" },
      }),
    });

    const snapshot = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrap();

    expect(snapshot.judge).toEqual({ id: "typesafe/jev-1.13", version: null });
    expect(snapshot.repeatCount).toBe(1);
  });

  const scoreFile = JSON.stringify({
    suite: "loom-routing",
    results: [{ caseId: "c1", modelId: "m/a", passed: true }],
  });
  const indexWith = (extra: Record<string, unknown>) =>
    JSON.stringify({
      runId: "r1",
      gitSha: "abc1234",
      dryRun: false,
      runSummary: { suites: ["loom-routing"] },
      ...extra,
    });

  it("reads the config mode recorded in bundle-index.json", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": indexWith({
        configMode: "builtin",
      }),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": scoreFile,
    });

    const snapshot = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrap();

    expect(snapshot.configMode).toBe("builtin");
    expect(snapshot.track).toBeNull();
  });

  it("reads the track the run was restricted to", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": JSON.stringify({
        runId: "r1",
        gitSha: "abc1234",
        dryRun: false,
        runSummary: { suites: ["loom-routing"], track: "trajectory" },
      }),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": scoreFile,
    });

    const snapshot = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrap();

    expect(snapshot.track).toBe("trajectory");
  });

  it("reads a config mode recorded only in the provenance manifest", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": indexWith({}),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": scoreFile,
      "/project/eval-bundles/runs/r1/provenance-manifest.json": JSON.stringify({
        configMode: "builtin",
      }),
    });

    const snapshot = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrap();

    expect(snapshot.configMode).toBe("builtin");
  });

  it("reads a bundle that records no config mode as project, as runs before the mode composed with the project config", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": indexWith({}),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": scoreFile,
    });

    const snapshot = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrap();

    expect(snapshot.configMode).toBe("project");
  });

  it("refuses a config mode it does not know", async () => {
    const fs = new MemoryFileSystem({
      "/project/eval-bundles/runs/r1/bundle-index.json": indexWith({
        configMode: "global",
      }),
      "/project/eval-bundles/runs/r1/score-loom-routing.json": scoreFile,
    });

    const error = (await new RunBundleReader(fs).read("r1"))._unsafeUnwrapErr();

    expect(error.type).toBe("BundleInvalid");
  });
});
