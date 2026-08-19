/** Stable chain step: require changed-adapter five-stage proof records. */
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
import type { AdapterPackageName } from "./changed-adapters.js";
import type { PublicPackageName } from "./constants.js";
import { DigestSchema, PackageNameSchema, SemVerSchema } from "./model.js";

const HarnessProofSchema = z
  .object({
    adapter: PackageNameSchema,
    version: SemVerSchema,
    tarballDigest: DigestSchema,
    stages: z
      .array(
        z.enum([
          "bound-artifact-digest",
          "install-entry-digest",
          "fresh-host-process",
          "inventory-readiness",
          "adapter-action",
        ]),
      )
      .length(5),
    status: z.literal("passed"),
    summary: z.string().min(1).max(512),
  })
  .strict();

export type HarnessProofRecord = z.infer<typeof HarnessProofSchema> & {
  adapter: AdapterPackageName;
};
export type HarnessProofMainError =
  | { type: "InvalidHarnessProof"; issues: readonly string[] }
  | {
      type: "HarnessProofDigestMismatch";
      adapter: AdapterPackageName;
      expected: string;
      actual: string;
    }
  | {
      type: "HarnessProofMissingStage";
      adapter: AdapterPackageName;
      stage: string;
    }
  | ChainStepInputError;

export function validateHarnessProof(
  input: unknown,
): Result<HarnessProofRecord, HarnessProofMainError> {
  const parsed = HarnessProofSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidHarnessProof",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  const required = [
    "bound-artifact-digest",
    "install-entry-digest",
    "fresh-host-process",
    "inventory-readiness",
    "adapter-action",
  ] as const;
  for (const stage of required)
    if (!parsed.data.stages.includes(stage))
      return err({
        type: "HarnessProofMissingStage",
        adapter: parsed.data.adapter as AdapterPackageName,
        stage,
      });
  return ok(parsed.data as HarnessProofRecord);
}

export function assertHarnessProofDigest(
  input: unknown,
  expected: { adapter: AdapterPackageName; digest: string },
): Result<HarnessProofRecord, HarnessProofMainError> {
  return validateHarnessProof(input).andThen((proof) => {
    if (
      proof.adapter !== expected.adapter ||
      proof.tarballDigest !== expected.digest
    )
      return err({
        type: "HarnessProofDigestMismatch" as const,
        adapter: expected.adapter,
        expected: expected.digest,
        actual: proof.tarballDigest,
      });
    return ok(proof);
  });
}

export function parseHarnessProofArgs(
  argv: readonly string[],
): Result<{ proofPath: string }, HarnessProofMainError> {
  const parsed = parseNamedPathArgs(argv, "harness-proof-main", ["proof"]);
  if (parsed.isErr()) return err(parsed.error);
  return ok({ proofPath: parsed.value.proof });
}

export function readHarnessProof(
  path: string,
): ResultAsync<HarnessProofRecord, HarnessProofMainError> {
  return readJsonFile(path)
    .mapErr((error): HarnessProofMainError => error)
    .andThen((input) => {
      const parsed = validateHarnessProof(input);
      return parsed.isErr() ? errAsync(parsed.error) : okAsync(parsed.value);
    });
}

if (import.meta.main) {
  const args = parseHarnessProofArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const proof = await readHarnessProof(args.value.proofPath);
    if (proof.isErr()) process.exitCode = 1;
  }
}

export type { PublicPackageName };
