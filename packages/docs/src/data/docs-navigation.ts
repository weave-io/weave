/**
 * docs-navigation — the single declarative source of docs navigation.
 *
 * `docs-navigation.json` is the authority for three related surfaces:
 *
 * 1. the Starlight sidebar rendered by `astro.config.mjs`,
 * 2. the command-palette search index consumed by `PageFrame.astro`, and
 * 3. the exact compatibility routes that stay reachable but stay out of
 *    navigation.
 *
 * The release-time deterministic docs checker reads the same JSON structurally.
 * Because the data — not this module and not `astro.config.mjs` — is the
 * authority, any runtime transformation applied to the exported values cannot
 * change what the checker enforces. Keep this module a narrowing shim: read the
 * JSON, reject a contract violation, and export typed values.
 *
 * Validation failures throw. This runs only at docs-build time, where an
 * invalid navigation contract must stop the build rather than silently ship a
 * broken sidebar or palette.
 */
import navigationData from "./docs-navigation.json";

/** Visual grouping shown as a `.grp` caption in the palette results list. */
export type DocsSearchGroup =
  | "Start"
  | "Configure"
  | "Adapters"
  | "Operate"
  | "Reference";

/** Icon key — maps to the inline SVG set in `docs.js` (`ICON.page` / `ICON.spec`). */
export type DocsSearchIcon = "page" | "spec";

const SEARCH_ICONS: readonly DocsSearchIcon[] = ["page", "spec"];

/** One sidebar group: a caption plus the exact routes shown beneath it. */
export interface DocsSidebarGroup {
  readonly label: DocsSearchGroup;
  readonly routes: readonly string[];
}

/** One command-palette entry, keyed by canonical route. */
export interface DocsSearchRecord {
  readonly group: DocsSearchGroup;
  readonly route: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: DocsSearchIcon;
}

/** The whole validated navigation contract. */
export interface DocsNavigation {
  readonly schemaVersion: 1;
  readonly sidebar: readonly DocsSidebarGroup[];
  readonly search: readonly DocsSearchRecord[];
  readonly compatibilityRoutes: readonly string[];
}

function fail(detail: string): never {
  throw new Error(`docs-navigation.json is invalid: ${detail}`);
}

function narrowGroup(
  value: string,
  labels: readonly string[],
): DocsSearchGroup {
  if (!labels.includes(value)) fail(`unknown group ${value}`);
  if (
    value !== "Start" &&
    value !== "Configure" &&
    value !== "Adapters" &&
    value !== "Operate" &&
    value !== "Reference"
  )
    fail(`unsupported group ${value}`);
  return value;
}

function narrowIcon(value: string): DocsSearchIcon {
  const icon = SEARCH_ICONS.find((candidate) => candidate === value);
  if (icon === undefined) fail(`unknown icon ${value}`);
  return icon;
}

function narrowNavigation(): DocsNavigation {
  if (navigationData.schemaVersion !== 1)
    fail(`unsupported schemaVersion ${String(navigationData.schemaVersion)}`);

  const labels = navigationData.sidebar.map((group) => group.label);
  const sidebar: DocsSidebarGroup[] = navigationData.sidebar.map((group) => ({
    label: narrowGroup(group.label, labels),
    routes: [...group.routes],
  }));
  const search: DocsSearchRecord[] = navigationData.search.map((entry) => ({
    group: narrowGroup(entry.group, labels),
    route: entry.route,
    title: entry.title,
    subtitle: entry.subtitle,
    icon: narrowIcon(entry.icon),
  }));
  const compatibilityRoutes = [...navigationData.compatibilityRoutes];

  const navigated = new Set(sidebar.flatMap((group) => group.routes));
  for (const route of compatibilityRoutes)
    if (navigated.has(route))
      fail(`route ${route} is both navigated and a compatibility route`);

  return { schemaVersion: 1, sidebar, search, compatibilityRoutes };
}

/** The validated navigation contract shared by the site and the checker. */
export const docsNavigation: DocsNavigation = narrowNavigation();

/**
 * Starlight `sidebar` value. `astro.config.mjs` assigns this directly so the
 * config holds no route list of its own.
 */
export const starlightSidebar: readonly {
  readonly label: string;
  readonly items: readonly string[];
}[] = docsNavigation.sidebar.map((group) => ({
  label: group.label,
  items: group.routes,
}));

/** Exact route inventory for pages intentionally absent from navigation. */
export const COMPATIBILITY_DOC_ROUTES: readonly string[] =
  docsNavigation.compatibilityRoutes;

const compatibilityRouteSet = new Set(COMPATIBILITY_DOC_ROUTES);

/**
 * Exact-match test. A page is not a compatibility page because it shares a
 * directory with one.
 */
export function isCompatibilityDocRoute(route: string): boolean {
  return compatibilityRouteSet.has(route);
}
