/**
 * Evals scenarios — how a run is written to disk.
 *
 * Bucket: Evals. The black box is `ArtifactBundleWriter` and the local-only
 * `RawArtifactsWriter`: eval results go in, and a directory tree comes out.
 * Everything asserted here is a file, a file name, or a file's contents —
 * never an intermediate descriptor.
 *
 * [`published-bundle.scenario.test.ts`](published-bundle.scenario.test.ts)
 * covers what a published bundle may *contain* (the sanitization promise).
 * This file covers how runs are **addressed, sequenced and kept apart**:
 *
 * - a run is addressed by commit and calendar day, with a sequence number;
 * - a second write never overwrites a first, locally or against the remote;
 * - only allowlisted artifacts are declared public, so a website loader
 *   never fetches an internal one;
 * - raw debugging artifacts land in a local-only `raw/` directory and are
 *   never declared public;
 * - a published score traces back to a prompt hash and a commit.
 *
 * `docs/eval-xss-policy.md` and `docs/eval-sanitization-and-publish-pipeline.md`
 * are normative for the explanation scenarios below.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ok, okAsync } from "neverthrow";
import {
  ArtifactBundleWriter,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  type RemoteSequenceReader,
  RUNS_SUBDIR,
  type WriteBundleOptions,
} from "../../packages/cli/src/evals/artifact-bundle.js";
import { deriveProvenanceManifest } from "../../packages/cli/src/evals/provenance.js";
import { RawArtifactsWriter } from "../../packages/cli/src/evals/raw-artifacts.js";
import type {
  PromptSnapshot,
  RawCaseResultArtifact,
  RunnerResult,
} from "../../packages/cli/src/evals/types.js";
import {
  caseResult,
  FIXED_GIT_SHA,
  FIXED_TIMESTAMP,
  filesUnder,
  provenanceManifest,
  runnerResult,
  withBundleRoot,
} from "../support/evals.js";

// ---------------------------------------------------------------------------
// Local harness
// ---------------------------------------------------------------------------

const TOKEN_ENV = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "a-repo-token" };

/** Writes one bundle into `root` and returns the write result, failing loudly. */
async function write(
  root: string,
  overrides: Partial<WriteBundleOptions> = {},
) {
  const result = await new ArtifactBundleWriter(root).writeBundle({
    runnerResults: [runnerResult()],
    provenanceManifest: provenanceManifest(),
    gitSha: FIXED_GIT_SHA,
    assembledAt: FIXED_TIMESTAMP,
    ...overrides,
  });

  if (result.isErr()) {
    expect(JSON.stringify(result.error)).toBe("bundle written");
  }
  return result._unsafeUnwrap();
}

/** Every path under `root`, relative and POSIX-separated, sorted. */
async function tree(root: string): Promise<string[]> {
  const absolute = await filesUnder(root);
  return absolute.map((p) => p.slice(root.length + 1)).sort();
}

/** Every file name written directly into the run directory of `runId`. */
async function runFiles(root: string, runId: string): Promise<string[]> {
  const prefix = `${RUNS_SUBDIR}/${runId}/`;
  return (await tree(root))
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

/** Reads and parses one JSON file from a run directory. */
async function readRunJson(
  root: string,
  runId: string,
  fileName: string,
  // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
): Promise<any> {
  return Bun.file(join(root, RUNS_SUBDIR, runId, fileName)).json();
}

/** A reader that reports the given run IDs as already present remotely. */
function remoteReporting(
  ids: string[],
  calls: Array<{ prefix: string; token: string }> = [],
): RemoteSequenceReader {
  return {
    readRemoteRunIds(prefix, token) {
      calls.push({ prefix, token });
      return okAsync(ids);
    },
  };
}

/** A prompt snapshot as `prompt-snapshots.ts` produces one. */
function snapshot(agentName: string, hash: string): PromptSnapshot {
  return {
    agentName,
    hash,
    byteLength: 4096,
    charLength: 4000,
    sources: [
      { kind: "builtin", layer: "primary" },
      { kind: "file", filePath: ".weave/prompts/loom.md", layer: "append" },
    ],
  };
}

/** A raw case artifact as a runner produces one when `--raw-artifacts` is on. */
function rawArtifact(
  overrides: Partial<RawCaseResultArtifact> = {},
): RawCaseResultArtifact {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    composedPrompt: "You are Loom. RAW-PROMPT-MARKER",
    transcript: [{ role: "user", content: "RAW-TRANSCRIPT-MARKER" }],
    rawContent: "RAW-RESPONSE-MARKER",
    dimensionRationales: { routingCorrectness: "RAW-RATIONALE-MARKER" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Addressing a run
// ---------------------------------------------------------------------------

describe("a maintainer publishes the first eval run from a commit", () => {
  const RUN_ID = "abc123d-2026-01-15-001";

  it("files the run under runs/<sha7>-<date>-001, so a run is addressable by commit and day", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);

      expect(written.runId).toBe(RUN_ID);
      expect(written.bundleDir).toBe(join(root, RUNS_SUBDIR, RUN_ID));
      expect(await tree(root)).not.toHaveLength(0);
    });
  });

  it("writes the score, summary, provenance and prompt-hash artifacts a reader needs", async () => {
    await withBundleRoot(async (root) => {
      await write(root);

      expect((await runFiles(root, RUN_ID)).sort()).toEqual([
        "bundle-index.json",
        "prompt-hashes.json",
        "provenance-manifest.json",
        "public-report.json",
        "run-summary.json",
        "score-loom-routing.json",
      ]);
    });
  });

  it("declares only the public artifacts, so a website loader never fetches an internal one", async () => {
    await withBundleRoot(async (root) => {
      await write(root);
      const index = await readRunJson(root, RUN_ID, "bundle-index.json");

      expect(index.publicFiles).toEqual([
        "bundle-index.json",
        "public-report.json",
      ]);
      for (const internal of [
        "run-summary.json",
        "score-loom-routing.json",
        "prompt-hashes.json",
        "provenance-manifest.json",
      ]) {
        expect(index.publicFiles).not.toContain(internal);
      }
    });
  });

  it("stamps a schemaVersion on both public files, so a consumer can reject a layout it does not know", async () => {
    await withBundleRoot(async (root) => {
      await write(root);

      expect(
        (await readRunJson(root, RUN_ID, "bundle-index.json")).schemaVersion,
      ).toBe(1);
      expect(
        (await readRunJson(root, RUN_ID, "public-report.json")).schemaVersion,
      ).toBe(1);
    });
  });

  it("names the run inside its own index, so a copied file still says where it came from", async () => {
    await withBundleRoot(async (root) => {
      await write(root);
      const index = await readRunJson(root, RUN_ID, "bundle-index.json");

      expect(index.runId).toBe(RUN_ID);
      expect(index.gitSha).toBe(FIXED_GIT_SHA);
      expect(index.assembledAt).toBe(FIXED_TIMESTAMP);
    });
  });
});

describe("a run is made outside a git checkout", () => {
  it("files it under `unknown-<date>`, so the missing commit is visible rather than guessed", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { gitSha: "unknown" });

      expect(written.runId).toBe("unknown-2026-01-15-001");
      expect(
        (await readRunJson(root, written.runId, "public-report.json")).gitSha,
      ).toBe("unknown");
    });
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("a maintainer publishes twice from the same commit on the same day", () => {
  /** Two runs from the same commit and day, distinguishable by case ID. */
  async function twoRuns(root: string) {
    const first = await write(root, {
      runnerResults: [
        runnerResult({
          caseResults: [caseResult({ caseId: "first-run-case" })],
        }),
      ],
    });
    const second = await write(root, {
      runnerResults: [
        runnerResult({
          caseResults: [caseResult({ caseId: "second-run-case" })],
        }),
      ],
    });
    return { first, second };
  }

  it("gives the second run its own directory rather than reusing the first", async () => {
    await withBundleRoot(async (root) => {
      const { first, second } = await twoRuns(root);

      expect(first.runId).toBe("abc123d-2026-01-15-001");
      expect(second.runId).toBe("abc123d-2026-01-15-002");
    });
  });

  it("leaves the first run's files untouched, so a published score can never be rewritten", async () => {
    await withBundleRoot(async (root) => {
      const { first } = await twoRuns(root);
      const report = await Bun.file(
        join(root, RUNS_SUBDIR, first.runId, "public-report.json"),
      ).text();

      expect(report).toContain("first-run-case");
      expect(report).not.toContain("second-run-case");
    });
  });

  it("keeps counting, so a third run does not land back on an earlier number", async () => {
    await withBundleRoot(async (root) => {
      await twoRuns(root);
      const third = await write(root);

      expect(third.runId).toBe("abc123d-2026-01-15-003");
      expect(await tree(root)).toContain(
        `${RUNS_SUBDIR}/abc123d-2026-01-15-003/bundle-index.json`,
      );
    });
  });

  it("starts the numbering over the next day, so run IDs stay readable", async () => {
    await withBundleRoot(async (root) => {
      await write(root);
      const nextDay = await write(root, {
        assembledAt: "2026-01-16T09:00:00.000Z",
      });

      expect(nextDay.runId).toBe("abc123d-2026-01-16-001");
    });
  });
});

describe("the same commit and day were already published to the results repo", () => {
  it("allocates above the remote's highest run, so a rerun cannot overwrite a published one", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        mode: "publish",
        env: TOKEN_ENV,
        remoteSequenceReader: remoteReporting([
          "abc123d-2026-01-15-001",
          "abc123d-2026-01-15-002",
        ]),
      });

      expect(written.runId).toBe("abc123d-2026-01-15-003");
    });
  });

  it("allocates above whichever of local and remote is higher", async () => {
    await withBundleRoot(async (root) => {
      await write(root);
      await write(root);
      const third = await write(root, {
        mode: "publish",
        env: TOKEN_ENV,
        remoteSequenceReader: remoteReporting(["abc123d-2026-01-15-005"]),
      });

      expect(third.runId).toBe("abc123d-2026-01-15-006");
    });
  });

  it("ignores remote runs from another commit or day", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        mode: "publish",
        env: TOKEN_ENV,
        remoteSequenceReader: remoteReporting([
          "deadbee-2026-01-15-009",
          "abc123d-2026-01-14-009",
        ]),
      });

      expect(written.runId).toBe("abc123d-2026-01-15-001");
    });
  });

  it("asks the remote about this commit and day only, using the publish token", async () => {
    await withBundleRoot(async (root) => {
      const calls: Array<{ prefix: string; token: string }> = [];
      await write(root, {
        mode: "publish",
        env: TOKEN_ENV,
        remoteSequenceReader: remoteReporting([], calls),
      });

      expect(calls).toEqual([
        { prefix: "abc123d-2026-01-15", token: "a-repo-token" },
      ]);
    });
  });

  it("leaves the remote alone for a local run, which cannot collide with it", async () => {
    await withBundleRoot(async (root) => {
      const calls: Array<{ prefix: string; token: string }> = [];
      await write(root, { remoteSequenceReader: remoteReporting([], calls) });

      expect(calls).toEqual([]);
    });
  });

  it("leaves the remote alone for a dry run, which never reaches the repo", async () => {
    await withBundleRoot(async (root) => {
      const calls: Array<{ prefix: string; token: string }> = [];
      await write(root, {
        mode: "publish",
        dryRun: true,
        env: TOKEN_ENV,
        remoteSequenceReader: remoteReporting([], calls),
      });

      expect(calls).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// The publish gate
// ---------------------------------------------------------------------------

describe("a maintainer publishes without a results-repo token", () => {
  it("refuses the run and names the variable to set", async () => {
    await withBundleRoot(async (root) => {
      const result = await new ArtifactBundleWriter(root).writeBundle({
        runnerResults: [runnerResult()],
        provenanceManifest: null,
        gitSha: FIXED_GIT_SHA,
        assembledAt: FIXED_TIMESTAMP,
        mode: "publish",
        env: {},
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe("PublishTokenMissing");
      expect(error.message).toContain(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
    });
  });

  it("writes nothing at all, so a refused publish leaves no half-run behind", async () => {
    await withBundleRoot(async (root) => {
      await new ArtifactBundleWriter(root).writeBundle({
        runnerResults: [runnerResult()],
        provenanceManifest: null,
        gitSha: FIXED_GIT_SHA,
        assembledAt: FIXED_TIMESTAMP,
        mode: "publish",
        env: {},
      });

      expect(await tree(root)).toEqual([]);
    });
  });

  it("still writes a dry run, because a dry run is local whatever the mode says", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        mode: "publish",
        dryRun: true,
        env: {},
      });

      expect(await runFiles(root, written.runId)).toContain(
        "bundle-index.json",
      );
      expect(
        (await readRunJson(root, written.runId, "bundle-index.json")).dryRun,
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-model and multi-suite runs
// ---------------------------------------------------------------------------

describe("a run covers two suites against two models", () => {
  const SONNET = "anthropic/claude-sonnet-4.5";
  const GPT = "openai/gpt-5";

  /** One runner result per (suite, model) pair, as a matrix run produces. */
  function matrix() {
    return ["loom-routing", "pattern-planning"].flatMap((suite) =>
      [SONNET, GPT].map((modelId) =>
        runnerResult({
          suite,
          caseResults: [
            caseResult({ suite, modelId, caseId: `${suite}-case` }),
          ],
        }),
      ),
    );
  }

  it("writes one score file per suite rather than one per model", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { runnerResults: matrix() });

      expect((await runFiles(root, written.runId)).sort()).toContain(
        "score-loom-routing.json",
      );
      expect(await runFiles(root, written.runId)).toContain(
        "score-pattern-planning.json",
      );
    });
  });

  it("keeps every model's rows in that one file, so no model overwrites another", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { runnerResults: matrix() });
      const score = await readRunJson(
        root,
        written.runId,
        "score-loom-routing.json",
      );

      expect(score.results.map((r: { modelId: string }) => r.modelId)).toEqual([
        SONNET,
        GPT,
      ]);
      expect(score.totals.totalCases).toBe(2);
    });
  });

  it("lists each suite once in the run summary, however many models ran it", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { runnerResults: matrix() });
      const index = await readRunJson(root, written.runId, "bundle-index.json");

      expect(index.runSummary.suites).toEqual([
        "loom-routing",
        "pattern-planning",
      ]);
      expect(index.runSummary.totalCases).toBe(4);
    });
  });

  it("reports both models in the public report, so they can be compared", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { runnerResults: matrix() });
      const report = await readRunJson(
        root,
        written.runId,
        "public-report.json",
      );
      const models = report.suiteSummaries.flatMap(
        (s: { cases: Array<{ modelId: string }> }) =>
          s.cases.map((c) => c.modelId),
      );

      expect([...new Set(models)].sort()).toEqual([SONNET, GPT].sort());
    });
  });
});

// ---------------------------------------------------------------------------
// What the public report says about a score
// ---------------------------------------------------------------------------

describe("a run mixes passing, partial, failing and skipped cases", () => {
  /** One case per score band, all in one suite. */
  function banded() {
    return [
      runnerResult({
        caseResults: [
          caseResult({ caseId: "clear-pass", weightedTotal: 0.95 }),
          caseResult({ caseId: "partial", weightedTotal: 0.6 }),
          caseResult({
            caseId: "clear-fail",
            passed: false,
            weightedTotal: 0.2,
          }),
          caseResult({ caseId: "skipped", weightedTotal: 0.95, dryRun: true }),
        ],
      }),
    ];
  }

  it("publishes a score band per case instead of the raw number", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { runnerResults: banded() });
      const report = await readRunJson(
        root,
        written.runId,
        "public-report.json",
      );
      const buckets = Object.fromEntries(
        report.suiteSummaries[0].cases.map(
          (c: { caseId: string; scoreBucket: string }) => [
            c.caseId,
            c.scoreBucket,
          ],
        ),
      );

      expect(buckets).toEqual({
        "clear-pass": "pass",
        partial: "partial",
        "clear-fail": "fail",
        skipped: "skip",
      });
    });
  });

  it("publishes no weighted score, so a bucket cannot be reverse-engineered", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { runnerResults: banded() });
      const report = await readRunJson(
        root,
        written.runId,
        "public-report.json",
      );

      for (const entry of report.suiteSummaries[0].cases) {
        expect(entry.weightedTotal).toBeUndefined();
        expect(entry.dimensionScores).toBeUndefined();
      }
    });
  });

  it("publishes the trajectory a harness actually took when one was observed", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                caseId: "observed",
                trajectorySummary: {
                  harnessDelegatedCorrectly: true,
                  observedSpawns: ["shuttle-backend"],
                  observedToolCalls: 3,
                  harnessCompletedWithoutError: true,
                },
              }),
            ],
          }),
        ],
      });
      const report = await readRunJson(
        root,
        written.runId,
        "public-report.json",
      );

      expect(report.suiteSummaries[0].hasRuntimeVerifiedCases).toBe(true);
      expect(report.suiteSummaries[0].cases[0].trajectorySummary).toEqual({
        harnessDelegatedCorrectly: true,
        observedSpawns: ["shuttle-backend"],
        observedToolCalls: 3,
        harnessCompletedWithoutError: true,
      });
    });
  });
});

describe("a case carries an explanation that would break the dashboard", () => {
  /**
   * Payloads deliberately free of double quotes: a quote survives into a
   * published file as `\"`, so a needle containing one matches nothing and the
   * assertion passes whether or not the payload was dropped. Every string here
   * appears verbatim in JSON, so the absence assertions can actually fail.
   */
  const HOSTILE = {
    "script tag": "<script>alert(1)</script>",
    "image error handler": "<img src=x onerror=alert(1)>",
    "javascript URI": "javascript:alert(1)",
    "data URI": "data:text/html;base64,PHNjcmlwdD4=",
    iframe: "<iframe src=https://evil.example></iframe>",
    "chain of thought": "<thinking>the model was unsure</thinking>",
    "transcript role marker": "Assistant: here is the answer",
  } as const;

  /** A run whose single case carries `text` as its public explanation. */
  function withExplanation(text: string) {
    return [
      runnerResult({
        caseResults: [
          caseResult({
            caseId: "hostile-explanation",
            publicExplanation: { text, source: "structured_signal" },
          }),
        ],
      }),
    ];
  }

  it.each(
    Object.entries(HOSTILE),
  )("keeps the %s out of every file the run declares public", async (_name, payload) => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: withExplanation(payload),
        writeMarkdown: true,
      });
      const declared: string[] = (
        await readRunJson(root, written.runId, "bundle-index.json")
      ).publicFiles;

      expect(declared).toContain("public-report.json");
      for (const name of declared) {
        const text = await Bun.file(join(written.bundleDir, name)).text();
        expect(text).not.toContain(payload);
      }
    });
  });

  it.each(
    Object.entries(HOSTILE),
  )("still carries the %s verbatim in the internal score file, which is published too", async (_name, payload) => {
    // Observed behaviour, not an endorsement. `BoundedExplanationSchema`
    // guards `public-report.json`, but `score-<suite>.json` takes the
    // explanation straight from the case summary — and every file in
    // `filesWritten`, score files included, is handed to the results-repo
    // publisher. See the note in the migration report for #183.
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: withExplanation(payload),
      });
      const score = await Bun.file(
        join(written.bundleDir, "score-loom-routing.json"),
      ).text();

      expect(score).toContain(payload);
    });
  });

  it("publishes the case and its score anyway, so dropping text never drops a result", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: withExplanation(HOSTILE["script tag"]),
      });
      const entry = (
        await readRunJson(root, written.runId, "public-report.json")
      ).suiteSummaries[0].cases[0];

      expect(entry.caseId).toBe("hostile-explanation");
      expect(entry.scoreBucket).toBe("pass");
      expect(entry.explanation).toBeUndefined();
    });
  });

  it("keeps a clean explanation, so the drop is targeted rather than blanket", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: withExplanation(
          "Routed to shuttle as the rubric expects.",
        ),
      });
      const entry = (
        await readRunJson(root, written.runId, "public-report.json")
      ).suiteSummaries[0].cases[0];

      expect(entry.explanation).toEqual({
        text: "Routed to shuttle as the rubric expects.",
        source: "structured_signal",
      });
    });
  });

  it("drops an explanation longer than the dashboard can render", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: withExplanation("a".repeat(301)),
      });
      const entry = (
        await readRunJson(root, written.runId, "public-report.json")
      ).suiteSummaries[0].cases[0];

      expect(entry.explanation).toBeUndefined();
    });
  });

  it.each([
    ["an unknown channel", "totally-made-up"],
    ["the transcript", "transcript_content"],
    ["a rationale", "raw_rationale"],
  ])("drops an explanation that declares it came from %s", async (_name, source) => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                caseId: "mis-sourced",
                publicExplanation: {
                  text: "routed to shuttle",
                  source,
                } as never,
              }),
            ],
          }),
        ],
      });
      const entry = (
        await readRunJson(root, written.runId, "public-report.json")
      ).suiteSummaries[0].cases[0];

      expect(entry.caseId).toBe("mis-sourced");
      expect(entry.explanation).toBeUndefined();
    });
  });
});

describe("a required case in a suite failed", () => {
  it("marks the suite red in the public report rather than rounding it up", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({ caseId: "passed-one" }),
              caseResult({ caseId: "failed-one", passed: false }),
            ],
          }),
        ],
      });
      const suite = (
        await readRunJson(root, written.runId, "public-report.json")
      ).suiteSummaries[0];

      expect(suite.suiteGreen).toBe(false);
      expect(suite.passedCases).toBe(1);
      expect(suite.failedCases).toBe(1);
      expect(suite.cases.map((c: { caseId: string }) => c.caseId)).toEqual([
        "passed-one",
        "failed-one",
      ]);
    });
  });

  it("counts a dry-run case out of the verdict, so a skip cannot turn a suite red", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({ caseId: "passed-one" }),
              caseResult({
                caseId: "skipped-one",
                passed: false,
                dryRun: true,
              }),
            ],
          }),
        ],
      });
      const suite = (
        await readRunJson(root, written.runId, "public-report.json")
      ).suiteSummaries[0];

      expect(suite.suiteGreen).toBe(true);
    });
  });
});

/**
 * An empty run is refused at the writer (#205), not merely avoided by the
 * orchestrator. With no failures, a run that scored nothing reads as green —
 * which is how a `--model` typo once published a passing run. The orchestrator
 * no longer produces one (`suite-runners.scenario.test.ts`), and this is the
 * second line: whoever calls the writer, nothing with `totalCases: 0` is
 * written, indexed or handed to the results repo.
 */
describe("a run scored no cases at all", () => {
  const EMPTY_SUITE = runnerResult({ caseResults: [] });

  /** Attempts a write and returns the result and what landed on disk. */
  async function attempt(
    root: string,
    overrides: Partial<WriteBundleOptions> = {},
  ) {
    const result = await new ArtifactBundleWriter(root).writeBundle({
      runnerResults: [EMPTY_SUITE],
      provenanceManifest: provenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      ...overrides,
    });
    return { result, files: await tree(root) };
  }

  it.each([
    ["no suites", [] as RunnerResult[]],
    ["one suite with no cases", [EMPTY_SUITE]],
    [
      "two suites with no cases",
      [EMPTY_SUITE, runnerResult({ suite: "weft-review", caseResults: [] })],
    ],
  ])("refuses a run of %s, and says it scored nothing", async (_label, runnerResults) => {
    await withBundleRoot(async (root) => {
      const { result } = await attempt(root, { runnerResults });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe("EmptyRun");
      expect(error.message).toContain("totalCases: 0");
    });
  });

  it("writes nothing at all, not even the dashboard indexes", async () => {
    await withBundleRoot(async (root) => {
      const { files } = await attempt(root, {
        writeMarkdown: true,
        generateIndexes: true,
      });

      expect(files).toEqual([]);
    });
  });

  it("never hands the run to the results repo", async () => {
    await withBundleRoot(async (root) => {
      const handed: unknown[] = [];
      const { result, files } = await attempt(root, {
        mode: "publish",
        env: TOKEN_ENV,
        generateIndexes: true,
        publisher: {
          publish(request) {
            handed.push(request);
            return okAsync({
              commitSha: null,
              branch: "main",
              filesPublished: 0,
              simulated: true,
            });
          },
        },
      });

      expect(result._unsafeUnwrapErr().type).toBe("EmptyRun");
      expect(handed).toEqual([]);
      expect(files).toEqual([]);
    });
  });

  it("still refuses a dry run, which has no cases to show either", async () => {
    await withBundleRoot(async (root) => {
      const { result, files } = await attempt(root, { dryRun: true });

      expect(result._unsafeUnwrapErr().type).toBe("EmptyRun");
      expect(files).toEqual([]);
    });
  });
});

describe("every case the writer is handed errored and none was scored", () => {
  const ALL_ERRORED = runnerResult({
    caseResults: [
      caseResult({
        passed: false,
        errored: true,
        errorClassification: "model-empty-response",
      }),
      caseResult({
        caseId: "route-to-pattern",
        passed: false,
        errored: true,
        errorClassification: "model-truncated-response",
      }),
    ],
  });

  it("refuses to write, index or publish it, and says nothing was scored", async () => {
    await withBundleRoot(async (root) => {
      const handed: unknown[] = [];
      const result = await new ArtifactBundleWriter(root).writeBundle({
        runnerResults: [ALL_ERRORED],
        provenanceManifest: provenanceManifest(),
        gitSha: FIXED_GIT_SHA,
        assembledAt: FIXED_TIMESTAMP,
        mode: "publish",
        env: TOKEN_ENV,
        generateIndexes: true,
        publisher: {
          publish(request) {
            handed.push(request);
            return okAsync({
              commitSha: null,
              branch: "main",
              filesPublished: 0,
              simulated: true,
            });
          },
        },
      });

      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe("NoScoredCases");
      expect(error.message).toContain("all 2 case(s) errored");
      expect(handed).toEqual([]);
      expect(await tree(root)).toEqual([]);
    });
  });

  it("writes the run once one case beside them was scored, with the errored ones marked", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              ...ALL_ERRORED.caseResults,
              caseResult({ caseId: "route-to-thread" }),
            ],
          }),
        ],
      });
      const report = await Bun.file(
        join(written.bundleDir, "public-report.json"),
      ).json();

      expect(report.runSummary).toMatchObject({
        totalCases: 3,
        passedCases: 1,
        failedCases: 0,
        erroredCases: 2,
        allSuitesGreen: false,
      });
    });
  });
});

describe("one suite of a run scored no cases, and another did", () => {
  it("writes the run, and still lists the empty suite so it is visible", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, {
        runnerResults: [
          runnerResult(),
          runnerResult({ suite: "weft-review", caseResults: [] }),
        ],
      });
      const report = await readRunJson(
        root,
        written.runId,
        "public-report.json",
      );

      expect(await runFiles(root, written.runId)).toContain(
        "score-weft-review.json",
      );
      expect(report.runSummary.suites).toEqual(["loom-routing", "weft-review"]);
      expect(report.suiteSummaries[1].cases).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// The Markdown report
// ---------------------------------------------------------------------------

describe("a maintainer wants the run readable without a dashboard", () => {
  it("writes public-report.md and declares it public", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { writeMarkdown: true });

      expect(await runFiles(root, written.runId)).toContain("public-report.md");
      expect(
        (await readRunJson(root, written.runId, "bundle-index.json"))
          .publicFiles,
      ).toContain("public-report.md");
    });
  });

  it("writes no Markdown when it was not asked for, and declares none", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);

      expect(await runFiles(root, written.runId)).not.toContain(
        "public-report.md",
      );
      expect(
        (await readRunJson(root, written.runId, "bundle-index.json"))
          .publicFiles,
      ).not.toContain("public-report.md");
    });
  });
});

// ---------------------------------------------------------------------------
// Dashboard indexes
// ---------------------------------------------------------------------------

describe("a maintainer refreshes the dashboard after a run", () => {
  it("writes the indexes beside runs/, never inside an immutable run directory", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { generateIndexes: true });

      expect(written.indexFilesWritten).toContain("dashboard-manifest.json");
      expect(await tree(root)).toContain("dashboard-manifest.json");
      expect(await runFiles(root, written.runId)).not.toContain(
        "dashboard-manifest.json",
      );
    });
  });

  it("counts every run written so far, so the dashboard shows history", async () => {
    await withBundleRoot(async (root) => {
      await write(root, { generateIndexes: true });
      await write(root, { generateIndexes: true });
      const manifest = await Bun.file(
        join(root, "dashboard-manifest.json"),
      ).json();

      expect(manifest.totalRuns).toBe(2);
    });
  });

  it("leaves the run written when no indexes were asked for", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);

      expect(written.indexFilesWritten).toEqual([]);
      expect(await tree(root)).not.toContain("dashboard-manifest.json");
    });
  });
});

// ---------------------------------------------------------------------------
// Raw debugging artifacts — local only
// ---------------------------------------------------------------------------

describe("a maintainer keeps the raw prompts and transcripts of a run", () => {
  const RAW = [
    "RAW-PROMPT-MARKER",
    "RAW-TRANSCRIPT-MARKER",
    "RAW-RESPONSE-MARKER",
    "RAW-RATIONALE-MARKER",
  ];

  it("puts them under the run's raw/ subdirectory, apart from the published files", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const path = (
        await new RawArtifactsWriter(
          written.bundleDir,
          true,
        ).writeCaseResultArtifact(rawArtifact(), FIXED_TIMESTAMP)
      )._unsafeUnwrap();

      expect(path).toBe(
        join(
          written.bundleDir,
          "raw",
          "case-route-to-shuttle-anthropic_claude-sonnet-4.5-2026-01-15T12-00-00-000Z.json",
        ),
      );
      expect(await Bun.file(path).exists()).toBe(true);
    });
  });

  it("never lets raw content reach a file the run declares public", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { writeMarkdown: true });
      await new RawArtifactsWriter(
        written.bundleDir,
        true,
      ).writeCaseResultArtifact(rawArtifact(), FIXED_TIMESTAMP);

      const index = await readRunJson(root, written.runId, "bundle-index.json");
      for (const name of index.publicFiles as string[]) {
        const text = await Bun.file(join(written.bundleDir, name)).text();
        for (const marker of RAW) expect(text).not.toContain(marker);
      }
      expect(index.publicFiles).not.toContain("raw");
    });
  });

  it("keeps the whole prompt, transcript and rationale, which is the point of asking for them", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const path = (
        await new RawArtifactsWriter(
          written.bundleDir,
          true,
        ).writeCaseResultArtifact(rawArtifact(), FIXED_TIMESTAMP)
      )._unsafeUnwrap();
      const artifact = await Bun.file(path).json();

      expect(artifact.caseId).toBe("route-to-shuttle");
      expect(artifact.composedPrompt).toContain("RAW-PROMPT-MARKER");
      expect(artifact.transcript[0].content).toBe("RAW-TRANSCRIPT-MARKER");
      expect(artifact.rawContent).toBe("RAW-RESPONSE-MARKER");
      expect(artifact.dimensionRationales.routingCorrectness).toBe(
        "RAW-RATIONALE-MARKER",
      );
    });
  });

  it("names two artifacts from the same case apart, so a rerun keeps both", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const writer = new RawArtifactsWriter(written.bundleDir, true);

      const first = (
        await writer.writeCaseResultArtifact(
          rawArtifact(),
          "2026-01-15T12:00:00.000Z",
        )
      )._unsafeUnwrap();
      const second = (
        await writer.writeCaseResultArtifact(
          rawArtifact(),
          "2026-01-15T12:00:00.001Z",
        )
      )._unsafeUnwrap();

      expect(first).not.toBe(second);
      expect(await Bun.file(first).exists()).toBe(true);
      expect(await Bun.file(second).exists()).toBe(true);
    });
  });

  it("writes nothing at all when raw capture was not switched on", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const before = await tree(root);

      const result = await new RawArtifactsWriter(
        written.bundleDir,
        false,
      ).writeCaseResultArtifact(rawArtifact(), FIXED_TIMESTAMP);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("RawArtifactsDisabled");
      expect(await tree(root)).toEqual(before);
    });
  });

  it.each([
    ["case id", { caseId: "../../../etc/passwd" }],
    ["model id", { modelId: "../../escape/model" }],
  ])("keeps a hostile %s inside raw/, so nothing is written outside the run", async (_what, overrides) => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const rawDir = join(written.bundleDir, "raw");

      const path = (
        await new RawArtifactsWriter(
          written.bundleDir,
          true,
        ).writeCaseResultArtifact(rawArtifact(overrides), FIXED_TIMESTAMP)
      )._unsafeUnwrap();

      expect(path.startsWith(`${rawDir}/`)).toBe(true);
      expect(path).not.toContain("..");
      for (const relative of await tree(root)) {
        expect(relative.startsWith("..")).toBe(false);
      }
    });
  });

  it("keeps a hostile agent name inside raw/ for a prompt artifact too", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const rawDir = join(written.bundleDir, "raw");

      const path = (
        await new RawArtifactsWriter(
          written.bundleDir,
          true,
        ).writePromptArtifact(
          { agentName: "../../loom", composedPrompt: "RAW-PROMPT-MARKER" },
          FIXED_TIMESTAMP,
        )
      )._unsafeUnwrap();

      expect(path.startsWith(`${rawDir}/`)).toBe(true);
      expect(path).not.toContain("..");
    });
  });

  it("writes every artifact of a batch and reports the ones it could not", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root);
      const writer = new RawArtifactsWriter(written.bundleDir, true);

      const { written: paths, errors } = (
        await writer.writeCaseResultArtifacts(
          [
            rawArtifact({ caseId: "one" }),
            rawArtifact({ caseId: "two" }),
            // No raw content at all: writing it would be a misleading "raw" file.
            {
              caseId: "empty",
              modelId: "m",
              transcript: [],
              dimensionRationales: {},
            } as unknown as RawCaseResultArtifact,
          ],
          FIXED_TIMESTAMP,
        )
      )._unsafeUnwrap();

      expect(paths).toHaveLength(2);
      expect(errors.map((e) => e.type)).toEqual(["RawArtifactWriteError"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Provenance — tying a score to a prompt
// ---------------------------------------------------------------------------

describe("a maintainer asks which prompt produced a published score", () => {
  const LOOM_HASH = "1".repeat(64);
  const SHUTTLE_HASH = "2".repeat(64);

  /** A manifest derived through the real pipeline from two agents' prompts. */
  function derived(loomHash = LOOM_HASH) {
    return deriveProvenanceManifest(
      [snapshot("loom", loomHash), snapshot("shuttle", SHUTTLE_HASH)],
      {
        gitShaProvider: { resolveGitSha: () => ok(FIXED_GIT_SHA) },
        capturedAt: FIXED_TIMESTAMP,
      },
    )._unsafeUnwrap();
  }

  it("publishes a prompt hash per agent, so a score points at an exact prompt", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { provenanceManifest: derived() });
      const hashes = await readRunJson(
        root,
        written.runId,
        "prompt-hashes.json",
      );

      expect(
        Object.fromEntries(
          hashes.promptHashes.map((r: { agentName: string; hash: string }) => [
            r.agentName,
            r.hash,
          ]),
        ),
      ).toEqual({ loom: LOOM_HASH, shuttle: SHUTTLE_HASH });
    });
  });

  it("publishes a different hash once a prompt changes, so drift is visible in a diff", async () => {
    const hashFor = async (loomHash: string) =>
      withBundleRoot(async (root) => {
        const written = await write(root, {
          provenanceManifest: derived(loomHash),
        });
        const hashes = await readRunJson(
          root,
          written.runId,
          "prompt-hashes.json",
        );
        return hashes.promptHashes[0].hash;
      });

    expect(await hashFor(LOOM_HASH)).not.toBe(await hashFor("3".repeat(64)));
  });

  it("records the commit on the manifest and on every record", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { provenanceManifest: derived() });
      const manifest = await readRunJson(
        root,
        written.runId,
        "provenance-manifest.json",
      );

      expect(manifest.gitSha).toBe(FIXED_GIT_SHA);
      for (const record of manifest.records) {
        expect(record.gitSha).toBe(FIXED_GIT_SHA);
        expect(record.capturedAt).toBe(FIXED_TIMESTAMP);
      }
    });
  });

  it("says where each prompt layer came from without publishing its text", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { provenanceManifest: derived() });
      const manifest = await readRunJson(
        root,
        written.runId,
        "provenance-manifest.json",
      );
      const loom = manifest.records[0];

      expect(loom.summary).toContain('Agent "loom"');
      expect(loom.summary).toContain("builtin primary");
      expect(loom.summary).toContain("file append");
      expect(loom.summary).toContain(`sha256:${LOOM_HASH.slice(0, 12)}`);
      expect(loom.byteLength).toBe(4096);
    });
  });

  it("omits the provenance files entirely when no manifest was captured", async () => {
    await withBundleRoot(async (root) => {
      const written = await write(root, { provenanceManifest: null });
      const files = await runFiles(root, written.runId);

      expect(files).not.toContain("provenance-manifest.json");
      expect(files).not.toContain("prompt-hashes.json");
      expect(files).toContain("public-report.json");
    });
  });
});
