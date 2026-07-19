import { logger } from "@weaveio/weave-engine";
import { err, ok, okAsync, Result } from "neverthrow";
import { BunCommandRunner } from "./command-runner.js";
import type { FileSystem } from "./filesystem.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";
import { StableTrainRecordSchema } from "./model.js";

const log = logger.child({ module: "stable-finalize" });
const authorizationText = Bun.env.RELEASE_PROMOTION_AUTHORIZATION;
if (authorizationText === undefined) {
  log.error("missing promotion authorization record");
  process.exit(2);
}
const parsedAuthorization = Result.fromThrowable(
  () => JSON.parse(authorizationText),
  () => ({ type: "InvalidPromotionAuthorization" as const }),
)();
if (parsedAuthorization.isErr()) {
  log.error(
    { error: parsedAuthorization.error },
    "invalid promotion authorization JSON",
  );
  process.exit(2);
}
const trainText = Bun.env.RELEASE_STABLE_TRAIN;
if (trainText === undefined) {
  log.error("missing stable train record");
  process.exit(2);
}
const parsedTrain = Result.fromThrowable(
  () => JSON.parse(trainText),
  () => undefined,
)().andThen((value) => {
  const parsed = StableTrainRecordSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(undefined);
});
if (parsedTrain.isErr()) {
  log.error("invalid stable train record");
  process.exit(2);
}

const files: FileSystem = {
  exists: () => okAsync(false),
  readBytes: () => okAsync(new Uint8Array()),
  readText: () => okAsync(""),
  writeText: () => okAsync(undefined),
  delete: () => okAsync(undefined),
};
const result = await new ReleaseOrchestrator(
  files,
  new NpmCliRegistryClient(new BunCommandRunner()),
  { now: () => new Date(), sleep: () => okAsync(undefined) },
).stableFinalize(parsedAuthorization.value, parsedTrain.value);
if (result.isErr()) {
  log.error({ error: result.error }, "stable finalize verification failed");
  process.exit(1);
}
log.info(
  { subjectSha: result.value.authorization.subjectSha },
  "stable promotion verified",
);
