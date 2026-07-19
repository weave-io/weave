import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  RELEASE_CONTROL_REF,
  RELEASE_EVENTS,
  RELEASE_INPUT_LIMITS,
} from "./constants.js";
import {
  CanonicalRefSchema,
  DigestSchema,
  FullShaSchema,
  NightlyVersionSchema,
  PackageNameSchema,
  ReleaseChannelSchema,
  ReleaseIdentitySchema,
  ReleaseOperationSchema,
  SemVerSchema,
  StableVersionSchema,
} from "./model.js";

const PositiveIntegerSchema = z.coerce.number().int().positive();
const ArtifactUploadInputSchema = z
  .object({
    serverArtifactId: PositiveIntegerSchema,
    uploadDigest: DigestSchema,
  })
  .strict();

/** Strict, workflow-only inputs for the artifact-binding CLI. */
export const ArtifactBindingCliInputSchema = z
  .object({
    repository: z.literal("weave-io/weave"),
    repositoryId: PositiveIntegerSchema,
    workflowPath: z.literal(".github/workflows/publish.yml"),
    workflowSha: FullShaSchema,
    runId: PositiveIntegerSchema,
    runAttempt: PositiveIntegerSchema.max(1000),
    event: z.enum(RELEASE_EVENTS),
    operation: ReleaseOperationSchema,
    headRef: CanonicalRefSchema,
    headSha: FullShaSchema,
    subjectSha: FullShaSchema,
    payload: ArtifactUploadInputSchema,
    control: ArtifactUploadInputSchema,
    controlPath: z.string().min(1).max(RELEASE_INPUT_LIMITS.identifierLength),
    manifestPath: z.string().min(1).max(RELEASE_INPUT_LIMITS.identifierLength),
  })
  .strict();
export type ArtifactBindingCliInput = z.infer<
  typeof ArtifactBindingCliInputSchema
>;

const DispatchSchema = ReleaseIdentitySchema.extend({
  eventName: z.literal(RELEASE_EVENTS[1]),
  ref: z.literal(RELEASE_CONTROL_REF),
  operation: ReleaseOperationSchema,
  channel: ReleaseChannelSchema,
  subjectSha: FullShaSchema,
  packages: z
    .array(PackageNameSchema)
    .min(1)
    .max(RELEASE_INPUT_LIMITS.packageCount),
  versions: z.record(z.string(), SemVerSchema),
})
  .strict()
  .superRefine((value, context) => {
    const stable = value.channel === "stable";
    if (stable && value.packages.includes("@weaveio/weave-adapter-claude-code"))
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "stable excludes Claude Code",
      });
    if (value.operation === "nightly" && value.channel !== "nightly")
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message: "nightly operation requires nightly channel",
      });
    if (value.operation !== "nightly" && !stable)
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message: "stable operation requires stable channel",
      });
    const packageSet = new Set<string>(value.packages);
    if (
      packageSet.size !== value.packages.length ||
      Object.keys(value.versions).length !== packageSet.size ||
      Object.keys(value.versions).some((name) => !packageSet.has(name))
    )
      context.addIssue({
        code: "custom",
        path: ["versions"],
        message: "versions must exactly match packages",
      });
    const versionSchema =
      value.channel === "nightly" ? NightlyVersionSchema : StableVersionSchema;
    if (
      Object.values(value.versions).some(
        (version) => !versionSchema.safeParse(version).success,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["versions"],
        message: `${value.channel} versions must use the canonical format`,
      });
  });
const ScheduleSchema = ReleaseIdentitySchema.extend({
  eventName: z.literal(RELEASE_EVENTS[0]),
  ref: z.literal(RELEASE_CONTROL_REF),
}).strict();
export const ReleaseInvocationSchema = z.union([
  DispatchSchema,
  ScheduleSchema,
]);
export type ReleaseInvocation = z.infer<typeof ReleaseInvocationSchema>;
export type InputValidationError = {
  type: "InvalidReleaseInvocation";
  issues: readonly z.core.$ZodIssue[];
};

/** The workflow boundary: callers must validate before interpolation or side effects. */
export function validateReleaseInvocation(
  input: unknown,
): Result<ReleaseInvocation, InputValidationError> {
  const parsed = ReleaseInvocationSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidReleaseInvocation",
      issues: parsed.error.issues,
    });
  return ok(parsed.data);
}
