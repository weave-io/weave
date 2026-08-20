import { PUBLIC_PACKAGES } from "../../../constants.js";
import { publishablePackageNames } from "../../../package-policy.js";

const FILES_FIELD = ["dist", "README.md", "CHANGELOG.md", "LICENSE"] as const;

const ASTRO = `export default {
  integrations: [
    {
      sidebar: [
        {
          label: "Start",
          items: [
            "docs",
            "docs/quickstart",
          ],
        },
      ],
    },
  ],
};
`;

const ASTRO_WITH_REFERENCE = `export default {
  integrations: [
    {
      sidebar: [
        {
          label: "Start",
          items: [
            "docs",
            "docs/quickstart",
            "docs/reference/adapters",
          ],
        },
      ],
    },
  ],
};
`;

const SEARCH = `export const docsSearchData = [
  { href: "docs/" },
  { href: "docs/quickstart/" },
];
`;

const SEARCH_WITH_REFERENCE = `export const docsSearchData = [
  { href: "docs/" },
  { href: "docs/quickstart/" },
  { href: "docs/reference/adapters/" },
];
`;

const ASTRO_WITH_COMMENT_ONLY_FAKE = `const fake = "items: ['docs/concepts']";
export default {
  integrations: [
    {
      sidebar: [
        {
          items: [
            "docs",
            "docs/quickstart",
            // "docs/concepts",
          ],
        },
      ],
    },
  ],
};
`;

const SEARCH_WITH_COMMENT_ONLY_FAKE = `const fake = "href: 'docs/concepts/'";
export const docsSearchData = [
  { href: "docs/" },
  { href: "docs/quickstart/" },
  // { href: "docs/concepts/" },
];
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
    "packages/docs/astro.config.mjs": ASTRO,
    "packages/docs/src/data/docs-search.ts": SEARCH,
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
  return passingDocsTree({
    "packages/docs/astro.config.mjs": ASTRO_WITH_REFERENCE,
    "packages/docs/src/data/docs-search.ts": SEARCH_WITH_REFERENCE,
    "packages/docs/src/content/docs/docs/explanation/architecture.mdx":
      "# Architecture\n\nThis exact inventory route remains available for existing links.\n",
    "packages/docs/src/content/docs/docs/reference/adapters/index.mdx":
      "# Adapters\n\nCurrent adapter support.\n",
    "packages/docs/src/content/docs/docs/reference/adapters/claude-code.mdx":
      "# Claude Code\n\nThis exact inventory route remains available for existing links.\n",
  });
}

export function commentOnlyFakeEntriesTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/astro.config.mjs": ASTRO_WITH_COMMENT_ONLY_FAKE,
    "packages/docs/src/data/docs-search.ts": SEARCH_WITH_COMMENT_ONLY_FAKE,
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
  return passingDocsTree({
    "packages/docs/src/content/docs/docs/how-to/not-in-inventory.mdx":
      "---\ntitle: Not in inventory\ndescription: Compatibility route for a test.\n---\n\nThis route is not explicitly listed.\n",
  });
}

export function malformedAstroTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/astro.config.mjs":
      'export default { integrations: [{ sidebar: [{ items: ["docs" }]}] };\n',
  });
}

export function repeatedAstroTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/astro.config.mjs":
      "export default { sidebar: [], sidebar: [] };\n",
  });
}

export function repeatedSearchEntriesTree(): Record<string, string> {
  return passingDocsTree({
    "packages/docs/src/data/docs-search.ts": `export const docsSearchData = [
  { href: "docs/" },
  { href: "docs/" },
  { href: "docs/quickstart/" },
];
`,
  });
}

export function inventoryFailureTree(): Record<string, string> {
  const files = passingDocsTree();
  delete files["packages/cli/README.md"];
  return files;
}
