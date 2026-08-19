/**
 * Stable chain boundary for post-publish refs and changeset cleanup.
 *
 * The GitHub mutation ports remain owned by the existing Task 12 modules. This
 * executable validates the hand-off artifact without importing the publication
 * executor, then lets the workflow adapter call those ports in the protected
 * App-token job.
 */
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
  canonicalJson,
  parseNamedPathArgs,
  readJsonFile,
  writeJsonFile,
} from "./chain-step-support.js";
import {
  DigestSchema,
  FullShaSchema,
  PackageNameSchema,
  SemVerSchema,
} from "./model.js";

const MemberSchema = z
  .object({
    packageName: PackageNameSchema,
    version: SemVerSchema,
    digest: DigestSchema,
  })
  .strict();

export const RefsCleanupInputSchema = z
  .object({
    releasedSha: FullShaSchema,
    publicationVerified: z.literal(true),
    members: z.array(MemberSchema).min(1).max(4),
    cleanup: z
      .object({
        channel: z.literal("stable"),
        ledgerDigest: DigestSchema,
      })
      .strict(),
  })
  .strict();

export type RefsCleanupInput = z.infer<typeof RefsCleanupInputSchema>;
export type RefsCleanupError =
  | { type: "InvalidRefsCleanupInput"; issues: readonly string[] }
  | ChainStepInputError;

export function validateRefsCleanupInput(
  input: unknown,
): Result<RefsCleanupInput, RefsCleanupError> {
  const parsed = RefsCleanupInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidRefsCleanupInput",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  const names = parsed.data.members.map((member) => member.packageName);
  if (new Set(names).size !== names.length)
    return err({
      type: "InvalidRefsCleanupInput",
      issues: ["members must contain one entry per package"],
    });
  return ok(parsed.data);
}

export function parseRefsCleanupArgs(
  argv: readonly string[],
): Result<{ inputPath: string; outputPath?: string }, RefsCleanupError> {
  const parsed = parseNamedPathArgs(argv, "refs-cleanup-main", ["input"]);
  if (parsed.isErr()) return err(parsed.error);
  return ok({ inputPath: parsed.value.input, outputPath: parsed.value.output });
}

export function runRefsCleanupFromFiles(
  inputPath: string,
  outputPath?: string,
): ResultAsync<RefsCleanupInput, RefsCleanupError> {
  return readJsonFile(inputPath)
    .mapErr((error): RefsCleanupError => error)
    .andThen((input) => {
      const validated = validateRefsCleanupInput(input);
      if (validated.isErr()) return errAsync(validated.error);
      if (outputPath === undefined) return okAsync(validated.value);
      return writeJsonFile(outputPath, validated.value)
        .mapErr((error): RefsCleanupError => error)
        .map(() => validated.value);
    });
}

if (import.meta.main) {
  const args = parseRefsCleanupArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const result = await runRefsCleanupFromFiles(
      args.value.inputPath,
      args.value.outputPath,
    );
    if (result.isErr()) process.exitCode = 1;
    else if (args.value.outputPath === undefined)
      await Bun.write("refs-cleanup.json", `${canonicalJson(result.value)}\n`);
  }
}
