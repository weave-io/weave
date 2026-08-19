/**
 * Thin Pi extension loader (Pi adapter contract).
 *
 * Resolves the host-module singleton before evaluating the implementation
 * so a native Bun import of this entry cannot load a nested Pi runtime.
 * This file must not statically import the implementation or any module
 * that imports a Pi package.
 *
 * It also records the absolute path Pi loaded this adapter from only as an
 * internal read capability. The identity loader hashes the complete runtime
 * output graph, including the implementation, before that graph is evaluated.
 * `import.meta.path` is absent on a host module loader that does not provide it,
 * and the accessor stores nothing in that case rather than inventing a path.
 */
import {
  loadExtensionBuildIdentity,
  maybeWriteExtensionBuildIdentityProofLine,
  unverifiableExtensionLoadIdentity,
} from "./extension-build-identity.js";
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
  const loadedIdentity = (
    await loadExtensionBuildIdentity(import.meta.path as unknown)
  ).match(
    (value) => value,
    () => unverifiableExtensionLoadIdentity("artifact-read-failed"),
  );
  maybeWriteExtensionBuildIdentityProofLine(loadedIdentity);
  const outcome = await resolveHostModules(new BunPiHostModuleEnvironment());
  const impl = await import("./extension-impl.js");
  if (outcome.isOk()) {
    recordHostModuleOutcome(outcome.value);
  }
  const setLoadedIdentity = (
    impl as typeof impl & {
      setLoadedPiExtensionIdentity?: (identity: typeof loadedIdentity) => void;
    }
  ).setLoadedPiExtensionIdentity;
  setLoadedIdentity?.(loadedIdentity);
  return (impl.default as (host: unknown) => void)(pi);
}
