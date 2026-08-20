/**
 * docs-search — command-palette search data for the docs command palette.
 *
 * This is the real-route replacement for the hardcoded prototype `DATA` array
 * that originally lived inline in `scripts/prototype/docs.js` and pointed at the
 * prototype HTML files (`docs-home.html`, `docs-article.html`). Each entry now
 * targets an actual Astro docs route.
 *
 * The entries are derived from `docs-navigation.json`, the one declarative
 * navigation contract the docs site and the release-time deterministic checker
 * share. This module holds no route list of its own; it only projects the
 * declared routes into the palette shape.
 *
 * `href` values are **root-relative, BASE_URL-less** route paths (e.g.
 * `docs/`, `docs/workflows/`). They intentionally omit the deployment base
 * prefix; `PageFrame.astro` joins each `href` to `import.meta.env.BASE_URL`
 * before serializing the data into the palette so navigation resolves correctly
 * under any `base` (root `/` for the public docs per the prototype-replica
 * learning, or a sub-path on other deployments). Keeping the raw data
 * base-agnostic means this module has no build-time coupling to the deploy path.
 *
 * `docs.js` reads the resolved, serialized form from the
 * `<script id="paletteData" type="application/json">` element emitted by
 * PageFrame; this array is the source of that script's contents.
 */
import {
  type DocsSearchGroup,
  type DocsSearchIcon,
  docsNavigation,
} from "./docs-navigation.js";

export type { DocsSearchGroup, DocsSearchIcon };

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
   * (e.g. `docs/workflows/`). PageFrame prepends `BASE_URL`.
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
export const docsSearchData: DocsSearchEntry[] = docsNavigation.search.map(
  (entry) => ({
    group: entry.group,
    title: entry.title,
    subtitle: entry.subtitle,
    href: `${entry.route}/`,
    icon: entry.icon,
  }),
);
