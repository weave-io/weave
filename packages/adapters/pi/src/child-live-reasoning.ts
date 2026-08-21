/**
 * Stable import façade for the Pi live-reasoning projection.
 *
 * The implementation is split by seam: descriptor-safe carrier parsing,
 * terminal/display normalization, process-memory registry ownership, observer
 * fanout, and the lifecycle reducer/projector.
 */
export {
  formatPiLiveReasoningInspectorRows,
  formatPiLiveReasoningParentLine,
  piLiveReasoningUtf8Bytes,
} from "./child-live-reasoning-display.js";
export {
  createPiLiveReasoningProjector,
  PiLiveReasoningProjector,
  projectPiLiveReasoningUpdate,
} from "./child-live-reasoning-projector.js";
export {
  createPiLiveReasoningRegistry,
  PiLiveReasoningRegistry,
} from "./child-live-reasoning-registry.js";
export * from "./child-live-reasoning-types.js";
