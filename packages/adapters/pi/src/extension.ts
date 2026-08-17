/**
 * Thin Pi extension loader (Pi adapter contract).
 *
 * Resolves the host-module singleton before evaluating the implementation
 * so a native Bun import of this entry cannot load a nested Pi runtime.
 * This file must not statically import the implementation or any module
 * that imports a Pi package.
 */
import {
  BunPiHostModuleEnvironment,
  recordHostModuleOutcome,
  resolveHostModules,
} from "./host-module-loader.js";

export default async function weaveAdapterExtension(
  pi: unknown,
): Promise<void> {
  const outcome = await resolveHostModules(new BunPiHostModuleEnvironment());
  const impl = await import("./extension-impl.js");
  if (outcome.isOk()) {
    recordHostModuleOutcome(outcome.value);
  }
  return (impl.default as (host: unknown) => void)(pi);
}
