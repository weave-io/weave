import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  LEGACY_PREFLIGHT_RUN_NAME,
  type LegacyPublisherPreflightEnvironment,
  runLegacyPublisherPreflight,
} from "../legacy-preflight.js";
import { LEGACY_DENYLIST_PATHS } from "./legacy-denylist.js";

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

describe("retired publisher after cutover", () => {
  test("removes the old workflow and keeps the preflight as a rollback proof", async () => {
    // Task 35 deleted the old publisher. The preflight module stays because
    // the documented rollback restores the old trust identity and re-verifies
    // it with `release:doctor --pre-cutover`; it reads the registry and
    // GitHub, never the removed workflow file.
    expect(
      await Bun.file(resolve(ROOT, ".github/workflows/publish.yml")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        resolve(ROOT, "scripts/release/legacy-preflight.ts"),
      ).exists(),
    ).toBe(true);

    const workflows = await Array.fromAsync(
      new Bun.Glob("*.{yml,yaml}").scan({
        cwd: resolve(ROOT, ".github/workflows"),
        onlyFiles: true,
      }),
    );
    expect([...workflows].sort()).toEqual([
      "agent-evals.yml",
      "ci.yml",
      "deploy-docs.yml",
      "docs-audit-followup.yml",
      "docs-audit.yml",
      "release-attest.yml",
      "release-publish.yml",
      "release-stable-prepare.yml",
      "release-stable-regenerate.yml",
    ]);
    for (const workflow of workflows) {
      const text = await Bun.file(
        resolve(ROOT, ".github/workflows", workflow),
      ).text();
      for (const path of LEGACY_DENYLIST_PATHS)
        expect(text, `${workflow}:${path}`).not.toContain(path);
    }
  });
});
