import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  loadActionFiles,
  verifyActionPins,
} from "../../../ci/verify-action-pins.js";
import { PHASE_C_WORKFLOW_PATHS } from "../../publish-reachability.js";

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

function allJobSections(source: string): ReadonlyMap<string, string> {
  const jobsMarker = "jobs:\n";
  const jobsStart = source.indexOf(jobsMarker);
  if (jobsStart < 0) return new Map();
  const body = source.slice(jobsStart + jobsMarker.length);
  const matches = Array.from(body.matchAll(/^ {2}([A-Za-z0-9_.-]+):\n/gm));
  return new Map(
    matches.map((match, index) => {
      const name = match[1] ?? "";
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? body.length;
      return [name, body.slice(start, end)];
    }),
  );
}

function hasProtectedSourceCheckout(section: string): boolean {
  return (
    /(?:^|\n)\s*-\s*uses:\s*actions\/checkout@[^\n]+/m.test(section) &&
    /^\s+ref:\s*[^\n]+$/m.test(section) &&
    /^\s+persist-credentials:\s*false\s*$/m.test(section)
  );
}

function readsRepositorySource(section: string): boolean {
  return (
    /\bbun\s+(?:install|run)\b/.test(section) ||
    /\bbun\s+(?:\.\/)?scripts\//.test(section) ||
    /(?:RELEASING|README)\.md\b|\bpackage\.json\b|\bbun\.lock\b|\.changeset\//.test(
      section,
    )
  );
}

function missingProtectedSourceCheckouts(
  path: string,
  source: string,
): string[] {
  return Array.from(allJobSections(source))
    .filter(([, section]) => readsRepositorySource(section))
    .filter(([, section]) => !hasProtectedSourceCheckout(section))
    .map(([job]) => `${path}#${job}`);
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
    expect(terminal).toContain(`repository: \${{ github.repository }}`);
    expect(terminal).toContain("ref: refs/heads/main");
    expect(terminal).toContain("persist-credentials: false");
    expect(hasProtectedSourceCheckout(terminal)).toBe(true);
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

  test("checks out protected source before every Phase C local read or script", async () => {
    const failures: string[] = [];
    for (const path of PHASE_C_WORKFLOW_PATHS) {
      failures.push(
        ...missingProtectedSourceCheckouts(path, await workflow(path)),
      );
    }
    expect(failures).toEqual([]);
  });

  test("detects a terminal local script when its protected checkout is removed", async () => {
    const source = await workflow(PR_WORKFLOW);
    const terminal = jobSection(source, "docs-audit");
    const checkoutStart = source.lastIndexOf("      - uses: actions/checkout@");
    const setupBunStart = source.indexOf(
      "      - uses: oven-sh/setup-bun@",
      checkoutStart,
    );
    const withoutCheckout =
      source.slice(0, checkoutStart) + source.slice(setupBunStart);
    expect(readsRepositorySource(terminal)).toBe(true);
    expect(hasProtectedSourceCheckout(terminal)).toBe(true);
    expect(
      missingProtectedSourceCheckouts(PR_WORKFLOW, withoutCheckout),
    ).toContain(`${PR_WORKFLOW}#docs-audit`);
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
