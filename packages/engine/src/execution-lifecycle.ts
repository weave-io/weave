/**
 * Execution Lifecycle Surface for the Weave engine.
 *
 * **Compatibility barrel** — this file re-exports all public symbols from the
 * decomposed `execution-lifecycle/` modules. All imports from
 * `./execution-lifecycle.js` continue to work unchanged.
 *
 * ## Module layout (execution-lifecycle/)
 *
 * | Module              | Responsibility                                          |
 * |---------------------|---------------------------------------------------------|
 * | `types.ts`          | All I/O interfaces, effect types, result aliases        |
 * | `errors.ts`         | Error factory helpers                                   |
 * | `metadata.ts`       | SafeMetadata runtime sanitization                       |
 * | `authorization.ts`  | Execution and reconciliation authorization validation   |
 * | `lease.ts`          | Active-lease validation and store-error mapping         |
 * | `session.ts`        | `observeSession` implementation                         |
 * | `start.ts`          | `startExecution` implementation                         |
 * | `resume.ts`         | `resumeExecution` implementation                        |
 * | `interrupts.ts`     | `handleUserInterrupt` implementation                    |
 * | `prompt-context.ts` | Step prompt context building and rendering              |
 * | `artifacts.ts`      | Artifact validation, integrity, and persistence         |
 * | `dispatch.ts`       | `dispatchStep` implementation                           |
 * | `completion.ts`     | `completeStep` implementation                           |
 * | `before-tool.ts`    | `beforeTool` implementation                             |
 * | `inspection.ts`     | `inspectExecution` implementation                       |
 * | `terminal-outcomes.ts` | `approveArtifact` implementation                     |
 * | `reconciliation.ts` | `reconcileExecution` implementation                     |
 *
 * ## Lifecycle Methods
 *
 * 1. `observeSession`    — adapter reports a normalized session observation
 * 2. `startExecution`    — adapter signals that a new workflow execution begins
 * 3. `resumeExecution`   — adapter signals that a paused execution resumes
 * 4. `handleUserInterrupt` — adapter signals a user-initiated interrupt
 * 5. `dispatchStep`      — adapter requests dispatch of the next workflow step
 * 6. `completeStep`      — adapter signals that a step has finished
 * 7. `beforeTool`        — adapter signals that a tool call is about to execute
 * 8. `inspectExecution`  — adapter queries execution state without side effects
 * 9. `approveArtifact`   — adapter approves or rejects an artifact
 * 10. `reconcileExecution` — adapter triggers reconciliation routing
 *
 * @see docs/adapter-boundary.md — Execution Lifecycle Surface section
 * @see docs/adr/0004-workflow-first-execution-contract.md — Execution boundary
 */

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
} from "./execution-lifecycle/index.js";
export {
  approveArtifact,
  beforeTool,
  completeStep,
  dispatchStep,
  EXECUTION_AUTHORIZATION_SOURCES,
  EXECUTION_OPERATION_KINDS,
  handleUserInterrupt,
  inspectExecution,
  lifecycleLeaseConflictError,
  lifecycleNotFoundError,
  lifecyclePersistenceError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
  observeSession,
  RECONCILIATION_AUTHORIZATION_SOURCES,
  RECONCILIATION_REASONS,
  reconcileExecution,
  resumeExecution,
  sanitizeMetadata,
  startExecution,
  validateAuthorizationSource,
  validateReconciliationSource,
} from "./execution-lifecycle/index.js";
