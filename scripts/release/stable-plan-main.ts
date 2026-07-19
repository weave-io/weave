import { logger } from "@weaveio/weave-engine";
import { z } from "zod";
import { ReleaseOrchestrator } from "./release-orchestrator.js";
import { BunFileSystem } from "./filesystem.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { BunCommandRunner } from "./command-runner.js";
import { SystemClock } from "./clock.js";

const log = logger.child({ module: "stable-plan-main" });
const Input = z.object({ operation: z.enum(["stable-cut", "stable-fix"]), input: z.unknown() }).strict();
const raw = Bun.env.RELEASE_STABLE_PLAN_INPUT;
if (raw === undefined) {
  log.error("missing stable plan input");
  process.exitCode = 2;
} else {
  const json = z.object({}).passthrough().safeParse(JSON.parse(raw));
  const input = Input.safeParse(json.success ? json.data : undefined);
  if (!input.success) {
    log.error({ issues: input.error.issues }, "invalid stable plan input");
    process.exitCode = 2;
  } else {
    const orchestrator = new ReleaseOrchestrator(new BunFileSystem(), new NpmCliRegistryClient(new BunCommandRunner()), new SystemClock());
    const result = input.data.operation === "stable-cut" ? await orchestrator.planStableCut(input.data.input as never) : await orchestrator.planStableFix(input.data.input as never);
    if (result.isErr()) { log.error({ error: result.error }, "stable planning failed"); process.exitCode = 1; }
    else log.info({ plan: result.value }, "stable plan created");
  }
}
