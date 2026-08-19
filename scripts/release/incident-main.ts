/**
 * Authorized integrity-incident workflow entry.
 *
 * Phase `generate` verifies immutable registry bytes and emits the exact
 * interactive maintainer commands. Phase `complete` reads back `deprecated`
 * metadata and only then writes durable GitHub evidence through injected
 * completion ports. This root never runs npm deprecate, unpublishes, or moves
 * a dist-tag.
 */
import {
  err,
  errAsync,
  ok,
  Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
  type Result as ResultType,
} from "neverthrow";
import { z } from "zod";
import {
  completeIncidentResolution,
  generateIncidentResolution,
  IncidentAuthorizationRecordSchema,
  type IncidentCompletionPorts,
  type IncidentGenerateResult,
  type IncidentRegistryPort,
  type IncidentResolutionError,
  type IncidentResolutionRequest,
} from "./incident-resolution.js";
import type { ReleaseAuthority } from "./release-state.js";

export const INCIDENT_MAIN_SCHEMA_VERSION = 1 as const;
export const IncidentMainInputSchema = z
  .object({
    schemaVersion: z.literal(INCIDENT_MAIN_SCHEMA_VERSION),
    phase: z.enum(["generate", "complete"]),
    actor: z
      .object({
        actor: z.string().min(1).max(64),
        maintainerAuthorized: z.boolean(),
        environment: z.literal("release"),
        environmentApproved: z.boolean(),
      })
      .strict(),
    authority: z.unknown(),
    storedRecord: z.unknown().optional(),
    now: z.string().max(64).optional(),
  })
  .strict();
export type IncidentMainInput = z.infer<typeof IncidentMainInputSchema>;

export type IncidentMainError =
  | { type: "InvalidIncidentInput"; issues: readonly string[] }
  | { type: "IncidentInputTooLarge"; bytes: number; limit: number }
  | IncidentResolutionError;

export type IncidentMainResult =
  | IncidentGenerateResult
  | {
      status: "CompleteWithIncident";
      state: unknown;
      record: unknown;
    };

export function validateIncidentMainInput(
  input: unknown,
): ResultType<IncidentMainInput, IncidentMainError> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(input) ?? "",
    () => "",
  )();
  const bytes = serialized.isErr()
    ? Number.MAX_SAFE_INTEGER
    : new TextEncoder().encode(serialized.value).byteLength;
  if (bytes > 256 * 1024)
    return err({
      type: "IncidentInputTooLarge",
      bytes,
      limit: 256 * 1024,
    });
  const parsed = IncidentMainInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidIncidentInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  const record = parsed.data.storedRecord;
  if (
    record !== undefined &&
    !IncidentAuthorizationRecordSchema.safeParse(record).success
  )
    return err({
      type: "InvalidIncidentInput",
      issues: ["storedRecord is not a valid incident authorization record"],
    });
  return ok(parsed.data);
}

export function runIncidentMain(
  input: unknown,
  registry: IncidentRegistryPort,
  completion: IncidentCompletionPorts,
): ResultAsyncType<IncidentMainResult, IncidentMainError> {
  const parsed = validateIncidentMainInput(input);
  if (parsed.isErr()) return errAsync(parsed.error);
  const request = parsed.value;
  const authority = request.authority as ReleaseAuthority;
  const base: IncidentResolutionRequest = {
    actor: request.actor,
    authority,
    ...(request.storedRecord === undefined
      ? {}
      : { storedRecord: request.storedRecord }),
    ...(request.now === undefined ? {} : { now: request.now }),
  };
  if (request.phase === "generate")
    return generateIncidentResolution(base, registry).map((result) => result);
  return completeIncidentResolution(base, registry, completion).map(
    (result) => ({
      status: result.status,
      state: result.state,
      record: result.record,
    }),
  );
}

export function parseIncidentArgs(
  argv: readonly string[],
): ResultType<
  { inputPath: string },
  { type: "InvalidIncidentInput"; issues: readonly string[] }
> {
  if (argv.length !== 2 || argv[0] !== "--input" || argv[1] === undefined)
    return err({
      type: "InvalidIncidentInput",
      issues: ["usage: incident-main --input <incident.json>"],
    });
  return ok({ inputPath: argv[1] });
}

if (import.meta.main) {
  const args = parseIncidentArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const input = await ResultAsync.fromThrowable(
      () => Bun.file(args.value.inputPath).text(),
      (cause): IncidentMainError => ({
        type: "InvalidIncidentInput",
        issues: [String(cause)],
      }),
    )();
    if (input.isErr()) {
      process.exitCode = 1;
    } else {
      const parsed = Result.fromThrowable(
        () => JSON.parse(input.value) as unknown,
        (cause): IncidentMainError => ({
          type: "InvalidIncidentInput",
          issues: [String(cause)],
        }),
      )();
      if (parsed.isErr() || validateIncidentMainInput(parsed.value).isErr())
        process.exitCode = 1;
    }
  }
}
