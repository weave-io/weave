/**
 * Bounded docs-tree loading and validation.
 *
 * Every read reserves its budget before the bytes are pulled in, and an
 * in-memory tree supplied by a caller is revalidated against the same bounds
 * before evaluation. Nothing here interprets documentation policy.
 */
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { PUBLIC_PACKAGES } from "../constants.js";
import { publishablePackageNames } from "../package-policy.js";
import {
  boundFailure,
  DETERMINISTIC_DOCS_LIMITS,
  type DeterministicDocsCheckError,
  normalizeRel,
  parseFailure,
} from "./contract.js";
import {
  DOCS_AUDIT_LIMITS,
  DOCS_SITE_ASTRO_CONFIG,
  DOCS_SITE_CONTENT_ROOT,
  DOCS_SITE_NAVIGATION_DATA,
  REQUIRED_ROOT_README,
  REQUIRED_TARBALL_DOC_FILES,
} from "./policy.js";

export type DocsTree = Readonly<Record<string, string>>;

export interface LoadedDocsTree {
  readonly rootMissing: boolean;
  readonly files: DocsTree;
}

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

interface CollectionBudget {
  fileCount: number;
  aggregateBytes: number;
  parserBytes: number;
}

/** Files whose text is handed to a structural parser. */
export function isParserInputPath(path: string): boolean {
  return (
    path === DOCS_SITE_NAVIGATION_DATA ||
    path.endsWith("/package.json") ||
    path === "package.json"
  );
}

export async function collectDocsTree(
  contentRoot: string,
): Promise<Result<LoadedDocsTree, DeterministicDocsCheckError>> {
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
  const navigation = await addTreeFile(
    contentRoot,
    DOCS_SITE_NAVIGATION_DATA,
    files,
    budget,
  );
  if (navigation.isErr()) return err(navigation.error);
  for (const packageName of publishablePackageNames()) {
    const directory = PUBLIC_PACKAGES[packageName].directory;
    const manifest = await addTreeFile(
      contentRoot,
      `${directory}/package.json`,
      files,
      budget,
    );
    if (manifest.isErr()) return err(manifest.error);
    for (const doc of REQUIRED_TARBALL_DOC_FILES) {
      const read = await addTreeFile(
        contentRoot,
        `${directory}/${doc}`,
        files,
        budget,
      );
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
  if (
    actualBytes > DETERMINISTIC_DOCS_LIMITS.perFileBytes ||
    actualBytes > fileBytes
  )
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

/** Re-apply the read bounds to a tree that a caller supplied in memory. */
export function validateDocsTreeBounds(
  files: DocsTree,
): Result<void, DeterministicDocsCheckError> {
  let fileCount = 0;
  let aggregateBytes = 0;
  let parserBytes = 0;
  for (const path of ownPaths(files)) {
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

/** Own, enumerable paths of a supplied tree, in insertion order. */
export function ownPaths(files: DocsTree): readonly string[] {
  const paths: string[] = [];
  for (const path in files)
    if (Object.prototype.propertyIsEnumerable.call(files, path))
      paths.push(path);
  return paths;
}

/** Canonical route slugs for every docs-site content page in the tree. */
export function contentPageSlugs(files: DocsTree): Set<string> {
  const slugs = new Set<string>();
  const prefix = `${DOCS_SITE_CONTENT_ROOT}/`;
  for (const path of ownPaths(files)) {
    if (!path.startsWith(prefix)) continue;
    if (!path.endsWith(".md") && !path.endsWith(".mdx")) continue;
    const relative = path.slice(prefix.length).replace(/\.(md|mdx)$/, "");
    const slug = relative.replace(/\/index$/, "");
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

/** Best-effort content path for a slug, used only for issue reporting. */
export function slugToContentPath(slug: string, files: DocsTree): string {
  const candidates = [
    `${DOCS_SITE_CONTENT_ROOT}/${slug}.mdx`,
    `${DOCS_SITE_CONTENT_ROOT}/${slug}.md`,
    `${DOCS_SITE_CONTENT_ROOT}/${slug}/index.mdx`,
    `${DOCS_SITE_CONTENT_ROOT}/${slug}/index.md`,
  ];
  const fallback = `${DOCS_SITE_CONTENT_ROOT}/${slug}.mdx`;
  return candidates.find((path) => files[path] !== undefined) ?? fallback;
}
