/**
 * Public façade for the live-proof system.
 *
 * Keep this module small. Process contracts, bounded stream accounting,
 * deadline handling, and the Bun host boundary live in focused modules while
 * callers keep importing this stable path.
 */

export { runBoundedProcess } from "./child-stream-live-proof-bounded-runner.js";
export {
  isLiveProofStreamOverflow,
  LIVE_PROOF_STREAM_OVERFLOW,
  MAX_LIVE_PROOF_LINE_BYTES,
  MAX_LIVE_PROOF_QUEUED_BYTES_PER_STREAM,
  MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM,
  MAX_LIVE_PROOF_TOTAL_QUEUED_BYTES,
  MAX_LIVE_PROOF_TOTAL_QUEUED_LINES,
  MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES,
} from "./child-stream-live-proof-bounded-stream.js";
export {
  createLiveProofSystem,
  safeProofEnvironment,
  workspacePath,
} from "./child-stream-live-proof-host.js";
export type {
  BoundedProcess,
  BoundedProcessLimits,
  BoundedProcessOutput,
  BoundedProcessRunnerInput,
  LiveProofCommandOutput,
  LiveProofPathKind,
  LiveProofProcess,
  LiveProofSpawnInput,
  LiveProofSystem,
  LiveProofSystemFailure,
  LiveProofTimer,
} from "./child-stream-live-proof-system-contract.js";
export {
  DEFAULT_BOUNDED_PROCESS_LIMITS,
  systemFailure,
} from "./child-stream-live-proof-system-contract.js";
