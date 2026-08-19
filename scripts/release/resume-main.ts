/**
 * Workflow entry for stable resume.
 *
 * The state machine and transition ports live in `resume.ts`; this file is the
 * bounded workflow boundary. It validates the dispatch carrier and exposes a
 * small injectable runner for hermetic tests. It never treats a cached report
 * or a workflow artifact as authority.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
  type Result as ResultType,
} from "neverthrow";
import { z } from "zod";
import type { ReleasePlan } from "./release-plan.js";
import type { DiscoveredRelease } from "./release-state.js";
import {
  type ResumeError,
  type ResumeRequest,
  type ResumeResult,
  type ResumeTransitionPorts,
  resumeRelease,
} from "./resume.js";

export const RESUME_MAIN_SCHEMA_VERSION = 1 as const;
export const ResumeMainInputSchema = z
  .object({
    schemaVersion: z.literal(RESUME_MAIN_SCHEMA_VERSION),
    releasedSha: z.string().regex(/^[0-9a-f]{40}$/),
    storedPlan: z.unknown().optional(),
    discovered: z.unknown(),
  })
  .strict();
export type ResumeMainInput = z.infer<typeof ResumeMainInputSchema>;

export type ResumeMainError =
  | { type: "InvalidResumeInput"; issues: readonly string[] }
  | { type: "ResumeInputTooLarge"; bytes: number; limit: number }
  | ResumeError;

export function validateResumeMainInput(
  input: unknown,
): ResultType<ResumeMainInput, ResumeMainError> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(input) ?? "",
    () => "",
  )();
  if (serialized.isErr())
    return err({
      type: "ResumeInputTooLarge",
      bytes: Number.MAX_SAFE_INTEGER,
      limit: 256 * 1024,
    });
  const bytes = new TextEncoder().encode(serialized.value).byteLength;
  if (bytes > 256 * 1024)
    return err({
      type: "ResumeInputTooLarge",
      bytes,
      limit: 256 * 1024,
    });
  const parsed = ResumeMainInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidResumeInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

export function runResumeMain(
  input: unknown,
  ports: ResumeTransitionPorts,
): ResultAsync<ResumeResult, ResumeMainError> {
  const parsed = validateResumeMainInput(input);
  if (parsed.isErr()) return errAsync(parsed.error);
  const discovered = parseDiscoveredRelease(parsed.value.discovered);
  if (discovered.isErr()) return errAsync(discovered.error);
  if (
    discovered.value.kind === "merged-release" &&
    discovered.value.state.releasedSha !== parsed.value.releasedSha
  )
    return errAsync({
      type: "InvalidResumeInput" as const,
      issues: [
        `releasedSha does not match discovered state (${discovered.value.state.releasedSha})`,
      ],
    });
  const request: ResumeRequest = {
    discovered: discovered.value,
    ...(parsed.value.storedPlan === undefined
      ? {}
      : { storedPlan: parsed.value.storedPlan }),
  };
  return resumeRelease(request, ports).mapErr((error) => error);
}

export function parseDiscoveredRelease(
  input: unknown,
): ResultType<DiscoveredRelease, ResumeMainError> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return err({
      type: "InvalidResumeInput",
      issues: ["discovered must be an object"],
    });
  const record = input as Record<string, unknown>;
  if (record.kind === "creation-cleanup-pending") {
    const ownership = record.ownership;
    if (
      typeof ownership !== "object" ||
      ownership === null ||
      Array.isArray(ownership)
    )
      return err({
        type: "InvalidResumeInput",
        issues: ["creation cleanup ownership is required"],
      });
    return ok(input as DiscoveredRelease);
  }
  if (record.kind !== "merged-release")
    return err({
      type: "InvalidResumeInput",
      issues: [
        "discovered.kind must be merged-release or creation-cleanup-pending",
      ],
    });
  if (typeof record.state !== "object" || record.state === null)
    return err({
      type: "InvalidResumeInput",
      issues: ["merged-release state is required"],
    });
  return ok(input as DiscoveredRelease);
}

export interface ResumeMainFilePort {
  read(path: string): ResultAsync<string, ResumeMainError>;
}

export function parseResumeArgs(
  argv: readonly string[],
): ResultType<
  { inputPath: string },
  { type: "InvalidResumeInput"; issues: readonly string[] }
> {
  if (argv.length !== 2 || argv[0] !== "--input" || argv[1] === undefined)
    return err({
      type: "InvalidResumeInput",
      issues: ["usage: resume-main --input <resume.json>"],
    });
  return ok({ inputPath: argv[1] });
}

/** Main uses a file only as a carrier; authority is still reread by ports. */
export function readResumeInput(
  path: string,
  files: ResumeMainFilePort,
): ResultAsyncType<ResumeMainInput, ResumeMainError> {
  return files.read(path).andThen((text) => {
    const parsed = Result.fromThrowable(
      () => JSON.parse(text) as unknown,
      (cause): ResumeMainError => ({
        type: "InvalidResumeInput",
        issues: [String(cause)],
      }),
    )();
    if (parsed.isErr())
      return errAsync<ResumeMainInput, ResumeMainError>(parsed.error);
    const validated = validateResumeMainInput(parsed.value);
    return validated.isErr()
      ? errAsync<ResumeMainInput, ResumeMainError>(validated.error)
      : okAsync<ResumeMainInput, ResumeMainError>(validated.value);
  });
}

if (import.meta.main) {
  const args = parseResumeArgs(Bun.argv.slice(2));
  if (args.isErr()) {
    process.exitCode = 2;
  } else {
    const input = await ResultAsync.fromThrowable(
      () => Bun.file(args.value.inputPath).text(),
      (cause): ResumeMainError => ({
        type: "InvalidResumeInput",
        issues: [String(cause)],
      }),
    )().andThen((text) =>
      Result.fromThrowable(
        () => JSON.parse(text) as unknown,
        (cause): ResumeMainError => ({
          type: "InvalidResumeInput",
          issues: [String(cause)],
        }),
      )(),
    );
    // The workflow boundary validates the carrier before handing it to the
    // injected controller. Live wiring supplies the ports in the job adapter;
    // a missing carrier is a hard, non-publishing failure.
    if (input.isErr() || validateResumeMainInput(input.value).isErr())
      process.exitCode = 1;
  }
}

// Keep the type visible to API consumers that build a plan-aware resume port.
export type { ReleasePlan };
