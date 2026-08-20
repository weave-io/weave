/**
 * Deterministic docs checker: local links, sidebar/search coverage, and
 * README/tarball docs inventory.
 */
import { join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { checkLinks } from "../../docs/check-links.js";
import {
  NPM_DIGEST_PREFIX,
  PUBLIC_PACKAGES,
  type PublicPackageName,
} from "../constants.js";
import { publishablePackageNames } from "../package-policy.js";
import {
  DOCS_AUDIT_LIMITS,
  DOCS_SITE_ASTRO_CONFIG,
  DOCS_SITE_CONTENT_ROOT,
  DOCS_SITE_SEARCH_DATA,
  REQUIRED_ROOT_README,
  REQUIRED_TARBALL_DOC_FILES,
} from "./policy.js";

export const DETERMINISTIC_DOCS_CHECK_VERSION = 1 as const;

export type DeterministicDocsIssueKind =
  | "broken-link"
  | "broken-anchor"
  | "sidebar-missing-page"
  | "sidebar-unknown-entry"
  | "search-missing-page"
  | "search-unknown-entry"
  | "missing-readme"
  | "missing-tarball-doc"
  | "empty-readme"
  | "missing-files-entry";

export interface DeterministicDocsIssue {
  readonly kind: DeterministicDocsIssueKind;
  readonly path: string;
  readonly detail: string;
}

export interface DeterministicDocsCheckResult {
  readonly schemaVersion: typeof DETERMINISTIC_DOCS_CHECK_VERSION;
  readonly passed: boolean;
  readonly issues: readonly DeterministicDocsIssue[];
  readonly digest: string;
}

export type DeterministicDocsCheckError =
  | { type: "DeterministicDocsRootInvalid"; path: string }
  | { type: "DeterministicDocsIoFailed"; path: string; message: string };

const DOCUMENT_GLOBS = [
  "README.md",
  "RELEASING.md",
  "docs/**/*.md",
  "packages/*/README.md",
  "packages/adapters/*/README.md",
  "packages/docs/README.md",
  `${DOCS_SITE_CONTENT_ROOT}/**/*.{md,mdx}`,
] as const;

/**
 * The checked-in Astro config keeps these legacy route families out of the
 * public sidebar and search index. All other content remains fail-closed:
 * adding a page without navigation coverage is an audit failure.
 */
const COMPATIBILITY_ROUTE_PREFIXES = [
  "docs/explanation/",
  "docs/guides/",
  "docs/how-to/",
  "docs/tutorials/",
] as const;
const COMPATIBILITY_CONTRACT_MARKERS = [
  "compatibility pages",
  "intentionally left out of navigation",
] as const;

export function runDeterministicDocsCheck(
  contentRoot: string,
): ResultAsync<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  return ResultAsync.fromPromise<LoadedTree, DeterministicDocsCheckError>(
    collectTree(contentRoot),
    (cause): DeterministicDocsCheckError => ({
      type: "DeterministicDocsIoFailed",
      path: contentRoot,
      message: String(cause),
    }),
  ).andThen(
    (
      tree,
    ): Result<DeterministicDocsCheckResult, DeterministicDocsCheckError> => {
      if (tree.rootMissing)
        return err<DeterministicDocsCheckResult, DeterministicDocsCheckError>({
          type: "DeterministicDocsRootInvalid",
          path: contentRoot,
        });
      return ok<DeterministicDocsCheckResult, DeterministicDocsCheckError>(
        evaluateTree(tree.files),
      );
    },
  );
}

export function evaluateDeterministicDocsTree(
  files: Readonly<Record<string, string>>,
): DeterministicDocsCheckResult {
  return evaluateTree(files);
}

interface LoadedTree {
  rootMissing: boolean;
  files: Record<string, string>;
}

async function collectTree(contentRoot: string): Promise<LoadedTree> {
  const rootFile = Bun.file(join(contentRoot, REQUIRED_ROOT_README));
  const rootExists = await rootFile.exists();
  const astro = Bun.file(join(contentRoot, DOCS_SITE_ASTRO_CONFIG));
  const hasAstro = await astro.exists();
  if (!rootExists && !hasAstro) {
    const probe = Bun.file(contentRoot);
    if (!(await probe.exists())) return { rootMissing: true, files: {} };
  }
  const files: Record<string, string> = {};
  for (const pattern of DOCUMENT_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: contentRoot,
      onlyFiles: true,
      dot: false,
    })) {
      files[normalizeRel(path)] = await Bun.file(
        join(contentRoot, path),
      ).text();
    }
  }
  for (const extra of [DOCS_SITE_ASTRO_CONFIG, DOCS_SITE_SEARCH_DATA]) {
    const file = Bun.file(join(contentRoot, extra));
    if (await file.exists()) files[extra] = await file.text();
  }
  for (const packageName of publishablePackageNames()) {
    const directory = PUBLIC_PACKAGES[packageName].directory;
    const manifestPath = `${directory}/package.json`;
    const manifest = Bun.file(join(contentRoot, manifestPath));
    if (await manifest.exists()) files[manifestPath] = await manifest.text();
    for (const doc of REQUIRED_TARBALL_DOC_FILES) {
      const path = `${directory}/${doc}`;
      if (files[path] !== undefined) continue;
      const file = Bun.file(join(contentRoot, path));
      if (await file.exists()) files[path] = await file.text();
    }
  }
  return { rootMissing: false, files };
}

function evaluateTree(
  files: Readonly<Record<string, string>>,
): DeterministicDocsCheckResult {
  const issues: DeterministicDocsIssue[] = [];
  collectLinkIssues(files, issues);
  collectSidebarSearchIssues(files, issues);
  collectInventoryIssues(files, issues);
  issues.sort(compareIssue);
  const payload = {
    schemaVersion: DETERMINISTIC_DOCS_CHECK_VERSION,
    passed: issues.length === 0,
    issues: issues.slice(0, DOCS_AUDIT_LIMITS.issues).map((issue) => ({
      ...issue,
      path: boundText(issue.path, DOCS_AUDIT_LIMITS.issuePathChars),
      detail: boundText(issue.detail, DOCS_AUDIT_LIMITS.issuePathChars),
    })),
  };
  return {
    ...payload,
    digest: docsAuditDigest(payload),
  };
}

function collectLinkIssues(
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
): void {
  const documents: Record<string, string> = {};
  for (const [path, text] of Object.entries(files))
    if (path.endsWith(".md") || path.endsWith(".mdx")) documents[path] = text;
  const result = checkLinks({ documents });
  if (result.isOk()) return;
  for (const error of result.error) {
    issues.push({
      kind: error.type === "BrokenAnchor" ? "broken-anchor" : "broken-link",
      path: error.source,
      detail: error.target,
    });
  }
}

function collectSidebarSearchIssues(
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
): void {
  const astro = files[DOCS_SITE_ASTRO_CONFIG] ?? "";
  const pages = contentPageSlugs(files);
  const sidebar = parseSidebarSlugs(astro);
  const search = parseSearchSlugs(files[DOCS_SITE_SEARCH_DATA] ?? "");
  const compatibility = compatibilityPageSlugs(files, astro, sidebar);
  for (const slug of pages)
    if (!compatibility.has(slug) && !sidebar.has(slug))
      issues.push({
        kind: "sidebar-missing-page",
        path: slugToContentPath(slug, files),
        detail: slug,
      });
  for (const slug of sidebar)
    if (!pages.has(slug))
      issues.push({
        kind: "sidebar-unknown-entry",
        path: DOCS_SITE_ASTRO_CONFIG,
        detail: slug,
      });
  for (const slug of pages)
    if (!compatibility.has(slug) && !search.has(slug))
      issues.push({
        kind: "search-missing-page",
        path: slugToContentPath(slug, files),
        detail: slug,
      });
  for (const slug of search)
    if (!pages.has(slug))
      issues.push({
        kind: "search-unknown-entry",
        path: DOCS_SITE_SEARCH_DATA,
        detail: slug,
      });
}

function collectInventoryIssues(
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
): void {
  if (files[REQUIRED_ROOT_README] === undefined)
    issues.push({
      kind: "missing-readme",
      path: REQUIRED_ROOT_README,
      detail: "root",
    });
  else if (!isUsefulReadme(files[REQUIRED_ROOT_README] ?? ""))
    issues.push({
      kind: "empty-readme",
      path: REQUIRED_ROOT_README,
      detail: "root",
    });
  for (const packageName of publishablePackageNames())
    collectPackageInventory(packageName, files, issues);
}

function collectPackageInventory(
  packageName: PublicPackageName,
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
): void {
  const directory = PUBLIC_PACKAGES[packageName].directory;
  const readmePath = `${directory}/README.md`;
  const readme = files[readmePath];
  if (readme === undefined)
    issues.push({
      kind: "missing-readme",
      path: readmePath,
      detail: packageName,
    });
  else if (!isUsefulReadme(readme))
    issues.push({
      kind: "empty-readme",
      path: readmePath,
      detail: packageName,
    });
  const manifestText = files[`${directory}/package.json`];
  const listed = listedTarballDocs(manifestText);
  for (const doc of REQUIRED_TARBALL_DOC_FILES) {
    if (!listed.includes(doc))
      issues.push({
        kind: "missing-files-entry",
        path: `${directory}/package.json`,
        detail: doc,
      });
    const path = `${directory}/${doc}`;
    if (doc === "LICENSE") continue;
    if (files[path] === undefined)
      issues.push({
        kind: "missing-tarball-doc",
        path,
        detail: packageName,
      });
  }
}

function listedTarballDocs(
  manifestText: string | undefined,
): readonly string[] {
  if (manifestText === undefined) return [];
  const parsed = Result.fromThrowable(
    () => JSON.parse(manifestText) as { files?: unknown },
    () => undefined,
  )();
  if (parsed.isErr() || parsed.value === undefined) return [];
  const files = parsed.value.files;
  if (!Array.isArray(files)) return [];
  return files.filter((entry): entry is string => typeof entry === "string");
}

function contentPageSlugs(
  files: Readonly<Record<string, string>>,
): Set<string> {
  const slugs = new Set<string>();
  const prefix = `${DOCS_SITE_CONTENT_ROOT}/`;
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    if (!path.endsWith(".md") && !path.endsWith(".mdx")) continue;
    const relative = path.slice(prefix.length).replace(/\.(md|mdx)$/, "");
    const slug = relative.replace(/\/index$/, "");
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

function parseSidebarSlugs(source: string): Set<string> {
  const slugs = new Set<string>();
  const sidebarStart = source.search(/\bsidebar\s*:\s*/);
  if (sidebarStart < 0) return slugs;
  const sidebar = source.slice(sidebarStart);
  for (const block of sidebar.matchAll(/items\s*:\s*\[([\s\S]*?)\]/g)) {
    const body = block[1] ?? "";
    for (const match of body.matchAll(/['"]([^'"]+)['"]/g)) {
      const slug = match[1];
      if (slug !== undefined && slug.length > 0) slugs.add(slug);
    }
  }
  return slugs;
}

function parseSearchSlugs(source: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of source.matchAll(/href\s*:\s*["']([^"']+)["']/g)) {
    const href = match[1];
    if (href === undefined) continue;
    const slug = href.replace(/\/+$/, "");
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

function compatibilityPageSlugs(
  files: Readonly<Record<string, string>>,
  astro: string,
  sidebar: ReadonlySet<string>,
): Set<string> {
  if (!declaresCompatibilityRoutes(astro)) return new Set<string>();
  const compatibility = new Set<string>();
  for (const slug of contentPageSlugs(files)) {
    const path = slugToContentPath(slug, files);
    const text = files[path] ?? "";
    if (
      hasCompatibilityFrontmatter(text) ||
      COMPATIBILITY_ROUTE_PREFIXES.some((prefix) => slug.startsWith(prefix)) ||
      isUnindexedReferencePage(slug, sidebar)
    )
      compatibility.add(slug);
  }
  return compatibility;
}

function declaresCompatibilityRoutes(source: string): boolean {
  return COMPATIBILITY_CONTRACT_MARKERS.every((marker) =>
    source.includes(marker),
  );
}

function hasCompatibilityFrontmatter(source: string): boolean {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s|$)/);
  return frontmatter?.[1]?.includes("Compatibility route") ?? false;
}

function isUnindexedReferencePage(
  slug: string,
  sidebar: ReadonlySet<string>,
): boolean {
  if (!slug.startsWith("docs/reference/")) return false;
  return [...sidebar].some(
    (entry) =>
      entry.startsWith("docs/reference/") && slug.startsWith(`${entry}/`),
  );
}

function slugToContentPath(
  slug: string,
  files: Readonly<Record<string, string>>,
): string {
  const candidates = [
    `${DOCS_SITE_CONTENT_ROOT}/${slug}.mdx`,
    `${DOCS_SITE_CONTENT_ROOT}/${slug}.md`,
    `${DOCS_SITE_CONTENT_ROOT}/${slug}/index.mdx`,
    `${DOCS_SITE_CONTENT_ROOT}/${slug}/index.md`,
  ];
  const fallback = `${DOCS_SITE_CONTENT_ROOT}/${slug}.mdx`;
  return candidates.find((path) => files[path] !== undefined) ?? fallback;
}

function isUsefulReadme(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  return trimmed.length > 0 && /^#\s+\S/m.test(trimmed);
}

function compareIssue(
  left: DeterministicDocsIssue,
  right: DeterministicDocsIssue,
): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.detail !== right.detail) return left.detail < right.detail ? -1 : 1;
  return 0;
}

function normalizeRel(path: string): string {
  return path.replaceAll("\\", "/");
}

function boundText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function docsAuditDigest(value: unknown): string {
  return docsAuditBytesDigest(canonicalJson(value));
}

export function docsAuditBytesDigest(value: string): string {
  return `${NPM_DIGEST_PREFIX}${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
