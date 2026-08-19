import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  LEGACY_PREFLIGHT_RUN_NAME,
  type LegacyPublisherPreflightEnvironment,
  runLegacyPublisherPreflight,
} from "../legacy-preflight.js";

const SHA = "a".repeat(40);
const ROOT = resolve(import.meta.dir, "../../..");

function environment(
  overrides: Partial<LegacyPublisherPreflightEnvironment> = {},
): LegacyPublisherPreflightEnvironment {
  return {
    GITHUB_TOKEN: "read-only-test-token",
    RELEASE_REPOSITORY: "weave-io/weave",
    RELEASE_WORKFLOW_PATH: ".github/workflows/publish.yml",
    RELEASE_EVENT_NAME: "workflow_dispatch",
    RELEASE_OPERATION: "preflight",
    RELEASE_REF: "refs/heads/main",
    RELEASE_SHA: SHA,
    RELEASE_WORKFLOW_REF:
      "weave-io/weave/.github/workflows/publish.yml@refs/heads/main",
    RELEASE_PUBLISH_ENABLED: "true",
    ...overrides,
  };
}

function githubFetch(
  options: { readonly sha?: string; readonly checkConclusion?: string } = {},
) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const requestFetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("/git/ref/heads/main"))
      return new Response(
        JSON.stringify({
          ref: "refs/heads/main",
          object: { type: "commit", sha: options.sha ?? SHA },
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        check_runs: [
          {
            name: "Lint, Typecheck, Build & Test",
            conclusion: options.checkConclusion ?? "success",
          },
        ],
      }),
      { status: 200 },
    );
  };
  return { requestFetch, requests };
}

describe("legacy publisher read-only preflight", () => {
  test("returns typed success after protected-main validation", async () => {
    const github = githubFetch();
    const result = await runLegacyPublisherPreflight(
      environment(),
      github.requestFetch,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        type: "LegacyPublisherPreflightPassed",
        repository: "weave-io/weave",
        workflowPath: ".github/workflows/publish.yml",
        event: "workflow_dispatch",
        operation: "preflight",
        ref: "refs/heads/main",
        subjectSha: SHA,
        publicationEnabled: true,
        readOnly: true,
        sideEffects: "none",
      },
    });
    expect(github.requests).toHaveLength(2);
    expect(
      github.requests.every((request) => request.init?.method === "GET"),
    ).toBe(true);
  });

  test("fails closed when publication is disabled without querying GitHub", async () => {
    const github = githubFetch();
    const result = await runLegacyPublisherPreflight(
      environment({ RELEASE_PUBLISH_ENABLED: "false" }),
      github.requestFetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.reason).toContain(
        "RELEASE_PUBLISH_ENABLED must be exactly true",
      );
    expect(github.requests).toHaveLength(0);
  });

  test("rejects stale protected-main code and a failed required check", async () => {
    const stale = githubFetch({ sha: "b".repeat(40) });
    const staleResult = await runLegacyPublisherPreflight(
      environment(),
      stale.requestFetch,
    );
    expect(staleResult.ok).toBe(false);

    const failedCheck = githubFetch({ checkConclusion: "failure" });
    const failedResult = await runLegacyPublisherPreflight(
      environment(),
      failedCheck.requestFetch,
    );
    expect(failedResult.ok).toBe(false);
    if (!failedResult.ok)
      expect(failedResult.error.reason).toContain("is not green");
  });

  test("rejects an arbitrary dispatch identity and missing protected identity", async () => {
    const arbitrary = await runLegacyPublisherPreflight(
      environment({ RELEASE_OPERATION: "nightly" }),
      githubFetch().requestFetch,
    );
    expect(arbitrary.ok).toBe(false);

    const missing = await runLegacyPublisherPreflight(
      environment({ RELEASE_WORKFLOW_REF: undefined }),
      githubFetch().requestFetch,
    );
    expect(missing.ok).toBe(false);
  });

  test("keeps the stable run identity separate from controller output", () => {
    expect(LEGACY_PREFLIGHT_RUN_NAME).toBe("legacy-publisher-preflight");
  });
});

describe("publish workflow preflight reachability", () => {
  test("guards the preflight path before every side-effect job", async () => {
    const text = await Bun.file(
      resolve(ROOT, ".github/workflows/publish.yml"),
    ).text();
    expect(text).toContain(
      "run-name: legacy-publisher-$" +
        "{{ github.event_name == 'workflow_dispatch' && inputs.operation || 'scheduled' }}",
    );
    expect(text).toContain(
      "options: [nightly, stable-cut, stable-fix, stable-publish, stable-finalize, metadata-replay, preflight]",
    );

    const legacyJob = jobBlock(text, "legacy-preflight");
    expect(legacyJob).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.operation == 'preflight'",
    );
    expect(legacyJob).toContain(
      "permissions:\n      contents: read\n      checks: read",
    );
    expect(legacyJob).toContain("ref: refs/heads/main");
    expect(legacyJob).toContain("persist-credentials: false");
    expect(legacyJob).toContain(
      "RELEASE_WORKFLOW_REF: $" + "{{ github.workflow_ref }}",
    );
    expect(legacyJob).toContain("run: bun scripts/release/legacy-preflight.ts");
    expect(legacyJob).not.toMatch(
      /\bnpm\b|id-token|create-github-app-token|npm publish/,
    );
    expect(legacyJob).not.toContain("bun install");

    for (const job of [
      "preflight",
      "build",
      "bind",
      "publish",
      "stable-plan",
      "metadata-replay-plan",
      "stable-finalize",
      "release-refs",
    ]) {
      const block = jobBlock(text, job);
      expect(block, job).toContain("inputs.operation != 'preflight'");
    }

    for (const job of [
      "build",
      "bind",
      "publish",
      "stable-plan",
      "metadata-replay-plan",
      "stable-finalize",
      "release-refs",
    ]) {
      const block = jobBlock(text, job);
      expect(block, job).toContain("needs:");
      expect(block, job).not.toMatch(
        /if:\s*[^\n]*inputs\.operation == 'preflight'/,
      );
    }
  });
});

function jobBlock(text: string, id: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[A-Za-z0-9-]+:\s*$/.test(line),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}
