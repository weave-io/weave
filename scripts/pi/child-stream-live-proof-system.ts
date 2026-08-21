/**
 * Public façade for the live-proof system.
 *
 * Keep this module small. Process contracts, bounded stream accounting,
 * deadline handling, and the Bun host boundary live in focused modules while
 * callers keep importing this stable path.
 */

export {
  runBoundedProcess,
  spawnBoundedInteractiveProcess,
} from "../bounded-process/runner.js";
export {
  BOUNDED_PROCESS_STREAM_OVERFLOW as LIVE_PROOF_STREAM_OVERFLOW,
  isBoundedProcessStreamOverflow as isLiveProofStreamOverflow,
  MAX_BOUNDED_PROCESS_LINE_BYTES as MAX_LIVE_PROOF_LINE_BYTES,
  MAX_BOUNDED_PROCESS_QUEUED_BYTES_PER_STREAM as MAX_LIVE_PROOF_QUEUED_BYTES_PER_STREAM,
  MAX_BOUNDED_PROCESS_QUEUED_LINES_PER_STREAM as MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM,
  MAX_BOUNDED_PROCESS_TOTAL_QUEUED_BYTES as MAX_LIVE_PROOF_TOTAL_QUEUED_BYTES,
  MAX_BOUNDED_PROCESS_TOTAL_QUEUED_LINES as MAX_LIVE_PROOF_TOTAL_QUEUED_LINES,
  MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES as MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES,
} from "../bounded-process/stream.js";
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
  BoundedProcessStdin,
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
