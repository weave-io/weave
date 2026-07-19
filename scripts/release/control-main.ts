import { logger } from "@weaveio/weave-engine";
import { validateArtifactBindingRecord } from "./artifact-manifest.js";
import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { validateReleaseInvocation } from "./input-validation.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";

const log = logger.child({ module: "release-control" });
const args = Bun.argv.slice(2);
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
const invocationJson = JSON.parse(invocationText.value) as unknown;
const manifestJson = JSON.parse(manifestText.value) as unknown;
const binding = validateArtifactBindingRecord(
  JSON.parse(bindingText.value) as unknown,
);
const invocation = validateReleaseInvocation(invocationJson);
if (invocation.isErr()) {
  log.error({ issues: invocation.error.issues }, "invalid release invocation");
  process.exit(2);
}
if (
  invocation.value.eventName !== "workflow_dispatch" ||
  binding.isErr() ||
  binding.value.releaseSubjectSha !== invocation.value.subjectSha
) {
  log.error("invalid or mismatched binding record");
  process.exit(2);
}
const result = await new ReleaseOrchestrator(
  files,
  new NpmCliRegistryClient(new BunCommandRunner()),
  new SystemClock(),
).publish({
  invocation: invocation.value,
  manifest: manifestJson,
  artifactDirectory,
  bindingVerified: true,
  credentialScan: { environment: Bun.env },
});
if (result.isErr()) {
  log.error({ error: result.error }, "release failed");
  process.exit(1);
}
log.info("release completed");
