/**
 * Evals scenarios — what a hostile or careless result can push into a bundle.
 *
 * Bucket: Evals. The black box is the run directory `ArtifactBundleWriter`
 * writes. Results go in — including results shaped in ways no runner is
 * supposed to produce — and the files a reader, or tryweave.io, would find
 * come out.
 *
 * [`published-bundle.scenario.test.ts`](./published-bundle.scenario.test.ts)
 * covers the happy path: a run is written, traceable, immutable and
 * reproducible. This file covers the adversarial one, and is the executable
 * form of the promises in [`docs/eval-xss-policy.md`](../../docs/eval-xss-policy.md)
 * and [`docs/eval-sanitization-and-publish-pipeline.md`](../../docs/eval-sanitization-and-publish-pipeline.md).
 * Neither document may be weakened by what is asserted here.
 *
 * Two distinctions the assertions depend on:
 *
 * - **No file at all** may carry a value from a field the publish guard calls
 *   sensitive. That is an absolute: the run directory is local, but a leak
 *   into it is still a leak.
 * - **No *public* artifact** may carry an injection payload. Only
 *   `bundle-index.json`, `public-report.json`, `public-report.md` and the
 *   dashboard indexes are ever uploaded; `score-<suite>.json` stays local and
 *   does carry the explanation text a reader never sees.
 *
 * Every absence assertion here has been watched go red against a neutered
 * `sanitizeCaseResultSummary`, a neutered explanation validation step and a
 * neutered Markdown value sanitizer. An absence that was never observed
 * failing proves nothing.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ArtifactBundleWriter } from "../../packages/cli/src/evals/artifact-bundle.js";
import { EXPLANATION_MAX_CHARS } from "../../packages/cli/src/evals/report-schema.js";
import { SENSITIVE_FIELD_NAMES } from "../../packages/cli/src/evals/sanitizer.js";
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
// Publishing one run
// ---------------------------------------------------------------------------

/** A summary carrying whatever a scenario wants to push at the publisher. */
type HostileSummary = Record<string, unknown>;

/**
 * Publishes one run containing a single case with `summary` merged in, with
 * every optional artifact turned on — the Markdown report and the dashboard
 * indexes are published too, so they are part of the black box.
 */
async function publishCase(root: string, summary: HostileSummary) {
  const writer = new ArtifactBundleWriter(root);
  const result = await writer.writeBundle({
    runnerResults: [
      runnerResult({ caseResults: [caseResult(summary as never)] }),
    ],
    provenanceManifest: provenanceManifest(),
    gitSha: FIXED_GIT_SHA,
    assembledAt: FIXED_TIMESTAMP,
    writeMarkdown: true,
    generateIndexes: true,
  });

  if (result.isErr()) {
    expect(JSON.stringify(result.error)).toBe("bundle written");
  }
  return result._unsafeUnwrap();
}

/** The names a run directory may ever upload, per `RUN_ARTIFACT_ALLOWLIST`. */
const UPLOADED_RUN_FILES = new Set([
  "bundle-index.json",
  "public-report.json",
  "public-report.md",
]);

/** Every file that can reach a reader: the uploaded run files and the indexes. */
async function publicArtifacts(root: string): Promise<string[]> {
  const all = await filesUnder(root);
  return all.filter((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const isIndex = !path.includes(`${join(root, "runs")}/`);
    return isIndex || UPLOADED_RUN_FILES.has(name);
  });
}

/** The concatenated text of every artifact a reader could receive. */
async function publicText(root: string): Promise<string> {
  const paths = await publicArtifacts(root);
  const parts = await Promise.all(paths.map((p) => Bun.file(p).text()));
  return parts.join("\n");
}

/** Names the offending file rather than failing on a bare boolean. */
async function expectAbsentEverywhere(
  root: string,
  needle: string,
): Promise<void> {
  for (const path of await filesUnder(root)) {
    const text = await Bun.file(path).text();
    if (text.includes(needle)) {
      expect(`${path} contains ${needle}`).toBe("nothing contains it");
    }
  }
}

/** The single case entry in the published report, or `undefined`. */
async function publishedCase(
  root: string,
): Promise<Record<string, unknown> | undefined> {
  const path = (await filesUnder(root)).find((p) =>
    p.endsWith("public-report.json"),
  );
  if (path === undefined) return undefined;
  const report = JSON.parse(await Bun.file(path).text());
  return report.suiteSummaries?.[0]?.cases?.[0];
}

/**
 * The published case's id, asserted to carry no explanation.
 *
 * Returning the id rather than a boolean is deliberate: when assembly drops
 * the whole report, `publishedCase` is `undefined` and a bare
 * `expect(entry?.explanation).toBeUndefined()` passes while nothing was
 * published at all. The caller compares the id, so the case must be there.
 */
async function caseWithoutExplanation(root: string): Promise<unknown> {
  const entry = await publishedCase(root);
  expect(entry?.explanation).toBeUndefined();
  return entry?.caseId;
}

/** The rendered Markdown report. */
async function publishedMarkdown(root: string): Promise<string> {
  const path = (await filesUnder(root)).find((p) =>
    p.endsWith("public-report.md"),
  );
  expect(path).toBeDefined();
  return Bun.file(path as string).text();
}

// ---------------------------------------------------------------------------
// Sensitive fields
// ---------------------------------------------------------------------------

/**
 * Every field name the publish guard blocks, listed here rather than read from
 * the source. Reading `SENSITIVE_FIELD_NAMES` would make the table shrink
 * silently when a name is removed; the drift check below compares the two.
 */
const SENSITIVE_FIELDS = [
  "composedPrompt",
  "rawContent",
  "rawPrompt",
  "prompt",
  "rawArtifact",
  "rawArtifacts",
  "toolArgs",
  "arguments",
  "tool_arguments",
  "args",
  "env",
  "environment",
  "envValue",
  "cause",
  "body",
  "rawBody",
  "errorBody",
  "logTail",
  "logs",
  "logLines",
  "rationale",
  "dimensionRationales",
  "transcript",
  "localDiagnostic",
] as const;

/** One unmistakable value per sensitive field, all on one case summary. */
function everySensitiveField(): HostileSummary {
  const summary: HostileSummary = {};
  for (const field of SENSITIVE_FIELDS) summary[field] = `LEAK-${field}`;
  return summary;
}

describe("a run's results carry every field the publish guard calls sensitive", () => {
  it.each(
    SENSITIVE_FIELDS.map((f) => [f] as const),
  )("writes no file carrying what was in %s", async (field) => {
    await withBundleRoot(async (root) => {
      await publishCase(root, everySensitiveField());
      await expectAbsentEverywhere(root, `LEAK-${field}`);
    });
  });

  it("names none of those fields in any written file, so a grep for them stays clean", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, everySensitiveField());

      for (const path of await filesUnder(root)) {
        const text = await Bun.file(path).text();
        for (const field of SENSITIVE_FIELDS) {
          if (text.includes(`"${field}"`)) {
            expect(`${path} names ${field}`).toBe("no file names it");
          }
        }
      }
    });
  });

  it("publishes the score the run produced, so stripping the prompt does not strip the result", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, everySensitiveField());
      const entry = await publishedCase(root);

      expect(entry?.caseId).toBe("route-to-shuttle");
      expect(entry?.passed).toBe(true);
    });
  });

  it("has a case above for every field the guard blocks, so a new one cannot be added untested", () => {
    expect([...SENSITIVE_FIELD_NAMES].sort()).toEqual(
      [...SENSITIVE_FIELDS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Shapes no runner is supposed to produce
// ---------------------------------------------------------------------------

/**
 * Results shaped in ways the allowlist has never been told about. The promise
 * is that the projection is positive — it copies named fields — so anything
 * not named is dropped whatever shape it arrives in.
 */
const HOSTILE_SHAPES: ReadonlyArray<
  readonly [name: string, summary: HostileSummary, needles: readonly string[]]
> = [
  [
    "an unknown scalar field",
    { verdictNote: "SHAPE-scalar" },
    ["SHAPE-scalar", "verdictNote"],
  ],
  [
    "a sensitive field buried in a nested object",
    { debug: { inner: { composedPrompt: "SHAPE-nested" } } },
    ["SHAPE-nested", '"debug"'],
  ],
  [
    "an array of objects each carrying a transcript",
    {
      turnLog: [{ transcript: "SHAPE-array" }, { transcript: "SHAPE-array2" }],
    },
    ["SHAPE-array", "SHAPE-array2", '"turnLog"'],
  ],
  [
    "an array of bare strings",
    { notes: ["SHAPE-bare-a", "SHAPE-bare-b"] },
    ["SHAPE-bare-a", "SHAPE-bare-b", '"notes"'],
  ],
  [
    "a field named after a prototype slot",
    { constructorNote: "SHAPE-proto", toStringNote: "SHAPE-proto2" },
    ["SHAPE-proto", "SHAPE-proto2"],
  ],
  [
    "extra keys hidden inside an otherwise valid explanation",
    {
      publicExplanation: {
        text: "routing matched",
        source: "structured_signal",
        rationale: "SHAPE-explanation",
      },
    },
    ["SHAPE-explanation"],
  ],
  [
    "an extra key on the trajectory summary, whose allowlist is closed",
    {
      trajectorySummary: {
        harnessDelegatedCorrectly: true,
        observedSpawns: ["shuttle"],
        observedToolCalls: 3,
        harnessCompletedWithoutError: true,
        rawTranscriptRef: "SHAPE-trajectory",
      },
    },
    ["SHAPE-trajectory", "rawTranscriptRef"],
  ],
  [
    "a dimension score carrying the scorer's rationale alongside it",
    {
      dimensionScores: {
        routingCorrectness: {
          score: 1,
          applicable: true,
          rationale: "SHAPE-dimension",
        },
        delegationCorrectness: { score: 1, applicable: false },
        executionCompleteness: { score: 1, applicable: false },
        rationaleQuality: { score: 0.8, applicable: true },
      },
    },
    ["SHAPE-dimension"],
  ],
];

describe("a runner hands the publisher a result shaped in ways the allowlist never anticipated", () => {
  it.each(
    HOSTILE_SHAPES,
  )("writes nothing from %s", async (_name, summary, needles) => {
    await withBundleRoot(async (root) => {
      await publishCase(root, summary);
      for (const needle of needles) {
        await expectAbsentEverywhere(root, needle);
      }
    });
  });

  it.each(
    HOSTILE_SHAPES,
  )("publishes the case anyway when it carries %s, rather than failing the run", async (_name, summary) => {
    await withBundleRoot(async (root) => {
      await publishCase(root, summary);

      expect((await publishedCase(root))?.caseId).toBe("route-to-shuttle");
    });
  });

  it("keeps the four trajectory fields a reader is allowed to see", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        trajectorySummary: {
          harnessDelegatedCorrectly: true,
          observedSpawns: ["shuttle"],
          observedToolCalls: 3,
          harnessCompletedWithoutError: true,
          rawTranscriptRef: "SHAPE-trajectory",
        },
      });

      expect((await publishedCase(root))?.trajectorySummary).toEqual({
        harnessDelegatedCorrectly: true,
        observedSpawns: ["shuttle"],
        observedToolCalls: 3,
        harnessCompletedWithoutError: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Explanation text
// ---------------------------------------------------------------------------

/**
 * Text that must never reach a rendering surface: chain-of-thought traces,
 * transcript role markers, prompt delimiters, scorer-internal markers, secrets
 * and the HTML injection vectors named in `docs/eval-xss-policy.md`.
 */
const INJECTION_PAYLOADS: ReadonlyArray<readonly [name: string, text: string]> =
  [
    ["a <thinking> trace", "<thinking>it probably routed</thinking>"],
    ["a <cot> trace", "<cot>step one</cot>"],
    ["a <reasoning> trace", "<reasoning>because</reasoning>"],
    ["a <scratchpad> trace", "<scratchpad>notes</scratchpad>"],
    ["a User: transcript marker", "verdict\nUser: route this for me"],
    ["an Assistant: transcript marker", "verdict\nAssistant: delegating now"],
    ["a Human: transcript marker", "verdict\nHuman: route this"],
    ["a System: transcript marker", "verdict\nSystem: you are loom"],
    ["a Tool: transcript marker", "verdict\nTool: read(file)"],
    ["a <system> prompt delimiter", "<system>you are loom"],
    ["a <prompt> delimiter", "<prompt>route this"],
    ["an <instruction> delimiter", "<instruction>route this"],
    ["a <context> delimiter", "<context>the repo is"],
    ["a rationale: marker", "rationale: the model chose shuttle"],
    ["a score: marker", "score: 0.82 for routing"],
    ["a justification: marker", "justification: it picked the right agent"],
    ["an explanation: marker", "explanation: it picked the right agent"],
    ["an sk- API key", "leaked sk-abcdefgh12345678"],
    ["a Bearer token", "leaked Bearer abcdefghijklmnop"],
    ["a GitHub token", "leaked ghp_abcdefgh12345678"],
    ["a <script> tag", "<script>alert(1)</script>"],
    ["a <style> tag", "<style>body{display:none}</style>"],
    ["an <iframe> tag", "<iframe src=evil></iframe>"],
    ["an <object> tag", "<object data=evil></object>"],
    ["an <embed> tag", "<embed src=evil>"],
    ["a <form> tag", "<form action=evil>"],
    ["an inline event handler", "<img src=x onerror=alert(1)>"],
    ["a javascript: URI", "click javascript:alert(1)"],
    ["a data: URI", "see data:text/html,<b>hi</b>"],
    ["an attribute breakout", `" onmouseover="alert(1)`],
  ];

describe("a case's explanation carries text a reader must never be shown", () => {
  it.each(
    INJECTION_PAYLOADS,
  )("keeps %s out of every artifact a reader can receive, and still publishes the case", async (_name, text) => {
    await withBundleRoot(async (root) => {
      const marker = "PAYLOAD-MARKER";
      await publishCase(root, {
        publicExplanation: {
          text: `${marker} ${text}`,
          source: "operator_note",
        },
      });

      const published = await publicText(root);
      expect(published).not.toContain(marker);
      expect(published).not.toContain(text);

      // Dropping the whole report would also satisfy the two assertions
      // above. The promise is narrower: the explanation goes, the result
      // stays, and the run still reaches the dashboard.
      expect((await publishedCase(root))?.caseId).toBe("route-to-shuttle");
    });
  });

  it("publishes the case without its explanation rather than losing the result", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: {
          text: "<script>alert(1)</script>",
          source: "operator_note",
        },
      });
      const entry = await publishedCase(root);

      expect(entry?.caseId).toBe("route-to-shuttle");
      expect(entry?.scoreBucket).toBe("pass");
      expect(entry?.explanation).toBeUndefined();
    });
  });
});

describe("a case's explanation declares where its text came from", () => {
  const ALLOWED = [
    "rubric_template",
    "score_bucket_label",
    "structured_signal",
    "operator_note",
  ] as const;

  it.each(
    ALLOWED.map((v) => [v] as const),
  )("publishes an explanation sourced from %s", async (source) => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { text: "routing matched", source },
      });

      expect((await publishedCase(root))?.explanation).toEqual({
        text: "routing matched",
        source,
      });
    });
  });

  const REJECTED = [
    "raw_rationale",
    "dimension_rationale",
    "transcript_content",
    "llm_freeform_summary",
    "raw_content",
    "",
    "whatever-the-runner-felt-like",
  ] as const;

  it.each(
    REJECTED.map((v) => [v] as const),
  )("drops an explanation sourced from %s, however clean its text looks", async (source) => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { text: "PLAUSIBLE-TEXT", source },
      });

      expect(await caseWithoutExplanation(root)).toBe("route-to-shuttle");
      expect(await publicText(root)).not.toContain("PLAUSIBLE-TEXT");
    });
  });

  it("drops an explanation that declares no source at all", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { text: "SOURCELESS-TEXT" },
      });

      expect(await caseWithoutExplanation(root)).toBe("route-to-shuttle");
      expect(await publicText(root)).not.toContain("SOURCELESS-TEXT");
    });
  });

  it("drops an explanation that carries no text", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { source: "operator_note" },
      });

      expect(await caseWithoutExplanation(root)).toBe("route-to-shuttle");
    });
  });

  it("drops an empty explanation instead of publishing a blank cell", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { text: "", source: "operator_note" },
      });

      expect(await caseWithoutExplanation(root)).toBe("route-to-shuttle");
    });
  });
});

describe("a case's explanation runs long", () => {
  const atLimit = `LIMIT${"y".repeat(EXPLANATION_MAX_CHARS - 5)}`;
  const overLimit = `${atLimit}z`;

  it("publishes an explanation of exactly the published limit", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { text: atLimit, source: "operator_note" },
      });

      expect((await publishedCase(root))?.explanation).toEqual({
        text: atLimit,
        source: "operator_note",
      });
    });
  });

  it("drops an explanation one character over the limit, rather than truncating it", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        publicExplanation: { text: overLimit, source: "operator_note" },
      });

      expect(await caseWithoutExplanation(root)).toBe("route-to-shuttle");
      expect(await publicText(root)).not.toContain(overLimit);
    });
  });

  it("holds that limit at 300 characters, which the dashboard lays its cells out around", () => {
    expect(EXPLANATION_MAX_CHARS).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// The scores themselves
// ---------------------------------------------------------------------------

describe("a maintainer reads the scores a published run recorded", () => {
  it("publishes each case's identity, verdict and timing", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {});

      expect(await publishedCase(root)).toMatchObject({
        caseId: "route-to-shuttle",
        modelId: "anthropic/claude-sonnet-4.5",
        suite: "loom-routing",
        passed: true,
        required: true,
        dryRun: false,
        scoredAt: FIXED_TIMESTAMP,
      });
    });
  });

  it("publishes every scoring dimension with its score and whether it applied", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {});
      const scorePath = (await filesUnder(root)).find((p) =>
        p.endsWith("score-loom-routing.json"),
      );
      expect(scorePath).toBeDefined();
      const row = JSON.parse(await Bun.file(scorePath as string).text())
        .results[0];

      expect(row.weightedTotal).toBe(0.9);
      expect(row.dimensionScores).toEqual({
        routingCorrectness: { score: 1, applicable: true },
        delegationCorrectness: { score: 1, applicable: false },
        executionCompleteness: { score: 1, applicable: false },
        rationaleQuality: { score: 0.8, applicable: true },
      });
    });
  });

  const BUCKETS: ReadonlyArray<readonly [number, string]> = [
    [1, "pass"],
    [0.9, "pass"],
    [0.89, "partial"],
    [0.5, "partial"],
    [0.49, "fail"],
    [0, "fail"],
  ];

  it.each(
    BUCKETS,
  )("buckets a weighted total of %s as %s, which is what a reader skims", async (weightedTotal, bucket) => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {
        weightedTotal,
        passed: weightedTotal >= 0.9,
      });

      expect((await publishedCase(root))?.scoreBucket).toBe(bucket);
    });
  });

  it("buckets a dry run as skip whatever it scored, so a fixture check never reads as a result", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, { weightedTotal: 0.95, dryRun: true });

      expect((await publishedCase(root))?.scoreBucket).toBe("skip");
    });
  });
});

// ---------------------------------------------------------------------------
// Values that are not explanations
// ---------------------------------------------------------------------------

describe("a case id carries markup a dashboard would otherwise render", () => {
  const hostileId = "<script>alert('id')</script>";
  const pipedModel = "anthropic|claude-sonnet-4.5";

  it("leaves the markup out of the Markdown report entirely", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, { caseId: hostileId, modelId: pipedModel });
      const markdown = await publishedMarkdown(root);

      expect(markdown).not.toContain("<script");
      expect(markdown).not.toContain("alert('id')");
    });
  });

  it("escapes a pipe so a model name cannot break the Markdown table", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, { caseId: hostileId, modelId: pipedModel });

      expect(await publishedMarkdown(root)).toContain(
        "anthropic&#124;claude-sonnet-4.5",
      );
    });
  });

  it("carries the case id verbatim in the JSON, where escaping is the dashboard's job", async () => {
    // Recorded, not endorsed: `docs/eval-xss-policy.md` places case-id escaping
    // in layer 3 (`escapeHtml()` before `innerHTML`), not at the schema. Case
    // ids come from repo-owned fixtures rather than model output, so the JSON
    // is allowed to carry them raw. A consumer that renders this field without
    // escaping it is the vulnerability, and this pins the contract it must meet.
    await withBundleRoot(async (root) => {
      await publishCase(root, { caseId: hostileId, modelId: pipedModel });

      expect((await publishedCase(root))?.caseId).toBe(hostileId);
    });
  });
});

// ---------------------------------------------------------------------------
// What the website is promised
// ---------------------------------------------------------------------------

describe("the website fetches a published run", () => {
  it("stamps the public report and each suite summary with the versions it pins", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, {});
      const path = (await filesUnder(root)).find((p) =>
        p.endsWith("public-report.json"),
      );
      const report = JSON.parse(await Bun.file(path as string).text());

      expect(report.schemaVersion).toBe(1);
      expect(report.suiteSummaries[0].schemaVersion).toBe(2);
    });
  });

  it("stamps every dashboard index with a schema version, since an unversioned one is rejected", async () => {
    await withBundleRoot(async (root) => {
      const written = await publishCase(root, {});
      expect(written.indexFilesWritten.length).toBeGreaterThan(0);

      for (const name of written.indexFilesWritten) {
        const parsed = JSON.parse(await Bun.file(join(root, name)).text());
        expect(`${name}:${parsed.schemaVersion}`).toBe(`${name}:1`);
      }
    });
  });

  it("dates every index the dashboard re-fetches, so staleness can be judged", async () => {
    // `model-comparison-<runId>.json` is the exception and carries `runId`
    // instead: it is regenerated per run rather than accumulated across runs.
    await withBundleRoot(async (root) => {
      const written = await publishCase(root, {});

      for (const name of written.indexFilesWritten) {
        const parsed = JSON.parse(await Bun.file(join(root, name)).text());
        const freshness = name.startsWith("model-comparison-")
          ? parsed.runId
          : parsed.updatedAt;
        expect(`${name}:${typeof freshness}`).toBe(`${name}:string`);
      }
    });
  });

  it("publishes the indexes the dashboard's fetch chain walks", async () => {
    await withBundleRoot(async (root) => {
      const written = await publishCase(root, {});

      expect([...written.indexFilesWritten].sort()).toEqual(
        [
          "dashboard-manifest.json",
          `model-comparison-${written.runId}.json`,
          "last-N-runs.json",
          "latest.json",
          "scenario-history-loom-routing.json",
          "suite-history-loom-routing.json",
        ].sort(),
      );
    });
  });

  it("names only uploadable files in the bundle index, so no local artifact is advertised", async () => {
    await withBundleRoot(async (root) => {
      const written = await publishCase(root, {});
      const index = JSON.parse(
        await Bun.file(join(written.bundleDir, "bundle-index.json")).text(),
      );

      for (const name of index.publicFiles) {
        expect(`${name} is uploadable`).toBe(
          `${UPLOADED_RUN_FILES.has(name) ? name : "NOT-UPLOADABLE"} is uploadable`,
        );
      }
      expect(index.publicFiles).toContain("public-report.json");
    });
  });
});

describe("a run records a case with no id at all", () => {
  it("publishes no public report for the run, because the report cannot be validated", async () => {
    await withBundleRoot(async (root) => {
      await publishCase(root, { caseId: "" });
      const names = (await filesUnder(root)).map((p) =>
        p.slice(p.lastIndexOf("/") + 1),
      );

      expect(names).not.toContain("public-report.json");
      expect(names).not.toContain("public-report.md");
    });
  });

  it("reports the write as a success regardless, so the run goes missing from the dashboard without a word", async () => {
    // Recorded as observed. `writeBundle` treats public-report assembly failure
    // as non-fatal, so one malformed case id costs the whole run its dashboard
    // presence and nothing in the result says so.
    await withBundleRoot(async (root) => {
      const written = await publishCase(root, { caseId: "" });

      expect(written.runId).toBeTruthy();
      expect(written.indexFilesWritten).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("a maintainer publishes a run that traced the prompts it used", () => {
  it("publishes each agent's prompt hash and size, so a score can be tied to a prompt", async () => {
    await withBundleRoot(async (root) => {
      const written = await publishCase(root, {});
      const manifest = JSON.parse(
        await Bun.file(
          join(written.bundleDir, "provenance-manifest.json"),
        ).text(),
      );

      expect(
        manifest.records.map((r: { agentName: string }) => r.agentName),
      ).toEqual(["loom", "tapestry", "shuttle"]);
      expect(manifest.records[0]).toMatchObject({
        hash: "a".repeat(64),
        byteLength: 4096,
        charLength: 4000,
        gitSha: FIXED_GIT_SHA,
      });
    });
  });

  it("publishes the hash rather than the prompt, so provenance leaks no prompt text", async () => {
    await withBundleRoot(async (root) => {
      const writer = new ArtifactBundleWriter(root);
      const manifest = provenanceManifest();
      const result = await writer.writeBundle({
        runnerResults: [runnerResult()],
        provenanceManifest: {
          ...manifest,
          records: manifest.records.map((record) => ({
            ...record,
            composedPrompt: "PROVENANCE-LEAK",
            promptText: "PROVENANCE-LEAK-2",
          })),
        } as never,
        gitSha: FIXED_GIT_SHA,
        assembledAt: FIXED_TIMESTAMP,
        writeMarkdown: true,
      });
      expect(result.isOk()).toBe(true);

      await expectAbsentEverywhere(root, "PROVENANCE-LEAK");
      await expectAbsentEverywhere(root, "promptText");
    });
  });
});
