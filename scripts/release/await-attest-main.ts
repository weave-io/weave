/** Stable chain step: dispatch and await the independent attestation run. */
import { err, errAsync, ok, type Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  type ChainStepInputError,
  parseNamedPathArgs,
  readJsonFile,
} from "./chain-step-support.js";
import {
  type AttestationCheckResult,
  type AttestationExpectation,
  type AttestationGateError,
  type AttestationPollPort,
  awaitAttestation,
  verifyAttestationResult,
} from "./publish-chain.js";

const RequestSchema = z
  .object({
    sourceRunId: z.number().int().positive(),
    artifactId: z.number().int().positive(),
    releasedSha: z.string().regex(/^[0-9a-f]{40}$/),
    planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    tarballDigests: z
      .array(
        z
          .object({
            packageName: z.string().min(1),
            sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export type AwaitAttestError =
  | { type: "InvalidAwaitAttestInput"; issues: readonly string[] }
  | AttestationGateError
  | ChainStepInputError;

export interface AwaitAttestInput extends AttestationExpectation {
  sourceRunId: number;
  artifactId: number;
}

export function parseAwaitAttestInput(
  input: unknown,
): Result<AwaitAttestInput, AwaitAttestError> {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidAwaitAttestInput",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data as AwaitAttestInput);
}

export function runAwaitAttestation(
  input: unknown,
  port: AttestationPollPort,
  options?: { attempts?: number; intervalMs?: number },
): ResultAsync<AttestationCheckResult, AwaitAttestError> {
  const parsed = parseAwaitAttestInput(input);
  if (parsed.isErr()) return errAsync(parsed.error);
  return awaitAttestation(parsed.value, port, options).mapErr((error) => error);
}

export function parseAwaitAttestArgs(
  argv: readonly string[],
): Result<{ requestPath: string; resultPath?: string }, AwaitAttestError> {
  const parsed = parseNamedPathArgs(argv, "await-attest-main", ["request"]);
  if (parsed.isErr()) return err(parsed.error);
  return ok({
    requestPath: parsed.value.request,
    resultPath: parsed.value.result,
  });
}

export function readAwaitAttestInput(
  path: string,
): ResultAsync<AwaitAttestInput, AwaitAttestError> {
  return readJsonFile(path)
    .mapErr((error): AwaitAttestError => error)
    .andThen((input) => {
      const parsed = parseAwaitAttestInput(input);
      return parsed.isErr() ? errAsync(parsed.error) : ok(parsed.value);
    });
}

if (import.meta.main) {
  const args = parseAwaitAttestArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const input = await readAwaitAttestInput(args.value.requestPath);
    if (input.isErr()) process.exitCode = 1;
    else if (args.value.resultPath !== undefined) {
      const result = await readJsonFile(args.value.resultPath);
      if (result.isErr()) process.exitCode = 1;
      else if (verifyAttestationResult(result.value, input.value).isErr())
        process.exitCode = 1;
    }
  }
}
