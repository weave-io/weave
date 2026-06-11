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
export type DocsSearchGroup =
  | "Pages"
  | "Tutorials"
  | "How-to"
  | "Reference"
  | "Explanation";

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
    group: "Pages",
    title: "Weave Documentation",
    subtitle: "docs home · Diataxis map",
    href: "docs/",
    icon: "page",
  },
  {
    group: "Tutorials",
    title: "Quickstart",
    subtitle: "create and validate .weave config",
    href: "docs/tutorials/quickstart/",
    icon: "page",
  },
  {
    group: "Tutorials",
    title: "OpenCode Plugin",
    subtitle: "implemented adapter setup",
    href: "docs/tutorials/opencode-plugin/",
    icon: "page",
  },
  {
    group: "Tutorials",
    title: "First Explicit Execution",
    subtitle: "adapter-native workflow start",
    href: "docs/tutorials/first-explicit-execution/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Install and Build",
    subtitle: "Bun commands",
    href: "docs/how-to/install-and-build/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Initialize Config",
    subtitle: "global and project config",
    href: "docs/how-to/initialize-config/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Migrate Legacy OpenCode Config",
    subtitle: "weave-opencode.jsonc to .weave",
    href: "docs/how-to/migrate-legacy-opencode-config/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Validate Config",
    subtitle: "project global explicit effective",
    href: "docs/how-to/validate-config/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Inspect Prompts",
    subtitle: "prompt list and inspect",
    href: "docs/how-to/inspect-prompts/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Customize Builtin Agent",
    subtitle: "override builtins",
    href: "docs/how-to/customize-builtin-agent/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Add Custom Agent",
    subtitle: "agent block recipe",
    href: "docs/how-to/add-custom-agent/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Create Category Shuttle",
    subtitle: "generated shuttle agents",
    href: "docs/how-to/create-category-shuttle/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Configure Prompt Appends",
    subtitle: "agent category workflow step",
    href: "docs/how-to/configure-prompt-appends/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Configure Tool Policy",
    subtitle: "abstract capabilities",
    href: "docs/how-to/configure-tool-policy/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Configure Model Preferences",
    subtitle: "ordered model intent",
    href: "docs/how-to/configure-model-preferences/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Extend Workflows",
    subtitle: "extends insert_before insert_after",
    href: "docs/how-to/extend-workflows/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Inspect Runtime State",
    subtitle: "status and journal",
    href: "docs/how-to/inspect-runtime-state/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Deploy Docs to GitHub Pages",
    subtitle: "docs workflow and BASE_PATH",
    href: "docs/how-to/deploy-docs-to-github-pages/",
    icon: "page",
  },
  {
    group: "How-to",
    title: "Maintain Public Docs",
    subtitle: "source of truth and validation",
    href: "docs/how-to/maintain-public-docs/",
    icon: "page",
  },
  {
    group: "Reference",
    title: "CLI Reference",
    subtitle: "init validate prompt runtime run",
    href: "docs/reference/cli/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "DSL Syntax",
    subtitle: "top-level forms and values",
    href: "docs/reference/dsl/syntax/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "DSL Agents",
    subtitle: "agent fields and builtins",
    href: "docs/reference/dsl/agents/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "DSL Categories",
    subtitle: "category shuttles",
    href: "docs/reference/dsl/categories/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "DSL Workflows",
    subtitle: "steps and completion methods",
    href: "docs/reference/dsl/workflows/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Settings and Disables",
    subtitle: "log level runtime journal disables",
    href: "docs/reference/dsl/settings-and-disables/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Workflow Extension",
    subtitle: "extends and before-plan",
    href: "docs/reference/dsl/workflow-extension/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Config Loading and Merge",
    subtitle: "builtins global project merge",
    href: "docs/reference/config-loading-and-merge/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Prompt Composition",
    subtitle: "templates descriptors appends",
    href: "docs/reference/prompt-composition/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Tool Policy",
    subtitle: "allow deny ask capabilities",
    href: "docs/reference/tool-policy/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Model Resolution",
    subtitle: "intent priority and adapter context",
    href: "docs/reference/model-resolution/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Execution Lifecycle",
    subtitle: "lifecycle methods and effects",
    href: "docs/reference/execution-lifecycle/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Runtime Store and Journal",
    subtitle: "weave.db and sanitized output",
    href: "docs/reference/runtime-store-and-journal/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Runtime Commands",
    subtitle: "command operations and labels",
    href: "docs/reference/runtime-commands/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Adapters",
    subtitle: "adapter support status",
    href: "docs/reference/adapters/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "OpenCode Adapter",
    subtitle: "plugin and command surfaces",
    href: "docs/reference/adapters/opencode/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Packages",
    subtitle: "workspace package responsibilities",
    href: "docs/reference/packages/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Deployment",
    subtitle: "GitHub Pages docs deploy",
    href: "docs/reference/deployment/",
    icon: "spec",
  },
  {
    group: "Explanation",
    title: "What Is Weave?",
    subtitle: "harness-agnostic config API",
    href: "docs/explanation/what-is-weave/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Architecture",
    subtitle: "core config engine adapters",
    href: "docs/explanation/architecture/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Engine and Adapter Boundary",
    subtitle: "ownership rules",
    href: "docs/explanation/engine-adapter-boundary/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Config Merge Model",
    subtitle: "why layering works this way",
    href: "docs/explanation/config-merge-model/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Prompt Composition Design",
    subtitle: "bounded templates",
    href: "docs/explanation/prompt-composition-design/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Workflow Execution Model",
    subtitle: "explicit user-authorized execution",
    href: "docs/explanation/workflow-execution-model/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Runtime and Journal Design",
    subtitle: "durable state and safety",
    href: "docs/explanation/runtime-and-journal-design/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Model Intent vs Selection",
    subtitle: "preferences not availability",
    href: "docs/explanation/model-intent-vs-selection/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Tool Policy Design",
    subtitle: "abstract capabilities",
    href: "docs/explanation/tool-policy-design/",
    icon: "page",
  },
  {
    group: "Explanation",
    title: "Public vs Internal Docs",
    subtitle: "current support vs future specs",
    href: "docs/explanation/public-vs-internal-docs/",
    icon: "page",
  },
];
