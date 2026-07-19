import { z } from "zod";
import type { ReleaseChannel } from "./constants.js";
import {
  NPM_DIGEST_PREFIX,
  PUBLIC_PACKAGES,
  RELEASE_CHANNELS,
  RELEASE_CONTROL_REF,
  RELEASE_EVENTS,
  RELEASE_INPUT_LIMITS,
  RELEASE_OPERATIONS,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  STABLE_TRAIN_STATES,
  TRAIN_SCHEMA_VERSION,
} from "./constants.js";

const ASCII = /^[\x21-\x7e]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{12}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const FullShaSchema = z.string().regex(FULL_SHA);
export const ShortShaSchema = z.string().regex(SHORT_SHA);
export const SemVerSchema = z.string().max(64).regex(SEMVER);
export const StableVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const DigestSchema = z
  .string()
  .regex(new RegExp(`^${NPM_DIGEST_PREFIX}[0-9a-f]{64}$`));
export const UtcTimestampSchema = z
  .string()
  .regex(UTC_TIMESTAMP)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "must be a real UTC timestamp",
  );
export const PackageNameSchema = z.enum(
  Object.keys(PUBLIC_PACKAGES) as [
    keyof typeof PUBLIC_PACKAGES,
    ...(keyof typeof PUBLIC_PACKAGES)[],
  ],
);
export const ReleaseChannelSchema = z.enum(RELEASE_CHANNELS);
export const ReleaseOperationSchema = z.enum(RELEASE_OPERATIONS);
export const StableTrainStateSchema = z.enum(STABLE_TRAIN_STATES);
export const ReleaseBranchSchema = z
  .string()
  .regex(/^release\/\d{8}-[0-9a-f]{12}$/);
export const MetadataBranchSchema = z
  .string()
  .regex(/^release-metadata\/\d{8}-[0-9a-f]{12}$/);
export const CanonicalRefSchema = z.union([
  z.literal(RELEASE_CONTROL_REF),
  ReleaseBranchSchema,
  MetadataBranchSchema,
]);
export const StableTagSchema = z
  .string()
  .regex(
    /^weave-(?:cli|adapter-opencode)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
export const NightlyVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{8}\.[0-9a-f]{12}$/,
  );

export const ReleaseIdentitySchema = z
  .object({
    repository: z.literal(RELEASE_REPOSITORY),
    workflowPath: z.literal(RELEASE_WORKFLOW_PATH),
  })
  .strict();

export const ArtifactFileSchema = z
  .object({
    filename: z
      .string()
      .max(RELEASE_INPUT_LIMITS.identifierLength)
      .regex(ASCII)
      .regex(/^[A-Za-z0-9@._-]+\.tgz$/),
    checksumFilename: z
      .string()
      .max(RELEASE_INPUT_LIMITS.identifierLength)
      .regex(ASCII)
      .regex(/^[A-Za-z0-9@._-]+\.tgz\.sha256$/),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(RELEASE_INPUT_LIMITS.artifactBytes),
    sha256: DigestSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.checksumFilename !== `${artifact.filename}.sha256`)
      context.addIssue({
        code: "custom",
        path: ["checksumFilename"],
        message: "checksum filename must match artifact filename",
      });
  });

export const ArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseSubjectSha: FullShaSchema,
    channel: ReleaseChannelSchema,
    packages: z
      .array(PackageNameSchema)
      .min(1)
      .max(RELEASE_INPUT_LIMITS.artifactCount),
    versions: z.record(z.string(), SemVerSchema),
    artifacts: z
      .array(ArtifactFileSchema)
      .min(1)
      .max(RELEASE_INPUT_LIMITS.artifactCount),
  })
  .strict()
  .superRefine((manifest, context) => {
    validatePackageSet(manifest, context);
    validateChannelVersions(manifest.channel, manifest.versions, context);
    for (const packageName of manifest.packages) {
      const version = manifest.versions[packageName];
      const artifact = manifest.artifacts.find(
        (entry) =>
          entry.filename === packageArtifactFilename(packageName, version),
      );
      if (artifact === undefined)
        context.addIssue({
          code: "custom",
          path: ["artifacts"],
          message: "every package/version needs its canonical artifact",
        });
    }
    if (
      manifest.channel === "stable" &&
      manifest.packages.includes("@weaveio/weave-adapter-claude-code")
    )
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "stable excludes Claude Code",
      });
  });

/** Server-bound release artifact identity. Task 9's extension to ArtifactManifest. */
export const ArtifactBindingArtifactSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(RELEASE_INPUT_LIMITS.identifierLength)
      .regex(ASCII),
    serverArtifactId: z.number().int().positive(),
    uploadDigest: DigestSchema,
    sizeInBytes: z
      .number()
      .int()
      .positive()
      .max(RELEASE_INPUT_LIMITS.artifactBytes),
  })
  .strict();
export const ArtifactBindingFileSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(RELEASE_INPUT_LIMITS.identifierLength)
      .regex(ASCII),
    sha256: DigestSchema,
  })
  .strict();
/** Content-addressed linkage between build outputs and Actions server identity. */
export const ArtifactBindingRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordDigest: DigestSchema,
    repositoryId: z.number().int().positive(),
    repository: z.literal(RELEASE_REPOSITORY),
    workflowPath: z.literal(RELEASE_WORKFLOW_PATH),
    workflowSha: FullShaSchema,
    runId: z.number().int().positive(),
    runAttempt: z.number().int().positive().max(1000),
    event: z.enum(RELEASE_EVENTS),
    operation: ReleaseOperationSchema,
    headRef: CanonicalRefSchema,
    headSha: FullShaSchema,
    originJobConclusion: z.literal("success"),
    originJobId: z.number().int().positive(),
    originJobName: z.literal("build"),
    artifacts: z.array(ArtifactBindingArtifactSchema).min(2).max(3),
    packages: z
      .array(PackageNameSchema)
      .min(1)
      .max(RELEASE_INPUT_LIMITS.artifactCount),
    versions: z.record(z.string(), SemVerSchema),
    releaseSubjectSha: FullShaSchema,
    manifestDigest: DigestSchema,
    files: z
      .array(ArtifactBindingFileSchema)
      .min(1)
      .max(RELEASE_INPUT_LIMITS.artifactCount * 2),
  })
  .strict()
  .superRefine((record, context) => {
    validatePackageSet(record, context);
    if (
      new Set(record.artifacts.map((artifact) => artifact.name)).size !==
      record.artifacts.length
    )
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "artifact names must be unique",
      });
    if (
      new Set(record.files.map((file) => file.filename)).size !==
      record.files.length
    )
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "file names must be unique",
      });
  });

export const StableTrainRecordSchema = z
  .object({
    schemaVersion: z.literal(TRAIN_SCHEMA_VERSION),
    recordDigest: DigestSchema,
    trainRef: ReleaseBranchSchema,
    subjectSha: FullShaSchema,
    cutAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    state: StableTrainStateSchema,
    packages: z.array(PackageNameSchema).min(1).max(2),
    versions: z.record(z.string(), SemVerSchema),
    artifactManifestDigest: DigestSchema.optional(),
    /** Replay input: exact stable changesets removed on the release branch. */
    consumedChangesets: z
      .array(
        z
          .object({ path: z.string().min(1), preimageDigest: DigestSchema })
          .strict(),
      )
      .optional(),
    /** Replay input: deterministic package/changelog writes made at the cut. */
    metadataWrites: z
      .array(
        z
          .object({
            path: z.string().min(1),
            contentsDigest: DigestSchema,
            contents: z.string(),
          })
          .strict(),
      )
      .optional(),
    /** Actions artifact IDs are deliberately discarded after a stable fix. */
    artifactIds: z.array(z.number().int().positive()).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    validatePackageSet(record, context);
    if (
      Object.values(record.versions).some(
        (version) => !StableVersionSchema.safeParse(version).success,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["versions"],
        message: "stable versions cannot include prerelease or build metadata",
      });
    if (record.packages.includes("@weaveio/weave-adapter-claude-code"))
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "stable trains cannot contain Claude Code",
      });
    if (
      Date.parse(record.expiresAt) - Date.parse(record.cutAt) !==
      7 * 24 * 60 * 60 * 1000
    )
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be exactly seven days after cutAt",
      });
  });

/** Immutable replay payload copied from a finalized stable train. */
export const MetadataReplayRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordDigest: DigestSchema,
    sourceTrainRef: ReleaseBranchSchema,
    sourceTrainDigest: DigestSchema,
    subjectSha: FullShaSchema,
    generatedAt: UtcTimestampSchema,
    versions: z.record(z.string(), StableVersionSchema),
    consumedChangesets: z.array(
      z
        .object({ path: z.string().min(1), preimageDigest: DigestSchema })
        .strict(),
    ),
    metadataWrites: z.array(
      z
        .object({
          path: z.string().min(1),
          contentsDigest: DigestSchema,
          contents: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

function validatePackageSet(
  value: { packages: readonly string[]; versions: Record<string, string> },
  context: z.RefinementCtx,
): void {
  const packages = new Set(value.packages);
  if (packages.size !== value.packages.length)
    context.addIssue({
      code: "custom",
      path: ["packages"],
      message: "packages must be unique",
    });
  if (Object.keys(value.versions).some((name) => !packages.has(name)))
    context.addIssue({
      code: "custom",
      path: ["versions"],
      message: "versions must exactly match packages",
    });
  if (value.packages.some((name) => !(name in value.versions)))
    context.addIssue({
      code: "custom",
      path: ["versions"],
      message: "every package needs a version",
    });
}

function validateChannelVersions(
  channel: ReleaseChannel,
  versions: Record<string, string>,
  context: z.RefinementCtx,
): void {
  const schema =
    channel === "nightly" ? NightlyVersionSchema : StableVersionSchema;
  if (
    Object.values(versions).some(
      (version) => !schema.safeParse(version).success,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["versions"],
      message: `${channel} versions must use the canonical format`,
    });
}

/** npm package scopes cannot be path segments in artifact names. */
export function packageArtifactFilename(
  packageName: string,
  version: string,
): string {
  return `${packageName.replace("/", "-")}-${version}.tgz`;
}

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type ArtifactBindingRecord = z.infer<typeof ArtifactBindingRecordSchema>;
export type StableTrainRecord = z.infer<typeof StableTrainRecordSchema>;
export type MetadataReplayRecord = z.infer<typeof MetadataReplayRecordSchema>;
