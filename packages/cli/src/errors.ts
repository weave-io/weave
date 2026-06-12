/**
 * Shared discriminated-union CLI error types.
 *
 * Each variant describes a specific failure mode with enough
 * context for user-facing formatting.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type CliError =
  | InvalidArgsError
  | MissingFileError
  | FileReadError
  | ParseFailureError
  | ValidationFailureError
  | AgentNotFoundError
  | CompositionFailureError
  | UnknownCommandError
  | EvalValidationError;

export type InvalidArgsError = {
  type: "InvalidArgs";
  message: string;
};

export type MissingFileError = {
  type: "MissingFile";
  path: string;
  message: string;
};

export type FileReadError = {
  type: "FileReadError";
  path: string;
  cause: unknown;
  message: string;
};

export type ParseFailureError = {
  type: "ParseFailure";
  path: string;
  errors: string[];
};

export type ValidationFailureError = {
  type: "ValidationFailure";
  path: string;
  errors: string[];
};

export type AgentNotFoundError = {
  type: "AgentNotFound";
  agentName: string;
  message: string;
};

export type CompositionFailureError = {
  type: "CompositionFailure";
  agentName: string;
  message: string;
};

export type UnknownCommandError = {
  type: "UnknownCommand";
  command: string;
  message: string;
};

export type EvalValidationError = {
  type: "EvalValidation";
  message: string;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a CLI error for human-readable stderr output. */
export function formatCliError(error: CliError): string {
  switch (error.type) {
    case "InvalidArgs":
      return `Error: ${error.message}`;
    case "MissingFile":
      return `Error: File not found: ${error.path}\n  ${error.message}`;
    case "FileReadError":
      return `Error: Could not read ${error.path}\n  ${error.message}`;
    case "ParseFailure":
      return error.errors.join("\n");
    case "ValidationFailure":
      return error.errors.join("\n");
    case "AgentNotFound":
      return `Error: Agent "${error.agentName}" not found\n\nRun 'weave prompt list' to see available agents.`;
    case "CompositionFailure":
      return `Error: Failed to compose prompt for agent "${error.agentName}"\n\n${error.message}`;
    case "UnknownCommand":
      return `Error: Unknown command "${error.command}"\n  ${error.message}`;
    case "EvalValidation":
      return `Error: ${error.message}`;
  }
}
