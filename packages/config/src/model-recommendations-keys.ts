/**
 * Public keys that may sign published model recommendations (Spec 39).
 *
 * Each entry is a raw 32-byte Ed25519 public key, base64-encoded. A list is
 * accepted when any key in this list verifies its signature.
 *
 * Rotation: ship the new key here in a release first, and only start signing
 * with it once that release is out, so clients already know the key when the
 * first list signed with it arrives. Remove a retired key in a later release.
 * The private half lives only in the `model-recommendations` GitHub
 * Environment of the website repository; it never enters this repository.
 */
export const MODEL_RECOMMENDATIONS_PUBLIC_KEYS: readonly string[] = [
  // Production key, added 1 Oct 2026 (Spec 39).
  "b5UhKwU8ugzt7BBcPCHCIXPMaGip85yid0l187r7c8Y=",
];
