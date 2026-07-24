/**
 * Shared delegation task-length limit (Spec 33 §11.2 Task 9).
 *
 * This is a leaf module with zero adapter dependencies of its own, so it
 * can be imported by every layer that must enforce the exact same bound
 * without ever creating an import cycle:
 *
 * - `delegation-tool.ts` (tool parsing: the TypeBox parameter schema and
 *   `parseDelegationCall`)
 * - `child-control-bodies.ts` (the private-control transport schema:
 *   `DelegateRequestBodySchema.task`, used by a live child relaying its own
 *   nested `delegate-request`)
 * - `delegation-controller.ts` (the controller's own defense-in-depth
 *   bound re-check in `delegate()`)
 * - `rpc-child.ts` (the RPC prompt-send layer's defense-in-depth check in
 *   `runTask`/`sendTaskPrompt`)
 *
 * Before this module existed, `delegation-tool.ts` owned the constant and
 * every other layer imported it from there. `child-control-bodies.ts` is a
 * pure transport-schema module and must never import a tool-registration
 * module (`delegation-tool.ts` imports `permission-bridge.js`, which is
 * reachable from `child-runtime.js`, which `child-control-bodies.ts` is
 * itself imported by - so that direction would have created a cycle).
 * Keeping the constant here, with no imports of its own, avoids that
 * entirely while still guaranteeing every layer enforces the identical
 * bound.
 */
export const MAX_TASK_INPUT_CHARS = 8_000;
