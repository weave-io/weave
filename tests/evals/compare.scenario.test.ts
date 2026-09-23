/**
 * Eval scenarios — comparing a candidate run with a baseline
 * (Spec 37, task 18.2).
 *
 * Bucket: evals, entered through the CLI seam. A maintainer changes a prompt,
 * runs the evals before and after, and runs
 *
 *   weave eval compare <baseline> <candidate>
 *
 * The promises: per suite × model it says whether the pass rate changed
 * beyond the noise, and says "no detectable change" honestly when the
 * samples are too small to tell; it refuses runs that differ in design (case
 * set, models, repeat count, judge) rather than compare them; and it never
 * prints a prompt, an answer or anything else from the raw artifacts.
 *
 * The two bundles are written by the real `ArtifactBundleWriter`, then served
 * to `weave eval compare` from a `MemoryFileSystem` rooted at `/project`, so
 * the command reads exactly the files a run leaves in `eval-bundles/`.
 */

import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { run } from "../../packages/cli/src/cli.js";
import { ArtifactBundleWriter } from "../../packages/cli/src/evals/artifact-bundle.js";
import type {
  CaseResult,
  PromptProvenanceManifest,
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

const MODEL = "deepseek/deepseek-v4-flash-0731";
const OTHER_MODEL = "openai/gpt-6-luna";
const BASELINE_SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANDIDATE_SHA = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LEAK = "LEAK-raw-answer-should-never-print";
const SUMMARY_LEAK = "LEAK-prompt-summary-should-never-print";

/**
 * The attempts of one case on one model, as a string: `P` passed, `F`
 * failed, `E` errored. `"PPF"` is three repeats, the last one failing.
 */
interface CaseSpec {
  caseId: string;
  outcomes: string;
  modelId?: string;
  suite?: string;
}

interface RunSpec {
  gitSha: string;
  cases: CaseSpec[];
  /** The composed-prompt hash of Loom. Defaults to `"a" × 64`. */
  loomHash?: string;
  dryRun?: boolean;
  judge?: { id: string; version: string };
}

function repeatCountOf(spec: RunSpec): number {
  return spec.cases[0]?.outcomes.length ?? 1;
}

function caseResults(spec: RunSpec): Map<string, CaseResult[]> {
  const repeated = repeatCountOf(spec) > 1;
  const bySuite = new Map<string, CaseResult[]>();
  const count = repeatCountOf(spec);
  for (let attempt = 1; attempt <= count; attempt += 1) {
    for (const c of spec.cases) {
      const outcome = c.outcomes[attempt - 1];
      if (outcome === undefined) continue;
      const suite = c.suite ?? "loom-routing";
      const results = bySuite.get(suite) ?? [];
      results.push(
        caseResult({
          caseId: c.caseId,
          modelId: c.modelId ?? MODEL,
          suite,
          passed: outcome === "P",
          dryRun: spec.dryRun ?? false,
          ...(repeated ? { attempt } : {}),
          ...(outcome === "E" ? { errored: true } : {}),
        }),
      );
      bySuite.set(suite, results);
    }
  }
  return bySuite;
}

function manifest(spec: RunSpec): PromptProvenanceManifest {
  const base = provenanceManifest(["loom", "shuttle"]);
  return {
    ...base,
    records: base.records.map((record) => ({
      ...record,
      summary: SUMMARY_LEAK,
      hash:
        record.agentName === "loom"
          ? (spec.loomHash ?? "a".repeat(64))
          : record.hash,
    })),
  };
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
      provenanceManifest: manifest(spec),
      gitSha: spec.gitSha,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: spec.dryRun ?? false,
      repeatCount: repeatCountOf(spec),
      writeMarkdown: true,
    })
  )._unsafeUnwrap();
  // A raw transcript sits next to the bundle, as `--raw-artifacts` leaves it.
  await Bun.write(
    `${written.bundleDir}/raw/case-leak.json`,
    JSON.stringify({ rawContent: LEAK, composedPrompt: LEAK }),
  );
  if (spec.judge !== undefined) {
    const indexPath = `${written.bundleDir}/bundle-index.json`;
    const index = await Bun.file(indexPath).json();
    await Bun.write(
      indexPath,
      JSON.stringify({ ...index, judge: spec.judge }, null, 2),
    );
  }
  return written.runId;
}

interface CompareObservation {
  exitCode: number;
  stdout: string;
  stderr: string;
  baselineId: string;
  candidateId: string;
}

/**
 * Writes both runs, then runs `weave eval compare` against them from
 * `/project`, naming them by run ID unless `args` says otherwise.
 */
async function compare(
  baseline: RunSpec,
  candidate: RunSpec,
  args?: (ids: { baseline: string; candidate: string }) => string[],
): Promise<CompareObservation> {
  return withBundleRoot(async (root) => {
    const baselineId = await writeRun(root, baseline);
    const candidateId = await writeRun(root, candidate);
    const files: Record<string, string> = {};
    for (const path of await filesUnder(root)) {
      files[`/project/eval-bundles/${relative(root, path)}`] =
        await Bun.file(path).text();
    }
    const terminal = new BufferTerminal();
    const argv = args?.({ baseline: baselineId, candidate: candidateId }) ?? [
      baselineId,
      candidateId,
    ];
    const result = await run({
      argv: ["bun", "weave", "eval", "compare", ...argv],
      terminal,
      colorEnabled: false,
      fs: new MemoryFileSystem(files, "/project", "/home/user"),
      env: {},
    });
    return {
      exitCode: result._unsafeUnwrap(),
      stdout: terminal.out.join("\n"),
      stderr: terminal.err.join("\n"),
      baselineId,
      candidateId,
    };
  });
}

function runOf(gitSha: string, ...cases: CaseSpec[]): RunSpec {
  return { gitSha, cases };
}

describe("a maintainer compares a prompt change that clearly helped", () => {
  const baseline = runOf(
    BASELINE_SHA,
    { caseId: "loom-route-api", outcomes: "FFFFF" },
    { caseId: "loom-route-ui", outcomes: "FFFFP" },
  );
  const candidate = {
    ...runOf(
      CANDIDATE_SHA,
      { caseId: "loom-route-api", outcomes: "PPPPP" },
      { caseId: "loom-route-ui", outcomes: "PPPPP" },
    ),
    loomHash: "c".repeat(64),
  };

  it("says the suite improved on that model, with both pass rates", async () => {
    const result = await compare(baseline, candidate);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Eval compare ${result.baselineId} → ${result.candidateId}`,
    );
    expect(result.stdout).toContain("loom-routing");
    expect(result.stdout).toMatch(/baseline +1\/10 +10% \[2–40%\]/);
    expect(result.stdout).toMatch(/candidate +10\/10 +100% \[72–100%\]/);
    expect(result.stdout).toContain("p < 0.001, Holm-adjusted p < 0.001");
    expect(result.stdout).toContain("IMPROVED (+90 points)");
  });

  it("names the cases whose pass rate moved", async () => {
    const result = await compare(baseline, candidate);

    expect(result.stdout).toContain("loom-route-api  0/5 → 5/5");
    expect(result.stdout).toContain("loom-route-ui  1/5 → 5/5");
  });

  it("names the agent whose prompt changed, by hash only", async () => {
    const result = await compare(baseline, candidate);

    expect(result.stdout).toContain(
      `loom  ${"a".repeat(12)} → ${"c".repeat(12)}`,
    );
    expect(result.stdout).not.toContain("shuttle  ");
  });

  it("says the judge is unknown, because neither run records one yet", async () => {
    const result = await compare(baseline, candidate);

    expect(result.stdout).toContain(
      "unknown (baseline: not recorded; candidate: not recorded)",
    );
  });

  it("prints nothing from the raw artifacts or the prompt provenance", async () => {
    const result = await compare(baseline, candidate);

    // Positive first: the comparison ran and printed its verdict.
    expect(result.stdout).toContain("IMPROVED");
    expect(result.stdout).not.toContain(LEAK);
    expect(result.stdout).not.toContain(SUMMARY_LEAK);
    expect(result.stderr).not.toContain(LEAK);
  });
});

describe("a maintainer compares a change that clearly hurt", () => {
  it("says the suite regressed", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPPPPPPP" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "FFFFFFFF" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("REGRESSED (-100 points)");
  });
});

describe("a maintainer compares runs whose difference is within the noise", () => {
  it("says no detectable change, with the p-value it tested", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPPFF" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPPPF" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no detectable change (+20 points)");
    expect(result.stdout).toContain("p = 1.000, Holm-adjusted p = 1.000");
    expect(result.stdout).not.toContain("IMPROVED");
    expect(result.stdout).toContain(
      "That does not show the runs are equal: small samples only detect large changes.",
    );
  });
});

describe("a maintainer compares single runs of one case", () => {
  it("says too few attempts rather than claiming anything, even from fail to pass", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "F" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "P" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "no detectable change: too few scored attempts for any difference to show; re-run both with a higher --repeat",
    );
    expect(result.stdout).not.toContain("IMPROVED");
  });
});

describe("a maintainer compares runs where some attempts errored", () => {
  it("leaves the errored attempts out of the pass rate and says how many", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPEEP" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPPPP" }),
    );

    expect(result.stdout).toMatch(
      /baseline +3\/3 +100% \[44–100%\], 2 errored left out/,
    );
  });

  it("does not compare a model whose every attempt errored", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "EEEE" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPPP" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "not compared: one run has no scored attempt",
    );
  });
});

describe("a maintainer compares runs of different designs", () => {
  it("refuses runs over different cases, and names them", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-ui", outcomes: "PPP" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ran different cases");
    expect(result.stderr).toContain(
      "Only in the baseline: loom-routing/loom-route-api",
    );
    expect(result.stderr).toContain(
      "Only in the candidate: loom-routing/loom-route-ui",
    );
  });

  it("refuses runs on different models", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
      runOf(CANDIDATE_SHA, {
        caseId: "loom-route-api",
        outcomes: "PPP",
        modelId: OTHER_MODEL,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("used different models");
    expect(result.stderr).toContain(OTHER_MODEL);
  });

  it("refuses runs with different repeat counts", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPPPP" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "The baseline repeated each case 3 time(s) and the candidate 5",
    );
    expect(result.stderr).toContain("--repeat 3");
  });

  it("refuses runs scored by different judges", async () => {
    const result = await compare(
      {
        ...runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
        judge: { id: "anthropic/claude-sonnet-4.5", version: "2025-09-29" },
      },
      {
        ...runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
        judge: { id: "typesafe/jev-1.13", version: "1.13.0" },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("scored by different judges");
    expect(result.stderr).toContain("anthropic/claude-sonnet-4.5@2025-09-29");
    expect(result.stderr).toContain("typesafe/jev-1.13@1.13.0");
  });

  it("names the judge when both runs record the same one", async () => {
    const judge = { id: "typesafe/jev-1.13", version: "1.13.0" };
    const result = await compare(
      {
        ...runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
        judge,
      },
      {
        ...runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
        judge,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Judge:    typesafe/jev-1.13@1.13.0");
  });

  it("flags a judge recorded in only one run instead of refusing", async () => {
    const result = await compare(
      runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
      {
        ...runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "PPP" }),
        judge: { id: "typesafe/jev-1.13", version: "1.13.0" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "unknown (baseline: not recorded; candidate: typesafe/jev-1.13@1.13.0)",
    );
  });

  it("refuses a dry run, which scored nothing", async () => {
    const result = await compare(
      {
        ...runOf(BASELINE_SHA, { caseId: "loom-route-api", outcomes: "P" }),
        dryRun: true,
      },
      runOf(CANDIDATE_SHA, { caseId: "loom-route-api", outcomes: "P" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is a dry run");
  });
});

describe("a maintainer names the runs to compare", () => {
  const baseline = runOf(BASELINE_SHA, {
    caseId: "loom-route-api",
    outcomes: "PP",
  });
  const candidate = runOf(CANDIDATE_SHA, {
    caseId: "loom-route-api",
    outcomes: "PP",
  });

  it("accepts run directories as well as run IDs", async () => {
    const result = await compare(baseline, candidate, (ids) => [
      `eval-bundles/runs/${ids.baseline}`,
      `/project/eval-bundles/runs/${ids.candidate}`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Eval compare ${result.baselineId} → ${result.candidateId}`,
    );
  });

  it("says which paths it tried when a run does not exist", async () => {
    const result = await compare(baseline, candidate, (ids) => [
      ids.baseline,
      "no-such-run",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No eval run found for "no-such-run"');
    expect(result.stderr).toContain("/project/eval-bundles/runs/no-such-run");
  });

  it("asks for exactly two runs", async () => {
    const result = await compare(baseline, candidate, (ids) => [ids.baseline]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "weave eval compare needs exactly two runs",
    );
  });
});
