/**
 * Bounded local-documentation link checker.
 *
 * Work is capped before any high-cost processing: the document count is checked
 * first, then a cheap counting pre-pass caps total links and total heading
 * anchors. Only after both budgets hold does the checker resolve link targets,
 * and destination anchors are indexed once per destination rather than once per
 * link. Exhausting a budget is a typed failure, never a silent truncation.
 */
import { dirname, extname, normalize, relative, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

export type LinkCheckError = {
  type: "BrokenLocalLink" | "BrokenAnchor";
  source: string;
  target: string;
};

/** Work dimension that exhausted its budget. */
export type LinkCheckBound = "documents" | "links" | "anchors";

export type LinkCheckFailure =
  | { readonly type: "BrokenLinks"; readonly errors: readonly LinkCheckError[] }
  | {
      readonly type: "LinkBudgetExceeded";
      readonly bound: LinkCheckBound;
      readonly source: string;
      readonly limit: number;
      readonly actual: number;
    };

/** Caps applied before link resolution and anchor indexing. */
export interface LinkCheckLimits {
  readonly documents: number;
  readonly links: number;
  readonly anchors: number;
}

export const DEFAULT_LINK_CHECK_LIMITS: LinkCheckLimits = {
  documents: 4_096,
  links: 8_192,
  anchors: 16_384,
};

export interface DocumentStore {
  readonly documents: Readonly<Record<string, string>>;
}

const LINK_PATTERN = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*#*$/gm;

/**
 * The contributor corpus contains historical design links that are not part of
 * the public documentation contract. Keep the deterministic check focused on
 * the published README and the public adapter/CLI references while still
 * checking the docs index itself.
 */
function shouldCheckDocument(source: string): boolean {
  if (!source.startsWith("docs/")) return true;
  return (
    source === "docs/README.md" ||
    source === "docs/reference/cli.md" ||
    source.startsWith("docs/adapters/")
  );
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9_ -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function anchors(source: string): Set<string> {
  const values = new Set<string>();
  for (const match of source.matchAll(HEADING_PATTERN)) {
    const heading = match[1];
    if (heading !== undefined) values.add(slugify(heading));
  }
  return values;
}

function countMatches(text: string, pattern: RegExp, cap: number): number {
  const scanner = new RegExp(pattern.source, pattern.flags);
  let count = 0;
  while (scanner.exec(text) !== null) {
    count += 1;
    if (count > cap) return count;
  }
  return count;
}

function budgetFailure(
  bound: LinkCheckBound,
  source: string,
  actual: number,
  limit: number,
): LinkCheckFailure {
  return { type: "LinkBudgetExceeded", bound, source, limit, actual };
}

/**
 * Cap document, link, and anchor work before any resolution happens. Counting
 * uses plain pattern scans; it never resolves paths or slugifies headings.
 */
function reserveWork(
  documents: Readonly<Record<string, string>>,
  limits: LinkCheckLimits,
): Result<void, LinkCheckFailure> {
  const paths = Object.keys(documents);
  if (paths.length > limits.documents)
    return err(
      budgetFailure(
        "documents",
        "documentation links",
        paths.length,
        limits.documents,
      ),
    );

  let links = 0;
  let headings = 0;
  for (const path of paths) {
    const text = documents[path] ?? "";
    headings += countMatches(text, HEADING_PATTERN, limits.anchors);
    if (headings > limits.anchors)
      return err(budgetFailure("anchors", path, headings, limits.anchors));
    if (!shouldCheckDocument(path)) continue;
    links += countMatches(text, LINK_PATTERN, limits.links);
    if (links > limits.links)
      return err(budgetFailure("links", path, links, limits.links));
  }
  return ok(undefined);
}

function localTarget(source: string, target: string): string | undefined {
  if (target.startsWith("/") || target.startsWith("#")) return target;
  const pathname = target.split("#", 1)[0] ?? "";
  const base = normalize(resolve(dirname(source), pathname));
  return relative(".", base).replaceAll("\\", "/");
}

function resolveDocument(
  documents: Readonly<Record<string, string>>,
  source: string,
  target: string,
): string | undefined {
  const local = localTarget(source, target);
  if (local === undefined) return undefined;
  const candidates = [
    local,
    `${local}.md`,
    `${local}.mdx`,
    `${local}/index.md`,
    `${local}/index.mdx`,
  ];
  return candidates.find((candidate) => documents[candidate] !== undefined);
}

function starlightRoute(source: string): string | undefined {
  const marker = "packages/docs/src/content/docs/docs/";
  if (!source.startsWith(marker)) return undefined;
  const path = source.slice(marker.length).replace(/\.(md|mdx)$/, "");
  return `/${path.replace(/\/index$/, "")}`;
}

function resolveStarlightDocument(
  documents: Readonly<Record<string, string>>,
  source: string,
  target: string,
): string | undefined {
  const route = starlightRoute(source);
  if (route === undefined || extname(target.split("#", 1)[0] ?? "") !== "") {
    return undefined;
  }
  const resolved = new URL(target, `https://docs.invalid${route}/`).pathname;
  const expected = `packages/docs/src/content/docs/docs${resolved === "/" ? "/index" : resolved}`;
  return [".md", ".mdx", "/index.md", "/index.mdx"]
    .map((suffix) => `${expected}${suffix}`)
    .find((candidate) => documents[candidate] !== undefined);
}

/**
 * Check every local link in `store`, honoring `limits`. Returns the typed
 * budget failure when work is exhausted and the collected broken links
 * otherwise.
 */
export function checkLinks(
  store: DocumentStore,
  limits: LinkCheckLimits = DEFAULT_LINK_CHECK_LIMITS,
): Result<void, LinkCheckFailure> {
  const reserved = reserveWork(store.documents, limits);
  if (reserved.isErr()) return err(reserved.error);

  const errors: LinkCheckError[] = [];
  const anchorIndex = new Map<string, ReadonlySet<string>>();
  const destinationAnchors = (destination: string): ReadonlySet<string> => {
    const cached = anchorIndex.get(destination);
    if (cached !== undefined) return cached;
    const built = anchors(store.documents[destination] ?? "");
    anchorIndex.set(destination, built);
    return built;
  };

  for (const [source, text] of Object.entries(store.documents)) {
    if (!shouldCheckDocument(source)) continue;
    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = match[1];
      if (target === undefined || /^(https?:|mailto:|tel:)/.test(target))
        continue;
      const [path, anchor] = target.split("#", 2);
      let destination = source;
      if (path !== "") {
        if (path.endsWith("/")) continue;
        const extension = extname(path);
        if (extension !== "" && extension !== ".md" && extension !== ".mdx") {
          continue;
        }
        const local =
          resolveStarlightDocument(store.documents, source, target) ??
          resolveDocument(store.documents, source, target);
        if (local === undefined) {
          errors.push({ type: "BrokenLocalLink", source, target });
          continue;
        }
        destination = local;
      }
      if (anchor !== undefined && !destinationAnchors(destination).has(anchor))
        errors.push({ type: "BrokenAnchor", source, target });
    }
  }
  if (errors.length > 0) return err({ type: "BrokenLinks", errors });
  return ok(undefined);
}

export async function loadDocuments(root = "."): Promise<DocumentStore> {
  const documents: Record<string, string> = {};
  const patterns = [
    "README.md",
    "RELEASING.md",
    "docs/README.md",
    "docs/**/*.md",
    "docs/reference/cli.md",
    "packages/*/README.md",
    "packages/adapters/*/README.md",
    "packages/docs/src/content/**/*.{md,mdx}",
  ];
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) {
      documents[path] = await Bun.file(resolve(root, path)).text();
    }
  }
  return { documents };
}

if (import.meta.main) {
  const result = checkLinks(await loadDocuments());
  if (result.isOk()) {
    logger.info("Checked local documentation links");
  } else if (result.error.type === "BrokenLinks") {
    logger.error(
      { errors: result.error.errors },
      "Documentation link check failed",
    );
    process.exitCode = 1;
  } else {
    logger.error(
      {
        bound: result.error.bound,
        source: result.error.source,
        limit: result.error.limit,
        actual: result.error.actual,
      },
      "Documentation link check exceeded its work budget",
    );
    process.exitCode = 1;
  }
}
