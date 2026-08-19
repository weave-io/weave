/** Stable chain step: require a passing exact-tarball consumer proof. */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import {
  type ChainStepInputError,
  parseNamedPathArgs,
  readJsonFile,
} from "./chain-step-support.js";
import type { PublicPackageName } from "./constants.js";
import { DigestSchema, PackageNameSchema, SemVerSchema } from "./model.js";

const ConsumerProofSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    tarballDigest: DigestSchema,
    status: z.literal("passed"),
    summary: z.string().min(1).max(512),
  })
  .strict();

export type ConsumerProof = z.infer<typeof ConsumerProofSchema>;
export type ConsumerProofError =
  | { type: "InvalidConsumerProof"; issues: readonly string[] }
  | {
      type: "ConsumerProofDigestMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string;
    }
  | ChainStepInputError;

export function validateConsumerProof(
  input: unknown,
): Result<ConsumerProof, ConsumerProofError> {
  const parsed = ConsumerProofSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidConsumerProof",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

export function assertConsumerProofDigest(
  proof: unknown,
  expected: { packageName: PublicPackageName; digest: string },
): Result<ConsumerProof, ConsumerProofError> {
  return validateConsumerProof(proof).andThen((value) => {
    if (value.packageName !== expected.packageName)
      return err({
        type: "ConsumerProofDigestMismatch" as const,
        packageName: expected.packageName,
        expected: expected.digest,
        actual: value.tarballDigest,
      });
    if (value.tarballDigest !== expected.digest)
      return err({
        type: "ConsumerProofDigestMismatch" as const,
        packageName: expected.packageName,
        expected: expected.digest,
        actual: value.tarballDigest,
      });
    return ok(value);
  });
}

export function parseConsumerProofArgs(
  argv: readonly string[],
): Result<{ proofPath: string }, ConsumerProofError> {
  const parsed = parseNamedPathArgs(argv, "consumer-proof-main", ["proof"]);
  if (parsed.isErr()) return err(parsed.error);
  return ok({ proofPath: parsed.value.proof });
}

export function readConsumerProof(
  path: string,
): ResultAsync<ConsumerProof, ConsumerProofError> {
  return readJsonFile(path)
    .mapErr((error): ConsumerProofError => error)
    .andThen((input) => {
      const parsed = validateConsumerProof(input);
      return parsed.isErr() ? errAsync(parsed.error) : okAsync(parsed.value);
    });
}

if (import.meta.main) {
  const args = parseConsumerProofArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const proof = await readConsumerProof(args.value.proofPath);
    if (proof.isErr()) process.exitCode = 1;
  }
}
