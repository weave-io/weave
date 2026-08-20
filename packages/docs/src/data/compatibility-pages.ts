/**
 * Exact route inventory for documentation pages that remain available for
 * existing links but are intentionally absent from public navigation.
 *
 * Keep this list explicit. A new page is not a compatibility page because it
 * shares a directory with one of these routes. Astro navigation and the
 * release-time deterministic checker both consume this inventory.
 */
export const COMPATIBILITY_DOC_ROUTES = [
  "docs/explanation/architecture",
  "docs/explanation/config-merge-model",
  "docs/explanation/engine-adapter-boundary",
  "docs/explanation/model-intent-vs-selection",
  "docs/explanation/prompt-composition-design",
  "docs/explanation/public-vs-internal-docs",
  "docs/explanation/runtime-and-journal-design",
  "docs/explanation/tool-policy-design",
  "docs/explanation/what-is-weave",
  "docs/explanation/workflow-execution-model",
  "docs/guides/configuration",
  "docs/guides/core-concepts",
  "docs/guides/installation",
  "docs/how-to/add-custom-agent",
  "docs/how-to/configure-model-preferences",
  "docs/how-to/configure-prompt-appends",
  "docs/how-to/configure-tool-policy",
  "docs/how-to/create-category-shuttle",
  "docs/how-to/customize-builtin-agent",
  "docs/how-to/deploy-docs-to-github-pages",
  "docs/how-to/extend-workflows",
  "docs/how-to/initialize-config",
  "docs/how-to/inspect-prompts",
  "docs/how-to/inspect-runtime-state",
  "docs/how-to/install-and-build",
  "docs/how-to/maintain-public-docs",
  "docs/how-to/migrate-legacy-opencode-config",
  "docs/how-to/validate-config",
  "docs/reference/adapters/claude-code",
  "docs/reference/adapters/opencode",
  "docs/reference/adapters/pi",
  "docs/reference/config-loading-and-merge",
  "docs/reference/deployment",
  "docs/reference/dsl/agents",
  "docs/reference/dsl/categories",
  "docs/reference/dsl/settings-and-disables",
  "docs/reference/dsl/syntax",
  "docs/reference/dsl/workflow-extension",
  "docs/reference/dsl/workflows",
  "docs/reference/execution-lifecycle",
  "docs/reference/model-resolution",
  "docs/reference/prompt-composition",
  "docs/reference/runtime-commands",
  "docs/reference/runtime-store-and-journal",
  "docs/reference/tool-policy",
  "docs/tutorials/first-explicit-execution",
  "docs/tutorials/opencode-plugin",
  "docs/tutorials/quickstart",
] as const;

const compatibilityRouteSet = new Set<string>(COMPATIBILITY_DOC_ROUTES);

export function isCompatibilityDocRoute(route: string): boolean {
  return compatibilityRouteSet.has(route);
}

/** Remove compatibility routes before handing route lists to Astro. */
export function withoutCompatibilityDocRoutes(
  routes: readonly string[],
): string[] {
  return routes.filter((route) => !isCompatibilityDocRoute(route));
}
