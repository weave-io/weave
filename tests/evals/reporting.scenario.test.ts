/**
 * Evals scenarios — what a reader sees, and what reaches the results repo.
 *
 * Bucket: Evals. Three black boxes, all downstream of a written run:
 *
 * - **`public-report.md`** — the Markdown artifact a maintainer downloads from
 *   CI or reads in the GitHub UI. Rendered by `report-markdown.ts`; entered
 *   here through `ArtifactBundleWriter.writeBundle({ writeMarkdown: true })`,
 *   never by calling the renderer.
 * - **the dashboard indexes** — the JSON files tryweave.io fetches to learn
 *   which runs exist. Written by `DashboardIndexWriter`; entered through
 *   `writeBundle({ generateIndexes: true })`, or through `rebuildFromRuns()`
 *   when a scenario needs run directories that no single write produces.
 * - **the HTTP traffic of a publish** — `GitHubContentsPublisher` takes an
 *   injected `fetch`, so every request a publish would make is observable
 *   without a network. That injected seam is the only one used here.
 *
 * [`bundle-writing.scenario.test.ts`](bundle-writing.scenario.test.ts) covers
 * how a run is addressed and kept apart;
 * [`publish-safety.scenario.test.ts`](publish-safety.scenario.test.ts) covers
 * what a bundle may contain. This file covers how that content is **rendered,
 * indexed and uploaded**.
 *
 * [`docs/eval-xss-policy.md`](../../docs/eval-xss-policy.md) is normative for
 * everything asserted about `public-report.md`. Nothing here weakens it — and
 * one scenario records a place where the renderer does not yet meet it.
 *
 * Every absence assertion below was watched go red against a mutated source
 * (see the PR for the table), and each is paired with a positive assertion, so
 * a payload that simply never arrived cannot pass for a payload that was
 * blocked.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import {
  ArtifactBundleWriter,
  type BundleWriteResult,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  RUNS_SUBDIR,
  type WriteBundleOptions,
} from "../../packages/cli/src/evals/artifact-bundle.js";
import { DashboardIndexWriter } from "../../packages/cli/src/evals/dashboard-indexes.js";
import { GitHubContentsPublisher } from "../../packages/cli/src/evals/github-contents-publisher.js";
import type {
  PublishBundleRequest,
  PublishBundleResult,
  ResultsRepoPublisher,
} from "../../packages/cli/src/evals/results-repo.js";
import type { ResultsRepoError } from "../../packages/cli/src/evals/types.js";
import {
  caseResult,
  FIXED_GIT_SHA,
  FIXED_TIMESTAMP,
  provenanceManifest,
  runnerResult,
  withBundleRoot,
} from "../support/evals.js";

// ---------------------------------------------------------------------------
// Local harness — writing
// ---------------------------------------------------------------------------

/** Writes one run into `root`, failing loudly rather than returning an error. */
async function writeRun(
  root: string,
  overrides: Partial<WriteBundleOptions> = {},
): Promise<BundleWriteResult> {
  const result = await new ArtifactBundleWriter(root).writeBundle({
    runnerResults: [runnerResult()],
    provenanceManifest: provenanceManifest(),
    gitSha: FIXED_GIT_SHA,
    assembledAt: FIXED_TIMESTAMP,
    ...overrides,
  });

  if (result.isErr()) {
    expect(JSON.stringify(result.error)).toBe("run written");
  }
  return result._unsafeUnwrap();
}

/** Writes one run and returns the Markdown report a reader would download. */
async function markdownOf(
  root: string,
  overrides: Partial<WriteBundleOptions> = {},
): Promise<string> {
  const written = await writeRun(root, { writeMarkdown: true, ...overrides });
  return Bun.file(join(written.bundleDir, "public-report.md")).text();
}

/** Reads and parses one index file from the bundle root. */
async function readIndex(
  root: string,
  fileName: string,
  // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
): Promise<any> {
  return Bun.file(join(root, fileName)).json();
}

/** Reads and parses the `public-report.json` of a written run. */
async function readPublicReport(
  written: BundleWriteResult,
  // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
): Promise<any> {
  return Bun.file(join(written.bundleDir, "public-report.json")).json();
}

/** A run whose single case is the default one, assembled on the given day. */
function onDay(day: string): Partial<WriteBundleOptions> {
  return { assembledAt: `2026-01-${day}T12:00:00.000Z` };
}

// ---------------------------------------------------------------------------
// Local harness — publishing
// ---------------------------------------------------------------------------

const TOKEN = "a-results-repo-token";
const TOKEN_ENV = { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: TOKEN };
const API_PREFIX =
  "https://api.github.com/repos/weave-io/weave-agent-evals/contents/";

/** One request a publish made, reduced to what a maintainer could check. */
interface Call {
  method: string;
  path: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

/**
 * An injected `fetch` that answers 404 for every remote path except the ones
 * named in `existing`, which answer 200 with a blob SHA. Records every call.
 */
function recordingFetch(existing: Iterable<string> = []) {
  const calls: Call[] = [];
  const present = new Set(existing);

  const fetchImpl = async (request: Request): Promise<Response> => {
    const body =
      request.method === "PUT"
        ? ((await request.clone().json()) as Record<string, unknown>)
        : null;
    calls.push({
      method: request.method,
      path: request.url.replace(API_PREFIX, ""),
      url: request.url,
      authorization: request.headers.get("Authorization"),
      body,
    });

    if (request.method === "GET") {
      if (present.has(request.url.replace(API_PREFIX, ""))) {
        return new Response(JSON.stringify({ sha: "remote-blob-sha" }), {
          status: 200,
        });
      }
      return new Response("Not Found", { status: 404 });
    }
    return new Response(JSON.stringify({ commit: { sha: "commit-sha-1" } }), {
      status: 201,
    });
  };

  return { calls, fetchImpl };
}

/** The remote paths a publish sent a PUT to, in order. */
function uploaded(calls: Call[]): string[] {
  return calls.filter((c) => c.method === "PUT").map((c) => c.path);
}

/** Writes a run locally, then publishes exactly what that write produced. */
async function writeThenPublish(
  root: string,
  calls: Call[],
  fetchImpl: (request: Request) => Promise<Response>,
  requestOverrides: Partial<PublishBundleRequest> = {},
  /**
   * Reader override. The default reads the bundle off disk; a scenario that
   * names a file the run never wrote supplies a stub, so what it observes is
   * the allowlist filtering rather than a missing file.
   */
  fileReader?: (path: string) => Promise<string>,
) {
  const written = await writeRun(root, {
    writeMarkdown: true,
    generateIndexes: true,
  });
  const result = await new GitHubContentsPublisher(
    fetchImpl,
    fileReader,
  ).publish({
    bundle: written.bundle,
    localBundleDir: written.bundleDir,
    fileNames: written.filesWritten.map((p) => p.slice(p.lastIndexOf("/") + 1)),
    localBundleRoot: root,
    indexFileNames: written.indexFilesWritten,
    env: TOKEN_ENV,
    ...requestOverrides,
  });
  return { written, result, calls };
}

/** A publisher that records the request it was handed and reports success. */
class RecordingPublisher implements ResultsRepoPublisher {
  readonly requests: PublishBundleRequest[] = [];

  publish(request: PublishBundleRequest) {
    this.requests.push(request);
    return okAsync<PublishBundleResult, ResultsRepoError>({
      commitSha: null,
      branch: "main",
      filesPublished: 0,
      simulated: true,
    });
  }
}

// ===========================================================================
// The Markdown report
// ===========================================================================

describe("a maintainer downloads the Markdown report of a run that failed", () => {
  /** Two suites, one of them red, with a passing, a failing and a skipped case. */
  const results = [
    runnerResult({
      caseResults: [
        caseResult({
          publicExplanation: {
            text: "routing matched | the expected agent",
            source: "operator_note",
          },
        } as never),
        caseResult({
          caseId: "route-to-warp",
          modelId: "openai/gpt-5",
          passed: false,
          weightedTotal: 0.6,
        }),
        caseResult({
          caseId: "route-to-weft",
          modelId: "openai/gpt-5",
          dryRun: true,
        } as never),
      ],
    }),
    runnerResult({
      suite: "tapestry-execution",
      caseResults: [caseResult({ suite: "tapestry-execution" })],
    }),
  ];

  const report = (root: string) => markdownOf(root, { runnerResults: results });

  it("opens with a verdict for the whole run, so the first line answers the question", async () => {
    await withBundleRoot(async (root) => {
      expect(await report(root)).toContain(
        "## Weave Agent Evals Report — 🔴 One or more suites failed",
      );
    });
  });

  it("names the commit in short form and the moment the run was assembled", async () => {
    await withBundleRoot(async (root) => {
      expect(await report(root)).toContain(
        "**Git SHA**: `abc123d` | **Assembled**: 2026-01-15T12:00:00.000Z",
      );
    });
  });

  it("totals the whole run across suites, not just the last one", async () => {
    await withBundleRoot(async (root) => {
      expect(await report(root)).toContain(
        "**Total cases**: 4 | **Passed**: 3 | **Failed**: 1",
      );
    });
  });

  it("lists every suite that ran, so a missing family is visible", async () => {
    await withBundleRoot(async (root) => {
      expect(await report(root)).toContain(
        "**Suites**: loom-routing, tapestry-execution",
      );
    });
  });

  it("gives each suite its own section with its own verdict and counts", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await report(root);

      expect(markdown).toContain("### Suite: loom-routing — 🔴 red");
      expect(markdown).toContain("### Suite: tapestry-execution — 🟢 green");
      expect(markdown).toContain(
        "**Total**: 3 | **Passed**: 2 | **Failed**: 1",
      );
    });
  });

  it("lays each suite out as a table a Markdown reader can render", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await report(root);

      expect(markdown).toContain(
        "| Case ID | Model | Score | Passed | Explanation |",
      );
      expect(markdown).toContain(
        "|---------|-------|-------|--------|-------------|",
      );
    });
  });

  it("gives each case a score band and a plain yes or no, rather than a raw number", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await report(root);

      expect(markdown).toContain(
        "| route-to-shuttle | anthropic/claude-sonnet-4.5 | ✅ pass | yes |",
      );
      expect(markdown).toContain(
        "| route-to-warp | openai/gpt-5 | ⚠️ partial | no |",
      );
      expect(markdown).toContain(
        "| route-to-weft | openai/gpt-5 | ⏭️ skip | yes |",
      );
      expect(markdown).not.toContain("0.6");
    });
  });

  it("shows the explanation beside the case it explains", async () => {
    await withBundleRoot(async (root) => {
      expect(await report(root)).toContain(
        "| ✅ pass | yes | routing matched &#124; the expected agent |",
      );
    });
  });
});

/**
 * A run whose every suite is empty is refused before it is written (#205;
 * `bundle-writing.scenario.test.ts`), so an empty suite only reaches a report
 * beside one that ran cases.
 */
describe("a suite ran no cases at all, beside one that did", () => {
  it("says so rather than printing an empty table a reader would mistrust", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({ suite: "warp-security", caseResults: [] }),
          runnerResult(),
        ],
      });

      const emptySection = markdown.slice(
        markdown.indexOf("### Suite: warp-security"),
        markdown.indexOf("### Suite: loom-routing"),
      );

      expect(emptySection).toContain("### Suite: warp-security — 🟢 green");
      expect(emptySection).toContain("_No cases in this suite._");
      expect(emptySection).not.toContain("| Case ID |");
    });
  });
});

describe("a maintainer downloads the report of a dry run", () => {
  it("warns on the face of the document that no model was called", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        dryRun: true,
        runnerResults: [
          runnerResult({
            caseResults: [caseResult({ dryRun: true } as never)],
          }),
        ],
      });

      expect(markdown).toContain(
        "> ⚠️ **Dry-run**: no model was called — all scores are zero.",
      );
      // Every band reads "skip", so no row can be mistaken for a real result.
      expect(markdown).toContain("| ⏭️ skip |");
    });
  });

  it("leaves the warning off a real run, so the banner means something", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root);

      expect(markdown).not.toContain("Dry-run");
      expect(markdown).toContain(
        "## Weave Agent Evals Report — 🟢 All suites green",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Injection into the Markdown report
// ---------------------------------------------------------------------------

/**
 * One payload per vector `docs/eval-xss-policy.md` names for
 * `MARKDOWN_INJECTION_PATTERNS`. None contains a double quote: a JSON
 * serializer would rewrite `"` to `\"`, and an assertion against the
 * unescaped form would then match nothing and pass for the wrong reason.
 */
const MARKDOWN_PAYLOADS: ReadonlyArray<readonly [name: string, text: string]> =
  [
    ["a <script> tag", "<script>alert(1)</script>"],
    ["a <style> tag", "<style>body{display:none}</style>"],
    ["an <iframe> tag", "<iframe src=evil-host>"],
    ["an <object> tag", "<object data=evil-host>"],
    ["an <embed> tag", "<embed src=evil-host>"],
    ["a <form> tag", "<form action=evil-host>"],
    ["an inline event handler", "<img src=x onerror=alert(1)>"],
    ["a javascript: URI", "javascript:alert(1)"],
    ["a data: URI", "data:text/html,evil-host"],
  ];

describe("a case id carries markup the report would otherwise render", () => {
  it.each(
    MARKDOWN_PAYLOADS,
  )("drops %s from the report and still lists the case's model", async (_name, payload) => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({ caseResults: [caseResult({ caseId: payload })] }),
        ],
      });

      expect(markdown).not.toContain(payload);
      // The positive twin: dropping the whole report would satisfy the line
      // above. The promise is that the row survives without the payload.
      expect(markdown).toContain("| anthropic/claude-sonnet-4.5 | ✅ pass |");
    });
  });
});

describe("a model id carries markup the report would otherwise render", () => {
  it.each(
    MARKDOWN_PAYLOADS,
  )("drops %s from the report and still lists the case it belongs to", async (_name, payload) => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({ caseResults: [caseResult({ modelId: payload })] }),
        ],
      });

      expect(markdown).not.toContain(payload);
      expect(markdown).toContain("| route-to-shuttle |");
    });
  });
});

describe("a case's explanation carries markup the report would otherwise render", () => {
  it.each(
    MARKDOWN_PAYLOADS,
  )("keeps %s out of the report while still publishing the case", async (_name, payload) => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                publicExplanation: {
                  text: `verdict ${payload}`,
                  source: "operator_note",
                },
              } as never),
            ],
          }),
        ],
      });

      expect(markdown).not.toContain(payload);
      expect(markdown).toContain("| route-to-shuttle |");
    });
  });
});

describe("a value in the report contains a pipe", () => {
  it("escapes it so the Markdown table keeps its shape", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                caseId: "route|to|shuttle",
                modelId: "anthropic|claude-sonnet-4.5",
                publicExplanation: {
                  text: "matched | as expected",
                  source: "operator_note",
                },
              } as never),
            ],
          }),
        ],
      });

      expect(markdown).toContain(
        "| route&#124;to&#124;shuttle | anthropic&#124;claude-sonnet-4.5 | ✅ pass | yes | matched &#124; as expected |",
      );
      // Six pipes is the table's own five columns plus nothing else: a raw
      // pipe in a cell would make this row seven and break the layout.
      const row = markdown
        .split("\n")
        .find((line) => line.includes("route&#124;"));
      expect((row ?? "").split("|").length - 1).toBe(6);
    });
  });
});

describe("a whole report is rendered from ordinary results", () => {
  it("contains no raw HTML at all, because it is plain Markdown by construction", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                publicExplanation: {
                  text: "routing matched",
                  source: "score_bucket_label",
                },
              } as never),
            ],
          }),
        ],
      });

      expect(markdown).toContain("routing matched");
      for (const pattern of [
        /<script/i,
        /<style/i,
        /<iframe/i,
        /<object/i,
        /<embed/i,
        /<form/i,
        /\bon\w+\s*=/i,
        /javascript\s*:/i,
        /data\s*:/i,
      ]) {
        expect(`${pattern} in report: ${pattern.test(markdown)}`).toBe(
          `${pattern} in report: false`,
        );
      }
    });
  });
});

describe("a reader skims the run and wants one line per suite", () => {
  /** The `explanation` the report carries for the first suite of a run. */
  async function suiteLine(
    root: string,
    overrides: Partial<WriteBundleOptions>,
    // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
  ): Promise<any> {
    const report = await readPublicReport(
      await writeRun(root, { ...overrides, writeMarkdown: true }),
    );
    return report.suiteSummaries[0].explanation;
  }

  it("says a suite is green and that every case in it passed", async () => {
    await withBundleRoot(async (root) => {
      expect(await suiteLine(root, {})).toEqual({
        text: "suite green; all 1 case(s) passed",
        source: "structured_signal",
      });
    });
  });

  it("says how many cases failed once one of them did", async () => {
    await withBundleRoot(async (root) => {
      const line = await suiteLine(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({ caseId: "one", passed: true }),
              caseResult({ caseId: "two", passed: false }),
              caseResult({ caseId: "three", passed: false }),
            ],
          }),
        ],
      });

      expect(line.text).toBe("suite not green; 1/3 passed, 2 failed");
    });
  });

  it("counts a suite that ran nothing, beside one that did, as green with nothing in it", async () => {
    await withBundleRoot(async (root) => {
      const line = await suiteLine(root, {
        runnerResults: [
          runnerResult({ suite: "warp-security", caseResults: [] }),
          runnerResult(),
        ],
      });

      expect(line.text).toBe("suite green; all 0 case(s) passed");
    });
  });

  it("says a dry run put nothing to a model, rather than reporting a green suite", async () => {
    await withBundleRoot(async (root) => {
      const line = await suiteLine(root, {
        dryRun: true,
        runnerResults: [
          runnerResult({
            caseResults: [caseResult({ dryRun: true } as never)],
          }),
        ],
      });

      expect(line.text).toBe("dry-run suite; 1 case(s) in workload");
    });
  });

  it("quotes nothing a model or a judge wrote", async () => {
    await withBundleRoot(async (root) => {
      const line = await suiteLine(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                caseId: "leaky",
                publicExplanation: {
                  text: "PER-CASE-TEXT",
                  source: "structured_signal",
                },
              } as never),
            ],
          }),
        ],
      });

      // Positive first: the line exists, so the absence is about what the
      // aggregate withheld rather than about a report that was never written.
      expect(line.text).toContain("suite green");
      expect(line.text).not.toContain("PER-CASE-TEXT");
    });
  });
});

describe("a reader compares how the models did on the same run", () => {
  /** The `explanation` the comparison carries for one model of a run. */
  async function modelLine(
    root: string,
    overrides: Partial<WriteBundleOptions>,
    index = 0,
    // biome-ignore lint/suspicious/noExplicitAny: scenarios read published JSON untyped.
  ): Promise<any> {
    const written = await writeRun(root, {
      ...overrides,
      generateIndexes: true,
    });
    const comparison = await readIndex(
      root,
      `model-comparison-${written.runId}.json`,
    );
    return comparison.models[index].explanation;
  }

  const TWO_MODELS = {
    runnerResults: [
      runnerResult({
        caseResults: [
          caseResult({ caseId: "one", modelId: "alpha/model", passed: false }),
          caseResult({ caseId: "two", modelId: "zeta/model", passed: true }),
        ],
      }),
    ],
  };

  it("gives each model its band and its tally, so the two are comparable", async () => {
    await withBundleRoot(async (root) => {
      expect(await modelLine(root, TWO_MODELS, 0)).toEqual({
        text: "model bucket: fail; 0/1 passed, 1 failed",
        source: "score_bucket_label",
      });
    });
    await withBundleRoot(async (root) => {
      expect((await modelLine(root, TWO_MODELS, 1)).text).toBe(
        "model bucket: pass; 1/1 passed, 0 failed",
      );
    });
  });

  it("calls a model partial when it passed some of its cases and not others", async () => {
    await withBundleRoot(async (root) => {
      const line = await modelLine(root, {
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({ caseId: "one", passed: true }),
              caseResult({ caseId: "two", passed: false }),
            ],
          }),
        ],
      });

      expect(line.text).toBe("model bucket: partial; 1/2 passed, 1 failed");
    });
  });

  it("says a dry run put nothing to the model, rather than reporting a failure", async () => {
    await withBundleRoot(async (root) => {
      const line = await modelLine(root, {
        dryRun: true,
        runnerResults: [
          runnerResult({
            caseResults: [caseResult({ dryRun: true } as never)],
          }),
        ],
      });

      expect(line.text).toBe("dry-run model; 1 case(s) in workload");
    });
  });
});

describe("a suite name carries markup the report would otherwise render", () => {
  /**
   * This scenario found a real hole and now guards the fix.
   *
   * `renderPublicReportBundle()` sanitized the `### Suite:` heading but
   * interpolated `runSummary.suites` straight into the run header, so a suite
   * name containing `<script>` reached `public-report.md` verbatim — against
   * the unconditional requirement in `docs/eval-xss-policy.md`.
   *
   * It survived for years of unit tests because every malicious-suite case set
   * `suiteSummaries[].suite` and left `runSummary.suites` clean, so the
   * unescaped line was never once exercised. Exposure was bounded — suite names
   * come from the repo-owned `EVAL_SUITE_REGISTRY`, not model output — but the
   * renderer is a layer-2 defence and had a gap in it.
   */
  const payload = "<script>alert(1)</script>";

  it("escapes markup in the run's suite list, not only in the suite heading", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, {
        runnerResults: [
          runnerResult({
            suite: payload,
            caseResults: [caseResult({ suite: payload })],
          }),
        ],
      });

      expect(markdown).toContain("### Suite:  — 🟢 green");
      expect(markdown).not.toContain(payload);
      expect(markdown).not.toContain("<script>");
    });
  });
});

// ===========================================================================
// The dashboard indexes
// ===========================================================================

describe("a maintainer has run the evals three times on one commit", () => {
  /** Three runs, oldest first, the middle one red and carrying a second case. */
  async function threeRuns(root: string) {
    await writeRun(root, { ...onDay("13"), generateIndexes: true });
    await writeRun(root, {
      ...onDay("14"),
      generateIndexes: true,
      runnerResults: [
        runnerResult({
          caseResults: [
            caseResult({ passed: false }),
            caseResult({ caseId: "route-to-warp", modelId: "openai/gpt-5" }),
          ],
        }),
      ],
    });
    return writeRun(root, { ...onDay("15"), generateIndexes: true });
  }

  it("lists every run in the manifest, newest first, and no run that never happened", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const manifest = await readIndex(root, "dashboard-manifest.json");

      expect(manifest.totalRuns).toBe(3);
      expect(manifest.runs.map((r: { runId: string }) => r.runId)).toEqual([
        "abc123d-2026-01-15-001",
        "abc123d-2026-01-14-001",
        "abc123d-2026-01-13-001",
      ]);
    });
  });

  it("points each manifest entry at the run's remote v1 path, which is where the dashboard fetches", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const manifest = await readIndex(root, "dashboard-manifest.json");

      expect(manifest.runs[0].bundleReportPath).toBe(
        "runs/v1/abc123d-2026-01-15-001/public-report.json",
      );
    });
  });

  it("carries each run's verdict and counts in the manifest, so the dashboard needs one fetch to draw a list", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const manifest = await readIndex(root, "dashboard-manifest.json");

      expect(manifest.runs[1]).toMatchObject({
        runId: "abc123d-2026-01-14-001",
        assembledAt: "2026-01-14T12:00:00.000Z",
        gitSha: FIXED_GIT_SHA,
        dryRun: false,
        allSuitesGreen: false,
        totalCases: 2,
        passedCases: 1,
        failedCases: 1,
        suites: ["loom-routing"],
      });
    });
  });

  it("plots the suite's history oldest first, with a pass rate per run, so a chart reads left to right", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const history = await readIndex(root, "suite-history-loom-routing.json");

      expect(
        history.history.map(
          (p: { runId: string; passRate: number }) =>
            `${p.runId}:${p.passRate}`,
        ),
      ).toEqual([
        "abc123d-2026-01-13-001:1",
        "abc123d-2026-01-14-001:0.5",
        "abc123d-2026-01-15-001:1",
      ]);
      expect(history.suite).toBe("loom-routing");
    });
  });

  it("points latest.json at the newest run, not the last one written", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const latest = await readIndex(root, "latest.json");

      expect(latest.runId).toBe("abc123d-2026-01-15-001");
      expect(latest.assembledAt).toBe("2026-01-15T12:00:00.000Z");
      expect(latest.allSuitesGreen).toBe(true);
    });
  });

  it("lists the recent runs newest first, so the dashboard's default view is the current one", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const lastN = await readIndex(root, "last-N-runs.json");

      expect(lastN.count).toBe(3);
      expect(lastN.maxRuns).toBe(10);
      expect(lastN.runs.map((r: { runId: string }) => r.runId)).toEqual([
        "abc123d-2026-01-15-001",
        "abc123d-2026-01-14-001",
        "abc123d-2026-01-13-001",
      ]);
    });
  });

  it("tracks each case across runs, oldest first, so a flaky scenario is visible as a streak", async () => {
    await withBundleRoot(async (root) => {
      await threeRuns(root);
      const scenarios = await readIndex(
        root,
        "scenario-history-loom-routing.json",
      );
      const byCase = Object.fromEntries(
        scenarios.scenarios.map((s: { caseId: string }) => [s.caseId, s]),
      );

      expect(Object.keys(byCase).sort()).toEqual([
        "route-to-shuttle",
        "route-to-warp",
      ]);
      expect(
        byCase["route-to-shuttle"].lastRuns.map(
          (r: { runId: string; status: string }) => `${r.runId}:${r.status}`,
        ),
      ).toEqual([
        "abc123d-2026-01-13-001:pass",
        "abc123d-2026-01-14-001:fail",
        "abc123d-2026-01-15-001:pass",
      ]);
      // A case that ran in one run only has one point, rather than blanks.
      expect(byCase["route-to-warp"].lastRuns).toHaveLength(1);
    });
  });
});

describe("a run pits two models against the same cases", () => {
  const results = [
    runnerResult({
      caseResults: [
        caseResult({ modelId: "zeta/model", passed: true }),
        caseResult({ modelId: "alpha/model", passed: false }),
      ],
    }),
  ];

  it("orders the models by name, so a comparison table does not reshuffle between runs", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, {
        runnerResults: results,
        generateIndexes: true,
      });
      const comparison = await readIndex(
        root,
        `model-comparison-${written.runId}.json`,
      );

      expect(
        comparison.models.map((m: { modelId: string }) => m.modelId),
      ).toEqual(["alpha/model", "zeta/model"]);
    });
  });

  it("gives each model a pass rate overall and per suite, with the band a reader skims", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, {
        runnerResults: results,
        generateIndexes: true,
      });
      const comparison = await readIndex(
        root,
        `model-comparison-${written.runId}.json`,
      );

      expect(comparison.models[0]).toMatchObject({
        modelId: "alpha/model",
        totalCases: 1,
        passedCases: 0,
        failedCases: 1,
        passRate: 0,
        perSuitePassRates: { "loom-routing": 0 },
        overallBucket: "fail",
      });
      expect(comparison.models[1]).toMatchObject({
        modelId: "zeta/model",
        passRate: 1,
        overallBucket: "pass",
      });
    });
  });

  it("calls the case partial when the models disagree, rather than picking a winner", async () => {
    await withBundleRoot(async (root) => {
      await writeRun(root, { runnerResults: results, generateIndexes: true });
      const scenarios = await readIndex(
        root,
        "scenario-history-loom-routing.json",
      );

      expect(scenarios.scenarios[0].lastRuns[0]).toMatchObject({
        status: "partial",
        passed: false,
        totalModels: 2,
        passedModels: 1,
        failedModels: 1,
        skippedModels: 0,
      });
    });
  });
});

describe("every model skipped a case in a dry run", () => {
  it("records the case as skipped rather than as passing, so a fixture check never reads as a result", async () => {
    await withBundleRoot(async (root) => {
      await writeRun(root, {
        generateIndexes: true,
        runnerResults: [
          runnerResult({
            caseResults: [caseResult({ dryRun: true } as never)],
          }),
        ],
      });
      const scenarios = await readIndex(
        root,
        "scenario-history-loom-routing.json",
      );

      expect(scenarios.scenarios[0].lastRuns[0]).toMatchObject({
        status: "skip",
        passed: false,
        totalModels: 0,
        skippedModels: 1,
      });
    });
  });
});

describe("a case's explanation changes between runs", () => {
  it("describes the scenario with the newest explanation there is, so the dashboard shows current text", async () => {
    await withBundleRoot(async (root) => {
      const withText = (text: string) => ({
        runnerResults: [
          runnerResult({
            caseResults: [
              caseResult({
                publicExplanation: { text, source: "operator_note" },
              } as never),
            ],
          }),
        ],
      });

      await writeRun(root, { ...onDay("13"), ...withText("first verdict") });
      await writeRun(root, { ...onDay("14") });
      await writeRun(root, {
        ...onDay("15"),
        ...withText("newest verdict"),
        generateIndexes: true,
      });
      const scenarios = await readIndex(
        root,
        "scenario-history-loom-routing.json",
      );

      expect(scenarios.scenarios[0].description).toBe("newest verdict");
      expect(scenarios.scenarios[0].title).toBe("route-to-shuttle");
    });
  });
});

describe("more than ten runs have accumulated on one commit", () => {
  async function twelveRuns(root: string) {
    for (let day = 1; day <= 12; day++) {
      await writeRun(root, onDay(String(day).padStart(2, "0")));
    }
    const rebuilt = await new DashboardIndexWriter(root).rebuildFromRuns();
    expect(rebuilt.isOk()).toBe(true);
  }

  it("keeps every run in the manifest, so no published run becomes unreachable", async () => {
    await withBundleRoot(async (root) => {
      await twelveRuns(root);
      const manifest = await readIndex(root, "dashboard-manifest.json");

      expect(manifest.totalRuns).toBe(12);
      expect(manifest.runs).toHaveLength(12);
    });
  });

  it("caps the recent-runs index at ten and keeps the ten newest", async () => {
    await withBundleRoot(async (root) => {
      await twelveRuns(root);
      const lastN = await readIndex(root, "last-N-runs.json");

      expect(lastN.count).toBe(10);
      expect(lastN.runs[0].runId).toBe("abc123d-2026-01-12-001");
      expect(lastN.runs[9].runId).toBe("abc123d-2026-01-03-001");
    });
  });

  it("caps each scenario's history at ten and keeps the ten newest, still oldest first", async () => {
    await withBundleRoot(async (root) => {
      await twelveRuns(root);
      const scenarios = await readIndex(
        root,
        "scenario-history-loom-routing.json",
      );
      const runIds = scenarios.scenarios[0].lastRuns.map(
        (r: { runId: string }) => r.runId,
      );

      expect(runIds).toHaveLength(10);
      expect(runIds[0]).toBe("abc123d-2026-01-03-001");
      expect(runIds[9]).toBe("abc123d-2026-01-12-001");
    });
  });
});

describe("a run covers two suite families", () => {
  it("writes one history and one scenario index per suite, so each family charts on its own", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, {
        generateIndexes: true,
        runnerResults: [
          runnerResult(),
          runnerResult({
            suite: "warp-security",
            caseResults: [
              caseResult({ suite: "warp-security", caseId: "audit-secrets" }),
            ],
          }),
        ],
      });

      expect([...written.indexFilesWritten].sort()).toEqual(
        [
          "dashboard-manifest.json",
          "last-N-runs.json",
          "latest.json",
          `model-comparison-${written.runId}.json`,
          "scenario-history-loom-routing.json",
          "scenario-history-warp-security.json",
          "suite-history-loom-routing.json",
          "suite-history-warp-security.json",
        ].sort(),
      );
      expect(
        (await readIndex(root, "scenario-history-warp-security.json"))
          .scenarios[0].caseId,
      ).toBe("audit-secrets");
    });
  });
});

describe("a run directory holds a report the dashboard cannot read", () => {
  /** One good run, one unparseable report and one from a future layout. */
  async function mixedRuns(root: string) {
    const good = await writeRun(root, onDay("15"));
    const report = await Bun.file(
      join(good.bundleDir, "public-report.json"),
    ).json();

    await Bun.write(
      join(root, RUNS_SUBDIR, "corrupt-2026-01-16-001", "public-report.json"),
      "{ this is not json",
    );
    await Bun.write(
      join(root, RUNS_SUBDIR, "future-2026-01-17-001", "public-report.json"),
      JSON.stringify({ ...report, schemaVersion: 99 }),
    );

    const rebuilt = await new DashboardIndexWriter(root).rebuildFromRuns();
    expect(rebuilt.isOk()).toBe(true);
    return good;
  }

  it("indexes the runs it can read and leaves out the ones it cannot, rather than failing the rebuild", async () => {
    await withBundleRoot(async (root) => {
      const good = await mixedRuns(root);
      const manifest = await readIndex(root, "dashboard-manifest.json");

      expect(manifest.runs.map((r: { runId: string }) => r.runId)).toEqual([
        good.runId,
      ]);
      expect(manifest.totalRuns).toBe(1);
    });
  });

  it("keeps a run written under a layout it does not know out of the dashboard entirely", async () => {
    await withBundleRoot(async (root) => {
      await mixedRuns(root);
      const latest = await readIndex(root, "latest.json");

      expect(latest.runId).not.toBe("future-2026-01-17-001");
      expect(latest.runId).not.toBe("corrupt-2026-01-16-001");
    });
  });
});

describe("no run has been written yet", () => {
  it("writes no index files at all, so the dashboard is not sent to an empty manifest", async () => {
    await withBundleRoot(async (root) => {
      const rebuilt = await new DashboardIndexWriter(root).rebuildFromRuns();

      expect(rebuilt._unsafeUnwrap().filesWritten).toEqual([]);
    });
  });
});

describe("a maintainer rebuilds the indexes twice from the same runs", () => {
  it("produces the same manifest both times apart from its timestamp", async () => {
    await withBundleRoot(async (root) => {
      await writeRun(root, onDay("13"));
      await writeRun(root, onDay("14"));

      const stamped = (at: string) => new DashboardIndexWriter(root, at);
      await stamped("2026-02-01T00:00:00.000Z").rebuildFromRuns();
      const first = await Bun.file(
        join(root, "dashboard-manifest.json"),
      ).text();
      await stamped("2026-02-01T00:00:00.000Z").rebuildFromRuns();
      const second = await Bun.file(
        join(root, "dashboard-manifest.json"),
      ).text();

      expect(second).toBe(first);
    });
  });
});

// ===========================================================================
// Publishing to the results repository
// ===========================================================================

describe("a maintainer publishes a finished run to the results repository", () => {
  it("uploads only the three artifacts a reader is meant to fetch, and none of the local ones", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      const { written } = await writeThenPublish(root, calls, fetchImpl);
      const runId = written.runId;

      expect(uploaded(calls).filter((p) => p.startsWith("runs/"))).toEqual([
        `runs/v1/${runId}/public-report.json`,
        `runs/v1/${runId}/public-report.md`,
        `runs/v1/${runId}/bundle-index.json`,
      ]);
    });
  });

  it("uploads every dashboard index under indexes/v1/, where the website looks for them", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      const { written } = await writeThenPublish(root, calls, fetchImpl);

      expect(
        uploaded(calls)
          .filter((p) => p.startsWith("indexes/"))
          .sort(),
      ).toEqual(
        [
          "indexes/v1/dashboard-manifest.json",
          "indexes/v1/last-N-runs.json",
          "indexes/v1/latest.json",
          `indexes/v1/model-comparison-${written.runId}.json`,
          "indexes/v1/scenario-history-loom-routing.json",
          "indexes/v1/suite-history-loom-routing.json",
        ].sort(),
      );
    });
  });

  it("uploads every run artifact before any index, so no index ever points at a run that is not there", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      await writeThenPublish(root, calls, fetchImpl);
      const puts = uploaded(calls);
      const lastRun = puts.reduce(
        (found, path, at) => (path.startsWith("runs/") ? at : found),
        -1,
      );
      const firstIndex = puts.findIndex((p) => p.startsWith("indexes/"));

      expect(lastRun).toBeGreaterThanOrEqual(0);
      expect(firstIndex).toBeGreaterThan(lastRun);
    });
  });

  it("carries the token in the Authorization header and nowhere a log or a proxy would see it", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      await writeThenPublish(root, calls, fetchImpl);

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(`${call.path}: ${call.authorization}`).toBe(
          `${call.path}: Bearer ${TOKEN}`,
        );
        expect(call.url).not.toContain(TOKEN);
        expect(JSON.stringify(call.body ?? {})).not.toContain(TOKEN);
      }
    });
  });

  it("reports the commit it landed on and how many files it sent", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      const { result } = await writeThenPublish(root, calls, fetchImpl);

      expect(result._unsafeUnwrap()).toEqual({
        commitSha: "commit-sha-1",
        branch: "main",
        filesPublished: 9,
        simulated: false,
      });
    });
  });
});

describe("a run artifact with this name already exists in the results repository", () => {
  it("issues no PUT for it, so a published score can never be rewritten", async () => {
    await withBundleRoot(async (root) => {
      const runId = "abc123d-2026-01-15-001";
      const { calls, fetchImpl } = recordingFetch([
        `runs/v1/${runId}/public-report.json`,
      ]);
      await writeThenPublish(root, calls, fetchImpl);

      expect(uploaded(calls)).toEqual([]);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET runs/v1/${runId}/public-report.json`,
      ]);
    });
  });

  it("fails the publish and says the run ID was already used, rather than reporting a silent success", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch([
        "runs/v1/abc123d-2026-01-15-001/public-report.json",
      ]);
      const { result } = await writeThenPublish(root, calls, fetchImpl);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("PublishFailed");
      expect(result._unsafeUnwrapErr().message).toContain("already published");
    });
  });

  it("never sends a blob SHA with a run artifact, so a create can never become an overwrite", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      await writeThenPublish(root, calls, fetchImpl);

      for (const call of calls) {
        if (call.method !== "PUT" || !call.path.startsWith("runs/")) continue;
        expect(`${call.path} sends sha: ${"sha" in (call.body ?? {})}`).toBe(
          `${call.path} sends sha: false`,
        );
      }
    });
  });
});

describe("the dashboard indexes already exist in the results repository", () => {
  it("replaces them in place, quoting the SHA the remote reported, because an index is meant to move", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch(["indexes/v1/latest.json"]);
      const { result } = await writeThenPublish(root, calls, fetchImpl);
      const latestPut = calls.find(
        (c) => c.method === "PUT" && c.path === "indexes/v1/latest.json",
      );

      expect(result.isOk()).toBe(true);
      expect(latestPut?.body?.sha).toBe("remote-blob-sha");
      // An index the remote does not have yet is still created, without one.
      const manifestPut = calls.find(
        (c) =>
          c.method === "PUT" && c.path === "indexes/v1/dashboard-manifest.json",
      );
      expect("sha" in (manifestPut?.body ?? {})).toBe(false);
    });
  });
});

describe("an index file cannot be uploaded", () => {
  it("still reports the publish as done, because the run artifacts are already committed", async () => {
    await withBundleRoot(async (root) => {
      const calls: Call[] = [];
      const fetchImpl = async (request: Request): Promise<Response> => {
        calls.push({
          method: request.method,
          path: request.url.replace(API_PREFIX, ""),
          url: request.url,
          authorization: null,
          body: null,
        });
        if (request.method === "GET")
          return new Response("Not Found", { status: 404 });
        if (request.url.includes("indexes/v1/"))
          return new Response("Server Error", { status: 500 });
        return new Response(
          JSON.stringify({ commit: { sha: "commit-sha-1" } }),
          {
            status: 201,
          },
        );
      };
      const { result } = await writeThenPublish(root, calls, fetchImpl);

      expect(result._unsafeUnwrap()).toMatchObject({
        filesPublished: 3,
        simulated: false,
      });
      // It kept trying the rest rather than stopping at the first failure.
      expect(
        uploaded(calls).filter((p) => p.startsWith("indexes/")),
      ).toHaveLength(6);
    });
  });
});

// ---------------------------------------------------------------------------
// What may and may not be uploaded
// ---------------------------------------------------------------------------

/** Run-directory names that must never reach the results repository. */
const NON_PUBLIC_RUN_FILES = [
  "score-loom-routing.json",
  "run-summary.json",
  "prompt-hashes.json",
  "provenance-manifest.json",
  "raw/route-to-shuttle.json",
  "raw\\route-to-shuttle.json",
  "../../etc/passwd",
  "anything-else.json",
] as const;

describe("something asks the publisher to upload a file the run never declared public", () => {
  it.each(
    NON_PUBLIC_RUN_FILES.map((f) => [f] as const),
  )("uploads no %s, however explicitly it was named", async (fileName) => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      await writeThenPublish(root, calls, fetchImpl, {
        fileNames: [fileName, "public-report.json"],
        indexFileNames: undefined,
        localBundleRoot: undefined,
      });

      // The positive twin: the allowlisted file beside it did go up, so this
      // is a filter doing its job rather than a publish that never ran.
      expect(uploaded(calls)).toEqual([
        "runs/v1/abc123d-2026-01-15-001/public-report.json",
      ]);
    });
  });

  it("refuses the publish outright when nothing publishable is left, rather than reporting zero files sent", async () => {
    await withBundleRoot(async (root) => {
      const { calls, fetchImpl } = recordingFetch();
      const { result } = await writeThenPublish(root, calls, fetchImpl, {
        fileNames: ["score-loom-routing.json", "run-summary.json"],
        indexFileNames: undefined,
        localBundleRoot: undefined,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("PublishFailed");
      expect(calls).toEqual([]);
    });
  });
});

/** Index names the website's fetch chain is pointed at by the manifest. */
const ALLOWED_INDEX_NAMES = [
  "dashboard-manifest.json",
  "latest.json",
  "last-N-runs.json",
  "suite-history-loom-routing.json",
  "suite-history-tapestry.execution.json",
  "scenario-history-loom-routing.json",
  "model-comparison-abc1234-2026-06-11-001.json",
  "model-comparison-unknown-2026-01-15-001.json",
] as const;

/** Names that look close enough to an index file to be worth refusing. */
const REJECTED_INDEX_NAMES = [
  "suite-history-.json",
  "scenario-history-.json",
  "model-comparison-.json",
  "suite-history--leading-dash.json",
  "run-summary.json",
  "score-loom-routing.json",
  "arbitrary-file.json",
  "nested/suite-history-loom-routing.json",
  "nested\\suite-history-loom-routing.json",
  "../../etc/passwd",
  "suite-history-../../escape.json",
] as const;

/**
 * Publishes `fileName` as an index alongside `latest.json` and returns the
 * index paths a PUT went to.
 *
 * The file reader is stubbed: these names are not files the run wrote, and a
 * failed local read would keep a name off the remote for the wrong reason.
 * `latest.json` rides along as the positive twin — its presence proves index
 * upload happened at all, so a missing name is one the allowlist filtered.
 */
async function indexUploadsFor(
  root: string,
  fileName: string,
): Promise<string[]> {
  const { calls, fetchImpl } = recordingFetch();
  await writeThenPublish(
    root,
    calls,
    fetchImpl,
    { indexFileNames: [fileName, "latest.json"] },
    async () => "{}",
  );
  const indexPuts = uploaded(calls).filter((p) => p.startsWith("indexes/"));
  expect(indexPuts).toContain("indexes/v1/latest.json");
  return indexPuts;
}

describe("a publish is pointed at an index file the dashboard fetches", () => {
  it.each(
    ALLOWED_INDEX_NAMES.map((n) => [n] as const),
  )("uploads %s under indexes/v1/, so the fetch chain finds it", async (fileName) => {
    await withBundleRoot(async (root) => {
      expect(await indexUploadsFor(root, fileName)).toContain(
        `indexes/v1/${fileName}`,
      );
    });
  });
});

describe("a publish is pointed at an index file name the allowlist does not cover", () => {
  it.each(
    REJECTED_INDEX_NAMES.map((n) => [n] as const),
  )("uploads no %s, so nothing but a known index lands under indexes/v1/", async (fileName) => {
    await withBundleRoot(async (root) => {
      expect(await indexUploadsFor(root, fileName)).not.toContain(
        `indexes/v1/${fileName}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// What the publisher is handed — issue #201
// ---------------------------------------------------------------------------

describe("a run is published through a results-repo publisher", () => {
  /**
   * Recorded as observed, not as endorsed — this is issue #201.
   *
   * `writeBundle()` hands the publisher every path in `filesWritten`, which
   * includes `score-<suite>.json`. That file carries explanation text
   * `BoundedExplanationSchema` keeps out of `public-report.json`, and the
   * run's own `publicFiles` list does not include it. Only the *GitHub*
   * publisher's `RUN_ARTIFACT_ALLOWLIST` stops it going up, so a different
   * `ResultsRepoPublisher` would publish it.
   */
  it("hands it every file the run wrote, the local score file included", async () => {
    await withBundleRoot(async (root) => {
      const publisher = new RecordingPublisher();
      await writeRun(root, {
        mode: "publish",
        publisher,
        env: TOKEN_ENV,
        writeMarkdown: true,
        generateIndexes: true,
      });

      expect(publisher.requests[0]?.fileNames).toEqual([
        "run-summary.json",
        "score-loom-routing.json",
        "prompt-hashes.json",
        "provenance-manifest.json",
        "public-report.json",
        "public-report.md",
        "bundle-index.json",
      ]);
    });
  });

  it("declares a narrower set as public in the run's own index, which the names above do not honour", async () => {
    await withBundleRoot(async (root) => {
      const publisher = new RecordingPublisher();
      const written = await writeRun(root, {
        mode: "publish",
        publisher,
        env: TOKEN_ENV,
        writeMarkdown: true,
        generateIndexes: true,
      });
      const index = await Bun.file(
        join(written.bundleDir, "bundle-index.json"),
      ).json();

      expect([...index.publicFiles].sort()).toEqual([
        "bundle-index.json",
        "public-report.json",
        "public-report.md",
      ]);
      expect(index.publicFiles).not.toContain("score-loom-routing.json");
    });
  });
});

// ---------------------------------------------------------------------------
// When a publish must not happen at all
// ---------------------------------------------------------------------------

describe("a publish is attempted without a results-repo token", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ] as const)("refuses when the variable is %s, and reaches the network not at all", async (_label, value) => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, { writeMarkdown: true });
      const { calls, fetchImpl } = recordingFetch();
      const result = await new GitHubContentsPublisher(fetchImpl).publish({
        bundle: written.bundle,
        localBundleDir: written.bundleDir,
        fileNames: ["public-report.json"],
        env:
          value === undefined
            ? {}
            : { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: value },
      });

      expect(result._unsafeUnwrapErr().type).toBe("TokenMissing");
      expect(calls).toEqual([]);
    });
  });

  it("names the variable to set without echoing whatever was in it", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, { writeMarkdown: true });
      const { fetchImpl } = recordingFetch();
      const result = await new GitHubContentsPublisher(fetchImpl).publish({
        bundle: written.bundle,
        localBundleDir: written.bundleDir,
        fileNames: ["public-report.json"],
        env: { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "   " },
      });
      const message = result._unsafeUnwrapErr().message;

      expect(message).toContain(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
      expect(message).not.toContain("   ");
    });
  });
});

describe("a dry-run bundle is handed to the publisher anyway", () => {
  it("refuses it and reaches the network not at all, because a dry run scored nothing", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, {
        dryRun: true,
        writeMarkdown: true,
      });
      const { calls, fetchImpl } = recordingFetch();
      const result = await new GitHubContentsPublisher(fetchImpl).publish({
        bundle: written.bundle,
        localBundleDir: written.bundleDir,
        fileNames: ["public-report.json"],
        env: TOKEN_ENV,
      });

      expect(result._unsafeUnwrapErr().type).toBe("DryRunPublishBlocked");
      expect(calls).toEqual([]);
    });
  });

  it("refuses a bundle carrying no scores at all, rather than publishing an empty run", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, { writeMarkdown: true });
      const { calls, fetchImpl } = recordingFetch();
      const result = await new GitHubContentsPublisher(fetchImpl).publish({
        bundle: { ...written.bundle, scoreFiles: [] },
        localBundleDir: written.bundleDir,
        fileNames: ["public-report.json"],
        env: TOKEN_ENV,
      });

      expect(result._unsafeUnwrapErr().type).toBe("NoScoreFilesToPublish");
      expect(calls).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Reading what the remote already has
// ---------------------------------------------------------------------------

/** The dashboard manifest as the GitHub Contents API returns it: base64. */
function manifestResponse(manifest: unknown): Response {
  const content = Buffer.from(JSON.stringify(manifest)).toString("base64");
  return new Response(JSON.stringify({ content }), { status: 200 });
}

describe("a rerun asks the results repository which runs it already holds", () => {
  it("reports the runs sharing this commit and day, and ignores every other prefix", async () => {
    const calls: string[] = [];
    const publisher = new GitHubContentsPublisher(async (request) => {
      calls.push(
        `${request.method} ${request.url} auth=${request.headers.get("Authorization")}`,
      );
      return manifestResponse({
        runs: [
          { runId: "abc123d-2026-01-15-001" },
          { runId: "abc123d-2026-01-15-002" },
          { runId: "abc123d-2026-01-14-001" },
          { runId: "ffffff0-2026-01-15-001" },
          { notARun: true },
        ],
      });
    });

    const ids = await publisher.readRemoteRunIds("abc123d-2026-01-15", TOKEN);

    expect(ids._unsafeUnwrap()).toEqual([
      "abc123d-2026-01-15-001",
      "abc123d-2026-01-15-002",
    ]);
    expect(calls).toEqual([
      `GET ${API_PREFIX}indexes/v1/dashboard-manifest.json auth=Bearer ${TOKEN}`,
    ]);
  });

  const UNUSABLE: ReadonlyArray<
    readonly [name: string, respond: () => Promise<Response>]
  > = [
    [
      "the manifest has never been published",
      async () => new Response("Not Found", { status: 404 }),
    ],
    [
      "the request fails outright",
      async () => {
        throw new Error("network is down");
      },
    ],
    [
      "the response is not the shape the API promises",
      async () => new Response("<html>gateway</html>", { status: 200 }),
    ],
    [
      "the manifest body is not JSON",
      async () =>
        new Response(
          JSON.stringify({
            content: Buffer.from("{ not json").toString("base64"),
          }),
          { status: 200 },
        ),
    ],
    [
      "the manifest lists no runs",
      async () => manifestResponse({ updatedAt: "2026-01-15T12:00:00.000Z" }),
    ],
  ];

  it.each(
    UNUSABLE,
  )("falls back to local numbering when %s, rather than failing the run", async (_name, respond) => {
    const publisher = new GitHubContentsPublisher(() => respond());

    const ids = await publisher.readRemoteRunIds("abc123d-2026-01-15", TOKEN);

    expect(ids.isOk()).toBe(true);
    expect(ids._unsafeUnwrap()).toEqual([]);
  });
});

describe("a reader looks at a run in which one model's answer was empty (Spec 37, 16.5)", () => {
  /**
   * Two cases on two models: every answer scored and passed, except that
   * `route-to-shuttle` on the second model came back empty and errored.
   */
  const WITH_ERRORED = {
    runnerResults: [
      runnerResult({
        caseResults: [
          caseResult({ caseId: "route-to-shuttle", modelId: "alpha/model" }),
          caseResult({ caseId: "route-to-warp", modelId: "alpha/model" }),
          caseResult({
            caseId: "route-to-shuttle",
            modelId: "zeta/model",
            passed: false,
            weightedTotal: 0,
            errored: true,
            errorClassification: "model-empty-response",
          }),
          caseResult({ caseId: "route-to-warp", modelId: "zeta/model" }),
        ],
      }),
    ],
    generateIndexes: true,
    writeMarkdown: true,
  };

  it("charts the suite's pass rate over the cases that were scored", async () => {
    await withBundleRoot(async (root) => {
      await writeRun(root, WITH_ERRORED);
      const history = await readIndex(root, "suite-history-loom-routing.json");

      expect(history.history[0]).toMatchObject({
        totalCases: 4,
        passedCases: 3,
        erroredCases: 1,
        passRate: 1,
        suiteGreen: false,
      });
    });
  });

  it("does not count the errored model as a failure in the case's history", async () => {
    await withBundleRoot(async (root) => {
      await writeRun(root, WITH_ERRORED);
      const scenarios = await readIndex(
        root,
        "scenario-history-loom-routing.json",
      );
      const shuttle = scenarios.scenarios.find(
        (s: { caseId: string }) => s.caseId === "route-to-shuttle",
      );

      expect(shuttle.lastRuns[0]).toMatchObject({
        status: "pass",
        passedModels: 1,
        failedModels: 0,
        skippedModels: 1,
        erroredModels: 1,
      });
    });
  });

  it("gives the model a pass rate over its scored cases, and names the errored one", async () => {
    await withBundleRoot(async (root) => {
      const written = await writeRun(root, WITH_ERRORED);
      const comparison = await readIndex(
        root,
        `model-comparison-${written.runId}.json`,
      );
      const zeta = comparison.models.find(
        (m: { modelId: string }) => m.modelId === "zeta/model",
      );

      expect(zeta).toMatchObject({
        totalCases: 2,
        passedCases: 1,
        failedCases: 0,
        erroredCases: 1,
        passRate: 1,
      });
    });
  });

  it("shows the errored count on the latest-run snapshot and the run list", async () => {
    await withBundleRoot(async (root) => {
      await writeRun(root, WITH_ERRORED);
      const latest = await readIndex(root, "latest.json");
      const lastN = await readIndex(root, "last-N-runs.json");

      expect(latest).toMatchObject({ failedCases: 0, erroredCases: 1 });
      expect(lastN.runs[0]).toMatchObject({ failedCases: 0, erroredCases: 1 });
    });
  });

  it("marks the case as errored in the Markdown report, not as a no", async () => {
    await withBundleRoot(async (root) => {
      const markdown = await markdownOf(root, WITH_ERRORED);

      expect(markdown).toContain("errored (model-empty-response)");
      expect(markdown).toContain("**Failed**: 0 | **Errored**: 1");
    });
  });
});
