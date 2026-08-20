/**
 * Deterministic docs checker: local links, sidebar/search coverage, and
 * README/tarball docs inventory.
 *
 * The checker never executes PR-controlled Astro or search source. It uses a
 * bounded structural lexer for the two small data surfaces and an exact,
 * checked-in compatibility inventory shared with the docs site.
 */
import { join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { isCompatibilityDocRoute } from "../../../packages/docs/src/data/compatibility-pages.js";
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

/** Bounds applied before reading or structurally parsing the docs tree. */
export const DETERMINISTIC_DOCS_LIMITS = {
  fileCount: 512,
  perFileBytes: 512 * 1024,
  aggregateBytes: 8 * 1024 * 1024,
  parserWork: 256 * 1024,
} as const;

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
  | "missing-files-entry"
  | "deterministic-input-invalid";

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

export type DeterministicDocsBound =
  | "file-count"
  | "file-bytes"
  | "aggregate-bytes"
  | "parser-work";

export type DeterministicDocsParseReason = "malformed-input" | "repeated-input";

export type DeterministicDocsCheckError =
  | { type: "DeterministicDocsRootInvalid"; path: string }
  | { type: "DeterministicDocsIoFailed"; path: string; message: string }
  | {
      type: "DeterministicDocsBoundExceeded";
      bound: DeterministicDocsBound;
      path: string;
      limit: number;
      actual: number;
    }
  | {
      type: "DeterministicDocsParseFailed";
      path: string;
      reason: DeterministicDocsParseReason;
      detail: string;
    };

const DOCUMENT_GLOBS = [
  "README.md",
  "RELEASING.md",
  "docs/**/*.md",
  "packages/*/README.md",
  "packages/adapters/*/README.md",
  "packages/docs/README.md",
  `${DOCS_SITE_CONTENT_ROOT}/**/*.{md,mdx}`,
] as const;

const textEncoder = new TextEncoder();

export function runDeterministicDocsCheck(
  contentRoot: string,
): ResultAsync<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  const loaded = ResultAsync.fromPromise(
    collectTree(contentRoot),
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
  files: Readonly<Record<string, string>>,
): Result<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  return evaluateTree(files);
}

/** Backwards-compatible value API for fixture and unit-test callers. */
export function evaluateDeterministicDocsTree(
  files: Readonly<Record<string, string>>,
): DeterministicDocsCheckResult {
  const result = evaluateDeterministicDocsTreeSafe(files);
  if (result.isOk()) return result.value;
  return failureResult(result.error);
}

interface LoadedTree {
  readonly rootMissing: boolean;
  readonly files: Record<string, string>;
}

interface CollectionBudget {
  fileCount: number;
  aggregateBytes: number;
  parserBytes: number;
}

interface ParserBudget {
  used: number;
}

async function collectTree(
  contentRoot: string,
): Promise<Result<LoadedTree, DeterministicDocsCheckError>> {
  const rootFile = Bun.file(join(contentRoot, REQUIRED_ROOT_README));
  const rootExists = await rootFile.exists();
  const astro = Bun.file(join(contentRoot, DOCS_SITE_ASTRO_CONFIG));
  const hasAstro = await astro.exists();
  if (!rootExists && !hasAstro) {
    const probe = Bun.file(contentRoot);
    if (!(await probe.exists())) return ok({ rootMissing: true, files: {} });
  }

  const files: Record<string, string> = {};
  const budget: CollectionBudget = {
    fileCount: 0,
    aggregateBytes: 0,
    parserBytes: 0,
  };

  for (const pattern of DOCUMENT_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: contentRoot,
      onlyFiles: true,
      dot: false,
    })) {
      const read = await addTreeFile(contentRoot, path, files, budget);
      if (read.isErr()) return err(read.error);
    }
  }
  for (const extra of [DOCS_SITE_ASTRO_CONFIG, DOCS_SITE_SEARCH_DATA]) {
    const read = await addTreeFile(contentRoot, extra, files, budget);
    if (read.isErr()) return err(read.error);
  }
  for (const packageName of publishablePackageNames()) {
    const directory = PUBLIC_PACKAGES[packageName].directory;
    const manifestPath = `${directory}/package.json`;
    const manifest = await addTreeFile(
      contentRoot,
      manifestPath,
      files,
      budget,
    );
    if (manifest.isErr()) return err(manifest.error);
    for (const doc of REQUIRED_TARBALL_DOC_FILES) {
      const path = `${directory}/${doc}`;
      const read = await addTreeFile(contentRoot, path, files, budget);
      if (read.isErr()) return err(read.error);
    }
  }
  return ok({ rootMissing: false, files });
}

async function addTreeFile(
  contentRoot: string,
  relativePath: string,
  files: Record<string, string>,
  budget: CollectionBudget,
): Promise<Result<void, DeterministicDocsCheckError>> {
  const path = normalizeRel(relativePath);
  if (files[path] !== undefined) return ok(undefined);
  if (path.length === 0 || path.length > DOCS_AUDIT_LIMITS.pathChars)
    return err(
      parseFailure(path, "malformed-input", "file path is not bounded"),
    );

  const file = Bun.file(join(contentRoot, path));
  if (!(await file.exists())) return ok(undefined);
  const fileBytes = file.size;
  const reserved = reserveFile(path, fileBytes, budget);
  if (reserved.isErr()) return err(reserved.error);

  const text = await file.text();
  const actualBytes = textEncoder.encode(text).byteLength;
  if (actualBytes > DETERMINISTIC_DOCS_LIMITS.perFileBytes)
    return err(
      boundFailure(
        "file-bytes",
        path,
        actualBytes,
        DETERMINISTIC_DOCS_LIMITS.perFileBytes,
      ),
    );
  if (actualBytes > fileBytes)
    return err(
      boundFailure(
        "file-bytes",
        path,
        actualBytes,
        DETERMINISTIC_DOCS_LIMITS.perFileBytes,
      ),
    );

  files[path] = text;
  return ok(undefined);
}

function reserveFile(
  path: string,
  fileBytes: number,
  budget: CollectionBudget,
): Result<void, DeterministicDocsCheckError> {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0)
    return err(parseFailure(path, "malformed-input", "file size is invalid"));
  if (fileBytes > DETERMINISTIC_DOCS_LIMITS.perFileBytes)
    return err(
      boundFailure(
        "file-bytes",
        path,
        fileBytes,
        DETERMINISTIC_DOCS_LIMITS.perFileBytes,
      ),
    );
  if (budget.fileCount >= DETERMINISTIC_DOCS_LIMITS.fileCount)
    return err(
      boundFailure(
        "file-count",
        path,
        budget.fileCount + 1,
        DETERMINISTIC_DOCS_LIMITS.fileCount,
      ),
    );
  if (
    budget.aggregateBytes + fileBytes >
    DETERMINISTIC_DOCS_LIMITS.aggregateBytes
  )
    return err(
      boundFailure(
        "aggregate-bytes",
        path,
        budget.aggregateBytes + fileBytes,
        DETERMINISTIC_DOCS_LIMITS.aggregateBytes,
      ),
    );
  if (isParserInputPath(path)) {
    const parserBytes = budget.parserBytes + fileBytes;
    if (parserBytes > DETERMINISTIC_DOCS_LIMITS.parserWork)
      return err(
        boundFailure(
          "parser-work",
          path,
          parserBytes,
          DETERMINISTIC_DOCS_LIMITS.parserWork,
        ),
      );
    budget.parserBytes = parserBytes;
  }

  budget.fileCount += 1;
  budget.aggregateBytes += fileBytes;
  return ok(undefined);
}

function evaluateTree(
  files: Readonly<Record<string, string>>,
): Result<DeterministicDocsCheckResult, DeterministicDocsCheckError> {
  const bounded = validateTreeBounds(files);
  if (bounded.isErr()) return err(bounded.error);

  const issues: DeterministicDocsIssue[] = [];
  const parserBudget: ParserBudget = { used: 0 };
  const links = collectLinkIssues(files, issues);
  if (links.isErr()) return err(links.error);
  const navigation = collectSidebarSearchIssues(files, issues, parserBudget);
  if (navigation.isErr()) return err(navigation.error);
  const inventory = collectInventoryIssues(files, issues, parserBudget);
  if (inventory.isErr()) return err(inventory.error);
  return ok(buildResult(issues));
}

function validateTreeBounds(
  files: Readonly<Record<string, string>>,
): Result<void, DeterministicDocsCheckError> {
  let fileCount = 0;
  let aggregateBytes = 0;
  let parserBytes = 0;
  for (const path in files) {
    if (!Object.prototype.propertyIsEnumerable.call(files, path)) continue;
    fileCount += 1;
    if (fileCount > DETERMINISTIC_DOCS_LIMITS.fileCount)
      return err(
        boundFailure(
          "file-count",
          path,
          fileCount,
          DETERMINISTIC_DOCS_LIMITS.fileCount,
        ),
      );
    const text = files[path];
    if (typeof text !== "string")
      return err(parseFailure(path, "malformed-input", "file is not text"));
    const bytes = textEncoder.encode(text).byteLength;
    if (bytes > DETERMINISTIC_DOCS_LIMITS.perFileBytes)
      return err(
        boundFailure(
          "file-bytes",
          path,
          bytes,
          DETERMINISTIC_DOCS_LIMITS.perFileBytes,
        ),
      );
    aggregateBytes += bytes;
    if (aggregateBytes > DETERMINISTIC_DOCS_LIMITS.aggregateBytes)
      return err(
        boundFailure(
          "aggregate-bytes",
          path,
          aggregateBytes,
          DETERMINISTIC_DOCS_LIMITS.aggregateBytes,
        ),
      );
    if (isParserInputPath(path)) {
      parserBytes += bytes;
      if (parserBytes > DETERMINISTIC_DOCS_LIMITS.parserWork)
        return err(
          boundFailure(
            "parser-work",
            path,
            parserBytes,
            DETERMINISTIC_DOCS_LIMITS.parserWork,
          ),
        );
    }
  }
  return ok(undefined);
}

function collectLinkIssues(
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
): Result<void, DeterministicDocsCheckError> {
  const documents: Record<string, string> = {};
  for (const path in files) {
    if (!Object.prototype.propertyIsEnumerable.call(files, path)) continue;
    const text = files[path];
    if (path.endsWith(".md") || path.endsWith(".mdx")) documents[path] = text;
  }
  const checked = Result.fromThrowable(
    () => checkLinks({ documents }),
    () =>
      parseFailure(
        "documentation links",
        "malformed-input",
        "link parser rejected bounded input",
      ),
  )();
  if (checked.isErr()) return err(checked.error);
  if (checked.value.isOk()) return ok(undefined);
  for (const error of checked.value.error) {
    if (issues.length >= DOCS_AUDIT_LIMITS.issues) break;
    issues.push({
      kind: error.type === "BrokenAnchor" ? "broken-anchor" : "broken-link",
      path: error.source,
      detail: error.target,
    });
  }
  return ok(undefined);
}

function collectSidebarSearchIssues(
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
  parserBudget: ParserBudget,
): Result<void, DeterministicDocsCheckError> {
  const pages = contentPageSlugs(files);
  const sidebar = parseSidebarSlugs(
    files[DOCS_SITE_ASTRO_CONFIG] ?? "",
    DOCS_SITE_ASTRO_CONFIG,
    parserBudget,
  );
  if (sidebar.isErr()) return err(sidebar.error);
  const search = parseSearchSlugs(
    files[DOCS_SITE_SEARCH_DATA] ?? "",
    DOCS_SITE_SEARCH_DATA,
    parserBudget,
  );
  if (search.isErr()) return err(search.error);
  const compatibility = compatibilityPageSlugs(pages);

  for (const slug of pages)
    if (!compatibility.has(slug) && !sidebar.value.has(slug))
      issues.push({
        kind: "sidebar-missing-page",
        path: slugToContentPath(slug, files),
        detail: slug,
      });
  for (const slug of sidebar.value)
    if (!pages.has(slug))
      issues.push({
        kind: "sidebar-unknown-entry",
        path: DOCS_SITE_ASTRO_CONFIG,
        detail: slug,
      });
  for (const slug of pages)
    if (!compatibility.has(slug) && !search.value.has(slug))
      issues.push({
        kind: "search-missing-page",
        path: slugToContentPath(slug, files),
        detail: slug,
      });
  for (const slug of search.value)
    if (!pages.has(slug))
      issues.push({
        kind: "search-unknown-entry",
        path: DOCS_SITE_SEARCH_DATA,
        detail: slug,
      });
  return ok(undefined);
}

function compatibilityPageSlugs(pages: ReadonlySet<string>): Set<string> {
  const compatibility = new Set<string>();
  for (const slug of pages)
    if (isCompatibilityDocRoute(slug)) compatibility.add(slug);
  return compatibility;
}

function collectInventoryIssues(
  files: Readonly<Record<string, string>>,
  issues: DeterministicDocsIssue[],
  parserBudget: ParserBudget,
): Result<void, DeterministicDocsCheckError> {
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
  files: Readonly<Record<string, string>>,
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
  const manifestText = files[manifestPath];
  const listed = listedTarballDocs(manifestText, manifestPath, parserBudget);
  if (listed.isErr()) return err(listed.error);
  for (const doc of REQUIRED_TARBALL_DOC_FILES) {
    if (!listed.value.includes(doc))
      issues.push({
        kind: "missing-files-entry",
        path: manifestPath,
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
  const files = parsed.value.files;
  if (!Array.isArray(files)) return ok([]);
  return ok(
    files.filter((entry): entry is string => typeof entry === "string"),
  );
}

function contentPageSlugs(
  files: Readonly<Record<string, string>>,
): Set<string> {
  const slugs = new Set<string>();
  const prefix = `${DOCS_SITE_CONTENT_ROOT}/`;
  for (const path in files) {
    if (!Object.prototype.propertyIsEnumerable.call(files, path)) continue;
    if (!path.startsWith(prefix)) continue;
    if (!path.endsWith(".md") && !path.endsWith(".mdx")) continue;
    const relative = path.slice(prefix.length).replace(/\.(md|mdx)$/, "");
    const slug = relative.replace(/\/index$/, "");
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

type StructuralTokenKind = "identifier" | "string" | "punctuation" | "other";

interface StructuralToken {
  readonly kind: StructuralTokenKind;
  readonly value: string;
}

function parseSidebarSlugs(
  source: string,
  path: string,
  parserBudget: ParserBudget,
): Result<Set<string>, DeterministicDocsCheckError> {
  const tokens = tokenize(source, path, parserBudget);
  if (tokens.isErr()) return err(tokens.error);
  const properties: number[] = [];
  for (let index = 0; index < tokens.value.length; index += 1) {
    const token = tokens.value[index];
    if (
      token?.kind === "identifier" &&
      token.value === "sidebar" &&
      tokens.value[index + 1]?.value === ":"
    )
      properties.push(index);
  }
  if (properties.length === 0) return ok(new Set<string>());
  if (properties.length > 1)
    return err(
      parseFailure(
        path,
        "repeated-input",
        "sidebar property occurs more than once",
      ),
    );
  const property = properties[0];
  if (property === undefined) return ok(new Set<string>());
  const open = property + 2;
  if (tokens.value[open]?.value !== "[")
    return err(
      parseFailure(path, "malformed-input", "sidebar is not an array"),
    );
  const close = findMatching(tokens.value, open, path, parserBudget);
  if (close.isErr()) return err(close.error);

  const slugs = new Set<string>();
  for (let index = open + 1; index < close.value; index += 1) {
    const work = consumeParserWork(parserBudget, path);
    if (work.isErr()) return err(work.error);
    const token = tokens.value[index];
    if (
      token?.kind !== "identifier" ||
      token.value !== "items" ||
      tokens.value[index + 1]?.value !== ":"
    )
      continue;
    const itemsValue = index + 2;
    let itemsOpen = -1;
    if (tokens.value[itemsValue]?.value === "[") itemsOpen = itemsValue;
    else if (
      tokens.value[itemsValue]?.kind === "identifier" &&
      tokens.value[itemsValue]?.value === "withoutCompatibilityDocRoutes" &&
      tokens.value[itemsValue + 1]?.value === "(" &&
      tokens.value[itemsValue + 2]?.value === "["
    )
      itemsOpen = itemsValue + 2;
    if (itemsOpen < 0)
      return err(
        parseFailure(path, "malformed-input", "items is not an array"),
      );
    const itemsClose = findMatching(
      tokens.value,
      itemsOpen,
      path,
      parserBudget,
    );
    if (itemsClose.isErr()) return err(itemsClose.error);
    const values = directArrayStrings(
      tokens.value,
      itemsOpen,
      itemsClose.value,
      path,
      parserBudget,
    );
    if (values.isErr()) return err(values.error);
    for (const slug of values.value) {
      const normalized = normalizeRoute(slug);
      if (normalized.length > 0) slugs.add(normalized);
    }
  }
  return ok(slugs);
}

function parseSearchSlugs(
  source: string,
  path: string,
  parserBudget: ParserBudget,
): Result<Set<string>, DeterministicDocsCheckError> {
  const tokens = tokenize(source, path, parserBudget);
  if (tokens.isErr()) return err(tokens.error);
  const slugs = new Set<string>();
  for (let index = 0; index + 2 < tokens.value.length; index += 1) {
    const work = consumeParserWork(parserBudget, path);
    if (work.isErr()) return err(work.error);
    if (
      tokens.value[index]?.kind !== "identifier" ||
      tokens.value[index]?.value !== "href" ||
      tokens.value[index + 1]?.value !== ":"
    )
      continue;
    const value = tokens.value[index + 2];
    // The interface declaration contains `href: string`; only object
    // properties with a string literal are coverage entries.
    if (value?.kind !== "string") {
      if (value?.kind === "identifier" && value.value === "string") continue;
      return err(parseFailure(path, "malformed-input", "href is not a string"));
    }
    const slug = normalizeRoute(value.value);
    if (slug.length > 0) slugs.add(slug);
  }
  return ok(slugs);
}

function tokenize(
  source: string,
  path: string,
  parserBudget: ParserBudget,
): Result<readonly StructuralToken[], DeterministicDocsCheckError> {
  const capacity = ensureParserInput(parserBudget, path, source.length);
  if (capacity.isErr()) return err(capacity.error);
  const tokens: StructuralToken[] = [];
  let index = 0;
  while (index < source.length) {
    const work = consumeParserWork(parserBudget, path);
    if (work.isErr()) return err(work.error);
    const character = source[index];
    if (character === undefined) break;
    index += 1;
    if (/\s/.test(character)) continue;

    if (character === "/" && source[index] === "/") {
      const slashWork = consumeParserWork(parserBudget, path);
      if (slashWork.isErr()) return err(slashWork.error);
      index += 1;
      while (index < source.length && source[index] !== "\n") {
        const commentWork = consumeParserWork(parserBudget, path);
        if (commentWork.isErr()) return err(commentWork.error);
        index += 1;
      }
      continue;
    }
    if (character === "/" && source[index] === "*") {
      const starWork = consumeParserWork(parserBudget, path);
      if (starWork.isErr()) return err(starWork.error);
      index += 1;
      let closed = false;
      while (index < source.length) {
        const commentWork = consumeParserWork(parserBudget, path);
        if (commentWork.isErr()) return err(commentWork.error);
        const current = source[index];
        index += 1;
        if (current === "*" && source[index] === "/") {
          const endWork = consumeParserWork(parserBudget, path);
          if (endWork.isErr()) return err(endWork.error);
          index += 1;
          closed = true;
          break;
        }
      }
      if (!closed)
        return err(
          parseFailure(path, "malformed-input", "unterminated comment"),
        );
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const stringValue = readStringToken(
        source,
        index,
        character,
        path,
        parserBudget,
      );
      if (stringValue.isErr()) return err(stringValue.error);
      index = stringValue.value.next;
      tokens.push({ kind: "string", value: stringValue.value.value });
      continue;
    }
    if (isIdentifierStart(character)) {
      let value = character;
      while (index < source.length) {
        const next = source[index];
        if (next === undefined || !isIdentifierPart(next)) break;
        const identifierWork = consumeParserWork(parserBudget, path);
        if (identifierWork.isErr()) return err(identifierWork.error);
        value += next;
        index += 1;
      }
      tokens.push({ kind: "identifier", value });
      continue;
    }
    if ("{}[]():,".includes(character)) {
      tokens.push({ kind: "punctuation", value: character });
      continue;
    }
    tokens.push({ kind: "other", value: character });
  }
  return ok(tokens);
}

function readStringToken(
  source: string,
  start: number,
  quote: string,
  path: string,
  parserBudget: ParserBudget,
): Result<
  { readonly next: number; readonly value: string },
  DeterministicDocsCheckError
> {
  let index = start;
  let value = "";
  while (index < source.length) {
    const work = consumeParserWork(parserBudget, path);
    if (work.isErr()) return err(work.error);
    const character = source[index];
    if (character === undefined) break;
    index += 1;
    if (character === quote) return ok({ next: index, value });
    if (character !== "`" && (character === "\n" || character === "\r"))
      return err(parseFailure(path, "malformed-input", "newline in string"));
    if (character !== "\\") {
      value += character;
      continue;
    }
    if (index >= source.length)
      return err(parseFailure(path, "malformed-input", "unterminated escape"));
    const escapeWork = consumeParserWork(parserBudget, path);
    if (escapeWork.isErr()) return err(escapeWork.error);
    const escaped = source[index];
    if (escaped === undefined) break;
    index += 1;
    value += escaped;
  }
  return err(parseFailure(path, "malformed-input", "unterminated string"));
}

function findMatching(
  tokens: readonly StructuralToken[],
  start: number,
  path: string,
  parserBudget: ParserBudget,
): Result<number, DeterministicDocsCheckError> {
  const expected: string[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    const work = consumeParserWork(parserBudget, path);
    if (work.isErr()) return err(work.error);
    const value = tokens[index]?.value;
    if (value === "[" || value === "{" || value === "(") {
      expected.push(closingDelimiter(value));
      continue;
    }
    if (value !== "]" && value !== "}" && value !== ")") continue;
    if (expected.at(-1) !== value)
      return err(
        parseFailure(path, "malformed-input", "mismatched delimiters"),
      );
    expected.pop();
    if (expected.length === 0) return ok(index);
  }
  return err(parseFailure(path, "malformed-input", "unterminated array"));
}

function directArrayStrings(
  tokens: readonly StructuralToken[],
  open: number,
  close: number,
  path: string,
  parserBudget: ParserBudget,
): Result<readonly string[], DeterministicDocsCheckError> {
  const values: string[] = [];
  const delimiters: string[] = [];
  for (let index = open + 1; index < close; index += 1) {
    const work = consumeParserWork(parserBudget, path);
    if (work.isErr()) return err(work.error);
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.value === "[" || token.value === "{" || token.value === "(") {
      delimiters.push(closingDelimiter(token.value));
      continue;
    }
    if (token.value === "]" || token.value === "}" || token.value === ")") {
      delimiters.pop();
      continue;
    }
    if (delimiters.length === 0 && token.kind === "string")
      values.push(token.value);
  }
  return ok(values);
}

function isParserInputPath(path: string): boolean {
  return (
    path === DOCS_SITE_ASTRO_CONFIG ||
    path === DOCS_SITE_SEARCH_DATA ||
    path.endsWith("/package.json")
  );
}

function ensureParserInput(
  parserBudget: ParserBudget,
  path: string,
  inputLength: number,
): Result<void, DeterministicDocsCheckError> {
  if (inputLength > DETERMINISTIC_DOCS_LIMITS.parserWork - parserBudget.used)
    return err(
      boundFailure(
        "parser-work",
        path,
        parserBudget.used + inputLength,
        DETERMINISTIC_DOCS_LIMITS.parserWork,
      ),
    );
  return ok(undefined);
}

function consumeParserWork(
  parserBudget: ParserBudget,
  path: string,
  units = 1,
): Result<void, DeterministicDocsCheckError> {
  if (units < 0 || !Number.isSafeInteger(units))
    return err(parseFailure(path, "malformed-input", "invalid parser work"));
  if (parserBudget.used > DETERMINISTIC_DOCS_LIMITS.parserWork - units)
    return err(
      boundFailure(
        "parser-work",
        path,
        parserBudget.used + units,
        DETERMINISTIC_DOCS_LIMITS.parserWork,
      ),
    );
  parserBudget.used += units;
  return ok(undefined);
}

function closingDelimiter(opening: string): string {
  if (opening === "[") return "]";
  if (opening === "{") return "}";
  return ")";
}

function isIdentifierStart(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "_" ||
    character === "$"
  );
}

function isIdentifierPart(character: string): boolean {
  const code = character.charCodeAt(0);
  return isIdentifierStart(character) || (code >= 48 && code <= 57);
}

function normalizeRoute(value: string): string {
  const withoutAnchor = value.split("#", 1)[0] ?? "";
  return withoutAnchor.replace(/\/+$/, "");
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

function buildResult(
  issues: readonly DeterministicDocsIssue[],
): DeterministicDocsCheckResult {
  const sorted = [...issues].sort(compareIssue);
  const payload = {
    schemaVersion: DETERMINISTIC_DOCS_CHECK_VERSION,
    passed: sorted.length === 0,
    issues: sorted.slice(0, DOCS_AUDIT_LIMITS.issues).map((issue) => ({
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

function failureResult(
  error: DeterministicDocsCheckError,
): DeterministicDocsCheckResult {
  const path = "path" in error ? error.path : "deterministic docs input";
  return buildResult([
    {
      kind: "deterministic-input-invalid",
      path,
      detail: error.type,
    },
  ]);
}

function boundFailure(
  bound: DeterministicDocsBound,
  path: string,
  actual: number,
  limit: number,
): DeterministicDocsCheckError {
  return {
    type: "DeterministicDocsBoundExceeded",
    bound,
    path: boundText(path, DOCS_AUDIT_LIMITS.pathChars),
    limit,
    actual,
  };
}

function parseFailure(
  path: string,
  reason: DeterministicDocsParseReason,
  detail: string,
): DeterministicDocsCheckError {
  return {
    type: "DeterministicDocsParseFailed",
    path: boundText(path, DOCS_AUDIT_LIMITS.pathChars),
    reason,
    detail: boundText(detail, DOCS_AUDIT_LIMITS.issuePathChars),
  };
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
