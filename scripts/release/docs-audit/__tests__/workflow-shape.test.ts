import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  loadActionFiles,
  verifyActionPins,
} from "../../../ci/verify-action-pins.js";

const ROOT = resolve(import.meta.dir, "../../../..");
const PR_WORKFLOW = ".github/workflows/docs-audit.yml";
const FOLLOWUP_WORKFLOW = ".github/workflows/docs-audit-followup.yml";

async function workflow(path: string): Promise<string> {
  return Bun.file(resolve(ROOT, path)).text();
}

function jobSection(source: string, job: string): string {
  const start = source.indexOf(`  ${job}:\n`);
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("docs-audit workflow shape", () => {
  test("uses only pull_request and the complete public-impact path filter", async () => {
    const source = await workflow(PR_WORKFLOW);

    expect(source).toContain("on:\n  pull_request:");
    expect(source).not.toContain("workflow_dispatch:");
    expect(source).not.toContain("pull_request_target");
    for (const path of [
      "packages/cli/**",
      "packages/adapters/**",
      "packages/docs/**",
      "docs/**",
      "README.md",
      ".changeset/**",
    ])
      expect(source).toContain(`      - ${path}`);
  });

  test("always creates one terminal docs-audit job over both feeder jobs", async () => {
    const source = await workflow(PR_WORKFLOW);
    const terminal = jobSection(source, "docs-audit");

    expect(terminal).toContain("name: docs-audit");
    expect(terminal).toContain("needs: [docs-deterministic, docs-ai-audit]");
    expect(terminal).toContain("if: always()");
    expect(terminal).toContain("scripts/release/docs-audit/gate-main.ts");
    expect(source).toContain("docs-ai-fork-skip:");
    expect(source).toContain("The AI audit is skipped neutrally");
    expect(source).toContain("Dispatch **Docs audit follow-up**");
    expect(source).toContain(
      "It will not execute, install, or check out fork content.",
    );
  });

  test("runs same-repository AI only in the protected environment", async () => {
    const source = await workflow(PR_WORKFLOW);
    const ai = jobSection(source, "docs-ai-audit");
    const deterministic = jobSection(source, "docs-deterministic");

    expect(ai).toContain("environment: release-ai");
    expect(ai).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(ai).toContain("WEAVE_RELEASE_AI_API_KEY");
    expect(deterministic).not.toContain("${{ secrets.");
    expect(deterministic).not.toContain("WEAVE_RELEASE_AI_API_KEY");
  });

  test("keeps the follow-up controller on main and fork bytes in data-only flow", async () => {
    const source = await workflow(FOLLOWUP_WORKFLOW);
    const audit = jobSection(source, "followup-audit");
    const post = jobSection(source, "followup-post");
    const terminal = jobSection(source, "docs-audit");
    const patches = jobSection(source, "apply-patches");

    expect(source).toContain("on:\n  workflow_dispatch:");
    expect(source).not.toContain("pull_request_target");
    expect(source).toContain(
      'description: "Pull request number (1 through 1000000)"',
    );
    expect(source).toContain("type: boolean");
    for (const section of [audit, post, terminal, patches]) {
      expect(section).toContain("ref: main");
      expect(section).not.toContain("git checkout");
      expect(section).not.toContain("git fetch");
      expect(section).not.toContain("pull/<");
    }
    expect(audit).toContain("--data-root");
    expect(audit).toContain("--ignore-scripts");
    expect(audit).toContain("environment: release-ai");
    expect(post).toContain("environment: release-app");
    expect(terminal).toContain("if: always()");
    expect(terminal).toContain("scripts/release/docs-audit/gate-main.ts");
    expect(patches).toContain("environment: docs-audit-patch");
    expect(patches).not.toContain("WEAVE_RELEASE_AI_API_KEY");
    expect(patches).toContain("--phase apply-patches");
    expect(patches).toContain("gh pr create");
  });

  test("has no pull_request_target and all action references are approved SHAs", async () => {
    const files = await loadActionFiles(ROOT);
    expect(
      Object.values(files).some((source) =>
        source.includes("pull_request_target"),
      ),
    ).toBe(false);
    const pins = verifyActionPins(files);
    expect(pins.isOk()).toBe(true);
  });
});
