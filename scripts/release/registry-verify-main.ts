/** Stable chain step: verify every published registry digest before refs. */
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
import type { PublishRegistry } from "./npm-registry-client.js";

const MemberSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    digest: DigestSchema,
  })
  .strict();

export type RegistryVerifyError =
  | { type: "InvalidRegistryVerification"; issues: readonly string[] }
  | {
      type: "RegistryDigestMismatch";
      packageName: PublicPackageName;
      expected: string;
      actual: string | null;
    }
  | ChainStepInputError;

export function validateRegistryVerification(
  input: unknown,
): Result<readonly z.infer<typeof MemberSchema>[], RegistryVerifyError> {
  const parsed = z.array(MemberSchema).min(1).max(4).safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidRegistryVerification",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

export function verifyRegistryMembers(
  members: readonly z.infer<typeof MemberSchema>[],
  registry: PublishRegistry,
): ResultAsync<void, RegistryVerifyError> {
  return members.reduce<ResultAsync<void, RegistryVerifyError>>(
    (chain, member) =>
      chain.andThen(() =>
        registry
          .readPublishedTarballDigest(member.packageName, member.version)
          .mapErr(
            (error): RegistryVerifyError => ({
              type: "InvalidRegistryVerification",
              issues: [error.message],
            }),
          )
          .andThen((observed) => {
            if (observed.state === "unpublished")
              return errAsync({
                type: "RegistryDigestMismatch" as const,
                packageName: member.packageName,
                expected: member.digest,
                actual: null,
              });
            if (observed.sha256 !== member.digest)
              return errAsync({
                type: "RegistryDigestMismatch" as const,
                packageName: member.packageName,
                expected: member.digest,
                actual: observed.sha256,
              });
            return okAsync(undefined);
          }),
      ),
    okAsync(undefined),
  );
}

export function parseRegistryVerifyArgs(
  argv: readonly string[],
): Result<{ membersPath: string }, RegistryVerifyError> {
  const parsed = parseNamedPathArgs(argv, "registry-verify-main", ["members"]);
  if (parsed.isErr()) return err(parsed.error);
  return ok({ membersPath: parsed.value.members });
}

export function readRegistryVerification(
  path: string,
): ResultAsync<readonly z.infer<typeof MemberSchema>[], RegistryVerifyError> {
  return readJsonFile(path)
    .mapErr((error): RegistryVerifyError => error)
    .andThen((input) => {
      const parsed = validateRegistryVerification(input);
      return parsed.isErr() ? errAsync(parsed.error) : okAsync(parsed.value);
    });
}

if (import.meta.main) {
  const args = parseRegistryVerifyArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const result = await readRegistryVerification(args.value.membersPath);
    if (result.isErr()) process.exitCode = 1;
  }
}
