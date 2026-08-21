/**
 * Trusted Pi extension preloader entry.
 *
 * This module imports only build-bundled preloader orchestration. The build
 * emits one self-contained extension.js, so these source seams never become
 * runtime files that could evaluate before the pinned graph is verified.
 *
 * The build replaces this fixed-width value after it has emitted the other
 * runtime outputs. Keeping the value in the entry binds an already-running
 * entry module to the build that produced its sibling files: an old entry
 * cannot accept a newer sidecar.
 */
import type { EXTENSION_BUILD_BINDING_PLACEHOLDER } from "./extension-build-identity-types.js";
import { createWeaveAdapterExtension } from "./extension-preloader-factory.js";

const WEAVE_PI_EMBEDDED_BUILD_BINDING =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** Compile-time equality check for the build replacement sentinel. */
function embeddedBuildBinding(): string {
  const binding: typeof EXTENSION_BUILD_BINDING_PLACEHOLDER =
    WEAVE_PI_EMBEDDED_BUILD_BINDING;
  return binding;
}

export { readExtensionPreloaderRetentionForTesting } from "./extension-preloader-pinned-runtime.js";

export default function weaveAdapterExtension(pi: unknown): Promise<void> {
  return createWeaveAdapterExtension(
    pi,
    embeddedBuildBinding(),
    import.meta.path,
  );
}
