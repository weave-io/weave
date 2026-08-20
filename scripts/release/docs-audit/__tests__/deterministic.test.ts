import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DETERMINISTIC_DOCS_LIMITS,
  evaluateDeterministicDocsTree,
  evaluateDeterministicDocsTreeSafe,
  runDeterministicDocsCheck,
} from "../deterministic.js";
import { DOCS_AUDIT_LIMITS } from "../policy.js";
import {
  brokenLinkTree,
  commentOnlyFakeEntriesTree,
  compatibilityDocsTree,
  inventoryFailureTree,
  malformedAstroTree,
  passingDocsTree,
  repeatedAstroTree,
  repeatedSearchEntriesTree,
  routePrefixBypassTree,
  sidebarDriftTree,
  unmarkedHowToPageTree,
} from "./fixtures/deterministic-trees.js";

describe("deterministic docs checker", () => {
  test("passes a complete docs tree fixture, including the root runbook link", () => {
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

  test("allows compatibility pages excluded by the Astro navigation contract", () => {
    const result = evaluateDeterministicDocsTree(compatibilityDocsTree());
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("fails a public page missing sidebar and search coverage", () => {
    const result = evaluateDeterministicDocsTree(sidebarDriftTree());
    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sidebar-missing-page",
          detail: "docs/concepts",
        }),
        expect.objectContaining({
          kind: "search-missing-page",
          detail: "docs/concepts",
        }),
      ]),
    );
  });

  test("does not count comment-only sidebar or search entries", () => {
    const result = evaluateDeterministicDocsTree(commentOnlyFakeEntriesTree());
    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sidebar-missing-page",
          detail: "docs/concepts",
        }),
        expect.objectContaining({
          kind: "search-missing-page",
          detail: "docs/concepts",
        }),
      ]),
    );
  });

  test("requires new how-to pages to have navigation and search coverage", () => {
    const result = evaluateDeterministicDocsTree(unmarkedHowToPageTree());
    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sidebar-missing-page",
          detail: "docs/how-to/new-page",
        }),
        expect.objectContaining({
          kind: "search-missing-page",
          detail: "docs/how-to/new-page",
        }),
      ]),
    );
  });

  test("does not exempt an unlisted route that shares a compatibility prefix", () => {
    const result = evaluateDeterministicDocsTree(routePrefixBypassTree());
    expect(result.passed).toBe(false);
    expect(
      result.issues.filter(
        (issue) => issue.detail === "docs/how-to/not-in-inventory",
      ),
    ).toHaveLength(2);
  });

  test("accepts repeated search entries without repeated parser work failures", () => {
    const result = evaluateDeterministicDocsTree(repeatedSearchEntriesTree());
    expect(result.passed).toBe(true);
  });

  test("returns typed failures for malformed and repeated structural input", () => {
    const malformed = evaluateDeterministicDocsTreeSafe(malformedAstroTree());
    expect(malformed.isErr()).toBe(true);
    if (malformed.isOk()) return;
    expect(malformed.error.type).toBe("DeterministicDocsParseFailed");
    if (malformed.error.type !== "DeterministicDocsParseFailed") return;
    expect(malformed.error.reason).toBe("malformed-input");

    const repeated = evaluateDeterministicDocsTreeSafe(repeatedAstroTree());
    expect(repeated.isErr()).toBe(true);
    if (repeated.isOk()) return;
    expect(repeated.error.type).toBe("DeterministicDocsParseFailed");
    if (repeated.error.type !== "DeterministicDocsParseFailed") return;
    expect(repeated.error.reason).toBe("repeated-input");
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

  test("rejects file-count overflow before structural parsing", () => {
    const files = passingDocsTree();
    for (let index = 0; index < DETERMINISTIC_DOCS_LIMITS.fileCount; index += 1)
      files[`docs/generated/${index}.md`] = "# Generated\n";
    const result = evaluateDeterministicDocsTreeSafe(files);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DeterministicDocsBoundExceeded");
    if (result.error.type !== "DeterministicDocsBoundExceeded") return;
    expect(result.error.bound).toBe("file-count");
  });

  test("rejects per-file and aggregate byte overflow before parsing", () => {
    const perFile = evaluateDeterministicDocsTreeSafe(
      passingDocsTree({
        "docs/oversized.md": "x".repeat(
          DETERMINISTIC_DOCS_LIMITS.perFileBytes + 1,
        ),
      }),
    );
    expect(perFile.isErr()).toBe(true);
    if (perFile.isOk()) return;
    expect(perFile.error.type).toBe("DeterministicDocsBoundExceeded");
    if (perFile.error.type !== "DeterministicDocsBoundExceeded") return;
    expect(perFile.error.bound).toBe("file-bytes");

    const files = passingDocsTree();
    const chunks = Math.ceil(
      DETERMINISTIC_DOCS_LIMITS.aggregateBytes /
        DETERMINISTIC_DOCS_LIMITS.perFileBytes,
    );
    for (let index = 0; index < chunks; index += 1)
      files[`docs/aggregate/${index}.md`] = "x".repeat(
        DETERMINISTIC_DOCS_LIMITS.perFileBytes,
      );
    const aggregate = evaluateDeterministicDocsTreeSafe(files);
    expect(aggregate.isErr()).toBe(true);
    if (aggregate.isOk()) return;
    expect(aggregate.error.type).toBe("DeterministicDocsBoundExceeded");
    if (aggregate.error.type !== "DeterministicDocsBoundExceeded") return;
    expect(aggregate.error.bound).toBe("aggregate-bytes");
  });

  test("rejects parser-work overflow before scanning source", () => {
    const result = evaluateDeterministicDocsTreeSafe(
      passingDocsTree({
        "packages/docs/astro.config.mjs": `export default { sidebar: [] };${" ".repeat(
          DETERMINISTIC_DOCS_LIMITS.parserWork,
        )}`,
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("DeterministicDocsBoundExceeded");
    if (result.error.type !== "DeterministicDocsBoundExceeded") return;
    expect(result.error.bound).toBe("parser-work");
  });

  test("enforces read bounds before loading a content-root file", async () => {
    const root = await writeTree(
      passingDocsTree({
        "docs/oversized.md": "x".repeat(
          DETERMINISTIC_DOCS_LIMITS.perFileBytes + 1,
        ),
      }),
    );
    try {
      const result = await runDeterministicDocsCheck(root);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.type).toBe("DeterministicDocsBoundExceeded");
      if (result.error.type !== "DeterministicDocsBoundExceeded") return;
      expect(result.error.bound).toBe("file-bytes");
    } finally {
      removeTree(root);
    }
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
