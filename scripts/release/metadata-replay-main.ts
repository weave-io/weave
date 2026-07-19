import { logger } from "@weaveio/weave-engine";
import { z } from "zod";
import { Result } from "neverthrow";
import { ReleaseOrchestrator } from "./release-orchestrator.js";
import { BunFileSystem } from "./filesystem.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { BunCommandRunner } from "./command-runner.js";
import { SystemClock } from "./clock.js";

const log = logger.child({ module: "metadata-replay-main" });
const Input = z.object({ record: z.unknown(), branch: z.string().min(1) }).strict();
const raw = Bun.env.RELEASE_METADATA_REPLAY_INPUT;
const decoded = raw === undefined
  ? Result.fromThrowable(() => undefined, () => undefined)()
  : Result.fromThrowable(() => JSON.parse(raw) as unknown, () => undefined)();
const input = decoded.isOk() ? Input.safeParse(decoded.value) : Input.safeParse(undefined);
if (!input.success) { log.error({ issues: input.error.issues }, "invalid metadata replay input"); process.exitCode = 2; }
else {
  const result = await new ReleaseOrchestrator(new BunFileSystem(), new NpmCliRegistryClient(new BunCommandRunner()), new SystemClock()).planMetadataReplay(input.data.record as never, input.data.branch);
  if (result.isErr()) { log.error({ error: result.error }, "metadata replay planning failed"); process.exitCode = 1; }
  else log.info({ plan: result.value }, "metadata replay plan created");
}
