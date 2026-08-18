/**
 * Standalone publication entrypoint.
 *
 * Reads only validated artifacts, rejects credential sources that would
 * bypass OIDC, and hands the bound tarballs to the serial executor. It
 * never invokes Changesets, AI, or Git mutation.
 */
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem, type FileSystem } from "./filesystem.js";
import {
  NpmCliRegistryClient,
  type PublishRegistry,
} from "./npm-registry-client.js";
import { scanCredentialSources } from "./package-policy.js";
import {
  PUBLICATION_REPORT_LIMITS,
  type PublicationError,
  type PublicationReport,
  PublishExecutor,
  parsePublicationReport,
  serializePublicationReport,
} from "./publish-executor.js";
import { parseReleasePlanArtifact } from "./release-plan.js";

const log = logger.child({ module: "publish-main" });

const PathSchema = z
  .string()
  .min(1)
  .max(PUBLICATION_REPORT_LIMITS.directoryLength)
  .refine(
    (value) => !value.includes("..") && !/[;&|`$<>\n\r]/.test(value),
    "path must be a bounded safe path",
  );

export interface PublishMainArgs {
  planPath: string;
  proofChainPath: string;
  artifactDirectory: string;
  reportPath: string;
}

export interface PublishMainDependencies {
  files: FileSystem;
  registry: PublishRegistry;
}

export function parsePublishMainArgs(
  argv: readonly string[],
): Result<PublishMainArgs, PublicationError> {
  if (argv.length !== 4)
    return err({
      type: "InvalidPublicationInput",
      issues: [
        "usage: publish-main <plan-artifact> <proof-chain> <artifact-directory> <report-path>",
      ],
    });
  const parsed = z
    .object({
      planPath: PathSchema,
      proofChainPath: PathSchema,
      artifactDirectory: PathSchema,
      reportPath: PathSchema,
    })
    .strict()
    .safeParse({
      planPath: argv[0],
      proofChainPath: argv[1],
      artifactDirectory: argv[2],
      reportPath: argv[3],
    });
  if (!parsed.success)
    return err({
      type: "InvalidPublicationInput",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

export function runPublishMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: PublishMainDependencies,
): ResultAsync<PublicationReport, PublicationError> {
  const args = parsePublishMainArgs(argv);
  if (args.isErr()) return errAsync(args.error);
  const credentials = scanCredentialSources({ environment: env });
  if (credentials.isErr())
    return errAsync({
      type: "CredentialSourceDetected",
      source: credentials.error,
    });
  return readJson(deps.files, args.value.planPath, "plan artifact")
    .andThen((planText) =>
      parseReleasePlanArtifact(planText)
        .mapErr(
          (error): PublicationError => ({
            type: "InvalidPublicationPlan",
            error,
          }),
        )
        .asyncAndThen((artifact) =>
          readJson(
            deps.files,
            args.value.proofChainPath,
            "proof chain",
          ).andThen((proofText) =>
            parseUnknownJson(proofText, "proof chain").asyncAndThen(
              (proofChain) =>
                new PublishExecutor(deps).execute({
                  plan: artifact.plan,
                  proofChain,
                  artifactDirectory: args.value.artifactDirectory,
                  credentialScan: { environment: env },
                }),
            ),
          ),
        ),
    )
    .andThen((report) => writeReport(deps.files, args.value.reportPath, report))
    .orElse((error) =>
      persistIncomplete(deps.files, args.value.reportPath, error),
    );
}

export function readPersistedReport(
  text: string,
): Result<PublicationReport, PublicationError> {
  return parsePublicationReport(text);
}

function readJson(
  files: FileSystem,
  path: string,
  label: string,
): ResultAsync<string, PublicationError> {
  return files.readText(path).andThen((text) => {
    if (text.length > PUBLICATION_REPORT_LIMITS.bytes)
      return errAsync({
        type: "InvalidPublicationInput" as const,
        issues: [`${label} exceeds the bounded input limit`],
      });
    return ok(text);
  });
}

function parseUnknownJson(
  text: string,
  label: string,
): Result<unknown, PublicationError> {
  return Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    (): PublicationError => ({
      type: "MalformedPublicationJson",
      reason: `${label} is not JSON`,
    }),
  )();
}

function writeReport(
  files: FileSystem,
  path: string,
  report: PublicationReport,
): ResultAsync<PublicationReport, PublicationError> {
  const serialized = serializePublicationReport(report);
  if (serialized.isErr()) return errAsync(serialized.error);
  return files.writeText(path, serialized.value).map(() => report);
}

function persistIncomplete(
  files: FileSystem,
  path: string,
  error: PublicationError,
): ResultAsync<PublicationReport, PublicationError> {
  if (error.type !== "PublicationIncomplete") return errAsync(error);
  return writeReport(files, path, error.report).andThen(() => errAsync(error));
}

if (import.meta.main) {
  const result = await runPublishMain(Bun.argv.slice(2), Bun.env, {
    files: new BunFileSystem(),
    registry: new NpmCliRegistryClient(new BunCommandRunner()),
  });
  if (result.isOk()) {
    log.info(
      { packages: result.value.members.length, tag: result.value.tag },
      "publication completed",
    );
  } else {
    log.error({ error: result.error }, "publication failed");
    process.exitCode = result.error.type === "InvalidPublicationInput" ? 2 : 1;
  }
}
