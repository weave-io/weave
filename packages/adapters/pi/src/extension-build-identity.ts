/**
 * Stable public façade for extension build identity.
 *
 * The implementation is split by ownership: path-free contract types,
 * validation, build binding, manifest I/O, runtime health, and proof output.
 * Keep callers on this module so those seams can evolve without changing the
 * identity API or the pinned preloader contract.
 */

export {
  computeExtensionBuildBinding,
  sha256Hex,
} from "./extension-build-identity-binding.js";
export {
  createExtensionBuildManifest,
  parseExtensionBuildManifest,
  parseExtensionBuildManifestText,
  readArtifactSha256,
  renderExtensionBuildManifest,
} from "./extension-build-identity-manifest.js";
export {
  maybeWriteExtensionBuildIdentityProofLine,
  parseExtensionBuildIdentityProof,
  renderExtensionBuildIdentityHealthLine,
  renderExtensionBuildIdentityProofLine,
} from "./extension-build-identity-proof.js";
export {
  evaluateExtensionBuildIdentity,
  extensionProcessStartMs,
  loadExtensionBuildIdentity,
  readExtensionBuildIdentityHealth,
  unverifiableExtensionLoadIdentity,
} from "./extension-build-identity-runtime.js";
export type {
  ExtensionBuildIdentityError,
  ExtensionBuildIdentityHealth,
  ExtensionBuildIdentityManifest,
  ExtensionBuildIdentityProof,
  ExtensionBuildIdentityProofLine,
  ExtensionBuildIdentityReason,
  ExtensionBuildIdentityState,
  ExtensionBuildManifestGit,
  ExtensionBuildOutputDigest,
  ExtensionLoadedIdentity,
  ExtensionRuntimeOutputName,
} from "./extension-build-identity-types.js";
export {
  EXTENSION_BUILD_BINDING_PLACEHOLDER,
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
  EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
  EXTENSION_BUILD_MANIFEST_FILENAME,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH,
  MAX_EXTENSION_BUILD_INPUTS,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
  MAX_EXTENSION_BUILD_OUTPUT_BYTES,
  MAX_EXTENSION_BUILD_OUTPUT_NAME_LENGTH,
  MAX_EXTENSION_BUILD_OUTPUTS,
  MAX_EXTENSION_BUILD_SUBJECT_LENGTH,
} from "./extension-build-identity-types.js";
