/**
 * Docs navigation authority.
 *
 * The checker's only source of navigated routes, palette search routes, and
 * compatibility routes is `packages/docs/src/data/docs-navigation.json`, the
 * same declarative file `astro.config.mjs` and `docs-search.ts` consume. No
 * executable source is read, so comments, string literals, and runtime
 * transformations in the docs site cannot change what is enforced here.
 *
 * Entry counts are capped before any per-entry validation, and the whole
 * document is charged against the shared parser budget before it is parsed.
 */
import { err, ok, Result } from "neverthrow";
import {
  consumeParserWork,
  type DeterministicDocsCheckError,
  ensureParserInput,
  type ParserBudget,
  parseFailure,
} from "./contract.js";

/** Structural caps applied before per-entry validation. */
export const DOCS_NAVIGATION_LIMITS = {
  groups: 32,
  routesPerGroup: 256,
  sidebarRoutes: 512,
  searchEntries: 512,
  compatibilityRoutes: 512,
  routeChars: 160,
  labelChars: 64,
  textChars: 256,
} as const;

export const DOCS_NAVIGATION_SCHEMA_VERSION = 1 as const;

/** Route pattern: lowercase, hyphen-separated segments rooted at `docs`. */
const ROUTE_PATTERN = /^docs(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export interface DocsNavigationContract {
  readonly sidebarRoutes: ReadonlySet<string>;
  readonly searchRoutes: ReadonlySet<string>;
  readonly compatibilityRoutes: ReadonlySet<string>;
}

/**
 * Parse and validate the declarative navigation contract. Returns a typed
 * failure for malformed data, duplicate routes, and routes that are both
 * navigated and declared as compatibility routes.
 */
export function parseDocsNavigation(
  text: string | undefined,
  path: string,
  budget: ParserBudget,
): Result<DocsNavigationContract, DeterministicDocsCheckError> {
  if (text === undefined)
    return err(
      parseFailure(path, "malformed-input", "navigation data is missing"),
    );
  const capacity = ensureParserInput(budget, path, text.length);
  if (capacity.isErr()) return err(capacity.error);
  const charged = consumeParserWork(budget, path, text.length);
  if (charged.isErr()) return err(charged.error);

  const parsed = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => parseFailure(path, "malformed-input", "navigation data is not JSON"),
  )();
  if (parsed.isErr()) return err(parsed.error);

  const root = parsed.value;
  if (!isRecord(root))
    return err(
      parseFailure(path, "malformed-input", "navigation data is not an object"),
    );
  if (root.schemaVersion !== DOCS_NAVIGATION_SCHEMA_VERSION)
    return err(
      parseFailure(path, "malformed-input", "unsupported navigation schema"),
    );

  const sidebar = readSidebarRoutes(root.sidebar, path);
  if (sidebar.isErr()) return err(sidebar.error);
  const search = readSearchRoutes(root.search, path);
  if (search.isErr()) return err(search.error);
  const compatibility = readRouteList(
    root.compatibilityRoutes,
    path,
    DOCS_NAVIGATION_LIMITS.compatibilityRoutes,
    "compatibilityRoutes",
  );
  if (compatibility.isErr()) return err(compatibility.error);

  for (const route of compatibility.value)
    if (sidebar.value.has(route) || search.value.has(route))
      return err(
        parseFailure(
          path,
          "conflicting-input",
          `route ${route} is navigated and a compatibility route`,
        ),
      );

  return ok({
    sidebarRoutes: sidebar.value,
    searchRoutes: search.value,
    compatibilityRoutes: compatibility.value,
  });
}

function readSidebarRoutes(
  value: unknown,
  path: string,
): Result<ReadonlySet<string>, DeterministicDocsCheckError> {
  if (!Array.isArray(value))
    return err(
      parseFailure(path, "malformed-input", "sidebar is not an array"),
    );
  if (value.length > DOCS_NAVIGATION_LIMITS.groups)
    return err(
      parseFailure(path, "malformed-input", "too many sidebar groups"),
    );

  const routes = new Set<string>();
  for (const group of value) {
    if (!isRecord(group))
      return err(
        parseFailure(path, "malformed-input", "sidebar group is not an object"),
      );
    const label = group.label;
    if (
      typeof label !== "string" ||
      label.length === 0 ||
      label.length > DOCS_NAVIGATION_LIMITS.labelChars
    )
      return err(
        parseFailure(path, "malformed-input", "sidebar label is not bounded"),
      );
    const groupRoutes = readRouteList(
      group.routes,
      path,
      DOCS_NAVIGATION_LIMITS.routesPerGroup,
      `sidebar group ${label}`,
    );
    if (groupRoutes.isErr()) return err(groupRoutes.error);
    for (const route of groupRoutes.value) {
      if (routes.has(route))
        return err(
          parseFailure(
            path,
            "repeated-input",
            `sidebar route ${route} occurs more than once`,
          ),
        );
      routes.add(route);
      if (routes.size > DOCS_NAVIGATION_LIMITS.sidebarRoutes)
        return err(
          parseFailure(path, "malformed-input", "too many sidebar routes"),
        );
    }
  }
  return ok(routes);
}

function readSearchRoutes(
  value: unknown,
  path: string,
): Result<ReadonlySet<string>, DeterministicDocsCheckError> {
  if (!Array.isArray(value))
    return err(parseFailure(path, "malformed-input", "search is not an array"));
  if (value.length > DOCS_NAVIGATION_LIMITS.searchEntries)
    return err(
      parseFailure(path, "malformed-input", "too many search entries"),
    );

  const routes = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry))
      return err(
        parseFailure(path, "malformed-input", "search entry is not an object"),
      );
    const route = readRoute(entry.route, path, "search entry");
    if (route.isErr()) return err(route.error);
    for (const field of ["group", "title", "subtitle", "icon"]) {
      const text = entry[field];
      if (
        typeof text !== "string" ||
        text.length === 0 ||
        text.length > DOCS_NAVIGATION_LIMITS.textChars
      )
        return err(
          parseFailure(
            path,
            "malformed-input",
            `search entry ${field} is not bounded text`,
          ),
        );
    }
    if (routes.has(route.value))
      return err(
        parseFailure(
          path,
          "repeated-input",
          `search route ${route.value} occurs more than once`,
        ),
      );
    routes.add(route.value);
  }
  return ok(routes);
}

function readRouteList(
  value: unknown,
  path: string,
  limit: number,
  label: string,
): Result<ReadonlySet<string>, DeterministicDocsCheckError> {
  if (!Array.isArray(value))
    return err(
      parseFailure(path, "malformed-input", `${label} is not an array`),
    );
  if (value.length > limit)
    return err(parseFailure(path, "malformed-input", `${label} is too large`));
  const routes = new Set<string>();
  for (const entry of value) {
    const route = readRoute(entry, path, label);
    if (route.isErr()) return err(route.error);
    if (routes.has(route.value))
      return err(
        parseFailure(
          path,
          "repeated-input",
          `${label} route ${route.value} occurs more than once`,
        ),
      );
    routes.add(route.value);
  }
  return ok(routes);
}

function readRoute(
  value: unknown,
  path: string,
  label: string,
): Result<string, DeterministicDocsCheckError> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > DOCS_NAVIGATION_LIMITS.routeChars ||
    !ROUTE_PATTERN.test(value)
  )
    return err(
      parseFailure(
        path,
        "malformed-input",
        `${label} has an invalid route value`,
      ),
    );
  return ok(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
