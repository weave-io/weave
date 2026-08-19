import { dirname, extname, normalize, relative, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

export type LinkCheckError = {
  type: "BrokenLocalLink" | "BrokenAnchor";
  source: string;
  target: string;
};

export interface DocumentStore {
  readonly documents: Readonly<Record<string, string>>;
}

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
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const heading = match[1];
    if (heading !== undefined) values.add(slugify(heading));
  }
  return values;
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

export function checkLinks(
  store: DocumentStore,
): Result<void, LinkCheckError[]> {
  const errors: LinkCheckError[] = [];
  for (const [source, text] of Object.entries(store.documents)) {
    if (!shouldCheckDocument(source)) continue;
    for (const match of text.matchAll(
      /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g,
    )) {
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
      if (
        anchor !== undefined &&
        !anchors(store.documents[destination] ?? "").has(anchor)
      ) {
        errors.push({ type: "BrokenAnchor", source, target });
      }
    }
  }
  if (errors.length > 0) return err(errors);
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
  } else {
    logger.error({ errors: result.error }, "Documentation link check failed");
    process.exitCode = 1;
  }
}
