/**
 * Thin Pi extension loader (Pi adapter contract).
 *
 * Resolves the host-module singleton before evaluating the implementation
 * so a native Bun import of this entry cannot load a nested Pi runtime.
 * This file must not statically import the implementation or any module
 * that imports a Pi package.
 *
 * It also records one fact only this module can know: the absolute path Pi
 * loaded this adapter from. `import.meta.path` is absent on a host module
 * loader that does not provide it, and the accessor stores nothing in that
 * case rather than inventing a path.
 */
import {
  BunPiHostModuleEnvironment,
  recordHostModuleOutcome,
  recordPiExtensionEntryPath,
  resolveHostModules,
} from "./host-module-loader.js";

export default async function weaveAdapterExtension(
  pi: unknown,
): Promise<void> {
  recordPiExtensionEntryPath(import.meta.path as unknown);
  const outcome = await resolveHostModules(new BunPiHostModuleEnvironment());
  const impl = await import("./extension-impl.js");
  if (outcome.isOk()) {
    recordHostModuleOutcome(outcome.value);
  }
  return (impl.default as (host: unknown) => void)(pi);
}
