/**
 * Ephemeral npm-compatible registry fixture for hermetic tests.
 *
 * Serves GET /:package and GET /:package/:version so the production
 * incident controller can read `deprecated` through ordinary registry
 * HTTP. Mutation of `deprecated` is not exposed here — only the
 * deprecation seam writes that field.
 */
import { readStore, readVersion } from "./store.js";

export interface LocalRegistryServer {
  url: string;
  stop(): void;
}

export function startLocalRegistry(root: string): LocalRegistryServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET")
        return Response.json({ error: "method not allowed" }, { status: 405 });
      const parts = url.pathname.split("/").filter((part) => part.length > 0);
      if (
        parts.length === 1 ||
        (parts.length === 2 && parts[0]?.startsWith("@"))
      ) {
        const name = scopedName(parts);
        if (name === undefined)
          return Response.json({ error: "not found" }, { status: 404 });
        const store = await readStore(root);
        const pack = store[name];
        if (pack === undefined)
          return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(toNpmPackage(pack));
      }
      const name = scopedName(parts.slice(0, parts.length - 1));
      const version = parts[parts.length - 1];
      if (name === undefined || version === undefined)
        return Response.json({ error: "not found" }, { status: 404 });
      const record = await readVersion(root, name, version);
      if (record === null)
        return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(toNpmVersion(record));
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}

function scopedName(parts: readonly string[]): string | undefined {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && parts[0]?.startsWith("@"))
    return `${parts[0]}/${parts[1]}`;
  return undefined;
}

function toNpmPackage(pack: {
  name: string;
  versions: Record<
    string,
    {
      name: string;
      version: string;
      digest: string;
      provenanceSubjectDigest: string;
      deprecated: string | null;
    }
  >;
}) {
  const versions: Record<string, ReturnType<typeof toNpmVersion>> = {};
  for (const [version, record] of Object.entries(pack.versions))
    versions[version] = toNpmVersion(record);
  return { name: pack.name, versions };
}

function toNpmVersion(record: {
  name: string;
  version: string;
  digest: string;
  provenanceSubjectDigest: string;
  deprecated: string | null;
}) {
  return {
    name: record.name,
    version: record.version,
    dist: {
      integrity: record.digest,
      shasum: record.digest.slice(-40),
      tarball: `http://127.0.0.1/fake/${record.name}/-/${record.name}-${record.version}.tgz`,
    },
    provenance: { subjectDigest: record.provenanceSubjectDigest },
    deprecated: record.deprecated ?? undefined,
  };
}
