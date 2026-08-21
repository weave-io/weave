/**
 * Stable executable façade for the child-streaming verifier.
 *
 * Security-sensitive identity, process, capture, replay, and evaluation work
 * lives in focused modules. Keep this path stable for scripts and tests.
 */

import { runCommandLine } from "./child-stream-verify-cli.js";

export {
  buildIdentityProbeEnvironment,
  IDENTITY_PROBE_ENV_ALLOWLIST,
} from "./child-stream-identity-environment.js";
export {
  classifyChildStreamingEvidence,
  runAfterIdentity,
  verifyIdentityFacts,
} from "./child-stream-identity-evaluation.js";
export {
  probePiIdentity,
  verifyCurrentBuildIdentity,
} from "./child-stream-identity-probe.js";
export { renderIdentityVerification } from "./child-stream-identity-report.js";
export { parseVerifyChildStreamingArgs } from "./child-stream-verify-args.js";
export { runCommandLine } from "./child-stream-verify-cli.js";
export type {
  ChildStreamingEvidenceClass,
  IdentityProbeIsolationPaths,
  IdentityVerificationFacts,
  IdentityVerificationSuccess,
  VerifyChildStreamingArgs,
  VerifyChildStreamingFailure,
  VerifyChildStreamingFailureType,
  VerifyCurrentBuildIdentityInput,
} from "./child-stream-verify-types.js";

if (import.meta.main) {
  await runCommandLine(Bun.argv.slice(2));
}
