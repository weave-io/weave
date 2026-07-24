import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  makeInvariantViolationFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PiCommandInfo, PiExtensionApi, PiToolInfo } from "./types.js";

const PiSourceInfoSchema = z.object({
  path: z.string(),
  source: z.string(),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
  baseDir: z.string().optional(),
});

const PiCommandInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(["extension", "prompt", "skill"]),
  sourceInfo: PiSourceInfoSchema,
});

const PiToolInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  sourceInfo: PiSourceInfoSchema,
});

/**
 * Reads and validates `pi.getCommands()`. The host is an untrusted external
 * boundary: a throwing call or a malformed payload becomes a typed
 * `InvariantViolation` rather than propagating an exception or silently
 * trusting the shape.
 */
export function readValidatedCommands(
  api: Pick<PiExtensionApi, "getCommands">,
): Result<PiCommandInfo[], PiAdapterFailure> {
  const raw = Result.fromThrowable(
    () => api.getCommands(),
    () => makeInvariantViolationFailure("getCommands-threw"),
  )();
  if (raw.isErr()) return err(raw.error);
  const parsed = z.array(PiCommandInfoSchema).safeParse(raw.value);
  if (!parsed.success) {
    return err(makeInvariantViolationFailure("getCommands-malformed"));
  }
  return ok(parsed.data);
}

/** Same contract as {@link readValidatedCommands} for `pi.getAllTools()`. */
export function readValidatedTools(
  api: Pick<PiExtensionApi, "getAllTools">,
): Result<PiToolInfo[], PiAdapterFailure> {
  const raw = Result.fromThrowable(
    () => api.getAllTools(),
    () => makeInvariantViolationFailure("getAllTools-threw"),
  )();
  if (raw.isErr()) return err(raw.error);
  const parsed = z.array(PiToolInfoSchema).safeParse(raw.value);
  if (!parsed.success) {
    return err(makeInvariantViolationFailure("getAllTools-malformed"));
  }
  return ok(parsed.data);
}
