import { Result } from "neverthrow";
import {
  type PiChildProviderError,
  PiChildProviderErrorSchema,
} from "./child-provider-error.js";

const CLASS_LABELS: Readonly<Record<PiChildProviderError["class"], string>> =
  Object.freeze({
    "rate-limit": "rate limit",
    auth: "authentication",
    timeout: "timeout",
    overload: "provider overload",
    connection: "connection",
    cancelled: "cancelled",
    "malformed-response": "malformed response",
    "provider-error": "provider error",
    unknown: "unknown",
  });

/**
 * Render the closed, sanitized provider-error projection in a pinned order.
 *
 * This formatter accepts no raw provider payload. Callers must apply their
 * existing cell-width clipping to the returned single line.
 */
export function formatPiChildProviderError(
  error: PiChildProviderError | undefined,
): string {
  const parsed = Result.fromThrowable(
    () => PiChildProviderErrorSchema.safeParse(error),
    () => undefined,
  )();
  if (parsed.isErr() || !parsed.value.success) {
    return "assistant error · details unavailable";
  }
  const sanitized = parsed.value.data;
  if (
    sanitized.class === "unknown" &&
    sanitized.httpStatus === undefined &&
    sanitized.code === undefined &&
    sanitized.source === undefined &&
    sanitized.provider === undefined &&
    sanitized.model === undefined
  ) {
    return "assistant error · details unavailable";
  }

  const facts = [
    CLASS_LABELS[sanitized.class],
    sanitized.httpStatus === undefined
      ? undefined
      : `HTTP ${sanitized.httpStatus}`,
    sanitized.code,
    sanitized.source === undefined ? undefined : `source ${sanitized.source}`,
    sanitized.provider === undefined
      ? undefined
      : `provider ${sanitized.provider}`,
    sanitized.model === undefined ? undefined : `model ${sanitized.model}`,
    sanitized.message,
  ].filter((fact): fact is string => fact !== undefined);

  return `assistant error · ${facts.join(" · ")}`;
}
