import { PUBLIC_PACKAGES } from "../../../constants.js";
import { publishablePackageNames } from "../../../package-policy.js";

const FILES_FIELD = ["dist", "README.md", "CHANGELOG.md", "LICENSE"] as const;

const ASTRO = `export default {
  integrations: [
    {
      sidebar: [
        {
          label: "Start",
          items: ["docs", "docs/quickstart"],
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
    "docs/README.md": "# Docs\n\nContributor documentation index.\n",
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

export function inventoryFailureTree(): Record<string, string> {
  const files = passingDocsTree();
  delete files["packages/cli/README.md"];
  return files;
}
