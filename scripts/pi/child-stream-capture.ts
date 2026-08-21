/**
 * Stable public façade for the Pi child stream capture proof.
 *
 * Security-sensitive work lives in focused modules so omission/sanitization,
 * fixture verification, replay, and real-Pi resource cleanup can be audited
 * independently without changing the script's public import surface.
 */

export type {
  CaptureFailure,
  CaptureFailureType,
  CaptureFixture,
  CaptureManifest,
  CaptureManifestBounds,
  CaptureSuccess,
  FixtureStructuralFacts,
  FixtureValidationFailure,
  FixtureValidationFailureType,
  ReplayFacts,
  SanitizedEvent,
} from "./child-stream-capture-contract.js";
export {
  FIXTURE_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  MAX_CAPTURE_ARRAY_LENGTH,
  MAX_CAPTURE_DEPTH,
  MAX_CAPTURE_EVENTS,
  MAX_CAPTURE_KEYS,
  MAX_CAPTURE_PREVIEW_BYTES,
  MAX_CAPTURE_STRING_BYTES,
  MAX_CAPTURE_TOTAL_BYTES,
  PROMPT_OMITTED_MARKER,
  PROVIDER_VALUE_OMITTED_MARKER,
  REASONING_OMITTED_MARKER,
  REQUIRED_PI_VERSION,
  SANITIZER_VERSION,
  STRING_OMITTED_MARKER,
  STRING_TRUNCATED_MARKER,
} from "./child-stream-capture-contract.js";
export { captureChildEvents } from "./child-stream-capture-harness.js";
export {
  injectControlledReasoningInMemory,
  replayFixtureThroughAdapter,
} from "./child-stream-capture-replay.js";
export {
  containsForbiddenContent,
  omitReasoningProse,
  sanitizeRawEvent,
  sanitizeRawEvents,
  sha256HexOfText,
} from "./child-stream-capture-sanitizer.js";
export {
  buildCaptureManifest,
  deriveManifestPath,
  readFixtureAndManifest,
  runFixtureRedControls,
  serializeFixture,
  validateFixtureStructure,
  verifyCaptureManifest,
} from "./child-stream-capture-verifier.js";
