/**
 * Eval scenarios — comparing two models to choose a default
 * (Spec 39 task 0.2, gap G2).
 *
 * Bucket: evals, entered through the CLI seam. A maintainer considering a
 * new default model for an agent runs both models on one commit, then runs
 *
 *   weave eval compare-models <run> [<run>] --current <id> --candidate <id>
 *
 * The promises: per suite it states both pass rates, whether the candidate
 * is significantly worse or better, the smallest drop the suite could have
 * detected, the per-case guard, the cost per attempt of both models, and a
 * PASS / FAIL against the publication bar with the reasons; it refuses runs
 * that cannot be compared (too few or uneven repeats, different commits)
 * rather than compare them; `--json` prints the same as a document; and it
 * never prints anything from the raw artifacts.
 *
 * Bundles are written by the real `ArtifactBundleWriter`, then served from a
 * `MemoryFileSystem` rooted at `/project`, as in `compare.scenario.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { run } from "../../packages/cli/src/cli.js";
import { ArtifactBundleWriter } from "../../packages/cli/src/evals/artifact-bundle.js";
import type { AttemptUsage } from "../../packages/cli/src/evals/attempt-usage.js";
import type {
  CaseResult,
  RunnerResult,
} from "../../packages/cli/src/evals/types.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import {
  caseResult,
  FIXED_TIMESTAMP,
  filesUnder,
  provenanceManifest,
  withBundleRoot,
} from "../support/evals.js";

const LUNA = "openai/gpt-6-luna";
const SOL = "openai/gpt-6-sol";
const SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const JUDGE = { id: "typesafe/jev", version: "1.13-20260917" };
const LEAK = "LEAK-raw-answer-should-never-print";

/** One case on one model: `P` passed, `F` failed, `E` errored, per attempt. */
interface CaseSpec {
  caseId: string;
  modelId: string;
  outcomes: string;
  suite?: string;
  usage?: AttemptUsage;
}

interface RunSpec {
  gitSha?: string;
  cases: CaseSpec[];
}

function caseResults(spec: RunSpec): Map<string, CaseResult[]> {
  const bySuite = new Map<string, CaseResult[]>();
  for (const c of spec.cases) {
    [...c.outcomes].forEach((outcome, index) => {
      const suite = c.suite ?? "spindle-tools";
      const results = bySuite.get(suite) ?? [];
      results.push(
        caseResult({
          caseId: c.caseId,
          modelId: c.modelId,
          suite,
          passed: outcome === "P",
          attempt: index + 1,
          ...(outcome === "E" ? { errored: true } : {}),
          ...(c.usage !== undefined ? { usage: c.usage } : {}),
        }),
      );
      bySuite.set(suite, results);
    });
  }
  return bySuite;
}

async function writeRun(root: string, spec: RunSpec): Promise<string> {
  const runnerResults: RunnerResult[] = [...caseResults(spec)].map(
    ([suite, results]) => ({
      suite,
      suiteGreen: results.every((r) => r.summary.passed),
      caseResults: results,
      totalCases: results.length,
      passedCases: results.filter((r) => r.summary.passed).length,
      failedCases: results.filter(
        (r) => !r.summary.passed && r.summary.errored !== true,
      ).length,
      erroredCases: results.filter((r) => r.summary.errored === true).length,
      completedAt: FIXED_TIMESTAMP,
    }),
  );
  const written = (
    await new ArtifactBundleWriter(root).writeBundle({
      runnerResults,
      provenanceManifest: provenanceManifest(["spindle", "loom"]),
      gitSha: spec.gitSha ?? SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
      repeatCount: spec.cases[0]?.outcomes.length ?? 1,
      writeMarkdown: true,
      judge: JUDGE,
      configMode: "builtin",
      track: "text",
    })
  )._unsafeUnwrap();
  await Bun.write(
    `${written.bundleDir}/raw/case-leak.json`,
    JSON.stringify({ rawContent: LEAK }),
  );
  return written.runId;
}

interface Observation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Writes the runs, then runs `weave eval compare-models` from `/project`
 * with the run IDs followed by `args`.
 */
async function compareModels(
  runs: RunSpec[],
  args: string[] = ["--current", LUNA, "--candidate", SOL],
): Promise<Observation> {
  return withBundleRoot(async (root) => {
    const ids: string[] = [];
    for (const spec of runs) ids.push(await writeRun(root, spec));
    const files: Record<string, string> = {};
    for (const path of await filesUnder(root)) {
      files[`/project/eval-bundles/${relative(root, path)}`] =
        await Bun.file(path).text();
    }
    const terminal = new BufferTerminal();
    const result = await run({
      argv: ["bun", "weave", "eval", "compare-models", ...ids, ...args],
      terminal,
      colorEnabled: false,
      fs: new MemoryFileSystem(files, "/project", "/home/user"),
      env: {},
    });
    return {
      exitCode: result._unsafeUnwrap(),
      stdout: terminal.out.join("\n"),
      stderr: terminal.err.join("\n"),
    };
  });
}

const cost = (modelUsd: number): AttemptUsage => ({
  model: { calls: 1, costUsd: modelUsd, costSource: "provider" },
  judge: { calls: 1, costUsd: 0.001, costSource: "provider" },
});

/** The 29 Sep Spindle comparison: Luna 15/16 against Sol 11/16. */
const SPINDLE_29_SEP: RunSpec = {
  cases: [
    {
      caseId: "spindle-citations",
      modelId: LUNA,
      outcomes: "PPPPPPPP",
      usage: cost(0.002),
    },
    {
      caseId: "spindle-boundary",
      modelId: LUNA,
      outcomes: "PPPPPPPF",
      usage: cost(0.002),
    },
    {
      caseId: "spindle-citations",
      modelId: SOL,
      outcomes: "PPPPFFFF",
      usage: cost(0.01),
    },
    {
      caseId: "spindle-boundary",
      modelId: SOL,
      outcomes: "PPPPPPPF",
      usage: cost(0.01),
    },
  ],
};

describe("a maintainer compares two models where one case collapsed", () => {
  it("states both pass rates and finds no significant suite-level difference", async () => {
    const result = await compareModels([SPINDLE_29_SEP]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Eval compare-models ${LUNA} (current) → ${SOL} (candidate)`,
    );
    expect(result.stdout).toMatch(/current +15\/16 +94% \[72–99%\]/);
    expect(result.stdout).toMatch(/candidate +11\/16 +69% \[44–86%\]/);
    expect(result.stdout).toContain(
      "no significant difference (-25 points)  p = 0.172, Holm-adjusted p = 0.172",
    );
  });

  it("says how small a drop the suite could have detected", async () => {
    const result = await compareModels([SPINDLE_29_SEP]);

    expect(result.stdout).toMatch(
      /Smallest detectable drop at this size: \d+ points from 95%, before Holm's adjustment/,
    );
  });

  it("fails the per-case guard, naming the case", async () => {
    const result = await compareModels([SPINDLE_29_SEP]);

    expect(result.stdout).toContain("Per-case guard: FAILED on 1 case");
    expect(result.stdout).toContain("spindle-citations  8/8 100% → 4/8 50%");
  });

  it("states the cost per attempt of both models and the difference", async () => {
    const result = await compareModels([SPINDLE_29_SEP]);

    expect(result.stdout).toContain(
      "Cost per attempt, model calls: $0.00200 (reported by OpenRouter) → $0.0100 (reported by OpenRouter) (+$0.00800)",
    );
    expect(result.stdout).toContain(
      "Cost per attempt, judge calls: $0.00100 (reported by OpenRouter) → $0.00100 (reported by OpenRouter) (same)",
    );
  });

  it("fails the publication bar with its reasons, and lists what it cannot check", async () => {
    const result = await compareModels([SPINDLE_29_SEP]);

    expect(result.stdout).toContain(
      "Publication bar: FAIL — 2 cases; the bar needs at least 12 text cases (step 2); " +
        "per-case guard failed on spindle-citations",
    );
    expect(result.stdout).toContain("Not checked here:");
    expect(result.stdout).toContain("step 5, real sessions");
    expect(result.stdout).toContain("step 8, published evidence");
  });

  it("prints nothing from the raw artifacts", async () => {
    const result = await compareModels([SPINDLE_29_SEP]);

    expect(result.stdout).toContain("Publication bar");
    expect(result.stdout).not.toContain(LEAK);
  });
});

describe("a maintainer compares two models on a grown suite with no regression", () => {
  const caseIds = Array.from({ length: 12 }, (_, i) => `loom-case-${i + 1}`);
  const grown: RunSpec = {
    cases: [
      ...caseIds.map((caseId) => ({
        caseId,
        modelId: LUNA,
        suite: "loom-routing",
        outcomes: "PPPPP",
        usage: cost(0.004),
      })),
      ...caseIds.map((caseId) => ({
        caseId,
        modelId: SOL,
        suite: "loom-routing",
        outcomes: "PPPPP",
        usage: cost(0.003),
      })),
    ],
  };

  it("passes the bar", async () => {
    const result = await compareModels([grown]);

    expect(result.stdout).toContain("Publication bar: PASS");
    expect(result.stdout).toContain(
      "Suites clearing the publication bar steps a comparison can check: 1 of 1.",
    );
  });

  it("prints the comparison as a JSON document with --json", async () => {
    const result = await compareModels(
      [grown],
      ["--current", LUNA, "--candidate", SOL, "--json"],
    );

    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document).toMatchObject({
      kind: "weave-eval-model-comparison",
      version: 1,
      current: { modelId: LUNA },
      candidate: { modelId: SOL },
      repeats: 5,
      configMode: "builtin",
      track: "text",
      judge: { kind: "same", judge: { id: JUDGE.id, version: JUDGE.version } },
    });
    expect(document.suites[0]).toMatchObject({
      suite: "loom-routing",
      caseCount: 12,
      verdict: "no-significant-difference",
      guardFailures: [],
      bar: { verdict: "pass", reasons: [] },
    });
    expect(document.suites[0].cost.difference.model).toBeCloseTo(-0.001, 10);
  });
});

describe("a maintainer compares two models from separate runs", () => {
  const lunaRun: RunSpec = {
    cases: [{ caseId: "spindle-citations", modelId: LUNA, outcomes: "PPPPP" }],
  };
  const solRun = (gitSha = SHA): RunSpec => ({
    gitSha,
    cases: [{ caseId: "spindle-citations", modelId: SOL, outcomes: "PPPPF" }],
  });

  it("compares runs made on one commit", async () => {
    const result = await compareModels([lunaRun, solRun()]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Runs: +\S+ \(current\), \S+ \(candidate\)/);
  });

  it("refuses runs made on different commits", async () => {
    const result = await compareModels([lunaRun, solRun(OTHER_SHA)]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot compare these models");
    expect(result.stderr).toContain("commit 1111111");
  });
});

describe("a maintainer compares models run fewer times than the bar needs", () => {
  const thin: RunSpec = {
    cases: [
      { caseId: "spindle-citations", modelId: LUNA, outcomes: "PPP" },
      { caseId: "spindle-citations", modelId: SOL, outcomes: "PPP" },
    ],
  };

  it("refuses, saying how many repeats it found and how many it needs", async () => {
    const result = await compareModels([thin]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Each case ran 3 times per model; the publication bar needs at least 5.",
    );
  });

  it("compares with --min-repeats, and says the bar is not met", async () => {
    const result = await compareModels(
      [thin],
      ["--current", LUNA, "--candidate", SOL, "--min-repeats", "3"],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--min-repeats 3 is below the bar's 5");
    expect(result.stdout).toContain(
      "3 repeats per case; the bar needs at least 5 (step 3)",
    );
  });

  it("rejects a --min-repeats above the bar's own minimum", async () => {
    const result = await compareModels(
      [thin],
      ["--current", LUNA, "--candidate", SOL, "--min-repeats", "9"],
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be a whole number from 1 to 5");
  });
});

describe("a maintainer forgets to name the models", () => {
  it("says what the command needs", async () => {
    const result = await compareModels([SPINDLE_29_SEP], ["--current", LUNA]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--current and --candidate");
  });
});
