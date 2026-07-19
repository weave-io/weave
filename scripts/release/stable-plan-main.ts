import { logger } from "@weaveio/weave-engine";
import { Result } from "neverthrow";
import { z } from "zod";
import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";

const log = logger.child({ module: "stable-plan-main" });
const Input = z
  .object({
    operation: z.enum(["stable-cut", "stable-fix"]),
    input: z.unknown(),
  })
  .strict();
const raw = Bun.env.RELEASE_STABLE_PLAN_INPUT;
if (raw === undefined) {
  log.error("missing stable plan input");
  process.exitCode = 2;
} else {
  const decoded = Result.fromThrowable(
    () => JSON.parse(raw) as unknown,
    () => undefined,
  )();
  const json = decoded.isOk()
    ? z.object({}).passthrough().safeParse(decoded.value)
    : z.object({}).passthrough().safeParse(undefined);
  const input = Input.safeParse(json.success ? json.data : undefined);
  if (!input.success) {
    log.error({ issues: input.error.issues }, "invalid stable plan input");
    process.exitCode = 2;
  } else {
    const orchestrator = new ReleaseOrchestrator(
      new BunFileSystem(),
      new NpmCliRegistryClient(new BunCommandRunner()),
      new SystemClock(),
    );
    const stableCutInput = input.data.input as Record<string, unknown>;
    const result =
      input.data.operation === "stable-cut"
        ? await orchestrator.planStableCut({
            ...stableCutInput,
            // Workflow inputs are JSON, while the orchestration API deliberately
            // accepts a Date so stable-train planning can use a server timestamp.
            serverCutAt: new Date(String(stableCutInput.serverCutAt)),
          } as never)
        : await orchestrator.planStableFix(input.data.input as never);
    if (result.isErr()) {
      log.error({ error: result.error }, "stable planning failed");
      process.exitCode = 1;
    } else log.info({ plan: result.value }, "stable plan created");
  }
}
