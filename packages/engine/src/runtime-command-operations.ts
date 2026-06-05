/**
 * Runtime Command Operations — compatibility barrel.
 *
 * Re-exports all public symbols from the decomposed
 * `runtime-command-operations/` module directory. All imports from
 * `./runtime-command-operations.js` continue to work unchanged.
 *
 * ## Module layout (runtime-command-operations/)
 *
 * | Module                  | Responsibility                                                  |
 * |-------------------------|-----------------------------------------------------------------|
 * | `types.ts`              | Operation kinds, inputs, result data, result types, errors      |
 * | `workflow-runner.ts`    | Reusable lifecycle-driven execution loop (adapter-agnostic)     |
 * | `run-named-workflow.ts` | `run-named-workflow` command operation                          |
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 */

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
  WorkflowRunnerError,
  WorkflowRunnerInput,
  WorkflowRunnerOutput,
} from "./runtime-command-operations/index.js";
export {
  COMMAND_OPERATION_KINDS,
  COMMAND_OPERATION_OUTCOMES,
  mapWorkflowRunnerErrorToLifecycle,
  runNamedWorkflow,
  runWorkflowLifecycle,
} from "./runtime-command-operations/index.js";
