import { logger } from "@weaveio/weave-engine";
import { z } from "zod";
import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { parseJsonValue } from "./json.js";
import { MetadataReplayRecordSchema } from "./model.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";

const log = logger.child({ module: "metadata-replay-main" });
const Input = z
  .object({ record: MetadataReplayRecordSchema, branch: z.string().min(1) })
  .strict();
const raw = Bun.env.RELEASE_METADATA_REPLAY_INPUT;
const decoded = raw === undefined ? undefined : parseJsonValue(raw);
const input =
  decoded === undefined || decoded.isErr()
    ? Input.safeParse(null)
    : Input.safeParse(decoded.value);
if (!input.success) {
  log.error({ issues: input.error.issues }, "invalid metadata replay input");
  process.exitCode = 2;
} else {
  const result = await new ReleaseOrchestrator(
    new BunFileSystem(),
    new NpmCliRegistryClient(new BunCommandRunner()),
    new SystemClock(),
  ).planMetadataReplay(input.data.record, input.data.branch);
  if (result.isErr()) {
    log.error({ error: result.error }, "metadata replay planning failed");
    process.exitCode = 1;
  } else log.info({ plan: result.value }, "metadata replay plan created");
}
