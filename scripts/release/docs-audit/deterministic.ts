/**
 * Deterministic docs checker: local links, navigation/search coverage, and
 * README/tarball docs inventory.
 *
 * The checker never reads PR-controlled executable source for authority.
 * Navigation, palette search, and compatibility routes all come from the
 * checked-in declarative contract in `packages/docs/src/data/docs-navigation.json`,
 * which the docs site consumes directly. Loading and bounds live in `tree.ts`,
 * navigation validation in `navigation.ts`, link work in `links.ts`, and the
 * shared shapes in `contract.ts`. This module holds only orchestration and
 * documentation policy.
 */
import { err, ok, Result, ResultAsync } from "neverthrow";
import { PUBLIC_PACKAGES, type PublicPackageName } from "../constants.js";
import { publishablePackageNames } from "../package-policy.js";
import {
  boundText,
  buildResult,
  consumeParserWork,
  createParserBudget,
  type DeterministicDocsCheckError,
  type DeterministicDocsCheckResult,
  type DeterministicDocsIssue,
  failureResult,
  type ParserBudget,
} from "./contract.js";
import { collectLinkIssues } from "./links.js";
import { parseDocsNavigation } from "./navigation.js";
import {
  DOCS_SITE_NAVIGATION_DATA,
  REQUIRED_ROOT_README,
  REQUIRED_TARBALL_DOC_FILES,
} from "./policy.js";
import {
  collectDocsTree,
  contentPageSlugs,
  type DocsTree,
  slugToContentPath,
  validateDocsTreeBounds,
} from "./tree.js";

export {
  canonicalJson,
  DETERMINISTIC_DOCS_CHECK_VERSION,
  DETERMINISTIC_DOCS_LIMITS,
  type DeterministicDocsBound,
  type DeterministicDocsCheckError,
  type DeterministicDocsCheckResult,
  type DeterministicDocsIssue,
  type DeterministicDocsIssueKind,
  type DeterministicDocsParseReason,
  docsAuditBytesDigest,
  docsAuditDigest,
} from "./contract.js";

export function runDeterministicDocsCheck(
  contentRoot: string,
): ResultAsync<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  const loaded = ResultAsync.fromPromise(
    collectDocsTree(contentRoot),
    (cause): DeterministicDocsCheckError => ({
      type: "DeterministicDocsIoFailed",
      path: contentRoot,
      message: boundText(String(cause), 256),
    }),
  );
  return loaded.andThen((treeResult) =>
    treeResult.andThen((tree) => {
      if (tree.rootMissing)
        return err<DeterministicDocsCheckResult, DeterministicDocsCheckError>({
          type: "DeterministicDocsRootInvalid",
          path: contentRoot,
        });
      return evaluateTree(tree.files);
    }),
  );
}

/**
 * Evaluate an already loaded tree while preserving typed input failures.
 * Production callers should prefer `runDeterministicDocsCheck`, which applies
 * the read bounds before loading files.
 */
export function evaluateDeterministicDocsTreeSafe(
  files: DocsTree,
): Result<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  return evaluateTree(files);
}

/** Backwards-compatible value API for fixture and unit-test callers. */
export function evaluateDeterministicDocsTree(
  files: DocsTree,
): DeterministicDocsCheckResult {
  const result = evaluateDeterministicDocsTreeSafe(files);
  if (result.isOk()) return result.value;
  return failureResult(result.error);
}

function evaluateTree(
  files: DocsTree,
): Result<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  const bounded = validateDocsTreeBounds(files);
  if (bounded.isErr()) return err(bounded.error);

  const issues: DeterministicDocsIssue[] = [];
  const parserBudget = createParserBudget();
  const links = collectLinkIssues(files, issues);
  if (links.isErr()) return err(links.error);
  const navigation = collectNavigationIssues(files, issues, parserBudget);
  if (navigation.isErr()) return err(navigation.error);
  const inventory = collectInventoryIssues(files, issues, parserBudget);
  if (inventory.isErr()) return err(inventory.error);
  return ok(buildResult(issues));
}

/**
 * Every public content page must be navigated and searchable unless it is an
 * exact declared compatibility route, and every declared route must exist.
 */
function collectNavigationIssues(
  files: DocsTree,
  issues: DeterministicDocsIssue[],
  parserBudget: ParserBudget,
): Result<void, DeterministicDocsCheckError> {
  const contract = parseDocsNavigation(
    files[DOCS_SITE_NAVIGATION_DATA],
    DOCS_SITE_NAVIGATION_DATA,
    parserBudget,
  );
  if (contract.isErr()) return err(contract.error);
  const { sidebarRoutes, searchRoutes, compatibilityRoutes } = contract.value;
  const pages = contentPageSlugs(files);

  for (const slug of pages) {
    if (compatibilityRoutes.has(slug)) continue;
    if (!sidebarRoutes.has(slug))
      issues.push({
        kind: "sidebar-missing-page",
        path: slugToContentPath(slug, files),
        detail: slug,
      });
    if (!searchRoutes.has(slug))
      issues.push({
        kind: "search-missing-page",
        path: slugToContentPath(slug, files),
        detail: slug,
      });
  }
  for (const slug of sidebarRoutes)
    if (!pages.has(slug))
      issues.push({
        kind: "sidebar-unknown-entry",
        path: DOCS_SITE_NAVIGATION_DATA,
        detail: slug,
      });
  for (const slug of searchRoutes)
    if (!pages.has(slug))
      issues.push({
        kind: "search-unknown-entry",
        path: DOCS_SITE_NAVIGATION_DATA,
        detail: slug,
      });
  return ok(undefined);
}

function collectInventoryIssues(
  files: DocsTree,
  issues: DeterministicDocsIssue[],
  parserBudget: ParserBudget,
): Result<void, DeterministicDocsCheckError> {
  const rootReadme = files[REQUIRED_ROOT_README];
  if (rootReadme === undefined)
    issues.push({
      kind: "missing-readme",
      path: REQUIRED_ROOT_README,
      detail: "root",
    });
  else if (!isUsefulReadme(rootReadme))
    issues.push({
      kind: "empty-readme",
      path: REQUIRED_ROOT_README,
      detail: "root",
    });
  for (const packageName of publishablePackageNames()) {
    const inventory = collectPackageInventory(
      packageName,
      files,
      issues,
      parserBudget,
    );
    if (inventory.isErr()) return err(inventory.error);
  }
  return ok(undefined);
}

function collectPackageInventory(
  packageName: PublicPackageName,
  files: DocsTree,
  issues: DeterministicDocsIssue[],
  parserBudget: ParserBudget,
): Result<void, DeterministicDocsCheckError> {
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

  const manifestPath = `${directory}/package.json`;
  const listed = listedTarballDocs(
    files[manifestPath],
    manifestPath,
    parserBudget,
  );
  if (listed.isErr()) return err(listed.error);
  for (const doc of REQUIRED_TARBALL_DOC_FILES) {
    if (!listed.value.includes(doc))
      issues.push({
        kind: "missing-files-entry",
        path: manifestPath,
        detail: doc,
      });
    if (doc === "LICENSE") continue;
    const path = `${directory}/${doc}`;
    if (files[path] === undefined)
      issues.push({ kind: "missing-tarball-doc", path, detail: packageName });
  }
  return ok(undefined);
}

function listedTarballDocs(
  manifestText: string | undefined,
  manifestPath: string,
  parserBudget: ParserBudget,
): Result<readonly string[], DeterministicDocsCheckError> {
  if (manifestText === undefined) return ok([]);
  const work = consumeParserWork(
    parserBudget,
    manifestPath,
    manifestText.length,
  );
  if (work.isErr()) return err(work.error);
  const parsed = Result.fromThrowable(
    () => JSON.parse(manifestText) as { files?: unknown },
    () => undefined,
  )();
  if (parsed.isErr() || parsed.value === undefined) return ok([]);
  const listed = parsed.value.files;
  if (!Array.isArray(listed)) return ok([]);
  return ok(
    listed.filter((entry): entry is string => typeof entry === "string"),
  );
}

function isUsefulReadme(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  return trimmed.length > 0 && /^#\s+\S/m.test(trimmed);
}
