/**
 * Runtime Command Operations — module barrel.
 *
 * Re-exports all public symbols from the runtime-command-operations module.
 * This barrel is the single import point for the command-operation surface.
 *
 * ## Module layout
 *
 * | Module                  | Responsibility                                                  |
 * |-------------------------|-----------------------------------------------------------------|
 * | `types.ts`              | Operation kinds, inputs, result data, result types, errors      |
 * | `workflow-runner.ts`    | Reusable lifecycle-driven execution loop (adapter-agnostic)     |
 * | `run-named-workflow.ts` | `run-named-workflow` command operation                          |
 *
 * ## Command Operations
 *
 * | Operation            | Kind                  | Description                              |
 * |----------------------|-----------------------|------------------------------------------|
 * | Start plan           | `start-plan`          | Start execution of a named plan file     |
 * | Run named workflow   | `run-named-workflow`  | Explicitly run a named workflow          |
 * | Inspect status       | `inspect-status`      | Read-only inspection of execution state  |
 * | Abort execution      | `abort-execution`     | Cancel or abort an active execution      |
 * | Advance step         | `advance-step`        | Advance or complete a blocked step       |
 * | Runtime health       | `runtime-health`      | Report adapter/runtime readiness         |
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 */

export { runNamedWorkflow } from "./run-named-workflow.js";
export type {
  AbortExecutionInput,
  AbortExecutionResult,
  AdvanceStepInput,
  AdvanceStepResult,
  CommandDegradedError,
  CommandLifecycleError,
  CommandNotFoundError,
  CommandOperationError,
  CommandOperationKind,
  CommandOperationOutcome,
  CommandOperationResult,
  CommandOperationResultData,
  CommandUnsupportedError,
  CommandValidationError,
  ExecutionAbortedData,
  ExecutionStartedData,
  ExecutionStatusData,
  InspectStatusInput,
  InspectStatusResult,
  RunNamedWorkflowInput,
  RunNamedWorkflowResult,
  RuntimeHealthData,
  RuntimeHealthInput,
  RuntimeHealthResult,
  StartPlanInput,
  StartPlanResult,
  StepAdvancedData,
} from "./types.js";
export {
  COMMAND_OPERATION_KINDS,
  COMMAND_OPERATION_OUTCOMES,
} from "./types.js";
export type {
  WorkflowRunnerError,
  WorkflowRunnerInput,
  WorkflowRunnerOutput,
} from "./workflow-runner.js";
export {
  mapWorkflowRunnerErrorToLifecycle,
  runWorkflowLifecycle,
} from "./workflow-runner.js";
