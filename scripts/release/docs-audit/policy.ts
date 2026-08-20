/**
 * Explicit docs-audit policy given to the headless agent and enforced by
 * the controller. Blocking kinds are closed; style never blocks; patches
 * may only target the docs/README allowlist.
 */
import { PUBLIC_PACKAGES } from "../constants.js";

/** Version of the controller-owned docs-audit policy text. */
export const DOCS_AUDIT_POLICY_VERSION = 1 as const;

export const DOCS_AUDIT_SEVERITIES = ["block", "warn"] as const;
export type DocsAuditSeverity = (typeof DOCS_AUDIT_SEVERITIES)[number];

/** Evidence-backed kinds that may fail the docs-audit gate. */
export const DOCS_AUDIT_BLOCKING_KINDS = [
  "factual-contradiction",
  "missing-required",
  "undocumented-public-behavior",
] as const;
export type DocsAuditBlockingKind = (typeof DOCS_AUDIT_BLOCKING_KINDS)[number];

/** Style is advisory. It must never be submitted as `block`. */
export const DOCS_AUDIT_WARNING_KINDS = ["style"] as const;
export type DocsAuditWarningKind = (typeof DOCS_AUDIT_WARNING_KINDS)[number];

export const DOCS_AUDIT_KINDS = [
  ...DOCS_AUDIT_BLOCKING_KINDS,
  ...DOCS_AUDIT_WARNING_KINDS,
] as const;
export type DocsAuditKind = (typeof DOCS_AUDIT_KINDS)[number];

/** Docs-site content collection root, relative to the caller content root. */
export const DOCS_SITE_CONTENT_ROOT = "packages/docs/src/content/docs" as const;
export const DOCS_SITE_SEARCH_DATA =
  "packages/docs/src/data/docs-search.ts" as const;
export const DOCS_SITE_ASTRO_CONFIG = "packages/docs/astro.config.mjs" as const;

/**
 * Declarative navigation contract shared by the docs site and the release-time
 * deterministic checker. This data file — never the Astro config or the search
 * module — is the authority for navigated, searchable, and compatibility
 * routes.
 */
export const DOCS_SITE_NAVIGATION_DATA =
  "packages/docs/src/data/docs-navigation.json" as const;

/** Required documentation files that ship with public packages or the repo. */
export const REQUIRED_ROOT_README = "README.md" as const;
export const REQUIRED_DOCS_INDEX = "docs/README.md" as const;
export const REQUIRED_TARBALL_DOC_FILES = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
] as const;

export const DOCS_PATCH_ALLOWLIST_PREFIXES = [
  "docs/",
  "packages/docs/src/",
] as const;

const PACKAGE_README_PATHS: readonly string[] = [
  "packages/docs/README.md",
  ...Object.values(PUBLIC_PACKAGES).map(
    (entry) => `${entry.directory}/README.md`,
  ),
];

export const DOCS_AUDIT_LIMITS = {
  promptBytes: 64 * 1024,
  retryErrorBytes: 4 * 1024,
  attempts: 2,
  findings: 32,
  patches: 16,
  claimChars: 2_000,
  pathChars: 256,
  excerptChars: 4_096,
  jsonBytes: 256 * 1024,
  issues: 32,
  issuePathChars: 160,
  issueCodeChars: 64,
  readBytes: 256 * 1024,
  grepMatches: 64,
  grepPatternChars: 256,
  listEntries: 256,
  globChars: 256,
  diffBytes: 64 * 1024,
  diffLines: 512,
} as const;

export interface DocsAuditIssue {
  code: string;
  path: string;
}

export interface DocsAuditEvidence {
  readonly path: string;
  readonly excerpt: string;
  readonly excerptDigest: string;
}

export interface DocsAuditFinding {
  readonly severity: DocsAuditSeverity;
  readonly kind: DocsAuditKind;
  readonly evidence: DocsAuditEvidence;
  readonly claim: string;
}

export function isBlockingKind(kind: string): kind is DocsAuditBlockingKind {
  return (DOCS_AUDIT_BLOCKING_KINDS as readonly string[]).includes(kind);
}

export function isWarningKind(kind: string): kind is DocsAuditWarningKind {
  return (DOCS_AUDIT_WARNING_KINDS as readonly string[]).includes(kind);
}

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > DOCS_AUDIT_LIMITS.pathChars)
    return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0"))
    return false;
  return path
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function publicPackageReadmePaths(): readonly string[] {
  return PACKAGE_README_PATHS.filter(
    (path) => path !== "packages/docs/README.md",
  );
}

export function allowedPackageReadmePaths(): readonly string[] {
  return PACKAGE_README_PATHS;
}

/**
 * Fail-closed patch allowlist: docs tree, docs-site sources, and READMEs.
 * Workflows, scripts, and product source are never legal targets.
 */
export function isAllowedDocsPatchPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (path === REQUIRED_ROOT_README) return true;
  if (path === REQUIRED_DOCS_INDEX) return true;
  if (PACKAGE_README_PATHS.includes(path)) return true;
  for (const prefix of DOCS_PATCH_ALLOWLIST_PREFIXES)
    if (path.startsWith(prefix)) return true;
  return false;
}

/** Policy text injected into the docs-audit prompt. */
export function docsAuditPolicyText(): string {
  return [
    `DOCS_AUDIT_POLICY_VERSION ${DOCS_AUDIT_POLICY_VERSION}`,
    "Audit public Weave documentation against shipped behavior.",
    "Surfaces: docs site, root and package READMEs, CLI help, examples,",
    "migration guidance, and npm tarball docs (README/CHANGELOG/LICENSE).",
    "You may only use read, grep, find, and ls inside the supplied content root.",
    "You have no bash, edit, write, persistence, skills, extensions, templates,",
    "themes, or global settings.",
    "Submit exactly once with the submit_docs_audit tool.",
    "Blocking kinds (severity block only): factual-contradiction,",
    "missing-required, undocumented-public-behavior.",
    "Each blocking finding needs resolvable evidence {path, excerpt, excerptDigest}.",
    "The excerpt must occur in the file at path; excerptDigest is sha256 of the excerpt.",
    "Style findings use severity warn and kind style. Style must never block.",
    "Do not invent files, paths, or excerpts. Claims must be factual.",
    "Optional patch proposals are unified diffs targeting only docs/, README files,",
    "packages/docs/src, and package READMEs. Never workflows, scripts, or source.",
  ].join("\n");
}
