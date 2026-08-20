/**
 * The docs site and the deterministic checker must share one declarative
 * navigation contract. These regressions pin that wiring against the real
 * repository: the checked-in data is the only place routes are declared, the
 * Astro config and search module hold no list of their own, and the live tree
 * still fails when a public page is not declared.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createParserBudget, DETERMINISTIC_DOCS_LIMITS } from "../contract.js";
import { evaluateDeterministicDocsTreeSafe } from "../deterministic.js";
import { parseDocsNavigation } from "../navigation.js";
import {
  DOCS_SITE_ASTRO_CONFIG,
  DOCS_SITE_CONTENT_ROOT,
  DOCS_SITE_NAVIGATION_DATA,
  DOCS_SITE_SEARCH_DATA,
} from "../policy.js";
import { collectDocsTree } from "../tree.js";

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Quoted route literal, e.g. `'docs'` or `"docs/reference/cli"`. */
const ROUTE_LITERAL = /['"]docs(\/[^'"]*)?['"]/g;

async function readRepositoryFile(path: string): Promise<string> {
  return await Bun.file(join(REPOSITORY_ROOT, path)).text();
}

describe("docs navigation wiring", () => {
  test("the checked-in navigation contract is valid and non-empty", async () => {
    const text = await readRepositoryFile(DOCS_SITE_NAVIGATION_DATA);
    const contract = parseDocsNavigation(
      text,
      DOCS_SITE_NAVIGATION_DATA,
      createParserBudget(),
    );
    if (contract.isErr()) throw new Error(contract.error.type);

    expect(contract.value.sidebarRoutes.size).toBeGreaterThan(0);
    expect(contract.value.searchRoutes.size).toBeGreaterThan(0);
    expect(contract.value.compatibilityRoutes.size).toBeGreaterThan(0);
    for (const route of contract.value.compatibilityRoutes) {
      expect(contract.value.sidebarRoutes.has(route)).toBe(false);
      expect(contract.value.searchRoutes.has(route)).toBe(false);
    }
  });

  test("the Astro config consumes the shared data and declares no routes", async () => {
    const config = await readRepositoryFile(DOCS_SITE_ASTRO_CONFIG);
    expect(config).toContain("src/data/docs-navigation");
    expect(config).toContain("sidebar: starlightSidebar");
    expect(config.match(ROUTE_LITERAL)).toBeNull();
    expect(config).not.toContain(".filter(");
  });

  test("the search module projects the shared data and declares no routes", async () => {
    const search = await readRepositoryFile(DOCS_SITE_SEARCH_DATA);
    expect(search).toContain("docsNavigation.search");
    expect(search.match(ROUTE_LITERAL)).toBeNull();
  });

  test("the live repository tree passes and stays fail-closed for a new page", async () => {
    const loaded = await collectDocsTree(REPOSITORY_ROOT);
    if (loaded.isErr()) throw new Error(loaded.error.type);
    expect(loaded.value.rootMissing).toBe(false);

    const passing = evaluateDeterministicDocsTreeSafe(loaded.value.files);
    if (passing.isErr()) throw new Error(passing.error.type);
    expect(passing.value.issues).toEqual([]);
    expect(passing.value.passed).toBe(true);

    const route = "docs/how-to/undeclared-page";
    const drifted = evaluateDeterministicDocsTreeSafe({
      ...loaded.value.files,
      [`${DOCS_SITE_CONTENT_ROOT}/${route}.mdx`]:
        "---\ntitle: Undeclared\n---\n\nThis page is not declared anywhere.\n",
    });
    if (drifted.isErr()) throw new Error(drifted.error.type);
    expect(drifted.value.passed).toBe(false);
    expect(drifted.value.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sidebar-missing-page",
          detail: route,
        }),
        expect.objectContaining({ kind: "search-missing-page", detail: route }),
      ]),
    );
  });

  test("the live repository stays inside the link and anchor budgets", async () => {
    const loaded = await collectDocsTree(REPOSITORY_ROOT);
    if (loaded.isErr()) throw new Error(loaded.error.type);
    let links = 0;
    let headings = 0;
    for (const text of Object.values(loaded.value.files)) {
      links += [...text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
        .length;
      headings += [...text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].length;
    }
    expect(links).toBeLessThanOrEqual(DETERMINISTIC_DOCS_LIMITS.links);
    expect(headings).toBeLessThanOrEqual(DETERMINISTIC_DOCS_LIMITS.anchors);
  });
});
