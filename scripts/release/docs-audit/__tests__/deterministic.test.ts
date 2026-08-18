import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateDeterministicDocsTree,
  runDeterministicDocsCheck,
} from "../deterministic.js";
import { DOCS_AUDIT_LIMITS } from "../policy.js";
import {
  brokenLinkTree,
  inventoryFailureTree,
  passingDocsTree,
  sidebarDriftTree,
} from "./fixtures/deterministic-trees.js";

describe("deterministic docs checker", () => {
  test("passes a complete docs tree fixture", () => {
    const result = evaluateDeterministicDocsTree(passingDocsTree());
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("fails broken local links", () => {
    const result = evaluateDeterministicDocsTree(brokenLinkTree());
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "broken-link")).toBe(
      true,
    );
  });

  test("fails sidebar and search drift", () => {
    const result = evaluateDeterministicDocsTree(sidebarDriftTree());
    expect(result.passed).toBe(false);
    const kinds = new Set(result.issues.map((issue) => issue.kind));
    expect(kinds.has("sidebar-missing-page")).toBe(true);
    expect(kinds.has("search-missing-page")).toBe(true);
  });

  test("fails README/tarball inventory gaps", () => {
    const result = evaluateDeterministicDocsTree(inventoryFailureTree());
    expect(result.passed).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.kind === "missing-readme" &&
          issue.path === "packages/cli/README.md",
      ),
    ).toBe(true);
  });

  test("bounds issue results and keeps their digest SHA-shaped", () => {
    const links = Array.from(
      { length: DOCS_AUDIT_LIMITS.issues + 8 },
      (_, index) => `[missing ${index}](missing-${index}.md)`,
    ).join("\n");
    const result = evaluateDeterministicDocsTree(
      passingDocsTree({ "docs/README.md": `# Docs\n\n${links}\n` }),
    );

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(DOCS_AUDIT_LIMITS.issues);
    expect(
      result.issues.every(
        (issue) =>
          issue.path.length <= DOCS_AUDIT_LIMITS.issuePathChars &&
          issue.detail.length <= DOCS_AUDIT_LIMITS.issuePathChars,
      ),
    ).toBe(true);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("loads a passing tree from a content root", async () => {
    const root = await writeTree(passingDocsTree());
    try {
      const result = await runDeterministicDocsCheck(root);
      if (result.isErr()) throw new Error(`unexpected ${result.error.type}`);
      expect(result.value.passed).toBe(true);
    } finally {
      removeTree(root);
    }
  });

  test("refuses a missing content root", async () => {
    const result = await runDeterministicDocsCheck(
      join(tmpdir(), `docs-audit-missing-${Bun.randomUUIDv7()}`),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DeterministicDocsRootInvalid");
  });
});

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = join(tmpdir(), `docs-audit-det-${Bun.randomUUIDv7()}`);
  for (const [path, text] of Object.entries(files))
    await Bun.write(join(root, path), text);
  return root;
}

function removeTree(root: string): void {
  Bun.spawnSync(["rm", "-rf", root]);
}
