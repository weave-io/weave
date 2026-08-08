/** Search entries for the live public documentation routes. */

export type DocsSearchGroup =
  | "Start"
  | "Configure"
  | "Adapters"
  | "Operate"
  | "Reference";
export type DocsSearchIcon = "page" | "spec";

export interface DocsSearchEntry {
  group: DocsSearchGroup;
  title: string;
  subtitle: string;
  /** Root-relative route without the deployment base prefix. */
  href: string;
  icon: DocsSearchIcon;
}

export const docsSearchData: DocsSearchEntry[] = [
  {
    group: "Start",
    title: "Overview",
    subtitle: "Weave's configuration model and documentation map",
    href: "docs/",
    icon: "page",
  },
  {
    group: "Start",
    title: "Quickstart",
    subtitle: "install, initialize, validate, and choose a harness",
    href: "docs/quickstart/",
    icon: "page",
  },
  {
    group: "Start",
    title: "Concepts",
    subtitle: "agents, workflows, scopes, adapters, and intent",
    href: "docs/concepts/",
    icon: "page",
  },
  {
    group: "Configure",
    title: "Configuration",
    subtitle: "scopes, merge order, migration, and validation",
    href: "docs/configuration/",
    icon: "page",
  },
  {
    group: "Configure",
    title: "Agents and categories",
    subtitle: "named roles, domain categories, and shuttles",
    href: "docs/agents-and-categories/",
    icon: "page",
  },
  {
    group: "Configure",
    title: "Prompts, models, and policy",
    subtitle: "prompt composition, model preferences, and permissions",
    href: "docs/prompts-models-policy/",
    icon: "page",
  },
  {
    group: "Configure",
    title: "Workflows",
    subtitle: "ordered steps and completion signals",
    href: "docs/workflows/",
    icon: "page",
  },
  {
    group: "Adapters",
    title: "Support matrix",
    subtitle: "implementation and release status by harness",
    href: "docs/reference/adapters/",
    icon: "spec",
  },
  {
    group: "Adapters",
    title: "OpenCode",
    subtitle: "published plugin setup and commands",
    href: "docs/reference/adapters/opencode/",
    icon: "page",
  },
  {
    group: "Adapters",
    title: "Claude Code",
    subtitle: "compose generated files with the CLI",
    href: "docs/reference/adapters/claude-code/",
    icon: "page",
  },
  {
    group: "Adapters",
    title: "Pi",
    subtitle: "extension installation, health, switching, and commands",
    href: "docs/reference/adapters/pi/",
    icon: "page",
  },
  {
    group: "Operate",
    title: "Runtime inspection",
    subtitle: "status and journal queries",
    href: "docs/runtime-inspection/",
    icon: "page",
  },
  {
    group: "Operate",
    title: "Evals",
    subtitle: "text-only agent behavior suites",
    href: "docs/evals/",
    icon: "page",
  },
  {
    group: "Operate",
    title: "Releases",
    subtitle: "package channels and adapter distribution",
    href: "docs/reference/releases/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "CLI",
    subtitle: "commands, flags, and adapter composition",
    href: "docs/reference/cli/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "DSL",
    subtitle: "supported .weave syntax and fields",
    href: "docs/reference/dsl/",
    icon: "spec",
  },
  {
    group: "Reference",
    title: "Packages",
    subtitle: "public package roles and installation targets",
    href: "docs/reference/packages/",
    icon: "spec",
  },
];
