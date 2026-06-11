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
export type DocsSearchGroup = "Pages" | "Specs · ADRs";

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
 * Search index for the live docs routes.
 *
 * Hrefs map to the content routes that exist under `src/content/docs/docs/`:
 *   docs/                         → Introduction (docs/index.mdx)
 *   docs/workflows/               → Workflows (canonical article)
 *   docs/getting-started/         → Getting Started
 *   docs/guides/installation/     → Installation
 *   docs/guides/configuration/    → Configuration Guide
 *   docs/guides/core-concepts/    → Core Concepts
 *   docs/reference/cli/           → CLI Reference
 *   docs/reference/adapters/      → Adapters
 *
 * Section anchors use Astro's auto-generated heading slugs so that selecting a
 * result lands on the matching `#<slug>` section (and the TOC scrollspy in
 * docs.js highlights it).
 */
export const docsSearchData: DocsSearchEntry[] = [
  // --- Pages -------------------------------------------------------------
  {
    group: "Pages",
    title: "Introduction",
    subtitle: "get started · what is Weave",
    href: "docs/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Quickstart",
    subtitle: "anatomy of a .weave file",
    href: "docs/#anatomy-of-a-weave-file",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Getting Started",
    subtitle: "install · validate · packages",
    href: "docs/getting-started/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Installation",
    subtitle: "guide · build the workspace",
    href: "docs/guides/installation/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Workflows",
    subtitle: "core dsl · the DAG model",
    href: "docs/workflows/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Configuration Guide",
    subtitle: "core dsl · agents, categories, settings",
    href: "docs/guides/configuration/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Core Concepts",
    subtitle: "core dsl · the moving parts",
    href: "docs/guides/core-concepts/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "CLI Reference",
    subtitle: "reference · command entry points",
    href: "docs/reference/cli/",
    icon: "page",
  },
  {
    group: "Pages",
    title: "Adapters",
    subtitle: "reference · current adapter targets",
    href: "docs/reference/adapters/",
    icon: "page",
  },
  // --- Workflows article sections ---------------------------------------
  {
    group: "Specs · ADRs",
    title: "Workflows · Overview",
    subtitle: "spec · stages and the DAG",
    href: "docs/workflows/#overview",
    icon: "spec",
  },
  {
    group: "Specs · ADRs",
    title: "Workflows · Syntax",
    subtitle: "spec · stage shape",
    href: "docs/workflows/#syntax",
    icon: "spec",
  },
  {
    group: "Specs · ADRs",
    title: "Workflows · Inputs & dependencies",
    subtitle: "spec · inferred edges, fan-in with +",
    href: "docs/workflows/#inputs--dependencies",
    icon: "spec",
  },
  {
    group: "Specs · ADRs",
    title: "Workflows · Runtime contract",
    subtitle: "spec · adapter-facing surface",
    href: "docs/workflows/#runtime-contract",
    icon: "spec",
  },
  {
    group: "Specs · ADRs",
    title: "Workflows · Common errors",
    subtitle: "spec · E2101–W2110",
    href: "docs/workflows/#common-errors",
    icon: "spec",
  },
];
