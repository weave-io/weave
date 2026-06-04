/**
 * Execution Lifecycle — module barrel.
 *
 * Re-exports all public symbols from the decomposed lifecycle modules.
 * This barrel is the single import point for the lifecycle surface.
 *
 * Module layout:
 * - types.ts          — all I/O interfaces, effect types, result aliases, SafeMetadata
 * - errors.ts         — error factory helpers
 * - metadata.ts       — SafeMetadata runtime sanitization
 * - authorization.ts  — execution and reconciliation authorization validation
 * - lease.ts          — active-lease validation and store-error mapping
 * - session.ts        — observeSession implementation
 * - start.ts          — startExecution implementation
 * - resume.ts         — resumeExecution implementation
 * - interrupts.ts     — handleUserInterrupt implementation
 * - prompt-context.ts — step prompt context building and rendering
 * - artifacts.ts      — artifact validation, integrity, and persistence
 * - dispatch.ts       — dispatchStep implementation
 * - completion.ts     — completeStep implementation
 * - before-tool.ts    — beforeTool implementation
 * - inspection.ts     — inspectExecution implementation
 * - terminal-outcomes.ts — approveArtifact implementation
 * - reconciliation.ts — reconcileExecution implementation
 */

// Authorization validation
export {
  validateAuthorizationSource,
  validateReconciliationSource,
} from "./authorization.js";
export { beforeTool } from "./before-tool.js";
export { completeStep } from "./completion.js";
export { dispatchStep } from "./dispatch.js";
// Error factories
export {
  lifecycleLeaseConflictError,
  lifecycleNotFoundError,
  lifecyclePersistenceError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
} from "./errors.js";
export { inspectExecution } from "./inspection.js";
export { handleUserInterrupt } from "./interrupts.js";
// Metadata sanitization
export { sanitizeMetadata } from "./metadata.js";
export { reconcileExecution } from "./reconciliation.js";
export { resumeExecution } from "./resume.js";
// Lifecycle implementations
export { observeSession } from "./session.js";
export { startExecution } from "./start.js";
export { approveArtifact } from "./terminal-outcomes.js";
// Types and constants
export type {
  ApproveArtifactInput,
  ApproveArtifactOutput,
  ApproveArtifactResult,
  BeforeToolInput,
  BeforeToolOutput,
  BeforeToolResult,
  CompleteExecutionEffect,
  CompleteStepInput,
  CompleteStepOutput,
  CompleteStepResult,
  DispatchAgentEffect,
  DispatchStepInput,
  DispatchStepOutput,
  DispatchStepResult,
  ExecutionAuthorizationSource,
  ExecutionOperationKind,
  HandleUserInterruptInput,
  HandleUserInterruptOutput,
  HandleUserInterruptResult,
  InspectExecutionInput,
  InspectExecutionOutput,
  InspectExecutionResult,
  LifecycleEffect,
  LifecycleError,
  LifecycleLeaseConflictError,
  LifecycleNotFoundError,
  LifecyclePersistenceError,
  LifecyclePolicyDecisionError,
  LifecycleValidationError,
  ObserveSessionInput,
  ObserveSessionOutput,
  ObserveSessionResult,
  PauseExecutionEffect,
  ReconcileExecutionInput,
  ReconcileExecutionOutput,
  ReconcileExecutionResult,
  ReconciliationAuthorizationSource,
  ResumeExecutionInput,
  ResumeExecutionOutput,
  ResumeExecutionResult,
  SafeMetadata,
  StartExecutionInput,
  StartExecutionOutput,
  StartExecutionResult,
  StepCompletionSignal,
  WorkflowExecutionContext,
} from "./types.js";
export {
  EXECUTION_AUTHORIZATION_SOURCES,
  EXECUTION_OPERATION_KINDS,
  RECONCILIATION_AUTHORIZATION_SOURCES,
  RECONCILIATION_REASONS,
} from "./types.js";
