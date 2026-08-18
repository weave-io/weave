/**
 * Test-only in-memory/file-backed npm package store.
 *
 * Production controllers never import this module. The integration test and
 * the deprecation seam share one store directory so readback is authoritative
 * without the controller reaching the seam.
 */
import { join } from "node:path";

export interface LocalRegistryVersion {
  name: string;
  version: string;
  digest: string;
  provenanceSubjectDigest: string;
  deprecated: string | null;
}

export interface LocalRegistryPackage {
  name: string;
  versions: Record<string, LocalRegistryVersion>;
}

const STORE_FILE = "registry-store.json";

export function storePath(root: string): string {
  return join(root, STORE_FILE);
}

export async function readStore(
  root: string,
): Promise<Record<string, LocalRegistryPackage>> {
  const file = Bun.file(storePath(root));
  if (!(await file.exists())) return {};
  const parsed: unknown = JSON.parse(await file.text());
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  return parsed as Record<string, LocalRegistryPackage>;
}

export async function writeStore(
  root: string,
  store: Record<string, LocalRegistryPackage>,
): Promise<void> {
  await Bun.write(storePath(root), `${JSON.stringify(store, null, 2)}\n`);
}

export async function putVersion(
  root: string,
  version: LocalRegistryVersion,
): Promise<void> {
  const store = await readStore(root);
  const current = store[version.name] ?? { name: version.name, versions: {} };
  current.versions[version.version] = version;
  store[version.name] = current;
  await writeStore(root, store);
}

export async function readVersion(
  root: string,
  name: string,
  version: string,
): Promise<LocalRegistryVersion | null> {
  const store = await readStore(root);
  return store[name]?.versions[version] ?? null;
}
