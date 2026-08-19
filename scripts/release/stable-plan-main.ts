import { logger } from "@weaveio/weave-engine";
import { z } from "zod";
import { SystemClock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { BunFileSystem } from "./filesystem.js";
import { parseJsonValue } from "./json.js";
import {
  FullShaSchema,
  PackageNameSchema,
  SemVerSchema,
  StableTrainRecordSchema,
} from "./model.js";
import { NpmCliRegistryClient } from "./npm-registry-client.js";
import { ReleaseOrchestrator } from "./release-orchestrator.js";

const log = logger.child({ module: "stable-plan-main" });
const BumpSchema = z.enum(["patch", "minor", "major"]);
const ChangesetReleasesSchema = z.array(
  z.tuple([PackageNameSchema, BumpSchema]),
);
const StableCutInputSchema = z
  .object({
    mainHeadSha: FullShaSchema,
    serverCutAt: z.string().datetime(),
    partition: z
      .object({
        stableFiles: z.array(z.string()),
        remainOnMainFiles: z.array(z.string()),
      })
      .strict(),
    changesets: z.array(
      z
        .object({
          path: z.string(),
          releases: ChangesetReleasesSchema,
        })
        .strict(),
    ),
    packageVersions: z.record(PackageNameSchema, SemVerSchema),
    changesetContents: z.record(z.string(), z.string()),
    reservedVersions: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict();
const StableFixInputSchema = z
  .object({
    record: StableTrainRecordSchema,
    commits: z.array(
      z
        .object({
          sha: FullShaSchema,
          green: z.boolean(),
          mergedToMain: z.boolean(),
        })
        .strict(),
    ),
    expectedHeadSha: FullShaSchema,
  })
  .strict();
const Input = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("stable-cut"), input: StableCutInputSchema })
    .strict(),
  z
    .object({ operation: z.literal("stable-fix"), input: StableFixInputSchema })
    .strict(),
]);

const raw = Bun.env.RELEASE_STABLE_PLAN_INPUT;
if (raw === undefined) {
  log.error("missing stable plan input");
  process.exitCode = 2;
} else {
  const decoded = parseJsonValue(raw);
  const input = decoded.isOk()
    ? Input.safeParse(decoded.value)
    : Input.safeParse(null);
  if (!input.success) {
    log.error({ issues: input.error.issues }, "invalid stable plan input");
    process.exitCode = 2;
  } else {
    const orchestrator = new ReleaseOrchestrator(
      new BunFileSystem(),
      new NpmCliRegistryClient(new BunCommandRunner()),
      new SystemClock(),
    );
    const result =
      input.data.operation === "stable-cut"
        ? await orchestrator.planStableCut({
            ...input.data.input,
            changesets: input.data.input.changesets.map((changeset) => ({
              ...changeset,
              releases: new Map(changeset.releases),
            })),
            serverCutAt: new Date(input.data.input.serverCutAt),
          })
        : await orchestrator.planStableFix({
            ...input.data.input,
            clock: new SystemClock(),
          });
    if (result.isErr()) {
      log.error({ error: result.error }, "stable planning failed");
      process.exitCode = 1;
    } else log.info({ plan: result.value }, "stable plan created");
  }
}
