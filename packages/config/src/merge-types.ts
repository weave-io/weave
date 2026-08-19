/** Errors raised while resolving workflow extensions and merging config layers. */
export type WorkflowInputName =
  | "workflowName"
  | "base"
  | "override"
  | "workflowMap";

export type WorkflowExtensionError =
  | {
      type: "UnknownExtendsTarget";
      workflowName: string;
      extendsTarget: string;
    }
  | {
      type: "UnknownInsertionAnchor";
      workflowName: string;
      stepName: string;
      anchor: string;
    }
  | {
      type: "BothInsertBeforeAndAfter";
      workflowName: string;
      stepName: string;
    }
  | {
      type: "ExtendsCycle";
      workflowName: string;
      cycle: string[];
    }
  | {
      /** The public workflow seam rejected an unsafe or invalid argument. */
      type: "UnsafeWorkflowInput";
      argument: WorkflowInputName;
      message: string;
    };

/** Top-level failures returned by the configuration merge pipeline. */
export type MergeError =
  | {
      type: "WorkflowExtensionError";
      error: WorkflowExtensionError;
    }
  | {
      type: "ConfigValidationError";
      errors: Array<{ path: string; message: string }>;
    };
