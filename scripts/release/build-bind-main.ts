/** Stable chain step: build at releasedSha and validate the bound plan. */
import { err, errAsync, ok, type Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  type ChainStepInputError,
  canonicalJson,
  parseNamedPathArgs,
  readJsonFile,
  writeJsonFile,
} from "./chain-step-support.js";
import {
  parseReleasePlanArtifact,
  type ReleasePlanArtifact,
  releasePlanDigest,
} from "./release-plan.js";

const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const BuildBindInputSchema = z
  .object({
    releasedSha: ShaSchema,
    plan: z.unknown(),
  })
  .strict();

export type BuildBindError =
  | { type: "InvalidBuildBindInput"; issues: readonly string[] }
  | { type: "ReleasedShaMismatch"; expected: string; actual: string }
  | { type: "BindingMissing" }
  | ChainStepInputError;

export interface BuildBindResult {
  readonly releasedSha: string;
  readonly planDigest: string;
  readonly binding: NonNullable<ReleasePlanArtifact["plan"]["binding"]>;
}

export function runBuildBind(
  input: unknown,
): Result<BuildBindResult, BuildBindError> {
  const parsed = BuildBindInputSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidBuildBindInput",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  const artifact = parseReleasePlanArtifact(JSON.stringify(parsed.data.plan));
  if (artifact.isErr())
    return err({
      type: "InvalidBuildBindInput",
      issues: [artifact.error.type],
    });
  const plan = artifact.value.plan;
  if (plan.releasedSha !== parsed.data.releasedSha)
    return err({
      type: "ReleasedShaMismatch",
      expected: parsed.data.releasedSha,
      actual: plan.releasedSha ?? "",
    });
  if (plan.binding === null) return err({ type: "BindingMissing" });
  return ok({
    releasedSha: parsed.data.releasedSha,
    planDigest: releasePlanDigest(plan),
    binding: plan.binding,
  });
}

export interface BuildBindFileResult extends BuildBindResult {
  readonly plan: ReleasePlanArtifact;
}

export function runBuildBindFromFiles(
  planPath: string,
  releasedSha: string,
  outputPath?: string,
): ResultAsync<BuildBindFileResult, BuildBindError> {
  return readJsonFile(planPath)
    .mapErr((error): BuildBindError => error)
    .andThen((planInput) => {
      const artifact = parseReleasePlanArtifact(JSON.stringify(planInput));
      if (artifact.isErr())
        return errAsync<BuildBindFileResult, BuildBindError>({
          type: "InvalidBuildBindInput",
          issues: [artifact.error.type],
        });
      const result = runBuildBind({ releasedSha, plan: artifact.value });
      if (result.isErr()) return errAsync(result.error);
      const value = { ...result.value, plan: artifact.value };
      if (outputPath === undefined) return ok(value);
      return writeJsonFile(outputPath, value)
        .mapErr((error): BuildBindError => error)
        .map(() => value);
    });
}

export function parseBuildBindArgs(
  argv: readonly string[],
): Result<
  { planPath: string; releasedSha: string; outputPath?: string },
  BuildBindError
> {
  const paths = parseNamedPathArgs(argv, "build-bind-main", [
    "plan",
    "released-sha",
  ]);
  if (paths.isErr()) return err(paths.error);
  const releasedSha = paths.value["released-sha"];
  const planPath = paths.value.plan;
  if (releasedSha === undefined || planPath === undefined)
    return err({
      type: "InvalidBuildBindInput",
      issues: ["missing plan or SHA"],
    });
  return ok({
    planPath,
    releasedSha,
    outputPath: paths.value.output,
  });
}

if (import.meta.main) {
  const args = parseBuildBindArgs(Bun.argv.slice(2));
  if (args.isErr()) process.exitCode = 2;
  else {
    const result = await runBuildBindFromFiles(
      args.value.planPath,
      args.value.releasedSha,
      args.value.outputPath,
    );
    if (result.isErr()) process.exitCode = 1;
    else if (args.value.outputPath === undefined)
      await Bun.write("build-bind.json", `${canonicalJson(result.value)}\n`);
  }
}
