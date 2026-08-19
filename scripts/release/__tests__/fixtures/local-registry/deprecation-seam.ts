/**
 * Test-only deprecation seam.
 *
 * Sets `deprecated` metadata directly on the local registry fixture. No
 * production module may import, dynamically load, spawn, or otherwise reach
 * this file. The hermetic incident-recovery integration test is the only
 * sanctioned caller.
 */
import { type LocalRegistryVersion, putVersion, readVersion } from "./store.js";

export async function setDeprecated(input: {
  root: string;
  name: string;
  version: string;
  message: string;
}): Promise<LocalRegistryVersion> {
  const current = await readVersion(input.root, input.name, input.version);
  if (current === null)
    throw new Error(`local registry missing ${input.name}@${input.version}`);
  const next = { ...current, deprecated: input.message };
  await putVersion(input.root, next);
  return next;
}
