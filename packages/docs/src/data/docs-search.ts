/**
 * docs-search — command-palette search data for the docs command palette.
 *
 * This is the real-route replacement for the hardcoded prototype `DATA` array
 * that originally lived inline in `scripts/prototype/docs.js` and pointed at the
 * prototype HTML files (`docs-home.html`, `docs-article.html`). Each entry now
 * targets an actual Astro docs route.
 *
 * `href` values are **root-relative, BASE_URL-less** route paths (e.g.
 * `docs/`, `docs/workflows/#overview`). They intentionally omit the deployment
 * base prefix; `PageFrame.astro` joins each `href` to `import.meta.env.BASE_URL`
 * before serializing the data into the palette so navigation resolves correctly
 * under any `base` (root `/` for the public docs per the prototype-replica
 * learning, or a sub-path on other deployments). Keeping the raw data
 * base-agnostic means this module has no build-time coupling to the deploy path.
 *
 * `docs.js` reads the resolved, serialized form from the
 * `<script id="paletteData" type="application/json">` element emitted by
 * PageFrame; this array is the source of that script's contents.
 */

/** Visual grouping shown as a `.grp` caption in the palette results list. */
export type DocsSearchGroup = "Start" | "Guides" | "Reference";

/** Icon key — maps to the inline SVG set in `docs.js` (`ICON.page` / `ICON.spec`). */
export type DocsSearchIcon = "page" | "spec";

/** A single command-palette search entry. */
export interface DocsSearchEntry {
  /** Result group caption. */
  group: DocsSearchGroup;
  /** Primary result title (bold line). */
  title: string;
  /** Secondary descriptor (muted sub-line); also matched during filtering. */
  subtitle: string;
  /**
   * Root-relative route path WITHOUT the deployment base prefix
   * (e.g. `docs/workflows/#overview`). PageFrame prepends `BASE_URL`.
   */
  href: string;
  /** Icon key resolved by `docs.js`. */
  icon: DocsSearchIcon;
}

/**
 * Search index for the live public docs routes under
 * `src/content/docs/docs/`. Hrefs are base-less and are joined to BASE_URL by
 * PageFrame before the palette receives them.
 */
export const docsSearchData: DocsSearchEntry[] = [
  {
    group: "Start",
    title: "Weave Documentation",
    subtitle: "route map and support boundaries",
    href: "docs/",
    icon: "page",
  },
  {
    group: "Start",
    title: "Getting Started",
    subtitle: "install, create config, validate, connect OpenCode",
    href: "docs/getting-started/",
    icon: "page",
  },
  {
    group: "Start",
    title: "Concepts",
    subtitle: "API layer, packages, config, execution boundaries",
    href: "docs/concepts/",
    icon: "page",
  },
  {
    group: "Guides",
    title: "Configuration",
    subtitle: "global/project config, merge, validation, prompts",
    href: "docs/configuration/",
    icon: "page",
  },
  {
    group: "Guides",
    title: "Agents and Categories",
    subtitle: "builtin overrides, custom agents, category shuttles",
    href: "docs/agents-and-categories/",
    icon: "page",
  },
  {
    group: "Guides",
    title: "Prompts, Models, and Policy",
    subtitle: "prompt composition, model intent, tool policy",
    href: "docs/prompts-models-policy/",
    icon: "page",
  },
  {
    group: "Guides",
    title: "Workflows",
    subtitle: "ordered explicit execution and gates",
    href: "docs/workflows/",
    icon: "page",
  },
  {
    group: "Guides",
    title: "OpenCode",
    subtitle: "implemented adapter setup and commands",
    href: "docs/opencode/",
    icon: "page",
  },
  {
    group: "Guides",
    title: "Runtime Operations",
    subtitle: "CLI recipes, journal, builds, docs maintenance",
    href: "docs/runtime-operations/",
    icon: "page",
  },
  {
    group: "Reference",
    title: "CLI Reference",
    subtitle: "init validate prompt runtime and run behavior",
    href: "docs/reference/cli/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "DSL Reference",
    subtitle: "syntax, agents, categories, workflows, settings",
    href: "docs/reference/dsl/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Adapters",
    subtitle: "support matrix and OpenCode capabilities",
    href: "docs/reference/adapters/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Packages",
    subtitle: "workspace package responsibilities",
    href: "docs/reference/packages/",
    icon: "spec",
  },
];
