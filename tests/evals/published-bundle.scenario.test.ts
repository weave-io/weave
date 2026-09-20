/**
 * Evals scenarios — what gets published.
 *
 * Bucket: Evals. The black box is the bundle written to disk: eval results go
 * in, and the files a reader — or tryweave.io — would find come out. These
 * assert what those files contain, never how the sanitizer or the assembler
 * arrived at it.
 *
 * The leak scenarios are the reason this bucket exists. `docs/eval-xss-policy.md`
 * and `docs/eval-sanitization-and-publish-pipeline.md` are normative; these
 * tests are the executable form of the promise those documents make.
 */

import { describe, expect, it } from "bun:test";
import { ArtifactBundleWriter } from "../../packages/cli/src/evals/artifact-bundle.js";
import {
  allPublishedText,
  caseResult,
  expectNothingPublishedContains,
  FIXED_GIT_SHA,
  FIXED_TIMESTAMP,
  filesUnder,
  LEAK_MARKERS,
  provenanceManifest,
  runnerResult,
  withBundleRoot,
} from "../support/evals.js";

/** Writes one bundle into `root` and returns the write result. */
async function publish(
  root: string,
  results = [runnerResult()],
  overrides: Record<string, unknown> = {},
) {
  const writer = new ArtifactBundleWriter(root);
  const result = await writer.writeBundle({
    runnerResults: results,
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

describe("a maintainer publishes an eval run", () => {
  it("writes a run directory with the artifacts a reader needs", async () => {
    await withBundleRoot(async (root) => {
      const written = await publish(root);
      const files = await filesUnder(root);

      expect(written.runId).toBeTruthy();
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((p) => p.endsWith("public-report.json"))).toBe(true);
    });
  });

  it("records the commit the run was made from, so a score can be traced back", async () => {
    await withBundleRoot(async (root) => {
      await publish(root);

      expect(await allPublishedText(root)).toContain(FIXED_GIT_SHA);
    });
  });
});

// ---------------------------------------------------------------------------
// The promise the whole sanitization pipeline exists to keep.
// ---------------------------------------------------------------------------

describe("a run carries prompts and transcripts the publisher must not leak", () => {
  /**
   * A case result carrying every sensitive field **on the summary**, which is
   * the object assembly actually reads.
   *
   * An earlier version of this put the markers in `rawArtifact`. That made
   * every assertion below vacuous: assembly never reads that field, so nothing
   * needed stripping and a broken sanitizer went undetected. The markers have
   * to sit on the path publication really takes.
   */
  function leakyResults() {
    const leaky = caseResult({
      composedPrompt: LEAK_MARKERS.composedPrompt,
      rawContent: LEAK_MARKERS.rawContent,
      rawPrompt: LEAK_MARKERS.rawPrompt,
      transcript: [{ role: "user", content: LEAK_MARKERS.transcript }],
    } as never);
    return [runnerResult({ caseResults: [leaky] })];
  }

  it.each(
    Object.entries(LEAK_MARKERS),
  )("publishes no file containing the %s", async (_field, marker) => {
    await withBundleRoot(async (root) => {
      await publish(root, leakyResults());
      await expectNothingPublishedContains(root, marker);
    });
  });

  it("names no sensitive field in any published file", async () => {
    await withBundleRoot(async (root) => {
      await publish(root, leakyResults());
      const text = await allPublishedText(root);

      for (const field of Object.keys(LEAK_MARKERS)) {
        expect(text).not.toContain(`"${field}"`);
      }
    });
  });

  it("still publishes the score the run produced", async () => {
    await withBundleRoot(async (root) => {
      await publish(root, leakyResults());
      const text = await allPublishedText(root);

      // Stripping the prompt must not strip the result with it.
      expect(text).toContain("route-to-shuttle");
    });
  });
});

// ---------------------------------------------------------------------------

describe("a maintainer publishes twice from the same commit", () => {
  it("never overwrites the first run", async () => {
    await withBundleRoot(async (root) => {
      const first = await publish(root);
      const second = await publish(root);

      expect(second.runId).not.toBe(first.runId);
    });
  });

  it("keeps both runs on disk", async () => {
    await withBundleRoot(async (root) => {
      const first = await publish(root);
      const second = await publish(root);
      const files = await filesUnder(root);

      expect(files.some((p) => p.includes(first.runId))).toBe(true);
      expect(files.some((p) => p.includes(second.runId))).toBe(true);
    });
  });
});

describe("a maintainer publishes the same run twice over", () => {
  it("produces byte-identical reports for identical input", async () => {
    const read = async (root: string) => {
      const path = (await filesUnder(root)).find((p) =>
        p.endsWith("public-report.json"),
      );
      expect(path).toBeDefined();
      return Bun.file(path as string).text();
    };

    const a = await withBundleRoot(async (root) => {
      await publish(root);
      return read(root);
    });
    const b = await withBundleRoot(async (root) => {
      await publish(root);
      return read(root);
    });

    expect(a).toBe(b);
  });
});

describe("a maintainer runs a suite that failed", () => {
  it("publishes the failure rather than hiding it", async () => {
    await withBundleRoot(async (root) => {
      const failed = runnerResult({
        caseResults: [caseResult({ passed: false, caseId: "route-missed" })],
      });
      await publish(root, [failed]);

      expect(await allPublishedText(root)).toContain("route-missed");
    });
  });
});
