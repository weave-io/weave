/**
 * Shared harness for the evals scenario bucket.
 *
 * The black box here is the **published bundle**: eval results go in, and the
 * files a reader (or tryweave.io) would find on disk come out. Scenarios assert
 * what those files contain, never how the sanitizer or the assembler got there.
 *
 * Unlike the adapter bucket this writes to a real directory, because
 * `ArtifactBundleWriter` owns its own I/O. It is a per-test temporary directory
 * under the OS temp root — never the developer's config or working tree — and
 * it is removed afterwards.
 */

import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CaseResult,
  PromptProvenanceManifest,
  RunnerResult,
  ScoringDimension,
} from "../../packages/cli/src/evals/types.js";

export const FIXED_GIT_SHA = "abc123def456abc123def456abc123def456abc1";
export const FIXED_TIMESTAMP = "2026-01-15T12:00:00.000Z";

/**
 * Every field name the publish guard treats as sensitive, with a value that is
 * unmistakable if it ever reaches a published file.
 *
 * Scenarios feed these in deliberately: the promise is that a bundle assembled
 * from results carrying them still publishes nothing recognisable.
 */
export const LEAK_MARKERS = {
  composedPrompt: "LEAK-composed-prompt-should-never-publish",
  rawContent: "LEAK-raw-content-should-never-publish",
  rawPrompt: "LEAK-raw-prompt-should-never-publish",
  transcript: "LEAK-transcript-should-never-publish",
} as const;

function dimensionScores(
  passed: boolean,
): Record<ScoringDimension, { score: number; applicable: boolean }> {
  return {
    routingCorrectness: { score: passed ? 1 : 0, applicable: true },
    delegationCorrectness: { score: 1, applicable: false },
    executionCompleteness: { score: 1, applicable: false },
    rationaleQuality: { score: 0.8, applicable: true },
  };
}

/** A case result as a runner produces it. */
export function caseResult(
  overrides: Partial<CaseResult["summary"]> = {},
  extra: Partial<CaseResult> = {},
): CaseResult {
  const passed = overrides.passed ?? true;
  return {
    summary: {
      caseId: "route-to-shuttle",
      modelId: "anthropic/claude-sonnet-4.5",
      suite: "loom-routing",
      passed,
      required: true,
      weightedTotal: passed ? 0.9 : 0,
      dimensionScores: dimensionScores(passed),
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      ...overrides,
    },
    ...extra,
  };
}

/** A suite's worth of results. */
export function runnerResult(
  overrides: Partial<RunnerResult> = {},
): RunnerResult {
  const caseResults = overrides.caseResults ?? [caseResult()];
  return {
    suite: "loom-routing",
    suiteGreen: caseResults.every((c) => c.summary.passed),
    caseResults,
    totalCases: caseResults.length,
    passedCases: caseResults.filter((c) => c.summary.passed).length,
    failedCases: caseResults.filter((c) => !c.summary.passed).length,
    completedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

/** A provenance manifest covering the named agents. */
export function provenanceManifest(
  agents: string[] = ["loom", "tapestry", "shuttle"],
): PromptProvenanceManifest {
  return {
    version: 1,
    producedAt: FIXED_TIMESTAMP,
    gitSha: FIXED_GIT_SHA,
    records: agents.map((agentName) => ({
      agentName,
      hash: "a".repeat(64),
      byteLength: 4096,
      charLength: 4000,
      sources: [{ kind: "builtin" as const, layer: "primary" as const }],
      summary: `Agent "${agentName}": 1 source(s) [builtin primary]`,
      gitSha: FIXED_GIT_SHA,
      capturedAt: FIXED_TIMESTAMP,
    })),
  };
}

/** Runs `body` with a fresh temporary bundle root, removed afterwards. */
export async function withBundleRoot<T>(
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "weave-evals-scenario-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every file under `dir`, as absolute paths. */
export async function filesUnder(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const found: string[] = [];
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    found.push(join(dir, rel));
  }
  return found.sort();
}

/** The concatenated text of every file under `dir`. */
export async function allPublishedText(dir: string): Promise<string> {
  const paths = await filesUnder(dir);
  const parts = await Promise.all(paths.map((p) => Bun.file(p).text()));
  return parts.join("\n");
}

/**
 * Fails with the offending file named, rather than a bare boolean, when any
 * published file contains `needle`.
 */
export async function expectNothingPublishedContains(
  dir: string,
  needle: string,
): Promise<void> {
  for (const path of await filesUnder(dir)) {
    const text = await Bun.file(path).text();
    if (text.includes(needle)) {
      expect(`${path} contains ${needle}`).toBe(
        "no published file contains it",
      );
    }
  }
}
