import { ResultAsync } from "neverthrow";

export type OpenCode2ErrorCode =
  | "invalid_options"
  | "config_unavailable"
  | "catalog_unavailable"
  | "model_unavailable"
  | "session_unavailable"
  | "plan_unavailable"
  | "host_unavailable"
  | "disposed";

export interface OpenCode2Error {
  readonly code: OpenCode2ErrorCode;
  readonly message: string;
}

/** Convert a host Promise boundary without retaining raw host causes. */
export function fromOpenCode2Promise<T>(
  operation: () => Promise<T>,
  code: OpenCode2ErrorCode,
  message: string,
): ResultAsync<T, OpenCode2Error> {
  return ResultAsync.fromThrowable(
    operation,
    (): OpenCode2Error => ({ code, message }),
  )();
}
