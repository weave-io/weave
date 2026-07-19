import { logger } from "@weaveio/weave-engine";
import { okAsync, Result } from "neverthrow";

import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { GitHubRestClient } from "./github-client.js";
import {
  releaseGitHubApiUrl,
  validateReleaseControlEnvironment,
  validateReleaseInvocation,
} from "./input-validation.js";
import { StableTrainRecordSchema } from "./model.js";
import type { NpmRegistryClient } from "./npm-registry-client.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { promotionCommandsFromRegistry } from "./promotion-commands.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";
import { validateStableTrain } from "./stable-train.js";

const log = logger.child({ module: "release-control" });
const args = Bun.argv.slice(2);
const dryRun = Bun.env.RELEASE_CONTROL_DRY_RUN === "true";
if (args[0] === "--help") {
  log.info(
    "usage: release-control <invocation.json> <manifest.json> <artifact-directory> <binding.json>",
  );
  process.exit(0);
}
if (args.length !== 4) {
  log.error(
    "expected invocation, manifest, artifact directory, and binding record",
  );
  process.exit(2);
}
const [invocationPath, manifestPath, artifactDirectory, bindingPath] = args;
const files = new BunFileSystem();
const invocationText = await files.readText(invocationPath);
const manifestText = await files.readText(manifestPath);
const bindingText = await files.readText(bindingPath);
if (invocationText.isErr() || manifestText.isErr() || bindingText.isErr()) {
  log.error("unable to read release inputs");
  process.exit(1);
}
const invocationJson = parseJson(invocationText.value);
const manifestJson = parseJson(manifestText.value);
const bindingJson = parseJson(bindingText.value);
if (invocationJson.isErr() || manifestJson.isErr() || bindingJson.isErr()) {
  log.error("release inputs contain invalid JSON");
  process.exit(2);
}
const invocation = validateReleaseInvocation(invocationJson.value);
if (invocation.isErr()) {
  log.error({ issues: invocation.error.issues }, "invalid release invocation");
  process.exit(2);
}
const environment = validateReleaseControlEnvironment({
  workflowSha: Bun.env.RELEASE_WORKFLOW_SHA,
  headRef: Bun.env.RELEASE_HEAD_REF,
  headSha: Bun.env.RELEASE_HEAD_SHA,
  runId: Bun.env.RELEASE_RUN_ID,
  runAttempt: Bun.env.RELEASE_RUN_ATTEMPT,
});
if (environment.isErr()) {
  log.error(
    { issues: environment.error.issues },
    "invalid release environment",
  );
  process.exit(2);
}
if (invocation.value.eventName !== "workflow_dispatch") {
  log.error("control only permits workflow dispatch publication");
  process.exit(2);
}
const stableTrain = StableTrainRecordSchema.safeParse(
  typeof manifestJson.value === "object" && manifestJson.value !== null
    ? (manifestJson.value as { stableTrain?: unknown }).stableTrain
    : undefined,
);
const boundStableTrain = stableTrain.success
  ? stableTrainFromBinding(bindingJson.value, stableTrain.data)
  : undefined;
if (invocation.value.channel === "stable" && boundStableTrain === undefined) {
  log.error("stable control requires a validated stable train record");
  process.exit(2);
}
const manifestDigest = digest(manifestText.value);
const manifestFiles = artifactFiles(manifestJson.value);
if (manifestFiles === undefined) {
  log.error("manifest has no verifiable files");
  process.exit(2);
}
// Bun.argv[0] remains Bun's launcher in compiled executables; execPath is the
// standalone control binary that the binding record authenticates.
const controlBytes = await files.readBytes(process.execPath);
if (controlBytes.isErr()) {
  log.error("unable to read control binary");
  process.exit(1);
}
const registry = registryClient();
const result = await new ReleaseOrchestrator(
  files,
  registry,
  new SystemClock(),
).publish({
  invocation: invocation.value,
  manifest: manifestJson.value,
  artifactDirectory,
  bindingVerification: {
    record: bindingJson.value,
    context: {
      expectedWorkflowSha: environment.value.workflowSha,
      expectedRunId: environment.value.runId,
      expectedRunAttempt: environment.value.runAttempt,
      expectedOperation: invocation.value.operation,
      expectedHeadRef: environment.value.headRef,
      expectedHeadSha: environment.value.headSha,
      expectedManifest: manifestJson.value as never,
      expectedManifestDigest: manifestDigest,
      expectedFiles: [
        ...manifestFiles,
        { filename: "release-control", sha256: digest(controlBytes.value) },
      ],
    },
    github: new GitHubRestClient(
      invocation.value.repository,
      Bun.env.GITHUB_TOKEN,
      fetch,
      releaseGitHubApiUrl(dryRun, Bun.env.RELEASE_GITHUB_API_URL),
    ),
  },
  credentialScan: { environment: Bun.env },
  stableTrain: boundStableTrain,
});
if (result.isErr()) {
  log.error({ error: result.error }, "release failed");
  process.exit(1);
}
if (
  result.value.state === "published" &&
  result.value.promotionAuthorization !== undefined
) {
  const commands = await promotionCommandsFromRegistry(
    result.value.promotionAuthorization,
    registry,
  );
  if (commands.isErr()) {
    log.error(
      { error: commands.error },
      "unable to generate promotion commands",
    );
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({ promotionAuthorization: result.value.promotionAuthorization, promotionCommands: commands.value, stableTrain: result.value.stableTrain })}\n`,
  );
}
if (dryRun)
  process.stdout.write(
    `${JSON.stringify({
      dryRun: true,
      plannedCommands: plannedCommands(
        invocation.value.operation,
        artifactDirectory,
        manifestFiles,
      ),
    })}\n`,
  );
log.info("release completed");

function artifactFiles(
  value: unknown,
): readonly { filename: string; sha256: string }[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const artifacts = (value as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return undefined;
  const files = artifacts.map((artifact) => {
    if (typeof artifact !== "object" || artifact === null) return undefined;
    const { filename, sha256 } = artifact as Record<string, unknown>;
    return typeof filename === "string" && typeof sha256 === "string"
      ? { filename, sha256 }
      : undefined;
  });
  return files.some((file) => file === undefined)
    ? undefined
    : (files as { filename: string; sha256: string }[]);
}

function digest(value: string | Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

function parseJson(value: string) {
  return Result.fromThrowable(
    () => JSON.parse(value) as unknown,
    () => ({ type: "InvalidJson" as const }),
  )();
}

function stableTrainFromBinding(
  binding: unknown,
  manifestTrain: import("./model.js").StableTrainRecord,
) {
  if (typeof binding !== "object" || binding === null) return undefined;
  const candidate = (binding as { stableTrain?: unknown }).stableTrain;
  const parsed = validateStableTrain(candidate);
  if (parsed.isErr() || parsed.value.state !== "bound") return undefined;
  if (
    parsed.value.subjectSha !== manifestTrain.subjectSha ||
    JSON.stringify(parsed.value.packages) !==
      JSON.stringify(manifestTrain.packages) ||
    JSON.stringify(parsed.value.versions) !==
      JSON.stringify(manifestTrain.versions)
  )
    return undefined;
  return parsed.value;
}

/** Dry runs validate the full local and server-bound proof without registry mutation. */
function plannedCommands(
  operation: string,
  artifactDirectory: string,
  files: readonly { filename: string; sha256: string }[],
): readonly string[] {
  const tag = operation === "nightly" ? "nightly" : "next";
  return files.map(
    (file) =>
      `npm publish ${artifactDirectory}/${file.filename} --access public --tag ${tag}`,
  );
}

function registryClient(): NpmRegistryClient {
  if (!dryRun) return new NpmCliRegistryClient(new BunCommandRunner());
  return {
    publish: () => okAsync(undefined),
    viewVersion: () => okAsync(""),
    listVersions: () => okAsync([]),
    viewDistTags: () => okAsync({}),
    distTagLs: (packageName) =>
      okAsync({ latest: `0.0.0-${packageName.length}` }),
    verifyPublished: () => okAsync(undefined),
  };
}
