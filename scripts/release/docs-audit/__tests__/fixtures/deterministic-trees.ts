import { PUBLIC_PACKAGES } from "../../../constants.js";
import { publishablePackageNames } from "../../../package-policy.js";
import { DOCS_SITE_NAVIGATION_DATA } from "../../policy.js";

const FILES_FIELD = ["dist", "README.md", "CHANGELOG.md", "LICENSE"] as const;

interface NavigationFixture {
  readonly sidebar?: readonly string[];
  readonly search?: readonly string[];
  readonly compatibilityRoutes?: readonly string[];
}

/** Build the declarative navigation contract the checker treats as authority. */
export function navigationData(
  fixture: NavigationFixture = {},
): Record<string, unknown> {
  const sidebar = fixture.sidebar ?? ["docs", "docs/quickstart"];
  const search = fixture.search ?? sidebar;
  return {
    schemaVersion: 1,
    sidebar: [{ label: "Start", routes: [...sidebar] }],
    search: search.map((route) => ({
      group: "Start",
      route,
      title: route,
      subtitle: "fixture entry",
      icon: "page",
    })),
    compatibilityRoutes: [...(fixture.compatibilityRoutes ?? [])],
  };
}

function navigationJson(fixture: NavigationFixture = {}): string {
  return `${JSON.stringify(navigationData(fixture), null, 2)}\n`;
}

/**
 * A hostile Astro config: it declares a different route list, hides entries
 * behind a runtime `.filter()`, and mentions routes only in comments and
 * strings. None of it may reach the checker.
 */
const ASTRO_WITH_RUNTIME_TRANSFORM = `import { starlightSidebar } from './src/data/docs-navigation.ts';

// "docs/concepts" is mentioned only in this comment.
const spoof = "items: ['docs/concepts']";

export default {
  integrations: [
    {
      sidebar: [
        {
          label: 'Start',
          items: ['docs', 'docs/quickstart', 'docs/concepts'].filter(
            (route) => route !== 'docs/concepts',
          ),
        },
      ],
      spoof,
      real: starlightSidebar,
    },
  ],
};
`;

const SEARCH_MODULE = `import { docsNavigation } from './docs-navigation.js';

// { href: "docs/concepts/" }
export const docsSearchData = docsNavigation.search.map((entry) => ({
  group: entry.group,
  title: entry.title,
  subtitle: entry.subtitle,
  href: \`\${entry.route}/\`,
  icon: entry.icon,
}));
`;

function packageManifest(name: string): string {
  return `${JSON.stringify({ name, files: [...FILES_FIELD] }, null, 2)}\n`;
}

function packageReadme(name: string): string {
  return `# ${name}\n\nInstall and use the published package.\n`;
}

/** In-memory passing docs tree for the deterministic checker. */
export function passingDocsTree(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": "# Weave\n\nPublic packages and adapters.\n",
    "RELEASING.md": "# Releasing\n\nRelease operator runbook.\n",
    "docs/README.md":
      "# Docs\n\nContributor documentation index. See the [release runbook](../RELEASING.md).\n",
    "packages/docs/README.md": "# Docs site\n\nPublic documentation.\n",
    "packages/docs/astro.config.mjs": ASTRO_WITH_RUNTIME_TRANSFORM,
    "packages/docs/src/data/docs-search.ts": SEARCH_MODULE,
    [DOCS_SITE_NAVIGATION_DATA]: navigationJson(),
    "packages/docs/src/content/docs/docs/index.mdx":
      "# Overview\n\nWeave configuration model.\n",
    "packages/docs/src/content/docs/docs/quickstart.mdx":
      "# Quickstart\n\nInstall, initialize, and validate.\n",
  };
  for (const packageName of publishablePackageNames()) {
    const directory = PUBLIC_PACKAGES[packageName].directory;
    files[`${directory}/README.md`] = packageReadme(packageName);
    files[`${directory}/CHANGELOG.md`] = `# ${packageName}\n`;
    files[`${directory}/package.json`] = packageManifest(packageName);
  }
  return { ...files, ...overrides };
}

/** Replace only the navigation contract of a passing tree. */
export function navigationTree(
  fixture: NavigationFixture,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return passingDocsTree({
    [DOCS_SITE_NAVIGATION_DATA]: navigationJson(fixture),
    ...overrides,
  });
}

export function brokenLinkTree(): Record<string, string> {
  return passingDocsTree({
    "docs/README.md":
      "# Docs\n\nSee the [missing page](missing.md) for details.\n",
  });
}

export function sidebarDriftTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/src/content/docs/docs/concepts.mdx":
      "# Concepts\n\nAgents and workflows.\n",
  });
}

export function compatibilityDocsTree(): Record<string, string> {
  return navigationTree(
    {
      sidebar: ["docs", "docs/quickstart", "docs/reference/adapters"],
      compatibilityRoutes: [
        "docs/explanation/architecture",
        "docs/reference/adapters/claude-code",
      ],
    },
    {
      "packages/docs/src/content/docs/docs/explanation/architecture.mdx":
        "# Architecture\n\nThis exact inventory route remains available for existing links.\n",
      "packages/docs/src/content/docs/docs/reference/adapters/index.mdx":
        "# Adapters\n\nCurrent adapter support.\n",
      "packages/docs/src/content/docs/docs/reference/adapters/claude-code.mdx":
        "# Claude Code\n\nThis exact inventory route remains available for existing links.\n",
    },
  );
}

/**
 * The docs site source claims coverage for `docs/concepts` in a comment, a
 * string literal, and a pre-filter array literal. The declarative contract does
 * not, so the page must still fail coverage.
 */
export function commentOnlyFakeEntriesTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/src/content/docs/docs/concepts.mdx":
      "# Concepts\n\nAgents and workflows.\n",
  });
}

export function unmarkedHowToPageTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/src/content/docs/docs/how-to/new-page.mdx":
      "# New How-To\n\nThis new page is not in the compatibility inventory.\n",
  });
}

export function routePrefixBypassTree(): Record<string, string> {
  return navigationTree(
    { compatibilityRoutes: ["docs/how-to/in-inventory"] },
    {
      "packages/docs/src/content/docs/docs/how-to/not-in-inventory.mdx":
        "---\ntitle: Not in inventory\ndescription: Compatibility route for a test.\n---\n\nThis route is not explicitly listed.\n",
    },
  );
}

export function malformedNavigationTree(): Record<string, string> {
  return passingDocsTree({
    [DOCS_SITE_NAVIGATION_DATA]: `{\n  // "docs/concepts" is a comment, not data\n  "schemaVersion": 1\n}\n`,
  });
}

export function repeatedNavigationTree(): Record<string, string> {
  return passingDocsTree({
    [DOCS_SITE_NAVIGATION_DATA]: navigationJson({
      sidebar: ["docs", "docs/quickstart"],
      search: ["docs", "docs", "docs/quickstart"],
    }),
  });
}

export function conflictingNavigationTree(): Record<string, string> {
  return passingDocsTree({
    [DOCS_SITE_NAVIGATION_DATA]: navigationJson({
      compatibilityRoutes: ["docs/quickstart"],
    }),
  });
}

export function inventoryFailureTree(): Record<string, string> {
  const files = passingDocsTree();
  delete files["packages/cli/README.md"];
  return files;
}
