import { logger } from "@weaveio/weave-engine";
import { Result, ResultAsync, err, ok } from "neverthrow";
import { z } from "zod";
import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { GitHubRestClient } from "./github-client.js";
import { ArtifactManifestSchema, StableTrainRecordSchema } from "./model.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";

const log = logger.child({ module: "release-refs-main" });
const Input = z.object({
  authorization: z.string().min(1), appToken: z.string().min(1),
  payloadDirectory: z.string().min(1), notes: z.string().min(1),
}).strict();
const input = Input.safeParse({
  authorization: Bun.env.RELEASE_PROMOTION_AUTHORIZATION,
  appToken: Bun.env.RELEASE_APP_TOKEN,
  payloadDirectory: Bun.env.RELEASE_PAYLOAD_DIRECTORY,
  notes: Bun.env.RELEASE_RELEASE_NOTES,
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
    if (authorization.isErr()) {
      log.error("invalid promotion authorization JSON");
      process.exitCode = 2;
    } else {
      const result = await new ReleaseOrchestrator(
        new BunFileSystem(), new NpmCliRegistryClient(new BunCommandRunner()), new SystemClock(),
      ).stableReleaseRefs({
        authorization: authorization.value, manifest: payload.value.manifest,
        artifactDirectory: input.data.payloadDirectory,
        github: new GitHubRestClient("weave-io/weave", input.data.appToken, fetch, Bun.env.RELEASE_GITHUB_API_URL),
        notes: input.data.notes, stableTrain: payload.value.train,
      });
      if (result.isErr()) { log.error({ error: result.error }, "release references failed"); process.exitCode = 1; }
      else log.info({ state: result.value.state, tags: result.value.tags }, "release references verified");
    }
  }
}

function parseJson(text: string) {
  return Result.fromThrowable(() => JSON.parse(text) as unknown, () => ({ type: "InvalidJson" as const }))();
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
    const train = StableTrainRecordSchema.safeParse(manifest.data.stableTrain);
    if (!train.success) return err({ type: "InvalidStableTrain" as const });
    return ok({ manifest: manifest.data, train: train.data });
}
