import { logger } from "@weaveio/weave-engine";
import { err, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { GitHubRestClient } from "./github-client.js";
import { parseJsonValue } from "./json.js";
import { ArtifactManifestSchema } from "./model.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";
import { hasProgressedLineage } from "./stable-lineage.js";
import { validateStableTrain } from "./stable-train.js";

const log = logger.child({ module: "release-refs-main" });
const Input = z
  .object({
    authorization: z.string().min(1),
    appToken: z.string().min(1),
    payloadDirectory: z.string().min(1),
    notes: z.string().min(1),
    awaitingTrain: z.string().min(1),
    progressedTrain: z.string().min(1),
  })
  .strict();
const input = Input.safeParse({
  authorization: Bun.env.RELEASE_PROMOTION_AUTHORIZATION,
  appToken: Bun.env.RELEASE_APP_INSTALLATION_TOKEN,
  payloadDirectory: Bun.env.RELEASE_PAYLOAD_DIRECTORY,
  notes: Bun.env.RELEASE_RELEASE_NOTES,
  awaitingTrain: Bun.env.RELEASE_AWAITING_STABLE_TRAIN,
  progressedTrain: Bun.env.RELEASE_PROGRESSED_STABLE_TRAIN,
});
if (!input.success) {
  log.error({ issues: input.error.issues }, "invalid release references input");
  process.exitCode = 2;
} else {
  const payload = await loadPayload(input.data.payloadDirectory);
  if (payload.isErr()) {
    log.error({ error: payload.error }, "invalid bound release payload");
    process.exitCode = 2;
  } else {
    const authorization = parseJson(input.data.authorization);
    const awaitingTrain = parseJson(input.data.awaitingTrain).andThen(
      validateStableTrain,
    );
    const progressedTrain = parseJson(input.data.progressedTrain)
      .andThen(validateStableTrain)
      .andThen((train) => {
        if (awaitingTrain.isErr()) return err(awaitingTrain.error);
        return hasProgressedLineage(awaitingTrain.value, train)
          ? ok(train)
          : err({ type: "InvalidStableTrainLineage" as const });
      });
    if (
      authorization.isErr() ||
      awaitingTrain.isErr() ||
      progressedTrain.isErr()
    ) {
      log.error("invalid promotion authorization or progressed train JSON");
      process.exitCode = 2;
    } else {
      const result = await new ReleaseOrchestrator(
        new BunFileSystem(),
        new NpmCliRegistryClient(new BunCommandRunner()),
        new SystemClock(),
      ).stableReleaseRefs({
        authorization: authorization.value,
        manifest: payload.value.manifest,
        artifactDirectory: input.data.payloadDirectory,
        github: new GitHubRestClient(
          "weave-io/weave",
          input.data.appToken,
          fetch,
          Bun.env.RELEASE_GITHUB_API_URL,
        ),
        notes: input.data.notes,
        stableTrain: progressedTrain.value,
      });
      if (result.isErr()) {
        log.error({ error: result.error }, "release references failed");
        process.exitCode = 1;
      } else
        log.info(
          { state: result.value.state, tags: result.value.tags },
          "release references verified",
        );
    }
  }
}

function parseJson(text: string) {
  return parseJsonValue(text).mapErr(() => ({ type: "InvalidJson" as const }));
}

async function loadPayload(directory: string) {
  const read = await ResultAsync.fromPromise(
    Bun.file(`${directory}/manifest.json`).text(),
    () => ({ type: "PayloadReadFailed" as const }),
  );
  if (read.isErr()) return err(read.error);
  const parsed = parseJson(read.value);
  if (parsed.isErr()) return err({ type: "InvalidManifestJson" as const });
  const manifest = ArtifactManifestSchema.safeParse(parsed.value);
  if (!manifest.success) return err({ type: "InvalidManifest" as const });
  return ok({ manifest: manifest.data });
}
