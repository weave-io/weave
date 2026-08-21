import {
  MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
  MAX_CONFIG_ERROR_FIELD_LENGTH,
  MAX_CONFIG_ERROR_ISSUES,
  MAX_CONFIG_ERROR_PATH_LENGTH,
} from "@weaveio/weave-core";

const CONFIG_DIAGNOSTICS_TRUNCATED = "[config layer diagnostics truncated]";

export type ConfigValidationIssue = { path: string; message: string };

function appendOwn<T>(target: T[], value: T): void {
  Object.defineProperty(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function truncateDiagnostic(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}... [truncated]`;
}

/** Bound merge diagnostics before they cross the config error boundary. */
export function boundConfigIssues(
  issues: readonly ConfigValidationIssue[],
): ConfigValidationIssue[] {
  const bounded: ConfigValidationIssue[] = [];
  let size = 0;
  let truncated = false;
  for (const issue of issues) {
    const next = {
      path: truncateDiagnostic(issue.path, MAX_CONFIG_ERROR_PATH_LENGTH),
      message: truncateDiagnostic(issue.message, MAX_CONFIG_ERROR_FIELD_LENGTH),
    };
    const nextSize = next.path.length + next.message.length;
    if (
      bounded.length >= MAX_CONFIG_ERROR_ISSUES - 1 ||
      size + nextSize + CONFIG_DIAGNOSTICS_TRUNCATED.length >
        MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE
    ) {
      truncated = true;
      break;
    }
    appendOwn(bounded, next);
    size += nextSize;
  }
  if (truncated) {
    appendOwn(bounded, {
      path: "config",
      message: CONFIG_DIAGNOSTICS_TRUNCATED,
    });
  }
  return bounded;
}
